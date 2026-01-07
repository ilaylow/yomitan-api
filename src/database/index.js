import Database from "better-sqlite3";
import fs from "fs";
import path from "path";

const dbPath = path.join(process.cwd(), "data", "app.db");
export const db = new Database(dbPath);

// Load schema on startup
const schemaPath = path.join(import.meta.dirname, "schema.sql");
const schema = fs.readFileSync(schemaPath, "utf8");

db.exec(schema);
