import fs from "fs";
import path from "path";
import { db } from "../src/database/index.js";
import { SQLiteAdapter } from "../src/database/sqlite-adapter.js";
import { DictionaryImporter } from "../src/importer/dictionary-importer.js";

const args = process.argv.slice(2);

if (args.length === 0) {
  console.log("Usage: node src/cli/import.js <path-to-dictionary.zip>");
  process.exit(1);
}

const zipPath = path.resolve(args[0]);

if (!fs.existsSync(zipPath)) {
  console.error(`File not found: ${zipPath}`);
  process.exit(1);
}

console.log(`Importing dictionary from: ${zipPath}`);

// Read the ZIP file
const archiveContent = fs.readFileSync(zipPath).buffer;

// Create adapter and importer
const adapter = new SQLiteAdapter(db);
const importer = new DictionaryImporter();

// Import details
const details = {
  prefixWildcardsSupported: true,
  yomitanVersion: "0.0.0.0", // Development version
};

try {
  const result = await importer.importDictionary(
    adapter,
    archiveContent,
    details,
  );

  if (result.errors.length > 0) {
    console.log("\nImport completed with errors:");
    for (const error of result.errors) {
      console.error(`  - ${error.message}`);
    }
  }

  if (result.result) {
    console.log("\nImport successful!");
    console.log(`  Title: ${result.result.title}`);
    console.log(`  Revision: ${result.result.revision}`);
    console.log(`  Terms: ${result.result.counts?.terms?.total || 0}`);
    console.log(`  Kanji: ${result.result.counts?.kanji?.total || 0}`);
  } else {
    console.log("\nImport failed - no result returned");
  }
} catch (error) {
  console.error("\nImport failed with exception:");
  console.error(error);
  process.exit(1);
}
