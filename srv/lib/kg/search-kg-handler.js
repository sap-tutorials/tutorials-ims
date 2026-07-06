// srv/lib/kg/search-kg-handler.js
//
// Anonymous-safe KG search for the ⌘K command palette (issue #1036).
//
// Same seed / walk / hydrate / link-aggregate algorithm as
// srv/lib/kg/joule-tool-expand-concepts.js MINUS:
//   • the enqueue-on-zero-seed behavior
//   • the queryEcho / rationale / warning fields the Joule LLM needs
//
// This file MUST NOT import queuing modules. A palette keystroke never
// spams background drains. A static regex test in
// test/kg-search-kg-handler.test.js fails if prohibited imports are added.

import cds from '@sap/cds'
import { topConceptsByCosine } from './concept-embedding-query.js'
import { fetchEdges, fetchConceptsByIds, fetchLinks } from './_search-fetches.js'

const LOG = cds.log('search-kg-handler')

const DEFAULT_MAX_CONCEPTS = 5
const DEFAULT_MAX_TUTORIALS = 5
const HARD_QUERY_LIMIT = 200
const WALK_BOOST = 0.5
const DEFAULT_TIMEOUT_MS = 3000  // palette keystrokes — users abandon fast

function clampInt(value, min, max, defaultValue) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return defaultValue
  return Math.max(min, Math.min(max, n))
}

/**
 * @param {object} opts
 * @param {object}   opts.db           - CDS db handle
 * @param {object}   opts.embedClient  - { embed(text, opts?) => Promise<Float32Array> }
 * @param {object}   opts.args         - { term, maxConcepts?, maxTutorials? }
 * @param {object=}  opts.telemetry    - { emit(event, payload) } optional
 * @param {number=}  opts.timeoutMs    - default 3000
 * @returns {Promise<{concepts: Array, tutorials: Array}>} Fail-open — always resolves.
 */
export async function searchKgHandler({ db, embedClient, args, telemetry, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const rawQuery = typeof args?.term === 'string' ? args.term.trim() : ''
  if (!rawQuery) return { concepts: [], tutorials: [] }
  if (rawQuery.length > HARD_QUERY_LIMIT) return { concepts: [], tutorials: [] }

  const maxConcepts = clampInt(args?.maxConcepts, 1, 10, DEFAULT_MAX_CONCEPTS)
  const maxTutorials = clampInt(args?.maxTutorials, 1, 20, DEFAULT_MAX_TUTORIALS)

  const t0 = Date.now()
  const deadline = t0 + timeoutMs
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(new Error('searchKG timeout')), timeoutMs)
  const timedOut = () => Date.now() >= deadline

  try {
    let queryVector
    try {
      queryVector = await embedClient.embed(rawQuery, { signal: abort.signal })
    } catch (err) {
      LOG.warn?.('embed failed:', err.message)
      return { concepts: [], tutorials: [] }
    }
    if (timedOut()) return { concepts: [], tutorials: [] }

    const seeds = await topConceptsByCosine({ db, queryVector, limit: maxConcepts })
    if (timedOut()) return { concepts: [], tutorials: [] }
    if (seeds.length === 0) return { concepts: [], tutorials: [] }

    const seedById = new Map(seeds.map(s => [s.id, s]))
    const edges = await fetchEdges(db, seeds.map(s => s.id))
    if (timedOut()) return { concepts: [], tutorials: [] }

    const boosted = new Map(seeds.map(s => [s.id, { ...s }]))
    const neighbourIds = new Set()
    for (const e of edges) {
      if (boosted.has(e.target_id) && seedById.has(e.target_id)) continue
      const src = seedById.get(e.source_id)
      if (!src) continue
      const boost = WALK_BOOST * src.score * (Number(e.confidence) || 0)
      neighbourIds.add(e.target_id)
      const existing = boosted.get(e.target_id)
      if (existing) existing.score = Math.max(existing.score, boost)
      else boosted.set(e.target_id, { id: e.target_id, score: boost })
    }

    if (neighbourIds.size > 0) {
      const hydrated = await fetchConceptsByIds(db, [...neighbourIds])
      if (timedOut()) return { concepts: [], tutorials: [] }
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

    if (allConcepts.length === 0) return { concepts: [], tutorials: [] }

    const links = await fetchLinks(db, allConcepts.map(c => c.id))
    if (timedOut()) return { concepts: [], tutorials: [] }
    const conceptScoreById = new Map(allConcepts.map(c => [c.id, c.score]))

    const perTutorial = new Map()
    for (const l of links) {
      const cs = conceptScoreById.get(l.concept_id) ?? 0
      const contribution = cs * (Number(l.confidence) || 0)
      let bucket = perTutorial.get(l.tutorial_id)
      if (!bucket) {
        bucket = { slug: l.tutorial_slug, title: l.title, score: 0 }
        perTutorial.set(l.tutorial_id, bucket)
      }
      bucket.score += contribution
    }

    const tutorials = [...perTutorial.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, maxTutorials)

    telemetry?.emit?.('kg.palette.search_returned', {
      conceptCount: allConcepts.length,
      tutorialCount: tutorials.length,
      latencyMs: Date.now() - t0,
    })

    return {
      concepts: allConcepts.map(c => ({ slug: c.slug, name: c.name, score: Number(c.score.toFixed(4)) })),
      tutorials: tutorials.map(t => ({ slug: t.slug, title: t.title, score: Number(t.score.toFixed(4)) })),
    }
  } catch (err) {
    LOG.warn?.('searchKgHandler failed open:', err.message)
    return { concepts: [], tutorials: [] }
  } finally {
    clearTimeout(timer)
  }
}
