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
//   2. Embed the query via injected embedClient.
//   3. Top-N cosine over Concepts.embedding (via concept-embedding-query.js helper).
//   4. 1-hop walk along ConceptEdges (requires | relatedTo), boosting neighbours
//      with WALK_BOOST * seedScore * edgeConfidence.
//   5. Hydrate neighbour metadata (respects publish gate — non-ACTIVE dropped).
//   6. Join TutorialConceptLinks (predicate='teaches'), aggregate per tutorial as
//      SUM(conceptScore * linkConfidence).
//   7. Rationale = names of top 2 contributing concepts joined with " and ".
//   8. Empty KG → { queryEcho, concepts: [], tutorials: [] } (not an error).

import { topConceptsByCosine } from './concept-embedding-query.js'

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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(value, min, max, defaultValue) {
  const n = Math.floor(Number(value))
  if (!Number.isFinite(n)) return defaultValue
  return Math.max(min, Math.min(max, n))
}

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana'
}

async function fetchEdges(db, sourceIds) {
  if (sourceIds.length === 0) return []
  const placeholders = sourceIds.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT SOURCE_ID as source_id, TARGET_ID as target_id, PREDICATE as predicate, CONFIDENCE as confidence
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTEDGES
       WHERE PREDICATE IN ('requires','relatedTo') AND SOURCE_ID IN (${placeholders})`,
      sourceIds
    ) || []
  }
  return await db.run(
    `SELECT source_ID as source_id, target_ID as target_id, predicate, confidence
     FROM com_sap_developers_ims_ConceptEdges
     WHERE predicate IN ('requires','relatedTo') AND source_ID IN (${placeholders})`,
    sourceIds
  ) || []
}

async function fetchConceptsByIds(db, ids) {
  if (ids.length === 0) return []
  const placeholders = ids.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT ID as id, SLUG as slug, NAME as name
       FROM COM_SAP_DEVELOPERS_IMS_CONCEPTS
       WHERE ID IN (${placeholders})
         AND STATUS = 'ACTIVE' AND PUBLISHEDAT IS NOT NULL AND MERGEDINTO_ID IS NULL`,
      ids
    ) || []
  }
  return await db.run(
    `SELECT ID as id, slug, name FROM com_sap_developers_ims_Concepts
     WHERE ID IN (${placeholders})
       AND status = 'ACTIVE' AND publishedAt IS NOT NULL AND mergedInto_ID IS NULL`,
    ids
  ) || []
}

async function fetchLinks(db, conceptIds) {
  if (conceptIds.length === 0) return []
  const placeholders = conceptIds.map(() => '?').join(',')
  if (isHana(db)) {
    return await db.run(
      `SELECT l.CONCEPT_ID as concept_id, l.TUTORIAL_ID as tutorial_id, l.CONFIDENCE as confidence,
              t.SLUG as tutorial_slug, t.TITLE as title
       FROM COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS l
       JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALS t ON t.ID = l.TUTORIAL_ID
       WHERE l.PREDICATE = 'teaches' AND l.CONCEPT_ID IN (${placeholders})`,
      conceptIds
    ) || []
  }
  return await db.run(
    `SELECT l.concept_ID as concept_id, l.tutorial_ID as tutorial_id, l.confidence,
            t.slug as tutorial_slug, t.title
     FROM com_sap_developers_ims_TutorialConceptLinks l
     JOIN com_sap_developers_ims_Tutorials t ON t.ID = l.tutorial_ID
     WHERE l.predicate = 'teaches' AND l.concept_ID IN (${placeholders})`,
    conceptIds
  ) || []
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {object}   opts.db          - CDS db handle
 * @param {object}   opts.embedClient - { embed(text) => Promise<Float32Array> }
 * @param {object}   opts.args        - { query, maxConcepts?, maxTutorials? } from the LLM
 * @param {object=}  opts.telemetry   - { emit(event, payload) } optional
 * @returns {Promise<object>} JSON response for the LLM
 */
export async function expandSearchConceptsHandler({ db, embedClient, args, telemetry }) {
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

  let queryVector
  try {
    queryVector = await embedClient.embed(rawQuery)
  } catch (err) {
    telemetry?.emit?.('kg.joule.search_expansion_returned', {
      error: 'embed_failed', latencyMs: Date.now() - t0,
    })
    return { queryEcho: rawQuery, concepts: [], tutorials: [], warning: 'embed_failed' }
  }

  const seeds = await topConceptsByCosine({ db, queryVector, limit: maxConcepts })
  if (seeds.length === 0) {
    telemetry?.emit?.('kg.joule.search_expansion_returned', {
      resultCount: 0, latencyMs: Date.now() - t0,
    })
    return { queryEcho: rawQuery, concepts: [], tutorials: [] }
  }

  const seedById = new Map(seeds.map(s => [s.id, s]))
  const edges = await fetchEdges(db, seeds.map(s => s.id))
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
}
