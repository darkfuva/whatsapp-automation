type LogLevel = "debug" | "info" | "warn" | "error";

let debugEnabled = false;

export function setLoggerDebug(enabled: boolean): void {
  debugEnabled = enabled;
}

function formatMeta(meta: unknown): string {
  if (meta === undefined) {
    return "";
  }

  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return " [unserializable-meta]";
  }
}

function shouldLog(level: LogLevel): boolean {
  if (level === "debug") {
    return debugEnabled;
  }

  return true;
}

function log(level: LogLevel, message: string, meta?: unknown): void {
  if (!shouldLog(level)) {
    return;
  }

  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${formatMeta(meta)}`;
  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

export const logger = {
  debug(message: string, meta?: unknown): void {
    log("debug", message, meta);
  },
  info(message: string, meta?: unknown): void {
    log("info", message, meta);
  },
  warn(message: string, meta?: unknown): void {
    log("warn", message, meta);
  },
  error(message: string, meta?: unknown): void {
    log("error", message, meta);
  }
};

