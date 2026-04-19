import { StoredMessageRow } from "../db/types";
import { logger } from "../utils/logger";

export interface TaskExtractionPrompt {
  systemPrompt: string;
  userPrompt: string;
}

const MAX_MESSAGE_TEXT_CHARS = 220;

function clipText(input: string | null | undefined, maxChars: number): string | null {
  if (!input) {
    return null;
  }

  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function sortMessagesByRecency(messages: StoredMessageRow[]): StoredMessageRow[] {
  return [...messages].sort((left, right) => {
    const leftTime = new Date(left.normalized_timestamp || left.created_at).getTime();
    const rightTime = new Date(right.normalized_timestamp || right.created_at).getTime();
    return rightTime - leftTime;
  });
}

function formatMessagesForPrompt(messages: StoredMessageRow[]): string {
  const selectedMessages = sortMessagesByRecency(
    messages.filter((message) => clipText(message.message_text, MAX_MESSAGE_TEXT_CHARS) !== null)
  ).reverse();

  return JSON.stringify(
    selectedMessages.map((message) => ({
      id: message.id,
      chat: message.chat_name,
      sender: message.sender_name,
      time: message.normalized_timestamp || message.timestamp_text,
      text: clipText(message.message_text, MAX_MESSAGE_TEXT_CHARS)
    })),
    null,
    0
  );
}

export function buildTaskExtractionPrompt(input: {
  todayDate: string;
  taskWindowHours: number;
  taskContextHours: number;
  messages: StoredMessageRow[];
}): TaskExtractionPrompt {
  const systemPrompt = [
    "Extract actionable items and awareness items from recent work chats.",
    "Allowed categories: urgent, today, follow_up, blocker, waiting_on, awareness, low_confidence.",
    "awareness means important new information the user should know even without an action.",
    "Include all distinct grounded items from the messages, including routine operational updates if they may matter to the user.",
    "Do not hallucinate items that are not supported by the messages.",
    "Return valid JSON only in the required shape.",
    JSON.stringify(
      {
        tasks: [
          {
            category: "awareness",
            title: "Short headline",
            details: "Why it matters",
            confidence: 0.92,
            source_chat_name: "Chat name",
            source_message_id: 123,
            source_message_time: "2026-04-18T02:40:00.000Z",
            source_excerpt: "Short quote or paraphrase",
            assignee_hint: "why this seems assigned to the user",
            due_date: "2026-04-18",
            waiting_on: "optional person/team",
            status: "open"
          }
        ]
      },
      null,
      0
    )
  ].join("\n");

  const userPrompt = [
    `Today is ${input.todayDate}.`,
    `Focus on the last ${input.taskWindowHours}h, with up to ${input.taskContextHours}h for context.`,
    "Answer: what do I need to do, and what new things should I know?",
    "Include all distinct items supported by this batch.",
    "Use only the messages in this batch.",
    "Messages:",
    formatMessagesForPrompt(input.messages)
  ].join("\n");

  logger.debug("Built task extraction prompt.", {
    batchMessages: input.messages.length,
    maxMessageTextChars: MAX_MESSAGE_TEXT_CHARS
  });

  return { systemPrompt, userPrompt };
}

export interface TaskCandidateForPrompt {
  category: string;
  title: string;
  details: string | null;
  confidence: number;
  source_chat_name: string | null;
  source_message_id: number | null;
  source_message_time: string | null;
  source_excerpt: string | null;
  assignee_hint: string | null;
  due_date: string | null;
  waiting_on: string | null;
  status: string;
}

export interface ChatQueryPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface QueryPlannerPrompt {
  systemPrompt: string;
  userPrompt: string;
}

export interface OperationFactPrompt {
  systemPrompt: string;
  userPrompt: string;
}

function formatCandidatesForPrompt(candidates: TaskCandidateForPrompt[]): string {
  return JSON.stringify(
    candidates.map((candidate) => ({
      category: candidate.category,
      title: clipText(candidate.title, 120),
      details: clipText(candidate.details, 220),
      confidence: candidate.confidence,
      source_chat_name: candidate.source_chat_name,
      source_message_id: candidate.source_message_id,
      source_message_time: candidate.source_message_time,
      source_excerpt: clipText(candidate.source_excerpt, 160),
      waiting_on: candidate.waiting_on
    })),
    null,
    0
  );
}

export function buildTaskConsolidationPrompt(input: {
  todayDate: string;
  candidates: TaskCandidateForPrompt[];
}): TaskExtractionPrompt {
  const systemPrompt = [
    "You deduplicate and consolidate extracted work items and awareness items.",
    "Merge items that clearly refer to the same thing.",
    "Keep all distinct grounded items after deduplication.",
    "Preserve awareness items, including routine operational updates, when they may matter to the user.",
    "Return valid JSON only in the required shape."
  ].join("\n");

  const userPrompt = [
    `Today is ${input.todayDate}.`,
    "Combine overlapping candidates into one best final list.",
    "Prefer the strongest source and highest confidence evidence.",
    "Do not remove items just because they seem routine if they are distinct and grounded.",
    "Do not invent new items beyond the candidates provided.",
    "Candidates JSON:",
    formatCandidatesForPrompt(input.candidates)
  ].join("\n");

  logger.debug("Built task consolidation prompt.", {
    candidateCount: input.candidates.length
  });

  return { systemPrompt, userPrompt };
}

export function buildChatQueryPrompt(input: {
  chatName: string;
  userQuestion: string;
  messages: StoredMessageRow[];
}): ChatQueryPrompt {
  const systemPrompt = [
    "Answer the user's question using only the provided chat messages.",
    "Do not hallucinate facts not grounded in the messages.",
    "If the messages are insufficient, say so plainly.",
    "Be concise but specific."
  ].join("\n");

  const userPrompt = [
    `Chat: ${input.chatName}`,
    `Question: ${input.userQuestion}`,
    "Use only this batch of messages.",
    "Messages:",
    formatMessagesForPrompt(input.messages)
  ].join("\n");

  logger.debug("Built chat query prompt.", {
    chatName: input.chatName,
    batchMessages: input.messages.length,
    maxMessageTextChars: MAX_MESSAGE_TEXT_CHARS
  });

  return { systemPrompt, userPrompt };
}

export function buildChatQuerySynthesisPrompt(input: {
  chatName: string;
  userQuestion: string;
  partialAnswers: string[];
}): ChatQueryPrompt {
  const systemPrompt = [
    "Combine partial answers from multiple chat-message batches into one final answer.",
    "Use only the provided partial answers.",
    "Do not invent facts not present in the partial answers.",
    "If the partial answers are insufficient, say so plainly."
  ].join("\n");

  const userPrompt = [
    `Chat: ${input.chatName}`,
    `Question: ${input.userQuestion}`,
    "Partial answers:",
    JSON.stringify(input.partialAnswers, null, 0)
  ].join("\n");

  logger.debug("Built chat query synthesis prompt.", {
    chatName: input.chatName,
    partialAnswers: input.partialAnswers.length
  });

  return { systemPrompt, userPrompt };
}

export function buildQueryPlannerPrompt(input: {
  todayDate: string;
  userQuestion: string;
  availableChats: string[];
}): QueryPlannerPrompt {
  const systemPrompt = [
    "Plan how to answer the user's operational chat query.",
    "Return valid JSON only.",
    "Use this shape exactly:",
    JSON.stringify(
      {
        primary_time_scope: "previous_day",
        analysis_time_scope: "last_7_days",
        target_chats: ["HQ Obajana Mines Group"],
        needs_retrieval: true,
        needs_fact_extraction: true,
        needs_numeric_aggregation: true,
        needs_analysis: true,
        answer_style: "report",
        reasoning: "short reason"
      },
      null,
      0
    )
  ].join("\n");

  const userPrompt = [
    `Today is ${input.todayDate}.`,
    `User question: ${input.userQuestion}`,
    `Available chats: ${JSON.stringify(input.availableChats)}`,
    "Infer the best plan. Use target_chats=[] only if all available chats should be considered."
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export function buildOperationFactExtractionPrompt(input: {
  messages: StoredMessageRow[];
}): OperationFactPrompt {
  const systemPrompt = [
    "Extract atomic operational facts from work chat messages.",
    "Return valid JSON only.",
    "Prefer normalized metric names like crushing_tons, running_hours, breakdown_hours, tph, drilling_meters, low_drilling_reason.",
    "Use fact_type='metric' for numeric facts and fact_type='reason' or fact_type='status' for text facts.",
    "Keep entity_name as specific as possible, for example crusher_1, crusher_2, drilling, excavator_3, dumper_14, total_crushing.",
    "Use source_message_id and source_chat_name from the provided messages.",
    "Use this shape exactly:",
    JSON.stringify(
      {
        facts: [
          {
            report_date: "2026-04-18",
            fact_type: "metric",
            entity_name: "crusher_2",
            metric_name: "crushing_tons",
            metric_value: 10288,
            metric_unit: "tons",
            text_value: null,
            dimensions: {
              shift: "day"
            },
            source_message_id: 195,
            source_chat_name: "HQ Obajana Mines Group",
            source_message_time: "2026-04-18T11:29:00.000Z",
            confidence: 0.92
          }
        ]
      },
      null,
      0
    )
  ].join("\n");

  const userPrompt = [
    "Messages:",
    formatMessagesForPrompt(input.messages)
  ].join("\n");

  return { systemPrompt, userPrompt };
}

export function buildGenericQueryAnswerPrompt(input: {
  userQuestion: string;
  planSummary: Record<string, unknown>;
  aggregatedFacts: Record<string, unknown>;
  evidenceMessages: Array<Record<string, unknown>>;
}): ChatQueryPrompt {
  const systemPrompt = [
    "Answer the user's question using the provided plan summary, aggregated facts, and evidence messages.",
    "Use exact numbers from aggregated facts when available.",
    "Use evidence messages for context, caveats, and explanations.",
    "If something is missing, say it was not found rather than guessing.",
    "Be structured and concise."
  ].join("\n");

  const userPrompt = [
    `Question: ${input.userQuestion}`,
    `Plan summary: ${JSON.stringify(input.planSummary, null, 0)}`,
    `Aggregated facts: ${JSON.stringify(input.aggregatedFacts, null, 0)}`,
    `Evidence messages: ${JSON.stringify(input.evidenceMessages, null, 0)}`
  ].join("\n");

  return { systemPrompt, userPrompt };
}
