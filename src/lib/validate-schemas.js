/*
 * Stub for validate-schemas.js
 * In the full Yomitan build, this is generated from JSON schemas using AJV.
 * For now, we skip validation and always return true.
 * TODO: Implement proper schema validation if needed.
 */

// Create a validator function that always returns true
const createValidator = () => {
  const validator = () => true;
  /** @type {any} */ validator.errors = null;
  return validator;
};

export const dictionaryIndex = createValidator();
export const dictionaryTermBankV1 = createValidator();
export const dictionaryTermBankV3 = createValidator();
export const dictionaryTermMetaBankV3 = createValidator();
export const dictionaryKanjiBankV1 = createValidator();
export const dictionaryKanjiBankV3 = createValidator();
export const dictionaryKanjiMetaBankV3 = createValidator();
export const dictionaryTagBankV3 = createValidator();
