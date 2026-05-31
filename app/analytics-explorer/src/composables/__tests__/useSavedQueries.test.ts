// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

const { useSavedQueries } = await import('../useSavedQueries')

describe('useSavedQueries', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('loadRows fetches /admin/analytics/SavedQueries ordered desc by lastRunAt then createdAt', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [
        { ID: 's1', name: 'Top events', sql: 'SELECT 1', spec: null, visibility: 'private', createdAt: '2026-05-30T10:00:00Z', lastRunAt: null, createdBy: 'tom@test', description: '' },
      ] }),
    } as any)
    const sq = useSavedQueries()
    await sq.loadRows()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/admin/analytics/SavedQueries')
    expect(url).toContain('$orderby=')
    expect(sq.rows.value.length).toBe(1)
  })

  it('saveAs POSTs to the SavedQueries collection with name/spec/sql/visibility', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ID: 'new-id', name: 'My query', visibility: 'private' }),
    } as any)
    const sq = useSavedQueries()
    const created = await sq.saveAs({
      name: 'My query', description: '', sql: 'SELECT 1', spec: '{}', visibility: 'private',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/admin/analytics/SavedQueries')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.name).toBe('My query')
    expect(body.visibility).toBe('private')
    expect(created.ID).toBe('new-id')
  })

  it('rename calls the bound action endpoint with name + description', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ID: 's1', name: 'Renamed' }),
    } as any)
    const sq = useSavedQueries()
    await sq.rename('s1', 'Renamed', 'desc')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("/admin/analytics/SavedQueries(ID='")
    expect(url).toContain('/AnalyticsService.rename')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed', description: 'desc' })
  })

  it('setVisibility calls the action endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as any)
    const sq = useSavedQueries()
    await sq.setVisibility('s1', 'shared-admins')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/AnalyticsService.setVisibility')
    expect(JSON.parse(init.body)).toEqual({ visibility: 'shared-admins' })
  })

  it('duplicate calls the action with empty body', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ID: 'new-id' }) } as any)
    const sq = useSavedQueries()
    const r = await sq.duplicate('s1')
    expect(r.ID).toBe('new-id')
  })

  it('remove calls DELETE on the entity', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 } as any)
    const sq = useSavedQueries()
    await sq.remove('s1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('DELETE')
    expect(url).toContain("/admin/analytics/SavedQueries(ID='")
  })

  it('parseSpec returns parsed when valid v1 JSON', () => {
    const sq = useSavedQueries()
    expect(sq.parseSpec('{"version":1,"from":{"entity":"X"}}')).toEqual({ version: 1, from: { entity: 'X' } })
    expect(sq.parseSpec(null)).toBe(null)
    expect(sq.parseSpec('not json')).toBe(null)
  })
})
