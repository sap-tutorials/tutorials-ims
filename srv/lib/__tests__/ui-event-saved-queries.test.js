import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'

import { seedUIEventSavedQueries, QUERIES } from '../ui-event-saved-queries.js'

const require = createRequire(import.meta.url)
const { validateSelect } = require('../analytics-sql-validator.cjs')

cds.test('serve', '--project', '.', '--in-memory')

describe('ui-event-saved-queries — canonical A/B SavedQueries seeder', () => {
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

  it('inserts all 6 canonical queries on first run (empty table)', async () => {
    await clearSeedRows()
    const db = cds.db
    const result = await db.tx({ user: new cds.User.Privileged() }, tx =>
      seedUIEventSavedQueries(tx))
    expect(result).toEqual({ inserted: 6, total: 6 })

    const rows = await db.tx({ user: new cds.User.Privileged() }, tx =>
      tx.run(SELECT.from(SavedQuery).columns('name', 'visibility', 'privacyMode', 'createdBy')
        .where({ name: { in: seedNames } })))
    expect(rows.length).toBe(6)
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
      seedUIEventSavedQueries(tx))
    expect(first).toEqual({ inserted: 6, total: 6 })

    const second = await db.tx({ user: new cds.User.Privileged() }, tx =>
      seedUIEventSavedQueries(tx))
    expect(second).toEqual({ inserted: 0, total: 6 })

    const rows = await db.tx({ user: new cds.User.Privileged() }, tx =>
      tx.run(SELECT.from(SavedQuery).columns('ID').where({ name: { in: seedNames } })))
    expect(rows.length).toBe(6)
  })

  it('every seeded SQL passes the analytics SQL validator', () => {
    // The validator's allowlist includes both the projection name (UIEvents)
    // and the HANA/SQLite physical names. We mirror that here so the test
    // doesn't depend on the live AnalyticsService allowlist plumbing.
    const allowedTables = new Set([
      'UIEvents',
      'COM_SAP_DEVELOPERS_IMS_UIEVENT',
      'com_sap_developers_ims_UIEvent',
    ])
    for (const q of QUERIES) {
      expect(() => validateSelect(q.sql, allowedTables)).not.toThrow()
    }
  })
})
