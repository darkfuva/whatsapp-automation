import dotenv from "dotenv";
import os from "node:os";
import path from "node:path";

import { setLoggerDebug } from "../utils/logger";

dotenv.config();

export interface AppConfig {
  taskExtractionEnabled: boolean;
  ollamaBaseUrl: string;
  ollamaModel: string;
  ollamaEmbedModel: string;
  ollamaTimeoutMs: number;
  ollamaNumCtx: number;
  retrievalTopK: number;
  syncIntervalHours: number;
  userDataDir: string;
  dbPath: string;
  debug: boolean;
  localOnlyMode: boolean;
  headless: boolean;
  whatsappUrl: string;
  lookbackHours: number;
  taskWindowHours: number;
  taskContextHours: number;
  maxScrollIterations: number;
  debugArtifactsDir: string;
  loginWaitMinutes: number;
}

let cachedConfig: AppConfig | null = null;

function parseBoolean(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

function parseNumber(value: string | undefined, defaultValue: number): number {
  if (value === undefined || value === "") {
    return defaultValue;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

function resolveAppPath(inputPath: string): string {
  if (path.isAbsolute(inputPath)) {
    return inputPath;
  }

  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }

  return path.resolve(process.cwd(), inputPath);
}

export function getConfig(): AppConfig {
  if (cachedConfig) {
    return cachedConfig;
  }

  cachedConfig = {
    taskExtractionEnabled: parseBoolean(process.env.TASK_EXTRACTION_ENABLED, true),
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434",
    ollamaModel: process.env.OLLAMA_MODEL || "gemma4:e2b",
    ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text:latest",
    ollamaTimeoutMs: parseNumber(process.env.OLLAMA_TIMEOUT_MS, 120000),
    ollamaNumCtx: parseNumber(process.env.OLLAMA_NUM_CTX, 8192),
    retrievalTopK: parseNumber(process.env.RETRIEVAL_TOP_K, 12),
    syncIntervalHours: parseNumber(process.env.SYNC_INTERVAL_HOURS, 6),
    userDataDir: resolveAppPath(process.env.USER_DATA_DIR || ".local-data/browser-profile"),
    dbPath: resolveAppPath(process.env.DB_PATH || ".local-data/whatsapp.sqlite"),
    debug: parseBoolean(process.env.DEBUG, false),
    localOnlyMode: parseBoolean(process.env.LOCAL_ONLY_MODE, false),
    headless: parseBoolean(process.env.HEADLESS, false),
    whatsappUrl: process.env.WHATSAPP_URL || "https://web.whatsapp.com",
    lookbackHours: parseNumber(process.env.LOOKBACK_HOURS, 168),
    taskWindowHours: parseNumber(process.env.TASK_WINDOW_HOURS, 24),
    taskContextHours: parseNumber(process.env.TASK_CONTEXT_HOURS, 72),
    maxScrollIterations: parseNumber(process.env.MAX_SCROLL_ITERATIONS, 20),
    debugArtifactsDir: resolveAppPath(process.env.DEBUG_ARTIFACTS_DIR || ".local-data/debug"),
    loginWaitMinutes: parseNumber(process.env.LOGIN_WAIT_MINUTES, 10)
  };

  setLoggerDebug(cachedConfig.debug);
  return cachedConfig;
}
