import { Page } from "playwright";

import { MessageDirection, MessageType } from "../db/types";
import { sha256 } from "../utils/hash";
import { logger } from "../utils/logger";
import { sleep } from "../utils/sleep";
import { parseWhatsAppPrePlainText } from "../utils/time";
import { WHATSAPP_SELECTORS } from "./selectors";

interface BrowserExtractedRow {
  rawPrePlainText: string | null;
  senderName: string | null;
  timestampText: string | null;
  messageText: string | null;
  messageType: MessageType;
  direction: MessageDirection;
  htmlSnippet: string;
}

export interface ExtractedMessage {
  groupName: string;
  senderName: string | null;
  timestampText: string | null;
  normalizedTimestamp: string | null;
  messageText: string | null;
  messageType: MessageType;
  direction: MessageDirection;
  dedupeHash: string;
  raw: Record<string, unknown>;
}

function normalizeText(input: string | null | undefined): string | null {
  if (!input) {
    return null;
  }

  const value = input.replace(/\s+/g, " ").trim();
  return value.length > 0 ? value : null;
}

function computeDedupeHash(input: {
  groupName: string;
  senderName: string | null;
  timestampText: string | null;
  normalizedTimestamp: string | null;
  messageText: string | null;
  messageType: MessageType;
  direction: MessageDirection;
}): string {
  return sha256(
    [
      input.groupName,
      input.senderName || "",
      input.normalizedTimestamp || "",
      input.timestampText || "",
      input.messageText || "",
      input.messageType,
      input.direction
    ].join("|")
  );
}

async function extractVisibleRows(page: Page): Promise<BrowserExtractedRow[]> {
  const result = await page.evaluate(function (selectors) {
    const rowSet = new Set<Element>();
    for (const selector of selectors.messageRowCandidates) {
      const matched = Array.from(document.querySelectorAll(selector));
      for (const element of matched) {
        rowSet.add(element);
      }
    }

    const uniqueRows = Array.from(rowSet).filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.height > 0 && rect.width > 0;
    });

    const output: Array<{
      rawPrePlainText: string | null;
      senderName: string | null;
      timestampText: string | null;
      messageText: string | null;
      messageType: MessageType;
      direction: MessageDirection;
      htmlSnippet: string;
    }> = [];

    for (const row of uniqueRows) {
      const withPrePlain = row.matches("[data-pre-plain-text]")
        ? row
        : row.querySelector("[data-pre-plain-text]");

      let senderTitle =
        row.getAttribute("data-author") ||
        row.getAttribute("aria-label") ||
        null;

      if (!senderTitle) {
        for (const selector of selectors.messageMetaCandidates) {
          const match = row.querySelector(selector);
          const text = match?.textContent?.replace(/\s+/g, " ").trim();
          if (text) {
            senderTitle = text;
            break;
          }
        }
      }

      const textParts: string[] = [];
      for (const selector of selectors.messageTextCandidates) {
        const matches = Array.from(row.querySelectorAll(selector));
        for (const match of matches) {
          const text = match.textContent?.replace(/\s+/g, " ").trim();
          if (text && !textParts.includes(text)) {
            textParts.push(text);
          }
        }
      }

      let attachmentLabel: string | null = null;
      for (const selector of selectors.attachmentCandidates) {
        const match = row.querySelector(selector);
        const text = match?.textContent?.replace(/\s+/g, " ").trim();
        if (text) {
          attachmentLabel = text;
          break;
        }

        const ariaLabel = match?.getAttribute("aria-label");
        if (ariaLabel) {
          attachmentLabel = ariaLabel;
          break;
        }
      }

      const className = typeof (row as HTMLElement).className === "string" ? (row as HTMLElement).className : "";
      const dataTestId = row.getAttribute("data-testid") || "";
      let direction: MessageDirection = "unknown";
      if (className.includes("message-out") || dataTestId.includes("out")) {
        direction = "outgoing";
      } else if (className.includes("message-in") || dataTestId.includes("in")) {
        direction = "incoming";
      }

      let messageType: MessageType = "unknown";
      if (textParts.length > 0) {
        messageType = "text";
      } else if (attachmentLabel) {
        messageType = "attachment-placeholder";
      }

      output.push({
        rawPrePlainText: withPrePlain?.getAttribute("data-pre-plain-text") || null,
        senderName: senderTitle,
        timestampText: withPrePlain?.getAttribute("data-pre-plain-text") || null,
        messageText: textParts.length > 0 ? textParts.join("\n") : attachmentLabel,
        messageType,
        direction,
        htmlSnippet: row.outerHTML.slice(0, 4000)
      });
    }

    return output;
  }, WHATSAPP_SELECTORS);

  if (!Array.isArray(result)) {
    logger.warn("WhatsApp extractor returned a non-array result; skipping this batch.");
    return [];
  }

  return result as BrowserExtractedRow[];
}

async function scrollMessagesUp(page: Page): Promise<boolean> {
  return page.evaluate(function (selectors) {
    const rows =
      document.querySelector(selectors.messageRowCandidates[0]) ||
      document.querySelector(selectors.messageRowCandidates[1]) ||
      document.querySelector(selectors.messageRowCandidates[2]);

    if (!rows) {
      return false;
    }

    let parent = rows.parentElement;
    while (parent) {
      const htmlElement = parent as HTMLElement;
      if (htmlElement.scrollHeight > htmlElement.clientHeight + 50) {
        const previousTop = htmlElement.scrollTop;
        htmlElement.scrollTop = Math.max(0, htmlElement.scrollTop - htmlElement.clientHeight * 0.9);
        return htmlElement.scrollTop !== previousTop || previousTop > 0;
      }
      parent = parent.parentElement;
    }

    return false;
  }, WHATSAPP_SELECTORS);
}

function oldestTimestamp(messages: ExtractedMessage[]): number | null {
  const timestamps = messages
    .map((message) => (message.normalizedTimestamp ? new Date(message.normalizedTimestamp).getTime() : null))
    .filter((value): value is number => value !== null && Number.isFinite(value));

  if (timestamps.length === 0) {
    return null;
  }

  return Math.min(...timestamps);
}

export async function collectChatMessages(
  page: Page,
  chatName: string,
  lookbackHours: number,
  maxScrollIterations: number
): Promise<ExtractedMessage[]> {
  const lookbackBoundary = Date.now() - lookbackHours * 60 * 60 * 1000;
  const byHash = new Map<string, ExtractedMessage>();
  let lastSize = 0;
  let stableIterations = 0;

  for (let iteration = 0; iteration < maxScrollIterations; iteration += 1) {
    const rows = await extractVisibleRows(page);
    for (const row of rows) {
      const parsed = parseWhatsAppPrePlainText(row.rawPrePlainText || row.timestampText);
      const senderName = normalizeText(parsed.senderName || row.senderName);
      const timestampText = normalizeText(parsed.timestampText || row.timestampText);
      const normalizedTimestamp = parsed.normalizedTimestamp;
      const messageText = normalizeText(row.messageText);

      const message: ExtractedMessage = {
        groupName: chatName,
        senderName,
        timestampText,
        normalizedTimestamp,
        messageText,
        messageType: row.messageType,
        direction: row.direction,
        dedupeHash: computeDedupeHash({
          groupName: chatName,
          senderName,
          timestampText,
          normalizedTimestamp,
          messageText,
          messageType: row.messageType,
          direction: row.direction
        }),
        raw: {
          rawPrePlainText: row.rawPrePlainText,
          htmlSnippet: row.htmlSnippet
        }
      };

      byHash.set(message.dedupeHash, message);
    }

    const collected = Array.from(byHash.values());
    const oldest = oldestTimestamp(collected);
    if (oldest !== null && oldest <= lookbackBoundary) {
      break;
    }

    if (byHash.size === lastSize) {
      stableIterations += 1;
    } else {
      stableIterations = 0;
    }

    if (stableIterations >= 2) {
      logger.debug("Message extraction stabilized before hitting lookback boundary.", {
        chatName,
        count: byHash.size
      });
      break;
    }

    lastSize = byHash.size;
    const scrolled = await scrollMessagesUp(page);
    if (!scrolled) {
      break;
    }

    await sleep(700);
  }

  return Array.from(byHash.values()).sort((left, right) => {
    const leftTime = left.normalizedTimestamp ? new Date(left.normalizedTimestamp).getTime() : 0;
    const rightTime = right.normalizedTimestamp ? new Date(right.normalizedTimestamp).getTime() : 0;
    return leftTime - rightTime;
  });
}
