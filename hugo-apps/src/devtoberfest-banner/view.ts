// Pure, unit-testable view logic for the homepage Devtoberfest banner (#2131).
//
// The banner reads the public `/api/devtoberfest/status` window (admin-managed
// via /admin-ui/#/devtoberfest — no hardcoded dates) and shows one of two
// states, computed live in the visitor's browser so it never goes stale:
//
//   before → a live countdown to the start ("Starts in 5d 12h 30m")
//   during → the live-now message with the contest date range
//
// Any other case (event ended, no active event, unparseable/absent dates)
// hides the banner entirely. Keeping this a pure function of (status, now)
// means the phase/label logic is testable without a live clock or the DOM.

import { formatCountdown, formatDuration } from '../devtoberfest/countdown'
import type { StatusResponse } from '../devtoberfest/types'

export interface BannerView {
  /** Whether the banner should be visible at all. */
  show: boolean
  /** 'before' | 'during' when shown; '' when hidden. */
  phase: '' | 'before' | 'during'
  /** The primary dynamic line, e.g. "Starts in 5d 12h 30m" or "Live now". */
  message: string
  /** Contest window "Oct 1 – Oct 31" (rendered during both phases). */
  window: string
}

const HIDDEN: BannerView = { show: false, phase: '', message: '', window: '' }

/**
 * Format an ISO date as a short "Mon D" label in UTC so the contest window is
 * deterministic regardless of the visitor's timezone (the window is a date
 * range, not an instant — a UTC calendar day is the right unit here).
 */
function fmtDay(iso: string): string {
  const t = Date.parse(iso)
  if (isNaN(t)) return ''
  return new Date(t).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  })
}

/**
 * Compute the banner's visible state from the status payload and the current
 * time (epoch ms). Returns HIDDEN unless the event is upcoming or running.
 */
export function bannerView(status: StatusResponse | null, nowMs: number): BannerView {
  const ev = status?.event
  if (!ev || !ev.startDate || !ev.endDate) return HIDDEN

  const cd = formatCountdown(nowMs, ev.startDate, ev.endDate)
  if (cd.phase !== 'before' && cd.phase !== 'during') return HIDDEN

  const start = Date.parse(ev.startDate)
  const s = fmtDay(ev.startDate)
  const e = fmtDay(ev.endDate)
  const window = s && e ? `${s} – ${e}` : ''

  const message =
    cd.phase === 'before' ? `Starts in ${formatDuration(start - nowMs)}` : 'Live now'

  return { show: true, phase: cd.phase, message, window }
}
