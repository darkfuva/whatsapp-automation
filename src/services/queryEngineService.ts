import { OllamaTaskClient, OperationFactCandidate, QueryPlanCandidate } from "../ai/ollamaClient";
import { AppConfig } from "../config/env";
import { AppDatabase } from "../db/database";
import { OperationFactRow, StoredMessageRow } from "../db/types";
import { sha256 } from "../utils/hash";
import { logger } from "../utils/logger";
import { EmbeddingService } from "./embeddingService";

const MAX_FACT_BATCH_MESSAGES = 24;
const MAX_FACT_BATCH_CHARS = 4200;
const MAX_EVIDENCE_MESSAGES = 12;
const MAX_EVIDENCE_TEXT_CHARS = 280;
const MAX_TEXT_FACTS = 24;
const MAX_TEXT_FACT_CHARS = 220;

interface TimeRange {
  label: string;
  fromIso: string;
  toIso: string;
}

interface ResolvedQueryPlan {
  primaryRange: TimeRange;
  analysisRange: TimeRange;
  targetChats: string[];
  needsRetrieval: boolean;
  needsFactExtraction: boolean;
  needsNumericAggregation: boolean;
  needsAnalysis: boolean;
  answerStyle: string;
  reasoning: string;
  source: "llm" | "heuristic";
}

interface QueryExecutionResult {
  answer: string;
  plan: ResolvedQueryPlan;
  messagesConsidered: number;
  factsLoaded: number;
  evidenceMessages: number;
}

function clipText(input: string | null | undefined, maxChars: number): string | null {
  if (!input) {
    return null;
  }

  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length === 0) {
    return null;
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 3))}...`;
}

function messageTime(message: StoredMessageRow): number {
  return new Date(message.normalized_timestamp || message.created_at).getTime();
}

function factTime(row: OperationFactRow): number {
  return new Date(row.source_message_time || row.report_date || row.created_at).getTime();
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function resolveTimeRange(scope: string | undefined, now = new Date()): TimeRange {
  const normalized = (scope || "").trim().toLowerCase();
  const startToday = startOfLocalDay(now);
  const startYesterday = addDays(startToday, -1);

  switch (normalized) {
    case "today":
      return {
        label: "today",
        fromIso: startToday.toISOString(),
        toIso: now.toISOString()
      };
    case "previous_day":
    case "yesterday":
      return {
        label: "previous_day",
        fromIso: startYesterday.toISOString(),
        toIso: startToday.toISOString()
      };
    case "last_24h":
      return {
        label: "last_24h",
        fromIso: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
        toIso: now.toISOString()
      };
    case "last_7_days":
    case "last_week":
      return {
        label: "last_7_days",
        fromIso: addDays(startToday, -7).toISOString(),
        toIso: now.toISOString()
      };
    case "last_30_days":
    case "all_available":
      return {
        label: normalized || "last_30_days",
        fromIso: addDays(startToday, -30).toISOString(),
        toIso: now.toISOString()
      };
    case "last_72h":
    default:
      return {
        label: normalized || "last_72h",
        fromIso: new Date(now.getTime() - 72 * 60 * 60 * 1000).toISOString(),
        toIso: now.toISOString()
      };
  }
}

function normalizeChatFilter(raw: string | undefined, availableChats: string[]): string[] {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  const requested = raw
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  const availableSet = new Set(availableChats);
  return requested.filter((chat) => availableSet.has(chat));
}

function buildHeuristicPlan(
  userQuestion: string,
  availableChats: string[],
  requestedChats: string[]
): ResolvedQueryPlan {
  const question = userQuestion.toLowerCase();
  const mentionsPreviousDay =
    /\byesterday\b/.test(question) ||
    /previous day/.test(question) ||
    /last day/.test(question) ||
    /00[:.]?00/.test(question);
  const mentionsToday = /\btoday\b/.test(question);
  const mentionsWeek = /last\s*1?\s*week/.test(question) || /last\s*7\s*days?/.test(question) || /\bweekly\b/.test(question);
  const mentionsMetrics =
    /\btotal\b/.test(question) ||
    /\btons?\b/.test(question) ||
    /\btph\b/.test(question) ||
    /\bhours?\b/.test(question) ||
    /\bbreakdowns?\b/.test(question) ||
    /\bdrilling\b/.test(question) ||
    /\bcrusher\b/.test(question) ||
    /\bexcavators?\b/.test(question) ||
    /\bdumpers?\b/.test(question) ||
    /\bmtrs?\b/.test(question) ||
    /\bmeters?\b/.test(question);
  const mentionsAnalysis =
    /\banalysis\b/.test(question) ||
    /\btrend\b/.test(question) ||
    /\bwhy\b/.test(question) ||
    /\breason/.test(question) ||
    mentionsWeek;

  const primaryScope = mentionsPreviousDay ? "previous_day" : mentionsToday ? "today" : "last_72h";
  const analysisScope = mentionsWeek ? "last_7_days" : primaryScope;

  return {
    primaryRange: resolveTimeRange(primaryScope),
    analysisRange: resolveTimeRange(analysisScope),
    targetChats: requestedChats.length > 0 ? requestedChats : availableChats,
    needsRetrieval: true,
    needsFactExtraction: mentionsMetrics || mentionsAnalysis,
    needsNumericAggregation: mentionsMetrics,
    needsAnalysis: mentionsAnalysis || !mentionsMetrics,
    answerStyle: mentionsMetrics ? "report" : "answer",
    reasoning: "Heuristic plan based on time, metric, and analysis terms in the question.",
    source: "heuristic"
  };
}

function resolveQueryPlan(input: {
  candidate: QueryPlanCandidate | null;
  userQuestion: string;
  availableChats: string[];
  requestedChats: string[];
}): ResolvedQueryPlan {
  const fallback = buildHeuristicPlan(input.userQuestion, input.availableChats, input.requestedChats);
  if (!input.candidate) {
    return fallback;
  }

  const availableSet = new Set(input.availableChats);
  const candidateChats = Array.isArray(input.candidate.target_chats)
    ? input.candidate.target_chats.filter((chat): chat is string => typeof chat === "string" && availableSet.has(chat))
    : [];

  return {
    primaryRange: resolveTimeRange(input.candidate.primary_time_scope || fallback.primaryRange.label),
    analysisRange: resolveTimeRange(input.candidate.analysis_time_scope || fallback.analysisRange.label),
    targetChats:
      input.requestedChats.length > 0
        ? input.requestedChats
        : candidateChats.length > 0
          ? candidateChats
          : input.availableChats,
    needsRetrieval: input.candidate.needs_retrieval ?? fallback.needsRetrieval,
    needsFactExtraction: input.candidate.needs_fact_extraction ?? fallback.needsFactExtraction,
    needsNumericAggregation: input.candidate.needs_numeric_aggregation ?? fallback.needsNumericAggregation,
    needsAnalysis: input.candidate.needs_analysis ?? fallback.needsAnalysis,
    answerStyle: input.candidate.answer_style || fallback.answerStyle,
    reasoning: input.candidate.reasoning || fallback.reasoning,
    source: "llm"
  };
}

function splitIntoFactBatches(messages: StoredMessageRow[]): StoredMessageRow[][] {
  const meaningfulMessages = [...messages]
    .filter((message) => Boolean(clipText(message.message_text, MAX_FACT_BATCH_CHARS)))
    .sort((left, right) => messageTime(left) - messageTime(right));

  const batches: StoredMessageRow[][] = [];
  let currentBatch: StoredMessageRow[] = [];
  let currentChars = 0;

  for (const message of meaningfulMessages) {
    const estimatedChars =
      (message.message_text || "").length + (message.chat_name || "").length + (message.sender_name || "").length + 80;
    const wouldOverflowCount = currentBatch.length >= MAX_FACT_BATCH_MESSAGES;
    const wouldOverflowChars = currentChars + estimatedChars > MAX_FACT_BATCH_CHARS;

    if (currentBatch.length > 0 && (wouldOverflowCount || wouldOverflowChars)) {
      batches.push(currentBatch);
      currentBatch = [];
      currentChars = 0;
    }

    currentBatch.push(message);
    currentChars += estimatedChars;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
}

function factContentHash(fact: OperationFactCandidate): string {
  return sha256(
    JSON.stringify({
      reportDate: fact.report_date,
      factType: fact.fact_type,
      entityName: fact.entity_name,
      metricName: fact.metric_name,
      metricValue: fact.metric_value,
      metricUnit: fact.metric_unit,
      textValue: fact.text_value,
      dimensions: fact.dimensions,
      sourceMessageId: fact.source_message_id,
      sourceChatName: fact.source_chat_name
    })
  );
}

function reportDateKey(row: OperationFactRow): string {
  if (row.report_date && row.report_date.length >= 10) {
    return row.report_date.slice(0, 10);
  }

  if (row.source_message_time && row.source_message_time.length >= 10) {
    return row.source_message_time.slice(0, 10);
  }

  return "unknown";
}

function isExplicitTotalEntity(entityName: string | null): boolean {
  if (!entityName) {
    return false;
  }

  return /\b(total|overall|grand)\b/i.test(entityName);
}

function pickLatestFacts(rows: OperationFactRow[]): OperationFactRow[] {
  const bestByKey = new Map<string, OperationFactRow>();

  for (const row of rows) {
    const key = [
      reportDateKey(row),
      row.fact_type,
      row.metric_name,
      row.metric_unit || "",
      row.entity_name || "",
      row.dimensions_json || ""
    ].join("|");

    const current = bestByKey.get(key);
    if (!current || factTime(row) >= factTime(current)) {
      bestByKey.set(key, row);
    }
  }

  return [...bestByKey.values()].sort((left, right) => factTime(left) - factTime(right));
}

function buildAggregatedFacts(primaryFacts: OperationFactRow[], analysisFacts: OperationFactRow[]): Record<string, unknown> {
  const latestPrimary = pickLatestFacts(primaryFacts);
  const latestAnalysis = pickLatestFacts(analysisFacts);

  const primaryNumeric = latestPrimary.filter((fact) => Number.isFinite(fact.metric_value));
  const analysisNumeric = latestAnalysis.filter((fact) => Number.isFinite(fact.metric_value));
  const primaryTextFacts = latestPrimary
    .filter((fact) => fact.text_value && fact.text_value.trim().length > 0)
    .sort((left, right) => factTime(right) - factTime(left))
    .slice(0, MAX_TEXT_FACTS)
    .map((fact) => ({
      report_date: reportDateKey(fact),
      fact_type: fact.fact_type,
      entity_name: fact.entity_name,
      metric_name: fact.metric_name,
      text_value: clipText(fact.text_value, MAX_TEXT_FACT_CHARS),
      source_chat_name: fact.source_chat_name,
      source_message_time: fact.source_message_time,
      confidence: fact.confidence
    }));

  const byEntity = new Map<string, Record<string, unknown>>();
  const dailyMetricBuckets = new Map<string, { totals: number[]; summedEntities: number[] }>();

  for (const fact of primaryNumeric) {
    const entityKey = fact.entity_name || "unscoped";
    const entity = byEntity.get(entityKey) || {};
    entity[fact.metric_name] = {
      value: fact.metric_value,
      unit: fact.metric_unit,
      report_date: reportDateKey(fact),
      confidence: fact.confidence
    };
    byEntity.set(entityKey, entity);
  }

  for (const fact of analysisNumeric) {
    const bucketKey = `${reportDateKey(fact)}|${fact.metric_name}|${fact.metric_unit || ""}`;
    const bucket = dailyMetricBuckets.get(bucketKey) || { totals: [], summedEntities: [] };

    if (isExplicitTotalEntity(fact.entity_name)) {
      bucket.totals.push(Number(fact.metric_value));
    } else {
      bucket.summedEntities.push(Number(fact.metric_value));
    }

    dailyMetricBuckets.set(bucketKey, bucket);
  }

  const dailyTotals: Array<Record<string, unknown>> = [];
  for (const [bucketKey, bucket] of dailyMetricBuckets.entries()) {
    const [date, metricName, unit] = bucketKey.split("|");
    const value =
      bucket.totals.length > 0
        ? Math.max(...bucket.totals)
        : bucket.summedEntities.reduce((sum, current) => sum + current, 0);

    dailyTotals.push({
      report_date: date,
      metric_name: metricName,
      value,
      unit: unit || null
    });
  }

  dailyTotals.sort((left, right) => {
    const leftKey = `${left.report_date}|${left.metric_name}`;
    const rightKey = `${right.report_date}|${right.metric_name}`;
    return leftKey.localeCompare(rightKey);
  });

  const totalsByMetric = new Map<string, { value: number; unit: string | null }>();
  for (const fact of primaryNumeric) {
    const key = `${fact.metric_name}|${fact.metric_unit || ""}`;
    const current = totalsByMetric.get(key);

    if (isExplicitTotalEntity(fact.entity_name)) {
      totalsByMetric.set(key, {
        value: Math.max(current?.value ?? Number.NEGATIVE_INFINITY, Number(fact.metric_value)),
        unit: fact.metric_unit
      });
      continue;
    }

    if (!current) {
      totalsByMetric.set(key, {
        value: Number(fact.metric_value),
        unit: fact.metric_unit
      });
    } else if (!Number.isFinite(current.value)) {
      totalsByMetric.set(key, {
        value: Number(fact.metric_value),
        unit: fact.metric_unit
      });
    } else {
      totalsByMetric.set(key, {
        value: current.value + Number(fact.metric_value),
        unit: fact.metric_unit
      });
    }
  }

  return {
    primary_fact_count: primaryFacts.length,
    analysis_fact_count: analysisFacts.length,
    totals_by_metric: Object.fromEntries(
      [...totalsByMetric.entries()].map(([key, value]) => [key.split("|")[0], value])
    ),
    by_entity: Object.fromEntries([...byEntity.entries()]),
    daily_totals: dailyTotals,
    text_facts: primaryTextFacts
  };
}

export class QueryEngineService {
  private readonly client: OllamaTaskClient;
  private readonly embeddingService: EmbeddingService;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase
  ) {
    this.client = new OllamaTaskClient(config);
    this.embeddingService = new EmbeddingService(config, database);
  }

  async query(userQuestion: string, chatFilter?: string): Promise<QueryExecutionResult> {
    const availableChats = this.database.getActiveChats().map((chat) => chat.name);
    if (availableChats.length === 0) {
      throw new Error("No active chats are configured. Add chats first with npm run chats:add.");
    }

    const requestedChats = normalizeChatFilter(chatFilter, availableChats);
    if (chatFilter && chatFilter.trim().length > 0 && requestedChats.length === 0) {
      throw new Error(`No active chats matched the filter: ${chatFilter}`);
    }

    const plannerCandidate = await this.client.planQuery(
      new Date().toISOString().slice(0, 10),
      userQuestion,
      availableChats
    ).catch((error) => {
      logger.warn("Falling back to heuristic query plan after planner failure.", {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    });

    const plan = resolveQueryPlan({
      candidate: plannerCandidate,
      userQuestion,
      availableChats,
      requestedChats
    });

    logger.info("Resolved generic query plan.", {
      source: plan.source,
      targetChats: plan.targetChats,
      primaryRange: plan.primaryRange,
      analysisRange: plan.analysisRange,
      needsRetrieval: plan.needsRetrieval,
      needsFactExtraction: plan.needsFactExtraction,
      needsNumericAggregation: plan.needsNumericAggregation,
      needsAnalysis: plan.needsAnalysis
    });

    const analysisMessages = this.database.getMessagesForRange({
      fromIso: plan.analysisRange.fromIso,
      toIso: plan.analysisRange.toIso,
      chatNames: plan.targetChats
    });

    if (analysisMessages.length === 0) {
      return {
        answer: `No stored messages were found for ${plan.targetChats.join(", ")} in the ${plan.analysisRange.label} window.`,
        plan,
        messagesConsidered: 0,
        factsLoaded: 0,
        evidenceMessages: 0
      };
    }

    const primaryMessages = analysisMessages.filter((message) => {
      const time = messageTime(message);
      return (
        time >= new Date(plan.primaryRange.fromIso).getTime() &&
        time < new Date(plan.primaryRange.toIso).getTime()
      );
    });

    if (plan.needsFactExtraction) {
      const factBatches = splitIntoFactBatches(analysisMessages);
      let extractedFactCount = 0;

      for (let index = 0; index < factBatches.length; index += 1) {
        const facts = await this.client.extractOperationFacts(
          factBatches[index],
          `operation_fact_batch_${index + 1}_of_${factBatches.length}`
        );

        if (facts.length === 0) {
          continue;
        }

        this.database.insertOperationFacts(
          facts.map((fact) => ({
            contentHash: factContentHash(fact),
            sourceMessageId: fact.source_message_id,
            sourceChatName: fact.source_chat_name,
            sourceMessageTime: fact.source_message_time,
            reportDate: fact.report_date,
            factType: fact.fact_type,
            entityName: fact.entity_name,
            metricName: fact.metric_name,
            metricValue: fact.metric_value,
            metricUnit: fact.metric_unit,
            textValue: fact.text_value,
            dimensionsJson: fact.dimensions ? JSON.stringify(fact.dimensions) : null,
            confidence: fact.confidence,
            extractorModel: this.config.ollamaModel
          }))
        );

        extractedFactCount += facts.length;
      }

      logger.info("Extracted operation facts for generic query.", {
        extractedFacts: extractedFactCount,
        batches: factBatches.length
      });
    }

    const primaryFacts = this.database.getOperationFactsForRange({
      fromIso: plan.primaryRange.fromIso,
      toIso: plan.primaryRange.toIso,
      chatNames: plan.targetChats
    });
    const analysisFacts = this.database.getOperationFactsForRange({
      fromIso: plan.analysisRange.fromIso,
      toIso: plan.analysisRange.toIso,
      chatNames: plan.targetChats
    });

    let evidenceMessages = primaryMessages.length > 0 ? primaryMessages : analysisMessages;
    if (plan.needsRetrieval) {
      const matches = await this.embeddingService.retrieveRelevantMessagesFromMessages(
        analysisMessages,
        userQuestion,
        this.config.retrievalTopK
      );

      const matchedIds = new Set(matches.map((match) => match.messageId));
      const retrievedMessages = analysisMessages.filter((message) => matchedIds.has(message.id));
      if (retrievedMessages.length > 0) {
        evidenceMessages = retrievedMessages;
      }
    }

    const formattedEvidence = [...evidenceMessages]
      .sort((left, right) => messageTime(right) - messageTime(left))
      .slice(0, MAX_EVIDENCE_MESSAGES)
      .map((message) => ({
        id: message.id,
        chat: message.chat_name,
        sender: message.sender_name,
        time: message.normalized_timestamp || message.timestamp_text,
        text: clipText(message.message_text, MAX_EVIDENCE_TEXT_CHARS)
      }));

    const aggregatedFacts = buildAggregatedFacts(primaryFacts, analysisFacts);
    const answer = await this.client.answerGenericQuery({
      userQuestion,
      planSummary: {
        source: plan.source,
        answer_style: plan.answerStyle,
        reasoning: plan.reasoning,
        target_chats: plan.targetChats,
        primary_range: plan.primaryRange,
        analysis_range: plan.analysisRange
      },
      aggregatedFacts,
      evidenceMessages: formattedEvidence
    });

    return {
      answer,
      plan,
      messagesConsidered: analysisMessages.length,
      factsLoaded: analysisFacts.length,
      evidenceMessages: formattedEvidence.length
    };
  }
}
