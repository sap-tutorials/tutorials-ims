// srv/lib/kg/joule-tool-expand-concepts.js
//
// Joule chat tool: expandSearchConcepts (Issue #943, Part 3).
//
// Descriptor uses the OpenAI function-calling shape (bare `parameters`),
// NOT the Anthropic `input_schema` shape — the chat orchestrator's LLM
// adapter expects the former. See feedback_llm_adapter_schema_shape (PR #885).
//
// Handler algorithm:
//   1. Validate args (query non-empty, <= 200 chars; clamp maxConcepts/maxTutorials).
//   2. Embed the query via injected embedClient (with 5s AbortController).
//   3. Top-N cosine over Concepts.embedding (via concept-embedding-query.js helper).
//   4. 1-hop walk along ConceptEdges (requires | relatedTo), boosting neighbours
//      with WALK_BOOST * seedScore * edgeConfidence.
//   5. Hydrate neighbour metadata (respects publish gate — non-ACTIVE dropped).
//   6. Join TutorialConceptLinks (predicate='teaches'), aggregate per tutorial as
//      SUM(conceptScore * linkConfidence).
//   7. Rationale = names of top 2 contributing concepts joined with " and ".
//   8. Empty KG → { queryEcho, concepts: [], tutorials: [] } (not an error).
//   9. Wall-clock check between each DB round-trip; on timeout return
//      { warning: 'timeout', concepts: [], tutorials: [] } per spec §3.

import { topConceptsByCosine } from './concept-embedding-query.js'
import { fetchEdges, fetchConceptsByIds, fetchLinks } from './_search-fetches.js'
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
const WALK_BOOST = 0.5
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
 * @param {object}   opts.db           - CDS db handle
 * @param {object}   opts.embedClient  - { embed(text, opts?) => Promise<Float32Array> }
 * @param {object}   opts.args         - { query, maxConcepts?, maxTutorials? } from the LLM
 * @param {object=}  opts.telemetry    - { emit(event, payload) } optional
 * @param {number=}  opts.timeoutMs    - wall-clock cap (default 5000). Passes an AbortSignal
 *                                       to embedClient.embed if the client accepts one; also
 *                                       short-circuits before edge/link fetches once exceeded.
 * @returns {Promise<object>} JSON response for the LLM
 */
export async function expandSearchConceptsHandler({ db, embedClient, args, telemetry, timeoutMs = DEFAULT_TIMEOUT_MS, requester }) {
  const rawQuery = typeof args?.query === 'string' ? args.query.trim() : ''
  if (!rawQuery) return { error: 'query is empty', concepts: [], tutorials: [] }
  if (rawQuery.length > HARD_QUERY_LIMIT) {
    return { error: `query exceeds ${HARD_QUERY_LIMIT} chars`, concepts: [], tutorials: [] }
  }
  const maxConcepts = clampInt(args?.maxConcepts, 1, 10, DEFAULT_MAX_CONCEPTS)
  const maxTutorials = clampInt(args?.maxTutorials, 1, 20, DEFAULT_MAX_TUTORIALS)

  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('expandSearchConcepts timeout')), timeoutMs)
  const timedOut = () => Date.now() >= deadline
  const emitTimeout = () => {
    telemetry?.emit?.('kg.joule.search_expansion_returned', {
      warning: 'timeout', latencyMs: Date.now() - t0,
    })
    return { queryEcho: rawQuery, concepts: [], tutorials: [], warning: 'timeout' }
  }

  telemetry?.emit?.('kg.joule.search_expansion_requested', {
    queryLength: rawQuery.length, maxConcepts, maxTutorials,
  })

  try {
    // Embed with AbortSignal — client may or may not honour it; the wall-clock check
    // below is the backstop.
    let queryVector
    try {
      queryVector = await embedClient.embed(rawQuery, { signal: abort.signal })
    } catch (err) {
      if (abort.signal.aborted) return emitTimeout()
      telemetry?.emit?.('kg.joule.search_expansion_returned', {
        error: 'embed_failed', latencyMs: Date.now() - t0,
      })
      return { queryEcho: rawQuery, concepts: [], tutorials: [], warning: 'embed_failed' }
    }
    if (timedOut()) return emitTimeout()

    const seeds = await topConceptsByCosine({ db, queryVector, limit: maxConcepts })
    if (timedOut()) return emitTimeout()
    if (seeds.length === 0) {
      telemetry?.emit?.('kg.joule.search_expansion_returned', {
        resultCount: 0, latencyMs: Date.now() - t0,
      })
      // #948: fire-and-forget enqueue on zero-seed. Never awaited. Never
      // throws to the caller. If the flag is off, the module bails
      // internally and returns { status: 'disabled' }.
      const requesterOrDefault = requester ?? { kind: 'anon' }
      enqueueOnDemandExtraction({ db, query: rawQuery, requester: requesterOrDefault })
        .catch(err => LOG.warn?.('enqueueOnDemandExtraction dispatch failed:', err.message))
      return { queryEcho: rawQuery, concepts: [], tutorials: [] }
    }

    const seedById = new Map(seeds.map(s => [s.id, s]))
    const edges = await fetchEdges(db, seeds.map(s => s.id))
    if (timedOut()) return emitTimeout()
    const boosted = new Map(seeds.map(s => [s.id, { ...s }]))
    const neighbourIds = new Set()
    for (const e of edges) {
      if (boosted.has(e.target_id) && seedById.has(e.target_id)) continue
      const src = seedById.get(e.source_id)
      if (!src) continue
      const boost = WALK_BOOST * src.score * (Number(e.confidence) || 0)
      neighbourIds.add(e.target_id)
      const existing = boosted.get(e.target_id)
      if (existing) {
        existing.score = Math.max(existing.score, boost)
      } else {
        boosted.set(e.target_id, { id: e.target_id, score: boost })
      }
    }

    // Hydrate neighbour metadata (respects publish gate — filters out non-ACTIVE).
    if (neighbourIds.size > 0) {
      const hydrated = await fetchConceptsByIds(db, [...neighbourIds])
      if (timedOut()) return emitTimeout()
      const hydratedMap = new Map(hydrated.map(h => [h.id, h]))
      for (const id of neighbourIds) {
        const meta = hydratedMap.get(id)
        const entry = boosted.get(id)
        if (!meta) { boosted.delete(id); continue }
        entry.slug = meta.slug
        entry.name = meta.name
      }
    }

    const allConcepts = [...boosted.values()]
      .filter(c => c.slug && c.name)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxConcepts)

    if (allConcepts.length === 0) {
      telemetry?.emit?.('kg.joule.search_expansion_returned', {
        resultCount: 0, latencyMs: Date.now() - t0,
      })
      return { queryEcho: rawQuery, concepts: [], tutorials: [] }
    }

    const links = await fetchLinks(db, allConcepts.map(c => c.id))
    if (timedOut()) return emitTimeout()
    const conceptScoreById = new Map(allConcepts.map(c => [c.id, c.score]))
    const conceptNameById  = new Map(allConcepts.map(c => [c.id, c.name]))

    // Aggregate per tutorial.
    const perTutorial = new Map()
    for (const l of links) {
      const cs = conceptScoreById.get(l.concept_id) ?? 0
      const contribution = cs * (Number(l.confidence) || 0)
      let bucket = perTutorial.get(l.tutorial_id)
      if (!bucket) {
        bucket = { slug: l.tutorial_slug, title: l.title, score: 0, contribs: [] }
        perTutorial.set(l.tutorial_id, bucket)
      }
      bucket.score += contribution
      bucket.contribs.push({ conceptId: l.concept_id, contribution })
    }

    const tutorials = [...perTutorial.values()]
      .map(b => {
        const topTwo = b.contribs
          .sort((x, y) => y.contribution - x.contribution)
          .slice(0, 2)
          .map(c => conceptNameById.get(c.conceptId))
          .filter(Boolean)
        const rationale = topTwo.length === 0
          ? ''
          : topTwo.length === 1
            ? `Teaches ${topTwo[0]}`
            : `Teaches ${topTwo[0]} and ${topTwo[1]}`
        return { slug: b.slug, title: b.title, rationale, score: b.score }
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTutorials)

    telemetry?.emit?.('kg.joule.search_expansion_returned', {
      conceptCount: allConcepts.length,
      tutorialCount: tutorials.length,
      latencyMs: Date.now() - t0,
    })

    return {
      queryEcho: rawQuery,
      concepts: allConcepts.map(c => ({ slug: c.slug, name: c.name, score: Number(c.score.toFixed(4)) })),
      tutorials: tutorials.map(t => ({ ...t, score: Number(t.score.toFixed(4)) })),
    }
  } finally {
    clearTimeout(timer)
  }
}
