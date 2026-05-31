// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

const { useHistory } = await import('../useHistory')

describe('useHistory', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('loadRows fetches /admin/analytics/QueryHistory ordered desc by createdAt', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [
        { ID: 'h1', sql: 'SELECT 1', spec: null, createdAt: '2026-05-30T10:00:00Z', source: 'editor', rowCount: 1, durationMs: 10, truncated: false, privacyMode: 'raw' },
        { ID: 'h2', sql: 'SELECT 2', spec: '{}', createdAt: '2026-05-29T10:00:00Z', source: 'builder', rowCount: 2, durationMs: 20, truncated: false, privacyMode: 'raw' },
      ] }),
    } as any)
    const h = useHistory()
    await h.loadRows()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/admin/analytics/QueryHistory')
    expect(url).toContain('$orderby=createdAt%20desc')
    expect(h.rows.value.length).toBe(2)
    expect(h.rows.value[0].ID).toBe('h1')
  })

  it('loadRows surfaces fetch errors via lastError ref', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' } as any)
    const h = useHistory()
    await expect(h.loadRows()).rejects.toThrow(/500|oops/)
    expect(h.lastError.value).toBeTruthy()
  })

  it('parseSpec returns the parsed QuerySpec when spec is non-null v1 JSON', () => {
    const h = useHistory()
    const parsed = h.parseSpec('{"version":1,"from":{"entity":"X","alias":"x"}}')
    expect(parsed).toEqual({ version: 1, from: { entity: 'X', alias: 'x' } })
  })

  it('parseSpec returns null for null/empty/invalid input', () => {
    const h = useHistory()
    expect(h.parseSpec(null)).toBe(null)
    expect(h.parseSpec('')).toBe(null)
    expect(h.parseSpec('not json')).toBe(null)
  })
})
