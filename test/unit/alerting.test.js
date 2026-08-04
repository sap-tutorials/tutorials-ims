// test/unit/alerting.test.js
import { describe, it, expect, beforeEach, vi } from 'vitest'
import cds from '@sap/cds'

// Gating is DB-backed via the alert-settings resolver (ChatSettings.alertsEnabled),
// NOT an env var. Mock the resolver to toggle enabled/disabled in tests.
const enabledState = { value: true }
vi.mock('../../srv/lib/runtime-config/alert-settings.js', () => ({
  isAlertingEnabled: () => Promise.resolve(enabledState.value),
  _resetForTest: () => {}
}))

describe('alerting helper', () => {
  beforeEach(() => { vi.resetModules(); enabledState.value = true })

  it('no-ops when alerting is disabled in the DB (never connects)', async () => {
    enabledState.value = false
    const spy = vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn() })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({ eventType: 'X', severity: 'ERROR' })
    // connect.to must not be called when disabled
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('routes to the alerts service when enabled', async () => {
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({ eventType: 'PublishRejected', severity: 'ERROR' })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'PublishRejected' }))
  })

  it('never throws when the service.raise throws (fail-open)', async () => {
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: vi.fn().mockRejectedValue(new Error('boom')) }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await expect(raise({ eventType: 'X', severity: 'ERROR' })).resolves.toBeUndefined()
  })

  it('never throws when connect itself throws (fail-open)', async () => {
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockRejectedValue(new Error('no binding')) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await expect(raise({ eventType: 'X', severity: 'ERROR' })).resolves.toBeUndefined()
  })

  it('publish-reject envelope shape is correct', async () => {
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    // Simulate what the hook constructs:
    await raise({
      eventType: 'PublishRejected', severity: 'ERROR', category: 'ALERT',
      subject: 'Content publish rejected 2 slug(s)',
      body: 'Rejected reverts: a, b',
      resource: { resourceName: 'content-publish', resourceType: 'service' }
    })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'PublishRejected', category: 'ALERT',
      resource: { resourceName: 'content-publish', resourceType: 'service' }
    }))
  })

  it('scheduled-job-failed envelope uses jobName as resourceName', async () => {
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({
      eventType: 'ScheduledJobFailed', severity: 'ERROR', category: 'ALERT',
      subject: 'Scheduled job failed: kg-pagerank-job',
      body: 'TypeError: boom',
      resource: { resourceName: 'kg-pagerank-job', resourceType: 'job' }
    })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'ScheduledJobFailed',
      resource: { resourceName: 'kg-pagerank-job', resourceType: 'job' }
    }))
  })

  it('rebuild-dispatch-failed envelope shape is correct', async () => {
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raise } = await import('../../srv/lib/alerting.js')
    await raise({
      eventType: 'RebuildDispatchFailed', severity: 'ERROR', category: 'ALERT',
      subject: 'Rebuild dispatch failed',
      body: 'fetch failed: 503',
      resource: { resourceName: 'rebuild-dispatch', resourceType: 'service' }
    })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'RebuildDispatchFailed', category: 'ALERT',
      resource: { resourceName: 'rebuild-dispatch', resourceType: 'service' }
    }))
  })
})

describe('raiseTest helper', () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.resetModules(); enabledState.value = true })

  it('returns { outcome: "disabled" } when alerting is disabled (never connects)', async () => {
    enabledState.value = false
    const spy = vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn() })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR' })
    expect(res).toEqual({ outcome: 'disabled' })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })

  it('returns { outcome: "delivered" } when enabled and the sink resolves', async () => {
    const raiseSpy = vi.fn().mockResolvedValue(undefined)
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: raiseSpy }) })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR',
      resource: { resourceName: 'admin-test:u:2026', resourceType: 'service' } })
    expect(res).toEqual({ outcome: 'delivered' })
    expect(raiseSpy).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'AlertingTest' }))
  })

  it('returns { outcome: "error", reason } when the sink raise throws (never throws)', async () => {
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockResolvedValue({ raise: vi.fn().mockRejectedValue(new Error('boom')) }) })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR' })
    expect(res.outcome).toBe('error')
    expect(res.reason).toContain('boom')
  })

  it('returns { outcome: "error", reason } when connect itself throws', async () => {
    vi.spyOn(cds, 'connect', 'get').mockReturnValue({ to: vi.fn().mockRejectedValue(new Error('no binding')) })
    const { raiseTest } = await import('../../srv/lib/alerting.js')
    const res = await raiseTest({ eventType: 'AlertingTest', severity: 'ERROR' })
    expect(res.outcome).toBe('error')
    expect(res.reason).toContain('no binding')
  })
})
