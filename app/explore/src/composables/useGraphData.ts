import { ref, computed } from 'vue'
import type { ExplorePayload } from '../types'

export function useGraphData() {
  // Server-rendered HTML inlines the JSON; read synchronously.
  const payload = ref<ExplorePayload | null>(window.__INITIAL_GRAPH__ ?? null)
  const hasData = computed(() => !!payload.value)

  // Fallback: if HTML wasn't server-rendered (e.g., dev server), fetch.
  async function fetchAsync() {
    const r = await fetch('/graph/explore-data')
    if (r.ok) payload.value = await r.json()
  }

  if (!payload.value) fetchAsync()

  return { payload, hasData }
}
