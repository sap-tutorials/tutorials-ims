import { onMounted } from 'vue'

/**
 * Central telemetry helper for the explore page. Fires kg.explore.viewed
 * once on mount with the initial graph size. Other events (node_clicked,
 * node_navigated, search, filter) are dispatched directly by the components
 * that own the user interaction — same pattern as Phase 1.
 *
 * kg.explore.path_drawn is intentionally deferred to Task 5 (find-path wiring).
 */
export function useTelemetry() {
  onMounted(() => {
    if (typeof window === 'undefined') return
    const initial = window.__INITIAL_GRAPH__
    const nodeCount = initial?.nodes.length ?? 0
    const edgeCount = initial?.edges.length ?? 0
    window.dispatchEvent(new CustomEvent('kg.explore.viewed', {
      detail: { nodeCount, edgeCount },
    }))
  })
}
