import { BrowserSession } from "../browser/session";
import { AppConfig } from "../config/env";
import { AppDatabase } from "../db/database";
import { StoredMessageInput, SyncStatus } from "../db/types";
import { logger } from "../utils/logger";
import { nowIso } from "../utils/time";
import { ensureLoggedIn } from "../whatsapp/auth";
import { openChatByName } from "../whatsapp/chatNavigator";
import { captureDebugArtifacts } from "../whatsapp/debug";
import { collectChatMessages } from "../whatsapp/messageExtractor";

export async function runSingleSync(config: AppConfig, database: AppDatabase): Promise<void> {
  const chats = database.getActiveChats();
  const syncRunId = database.createSyncRun(chats.length);

  if (chats.length === 0) {
    database.completeSyncRun(syncRunId, {
      status: "success",
      succeededChats: 0,
      failedChats: 0,
      errors: [],
      notes: "No active chats configured."
    });
    logger.warn("No active chats configured. Add chats with npm run chats:add -- \"Group Name\".");
    return;
  }

  const browser = new BrowserSession(config);
  const failures: Array<{ chatName: string; error: string }> = [];
  let succeededChats = 0;

  try {
    const page = await browser.open();
    await ensureLoggedIn(page, config);

    for (const chat of chats) {
      try {
        await openChatByName(page, chat.name);
        const extracted = await collectChatMessages(
          page,
          chat.name,
          config.lookbackHours,
          config.maxScrollIterations
        );

        const stored: StoredMessageInput[] = extracted.map((message) => ({
          senderName: message.senderName,
          timestampText: message.timestampText,
          normalizedTimestamp: message.normalizedTimestamp,
          messageText: message.messageText,
          messageType: message.messageType,
          direction: message.direction,
          dedupeHash: message.dedupeHash,
          rawJson: JSON.stringify(message.raw),
          syncRunId
        }));

        const result = database.insertMessages(chat.id, stored);
        database.touchChatLastSynced(chat.id, nowIso());
        succeededChats += 1;

        logger.info("Chat sync completed.", {
          chatName: chat.name,
          extracted: extracted.length,
          inserted: result.inserted,
          skipped: result.skipped
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        failures.push({ chatName: chat.name, error: message });
        logger.error("Chat sync failed.", { chatName: chat.name, error: message });

        try {
          const artifacts = await captureDebugArtifacts(page, config, `sync_failure_${chat.name}`);
          logger.warn("Saved debug artifacts for failed chat.", artifacts);
        } catch (artifactError) {
          logger.warn("Failed to save debug artifacts.", {
            chatName: chat.name,
            error: artifactError instanceof Error ? artifactError.message : String(artifactError)
          });
        }
      }
    }
  } finally {
    await browser.close();
  }

  const failedChats = failures.length;
  const status: SyncStatus =
    failedChats === 0 ? "success" : succeededChats > 0 ? "partial" : "failed";

  database.completeSyncRun(syncRunId, {
    status,
    succeededChats,
    failedChats,
    errors: failures,
    notes: `Processed ${chats.length} chat(s).`
  });
}

