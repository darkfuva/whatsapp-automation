PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  status TEXT NOT NULL,
  total_chats INTEGER NOT NULL DEFAULT 0,
  succeeded_chats INTEGER NOT NULL DEFAULT 0,
  failed_chats INTEGER NOT NULL DEFAULT 0,
  errors_json TEXT,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id INTEGER NOT NULL,
  sender_name TEXT,
  timestamp_text TEXT,
  normalized_timestamp TEXT,
  message_text TEXT,
  message_type TEXT NOT NULL,
  direction TEXT NOT NULL,
  dedupe_hash TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  sync_run_id INTEGER,
  FOREIGN KEY (chat_id) REFERENCES chats(id) ON DELETE CASCADE,
  FOREIGN KEY (sync_run_id) REFERENCES sync_runs(id) ON DELETE SET NULL,
  UNIQUE(chat_id, dedupe_hash)
);

CREATE INDEX IF NOT EXISTS idx_messages_chat_id ON messages(chat_id);
CREATE INDEX IF NOT EXISTS idx_messages_normalized_timestamp ON messages(normalized_timestamp);
CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);

CREATE TABLE IF NOT EXISTS message_embeddings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL UNIQUE,
  model_name TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  embedding_dim INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_message_embeddings_message_id ON message_embeddings(message_id);
CREATE INDEX IF NOT EXISTS idx_message_embeddings_model_name ON message_embeddings(model_name);

CREATE TABLE IF NOT EXISTS operation_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,
  source_message_id INTEGER,
  source_chat_name TEXT,
  source_message_time TEXT,
  report_date TEXT,
  fact_type TEXT NOT NULL,
  entity_name TEXT,
  metric_name TEXT NOT NULL,
  metric_value REAL,
  metric_unit TEXT,
  text_value TEXT,
  dimensions_json TEXT,
  confidence REAL NOT NULL,
  extractor_model TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_facts_report_date ON operation_facts(report_date);
CREATE INDEX IF NOT EXISTS idx_operation_facts_metric_name ON operation_facts(metric_name);
CREATE INDEX IF NOT EXISTS idx_operation_facts_source_message_id ON operation_facts(source_message_id);

CREATE TABLE IF NOT EXISTS extracted_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_date TEXT NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  confidence REAL NOT NULL,
  source_chat_name TEXT,
  source_message_id INTEGER,
  source_message_time TEXT,
  source_excerpt TEXT,
  assignee_hint TEXT,
  due_date TEXT,
  waiting_on TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  source_type TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_extracted_tasks_task_date ON extracted_tasks(task_date);
CREATE INDEX IF NOT EXISTS idx_extracted_tasks_category ON extracted_tasks(category);
