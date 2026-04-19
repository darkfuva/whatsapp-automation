import { BrowserSession } from "../browser/session";
import { getConfig } from "../config/env";
import { AppDatabase } from "../db/database";
import { ChatQueryService } from "../services/chatQueryService";
import { EmbeddingService } from "../services/embeddingService";
import { seedFixtureMessages } from "../services/fixtureService";
import { QueryEngineService } from "../services/queryEngineService";
import { TaskExtractionService } from "../services/taskExtractionService";
import { runSingleSync } from "../sync/syncRunner";
import { logger } from "../utils/logger";
import { sleep } from "../utils/sleep";
import { ensureLoggedIn } from "../whatsapp/auth";
import { openChatByName } from "../whatsapp/chatNavigator";
import { captureDebugArtifacts } from "../whatsapp/debug";

function requireArgument(value: string | undefined, message: string): string {
  if (!value || value.trim().length === 0) {
    throw new Error(message);
  }

  return value.trim();
}

function printChatList(database: AppDatabase): void {
  const chats = database.listChats();
  if (chats.length === 0) {
    console.log("No chats configured.");
    return;
  }

  for (const chat of chats) {
    console.log(`${chat.is_active ? "[active]" : "[inactive]"} ${chat.name}`);
  }
}

async function runLoginCommand(): Promise<void> {
  const config = getConfig();
  const browser = new BrowserSession(config);

  try {
    const page = await browser.open();
    await ensureLoggedIn(page, config);
    console.log("WhatsApp Web is ready.");
    console.log("The persistent browser profile has been updated. You can run sync after this.");
    await page.waitForTimeout(3000);
  } finally {
    await browser.close();
  }
}

async function runInspectCommand(chatName?: string): Promise<void> {
  const config = getConfig();
  const browser = new BrowserSession(config);

  try {
    const page = await browser.open();
    await ensureLoggedIn(page, config);
    if (chatName) {
      await openChatByName(page, chatName);
    }

    const artifacts = await captureDebugArtifacts(page, config, chatName ? `inspect_${chatName}` : "inspect_home");
    console.log(`Saved screenshot: ${artifacts.screenshotPath}`);
    console.log(`Saved HTML: ${artifacts.htmlPath}`);
  } finally {
    await browser.close();
  }
}

async function runWatchLoop(database: AppDatabase): Promise<void> {
  const config = getConfig();
  const taskService = new TaskExtractionService(config, database);
  const intervalMs = config.syncIntervalHours * 60 * 60 * 1000;

  while (true) {
    try {
      await runSingleSync(config, database);
      if (config.taskExtractionEnabled) {
        await taskService.refreshTodayTasks();
      }
    } catch (error) {
      logger.error("Watch cycle failed.", {
        error: error instanceof Error ? error.message : String(error)
      });
    }

    logger.info("Sleeping until next scheduled sync.", {
      hours: config.syncIntervalHours
    });
    await sleep(intervalMs);
  }
}

async function main(): Promise<void> {
  const config = getConfig();
  const database = new AppDatabase(config);
  const command = process.argv[2];
  const args = process.argv.slice(3);

  try {
    switch (command) {
      case "db:init":
        database.init();
        console.log(`Database ready at ${config.dbPath}`);
        break;
      case "login":
        await runLoginCommand();
        break;
      case "sync":
        await runSingleSync(config, database);
        console.log("Sync finished.");
        break;
      case "watch":
        await runWatchLoop(database);
        break;
      case "today": {
        const taskService = new TaskExtractionService(config, database);
        const tasks = await taskService.refreshTodayTasks();
        taskService.printTodayTasks(tasks);
        break;
      }
      case "ask": {
        const chatName = requireArgument(
          args[0],
          "Usage: npm run ask -- \"Exact Chat Name\" \"Your question\" [hours]"
        );
        const userQuestion = requireArgument(
          args[1],
          "Usage: npm run ask -- \"Exact Chat Name\" \"Your question\" [hours]"
        );
        const hours = args[2] ? Number(args[2]) : 48;
        if (!Number.isFinite(hours) || hours <= 0) {
          throw new Error("Hours must be a positive number.");
        }

        const chatQueryService = new ChatQueryService(config, database);
        const answer = await chatQueryService.ask(chatName, userQuestion, hours);
        console.log(answer);
        break;
      }
      case "query": {
        const userQuestion = requireArgument(
          args[0],
          "Usage: npm run query -- \"Your question\" [\"Chat One,Chat Two\"]"
        );
        const chatFilter = args[1];
        const queryService = new QueryEngineService(config, database);
        const result = await queryService.query(userQuestion, chatFilter);
        console.log(result.answer);
        break;
      }
      case "embeddings:index": {
        const embeddingService = new EmbeddingService(config, database);
        const chatName = args[0];
        const hours = args[1] ? Number(args[1]) : 168;

        if (!Number.isFinite(hours) || hours <= 0) {
          throw new Error("Hours must be a positive number.");
        }

        if (chatName) {
          const result = await embeddingService.ensureEmbeddingsForChatSince(chatName, hours);
          console.log(`Indexed ${result.indexed} embedding(s) for ${chatName}. Existing: ${result.existing}.`);
          break;
        }

        const activeChats = database.getActiveChats();
        for (const chat of activeChats) {
          const result = await embeddingService.ensureEmbeddingsForChatSince(chat.name, hours);
          console.log(`Indexed ${result.indexed} embedding(s) for ${chat.name}. Existing: ${result.existing}.`);
        }
        break;
      }
      case "chats:list":
        printChatList(database);
        break;
      case "chats:add": {
        const name = requireArgument(args[0], "Usage: npm run chats:add -- \"Exact Chat Name\"");
        database.addChat(name);
        console.log(`Added chat: ${name}`);
        break;
      }
      case "chats:remove": {
        const name = requireArgument(args[0], "Usage: npm run chats:remove -- \"Exact Chat Name\"");
        database.removeChat(name);
        console.log(`Removed chat: ${name}`);
        break;
      }
      case "inspect":
        await runInspectCommand(args[0]);
        break;
      case "fixture:seed": {
        const result = seedFixtureMessages(database);
        console.log(`Seeded ${result.messages} messages across ${result.chats} chats.`);
        break;
      }
      default:
        console.log("Available commands:");
        console.log("  npm run db:init");
        console.log("  npm run login");
        console.log("  npm run sync");
        console.log("  npm run watch");
        console.log("  npm run today");
        console.log("  npm run ask -- \"Exact Chat Name\" \"Your question\" [hours]");
        console.log("  npm run query -- \"Your question\" [\"Chat One,Chat Two\"]");
        console.log("  npm run embeddings:index -- [\"Exact Chat Name\"] [hours]");
        console.log("  npm run chats:list");
        console.log("  npm run chats:add -- \"Exact Chat Name\"");
        console.log("  npm run chats:remove -- \"Exact Chat Name\"");
        console.log("  npm run inspect -- \"Exact Chat Name\"");
        console.log("  npm run fixture:seed");
        process.exitCode = 1;
        break;
    }
  } finally {
    database.close();
  }
}

main().catch((error) => {
  logger.error("Command failed.", {
    error: error instanceof Error ? error.message : String(error)
  });
  process.exitCode = 1;
});
