import { onMounted } from 'vue'

/**
 * Central telemetry helper for the explore page. Fires kg.explore.viewed
 * once on mount with the initial graph size. Other events (node_clicked,
 * node_navigated, search, filter) are dispatched directly by the components
 * that own the user interaction — same pattern as Phase 1.
 *
 * kg.explore.path_drawn is exposed as a module-level dispatcher
 * (dispatchPathDrawn) — matches the pattern used elsewhere in the explore
 * app for component-owned events. Called by App.vue after fetchPath()
 * returns a non-empty result.
 */

// Module-level guard: kg.explore.viewed is a "page-view" event and should fire
// exactly once per page load, even if multiple components call useTelemetry().
let viewedDispatched = false

export function useTelemetry() {
  onMounted(() => {
    if (typeof window === 'undefined') return
    if (viewedDispatched) return
    viewedDispatched = true
    const initial = window.__INITIAL_GRAPH__
    const nodeCount = initial?.nodes.length ?? 0
    const edgeCount = initial?.edges.length ?? 0
    window.dispatchEvent(new CustomEvent('kg.explore.viewed', {
      detail: { nodeCount, edgeCount },
    }))
  })
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
