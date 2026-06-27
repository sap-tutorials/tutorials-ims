import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('buildConceptsHandler (Express middleware)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns the payload as JSON', async () => {
    const fakePayload = { concepts: [], generatedAt: '2026-06-27T00:00:00.000Z' }

    vi.doMock('../../../srv/lib/published-concepts-query.js', () => ({
      buildConceptsPayload: vi.fn().mockResolvedValue(fakePayload),
    }))

    const { buildConceptsHandler } = await import('../../../srv/lib/build-concepts.js')

    const req = {}
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    await buildConceptsHandler(req, res)

    expect(res.status).not.toHaveBeenCalled()
    expect(res.json).toHaveBeenCalledWith(fakePayload)
  })

  it('returns 500 + error JSON when the helper throws', async () => {
    vi.doMock('../../../srv/lib/published-concepts-query.js', () => ({
      buildConceptsPayload: vi.fn().mockRejectedValue(new Error('boom')),
    }))

    const { buildConceptsHandler } = await import('../../../srv/lib/build-concepts.js')

    const req = {}
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn().mockReturnThis() }
    await buildConceptsHandler(req, res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(String) }))
  })
})
