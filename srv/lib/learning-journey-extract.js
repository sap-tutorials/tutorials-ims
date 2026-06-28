// srv/lib/learning-journey-extract.js
//
// Phase 4.1 (#447): per-type adapter calling extractConceptsCore.
//
// Builds the system + user prompt (registry hint + prereq candidates),
// calls the shared core, applies post-LLM validation (confidence floors,
// length caps, slug-existence check, self-reference guard).
//
// Spec: docs/superpowers/specs/2026-06-28-447-phase4.1-learning-journeys.md §3

import { extractConceptsCore } from './kg-extract.js';

const COVERS_CONFIDENCE_FLOOR = 0.6;
const PREREQ_CONFIDENCE_FLOOR = 0.7;
const COVERS_MAX = 8;
const PREREQ_MAX = 5;

const SYSTEM_PROMPT = `
You are extracting concepts from an SAP Learning Journey description.

A Learning Journey is a structured curriculum on learning.sap.com that
teaches a coherent skill set across multiple modules (typically 3-20 hours
of content).

Your job is to identify:

1. covers — Concepts the journey discusses or teaches across its modules.
   Aim for 4-8 concepts (journeys are broader than tutorials). Each comes
   with a confidence in 0.0-1.0; floor 0.6.

2. journeyPrerequisites — OTHER learning journeys this journey assumes
   the learner has already taken. Only emit a prerequisite when the
   journey body or title explicitly references prior learning, OR when
   the level + topic structure makes the dependency obvious. Confidence
   floor 0.7.

You will be given:
- A K=25 list of concepts already in the registry. STRONGLY PREFER to
  reuse a registry slug when it fits. Only mint a new slug when the
  journey discusses something genuinely outside the registry's scope.
- A K=10 list of OTHER learning journeys, by title. Reference these by
  slug when listing prerequisites.

If the journey body is empty (metadata-only fallback), extract from
title + level + duration alone; emit fewer concepts (2-4) with lower
confidence (0.5-0.7 typical).
`.trim();

export const LEARNING_JOURNEY_EXTRACT_SCHEMA = {
  type: 'object',
  required: ['covers', 'journeyPrerequisites'],
  properties: {
    covers: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'confidence'],
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    journeyPrerequisites: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'reason', 'confidence'],
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$' },
          reason: { type: 'string', maxLength: 500 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
  },
};

function renderRegistryHint(nearestConcepts) {
  if (!nearestConcepts?.length) return '(empty — minted concepts will be new)';
  return nearestConcepts
    .map(c => `- ${c.slug}: ${c.name}. ${(c.description ?? '').slice(0, 100)}`)
    .join('\n');
}

function renderPrereqCandidates(prereqCandidates) {
  if (!prereqCandidates?.length) return '(none)';
  return prereqCandidates
    .map(j => `- ${j.slug}: ${j.title} (${j.level})`)
    .join('\n');
}

function buildUserPrompt(journey, body, bodySource, nearestConcepts, prereqCandidates) {
  const truncatedBody = (body ?? '').slice(0, 8000);
  return `
LEARNING JOURNEY:

Title: ${journey.title}
Level: ${journey.level}
Duration: ${journey.durationHours} hours
URL: ${journey.url}

Body (${bodySource}):
${truncatedBody}

REGISTRY HINT (nearest concepts by embedding similarity):
${renderRegistryHint(nearestConcepts)}

PREREQUISITE CANDIDATES (nearest learning journeys):
${renderPrereqCandidates(prereqCandidates)}
`.trim();
}

/**
 * @param {object} args
 * @param {Function} args.callModel — ({system, user, schema}) => Promise<response>
 * @param {object} args.journey — { slug, title, level, durationHours, url }
 * @param {string} args.body — body text from body-fetcher (may be empty)
 * @param {'structured'|'readability'|'metadata'} args.bodySource
 * @param {Array<{slug, name, description}>} args.nearestConcepts
 * @param {Array<{slug, title, level}>} args.prereqCandidates
 * @param {Set<string>} args.existingJourneySlugs — for prereq slug-existence check
 * @returns {Promise<{ covers: Array, journeyPrerequisites: Array, tokenUsage: object }>}
 */
export async function extractConceptsFromLearningJourney({
  callModel,
  journey,
  body,
  bodySource,
  nearestConcepts,
  prereqCandidates,
  existingJourneySlugs,
}) {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(journey, body, bodySource, nearestConcepts, prereqCandidates);

  const { verdict, tokenUsage } = await extractConceptsCore({
    system, user, schema: LEARNING_JOURNEY_EXTRACT_SCHEMA, callModel,
  });

  // Post-LLM validation
  const covers = (verdict?.covers ?? [])
    .filter(c => typeof c?.confidence === 'number' && c.confidence >= COVERS_CONFIDENCE_FLOOR)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, COVERS_MAX);

  const journeyPrerequisites = (verdict?.journeyPrerequisites ?? [])
    .filter(p => typeof p?.confidence === 'number' && p.confidence >= PREREQ_CONFIDENCE_FLOOR)
    .filter(p => existingJourneySlugs.has(p.slug))    // slug-existence check
    .filter(p => p.slug !== journey.slug)             // self-reference guard
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, PREREQ_MAX);

  return { covers, journeyPrerequisites, tokenUsage };
}
