import fs from "node:fs";
import path from "node:path";

export function ensureDirectoryExists(targetPath: string): void {
  fs.mkdirSync(targetPath, { recursive: true });
}

export function ensureParentDirectory(filePath: string): void {
  ensureDirectoryExists(path.dirname(filePath));
}

export function sanitizeFileName(input: string): string {
  return input.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 120);
}

