import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'

const SUITE_PREFIX = '__TEST__ analytics-builder-phase1'

describe('analytics-builder Phase 1 — hybrid HANA E2E', () => {
  let srv
  const createdSavedIDs = []

  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run the hybrid suite')
    }
    srv = await cds.connect.to('AnalyticsService')
  })

  afterAll(async () => {
    if (createdSavedIDs.length) {
      const { AnalyticsSavedQuery } = cds.entities('com.sap.developers.ims')
      await DELETE.from(AnalyticsSavedQuery).where({ ID: { in: createdSavedIDs } })
    }
    // Prune ONLY rows written by this test run. The marker string literal
    // in the test SQL gives us a precise filter (validator rejects /* */ comments).
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    await DELETE.from(AnalyticsQueryHistory).where({ sql: { like: '%PHASE1_E2E_MARKER%' } })
  })

  it('listExposedEntities returns enriched fields against HANA', async () => {
    const list = await srv.send('listExposedEntities')
    const tasks = list.find(e => e.name === 'Tasks')
    expect(tasks.columns.find(c => c.name === 'status')?.filterMode).toBe('enum')
    expect(Array.isArray(tasks.associations)).toBe(true)
  })

  it('runSelectQuery returns privacy + historyId on HANA', async () => {
    const r = await srv.send('runSelectQuery', {
      // Validator forbids comments — string-literal marker the cleanup can grep.
      sql: "SELECT TOP 1 ID, 'PHASE1_E2E_MARKER' AS m FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS",
      source: 'replay',
    })
    expect(r.privacy).toEqual({ mode: 'raw', suppressedCells: 0 })
    expect(r.historyId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('sampleDistinct returns values for Tasks.status', async () => {
    const r = await srv.send('sampleDistinct', { table: 'Tasks', column: 'status', limit: 100 })
    expect(Array.isArray(r.values)).toBe(true)
  })

  it('sampleDistinct rejects Users.email (PII)', async () => {
    await expect(
      srv.send('sampleDistinct', { table: 'Users', column: 'email', limit: 100 })
    ).rejects.toThrow(/not eligible|403/)
  })

  it('SavedQueries CRUD round-trip', async () => {
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      ID: cds.utils.uuid(),
      name: `${SUITE_PREFIX} crud`,
      sql: 'SELECT TOP 1 ID FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS',
      spec: '{}', visibility: 'private',
    })
    const id = created.results?.[0]?.ID || created.ID || created
    if (id && typeof id === 'string') createdSavedIDs.push(id)
    const renamed = await srv.send({
      event: 'rename', entity: 'SavedQueries',
      params: [{ ID: id }],
      data: { name: `${SUITE_PREFIX} renamed`, description: 'updated' },
    })
    expect(renamed.name).toBe(`${SUITE_PREFIX} renamed`)
  })
})
