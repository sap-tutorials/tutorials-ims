// test/unit/alerting.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import cds from '@sap/cds'

describe('alerting helper', () => {
  beforeEach(() => { vi.resetModules(); delete process.env.ALERTS_ENABLED })

  it('no-ops when ALERTS_ENABLED is not set (never connects)', async () => {
    const spy = vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn() })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({ eventType: 'X', severity: 'ERROR' })
    // connect.to must not be called when disabled
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('routes to the alerts service when enabled', async () => {
    process.env.ALERTS_ENABLED = 'true'
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({ eventType: 'PublishRejected', severity: 'ERROR' })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PublishRejected' }))
  })

  it('never throws when the service.raise throws (fail-open)', async () => {
    process.env.ALERTS_ENABLED = 'true'
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: vi.fn().mockRejectedValue(new Error('boom')) }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await expect(raise({ eventType: 'X', severity: 'ERROR' })).resolves.toBeUndefined()
  })

  it('never throws when connect itself throws (fail-open)', async () => {
    process.env.ALERTS_ENABLED = 'true'
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockRejectedValue(new Error('no binding')) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await expect(raise({ eventType: 'X', severity: 'ERROR' })).resolves.toBeUndefined()
  })
})
