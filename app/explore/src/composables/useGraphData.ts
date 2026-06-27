import { ref, computed } from 'vue'
import type { ExplorePayload } from '../types'

export function useGraphData() {
  // SSR / no-window guard
  const initial = typeof window !== 'undefined' ? window.__INITIAL_GRAPH__ : null
  const payload = ref<ExplorePayload | null>(initial ?? null)
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

  if (!payload.value && typeof window !== 'undefined') {
    fetchAsync()
  }

  return { payload, hasData, error }
}
