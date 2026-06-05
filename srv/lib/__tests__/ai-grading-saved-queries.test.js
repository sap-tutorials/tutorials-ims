import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'

import { seedAiGradingSavedQueries, QUERIES } from '../ai-grading-saved-queries.js'

const require = createRequire(import.meta.url)
const { validateSelect } = require('../analytics-sql-validator.cjs')

cds.test('serve', '--project', '.', '--in-memory')

describe('ai-grading-saved-queries — token-spend SavedQueries seeder (#240)', () => {
  const SavedQuery = 'com.sap.developers.ims.AnalyticsSavedQuery'
  const seedNames = QUERIES.map(q => q.name)

  // Cleanup before each scenario so the suite runs in any order.
  async function clearSeedRows() {
    const db = cds.db
    await db.tx({ user: new cds.User.Privileged() }, tx =>
      tx.run(DELETE.from(SavedQuery).where({ name: { in: seedNames } })))
  }

  beforeAll(async () => {
    await clearSeedRows()
  })

  it('inserts all 5 canonical queries on first run (empty table)', async () => {
    await clearSeedRows()
    const db = cds.db
    const result = await db.tx({ user: new cds.User.Privileged() }, tx =>
      seedAiGradingSavedQueries(tx))
    expect(result).toEqual({ inserted: 5, total: 5 })

    const rows = await db.tx({ user: new cds.User.Privileged() }, tx =>
      tx.run(SELECT.from(SavedQuery).columns('name', 'visibility', 'privacyMode', 'createdBy')
        .where({ name: { in: seedNames } })))
    expect(rows.length).toBe(5)
    for (const r of rows) {
      expect(r.visibility).toBe('shared-admins')
      expect(r.privacyMode).toBe('raw')
      expect(r.createdBy).toBe('system')
    }
  })

  it('is idempotent — re-running does not duplicate', async () => {
    await clearSeedRows()
    const db = cds.db
    const first = await db.tx({ user: new cds.User.Privileged() }, tx =>
      seedAiGradingSavedQueries(tx))
    expect(first).toEqual({ inserted: 5, total: 5 })

    const second = await db.tx({ user: new cds.User.Privileged() }, tx =>
      seedAiGradingSavedQueries(tx))
    expect(second).toEqual({ inserted: 0, total: 5 })

    const rows = await db.tx({ user: new cds.User.Privileged() }, tx =>
      tx.run(SELECT.from(SavedQuery).columns('ID').where({ name: { in: seedNames } })))
    expect(rows.length).toBe(5)
  })

  it('every seeded SQL passes the analytics SQL validator', () => {
    // Mirror the validator's allowlist from AnalyticsService at runtime.
    // Both projection names + HANA + SQLite physical names.
    const allowedTables = new Set([
      'ValidateAnswerSubmissions',
      'CodeCheckSubmissions',
      'COM_SAP_DEVELOPERS_IMS_VALIDATEANSWERSUBMISSIONS',
      'com_sap_developers_ims_ValidateAnswerSubmissions',
      'COM_SAP_DEVELOPERS_IMS_CODECHECKSUBMISSIONS',
      'com_sap_developers_ims_CodeCheckSubmissions',
    ])
    for (const q of QUERIES) {
      expect(() => validateSelect(q.sql, allowedTables)).not.toThrow()
    }
  })

  it('every query targets at least one ai-grading submissions table', () => {
    // Defense against accidental drift: every canonical query SHOULD aggregate
    // submissions data, not some unrelated table.
    for (const q of QUERIES) {
      const sql = q.sql.toLowerCase()
      const targetsValidate = sql.includes('validateanswersubmissions')
      const targetsCodeCheck = sql.includes('codechecksubmissions')
      expect(targetsValidate || targetsCodeCheck).toBe(true)
    }
  })

  it('all queries explicitly exclude disabled errorReason rows from token totals', () => {
    // Disabled-flag short-circuits before any LLM call, so promptTokens are 0
    // anyway — but excluding these rows from the SUM keeps the row count
    // accurate (you wouldn't want to include "disabled" attempts in a
    // submissions count for spend tracking).
    for (const q of QUERIES) {
      const sql = q.sql
      // The verdict-distribution query intentionally INCLUDES disabled to
      // surface "how often did this happen?" — exempt it.
      if (q.name.includes('Verdict outcome distribution')) continue
      expect(sql).toMatch(/errorReason\s+IS\s+NULL\s+OR\s+errorReason\s+<>\s+'disabled'/i)
    }
  })
})
