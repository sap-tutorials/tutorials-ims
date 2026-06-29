#!/usr/bin/env node
// scripts/validate-api-docs-yaml.cjs
//
// Phase 4.5 (#746): YAML schema validator for db/data/api-docs.yaml.
// Run via `npm run validate-api-docs-yaml`. Wired into CI on every PR
// touching db/data/api-docs.yaml.

const fs = require('node:fs');
const path = require('node:path');
const yaml = require('js-yaml');
const Ajv = require('ajv');

const VALID_API_TYPES = ['odata-v2', 'odata-v4', 'rest', 'soap', 'reference', 'graphql', 'other'];

const SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    required: ['sourceId', 'title', 'url', 'description', 'category', 'apiType'],
    properties: {
      sourceId: { type: 'string', pattern: '^[A-Za-z0-9_\\-]+$', minLength: 1, maxLength: 120 },
      title: { type: 'string', minLength: 5, maxLength: 255 },
      url: { type: 'string', pattern: '^https://api\\.sap\\.com/', maxLength: 500 },
      description: { type: 'string', minLength: 20 },
      category: { type: 'string', minLength: 2, maxLength: 80 },
      apiType: { type: 'string', enum: VALID_API_TYPES },
    },
  },
};

function validateApiDocsYaml(data) {
  const ajv = new Ajv({ allErrors: true });
  const validate = ajv.compile(SCHEMA);
  const errors = [];
  if (!validate(data)) {
    for (const e of validate.errors) {
      // Surface the failing property name in the error string so test
      // matchers (e.g. /sourceId/, /url/, /apiType/) hit reliably even
      // when the message reads "must have required property 'sourceId'".
      const propMatch = /must have required property '([^']+)'/.exec(e.message || '');
      const prop = propMatch ? propMatch[1] : '';
      const inst = e.instancePath || '(root)';
      errors.push(`${inst}: ${e.message}${prop ? ` [${prop}]` : ''}`);
    }
    return { valid: false, errors };
  }
  // Duplicate sourceId check (Ajv schema can't express this cleanly).
  const seen = new Set();
  for (const row of data) {
    if (seen.has(row.sourceId)) errors.push(`duplicate sourceId in file: ${row.sourceId}`);
    seen.add(row.sourceId);
  }
  return errors.length > 0 ? { valid: false, errors } : { valid: true, errors: [] };
}

function main() {
  const yamlPath = path.resolve(__dirname, '..', 'db', 'data', 'api-docs.yaml');
  if (!fs.existsSync(yamlPath)) {
    console.error(`api-docs.yaml not found at ${yamlPath}`);
    process.exit(1);
  }
  const raw = fs.readFileSync(yamlPath, 'utf8');
  const data = yaml.load(raw);
  const result = validateApiDocsYaml(data);
  if (!result.valid) {
    console.error(`api-docs.yaml validation FAILED:\n  ${result.errors.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`api-docs.yaml: OK (${data.length} entries)`);
  process.exit(0);
}

module.exports = { validateApiDocsYaml };
if (require.main === module) main();
