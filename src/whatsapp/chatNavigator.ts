import { Locator, Page } from "playwright";

import { logger } from "../utils/logger";
import { sleep } from "../utils/sleep";
import { WHATSAPP_SELECTORS } from "./selectors";

function quoteAttribute(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function findFirstVisibleLocator(page: Page, selectors: readonly string[], timeoutMs = 5000): Promise<Locator | null> {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        if (await locator.isVisible().catch(() => false)) {
          return locator;
        }
      }
    }

    await sleep(100);
  }

  return null;
}

async function clearEditableField(locator: Locator): Promise<void> {
  await locator.click({ force: true });
  await locator.press("Control+A").catch(() => undefined);
  await locator.press("Meta+A").catch(() => undefined);
  await locator.press("Backspace").catch(() => undefined);
}

async function clickChatResult(page: Page, chatName: string, timeoutMs = 5000): Promise<boolean> {
  const titleSelector = `span[title=${quoteAttribute(chatName)}]`;
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    const directMatch = page.locator(titleSelector).first();
    if (await directMatch.count().catch(() => 0)) {
      if (await directMatch.isVisible().catch(() => false)) {
        await directMatch.click();
        return true;
      }
    }

    const textMatch = page.getByText(chatName, { exact: true }).first();
    if (await textMatch.count().catch(() => 0)) {
      if (await textMatch.isVisible().catch(() => false)) {
        await textMatch.click();
        return true;
      }
    }

    await sleep(150);
  }

  return false;
}

async function waitForChatHeader(page: Page, chatName: string, timeoutMs = 8000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    for (const selector of WHATSAPP_SELECTORS.chatHeaderTitle) {
      const locator = page.locator(selector).first();
      const text = (await locator.textContent().catch(() => null))?.trim();
      if (text && text.includes(chatName)) {
        return;
      }
    }

    await sleep(150);
  }

  logger.debug("Chat header did not exactly match target; continuing with best effort.", { chatName });
}

export async function openChatByName(page: Page, chatName: string): Promise<void> {
  logger.info("Opening chat.", { chatName });

  if (await clickChatResult(page, chatName, 1200)) {
    await waitForChatHeader(page, chatName);
    return;
  }

  const searchBox = await findFirstVisibleLocator(page, WHATSAPP_SELECTORS.sidebarSearchInputs, 8000);
  if (!searchBox) {
    throw new Error(`Unable to find the sidebar search box for chat "${chatName}".`);
  }

  await clearEditableField(searchBox);
  await searchBox.type(chatName, { delay: 50 });
  await sleep(800);

  const clicked = await clickChatResult(page, chatName, 5000);
  await clearEditableField(searchBox).catch(() => undefined);
  await page.keyboard.press("Escape").catch(() => undefined);

  if (!clicked) {
    throw new Error(`Chat "${chatName}" was not found in WhatsApp Web search results.`);
  }

  await waitForChatHeader(page, chatName);
}

