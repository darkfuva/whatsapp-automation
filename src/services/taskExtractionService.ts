import { OllamaTaskClient } from "../ai/ollamaClient";
import { AppConfig } from "../config/env";
import { AppDatabase } from "../db/database";
import { StoredMessageRow, StoredTaskInput, StoredTaskRow } from "../db/types";
import { logger } from "../utils/logger";
import { formatLocalTimestamp, formatRelativeTargetDate } from "../utils/time";

const MAX_BATCH_MESSAGES = 28;
const MAX_BATCH_CHARS = 3600;

function localStartOfYesterdayIso(): string {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() - 1);
  return date.toISOString();
}

function messageSortTime(message: StoredMessageRow): number {
  return new Date(message.normalized_timestamp || message.created_at).getTime();
}

function estimateMessageSize(message: StoredMessageRow): number {
  return (
    (message.message_text || "").length +
    (message.chat_name || "").length +
    (message.sender_name || "").length +
    80
  );
}

function splitIntoBatches(messages: StoredMessageRow[]): StoredMessageRow[][] {
  const sorted = [...messages].sort((left, right) => messageSortTime(left) - messageSortTime(right));
  const batches: StoredMessageRow[][] = [];
  let currentBatch: StoredMessageRow[] = [];
  let currentChars = 0;

  for (const message of sorted) {
    const messageSize = estimateMessageSize(message);
    const wouldOverflowCount = currentBatch.length >= MAX_BATCH_MESSAGES;
    const wouldOverflowChars = currentChars + messageSize > MAX_BATCH_CHARS;

    if (currentBatch.length > 0 && (wouldOverflowCount || wouldOverflowChars)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(message);
    currentChars += messageSize;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function dedupeTasks(tasks: StoredTaskInput[]): StoredTaskInput[] {
  const byKey = new Map<string, StoredTaskInput>();

  for (const task of tasks) {
    const key = [
      task.category,
      task.title.trim().toLowerCase(),
      (task.sourceChatName || "").trim().toLowerCase()
    ].join("|");

    const existing = byKey.get(key);
    if (!existing || task.confidence > existing.confidence) {
      byKey.set(key, task);
    }
  }

  return Array.from(byKey.values());
}

export class TaskExtractionService {
  private readonly client: OllamaTaskClient | null;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase
  ) {
    this.client = config.taskExtractionEnabled ? new OllamaTaskClient(config) : null;
  }

  async refreshTodayTasks(): Promise<StoredTaskRow[]> {
    const taskDate = formatRelativeTargetDate(new Date());

    if (!this.config.taskExtractionEnabled) {
      logger.info("TASK_EXTRACTION_ENABLED is false; skipping task extraction.");
      this.database.clearTasksForDate(taskDate);
      return [];
    }

    if (!this.client) {
      throw new Error("Task extraction is enabled but the local Ollama client is unavailable.");
    }

    const yesterdayFloorHours = Math.ceil(
      (Date.now() - new Date(localStartOfYesterdayIso()).getTime()) / (60 * 60 * 1000)
    );
    const messages = this.database.getMessagesSince(Math.max(this.config.taskContextHours, yesterdayFloorHours));
    if (messages.length === 0) {
      logger.info("No recent synced messages found for task extraction.");
      this.database.clearTasksForDate(taskDate);
      return [];
    }

    const batches = splitIntoBatches(messages);
    logger.info("Running batched task extraction.", {
      messages: messages.length,
      batches: batches.length
    });

    const candidateTasks: StoredTaskInput[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      const tasks = await this.client.extractTasksForBatch(
        batch,
        taskDate,
        `batch_${index + 1}_of_${batches.length}`
      );

      logger.debug("Batch extraction completed.", {
        batch: index + 1,
        batchMessages: batch.length,
        extracted: tasks.length
      });

      candidateTasks.push(
        ...tasks.map((task) => ({
          taskDate,
          category: task.category,
          title: task.title,
          details: task.details,
          confidence: task.confidence,
          sourceChatName: task.source_chat_name,
          sourceMessageId: task.source_message_id,
          sourceMessageTime: task.source_message_time,
          sourceExcerpt: task.source_excerpt,
          assigneeHint: task.assignee_hint,
          dueDate: task.due_date,
          waitingOn: task.waiting_on,
          status: task.status,
          sourceType: `${this.config.ollamaModel}:batch`,
          rawJson: JSON.stringify(task)
        }))
      );
    }

    let records = dedupeTasks(candidateTasks);

    if (records.length > 1) {
      const consolidated = await this.client.consolidateTasks(
        records.map((record) => ({
          category: record.category,
          title: record.title,
          details: record.details,
          confidence: record.confidence,
          source_chat_name: record.sourceChatName,
          source_message_id: record.sourceMessageId,
          source_message_time: record.sourceMessageTime,
          source_excerpt: record.sourceExcerpt,
          assignee_hint: record.assigneeHint,
          due_date: record.dueDate,
          waiting_on: record.waitingOn,
          status: record.status
        })),
        taskDate
      );

      const consolidatedRecords = dedupeTasks(
        consolidated.map((task) => ({
          taskDate,
          category: task.category,
          title: task.title,
          details: task.details,
          confidence: task.confidence,
          sourceChatName: task.source_chat_name,
          sourceMessageId: task.source_message_id,
          sourceMessageTime: task.source_message_time,
          sourceExcerpt: task.source_excerpt,
          assigneeHint: task.assignee_hint,
          dueDate: task.due_date,
          waitingOn: task.waiting_on,
          status: task.status,
          sourceType: `${this.config.ollamaModel}:consolidated`,
          rawJson: JSON.stringify(task)
        }))
      );

      if (consolidatedRecords.length > 0) {
        records = consolidatedRecords;
      } else {
        logger.warn("Consolidation returned no parsed items; falling back to batch candidates.");
      }
    }

    this.database.clearTasksForDate(taskDate);
    this.database.insertTasks(records);
    return this.database.listTasksForDate(taskDate);
  }

  printTodayTasks(tasks: StoredTaskRow[]): void {
    if (!this.config.taskExtractionEnabled) {
      console.log("Task extraction is disabled because TASK_EXTRACTION_ENABLED=false.");
      return;
    }

    if (tasks.length === 0) {
      console.log("No actionable or awareness items found for today.");
      return;
    }

    const categories: Array<{ key: StoredTaskRow["category"]; label: string }> = [
      { key: "urgent", label: "Urgent" },
      { key: "today", label: "Today" },
      { key: "follow_up", label: "Follow-ups" },
      { key: "blocker", label: "Blockers" },
      { key: "waiting_on", label: "Waiting On" },
      { key: "awareness", label: "Awareness" },
      { key: "low_confidence", label: "Low Confidence" }
    ];

    for (const category of categories) {
      const items = tasks.filter((task) => task.category === category.key);
      if (items.length === 0) {
        continue;
      }

      console.log(`\n${category.label}`);
      for (const item of items) {
        const reference = [
          item.source_chat_name || "unknown-chat",
          formatLocalTimestamp(item.source_message_time)
        ].join(" | ");

        const suffix = item.waiting_on ? ` | waiting on: ${item.waiting_on}` : "";
        console.log(`- ${item.title} (${Math.round(item.confidence * 100)}%)`);
        if (item.details) {
          console.log(`  ${item.details}`);
        }
        console.log(`  Ref: ${reference}${suffix}`);
      }
    }
  }
}
