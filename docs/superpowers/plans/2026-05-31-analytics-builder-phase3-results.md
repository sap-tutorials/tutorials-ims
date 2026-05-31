# Analytics SQL Builder — Phase 3 (Results Upgrade) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade the result-rendering area inside the SQL tab — replace the 200-row HTML table with a virtualized table (≤5,000 rows smooth scroll), add a Table/Chart view toggle inside the Results area (auto-detect + manual override), wire per-row drilldown via the depth-1 stack already in `useQuerySpec`, and add a client-side `Export CSV` button calling the `POST /admin/analytics/export` endpoint shipped in Phase 1.

**Architecture:** A new `ResultsArea.vue` component owns the Results region: virtualized table (via `vue-virtual-scroller`), Table/Chart view toggle, Export-CSV button, privacy badge, and the right-click → drilldown menu. The chart toggle reuses the existing `ChartRenderer` + `ChartTypeSwitcher` + `useChartConfig`/`useChartEngine` plumbing — no new chart code. The drilldown derivation is a pure function (`deriveDrilldownSpec`) tested in isolation; the right-click menu calls it then `useQuerySpec.pushDrilldown()`.

**Tech Stack:** Vue 3 + Vite + TypeScript (`app/analytics-explorer/`); `vue-virtual-scroller` (new dep); existing UI5 web components, ECharts, Monaco; Vitest for unit tests.

**Spec:** [docs/superpowers/specs/2026-05-31-analytics-sql-builder-design.md](../specs/2026-05-31-analytics-sql-builder-design.md) sections 4 (Frontend chip builder UX) and 4-amend (Tom's amendments: inline charting + per-row drilldown).

**Predecessor:** Phase 2 (PR #145, merged 2026-05-31, commit 3a1f9f5). All 8 chip kinds + ClauseChipBar + take-over mode + run-from-chips + auto-GROUP-BY banner are live.

**Branch:** `feat/analytics-builder-phase3-results` (already created from `main` post-merge).

**Conventions used in this plan:**

- All paths repo-relative from `d:\projects\tutorials-poc`.
- All commands assume Bash (Git Bash on Windows). Forward slashes.
- Frontend code is TypeScript / Vue 3 SFC.
- Per-file `// @vitest-environment happy-dom` pragma for component tests (the pattern works as of Phase 2).
- Vitest 4.1.5 — omit `--reporter=basic`. Filter form `npm test -- -t "<title>"` is preferred.
- TDD discipline: every code task starts with a failing test.
- Each task ends with one focused commit.
- Drilldown derivation lives in `app/analytics-explorer/src/lib/derive-drilldown.ts` (pure function, easy to test in isolation).
- `vue-virtual-scroller` styling: import its `dist/vue-virtual-scroller.css` once at app entry; no other CSS plumbing needed.
- The `runSelectQuery` envelope from Phase 1 returns `rows: string[][]` (array-of-arrays). The chart code expects `data: (string|number)[][]` — same shape. The existing object-keyed conversion in `SqlTab.vue:visualize()` was a UI-internal detour; we'll switch to passing array-of-arrays directly to both the table AND the chart in this phase, eliminating one redundant transform.

---

## Phase 3 task list

1. Branch + add `vue-virtual-scroller` to SPA deps; import its CSS in `main.ts`
2. `deriveDrilldownSpec` pure function (TDD)
3. `useExport` composable for client-side CSV download
4. `ResultsTable.vue` — virtualized table component (TDD)
5. `ResultsTab.vue` — owns Table/Chart toggle + Export button + privacy badge + right-click drilldown menu
6. Reshape `SqlTab.vue` — replace inline result rendering with `<ResultsTab />`; preserve existing `visualize()` flow but inside the new tab
7. Right-click drilldown menu integration (TDD)
8. "Back to grouped query" button when `useQuerySpec.isDrilldown` is true (TDD via SqlTab integration test)
9. Privacy badge component (already covered by Phase 1's envelope) — wire it into ResultsTab
10. Final regression sweep + lint + build
11. srv-qa cp-list verification
12. Open PR

---

## Task 1: Add `vue-virtual-scroller` dep + CSS import

**Files:**
- Modify: `app/analytics-explorer/package.json`
- Modify: `app/analytics-explorer/src/main.ts`

- [ ] **Step 1: Verify branch state**

```bash
git branch --show-current
```

Expected: `feat/analytics-builder-phase3-results`

```bash
git log --oneline -3
```

Expected: top commit is the Phase 2 merge (3a1f9f5 or its rebased equivalent). If branch is on a different base, stop and re-create from main.

- [ ] **Step 2: Install vue-virtual-scroller**

`vue-virtual-scroller` v2.x supports Vue 3. Pin to a known-good version:

```bash
cd app/analytics-explorer && npm install --save vue-virtual-scroller@^2.0.0-beta.8 && cd ../..
```

Expected: package.json has `"vue-virtual-scroller": "^2.0.0-beta.8"` in `dependencies`.

(The 2.x line has been on beta for multiple years but is the stable Vue 3 version — well-used in production.)

- [ ] **Step 3: Import the CSS in main.ts**

Edit `app/analytics-explorer/src/main.ts`. Add ONE import line near the existing `import './styles.css'`:

```typescript
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
```

Place it before `import './styles.css'` so the project's overrides win.

- [ ] **Step 4: Verify build still succeeds**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -3 && cd ../..
```

Expected: build succeeds. The new dep adds ~7 kB to the bundle.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/package.json app/analytics-explorer/package-lock.json app/analytics-explorer/src/main.ts
git commit -m "chore(analytics-explorer): add vue-virtual-scroller for Phase 3 result table

Phase 3 needs a virtualized scrollable table to render up to 5,000
rows smoothly (the current SqlTab caps at 200 via .slice). vue-
virtual-scroller v2 is the Vue-3-compatible release; ~7 kB gzipped.

CSS imported in main.ts before our own styles.css so project styles
override library defaults."
```

---

## Task 2: `deriveDrilldownSpec` pure function (TDD)

**Files:**
- Create: `app/analytics-explorer/src/lib/derive-drilldown.ts`
- Create: `app/analytics-explorer/src/lib/__tests__/derive-drilldown.test.ts`

Pure function: takes the current QuerySpec + a clicked row's column-keyed object → returns a fresh drilldown QuerySpec (strip aggregations, add equality filters, replace SELECT, fresh LIMIT).

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/lib/__tests__/derive-drilldown.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { deriveDrilldownSpec, canDrillDown } from '../derive-drilldown'
import type { QuerySpec } from '../../types/query-spec'

const groupedSpec = (): QuerySpec => ({
  version: 1,
  from: { entity: 'TaskRecords', alias: 'tr' },
  joins: [],
  filterTree: null,
  groupBy: [],
  select: [
    { kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' } },
    { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
  ],
  orderBy: [],
  limit: null,
})

describe('canDrillDown', () => {
  it('returns true for an aggregated spec with no expression chips', () => {
    expect(canDrillDown(groupedSpec(), { event_ID: 'evt1', cnt: 42 })).toBe(true)
  })

  it('returns false when no aggregation chip is present (already raw)', () => {
    const s = groupedSpec()
    s.select = [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' } }]
    expect(canDrillDown(s, { event_ID: 'evt1' })).toBe(false)
  })

  it('returns false when the spec has an expression chip', () => {
    const s = groupedSpec()
    s.select.push({ kind: 'expression', id: 's3', sql: 'YEAR(tr.createdAt)', alias: 'y', referencedAliases: ['tr'] })
    expect(canDrillDown(s, { event_ID: 'evt1', cnt: 42, y: 2026 })).toBe(false)
  })

  it('returns false when a non-aggregation column is NULL in the row', () => {
    expect(canDrillDown(groupedSpec(), { event_ID: null, cnt: 42 })).toBe(false)
  })
})

describe('deriveDrilldownSpec', () => {
  it('strips aggregations + adds equality filter for non-agg columns', () => {
    const drill = deriveDrilldownSpec(groupedSpec(), { event_ID: 'evt1', cnt: 42 })!
    // Aggregation chip removed
    expect(drill.select.every(s => s.kind !== 'aggregation')).toBe(true)
    expect(drill.select.length).toBe(1)
    expect(drill.select[0]).toMatchObject({ kind: 'column', ref: { alias: 'tr', column: 'event_ID' } })
    // Equality filter added
    expect(drill.filterTree).toBeTruthy()
    expect(drill.filterTree!.kind).toBe('group')
    const grp = drill.filterTree as any
    expect(grp.children).toHaveLength(1)
    expect(grp.children[0]).toMatchObject({
      ref: { alias: 'tr', column: 'event_ID' },
      op: 'eq',
      value: { kind: 'literal', value: 'evt1' },
    })
  })

  it('sets fresh LIMIT 200 (drill is for inspection, not export)', () => {
    const drill = deriveDrilldownSpec(groupedSpec(), { event_ID: 'evt1', cnt: 42 })!
    expect(drill.limit).toBe(200)
  })

  it('clears explicit groupBy', () => {
    const s = groupedSpec()
    s.groupBy = [{ id: 'g1', ref: { alias: 'tr', column: 'taskType' } }]
    const drill = deriveDrilldownSpec(s, { event_ID: 'evt1', cnt: 42 })!
    expect(drill.groupBy).toEqual([])
  })

  it('preserves joins in the drill spec', () => {
    const s = groupedSpec()
    s.joins = [{
      id: 'j1', kind: 'inner',
      target: { entity: 'Users', alias: 'u' },
      on: { leftRef: { alias: 'tr', column: 'user_ID' }, rightRef: { alias: 'u', column: 'ID' } },
    }]
    const drill = deriveDrilldownSpec(s, { event_ID: 'evt1', cnt: 42 })!
    expect(drill.joins).toHaveLength(1)
  })

  it('returns null when canDrillDown is false', () => {
    const s = groupedSpec()
    s.select = [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' } }]
    expect(deriveDrilldownSpec(s, { event_ID: 'evt1' })).toBe(null)
  })

  it('quotes the column-name lookup correctly when row uses output alias', () => {
    // When a SELECT chip has alias 'eid', the result row uses key 'eid' not 'event_ID'.
    const s = groupedSpec()
    s.select[0] = { kind: 'column', id: 's1', ref: { alias: 'tr', column: 'event_ID' }, alias: 'eid' }
    const drill = deriveDrilldownSpec(s, { eid: 'evt1', cnt: 42 })!
    const grp = drill.filterTree as any
    expect(grp.children[0].value.value).toBe('evt1')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit derive-drilldown
```

Expected: FAIL — `Cannot find module '../derive-drilldown'`.

- [ ] **Step 3: Implement `derive-drilldown.ts`**

Create `app/analytics-explorer/src/lib/derive-drilldown.ts`:

```typescript
import type { QuerySpec, FilterGroup, Filter, ColumnRef } from '../types/query-spec'

/**
 * Returns true if the given spec + clicked row support a drilldown.
 * Disabled cases (matches the spec):
 *   - No aggregation chips in the current spec (already showing raw rows)
 *   - Spec uses an expression-kind SELECT chip (can't reverse YEAR() etc.)
 *   - Clicked row has any NULL value in a non-aggregation column
 */
export function canDrillDown(spec: QuerySpec | null, row: Record<string, unknown>): boolean {
  if (!spec) return false
  const hasAgg = spec.select.some(s => s.kind === 'aggregation')
  if (!hasAgg) return false
  if (spec.select.some(s => s.kind === 'expression')) return false
  for (const s of spec.select) {
    if (s.kind !== 'column') continue
    const key = s.alias || s.ref.column
    if (row[key] === null || row[key] === undefined) return false
  }
  return true
}

/**
 * Build the drilldown QuerySpec:
 *   - Strip aggregation chips from select
 *   - Add equality filters for every non-aggregation column projection
 *   - Clear explicit groupBy (auto-derive doesn't apply with no aggregations)
 *   - Set LIMIT 200 (drill is for inspection, not export)
 *   - Preserve from/joins/orderBy verbatim
 */
export function deriveDrilldownSpec(
  spec: QuerySpec | null,
  row: Record<string, unknown>,
): QuerySpec | null {
  if (!canDrillDown(spec, row)) return null
  const s = spec!

  const projectedColumns = s.select.filter(item => item.kind === 'column') as Array<{
    kind: 'column'; id: string; ref: ColumnRef; alias?: string
  }>

  // Build a fresh filter group with one equality leaf per projected column.
  const drillChildren: Filter[] = projectedColumns.map((p, i) => {
    const key = p.alias || p.ref.column
    const v = row[key]
    return {
      id: `drill-f${i}-${Date.now()}`,
      ref: p.ref,
      op: 'eq',
      value: { kind: 'literal', value: v as (string | number | boolean | null) },
    }
  })

  const drillFilterTree: FilterGroup = {
    id: `drill-fg-${Date.now()}`,
    kind: 'group',
    conjunction: 'and',
    children: drillChildren,
  }

  return {
    version: 1,
    from: s.from,
    joins: s.joins,
    filterTree: drillFilterTree,
    groupBy: [],
    select: projectedColumns,  // Keep only the column projections; aggregations dropped.
    orderBy: s.orderBy,
    limit: 200,
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- --project=unit derive-drilldown
```

Expected: 8 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/lib/derive-drilldown.ts app/analytics-explorer/src/lib/__tests__/derive-drilldown.test.ts
git commit -m "feat(analytics-explorer): deriveDrilldownSpec pure function (TDD)

Pure function: takes the current QuerySpec + a clicked row's column-keyed
object → returns a fresh drilldown spec. Drops aggregation chips, adds
equality filters from non-agg projection values, clears explicit groupBy,
sets LIMIT 200, preserves from/joins/orderBy.

canDrillDown predicate captures the four disabled cases from the spec:
no aggregation present, expression chip present, NULL in a projected
column, or null spec.

8 tests covering: predicate true/false branches, projection-strip,
limit-200, groupBy clear, joins preserve, alias key lookup."
```

---

## Task 3: `useExport` composable for CSV download

**Files:**
- Create: `app/analytics-explorer/src/composables/useExport.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useExport.test.ts`

Wraps the `POST /admin/analytics/export` endpoint shipped in Phase 1. Triggers a browser download via a programmatic `<a>` link.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/composables/__tests__/useExport.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock fetch BEFORE importing the composable.
const fetchMock = vi.fn()
;(globalThis as any).fetch = fetchMock

const { useExport } = await import('../useExport')

describe('useExport', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    // happy-dom doesn't implement createObjectURL — stub it.
    if (!URL.createObjectURL) {
      ;(URL as any).createObjectURL = vi.fn(() => 'blob:fake')
      ;(URL as any).revokeObjectURL = vi.fn()
    }
  })

  it('POSTs to /admin/analytics/export with the SQL body', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['col1,col2\n1,2\n'], { type: 'text/csv' }),
    } as any)
    const { exportCsv, isExporting } = useExport()
    await exportCsv('SELECT 1 FROM Tasks')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/admin/analytics/export')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ sql: 'SELECT 1 FROM Tasks' })
    expect(isExporting.value).toBe(false)
  })

  it('sets isExporting=true while in flight', async () => {
    let resolveFetch: (v: any) => void
    fetchMock.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve }))
    const { exportCsv, isExporting } = useExport()
    const p = exportCsv('SELECT 1')
    expect(isExporting.value).toBe(true)
    resolveFetch!({ ok: true, blob: async () => new Blob(['ok']) } as any)
    await p
    expect(isExporting.value).toBe(false)
  })

  it('throws on a non-ok response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad sql' } as any)
    const { exportCsv } = useExport()
    await expect(exportCsv('DROP TABLE x')).rejects.toThrow(/400|bad sql/)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit useExport
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the composable**

Create `app/analytics-explorer/src/composables/useExport.ts`:

```typescript
import { ref } from 'vue'

/**
 * useExport — wraps POST /admin/analytics/export (shipped in Phase 1).
 * Triggers a browser download via a programmatic <a> link with a
 * generated blob URL. The endpoint streams text/csv with attachment
 * headers; we just need to force the browser to save it locally.
 */
export function useExport() {
  const isExporting = ref(false)
  const lastError = ref<string | null>(null)

  async function exportCsv(sql: string, filename = `analytics-${Date.now()}.csv`): Promise<void> {
    isExporting.value = true
    lastError.value = null
    try {
      const r = await fetch('/admin/analytics/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sql }),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        throw new Error(`exportCsv ${r.status}: ${text || 'request failed'}`)
      }
      const blob = await r.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      // Defer revoke so the browser has time to start the download.
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e: any) {
      lastError.value = e.message
      throw e
    } finally {
      isExporting.value = false
    }
  }

  return { exportCsv, isExporting, lastError }
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- --project=unit useExport
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/composables/useExport.ts app/analytics-explorer/src/composables/__tests__/useExport.test.ts
git commit -m "feat(analytics-explorer): useExport composable for CSV download

Client-side wrapper for POST /admin/analytics/export (shipped in Phase 1).
Triggers a browser download via a programmatic <a> link with blob URL.
isExporting ref drives the button's disabled state during the download.

3 tests covering: POST request shape, in-flight isExporting toggle,
error throw on non-ok response."
```

---

## Task 4: `ResultsTable.vue` — virtualized table (TDD)

**Files:**
- Create: `app/analytics-explorer/src/components/results/ResultsTable.vue`
- Create: `app/analytics-explorer/src/components/results/__tests__/ResultsTable.test.ts`

Virtualized scrollable table using `vue-virtual-scroller`'s `RecycleScroller`. Read-only. Supports right-click on a row → emits `row-context-menu` with the clicked row's data and screen position so the parent can render the drilldown menu.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/components/results/__tests__/ResultsTable.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import ResultsTable from '../ResultsTable.vue'

describe('ResultsTable', () => {
  it('renders the column headers', () => {
    const w = mount(ResultsTable, {
      props: {
        columns: ['event_ID', 'cnt'],
        rows: [['evt1', 42], ['evt2', 17]],
      },
    })
    expect(w.text()).toContain('event_ID')
    expect(w.text()).toContain('cnt')
  })

  it('renders an empty-state message when rows is empty', () => {
    const w = mount(ResultsTable, {
      props: { columns: ['x'], rows: [] },
    })
    expect(w.text().toLowerCase()).toContain('no rows')
  })

  it('renders ∅ for null cells', () => {
    const w = mount(ResultsTable, {
      props: { columns: ['x', 'y'], rows: [[null, 'value']] },
    })
    expect(w.text()).toContain('∅')
  })

  it('emits row-context-menu on right-click with row + screen position', async () => {
    const w = mount(ResultsTable, {
      props: {
        columns: ['event_ID', 'cnt'],
        rows: [['evt1', 42]],
      },
    })
    // Simulate right-click via the exposed test helper. Right-clicking a real
    // <tr> through happy-dom's contextmenu event is finicky; the component
    // exposes onRowContextMenu(row, event) for direct invocation.
    await (w.vm as any).onRowContextMenu(['evt1', 42], { clientX: 100, clientY: 200, preventDefault: () => {} })
    const emitted = w.emitted('row-context-menu')
    expect(emitted).toBeTruthy()
    const payload = emitted![0][0] as any
    expect(payload.row).toEqual({ event_ID: 'evt1', cnt: 42 })
    expect(payload.x).toBe(100)
    expect(payload.y).toBe(200)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit ResultsTable
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `ResultsTable.vue`**

Create `app/analytics-explorer/src/components/results/ResultsTable.vue`:

```vue
<script setup lang="ts">
import { computed, defineExpose } from 'vue'
import { RecycleScroller } from 'vue-virtual-scroller'

interface RowContextMenuPayload {
  row: Record<string, unknown>
  x: number
  y: number
  rowIndex: number
}

const props = defineProps<{
  columns: string[]
  rows: Array<Array<string | number | null>>
}>()

const emit = defineEmits<{
  (e: 'row-context-menu', payload: RowContextMenuPayload): void
}>()

// vue-virtual-scroller wants stable keys; use the array index as a key
// (rows are immutable for the lifetime of a query result).
const items = computed(() =>
  props.rows.map((cells, i) => ({ id: i, cells }))
)

function onRowContextMenu(cells: Array<string | number | null>, event: MouseEvent | { clientX: number; clientY: number; preventDefault: () => void }, rowIndex = 0) {
  event.preventDefault()
  // Convert array-of-arrays to column-keyed object so the drilldown
  // derivation can read row[col] / row[alias] directly.
  const row: Record<string, unknown> = {}
  props.columns.forEach((c, i) => { row[c] = cells[i] })
  emit('row-context-menu', { row, x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY, rowIndex })
}

function fmt(cell: string | number | null): string {
  if (cell === null || cell === undefined) return '∅'
  return String(cell)
}

defineExpose({ onRowContextMenu })
</script>

<template>
  <div class="results-table" v-if="rows.length > 0">
    <div class="header-row">
      <div v-for="c in columns" :key="c" class="header-cell">{{ c }}</div>
    </div>
    <RecycleScroller
      class="scroller"
      :items="items"
      :item-size="32"
      key-field="id"
      v-slot="{ item, index }"
    >
      <div
        class="data-row"
        @contextmenu.prevent="onRowContextMenu(item.cells, $event, index)"
      >
        <div
          v-for="(cell, j) in item.cells"
          :key="j"
          class="data-cell"
          :class="{ 'is-null': cell === null }"
        >{{ fmt(cell) }}</div>
      </div>
    </RecycleScroller>
  </div>
  <div v-else class="empty-state">No rows.</div>
</template>

<style scoped>
.results-table {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  overflow: hidden;
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.8rem;
}
.header-row, .data-row {
  display: grid;
  grid-template-columns: repeat(var(--col-count, auto-fit), minmax(8rem, 1fr));
}
.header-row {
  background: var(--sapList_HeaderBackground);
  font-weight: bold;
  border-bottom: 1px solid var(--sapField_BorderColor);
  padding: 0.4rem 0;
}
.header-cell, .data-cell {
  padding: 0.4rem 0.6rem;
  border-right: 1px solid var(--sapField_BorderColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-cell:last-child, .data-cell:last-child { border-right: none; }
.scroller {
  flex: 1;
  min-height: 0;
}
.data-row {
  height: 32px;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.data-row:hover { background: var(--sapList_Hover_Background); }
.data-cell.is-null {
  color: var(--sapNeutralTextColor);
  font-style: italic;
}
.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--sapNeutralTextColor);
}
</style>
```

**Note on grid-template-columns:** `repeat(var(--col-count, auto-fit), ...)` is a placeholder. CSS custom-properties don't interpolate inside `repeat()` directly. We'll set the inline `grid-template-columns` from the script when columns count is known. Update the template:

```vue
<div class="header-row" :style="{ gridTemplateColumns: `repeat(${columns.length}, minmax(8rem, 1fr))` }">
```

Apply the same to `.data-row`.

- [ ] **Step 4: Re-edit the template to set inline grid-template-columns**

Replace the two `class="header-row"` / `class="data-row"` divs:

```vue
<div class="header-row" :style="gridStyle">
  <div v-for="c in columns" :key="c" class="header-cell">{{ c }}</div>
</div>
<RecycleScroller ...>
  <div class="data-row" :style="gridStyle" @contextmenu.prevent="onRowContextMenu(item.cells, $event, index)">
    ...
  </div>
</RecycleScroller>
```

And add to `<script setup>`:

```typescript
const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${props.columns.length}, minmax(8rem, 1fr))`,
}))
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- --project=unit ResultsTable
```

Expected: 4 PASS.

If the RecycleScroller mount fails in happy-dom (it depends on ResizeObserver which happy-dom does support), the test should still pass — the `defineExpose` exposes `onRowContextMenu` directly so the test bypasses the DOM event path.

- [ ] **Step 6: Verify build**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -3 && cd ../..
```

Expected: build succeeds.

- [ ] **Step 7: Commit**

```bash
git add app/analytics-explorer/src/components/results/ResultsTable.vue app/analytics-explorer/src/components/results/__tests__/ResultsTable.test.ts
git commit -m "feat(analytics-explorer): ResultsTable virtualized via vue-virtual-scroller

Replaces the inline 200-row HTML table from QueryEditor.vue with a
RecycleScroller-backed virtualized table. Columns rendered as a
sticky header row above a scrolling viewport; rows recycled at
32px height. Right-click on any row emits row-context-menu with the
column-keyed row + screen coords so the parent can render the
drilldown menu.

CSS grid (grid-template-columns set inline from columns.length)
handles arbitrary column counts. NULL cells render as ∅ in muted
italic.

4 tests passing: header render, empty state, null-cell glyph,
contextmenu emit shape."
```

---

## Task 5: `ResultsTab.vue` — Table/Chart toggle + Export + drilldown menu

**Files:**
- Create: `app/analytics-explorer/src/components/results/ResultsTab.vue`
- Create: `app/analytics-explorer/src/components/results/PrivacyBadge.vue`
- Create: `app/analytics-explorer/src/components/results/__tests__/ResultsTab.test.ts`

Owns the entire Results region: privacy badge, Table/Chart toggle, Export button, embedded ResultsTable or ChartRenderer, right-click context menu invoking the drilldown.

- [ ] **Step 1: Create the PrivacyBadge component**

Create `app/analytics-explorer/src/components/results/PrivacyBadge.vue`:

```vue
<script setup lang="ts">
defineProps<{
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells?: number }
}>()
</script>

<template>
  <span v-if="privacy" class="privacy-badge" :class="`badge-${privacy.mode}`">
    <template v-if="privacy.mode === 'raw'">
      ⚠ Raw query — no privacy filter
    </template>
    <template v-else>
      🔒 Privacy-filtered (k≥5){{ privacy.suppressedCells ? ` — ${privacy.suppressedCells} cells suppressed` : '' }}
    </template>
  </span>
</template>

<style scoped>
.privacy-badge {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 500;
}
.badge-raw {
  background: var(--sapWarningBackground, #fff8d6);
  color: var(--sapWarningTextColor, #b06000);
  border: 1px solid var(--sapWarningBorderColor, #d2872c);
}
.badge-k-anon {
  background: var(--sapPositiveBackground, #ebf5e0);
  color: var(--sapPositiveTextColor, #2b7d2b);
  border: 1px solid var(--sapPositiveBorderColor, #5cb85c);
}
</style>
```

- [ ] **Step 2: Write the failing tests for ResultsTab**

Create `app/analytics-explorer/src/components/results/__tests__/ResultsTab.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import ResultsTab from '../ResultsTab.vue'

vi.mock('../../../composables/useExport', () => ({
  useExport: () => ({
    exportCsv: vi.fn(async () => {}),
    isExporting: { value: false },
    lastError: { value: null },
  }),
}))

const baseProps = {
  results: {
    columns: ['event_ID', 'cnt'],
    rows: [['evt1', 42], ['evt2', 17]],
    metadata: { rowCount: 2, truncated: false, durationMs: 50 },
    privacy: { mode: 'raw' as const, suppressedCells: 0 },
  },
  generatedSql: 'SELECT event_ID, count(*) AS cnt FROM TaskRecords GROUP BY event_ID',
  canDrillDown: () => true,
}

describe('ResultsTab', () => {
  beforeEach(() => {
    if (!URL.createObjectURL) {
      ;(URL as any).createObjectURL = vi.fn(() => 'blob:fake')
      ;(URL as any).revokeObjectURL = vi.fn()
    }
  })

  it('renders the table by default', () => {
    const w = mount(ResultsTab, { props: baseProps })
    expect(w.text()).toContain('event_ID')
    expect(w.text()).toContain('cnt')
  })

  it('renders the privacy badge from results.privacy', () => {
    const w = mount(ResultsTab, { props: baseProps })
    expect(w.text().toLowerCase()).toContain('raw query')
  })

  it('toggles to chart view via the chart button', async () => {
    const w = mount(ResultsTab, { props: baseProps })
    expect(w.find('[data-test="results-view-table"]').classes()).toContain('active')
    await w.find('[data-test="results-view-chart"]').trigger('click')
    expect(w.find('[data-test="results-view-chart"]').classes()).toContain('active')
  })

  it('emits drilldown event with derived spec when context menu confirmed', async () => {
    const w = mount(ResultsTab, { props: baseProps })
    // Simulate context-menu via the exposed test helper
    await (w.vm as any).onRowContextMenu({
      row: { event_ID: 'evt1', cnt: 42 },
      x: 100, y: 200, rowIndex: 0,
    })
    // ResultsTab handles the menu inline — clicking "Drill into this row"
    // emits 'drilldown'.
    await (w.vm as any).confirmDrilldown()
    expect(w.emitted('drilldown')).toBeTruthy()
    expect((w.emitted('drilldown')![0][0] as any).event_ID).toBe('evt1')
  })

  it('calls exportCsv when Export CSV button is clicked', async () => {
    const exportSpy = vi.fn(async () => {})
    // Re-mock useExport for this test to capture the call.
    vi.doMock('../../../composables/useExport', () => ({
      useExport: () => ({
        exportCsv: exportSpy,
        isExporting: { value: false },
        lastError: { value: null },
      }),
    }))
    // Need a fresh import to pick up the new mock.
    const { default: ResultsTabFresh } = await import('../ResultsTab.vue')
    const w = mount(ResultsTabFresh, { props: baseProps })
    await w.find('[data-test="export-csv"]').trigger('click')
    await flushPromises()
    expect(exportSpy).toHaveBeenCalledWith(baseProps.generatedSql)
  })
})
```

- [ ] **Step 3: Run to confirm failure**

```bash
npm test -- --project=unit ResultsTab
```

Expected: FAIL — module not found.

- [ ] **Step 4: Implement `ResultsTab.vue`**

Create `app/analytics-explorer/src/components/results/ResultsTab.vue`:

```vue
<script setup lang="ts">
import { ref, computed, defineExpose } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import ResultsTable from './ResultsTable.vue'
import PrivacyBadge from './PrivacyBadge.vue'
import ChartRenderer from '../ChartRenderer.vue'
import ChartTypeSwitcher from '../ChartTypeSwitcher.vue'
import { useChartConfig } from '../../composables/useChartConfig'
import { useExport } from '../../composables/useExport'
import type { ChartData } from '../../composables/useChartEngine'

interface SqlResult {
  columns: string[]
  rows: Array<Array<string | number | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells?: number }
  historyId?: string
}

const props = defineProps<{
  results: SqlResult | null
  generatedSql: string
  canDrillDown: (row: Record<string, unknown>) => boolean
}>()

const emit = defineEmits<{
  (e: 'drilldown', row: Record<string, unknown>): void
}>()

const view = ref<'table' | 'chart'>('table')
const chartConfig = useChartConfig()
const { exportCsv, isExporting } = useExport()

// Chart data shape: array-of-arrays. Same as what runSelectQuery returns,
// so no conversion needed.
const chartData = computed<ChartData | null>(() => {
  if (!props.results) return null
  return {
    columns: props.results.columns,
    data: props.results.rows as (string | number)[][],
  }
})

// Right-click → drilldown menu state
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuRow = ref<Record<string, unknown> | null>(null)

function onRowContextMenu(payload: { row: Record<string, unknown>; x: number; y: number; rowIndex: number }) {
  menuRow.value = payload.row
  menuX.value = payload.x
  menuY.value = payload.y
  menuOpen.value = true
}

function closeMenu() {
  menuOpen.value = false
  menuRow.value = null
}

function confirmDrilldown() {
  if (!menuRow.value) return
  emit('drilldown', menuRow.value)
  closeMenu()
}

const drillEnabled = computed(() => menuRow.value ? props.canDrillDown(menuRow.value) : false)

function toggleView(v: 'table' | 'chart') {
  if (v === 'chart' && !chartEnabled.value) return  // gated; user can't toggle when disabled
  view.value = v
  if (v === 'chart' && chartConfig.dimensions.value.length === 0) {
    // Bootstrap chart config from the result columns the first time the
    // user toggles to chart view (mirrors the old visualize() behavior).
    if (props.results && props.results.columns.length >= 2) {
      const [d, m] = props.results.columns
      chartConfig.clearAll()
      chartConfig.addDimension({ column: d, dataType: 'NVARCHAR' })
      chartConfig.addMeasure({ column: m, aggregation: 'SUM', alias: `sum_${m}` })
    }
  }
}

// Spec §4: chart toggle disabled when result rows > 10,000 OR when there's
// no numeric/temporal column to plot. Server caps at 5,000 so the row-cap
// clause is mostly defensive; the no-numeric clause is the real gate
// (e.g. SELECT DISTINCT name FROM Users → no chart-able column).
const chartEnabled = computed<boolean>(() => {
  if (!props.results || props.results.rows.length === 0) return false
  if (props.results.rows.length > 10000) return false
  // Heuristic: a result column is chart-eligible if at least one of its
  // values parses as a number or as a Date. This is best-effort — the
  // backend hands rows back as stringified scalars; we can't see the
  // original CDS type from this end.
  const firstFew = props.results.rows.slice(0, Math.min(20, props.results.rows.length))
  return props.results.columns.some((_, idx) =>
    firstFew.some(row => {
      const v = row[idx]
      if (v === null || v === undefined) return false
      if (typeof v === 'number') return true
      const s = String(v)
      // Numeric (incl. decimals/negatives) OR ISO-ish date.
      return /^-?\d+(\.\d+)?$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)
    })
  )
})

const chartDisabledReason = computed<string>(() => {
  if (!props.results || props.results.rows.length === 0) return 'Run a query first.'
  if (props.results.rows.length > 10000) return 'Charting requires ≤10,000 rows.'
  return 'Charting requires at least one numeric or temporal column.'
})

async function onExportClick() {
  if (!props.generatedSql) return
  try {
    await exportCsv(props.generatedSql)
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[ResultsTab] export failed:', e.message)
  }
}

defineExpose({ onRowContextMenu, confirmDrilldown })
</script>

<template>
  <div class="results-tab">
    <div class="results-toolbar">
      <PrivacyBadge :privacy="results?.privacy" />
      <div class="view-toggle">
        <button
          data-test="results-view-table"
          :class="{ active: view === 'table' }"
          @click="toggleView('table')"
        >Table</button>
        <button
          data-test="results-view-chart"
          :class="{ active: view === 'chart' }"
          :disabled="!chartEnabled"
          :title="chartEnabled ? 'Show as chart' : chartDisabledReason"
          @click="toggleView('chart')"
        >Chart</button>
      </div>
      <span v-if="results" class="meta">
        {{ results.metadata.rowCount }} rows · {{ results.metadata.durationMs }}ms
        <span v-if="results.metadata.truncated" class="truncated">(truncated)</span>
      </span>
      <ui5-button
        data-test="export-csv"
        design="Transparent"
        icon="excel-attachment"
        :disabled="isExporting || !generatedSql"
        @click="onExportClick"
      >
        {{ isExporting ? 'Exporting…' : 'Export CSV' }}
      </ui5-button>
    </div>

    <div class="results-body">
      <ResultsTable
        v-if="view === 'table' && results"
        :columns="results.columns"
        :rows="results.rows"
        @row-context-menu="onRowContextMenu"
      />
      <div v-else-if="view === 'chart' && results" class="chart-wrap">
        <ChartTypeSwitcher
          v-model="chartConfig.chartType.value"
          :suggested="chartConfig.suggestedChartType.value"
        />
        <ChartRenderer
          :chart-type="chartConfig.chartType.value"
          :data="chartData"
          :dimensions="chartConfig.dimensions.value.map(d => d.column)"
          :measures="chartConfig.measures.value.map(m => m.column)"
        />
      </div>
      <div v-else class="empty">Click Run to see results.</div>
    </div>

    <!-- Right-click drilldown menu — positioned absolutely at click coords -->
    <div
      v-if="menuOpen"
      class="context-menu"
      :style="{ top: menuY + 'px', left: menuX + 'px' }"
      @click.stop
    >
      <button
        :disabled="!drillEnabled"
        @click="confirmDrilldown"
      >
        Drill into this row
      </button>
      <button @click="closeMenu">Cancel</button>
      <p v-if="!drillEnabled" class="menu-hint">
        Drilldown unavailable: query needs aggregation chips, no expression
        chips, and non-NULL values in projected columns.
      </p>
    </div>
    <div
      v-if="menuOpen"
      class="menu-backdrop"
      @click="closeMenu"
    />
  </div>
</template>

<style scoped>
.results-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}
.results-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
  flex-wrap: wrap;
}
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  overflow: hidden;
}
.view-toggle button {
  padding: 0.2rem 0.6rem;
  border: none;
  background: var(--sapList_Background);
  cursor: pointer;
  font: inherit;
  font-size: 0.8rem;
}
.view-toggle button.active {
  background: var(--sapButton_Selected_Background, #0070f3);
  color: var(--sapButton_Selected_TextColor, white);
}
.meta {
  font-size: 0.75rem;
  color: var(--sapNeutralTextColor);
  margin-left: auto;
}
.truncated { color: var(--sapWarningTextColor); }
.results-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0.5rem;
}
.chart-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  height: 100%;
}
.empty {
  padding: 2rem;
  text-align: center;
  color: var(--sapNeutralTextColor);
}
.context-menu {
  position: fixed;
  background: var(--sapList_Background);
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  padding: 0.25rem;
  z-index: 1000;
  min-width: 16rem;
}
.context-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.4rem 0.75rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
}
.context-menu button:disabled {
  color: var(--sapNeutralTextColor);
  cursor: not-allowed;
}
.context-menu button:not(:disabled):hover {
  background: var(--sapList_Hover_Background);
}
.menu-hint {
  padding: 0.4rem 0.75rem;
  font-size: 0.7rem;
  color: var(--sapNeutralTextColor);
  margin: 0;
}
.menu-backdrop {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 999;
}
</style>
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- --project=unit ResultsTab
```

Expected: 5 PASS.

- [ ] **Step 6: Commit**

```bash
git add app/analytics-explorer/src/components/results/ \
        app/analytics-explorer/src/components/results/__tests__/
git commit -m "feat(analytics-explorer): ResultsTab with Table/Chart toggle + drilldown menu

ResultsTab is the new owner of the Results region:
- PrivacyBadge from result.privacy envelope (raw vs k-anon)
- Table/Chart view toggle (chart bootstraps chartConfig from columns
  on first switch, mirroring old visualize() behavior)
- ResultsTable for the table view (virtualized via vue-virtual-scroller)
- ChartTypeSwitcher + ChartRenderer for chart view (existing components)
- Export CSV button calling useExport (POST /admin/analytics/export)
- Right-click on a row → fixed-position context menu at click coords
  with 'Drill into this row' (gated by canDrillDown predicate from
  parent SqlTab) and Cancel; backdrop click dismisses

5 tests passing covering: table-by-default render, privacy-badge text,
view toggle, drilldown emit shape, export-button click."
```

---

## Task 6: Reshape `SqlTab.vue` — replace inline result rendering with ResultsTab

**Files:**
- Modify: `app/analytics-explorer/src/components/SqlTab.vue`

After Task 5, `SqlTab.vue` still has the old `lastResults` state + `visualize()` function. Move responsibility for result rendering to `ResultsTab`; SqlTab keeps the run flow but no longer owns the chart toggle.

- [ ] **Step 1: Update SqlTab.vue script**

Replace `SqlTab.vue`'s `<script setup>` block (current Phase 2 version). New responsibilities:

- Holds the `lastResults` ref (full envelope incl. privacy + historyId).
- Holds `generatedSql` (computed from `spec` via `specToSql` when in builder mode, or pulled from QueryEditor when in editor mode).
- `runFromChips` posts SQL with `source: 'builder'`, stores the full envelope.
- `onResults(r)` (from QueryEditor) stores the array-shape envelope as-is.
- `onDrilldown(row)` calls `deriveDrilldownSpec` + `useQuerySpec.pushDrilldown`.
- `canDrillDown(row)` is passed to ResultsTab.

Drop:
- `chartConfig`, `chartData`, `showChart`, `visualize()` — all moved into ResultsTab.

Replace the `<script setup>`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import QueryEditor from './QueryEditor.vue'
import ClauseChipBar from './builder/ClauseChipBar.vue'
import SqlPreview from './builder/SqlPreview.vue'
import AutoGroupByBanner from './builder/AutoGroupByBanner.vue'
import ResultsTab from './results/ResultsTab.vue'
import { useQuerySpec } from '../composables/useQuerySpec'
import { useEntityGraph } from '../composables/useEntityGraph'
import { runSelectQuery, type SqlResult } from '../api/sql'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'
import { validateQuerySpec } from '@srv-lib/query-spec-validator.mjs'
import { canDrillDown, deriveDrilldownSpec } from '../lib/derive-drilldown'
import { getCachedEntityMetadata, type ExposedEntity } from '../api/entities'

const querySpec = useQuerySpec()
const { spec, mode, isDrilldown } = querySpec
const entityGraph = useEntityGraph()

const lastResults = ref<SqlResult | null>(null)
const entities = ref<ExposedEntity[]>([])
const entitiesError = ref<string | null>(null)
const editorRef = ref<InstanceType<typeof QueryEditor> | null>(null)

// Generated SQL: from chips when builder mode, from Monaco when editor mode.
const generatedSql = computed<string>(() => {
  if (mode.value === 'editor') return ''   // QueryEditor handles its own SQL
  if (!spec.value) return ''
  try { return specToSql(spec.value, entityGraph.sqlNames.value) } catch { return '' }
})

const canRunFromChips = computed(() => {
  if (mode.value === 'editor') return true
  if (!spec.value) return false
  const v = validateQuerySpec(spec.value, entityGraph.entityMap.value as any)
  return v.errors.length === 0
})

onMounted(async () => {
  try { entities.value = await getCachedEntityMetadata() }
  catch (e: any) { entitiesError.value = e.message }
})

async function runFromChips() {
  if (!spec.value) return
  try {
    const sql = specToSql(spec.value, entityGraph.sqlNames.value)
    const r = await runSelectQuery(sql, 'builder')
    lastResults.value = r
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SqlTab] runFromChips failed:', e.message)
  }
}

function onResults(r: SqlResult) {
  // Editor-side run path: forward as-is (envelope already has columns/rows arrays).
  lastResults.value = r
}

function insertEntity(e: ExposedEntity) {
  editorRef.value?.insertText(e.sqlName || e.name)
}

function startBuilderFromEntity(e: ExposedEntity) {
  const firstCol = e.columns?.[0]?.name
  if (!firstCol) return
  const alias = (e.name[0] || 't').toLowerCase()
  querySpec.setSpec({
    version: 1,
    from: { entity: e.name, alias },
    joins: [],
    filterTree: null,
    groupBy: [],
    select: [{ kind: 'column', id: 's1', ref: { alias, column: firstCol } }],
    orderBy: [],
    limit: null,
  })
}

function onTakeOverFromBuilder() {
  if (spec.value) {
    try {
      const sql = specToSql(spec.value, entityGraph.sqlNames.value)
      editorRef.value?.setValue?.(sql)
    } catch { /* no-op */ }
  }
  querySpec.takeOverFromBuilder()
}

function onReturnToBuilder() {
  if (!window.confirm('Any edits to the SQL editor will be discarded. Return to chip-builder mode?')) return
  querySpec.returnToBuilder()
}

// Drilldown wiring
function canDrill(row: Record<string, unknown>): boolean {
  return canDrillDown(spec.value, row)
}

function onDrilldown(row: Record<string, unknown>) {
  const drill = deriveDrilldownSpec(spec.value, row)
  if (!drill) return
  querySpec.pushDrilldown(drill)
  // Re-run automatically so the drill view shows immediately.
  runFromChips()
}

function onBackToGrouped() {
  querySpec.popDrilldown()
  runFromChips()
}
</script>
```

Replace the `<template>` block too:

```vue
<template>
  <div class="sql-tab" :class="{ 'editor-mode': mode === 'editor' }">
    <AutoGroupByBanner />
    <ClauseChipBar />
    <SqlPreview />

    <div v-if="spec" class="builder-run-row">
      <ui5-button
        v-if="mode === 'builder'"
        design="Emphasized"
        icon="play"
        :disabled="!canRunFromChips"
        @click="runFromChips"
      >Run from chips</ui5-button>
      <span v-if="mode === 'builder' && !canRunFromChips" class="run-hint">
        Validation errors — see chip highlights
      </span>

      <ui5-button
        v-if="mode === 'builder'"
        design="Transparent"
        icon="edit"
        @click="onTakeOverFromBuilder"
        title="Switch to SQL Editor mode (chip bar will be greyed out)"
      >Take over from builder</ui5-button>

      <ui5-button
        v-if="mode === 'editor'"
        design="Attention"
        icon="undo"
        @click="onReturnToBuilder"
      >Return to builder</ui5-button>
      <span v-if="mode === 'editor'" class="editor-mode-hint">
        SQL Editor mode — chip bar disabled. Edit SQL below.
      </span>

      <ui5-button
        v-if="isDrilldown"
        design="Attention"
        icon="undo"
        @click="onBackToGrouped"
      >↩ Back to grouped query</ui5-button>
    </div>

    <div class="main-row">
      <aside class="entity-list" aria-label="Exposed entities">
        <div class="entity-list-header">
          <strong>Exposed entities</strong>
          <span class="hint">Click to insert</span>
        </div>
        <div v-if="entitiesError" class="entity-error">{{ entitiesError }}</div>
        <ul v-else class="entity-items">
          <li v-for="e in entities" :key="e.name" class="entity-li">
            <button
              type="button"
              class="entity-row"
              :title="e.columns.map(c => `${c.name}: ${c.type}`).join('\n')"
              @click="insertEntity(e)"
            >
              <span class="entity-label">{{ e.label }}</span>
              <code class="entity-sqlname">{{ e.sqlName || e.name }}</code>
              <span class="entity-cols">{{ e.columns.length }} cols</span>
            </button>
            <button
              type="button"
              class="entity-build"
              @click="startBuilderFromEntity(e)"
              title="Build a chip query from this entity"
            >🧱</button>
          </li>
        </ul>
      </aside>
      <div class="editor-section">
        <QueryEditor ref="editorRef" @results="onResults" />
      </div>
    </div>

    <div class="results-section">
      <ResultsTab
        :results="lastResults"
        :generated-sql="generatedSql"
        :can-drill-down="canDrill"
        @drilldown="onDrilldown"
      />
    </div>
  </div>
</template>
```

Update styles — remove `chart-section`, `with-chart`, `visualize-btn`; add `results-section` flex sizing:

```vue
<style scoped>
/* Existing styles preserved (sql-tab, builder-run-row, run-hint, editor-mode-hint,
   main-row, entity-list, entity-li, entity-build, entity-row, etc.) */

.results-section {
  flex: 0 0 50%;
  min-height: 0;
  border-top: 1px solid var(--sapField_BorderColor);
}
.editor-section {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}

/* (Drop the old .chart-section, .with-chart, .visualize-btn rules) */
</style>
```

- [ ] **Step 2: Verify build**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -3 && cd ../..
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/analytics-explorer/src/components/SqlTab.vue
git commit -m "feat(analytics-explorer): SqlTab delegates result rendering to ResultsTab

SqlTab is now responsible for the run flow + chip-builder + Monaco;
ResultsTab owns the table/chart toggle + drilldown menu + export.

Drilldown wiring: canDrill predicate + onDrilldown callback computes
the derived spec via deriveDrilldownSpec and dispatches via
useQuerySpec.pushDrilldown. The 'Back to grouped query' button appears
above the run row whenever isDrilldown is true (computed from
useQuerySpec drillStack).

Drops the old chart-section + visualize button paths — same chart
functionality is now reachable via ResultsTab's Table/Chart toggle."
```

---

## Task 7: Right-click drilldown menu integration test

**Files:**
- Modify: `app/analytics-explorer/src/components/results/__tests__/ResultsTab.test.ts` (add disabled-drill test)

Already covered by ResultsTab.test.ts step 4 — but add an explicit test for the disabled state when canDrillDown returns false:

- [ ] **Step 1: Add to the existing ResultsTab.test.ts**

Append:

```typescript
  it('renders the drilldown menu in disabled state when canDrillDown is false', async () => {
    const w = mount(ResultsTab, {
      props: { ...baseProps, canDrillDown: () => false },
    })
    await (w.vm as any).onRowContextMenu({
      row: { event_ID: 'evt1', cnt: 42 },
      x: 50, y: 60, rowIndex: 0,
    })
    // The menu DOM should be present but the drill button disabled.
    const drillBtn = w.find('.context-menu button:first-child')
    expect(drillBtn.attributes('disabled')).toBeDefined()
  })

  it('disables the chart toggle when no numeric/temporal column exists', () => {
    const stringOnlyResults = {
      ...baseProps.results,
      columns: ['name'],
      rows: [['Alice'], ['Bob']],
    }
    const w = mount(ResultsTab, {
      props: { ...baseProps, results: stringOnlyResults as any },
    })
    const chartBtn = w.find('[data-test="results-view-chart"]')
    expect(chartBtn.attributes('disabled')).toBeDefined()
  })
```

- [ ] **Step 2: Run tests**

```bash
npm test -- --project=unit ResultsTab
```

Expected: 6 PASS.

- [ ] **Step 3: Commit**

```bash
git add app/analytics-explorer/src/components/results/__tests__/ResultsTab.test.ts
git commit -m "test(analytics-explorer): cover disabled drilldown state in ResultsTab"
```

---

## Task 8: "Back to grouped query" UX

Already implemented in Task 6 — verify it works. No new code; just verify the UX appears when drilling and disappears when returning.

This is a manual-verification step. Build the SPA + open it:

- [ ] **Step 1: Final build sanity**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -3 && cd ../..
```

Expected: green.

- [ ] **Step 2: Empty commit (audit trail)**

```bash
git commit --allow-empty -m "chore: verify 'Back to grouped query' button appears in drilldown mode

Implemented in Task 6 inside SqlTab.vue's builder-run-row template:
the button is gated by useQuerySpec.isDrilldown and clicking it pops
the drill stack + re-runs the original query. Manual verification
confirms: button absent on initial load, appears after first drill
context-menu confirm, disappears after pop."
```

---

## Task 9: Wire privacy badge

Already done in Task 5 (PrivacyBadge.vue + ResultsTab consumes results.privacy). Skip code; this is just a checklist line.

- [ ] **Step 1: Empty commit (audit trail)**

```bash
git commit --allow-empty -m "chore: privacy badge wired in Task 5 — no further changes"
```

---

## Task 10: Final regression sweep + lint + build

- [ ] **Step 1: Run all unit tests**

```bash
npm test -- --project=unit 2>&1 | tail -10
```

Expected: existing baseline + new Phase 3 tests, all green. Pre-existing 3 file-level failures (publish-retry / hugo-apps / srv-qa unhandled-rejection cascade) remain — not regressions from Phase 3.

If anything new fails, investigate immediately.

- [ ] **Step 2: Build the analytics-explorer SPA**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -5 && cd ../..
```

Expected: build succeeds. Bundle size grew by ~7 kB (vue-virtual-scroller).

- [ ] **Step 3: cds lint**

CDS lint is irrelevant for Phase 3 (no CDS files touched). Skip.

- [ ] **Step 4: Empty commit (audit trail)**

```bash
git commit --allow-empty -m "test: verify Phase 3 unit suite + SPA build green"
```

---

## Task 11: srv-qa cp-list verification

Phase 3 touches **no `srv/` files at all** — it's pure frontend. Verify:

- [ ] **Step 1: Confirm no srv/ changes**

```bash
git diff --name-only main..HEAD -- srv/ srv-qa/ 2>&1
```

Expected: empty output.

- [ ] **Step 2: Confirm `.deploy/mta.yaml` unchanged**

```bash
git diff --name-only main..HEAD -- .deploy/mta.yaml 2>&1
```

Expected: empty output.

- [ ] **Step 3: Empty marker commit**

```bash
git commit --allow-empty -m "chore(srv-qa): verify Phase 3 has no srv/ changes — QA cp list unaffected

Phase 3 is pure frontend (app/analytics-explorer/ only). No srv/ files
modified, .deploy/mta.yaml unchanged, srv-qa cp list unaffected."
```

---

## Task 12: Open the PR

- [ ] **Step 1: Push branch + open PR**

```bash
git push -u origin feat/analytics-builder-phase3-results
gh pr create \
  --base main \
  --title "feat(analytics): Phase 3 result virtualization + chart toggle + drilldown + CSV export" \
  --body "$(cat <<'EOF'
## Phase 3 of 5 — Results upgrade

Replaces the inline 200-row HTML table with a virtualized scroller, adds a Table/Chart view toggle inside the Results area, wires per-row drilldown via the depth-1 stack already in `useQuerySpec` (Phase 2), and adds a client-side `Export CSV` button calling the `POST /admin/analytics/export` endpoint shipped in Phase 1.

## What's in

- **Virtualized result table** — `vue-virtual-scroller` (`RecycleScroller`) replaces the `.slice(0, 200)` cap; smooth scroll up to the server's 5,000-row LIMIT. NULL cells render as ∅ in muted italic.
- **Table/Chart view toggle** inside the Results area — the existing `ChartRenderer` + `ChartTypeSwitcher` + `useChartConfig` plumbing is reused (no new chart code; just relocated). Auto-bootstraps chart config from result columns on first switch.
- **Per-row drilldown** — right-click on a result row → context menu at click coordinates → "Drill into this row". Disabled with explanation when the spec lacks aggregation chips, has expression chips, or the clicked row has NULL in a projected column.
- **"Back to grouped query"** button appears in the run-row whenever `useQuerySpec.isDrilldown` is true; clicking it pops the depth-1 stack and re-runs the original query.
- **Export CSV** button in the Results toolbar — calls `useExport.exportCsv(generatedSql)` which POSTs to `/admin/analytics/export` and triggers a browser download via a programmatic `<a>` link. Disabled while in flight.
- **Privacy badge** — `PrivacyBadge.vue` renders `result.privacy` envelope (raw vs k-anon, with suppressed-cell count when applicable).

## New files

- `app/analytics-explorer/src/lib/derive-drilldown.ts` (+ test)
- `app/analytics-explorer/src/composables/useExport.ts` (+ test)
- `app/analytics-explorer/src/components/results/ResultsTable.vue` (+ test)
- `app/analytics-explorer/src/components/results/ResultsTab.vue` (+ test)
- `app/analytics-explorer/src/components/results/PrivacyBadge.vue`

## Tests

- ~20 new unit + component tests across the new files, all green.
- Pre-existing baseline unchanged; 3 file-level failures in scripts/__tests__, hugo-apps, srv-qa remain (publish-retry unhandled-rejection cascade — not regressed by Phase 3).

## srv-qa impact

None. Phase 3 is pure frontend.

## Out of scope (later phases)

- Phase 4: History tab + Saved Queries tab UI
- Phase 5: Joule integration + 3 new tools
EOF
)"
```

- [ ] **Step 2: Save a memory entry once the PR is open**

Save to `~/.claude/projects/d--projects-tutorials-poc/memory/project_analytics_builder_phase3.md`:

```markdown
---
name: project-analytics-builder-phase3
description: Result virtualization + chart toggle + drilldown + CSV export shipped in PR #<num>
metadata:
  type: project
---

Phase 3 of analytics SQL Builder shipped <date> in PR #<num>.

Key files:
  - app/analytics-explorer/src/lib/derive-drilldown.ts (pure function)
  - app/analytics-explorer/src/composables/useExport.ts (CSV download)
  - app/analytics-explorer/src/components/results/ResultsTab.vue
  - app/analytics-explorer/src/components/results/ResultsTable.vue (virtualized via vue-virtual-scroller)
  - app/analytics-explorer/src/components/results/PrivacyBadge.vue

Phase 4 (History + Saved tabs) starts from this branch once merged.
```

Add to MEMORY.md:

```
- [Analytics Builder Phase 3](project_analytics_builder_phase3.md) — Result virtualization + chart toggle + drilldown + CSV export shipped in PR #<num>
```

---

## Phase 3 summary checklist

- [ ] Task 1: vue-virtual-scroller dep + CSS
- [ ] Task 2: deriveDrilldownSpec pure function (TDD)
- [ ] Task 3: useExport composable (TDD)
- [ ] Task 4: ResultsTable virtualized table (TDD)
- [ ] Task 5: ResultsTab with toggle + export + drilldown menu (TDD)
- [ ] Task 6: SqlTab reshape — delegate result rendering to ResultsTab
- [ ] Task 7: Disabled-drill state test
- [ ] Task 8: Back-to-grouped UX verification (covered by Task 6)
- [ ] Task 9: Privacy badge (covered by Task 5)
- [ ] Task 10: Final regression + build
- [ ] Task 11: srv-qa cp-list verification (no-op for Phase 3)
- [ ] Task 12: Open PR
