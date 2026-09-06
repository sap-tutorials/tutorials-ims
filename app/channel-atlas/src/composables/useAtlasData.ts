import { ref, computed } from 'vue'
import type { Ref, ComputedRef } from 'vue'
import type { AtlasPayload } from '../types.js'

/**
 * Loads the channel-atlas payload.
 *
 * Priority:
 *  1. Inline <script type="application/json" id="atlas-payload"> element
 *     injected by hugo/layouts/channels/atlas.html at Hugo build time.
 *     Avoids a network round-trip in production.
 *  2. Runtime fetch from GET /build/channel-atlas
 *     (dev mode via Vite proxy, or when inline element is absent).
 *
 * Fail-open: any error sets `error` and leaves `payload` null.
 * The App.vue renders an empty-state message when hasData is false.
 */
export function useAtlasData(): {
  payload: Ref<AtlasPayload | null>
  hasData: ComputedRef<boolean>
  error: Ref<Error | null>
} {
  const payload = ref<AtlasPayload | null>(null)
  const error   = ref<Error | null>(null)
  const hasData = computed(() => !!payload.value)

  async function loadData() {
    try {
      // 1. Inline payload (injected by Hugo layout — no round-trip in production).
      if (typeof document !== 'undefined') {
        const inline = document.getElementById('atlas-payload')
        if (inline?.textContent) {
          const parsed = JSON.parse(inline.textContent) as AtlasPayload
          // A build-time fetch failure is inlined as { channels:[], error }.
          // Surface it as a load error instead of an empty-filter state.
          if (parsed.error) {
            error.value = new Error(parsed.error)
          } else {
            payload.value = parsed
          }
          return
        }
      }
      // 2. Fallback: fetch from the live CAP endpoint.
      //    In dev: Vite proxies /build/channel-atlas → http://localhost:4004.
      //    In production: approuter routes it to srv-api (authenticationType: none).
      const r = await fetch('/build/channel-atlas')
      if (!r.ok) {
        error.value = new Error(`HTTP ${r.status}`)
        return
      }
      payload.value = (await r.json()) as AtlasPayload
    } catch (err) {
      console.error('[channel-atlas] failed to load data', err)
      error.value = err instanceof Error ? err : new Error(String(err))
    }
  }

  // Only runs in browser context — SSR/unit env guard matches explore's pattern.
  if (typeof window !== 'undefined') {
    loadData()
  }

  return { payload, hasData, error }
}
