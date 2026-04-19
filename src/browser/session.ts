import { BrowserContext, Page, chromium } from "playwright";

import { AppConfig } from "../config/env";
import { ensureDirectoryExists } from "../utils/files";

export class BrowserSession {
  private context: BrowserContext | null = null;
  private page: Page | null = null;

  constructor(private readonly config: AppConfig) {}

  async open(): Promise<Page> {
    if (this.page) {
      return this.page;
    }

    ensureDirectoryExists(this.config.userDataDir);

    this.context = await chromium.launchPersistentContext(this.config.userDataDir, {
      headless: this.config.headless,
      viewport: { width: 1440, height: 960 },
      args: ["--disable-blink-features=AutomationControlled"]
    });

    this.page = this.context.pages()[0] || (await this.context.newPage());
    await this.page.goto(this.config.whatsappUrl, { waitUntil: "domcontentloaded" });
    return this.page;
  }

  getPage(): Page {
    if (!this.page) {
      throw new Error("Browser session has not been opened yet.");
    }

    return this.page;
  }

  async close(): Promise<void> {
    if (!this.context) {
      return;
    }

    await this.context.close();
    this.context = null;
    this.page = null;
  }
}
