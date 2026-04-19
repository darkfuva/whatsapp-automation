import fs from "node:fs/promises";
import path from "node:path";

import { Page } from "playwright";

import { AppConfig } from "../config/env";
import { ensureDirectoryExists, sanitizeFileName } from "../utils/files";

export async function captureDebugArtifacts(page: Page, config: AppConfig, label: string): Promise<{ screenshotPath: string; htmlPath: string }> {
  ensureDirectoryExists(config.debugArtifactsDir);

  const safeLabel = sanitizeFileName(label);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = `${timestamp}_${safeLabel}`;
  const screenshotPath = path.join(config.debugArtifactsDir, `${baseName}.png`);
  const htmlPath = path.join(config.debugArtifactsDir, `${baseName}.html`);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await fs.writeFile(htmlPath, await page.content(), "utf8");

  return { screenshotPath, htmlPath };
}
