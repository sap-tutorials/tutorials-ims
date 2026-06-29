// srv/lib/discovery-mission-extract.js
//
// Phase 4.3 (#447): per-type adapter for SAP Discovery Center mission concept extraction.
//
// Mirrors srv/lib/blog-post-extract.js with two differences:
//   1. Two-predicate schema: teaches + usesServices
//   2. Higher confidence floor for usesServices (0.7 vs 0.6 for teaches) —
//      service names are easier to over-emit.
//
// Spec: docs/superpowers/specs/2026-06-28-447-phase4.3-discovery-missions.md §6

import { extractConceptsCore } from './kg-extract.js';

const TEACHES_CONFIDENCE_FLOOR = 0.6;
const TEACHES_MAX = 8;
const SERVICES_CONFIDENCE_FLOOR = 0.7;
const SERVICES_MAX = 5;
const SERVICE_NAME_MIN_LENGTH = 2;

const SYSTEM_PROMPT = `
You are extracting concepts from an SAP Discovery Center mission.

Missions teach hands-on skills via curated end-to-end scenarios. Identify:

(a) The technical concepts the mission TEACHES — what skills the learner
    gains. Aim for 3-6 concepts (missions are broader than blogs, more
    focused than learning journeys).

    Each cover comes with:
      - slug: stable kebab-case identifier. Reuse from REGISTRY HINT when
              it fits.
      - name: human-readable label (e.g. "CAP service handlers"). REQUIRED.
      - confidence: 0.0-1.0; floor 0.6.

(b) The SAP BTP services the mission USES — explicit product/service
    references in the description. Aim for 2-4 services.

    Each service:
      - name: official SAP service name (e.g. "SAP Integration Suite",
              "SAP Build Apps", "SAP HANA Cloud"). REQUIRED, min 2 chars.
      - confidence: 0.0-1.0; floor 0.7 (higher than concepts — service
                    names are easy to over-emit).

You will be given a K=25 list of existing registry concepts. STRONGLY PREFER
reusing a registry slug for (a) when it fits.
`.trim();

export const DISCOVERY_MISSION_EXTRACT_SCHEMA = {
  type: 'object',
  required: ['teaches', 'usesServices'],
  properties: {
    teaches: {
      type: 'array',
      items: {
        type: 'object',
        required: ['slug', 'name', 'confidence'],
        properties: {
          slug: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$' },
          name: { type: 'string', minLength: 2, maxLength: 120 },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
        },
      },
    },
    usesServices: {
      type: 'array',
      items: {
        type: 'object',
        required: ['name', 'confidence'],
        properties: {
          name: { type: 'string', minLength: SERVICE_NAME_MIN_LENGTH, maxLength: 120 },
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

function buildUserPrompt(mission, nearestConcepts) {
  return `
DISCOVERY MISSION:

Title: ${mission.title}
Effort level: ${mission.effortLevel ?? '(unknown)'}
Category: ${mission.categorySlug ?? '(none)'}

Description:
${mission.description ?? ''}

REGISTRY HINT (nearest concepts by embedding similarity):
${renderRegistryHint(nearestConcepts)}
`.trim();
}

/**
 * @param {object} args
 * @param {Function} args.callModel — ({system, user, schema}) => Promise<{verdict, tokenUsage}>
 * @param {object} args.mission — { slug, title, description, effortLevel, categorySlug }
 * @param {Array<{slug, name, description}>} args.nearestConcepts
 * @returns {Promise<{ teaches: Array, usesServices: Array, tokenUsage: object }>}
 */
export async function extractConceptsFromDiscoveryMission({
  callModel, mission, nearestConcepts,
}) {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(mission, nearestConcepts);

  const { verdict, tokenUsage } = await extractConceptsCore({
    system, user, schema: DISCOVERY_MISSION_EXTRACT_SCHEMA, callModel,
  });

  const teaches = (verdict?.teaches ?? [])
    .filter(t => typeof t?.confidence === 'number' && t.confidence >= TEACHES_CONFIDENCE_FLOOR)
    .filter(t => typeof t?.name === 'string' && t.name.trim().length > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, TEACHES_MAX);

  const usesServices = (verdict?.usesServices ?? [])
    .filter(s => typeof s?.confidence === 'number' && s.confidence >= SERVICES_CONFIDENCE_FLOOR)
    .filter(s => typeof s?.name === 'string' && s.name.trim().length >= SERVICE_NAME_MIN_LENGTH)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, SERVICES_MAX);

  return { teaches, usesServices, tokenUsage };
}
