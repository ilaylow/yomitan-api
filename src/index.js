import Fastify from "fastify";
import cors from "@fastify/cors";
import { db } from "./database/index.js";
import { Translator } from "./translator/translator.js";
import { SQLiteAdapter } from "./database/sqlite-adapter.js";
import { simplifyResponse } from "./utils/simplify-response.js";
import kuromoji from "@sglkc/kuromoji";

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

  const result = await translator.findTerms("simple", term, {
    matchType: "prefix",
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
  });

  return result;
});

fastify.get("/yomitan/api/term/simple/:term", async (request, reply) => {
  const resultsArr = [];
  const { term } = /** @type {{ term: string }} */ (request.params);

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
    const result = await translator.findTerms("simple", lookupTerm, {
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
    });

    const simplifiedResult = simplifyResponse(result);
    const { results } = /** @type {{ results: object[] }} */ (simplifiedResult);
    resultsArr.push(...results);
  }

  return { results: resultsArr };
});

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
