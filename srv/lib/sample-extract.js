// srv/lib/sample-extract.js
//
// Phase 4.6 (#747): per-type LLM adapter for SAP-samples GitHub repos.
// Single predicate `embodies`. Floor 0.7 (high — samples are
// authoritative reference code). Cap 6. Name required, min 2 chars.
//
// Spec: docs/superpowers/specs/2026-06-29-747-phase4.6-code-samples.md §4.3

import { extractConceptsCore } from './kg-extract.js';

const FLOOR = 0.7;
const CAP = 6;
const MIN_NAME_LEN = 2;

const SYSTEM_PROMPT = `
You are extracting concepts from an SAP-samples GitHub repository. The repo
is a working reference implementation — it EMBODIES one or more concepts
via actual code.

Identify the technical concepts this sample embodies. Aim for 2-5 concepts.
Each concept comes with:
  - slug: stable kebab-case identifier. Reuse from REGISTRY HINT when fits.
  - name: human-readable label. REQUIRED.
  - confidence: 0.0-1.0; floor 0.7 (samples are authoritative reference code).

Do NOT include concepts the README merely mentions in passing. Only emit a
concept when this repo is a working demonstration of how to USE that concept.

You will be given a K=25 list of registry concepts + the repo's primary
language + GitHub topics. STRONGLY PREFER reusing a registry slug.
`.trim();

const SCHEMA = {
  type: 'object',
  required: ['embodies'],
  properties: {
    embodies: {
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
 * @param {string} [args.language]
 * @param {string[]} [args.topics]
 * @param {Array<{slug, name}>} [args.registry]
 * @param {Function} args.callModel
 * @returns {Promise<{ concepts: Array<{slug, name, confidence}>, promptTokens: number, completionTokens: number }>}
 */
export async function extractConceptsFromSample({
  title, description, language, topics = [], registry = [], callModel,
}) {
  const userPrompt = buildUserPrompt({ title, description, language, topics, registry });
  const { verdict, tokenUsage } = await extractConceptsCore({
    system: SYSTEM_PROMPT,
    user: userPrompt,
    schema: SCHEMA,
    callModel,
  });

  const concepts = applyPostValidation(verdict?.embodies ?? []);
  return {
    concepts,
    promptTokens: tokenUsage?.prompt ?? 0,
    completionTokens: tokenUsage?.completion ?? 0,
  };
}

function buildUserPrompt({ title, description, language, topics, registry }) {
  const registryHint = (registry ?? [])
    .slice(0, 25)
    .map(c => `  - ${c.slug} — ${c.name}`)
    .join('\n');
  const topicLine = topics.length > 0 ? `\nGITHUB TOPICS: ${topics.join(', ')}` : '';
  return `
REPO: ${title}
PRIMARY LANGUAGE: ${language || '(unknown)'}${topicLine}

README (first 2000 chars):
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
