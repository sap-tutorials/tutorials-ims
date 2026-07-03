import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('cleanup job — analytics history pruning', () => {
  it('keeps the most recent 200 rows per user, deletes the rest', async () => {
    const db = await cds.connect.to('db')
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')

    // Insert 250 rows for tom@test, 50 for admin@test, all with marker SQL.
    const tomRows = Array.from({ length: 250 }, (_, i) => ({
      ID: cds.utils.uuid(),
      sql: `SELECT ${i} /* PRUNE_TEST_TOM */ FROM TaskRecords`,
      rowCount: 0, durationMs: 1, truncated: false,
      privacyMode: 'raw', source: 'replay',
      createdBy: 'tom@test',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }))
    const adminRows = Array.from({ length: 50 }, (_, i) => ({
      ID: cds.utils.uuid(),
      sql: `SELECT ${i} /* PRUNE_TEST_ADMIN */ FROM TaskRecords`,
      rowCount: 0, durationMs: 1, truncated: false,
      privacyMode: 'raw', source: 'replay',
      createdBy: 'admin@test',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }))
    await INSERT.into(AnalyticsQueryHistory).entries([...tomRows, ...adminRows])

    const { pruneAnalyticsHistory } = await import('../jobs/cleanup.js')
    await pruneAnalyticsHistory(200)

    const tomRemaining = await SELECT.from(AnalyticsQueryHistory)
      .where({ createdBy: 'tom@test' })
    const adminRemaining = await SELECT.from(AnalyticsQueryHistory)
      .where({ createdBy: 'admin@test' })
    expect(tomRemaining.length).toBe(200)
    expect(adminRemaining.length).toBe(50)
  })
})
