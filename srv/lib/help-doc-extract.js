// srv/lib/help-doc-extract.js
//
// Phase 4.7 (#748): LLM extraction adapter for narrative documentation pages
// from help.sap.com, cap.cloud.sap, and ui5.sap.com. Single predicate
// `explains`. Floor 0.7, cap 8. Optional anchor per concept.
//
// Spec: docs/superpowers/specs/2026-07-01-748-phase4.7-help-docs.md §4.3

import { extractConceptsCore } from './kg-extract.js';

const FLOOR = 0.7;
const CAP = 8;
const MIN_NAME_LEN = 2;
const MAX_SLUG_LEN = 80;
const MAX_NAME_LEN = 120;
const MAX_ANCHOR_LEN = 120;
const SLUG_PATTERN = /^[a-z0-9-]+$/;
const REGISTRY_HINT_K = 25;

export const KG_HELP_DOC_EXTRACT_SCHEMA = Object.freeze({
  name: 'extract_help_doc_concepts',
  // Schema is intentionally minimal — matches sibling adapters
  // (sample-extract.js, api-doc-extract.js, video-extract.js). Tight
  // constraints (slug patterns, name/description min-length, anchor patterns,
  // confidence floor) live in `applyPostValidation` below rather than the
  // schema, so a single non-conforming concept in the LLM output DOES NOT
  // cause the whole tool call to return empty. gpt-4o-mini's structured-
  // output mode is stricter than plain JSON validation — schema patterns
  // that reject one item can silently zero the whole array.
  //
  // See spec §4.3 for the intended constraints; they're enforced downstream.
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
            anchor: {
              // §3 Q5: optional slug-format H2/H3 identifier from the doc page.
              // null when the concept is discussed throughout the page rather
              // than in one section. Type-only (no pattern/maxLength here to
              // avoid tool-call rejection); enforced in applyPostValidation.
              type: ['string', 'null'],
            },
          },
        },
      },
    },
  },
});

const HELP_DOC_SYSTEM_PROMPT = `
You are analyzing a page of narrative SAP developer documentation from one of
three sources: help.sap.com (SAP product help), cap.cloud.sap (CAP framework
docs), or ui5.sap.com (UI5 Demo Kit).

Extract the concepts this page EXPLAINS. A page "explains" a concept when the
page teaches how the concept works, describes its behavior, or details how to
use it. This is distinct from merely mentioning a concept in passing.

For each concept, output:
- slug: kebab-case identifier
- name: human-readable concept name
- description: one-sentence description
- confidence: 0.7-1.0 (only output concepts you are confident the page explains)
- anchor: OPTIONAL slug of the H2/H3 section where the concept is primarily
  discussed. Output null if the concept is discussed throughout the page rather
  than in one section. DO NOT invent anchor slugs — only output the exact slug
  format shown in the page structure.

Output at most 8 concepts. Prefer reusing registry concepts (below) over
minting new slugs.
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
    // Anchor: null OR a slug-format string ≤ MAX_ANCHOR_LEN. Anything else null-ed.
    let anchor = null;
    if (typeof item.anchor === 'string' && item.anchor.length > 0) {
      const a = item.anchor.toLowerCase();
      if (SLUG_PATTERN.test(a) && a.length <= MAX_ANCHOR_LEN) anchor = a;
    }
    filtered.push({
      slug: slugLower,
      name: item.name,
      description: typeof item.description === 'string' ? item.description : '',
      confidence: item.confidence,
      anchor,
    });
    if (filtered.length >= CAP) break;
  }
  return filtered;
}
