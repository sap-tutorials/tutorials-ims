// srv/lib/help-doc-extract.js
//
// Phase 4.7 (#748): LLM extraction adapter for narrative documentation pages
// from help.sap.com, cap.cloud.sap, and ui5.sap.com. Single predicate
// `explains`. Floor 0.7, cap 8.
//
// NOTE (2026-07-01): anchor extraction is currently NOT emitted by the LLM.
// Claude 4.6 Sonnet refuses to call the tool when the schema contains a
// nullable field via `type: ['string', 'null']` convention. Verified empirically.
// Column persists on HelpDocConceptLinks; cron writes null. Reinstate via a
// Claude-friendly mechanism (sentinel empty-string, or two-pass extraction)
// when anchor UX is a priority.
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.3

import { extractConceptsCore } from './kg-extract.js';

const FLOOR = 0.7;
const CAP = 8;
const MIN_NAME_LEN = 2;
const MAX_SLUG_LEN = 80;
const MAX_NAME_LEN = 120;
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const REGISTRY_HINT_K = 25;

export const KG_HELP_DOC_EXTRACT_SCHEMA = Object.freeze({
  name: 'extract_help_doc_concepts',
  // Schema is intentionally minimal — matches sibling adapters
  // (sample-extract.js, api-doc-extract.js, video-extract.js). Tight
  // constraints (slug patterns, name/description min-length, anchor patterns,
  // confidence floor) live in `applyPostValidation` below rather than the
  // schema, so a single non-conforming concept in the LLM output DOES NOT
  // cause the whole tool call to return empty.
  //
  // NOTE (2026-07-01, Bug 5): `anchor` was previously declared as
  // `type: ['string', 'null']` per JSON Schema convention for nullable
  // fields. Verified live via one-off diagnostic that Claude 4.6 Sonnet
  // (the KG-extract deployment model) responds with `verdict: {}` — refuses
  // to call the tool at all — when a schema uses the array-type-with-null
  // convention. Removing anchor from the schema entirely restored real
  // multi-concept output (390 completion tokens vs 16 before). LLM does
  // NOT emit anchors today; anchor rendering in Task 3's UI stays dormant
  // until anchor extraction is added back via a Claude-friendly mechanism
  // (candidates for future work: `type: 'string'` with sentinel `''`,
  // or a second post-extraction pass).
  //
  // See spec §4.3 for the original design intent + Bug 5 investigation
  // notes for the trade-off.
  parameters: {
    type: 'object',
    required: ['concepts'],
    properties: {
      concepts: {
        type: 'array',
        items: {
          type: 'object',
          required: ['slug', 'name', 'confidence'],
          properties: {
            slug: { type: 'string', minLength: 1 },
            name: { type: 'string' },
            description: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
          },
        },
      },
    },
  },
});

// System prompt is intentionally active-voice + count-directed. Earlier
// versions used a defensive framing ("distinct from merely mentioning...",
// "DO NOT invent anchor slugs") that empirically caused gpt-4o-mini to emit
// empty concepts arrays on every call (verified 2026-07-01 in a real cron
// run — 500 extractions, ~987k prompt tokens, ~8k completion tokens ≈ 16
// tokens/response = just `{"concepts":[]}`). The active-voice shape below
// mirrors sample-extract.js (which works in production).
// Anchor-invention prevention lives in applyPostValidation (SLUG_PATTERN)
// where it belongs — post-processing, not pre-emission.
const HELP_DOC_SYSTEM_PROMPT = `
You are extracting technical concepts from an SAP developer documentation
page (help.sap.com, cap.cloud.sap, or ui5.sap.com).

Identify the technical concepts this page explains. Aim for 3-6 concepts
per page — pages typically cover a handful of related concepts.

Each concept comes with:
  - slug: stable kebab-case identifier. Reuse from REGISTRY HINT when it fits.
  - name: human-readable label. REQUIRED.
  - description: one-sentence description of the concept.
  - confidence: 0.0-1.0; use 0.7+ for concepts the page directly explains.

You will be given a K=25 list of registry concepts. STRONGLY PREFER reusing
a registry slug when your concept matches — this keeps the graph coherent.
`.trim();

export async function extractConceptsFromHelpDoc({ callModel, helpDoc, nearestConcepts = [] }) {
  const userPrompt = buildUserPrompt({ helpDoc, nearestConcepts });
  const { verdict, tokenUsage } = await extractConceptsCore({
    system: HELP_DOC_SYSTEM_PROMPT,
    user: userPrompt,
    schema: KG_HELP_DOC_EXTRACT_SCHEMA,
    callModel,
  });

  const concepts = applyPostValidation(verdict?.concepts ?? []);
  return {
    concepts,
    promptTokens: tokenUsage?.prompt ?? 0,
    completionTokens: tokenUsage?.completion ?? 0,
  };
}

function buildUserPrompt({ helpDoc, nearestConcepts }) {
  const registryHint = nearestConcepts
    .slice(0, REGISTRY_HINT_K)
    .map(c => `- ${c.slug} — ${c.name}`)
    .join('\n');
  const sectionLine = helpDoc.section ? `\nSECTION: ${helpDoc.section}` : '';
  return `
PAGE TITLE: ${helpDoc.title}
SOURCE: ${helpDoc.source}
PRODUCT: ${helpDoc.product}${sectionLine}
URL: ${helpDoc.url}

PAGE BODY (first 2000 chars):
${helpDoc.description}

REGISTRY HINT (K=${REGISTRY_HINT_K} nearest concepts you should reuse when they fit):
${registryHint}
`.trim();
}

function applyPostValidation(raw) {
  const filtered = [];
  for (const item of raw) {
    if (typeof item?.confidence !== 'number' || item.confidence < FLOOR) continue;
    if (typeof item?.name !== 'string') continue;
    if (item.name.length < MIN_NAME_LEN || item.name.length > MAX_NAME_LEN) continue;
    if (typeof item?.slug !== 'string' || item.slug.length < 1) continue;
    // Normalize slug to lowercase then validate against the pattern. If the
    // LLM emits e.g. `CAP_Handlers`, we lowercase it but then still reject
    // (underscore isn't in the pattern) — extractor won't try to launder
    // non-conforming slugs into the graph.
    const slugLower = item.slug.toLowerCase();
    if (!SLUG_PATTERN.test(slugLower) || slugLower.length > MAX_SLUG_LEN) continue;
    filtered.push({
      slug: slugLower,
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      confidence: item.confidence,
      // anchor is not extracted today — see KG_HELP_DOC_EXTRACT_SCHEMA
      // note for the Claude compatibility trade-off. Column persists on
      // HelpDocConceptLinks per schema; the cron writes null.
      anchor: null,
    });
    if (filtered.length >= CAP) break;
  }
  return filtered;
}
