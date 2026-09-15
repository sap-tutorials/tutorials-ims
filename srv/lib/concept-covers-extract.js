// srv/lib/concept-covers-extract.js
// Shared `covers`-predicate concept extractor for external-content adapters
// (SAP community events #765, TechEd sessions #2312, ...).
//
// Both adapters classify a single item (event / session) by which technical
// concepts it COVERS. They differ only in the system prompt + how they render
// the user prompt from their row shape; the LLM contract, output schema, and
// post-validation (floor 0.7 confidence, cap 6, min-name-len, slug lowercase)
// are identical. That common core lives here.
//
// CRITICAL — model-call contract. This routes through extractConceptsCore()
// from srv/lib/kg-extract.js, which calls the injected `callModel` as
//   callModel({ system, user, schema }) => { verdict, promptTokens?, completionTokens?, ... }
// exactly as srv/lib/code-check-llm.js `defaultCallModel` expects. A previous
// implementation called `callModel({ system, messages, max_tokens })` and read
// `response.content` / `response.usage` (an Anthropic-style shape the real
// defaultCallModel never returns) — that silently yielded zero concept links in
// production. Do NOT reintroduce the `messages` / `.content` shape here.

import { extractConceptsCore } from './kg-extract.js';

/** Hard cap on emitted concepts per item. */
export const CAP_CONCEPTS = 6;
/** Drop concepts below this confidence. */
export const FLOOR_CONFIDENCE = 0.7;
/** Minimum length for slug and name. */
export const MIN_NAME_LEN = 2;

/**
 * Forced-tool-call JSON schema for the `covers` extraction output. Passed
 * explicitly to callModel so we never fall back to defaultCallModel's
 * code-check schema. Modeled on KG_EXTRACT_SCHEMA in srv/lib/kg-extract.js.
 */
export const COVERS_CONCEPTS_SCHEMA = {
  type: 'object',
  properties: {
    concepts: {
      type: 'array',
      description: `Technical concepts this item covers. Emit at most ${CAP_CONCEPTS}.`,
      items: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            pattern: '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$',
            description: 'Stable kebab-case identifier. Reuse from the nearest-concepts list when it fits.',
          },
          name: { type: 'string', description: 'Human-readable concept label.' },
          description: { type: 'string', description: 'One-sentence description of the concept.' },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'How central this concept is to the item.',
          },
        },
        required: ['slug', 'name', 'confidence'],
      },
    },
  },
  required: ['concepts'],
};

/**
 * Render the K=15 nearest-concepts hint as prompt bullet lines. Shared so both
 * adapters format the registry hint identically (grep-able by tests: `slug`
 * substrings appear verbatim in the user prompt).
 *
 * @param {Array<{slug: string, name: string}>} nearestConcepts
 * @returns {string[]}
 */
export function nearestConceptLines(nearestConcepts) {
  return [
    `Nearest concepts (choose from these when there's a good match; otherwise emit a new slug):`,
    ...(nearestConcepts ?? []).slice(0, 15).map((c) => `- ${c.slug}: ${c.name}`),
  ];
}

/**
 * Run the LLM extraction and apply post-validation. Content-type-agnostic:
 * callers supply the system prompt + a fully-rendered user prompt string.
 *
 * @param {object} args
 * @param {string} args.system    — system prompt
 * @param {string} args.user      — fully-rendered user prompt STRING
 * @param {Function} args.callModel — ({system, user, schema}) => Promise<{verdict, ...}>
 * @returns {Promise<{ concepts: Array<{slug,name,description,confidence}>, promptTokens: number, completionTokens: number }>}
 */
export async function extractCoversConcepts({ system, user, callModel }) {
  const { verdict, tokenUsage } = await extractConceptsCore({
    system,
    user,
    schema: COVERS_CONCEPTS_SCHEMA,
    callModel,
  });

  // Contract tripwire (#2312): if a future change hands us a raw chat-completion
  // shape (`{ content: [...] }`) instead of a forced-tool verdict, surface it
  // LOUDLY instead of silently returning zero concepts — which is exactly how
  // the original bug shipped. A well-formed verdict carries `concepts`; the
  // legacy Anthropic shape carries `content` and no `concepts`. Jobs catch this
  // per-row (errors++), so one bad shape is visible without aborting the batch.
  if (verdict && typeof verdict === 'object' && !('concepts' in verdict) && 'content' in verdict) {
    throw new Error(
      'concept-covers-extract: model response looks like a raw chat completion ' +
        '({ content: [...] }), not a forced-tool verdict ({ concepts: [...] }). ' +
        'callModel must satisfy the defaultCallModel contract.'
    );
  }

  const raw = Array.isArray(verdict?.concepts) ? verdict.concepts : [];
  const filtered = [];
  for (const c of raw) {
    if (typeof c?.slug !== 'string' || c.slug.length < MIN_NAME_LEN) continue;
    if (typeof c?.name !== 'string' || c.name.length < MIN_NAME_LEN) continue;
    if (typeof c?.confidence !== 'number' || c.confidence < FLOOR_CONFIDENCE) continue;
    filtered.push({
      slug: c.slug.toLowerCase(),
      name: c.name.trim(),
      description: (c.description ?? '').trim(),
      confidence: c.confidence,
    });
    if (filtered.length >= CAP_CONCEPTS) break;
  }

  return {
    concepts: filtered,
    promptTokens: tokenUsage.prompt,
    completionTokens: tokenUsage.completion,
  };
}
