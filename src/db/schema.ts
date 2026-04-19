import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

export function initializeSchema(db: Database.Database): void {
  const schemaPath = path.resolve(process.cwd(), "sql", "schema.sql");
  const schemaSql = fs.readFileSync(schemaPath, "utf8");
  db.exec(schemaSql);
}

