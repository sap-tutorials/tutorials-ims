// srv/lib/video-extract.js
//
// Phase 4.4 (#447): per-type adapter for SAP Developers YouTube video concept
// extraction.
//
// Mirrors srv/lib/discovery-mission-extract.js with these differences:
//   1. System prompt updated for YouTube-video context.
//   2. Schema key `usesServices` → `featuresService`.
//   3. Input prompt uses title/description/publishedAt/channelTitle
//      instead of effort/category.
//
// Spec: docs/superpowers/specs/2026-06-29-447-phase4.4-videos.md §6

import { extractConceptsCore } from './kg-extract.js';

const TEACHES_CONFIDENCE_FLOOR = 0.6;
const TEACHES_MAX = 8;
const SERVICES_CONFIDENCE_FLOOR = 0.7;
const SERVICES_MAX = 5;
const SERVICE_NAME_MIN_LENGTH = 2;

const SYSTEM_PROMPT = `
You are extracting concepts from an SAP Developers YouTube video.

Videos teach hands-on skills via tutorials, news shows, conference talks, and demos.
Identify:

(a) The technical concepts the video TEACHES — what skills the viewer learns.
    Aim for 3-6 concepts (videos vary widely in scope).

    Each cover comes with:
      - slug: stable kebab-case identifier. Reuse from REGISTRY HINT when fits.
      - name: human-readable label. REQUIRED.
      - confidence: 0.0-1.0; floor 0.6.

(b) The SAP BTP services the video FEATURES — explicit product/service
    references in title or description.

    Each service:
      - name: official SAP service name. REQUIRED, min 2 chars.
      - confidence: 0.0-1.0; floor 0.7 (higher than concepts — service names
                    are easy to over-emit from passing mentions).

You will be given a K=25 list of registry concepts. STRONGLY PREFER reusing
a registry slug for (a) when it fits.
`.trim();

export const VIDEO_EXTRACT_SCHEMA = {
  type: 'object',
  required: ['teaches', 'featuresService'],
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
    featuresService: {
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

function buildUserPrompt(video, nearestConcepts) {
  return `
YOUTUBE VIDEO:

Title: ${video.title}
Channel: ${video.channelTitle ?? '(unknown)'}
Published: ${video.publishedAt ?? '(unknown)'}

Description:
${video.description ?? ''}

REGISTRY HINT (nearest concepts by embedding similarity):
${renderRegistryHint(nearestConcepts)}
`.trim();
}

/**
 * @param {object} args
 * @param {Function} args.callModel — ({system, user, schema}) => Promise<{verdict, tokenUsage}>
 * @param {object} args.video — { slug, title, description, publishedAt, channelTitle }
 * @param {Array<{slug, name, description}>} args.nearestConcepts
 * @returns {Promise<{ teaches: Array, featuresService: Array, tokenUsage: object }>}
 */
export async function extractConceptsFromVideo({
  callModel, video, nearestConcepts,
}) {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(video, nearestConcepts);

  const { verdict, tokenUsage } = await extractConceptsCore({
    system, user, schema: VIDEO_EXTRACT_SCHEMA, callModel,
  });

  const teaches = (verdict?.teaches ?? [])
    .filter(t => typeof t?.confidence === 'number' && t.confidence >= TEACHES_CONFIDENCE_FLOOR)
    .filter(t => typeof t?.name === 'string' && t.name.trim().length > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, TEACHES_MAX);

  const featuresService = (verdict?.featuresService ?? [])
    .filter(s => typeof s?.confidence === 'number' && s.confidence >= SERVICES_CONFIDENCE_FLOOR)
    .filter(s => typeof s?.name === 'string' && s.name.trim().length >= SERVICE_NAME_MIN_LENGTH)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, SERVICES_MAX);

  return { teaches, featuresService, tokenUsage };
}
