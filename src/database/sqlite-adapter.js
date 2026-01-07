/**
 * @typedef {import('dictionary-database').TermEntry} TermEntry
 * @typedef {import('dictionary-database').TermMeta} TermMeta
 * @typedef {import('dictionary-database').Tag} Tag
 * @typedef {import('dictionary-database').MatchType} MatchType
 * @typedef {import('dictionary-database').MatchSource} MatchSource
 * @typedef {import('dictionary-database').DatabaseTermEntryWithId} DatabaseTermEntryWithId
 * @typedef {import('translation').TermEnabledDictionaryMap} TermEnabledDictionaryMap
 */

export class SQLiteAdapter {
  /**
   * @param {import("better-sqlite3").Database} database
   */
  constructor(database) {
    /** @type {import("better-sqlite3").Database} */
    this.db = database;
  }

  /**
   * @returns {boolean}
   */
  isPrepared() {
    return this.db !== null;
  }

  /**
   * @param {string} title
   * @returns {boolean}
   */
  dictionaryExists(title) {
    const query = this.db.prepare(
      "SELECT 1 FROM dictionaries WHERE title = ?",
    );
    const result = query.get(title);
    return result !== undefined;
  }

  /**
   * @param {string} table
   * @param {Record<string, unknown>[]} entries
   * @param {number} totalCount
   * @param {number} startIndex
   * @returns {void}
   */
  bulkAdd(table, entries, totalCount, startIndex) {
    if (entries.length === 0) {
      return;
    }

    const keys = Object.keys(entries[0]);
    const queryStr = this._buildQueryStr(table, keys);

    const stmt = this.db.prepare(queryStr);

    const insertMany = this.db.transaction((/** @type {Record<string, unknown>[]} */ rows) => {
      for (const row of rows) {
        const values = keys.map((key) => this._toSqliteValue(row[key]));
        stmt.run(...values);
      }
    });

    insertMany(entries);
  }

  /**
   * @param {string} table
   * @param {Record<string, unknown>} entry
   * @returns {number|bigint}
   */
  addWithResult(table, entry) {
    const keys = Object.keys(entry);
    const queryStr = this._buildQueryStr(table, keys);
    const stmt = this.db.prepare(queryStr);

    const values = keys.map((key) => this._toSqliteValue(entry[key]));
    const res = stmt.run(...values);
    return res.lastInsertRowid;
  }

  /**
   * @param {string} table
   * @param {Array<{data: Record<string, unknown>, primaryKey: number}>} items
   * @param {number} totalCount
   * @param {number} startIndex
   * @returns {void}
   */
  bulkUpdate(table, items, totalCount, startIndex) {
    if (items.length === 0) {
      return;
    }

    // Items have structure: { data: {...fields...}, primaryKey: id }
    // Extract keys from the data object
    const firstItem = items[0];
    const keys = Object.keys(firstItem.data);

    // Build: UPDATE table SET col1 = ?, col2 = ? WHERE id = ?
    // Quote column names to handle reserved keywords like "order"
    const setClause = keys.map((key) => `"${key}" = ?`).join(", ");
    const queryStr = `UPDATE ${table} SET ${setClause} WHERE id = ?`;

    const stmt = this.db.prepare(queryStr);

    const updateMany = this.db.transaction(
      (/** @type {Array<{data: Record<string, unknown>, primaryKey: number}>} */ rows) => {
        for (const row of rows) {
          const values = keys.map((key) => this._toSqliteValue(row.data[key]));
          values.push(row.primaryKey); // Add the WHERE clause value
          stmt.run(...values);
        }
      },
    );

    updateMany(items);
  }

  /**
   * @param {string} table
   * @param {string[]} keys
   * @returns {string}
   */
  _buildQueryStr(table, keys) {
    // Quote column names to handle reserved keywords like "order"
    const columns = keys.map((k) => `"${k}"`).join(", ");
    const placeholders = keys.map(() => "?").join(", ");
    return `INSERT INTO ${table} (${columns}) VALUES (${placeholders})`;
  }

  /**
   * Convert JavaScript values to SQLite-compatible values
   * - Objects/Arrays → JSON string
   * - Booleans → 1 or 0
   * - Everything else → pass through
   * @param {unknown} value
   * @returns {string|number|null}
   */
  _toSqliteValue(value) {
    if (value === null || value === undefined) {
      return null;
    }
    if (typeof value === "boolean") {
      return value ? 1 : 0;
    }
    if (typeof value === "object") {
      return JSON.stringify(value);
    }
    return /** @type {string|number} */ (value);
  }

  /**
   * Find terms in bulk
   * @param {string[]} termList - List of terms to search for
   * @param {TermEnabledDictionaryMap} dictionaries - Map of enabled dictionary names
   * @param {MatchType} matchType - 'exact', 'prefix', or 'suffix'
   * @returns {TermEntry[]} Array of term results
   */
  findTermsBulk(termList, dictionaries, matchType) {
    if (termList.length === 0) {
      return [];
    }

    /** @type {TermEntry[]} */
    const results = [];
    /** @type {Set<number>} */
    const visited = new Set();
    const dictionaryNames = [...dictionaries.keys()];

    if (dictionaryNames.length === 0) {
      return [];
    }

    // Build the base query based on match type
    // Search both expression and reading columns
    const columns =
      matchType === "suffix"
        ? ["expressionReverse", "readingReverse"]
        : ["expression", "reading"];

    for (let itemIndex = 0; itemIndex < termList.length; itemIndex++) {
      const term = termList[itemIndex];

      for (let indexIndex = 0; indexIndex < columns.length; indexIndex++) {
        const column = columns[indexIndex];
        /** @type {DatabaseTermEntryWithId[]} */
        let rows;

        if (matchType === "exact") {
          const stmt = this.db.prepare(
            `SELECT * FROM terms WHERE "${column}" = ? AND dictionary IN (${dictionaryNames.map(() => "?").join(", ")})`,
          );
          rows = /** @type {DatabaseTermEntryWithId[]} */ (
            stmt.all(term, ...dictionaryNames)
          );
        } else if (matchType === "prefix") {
          const stmt = this.db.prepare(
            `SELECT * FROM terms WHERE "${column}" LIKE ? AND dictionary IN (${dictionaryNames.map(() => "?").join(", ")})`,
          );
          rows = /** @type {DatabaseTermEntryWithId[]} */ (
            stmt.all(term + "%", ...dictionaryNames)
          );
        } else if (matchType === "suffix") {
          // For suffix, we search the reversed columns with prefix match
          const stmt = this.db.prepare(
            `SELECT * FROM terms WHERE "${column}" LIKE ? AND dictionary IN (${dictionaryNames.map(() => "?").join(", ")})`,
          );
          rows = /** @type {DatabaseTermEntryWithId[]} */ (
            stmt.all(term + "%", ...dictionaryNames)
          );
        } else {
          // Default to exact match
          const stmt = this.db.prepare(
            `SELECT * FROM terms WHERE "${column}" = ? AND dictionary IN (${dictionaryNames.map(() => "?").join(", ")})`,
          );
          rows = /** @type {DatabaseTermEntryWithId[]} */ (
            stmt.all(term, ...dictionaryNames)
          );
        }

        for (const row of rows) {
          // Skip duplicates
          if (visited.has(row.id)) {
            continue;
          }
          visited.add(row.id);

          // Determine actual match type (might be exact even in prefix/suffix mode)
          /** @type {MatchType} */
          let actualMatchType = matchType;
          const matchSourceIsTerm = indexIndex === 0;
          /** @type {MatchSource} */
          const matchSource = matchSourceIsTerm ? "term" : "reading";
          const matchValue = matchSourceIsTerm ? row.expression : row.reading;

          if (matchValue === term) {
            actualMatchType = "exact";
          }

          results.push(
            this._createTermResult(row, itemIndex, matchSource, actualMatchType),
          );
        }
      }
    }

    return results;
  }

  /**
   * Create a term result object from a database row
   * @param {DatabaseTermEntryWithId} row
   * @param {number} index
   * @param {MatchSource} matchSource
   * @param {MatchType} matchType
   * @returns {TermEntry}
   */
  _createTermResult(row, index, matchSource, matchType) {
    return {
      index,
      matchType,
      matchSource,
      term: row.expression,
      reading: row.reading,
      definitionTags: this._splitField(row.definitionTags),
      termTags: this._splitField(row.termTags || ""),
      rules: this._splitField(row.rules),
      definitions: this._parseJson(row.glossary),
      score: row.score,
      dictionary: row.dictionary,
      id: row.id,
      sequence: typeof row.sequence === "number" ? row.sequence : -1,
    };
  }

  /**
   * Find terms by sequence number (for merge mode)
   * @param {Array<{query: number, dictionary: string}>} sequenceList
   * @returns {TermEntry[]}
   */
  findTermsBySequenceBulk(sequenceList) {
    if (sequenceList.length === 0) {
      return [];
    }

    /** @type {TermEntry[]} */
    const results = [];

    for (let i = 0; i < sequenceList.length; i++) {
      const { query: sequence, dictionary } = sequenceList[i];

      const stmt = this.db.prepare(
        `SELECT * FROM terms WHERE "sequence" = ? AND dictionary = ?`,
      );
      /** @type {DatabaseTermEntryWithId[]} */
      const rows = /** @type {DatabaseTermEntryWithId[]} */ (
        stmt.all(sequence, dictionary)
      );

      for (const row of rows) {
        results.push(this._createTermResult(row, i, "term", "exact"));
      }
    }

    return results;
  }

  /**
   * Find exact term matches (for secondary dictionaries in merge mode)
   * @param {Array<{term: string, reading: string}>} termList
   * @param {TermEnabledDictionaryMap} dictionaries
   * @returns {TermEntry[]}
   */
  findTermsExactBulk(termList, dictionaries) {
    if (termList.length === 0) {
      return [];
    }

    /** @type {TermEntry[]} */
    const results = [];
    const dictionaryNames = [...dictionaries.keys()];

    if (dictionaryNames.length === 0) {
      return [];
    }

    const dictPlaceholders = dictionaryNames.map(() => "?").join(", ");

    for (let i = 0; i < termList.length; i++) {
      const { term, reading } = termList[i];

      const stmt = this.db.prepare(
        `SELECT * FROM terms WHERE "expression" = ? AND "reading" = ? AND dictionary IN (${dictPlaceholders})`,
      );
      /** @type {DatabaseTermEntryWithId[]} */
      const rows = /** @type {DatabaseTermEntryWithId[]} */ (
        stmt.all(term, reading, ...dictionaryNames)
      );

      for (const row of rows) {
        results.push(this._createTermResult(row, i, "term", "exact"));
      }
    }

    return results;
  }

  /**
   * Find term metadata (frequencies, pitch accents)
   * @param {string[]} termList
   * @param {TermEnabledDictionaryMap} dictionaries
   * @returns {TermMeta[]}
   */
  findTermMetaBulk(termList, dictionaries) {
    if (termList.length === 0) {
      return [];
    }

    /** @type {TermMeta[]} */
    const results = [];
    const dictionaryNames = [...dictionaries.keys()];

    if (dictionaryNames.length === 0) {
      return [];
    }

    const dictPlaceholders = dictionaryNames.map(() => "?").join(", ");

    for (let i = 0; i < termList.length; i++) {
      const term = termList[i];

      const stmt = this.db.prepare(
        `SELECT * FROM termMeta WHERE "expression" = ? AND dictionary IN (${dictPlaceholders})`,
      );
      const rows = stmt.all(term, ...dictionaryNames);

      for (const row of /** @type {any[]} */ (rows)) {
        results.push({
          index: i,
          term: row.expression,
          mode: row.mode,
          data: this._parseJson(row.data),
          dictionary: row.dictionary,
        });
      }
    }

    return results;
  }

  /**
   * Find tag metadata
   * @param {import('translator').TagTargetItem[]} items
   * @returns {Array<Tag & {index: number}>}
   */
  findTagMetaBulk(items) {
    if (items.length === 0) {
      return [];
    }

    /** @type {Array<Tag & {index: number}>} */
    const results = [];

    for (let i = 0; i < items.length; i++) {
      const { query, dictionary } = items[i];

      const stmt = this.db.prepare(
        `SELECT * FROM tagMeta WHERE "name" = ? AND dictionary = ?`,
      );
      const row = /** @type {Tag|undefined} */ (stmt.get(query, dictionary));

      if (row) {
        results.push({
          index: i,
          name: row.name,
          category: row.category,
          order: row.order,
          notes: row.notes,
          score: row.score,
          dictionary: row.dictionary,
        });
      }
    }

    return results;
  }

  /**
   * Split a space-separated field into an array
   * @param {string|null|undefined} field
   * @returns {string[]}
   */
  _splitField(field) {
    if (!field) {
      return [];
    }
    return field.split(" ").filter((item) => item.length > 0);
  }

  /**
   * Parse JSON field, returning the value or empty array on failure
   * @param {unknown} value
   * @returns {any}
   */
  _parseJson(value) {
    if (!value) {
      return [];
    }
    if (typeof value === "string") {
      try {
        return JSON.parse(value);
      } catch {
        return [];
      }
    }
    return value;
  }
}
