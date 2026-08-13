// Pure, unit-testable countdown helpers for the Devtoberfest home banner.
//
// Extracted from the SFC so the phase/label logic can be tested without a
// mounted component or a live clock (mirrors ./ticker.ts). The component owns
// the `setInterval` tick and passes the current time in; these functions are
// pure functions of (now, start, end).

export type CountdownPhase = 'before' | 'during' | 'ended' | 'invalid'

export interface Countdown {
  phase: CountdownPhase
  label: string
}

/**
 * Format a millisecond duration as a short human string. Shows the two-to-three
 * most significant units so it stays readable at every scale:
 *   >= 1 day   → `5d 12h 30m`
 *   >= 1 hour  → `12h 30m`
 *   >= 1 min   → `30m 15s`
 *   < 1 min    → `15s`
 * Negative input clamps to `0s`. Sub-second remainders floor.
 */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(totalSec / 86400)
  const h = Math.floor((totalSec % 86400) / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (d > 0) return `${d}d ${h}h ${m}m`
  if (h > 0) return `${h}h ${m}m`
  if (m > 0) return `${m}m ${s}s`
  return `${s}s`
}

/**
 * Compute the countdown phase and label for an event window.
 *
 * @param nowMs    - current time in epoch ms (component passes `Date.now()`)
 * @param startISO - ISO-8601 event start (UTC)
 * @param endISO   - ISO-8601 event end (UTC)
 *
 * Boundaries: `now === start` is already `during`; `now === end` is `ended`.
 * Unparseable start/end → `{ phase: 'invalid', label: '' }` so the caller can
 * render nothing rather than a broken string.
 */
export function formatCountdown(nowMs: number, startISO: string, endISO: string): Countdown {
  const start = Date.parse(startISO)
  const end = Date.parse(endISO)
  if (isNaN(start) || isNaN(end)) return { phase: 'invalid', label: '' }

  if (nowMs < start) {
    return { phase: 'before', label: `Starts in ${formatDuration(start - nowMs)}` }
  }
  if (nowMs < end) {
    return { phase: 'during', label: `Ends in ${formatDuration(end - nowMs)}` }
  }
  return { phase: 'ended', label: 'Ended' }
}
