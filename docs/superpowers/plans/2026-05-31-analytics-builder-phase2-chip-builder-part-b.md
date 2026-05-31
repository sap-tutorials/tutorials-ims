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
  } catch (e: any) {
    lastResults.value = { error: e.message, columns: [], rows: [] }
  }
}

function onResults(r: any) { lastResults.value = r }
function onEntityClicked(name: string) {
  // EntitySidebar emits the logical entity name. setSpec to a fresh single-entity spec
  // when the user clicks an entity from an empty builder.
  // (Detailed flow handled in subsequent tasks.)
}
</script>
```

(Note: this introduces `EntitySidebar.vue` and `SqlEditorTab.vue` and `PrivacyBadge.vue` — those are new files created in Tasks 11, 19, and 20 respectively. For now, create empty stub files so the imports resolve.)

- [ ] **Step 3: Create the stub component files**

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

Edit `app/analytics-explorer/src/api/sql.ts`:

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

### Task 11 Step 0 (one-time setup): Install @vue/test-utils

```bash
cd app/analytics-explorer && npm install --save-dev @vue/test-utils@^2.4.0 happy-dom@^14 && cd ../..
```

Update `vitest.config.ts` (the project root one) — confirm the `unit` project's `environment` for `app/analytics-explorer/**` files is set to `happy-dom`. If the existing config has `environment: 'node'` for unit, add a per-file environment hint:

```typescript
// At the top of each component test:
// @vitest-environment happy-dom
```

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

Same template. Popover offers:

- INNER / LEFT radio
- Suggested joins (driven by `useEntityGraph.joinableTo()`) — radio list
- Custom join: target entity dropdown + alias + ON column-pair selectors

Emits `change` with `{ id, kind, target, on }`.

### Task 13: FilterChip (leaf)

Most polymorphic. Popover renders different controls based on the column's `filterMode`:

- `enum` + `sample: true`: column dropdown → operator dropdown (eq/neq/in/notIn) → multi-select dropdown of distinct values, lazy-loaded via `useEntityGraph.sampleDistinctCached()`.
- `date`: column → operator (between/before/after/sinceDays/inCurrent) → date picker / number+unit / period dropdown.
- `numeric-range`: numeric inputs.
- `free` (default): plain text input. Operator set restricted (no `in`).

Emits `change` with the next `Filter` leaf node. Tests cover at least one of each filterMode case.

### Task 14: FilterGroupChip (recursive bracket-style)

The recursive container. Renders `(` ... children ... `)` with a small AND/OR toggle chip between siblings. Children are either FilterChip (leaf) or FilterGroupChip (recursive).

UX:

- Click the open-bracket chip → popover toggles conjunction (AND/OR) + offers "Wrap in NOT" toggle + offers "Ungroup" button.
- Multi-select Ctrl/⌘-click on sibling chips → floating "Group these (AND) / (OR)" button appears.
- Max nesting depth 4 — past that, the "Add nested group" button is disabled in the popover.

Emits `change` with the next `FilterGroup` node.

### Task 15: GroupByChip

Auto-derived from `select.filter(s => s.kind !== 'aggregation')` when at least one aggregation is present; explicit-only chips edited via `spec.groupBy`. Auto chips render `(auto)` and are read-only. Explicit ⊕ button adds a key.

### Task 16: SelectChip

Discriminated union: `column` | `aggregation` | `expression`. Different popover per kind. ⊕ quick-pick offers column → aggregation → expression in that order.

The expression popover validates the SQL fragment via `node-sql-parser` in the browser before applying — drop in a small wrapper `app/analytics-explorer/src/lib/expr-validator.ts` that calls `new Parser().astify(sql, { database: 'MySQL' })` and reports parse errors.

### Task 17: OrderByChip + LimitChip

Together because both are small.

OrderByChip popover: dropdown picks SELECT chip (by id) OR an arbitrary column ref, plus asc/desc. Multiple OrderByChips supported.

LimitChip popover: number input + "use server cap" toggle.

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
