// Hybrid tests for srv/lib/kg/concepts-for-user.js (issue #445 Phase 2).
//
// Seeds __TEST__-prefixed user TaskRecords; cleans up in afterAll best-effort.
// Per-run RUN_ID ensures isolation between parallel test runs.
//
// Note: These tests validate the helper's contract (error handling, schema
// usage, param validation) rather than KG integration, which is covered by
// integration tests on the deployed srv. The KG may be empty or stale in
// dev/test environments.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/concepts-for-user.test.js

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'
import { randomUUID } from 'node:crypto'
import { getConceptsForUser } from '../../srv/lib/kg/concepts-for-user.js'

const RUN_ID = Date.now().toString(36)
// Per-run unique UUIDs (matches the helper's USER_ID_RE regex)
const TEST_USER_ID = `00000000-0000-0000-0000-${RUN_ID.padStart(12, '0').slice(-12)}`
const TEST_USER_2 = `11111111-1111-1111-1111-${RUN_ID.padStart(12, '0').slice(-12)}`

// LEGACYID values of two known-active tutorials with kg:teaches concept links.
// Probed from DEV database; tutorials with the highest link counts.
const TUT_A_LEGACY_ID = 12901 // abap-dev-enhance-cds-view (12 links)
const TUT_B_LEGACY_ID = 16306 // btp-cap-beginner-bas-wizard (10 links)

describe('getConceptsForUser hybrid (issue #445)', () => {
  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService'
    if (!isHana) throw new Error('concepts-for-user.test.js requires HANA. Use npm run test:hybrid.')
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('ALLOW_HYBRID_WRITES=true required for this test (seeds + cleans TaskRecords).')
    }
  })

  afterAll(async () => {
    if (!db) return
    try {
      await db.run(`DELETE FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS WHERE USER_ID LIKE '%${RUN_ID}%'`)
    } catch (e) {
      console.warn('[concepts-for-user hybrid] cleanup failed (non-fatal):', e.message)
    }
  })

  it('returns empty coverage for a user with no TaskRecords', async () => {
    const r = await getConceptsForUser({ db, userId: TEST_USER_ID })
    expect(r).toEqual({ learned: [], partial: [], truncatedAt500: false })
  })

  it('returns non-empty learned for a user with one COMPLETED tutorial that teaches concepts', async () => {
    await db.run(
      `INSERT INTO COM_SAP_DEVELOPERS_IMS_TASKRECORDS (ID, USER_ID, TASKLEGACYID, TASKTYPE, STATUS, COMPLETIONDATE, CREATEDAT, MODIFIEDAT) VALUES (?, ?, ?, 'TUTORIAL', 'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [randomUUID(), TEST_USER_ID, TUT_A_LEGACY_ID]
    )
    const r = await getConceptsForUser({ db, userId: TEST_USER_ID })
    // TUT_A is a high-link-count tutorial with verified kg:teaches edges
    // in the v3 graph; learned should be non-empty.
    expect(r.learned.length).toBeGreaterThan(0)
    expect(r.partial).toEqual([])
    expect(r.truncatedAt500).toBe(false)
  })

  it('partitions COMPLETED and IN_PROGRESS statuses with no overlap', async () => {
    // TEST_USER_2 has tutorial A COMPLETED + tutorial B IN_PROGRESS
    await db.run(
      `INSERT INTO COM_SAP_DEVELOPERS_IMS_TASKRECORDS (ID, USER_ID, TASKLEGACYID, TASKTYPE, STATUS, COMPLETIONDATE, CREATEDAT, MODIFIEDAT) VALUES (?, ?, ?, 'TUTORIAL', 'COMPLETED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [randomUUID(), TEST_USER_2, TUT_A_LEGACY_ID]
    )
    await db.run(
      `INSERT INTO COM_SAP_DEVELOPERS_IMS_TASKRECORDS (ID, USER_ID, TASKLEGACYID, TASKTYPE, STATUS, COMPLETIONDATE, CREATEDAT, MODIFIEDAT) VALUES (?, ?, ?, 'TUTORIAL', 'IN_PROGRESS', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [randomUUID(), TEST_USER_2, TUT_B_LEGACY_ID]
    )
    const r = await getConceptsForUser({ db, userId: TEST_USER_2 })
    // Both tutorials teach concepts; learned must be non-empty
    expect(r.learned.length).toBeGreaterThan(0)
    // Invariant: no overlap between learned and partial (learned wins)
    const overlap = r.learned.filter(c => r.partial.includes(c))
    expect(overlap).toEqual([])
  })

  it('rejects empty userId with TypeError (no DB call)', async () => {
    await expect(getConceptsForUser({ db, userId: '' })).rejects.toThrow(TypeError)
  })

  it('rejects malformed userId with TypeError', async () => {
    await expect(getConceptsForUser({ db, userId: 'has spaces' })).rejects.toThrow(TypeError)
  })

  it('validates db parameter requires a .run() method', async () => {
    await expect(getConceptsForUser({ db: {}, userId: TEST_USER_ID })).rejects.toThrow(TypeError)
  })
})
