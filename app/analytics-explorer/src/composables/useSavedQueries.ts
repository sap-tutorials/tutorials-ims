import { ref } from 'vue'
import { csrfFetch } from '../api/csrf-fetch'
import type { QuerySpec } from '../types/query-spec'

export interface SavedRow {
  ID: string
  name: string
  description: string | null
  sql: string
  spec: string | null
  visibility: 'private' | 'shared-admins'
  rowCount: number | null
  durationMs: number | null
  truncated: boolean
  privacyMode: 'raw' | 'k-anon'
  createdBy: string
  createdAt: string
  lastRunAt: string | null
}

export interface SaveAsInput {
  name: string
  description: string
  sql: string
  spec: string | null
  visibility: 'private' | 'shared-admins'
}

const COLLECTION = '/admin/analytics/SavedQueries'

function entityKeyUrl(id: string): string {
  // OData v4 single-key URL. CAP accepts the quoted-string form for UUIDs:
  //   /admin/analytics/SavedQueries(ID='abc-123')
  // The unquoted form (ID=abc-123) works with some clients but not reliably
  // with CAP's OData router for typed Edm.Guid; always quote the value.
  return `${COLLECTION}(ID='${encodeURIComponent(id)}')`
}

async function jsonFetch(url: string, init: RequestInit = {}): Promise<any> {
  const r = await csrfFetch(url, {
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(init.headers || {}) },
    ...init,
  })
  if (!r.ok) {
    const text = await r.text().catch(() => '')
    throw new Error(`useSavedQueries ${r.status}: ${text || 'fetch failed'}`)
  }
  if (r.status === 204) return null
  return r.json()
}

export function useSavedQueries() {
  const rows = ref<SavedRow[]>([])
  const isLoading = ref(false)
  const lastError = ref<string | null>(null)

  async function loadRows(): Promise<void> {
    isLoading.value = true
    lastError.value = null
    try {
      const url = `${COLLECTION}?$orderby=lastRunAt%20desc,createdAt%20desc&$top=200`
      const json = await jsonFetch(url)
      rows.value = (json.value || []) as SavedRow[]
    } catch (e: any) {
      lastError.value = e.message
      throw e
    } finally {
      isLoading.value = false
    }
  }

  async function saveAs(input: SaveAsInput): Promise<SavedRow> {
    const body = {
      name: input.name,
      description: input.description,
      sql: input.sql,
      spec: input.spec,
      visibility: input.visibility,
    }
    return jsonFetch(COLLECTION, { method: 'POST', body: JSON.stringify(body) })
  }

  async function rename(id: string, name: string, description: string): Promise<SavedRow> {
    return jsonFetch(`${entityKeyUrl(id)}/AnalyticsService.rename`, {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    })
  }

  async function setVisibility(id: string, visibility: 'private' | 'shared-admins'): Promise<SavedRow> {
    return jsonFetch(`${entityKeyUrl(id)}/AnalyticsService.setVisibility`, {
      method: 'POST',
      body: JSON.stringify({ visibility }),
    })
  }

  async function duplicate(id: string): Promise<SavedRow> {
    return jsonFetch(`${entityKeyUrl(id)}/AnalyticsService.duplicate`, {
      method: 'POST',
      body: JSON.stringify({}),
    })
  }

  async function recordRun(id: string, rowCount: number, durationMs: number): Promise<SavedRow> {
    return jsonFetch(`${entityKeyUrl(id)}/AnalyticsService.recordRun`, {
      method: 'POST',
      body: JSON.stringify({ rowCount, durationMs }),
    })
  }

  async function remove(id: string): Promise<void> {
    await jsonFetch(entityKeyUrl(id), { method: 'DELETE' })
  }

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

  return {
    rows, isLoading, lastError,
    loadRows, saveAs, rename, setVisibility, duplicate, recordRun, remove,
    parseSpec,
  }
}
