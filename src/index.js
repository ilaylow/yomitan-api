import Fastify from "fastify";
import cors from "@fastify/cors";
import { db } from "./database/index.js";
import { Translator } from "./translator/translator.js";
import { SQLiteAdapter } from "./database/sqlite-adapter.js";
import { simplifyResponse } from "./utils/simplify-response.js";
import kuromoji from "@sglkc/kuromoji";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";

// ── Auth config ────────────────────────────────────────────────────────────────
// TODO: move these to environment variables
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "571459247488-v8shkr9cerpljc8e9lipnvaunhqao93l.apps.googleusercontent.com";
const ALLOWED_EMAILS = ["chuenleylow@gmail.com"];
const JWT_SECRET = process.env.JWT_SECRET || "arandomsecretthisisrunninglocally";
// ──────────────────────────────────────────────────────────────────────────────

const googleClient = new OAuth2Client(GOOGLE_CLIENT_ID);

/** Fastify preHandler that validates Bearer JWT and sets request.user
 * @param {import('fastify').FastifyRequest} request
 * @param {import('fastify').FastifyReply} reply
 */
async function verifyAuth(request, reply) {
  const auth = request.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    return reply.code(401).send({ error: "Unauthorized" });
  }
  try {
    /** @type {any} */ (request).user = jwt.verify(auth.slice(7), JWT_SECRET);
  } catch {
    return reply.code(401).send({ error: "Invalid token" });
  }
}

const adapter = new SQLiteAdapter(db);
const translator = new Translator(adapter);
translator.prepare();

const enabledDictionaryMap = new Map([
  [
    "Jitendex.org [2026-01-04]",
    {
      index: 0,
      alias: "",
      allowSecondarySearches: true,
      partsOfSpeechFilter: false,
      useDeinflections: true,
    },
  ],
]);

/** @type {import('translation').FindTermsOptions} */
const searchTermOptions = {
  matchType: "exact",
  deinflect: true,
  primaryReading: "",
  mainDictionary: "Jitendex.org [2026-01-04]",
  sortFrequencyDictionary: null,
  sortFrequencyDictionaryOrder: "descending",
  removeNonJapaneseCharacters: false,
  textReplacements: [null],
  enabledDictionaryMap,
  excludeDictionaryDefinitions: null,
  searchResolution: "word",
  language: "ja",
};

const fastify = Fastify({
  logger: true,
});

/**
 * Check if a character is kanji
 * @param {string} char
 * @returns {boolean}
 */
function isKanji(char) {
  const code = char.charCodeAt(0);
  return code >= 0x4e00 && code <= 0x9faf;
}

/**
 * Check if a string contains kanji characters
 * @param {string} text
 * @returns {boolean}
 */
function containsKanji(text) {
  return /[\u4e00-\u9faf]/.test(text);
}

/**
 * Split text into segments of consecutive kanji and non-kanji characters
 * @param {string} text
 * @returns {string[]}
 */
function splitByKanji(text) {
  if (!text) return [];

  const segments = [];
  let currentSegment = text[0];
  let currentIsKanji = isKanji(text[0]);

  for (let i = 1; i < text.length; i++) {
    const char = text[i];
    const charIsKanji = isKanji(char);

    if (charIsKanji === currentIsKanji) {
      currentSegment += char;
    } else {
      segments.push(currentSegment);
      currentSegment = char;
      currentIsKanji = charIsKanji;
    }
  }

  segments.push(currentSegment);
  return segments;
}

async function initKuromoji() {
  return new Promise((resolve, reject) => {
    kuromoji
      .builder({ dicPath: "node_modules/@sglkc/kuromoji/dict" })
      .build((err, _tokenizer) => {
        if (err) {
          console.error("Failed to initialize tokenizer");
          process.exit(1);
        } else {
          resolve(_tokenizer);
        }
      });
  });
}

/** @type {kuromoji.Tokenizer<kuromoji.IpadicFeatures>} */
let tokenizer = await initKuromoji();

// Register CORS
await fastify.register(cors);

// Health check route
fastify.get("/yomitan", async (request, reply) => {
  return { status: "ok" };
});

// List dictionaries
fastify.get("/yomitan/api/dictionaries", async (request, reply) => {
  const dictionaries = db.prepare("SELECT * FROM dictionaries").all();
  return { dictionaries };
});

fastify.get("/yomitan/api/term/raw/:term", async (request, reply) => {
  const { term } = /** @type {{ term: string }} */ (request.params);

  const result = await translator.findTerms("simple", term, searchTermOptions);

  return result;
});

fastify.get("/yomitan/api/term/simple/:term", async (request, reply) => {
  const resultsArr = [];
  const { term } = /** @type {{ term: string }} */ (request.params);

  // First find if there is an exact match for the term, otherwise break it down by tokenization.
  const result = await translator.findTerms("simple", term, searchTermOptions);
  if (result.dictionaryEntries.length !== 0) {
    return simplifyResponse(result);
  }

  // Split into kanji/non-kanji segments, then tokenize kanji segments
  const segments = splitByKanji(term);
  const termsToLookup = segments.flatMap((segment) => {
    if (containsKanji(segment)) {
      return tokenizer
        .tokenize(segment)
        .filter((t) => t.word_type !== "UNKNOWN")
        .map((t) => t.surface_form);
    }
    return [segment];
  });

  for (const lookupTerm of termsToLookup) {
    const result = await translator.findTerms(
      "simple",
      lookupTerm,
      searchTermOptions,
    );

    const simplifiedResult = simplifyResponse(result);
    const { results } = /** @type {{ results: object[] }} */ (simplifiedResult);
    resultsArr.push(...results);
  }

  return { results: resultsArr };
});

// ── Auth routes ────────────────────────────────────────────────────────────────

/** Exchange a Google ID token for an app JWT */
fastify.post("/yomitan/auth/google", async (request, reply) => {
  const { idToken } = /** @type {any} */ (request.body) ?? {};
  if (!idToken) return reply.code(400).send({ error: "idToken required" });

  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const { email } = /** @type {import('google-auth-library').TokenPayload} */ (ticket.getPayload());

    if (!ALLOWED_EMAILS.includes(email)) {
      return reply.code(403).send({ error: "Access denied" });
    }

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "30d" });
    return { token, email };
  } catch {
    return reply.code(401).send({ error: "Invalid Google token" });
  }
});

// ── Saved words routes ─────────────────────────────────────────────────────────

fastify.get(
  "/yomitan/api/words",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const words = /** @type {any[]} */ (db
      .prepare(
        "SELECT * FROM saved_words WHERE user_email = ? ORDER BY created_at DESC",
      )
      .all(user.email));
    return {
      words: words.map((w) => ({ ...w, glossary: JSON.parse(w.glossary) })),
    };
  },
);

/** Get the date string (YYYY-MM-DD) for today in the server's local timezone */
function todayDateString() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

fastify.post(
  "/yomitan/api/words",
  { preHandler: verifyAuth },
  async (request, reply) => {
    const { term, reading, dictionary, glossary } = /** @type {any} */ (request.body) ?? {};
    if (!term || !reading || !dictionary || !glossary) {
      return reply.code(400).send({ error: "Missing fields" });
    }

    const user = /** @type {any} */ (request).user;
    db.prepare(
        `INSERT INTO saved_words (user_email, term, reading, dictionary, glossary)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_email, term) DO NOTHING`,
      )
      .run(
        user.email,
        term,
        reading,
        dictionary,
        JSON.stringify(glossary),
      );

    const word = /** @type {any} */ (db
      .prepare("SELECT * FROM saved_words WHERE user_email = ? AND term = ?")
      .get(user.email, term));

    // Auto-assign to today's deck
    const deckName = todayDateString();
    db.prepare(
      `INSERT INTO decks (user_email, name) VALUES (?, ?)
       ON CONFLICT(user_email, name) DO NOTHING`,
    ).run(user.email, deckName);

    const deck = /** @type {any} */ (db
      .prepare("SELECT id FROM decks WHERE user_email = ? AND name = ?")
      .get(user.email, deckName));

    db.prepare(
      `INSERT INTO deck_words (deck_id, word_id) VALUES (?, ?)
       ON CONFLICT(deck_id, word_id) DO NOTHING`,
    ).run(deck.id, word.id);

    return { word: { ...word, glossary: JSON.parse(word.glossary) } };
  },
);

fastify.delete(
  "/yomitan/api/words/:id",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const id = Number(/** @type {any} */ (request.params).id);
    db.prepare(
      "DELETE FROM saved_words WHERE id = ? AND user_email = ?",
    ).run(id, user.email);
    // Also remove from all decks
    db.prepare("DELETE FROM deck_words WHERE word_id = ?").run(id);
    return { success: true };
  },
);

// ── Deck routes ───────────────────────────────────────────────────────────────

/** List all decks for the user, ordered by date descending.
 *  Optional ?tag=<tagId> to filter by tag.
 *  Optional ?limit=N&offset=M for pagination.
 *  Returns { decks, total } where total is the unpagenated count. */
fastify.get(
  "/yomitan/api/decks",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const tagId = /** @type {any} */ (request.query).tag;
    const limit = /** @type {any} */ (request.query).limit;
    const offset = /** @type {any} */ (request.query).offset;

    let baseQuery;
    let countQuery;
    let params;

    if (tagId) {
      baseQuery = `SELECT d.*, COUNT(dw.id) AS word_count
         FROM decks d
         JOIN deck_tags dt ON dt.deck_id = d.id AND dt.tag_id = ?
         LEFT JOIN deck_words dw ON dw.deck_id = d.id
         WHERE d.user_email = ?
         GROUP BY d.id
         ORDER BY d.name DESC`;
      countQuery = `SELECT COUNT(DISTINCT d.id) AS total
         FROM decks d
         JOIN deck_tags dt ON dt.deck_id = d.id AND dt.tag_id = ?
         WHERE d.user_email = ?`;
      params = [Number(tagId), user.email];
    } else {
      baseQuery = `SELECT d.*, COUNT(dw.id) AS word_count
         FROM decks d
         LEFT JOIN deck_words dw ON dw.deck_id = d.id
         WHERE d.user_email = ?
         GROUP BY d.id
         ORDER BY d.name DESC`;
      countQuery = `SELECT COUNT(*) AS total FROM decks d WHERE d.user_email = ?`;
      params = [user.email];
    }

    const { total } = /** @type {any} */ (db.prepare(countQuery).get(...params));

    if (limit != null) {
      baseQuery += ` LIMIT ?`;
      params.push(Number(limit));
      if (offset != null) {
        baseQuery += ` OFFSET ?`;
        params.push(Number(offset));
      }
    }

    const decks = /** @type {any[]} */ (db.prepare(baseQuery).all(...params));
    return { decks, total };
  },
);

/** Get all words in a specific deck */
fastify.get(
  "/yomitan/api/decks/:id/words",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const deckId = Number(request.params.id);
    const words = /** @type {any[]} */ (db
      .prepare(
        `SELECT sw.* FROM saved_words sw
         JOIN deck_words dw ON dw.word_id = sw.id
         WHERE dw.deck_id = ? AND sw.user_email = ?
         ORDER BY dw.created_at DESC`,
      )
      .all(deckId, user.email));
    return {
      words: words.map((w) => ({ ...w, glossary: JSON.parse(w.glossary) })),
    };
  },
);

/** Remove a word from a specific deck */
fastify.delete(
  "/yomitan/api/decks/:deckId/words/:wordId",
  { preHandler: verifyAuth },
  async (request) => {
    const deckId = Number(request.params.deckId);
    const wordId = Number(request.params.wordId);
    db.prepare(
      "DELETE FROM deck_words WHERE deck_id = ? AND word_id = ?",
    ).run(deckId, wordId);
    return { success: true };
  },
);

/** Delete an entire deck (does not delete the words themselves) */
fastify.delete(
  "/yomitan/api/decks/:id",
  { preHandler: verifyAuth },
  async (request) => {
    const id = Number(request.params.id);
    const user = /** @type {any} */ (request).user;
    db.prepare("DELETE FROM deck_words WHERE deck_id = ?").run(id);
    db.prepare(
      "DELETE FROM decks WHERE id = ? AND user_email = ?",
    ).run(id, user.email);
    return { success: true };
  },
);

/** Merge source deck into destination deck.
 *  Moves all words from source to dest (skipping duplicates), then deletes source. */
fastify.post(
  "/yomitan/api/decks/:destId/merge/:sourceId",
  { preHandler: verifyAuth },
  async (request, reply) => {
    const user = /** @type {any} */ (request).user;
    const destId = Number(request.params.destId);
    const sourceId = Number(request.params.sourceId);

    // Verify both decks belong to this user
    const dest = db.prepare("SELECT id FROM decks WHERE id = ? AND user_email = ?").get(destId, user.email);
    const source = db.prepare("SELECT id FROM decks WHERE id = ? AND user_email = ?").get(sourceId, user.email);
    if (!dest || !source) {
      return reply.code(404).send({ error: "Deck not found" });
    }

    const merge = db.transaction(() => {
      // Move words: INSERT OR IGNORE skips duplicates (unique index on deck_id, word_id)
      db.prepare(
        `INSERT OR IGNORE INTO deck_words (deck_id, word_id, created_at)
         SELECT ?, word_id, created_at FROM deck_words WHERE deck_id = ?`
      ).run(destId, sourceId);

      // Delete source deck (CASCADE removes its deck_words, deck_tags, quiz_scores)
      db.prepare("DELETE FROM decks WHERE id = ?").run(sourceId);
    });
    merge();

    // Return updated word count
    const { word_count } = /** @type {any} */ (
      db.prepare("SELECT COUNT(*) AS word_count FROM deck_words WHERE deck_id = ?").get(destId)
    );
    return { success: true, word_count };
  },
);

/** Get which decks a word (by term) belongs to */
fastify.get(
  "/yomitan/api/words/:term/decks",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const term = /** @type {string} */ (request.params.term);
    const decks = /** @type {any[]} */ (db
      .prepare(
        `SELECT d.id, d.name FROM decks d
         JOIN deck_words dw ON dw.deck_id = d.id
         JOIN saved_words sw ON sw.id = dw.word_id
         WHERE sw.user_email = ? AND sw.term = ?
         ORDER BY d.name DESC`,
      )
      .all(user.email, term));
    return { decks };
  },
);

// ── Tag routes ────────────────────────────────────────────────────────────────

/** List all tags for the user, ordered by most recently used */
fastify.get(
  "/yomitan/api/tags",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const limit = Number(/** @type {any} */ (request.query).limit) || 0;
    let query = `SELECT t.*, MAX(COALESCE(dt.created_at, t.created_at)) AS last_used
       FROM tags t
       LEFT JOIN deck_tags dt ON dt.tag_id = t.id
       WHERE t.user_email = ?
       GROUP BY t.id
       ORDER BY last_used DESC`;
    if (limit > 0) query += ` LIMIT ${limit}`;
    const tags = /** @type {any[]} */ (db.prepare(query).all(user.email));
    return { tags };
  },
);

/** Create a new tag */
fastify.post(
  "/yomitan/api/tags",
  { preHandler: verifyAuth },
  async (request, reply) => {
    const { name, color } = /** @type {any} */ (request.body) ?? {};
    if (!name) return reply.code(400).send({ error: "name required" });

    const user = /** @type {any} */ (request).user;
    db.prepare(
      `INSERT INTO tags (user_email, name, color) VALUES (?, ?, ?)
       ON CONFLICT(user_email, name) DO UPDATE SET color = excluded.color`,
    ).run(user.email, name.trim(), color || "#e94560");

    const tag = db
      .prepare("SELECT * FROM tags WHERE user_email = ? AND name = ?")
      .get(user.email, name.trim());
    return { tag };
  },
);

/** Delete a tag */
fastify.delete(
  "/yomitan/api/tags/:id",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const id = Number(/** @type {any} */ (request.params).id);
    db.prepare("DELETE FROM deck_tags WHERE tag_id = ?").run(id);
    db.prepare(
      "DELETE FROM tags WHERE id = ? AND user_email = ?",
    ).run(id, user.email);
    return { success: true };
  },
);

/** Add a tag to a deck */
fastify.post(
  "/yomitan/api/decks/:id/tags",
  { preHandler: verifyAuth },
  async (request, reply) => {
    const deckId = Number(/** @type {any} */ (request.params).id);
    const { tagId } = /** @type {any} */ (request.body) ?? {};
    if (!tagId) return reply.code(400).send({ error: "tagId required" });

    db.prepare(
      `INSERT INTO deck_tags (deck_id, tag_id) VALUES (?, ?)
       ON CONFLICT(deck_id, tag_id) DO NOTHING`,
    ).run(deckId, tagId);
    return { success: true };
  },
);

/** Remove a tag from a deck */
fastify.delete(
  "/yomitan/api/decks/:deckId/tags/:tagId",
  { preHandler: verifyAuth },
  async (request) => {
    const deckId = Number(/** @type {any} */ (request.params).deckId);
    const tagId = Number(/** @type {any} */ (request.params).tagId);
    db.prepare(
      "DELETE FROM deck_tags WHERE deck_id = ? AND tag_id = ?",
    ).run(deckId, tagId);
    return { success: true };
  },
);

/** Get tags for a specific deck */
fastify.get(
  "/yomitan/api/decks/:id/tags",
  { preHandler: verifyAuth },
  async (request) => {
    const deckId = Number(/** @type {any} */ (request.params).id);
    const tags = /** @type {any[]} */ (db
      .prepare(
        `SELECT t.* FROM tags t
         JOIN deck_tags dt ON dt.tag_id = t.id
         WHERE dt.deck_id = ?
         ORDER BY t.name`,
      )
      .all(deckId));
    return { tags };
  },
);

// ── Quiz score routes ────────────────────────────────────────────────────────

/** Save a quiz score */
fastify.post(
  "/yomitan/api/quiz/scores",
  { preHandler: verifyAuth },
  async (request, reply) => {
    const { deckId, readingScore, meaningScore, total } = /** @type {any} */ (request.body) ?? {};
    if (deckId == null || readingScore == null || meaningScore == null || total == null) {
      return reply.code(400).send({ error: "Missing fields" });
    }

    const user = /** @type {any} */ (request).user;
    db.prepare(
      `INSERT INTO quiz_scores (user_email, deck_id, reading_score, meaning_score, total)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(user.email, Number(deckId), Number(readingScore), Number(meaningScore), Number(total));

    return { success: true };
  },
);

/** Get most recent quiz score for a deck */
fastify.get(
  "/yomitan/api/decks/:id/quiz-score",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const deckId = Number(request.params.id);
    const score = db
      .prepare(
        `SELECT * FROM quiz_scores
         WHERE user_email = ? AND deck_id = ?
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get(user.email, deckId);
    return { score: score || null };
  },
);

/** Get most recent quiz scores for all decks (batch) */
fastify.get(
  "/yomitan/api/quiz/scores/latest",
  { preHandler: verifyAuth },
  async (request) => {
    const user = /** @type {any} */ (request).user;
    const scores = /** @type {any[]} */ (db
      .prepare(
        `SELECT qs.* FROM quiz_scores qs
         INNER JOIN (
           SELECT deck_id, MAX(created_at) AS max_created
           FROM quiz_scores
           WHERE user_email = ?
           GROUP BY deck_id
         ) latest ON qs.deck_id = latest.deck_id AND qs.created_at = latest.max_created
         WHERE qs.user_email = ?`,
      )
      .all(user.email, user.email));
    return { scores };
  },
);

// ──────────────────────────────────────────────────────────────────────────────

// Start server
const start = async () => {
  try {
    await fastify.listen({ port: 3000 });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};

start();
