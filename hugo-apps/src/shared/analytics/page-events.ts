// hugo-apps/src/shared/analytics/page-events.ts
//
// Wires page_view (immediate), page_leave (pagehide + beacon flush), and
// scroll_depth (25/50/75/100% thresholds, fired once each per page-view) to
// the tracker.
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md (#204)

import { track, flush } from './tracker'

let wired = false
let pageLoadTime = 0
let eventCount = 0
const firedThresholds = new Set<number>()
let pagehideListener: (() => void) | null = null
let scrollListener: (() => void) | null = null

function computePercent(): number {
  const scrollHeight = document.documentElement.scrollHeight || document.body.scrollHeight || 0
  const innerHeight = window.innerHeight || 0
  const scrollY = window.scrollY || 0
  if (scrollHeight <= 0) return 0
  return Math.min(100, Math.round(((scrollY + innerHeight) / scrollHeight) * 100))
}

function onScroll() {
  const pct = computePercent()
  for (const threshold of [25, 50, 75, 100] as const) {
    if (pct >= threshold && !firedThresholds.has(threshold)) {
      firedThresholds.add(threshold)
      eventCount += 1
      track('scroll_depth', { maxPercent: threshold })
    }
  }
}

function onPagehide() {
  eventCount += 1
  track('page_leave', {
    durationMs: Date.now() - pageLoadTime,
    eventCount,
  })
  flush({ via: 'beacon' })
}

export function wirePageEvents(_surface: string) {
  // page_view fires on every call — even if listeners are already wired —
  // because callers (e.g. SPA navigation) may legitimately want a fresh view.
  pageLoadTime = Date.now()
  eventCount = 1 // count the page_view itself
  firedThresholds.clear()
  track('page_view', {
    path: typeof location !== 'undefined' ? location.pathname : '',
    referrer: typeof document !== 'undefined' ? document.referrer : '',
  })

  if (wired) return
  wired = true
  pagehideListener = onPagehide
  scrollListener = onScroll
  window.addEventListener('pagehide', pagehideListener)
  window.addEventListener('scroll', scrollListener, { passive: true })
}

export function _resetForTests() {
  if (pagehideListener) window.removeEventListener('pagehide', pagehideListener)
  if (scrollListener) window.removeEventListener('scroll', scrollListener)
  pagehideListener = null
  scrollListener = null
  wired = false
  pageLoadTime = 0
  eventCount = 0
  firedThresholds.clear()
}
