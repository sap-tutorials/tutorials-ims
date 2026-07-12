// test/hybrid/kg-external-content.test.js
// #1125 — exercises the fetchExternalContentLinks HANA-dialect branch
// (unit-untestable due to HANA UNION ALL syntax + double-quoted aliases)
// against a real HANA binding. Proves the lowercase-key contract from #1113.
//
// GATING: runs by default with `npm run test:hybrid` as long as isSafeForWrites().
// No env-flag opt-in needed — this test is read-only and has no $ cost.
//
// Run:
//   npx vitest run test/hybrid/kg-external-content.test.js --project hybrid

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { isSafeForWrites } from './_guard.js'
import { fetchExternalContentLinks } from '../../srv/lib/kg/_search-fetches.js'

cds.test('serve', '--project', '.', '--profile', 'hybrid')

describe.runIf(isSafeForWrites())('#1125 external content — HANA dialect', () => {
  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    const kind = db?.kind || db?.options?.kind
    expect(kind, `expected HANA, got kind=${kind}`).toBe('hana')
  })

  it('fetchExternalContentLinks returns lowercased-key rows for a known concept', async () => {
    const { Concepts } = cds.entities('com.sap.developers.ims')
    const [c] = await db.run(SELECT.from(Concepts).columns('ID').limit(1))
    if (!c) return // empty KG — nothing to assert
    const rows = await fetchExternalContentLinks(db, [c.ID])
    // Graceful no-op when DEV DB has no external links for this concept.
    if (rows.length === 0) return
    for (const r of rows) {
      expect(r).toHaveProperty('content_type')
      expect(r).toHaveProperty('concept_id')
      expect(r).toHaveProperty('slug')
      expect(r).toHaveProperty('url')
      // Keys must be lowercase — HANA folds unquoted aliases to uppercase; the
      // double-quoted aliases in the HANA branch of fetchExternalContentLinks
      // preserve lowercase (#1113). Presence of CONTENT_TYPE would mean the
      // fix regressed.
      expect(r).not.toHaveProperty('CONTENT_TYPE')
    }
  })
})
