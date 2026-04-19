import fs from "node:fs";
import path from "node:path";

import { AppDatabase } from "../db/database";
import { StoredMessageInput } from "../db/types";
import { sha256 } from "../utils/hash";

interface FixtureMessage {
  chatName: string;
  senderName: string | null;
  timestampText: string | null;
  normalizedTimestamp: string | null;
  messageText: string | null;
  messageType: "text" | "attachment-placeholder" | "unknown";
  direction: "incoming" | "outgoing" | "system" | "unknown";
}

export function seedFixtureMessages(database: AppDatabase): { chats: number; messages: number } {
  const fixturePath = path.resolve(process.cwd(), "fixtures", "sample-messages.json");
  const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as FixtureMessage[];
  const chatNames = Array.from(new Set(fixture.map((item) => item.chatName)));

  for (const chatName of chatNames) {
    database.addChat(chatName);
  }

  const chats = database.listChats().filter((chat) => chatNames.includes(chat.name));
  let totalMessages = 0;

  for (const chat of chats) {
    const rows = fixture
      .filter((item) => item.chatName === chat.name)
      .map<StoredMessageInput>((item) => ({
        senderName: item.senderName,
        timestampText: item.timestampText,
        normalizedTimestamp: item.normalizedTimestamp,
        messageText: item.messageText,
        messageType: item.messageType,
        direction: item.direction,
        dedupeHash: sha256(
          [
            chat.name,
            item.senderName || "",
            item.timestampText || "",
            item.normalizedTimestamp || "",
            item.messageText || ""
          ].join("|")
        ),
        rawJson: JSON.stringify({ fixture: true, ...item }),
        syncRunId: null
      }));

    totalMessages += database.insertMessages(chat.id, rows).inserted;
  }

  return { chats: chatNames.length, messages: totalMessages };
}

