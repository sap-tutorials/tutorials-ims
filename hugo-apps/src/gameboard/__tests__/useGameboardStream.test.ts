// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Mock socket.io-client so no real connection is attempted.
const handlers: Record<string, (...a: unknown[]) => void> = {}
const emit = vi.fn()
const disconnect = vi.fn()
vi.mock('socket.io-client', () => ({
  io: () => ({
    on: (ev: string, cb: (...a: unknown[]) => void) => { handlers[ev] = cb },
    emit,
    disconnect,
  }),
}))

import { useGameboardStream } from '../useGameboardStream'

describe('useGameboardStream', () => {
  beforeEach(() => { vi.useFakeTimers(); for (const k in handlers) delete handlers[k]; emit.mockClear() })
  afterEach(() => { vi.useRealTimers() })

  it('joins wsContext on connect and debounces tutorialCompleted', async () => {
    const onCompleted = vi.fn()
    const { connect, connectionState } = useGameboardStream()
    connect('', 'evt-1', onCompleted)
    handlers['connect']()
    expect(emit).toHaveBeenCalledWith('wsContext', { context: 'evt-1' })
    expect(connectionState.value).toBe('connected')

    handlers['tutorialCompleted']({ bucketName: 'x' })
    handlers['tutorialCompleted']({ bucketName: 'y' })
    expect(onCompleted).not.toHaveBeenCalled()   // still within debounce window
    vi.advanceTimersByTime(1500)
    expect(onCompleted).toHaveBeenCalledTimes(1)  // burst collapsed to one refetch
  })
})
