import { watch, type Ref } from 'vue'
import type { ExplorePayload } from '../types'

/**
 * Central telemetry helper for the explore page. Fires kg.explore.viewed
 * exactly once per page load when the graph data first arrives. Other
 * events (node_clicked, node_navigated, search, filter) are dispatched
 * directly by the components that own the user interaction — same pattern
 * as Phase 1.
 *
 * Pre-#744 this fired on mount because the SSR payload was inline via
 * window.__INITIAL_GRAPH__; post-#744 the payload arrives async via
 * useGraphData()'s fetch, so we watch the payload ref and dispatch on
 * the first null → non-null transition.
 *
 * kg.explore.path_drawn is exposed as a module-level dispatcher
 * (dispatchPathDrawn) — matches the pattern used elsewhere in the explore
 * app for component-owned events. Called by App.vue after fetchPath()
 * returns a non-empty result.
 */

// Module-level guard: kg.explore.viewed is a "page-view" event and should fire
// exactly once per page load, even if multiple components call useTelemetry().
let viewedDispatched = false

export function useTelemetry(opts: { payload: Ref<ExplorePayload | null> }) {
  if (typeof window === 'undefined') return
  // Fire kg.explore.viewed once when the graph data first arrives. `immediate`
  // covers the case where the payload is already populated at setup (e.g. a
  // future caller pre-fills the ref synchronously). We can't call stop()
  // inline because `immediate: true` invokes the callback synchronously
  // during `watch()` initialization — before `stop` is assigned (TDZ). The
  // module-level `viewedDispatched` guard prevents re-firing; we still stop
  // the watcher async to free its reactive deps.
  let stop: (() => void) | null = null
  stop = watch(
    opts.payload,
    (p) => {
      if (!p || viewedDispatched) return
      viewedDispatched = true
      const nodeCount = p.nodes.length
      const edgeCount = p.edges.length
      window.dispatchEvent(new CustomEvent('kg.explore.viewed', {
        detail: { nodeCount, edgeCount },
      }))
      // Defer stop() so it survives the `immediate: true` synchronous-init path.
      queueMicrotask(() => stop?.())
    },
    { immediate: true },
  )
}

/**
 * Fire kg.explore.path_drawn — emitted once per successful find-path
 * overlay render. detail.stepCount counts the steps actually drawn
 * (i.e. after server-side dedup), not the slugs the user typed.
 */
export function dispatchPathDrawn(detail: { from: string; to: string; stepCount: number }) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('kg.explore.path_drawn', { detail }))
}

/** Test hook to reset the one-shot guard between tests. */
export function _resetTelemetry() {
  viewedDispatched = false
}
