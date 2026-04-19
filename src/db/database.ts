import Database from "better-sqlite3";

import { AppConfig } from "../config/env";
import { ensureParentDirectory } from "../utils/files";
import { nowIso } from "../utils/time";
import { initializeSchema } from "./schema";
import {
  ChatRow,
  MessageEmbeddingRow,
  OperationFactInput,
  OperationFactRow,
  StoredMessageInput,
  StoredMessageRow,
  StoredTaskInput,
  StoredTaskRow,
  SyncRunRow,
  SyncStatus
} from "./types";

export class AppDatabase {
  private readonly db: Database.Database;

  constructor(config: AppConfig) {
    ensureParentDirectory(config.dbPath);
    this.db = new Database(config.dbPath);
    initializeSchema(this.db);
  }

  close(): void {
    this.db.close();
  }

  init(): void {
    initializeSchema(this.db);
  }

  listChats(): ChatRow[] {
    return this.db.prepare("SELECT * FROM chats ORDER BY name ASC").all() as ChatRow[];
  }

  getActiveChats(): ChatRow[] {
    return this.db.prepare("SELECT * FROM chats WHERE is_active = 1 ORDER BY name ASC").all() as ChatRow[];
  }

  addChat(name: string): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO chats (name, is_active, created_at, updated_at)
        VALUES (@name, 1, @timestamp, @timestamp)
        ON CONFLICT(name) DO UPDATE SET is_active = 1, updated_at = excluded.updated_at
        `
      )
      .run({ name, timestamp });
  }

  removeChat(name: string): void {
    this.db
      .prepare("UPDATE chats SET is_active = 0, updated_at = @updatedAt WHERE name = @name")
      .run({ name, updatedAt: nowIso() });
  }

  touchChatLastSynced(chatId: number, syncedAt: string): void {
    this.db
      .prepare("UPDATE chats SET last_synced_at = @syncedAt, updated_at = @syncedAt WHERE id = @chatId")
      .run({ chatId, syncedAt });
  }

  createSyncRun(totalChats: number): number {
    const result = this.db
      .prepare(
        `
        INSERT INTO sync_runs (started_at, status, total_chats, succeeded_chats, failed_chats)
        VALUES (@startedAt, 'running', @totalChats, 0, 0)
        `
      )
      .run({ startedAt: nowIso(), totalChats });

    return Number(result.lastInsertRowid);
  }

  completeSyncRun(syncRunId: number, input: {
    status: SyncStatus;
    succeededChats: number;
    failedChats: number;
    errors: Array<{ chatName: string; error: string }>;
    notes?: string;
  }): void {
    this.db
      .prepare(
        `
        UPDATE sync_runs
        SET ended_at = @endedAt,
            status = @status,
            succeeded_chats = @succeededChats,
            failed_chats = @failedChats,
            errors_json = @errorsJson,
            notes = @notes
        WHERE id = @syncRunId
        `
      )
      .run({
        syncRunId,
        endedAt: nowIso(),
        status: input.status,
        succeededChats: input.succeededChats,
        failedChats: input.failedChats,
        errorsJson: input.errors.length > 0 ? JSON.stringify(input.errors) : null,
        notes: input.notes || null
      });
  }

  getSyncRun(syncRunId: number): SyncRunRow | undefined {
    return this.db.prepare("SELECT * FROM sync_runs WHERE id = ?").get(syncRunId) as SyncRunRow | undefined;
  }

  insertMessages(chatId: number, messages: StoredMessageInput[]): { inserted: number; skipped: number } {
    const insert = this.db.prepare(
      `
      INSERT OR IGNORE INTO messages (
        chat_id,
        sender_name,
        timestamp_text,
        normalized_timestamp,
        message_text,
        message_type,
        direction,
        dedupe_hash,
        raw_json,
        created_at,
        sync_run_id
      )
      VALUES (
        @chatId,
        @senderName,
        @timestampText,
        @normalizedTimestamp,
        @messageText,
        @messageType,
        @direction,
        @dedupeHash,
        @rawJson,
        @createdAt,
        @syncRunId
      )
      `
    );

    let inserted = 0;
    const createdAt = nowIso();

    const transaction = this.db.transaction((items: StoredMessageInput[]) => {
      for (const item of items) {
        const result = insert.run({
          chatId,
          senderName: item.senderName,
          timestampText: item.timestampText,
          normalizedTimestamp: item.normalizedTimestamp,
          messageText: item.messageText,
          messageType: item.messageType,
          direction: item.direction,
          dedupeHash: item.dedupeHash,
          rawJson: item.rawJson,
          createdAt,
          syncRunId: item.syncRunId
        });

        inserted += result.changes;
      }
    });

    transaction(messages);
    return { inserted, skipped: messages.length - inserted };
  }

  getMessagesSince(hours: number): StoredMessageRow[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `
        SELECT
          messages.*,
          chats.name AS chat_name
        FROM messages
        INNER JOIN chats ON chats.id = messages.chat_id
        WHERE COALESCE(messages.normalized_timestamp, messages.created_at) >= @cutoff
          AND chats.is_active = 1
        ORDER BY COALESCE(messages.normalized_timestamp, messages.created_at) ASC
        `
      )
      .all({ cutoff }) as StoredMessageRow[];
  }

  getMessagesForChatSince(chatName: string, hours: number): StoredMessageRow[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `
        SELECT
          messages.*,
          chats.name AS chat_name
        FROM messages
        INNER JOIN chats ON chats.id = messages.chat_id
        WHERE chats.name = @chatName
          AND COALESCE(messages.normalized_timestamp, messages.created_at) >= @cutoff
        ORDER BY COALESCE(messages.normalized_timestamp, messages.created_at) ASC
        `
      )
      .all({ chatName, cutoff }) as StoredMessageRow[];
  }

  getMessagesForRange(input: {
    fromIso: string;
    toIso: string;
    chatNames?: string[];
    activeOnly?: boolean;
  }): StoredMessageRow[] {
    const conditions = [
      "COALESCE(messages.normalized_timestamp, messages.created_at) >= @fromIso",
      "COALESCE(messages.normalized_timestamp, messages.created_at) < @toIso"
    ];
    const params: Record<string, string | number> = {
      fromIso: input.fromIso,
      toIso: input.toIso
    };

    if (input.activeOnly !== false) {
      conditions.push("chats.is_active = 1");
    }

    if (input.chatNames && input.chatNames.length > 0) {
      const placeholders = input.chatNames.map((_, index) => `@chatName${index}`);
      conditions.push(`chats.name IN (${placeholders.join(", ")})`);
      input.chatNames.forEach((chatName, index) => {
        params[`chatName${index}`] = chatName;
      });
    }

    const sql = `
      SELECT
        messages.*,
        chats.name AS chat_name
      FROM messages
      INNER JOIN chats ON chats.id = messages.chat_id
      WHERE ${conditions.join(" AND ")}
      ORDER BY COALESCE(messages.normalized_timestamp, messages.created_at) ASC
    `;

    return this.db.prepare(sql).all(params) as StoredMessageRow[];
  }

  upsertMessageEmbedding(input: {
    messageId: number;
    modelName: string;
    contentHash: string;
    embedding: number[];
  }): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
        INSERT INTO message_embeddings (
          message_id,
          model_name,
          content_hash,
          embedding_json,
          embedding_dim,
          created_at,
          updated_at
        )
        VALUES (
          @messageId,
          @modelName,
          @contentHash,
          @embeddingJson,
          @embeddingDim,
          @timestamp,
          @timestamp
        )
        ON CONFLICT(message_id) DO UPDATE SET
          model_name = excluded.model_name,
          content_hash = excluded.content_hash,
          embedding_json = excluded.embedding_json,
          embedding_dim = excluded.embedding_dim,
          updated_at = excluded.updated_at
        `
      )
      .run({
        messageId: input.messageId,
        modelName: input.modelName,
        contentHash: input.contentHash,
        embeddingJson: JSON.stringify(input.embedding),
        embeddingDim: input.embedding.length,
        timestamp
      });
  }

  getMessageEmbeddingsForChatSince(chatName: string, hours: number, modelName: string): Array<{
    embedding: MessageEmbeddingRow;
    message: StoredMessageRow;
  }> {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare(
        `
        SELECT
          message_embeddings.id AS embedding_id,
          message_embeddings.message_id,
          message_embeddings.model_name,
          message_embeddings.content_hash,
          message_embeddings.embedding_json,
          message_embeddings.embedding_dim,
          message_embeddings.created_at AS embedding_created_at,
          message_embeddings.updated_at AS embedding_updated_at,
          messages.chat_id,
          chats.name AS chat_name,
          messages.sender_name,
          messages.timestamp_text,
          messages.normalized_timestamp,
          messages.message_text,
          messages.message_type,
          messages.direction,
          messages.dedupe_hash,
          messages.raw_json,
          messages.created_at,
          messages.sync_run_id
        FROM message_embeddings
        INNER JOIN messages ON messages.id = message_embeddings.message_id
        INNER JOIN chats ON chats.id = messages.chat_id
        WHERE chats.name = @chatName
          AND message_embeddings.model_name = @modelName
          AND COALESCE(messages.normalized_timestamp, messages.created_at) >= @cutoff
        ORDER BY COALESCE(messages.normalized_timestamp, messages.created_at) ASC
        `
      )
      .all({ chatName, modelName, cutoff }) as Array<
      {
        embedding_id: number;
        message_id: number;
        model_name: string;
        content_hash: string;
        embedding_json: string;
        embedding_dim: number;
        embedding_created_at: string;
        embedding_updated_at: string;
        chat_name: string;
        chat_id: number;
        sender_name: string | null;
        timestamp_text: string | null;
        normalized_timestamp: string | null;
        message_text: string | null;
        message_type: StoredMessageRow["message_type"];
        direction: StoredMessageRow["direction"];
        dedupe_hash: string;
        raw_json: string;
        created_at: string;
        sync_run_id: number | null;
      }
    >;

    return rows.map((row) => ({
      embedding: {
        id: row.embedding_id,
        message_id: row.message_id,
        model_name: row.model_name,
        content_hash: row.content_hash,
        embedding_json: row.embedding_json,
        embedding_dim: row.embedding_dim,
        created_at: row.embedding_created_at,
        updated_at: row.embedding_updated_at
      },
      message: {
        id: row.message_id,
        chat_id: row.chat_id,
        chat_name: row.chat_name,
        sender_name: row.sender_name,
        timestamp_text: row.timestamp_text,
        normalized_timestamp: row.normalized_timestamp,
        message_text: row.message_text,
        message_type: row.message_type,
        direction: row.direction,
        dedupe_hash: row.dedupe_hash,
        raw_json: row.raw_json,
        created_at: row.created_at,
        sync_run_id: row.sync_run_id
      }
    }));
  }

  getMessagesMissingEmbeddingsForChatSince(chatName: string, hours: number, modelName: string): StoredMessageRow[] {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    return this.db
      .prepare(
        `
        SELECT
          messages.*,
          chats.name AS chat_name
        FROM messages
        INNER JOIN chats ON chats.id = messages.chat_id
        LEFT JOIN message_embeddings
          ON message_embeddings.message_id = messages.id
         AND message_embeddings.model_name = @modelName
        WHERE chats.name = @chatName
          AND COALESCE(messages.normalized_timestamp, messages.created_at) >= @cutoff
          AND message_embeddings.id IS NULL
          AND messages.message_text IS NOT NULL
          AND trim(messages.message_text) <> ''
        ORDER BY COALESCE(messages.normalized_timestamp, messages.created_at) ASC
        `
      )
      .all({ chatName, cutoff, modelName }) as StoredMessageRow[];
  }

  getMessagesWithEmbeddingsCountForChatSince(chatName: string, hours: number, modelName: string): number {
    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
    const row = this.db
      .prepare(
        `
        SELECT count(*) as count
        FROM message_embeddings
        INNER JOIN messages ON messages.id = message_embeddings.message_id
        INNER JOIN chats ON chats.id = messages.chat_id
        WHERE chats.name = @chatName
          AND message_embeddings.model_name = @modelName
          AND COALESCE(messages.normalized_timestamp, messages.created_at) >= @cutoff
        `
      )
      .get({ chatName, modelName, cutoff }) as { count: number };

    return row.count;
  }

  getMessageEmbeddingsForMessageIds(messageIds: number[], modelName: string): MessageEmbeddingRow[] {
    if (messageIds.length === 0) {
      return [];
    }

    const params: Record<string, string | number> = { modelName };
    const placeholders = messageIds.map((messageId, index) => {
      params[`messageId${index}`] = messageId;
      return `@messageId${index}`;
    });

    const sql = `
      SELECT *
      FROM message_embeddings
      WHERE model_name = @modelName
        AND message_id IN (${placeholders.join(", ")})
    `;

    return this.db.prepare(sql).all(params) as MessageEmbeddingRow[];
  }

  insertOperationFacts(facts: OperationFactInput[]): void {
    if (facts.length === 0) {
      return;
    }

    const timestamp = nowIso();
    const insert = this.db.prepare(
      `
      INSERT INTO operation_facts (
        content_hash,
        source_message_id,
        source_chat_name,
        source_message_time,
        report_date,
        fact_type,
        entity_name,
        metric_name,
        metric_value,
        metric_unit,
        text_value,
        dimensions_json,
        confidence,
        extractor_model,
        created_at,
        updated_at
      )
      VALUES (
        @contentHash,
        @sourceMessageId,
        @sourceChatName,
        @sourceMessageTime,
        @reportDate,
        @factType,
        @entityName,
        @metricName,
        @metricValue,
        @metricUnit,
        @textValue,
        @dimensionsJson,
        @confidence,
        @extractorModel,
        @createdAt,
        @updatedAt
      )
      ON CONFLICT(content_hash) DO UPDATE SET
        source_message_id = excluded.source_message_id,
        source_chat_name = excluded.source_chat_name,
        source_message_time = excluded.source_message_time,
        report_date = excluded.report_date,
        fact_type = excluded.fact_type,
        entity_name = excluded.entity_name,
        metric_name = excluded.metric_name,
        metric_value = excluded.metric_value,
        metric_unit = excluded.metric_unit,
        text_value = excluded.text_value,
        dimensions_json = excluded.dimensions_json,
        confidence = excluded.confidence,
        extractor_model = excluded.extractor_model,
        updated_at = excluded.updated_at
      `
    );

    const transaction = this.db.transaction((items: OperationFactInput[]) => {
      for (const item of items) {
        insert.run({
          contentHash: item.contentHash,
          sourceMessageId: item.sourceMessageId,
          sourceChatName: item.sourceChatName,
          sourceMessageTime: item.sourceMessageTime,
          reportDate: item.reportDate,
          factType: item.factType,
          entityName: item.entityName,
          metricName: item.metricName,
          metricValue: item.metricValue,
          metricUnit: item.metricUnit,
          textValue: item.textValue,
          dimensionsJson: item.dimensionsJson,
          confidence: item.confidence,
          extractorModel: item.extractorModel,
          createdAt: timestamp,
          updatedAt: timestamp
        });
      }
    });

    transaction(facts);
  }

  getOperationFactsForRange(input: {
    fromIso: string;
    toIso: string;
    chatNames?: string[];
  }): OperationFactRow[] {
    const timeExpr = `
      COALESCE(
        CASE
          WHEN report_date IS NOT NULL AND length(report_date) = 10 THEN report_date || 'T00:00:00.000Z'
          ELSE report_date
        END,
        source_message_time
      )
    `;
    const conditions = [
      `${timeExpr} >= @fromIso`,
      `${timeExpr} < @toIso`
    ];
    const params: Record<string, string | number> = {
      fromIso: input.fromIso,
      toIso: input.toIso
    };

    if (input.chatNames && input.chatNames.length > 0) {
      const placeholders = input.chatNames.map((_, index) => `@chatName${index}`);
      conditions.push(`source_chat_name IN (${placeholders.join(", ")})`);
      input.chatNames.forEach((chatName, index) => {
        params[`chatName${index}`] = chatName;
      });
    }

    const sql = `
      SELECT *
      FROM operation_facts
      WHERE ${conditions.join(" AND ")}
      ORDER BY ${timeExpr} ASC, metric_name ASC
    `;

    return this.db.prepare(sql).all(params) as OperationFactRow[];
  }

  clearTasksForDate(taskDate: string): void {
    this.db.prepare("DELETE FROM extracted_tasks WHERE task_date = ?").run(taskDate);
  }

  insertTasks(tasks: StoredTaskInput[]): void {
    const insert = this.db.prepare(
      `
      INSERT INTO extracted_tasks (
        task_date,
        category,
        title,
        details,
        confidence,
        source_chat_name,
        source_message_id,
        source_message_time,
        source_excerpt,
        assignee_hint,
        due_date,
        waiting_on,
        status,
        source_type,
        raw_json,
        created_at
      )
      VALUES (
        @taskDate,
        @category,
        @title,
        @details,
        @confidence,
        @sourceChatName,
        @sourceMessageId,
        @sourceMessageTime,
        @sourceExcerpt,
        @assigneeHint,
        @dueDate,
        @waitingOn,
        @status,
        @sourceType,
        @rawJson,
        @createdAt
      )
      `
    );

    const createdAt = nowIso();
    const transaction = this.db.transaction((items: StoredTaskInput[]) => {
      for (const item of items) {
        insert.run({
          taskDate: item.taskDate,
          category: item.category,
          title: item.title,
          details: item.details,
          confidence: item.confidence,
          sourceChatName: item.sourceChatName,
          sourceMessageId: item.sourceMessageId,
          sourceMessageTime: item.sourceMessageTime,
          sourceExcerpt: item.sourceExcerpt,
          assigneeHint: item.assigneeHint,
          dueDate: item.dueDate,
          waitingOn: item.waitingOn,
          status: item.status,
          sourceType: item.sourceType,
          rawJson: item.rawJson,
          createdAt
        });
      }
    });

    transaction(tasks);
  }

  listTasksForDate(taskDate: string): StoredTaskRow[] {
    return this.db
      .prepare("SELECT * FROM extracted_tasks WHERE task_date = ? ORDER BY confidence DESC, category ASC, id ASC")
      .all(taskDate) as StoredTaskRow[];
  }
}
