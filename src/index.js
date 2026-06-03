import Fastify from "fastify";
import cors from "@fastify/cors";
import { db } from "./database/index.js";
import { Translator } from "./translator/translator.js";
import { SQLiteAdapter } from "./database/sqlite-adapter.js";
import { simplifyResponse } from "./utils/simplify-response.js";
import kuromoji from "@sglkc/kuromoji";
import { OAuth2Client } from "google-auth-library";
import jwt from "jsonwebtoken";
import { notifyDeckAssigned, notifyQuizCompleted } from "./email/notifier.js";

// ── Auth config ────────────────────────────────────────────────────────────────
// TODO: move these to environment variables
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const ALLOWED_EMAILS = [
    "chuenleylow@gmail.com",
    "yeetuskeetus1611@gmail.com",
    "leonmayuaki@gmail.com",
    "invictarocks@gmail.com",
];
const JWT_SECRET = process.env.JWT_SECRET || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5-nano";
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
        /** @type {any} */ (request).user = jwt.verify(
            auth.slice(7),
            JWT_SECRET,
        );
    } catch {
        return reply.code(401).send({ error: "Invalid token" });
    }
}

/** Returns true if the deck exists AND is owned by `email`. Otherwise sends 404/403 via `reply`
 *  and returns false. Callers must early-return when this returns false. */
function assertOwnsDeck(deckId, email, reply) {
    const row = /** @type {any} */ (
        db.prepare("SELECT user_email FROM decks WHERE id = ?").get(deckId)
    );
    if (!row) {
        reply.code(404).send({ error: "Deck not found" });
        return false;
    }
    if (row.user_email !== email) {
        reply.code(403).send({ error: "Forbidden" });
        return false;
    }
    return true;
}

/** Returns access info for `email` against `deckId`, or null if the deck is not visible.
 *  Shape: { owner_email, owned, access_type, teacher_of_owner }
 *    - owned: true iff caller is the owner
 *    - access_type: 'assigned' | 'shared' | null  (from deck_assignments)
 *    - teacher_of_owner: true iff caller is the teacher of the deck's owner */
function getDeckAccess(deckId, email) {
    const deck = /** @type {any} */ (
        db.prepare("SELECT user_email FROM decks WHERE id = ?").get(deckId)
    );
    if (!deck) return null;
    if (deck.user_email === email) {
        return {
            owner_email: deck.user_email,
            owned: true,
            access_type: null,
            teacher_of_owner: false,
        };
    }
    const assignment = /** @type {any} */ (
        db
            .prepare(
                "SELECT access_type FROM deck_assignments WHERE deck_id = ? AND user_email = ?",
            )
            .get(deckId, email)
    );
    const teacherLink = /** @type {any} */ (
        db
            .prepare(
                "SELECT 1 FROM teacher_students WHERE teacher_email = ? AND student_email = ?",
            )
            .get(email, deck.user_email)
    );
    if (!assignment && !teacherLink) return null;
    return {
        owner_email: deck.user_email,
        owned: false,
        access_type: assignment?.access_type ?? null,
        teacher_of_owner: !!teacherLink,
    };
}

/** Send 403 unless the JWT carries role === 'teacher'. Returns false if blocked. */
function requireTeacher(request, reply) {
    const user = /** @type {any} */ (request).user;
    if (user.role !== "teacher") {
        reply.code(403).send({ error: "Teacher role required" });
        return false;
    }
    return true;
}

/** Same contract as assertOwnsDeck but for tags. */
function assertOwnsTag(tagId, email, reply) {
    const row = /** @type {any} */ (
        db.prepare("SELECT user_email FROM tags WHERE id = ?").get(tagId)
    );
    if (!row) {
        reply.code(404).send({ error: "Tag not found" });
        return false;
    }
    if (row.user_email !== email) {
        reply.code(403).send({ error: "Forbidden" });
        return false;
    }
    return true;
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

    const result = await translator.findTerms(
        "simple",
        term,
        searchTermOptions,
    );

    return result;
});

fastify.get("/yomitan/api/term/simple/:term", async (request, reply) => {
    const resultsArr = [];
    const { term } = /** @type {{ term: string }} */ (request.params);

    // First find if there is an exact match for the term, otherwise break it down by tokenization.
    const result = await translator.findTerms(
        "simple",
        term,
        searchTermOptions,
    );
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
        const { results } = /** @type {{ results: object[] }} */ (
            simplifiedResult
        );
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
        const { email } =
            /** @type {import('google-auth-library').TokenPayload} */ (
                ticket.getPayload()
            );

        if (!ALLOWED_EMAILS.includes(email)) {
            return reply.code(403).send({ error: "Access denied" });
        }

        const existing = /** @type {any} */ (
            db
                .prepare("SELECT email, role FROM users WHERE email = ?")
                .get(email)
        );

        if (existing) {
            const token = jwt.sign({ email, role: existing.role }, JWT_SECRET, {
                expiresIn: "30d",
            });
            return { token, email, role: existing.role };
        }

        // First login: issue a short-lived token; frontend must POST /auth/role next.
        const token = jwt.sign({ email, role: null }, JWT_SECRET, {
            expiresIn: "10m",
        });
        return { token, email, role: null, needs_role: true };
    } catch {
        return reply.code(401).send({ error: "Invalid Google token" });
    }
});

/** Set role on first login. Only callable when current JWT has role === null. */
fastify.post(
    "/yomitan/auth/role",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        if (user.role != null) {
            return reply.code(409).send({ error: "Role already set" });
        }

        const body = /** @type {any} */ (request.body) ?? {};
        const role = body.role === "teacher" ? "teacher" : "student";

        db.prepare(
            "INSERT OR IGNORE INTO users (email, role) VALUES (?, ?)",
        ).run(user.email, role);

        const token = jwt.sign({ email: user.email, role }, JWT_SECRET, {
            expiresIn: "30d",
        });
        return { token, email: user.email, role };
    },
);

// ── Saved words routes ─────────────────────────────────────────────────────────

fastify.get(
    "/yomitan/api/words",
    { preHandler: verifyAuth },
    async (request) => {
        const user = /** @type {any} */ (request).user;
        const words = /** @type {any[]} */ (
            db
                .prepare(
                    "SELECT * FROM saved_words WHERE user_email = ? ORDER BY created_at DESC",
                )
                .all(user.email)
        );
        return {
            words: words.map((w) => ({
                ...w,
                glossary: JSON.parse(w.glossary),
            })),
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
        const { term, reading, dictionary, glossary, deckId } =
            /** @type {any} */ (request.body) ?? {};
        if (!term || !reading || !dictionary || !glossary) {
            return reply.code(400).send({ error: "Missing fields" });
        }

        const user = /** @type {any} */ (request).user;

        // Target deck: explicit deckId (owner-checked) for teacher flow,
        // else today's auto-created date-named deck (student flow).
        let targetDeckId;
        if (deckId != null) {
            if (!assertOwnsDeck(Number(deckId), user.email, reply)) return;
            targetDeckId = Number(deckId);
        } else {
            const deckName = todayDateString();
            db.prepare(
                `INSERT INTO decks (user_email, name) VALUES (?, ?)
         ON CONFLICT(user_email, name) DO NOTHING`,
            ).run(user.email, deckName);
            const deck = /** @type {any} */ (
                db
                    .prepare(
                        "SELECT id FROM decks WHERE user_email = ? AND name = ?",
                    )
                    .get(user.email, deckName)
            );
            targetDeckId = deck.id;
        }

        db.prepare(
            `INSERT INTO saved_words (user_email, term, reading, dictionary, glossary)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_email, term) DO NOTHING`,
        ).run(user.email, term, reading, dictionary, JSON.stringify(glossary));

        const word = /** @type {any} */ (
            db
                .prepare(
                    "SELECT * FROM saved_words WHERE user_email = ? AND term = ?",
                )
                .get(user.email, term)
        );

        db.prepare(
            `INSERT INTO deck_words (deck_id, word_id) VALUES (?, ?)
       ON CONFLICT(deck_id, word_id) DO NOTHING`,
        ).run(targetDeckId, word.id);

        return {
            word: { ...word, glossary: JSON.parse(word.glossary) },
            deck_id: targetDeckId,
        };
    },
);

/** Create a custom-named empty deck. Used by the teacher flow. */
fastify.post(
    "/yomitan/api/decks",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const { name } = /** @type {any} */ (request.body) ?? {};
        const trimmed = typeof name === "string" ? name.trim() : "";
        if (!trimmed) return reply.code(400).send({ error: "name required" });

        try {
            const result = db
                .prepare("INSERT INTO decks (user_email, name) VALUES (?, ?)")
                .run(user.email, trimmed);
            const deck = /** @type {any} */ (
                db
                    .prepare("SELECT * FROM decks WHERE id = ?")
                    .get(result.lastInsertRowid)
            );
            return { deck };
        } catch (e) {
            // UNIQUE(user_email, name) violation
            return reply
                .code(409)
                .send({ error: "A deck with that name already exists" });
        }
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

/** List decks visible to the caller (owned + assigned), ordered by date descending.
 *  Each row includes { owned, access_type, owner_email } so the UI can render read-only.
 *  Optional ?tag=<tagId> to filter by tag (only applies to owned decks; tags are owner-scoped).
 *  Optional ?limit=N&offset=M for pagination.
 *  Returns { decks, total } where total is the unpaginated count. */
fastify.get(
    "/yomitan/api/decks",
    { preHandler: verifyAuth },
    async (request) => {
        const user = /** @type {any} */ (request).user;
        const tagId = /** @type {any} */ (request.query).tag;
        const limit = /** @type {any} */ (request.query).limit;
        const offset = /** @type {any} */ (request.query).offset;

        // Visibility CTE: union of owned decks and decks with an assignment row for this user.
        // For owned decks: owned=1, access_type=NULL. For assigned: owned=0, access_type from row.
        // Tag filter intentionally only matches owned decks (tags are owner-scoped).
        const visibility = `
      WITH visible AS (
        SELECT d.id, d.user_email, d.name, d.created_at,
               1 AS owned, NULL AS access_type
          FROM decks d
         WHERE d.user_email = ?
        UNION ALL
        SELECT d.id, d.user_email, d.name, d.created_at,
               0 AS owned, da.access_type
          FROM decks d
          JOIN deck_assignments da ON da.deck_id = d.id
         WHERE da.user_email = ?
      )`;

        let baseQuery;
        let countQuery;
        let params;

        if (tagId) {
            baseQuery = `${visibility}
        SELECT v.id, v.user_email AS owner_email, v.name, v.created_at, v.owned, v.access_type,
               COUNT(dw.id) AS word_count
          FROM visible v
          JOIN deck_tags dt ON dt.deck_id = v.id AND dt.tag_id = ?
          LEFT JOIN deck_words dw ON dw.deck_id = v.id
         GROUP BY v.id
         ORDER BY v.name DESC`;
            countQuery = `${visibility}
        SELECT COUNT(DISTINCT v.id) AS total
          FROM visible v
          JOIN deck_tags dt ON dt.deck_id = v.id AND dt.tag_id = ?`;
            params = [user.email, user.email, Number(tagId)];
        } else {
            baseQuery = `${visibility}
        SELECT v.id, v.user_email AS owner_email, v.name, v.created_at, v.owned, v.access_type,
               COUNT(dw.id) AS word_count
          FROM visible v
          LEFT JOIN deck_words dw ON dw.deck_id = v.id
         GROUP BY v.id
         ORDER BY v.name DESC`;
            countQuery = `${visibility}
        SELECT COUNT(*) AS total FROM visible v`;
            params = [user.email, user.email];
        }

        const { total } = /** @type {any} */ (
            db.prepare(countQuery).get(...params)
        );

        if (limit != null) {
            baseQuery += ` LIMIT ?`;
            params.push(Number(limit));
            if (offset != null) {
                baseQuery += ` OFFSET ?`;
                params.push(Number(offset));
            }
        }

        const decks = /** @type {any[]} */ (
            db.prepare(baseQuery).all(...params)
        );
        return { decks, total };
    },
);

/** Get all words in a specific deck. Visible to owner, assignees, and the owner's teacher. */
fastify.get(
    "/yomitan/api/decks/:id/words",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(request.params.id);
        const access = getDeckAccess(deckId, user.email);
        if (!access) return reply.code(404).send({ error: "Deck not found" });
        const words = /** @type {any[]} */ (
            db
                .prepare(
                    `SELECT sw.* FROM saved_words sw
         JOIN deck_words dw ON dw.word_id = sw.id
         WHERE dw.deck_id = ?
         ORDER BY dw.created_at DESC`,
                )
                .all(deckId)
        );
        return {
            words: words.map((w) => ({
                ...w,
                glossary: JSON.parse(w.glossary),
            })),
            access,
        };
    },
);

/** Remove a word from a specific deck */
fastify.delete(
    "/yomitan/api/decks/:deckId/words/:wordId",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(request.params.deckId);
        const wordId = Number(request.params.wordId);
        if (!assertOwnsDeck(deckId, user.email, reply)) return;
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
    async (request, reply) => {
        const id = Number(request.params.id);
        const user = /** @type {any} */ (request).user;
        if (!assertOwnsDeck(id, user.email, reply)) return;
        db.prepare("DELETE FROM deck_words WHERE deck_id = ?").run(id);
        db.prepare("DELETE FROM decks WHERE id = ?").run(id);
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
        const dest = db
            .prepare("SELECT id FROM decks WHERE id = ? AND user_email = ?")
            .get(destId, user.email);
        const source = db
            .prepare("SELECT id FROM decks WHERE id = ? AND user_email = ?")
            .get(sourceId, user.email);
        if (!dest || !source) {
            return reply.code(404).send({ error: "Deck not found" });
        }

        const merge = db.transaction(() => {
            // Move words: INSERT OR IGNORE skips duplicates (unique index on deck_id, word_id)
            db.prepare(
                `INSERT OR IGNORE INTO deck_words (deck_id, word_id, created_at)
         SELECT ?, word_id, created_at FROM deck_words WHERE deck_id = ?`,
            ).run(destId, sourceId);

            // Delete source deck (CASCADE removes its deck_words, deck_tags, quiz_scores)
            db.prepare("DELETE FROM decks WHERE id = ?").run(sourceId);
        });
        merge();

        // Return updated word count
        const { word_count } = /** @type {any} */ (
            db
                .prepare(
                    "SELECT COUNT(*) AS word_count FROM deck_words WHERE deck_id = ?",
                )
                .get(destId)
        );
        return { success: true, word_count };
    },
);

// ── Deck assignment routes ───────────────────────────────────────────────────

/** Grant read-only access to a deck. Only the deck owner may grant.
 *  Body: { user_email, access_type? } — access_type defaults to 'assigned'. */
fastify.post(
    "/yomitan/api/decks/:id/assign",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(/** @type {any} */ (request.params).id);
        const { user_email: targetEmail, access_type } =
            /** @type {any} */ (request.body) ?? {};
        if (!targetEmail)
            return reply.code(400).send({ error: "user_email required" });
        if (!assertOwnsDeck(deckId, user.email, reply)) return;
        if (targetEmail === user.email) {
            return reply.code(400).send({ error: "Cannot assign to self" });
        }

        const target = /** @type {any} */ (
            db
                .prepare("SELECT email FROM users WHERE email = ?")
                .get(targetEmail)
        );
        if (!target)
            return reply.code(404).send({ error: "Target user not found" });

        const type = access_type === "shared" ? "shared" : "assigned";
        const result = db
            .prepare(
                `INSERT INTO deck_assignments (deck_id, user_email, access_type, granted_by)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(deck_id, user_email) DO UPDATE SET access_type = excluded.access_type`,
            )
            .run(deckId, targetEmail, type, user.email);

        // Only notify on fresh assignments (changes > 0 covers both insert and ON CONFLICT DO UPDATE,
        // but Resend-side dedup isn't needed for our scale; if you re-assign the same student to the
        // same deck, they'll get another email — that's fine, it's a rare action).
        if (result.changes > 0) {
            const deckRow = /** @type {any} */ (
                db.prepare("SELECT name FROM decks WHERE id = ?").get(deckId)
            );
            const studentRow = /** @type {any} */ (
                db
                    .prepare("SELECT display_name FROM users WHERE email = ?")
                    .get(targetEmail)
            );
            const teacherRow = /** @type {any} */ (
                db
                    .prepare("SELECT display_name FROM users WHERE email = ?")
                    .get(user.email)
            );
            notifyDeckAssigned({
                studentEmail: targetEmail,
                studentName: studentRow?.display_name,
                teacherEmail: user.email,
                teacherName: teacherRow?.display_name,
                deckName: deckRow?.name || "(unnamed deck)",
            });
        }

        return {
            success: true,
            deck_id: deckId,
            user_email: targetEmail,
            access_type: type,
        };
    },
);

/** Revoke a deck assignment. Only the original granter may revoke. */
fastify.delete(
    "/yomitan/api/decks/:id/assign/:email",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(/** @type {any} */ (request.params).id);
        const targetEmail = /** @type {string} */ (request.params.email);

        const row = /** @type {any} */ (
            db
                .prepare(
                    "SELECT granted_by FROM deck_assignments WHERE deck_id = ? AND user_email = ?",
                )
                .get(deckId, targetEmail)
        );
        if (!row)
            return reply.code(404).send({ error: "Assignment not found" });
        if (row.granted_by !== user.email) {
            return reply
                .code(403)
                .send({ error: "Only the granter may revoke" });
        }
        db.prepare(
            "DELETE FROM deck_assignments WHERE deck_id = ? AND user_email = ?",
        ).run(deckId, targetEmail);
        return { success: true };
    },
);

/** List assignments on a deck. Only the owner may see who has access. */
fastify.get(
    "/yomitan/api/decks/:id/assignments",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(/** @type {any} */ (request.params).id);
        if (!assertOwnsDeck(deckId, user.email, reply)) return;
        const assignments = /** @type {any[]} */ (
            db
                .prepare(
                    `SELECT user_email, access_type, granted_by, created_at
           FROM deck_assignments WHERE deck_id = ? ORDER BY created_at DESC`,
                )
                .all(deckId)
        );
        return { assignments };
    },
);

/** Get which decks a word (by term) belongs to */
fastify.get(
    "/yomitan/api/words/:term/decks",
    { preHandler: verifyAuth },
    async (request) => {
        const user = /** @type {any} */ (request).user;
        const term = /** @type {string} */ (request.params.term);
        const decks = /** @type {any[]} */ (
            db
                .prepare(
                    `SELECT d.id, d.name FROM decks d
         JOIN deck_words dw ON dw.deck_id = d.id
         JOIN saved_words sw ON sw.id = dw.word_id
         WHERE sw.user_email = ? AND sw.term = ?
         ORDER BY d.name DESC`,
                )
                .all(user.email, term)
        );
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
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const id = Number(/** @type {any} */ (request.params).id);
        if (!assertOwnsTag(id, user.email, reply)) return;
        db.prepare("DELETE FROM deck_tags WHERE tag_id = ?").run(id);
        db.prepare("DELETE FROM tags WHERE id = ?").run(id);
        return { success: true };
    },
);

/** Add a tag to a deck */
fastify.post(
    "/yomitan/api/decks/:id/tags",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(/** @type {any} */ (request.params).id);
        const { tagId } = /** @type {any} */ (request.body) ?? {};
        if (!tagId) return reply.code(400).send({ error: "tagId required" });
        if (!assertOwnsDeck(deckId, user.email, reply)) return;
        if (!assertOwnsTag(Number(tagId), user.email, reply)) return;

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
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(/** @type {any} */ (request.params).deckId);
        const tagId = Number(/** @type {any} */ (request.params).tagId);
        if (!assertOwnsDeck(deckId, user.email, reply)) return;
        db.prepare(
            "DELETE FROM deck_tags WHERE deck_id = ? AND tag_id = ?",
        ).run(deckId, tagId);
        return { success: true };
    },
);

/** Get tags for a specific deck. Visible to anyone who can see the deck. */
fastify.get(
    "/yomitan/api/decks/:id/tags",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const user = /** @type {any} */ (request).user;
        const deckId = Number(/** @type {any} */ (request.params).id);
        if (!getDeckAccess(deckId, user.email)) {
            return reply.code(404).send({ error: "Deck not found" });
        }
        const tags = /** @type {any[]} */ (
            db
                .prepare(
                    `SELECT t.* FROM tags t
         JOIN deck_tags dt ON dt.tag_id = t.id
         WHERE dt.deck_id = ?
         ORDER BY t.name`,
                )
                .all(deckId)
        );
        return { tags };
    },
);

// ── Quiz score routes ────────────────────────────────────────────────────────

/** Save a quiz score */
fastify.post(
    "/yomitan/api/quiz/scores",
    { preHandler: verifyAuth },
    async (request, reply) => {
        const { deckId, readingScore, meaningScore, total } =
            /** @type {any} */ (request.body) ?? {};
        if (
            deckId == null ||
            readingScore == null ||
            meaningScore == null ||
            total == null
        ) {
            return reply.code(400).send({ error: "Missing fields" });
        }

        const user = /** @type {any} */ (request).user;
        const access = getDeckAccess(Number(deckId), user.email);
        if (!access) {
            return reply.code(404).send({ error: "Deck not found" });
        }
        db.prepare(
            `INSERT INTO quiz_scores (user_email, deck_id, reading_score, meaning_score, total)
       VALUES (?, ?, ?, ?, ?)`,
        ).run(
            user.email,
            Number(deckId),
            Number(readingScore),
            Number(meaningScore),
            Number(total),
        );

        // Email the teacher iff: access is a teacher→student assignment (not peer 'shared')
        // AND owner is a teacher linked to caller.
        if (!access.owned && access.access_type === "assigned") {
            const link = /** @type {any} */ (
                db
                    .prepare(
                        "SELECT 1 FROM teacher_students WHERE teacher_email = ? AND student_email = ?",
                    )
                    .get(access.owner_email, user.email)
            );
            if (link) {
                const deckRow = /** @type {any} */ (
                    db
                        .prepare("SELECT name FROM decks WHERE id = ?")
                        .get(Number(deckId))
                );
                const studentRow = /** @type {any} */ (
                    db
                        .prepare(
                            "SELECT display_name FROM users WHERE email = ?",
                        )
                        .get(user.email)
                );
                notifyQuizCompleted({
                    teacherEmail: access.owner_email,
                    studentEmail: user.email,
                    studentName: studentRow?.display_name,
                    deckName: deckRow?.name || "(unnamed deck)",
                    readingScore: Number(readingScore),
                    meaningScore: Number(meaningScore),
                    total: Number(total),
                });
            }
        }

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
        const scores = /** @type {any[]} */ (
            db
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
                .all(user.email, user.email)
        );
        return { scores };
    },
);

// ── Teacher routes ──────────────────────────────────────────────────────────

/** List students linked to the calling teacher. */
fastify.get(
    "/yomitan/api/teacher/students",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!requireTeacher(request, reply)) return;
        const user = /** @type {any} */ (request).user;
        const students = /** @type {any[]} */ (
            db
                .prepare(
                    `SELECT ts.student_email, u.display_name, ts.created_at
           FROM teacher_students ts
           JOIN users u ON u.email = ts.student_email
          WHERE ts.teacher_email = ?
          ORDER BY ts.created_at DESC`,
                )
                .all(user.email)
        );
        return { students };
    },
);

/** Link a student to the calling teacher. Body: { student_email }.
 *  Fails if the student already has a teacher (UNIQUE on student_email). */
fastify.post(
    "/yomitan/api/teacher/students",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!requireTeacher(request, reply)) return;
        const user = /** @type {any} */ (request).user;
        const { student_email: studentEmail } =
            /** @type {any} */ (request.body) ?? {};
        if (!studentEmail)
            return reply.code(400).send({ error: "student_email required" });
        if (studentEmail === user.email) {
            return reply.code(400).send({ error: "Cannot link self" });
        }

        const student = /** @type {any} */ (
            db
                .prepare("SELECT email, role FROM users WHERE email = ?")
                .get(studentEmail)
        );
        if (!student)
            return reply.code(404).send({ error: "Student not found" });
        if (student.role !== "student") {
            return reply
                .code(400)
                .send({ error: "Target user is not a student" });
        }

        const existing = /** @type {any} */ (
            db
                .prepare(
                    "SELECT teacher_email FROM teacher_students WHERE student_email = ?",
                )
                .get(studentEmail)
        );
        if (existing) {
            if (existing.teacher_email === user.email) {
                return { success: true, already_linked: true };
            }
            return reply
                .code(409)
                .send({ error: "Student already has a teacher" });
        }

        const { student_name: studentName } =
            /** @type {any} */ (request.body) ?? {};
        const link = db.transaction(() => {
            db.prepare(
                "INSERT INTO teacher_students (teacher_email, student_email) VALUES (?, ?)",
            ).run(user.email, studentEmail);
            if (typeof studentName === "string" && studentName.trim()) {
                db.prepare(
                    "UPDATE users SET display_name = ? WHERE email = ?",
                ).run(studentName.trim(), studentEmail);
            }
        });
        link();
        return { success: true };
    },
);

/** Unlink a student from the calling teacher. */
fastify.delete(
    "/yomitan/api/teacher/students/:email",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!requireTeacher(request, reply)) return;
        const user = /** @type {any} */ (request).user;
        const studentEmail = /** @type {string} */ (request.params.email);
        const result = db
            .prepare(
                "DELETE FROM teacher_students WHERE teacher_email = ? AND student_email = ?",
            )
            .run(user.email, studentEmail);
        if (result.changes === 0) {
            return reply.code(404).send({ error: "Link not found" });
        }
        return { success: true };
    },
);

/** List a student's own tags (for the teacher's filter UI). */
fastify.get(
    "/yomitan/api/teacher/students/:email/tags",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!requireTeacher(request, reply)) return;
        const user = /** @type {any} */ (request).user;
        const studentEmail = /** @type {string} */ (request.params.email);
        const link = db
            .prepare(
                "SELECT 1 FROM teacher_students WHERE teacher_email = ? AND student_email = ?",
            )
            .get(user.email, studentEmail);
        if (!link) return reply.code(403).send({ error: "Not your student" });

        const tags = /** @type {any[]} */ (
            db
                .prepare(
                    `SELECT * FROM tags WHERE user_email = ? ORDER BY name`,
                )
                .all(studentEmail)
        );
        return { tags };
    },
);

/** Get the student's most recent quiz score on a specific deck (teacher-only). */
fastify.get(
    "/yomitan/api/teacher/students/:email/decks/:id/quiz-score",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!requireTeacher(request, reply)) return;
        const user = /** @type {any} */ (request).user;
        const studentEmail = /** @type {string} */ (request.params.email);
        const deckId = Number(/** @type {any} */ (request.params).id);
        const link = db
            .prepare(
                "SELECT 1 FROM teacher_students WHERE teacher_email = ? AND student_email = ?",
            )
            .get(user.email, studentEmail);
        if (!link) return reply.code(403).send({ error: "Not your student" });

        const score = db
            .prepare(
                `SELECT * FROM quiz_scores
           WHERE user_email = ? AND deck_id = ?
           ORDER BY created_at DESC LIMIT 1`,
            )
            .get(studentEmail, deckId);
        return { score: score || null };
    },
);

/** Get the student's most recent quiz score on every deck (batch, teacher-only). */
fastify.get(
    "/yomitan/api/teacher/students/:email/quiz-scores/latest",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!requireTeacher(request, reply)) return;
        const user = /** @type {any} */ (request).user;
        const studentEmail = /** @type {string} */ (request.params.email);
        const link = db
            .prepare(
                "SELECT 1 FROM teacher_students WHERE teacher_email = ? AND student_email = ?",
            )
            .get(user.email, studentEmail);
        if (!link) return reply.code(403).send({ error: "Not your student" });

        const scores = /** @type {any[]} */ (
            db
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
                .all(studentEmail, studentEmail)
        );
        return { scores };
    },
);

/** Read-only view of one student's owned decks (for the linked teacher). */
fastify.get(
    "/yomitan/api/teacher/students/:email/decks",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!requireTeacher(request, reply)) return;
        const user = /** @type {any} */ (request).user;
        const studentEmail = /** @type {string} */ (request.params.email);

        const link = db
            .prepare(
                "SELECT 1 FROM teacher_students WHERE teacher_email = ? AND student_email = ?",
            )
            .get(user.email, studentEmail);
        if (!link) return reply.code(403).send({ error: "Not your student" });

        const decks = /** @type {any[]} */ (
            db
                .prepare(
                    `SELECT d.id, d.user_email AS owner_email, d.name, d.created_at,
                COUNT(dw.id) AS word_count
           FROM decks d
           LEFT JOIN deck_words dw ON dw.deck_id = d.id
          WHERE d.user_email = ?
          GROUP BY d.id
          ORDER BY d.name DESC`,
                )
                .all(studentEmail)
        );
        return { decks };
    },
);

// ── AI sentence generation ────────────────────────────────────────────────────
// Proxies a single OpenAI chat completion so the API key never leaves the server.
fastify.post(
    "/yomitan/api/ai/sentence",
    { preHandler: verifyAuth },
    async (request, reply) => {
        if (!OPENAI_API_KEY) {
            return reply.code(503).send({ error: "AI not configured" });
        }
        const { term } = /** @type {any} */ (request.body || {});
        if (!term || typeof term !== "string") {
            return reply.code(400).send({ error: "term required" });
        }
        try {
            const res = await fetch(
                "https://api.openai.com/v1/chat/completions",
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${OPENAI_API_KEY}`,
                    },
                    body: JSON.stringify({
                        model: OPENAI_MODEL,
                        messages: [
                            {
                                role: "user",
                                content: `Generate a Japanese sentence using the word "${term}". Provide the sentence in Japanese, followed by the English translation on a new line. Keep it natural and suitable for language learners.`,
                            },
                        ],
                        max_completion_tokens: 5000,
                    }),
                },
            );
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                fastify.log.error(`OpenAI ${res.status}: ${body}`);
                return reply.code(502).send({ error: "Upstream error" });
            }
            const data = /** @type {any} */ (await res.json());
            const sentence = data?.choices?.[0]?.message?.content || "";
            return { sentence };
        } catch (e) {
            fastify.log.error(e);
            return reply.code(502).send({ error: "Upstream error" });
        }
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
