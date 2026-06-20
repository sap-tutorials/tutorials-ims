import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { _resetForTests, scheduleRebuild } from '../rebuild-trigger.js'
import * as tenantResolver from '../runtime-config/tenant-settings.js'

function mockTenant(rebuildTargetEnv = 'dev') {
  vi.spyOn(tenantResolver, 'resolveTenantSettings').mockResolvedValue({
    allowedCorsOrigins: '',
    rebuildTargetEnv,
    techUsers: '',
    techUsersMapping: '',
  })
}

describe('rebuild-trigger', () => {
  let dispatch
  beforeEach(() => {
    vi.useFakeTimers()
    dispatch = vi.fn().mockResolvedValue({ status: 204 })
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: 'fake-token' })
    mockTenant('dev')
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('fires once after debounce window for a single trigger', async () => {
    await scheduleRebuild('admin-write')
    expect(dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({ 'trigger-source': 'admin-write', environment: 'dev' })
  })

  it('coalesces multiple triggers within the window into one dispatch', async () => {
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(20_000)
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(20_000)
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('fires twice when triggers are spaced beyond the window', async () => {
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('no-ops when token is unset', async () => {
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: null })
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('swallows dispatch errors (does not throw to caller)', async () => {
    dispatch.mockRejectedValueOnce(new Error('network broken'))
    await scheduleRebuild('admin-write')
    await expect(vi.advanceTimersByTimeAsync(60_001)).resolves.not.toThrow()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('next trigger after a failed dispatch still fires (no permanent jam)', async () => {
    dispatch.mockRejectedValueOnce(new Error('network broken'))
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('defaults environment to "dev" when resolver returns dev', async () => {
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: 'fake-token' })
    mockTenant('dev')
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledWith({ 'trigger-source': 'admin-write', environment: 'dev' })
  })

  it('uses resolver value when set to qa', async () => {
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: 'fake-token' })
    mockTenant('qa')
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledWith({ 'trigger-source': 'admin-write', environment: 'qa' })
  })

  it('uses resolver value when set to prod', async () => {
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: 'fake-token' })
    mockTenant('prod')
    await scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledWith({ 'trigger-source': 'admin-write', environment: 'prod' })
  })
})
