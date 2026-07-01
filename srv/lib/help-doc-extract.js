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
const REGISTRY_HINT_K = 25;

export const KG_HELP_DOC_EXTRACT_SCHEMA = Object.freeze({
  name: 'extract_help_doc_concepts',
  parameters: {
    type: 'object',
    properties: {
      concepts: {
        type: 'array',
        maxItems: CAP,
        items: {
          type: 'object',
          properties: {
            slug: { type: 'string', pattern: '^[a-z0-9-]+$', maxLength: 80 },
            name: { type: 'string', minLength: MIN_NAME_LEN, maxLength: 120 },
            description: { type: 'string', minLength: 10, maxLength: 500 },
            confidence: { type: 'number', minimum: FLOOR, maximum: 1.0 },
            anchor: {
              // §3 Q5: optional slug-format H2/H3 identifier from the doc page.
              // null when the concept is discussed throughout the page rather
              // than in one section.
              type: ['string', 'null'],
              pattern: '^[a-z0-9-]+$',
              maxLength: 120,
            },
          },
          required: ['slug', 'name', 'description', 'confidence'],
        },
      },
    },
    required: ['concepts'],
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
    if (typeof item?.name !== 'string' || item.name.length < MIN_NAME_LEN) continue;
    if (typeof item?.slug !== 'string' || item.slug.length < 1) continue;
    filtered.push({
      slug: item.slug.toLowerCase(),
      name: item.name,
      description: item.description ?? '',
      confidence: item.confidence,
      anchor: (typeof item.anchor === 'string' && item.anchor.length > 0) ? item.anchor.toLowerCase() : null,
    });
    if (filtered.length >= CAP) break;
  }
  return filtered;
}
