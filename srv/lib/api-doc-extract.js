// srv/lib/api-doc-extract.js
//
// Phase 4.5 (#746): per-type LLM adapter for api.sap.com packages.
// Single predicate `officialReferenceFor`. Floor 0.7 (high — api-doc
// authority). Cap 6. Name required, min 2 chars.
//
// Spec: docs/superpowers/specs/2026-06-29-746-phase4.5-api-docs.md §4.4

import { extractConceptsCore } from './kg-extract.js';

const FLOOR = 0.7;
const CAP = 6;
const MIN_NAME_LEN = 2;

const SYSTEM_PROMPT = `
You are extracting concepts from a SAP API package's reference documentation on api.sap.com.

Identify the technical concepts this API is the AUTHORITATIVE reference for.
Aim for 1-4 concepts. Each concept comes with:
  - slug: stable kebab-case identifier. Reuse from REGISTRY HINT when fits.
  - name: human-readable label. REQUIRED.
  - confidence: 0.0-1.0; floor 0.7 (api-doc authority demands high confidence).

Do NOT include concepts the API merely mentions in passing. Only emit a concept
when this API is the canonical reference SAP developers would look up to use
that concept.

You will be given a K=25 list of registry concepts. STRONGLY PREFER reusing a
registry slug.
`.trim();

const SCHEMA = {
  type: 'object',
  required: ['officialReferenceFor'],
  properties: {
    officialReferenceFor: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'name', 'confidence'],
        properties: {
          slug: { type: 'string', minLength: 1 },
          name: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

/**
 * @param {object} args
 * @param {string} args.title
 * @param {string} args.description
 * @param {string} args.category
 * @param {string} args.apiType
 * @param {Array<{slug, name}>} [args.registry]
 * @param {Function} args.callModel
 * @returns {Promise<{ concepts: Array<{slug, name, confidence}>, promptTokens: number, completionTokens: number }>}
 */
export async function extractConceptsFromApiDoc({ title, description, category, apiType, registry = [], callModel }) {
  const userPrompt = buildUserPrompt({ title, description, category, apiType, registry });
  const { verdict, tokenUsage } = await extractConceptsCore({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    schema: SCHEMA,
    callModel,
  });

  const concepts = applyPostValidation(verdict?.officialReferenceFor ?? []);
  return {
    concepts,
    promptTokens: tokenUsage?.prompt ?? 0,
    completionTokens: tokenUsage?.completion ?? 0,
  };
}

function buildUserPrompt({ title, description, category, apiType, registry }) {
  const registryHint = (registry ?? [])
    .slice(0, 25)
    .map(c => `  - ${c.slug} — ${c.name}`)
    .join('\n');
  return `
TITLE: ${title}
CATEGORY: ${category}
API TYPE: ${apiType}

DESCRIPTION:
${description}

REGISTRY HINT (existing concepts you should reuse when they fit):
${registryHint}
`.trim();
}

function applyPostValidation(raw) {
  const filtered = [];
  for (const item of raw) {
    if (typeof item?.confidence !== 'number' || item.confidence < FLOOR) continue;
    if (typeof item?.name !== 'string' || item.name.length < MIN_NAME_LEN) continue;
    if (typeof item?.slug !== 'string' || item.slug.length < 1) continue;
    filtered.push({
      slug: item.slug.toLowerCase(),
      name: item.name,
      confidence: item.confidence,
    });
    if (filtered.length >= CAP) break;
  }
  return filtered;
}
