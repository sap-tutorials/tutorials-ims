// Pure, unit-testable view logic for the homepage SAP TechEd banner (#2751).
//
// This banner takes over the homepage automatically once Devtoberfest ends
// (the two events do not overlap, so no explicit swap toggle is needed — each
// banner self-hides outside its own window). Unlike the Devtoberfest banner,
// the TechEd banner also shows AFTER the event: the strip stays up and the text
// flips to "Watch the replays". It reads a fixed production Events row via
// GET /api/teched/event-status and renders one of three states, computed live
// in the visitor's browser so it never goes stale:
//
//   before → a live countdown to the start ("Starts in 5d 12h 30m")
//   during → "Live now — join the free virtual event"
//   after  → "Watch the replays" (banner stays visible)
//
// Only an absent/unparseable event window hides the banner entirely. Keeping
// this a pure function of (status, now) means the phase/label logic is testable
// without a live clock or the DOM (mirrors devtoberfest-banner/view.ts).

import { formatCountdown, formatDuration } from '../devtoberfest/countdown'

export interface TechEdEventInfo {
  name: string
  startDate: string
  endDate: string
}

/** Response shape of GET /api/teched/event-status (anonymous). */
export interface TechEdStatusResponse {
  event: TechEdEventInfo | null
}

export interface BannerView {
  /** Whether the banner should be visible at all. */
  show: boolean
  /** 'before' | 'during' | 'after' when shown; '' when hidden. */
  phase: '' | 'before' | 'during' | 'after'
  /** The primary dynamic line, e.g. "Starts in 5d 12h 30m" or "Watch the replays". */
  message: string
  /** Event window "Nov 24 – Nov 26" (rendered in all three phases). */
  window: string
}

const HIDDEN: BannerView = { show: false, phase: '', message: '', window: '' }

/**
 * Format an ISO date as a short "Mon D" label in UTC so the event window is
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
 * time (epoch ms). Returns HIDDEN only when the event window is absent or
 * unparseable; otherwise it is shown in all three phases (before/during/after).
 */
export function bannerView(status: TechEdStatusResponse | null, nowMs: number): BannerView {
  const ev = status?.event
  if (!ev || !ev.startDate || !ev.endDate) return HIDDEN

  const cd = formatCountdown(nowMs, ev.startDate, ev.endDate)
  if (cd.phase === 'invalid') return HIDDEN

  const start = Date.parse(ev.startDate)
  const s = fmtDay(ev.startDate)
  const e = fmtDay(ev.endDate)
  const window = s && e ? `${s} – ${e}` : ''

  if (cd.phase === 'before') {
    return { show: true, phase: 'before', message: `Starts in ${formatDuration(start - nowMs)}`, window }
  }
  if (cd.phase === 'during') {
    return { show: true, phase: 'during', message: 'Live now — join the free virtual event', window }
  }
  // 'ended' → banner persists, promoting the replays.
  return { show: true, phase: 'after', message: 'Watch the replays', window }
}
