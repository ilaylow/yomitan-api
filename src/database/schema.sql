-- Dictionaries
CREATE TABLE IF NOT EXISTS dictionaries (
    id INTEGER PRIMARY KEY,
    title TEXT UNIQUE NOT NULL,
    revision TEXT,
    version INTEGER,
    sequenced INTEGER DEFAULT 0,
    importDate INTEGER,
    prefixWildcardsSupported INTEGER DEFAULT 0,
    counts TEXT,  -- JSON
    styles TEXT,
    importSuccess INTEGER DEFAULT 0,
    author TEXT,
    url TEXT,
    description TEXT,
    attribution TEXT,
    frequencyMode TEXT,
    sourceLanguage TEXT,
    targetLanguage TEXT,
    isUpdatable INTEGER DEFAULT 0,
    indexUrl TEXT,
    downloadUrl TEXT
);

-- Terms
CREATE TABLE IF NOT EXISTS terms (
    id INTEGER PRIMARY KEY,
    dictionary TEXT NOT NULL,
    expression TEXT NOT NULL,
    reading TEXT NOT NULL,
    expressionReverse TEXT,
    readingReverse TEXT,
    definitionTags TEXT,
    rules TEXT,
    score INTEGER DEFAULT 0,
    glossary TEXT NOT NULL,  -- JSON
    sequence INTEGER DEFAULT -1,
    termTags TEXT
);

-- Indexes for fast lookup
-- Single column indexes (for simple lookups)
CREATE INDEX IF NOT EXISTS idx_terms_expression ON terms(expression);
CREATE INDEX IF NOT EXISTS idx_terms_reading ON terms(reading);

-- Composite indexes (for queries filtering by dictionary)
CREATE INDEX IF NOT EXISTS idx_terms_expression_dictionary ON terms(expression, dictionary);
CREATE INDEX IF NOT EXISTS idx_terms_reading_dictionary ON terms(reading, dictionary);
CREATE INDEX IF NOT EXISTS idx_terms_expression_reading ON terms(expression, reading);
CREATE INDEX IF NOT EXISTS idx_terms_dictionary_sequence ON terms(dictionary, sequence);

-- Indexes for suffix/reverse search
CREATE INDEX IF NOT EXISTS idx_terms_expressionReverse ON terms(expressionReverse);
CREATE INDEX IF NOT EXISTS idx_terms_readingReverse ON terms(readingReverse);

-- Term metadata (frequencies, pitch accents)
CREATE TABLE IF NOT EXISTS termMeta (
    id INTEGER PRIMARY KEY,
    dictionary TEXT NOT NULL,
    expression TEXT NOT NULL,
    mode TEXT NOT NULL,  -- 'freq', 'pitch', 'ipa'
    data TEXT NOT NULL  -- JSON
);

CREATE INDEX IF NOT EXISTS idx_termMeta_expression ON termMeta(expression);
CREATE INDEX IF NOT EXISTS idx_termMeta_expression_dictionary ON termMeta(expression, dictionary);

-- Kanji
CREATE TABLE IF NOT EXISTS kanji (
    id INTEGER PRIMARY KEY,
    dictionary TEXT NOT NULL,
    character TEXT NOT NULL,
    onyomi TEXT,
    kunyomi TEXT,
    tags TEXT,
    meanings TEXT NOT NULL,  -- JSON
    stats TEXT  -- JSON
);

CREATE INDEX IF NOT EXISTS idx_kanji_character ON kanji(character);

-- Kanji metadata
CREATE TABLE IF NOT EXISTS kanjiMeta (
    id INTEGER PRIMARY KEY,
    dictionary TEXT NOT NULL,
    character TEXT NOT NULL,
    mode TEXT NOT NULL,
    data TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_kanjiMeta_character ON kanjiMeta(character);

-- Tag definitions
CREATE TABLE IF NOT EXISTS tagMeta (
    id INTEGER PRIMARY KEY,
    dictionary TEXT NOT NULL,
    name TEXT NOT NULL,
    category TEXT,
    "order" INTEGER DEFAULT 0,
    notes TEXT,
    score INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_tagMeta_dictionary_name ON tagMeta(dictionary, name);

-- Media files (images, etc.)
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY,
    dictionary TEXT NOT NULL,
    path TEXT NOT NULL,
    mediaType TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    content BLOB NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_media_dictionary_path ON media(dictionary, path);

-- Saved words (per-user vocabulary list)
CREATE TABLE IF NOT EXISTS saved_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL REFERENCES users(email),
    term TEXT NOT NULL,
    reading TEXT NOT NULL,
    dictionary TEXT NOT NULL,
    glossary TEXT NOT NULL,  -- JSON: array of gloss strings
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_words_user_term ON saved_words(user_email, term);
CREATE INDEX IF NOT EXISTS idx_saved_words_user ON saved_words(user_email);

-- Decks (date-based collections of saved words)
CREATE TABLE IF NOT EXISTS decks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL REFERENCES users(email),
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_decks_user_name ON decks(user_email, name);
CREATE INDEX IF NOT EXISTS idx_decks_user ON decks(user_email);

-- Junction table: which words belong to which decks
CREATE TABLE IF NOT EXISTS deck_words (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    word_id INTEGER NOT NULL REFERENCES saved_words(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_words ON deck_words(deck_id, word_id);
CREATE INDEX IF NOT EXISTS idx_deck_words_word ON deck_words(word_id);

-- Tags (user-created labels for decks)
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL REFERENCES users(email),
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '#e94560',
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_user_name ON tags(user_email, name);
CREATE INDEX IF NOT EXISTS idx_tags_user ON tags(user_email);

-- Junction table: which tags belong to which decks
CREATE TABLE IF NOT EXISTS deck_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_deck_tags ON deck_tags(deck_id, tag_id);
CREATE INDEX IF NOT EXISTS idx_deck_tags_tag ON deck_tags(tag_id);

-- Quiz scores (per-deck quiz attempt results)
CREATE TABLE IF NOT EXISTS quiz_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email TEXT NOT NULL REFERENCES users(email),
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    reading_score INTEGER NOT NULL,
    meaning_score INTEGER NOT NULL,
    total INTEGER NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_quiz_scores_user ON quiz_scores(user_email);
CREATE INDEX IF NOT EXISTS idx_quiz_scores_deck ON quiz_scores(user_email, deck_id);

-- Per-word quiz outcomes for a student's *latest* attempt of a deck. Each row
-- is upserted on submit, so history is intentionally not preserved — the table
-- always reflects the most recent attempt only. Teachers query this to see
-- which specific words the student got right/wrong.
CREATE TABLE IF NOT EXISTS quiz_word_results (
    user_email TEXT NOT NULL REFERENCES users(email),
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    word_id INTEGER NOT NULL REFERENCES saved_words(id) ON DELETE CASCADE,
    reading_correct INTEGER NOT NULL,  -- 0 or 1
    meaning_correct INTEGER NOT NULL,  -- 0 or 1
    attempted_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (user_email, deck_id, word_id)
);

CREATE INDEX IF NOT EXISTS idx_quiz_word_results_deck ON quiz_word_results(deck_id, user_email);

-- Users (role + identity). Membership still gated by ALLOWED_EMAILS in code.
CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK (role IN ('student','teacher')),
    display_name TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Teacher↔student link. UNIQUE on student enforces "one teacher per student".
CREATE TABLE IF NOT EXISTS teacher_students (
    teacher_email TEXT NOT NULL REFERENCES users(email),
    student_email TEXT NOT NULL REFERENCES users(email),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (teacher_email, student_email)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_teacher_students_student ON teacher_students(student_email);

-- Read-only deck access grants. Deck.user_email remains the sole owner/mutator.
CREATE TABLE IF NOT EXISTS deck_assignments (
    deck_id INTEGER NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    user_email TEXT NOT NULL REFERENCES users(email),
    access_type TEXT NOT NULL CHECK (access_type IN ('assigned','shared')),
    granted_by TEXT NOT NULL REFERENCES users(email),
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    PRIMARY KEY (deck_id, user_email)
);

CREATE INDEX IF NOT EXISTS idx_deck_assignments_user ON deck_assignments(user_email);