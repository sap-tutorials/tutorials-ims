// srv/lib/kg-extract.js
// Constrained per-tutorial concept extraction via forced-tool-call LLM.
//
// Pure module: callModel is dependency-injected. The caller (the cron job)
// supplies `defaultCallModel` from srv/lib/code-check-llm.js or any callable
// matching that contract:
//   ({ system, user, schema }) => Promise<{ verdict, promptTokens?, completionTokens?, modelName? }>
//
// Mirrors the shape and conventions of srv/lib/code-check-llm.js — a single
// forced tool whose `parameters` IS the verdict schema. We do not call the
// SAP AI SDK directly here; the wiring is in defaultCallModel.
//
// Plan ref: docs/superpowers/plans/2026-06-17-knowledge-graph-implementation.md (PR 3 / Task 3.1)
// Spec ref: docs/superpowers/specs/2026-06-17-knowledge-graph-design.md ("Extraction & consolidation pipeline")

/** Slug-shape regex (mirrors db/knowledge-graph.cds Concepts.slug constraint). */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$/;

/** Drop teaches with confidence below this. */
const TEACHES_MIN_CONFIDENCE = 0.6;

/** Soft bounds — outside this range we warn but don't reshape. */
const TEACHES_MIN_LEN = 3;
const TEACHES_MAX_LEN = 7;

/** Hard cap on prerequisites; excess is truncated by descending confidence. */
const PREREQS_MAX_LEN = 4;

/**
 * Forced-tool-call JSON schema describing the extraction output. The shape
 * matches the verdict the LLM must return — caller's responsibility to honour
 * the forced tool-call.
 *
 * Slug fields use the same regex enforced post-hoc in validateAndShape().
 * Confidence fields are bounded 0..1.
 */
export const KG_EXTRACT_SCHEMA = {
  type: 'object',
  properties: {
    teaches: {
      type: 'array',
      description: 'Concepts this tutorial teaches. Aim for 3-7.',
      items: {
        type: 'object',
        properties: {
          slug: {
            type: 'string',
            pattern: '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$',
            description: 'Stable kebab-case identifier. Reuse from registry when it fits.',
          },
          name: { type: 'string', description: 'Human-readable concept label.' },
          confidence: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'How core this concept is to the tutorial.',
          },
        },
        required: ['slug', 'name', 'confidence'],
      },
    },
    extends: {
      type: ['string', 'null'],
      description: "If the tutorial says \"if you've completed X\", X's slug. Null otherwise.",
    },
    prerequisites: {
      type: 'array',
      description: 'Concept-to-concept :requires edges (top 4 by confidence).',
      items: {
        type: 'object',
        properties: {
          source: {
            type: 'string',
            pattern: '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$',
          },
          target: {
            type: 'string',
            pattern: '^[a-z0-9][a-z0-9-]{0,78}[a-z0-9]$',
          },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          evidence: { type: 'string', description: 'Cited tutorial slugs or quotes.' },
        },
        required: ['source', 'target', 'confidence'],
      },
    },
  },
  required: ['teaches', 'prerequisites'],
};

const SYSTEM_PROMPT =
  'You are a concept-extraction engine. Output JSON conforming to the provided ' +
  'schema. Use existing concept slugs when they fit; only propose new ones for ' +
  'genuine gaps. Confidence reflects how core the concept is to this tutorial.';

/**
 * Build the user prompt. Format is grep-able by tests:
 *   - "Tutorial: <title>"
 *   - markdown body verbatim
 *   - "Existing concepts:" bullet list (only when registry is non-empty)
 *
 * @param {string} title
 * @param {string} body
 * @param {Array<{slug, name, description?}>} registry
 * @returns {string}
 */
function buildUserPrompt(title, body, registry) {
  const parts = [`Tutorial: ${title}`, '', 'Markdown:', body];
  if (registry && registry.length > 0) {
    parts.push('', 'Existing concepts (use these slugs when they fit):');
    for (const c of registry) {
      parts.push(`- ${c.slug}: ${c.name}`);
    }
  }
  parts.push(
    '',
    'Return: { teaches: [{slug, name, confidence}], extends: tutorialSlug | null, ' +
      'prerequisites: [{source, target, confidence, evidence}] }'
  );
  return parts.join('\n');
}

/**
 * Apply post-LLM validation: slug-shape filter, confidence filter, prerequisite
 * truncation, length warnings. Returns the cleaned shape plus warnings array.
 *
 * @param {object} verdict — raw LLM output (already JSON-parsed).
 * @returns {{ teaches, extends, prerequisites, warnings }}
 */
function validateAndShape(verdict) {
  const warnings = [];

  // --- Defensive defaults --------------------------------------------------
  const rawTeaches = Array.isArray(verdict?.teaches) ? verdict.teaches : [];
  const rawPrereqs = Array.isArray(verdict?.prerequisites) ? verdict.prerequisites : [];
  const extendsValue =
    typeof verdict?.extends === 'string' && verdict.extends.length > 0
      ? verdict.extends
      : null;

  // --- Teaches: slug-shape filter, then confidence filter ------------------
  const teachesAfterSlug = [];
  for (const t of rawTeaches) {
    if (!t || typeof t.slug !== 'string' || !SLUG_RE.test(t.slug)) {
      warnings.push(
        `Dropped teaches entry with invalid slug shape: ${JSON.stringify(t?.slug ?? null)}`
      );
      continue;
    }
    teachesAfterSlug.push(t);
  }

  const teaches = teachesAfterSlug
    .filter((t) => typeof t.confidence === 'number' && t.confidence >= TEACHES_MIN_CONFIDENCE)
    .map((t) => ({ slug: t.slug, name: t.name, confidence: t.confidence }));

  // --- Teaches length warning (we don't truncate or pad) -------------------
  if (teaches.length < TEACHES_MIN_LEN || teaches.length > TEACHES_MAX_LEN) {
    warnings.push(
      `teaches.length=${teaches.length} outside expected bounds [${TEACHES_MIN_LEN}, ${TEACHES_MAX_LEN}]`
    );
  }

  // --- Prerequisites: drop invalid slug shapes, truncate by confidence -----
  const prereqsAfterSlug = [];
  for (const p of rawPrereqs) {
    if (
      !p ||
      typeof p.source !== 'string' ||
      typeof p.target !== 'string' ||
      !SLUG_RE.test(p.source) ||
      !SLUG_RE.test(p.target)
    ) {
      warnings.push(
        `Dropped prerequisite with invalid slug shape: ${JSON.stringify({ s: p?.source, t: p?.target })}`
      );
      continue;
    }
    prereqsAfterSlug.push(p);
  }

  let prerequisites = prereqsAfterSlug.map((p) => ({
    source: p.source,
    target: p.target,
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    evidence: typeof p.evidence === 'string' ? p.evidence : '',
  }));

  if (prerequisites.length > PREREQS_MAX_LEN) {
    const before = prerequisites.length;
    prerequisites = prerequisites
      .slice() // don't mutate
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, PREREQS_MAX_LEN);
    warnings.push(
      `Truncated prerequisites from ${before} to ${PREREQS_MAX_LEN} (kept top by confidence)`
    );
  }

  return { teaches, extends: extendsValue, prerequisites, warnings };
}

/**
 * Read prompt/completion token counts off whatever shape the injected
 * callModel returned. Mirrors the convention in srv/lib/code-check-llm.js
 * (which exposes `promptTokens` / `completionTokens`) but also tolerates
 * the OpenAI-style `usage.prompt_tokens` and a pre-shaped `tokenUsage`
 * object so that callers can wrap the LLM however they want.
 *
 * @param {object} response
 * @returns {{ prompt: number, completion: number }}
 */
function extractTokenUsage(response) {
  if (!response || typeof response !== 'object') {
    return { prompt: 0, completion: 0 };
  }
  // Pre-shaped tokenUsage on the response.
  if (response.tokenUsage && typeof response.tokenUsage === 'object') {
    return {
      prompt: Number(response.tokenUsage.prompt) || 0,
      completion: Number(response.tokenUsage.completion) || 0,
    };
  }
  // Mirror code-check-llm.js shape.
  if ('promptTokens' in response || 'completionTokens' in response) {
    return {
      prompt: Number(response.promptTokens) || 0,
      completion: Number(response.completionTokens) || 0,
    };
  }
  // OpenAI-style.
  if (response.usage && typeof response.usage === 'object') {
    return {
      prompt: Number(response.usage.prompt_tokens) || 0,
      completion: Number(response.usage.completion_tokens) || 0,
    };
  }
  return { prompt: 0, completion: 0 };
}

/**
 * Extract concepts from a single tutorial via constrained LLM call.
 *
 * Validation order (after callModel returns):
 *   1. Slug-shape regex — drop invalid + push to warnings
 *   2. Confidence filter (< 0.6 drops without warning)
 *   3. Truncate prerequisites to top 4 by confidence (warn if longer)
 *   4. Boundary warnings if teaches.length is outside [3, 7]
 *
 * @param {object} args
 * @param {string} args.tutorialSlug
 * @param {string} args.tutorialTitle
 * @param {string} args.tutorialBody       — markdown body
 * @param {Array<{slug, name, description?}>} args.registry  — current ACTIVE concepts
 * @param {function} args.callModel        — injected:
 *   ({ system, user, schema }) => Promise<{ verdict, promptTokens?, completionTokens?, modelName? }>
 * @returns {Promise<{
 *   teaches: Array<{slug, name, confidence}>,
 *   extends: string | null,
 *   prerequisites: Array<{source, target, confidence, evidence}>,
 *   tokenUsage: { prompt: number, completion: number },
 *   warnings: string[]
 * }>}
 */
export async function extractConceptsFromTutorial({
  tutorialSlug,
  tutorialTitle,
  tutorialBody,
  registry,
  callModel,
}) {
  if (typeof callModel !== 'function') {
    throw new Error('extractConceptsFromTutorial: `callModel` is required and must be a function');
  }

  const system = SYSTEM_PROMPT;
  const user = buildUserPrompt(tutorialTitle ?? '', tutorialBody ?? '', registry ?? []);

  const response = await callModel({ system, user, schema: KG_EXTRACT_SCHEMA });

  // The verdict shape mirrors code-check-llm: response.verdict holds the
  // tool-call arguments JSON. Tolerate flat shapes (callers that pre-extract).
  const verdict =
    response && typeof response === 'object' && 'verdict' in response
      ? response.verdict
      : response;

  const shaped = validateAndShape(verdict);
  const tokenUsage = extractTokenUsage(response);

  return {
    teaches: shaped.teaches,
    extends: shaped.extends,
    prerequisites: shaped.prerequisites,
    tokenUsage,
    warnings: shaped.warnings,
  };
}
