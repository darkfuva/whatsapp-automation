import { AppConfig } from "../config/env";
import { StoredMessageRow, TaskCategory } from "../db/types";
import { ensureDirectoryExists, sanitizeFileName } from "../utils/files";
import { extractJsonBlock } from "../utils/json";
import { logger } from "../utils/logger";
import {
  buildChatQueryPrompt,
  buildChatQuerySynthesisPrompt,
  buildGenericQueryAnswerPrompt,
  buildOperationFactExtractionPrompt,
  buildQueryPlannerPrompt,
  buildTaskConsolidationPrompt,
  buildTaskExtractionPrompt,
  TaskCandidateForPrompt
} from "./promptBuilder";
import fs from "node:fs/promises";
import path from "node:path";

export interface ExtractedTaskCandidate {
  category: TaskCategory;
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

interface OllamaGenerateResponse {
  response?: string;
}

interface OllamaEmbedResponse {
  embeddings?: number[][];
  embedding?: number[];
}

export interface QueryPlanCandidate {
  primary_time_scope?: string;
  analysis_time_scope?: string;
  target_chats?: string[];
  needs_retrieval?: boolean;
  needs_fact_extraction?: boolean;
  needs_numeric_aggregation?: boolean;
  needs_analysis?: boolean;
  answer_style?: string;
  reasoning?: string;
}

export interface OperationFactCandidate {
  report_date: string | null;
  fact_type: string;
  entity_name: string | null;
  metric_name: string;
  metric_value: number | null;
  metric_unit: string | null;
  text_value: string | null;
  dimensions: Record<string, unknown> | null;
  source_message_id: number | null;
  source_chat_name: string | null;
  source_message_time: string | null;
  confidence: number;
}

function assertCategory(input: string): TaskCategory {
  const normalized = input.trim().toLowerCase();
  const aliases: Record<string, TaskCategory> = {
    urgent: "urgent",
    today: "today",
    follow_up: "follow_up",
    "follow-up": "follow_up",
    blocker: "blocker",
    waiting_on: "waiting_on",
    "waiting-on": "waiting_on",
    awareness: "awareness",
    information: "awareness",
    info: "awareness",
    low_confidence: "low_confidence",
    "low-confidence": "low_confidence"
  };

  return aliases[normalized] || "low_confidence";
}

function parseTaskResponse(content: string): ExtractedTaskCandidate[] {
  const jsonBlock = extractJsonBlock(content) || content.trim();
  const parsed = JSON.parse(jsonBlock) as
    | { tasks?: Array<Record<string, unknown>>; work_items?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> }
    | Array<Record<string, unknown>>;

  let tasks: Array<Record<string, unknown>> = [];
  if (Array.isArray(parsed)) {
    tasks = parsed;
  } else if (Array.isArray(parsed.tasks)) {
    tasks = parsed.tasks;
  } else if (Array.isArray(parsed.work_items)) {
    tasks = parsed.work_items;
  } else if (Array.isArray(parsed.items)) {
    tasks = parsed.items;
  }

  return tasks
    .map((task) => ({
      category: assertCategory(String(task.category || "low_confidence")),
      title: String(task.title || "").trim(),
      details: task.details ? String(task.details) : null,
      confidence: Math.max(0, Math.min(1, Number(task.confidence ?? 0))),
      source_chat_name: task.source_chat_name ? String(task.source_chat_name) : null,
      source_message_id: task.source_message_id ? Number(task.source_message_id) : null,
      source_message_time: task.source_message_time ? String(task.source_message_time) : null,
      source_excerpt: task.source_excerpt ? String(task.source_excerpt) : null,
      assignee_hint: task.assignee_hint ? String(task.assignee_hint) : null,
      due_date: task.due_date ? String(task.due_date) : null,
      waiting_on: task.waiting_on ? String(task.waiting_on) : null,
      status: task.status ? String(task.status) : "open"
    }))
    .filter((task) => task.title.length > 0);
}

function parseJsonPayload(content: string): unknown {
  const jsonBlock = extractJsonBlock(content) || content.trim();
  return JSON.parse(jsonBlock);
}

export class OllamaTaskClient {
  constructor(private readonly config: AppConfig) {}

  private async writeDebugArtifact(
    stage: string,
    payload: Record<string, unknown>
  ): Promise<void> {
    if (!this.config.debug) {
      return;
    }

    const directory = path.join(this.config.debugArtifactsDir, "ai");
    ensureDirectoryExists(directory);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filePath = path.join(directory, `${timestamp}_${sanitizeFileName(stage)}.json`);
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");

    logger.debug("Saved AI debug artifact.", { stage, filePath });
  }

  private async runGenerate(input: {
    systemPrompt: string;
    userPrompt: string;
    stage: string;
  }): Promise<ExtractedTaskCandidate[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.ollamaTimeoutMs);
    const requestPayload = {
      model: this.config.ollamaModel,
      system: input.systemPrompt,
      prompt: input.userPrompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0.1,
        num_ctx: this.config.ollamaNumCtx
      }
    };

    logger.debug("Sending Ollama extraction request.", {
      stage: input.stage,
      model: this.config.ollamaModel,
      systemChars: input.systemPrompt.length,
      userChars: input.userPrompt.length,
      numCtx: this.config.ollamaNumCtx
    });

    try {
      const response = await fetch(`${this.config.ollamaBaseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as OllamaGenerateResponse;
      if (!payload.response) {
        logger.warn("Ollama response did not contain a text payload.");
        await this.writeDebugArtifact(input.stage, {
          stage: input.stage,
          request: requestPayload,
          rawResponse: payload,
          parsedTasks: []
        });
        return [];
      }

      const parsedTasks = parseTaskResponse(payload.response);

      logger.debug("Received Ollama extraction response.", {
        stage: input.stage,
        rawResponseChars: payload.response.length,
        parsedTasks: parsedTasks.length
      });

      await this.writeDebugArtifact(input.stage, {
        stage: input.stage,
        request: requestPayload,
        rawResponse: payload.response,
        parsedTasks
      });

      return parsedTasks;
    } catch (error) {
      if (error instanceof SyntaxError) {
        logger.warn("Ollama returned non-JSON task output; returning no tasks.", {
          model: this.config.ollamaModel,
          stage: input.stage
        });
        await this.writeDebugArtifact(input.stage, {
          stage: input.stage,
          request: requestPayload,
          parseError: "SyntaxError"
        });
        return [];
      }

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async runGenerateText(input: {
    systemPrompt: string;
    userPrompt: string;
    stage: string;
    jsonMode?: boolean;
  }): Promise<string> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.ollamaTimeoutMs);
    const requestPayload = {
      model: this.config.ollamaModel,
      system: input.systemPrompt,
      prompt: input.userPrompt,
      stream: false,
      ...(input.jsonMode ? { format: "json" as const } : {}),
      options: {
        temperature: 0.1,
        num_ctx: this.config.ollamaNumCtx
      }
    };

    logger.debug("Sending Ollama text request.", {
      stage: input.stage,
      model: this.config.ollamaModel,
      systemChars: input.systemPrompt.length,
      userChars: input.userPrompt.length,
      numCtx: this.config.ollamaNumCtx
    });

    try {
      const response = await fetch(`${this.config.ollamaBaseUrl.replace(/\/$/, "")}/api/generate`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        throw new Error(`Ollama request failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as OllamaGenerateResponse;
      const rawResponse = payload.response?.trim() || "";

      await this.writeDebugArtifact(input.stage, {
        stage: input.stage,
        request: requestPayload,
        rawResponse
      });

      logger.debug("Received Ollama text response.", {
        stage: input.stage,
        rawResponseChars: rawResponse.length
      });

      return rawResponse;
    } finally {
      clearTimeout(timeout);
    }
  }

  async extractTasks(messages: StoredMessageRow[], todayDate: string): Promise<ExtractedTaskCandidate[]> {
    return this.runGenerate(
      {
        ...buildTaskExtractionPrompt({
          todayDate,
          taskWindowHours: this.config.taskWindowHours,
          taskContextHours: this.config.taskContextHours,
          messages
        }),
        stage: "batch"
      }
    );
  }

  async extractTasksForBatch(
    messages: StoredMessageRow[],
    todayDate: string,
    batchLabel: string
  ): Promise<ExtractedTaskCandidate[]> {
    return this.runGenerate(
      {
        ...buildTaskExtractionPrompt({
          todayDate,
          taskWindowHours: this.config.taskWindowHours,
          taskContextHours: this.config.taskContextHours,
          messages
        }),
        stage: batchLabel
      }
    );
  }

  async consolidateTasks(candidates: TaskCandidateForPrompt[], todayDate: string): Promise<ExtractedTaskCandidate[]> {
    return this.runGenerate({
      ...buildTaskConsolidationPrompt({
        todayDate,
        candidates
      }),
      stage: "consolidation"
    });
  }

  async askFromMessages(
    chatName: string,
    userQuestion: string,
    messages: StoredMessageRow[],
    stage: string
  ): Promise<string> {
    return this.runGenerateText({
      ...buildChatQueryPrompt({
        chatName,
        userQuestion,
        messages
      }),
      stage
    });
  }

  async synthesizeChatAnswers(
    chatName: string,
    userQuestion: string,
    partialAnswers: string[]
  ): Promise<string> {
    return this.runGenerateText({
      ...buildChatQuerySynthesisPrompt({
        chatName,
        userQuestion,
        partialAnswers
      }),
      stage: "chat_query_synthesis"
    });
  }

  async embedTexts(texts: string[], stage: string): Promise<number[][]> {
    if (texts.length === 0) {
      return [];
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.ollamaTimeoutMs);
    const requestPayload = {
      model: this.config.ollamaEmbedModel,
      input: texts
    };

    logger.debug("Sending Ollama embedding request.", {
      stage,
      model: this.config.ollamaEmbedModel,
      texts: texts.length
    });

    try {
      const response = await fetch(`${this.config.ollamaBaseUrl.replace(/\/$/, "")}/api/embed`, {
        method: "POST",
        headers: {
          "content-type": "application/json"
        },
        signal: controller.signal,
        body: JSON.stringify(requestPayload)
      });

      if (!response.ok) {
        throw new Error(`Ollama embedding request failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as OllamaEmbedResponse;
      const embeddings = Array.isArray(payload.embeddings)
        ? payload.embeddings
        : Array.isArray(payload.embedding)
          ? [payload.embedding]
          : [];

      await this.writeDebugArtifact(stage, {
        stage,
        request: {
          model: this.config.ollamaEmbedModel,
          textCount: texts.length
        },
        embeddingCount: embeddings.length,
        embeddingDim: embeddings[0]?.length || 0
      });

      return embeddings;
    } finally {
      clearTimeout(timeout);
    }
  }

  async planQuery(todayDate: string, userQuestion: string, availableChats: string[]): Promise<QueryPlanCandidate | null> {
    const response = await this.runGenerateText({
      ...buildQueryPlannerPrompt({
        todayDate,
        userQuestion,
        availableChats
      }),
      stage: "query_planner",
      jsonMode: true
    });

    try {
      return parseJsonPayload(response) as QueryPlanCandidate;
    } catch {
      logger.warn("Failed to parse query planner response.");
      return null;
    }
  }

  async extractOperationFacts(messages: StoredMessageRow[], stage: string): Promise<OperationFactCandidate[]> {
    const response = await this.runGenerateText({
      ...buildOperationFactExtractionPrompt({ messages }),
      stage,
      jsonMode: true
    });

    try {
      const parsed = parseJsonPayload(response) as { facts?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> };
      const facts = Array.isArray(parsed.facts) ? parsed.facts : Array.isArray(parsed.items) ? parsed.items : [];

      return facts
        .map((fact) => ({
          report_date: fact.report_date ? String(fact.report_date) : null,
          fact_type: String(fact.fact_type || "metric"),
          entity_name: fact.entity_name ? String(fact.entity_name) : null,
          metric_name: String(fact.metric_name || "").trim(),
          metric_value: fact.metric_value === null || fact.metric_value === undefined ? null : Number(fact.metric_value),
          metric_unit: fact.metric_unit ? String(fact.metric_unit) : null,
          text_value: fact.text_value ? String(fact.text_value) : null,
          dimensions: fact.dimensions && typeof fact.dimensions === "object" ? (fact.dimensions as Record<string, unknown>) : null,
          source_message_id: fact.source_message_id ? Number(fact.source_message_id) : null,
          source_chat_name: fact.source_chat_name ? String(fact.source_chat_name) : null,
          source_message_time: fact.source_message_time ? String(fact.source_message_time) : null,
          confidence: Math.max(0, Math.min(1, Number(fact.confidence ?? 0)))
        }))
        .filter((fact) => fact.metric_name.length > 0);
    } catch {
      logger.warn("Failed to parse operation facts response.", { stage });
      return [];
    }
  }

  async answerGenericQuery(input: {
    userQuestion: string;
    planSummary: Record<string, unknown>;
    aggregatedFacts: Record<string, unknown>;
    evidenceMessages: Array<Record<string, unknown>>;
  }): Promise<string> {
    return this.runGenerateText({
      ...buildGenericQueryAnswerPrompt(input),
      stage: "generic_query_answer"
    });
  }
}
