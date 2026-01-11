import Fastify from "fastify";
import cors from "@fastify/cors";
import { db } from "./database/index.js";
import { Translator } from "./translator/translator.js";
import { SQLiteAdapter } from "./database/sqlite-adapter.js";
import { simplifyResponse } from "./utils/simplify-response.js";

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
    searchResolution: "letter",
    language: "ja",
  });

  return result;
});

fastify.get("/yomitan/api/term/simple/:term", async (request, reply) => {
  const { term } = /** @type {{ term: string }} */ (request.params);

  const result = await translator.findTerms("simple", term, {
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

  return simplifyResponse(result);
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
