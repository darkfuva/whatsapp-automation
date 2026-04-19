import { AppConfig } from "../config/env";
import { AppDatabase } from "../db/database";
import { StoredMessageRow } from "../db/types";
import { logger } from "../utils/logger";
import { OllamaTaskClient } from "../ai/ollamaClient";
import { EmbeddingService } from "./embeddingService";

const MAX_BATCH_MESSAGES = 28;
const MAX_BATCH_CHARS = 3600;

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
  const sorted = [...messages]
    .filter((message) => Boolean(message.message_text && message.message_text.trim().length > 0))
    .sort((left, right) => messageSortTime(left) - messageSortTime(right));

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

export class ChatQueryService {
  private readonly client: OllamaTaskClient;
  private readonly embeddingService: EmbeddingService;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase
  ) {
    this.client = new OllamaTaskClient(config);
    this.embeddingService = new EmbeddingService(config, database);
  }

  async ask(chatName: string, userQuestion: string, hours: number): Promise<string> {
    const messages = this.database.getMessagesForChatSince(chatName, hours);
    if (messages.length === 0) {
      return `No stored messages found for "${chatName}" in the last ${hours} hour(s).`;
    }

    const relevantMatches = await this.embeddingService.retrieveRelevantMessages(
      chatName,
      userQuestion,
      hours,
      this.config.retrievalTopK
    );

    const relevantMessageIds = new Set(relevantMatches.map((match) => match.messageId));
    const retrievedMessages = messages.filter((message) => relevantMessageIds.has(message.id));

    logger.info("Running retrieval-backed chat query over stored messages.", {
      chatName,
      hours,
      messages: messages.length,
      retrievedMessages: retrievedMessages.length,
      topK: this.config.retrievalTopK
    });

    if (retrievedMessages.length === 0) {
      return `No relevant embedded messages were found for "${chatName}" in the last ${hours} hour(s).`;
    }

    const batches = splitIntoBatches(retrievedMessages);

    if (batches.length === 1) {
      return this.client.askFromMessages(chatName, userQuestion, batches[0], "chat_query_batch_1_of_1");
    }

    const partialAnswers: string[] = [];
    for (let index = 0; index < batches.length; index += 1) {
      const answer = await this.client.askFromMessages(
        chatName,
        userQuestion,
        batches[index],
        `chat_query_batch_${index + 1}_of_${batches.length}`
      );

      if (answer.trim().length > 0) {
        partialAnswers.push(answer.trim());
      }
    }

    if (partialAnswers.length === 0) {
      return `No answer could be generated for "${chatName}" from the stored messages.`;
    }

    if (partialAnswers.length === 1) {
      return partialAnswers[0];
    }

    return this.client.synthesizeChatAnswers(chatName, userQuestion, partialAnswers);
  }
}
