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
