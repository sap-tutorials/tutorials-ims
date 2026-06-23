// srv/lib/kg/concepts-for-user.js
//
// Joule-side helper for Issue #445 Phase 2 conceptsForUser. Returns the
// concepts the user has fully learned (from COMPLETED tutorials) and
// partially learned (from IN_PROGRESS tutorials), expressed as concept
// slugs (the trailing path segment of the concept IRI).
//
// Why not in KG_QUERY procedure: the graph does not carry user→tutorial
// edges (Phase 4 architectural decision; userIds stay out of the graph
// for privacy). KG_QUERY is fixed-arity (5 IN params); a variable-length
// list of tutorial IRIs cannot fit. We route through KG_ADMIN_RUNSPARQL
// instead — it accepts arbitrary JS-built SPARQL.
//
// Privacy: no user IDs reach HANA KGE. Only opaque tutorial IRIs are
// in the SPARQL body. TaskRecords queries inherit CAP audit logging.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md

import cds from '@sap/cds'
import { kgAdminRunSparql } from '../kg-sparql-client.js'

const LOG = cds.log('concepts-for-user')

// UUID v4 shape OR a CAP-style SAP-ID (alphanumeric, 1-64 chars, plus hyphens/underscores).
const USER_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{1,64})$/

const TUTORIAL_IRI_PREFIX = 'https://developers.sap.com/kg/tutorial/'
const CONCEPT_IRI_PREFIX = 'https://developers.sap.com/kg/concept/'
const MAX_TASK_RECORDS = 500

/**
 * @param {object} args
 * @param {object} args.db - CDS db handle from cds.connect.to('db')
 * @param {string} args.userId - UUID or SAP-ID of the user
 * @returns {Promise<{ learned: string[], partial: string[], truncatedAt500: boolean }>}
 * @throws TypeError if userId is empty or malformed
 */
export async function getConceptsForUser({ db, userId }) {
  if (typeof userId !== 'string' || !userId.trim() || !USER_ID_RE.test(userId)) {
    throw new TypeError(`Invalid userId: ${JSON.stringify(userId)}`)
  }
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('db must be a CDS service with a .run() method')
  }

  // Step 1: read TaskRecords. Cap at MAX_TASK_RECORDS+1 to detect truncation.
  const taskRecords = await db.run(
    `SELECT TUTORIAL_ID, STATUS FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS
     WHERE USER_ID = ? AND STATUS IN ('COMPLETED', 'IN_PROGRESS')
     ORDER BY COMPLETEDAT DESC NULLS LAST
     LIMIT ${MAX_TASK_RECORDS + 1}`,
    [userId]
  )
  if (!taskRecords || taskRecords.length === 0) {
    return { learned: [], partial: [], truncatedAt500: false }
  }
  const truncatedAt500 = taskRecords.length > MAX_TASK_RECORDS
  const capped = truncatedAt500 ? taskRecords.slice(0, MAX_TASK_RECORDS) : taskRecords

  // Step 2: look up slugs.
  const tutorialIds = [...new Set(capped.map(r => r.TUTORIAL_ID).filter(Boolean))]
  if (tutorialIds.length === 0) {
    return { learned: [], partial: [], truncatedAt500 }
  }
  const placeholders = tutorialIds.map(() => '?').join(',')
  const slugRows = await db.run(
    `SELECT ID, SLUG FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE ID IN (${placeholders})`,
    tutorialIds
  )
  const idToSlug = new Map((slugRows || []).map(r => [r.ID, r.SLUG]))

  // Build (iri, status) pairs with shape validation.
  const pairs = []
  for (const tr of capped) {
    const slug = idToSlug.get(tr.TUTORIAL_ID)
    if (!slug) continue
    const slugLc = slug.toLowerCase()
    if (!/^[a-z0-9-]{1,80}$/.test(slugLc)) continue
    pairs.push({ iri: `${TUTORIAL_IRI_PREFIX}${slugLc}`, status: tr.STATUS })
  }
  if (pairs.length === 0) {
    return { learned: [], partial: [], truncatedAt500 }
  }

  // Step 3: SPARQL with VALUES clause.
  const valuesBody = pairs.map(p => `(<${p.iri}> "${p.status}")`).join(' ')
  const sparql = `
PREFIX kg: <https://developers.sap.com/kg/>
SELECT ?c ?status
FROM <https://developers.sap.com/kg/tutorials-v3>
WHERE {
  VALUES (?t ?status) { ${valuesBody} }
  ?t kg:teaches ?c .
}
LIMIT 5000`

  // Step 4: route through KG_ADMIN_RUNSPARQL.
  let sparqlResult
  try {
    sparqlResult = await kgAdminRunSparql({ db, sparql, isUpdate: false })
  } catch (err) {
    LOG.warn('kgAdminRunSparql failed for getConceptsForUser:', err.message)
    return { learned: [], partial: [], truncatedAt500 }
  }

  // Step 5: parse XML with matchAll.
  const xml = sparqlResult?.response || ''
  const learned = new Set()
  const partial = new Set()
  for (const m of xml.matchAll(/<result>([\s\S]*?)<\/result>/g)) {
    const block = m[1]
    const cMatch = block.match(/<binding name="c">\s*<uri>([^<]+)<\/uri>/)
    const sMatch = block.match(/<binding name="status">\s*<literal[^>]*>([^<]+)</)
    if (!cMatch || !sMatch) continue
    const conceptIri = cMatch[1]
    const status = sMatch[1]
    const conceptSlug = conceptIri.startsWith(CONCEPT_IRI_PREFIX)
      ? conceptIri.slice(CONCEPT_IRI_PREFIX.length)
      : conceptIri
    if (status === 'COMPLETED') learned.add(conceptSlug)
    else if (status === 'IN_PROGRESS') partial.add(conceptSlug)
  }
  // Dedupe: learned wins.
  for (const c of learned) partial.delete(c)

  return { learned: [...learned], partial: [...partial], truncatedAt500 }
}
