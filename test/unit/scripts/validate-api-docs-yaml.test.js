// test/unit/scripts/validate-api-docs-yaml.test.js
//
// Phase 4.5 (#746) Task 1: unit tests for the api-docs YAML validator.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateApiDocsYaml } = require('../../../scripts/validate-api-docs-yaml.cjs');

describe('validate-api-docs-yaml', () => {
  const validEntry = {
    sourceId: 'API_TEST',
    title: 'Test API',
    url: 'https://api.sap.com/test',
    description: 'A test API for the validation harness.',
    category: 'Test',
    apiType: 'rest',
  };

  it('accepts a valid array of entries', () => {
    expect(validateApiDocsYaml([validEntry])).toEqual({ valid: true, errors: [] });
  });

  it('rejects an entry missing sourceId', () => {
    const { sourceId, ...rest } = validEntry;
    const result = validateApiDocsYaml([rest]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/sourceId/);
  });

  it('rejects a url that is not https://api.sap.com/', () => {
    const result = validateApiDocsYaml([{ ...validEntry, url: 'https://example.com/foo' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/url/);
  });

  it('rejects an unknown apiType value', () => {
    const result = validateApiDocsYaml([{ ...validEntry, apiType: 'json' }]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/apiType/);
  });

  it('rejects duplicate sourceIds within the file', () => {
    const result = validateApiDocsYaml([validEntry, validEntry]);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toMatch(/duplicate.*API_TEST/i);
  });
});
