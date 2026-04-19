export type MessageType = "text" | "attachment-placeholder" | "unknown";
export type MessageDirection = "incoming" | "outgoing" | "system" | "unknown";
export type SyncStatus = "running" | "success" | "partial" | "failed";
export type TaskCategory = "urgent" | "today" | "follow_up" | "blocker" | "waiting_on" | "awareness" | "low_confidence";

export interface ChatRow {
  id: number;
  name: string;
  is_active: number;
  created_at: string;
  updated_at: string;
  last_synced_at: string | null;
}

export interface SyncRunRow {
  id: number;
  started_at: string;
  ended_at: string | null;
  status: SyncStatus;
  total_chats: number;
  succeeded_chats: number;
  failed_chats: number;
  errors_json: string | null;
  notes: string | null;
}

export interface StoredMessageRow {
  id: number;
  chat_id: number;
  chat_name: string;
  sender_name: string | null;
  timestamp_text: string | null;
  normalized_timestamp: string | null;
  message_text: string | null;
  message_type: MessageType;
  direction: MessageDirection;
  dedupe_hash: string;
  raw_json: string;
  created_at: string;
  sync_run_id: number | null;
}

export interface MessageEmbeddingRow {
  id: number;
  message_id: number;
  model_name: string;
  content_hash: string;
  embedding_json: string;
  embedding_dim: number;
  created_at: string;
  updated_at: string;
}

export interface MessageEmbeddingMatch {
  messageId: number;
  chatName: string;
  senderName: string | null;
  normalizedTimestamp: string | null;
  timestampText: string | null;
  messageText: string | null;
  similarity: number;
}

export interface OperationFactRow {
  id: number;
  content_hash: string;
  source_message_id: number | null;
  source_chat_name: string | null;
  source_message_time: string | null;
  report_date: string | null;
  fact_type: string;
  entity_name: string | null;
  metric_name: string;
  metric_value: number | null;
  metric_unit: string | null;
  text_value: string | null;
  dimensions_json: string | null;
  confidence: number;
  extractor_model: string;
  created_at: string;
  updated_at: string;
}

export interface OperationFactInput {
  contentHash: string;
  sourceMessageId: number | null;
  sourceChatName: string | null;
  sourceMessageTime: string | null;
  reportDate: string | null;
  factType: string;
  entityName: string | null;
  metricName: string;
  metricValue: number | null;
  metricUnit: string | null;
  textValue: string | null;
  dimensionsJson: string | null;
  confidence: number;
  extractorModel: string;
}

export interface StoredTaskRow {
  id: number;
  task_date: string;
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
  source_type: string;
  raw_json: string;
  created_at: string;
}

export interface StoredMessageInput {
  senderName: string | null;
  timestampText: string | null;
  normalizedTimestamp: string | null;
  messageText: string | null;
  messageType: MessageType;
  direction: MessageDirection;
  dedupeHash: string;
  rawJson: string;
  syncRunId: number | null;
}

export interface StoredTaskInput {
  taskDate: string;
  category: TaskCategory;
  title: string;
  details: string | null;
  confidence: number;
  sourceChatName: string | null;
  sourceMessageId: number | null;
  sourceMessageTime: string | null;
  sourceExcerpt: string | null;
  assigneeHint: string | null;
  dueDate: string | null;
  waitingOn: string | null;
  status: string;
  sourceType: string;
  rawJson: string;
}
