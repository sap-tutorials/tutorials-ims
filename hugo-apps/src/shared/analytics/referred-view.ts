// hugo-apps/src/shared/analytics/referred-view.ts
//
// Fires one `referred_view` event when a same-tab session lands on a
// /tutorials/<slug> page. Closes the click → tutorial-load funnel for the
// / vs /browse/ A/B comparison (#204).
//
// Reads two sessionStorage keys written by other modules:
//   - analytics.sessionId (tracker.ts) — presence proves same-tab origin
//   - analytics.lastClick (card-events.ts) — fromSurface + fromCardId hand-off
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md

import { track, init as initTracker } from './tracker'

const REFERRER_KEY = 'analytics.lastClick'

export function fireReferredView(slug: string) {
  if (typeof window === 'undefined') return
  const buildAt = (window as any).__BROWSE_BUILD_AT ?? ''
  initTracker({ surface: '/tutorials/', buildAt })
  // Only fire if a sessionId is already in storage — means the user came
  // from / or /browse/ in the same tab. New tabs have no prior sessionId.
  let hasExisting = false
  try {
    hasExisting = !!sessionStorage.getItem('analytics.sessionId')
  } catch { /* sessionStorage unavailable */ }
  if (!hasExisting) return
  // Pull last-click context (set by card-events.ts on /, /browse/)
  let lastClick = { fromSurface: '', fromCardId: '' }
  try {
    const raw = sessionStorage.getItem(REFERRER_KEY)
    if (raw) lastClick = JSON.parse(raw)
  } catch { /* ignore */ }
  track('referred_view', {
    tutorialSlug: slug,
    fromSurface: lastClick.fromSurface ?? '',
    fromCardId: lastClick.fromCardId ?? '',
  })
}
