# WhatsApp Web Collector

Local-only Node.js + TypeScript automation that opens WhatsApp Web in a persistent Playwright browser profile, syncs selected chats into SQLite, and answers: `What do I have to do today?`

It is intentionally simple:

- plain Playwright only
- local SQLite storage
- no unofficial WhatsApp wrapper libraries
- no n8n
- no cloud database
- local Gemma task extraction through Ollama

## What It Does

- Opens WhatsApp Web with a persistent Chromium profile.
- Lets you log in manually when the QR code is shown.
- Syncs only the chats you configure.
- Extracts recent messages with conservative selector fallbacks.
- Stores messages, sync runs, chats, and extracted tasks in SQLite.
- Prints a concise `today` view grouped into urgent, today, follow-ups, blockers, waiting-on, and low-confidence.
- Supports a generic `query` command that can plan retrieval, fact extraction, aggregation, and analysis for ad hoc questions.
- Saves screenshots and HTML snippets when scraping fails.

## Project Layout

```text
.
├─ fixtures/
│  └─ sample-messages.json
├─ sql/
│  └─ schema.sql
├─ src/
│  ├─ ai/
│  │  ├─ ollamaClient.ts
│  │  └─ promptBuilder.ts
│  ├─ browser/
│  │  └─ session.ts
│  ├─ cli/
│  │  └─ index.ts
│  ├─ config/
│  │  └─ env.ts
│  ├─ db/
│  │  ├─ database.ts
│  │  ├─ schema.ts
│  │  └─ types.ts
│  ├─ services/
│  │  ├─ fixtureService.ts
│  │  └─ taskExtractionService.ts
│  ├─ sync/
│  │  └─ syncRunner.ts
│  ├─ utils/
│  │  ├─ files.ts
│  │  ├─ hash.ts
│  │  ├─ json.ts
│  │  ├─ logger.ts
│  │  ├─ sleep.ts
│  │  └─ time.ts
│  └─ whatsapp/
│     ├─ auth.ts
│     ├─ chatNavigator.ts
│     ├─ debug.ts
│     ├─ messageExtractor.ts
│     └─ selectors.ts
├─ .env.example
├─ .gitignore
├─ package.json
└─ tsconfig.json
```

## Requirements

- Node.js 20+
- npm
- Playwright Chromium browser
- Ollama running locally with `gemma4:e2b`

## Install

```bash
npm install
npx playwright install chromium
copy .env.example .env
```

On PowerShell:

```powershell
Copy-Item .env.example .env
```

## First-Time Setup

1. Edit `.env` if you want custom paths or intervals.
2. Make sure Ollama is running locally and `gemma4:e2b` is installed.
3. Initialize the database:

```bash
npm run db:init
```

4. Open WhatsApp Web and log in once:

```bash
npm run login
```

When the QR code is visible, scan it with your phone. The browser uses a persistent profile, so later runs usually reuse the session.

## Add Chats To Monitor

List chats:

```bash
npm run chats:list
```

Add a group or personal chat:

```bash
npm run chats:add -- "Company Group Name"
npm run chats:add -- "Vikas Dhawan"
```

Remove a chat from monitoring:

```bash
npm run chats:remove -- "Company Group Name"
```

Only active chats in the database are synced.

## Run A One-Time Sync

```bash
npm run sync
```

This will:

- open WhatsApp Web
- ensure you are logged in
- open each configured chat
- load recent history for the configured lookback window
- store messages locally in SQLite
- continue if one chat fails

The default lookback is the last 7 days via `LOOKBACK_HOURS=168`.

## Run Scheduled Loop Mode

```bash
npm run watch
```

Default loop interval is `SYNC_INTERVAL_HOURS=6`. If you prefer Windows Task Scheduler or cron, schedule:

```bash
npm run sync
```

every 6 hours instead.

## Ask "What Do I Have To Do Today?"

If Ollama is running locally and `TASK_EXTRACTION_ENABLED=true`:

```bash
npm run today
```

This reads recent synced messages from SQLite, sends only that analysis payload to your local Ollama model, saves extracted tasks back into SQLite, and prints grouped results with source references.

If `TASK_EXTRACTION_ENABLED=false`, the tool skips task extraction and tells you it is disabled.

## Run A Generic Local Query

For open-ended questions that may need retrieval, numeric aggregation, and analysis:

```bash
npm run query -- "Tell me total crushing yesterday and reasons for low drilling"
```

Optionally scope the query to one or more chats:

```bash
npm run query -- "What changed since yesterday?" "HQ Obajana Mines Group"
npm run query -- "Summarize operational issues from the previous day" "HQ Obajana Mines Group,Vikas Dhawan"
```

The query engine will:

- plan a time window and answer style
- load stored messages from SQLite
- use embeddings to retrieve the most relevant evidence
- extract structured operational facts into `operation_facts`
- aggregate numeric facts before asking Gemma for the final answer

## Local Fixture Testing

To test the task extraction flow without opening WhatsApp:

```bash
npm run fixture:seed
npm run today
```

`fixture:seed` imports `fixtures/sample-messages.json` into SQLite.

## Debugging Selectors

If WhatsApp Web changes its DOM, the assumptions are isolated in:

- `src/whatsapp/selectors.ts`
- `src/whatsapp/messageExtractor.ts`
- `src/whatsapp/chatNavigator.ts`

To capture a screenshot plus HTML snapshot:

```bash
npm run inspect -- "Company Group Name"
```

Artifacts are written to `DEBUG_ARTIFACTS_DIR`.

## Environment Variables

Common settings:

- `TASK_EXTRACTION_ENABLED`
- `OLLAMA_BASE_URL`
- `OLLAMA_MODEL` default `gemma4:e2b`
- `OLLAMA_EMBED_MODEL` default `nomic-embed-text:latest`
- `OLLAMA_TIMEOUT_MS`
- `OLLAMA_NUM_CTX`
- `RETRIEVAL_TOP_K`
- `SYNC_INTERVAL_HOURS`
- `USER_DATA_DIR`
- `DB_PATH`
- `DEBUG`
- `LOCAL_ONLY_MODE`
- `HEADLESS`
- `WHATSAPP_URL`
- `LOOKBACK_HOURS` default `168` for the last 7 days
- `TASK_WINDOW_HOURS`
- `TASK_CONTEXT_HOURS`
- `MAX_SCROLL_ITERATIONS`
- `DEBUG_ARTIFACTS_DIR`
- `LOGIN_WAIT_MINUTES`

`LOCAL_ONLY_MODE=true` is compatible with local Ollama extraction because the model runs on your machine.

## Storage

SQLite tables:

- `chats`
- `messages`
- `message_embeddings`
- `operation_facts`
- `sync_runs`
- `extracted_tasks`

Message rows store normalized fields plus raw debug metadata so selector issues are diagnosable later.

## Notes And Limits

- WhatsApp Web DOM changes over time, so selector maintenance is expected.
- This MVP focuses on message text and conservative placeholders for non-text content.
- It avoids printing message content in logs unless `DEBUG=true`.
- Headless mode may work after an initial manual login, but visible mode is the safest starting point.

## Troubleshooting

If login does not persist:

- keep `USER_DATA_DIR` stable
- do not delete the profile folder between runs
- run `npm run login` again

If a chat is not found:

- confirm the chat name matches WhatsApp exactly
- open WhatsApp manually and verify the chat still exists
- run `npm run inspect -- "Exact Chat Name"` and review the debug artifacts

If messages stop extracting:

- inspect the latest screenshot and HTML snapshot
- update selectors in `src/whatsapp/selectors.ts`
- check `src/whatsapp/messageExtractor.ts` fallback logic

If `today` returns nothing useful:

- sync first with `npm run sync`
- verify recent messages exist in the database
- confirm Ollama is running locally and `OLLAMA_MODEL` matches an installed model
- use the fixture flow to verify the extraction pipeline independently
