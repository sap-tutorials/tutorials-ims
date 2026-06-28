// srv/lib/kg-path.js
//
// Shared path-finding helper. Consumed by:
// - srv/lib/kg/joule-tool-find-path.js (Phase 2 Joule chat tool — renders
//   the result as markdown with title/time hydration + telemetry).
// - srv/lib/graph-path-route.js (Phase 3 Track 3-B public HTTP endpoint
//   GET /graph/path — returns JSON for the /explore/ overlay).
//
// The SPARQL execution + XML parse lives here. Consumers wrap the result
// in their preferred shape; this module stays small and pure.
//
// Issue #446, Phase 3 Track 3-B PR 5/6.

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
 * Parse the SPARQL XML response from PATH_BETWEEN into a structured array.
 *
 * Binding shape (verified against the Joule tool's existing parser):
 *   <result>
 *     <binding name="b"><uri>https://developers.sap.com/kg/tutorial/&lt;slug&gt;</uri></binding>
 *     <binding name="pathType"><literal>PREREQ|CO_COMPLETED|SHARED_CONCEPT</literal></binding>
 *     <binding name="pathTypeRank"><literal datatype="...integer">1|2|3</literal></binding>
 *     <binding name="hopCount"><literal datatype="...integer">N</literal></binding>
 *   </result>
 *
 * Rows missing `b`, `pathType`, or `pathTypeRank` are dropped silently
 * (same behaviour as the original Joule parser at
 * srv/lib/kg/joule-tool-find-path.js:198). `hopCount` defaults to 0
 * when absent.
 *
 * The literal-element regex tolerates an optional `datatype="..."` attribute
 * because the SPARQL XML serializer emits typed literals for the integer
 * bindings — the original Joule parser matched the same shape.
 *
 * @param {string} xml - SPARQL XML response body (the `.response` field
 *                       of a kgQuery() return value)
 * @returns {Array<{slug:string, pathType:string, pathTypeRank:number, hopCount:number}>}
 */
export function parsePathSparql(xml) {
  if (!xml || typeof xml !== 'string') return []
  const steps = []
  for (const m of xml.matchAll(/<result>([\s\S]*?)<\/result>/g)) {
    const block = m[1]
    const bMatch = block.match(/<binding name="b">\s*<uri>([^<]+)<\/uri>/)
    const ptMatch = block.match(/<binding name="pathType">\s*<literal[^>]*>([^<]+)</)
    const rankMatch = block.match(/<binding name="pathTypeRank">\s*<literal[^>]*>([^<]+)</)
    const hopMatch = block.match(/<binding name="hopCount">\s*<literal[^>]*>([^<]+)</)

    if (!bMatch || !ptMatch || !rankMatch) continue

    const tutorialIri = bMatch[1].trim()
    const pathType = ptMatch[1].trim()
    const pathTypeRank = parseInt(rankMatch[1].trim(), 10)
    const hopCount = hopMatch ? parseInt(hopMatch[1].trim(), 10) : 0

    // Convert tutorial IRI to bare slug; preserve unknown IRIs as-is so a
    // stale projection row surfaces in logs rather than crashing the parse.
    const slug = tutorialIri.startsWith(TUTORIAL_IRI_PREFIX)
      ? tutorialIri.slice(TUTORIAL_IRI_PREFIX.length)
      : tutorialIri

    steps.push({ slug, pathType, pathTypeRank, hopCount })
  }
  return steps
}
