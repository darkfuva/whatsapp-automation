import { OllamaTaskClient } from "../ai/ollamaClient";
import { AppConfig } from "../config/env";
import { AppDatabase } from "../db/database";
import { MessageEmbeddingMatch, StoredMessageRow } from "../db/types";
import { sha256 } from "../utils/hash";
import { logger } from "../utils/logger";
import { cosineSimilarity } from "../utils/vector";

function buildEmbeddingText(message: StoredMessageRow): string | null {
  const messageText = message.message_text?.replace(/\s+/g, " ").trim();
  if (!messageText) {
    return null;
  }

  const parts = [
    `chat: ${message.chat_name}`,
    message.sender_name ? `sender: ${message.sender_name}` : null,
    message.normalized_timestamp ? `time: ${message.normalized_timestamp}` : null,
    `message: ${messageText}`
  ].filter((value): value is string => Boolean(value));

  return parts.join("\n");
}

export class EmbeddingService {
  private readonly client: OllamaTaskClient;

  constructor(
    private readonly config: AppConfig,
    private readonly database: AppDatabase
  ) {
    this.client = new OllamaTaskClient(config);
  }

  async ensureEmbeddingsForChatSince(chatName: string, hours: number): Promise<{ indexed: number; existing: number }> {
    const missingMessages = this.database.getMessagesMissingEmbeddingsForChatSince(
      chatName,
      hours,
      this.config.ollamaEmbedModel
    );
    const existing = this.database.getMessagesWithEmbeddingsCountForChatSince(
      chatName,
      hours,
      this.config.ollamaEmbedModel
    );

    if (missingMessages.length === 0) {
      return { indexed: 0, existing };
    }

    const texts = missingMessages
      .map((message) => ({
        message,
        text: buildEmbeddingText(message)
      }))
      .filter((item): item is { message: StoredMessageRow; text: string } => Boolean(item.text));

    if (texts.length === 0) {
      return { indexed: 0, existing };
    }

    const embeddings = await this.client.embedTexts(
      texts.map((item) => item.text),
      `embeddings_${chatName}`
    );

    let indexed = 0;
    for (let index = 0; index < texts.length; index += 1) {
      const embedding = embeddings[index];
      if (!Array.isArray(embedding) || embedding.length === 0) {
        continue;
      }

      this.database.upsertMessageEmbedding({
        messageId: texts[index].message.id,
        modelName: this.config.ollamaEmbedModel,
        contentHash: sha256(texts[index].text),
        embedding
      });
      indexed += 1;
    }

    logger.info("Indexed message embeddings.", {
      chatName,
      indexed,
      existing,
      model: this.config.ollamaEmbedModel
    });

    return { indexed, existing };
  }

  async ensureEmbeddingsForMessages(messages: StoredMessageRow[]): Promise<{ indexed: number; existing: number }> {
    const meaningfulMessages = messages
      .map((message) => ({
        message,
        text: buildEmbeddingText(message)
      }))
      .filter((item): item is { message: StoredMessageRow; text: string } => Boolean(item.text));

    if (meaningfulMessages.length === 0) {
      return { indexed: 0, existing: 0 };
    }

    const existingEmbeddings = this.database.getMessageEmbeddingsForMessageIds(
      meaningfulMessages.map((item) => item.message.id),
      this.config.ollamaEmbedModel
    );
    const existingByMessageId = new Set(existingEmbeddings.map((embedding) => embedding.message_id));
    const missing = meaningfulMessages.filter((item) => !existingByMessageId.has(item.message.id));

    if (missing.length === 0) {
      return { indexed: 0, existing: existingEmbeddings.length };
    }

    const embeddings = await this.client.embedTexts(
      missing.map((item) => item.text),
      "embeddings_range"
    );

    let indexed = 0;
    for (let index = 0; index < missing.length; index += 1) {
      const embedding = embeddings[index];
      if (!Array.isArray(embedding) || embedding.length === 0) {
        continue;
      }

      this.database.upsertMessageEmbedding({
        messageId: missing[index].message.id,
        modelName: this.config.ollamaEmbedModel,
        contentHash: sha256(missing[index].text),
        embedding
      });
      indexed += 1;
    }

    logger.info("Indexed message embeddings for range.", {
      indexed,
      existing: existingEmbeddings.length,
      model: this.config.ollamaEmbedModel
    });

    return { indexed, existing: existingEmbeddings.length };
  }

  async retrieveRelevantMessages(
    chatName: string,
    userQuestion: string,
    hours: number,
    topK: number
  ): Promise<MessageEmbeddingMatch[]> {
    await this.ensureEmbeddingsForChatSince(chatName, hours);

    const questionEmbeddings = await this.client.embedTexts(
      [`question: ${userQuestion}\nchat: ${chatName}`],
      "query_embedding"
    );
    const queryEmbedding = questionEmbeddings[0];

    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return [];
    }

    const rows = this.database.getMessageEmbeddingsForChatSince(chatName, hours, this.config.ollamaEmbedModel);
    const matches = rows
      .map<MessageEmbeddingMatch | null>((row) => {
        const embedding = JSON.parse(row.embedding.embedding_json) as number[];
        const similarity = cosineSimilarity(queryEmbedding, embedding);

        if (!Number.isFinite(similarity)) {
          return null;
        }

        return {
          messageId: row.message.id,
          chatName: row.message.chat_name,
          senderName: row.message.sender_name,
          normalizedTimestamp: row.message.normalized_timestamp,
          timestampText: row.message.timestamp_text,
          messageText: row.message.message_text,
          similarity
        };
      })
      .filter((match): match is MessageEmbeddingMatch => Boolean(match))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, topK);

    logger.debug("Retrieved relevant embedded messages.", {
      chatName,
      hours,
      topK,
      returned: matches.length
    });

    return matches;
  }

  async retrieveRelevantMessagesFromMessages(
    messages: StoredMessageRow[],
    userQuestion: string,
    topK: number
  ): Promise<MessageEmbeddingMatch[]> {
    await this.ensureEmbeddingsForMessages(messages);

    const meaningfulMessages = messages.filter((message) => Boolean(buildEmbeddingText(message)));
    const existingEmbeddings = this.database.getMessageEmbeddingsForMessageIds(
      meaningfulMessages.map((message) => message.id),
      this.config.ollamaEmbedModel
    );
    const embeddingByMessageId = new Map(
      existingEmbeddings.map((embedding) => [embedding.message_id, JSON.parse(embedding.embedding_json) as number[]])
    );

    const questionEmbeddings = await this.client.embedTexts(
      [`question: ${userQuestion}`],
      "query_embedding_range"
    );
    const queryEmbedding = questionEmbeddings[0];

    if (!Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
      return [];
    }

    return meaningfulMessages
      .map<MessageEmbeddingMatch | null>((message) => {
        const embedding = embeddingByMessageId.get(message.id);
        if (!embedding) {
          return null;
        }

        const similarity = cosineSimilarity(queryEmbedding, embedding);
        if (!Number.isFinite(similarity)) {
          return null;
        }

        return {
          messageId: message.id,
          chatName: message.chat_name,
          senderName: message.sender_name,
          normalizedTimestamp: message.normalized_timestamp,
          timestampText: message.timestamp_text,
          messageText: message.message_text,
          similarity
        };
      })
      .filter((match): match is MessageEmbeddingMatch => Boolean(match))
      .sort((left, right) => right.similarity - left.similarity)
      .slice(0, topK);
  }
}
