# Analytics SQL Builder — Phase 2 Part B (Tasks 9–25)

**Continuation of:** [2026-05-31-analytics-builder-phase2-chip-builder-part-a.md](./2026-05-31-analytics-builder-phase2-chip-builder-part-a.md)

> **For agentic workers:** Same conventions as Part A. Run Part A's tasks 1–8 to green before starting Task 9 here. Same branch (`feat/analytics-builder-phase2-chip-builder`).

---

## Phase 2 Part B task list (Tasks 9–25)

9. Live SQL preview component (`SqlPreview.vue`) — read-only Monaco
10. SqlTab layout reshape: chip bar + SQL preview + tab strip (Results / SQL Editor / History stub / Saved stub)
11. FromChip (TDD via component test)
12. JoinChip (TDD)
13. FilterChip — leaf chip (eq/neq/in/contains for `enum`/`free` modes; date ops for `date` mode)
14. FilterGroupChip — bracket-style group with AND/OR conjunction toggle, Ctrl-click multi-select to wrap, ungroup, NOT
15. GroupByChip (auto-derived + explicit)
16. SelectChip — column / aggregation / expression sub-shapes
17. OrderByChip + LimitChip
18. Run button + result envelope handling (privacy badge + historyId display)
19. Lift Monaco into the SQL Editor tab (existing `QueryEditor.vue` becomes `SqlEditorTab.vue`); take-over mode wires to `useQuerySpec.takeOverFromBuilder()`
20. Result table cleanup — keep the existing 200-row HTML table (Phase 3 will virtualize); ensure it consumes the new envelope shape
21. Joule stub button confirmation (no orchestrator wiring) + History/Saved tab stubs
22. Auto-GROUP-BY one-shot banner
23. Final regression sweep + cds lint
24. srv-qa cp-list verification (no Phase 2 srv changes)
25. Open PR

---

## Task 9: Live SQL preview (`SqlPreview.vue`)

**Files:**
- Create: `app/analytics-explorer/src/components/builder/SqlPreview.vue`

Read-only Monaco that re-renders on every `setSpec`. Reuses the same lazy Monaco import pattern as `QueryEditor.vue`.

- [ ] **Step 1: Create the component**

Create `app/analytics-explorer/src/components/builder/SqlPreview.vue`:

```vue
<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useQuerySpec } from '../../composables/useQuerySpec'
import { useEntityGraph } from '../../composables/useEntityGraph'
import { useTheme } from '../../composables/useTheme'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'
import { validateQuerySpec } from '@srv-lib/query-spec-validator.mjs'

const { spec } = useQuerySpec()
const entityGraph = useEntityGraph()
const { isDark } = useTheme()

const editorEl = ref<HTMLElement | null>(null)
let editor: any = null
let monacoNs: any = null
let destroyed = false

const generated = computed<string>(() => {
  if (!spec.value) return '-- (empty — add chips to build a query)'
  if (entityGraph.entityMap.value.size === 0) return '-- (loading entity metadata...)'
  const v = validateQuerySpec(spec.value, entityGraph.entityMap.value)
  if (v.errors.length) {
    return `-- (${v.errors.length} validation error${v.errors.length === 1 ? '' : 's'} — see chip highlights)`
  }
  try {
    return specToSql(spec.value, entityGraph.sqlNames.value)
  } catch (e: any) {
    return `-- spec-to-sql error: ${e.message}`
  }
})

onMounted(async () => {
  monacoNs = await import('monaco-editor')
  if (destroyed || !editorEl.value) return
  editor = monacoNs.editor.create(editorEl.value, {
    value: generated.value,
    language: 'sql',
    theme: isDark.value ? 'vs-dark' : 'vs',
    readOnly: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: 'on',
    automaticLayout: false,
  })
  const ro = new ResizeObserver(() => editor?.layout())
  ro.observe(editorEl.value)
  ;(editor as any)._ro = ro
})

onBeforeUnmount(() => {
  destroyed = true
  ;(editor as any)?._ro?.disconnect()
  editor?.dispose()
})

watch(generated, (s) => {
  if (editor && !destroyed) editor.setValue(s)
})

watch(isDark, (dark) => {
  if (monacoNs && !destroyed) monacoNs.editor.setTheme(dark ? 'vs-dark' : 'vs')
})
</script>

<template>
  <div class="sql-preview">
    <div class="sql-preview-header">
      <span class="label">SQL Preview</span>
      <span v-if="spec" class="hint">read-only — edit chips above to change</span>
    </div>
    <div ref="editorEl" class="sql-preview-editor" />
  </div>
</template>

<style scoped>
.sql-preview { border-bottom: 1px solid var(--sapList_BorderColor); }
.sql-preview-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.25rem 1rem; background: var(--sapList_HeaderBackground);
  font-size: 0.75rem;
}
.label { font-weight: bold; color: var(--sapContent_LabelColor); }
.hint { color: var(--sapContent_LabelColor); font-style: italic; }
.sql-preview-editor { height: 8rem; }
</style>
```

- [ ] **Step 2: Build to verify the component compiles**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -5 && cd ../..
```

Expected: build succeeds. Any TypeScript or alias-resolution errors surface here.

- [ ] **Step 3: Commit**

```bash
git add app/analytics-explorer/src/components/builder/SqlPreview.vue
git commit -m "feat(analytics-explorer): add SqlPreview (read-only Monaco)

Real-time SQL preview that re-renders on every setSpec. Pulls
specToSql + validateQuerySpec from @srv-lib (the isomorphic Phase 1
modules); when the spec has validation errors, the preview shows
'-- (N validation errors)' instead of garbage SQL — the chip bar
will render the offending chips in red.

Theme-reactive via useTheme().isDark (matches QueryEditor.vue pattern)."
```

---

## Task 10: SqlTab layout reshape

**Files:**
- Modify: `app/analytics-explorer/src/components/SqlTab.vue`

Reshape: ChipBar + SqlPreview at top; tab strip (Results / SQL Editor / History / Saved) below; Joule rail on the right (still a stub button).

**Preserve existing chart functionality.** The existing SqlTab today has a `Visualize` button that, after a run, opens a `ChartTypeSwitcher` + `ChartRenderer` panel below the editor. The reshape **must keep this** — it's shipped behavior and the spec calls for inline charting in Phase 2 (per the v1 amendments). The chart panel moves into the Results tab content (alongside the table) rather than being a separate section.

- [ ] **Step 1: Reshape the template**

Replace the entire `<template>` block of `app/analytics-explorer/src/components/SqlTab.vue` with the chip-bar-first layout:

```vue
<template>
  <div class="sql-tab">
    <div class="main-grid">
      <div class="builder-column">
        <ClauseChipBar />
        <SqlPreview />
        <div class="tab-strip" role="tablist">
          <button :class="{ active: bottomTab === 'results' }" @click="bottomTab = 'results'" role="tab">Results</button>
          <button :class="{ active: bottomTab === 'editor' }" @click="bottomTab = 'editor'" role="tab">SQL Editor</button>
          <button :class="{ active: bottomTab === 'history' }" @click="bottomTab = 'history'" role="tab">History</button>
          <button :class="{ active: bottomTab === 'saved' }" @click="bottomTab = 'saved'" role="tab">Saved</button>
          <div class="tab-strip-spacer" />
          <ui5-button design="Emphasized" icon="play" @click="runFromChips" :disabled="!canRun">Run</ui5-button>
        </div>
        <div class="tab-content">
          <div v-if="bottomTab === 'results'" class="results-panel">
            <PrivacyBadge v-if="lastResults" :privacy="lastResults.privacy" />
            <div class="results-toolbar" v-if="lastResults && lastResults.rows.length">
              <ui5-button design="Transparent" icon="chart-table-view" @click="visualize">
                {{ showChart ? 'Hide chart' : 'Visualize' }}
              </ui5-button>
            </div>
            <table v-if="lastResults && lastResults.rows.length" class="results-table">
              <thead><tr><th v-for="c in lastResults.columns" :key="c">{{ c }}</th></tr></thead>
              <tbody>
                <tr v-for="(row, i) in lastResults.rows.slice(0, 200)" :key="i">
                  <td v-for="(cell, j) in row" :key="j">{{ cell ?? '∅' }}</td>
                </tr>
              </tbody>
            </table>
            <div v-else-if="lastResults" class="empty">No rows.</div>
            <div v-else class="empty">Click Run to see results.</div>
            <!-- Inline chart panel — preserves the existing Visualize feature.
                 Phase 3 will replace this with the proper Table/Chart toggle + ECharts integration. -->
            <div v-if="showChart && chartData" class="chart-section">
              <ChartTypeSwitcher v-model="chartConfig.chartType.value" :suggested="chartConfig.suggestedChartType.value" />
              <ChartRenderer
                :chart-type="chartConfig.chartType.value"
                :data="chartData"
                :dimensions="chartConfig.dimensions.value.map(d => d.column)"
                :measures="chartConfig.measures.value.map(m => m.column)"
              />
            </div>
          </div>
          <div v-show="bottomTab === 'editor'">
            <SqlEditorTab ref="editorTabRef" @results="onResults" />
          </div>
          <div v-show="bottomTab === 'history'" class="empty">
            History tab — Phase 4.
          </div>
          <div v-show="bottomTab === 'saved'" class="empty">
            Saved queries tab — Phase 4.
          </div>
        </div>
      </div>
      <aside class="entity-sidebar">
        <EntitySidebar @insert="onEntityClicked" />
      </aside>
      <aside class="joule-rail">
        <ui5-button icon="da" design="Transparent" title="Joule (Phase 5)" disabled />
      </aside>
    </div>
  </div>
</template>
```

- [ ] **Step 2: Update the script setup**

Replace the `<script setup>` block of `SqlTab.vue` with:

```vue
<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import ClauseChipBar from './builder/ClauseChipBar.vue'
import SqlPreview from './builder/SqlPreview.vue'
import SqlEditorTab from './tabs/SqlEditorTab.vue'
import EntitySidebar from './builder/EntitySidebar.vue'
import PrivacyBadge from './results/PrivacyBadge.vue'
// Preserve existing chart functionality — moved into the Results tab.
import ChartRenderer from './ChartRenderer.vue'
import ChartTypeSwitcher from './ChartTypeSwitcher.vue'
import { useChartConfig } from '../composables/useChartConfig'
import type { ChartData } from '../composables/useChartEngine'
import { useQuerySpec } from '../composables/useQuerySpec'
import { useEntityGraph } from '../composables/useEntityGraph'
import { runSelectQuery } from '../api/sql'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'
import { validateQuerySpec } from '@srv-lib/query-spec-validator.mjs'

const { spec, mode } = useQuerySpec()
const entityGraph = useEntityGraph()
const bottomTab = ref<'results' | 'editor' | 'history' | 'saved'>('results')
const lastResults = ref<any | null>(null)
const editorTabRef = ref<any>(null)

// Chart state — same shape as before, just moved alongside the new layout.
const chartConfig = useChartConfig()
const chartData = ref<ChartData | null>(null)
const showChart = ref(false)

const canRun = computed(() => {
  if (mode.value === 'editor') return true   // SqlEditorTab handles its own run
  if (!spec.value) return false
  const v = validateQuerySpec(spec.value, entityGraph.entityMap.value)
  return v.errors.length === 0
})

async function runFromChips() {
  if (mode.value === 'editor') {
    editorTabRef.value?.run()
    return
  }
  if (!spec.value) return
  const sql = specToSql(spec.value, entityGraph.sqlNames.value)
  try {
    const r = await runSelectQuery(sql, 'builder')
    lastResults.value = r
    showChart.value = false  // hide chart on new query; user clicks Visualize again
  } catch (e: any) {
    lastResults.value = { error: e.message, columns: [], rows: [] }
  }
}

function onResults(r: any) {
  lastResults.value = r
  showChart.value = false
}

function onEntityClicked(name: string) {
  // EntitySidebar emits the logical entity name. Task 11 lands the actual
  // setSpec call: when the builder is empty and the user clicks an entity,
  // FromChip's "Create" path constructs a fresh single-entity spec via
  // useQuerySpec().setSpec({ from: { entity: name, alias: aliasFromName(name) }, ... }).
  // For now this is a no-op so the build compiles.
}

// Toggle chart panel — same logic as the existing visualize() function,
// just preserved across the layout reshape.
function visualize() {
  if (!lastResults.value || !lastResults.value.rows?.length) return
  if (showChart.value) {
    showChart.value = false
    return
  }
  showChart.value = true
  const cols = lastResults.value.columns as string[]
  chartData.value = {
    columns: cols,
    data: lastResults.value.rows.map((row: any) => cols.map(c => row[c])),
  }
  if (cols.length >= 2) {
    chartConfig.clearAll()
    chartConfig.addDimension({ column: cols[0], dataType: 'NVARCHAR' })
    chartConfig.addMeasure({ column: cols[1], aggregation: 'SUM', alias: `sum_${cols[1]}` })
  }
}
</script>
```

(Note: the new envelope returns `rows: string[][]` — an array of arrays, indexed by column position — but the existing `visualize()` was written when the envelope used `rows: object[]` with column keys. The plan's envelope from Phase 1's `runSelectQuery` is `rows: Array<Array<string | null>>` per `app/analytics-explorer/src/api/sql.ts`. So `row[c]` becomes `row[cols.indexOf(c)]`. Adjust the visualize body accordingly:

```typescript
chartData.value = {
  columns: cols,
  data: lastResults.value.rows.map((row: any[]) => cols.map((_, idx) => row[idx])),
}
```

This is a behaviour-preserving fix: the chart sees the same data, just sourced via index rather than key.)

- [ ] **Step 3: Create the stub component files**

(unchanged from the prior version of this task — EntitySidebar.vue, SqlEditorTab.vue, PrivacyBadge.vue stubs as previously specified)

[Stub component file contents preserved — see prior plan revision below for FULL bodies.]

Create `app/analytics-explorer/src/components/builder/EntitySidebar.vue`:

```vue
<script setup lang="ts">
import { useEntityGraph } from '../../composables/useEntityGraph'
const emit = defineEmits<{ (e: 'insert', name: string): void }>()
const { entities } = useEntityGraph()
</script>

<template>
  <div class="entity-sidebar-inner">
    <strong>Entities</strong>
    <ul>
      <li v-for="e in entities" :key="e.name">
        <button @click="emit('insert', e.name)">{{ e.label }}</button>
      </li>
    </ul>
  </div>
</template>
```

Create `app/analytics-explorer/src/components/tabs/SqlEditorTab.vue`:

```vue
<script setup lang="ts">
import { defineExpose } from 'vue'
import QueryEditor from '../QueryEditor.vue'
import { ref } from 'vue'
const editorRef = ref<any>(null)
const emit = defineEmits<{ (e: 'results', r: any): void }>()
function run() { editorRef.value?.run?.() }
defineExpose({ run })
</script>

<template>
  <QueryEditor ref="editorRef" @results="(r: any) => emit('results', r)" />
</template>
```

Create `app/analytics-explorer/src/components/results/PrivacyBadge.vue`:

```vue
<script setup lang="ts">
defineProps<{ privacy?: { mode: 'raw' | 'k-anon'; suppressedCells?: number } }>()
</script>

<template>
  <span v-if="privacy?.mode === 'raw'" class="badge badge-raw">
    Raw query — no privacy filter
  </span>
  <span v-else-if="privacy?.mode === 'k-anon'" class="badge badge-kanon">
    Privacy-filtered (k≥5){{ privacy.suppressedCells ? ` — ${privacy.suppressedCells} cells suppressed` : '' }}
  </span>
</template>

<style scoped>
.badge { padding: 0.25rem 0.5rem; border-radius: 4px; font-size: 0.75rem; }
.badge-raw   { background: #fff3cd; color: #856404; }
.badge-kanon { background: #d4edda; color: #155724; }
</style>
```

- [ ] **Step 4: Update sql.ts to accept a source parameter**

(unchanged — see prior version)

```typescript
export interface SqlResult {
  columns: string[]
  rows: Array<Array<string | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells: number }
  historyId?: string
}

export async function runSelectQuery(
  sql: string,
  source: 'builder' | 'editor' | 'joule' | 'replay' = 'editor',
): Promise<SqlResult> {
  const r = await fetch('/admin/analytics/runSelectQuery', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ sql, source }),
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`runSelectQuery ${r.status}: ${text}`)
  }
  const result = await r.json()
  if (!result || !Array.isArray(result.columns) || !Array.isArray(result.rows)) {
    throw new Error('runSelectQuery: malformed response')
  }
  return result as SqlResult
}
```

- [ ] **Step 5: Build to verify**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -10 && cd ../..
```

Expected: build succeeds.

- [ ] **Step 6: Commit**

```bash
git add app/analytics-explorer/src/
git commit -m "feat(analytics-explorer): reshape SqlTab layout for chip builder

Layout: ChipBar + SqlPreview + tab strip (Results / SQL Editor /
History / Saved) on the left; entity sidebar in the middle; Joule
rail (stub button) on the right.

Stubs created: EntitySidebar.vue (lists entities, emits 'insert'),
SqlEditorTab.vue (wraps existing QueryEditor), PrivacyBadge.vue
(renders result.privacy envelope).

Existing chart functionality preserved — Visualize button + ChartRenderer
+ ChartTypeSwitcher now live inside the Results tab content. Same
useChartConfig composable; only the row-indexing changed (Phase 1's
envelope returns rows as arrays, not objects).

api/sql.ts updated to accept source parameter ('builder' | 'editor' |
'joule' | 'replay') and to type the new result envelope (privacy +
historyId)."
```

---

## Tasks 11–17: Chip kinds (one task per kind)

**Caveat for the implementer:** the chip-by-chip implementation is largely mechanical — each chip is a small Vue SFC that takes a chip-state-slice prop, emits a `change` event with the next-spec-fragment, and uses a UI5 popover for editing. Rather than expanding every step inline, the next 7 tasks follow this template:

**Per-chip task template:**

1. **Step 1:** Write a Vitest component test using `@vue/test-utils` (NEW DEP — install in Task 11 Step 0).
2. **Step 2:** Run to confirm failure (component not found).
3. **Step 3:** Implement the SFC.
4. **Step 4:** Run the test to green.
5. **Step 5:** Add the chip to `ClauseChipBar.vue`'s template (replacing the spec-debug placeholder).
6. **Step 6:** Manual sanity: `npm run build` + visual inspection in the dev server (skip if blocked).
7. **Step 7:** Commit.

The first chip (FromChip) sets up `@vue/test-utils` and the per-chip test pattern; subsequent chips follow the same shape with progressively richer popover UX.

### Task 11 Step 0 (one-time setup): Test environment for component tests

**No npm install needed.** The repo root `package.json` already declares `@vue/test-utils@2.4.10` and `happy-dom@15.11.7` as devDependencies — both are available to the SPA's tests via the shared `node_modules`.

The Vitest unit project at `vitest.config.ts` runs with `environment: 'node'` by default. Component tests need `happy-dom`. Two options:

- **Per-file pragma (chosen):** prefix each component test file with `// @vitest-environment happy-dom` on the first line. Lightweight, no global config change, only the files that need DOM get the cost. Example shown in the FromChip test below.
- (Alternative — not chosen for Phase 2: a separate `dom-unit` Vitest project. Defer until enough component tests exist to justify it.)

**Fail-fast smoke step (do this BEFORE writing any chip implementation):** after creating the FromChip test file but before implementing FromChip itself, run `npm test -- --project=unit FromChip` and verify the failure mode is "Cannot find module '../FromChip.vue'" — NOT "Cannot find package '@vue/test-utils'" or "happy-dom is not defined". A `@vue/test-utils` import failure at this point means the per-file pragma isn't taking; stop and check the test file's first line is exactly `// @vitest-environment happy-dom` (no leading whitespace, no surrounding markdown).

If the Vitest unit project needs explicit access to `@vue/test-utils` (it shouldn't — Node module resolution walks up to root), confirm by running the FromChip test in Task 11 below. If the test fails to resolve `@vue/test-utils`, escalate.

### Task 11: FromChip

**Files:**
- Create: `app/analytics-explorer/src/components/builder/chips/FromChip.vue`
- Create: `app/analytics-explorer/src/components/builder/chips/__tests__/FromChip.test.ts`

The simplest chip — single chip, never deletable, popover offers entity dropdown + alias field.

Test outline (write the failing test):

```typescript
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import FromChip from '../FromChip.vue'

describe('FromChip', () => {
  it('renders the entity name + alias', () => {
    const w = mount(FromChip, {
      props: {
        from: { entity: 'Tasks', alias: 't' },
        availableEntities: [{ name: 'Tasks', label: 'Tasks' }, { name: 'Users', label: 'Users' }],
      },
    })
    expect(w.text()).toContain('Tasks')
    expect(w.text()).toContain('t')
  })

  it('emits change when entity dropdown selects a different entity', async () => {
    const w = mount(FromChip, {
      props: {
        from: { entity: 'Tasks', alias: 't' },
        availableEntities: [{ name: 'Tasks', label: 'Tasks' }, { name: 'Users', label: 'Users' }],
      },
    })
    // The chip exposes an internal "applyChange" method; in the popover form
    // tests mock the UI5 select via direct invocation.
    await (w.vm as any).applyChange({ entity: 'Users', alias: 'u' })
    expect(w.emitted('change')).toBeTruthy()
    expect(w.emitted('change')![0][0]).toEqual({ entity: 'Users', alias: 'u' })
  })
})
```

Implementation outline: a clickable chip that opens a `<ui5-popover>` with `<ui5-select>` for entity and `<ui5-input>` for alias; emits `change` on apply.

End with a commit:

```bash
git add app/analytics-explorer/src/components/builder/chips/FromChip.vue \
        app/analytics-explorer/src/components/builder/chips/__tests__/FromChip.test.ts \
        app/analytics-explorer/package.json \
        app/analytics-explorer/package-lock.json \
        vitest.config.ts
git commit -m "feat(analytics-explorer): FromChip + @vue/test-utils setup"
```

### Task 12: JoinChip

Same template as FromChip (per-chip-task structure: failing test → impl → wire into ClauseChipBar → commit).

**Props:** `{ join: Join; aliasMap: Map<string, EntityMeta>; suggestions: AssociationMeta[] }`

**Emits:** `change(join: Join)`, `remove()`

**Popover layout:**

- INNER / LEFT radio group at top
- "Suggested joins" section: radio list of `suggestions` (driven by `useEntityGraph.joinableTo()` for aliases already in the spec). Each row: target entity label + `ON x.col1 = y.col2`.
- "Custom join" section: target-entity dropdown + alias input + ON column-pair selectors (left side: column dropdown filtered to currently-aliased entities' columns; right side: column dropdown filtered to the chosen target entity's columns).
- Apply / Cancel buttons.

**Test cases (minimum):**

1. Renders compact form `INNER JOIN Users (u) ON t.user_ID = u.ID`.
2. Suggestions list populates from `joinableTo()` props.
3. Selecting a suggestion emits `change` with the suggested join shape.
4. Custom-join apply emits `change` with the custom shape.
5. Removing emits `remove()`.

End with `git commit -m "feat(analytics-explorer): JoinChip with association suggestions"`.

### Task 13: FilterChip (leaf)

Most polymorphic chip. Popover renders different controls depending on the column's `filterMode` from the entity graph. The chip itself takes a single `Filter` leaf node and emits `change(Filter)` on apply.

**Props:** `{ filter: Filter; aliasMap: Map<string, EntityMeta>; sampleDistinctCached: (table, col) => Promise<DistinctResult> }`

**Emits:** `change(filter: Filter)`, `remove()`

**Available operators per `filterMode` × column-type classification** (mirrors `OP_TYPE_OK` in the validator):

| filterMode  | Allowed ops                                                          | Value editor                                                    |
| ----------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| `enum`      | `eq`, `neq`, `in`, `isNull`                                          | Multi-select dropdown of distinct values via `sampleDistinctCached`; "type custom" fallback |
| `date`      | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `sinceDays`, `inLastDays`, `inCurrent`, `isNull` | per-op: date picker / two date pickers / number+unit / period dropdown |
| `numeric-range` | `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `isNull`        | numeric input(s)                                                |
| `free` (default) | `eq`, `neq`, `contains`, `startsWith`, `endsWith`, `isNull` (no `in` — paste-the-spreadsheet attack vector) | text input                                                  |

**Popover layout:**

1. Column dropdown — filtered to columns of currently-aliased entities.
2. Operator dropdown — filtered by the column's resolved `filterMode` (look up via `aliasMap.get(ref.alias).columns.get(ref.column).filterMode`).
3. Value editor — picked from the table above based on operator. For `enum`+`sample=true`, the dropdown lazy-loads distinct values via `sampleDistinctCached` on first open; show a loading indicator until resolved; show "Showing first 100 distinct values — type to add a custom value" when the result was truncated.
4. NOT toggle (sets `filter.negated = true`).
5. Apply / Cancel.

**Compact-form display when collapsed:** `WHERE t.status IN (PENDING, IN_PROGRESS)` — multi-line OK if many list values; truncate via `…` after 60 chars.

**Test cases (minimum, one per filterMode):**

1. Renders compact form for an `enum`-mode chip.
2. Renders compact form for a `date`-mode chip with `sinceDays` op.
3. Operator dropdown filters by `filterMode` (e.g. `between` not offered for `enum`).
4. Value-editor switches when operator changes (string `contains` → text input; `between` → two pickers).
5. `sampleDistinctCached` is invoked once when an enum dropdown opens.
6. Apply emits `change` with the next `Filter` shape, with `value.kind` matching the operator's expected kind (validator's OP_VALUE_KIND).
7. NOT toggle round-trips through `change` with `negated: true`.

End with `git commit -m "feat(analytics-explorer): FilterChip leaf with mode-driven editors"`.

### Task 14: FilterGroupChip (recursive)

The recursive container that renders the filter tree as `(` ... children ... `)` with conjunction tokens between siblings. Children are either `FilterChip` (leaf) or `FilterGroupChip` (recursive).

**Props:** `{ group: FilterGroup; aliasMap: Map<string, EntityMeta>; sampleDistinctCached: (table, col) => Promise<DistinctResult>; depth: number }`

**Emits:** `change(group: FilterGroup)`, `remove()`, `unwrap()` (replaces this group with its single child — only valid when `children.length === 1`).

**Layout:**

- Open-bracket chip `(` — clickable, opens a popover with: AND/OR conjunction toggle + NOT-wrap toggle + Ungroup button.
- Children rendered in order, with conjunction tokens `AND` / `OR` between adjacent siblings (read from `group.conjunction`).
- ⊕ chip at the end of the group's child list — adds a new sibling. Disabled when `depth >= 4` ([validator's MAX_GROUP_DEPTH]).
- Close-bracket chip `)`.
- Ctrl/⌘-click selection: track selected children in component-local state. When 2+ siblings are selected, a floating "Group these (AND) / (OR)" button appears above the bar. Clicking it wraps the selected children in a new nested `FilterGroup` and emits `change` with the new tree.

**Recursion guard:** the `depth` prop is incremented on each level. `<FilterGroupChip>` renders `<FilterGroupChip>` for child groups with `:depth="depth + 1"`. The validator already enforces depth ≤ 4 — the chip's job is to disable the "Add nested group" affordance past depth 4 (good UX) and rely on the validator to surface a chip-level error if a malformed spec arrives via Joule or saved-query restore.

**Test cases (minimum):**

1. Renders a group with two leaf children + an `AND` token between them.
2. Renders a nested group with `OR` conjunction.
3. Conjunction toggle emits `change` with the new conjunction value.
4. Adding a child via ⊕ emits `change` with `children.length + 1`.
5. Removing a child (child's `remove` event) emits `change` with the child gone.
6. Multi-select two children + "Group these (AND)" emits `change` with a new nested group.
7. Single-child groups expose `unwrap()` which the parent uses to flatten.
8. `depth >= 4` disables the "Add nested group" affordance (but still allows leaf adds).

End with `git commit -m "feat(analytics-explorer): FilterGroupChip recursive AND/OR tree with multi-select wrap"`.

### Task 15: GroupByChip

Auto-derived from non-aggregation SELECT chips when at least one aggregation is present (matches `deriveAutoGroupBy` in `spec-to-sql.mjs`). Explicit-only chips edited via `spec.groupBy[]`.

**Props (per chip):** `{ key: { id, ref, auto: boolean }; aliasMap: Map<string, EntityMeta> }`

**Emits:** `change(key)`, `remove()` — both no-ops when `auto: true` (the chip is read-only).

**Bar-level:** ⊕ button adds a new explicit `GroupKey`. Auto-derived chips are visually marked `(auto)` and unclickable.

**Test cases:** rendering when `auto: true` (no popover, no remove), rendering when explicit (popover lets user change column, remove deletes).

End with `git commit -m "feat(analytics-explorer): GroupByChip (auto-derived + explicit)"`.

### Task 16: SelectChip

Discriminated union: `column` | `aggregation` | `expression`. Three popover layouts, one per kind. The chip-bar's ⊕ button offers a quick-pick: column → aggregation → expression (column is the default; expression is two clicks deep, intentionally path-of-most-friction).

**Props:** `{ item: SelectItem; aliasMap: Map<string, EntityMeta> }`

**Emits:** `change(item: SelectItem)`, `remove()`

**Popover layout per kind:**

- **column** (`kind: 'column'`):
  - Column dropdown (filtered to currently-aliased entities' columns)
  - Alias input (optional)
- **aggregation** (`kind: 'aggregation'`):
  - Function dropdown: `count` / `sum` / `avg` / `min` / `max`
  - Column picker (or `*` for `count(*)`) — filtered to aliased entities; for sum/avg/min/max only numeric columns
  - DISTINCT toggle
  - Alias input (recommended; default `count_*`, `sum_<col>`, etc.)
- **expression** (`kind: 'expression'`):
  - Monospace `<textarea>` for the SQL fragment
  - Required alias input
  - Live syntax-error indicator: validate via a small wrapper `app/analytics-explorer/src/lib/expr-validator.ts` that calls `new Parser().astify(sql, { database: 'MySQL' })` on each keystroke (debounced 200ms). Show parse errors inline below the textarea.
  - Auto-detected `referencedAliases`: scan the AST for column refs; populate the array on Apply.

**Compact-form display:**

- column: `t.status` or `t.status AS my_status`
- aggregation: `COUNT(*) AS task_count`, `SUM(t.amount) AS total`
- expression: `YEAR(t.createdAt) AS year` with a small ƒ icon prefix

**`expr-validator.ts` (small new module):**

```typescript
import { Parser } from 'node-sql-parser'

const parser = new Parser()

export interface ExprValidationResult {
  ok: boolean
  error?: string
  referencedAliases: string[]
}

export function validateExpression(sql: string): ExprValidationResult {
  if (!sql.trim()) return { ok: false, error: 'expression is empty', referencedAliases: [] }
  // Wrap in SELECT so a bare expression parses.
  try {
    const ast = parser.astify(`SELECT ${sql} FROM dummy`, { database: 'MySQL' }) as any
    const aliases = new Set<string>()
    walk(ast, (n: any) => {
      if (n?.type === 'column_ref' && n.table) aliases.add(n.table)
    })
    return { ok: true, referencedAliases: [...aliases] }
  } catch (e: any) {
    return { ok: false, error: e.message, referencedAliases: [] }
  }
}

function walk(node: any, visit: (n: any) => void) {
  if (!node || typeof node !== 'object') return
  visit(node)
  for (const v of Object.values(node)) {
    if (Array.isArray(v)) v.forEach(x => walk(x, visit))
    else walk(v, visit)
  }
}
```

`node-sql-parser` is already a dependency (used by the server-side validator); the browser bundle picks it up via the same package. No new install.

**Test cases (minimum):**

1. Each kind renders its compact form correctly.
2. Aggregation column picker filters to numeric for `sum`/`avg`/`min`/`max` (count accepts any).
3. Expression textarea shows parse error inline when the SQL doesn't parse.
4. Apply on expression chip emits `change` with auto-derived `referencedAliases`.
5. ⊕-chip's quick-pick produces a `column` chip on first click; a deeper menu shows aggregation/expression options.

End with `git commit -m "feat(analytics-explorer): SelectChip (column / aggregation / expression)"`.

### Task 17: OrderByChip + LimitChip

Together because both are small.

**OrderByChip props:** `{ order: OrderClause; selectItems: SelectItem[]; aliasMap: Map<string, EntityMeta> }`

**OrderByChip emits:** `change(order: OrderClause)`, `remove()`

**OrderByChip popover layout:**

- "Order by" radio: SELECT chip (preferred, survives renames) | column ref
- If selectId chosen: dropdown of `selectItems[]` showing each item's compact form
- If columnRef chosen: column dropdown filtered to aliased entities' columns
- Direction toggle: asc / desc
- Apply / Cancel

**Bar-level:** ⊕ adds a new OrderClause. Multiple chips render in order; precedence shown as `1.`, `2.`, etc. Drag-reorder is OUT of scope for Phase 2 (chip array reordering is fine to defer to Phase 3).

**LimitChip props:** `{ limit: number | null }`

**LimitChip emits:** `change(limit: number | null)`

**LimitChip popover:**

- Number input
- "Use server cap (5000)" toggle that sets `limit = null`
- Apply / Cancel

Single chip per spec; no add/remove.

**Test cases (minimum):**

1. OrderByChip renders `cnt DESC` for a `selectId` ref.
2. OrderByChip renders `t.createdAt ASC` for a `columnRef` ref.
3. OrderByChip emits `change` on direction toggle.
4. LimitChip renders `LIMIT 10` when `limit: 10`; renders `LIMIT (server cap)` when `limit: null`.
5. LimitChip's "Use server cap" toggle sets `limit = null`.

End with `git commit -m "feat(analytics-explorer): OrderByChip + LimitChip"`.

---

## Task 18: Run button + result envelope handling

Most of this lands in Task 10 (the SqlTab reshape) — but verify here that the run-from-chips path actually:

- calls `validateQuerySpec` first; if any errors, blocks Run with a tooltip
- builds SQL via `specToSql`
- POSTs to `/admin/analytics/runSelectQuery` with `source: 'builder'`
- captures the result envelope (privacy, historyId)
- renders the privacy badge above the result table

Tests: extend the existing `useQuerySpec.test.ts` with one integration-ish test that drives `runFromChips`. Mock `runSelectQuery` to return a fake envelope. Assert privacy badge text appears.

End with a commit `feat(analytics-explorer): run-from-chips builds SQL via specToSql`.

---

## Task 19: SQL Editor "take over from builder" mode

**Files:**
- Modify: `app/analytics-explorer/src/components/tabs/SqlEditorTab.vue`
- Modify: `app/analytics-explorer/src/components/QueryEditor.vue` (no major changes — add a `mode` prop)

When the user is on the "SQL Editor" tab and clicks a "Take over from builder" button:

- `useQuerySpec().takeOverFromBuilder()` flips mode to `'editor'`.
- The chip bar greys out (CSS gate via `mode === 'editor'`).
- Monaco becomes editable; the read-only preview above continues to mirror the chip-built SQL but is grayed.
- Run from this tab POSTs with `source: 'editor'`.

Returning to builder via "Return to builder" prompts a confirmation that any SQL edits will be discarded.

---

## Task 20: Result table cleanup

The existing 200-row HTML table from `QueryEditor.vue` is sufficient for Phase 2. Phase 3 introduces virtualization + chart toggle + drilldown.

Verify the table consumes the new envelope shape correctly (`columns`, `rows: string[][]`, `metadata`, `privacy`, `historyId`). The table is already rendered in `SqlTab.vue` from Task 10 — confirm nothing else needs changing.

Add one component test in `app/analytics-explorer/src/components/__tests__/SqlTab-results.test.ts` that mounts SqlTab with mocked composables and verifies the privacy badge appears for `mode: 'raw'`.

---

## Task 21: Joule + History/Saved tab stubs

Confirm:

- The Joule rail button is disabled with title "Joule (Phase 5)".
- The History tab content is the placeholder `History tab — Phase 4.`.
- The Saved tab content is the placeholder `Saved queries tab — Phase 4.`.

No code change needed — verification commit:

```bash
git commit --allow-empty -m "chore(analytics-explorer): confirm Phase 2 leaves Joule/History/Saved as stubs"
```

---

## Task 22: Auto-GROUP-BY one-shot banner

When the user adds the *first* aggregation chip to a previously-raw query, a one-shot banner explains the auto-GROUP-BY:

```
ⓘ GROUP BY auto-added: t.event_ID, t.status. [ Show me ] [ Got it ]
```

Implementation: a small `AutoGroupByBanner.vue` watcher above the chip bar. State: `localStorage.getItem('analytics.seenAutoGroupBanner')`. Hides itself on dismiss.

TDD: a small test that mounts the banner with a watcher hook, simulates the first-aggregation transition, and asserts the banner appears.

End with a commit.

---

## Task 23: Final regression sweep + cds lint

- [ ] **Step 1: Run all unit tests**

```bash
npm test -- --project=unit 2>&1 | tail -10
```

Expected: 941 baseline + ~30 new Phase 2 tests, all green.

- [ ] **Step 2: Run cds lint**

```bash
npx cds lint 2>&1 | tail -10
```

Expected: clean.

- [ ] **Step 3: Build the analytics-explorer SPA**

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -10 && cd ../..
```

Expected: build succeeds. The new chunks (chip components, SqlPreview, SqlEditorTab) are split appropriately.

If any task introduced a CRLF flip on Windows ([feedback_crlf_regression_on_windows]), normalize via Node:

```bash
node -e "const fs=require('fs');for(const f of ['app/analytics-explorer/src/components/builder/ClauseChipBar.vue']){const t=fs.readFileSync(f,'utf8');fs.writeFileSync(f,t.replace(/\r\n/g,'\n'),'utf8');}"
```

---

## Task 24: srv-qa cp-list verification

Phase 2 touches **no** `srv/` files except renaming two .cjs → .mjs. Verify:

```bash
git diff --name-only main..HEAD -- srv/ 2>&1
```

Expected output:

```
srv/lib/__tests__/query-spec-validator.test.js
srv/lib/__tests__/spec-to-sql.test.js
srv/lib/README.md
srv/lib/query-spec-validator.cjs   (deleted)
srv/lib/query-spec-validator.mjs   (added)
srv/lib/spec-to-sql.cjs            (deleted)
srv/lib/spec-to-sql.mjs            (added)
```

Verify srv-qa does not import any of these:

```bash
grep -rn "query-spec-validator\|spec-to-sql" srv-qa/ 2>&1 | head -5
```

Expected: zero matches.

Verify the `.deploy/mta.yaml` srv-qa cp list does not reference these files:

```bash
grep -E "query-spec-validator|spec-to-sql" .deploy/mta.yaml
```

Expected: zero matches.

```bash
git commit --allow-empty -m "chore(srv-qa): verify Phase 2 .cjs->.mjs renames don't affect QA cp list

Phase 2 renames query-spec-validator.cjs -> .mjs and spec-to-sql.cjs ->
.mjs. Neither file is consumed by srv-qa (admin-only analytics surface).
.deploy/mta.yaml unchanged."
```

---

## Task 25: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin feat/analytics-builder-phase2-chip-builder
```

- [ ] **Step 2: Open the PR**

```bash
gh pr create --base main \
  --title "feat(analytics): Phase 2 chip builder UX (Monaco-as-tab + isomorphic modules)" \
  --body "$(cat <<'EOF'
## Phase 2 of 5 — Chip Builder UX

Implements the chip-driven SQL builder UI on top of Phase 1's backend foundation. The existing SQL tab is reshaped into chip-bar + SQL-preview + tab-strip layout; Monaco moves into the SQL Editor tab; the entity sidebar stays. Joule remains a stub button (Phase 5); History and Saved tabs are placeholders (Phase 4).

## What's in

- **Isomorphic conversion:** `query-spec-validator.cjs` and `spec-to-sql.cjs` renamed to `.mjs` (pure ESM). Browser imports them directly via a new Vite `@srv-lib` alias. Single source of truth — no drift between Node tests and browser code.
- **TypeScript types** for QuerySpec mirroring the validator's JSDoc shape (`app/analytics-explorer/src/types/query-spec.ts`).
- **`useQuerySpec` composable** — single mutation surface for builder state with a depth-1 drilldown stack and builder/editor mode toggle.
- **`useEntityGraph` composable** — loads enriched metadata once, exposes `entityMap`, `sqlNames`, `joinableTo`, and a session-scoped `sampleDistinctCached`.
- **Chip components** (FromChip, JoinChip, FilterChip, FilterGroupChip, GroupByChip, SelectChip, OrderByChip, LimitChip) — each a small Vue SFC with a UI5 popover for editing. Recursive filter tree handles AND/OR groups + NOT + max nesting depth 4.
- **`SqlPreview`** — read-only Monaco that re-renders on every spec change.
- **`SqlEditorTab`** — wraps the existing QueryEditor; "Take over from builder" toggle flips the mode in `useQuerySpec`.
- **Run flow** — chip-built SQL POSTed via `runSelectQuery` with `source: 'builder'`; result envelope rendered with privacy badge.
- **Auto-GROUP-BY banner** — one-shot localStorage-persisted hint when the first aggregation chip turns a raw query into a grouped one.

## Tests

- ~30 new unit + component tests across the new composables and chip SFCs.
- Existing project baseline unchanged.

## Out of scope (later phases)

- Result virtualization, chart toggle, per-row drilldown (Phase 3)
- History tab + Saved Queries tab UI (Phase 4)
- Joule integration + 3 new tools (Phase 5)
EOF
)"
```

- [ ] **Step 3: Save a memory entry once the PR is open**

Save to `C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_analytics_builder_phase2.md`:

```markdown
---
name: project-analytics-builder-phase2
description: Chip builder UX for analytics SQL Builder shipped in PR #<num>; Phase 3+ build on it
metadata:
  type: project
---

Phase 2 of analytics SQL Builder ([[project-analytics-sql-builder-design]])
shipped <date> in PR #<num>. Adds the chip-driven query builder UI on
top of Phase 1 ([[project-analytics-builder-phase1]]).

Key files:
  - srv/lib/query-spec-validator.mjs (renamed from .cjs — now ESM)
  - srv/lib/spec-to-sql.mjs (renamed from .cjs — now ESM)
  - app/analytics-explorer/vite.config.ts — @srv-lib alias
  - app/analytics-explorer/src/types/query-spec.ts
  - app/analytics-explorer/src/composables/useQuerySpec.ts
  - app/analytics-explorer/src/composables/useEntityGraph.ts
  - app/analytics-explorer/src/components/builder/ClauseChipBar.vue
  - app/analytics-explorer/src/components/builder/SqlPreview.vue
  - app/analytics-explorer/src/components/builder/chips/*.vue
```

Add to MEMORY.md:

```
- [Analytics Builder Phase 2](project_analytics_builder_phase2.md) — Chip builder UX shipped in PR #<num>; Phase 3+ build on it
```

---

## Part B summary checklist

- [ ] Task 9: SqlPreview component
- [ ] Task 10: SqlTab layout reshape + stubs (EntitySidebar, SqlEditorTab, PrivacyBadge)
- [ ] Task 11: FromChip + @vue/test-utils setup
- [ ] Task 12: JoinChip
- [ ] Task 13: FilterChip (leaf)
- [ ] Task 14: FilterGroupChip (recursive)
- [ ] Task 15: GroupByChip
- [ ] Task 16: SelectChip
- [ ] Task 17: OrderByChip + LimitChip
- [ ] Task 18: Run-from-chips integration
- [ ] Task 19: SQL Editor take-over mode
- [ ] Task 20: Result table cleanup
- [ ] Task 21: Joule + History + Saved stubs
- [ ] Task 22: Auto-GROUP-BY banner
- [ ] Task 23: Final regression + lint + build
- [ ] Task 24: srv-qa cp-list verification
- [ ] Task 25: Open PR
