import { Page } from "playwright";

import { AppConfig } from "../config/env";
import { logger } from "../utils/logger";
import { sleep } from "../utils/sleep";
import { WHATSAPP_SELECTORS } from "./selectors";

async function anySelectorVisible(page: Page, selectors: readonly string[], timeoutMs = 500): Promise<boolean> {
  const end = Date.now() + timeoutMs;

  while (Date.now() < end) {
    for (const selector of selectors) {
      const locator = page.locator(selector).first();
      if (await locator.count().catch(() => 0)) {
        if (await locator.isVisible().catch(() => false)) {
          return true;
        }
      }
    }

    await sleep(100);
  }

  return false;
}

export async function isLoggedIn(page: Page): Promise<boolean> {
  return anySelectorVisible(page, WHATSAPP_SELECTORS.loggedInIndicators, 1500);
}

export async function ensureLoggedIn(page: Page, config: AppConfig): Promise<void> {
  await page.goto(config.whatsappUrl, { waitUntil: "domcontentloaded" });

  if (await isLoggedIn(page)) {
    return;
  }

  const qrVisible = await anySelectorVisible(page, WHATSAPP_SELECTORS.qrIndicators, 1500);
  if (qrVisible) {
    logger.info("WhatsApp login required. Scan the QR code in the opened browser window.");
  } else {
    logger.info("Waiting for WhatsApp Web to finish loading.");
  }

  const deadline = Date.now() + config.loginWaitMinutes * 60 * 1000;
  while (Date.now() < deadline) {
    if (await isLoggedIn(page)) {
      logger.info("WhatsApp login detected.");
      return;
    }

    await sleep(1500);
  }

  throw new Error(`Login was not completed within ${config.loginWaitMinutes} minute(s).`);
}

