import { ref, computed } from 'vue'
import type { ExplorePayload } from '../types'

// Fetches the bulk graph payload from /graph/explore-data on mount.
// Pre-#744 this composable also accepted an inline payload via
// window.__INITIAL_GRAPH__ (SSR-injected by the standalone srv template).
// That code path is gone — /explore/ is now a Hugo page with no SSR.

export function useGraphData() {
  const payload = ref<ExplorePayload | null>(null)
  const error = ref<Error | null>(null)
  const hasData = computed(() => !!payload.value)

  async function fetchAsync() {
    try {
      const r = await fetch('/graph/explore-data')
      if (!r.ok) {
        error.value = new Error(`HTTP ${r.status}`)
        return
      }
      payload.value = await r.json()
    } catch (err) {
      console.error('[explore] failed to fetch graph data', err)
      error.value = err instanceof Error ? err : new Error(String(err))
    }
  }

  if (typeof window !== 'undefined') {
    fetchAsync()
  }

  return { payload, hasData, error }
}
