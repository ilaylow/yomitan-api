// Migration 001: add `user_email TEXT NOT NULL REFERENCES users(email)` to
// decks, saved_words, tags, quiz_scores by recreating each table.
//
// SQLite can't `ALTER TABLE ADD CONSTRAINT`, so the canonical pattern is:
//   PRAGMA foreign_keys = OFF   (so dropping referenced tables doesn't fail)
//   create _new table with desired schema
//   copy data
//   drop old, rename new
//   recreate indexes
//   PRAGMA foreign_key_check    (validate before committing)
//   COMMIT, PRAGMA foreign_keys = ON
//
// Run with pm2 stopped:
//   pm2 stop yomitan-api
//   node scripts/migrate-001-user-email-fk.js
//   pm2 start yomitan-api

import Database from "better-sqlite3";
import path from "path";

const dbPath = path.join(process.cwd(), "data", "app.db");
const db = new Database(dbPath);

console.log(`[migrate-001] opening ${dbPath}`);

// Idempotency check: bail if decks already has a FK to users.
const existingFks = db.pragma("foreign_key_list(decks)");
if (existingFks.some((fk) => fk.table === "users")) {
    console.log("[migrate-001] already migrated (decks.user_email already FKs users). Exiting.");
    db.close();
    process.exit(0);
}

db.pragma("foreign_keys = OFF");

const migrate = db.transaction(() => {
    console.log("[migrate-001] decks");
    db.exec(`
        CREATE TABLE decks_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL REFERENCES users(email),
            name TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO decks_new (id, user_email, name, created_at)
            SELECT id, user_email, name, created_at FROM decks;
        DROP TABLE decks;
        ALTER TABLE decks_new RENAME TO decks;
        CREATE UNIQUE INDEX idx_decks_user_name ON decks(user_email, name);
        CREATE INDEX idx_decks_user ON decks(user_email);
    `);

    console.log("[migrate-001] saved_words");
    db.exec(`
        CREATE TABLE saved_words_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL REFERENCES users(email),
            term TEXT NOT NULL,
            reading TEXT NOT NULL,
            dictionary TEXT NOT NULL,
            glossary TEXT NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO saved_words_new (id, user_email, term, reading, dictionary, glossary, created_at)
            SELECT id, user_email, term, reading, dictionary, glossary, created_at FROM saved_words;
        DROP TABLE saved_words;
        ALTER TABLE saved_words_new RENAME TO saved_words;
        CREATE UNIQUE INDEX idx_saved_words_user_term ON saved_words(user_email, term);
        CREATE INDEX idx_saved_words_user ON saved_words(user_email);
    `);

    console.log("[migrate-001] tags");
    db.exec(`
        CREATE TABLE tags_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL REFERENCES users(email),
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#e94560',
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO tags_new (id, user_email, name, color, created_at)
            SELECT id, user_email, name, color, created_at FROM tags;
        DROP TABLE tags;
        ALTER TABLE tags_new RENAME TO tags;
        CREATE UNIQUE INDEX idx_tags_user_name ON tags(user_email, name);
        CREATE INDEX idx_tags_user ON tags(user_email);
    `);

    console.log("[migrate-001] quiz_scores");
    db.exec(`
        CREATE TABLE quiz_scores_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_email TEXT NOT NULL REFERENCES users(email),
            deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
            reading_score INTEGER NOT NULL,
            meaning_score INTEGER NOT NULL,
            total INTEGER NOT NULL,
            created_at INTEGER NOT NULL DEFAULT (unixepoch())
        );
        INSERT INTO quiz_scores_new (id, user_email, deck_id, reading_score, meaning_score, total, created_at)
            SELECT id, user_email, deck_id, reading_score, meaning_score, total, created_at FROM quiz_scores;
        DROP TABLE quiz_scores;
        ALTER TABLE quiz_scores_new RENAME TO quiz_scores;
        CREATE INDEX idx_quiz_scores_user ON quiz_scores(user_email);
        CREATE INDEX idx_quiz_scores_deck ON quiz_scores(user_email, deck_id);
    `);

    // Verify no FK violations were introduced by the migration.
    const violations = db.pragma("foreign_key_check");
    if (violations.length > 0) {
        console.error("[migrate-001] FK violations after migration:", violations);
        throw new Error("FK violations detected — rolling back transaction");
    }
});

try {
    migrate();
    db.pragma("foreign_keys = ON");
    console.log("[migrate-001] done. FK enforcement restored.");
} catch (e) {
    db.pragma("foreign_keys = ON");
    console.error("[migrate-001] FAILED — transaction rolled back:", e.message);
    process.exit(1);
} finally {
    db.close();
}
