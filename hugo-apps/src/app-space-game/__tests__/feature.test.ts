// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Note: isGameEnabled was removed in C2 fix (#3009). The game enable signal is
// now carried by data.appSpaceGameEnabled from loadAppSpaceData(), which reads
// the server-side ImsConfig flag APP_SPACE_GAME_ENABLED (default OFF).

// --- isWebGLAvailable ---
describe('isWebGLAvailable', () => {
  let originalCreateElement: typeof document.createElement

  beforeEach(() => {
    originalCreateElement = document.createElement.bind(document)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    // Restore original createElement
    vi.spyOn(document, 'createElement').mockRestore()
  })

  it('returns false when getContext returns null for both webgl2 and webgl', async () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: vi.fn().mockReturnValue(null),
    } as unknown as HTMLCanvasElement)
    const { isWebGLAvailable } = await import('../feature')
    expect(isWebGLAvailable()).toBe(false)
  })

  it('returns true when getContext returns a non-null context for webgl2', async () => {
    const mockCtx = { drawingBufferWidth: 0 }
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: vi.fn().mockImplementation((type: string) =>
        type === 'webgl2' ? mockCtx : null,
      ),
    } as unknown as HTMLCanvasElement)
    const { isWebGLAvailable } = await import('../feature')
    expect(isWebGLAvailable()).toBe(true)
  })

  it('returns true when getContext returns a non-null context for webgl (fallback)', async () => {
    const mockCtx = { drawingBufferWidth: 0 }
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: vi.fn().mockImplementation((type: string) =>
        type === 'webgl' ? mockCtx : null,
      ),
    } as unknown as HTMLCanvasElement)
    const { isWebGLAvailable } = await import('../feature')
    expect(isWebGLAvailable()).toBe(true)
  })

  it('returns false when getContext throws', async () => {
    vi.spyOn(document, 'createElement').mockReturnValue({
      getContext: vi.fn().mockImplementation(() => {
        throw new Error('WebGL not supported')
      }),
    } as unknown as HTMLCanvasElement)
    const { isWebGLAvailable } = await import('../feature')
    expect(isWebGLAvailable()).toBe(false)
  })
})

// --- loadAppSpaceData ---
describe('loadAppSpaceData', () => {
  const mockData = {
    eventId: 42,
    eventName: 'Test Event',
    type: 'DEVTOBERFEST',
    paths: [],
  }

  const mockFallbackData = {
    eventId: 0,
    eventName: 'Fallback Event',
    type: 'DEFAULT',
    paths: [],
  }

  beforeEach(() => {
    vi.resetAllMocks()
    // Reset location to default (no eventid param)
    Object.defineProperty(window, 'location', {
      value: { search: '' },
      writable: true,
      configurable: true,
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns parsed data on a successful primary fetch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce(mockData),
    }))
    const { loadAppSpaceData } = await import('../feature')
    const result = await loadAppSpaceData()
    expect(result).toEqual(mockData)
  })

  it('falls back to /app-space-data.json when primary response.ok=true but .json() rejects', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockRejectedValueOnce(new Error('bad json')),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockFallbackData),
      }),
    )
    const { loadAppSpaceData } = await import('../feature')
    const result = await loadAppSpaceData()
    expect(result).toEqual(mockFallbackData)
  })

  it('falls back to /app-space-data.json when the primary fetch fails (non-ok response)', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockFallbackData),
      }),
    )
    const { loadAppSpaceData } = await import('../feature')
    const result = await loadAppSpaceData()
    expect(result).toEqual(mockFallbackData)
  })

  it('falls back to /app-space-data.json when the primary fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('Network fail'))
      .mockResolvedValueOnce({
        ok: true,
        json: vi.fn().mockResolvedValueOnce(mockFallbackData),
      }),
    )
    const { loadAppSpaceData } = await import('../feature')
    const result = await loadAppSpaceData()
    expect(result).toEqual(mockFallbackData)
  })

  it('returns null when both primary and fallback fetches fail', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockRejectedValueOnce(new Error('Primary fail'))
      .mockRejectedValueOnce(new Error('Fallback fail')),
    )
    const { loadAppSpaceData } = await import('../feature')
    const result = await loadAppSpaceData()
    expect(result).toBeNull()
  })

  it('returns null when both primary and fallback respond non-ok', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: false, status: 404 }),
    )
    const { loadAppSpaceData } = await import('../feature')
    const result = await loadAppSpaceData()
    expect(result).toBeNull()
  })

  it('uses eventid from URL search params (case-insensitive) in primary fetch URL', async () => {
    Object.defineProperty(window, 'location', {
      value: { search: '?eventId=99' },
      writable: true,
      configurable: true,
    })
    const fetchMock = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValueOnce({ ...mockData, eventId: 99 }),
    })
    vi.stubGlobal('fetch', fetchMock)
    const { loadAppSpaceData } = await import('../feature')
    await loadAppSpaceData()
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('eventLegacyId=99'),
    )
  })
})
