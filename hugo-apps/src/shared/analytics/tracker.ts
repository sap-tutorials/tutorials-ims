// hugo-apps/src/shared/analytics/tracker.ts
//
// Core tracker: sessionId lifetime, batch buffer, flush triggers, sendBeacon
// vs fetch fallback. Pure module — no DOM-event listeners here (those live in
// page-events.ts / filter-events.ts / card-events.ts and call track()).
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md (#204)

const SESSION_KEY = 'analytics.sessionId'
const BATCH_FLUSH_INTERVAL_MS = 30_000
const MAX_5XX_BEFORE_DISABLE = 3
const ENDPOINT = '/api/ui-event'

interface TrackerState {
  surface: string
  buildAt: string
  buffer: BufferedEvent[]
  flushTimer: ReturnType<typeof setTimeout> | null
  consecutive5xx: number
  selfDisabled: boolean
  sessionStorage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  sendBeacon: (url: string, data: string) => boolean
  fetchFn: typeof fetch
  cryptoUuid: () => string
}

interface BufferedEvent {
  eventType: string
  surface: string
  timestamp: number
  payload: Record<string, unknown>
}

let _state: TrackerState = createDefaultState()

function createDefaultState(): TrackerState {
  return {
    surface: '',
    buildAt: '',
    buffer: [],
    flushTimer: null,
    consecutive5xx: 0,
    selfDisabled: false,
    sessionStorage: typeof window !== 'undefined' && window.sessionStorage ? window.sessionStorage : noopStorage(),
    sendBeacon: typeof navigator !== 'undefined' && navigator.sendBeacon
      ? navigator.sendBeacon.bind(navigator)
      : () => false,
    fetchFn: typeof fetch !== 'undefined' ? fetch : (() => Promise.reject(new Error('no fetch'))) as typeof fetch,
    cryptoUuid: typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID.bind(crypto)
      : fallbackUuid,
  }
}

function noopStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> {
  return { getItem: () => null, setItem: () => {}, removeItem: () => {} }
}

function fallbackUuid(): string {
  // Math.random fallback for browsers without crypto.randomUUID. Not as
  // collision-resistant but the practical odds at our scale are negligible.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0
    const v = c === 'x' ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function _resetForTests(opts: Partial<TrackerState> & {
  sessionStorage?: any
  sendBeacon?: any
  fetchFn?: typeof fetch
  cryptoUuid?: () => string
}) {
  if (_state.flushTimer) clearTimeout(_state.flushTimer)
  _state = { ...createDefaultState(), ...opts }
}

export function init(opts: { surface: string; buildAt: string }) {
  _state.surface = opts.surface
  _state.buildAt = opts.buildAt
}

export function getSessionId(): string {
  let id = ''
  try {
    id = _state.sessionStorage.getItem(SESSION_KEY) ?? ''
  } catch {
    // sessionStorage unavailable (private mode, quota); generate anyway
  }
  if (!id) {
    id = _state.cryptoUuid()
    try {
      _state.sessionStorage.setItem(SESSION_KEY, id)
    } catch { /* noop */ }
  }
  return id
}

export function track(eventType: string, payload: Record<string, unknown>) {
  if (_state.selfDisabled) return
  _state.buffer.push({
    eventType,
    surface: _state.surface,
    timestamp: Date.now(),
    payload,
  })
  if (eventType === 'card_click') {
    flush({ via: 'fetch' })
  } else {
    scheduleFlush()
  }
}

function scheduleFlush() {
  if (_state.flushTimer) return
  _state.flushTimer = setTimeout(() => {
    _state.flushTimer = null
    flush({ via: 'fetch' })
  }, BATCH_FLUSH_INTERVAL_MS)
}

export function flush(opts: { via: 'fetch' | 'beacon' } = { via: 'fetch' }) {
  if (_state.selfDisabled) return
  if (_state.buffer.length === 0) return
  const events = _state.buffer.splice(0)
  if (_state.flushTimer) {
    clearTimeout(_state.flushTimer)
    _state.flushTimer = null
  }
  const sessionId = getSessionId()
  const body = JSON.stringify({ sessionId, buildAt: _state.buildAt, events })

  if (opts.via === 'beacon') {
    const blob = new Blob([body], { type: 'application/json' })
    const queued = _state.sendBeacon(ENDPOINT, blob as any)
    if (queued) return
    // Fall through to fetch fallback
  }

  _state.fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    keepalive: opts.via === 'beacon',
  }).then(res => {
    if (res.ok) {
      _state.consecutive5xx = 0
      return
    }
    if (res.status >= 500) {
      _state.consecutive5xx += 1
      if (_state.consecutive5xx >= MAX_5XX_BEFORE_DISABLE) {
        _state.selfDisabled = true
        console.warn('[analytics] tracker self-disabled after 3 consecutive 5xx')
      }
    }
    // 4xx: drop batch, no retry
  }).catch(() => {
    _state.consecutive5xx += 1
    if (_state.consecutive5xx >= MAX_5XX_BEFORE_DISABLE) {
      _state.selfDisabled = true
    }
  })
}

export function _getBufferForTests(): BufferedEvent[] {
  return [..._state.buffer]
}
