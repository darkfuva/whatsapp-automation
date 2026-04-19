export function nowIso(): string {
  return new Date().toISOString();
}

export function formatRelativeTargetDate(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function formatLocalTimestamp(iso: string | null | undefined): string {
  if (!iso) {
    return "unknown-time";
  }

  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) {
    return iso;
  }

  return value.toLocaleString();
}

interface ParsedPrePlainText {
  senderName: string | null;
  timestampText: string | null;
  normalizedTimestamp: string | null;
}

function parseDateParts(dateString: string): { year: number; month: number; day: number } | null {
  const parts = dateString.split("/").map((part) => Number(part.trim()));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part))) {
    return null;
  }

  let [first, second, year] = parts;
  if (year < 100) {
    year += 2000;
  }

  let day = first;
  let month = second;

  if (first <= 12 && second > 12) {
    month = first;
    day = second;
  }

  return { year, month, day };
}

function parseTimeParts(timeString: string): { hour: number; minute: number; second: number } | null {
  const normalized = timeString.trim().toUpperCase();
  const match = normalized.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || "0");
  const meridiem = match[4];

  if (meridiem === "AM" && hour === 12) {
    hour = 0;
  } else if (meridiem === "PM" && hour < 12) {
    hour += 12;
  }

  return { hour, minute, second };
}

function parseBracketContent(prePlainText: string): { datePart: string; timePart: string; senderName: string | null } | null {
  const firstMatch = prePlainText.match(/^\[(.+?),\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\]\s*(.*?)(?::\s*)?$/);
  if (firstMatch) {
    return {
      timePart: firstMatch[1].trim(),
      datePart: firstMatch[2].trim(),
      senderName: firstMatch[3]?.trim() || null
    };
  }

  const secondMatch = prePlainText.match(/^\[(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(.+?)\]\s*(.*?)(?::\s*)?$/);
  if (secondMatch) {
    return {
      datePart: secondMatch[1].trim(),
      timePart: secondMatch[2].trim(),
      senderName: secondMatch[3]?.trim() || null
    };
  }

  return null;
}

export function parseWhatsAppPrePlainText(prePlainText: string | null | undefined): ParsedPrePlainText {
  if (!prePlainText) {
    return {
      senderName: null,
      timestampText: null,
      normalizedTimestamp: null
    };
  }

  const parsed = parseBracketContent(prePlainText.trim());
  if (!parsed) {
    return {
      senderName: null,
      timestampText: prePlainText,
      normalizedTimestamp: null
    };
  }

  const dateParts = parseDateParts(parsed.datePart);
  const timeParts = parseTimeParts(parsed.timePart);

  if (!dateParts || !timeParts) {
    return {
      senderName: parsed.senderName,
      timestampText: `[${parsed.timePart}, ${parsed.datePart}]`,
      normalizedTimestamp: null
    };
  }

  const date = new Date(
    dateParts.year,
    dateParts.month - 1,
    dateParts.day,
    timeParts.hour,
    timeParts.minute,
    timeParts.second
  );

  return {
    senderName: parsed.senderName,
    timestampText: `[${parsed.timePart}, ${parsed.datePart}]`,
    normalizedTimestamp: Number.isNaN(date.getTime()) ? null : date.toISOString()
  };
}
