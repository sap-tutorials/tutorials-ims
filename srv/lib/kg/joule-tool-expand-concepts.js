// srv/lib/kg/joule-tool-expand-concepts.js
//
// Joule chat tool: expandSearchConcepts (Issue #943, Part 3).
//
// Descriptor uses the OpenAI function-calling shape (bare `parameters`),
// NOT the Anthropic `input_schema` shape — the chat orchestrator's LLM
// adapter expects the former. See feedback_llm_adapter_schema_shape (PR #885).
//
// #1111: this handler now delegates to computeKgSignal() (search-kg-signal.js)
// instead of running its own embed → cosine → walk → link fetch sequence.
// That collapses the "expandSearchConcepts + searchTutorials" turn from two
// cold KG scans (~20 s each on prod's ~6k Concepts table) down to one:
// whichever tool fires first warms the shared 5-min LRU + single-flight
// promise map, and the second call resolves against the cached signal.
// signal.warning of 'timeout' | 'embed_failed' | 'db_error' | 'kg_empty' |
// 'disabled' is surfaced back as { warning } in the tool response, preserving
// the original error contract.

import { computeKgSignal } from '../search-kg-signal.js'
import { enqueueOnDemandExtraction } from './on-demand-enqueue.js'
import cds from '@sap/cds'

const LOG = cds.log('joule-tool-expand-concepts')

// ---------------------------------------------------------------------------
// LLM-facing tool descriptor
// ---------------------------------------------------------------------------

export const EXPAND_SEARCH_CONCEPTS_TOOL = {
  type: 'function',
  function: {
    name: 'expandSearchConcepts',
    description: [
      'Given a free-text search query, return related knowledge-graph concepts',
      'plus the most relevant tutorials with short rationales.',
      '',
      'Use FIRST when the user asks to find or search for tutorials on a topic;',
      'then call searchTutorials for keyword matches to complement it.',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        query:        { type: 'string',  description: 'Free-text search query. 1-200 chars.' },
        maxConcepts:  { type: 'integer', description: 'Cap on returned concepts. 1-10, default 5.' },
        maxTutorials: { type: 'integer', description: 'Cap on returned tutorials. 1-20, default 8.' },
      },
      required: ['query'],
    },
  },
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_CONCEPTS = 5
const DEFAULT_MAX_TUTORIALS = 8
const HARD_QUERY_LIMIT = 200
const DEFAULT_TIMEOUT_MS = 5000  // Spec §3 error-handling table: >5s → { warning: 'timeout' }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(value, min, max, defaultValue) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return defaultValue
  return Math.max(min, Math.min(max, n))
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object}   opts.db              - CDS db handle
 * @param {object=}  opts.embedClient     - { embed(text, opts?) => Promise<Float32Array> }
 *                                          Passed through to computeKgSignal so tests can
 *                                          inject a stub without touching AI Core. When absent,
 *                                          computeKgSignal falls back to embedding-client.js.
 * @param {string=}  opts.embeddingModel  - resolved upstream via resolveEmbeddingSettings.
 * @param {object}   opts.args            - { query, maxConcepts?, maxTutorials? } from the LLM
 * @param {object=}  opts.telemetry       - { emit(event, payload) } optional
 * @param {number=}  opts.timeoutMs       - wall-clock cap forwarded to computeKgSignal.
 * @param {object=}  opts.requester       - { id?, kind } for #948 enqueue attribution.
 * @returns {Promise<object>} JSON response for the LLM
 */
export async function expandSearchConceptsHandler({
  db, embedClient, embeddingModel, args, telemetry,
  timeoutMs = DEFAULT_TIMEOUT_MS, requester,
}) {
  const rawQuery = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!rawQuery) return { error: 'query is empty', concepts: [], tutorials: [] }
  if (rawQuery.length > HARD_QUERY_LIMIT) {
    return { error: `query exceeds ${HARD_QUERY_LIMIT} chars`, concepts: [], tutorials: [] }
  }
  const maxConcepts = clampInt(args?.maxConcepts, 1, 10, DEFAULT_MAX_CONCEPTS)
  const maxTutorials = clampInt(args?.maxTutorials, 1, 20, DEFAULT_MAX_TUTORIALS)

  const t0 = Date.now()

  telemetry?.emit?.('kg.joule.search_expansion_requested', {
    queryLength: rawQuery.length, maxConcepts, maxTutorials,
  })

  // Shared cache + single-flight lives in search-kg-signal.js. A cold call
  // pays the full ~20 s scan; a hot call in the same Joule turn (or from
  // the OData $search path that already fired on the navigator page) resolves
  // synchronously off the LRU.
  const signal = await computeKgSignal({
    phrase: rawQuery,
    db,
    embedClient,
    embeddingModel,
    enabled: true,
    timeoutMs,
  })

  // Preserve the pre-#1111 warning contract by mapping signal.warning back
  // into the tool response envelope.
  if (signal.warning === 'timeout') {
    telemetry?.emit?.('kg.joule.search_expansion_returned', {
      warning: 'timeout', latencyMs: Date.now() - t0,
    })
    return { queryEcho: rawQuery, concepts: [], tutorials: [], warning: 'timeout' }
  }
  if (signal.warning === 'embed_failed') {
    telemetry?.emit?.('kg.joule.search_expansion_returned', {
      error: 'embed_failed', latencyMs: Date.now() - t0,
    })
    return { queryEcho: rawQuery, concepts: [], tutorials: [], warning: 'embed_failed' }
  }
  if (signal.warning === 'kg_empty' || signal.warning === 'db_error' || signal.topConcepts.length === 0) {
    telemetry?.emit?.('kg.joule.search_expansion_returned', {
      resultCount: 0, latencyMs: Date.now() - t0,
      ...(signal.warning ? { warning: signal.warning } : {}),
    })
    // #948: fire-and-forget enqueue on true zero-seed (kg_empty), NOT on
    // transient db_error — those deserve retry, not extraction storms.
    if (signal.warning === 'kg_empty') {
      const requesterOrDefault = requester ?? { kind: 'anon' }
      enqueueOnDemandExtraction({ db, query: rawQuery, requester: requesterOrDefault })
        .catch(err => LOG.warn?.('enqueueOnDemandExtraction dispatch failed:', err.message))
    }
    return { queryEcho: rawQuery, concepts: [], tutorials: [] }
  }

  const concepts = signal.topConcepts
    .slice(0, maxConcepts)
    .map(c => ({ slug: c.slug, name: c.name, score: c.score }))

  const tutorials = [...signal.slugScores.entries()]
    .map(([slug, score]) => ({
      slug,
      title: signal.slugTitle?.get?.(slug) ?? '',
      rationale: signal.slugRationale?.get?.(slug) ?? '',
      score,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, maxTutorials)

  telemetry?.emit?.('kg.joule.search_expansion_returned', {
    conceptCount: concepts.length,
    tutorialCount: tutorials.length,
    latencyMs: Date.now() - t0,
    signalAgeMs: Math.max(0, Date.now() - (signal.computedAt || Date.now())),
  })

  return { queryEcho: rawQuery, concepts, tutorials }
}
