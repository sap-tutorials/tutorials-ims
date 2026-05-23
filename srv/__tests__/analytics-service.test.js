import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

const project = cds.test('serve', '--project', '.', '--in-memory')
const auth = { auth: { username: 'admin', password: 'admin' } }

describe('AnalyticsService', () => {
  it('listExposedEntities returns the annotated set', async () => {
    const { data } = await project.get('/admin/analytics/listExposedEntities()', auth)
    expect(Array.isArray(data.value)).toBe(true)
    const names = data.value.map(e => e.name).sort()
    expect(names).toContain('TaskRecords')
    expect(names).toContain('Tasks')
    expect(names).toContain('CompletionAnalytics')
  })

  it('listExposedEntities omits unannotated entities', async () => {
    const { data } = await project.get('/admin/analytics/listExposedEntities()', auth)
    const names = data.value.map(e => e.name)
    expect(names).not.toContain('ContentFiles')
    expect(names).not.toContain('TutorialEmbedding')
  })

  it('exposes columns with type / nullable / length', async () => {
    const { data } = await project.get('/admin/analytics/listExposedEntities()', auth)
    const tutorials = data.value.find(e => e.name === 'Tutorials')
    expect(tutorials).toBeDefined()
    expect(tutorials.columns.length).toBeGreaterThan(0)
    expect(tutorials.columns[0]).toHaveProperty('type')
    expect(tutorials.columns[0]).toHaveProperty('nullable')
  })

  it('GET on a projection works (OData)', async () => {
    const { status } = await project.get('/admin/analytics/Tutorials?$top=1', auth)
    expect(status).toBe(200)
  })

  it('runSelectQuery rejects empty input', async () => {
    const { status } = await project.post('/admin/analytics/runSelectQuery',
      { sql: '' }, { ...auth, validateStatus: () => true })
    expect(status).toBe(400)
  })

  it('runSelectQuery rejects > 4096 chars', async () => {
    const sql = 'SELECT 1 FROM Tutorials WHERE ' + "x='" + 'a'.repeat(5000) + "'"
    const { status } = await project.post('/admin/analytics/runSelectQuery',
      { sql }, { ...auth, validateStatus: () => true })
    expect(status).toBe(400)
  })

  it('runSelectQuery rejects DDL', async () => {
    const { status } = await project.post('/admin/analytics/runSelectQuery',
      { sql: 'DROP TABLE Tutorials' }, { ...auth, validateStatus: () => true })
    expect(status).toBe(400)
  })

  it('runSelectQuery rejects non-allowlisted table', async () => {
    const { status } = await project.post('/admin/analytics/runSelectQuery',
      { sql: 'SELECT * FROM ContentFiles' }, { ...auth, validateStatus: () => true })
    expect(status).toBe(400)
  })

  it('runSelectQuery happy path returns columns + rows + metadata', async () => {
    // Use the CDS physical table name that works on both SQLite (unit tests) and HANA.
    // On SQLite, CDS maps com.sap.developers.ims.Tutorials → com_sap_developers_ims_Tutorials.
    // The validator allowlist includes this name so it passes.
    const { data } = await project.post('/admin/analytics/runSelectQuery',
      { sql: 'SELECT title FROM com_sap_developers_ims_Tutorials' }, auth)
    expect(data).toHaveProperty('columns')
    expect(data).toHaveProperty('rows')
    expect(data).toHaveProperty('metadata.durationMs')
    expect(typeof data.metadata.truncated).toBe('boolean')
  })
})
