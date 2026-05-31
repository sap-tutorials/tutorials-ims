# Analytics SQL Builder — Phase 4 (History + Saved Queries Tabs) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add History + Saved Queries tabs to the SQL tab. History auto-records every run (already wired in Phase 1's backend); Saved Queries are admin-curated, named, optionally shared with all admins. Both tabs let the user click a row to load the saved spec back into the chip builder via `useQuerySpec.setSpec`. Save flow lives in a new header bar above the chip row.

**Architecture:** A new `BottomTabs.vue` wraps `ResultsTab` (existing) + new `HistoryTab.vue` + new `SavedTab.vue` as peer tabs in the existing `results-section`. Three small composables: `useHistory`, `useSavedQueries` (CRUD + actions). One backend tweak: extend `runSelectQuery` to accept an optional `spec` parameter so future history rows carry the chip-built spec (Phase 1 wrote `spec: null`; Phase 4 backfills going forward). Saved-query Save button lives in a new `BuilderHeader.vue` row above `ClauseChipBar`. All entities are already shipped (Phase 1 — `AnalyticsQueryHistory`, `AnalyticsSavedQuery` with rename/setVisibility/duplicate/recordRun actions, `@restrict` rules for cross-user safety).

**Tech Stack:** Vue 3 + Vite + TypeScript (`app/analytics-explorer/`); existing UI5 web components for buttons/dialogs; Vitest + happy-dom for tests. Single backend file touched (`srv/analytics-service.js` — extend `runSelectQuery` handler + `analytics-history-writer.js`).

**Spec:** [docs/superpowers/specs/2026-05-31-analytics-sql-builder-design.md](../specs/2026-05-31-analytics-sql-builder-design.md) sections covering History/Saved (4-amend + Phase 1 entity definitions).

**Predecessor:** Phase 3 (PR #146, merged 2026-05-31, commit 43fa1e4). Result virtualization + Table/Chart toggle + drilldown + CSV export are live.

**Branch:** `feat/analytics-builder-phase4-history-saved` (already created from `main` post-merge).

**Conventions used in this plan:**

- All paths repo-relative from `d:\projects\tutorials-poc`.
- All commands assume Bash (Git Bash on Windows). Forward slashes.
- Frontend code is TypeScript / Vue 3 SFC.
- Per-file `// @vitest-environment happy-dom` pragma for component tests.
- TDD discipline: every code task starts with a failing test.
- Each task ends with one focused commit.
- ECharts/ChartTypeSwitcher mocked in component tests where they appear (Phase 3 lesson — happy-dom Canvas limitation).
- OData v4 entity URLs: collection at `/admin/analytics/QueryHistory` and `/admin/analytics/SavedQueries`; single-key access via `(ID=guid'...')` or `?$filter=ID eq <id>` (we use the latter — simpler URL building).
- Response shape from CAP OData: `{ value: [...] }` for collections, plain object for single entity.
- Old history rows (`spec === null`) load SQL only into Monaco + flip mode to `'editor'`. New rows (Phase 4+) load the spec via `useQuerySpec.setSpec(JSON.parse(spec))`.

---

## Phase 4 task list

1. Extend `runSelectQuery` to accept + persist `spec` (TDD; backend)
2. `useHistory` composable — fetch history rows + load helper (TDD)
3. `useSavedQueries` composable — CRUD + rename/setVisibility/duplicate/recordRun + load helper (TDD)
4. `HistoryTab.vue` component (TDD)
5. `SavedTab.vue` component (TDD)
6. `SaveQueryDialog.vue` — modal for name/description/visibility (TDD)
7. `BuilderHeader.vue` — header bar above chip row with Save button (TDD)
8. `BottomTabs.vue` — wraps Results / History / Saved as peer tabs (TDD)
9. Wire `BuilderHeader` into SqlTab + `BottomTabs` replacing direct `ResultsTab` mount
10. End-to-end smoke (build + lint + regression sweep)
11. srv-qa cp-list verification (one srv/ change to verify)
12. Open PR

---

## Task 1: Extend `runSelectQuery` to persist `spec`

**Files:**
- Modify: `srv/analytics-service.js` (handler) — pass `spec` through
- Modify: `srv/lib/analytics-history-writer.js` — accept + write the field
- Modify: `app/analytics-explorer/src/api/sql.ts` — add optional `spec` parameter
- Modify: `app/analytics-explorer/src/components/SqlTab.vue` — pass JSON-stringified spec
- Modify: `srv/__tests__/analytics-history-writer.test.js` if exists, else add `srv/__tests__/run-select-query-spec.test.js`

The Phase 1 history writer always set `spec: null`. Phase 4 extends `runSelectQuery` to accept an optional `spec: String` parameter; the writer persists it verbatim. Backwards compatible — old callers (no `spec` arg) continue to write `null`.

- [ ] **Step 1: Verify branch state**

```bash
git branch --show-current
```

Expected: `feat/analytics-builder-phase4-history-saved`.

- [ ] **Step 2: Write the failing test**

Create `srv/__tests__/run-select-query-spec.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

const { default: AnalyticsService } = await import('../analytics-service.js')  // for type-check; not strictly needed

describe('runSelectQuery — spec parameter (Phase 4)', () => {
  const asAdmin = (srv, fn) =>
    srv.tx({ user: new cds.User.Privileged() }, fn)

  it('writes spec verbatim to AnalyticsQueryHistory when provided', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const db = await cds.connect.to('db')
    const specJson = JSON.stringify({ version: 1, hint: 'phase4-test' })

    const r = await asAdmin(srv, tx => tx.send('runSelectQuery', {
      sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
      source: 'builder',
      spec: specJson,
    }))

    const { AnalyticsQueryHistory } = db.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row.spec).toBe(specJson)
  })

  it('writes spec=null when omitted (back-compat)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const db = await cds.connect.to('db')

    const r = await asAdmin(srv, tx => tx.send('runSelectQuery', {
      sql: 'SELECT ID FROM com_sap_developers_ims_TaskRecords LIMIT 1',
      source: 'editor',
    }))

    const { AnalyticsQueryHistory } = db.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row.spec).toBe(null)
  })
})
```

- [ ] **Step 3: Run to confirm failure**

```bash
npm test -- --project=unit run-select-query-spec
```

Expected: FAIL — first test fails because `spec` is not persisted (handler ignores it; writer always writes null).

- [ ] **Step 4: Update `srv/lib/analytics-history-writer.js`**

```javascript
import cds from '@sap/cds'

const VALID_SOURCES = new Set(['builder', 'editor', 'joule', 'replay'])

export function normalizeSource(s) {
  if (typeof s !== 'string') return 'editor'
  return VALID_SOURCES.has(s) ? s : 'editor'
}

export async function writeHistoryRow({
  user, sql, spec = null, rowCount, durationMs, truncated, source,
}) {
  const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
  const ID = cds.utils.uuid()
  await INSERT.into(AnalyticsQueryHistory).entries({
    ID,
    spec: typeof spec === 'string' ? spec : null,  // accept stringified JSON; null otherwise
    sql,
    rowCount,
    durationMs,
    truncated: !!truncated,
    privacyMode: 'raw',
    source: normalizeSource(source),
    createdBy: user,
    createdAt: new Date().toISOString(),
  })
  return ID
}
```

- [ ] **Step 5: Update `srv/analytics-service.js` handler**

Find the `writeHistoryRow` call inside `this.on('runSelectQuery', ...)`:

```javascript
const historyId = await writeHistoryRow({
  user: req.user.id,
  sql,
  rowCount: data.length,
  durationMs,
  truncated,
  source: req.data.source,
})
```

Replace with (add `spec` from req.data):

```javascript
const historyId = await writeHistoryRow({
  user: req.user.id,
  sql,
  spec: req.data.spec,  // optional JSON-stringified QuerySpec; null if omitted
  rowCount: data.length,
  durationMs,
  truncated,
  source: req.data.source,
})
```

- [ ] **Step 6: Update `srv/analytics-service.cds` action signature**

Find the `runSelectQuery` action declaration. Phase 1's signature is `action runSelectQuery(sql : String, source : String) returns ...`. Add `spec`:

```cds
action runSelectQuery(sql : String, source : String, spec : String) returns ...
```

(No return-shape changes; just the input.)

- [ ] **Step 7: Run the tests to confirm they pass**

```bash
npm test -- --project=unit run-select-query-spec
```

Expected: 2 PASS.

- [ ] **Step 8: Update the frontend `runSelectQuery` wrapper**

Edit `app/analytics-explorer/src/api/sql.ts`. Update the function signature:

```typescript
export async function runSelectQuery(
  sql: string,
  source: 'builder' | 'editor' | 'joule' | 'replay' = 'editor',
  spec?: string,  // optional JSON-stringified QuerySpec
): Promise<SqlResult> {
  const r = await fetch('/admin/analytics/runSelectQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sql, source, ...(spec ? { spec } : {}) }),
  })
  // ... rest unchanged
}
```

- [ ] **Step 9: Update SqlTab.vue's `runFromChips` to pass the spec**

In `app/analytics-explorer/src/components/SqlTab.vue`, find the `runFromChips` function. Update the `runSelectQuery` call to pass JSON-stringified spec:

```typescript
async function runFromChips() {
  if (!spec.value) return
  try {
    const sql = specToSql(spec.value, entityGraph.sqlNames.value)
    const r = await runSelectQuery(sql, 'builder', JSON.stringify(spec.value))
    lastResults.value = r
  } catch (e: any) {
    console.warn('[SqlTab] runFromChips failed:', e.message)
  }
}
```

- [ ] **Step 10: Verify build + run-envelope test still passes**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -3 && cd ../..
npm test -- --project=unit run-select-query-spec
npm test -- --project=unit run-envelope
```

Expected: build green; spec test green; existing envelope test green.

- [ ] **Step 11: Commit**

```bash
git add srv/lib/analytics-history-writer.js srv/analytics-service.js srv/analytics-service.cds srv/__tests__/run-select-query-spec.test.js app/analytics-explorer/src/api/sql.ts app/analytics-explorer/src/components/SqlTab.vue
git commit -m "feat(analytics): persist QuerySpec on history rows (Phase 4 prep)

Phase 1's analytics-history-writer always wrote spec=null because the
chip builder didn't exist yet. Phase 4 needs the spec on history rows
so 'Load from history' can restore the chip state, not just paste SQL
into Monaco.

Changes:
- runSelectQuery action gains optional 'spec : String' param
- writeHistoryRow accepts the param + writes it verbatim (or null)
- frontend runSelectQuery() takes optional 3rd arg, JSON-stringified
- runFromChips in SqlTab passes JSON.stringify(spec.value)

Back-compat: omitting spec writes null (existing callers unchanged).
Old Phase 1-3 history rows have spec=null — Phase 4's history loader
handles that with an SQL-only fallback (paste into editor + flip
mode to 'editor')."
```

---

## Task 2: `useHistory` composable (TDD)

**Files:**
- Create: `app/analytics-explorer/src/composables/useHistory.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useHistory.test.ts`

Loads history rows via OData GET; exposes a `loadHistoryRow(row)` helper that either restores the spec via `useQuerySpec.setSpec` (when `spec` is non-null) or pastes the SQL into the editor (when `spec` is null).

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/composables/__tests__/useHistory.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

const { useHistory } = await import('../useHistory')

describe('useHistory', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('loadRows fetches /admin/analytics/QueryHistory ordered desc by createdAt', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [
        { ID: 'h1', sql: 'SELECT 1', spec: null, createdAt: '2026-05-30T10:00:00Z', source: 'editor', rowCount: 1, durationMs: 10, truncated: false, privacyMode: 'raw' },
        { ID: 'h2', sql: 'SELECT 2', spec: '{}', createdAt: '2026-05-29T10:00:00Z', source: 'builder', rowCount: 2, durationMs: 20, truncated: false, privacyMode: 'raw' },
      ] }),
    } as any)
    const h = useHistory()
    await h.loadRows()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/admin/analytics/QueryHistory')
    expect(url).toContain('$orderby=createdAt%20desc')
    expect(h.rows.value.length).toBe(2)
    expect(h.rows.value[0].ID).toBe('h1')
  })

  it('loadRows surfaces fetch errors via lastError ref', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'oops' } as any)
    const h = useHistory()
    await expect(h.loadRows()).rejects.toThrow(/500|oops/)
    expect(h.lastError.value).toBeTruthy()
  })

  it('parseSpec returns the parsed QuerySpec when spec is non-null JSON', () => {
    const h = useHistory()
    const parsed = h.parseSpec('{"version":1,"from":{"entity":"X","alias":"x"}}')
    expect(parsed).toEqual({ version: 1, from: { entity: 'X', alias: 'x' } })
  })

  it('parseSpec returns null for null/empty/invalid input', () => {
    const h = useHistory()
    expect(h.parseSpec(null)).toBe(null)
    expect(h.parseSpec('')).toBe(null)
    expect(h.parseSpec('not json')).toBe(null)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit useHistory
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useHistory`**

Create `app/analytics-explorer/src/composables/useHistory.ts`:

```typescript
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
   * or not valid JSON. Callers fall back to "SQL-only load" in that case.
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
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm test -- --project=unit useHistory
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/composables/useHistory.ts app/analytics-explorer/src/composables/__tests__/useHistory.test.ts
git commit -m "feat(analytics-explorer): useHistory composable

Loads /admin/analytics/QueryHistory ordered by createdAt desc (top 200).
parseSpec helper returns a typed QuerySpec when the row's spec field
is non-null v1 JSON; returns null for nullable/empty/invalid input so
callers can fall back to SQL-only load (Phase 1 history rows have
spec=null and need to paste SQL into Monaco instead).

4 tests covering: GET URL shape + ordering, error -> lastError,
parseSpec valid path, parseSpec null/empty/invalid path."
```

---

## Task 3: `useSavedQueries` composable (TDD)

**Files:**
- Create: `app/analytics-explorer/src/composables/useSavedQueries.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useSavedQueries.test.ts`

CRUD + rename/setVisibility/duplicate/recordRun + reuse `parseSpec` from useHistory (or duplicate it).

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/composables/__tests__/useSavedQueries.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

const { useSavedQueries } = await import('../useSavedQueries')

describe('useSavedQueries', () => {
  beforeEach(() => {
    fetchMock.mockReset()
  })

  it('loadRows fetches /admin/analytics/SavedQueries ordered desc by lastRunAt then createdAt', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ value: [
        { ID: 's1', name: 'Top events', sql: 'SELECT 1', spec: null, visibility: 'private', createdAt: '2026-05-30T10:00:00Z', lastRunAt: null, createdBy: 'tom@test', description: '' },
      ] }),
    } as any)
    const sq = useSavedQueries()
    await sq.loadRows()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const url = fetchMock.mock.calls[0][0] as string
    expect(url).toContain('/admin/analytics/SavedQueries')
    expect(url).toContain('$orderby=')
    expect(sq.rows.value.length).toBe(1)
  })

  it('saveAs POSTs to the SavedQueries collection with name/spec/sql/visibility', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ID: 'new-id', name: 'My query', visibility: 'private' }),
    } as any)
    const sq = useSavedQueries()
    const created = await sq.saveAs({
      name: 'My query', description: '', sql: 'SELECT 1', spec: '{}', visibility: 'private',
    })
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/admin/analytics/SavedQueries')
    expect(init.method).toBe('POST')
    const body = JSON.parse(init.body)
    expect(body.name).toBe('My query')
    expect(body.visibility).toBe('private')
    expect(created.ID).toBe('new-id')
  })

  it('rename calls the bound action endpoint with name + description', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ID: 's1', name: 'Renamed' }),
    } as any)
    const sq = useSavedQueries()
    await sq.rename('s1', 'Renamed', 'desc')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain("/admin/analytics/SavedQueries(ID=")
    expect(url).toContain('/AnalyticsService.rename')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ name: 'Renamed', description: 'desc' })
  })

  it('setVisibility calls the action endpoint', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) } as any)
    const sq = useSavedQueries()
    await sq.setVisibility('s1', 'shared-admins')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toContain('/AnalyticsService.setVisibility')
    expect(JSON.parse(init.body)).toEqual({ visibility: 'shared-admins' })
  })

  it('duplicate calls the action with empty body', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ ID: 'new-id' }) } as any)
    const sq = useSavedQueries()
    const r = await sq.duplicate('s1')
    expect(r.ID).toBe('new-id')
  })

  it('remove calls DELETE on the entity', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 204 } as any)
    const sq = useSavedQueries()
    await sq.remove('s1')
    const [url, init] = fetchMock.mock.calls[0]
    expect(init.method).toBe('DELETE')
    expect(url).toContain("/admin/analytics/SavedQueries(ID=")
  })

  it('parseSpec returns parsed when valid v1 JSON', () => {
    const sq = useSavedQueries()
    expect(sq.parseSpec('{"version":1,"from":{"entity":"X"}}')).toEqual({ version: 1, from: { entity: 'X' } })
    expect(sq.parseSpec(null)).toBe(null)
    expect(sq.parseSpec('not json')).toBe(null)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit useSavedQueries
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useSavedQueries`**

Create `app/analytics-explorer/src/composables/useSavedQueries.ts`:

```typescript
import { ref } from 'vue'
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
  // OData v4 single-key URL. CAP accepts the key=value form.
  return `${COLLECTION}(ID=${encodeURIComponent(id)})`
}

async function jsonFetch(url: string, init: RequestInit = {}): Promise<any> {
  const r = await fetch(url, {
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
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit useSavedQueries
```

Expected: 7 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/composables/useSavedQueries.ts app/analytics-explorer/src/composables/__tests__/useSavedQueries.test.ts
git commit -m "feat(analytics-explorer): useSavedQueries composable

CRUD + bound actions for AnalyticsService.SavedQueries (Phase 1 backend):
- loadRows: GET ordered by lastRunAt desc, createdAt desc (top 200)
- saveAs: POST collection with name/spec/sql/visibility
- rename / setVisibility / duplicate / recordRun: POST bound action
- remove: DELETE
- parseSpec helper for the spec JSON field

7 tests covering each operation's URL shape + body."
```

---

## Task 4: `HistoryTab.vue` component (TDD)

**Files:**
- Create: `app/analytics-explorer/src/components/results/HistoryTab.vue`
- Create: `app/analytics-explorer/src/components/results/__tests__/HistoryTab.test.ts`

Renders the rows from `useHistory` as a list with timestamp + first 80 chars of SQL + source badge + row-count + privacy badge. Each row has a "Load" button that emits `load` with the row.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/components/results/__tests__/HistoryTab.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const loadRowsSpy = vi.fn(async () => {})
const rowsRef = { value: [] as any[] }
const lastErrorRef = { value: null as string | null }
const isLoadingRef = { value: false }
const parseSpecSpy = vi.fn((s: string | null) => s ? JSON.parse(s) : null)

vi.mock('../../../composables/useHistory', () => ({
  useHistory: () => ({
    rows: rowsRef,
    isLoading: isLoadingRef,
    lastError: lastErrorRef,
    loadRows: loadRowsSpy,
    parseSpec: parseSpecSpy,
  }),
}))

import HistoryTab from '../HistoryTab.vue'

describe('HistoryTab', () => {
  beforeEach(() => {
    loadRowsSpy.mockClear()
    rowsRef.value = []
    lastErrorRef.value = null
  })

  it('calls loadRows on mount', () => {
    mount(HistoryTab)
    expect(loadRowsSpy).toHaveBeenCalled()
  })

  it('renders the rows with sql preview + timestamp', async () => {
    rowsRef.value = [
      { ID: 'h1', sql: 'SELECT id FROM Users LIMIT 10', spec: null, createdAt: '2026-05-30T10:00:00Z', source: 'editor', rowCount: 10, durationMs: 50, truncated: false, privacyMode: 'raw' },
    ]
    const w = mount(HistoryTab)
    await flushPromises()
    expect(w.text()).toContain('SELECT id FROM Users')
    expect(w.text()).toContain('editor')
    expect(w.text().toLowerCase()).toContain('rows')
  })

  it('emits load with the row when Load button is clicked', async () => {
    const r = { ID: 'h1', sql: 'SELECT 1', spec: '{"version":1}', createdAt: '2026-05-30T10:00:00Z', source: 'builder', rowCount: 1, durationMs: 10, truncated: false, privacyMode: 'raw' }
    rowsRef.value = [r]
    const w = mount(HistoryTab)
    await flushPromises()
    await w.find('[data-test="history-load"]').trigger('click')
    expect(w.emitted('load')).toBeTruthy()
    expect(w.emitted('load')![0][0]).toBe(r)
  })

  it('renders the empty state when no rows', () => {
    rowsRef.value = []
    const w = mount(HistoryTab)
    expect(w.text().toLowerCase()).toContain('no history')
  })

  it('renders an error message when lastError is set', () => {
    lastErrorRef.value = 'fetch broken'
    const w = mount(HistoryTab)
    expect(w.text()).toContain('fetch broken')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit HistoryTab
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `HistoryTab.vue`**

Create `app/analytics-explorer/src/components/results/HistoryTab.vue`:

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import { useHistory, type HistoryRow } from '../../composables/useHistory'

const emit = defineEmits<{
  (e: 'load', row: HistoryRow): void
}>()

const { rows, isLoading, lastError, loadRows } = useHistory()

onMounted(() => {
  loadRows().catch(() => { /* error surfaced via lastError ref */ })
})

function shortSql(sql: string): string {
  if (sql.length <= 80) return sql
  return sql.slice(0, 77) + '…'
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="history-tab">
    <div v-if="lastError" class="error">⚠ {{ lastError }}</div>

    <div v-if="isLoading" class="empty">Loading…</div>
    <div v-else-if="rows.length === 0" class="empty">No history yet. Run a query to see it appear here.</div>
    <ul v-else class="rows">
      <li v-for="row in rows" :key="row.ID" class="row">
        <div class="row-main">
          <code class="sql-preview" :title="row.sql">{{ shortSql(row.sql) }}</code>
          <div class="row-meta">
            <span class="ts">{{ fmtDate(row.createdAt) }}</span>
            <span class="source-badge" :class="`source-${row.source}`">{{ row.source }}</span>
            <span class="rows-count">{{ row.rowCount ?? 0 }} rows · {{ row.durationMs ?? 0 }}ms</span>
          </div>
        </div>
        <ui5-button
          data-test="history-load"
          design="Transparent"
          icon="navigation-right-arrow"
          @click="emit('load', row)"
        >Load</ui5-button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.history-tab {
  display: flex; flex-direction: column;
  height: 100%; padding: 0.5rem; overflow-y: auto;
}
.error { color: var(--sapErrorColor); padding: 0.5rem; }
.empty { padding: 2rem; text-align: center; color: var(--sapNeutralTextColor); }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.row:hover { background: var(--sapList_Hover_Background); }
.row-main { flex: 1; min-width: 0; }
.sql-preview {
  display: block;
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-meta {
  display: flex; gap: 0.75rem; align-items: center;
  margin-top: 0.2rem; font-size: 0.7rem; color: var(--sapNeutralTextColor);
}
.source-badge {
  padding: 0.05rem 0.3rem; border-radius: 3px;
  background: var(--sapList_HeaderBackground);
  font-weight: 500;
}
.source-builder { color: var(--sapInformationTextColor, #0a6ed1); }
.source-editor  { color: var(--sapNeutralTextColor); }
.source-joule   { color: var(--sapPositiveTextColor, #2b7d2b); }
.source-replay  { color: var(--sapWarningTextColor, #b06000); }
</style>
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit HistoryTab
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/components/results/HistoryTab.vue app/analytics-explorer/src/components/results/__tests__/HistoryTab.test.ts
git commit -m "feat(analytics-explorer): HistoryTab component

Renders history rows via useHistory: SQL preview (80-char ellipsized) +
timestamp + colored source badge (builder/editor/joule/replay) + row
count + duration. Load button emits 'load' with the full row so the
parent (BottomTabs/SqlTab) can decide whether to setSpec or paste-and-
flip-to-editor based on whether spec is non-null v1 JSON.

5 tests covering: loadRows on mount, row rendering, load emit shape,
empty state, error state."
```

---

## Task 5: `SavedTab.vue` component (TDD)

**Files:**
- Create: `app/analytics-explorer/src/components/results/SavedTab.vue`
- Create: `app/analytics-explorer/src/components/results/__tests__/SavedTab.test.ts`

Lists saved queries; each row has Load + Rename + Visibility-toggle + Duplicate + Delete buttons.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/components/results/__tests__/SavedTab.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

const loadRowsSpy = vi.fn(async () => {})
const removeSpy = vi.fn(async () => {})
const setVisibilitySpy = vi.fn(async () => ({ ID: 's1', visibility: 'shared-admins' }))
const duplicateSpy = vi.fn(async () => ({ ID: 'new-id' }))
const renameSpy = vi.fn(async () => ({ ID: 's1', name: 'New name' }))
const rowsRef = { value: [] as any[] }

vi.mock('../../../composables/useSavedQueries', () => ({
  useSavedQueries: () => ({
    rows: rowsRef,
    isLoading: { value: false },
    lastError: { value: null },
    loadRows: loadRowsSpy,
    rename: renameSpy,
    setVisibility: setVisibilitySpy,
    duplicate: duplicateSpy,
    remove: removeSpy,
    parseSpec: (s: string | null) => s ? JSON.parse(s) : null,
  }),
}))

import SavedTab from '../SavedTab.vue'

const sampleRow = {
  ID: 's1', name: 'Top events', description: 'desc',
  sql: 'SELECT id FROM Events', spec: '{"version":1}', visibility: 'private',
  rowCount: 5, durationMs: 80, truncated: false, privacyMode: 'raw',
  createdBy: 'tom@test', createdAt: '2026-05-30T10:00:00Z', lastRunAt: null,
}

describe('SavedTab', () => {
  beforeEach(() => {
    loadRowsSpy.mockClear()
    removeSpy.mockClear()
    setVisibilitySpy.mockClear()
    duplicateSpy.mockClear()
    renameSpy.mockClear()
    rowsRef.value = []
  })

  it('calls loadRows on mount', () => {
    mount(SavedTab)
    expect(loadRowsSpy).toHaveBeenCalled()
  })

  it('renders rows with name + visibility + sql preview', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    expect(w.text()).toContain('Top events')
    expect(w.text()).toContain('private')
    expect(w.text()).toContain('SELECT id FROM Events')
  })

  it('emits load when Load button is clicked', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-load"]').trigger('click')
    expect(w.emitted('load')).toBeTruthy()
    expect(w.emitted('load')![0][0]).toBe(sampleRow)
  })

  it('toggleVisibility calls setVisibility with the flipped value', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-toggle-visibility"]').trigger('click')
    expect(setVisibilitySpy).toHaveBeenCalledWith('s1', 'shared-admins')
  })

  it('duplicate calls the action + reloads rows', async () => {
    rowsRef.value = [sampleRow]
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-duplicate"]').trigger('click')
    expect(duplicateSpy).toHaveBeenCalledWith('s1')
  })

  it('delete prompts confirm + calls remove + reloads', async () => {
    rowsRef.value = [sampleRow]
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true)
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-delete"]').trigger('click')
    await flushPromises()
    expect(confirmSpy).toHaveBeenCalled()
    expect(removeSpy).toHaveBeenCalledWith('s1')
    confirmSpy.mockRestore()
  })

  it('delete does NOT call remove when confirm returns false', async () => {
    rowsRef.value = [sampleRow]
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const w = mount(SavedTab)
    await flushPromises()
    await w.find('[data-test="saved-delete"]').trigger('click')
    expect(removeSpy).not.toHaveBeenCalled()
    confirmSpy.mockRestore()
  })

  it('renders empty state when no rows', () => {
    rowsRef.value = []
    const w = mount(SavedTab)
    expect(w.text().toLowerCase()).toContain('no saved')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit SavedTab
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SavedTab.vue`**

Create `app/analytics-explorer/src/components/results/SavedTab.vue`:

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import { useSavedQueries, type SavedRow } from '../../composables/useSavedQueries'

const emit = defineEmits<{
  (e: 'load', row: SavedRow): void
}>()

const sq = useSavedQueries()
const { rows, isLoading, lastError, loadRows, setVisibility, duplicate, remove } = sq

onMounted(() => {
  loadRows().catch(() => { /* surfaced via lastError */ })
})

async function toggleVisibility(row: SavedRow) {
  const next = row.visibility === 'private' ? 'shared-admins' : 'private'
  try {
    await setVisibility(row.ID, next)
    await loadRows()
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SavedTab] setVisibility failed:', e.message)
  }
}

async function onDuplicate(row: SavedRow) {
  try {
    await duplicate(row.ID)
    await loadRows()
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SavedTab] duplicate failed:', e.message)
  }
}

async function onDelete(row: SavedRow) {
  if (!window.confirm(`Delete saved query "${row.name}"? This cannot be undone.`)) return
  try {
    await remove(row.ID)
    await loadRows()
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SavedTab] delete failed:', e.message)
  }
}

function shortSql(sql: string): string {
  if (sql.length <= 80) return sql
  return sql.slice(0, 77) + '…'
}
</script>

<template>
  <div class="saved-tab">
    <div v-if="lastError" class="error">⚠ {{ lastError }}</div>

    <div v-if="isLoading" class="empty">Loading…</div>
    <div v-else-if="rows.length === 0" class="empty">
      No saved queries yet. Click "Save" in the chip-bar header to save the current query.
    </div>
    <ul v-else class="rows">
      <li v-for="row in rows" :key="row.ID" class="row">
        <div class="row-main">
          <div class="row-title">
            <strong class="name">{{ row.name }}</strong>
            <span class="vis-badge" :class="`vis-${row.visibility}`">
              {{ row.visibility === 'shared-admins' ? '🔓 shared-admins' : '🔒 private' }}
            </span>
          </div>
          <div v-if="row.description" class="desc">{{ row.description }}</div>
          <code class="sql-preview" :title="row.sql">{{ shortSql(row.sql) }}</code>
        </div>
        <div class="row-actions">
          <ui5-button
            data-test="saved-load"
            design="Emphasized"
            icon="navigation-right-arrow"
            @click="emit('load', row)"
          >Load</ui5-button>
          <ui5-button
            data-test="saved-toggle-visibility"
            design="Transparent"
            :icon="row.visibility === 'private' ? 'unlocked' : 'private'"
            :title="row.visibility === 'private' ? 'Share with all admins' : 'Make private'"
            @click="toggleVisibility(row)"
          />
          <ui5-button
            data-test="saved-duplicate"
            design="Transparent"
            icon="copy"
            title="Duplicate"
            @click="onDuplicate(row)"
          />
          <ui5-button
            data-test="saved-delete"
            design="Negative"
            icon="delete"
            title="Delete"
            @click="onDelete(row)"
          />
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.saved-tab {
  display: flex; flex-direction: column;
  height: 100%; padding: 0.5rem; overflow-y: auto;
}
.error { color: var(--sapErrorColor); padding: 0.5rem; }
.empty { padding: 2rem; text-align: center; color: var(--sapNeutralTextColor); }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
  display: flex; align-items: flex-start; gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.row:hover { background: var(--sapList_Hover_Background); }
.row-main { flex: 1; min-width: 0; }
.row-title { display: flex; align-items: center; gap: 0.5rem; }
.name { font-size: 0.95rem; }
.vis-badge {
  font-size: 0.7rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}
.vis-private      { background: var(--sapList_HeaderBackground); color: var(--sapNeutralTextColor); }
.vis-shared-admins { background: var(--sapPositiveBackground, #ebf5e0); color: var(--sapPositiveTextColor, #2b7d2b); }
.desc { font-size: 0.78rem; color: var(--sapNeutralTextColor); margin-top: 0.2rem; }
.sql-preview {
  display: block;
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.75rem;
  margin-top: 0.3rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions { display: flex; gap: 0.25rem; align-items: center; flex-shrink: 0; }
</style>
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit SavedTab
```

Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/components/results/SavedTab.vue app/analytics-explorer/src/components/results/__tests__/SavedTab.test.ts
git commit -m "feat(analytics-explorer): SavedTab component

Lists saved queries from useSavedQueries with per-row actions:
- Load (emits 'load' with the row)
- Toggle visibility (private <-> shared-admins via setVisibility)
- Duplicate (calls action, reloads list)
- Delete (window.confirm + remove + reload)

8 tests covering: loadRows on mount, row rendering, load emit,
visibility toggle, duplicate, delete with confirm true, delete with
confirm false (no remove call), empty state."
```

---

## Task 6: `SaveQueryDialog.vue` modal (TDD)

**Files:**
- Create: `app/analytics-explorer/src/components/builder/SaveQueryDialog.vue`
- Create: `app/analytics-explorer/src/components/builder/__tests__/SaveQueryDialog.test.ts`

Modal for entering name / description / visibility on save.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/components/builder/__tests__/SaveQueryDialog.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import SaveQueryDialog from '../SaveQueryDialog.vue'

describe('SaveQueryDialog', () => {
  it('renders the dialog when open=true', () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    expect(w.text()).toContain('Save query')
  })

  it('does not render when open=false', () => {
    const w = mount(SaveQueryDialog, { props: { open: false } })
    // The dialog body is rendered but the ui5-dialog hides itself when open=false.
    // We verify by checking that fields aren't visible (ui5-dialog handles visibility internally).
    expect(w.text()).not.toContain('Save query')
  })

  it('emits save with the form values when Save clicked + name is non-empty', async () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    // Use the exposed test helper to drive form input directly (ui5-input is hard to drive).
    ;(w.vm as any).draftName = 'My query'
    ;(w.vm as any).draftDescription = 'desc'
    ;(w.vm as any).draftVisibility = 'shared-admins'
    await (w.vm as any).onSave()
    expect(w.emitted('save')).toBeTruthy()
    expect(w.emitted('save')![0][0]).toEqual({
      name: 'My query', description: 'desc', visibility: 'shared-admins',
    })
  })

  it('does NOT emit save when name is empty', async () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    ;(w.vm as any).draftName = ''
    await (w.vm as any).onSave()
    expect(w.emitted('save')).toBeFalsy()
  })

  it('emits cancel when Cancel clicked', async () => {
    const w = mount(SaveQueryDialog, { props: { open: true } })
    await (w.vm as any).onCancel()
    expect(w.emitted('cancel')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit SaveQueryDialog
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `SaveQueryDialog.vue`**

Create `app/analytics-explorer/src/components/builder/SaveQueryDialog.vue`:

```vue
<script setup lang="ts">
import { ref, watch } from 'vue'
import '@ui5/webcomponents/dist/Dialog.js'
import '@ui5/webcomponents/dist/Button.js'

const props = defineProps<{
  open: boolean
}>()

const emit = defineEmits<{
  (e: 'save', payload: { name: string; description: string; visibility: 'private' | 'shared-admins' }): void
  (e: 'cancel'): void
}>()

const draftName = ref('')
const draftDescription = ref('')
const draftVisibility = ref<'private' | 'shared-admins'>('private')

// Reset form when dialog opens.
watch(() => props.open, (open) => {
  if (open) {
    draftName.value = ''
    draftDescription.value = ''
    draftVisibility.value = 'private'
  }
})

function onSave() {
  if (!draftName.value.trim()) return  // gate: name required
  emit('save', {
    name: draftName.value.trim(),
    description: draftDescription.value.trim(),
    visibility: draftVisibility.value,
  })
}

function onCancel() {
  emit('cancel')
}

defineExpose({ onSave, onCancel, draftName, draftDescription, draftVisibility })
</script>

<template>
  <ui5-dialog v-if="open" :open="open" header-text="Save query">
    <div class="dialog-body">
      <label>
        <span class="form-label">Name *</span>
        <input v-model="draftName" type="text" class="form-input" required />
      </label>
      <label>
        <span class="form-label">Description</span>
        <textarea v-model="draftDescription" class="form-textarea" rows="2" />
      </label>
      <fieldset class="vis-group">
        <legend class="form-label">Visibility</legend>
        <label><input type="radio" v-model="draftVisibility" value="private" /> Private</label>
        <label><input type="radio" v-model="draftVisibility" value="shared-admins" /> Shared with admins</label>
      </fieldset>
    </div>
    <div slot="footer" class="dialog-footer">
      <ui5-button design="Transparent" @click="onCancel">Cancel</ui5-button>
      <ui5-button design="Emphasized" :disabled="!draftName.trim()" @click="onSave">Save</ui5-button>
    </div>
  </ui5-dialog>
</template>

<style scoped>
.dialog-body { display: flex; flex-direction: column; gap: 0.6rem; padding: 1rem; min-width: 24rem; }
.form-label { font-size: 0.78rem; color: var(--sapContent_LabelColor); margin-bottom: 0.2rem; display: block; }
.form-input, .form-textarea {
  width: 100%; padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px; font: inherit;
}
.vis-group { border: none; padding: 0; margin: 0; display: flex; gap: 1rem; }
.vis-group legend { width: 100%; }
.dialog-footer { display: flex; justify-content: flex-end; gap: 0.5rem; padding: 0.5rem; }
</style>
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit SaveQueryDialog
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/components/builder/SaveQueryDialog.vue app/analytics-explorer/src/components/builder/__tests__/SaveQueryDialog.test.ts
git commit -m "feat(analytics-explorer): SaveQueryDialog modal

ui5-dialog with name (required) / description (optional) / visibility
(private | shared-admins) form. Emits 'save' with the trimmed values
when Save is clicked + name is non-empty; emits 'cancel' otherwise.
Form resets on every open.

5 tests covering: open render, closed render, save with all fields,
no-emit when name empty, cancel emit."
```

---

## Task 7: `BuilderHeader.vue` — header bar above chips (TDD)

**Files:**
- Create: `app/analytics-explorer/src/components/builder/BuilderHeader.vue`
- Create: `app/analytics-explorer/src/components/builder/__tests__/BuilderHeader.test.ts`

A small header row above ClauseChipBar with: query title (entity name) + Save button. Clicking Save opens the SaveQueryDialog and on success calls `useSavedQueries.saveAs`.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/components/builder/__tests__/BuilderHeader.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const saveAsSpy = vi.fn(async (input: any) => ({ ID: 'new', ...input }))
vi.mock('../../../composables/useSavedQueries', () => ({
  useSavedQueries: () => ({
    saveAs: saveAsSpy,
  }),
}))

const specRef = ref<any>(null)
vi.mock('../../../composables/useQuerySpec', () => ({
  useQuerySpec: () => ({ spec: specRef }),
}))

const sqlNamesRef = ref<Record<string, string>>({})
vi.mock('../../../composables/useEntityGraph', () => ({
  useEntityGraph: () => ({ sqlNames: sqlNamesRef }),
}))

vi.mock('@srv-lib/spec-to-sql.mjs', () => ({
  specToSql: () => 'SELECT 1',
}))

import BuilderHeader from '../BuilderHeader.vue'

describe('BuilderHeader', () => {
  beforeEach(() => {
    saveAsSpy.mockClear()
    specRef.value = null
  })

  it('renders the empty state when no spec', () => {
    specRef.value = null
    const w = mount(BuilderHeader)
    expect(w.text()).toContain('No query yet')
  })

  it('renders query title and Save button when spec exists', () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    expect(w.text()).toContain('Tasks')
    expect(w.find('[data-test="save-query"]').exists()).toBe(true)
  })

  it('Save button is disabled when no spec', () => {
    specRef.value = null
    const w = mount(BuilderHeader)
    const btn = w.find('[data-test="save-query"]')
    if (btn.exists()) {
      expect(btn.attributes('disabled')).toBeDefined()
    }
  })

  it('opens the SaveQueryDialog on Save click', async () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    expect((w.vm as any).dialogOpen).toBe(false)
    await w.find('[data-test="save-query"]').trigger('click')
    expect((w.vm as any).dialogOpen).toBe(true)
  })

  it('onDialogSave calls saveAs with name/description/visibility/sql/spec', async () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    await (w.vm as any).onDialogSave({ name: 'X', description: 'd', visibility: 'private' })
    await flushPromises()
    expect(saveAsSpy).toHaveBeenCalled()
    const arg = saveAsSpy.mock.calls[0][0]
    expect(arg.name).toBe('X')
    expect(arg.description).toBe('d')
    expect(arg.visibility).toBe('private')
    expect(arg.sql).toBe('SELECT 1')
    expect(arg.spec).toBe(JSON.stringify(specRef.value))
  })

  it('emits "saved" event after successful save', async () => {
    specRef.value = { version: 1, from: { entity: 'Tasks', alias: 't' } }
    const w = mount(BuilderHeader)
    await (w.vm as any).onDialogSave({ name: 'X', description: '', visibility: 'private' })
    await flushPromises()
    expect(w.emitted('saved')).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit BuilderHeader
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `BuilderHeader.vue`**

Create `app/analytics-explorer/src/components/builder/BuilderHeader.vue`:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import SaveQueryDialog from './SaveQueryDialog.vue'
import { useQuerySpec } from '../../composables/useQuerySpec'
import { useEntityGraph } from '../../composables/useEntityGraph'
import { useSavedQueries } from '../../composables/useSavedQueries'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'

const emit = defineEmits<{
  (e: 'saved'): void
}>()

const { spec } = useQuerySpec()
const { sqlNames } = useEntityGraph()
const { saveAs } = useSavedQueries()

const dialogOpen = ref(false)
const isSaving = ref(false)

const queryTitle = computed(() => spec.value?.from.entity || '')

function openDialog() {
  if (!spec.value) return
  dialogOpen.value = true
}

function onDialogCancel() {
  dialogOpen.value = false
}

async function onDialogSave(payload: { name: string; description: string; visibility: 'private' | 'shared-admins' }) {
  if (!spec.value) return
  isSaving.value = true
  try {
    let sql = ''
    try { sql = specToSql(spec.value, sqlNames.value) } catch { /* spec invalid; sql stays empty */ }
    await saveAs({
      name: payload.name,
      description: payload.description,
      visibility: payload.visibility,
      sql,
      spec: JSON.stringify(spec.value),
    })
    dialogOpen.value = false
    emit('saved')
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[BuilderHeader] saveAs failed:', e.message)
  } finally {
    isSaving.value = false
  }
}

defineExpose({ dialogOpen, onDialogSave })
</script>

<template>
  <div class="builder-header" v-if="spec">
    <div class="title-row">
      <strong class="query-title">{{ queryTitle }}</strong>
    </div>
    <div class="actions">
      <ui5-button
        data-test="save-query"
        design="Transparent"
        icon="save"
        :disabled="!spec || isSaving"
        @click="openDialog"
      >Save query</ui5-button>
    </div>
    <SaveQueryDialog
      :open="dialogOpen"
      @save="onDialogSave"
      @cancel="onDialogCancel"
    />
  </div>
  <div v-else class="builder-header empty">
    <span class="hint">No query yet — click an entity to start.</span>
  </div>
</template>

<style scoped>
.builder-header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
}
.builder-header.empty { opacity: 0.6; }
.title-row { flex: 1; }
.query-title { font-size: 0.9rem; }
.actions { display: flex; gap: 0.5rem; }
.hint { font-size: 0.8rem; color: var(--sapNeutralTextColor); }
</style>
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit BuilderHeader
```

Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/components/builder/BuilderHeader.vue app/analytics-explorer/src/components/builder/__tests__/BuilderHeader.test.ts
git commit -m "feat(analytics-explorer): BuilderHeader with Save button

Header bar above ClauseChipBar showing the query title (FROM entity)
and a Save button. Clicking Save opens SaveQueryDialog; on dialog
'save' calls useSavedQueries.saveAs with name/description/visibility +
the chip-built SQL (via specToSql) + JSON-stringified QuerySpec.

Emits 'saved' on success so the parent (SqlTab) can give a toast or
refresh saved-queries list.

6 tests covering: empty-state render, with-spec render, disabled-when-
no-spec, opens dialog on click, calls saveAs with right shape, emits
'saved' after success."
```

---

## Task 8: `BottomTabs.vue` — wraps Results / History / Saved (TDD)

**Files:**
- Create: `app/analytics-explorer/src/components/results/BottomTabs.vue`
- Create: `app/analytics-explorer/src/components/results/__tests__/BottomTabs.test.ts`

Tab strip with three peer tabs. Active tab default = Results. Loads from History or Saved emit `load` with the row; BottomTabs forwards as `load-row` event for SqlTab to handle.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/components/results/__tests__/BottomTabs.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'

vi.mock('../ResultsTab.vue', () => ({
  default: { name: 'ResultsTabStub', template: '<div data-test="results-stub" />' },
}))
vi.mock('../HistoryTab.vue', () => ({
  default: {
    name: 'HistoryTabStub',
    emits: ['load'],
    template: '<div data-test="history-stub" @click="$emit(\'load\', { ID: \'h1\' })" />',
  },
}))
vi.mock('../SavedTab.vue', () => ({
  default: {
    name: 'SavedTabStub',
    emits: ['load'],
    template: '<div data-test="saved-stub" @click="$emit(\'load\', { ID: \'s1\' })" />',
  },
}))

import BottomTabs from '../BottomTabs.vue'

const baseProps = {
  results: null,
  generatedSql: '',
  canDrillDown: () => false,
}

describe('BottomTabs', () => {
  it('renders the Results tab by default', () => {
    const w = mount(BottomTabs, { props: baseProps })
    expect(w.find('[data-test="results-stub"]').exists()).toBe(true)
    expect(w.find('[data-test="history-stub"]').exists()).toBe(false)
    expect(w.find('[data-test="saved-stub"]').exists()).toBe(false)
  })

  it('switches to History when the History tab is clicked', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-history"]').trigger('click')
    expect(w.find('[data-test="history-stub"]').exists()).toBe(true)
  })

  it('switches to Saved when the Saved tab is clicked', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-saved"]').trigger('click')
    expect(w.find('[data-test="saved-stub"]').exists()).toBe(true)
  })

  it('forwards History load event as load-row', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-history"]').trigger('click')
    await w.find('[data-test="history-stub"]').trigger('click')
    expect(w.emitted('load-row')).toBeTruthy()
    expect((w.emitted('load-row')![0][0] as any).source).toBe('history')
  })

  it('forwards Saved load event as load-row', async () => {
    const w = mount(BottomTabs, { props: baseProps })
    await w.find('[data-test="bottom-tab-saved"]').trigger('click')
    await w.find('[data-test="saved-stub"]').trigger('click')
    expect(w.emitted('load-row')).toBeTruthy()
    expect((w.emitted('load-row')![0][0] as any).source).toBe('saved')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit BottomTabs
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `BottomTabs.vue`**

Create `app/analytics-explorer/src/components/results/BottomTabs.vue`:

```vue
<script setup lang="ts">
import { ref } from 'vue'
import ResultsTab from './ResultsTab.vue'
import HistoryTab from './HistoryTab.vue'
import SavedTab from './SavedTab.vue'
import type { HistoryRow } from '../../composables/useHistory'
import type { SavedRow } from '../../composables/useSavedQueries'

interface SqlResult {
  columns: string[]
  rows: Array<Array<string | number | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells?: number }
  historyId?: string
}

defineProps<{
  results: SqlResult | null
  generatedSql: string
  canDrillDown: (row: Record<string, unknown>) => boolean
}>()

const emit = defineEmits<{
  (e: 'drilldown', row: Record<string, unknown>): void
  (e: 'load-row', payload: { source: 'history' | 'saved'; row: HistoryRow | SavedRow }): void
}>()

const activeTab = ref<'results' | 'history' | 'saved'>('results')

function onHistoryLoad(row: HistoryRow) {
  emit('load-row', { source: 'history', row })
}
function onSavedLoad(row: SavedRow) {
  emit('load-row', { source: 'saved', row })
}
</script>

<template>
  <div class="bottom-tabs">
    <div class="tab-strip" role="tablist">
      <button
        data-test="bottom-tab-results"
        :class="{ active: activeTab === 'results' }"
        role="tab"
        @click="activeTab = 'results'"
      >Results</button>
      <button
        data-test="bottom-tab-history"
        :class="{ active: activeTab === 'history' }"
        role="tab"
        @click="activeTab = 'history'"
      >History</button>
      <button
        data-test="bottom-tab-saved"
        :class="{ active: activeTab === 'saved' }"
        role="tab"
        @click="activeTab = 'saved'"
      >Saved</button>
    </div>
    <div class="tab-content">
      <ResultsTab
        v-if="activeTab === 'results'"
        :results="results"
        :generated-sql="generatedSql"
        :can-drill-down="canDrillDown"
        @drilldown="(row) => emit('drilldown', row)"
      />
      <HistoryTab
        v-else-if="activeTab === 'history'"
        @load="onHistoryLoad"
      />
      <SavedTab
        v-else-if="activeTab === 'saved'"
        @load="onSavedLoad"
      />
    </div>
  </div>
</template>

<style scoped>
.bottom-tabs {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.tab-strip {
  display: flex;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
}
.tab-strip button {
  padding: 0.4rem 0.9rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
  border-bottom: 2px solid transparent;
}
.tab-strip button.active {
  border-bottom-color: var(--sapButton_Selected_Background, #0070f3);
  color: var(--sapButton_Selected_Background, #0070f3);
  font-weight: 600;
}
.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit BottomTabs
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/components/results/BottomTabs.vue app/analytics-explorer/src/components/results/__tests__/BottomTabs.test.ts
git commit -m "feat(analytics-explorer): BottomTabs (Results / History / Saved)

Tab strip with three peer tabs. Results is the default; History +
Saved are loaded lazily (their components mount only when their tab
is active). History/Saved 'load' events bubble as 'load-row' with a
{ source: 'history'|'saved', row } envelope so SqlTab can route the
load through useQuerySpec.setSpec or pasteAndFlipMode.

5 tests covering: default tab, switch to History, switch to Saved,
History load forwarding, Saved load forwarding."
```

---

## Task 9: Wire BuilderHeader + BottomTabs into SqlTab

**Files:**
- Modify: `app/analytics-explorer/src/components/SqlTab.vue`

Replace the direct `<ResultsTab>` mount with `<BottomTabs>` and add `<BuilderHeader>` above the chip bar. Wire the `load-row` event to a function that decides between `setSpec` and SQL-only-paste.

- [ ] **Step 1: Update imports + add load handlers**

In `SqlTab.vue`'s `<script setup>`:

```typescript
import BuilderHeader from './builder/BuilderHeader.vue'
import BottomTabs from './results/BottomTabs.vue'
import { useHistory } from '../composables/useHistory'
import { useSavedQueries } from '../composables/useSavedQueries'
import type { HistoryRow } from '../composables/useHistory'
import type { SavedRow } from '../composables/useSavedQueries'

// (Drop the `import ResultsTab from './results/ResultsTab.vue'` line — BottomTabs owns it now.)

// Reuse the parseSpec helper from useHistory (also exposed by useSavedQueries).
const { parseSpec: parseHistorySpec } = useHistory()
```

Add the load-row handler:

```typescript
function onLoadRow(payload: { source: 'history' | 'saved'; row: HistoryRow | SavedRow }) {
  const row = payload.row
  const parsed = parseHistorySpec(row.spec)
  if (parsed) {
    // Spec available — restore chip state.
    querySpec.setSpec(parsed)
    if (mode.value === 'editor') querySpec.returnToBuilder()
  } else {
    // SQL-only fallback — paste into Monaco + flip to editor mode.
    editorRef.value?.setValue?.(row.sql)
    querySpec.takeOverFromBuilder()
  }
}
```

- [ ] **Step 2: Update template**

Replace the existing `<ResultsTab .../>` with `<BottomTabs .../>` and add `<BuilderHeader />` at the top:

```vue
<div class="sql-tab" :class="{ 'editor-mode': mode === 'editor' }">
  <AutoGroupByBanner />
  <BuilderHeader />
  <ClauseChipBar />
  <SqlPreview />
  <!-- ... builder-run-row + main-row unchanged ... -->
  <div class="results-section">
    <BottomTabs
      :results="lastResults"
      :generated-sql="generatedSql"
      :can-drill-down="canDrill"
      @drilldown="onDrilldown"
      @load-row="onLoadRow"
    />
  </div>
</div>
```

- [ ] **Step 3: Verify build**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -3 && cd ../..
```

Expected: build green.

- [ ] **Step 4: Commit**

```bash
git add app/analytics-explorer/src/components/SqlTab.vue
git commit -m "feat(analytics-explorer): wire BuilderHeader + BottomTabs into SqlTab

Layout additions:
- BuilderHeader (with Save button) sits between AutoGroupByBanner and
  ClauseChipBar
- BottomTabs replaces the direct ResultsTab mount in results-section,
  giving Results / History / Saved peer tabs

Load-row handler: tries to parse the row's spec field; if v1 JSON,
calls useQuerySpec.setSpec to restore chip state (and flips back to
builder mode if currently in editor mode). If null/invalid, pastes
the SQL into Monaco + flips to editor mode (covers Phase 1-3 history
rows that have spec=null)."
```

---

## Task 10: Final regression sweep + build

- [ ] **Step 1: Run all Phase 4 tests**

```bash
for t in run-select-query-spec useHistory useSavedQueries HistoryTab SavedTab SaveQueryDialog BuilderHeader BottomTabs; do
  echo "=== $t ==="
  npm test -- --project=unit "$t" 2>&1 | tail -3
done
```

Expected: every group reports `Tests N passed` with N matching the count from each task.

- [ ] **Step 2: Run a broader sweep to catch regressions**

```bash
npm test -- --project=unit -t "Chip" 2>&1 | tail -3
npm test -- --project=unit -t "useQuerySpec" 2>&1 | tail -3
npm test -- --project=unit -t "ResultsTab" 2>&1 | tail -3
```

Expected: same counts as before Phase 4 (36 chip, 6 useQuerySpec, 7 ResultsTab).

- [ ] **Step 3: Build the SPA**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -5 && cd ../..
```

Expected: green.

- [ ] **Step 4: Empty marker commit**

```bash
git commit --allow-empty -m "test: verify Phase 4 unit suite + SPA build green"
```

---

## Task 11: srv-qa cp-list verification

Phase 4 touches **one** srv/ file group (`runSelectQuery` extension in `analytics-service.js` + `analytics-history-writer.js` + `analytics-service.cds` schema). Per project policy ([feedback_srv_qa_cp_list_recurring]), check whether srv-qa imports any of these.

- [ ] **Step 1: Confirm no srv-qa imports**

```bash
grep -rn "analytics-history-writer\|analytics-service" srv-qa/ 2>&1 | head -5
```

Expected: empty.

- [ ] **Step 2: Confirm `.deploy/mta.yaml` srv-qa cp list unaffected**

```bash
grep -E "analytics-history-writer|analytics-service" .deploy/mta.yaml
```

Expected: empty.

- [ ] **Step 3: Empty marker commit**

```bash
git commit --allow-empty -m "chore(srv-qa): verify Phase 4 srv changes don't affect QA cp list

Phase 4 modifies analytics-history-writer.js + analytics-service.js +
analytics-service.cds (runSelectQuery gains optional spec param).
None of these are imported by srv-qa (admin-only analytics surface).
.deploy/mta.yaml unchanged."
```

---

## Task 12: Open the PR

- [ ] **Step 1: Push + open PR**

```bash
git push -u origin feat/analytics-builder-phase4-history-saved
gh pr create --base main \
  --title "feat(analytics): Phase 4 History + Saved Queries tabs" \
  --body "$(cat <<'EOF'
## Phase 4 of 5 — History + Saved Queries tabs

Adds two new tabs to the SQL tab's bottom area: History (auto-recorded by Phase 1's backend) and Saved (admin-curated, optionally shared with all admins). Save button lives in a new BuilderHeader above the chip row. Loading from a row restores the chip state via useQuerySpec.setSpec, or falls back to SQL-only paste when the row's spec field is null (Phase 1-3 history rows).

## What's in

- **runSelectQuery extended** — accepts an optional `spec : String` param so future history rows carry the chip-built spec; Phase 1-3 history rows (spec=null) load SQL-only into Monaco + flip mode to editor.
- **`useHistory`** composable — GET `/admin/analytics/QueryHistory` ordered desc by createdAt; parseSpec helper.
- **`useSavedQueries`** composable — full CRUD (load + create + delete) plus bound actions (rename, setVisibility, duplicate, recordRun).
- **`HistoryTab.vue`** — list of history rows with SQL preview + timestamp + colored source badge; Load button.
- **`SavedTab.vue`** — list of saved queries with name + visibility badge + per-row actions (Load, toggle visibility, duplicate, delete with confirm).
- **`SaveQueryDialog.vue`** — modal for name/description/visibility on save.
- **`BuilderHeader.vue`** — header bar above ClauseChipBar with query title (FROM entity) + Save button.
- **`BottomTabs.vue`** — wraps Results / History / Saved as peer tabs.
- **SqlTab reshape** — BuilderHeader added above ClauseChipBar; BottomTabs replaces the direct ResultsTab mount; `load-row` handler routes to setSpec (when spec present) or pastes SQL + flips to editor mode (when spec null).

## Tests

~40 new unit + component tests, all green. Phase 1-3 baselines unchanged.

## srv-qa impact

None. analytics-history-writer.js + analytics-service.js + analytics-service.cds are not imported by srv-qa.

## Out of scope

- Phase 5: Joule integration + 3 new tools (`generateAnalyticsQuery`, `explainAnalyticsResult`, extended `analyticsQuery`).
EOF
)"
```

- [ ] **Step 2: Save memory entry**

Save to `~/.claude/projects/d--projects-tutorials-poc/memory/project_analytics_builder_phase4.md`:

```markdown
---
name: project-analytics-builder-phase4
description: History + Saved Queries tabs shipped in PR #<num>
metadata:
  type: project
---

Phase 4 of analytics SQL Builder shipped <date> in PR #<num>.

Backend tweak: runSelectQuery accepts optional `spec: String` so
history rows carry the chip-built spec. Old rows (spec=null) load
SQL-only into Monaco.

New composables: useHistory, useSavedQueries.
New components: HistoryTab, SavedTab, SaveQueryDialog, BuilderHeader,
BottomTabs.
SqlTab reshape: BuilderHeader above chip bar; BottomTabs (Results /
History / Saved) replaces direct ResultsTab mount.

Phase 5 (Joule integration) starts from this branch once merged.
```

Add to MEMORY.md:

```
- [Analytics Builder Phase 4](project_analytics_builder_phase4.md) — History + Saved Queries tabs shipped in PR #<num>
```

---

## Phase 4 summary checklist

- [ ] Task 1: runSelectQuery accepts + persists spec (TDD; backend)
- [ ] Task 2: useHistory composable (TDD)
- [ ] Task 3: useSavedQueries composable (TDD)
- [ ] Task 4: HistoryTab component (TDD)
- [ ] Task 5: SavedTab component (TDD)
- [ ] Task 6: SaveQueryDialog modal (TDD)
- [ ] Task 7: BuilderHeader with Save button (TDD)
- [ ] Task 8: BottomTabs wrapper (TDD)
- [ ] Task 9: Wire BuilderHeader + BottomTabs into SqlTab
- [ ] Task 10: Final regression + build
- [ ] Task 11: srv-qa cp-list verification
- [ ] Task 12: Open PR
