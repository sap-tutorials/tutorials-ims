# Analytics SQL Builder — Phase 2 (Chip Builder UX) Implementation Plan — Part A

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the foundation for the chip-driven SQL query builder — dual-format isomorphic modules (browser can import the validator + spec-to-sql from Phase 1), Vite alias setup, the canonical state composable (`useQuerySpec`), the entity graph composable (`useEntityGraph`), and the empty `ClauseChipBar` shell wired into the existing SQL tab. After Part A, the SQL tab still works as before; the chip bar is mounted but empty (no chips yet).

**Architecture:** The Phase 1 server modules (`srv/lib/query-spec-validator.cjs`, `srv/lib/spec-to-sql.cjs`) are extracted into pure-ESM source files (`*.mjs` or shared modules), with a thin CJS wrapper kept for Node-side consumers (`runSelectQuery` handler). Browser imports the ESM directly via a Vite `@srv-lib` alias. A single fixture suite is shared between the Node and browser tests so the two runtimes can't drift. Builder state is one Vue composable (`useQuerySpec`) returning `{ spec ref, errors computed, setSpec, addJoin, addFilter, ... }`. Phase 2's UX scope: chip builder + Monaco-as-tab; Joule remains a stub button.

**Tech Stack:** Vue 3 + Vite + TypeScript (`app/analytics-explorer/`); UI5 web components (loaded per-component); Vitest for unit tests.

**Spec:** [docs/superpowers/specs/2026-05-31-analytics-sql-builder-design.md](../specs/2026-05-31-analytics-sql-builder-design.md)

**Predecessor:** Phase 1 (PR #142, merged 2026-05-31, commit 75f5f50). All Phase 1 backend additions are live.

**Branch:** `feat/analytics-builder-phase2-chip-builder` (already created from `main` post-merge).

**Conventions used in this plan:**

- All paths repo-relative from `d:\projects\tutorials-poc`.
- All commands assume Bash (Git Bash on Windows). Forward slashes.
- Frontend code is TypeScript / Vue 3 SFC; backend support modules stay JS/CJS.
- Vitest 4.1.5 — omit `--reporter=basic`. Filter form `npm test -- -t "<title>"` is preferred.
- TDD discipline: every code task starts with a failing test.
- Each task ends with one focused commit. Conventional commit prefix.
- Existing analytics-explorer patterns to mirror:
  - Composables return `{ refs, computed, methods }` (no Pinia). See `src/composables/useChartConfig.ts`.
  - UI5 components imported per-file via `@ui5/webcomponents/dist/<Name>.js`.
  - Strings hardcoded — no i18n framework.
  - Theme reactivity via `useTheme().isDark` ref + reactive watchers.
- **Node 20+ ESM** is the project default (`"type": "module"`); the new isomorphic ESM files use `.mjs` to make their format unambiguous in TypeScript-bundled contexts.

---

## Phase 2 Part A task list (Tasks 1–8)

1. Branch + UPDATED `srv/lib/README.md` (note isomorphic conversion)
2. Convert `query-spec-validator.cjs` → ESM `query-spec-validator.mjs` + thin CJS wrapper
3. Convert `spec-to-sql.cjs` → ESM `spec-to-sql.mjs` + thin CJS wrapper
4. Vite alias + tsconfig path so the browser can import `@srv-lib/...`
5. TypeScript types for QuerySpec (`app/analytics-explorer/src/types/query-spec.ts`)
6. `useQuerySpec` composable (TDD)
7. `useEntityGraph` composable (TDD) — enriched metadata + association lookups + sampleDistinct cache
8. ClauseChipBar shell + wire into SqlTab (no chip kinds yet — empty bar)

(Tasks 9–25 are in Part B: chip kinds, SQL preview, Run flow, virtualized table, history-write integration, hybrid + smoke tests, PR.)

---

## Task 1: Update `srv/lib/README.md` for isomorphic conversion

**Files:**
- Modify: `srv/lib/README.md`

- [ ] **Step 1: Verify branch state**

```bash
git branch --show-current
```

Expected: `feat/analytics-builder-phase2-chip-builder`

```bash
git log --oneline -3
```

Expected: top commit is the Phase 1 merge (75f5f50 or its rebased equivalent). If your branch is on a different base, stop and re-create from main.

- [ ] **Step 2: Update the README to flag the upcoming format change**

Edit `srv/lib/README.md`. Replace the two existing entries for the isomorphic modules with:

```markdown
- `query-spec-validator.mjs` (ESM) + `query-spec-validator.cjs` (thin CJS wrapper) — pure-function QuerySpec validator (referential integrity, op/value compat, OR-group depth ≤ 4). Browser imports via `@srv-lib/query-spec-validator.mjs`; Node consumers use the `.cjs` wrapper.
- `spec-to-sql.mjs` (ESM) + `spec-to-sql.cjs` (thin CJS wrapper) — deterministic QuerySpec → HANA SQL. Same dual-format pattern.
```

- [ ] **Step 3: Commit**

```bash
git add srv/lib/README.md
git commit -m "chore(srv/lib): note upcoming dual-format conversion of isomorphic modules"
```

---

## Task 2: Convert `query-spec-validator` to ESM

**Files:**
- Rename: `srv/lib/query-spec-validator.cjs` → `srv/lib/query-spec-validator.mjs`
- Modify: `srv/lib/__tests__/query-spec-validator.test.js`

The Phase 1 module has zero non-test consumers (verified in Step 1 below), so the migration is a clean rename + a two-line export change. No CJS wrapper needed.

- [ ] **Step 1: Verify the existing tests pass**

```bash
npm test -- --project=unit query-spec-validator
```

Expected: 12 PASS. This is the baseline we must preserve through the rename.

- [ ] **Step 2: Verify there are no Node consumers of the .cjs**

```bash
grep -rn "query-spec-validator" srv/ app/ --include="*.js" --include="*.ts" --include="*.cjs" --include="*.mjs" --include="*.vue" 2>&1 | grep -v __tests__ | head
```

Expected: zero matches (only test-file matches, which we excluded). If any non-test consumer exists, escalate as BLOCKED — a CJS wrapper migration would be needed.

- [ ] **Step 3: Rename the module**

```bash
git mv srv/lib/query-spec-validator.cjs srv/lib/query-spec-validator.mjs
```

- [ ] **Step 4: Convert to ESM**

Edit `srv/lib/query-spec-validator.mjs`:

- Remove the `'use strict'` line at the top (ESM is strict by default).
- Change `module.exports = { validateQuerySpec }` at the bottom to `export { validateQuerySpec }`.

(Internal helper functions stay as-is — they're already module-scoped.)

- [ ] **Step 5: Update the test to import the .mjs**

Edit `srv/lib/__tests__/query-spec-validator.test.js`. Replace:

```javascript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { validateQuerySpec } = require('../query-spec-validator.cjs')
```

with:

```javascript
import { validateQuerySpec } from '../query-spec-validator.mjs'
```

- [ ] **Step 6: Run the test**

```bash
npm test -- --project=unit query-spec-validator
```

Expected: 12 PASS. If anything fails, the conversion broke something — most likely cause is a CJS-only API used inside the module body (e.g. `__dirname`, `require`). Inspect and fix.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/query-spec-validator.mjs srv/lib/__tests__/query-spec-validator.test.js
git commit -m "refactor(srv/lib): convert query-spec-validator to ESM (.mjs)

Phase 2 prep: browser needs to import this module via Vite alias for
the chip builder's real-time validation. Conversion is straightforward
because the module has no Node consumers in Phase 1 — only its unit
test imports it, and the test now imports the .mjs directly.

Single-source-of-truth: same .mjs file is loaded by both the Vitest
runner (Node, ESM) and the browser bundle (Vite alias). No drift risk.

Future Phase 3+ Node consumers (when generateAnalyticsQuery in the
chat orchestrator validates a spec server-side) import the same .mjs
via 'import { validateQuerySpec } from .../query-spec-validator.mjs'."
```

---

## Task 3: Convert `spec-to-sql` to ESM

**Files:**
- Rename: `srv/lib/spec-to-sql.cjs` → `srv/lib/spec-to-sql.mjs`
- Modify: `srv/lib/__tests__/spec-to-sql.test.js`

Same pattern as Task 2.

- [ ] **Step 1: Verify no Node consumers**

```bash
grep -rn "spec-to-sql" srv/ app/ --include="*.js" --include="*.ts" --include="*.cjs" --include="*.mjs" --include="*.vue" 2>&1 | grep -v __tests__
```

Expected: zero non-test matches. If anything else imports `spec-to-sql.cjs`, escalate.

- [ ] **Step 2: Rename**

```bash
git mv srv/lib/spec-to-sql.cjs srv/lib/spec-to-sql.mjs
```

- [ ] **Step 3: Convert exports to ESM**

In `srv/lib/spec-to-sql.mjs`:

- Remove `'use strict'`.
- Change `module.exports = { specToSql }` to `export { specToSql }`.

- [ ] **Step 4: Update the test**

In `srv/lib/__tests__/spec-to-sql.test.js`. Replace:

```javascript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { specToSql } = require('../spec-to-sql.cjs')
```

with:

```javascript
import { specToSql } from '../spec-to-sql.mjs'
```

The test also has one inner `require('../analytics-sql-validator.cjs')` call inside `it('produces SQL that passes analytics-sql-validator')` — leave that one alone for now. `analytics-sql-validator.cjs` stays as CJS (it has Node-only consumers in `analytics-service.js`); the browser doesn't need it.

- [ ] **Step 5: Run the test**

```bash
npm test -- --project=unit spec-to-sql
```

Expected: 11 PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/spec-to-sql.mjs srv/lib/__tests__/spec-to-sql.test.js
git commit -m "refactor(srv/lib): convert spec-to-sql to ESM (.mjs)

Same single-source-of-truth pattern as query-spec-validator: the .mjs
is consumed by both the Vitest Node runner and the browser bundle (via
the @srv-lib Vite alias added in Phase 2 Task 4)."
```

---

## Task 4: Vite alias + tsconfig path for `@srv-lib`

**Files:**
- Modify: `app/analytics-explorer/vite.config.ts`
- Modify: `app/analytics-explorer/tsconfig.json`
- Modify: `vitest.config.ts` (repo root) — **also add `resolve.alias`** to the `unit` project; the project does not import `vite.config.ts`, so the SPA-side alias does not propagate to Vitest runs

> **Note on spec retraction:** The spec at one point retracted the "Vite alias" approach in favor of generated artifacts under `app/analytics-explorer/src/shared/__generated__/`. The retraction's concern was transitive Node imports (e.g. `@sap/cds`, `node:*`) leaking into the browser. The Phase 1 modules are leaf-pure JS — they import nothing — so the alias path is safe for these two specific files. If we ever need to share modules with Node imports, we'd switch to the generated-artifact pattern then.

- [ ] **Step 1: Add resolve.alias to vite.config.ts**

Edit `app/analytics-explorer/vite.config.ts`. Add the import for `fileURLToPath` at the top:

```typescript
import { fileURLToPath } from 'node:url'
```

Inside `defineConfig({ ... })`, add a `resolve.alias` block:

```typescript
resolve: {
  alias: {
    // Phase 2: lets the chip builder import the isomorphic Phase 1 modules
    // (query-spec-validator.mjs, spec-to-sql.mjs) directly from srv/lib.
    // Pure-ESM .mjs files; Vite consumes them with no transformation.
    '@srv-lib': fileURLToPath(new URL('../../srv/lib', import.meta.url)),
  },
},
```

(Place it alongside `build`, `server`, `plugins`. Order doesn't matter.)

- [ ] **Step 2: Add the tsconfig path mapping**

Edit `app/analytics-explorer/tsconfig.json`. Add `paths` to `compilerOptions`:

```json
"paths": {
  "@srv-lib/*": ["../../srv/lib/*"]
},
```

(Place it alongside `target`, `module`, `moduleResolution`, etc.)

Also confirm `baseUrl` is set; if not, add `"baseUrl": "."`. The file already has `"moduleResolution": "bundler"` which honors `paths`.

- [ ] **Step 3: Add the SAME alias to the Vitest unit project**

The Vitest unit project at `vitest.config.ts` does NOT import `vite.config.ts` — projects are flat. Without this step, `@srv-lib` will resolve in `npm run build` but FAIL in `npm test`.

Edit `vitest.config.ts` (repo root). At the top, add the import:

```typescript
import { fileURLToPath } from 'node:url'
```

Inside the `unit` project block, add `resolve.alias`:

```typescript
{
  test: {
    name: 'unit',
    environment: 'node',
    include: [...],  // unchanged
    exclude: [...],  // unchanged
    hookTimeout: 60000,
    env: { NO_TELEMETRY: 'true' }
  },
  resolve: {
    alias: {
      '@srv-lib': fileURLToPath(new URL('./srv/lib', import.meta.url)),
    },
  },
},
```

Note the path is relative to the **repo root** (where vitest.config.ts lives), so `./srv/lib` — not `../../srv/lib` like in the SPA's vite.config.

- [ ] **Step 4: Smoke-test the alias from both sides**

Create `app/analytics-explorer/src/lib/srv-lib-imports.ts`:

```typescript
import { validateQuerySpec } from '@srv-lib/query-spec-validator.mjs'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'

// Re-export for the regression smoke test below.
export { validateQuerySpec, specToSql }
```

Create `app/analytics-explorer/src/lib/__tests__/srv-lib-imports.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { validateQuerySpec, specToSql } from '../srv-lib-imports'

describe('@srv-lib alias', () => {
  it('imports validateQuerySpec from srv/lib', () => {
    expect(typeof validateQuerySpec).toBe('function')
  })

  it('imports specToSql from srv/lib', () => {
    expect(typeof specToSql).toBe('function')
  })
})
```

Run:

```bash
npm test -- --project=unit srv-lib-imports
```

Expected: 2 PASS. If the test fails with `Cannot find module '@srv-lib/...'`, the Vitest alias from Step 3 is missing or wrong. Confirm `vitest.config.ts` has both the `import { fileURLToPath } from 'node:url'` line and the `resolve.alias` block inside the `unit` project.

Then verify the build side:

```bash
cd app/analytics-explorer && npm run build 2>&1 | tail -5 && cd ../..
```

Expected: build succeeds. If it fails, the SPA-side Vite alias from Step 1 is missing or wrong.

The two paths (Step 1 + Step 3) are deliberately **separate** configs — there's no DRY-up here without restructuring the project. The smoke test is a permanent regression guard against either side breaking.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/vite.config.ts app/analytics-explorer/tsconfig.json vitest.config.ts app/analytics-explorer/src/lib/srv-lib-imports.ts app/analytics-explorer/src/lib/__tests__/srv-lib-imports.test.ts
git commit -m "feat(analytics-explorer): wire @srv-lib alias for isomorphic modules

Vite resolve.alias (SPA build) + tsconfig paths (TS resolution) +
Vitest unit-project resolve.alias (test runs). All three are needed —
the Vitest unit project doesn't import vite.config.ts, so the SPA-side
alias is invisible to test runs.

Smoke test in app/analytics-explorer/src/lib/__tests__/ guards against
the alias breaking in future Vite/Vitest upgrades."
```

---

## Task 5: TypeScript types for QuerySpec

**Files:**
- Create: `app/analytics-explorer/src/types/query-spec.ts`

The browser-side TypeScript types mirror the JSDoc-shape used by the validator. Pure type definitions — no runtime code. The validator and spec-to-sql functions are already typed at the JSDoc level via TS's `--allowJs --checkJs`, but explicit TypeScript shapes make the chip components and composables clearer.

- [ ] **Step 1: Create the types file**

Create `app/analytics-explorer/src/types/query-spec.ts`:

```typescript
// QuerySpec — canonical state shape for the analytics builder. Matches the
// JSDoc shape consumed by srv/lib/query-spec-validator.mjs and srv/lib/spec-to-sql.mjs.
//
// Keep this file in sync with the validator's OP_VALUE_KIND / OP_TYPE_OK
// constants; the test 'spec-validator and types stay in sync' (Task 6 Step N)
// guards drift.

export interface QuerySpec {
  version: 1
  from: TableRef
  joins: Join[]
  filterTree: FilterNode | null
  groupBy: GroupKey[]
  select: SelectItem[]
  orderBy: OrderClause[]
  limit: number | null
}

export interface TableRef {
  entity: string
  alias: string
}

export interface Join {
  id: string
  kind: 'inner' | 'left'
  target: TableRef
  on: { leftRef: ColumnRef; rightRef: ColumnRef }
}

export interface ColumnRef {
  alias: string
  column: string
}

export type FilterNode = Filter | FilterGroup

export interface Filter {
  id: string
  ref: ColumnRef
  op: FilterOp
  value: FilterValue
  negated?: boolean
}

export interface FilterGroup {
  id: string
  kind: 'group'
  conjunction: 'and' | 'or'
  negated?: boolean
  children: FilterNode[]
}

export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'contains' | 'startsWith' | 'endsWith'
  | 'between' | 'isNull'
  | 'sinceDays' | 'inLastDays' | 'inCurrent'

export type FilterValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'list'; value: (string | number)[] }
  | { kind: 'range'; value: [string | number, string | number] }
  | { kind: 'relative'; value: number; unit?: 'days' | 'months' | 'years' }
  | { kind: 'period'; value: 'day' | 'week' | 'month' | 'quarter' | 'year' }

export interface GroupKey {
  id: string
  ref: ColumnRef
}

export type SelectItem =
  | { kind: 'column'; id: string; ref: ColumnRef; alias?: string }
  | { kind: 'aggregation'; id: string; fn: AggFn; ref: ColumnRef | '*'; distinct?: boolean; alias?: string }
  | {
      kind: 'expression'
      id: string
      sql: string
      alias: string
      referencedAliases: string[]
    }

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max'

export interface OrderClause {
  id: string
  by: { kind: 'selectId'; id: string } | { kind: 'columnRef'; ref: ColumnRef }
  direction: 'asc' | 'desc'
}

// ─── Validation envelope (returned by query-spec-validator.mjs) ──────────
export interface ValidationIssue {
  chipId: string | null
  message: string
}

export interface ValidationResult {
  errors: ValidationIssue[]
}

// ─── Helpers for chip components ─────────────────────────────────────────
export function isFilterGroup(node: FilterNode | null | undefined): node is FilterGroup {
  return !!node && (node as FilterGroup).kind === 'group'
}

export function isFilterLeaf(node: FilterNode | null | undefined): node is Filter {
  return !!node && !(node as FilterGroup).kind
}
```

- [ ] **Step 2: Smoke-test the types compile**

Run a TypeScript compile check:

```bash
cd app/analytics-explorer && npx tsc --noEmit && cd ../..
```

Expected: clean (no output) means no type errors. If the project's tsconfig flags any error, fix the discriminated unions before continuing.

- [ ] **Step 3: Commit**

```bash
git add app/analytics-explorer/src/types/query-spec.ts
git commit -m "feat(analytics-explorer): add TypeScript types for QuerySpec

Pure type definitions matching the JSDoc shape consumed by the
isomorphic Phase 1 modules. Discriminated unions for SelectItem and
FilterValue let chip components match on .kind exhaustively. Helper
predicates isFilterGroup / isFilterLeaf give chip rendering a
type-safe walk over the filter tree."
```

---

## Task 6: `useQuerySpec` composable (TDD)

**Files:**
- Create: `app/analytics-explorer/src/composables/useQuerySpec.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useQuerySpec.test.ts`

The single mutation surface for builder state. Every chip mutation, drilldown push/pop, replay-from-history, save/load — all go through `setSpec`.

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/composables/__tests__/useQuerySpec.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest'
import { useQuerySpec } from '../useQuerySpec'
import type { QuerySpec } from '../../types/query-spec'

const baseSpec = (): QuerySpec => ({
  version: 1,
  from: { entity: 'Tasks', alias: 't' },
  joins: [],
  filterTree: null,
  groupBy: [],
  select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'status' } }],
  orderBy: [],
  limit: null,
})

describe('useQuerySpec', () => {
  let store: ReturnType<typeof useQuerySpec>

  beforeEach(() => {
    store = useQuerySpec()
  })

  it('starts with a null spec (empty builder)', () => {
    expect(store.spec.value).toBe(null)
  })

  it('setSpec replaces the spec', () => {
    const s = baseSpec()
    store.setSpec(s)
    expect(store.spec.value).toEqual(s)
  })

  it('clearSpec resets to null', () => {
    store.setSpec(baseSpec())
    store.clearSpec()
    expect(store.spec.value).toBe(null)
  })

  it('mutating state.spec.value works (Vue reactivity)', () => {
    store.setSpec(baseSpec())
    // Callers can mutate via setSpec(newSpec) — direct assignment to .value is
    // also supported but discouraged in chip components (use setSpec for clarity).
    const next = baseSpec()
    next.limit = 100
    store.setSpec(next)
    expect(store.spec.value?.limit).toBe(100)
  })

  it('drilldown stack: push, pop, depth-1 cap', () => {
    const grouped = baseSpec()
    grouped.select.push({ kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' })
    store.setSpec(grouped)

    const drillSpec = baseSpec()
    drillSpec.filterTree = {
      id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq', value: { kind: 'literal', value: 'PENDING' } },
      ],
    }
    store.pushDrilldown(drillSpec)

    expect(store.spec.value?.filterTree).toBeTruthy()
    expect(store.isDrilldown.value).toBe(true)

    // Drilling from a drilldown REPLACES the current drilldown (depth-1 cap).
    const drill2 = baseSpec()
    drill2.limit = 50
    store.pushDrilldown(drill2)
    expect(store.spec.value?.limit).toBe(50)
    expect(store.isDrilldown.value).toBe(true)

    // Pop returns to the original grouped query.
    store.popDrilldown()
    expect(store.spec.value).toEqual(grouped)
    expect(store.isDrilldown.value).toBe(false)
  })

  it('mode toggle: builder | editor', () => {
    expect(store.mode.value).toBe('builder')
    store.takeOverFromBuilder()
    expect(store.mode.value).toBe('editor')
    store.returnToBuilder()
    expect(store.mode.value).toBe('builder')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit useQuerySpec
```

Expected: FAIL with `Cannot find module '../useQuerySpec'`.

- [ ] **Step 3: Implement the composable**

Create `app/analytics-explorer/src/composables/useQuerySpec.ts`:

```typescript
import { ref, computed } from 'vue'
import type { QuerySpec } from '../types/query-spec'

// Single mutation surface for analytics builder state. ALL paths that
// change the spec (chip add/remove/edit, drilldown, replay, Joule
// "View in builder", history-tab click) go through setSpec or one of
// its convenience methods.
//
// The composable is a SINGLETON shared across the app — chip components
// import it independently and see the same reactive refs. We keep the
// state at module scope to make this explicit.

const _spec = ref<QuerySpec | null>(null)
const _mode = ref<'builder' | 'editor'>('builder')

// Drilldown stack: when a user right-clicks a result row → "Drill into
// this row", the current spec is pushed onto this stack and a derived
// drilldown spec replaces it. Pop returns to the original.
// Depth-1 cap: drilling from a drilldown REPLACES rather than nesting.
const _drillStack = ref<QuerySpec[]>([])

export function useQuerySpec() {
  function setSpec(next: QuerySpec | null) {
    _spec.value = next ? structuredClone(next) : null
  }

  function clearSpec() {
    _spec.value = null
    _drillStack.value = []
    _mode.value = 'builder'
  }

  function pushDrilldown(drillSpec: QuerySpec) {
    if (_drillStack.value.length === 0 && _spec.value) {
      _drillStack.value = [structuredClone(_spec.value)]
    }
    // Always replace the visible spec — depth-1 stack means a second
    // pushDrilldown overwrites the drill, never the original.
    _spec.value = structuredClone(drillSpec)
  }

  function popDrilldown() {
    const prev = _drillStack.value.pop()
    if (prev) {
      _spec.value = prev
      _drillStack.value = []
    }
  }

  const isDrilldown = computed(() => _drillStack.value.length > 0)

  function takeOverFromBuilder() { _mode.value = 'editor' }
  function returnToBuilder()     { _mode.value = 'builder' }

  return {
    spec: _spec,
    mode: _mode,
    isDrilldown,
    setSpec,
    clearSpec,
    pushDrilldown,
    popDrilldown,
    takeOverFromBuilder,
    returnToBuilder,
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
npm test -- --project=unit useQuerySpec
```

Expected: 6 PASS.

If `structuredClone` is undefined in the test environment, that's a Node ≤16 issue — the project's package.json `engines` should require Node 20+. Confirm with `node --version`.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/composables/useQuerySpec.ts app/analytics-explorer/src/composables/__tests__/useQuerySpec.test.ts
git commit -m "feat(analytics-explorer): add useQuerySpec composable (state)

Single mutation surface for analytics builder state. Module-scoped
singleton — every chip component imports it and sees the same
reactive spec ref. Drilldown stack is depth-1 (push replaces, pop
returns to original); mode toggle (builder | editor) flips the
SQL Editor tab between sync and take-over modes.

structuredClone() defensively copies the spec on setSpec to prevent
chips from sharing references that would surprise reactivity."
```

---

## Task 7: `useEntityGraph` composable (TDD)

**Files:**
- Create: `app/analytics-explorer/src/composables/useEntityGraph.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useEntityGraph.test.ts`

Loads enriched entity metadata once via `getCachedEntityMetadata()` and exposes:

- `entities` — array of exposed entities (same shape as Phase 1's listExposedEntities response).
- `entityMap` — `Map<string, EntityMeta>` keyed by short name; used by `validateQuerySpec` and `specToSql`.
- `joinableTo(fromAlias)` — given an alias in the current spec, returns associations that can be added as JOINs.
- `sqlNames` — `{ [logicalName]: physicalName }` map for `specToSql`.
- `sampleDistinct(table, column)` — fetches and caches DISTINCT values for a column (session-scoped, no TTL).

- [ ] **Step 1: Write the failing tests**

Create `app/analytics-explorer/src/composables/__tests__/useEntityGraph.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useEntityGraph, _resetForTest } from '../useEntityGraph'

// Mock the entities API so we don't hit a server.
vi.mock('../../api/entities', () => ({
  getCachedEntityMetadata: vi.fn(async () => ([
    {
      name: 'Tasks',
      sqlName: 'COM_SAP_DEVELOPERS_IMS_TASKS',
      label: 'Tasks',
      description: '',
      columns: [
        { name: 'id', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: false, length: null, filterMode: 'free', filterSample: false, pii: false },
        { name: 'status', type: 'cds.String', hanaType: 'NVARCHAR(255)', nullable: true, length: 255, filterMode: 'enum', filterSample: true, pii: false },
      ],
      associations: [],
    },
    {
      name: 'TaskRecords',
      sqlName: 'COM_SAP_DEVELOPERS_IMS_TASKRECORDS',
      label: 'Task records',
      description: '',
      columns: [
        { name: 'ID', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: false, length: null, filterMode: 'free', filterSample: false, pii: false },
        { name: 'user_ID', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: true, length: null, filterMode: 'free', filterSample: false, pii: false },
      ],
      associations: [
        { name: 'user', targetEntity: 'Users', cardinality: 'to-one', onLocal: ['user_ID'], onTarget: ['ID'] },
      ],
    },
    {
      name: 'Users',
      sqlName: 'COM_SAP_DEVELOPERS_IMS_USERS',
      label: 'Users',
      description: '',
      columns: [
        { name: 'ID', type: 'cds.UUID', hanaType: 'NVARCHAR(36)', nullable: false, length: null, filterMode: 'free', filterSample: false, pii: false },
        { name: 'email', type: 'cds.String', hanaType: 'NVARCHAR(255)', nullable: true, length: 255, filterMode: 'free', filterSample: false, pii: true },
      ],
      associations: [],
    },
  ])),
}))

vi.mock('../../api/distinct', () => ({
  sampleDistinct: vi.fn(async (table: string, column: string) => ({
    values: [`${table}.${column}.1`, `${table}.${column}.2`],
    truncated: false,
  })),
}))

describe('useEntityGraph', () => {
  beforeEach(() => {
    _resetForTest()
    vi.clearAllMocks()
  })

  it('load() populates entities and entityMap', async () => {
    const g = useEntityGraph()
    await g.load()
    expect(g.entities.value.length).toBe(3)
    expect(g.entityMap.value.has('Tasks')).toBe(true)
  })

  it('builds entityMap with column metadata in the validator-expected shape', async () => {
    const g = useEntityGraph()
    await g.load()
    const tasks = g.entityMap.value.get('Tasks')
    expect(tasks).toBeTruthy()
    expect(tasks!.columns.get('status')).toEqual(
      expect.objectContaining({ type: 'cds.String' }),
    )
  })

  it('sqlNames returns the runtime-physical names', async () => {
    const g = useEntityGraph()
    await g.load()
    expect(g.sqlNames.value['Tasks']).toBe('COM_SAP_DEVELOPERS_IMS_TASKS')
  })

  it('joinableTo returns associations whose target entity is in the entityMap', async () => {
    const g = useEntityGraph()
    await g.load()
    const joins = g.joinableTo('TaskRecords')
    expect(joins.length).toBe(1)
    expect(joins[0].targetEntity).toBe('Users')
  })

  it('joinableTo returns empty array for entities with no associations', async () => {
    const g = useEntityGraph()
    await g.load()
    expect(g.joinableTo('Tasks')).toEqual([])
  })

  it('sampleDistinctCached caches by (table, column) within session', async () => {
    const g = useEntityGraph()
    await g.load()
    const r1 = await g.sampleDistinctCached('Tasks', 'status')
    const r2 = await g.sampleDistinctCached('Tasks', 'status')
    expect(r1).toBe(r2)  // same Promise, same array reference
    const { sampleDistinct } = await import('../../api/distinct')
    expect((sampleDistinct as any).mock.calls.length).toBe(1)
  })

  it('sampleDistinctCached makes separate calls for different columns', async () => {
    const g = useEntityGraph()
    await g.load()
    await g.sampleDistinctCached('Tasks', 'status')
    await g.sampleDistinctCached('Tasks', 'taskType')
    const { sampleDistinct } = await import('../../api/distinct')
    expect((sampleDistinct as any).mock.calls.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit useEntityGraph
```

Expected: FAIL — module not found.

- [ ] **Step 3: Create the distinct API client first (it's a dependency)**

Create `app/analytics-explorer/src/api/distinct.ts`:

```typescript
export interface DistinctResult {
  values: string[]
  truncated: boolean
}

export async function sampleDistinct(
  table: string,
  column: string,
  limit = 100,
): Promise<DistinctResult> {
  // OData unbound function call: /admin/analytics/sampleDistinct(table='X',column='Y',limit=100)
  const params = new URLSearchParams({
    table: `'${table}'`,
    column: `'${column}'`,
    limit: String(limit),
  })
  const url = `/admin/analytics/sampleDistinct(${[...params].map(([k, v]) => `${k}=${v}`).join(',')})`
  const r = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  if (!r.ok) {
    const text = await r.text()
    throw new Error(`sampleDistinct ${r.status}: ${text}`)
  }
  return await r.json()
}
```

- [ ] **Step 4: Implement useEntityGraph**

Create `app/analytics-explorer/src/composables/useEntityGraph.ts`:

```typescript
import { ref, computed } from 'vue'
import { getCachedEntityMetadata } from '../api/entities'
import { sampleDistinct as apiSampleDistinct } from '../api/distinct'
import type { DistinctResult } from '../api/distinct'

interface ColumnMeta {
  type: string
  hanaType: string
  nullable: boolean
  length: number | null
  filterMode: 'enum' | 'free' | 'date' | 'numeric-range'
  filterSample: boolean
  pii: boolean
}

interface AssociationMeta {
  name: string
  targetEntity: string
  cardinality: 'to-one' | 'to-many'
  onLocal: string[]
  onTarget: string[]
}

interface EntityMeta {
  name: string
  label: string
  sqlName: string
  columns: Map<string, ColumnMeta>
  associations: AssociationMeta[]
}

const _entities = ref<any[]>([])
const _entityMap = ref<Map<string, EntityMeta>>(new Map())
const _sqlNames = ref<Record<string, string>>({})
const _loaded = ref(false)
const _distinctCache = new Map<string, Promise<DistinctResult>>()

export function _resetForTest() {
  _entities.value = []
  _entityMap.value = new Map()
  _sqlNames.value = {}
  _loaded.value = false
  _distinctCache.clear()
}

export function useEntityGraph() {
  async function load() {
    if (_loaded.value) return
    const list = await getCachedEntityMetadata()
    _entities.value = list as any[]
    const map = new Map<string, EntityMeta>()
    const names: Record<string, string> = {}
    for (const e of list as any[]) {
      const cols = new Map<string, ColumnMeta>()
      for (const c of e.columns) {
        cols.set(c.name, {
          type: c.type,
          hanaType: c.hanaType,
          nullable: c.nullable,
          length: c.length,
          filterMode: c.filterMode,
          filterSample: c.filterSample,
          pii: c.pii,
        })
      }
      map.set(e.name, {
        name: e.name,
        label: e.label,
        sqlName: e.sqlName,
        columns: cols,
        associations: (e.associations || []) as AssociationMeta[],
      })
      names[e.name] = e.sqlName
    }
    _entityMap.value = map
    _sqlNames.value = names
    _loaded.value = true
  }

  function joinableTo(entityName: string): AssociationMeta[] {
    const meta = _entityMap.value.get(entityName)
    if (!meta) return []
    return meta.associations.filter(a => _entityMap.value.has(a.targetEntity))
  }

  function sampleDistinctCached(table: string, column: string): Promise<DistinctResult> {
    const key = `${table}.${column}`
    let p = _distinctCache.get(key)
    if (!p) {
      p = apiSampleDistinct(table, column).catch(err => {
        // Drop failed promises from the cache so the user can retry.
        _distinctCache.delete(key)
        throw err
      })
      _distinctCache.set(key, p)
    }
    return p
  }

  return {
    entities: _entities,
    entityMap: _entityMap,
    sqlNames: _sqlNames,
    loaded: computed(() => _loaded.value),
    load,
    joinableTo,
    sampleDistinctCached,
  }
}
```

- [ ] **Step 5: Run the tests**

```bash
npm test -- --project=unit useEntityGraph
```

Expected: 7 PASS.

- [ ] **Step 6: Commit**

```bash
git add app/analytics-explorer/src/composables/useEntityGraph.ts app/analytics-explorer/src/composables/__tests__/useEntityGraph.test.ts app/analytics-explorer/src/api/distinct.ts
git commit -m "feat(analytics-explorer): add useEntityGraph composable

Loads enriched entity metadata via getCachedEntityMetadata once per
session and exposes:
  - entities[] (raw)
  - entityMap (Map<name, EntityMeta>) — the validator-expected shape
  - sqlNames map — for spec-to-sql to resolve logical → physical
  - joinableTo(entity) — associations whose target is also exposed
  - sampleDistinctCached(table, col) — promise-memoized per session,
    failed promises dropped so retry works

Plus a small api/distinct.ts wrapper for the new sampleDistinct
endpoint added in Phase 1."
```

---

## Task 8: ClauseChipBar shell wired into SqlTab

**Files:**
- Create: `app/analytics-explorer/src/components/builder/ClauseChipBar.vue`
- Modify: `app/analytics-explorer/src/components/SqlTab.vue` (add chip-bar above the existing entity-list/editor row)

After Part A, the SQL tab still works as it did before — the chip bar mounts and is empty (no chips yet) but doesn't interfere with the existing Monaco editor + entity sidebar + run flow. Phase 2 Part B fills in the chip kinds.

- [ ] **Step 1: Create the ClauseChipBar shell**

Create `app/analytics-explorer/src/components/builder/ClauseChipBar.vue`:

```vue
<script setup lang="ts">
import { onMounted } from 'vue'
import { useQuerySpec } from '../../composables/useQuerySpec'
import { useEntityGraph } from '../../composables/useEntityGraph'

const querySpec = useQuerySpec()
const entityGraph = useEntityGraph()

onMounted(async () => {
  // Lazy-load entity metadata when the chip bar mounts. Cheap because
  // getCachedEntityMetadata is already memoized at the API layer.
  await entityGraph.load()
})
</script>

<template>
  <div class="clause-chip-bar" role="toolbar" aria-label="Query builder">
    <div v-if="!querySpec.spec.value" class="empty-hint">
      Click an entity in the sidebar to start building a query, or switch to the SQL Editor tab.
    </div>
    <div v-else class="chips-placeholder">
      <!-- Phase 2 Part B fills in: FromChip, JoinChip(s), FilterChip tree,
           GroupByChip(s), SelectChip(s), OrderByChip(s), LimitChip. -->
      <code class="spec-debug">{{ JSON.stringify(querySpec.spec.value, null, 2) }}</code>
    </div>
  </div>
</template>

<style scoped>
.clause-chip-bar {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
  min-height: 3rem;
  display: flex;
  align-items: center;
}

.empty-hint {
  color: var(--sapContent_LabelColor);
  font-size: 0.875rem;
}

.chips-placeholder {
  font-family: var(--sapFontFamily);
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
}

.spec-debug {
  font-family: var(--sapFontMonospaceFamily);
  white-space: pre-wrap;
  max-width: 60ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
```

- [ ] **Step 2: Wire into SqlTab.vue**

Edit `app/analytics-explorer/src/components/SqlTab.vue`. Add the import:

```typescript
import ClauseChipBar from './builder/ClauseChipBar.vue'
```

In the template, add `<ClauseChipBar />` immediately after the opening `<div class="sql-tab">`:

```vue
<template>
  <div class="sql-tab">
    <ClauseChipBar />
    <div class="main-row">
      <!-- existing entity-list aside + editor-section unchanged -->
```

- [ ] **Step 3: Smoke-check the dev server**

```bash
cd app/analytics-explorer && npm install 2>&1 | tail -3 && npm run build 2>&1 | tail -10
```

Expected: build succeeds. The new ClauseChipBar component is included in the bundle.

(Skip running the dev server — that requires a CAP backend on :4004. We verify via build only.)

- [ ] **Step 4: Commit**

```bash
cd ../..  # back to repo root
git add app/analytics-explorer/src/components/builder/ClauseChipBar.vue app/analytics-explorer/src/components/SqlTab.vue
git commit -m "feat(analytics-explorer): add empty ClauseChipBar shell to SqlTab

Phase 2 Part A landing point: chip bar mounts, loads entity metadata via
useEntityGraph.load(), and renders an empty hint when no spec exists. The
existing Monaco editor + entity sidebar + run flow are unchanged — Part B
will fill in the chip kinds (FromChip, JoinChip, FilterChip, ...) and
wire the run button to the auto-generated SQL.

Mounts inside .sql-tab above .main-row; styled with SAP CSS vars so it
follows the existing theme."
```

---

## Part A summary checklist

- [ ] Task 1: README update
- [ ] Task 2: query-spec-validator → ESM
- [ ] Task 3: spec-to-sql → ESM
- [ ] Task 4: Vite alias + tsconfig path + smoke test
- [ ] Task 5: TypeScript types for QuerySpec
- [ ] Task 6: useQuerySpec composable (TDD)
- [ ] Task 7: useEntityGraph composable (TDD)
- [ ] Task 8: ClauseChipBar shell wired into SqlTab

After Part A, the existing SQL tab still works exactly as before. Part B (Tasks 9–25) adds the chip kinds, live SQL preview, run flow, virtualized result table (basic), history-write integration, hybrid + smoke tests, and the PR.
