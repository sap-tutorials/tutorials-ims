import { ref } from 'vue'
import type { QuerySpec } from '../types/query-spec'

export interface HistoryRow {
  ID: string
  sql: string
  spec: string | null
  createdAt: string
  source: 'builder' | 'editor' | 'joule' | 'replay'
  rowCount: number | null
  durationMs: number | null
  truncated: boolean
  privacyMode: 'raw' | 'k-anon'
}

const HISTORY_URL =
  '/admin/analytics/QueryHistory?$orderby=createdAt%20desc&$top=200'

export function useHistory() {
  const rows = ref<HistoryRow[]>([])
  const isLoading = ref(false)
  const lastError = ref<string | null>(null)

  async function loadRows(): Promise<void> {
    isLoading.value = true
    lastError.value = null
    try {
      const r = await fetch(HISTORY_URL, { headers: { Accept: 'application/json' } })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        throw new Error(`useHistory ${r.status}: ${text || 'fetch failed'}`)
      }
      const json = await r.json()
      rows.value = (json.value || []) as HistoryRow[]
    } catch (e: any) {
      lastError.value = e.message
      throw e
    } finally {
      isLoading.value = false
    }
  }

  /**
   * Best-effort QuerySpec parse. Returns null if the string is null/empty
   * or not valid v1 JSON. Callers fall back to "SQL-only load" in that case.
   */
  function parseSpec(spec: string | null | undefined): QuerySpec | null {
    if (!spec) return null
    try {
      const parsed = JSON.parse(spec)
      if (parsed && parsed.version === 1) return parsed as QuerySpec
      return null
    } catch {
      return null
    }
  }

  return { rows, isLoading, lastError, loadRows, parseSpec }
}
