// test/hybrid/kg-path-between.test.js
// Hybrid tests for KG_QUERY procedure's PATH_BETWEEN branch (issue #445 Phase 2).
//
// Runs against the deployed DEV procedure from Task 2.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/kg-path-between.test.js

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

// DO-block CALL pattern per memory kg_sparql_definer_procedures_canonical.
// The @cap-js/hana driver does not bind OUT params via db.run('CALL <proc>(...)').
// We wrap the CALL in a DO block and SELECT the OUT params back as a result set.
const DO_CALL_KG_QUERY = `DO (IN qn NVARCHAR(50) => ?, IN p1 NVARCHAR(500) => ?, IN p2 NVARCHAR(500) => ?, IN p3 NVARCHAR(500) => ?, IN ogi NVARCHAR(500) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_QUERY(:qn, :p1, :p2, :p3, :ogi, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`

async function callPathBetween(db, fromIri, toIri) {
  const rows = await db.run(DO_CALL_KG_QUERY, ['PATH_BETWEEN', fromIri, toIri, null, null])
  const r = Array.isArray(rows) ? rows[0] : rows?.changes?.[1]?.[0] || rows
  return r?.RESPONSE?.toString?.() || r?.RESPONSE || ''
}

// Parse SPARQL XML results with matchAll() to sidestep stateful regex pitfalls
// (and the security-hook false positive on RegExp.exec()).
function parseResults(xml) {
  if (!xml) return []
  const out = []
  for (const m of xml.matchAll(/<result>([\s\S]*?)<\/result>/g)) {
    const block = m[1]
    const bindings = {}
    for (const bm of block.matchAll(/<binding name="([^"]+)">[\s\S]*?<(uri|literal)[^>]*>([^<]+)</g)) {
      bindings[bm[1]] = bm[3]
    }
    out.push(bindings)
  }
  return out
}

// Production-realistic source tutorial. Verified via Task 2 smoke probe that
// this slug pair returns valid SPARQL XML with PREREQ arm populated.
const FROM_TUT = 'https://developers.sap.com/kg/tutorial/abap-dev-enhance-cds-view'
const TO_TUT = 'https://developers.sap.com/kg/tutorial/btp-cap-beginner-bas-wizard'

describe('KG_QUERY PATH_BETWEEN — three-arm hybrid SPARQL (issue #445)', () => {
  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService'
    if (!isHana) throw new Error('kg-path-between.test.js requires HANA. Use `npm run test:hybrid`.')
  })

  it('returns non-empty results for a known DEV slug pair', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    expect(parseResults(xml).length).toBeGreaterThan(0)
  })

  it('ORDER BY pathTypeRank: results are non-decreasing by rank', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    const ranks = parseResults(xml).map(r => Number(r.pathTypeRank))
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
    }
  })

  it('PREREQ arm fires (primary path when prerequisite graph has edges)', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    const prereq = parseResults(xml).filter(r => r.pathType === 'PREREQ')
    // PREREQ arm UNION matches the prerequisite chain: a.teaches ?c1 . ?c1 (^requires)+ ?cN . b.teaches ?cN
    // This arm should fire for high-traffic tutorial pairs with prerequisite data.
    expect(prereq.length).toBeGreaterThan(0)
  })

  it('pathTypeRank values are as-specified: PREREQ=1, CO_COMPLETED=2, SHARED_CONCEPT=3', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    const types = new Set()
    for (const r of parseResults(xml)) {
      if (r.pathType === 'PREREQ') expect(Number(r.pathTypeRank)).toBe(1)
      if (r.pathType === 'CO_COMPLETED') expect(Number(r.pathTypeRank)).toBe(2)
      if (r.pathType === 'SHARED_CONCEPT') expect(Number(r.pathTypeRank)).toBe(3)
      types.add(r.pathType)
    }
    // At least one pathType must be present.
    expect(types.size).toBeGreaterThan(0)
  })

  it('LIMIT 10 enforced: never more than 10 results', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    expect(parseResults(xml).length).toBeLessThanOrEqual(10)
  })

  it('?b never equals the source IRI (FILTER works)', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    for (const r of parseResults(xml)) {
      expect(r.b).not.toBe(FROM_TUT)
    }
  })

  it('rejects invalid :p1 IRI with code 10006', async () => {
    await expect(
      db.run(DO_CALL_KG_QUERY, ['PATH_BETWEEN', 'not-a-valid-iri', TO_TUT, null, null])
    ).rejects.toMatchObject({ code: 10006 })
  })

  it('rejects invalid :p2 IRI with code 10006', async () => {
    await expect(
      db.run(DO_CALL_KG_QUERY, ['PATH_BETWEEN', FROM_TUT, 'not-a-valid-iri', null, null])
    ).rejects.toMatchObject({ code: 10006 })
  })
})
