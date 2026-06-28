// srv/lib/blog-post-extract.js
//
// Phase 4.2 (#447): per-type adapter for blog-post concept extraction.
//
// Mirrors srv/lib/learning-journey-extract.js — same extractConceptsCore call,
// blog-specific system prompt and post-LLM validation rules. Schema requires
// `name` per cover (merge-on-write contract via #707 helper).
//
// Spec: docs/superpowers/specs/2026-06-28-447-phase4.2-blog-posts.md §6

import { extractConceptsCore } from './kg-extract.js';

const DISCUSSES_CONFIDENCE_FLOOR = 0.6;
const DISCUSSES_MAX = 6;
const BODY_CAP_CHARS = 8000;

const SYSTEM_PROMPT = `
You are extracting concepts from an SAP Community blog post.

Identify the technical concepts the post DISCUSSES — the things a reader
would learn about by reading it. Aim for 3-6 concepts (blogs are more
focused than learning journeys).

Each cover comes with:
  - slug: stable kebab-case identifier. Reuse from the REGISTRY HINT when
          it fits.
  - name: human-readable label (e.g. "CAP service handlers"). Required for
          merge-on-write — the cron embeds this when checking whether a
          novel slug is a near-duplicate of an existing concept.
  - confidence: 0.0-1.0; floor 0.6.

You will be given a K=25 list of existing registry concepts. STRONGLY
PREFER reusing a registry slug when it fits.
`.trim();

export const BLOG_POST_EXTRACT_SCHEMA = {
  type: 'object',
  required: ['discusses'],
  properties: {
    discusses: {
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
  },
};

function renderRegistryHint(nearestConcepts) {
  if (!nearestConcepts?.length) return '(empty — minted concepts will be new)';
  return nearestConcepts
    .map(c => `- ${c.slug}: ${c.name}. ${(c.description ?? '').slice(0, 100)}`)
    .join('\n');
}

function buildUserPrompt(post, body, nearestConcepts) {
  const truncatedBody = (body ?? '').slice(0, BODY_CAP_CHARS);
  return `
BLOG POST:

Title: ${post.title}
Author: ${post.authorLogin}
Posted: ${post.postedAt}

Body:
${truncatedBody}

REGISTRY HINT (nearest concepts by embedding similarity):
${renderRegistryHint(nearestConcepts)}
`.trim();
}

/**
 * @param {object} args
 * @param {Function} args.callModel — ({system, user, schema}) => Promise<{verdict, tokenUsage}>
 * @param {object} args.post — { slug, title, authorLogin, postedAt }
 * @param {string} args.body — full HTML; truncated to 8000 chars internally
 * @param {Array<{slug, name, description}>} args.nearestConcepts
 * @returns {Promise<{ discusses: Array, tokenUsage: object }>}
 */
export async function extractConceptsFromBlogPost({
  callModel, post, body, nearestConcepts,
}) {
  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(post, body, nearestConcepts);

  const { verdict, tokenUsage } = await extractConceptsCore({
    system, user, schema: BLOG_POST_EXTRACT_SCHEMA, callModel,
  });

  const discusses = (verdict?.discusses ?? [])
    .filter(d => typeof d?.confidence === 'number' && d.confidence >= DISCUSSES_CONFIDENCE_FLOOR)
    .filter(d => typeof d?.name === 'string' && d.name.trim().length > 0)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, DISCUSSES_MAX);

  return { discusses, tokenUsage };
}
