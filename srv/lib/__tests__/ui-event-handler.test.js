import { describe, it, expect, vi, beforeEach } from 'vitest'
import { _resetForTests, validateBatch, handleUIEvent } from '../ui-event-handler.js'

describe('ui-event-handler', () => {
  beforeEach(() => {
    _resetForTests({ enabled: true, insertFn: vi.fn().mockResolvedValue() })
  })

  describe('validateBatch', () => {
    it('accepts a well-formed batch', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [
          { eventType: 'page_view', surface: '/', timestamp: 1718000000000, payload: { path: '/', referrer: '' } },
        ],
      })
      expect(result.ok).toBe(true)
    })

    it('rejects non-UUID sessionId', () => {
      const result = validateBatch({ sessionId: 'not-a-uuid', events: [] })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/sessionId/i)
    })

    it('rejects empty events array', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [],
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/events/i)
    })

    it('rejects unknown eventType', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [{ eventType: 'banana', surface: '/', timestamp: 1, payload: {} }],
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/eventType|banana/i)
    })

    it('rejects oversized payload (>32 KB)', () => {
      const big = 'x'.repeat(33 * 1024)
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [{ eventType: 'page_view', surface: '/', timestamp: 1, payload: { path: big, referrer: '' } }],
      })
      expect(result.ok).toBe(false)
      expect(result.reason).toMatch(/size|32/i)
    })

    it('rejects non-array events', () => {
      const result = validateBatch({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: 'not-an-array',
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('handleUIEvent', () => {
    it('returns 204 on valid batch and calls insert', async () => {
      const insertFn = vi.fn().mockResolvedValue()
      _resetForTests({ enabled: true, insertFn })
      const req = mockReq({
        sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567',
        events: [{ eventType: 'page_view', surface: '/', timestamp: 1, payload: { path: '/', referrer: '' } }],
      })
      const res = mockRes()
      await handleUIEvent(req, res)
      expect(res.statusCode).toBe(204)
      expect(insertFn).toHaveBeenCalledTimes(1)
    })

    it('returns 503 when feature flag is off', async () => {
      _resetForTests({ enabled: false, insertFn: vi.fn() })
      const req = mockReq({ sessionId: 'a3e0a8b1-1234-4567-89ab-cdef01234567', events: [] })
      const res = mockRes()
      await handleUIEvent(req, res)
      expect(res.statusCode).toBe(503)
    })
  })
})

function mockReq(body) {
  return {
    body,
    header: () => 'mock-user-agent',
    headers: { 'user-agent': 'mock-user-agent' },
  }
}

function mockRes() {
  const res = {
    statusCode: 0,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { return this },
  }
  return res
}
