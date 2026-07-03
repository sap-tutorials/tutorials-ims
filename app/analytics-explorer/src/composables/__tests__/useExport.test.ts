// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock fetch BEFORE importing the composable.
const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

const { useExport } = await import('../useExport')
const { _resetCsrfTokenCacheForTests, _seedCsrfTokenForTests } = await import('../../api/csrf-fetch')

describe('useExport', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    // Pre-seed the CSRF token so csrfFetch() skips the /auth/user handshake
    // and fetchMock only sees the real POST.
    _resetCsrfTokenCacheForTests()
    _seedCsrfTokenForTests('TEST-CSRF')
    // happy-dom doesn't implement createObjectURL — stub it.
    if (!URL.createObjectURL) {
      ;(URL as any).createObjectURL = vi.fn(() => 'blob:fake')
      ;(URL as any).revokeObjectURL = vi.fn()
    }
  })

  it('POSTs to /admin/analytics/export with the SQL body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['col1,col2\n1,2\n'], { type: 'text/csv' }),
    } as any)
    const { exportCsv, isExporting } = useExport()
    await exportCsv('SELECT 1 FROM Tasks')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/admin/analytics/export')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ sql: 'SELECT 1 FROM Tasks' })
    expect(isExporting.value).toBe(false)
  })

  it('sets isExporting=true while in flight', async () => {
    let resolveFetch: (v: any) => void
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))
    const { exportCsv, isExporting } = useExport()
    const p = exportCsv('SELECT 1')
    expect(isExporting.value).toBe(true)
    resolveFetch!({ ok: true, blob: async () => new Blob(['ok']) } as any)
    await p
    expect(isExporting.value).toBe(false)
  })

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad sql' } as any)
    const { exportCsv } = useExport()
    await expect(exportCsv('DROP TABLE x')).rejects.toThrow(/400|bad sql/)
  })
})
