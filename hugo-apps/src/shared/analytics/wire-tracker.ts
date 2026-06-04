// hugo-apps/src/shared/analytics/wire-tracker.ts
// Orchestrator. Call once per page after Vue mount completes.
// surface = '/', '/browse/', or '/tutorials/' — must match server allowlist.

import { init as initTracker } from './tracker'
import { wirePageEvents } from './page-events'
import { wireCardEvents } from './card-events'
import type { Surface } from './events'

export interface WireTrackerOpts {
  surface: Surface
  filters?: any  // useNavigatorFilters return value (for filter-events); optional on /tutorials/
}

export function wireTracker(opts: WireTrackerOpts) {
  if (typeof window === 'undefined') return
  const buildAt = (window as any).__BROWSE_BUILD_AT ?? ''
  initTracker({ surface: opts.surface, buildAt })
  wirePageEvents(opts.surface)
  wireCardEvents(opts.surface)
  if (opts.filters) {
    // Lazy import to avoid pulling Vue into /tutorials/ bundle
    import('./filter-events').then(({ wireFilterEvents }) => {
      wireFilterEvents({ filters: opts.filters, surface: opts.surface })
    })
  }
}
