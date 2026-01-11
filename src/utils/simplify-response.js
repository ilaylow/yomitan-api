/**
 * Simplifies the verbose Yomitan dictionary response into a cleaner format
 * @param {{dictionaryEntries: import('dictionary').TermDictionaryEntry[], originalTextLength: number}} response - The raw response from translator.findTerms()
 * @returns {object} Simplified response
 */
export function simplifyResponse(response) {
  const { dictionaryEntries, originalTextLength } = response;

  // Deduplicate entries by sequence number
  const seenSequences = new Set();
  const uniqueEntries = [];

  for (const entry of dictionaryEntries) {
    const sequence = entry.definitions[0]?.sequences?.[0];
    if (sequence && seenSequences.has(sequence)) {
      continue;
    }
    if (sequence) {
      seenSequences.add(sequence);
    }
    uniqueEntries.push(entry);
  }

  const results = uniqueEntries.map((entry) => simplifyEntry(entry));

  return {
    results,
    originalTextLength,
  };
}

/**
 * Simplifies a single dictionary entry
 * @param {object} entry
 * @returns {object}
 */
function simplifyEntry(entry) {
  const headword = entry.headwords[0];
  const definition = entry.definitions[0];

  const result = {
    term: headword?.term || "",
    reading: headword?.reading || "",
    wordClasses: headword?.wordClasses || [],
    score: entry.score,
    dictionary: entry.dictionaryAlias,
    senses: [],
  };

  // Extract senses from structured content
  if (definition?.entries?.[0]?.type === "structured-content") {
    const content = definition.entries[0].content;
    result.senses = extractSenses(content);
  }

  return result;
}

/**
 * Recursively extracts senses (meanings + examples) from structured content
 * @param {any} content
 * @returns {Array<{partsOfSpeech: string[], glossary: string[], examples: Array<{japanese: string, english: string}>}>}
 */
function extractSenses(content) {
  const senses = [];
  const partsOfSpeech = [];

  // Find sense groups and extract data
  walkContent(content, (node) => {
    if (!node || typeof node !== "object") return;

    const dataContent = node.data?.content;

    // Collect parts of speech
    if (dataContent === "part-of-speech-info") {
      partsOfSpeech.push(node.title || node.content);
    }

    // Found a sense - extract glossary and examples
    if (dataContent === "sense") {
      const sense = {
        partsOfSpeech: [...partsOfSpeech],
        glossary: [],
        examples: [],
      };

      // Extract glossary items
      walkContent(node.content, (glossaryNode) => {
        if (glossaryNode?.data?.content === "glossary") {
          sense.glossary = extractGlossaryItems(glossaryNode.content);
        }
        if (glossaryNode?.data?.content === "example-sentence") {
          const example = extractExample(glossaryNode.content);
          if (example) {
            sense.examples.push(example);
          }
        }
      });

      if (sense.glossary.length > 0) {
        senses.push(sense);
      }
    }
  });

  return senses;
}

/**
 * Walks through content tree and calls callback on each node
 * @param {any} content
 * @param {(node: any) => void} callback
 */
function walkContent(content, callback) {
  if (!content) return;

  if (Array.isArray(content)) {
    for (const item of content) {
      walkContent(item, callback);
    }
  } else if (typeof content === "object") {
    callback(content);
    if (content.content) {
      walkContent(content.content, callback);
    }
  }
}

/**
 * Extracts glossary strings from glossary content
 * @param {any} content
 * @returns {string[]}
 */
function extractGlossaryItems(content) {
  const items = [];

  walkContent(content, (node) => {
    if (node?.tag === "li" && typeof node.content === "string") {
      items.push(node.content);
    }
  });

  return items;
}

/**
 * Extracts example sentence from example content
 * @param {any} content
 * @returns {{japanese: string, english: string} | null}
 */
function extractExample(content) {
  let japanese = "";
  let english = "";

  walkContent(content, (node) => {
    if (node?.data?.content === "example-sentence-a") {
      japanese = extractTextContent(node.content);
    }
    if (node?.data?.content === "example-sentence-b") {
      // Find the span with lang="en"
      walkContent(node.content, (child) => {
        if (child?.lang === "en" && typeof child.content === "string") {
          english = child.content;
        }
      });
    }
  });

  if (japanese || english) {
    return { japanese, english };
  }
  return null;
}

/**
 * Extracts plain text from content, handling ruby annotations
 * @param {any} content
 * @returns {string}
 */
function extractTextContent(content) {
  if (!content) return "";

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content.map((item) => extractTextContent(item)).join("");
  }

  if (typeof content === "object") {
    // For ruby elements, only get the base text (skip rt)
    if (content.tag === "ruby") {
      return extractRubyBase(content.content);
    }
    // Skip rt tags (furigana)
    if (content.tag === "rt") {
      return "";
    }
    return extractTextContent(content.content);
  }

  return "";
}

/**
 * Extracts base text from ruby content (excludes rt furigana)
 * @param {any} content
 * @returns {string}
 */
function extractRubyBase(content) {
  if (!content) return "";

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .filter((item) => !(typeof item === "object" && item?.tag === "rt"))
      .map((item) => {
        if (typeof item === "string") return item;
        if (typeof item === "object" && item.tag !== "rt") {
          return extractTextContent(item);
        }
        return "";
      })
      .join("");
  }

  return "";
}
