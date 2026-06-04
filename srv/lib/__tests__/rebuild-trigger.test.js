import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { _resetForTests, scheduleRebuild } from '../rebuild-trigger.js'

describe('rebuild-trigger', () => {
  let dispatch
  beforeEach(() => {
    vi.useFakeTimers()
    dispatch = vi.fn().mockResolvedValue({ status: 204 })
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: 'fake-token' })
  })
  afterEach(() => { vi.useRealTimers() })

  it('fires once after debounce window for a single trigger', async () => {
    scheduleRebuild('admin-write')
    expect(dispatch).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch).toHaveBeenCalledWith({ 'trigger-source': 'admin-write', environment: 'dev' })
  })

  it('coalesces multiple triggers within the window into one dispatch', async () => {
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(20_000)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(20_000)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('fires twice when triggers are spaced beyond the window', async () => {
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('no-ops when token is unset', async () => {
    _resetForTests({ dispatchFn: dispatch, debounceMs: 60_000, token: null })
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('swallows dispatch errors (does not throw to caller)', async () => {
    dispatch.mockRejectedValueOnce(new Error('network broken'))
    scheduleRebuild('admin-write')
    await expect(vi.advanceTimersByTimeAsync(60_001)).resolves.not.toThrow()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })

  it('next trigger after a failed dispatch still fires (no permanent jam)', async () => {
    dispatch.mockRejectedValueOnce(new Error('network broken'))
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(1)
    scheduleRebuild('admin-write')
    await vi.advanceTimersByTimeAsync(60_001)
    expect(dispatch).toHaveBeenCalledTimes(2)
  })
})
