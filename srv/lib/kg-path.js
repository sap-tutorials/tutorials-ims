// srv/lib/kg-path.js
//
// Shared path-finding helper. Consumed by:
// - srv/lib/kg/joule-tool-find-path.js (Phase 2 Joule chat tool — renders
//   the result as markdown with title/time hydration + telemetry).
// - srv/lib/graph-path-route.js (Phase 3 Track 3-B public HTTP endpoint
//   GET /graph/path — returns JSON for the /explore/ overlay).
//
// The SPARQL execution + JSON parse lives here. Consumers wrap the result
// in their preferred shape; this module stays small and pure.
//
// Issue #446, Phase 3 Track 3-B PR 5/6.
// #1129: parse fixed from XML → SPARQL-results+JSON (proc emits JSON).

import { kgQuery } from './kg-sparql-client.js'

// Single-source-of-truth tutorial IRI prefix. The PATH_BETWEEN procedure
// validates p1/p2 as full tutorial IRIs (see srv/lib/kg-queries.js).
// Kept in lockstep with joule-tool-find-path.js's local constant — the
// projection's authoritative copy lives in srv/lib/kg-projection.js
// (KG_IRI_PREFIXES.tutorial) but we don't import it here to keep this
// module free of projection-side dependencies (the projection imports
// the SPARQL client; we want a single direction of imports).
const TUTORIAL_IRI_PREFIX = 'https://developers.sap.com/kg/tutorial/'

/**
 * Run the PATH_BETWEEN SPARQL query and return ordered path-step candidates.
 *
 * Slugs are converted to tutorial IRIs the same way the Joule tool does
 * (lockstep with srv/lib/kg/joule-tool-find-path.js TUTORIAL_IRI_PREFIX).
 * The KG procedure validates p1/p2 against its own LIKE_REGEXPR allow-list.
 *
 * @param {object} opts
 * @param {object} opts.db        - CDS db service handle
 * @param {string} opts.fromSlug  - source tutorial slug (canonical lowercase)
 * @param {string} opts.toSlug    - target tutorial slug (canonical lowercase)
 * @returns {Promise<Array<{slug:string, pathType:string, pathTypeRank:number, hopCount:number}>>}
 */
export async function findPath({ db, fromSlug, toSlug }) {
  const fromIri = `${TUTORIAL_IRI_PREFIX}${fromSlug}`
  const toIri = `${TUTORIAL_IRI_PREFIX}${toSlug}`
  const result = await kgQuery({
    db,
    queryName: 'PATH_BETWEEN',
    params: { fromSlug: fromIri, toSlug: toIri },
  })
  return parsePathSparql(result?.response ?? '')
}

/**
 * Parse the SPARQL-results+JSON response from PATH_BETWEEN into a structured
 * array.
 *
 * KG_QUERY.hdbprocedure calls SYS_SPARQL_EXECUTE with
 * `Accept: application/sparql-results+json`, so the response is JSON — NOT
 * XML — for every query type. Binding shape (verified against DEV HANA
 * 2026-07-09):
 *   {
 *     "head": { "vars": ["b","pathType","pathTypeRank","hopCount"] },
 *     "results": { "bindings": [
 *       { "b":            { "type":"uri",     "value":"https://developers.sap.com/kg/tutorial/<slug>" },
 *         "pathType":     { "type":"literal", "value":"PREREQ|CO_COMPLETED|SHARED_CONCEPT" },
 *         "pathTypeRank": { "type":"literal", "datatype":"...#int", "value":"1|2|3" },
 *         "hopCount":     { "type":"literal", "datatype":"...#int", "value":"N" } },
 *       ...
 *     ] }
 *   }
 *
 * HISTORY (#1129): this parser previously used an XML `<result>` regex, which
 * matched the (never-live) XML shape our unit-test fixtures fed it but NOT the
 * JSON the proc actually emits. Result: it silently returned [] in production,
 * so every /graph/path and Joule find-learning-path call 404'd "No path found"
 * despite a fully-populated 83k-triple graph. Same class of bug fixed for
 * EXPLORE_GRAPH_BULK on 2026-06-28 (see srv/lib/kg-explore-data.js
 * parseExploreBindings); this brings PATH_BETWEEN in line.
 *
 * Fails soft on any non-JSON body (e.g. an XML regression) — returns [] rather
 * than throwing, mirroring parseExploreBindings. Rows missing `b`, `pathType`,
 * or `pathTypeRank` are dropped; `hopCount` defaults to 0 when absent.
 *
 * @param {string} json - SPARQL JSON response body (the `.response` field
 *                        of a kgQuery() return value)
 * @returns {Array<{slug:string, pathType:string, pathTypeRank:number, hopCount:number}>}
 */
export function parsePathSparql(json) {
  if (!json || typeof json !== 'string') return []

  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    // Non-JSON (e.g. legacy XML if the proc's Accept header ever regresses).
    // Fail soft — never throw. The empty result surfaces as an upstream 404.
    return []
  }

  const bindings =
    parsed && parsed.results && Array.isArray(parsed.results.bindings)
      ? parsed.results.bindings
      : []

  const steps = []
  for (const b of bindings) {
    const tutorialIri = b?.b?.value
    const pathType = b?.pathType?.value
    const rankRaw = b?.pathTypeRank?.value

    // Required trio — drop the row if any is absent (matches the prior
    // Joule parser semantics at srv/lib/kg/joule-tool-find-path.js).
    if (tutorialIri == null || pathType == null || rankRaw == null) continue

    const pathTypeRank = parseInt(rankRaw, 10)
    const hopCount = b?.hopCount?.value != null ? parseInt(b.hopCount.value, 10) : 0

    // Convert tutorial IRI to bare slug; preserve unknown IRIs as-is so a
    // stale projection row surfaces in logs rather than crashing the parse.
    const slug = tutorialIri.startsWith(TUTORIAL_IRI_PREFIX)
      ? tutorialIri.slice(TUTORIAL_IRI_PREFIX.length)
      : tutorialIri

    steps.push({ slug, pathType, pathTypeRank, hopCount })
  }
  return steps
}
