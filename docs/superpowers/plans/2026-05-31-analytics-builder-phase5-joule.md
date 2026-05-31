# Analytics SQL Builder — Phase 5 (Joule Integration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add three Joule tools (`generateAnalyticsQuery` NEW, `explainAnalyticsResult` NEW, `analyticsQuery` EXTENDED with pageContext awareness) plus a persistent right-rail JoulePanel in the analytics-explorer SPA. The panel streams via SSE to the existing `/chat/stream` endpoint; "View in builder" on a Generated-Query message restores the chip state via `useQuerySpec.setSpec`. Client-side PII redaction strips `@analytics.pii: true` columns from `lastResult.rows` before sending to the LLM.

**Architecture:** Existing chat orchestrator (`srv/lib/chat-orchestrator.js`) already ships `analyticsQuery` (Phase 1) and an SSE envelope. Phase 5 adds two tool definitions + their dispatch handlers + new SSE event types (`generated-query`, `explanation`). `chat-context.js`'s existing `adminLayer()` is enhanced to surface `currentSpec` + `lastResult.columns` when `pageContext.kind === 'admin' && pageContext.tool === 'analytics-builder'` (this matches the existing admin pageContext shape — we do NOT introduce a new kind). The SPA gets a new `JoulePanel.vue` (right-rail), `useJouleChat.ts` composable (SSE consumer), `redactPii.ts` utility (client-side filter), and `App.vue` wiring (toggle visibility + push `pageContext`). Server re-derives SQL from the validated QuerySpec — never trusts LLM-emitted SQL.

**Tech Stack:** Vue 3 + Vite + TypeScript (`app/analytics-explorer/`); CAP Node.js (`@sap/cds`) + `@sap-ai-sdk/orchestration`; Vitest + happy-dom for tests.

**Spec:** [docs/superpowers/specs/2026-05-31-analytics-sql-builder-design.md](../specs/2026-05-31-analytics-sql-builder-design.md) section 5 (Joule integration).

**Predecessor:** Phase 4 (PR #147, merged 2026-05-31, commit 4a374ec). History + Saved Queries tabs are live; runSelectQuery persists QuerySpec on history rows.

**Branch:** `feat/analytics-builder-phase5-joule` (already created from `main` post-merge).

**Conventions used in this plan:**

- All paths repo-relative from `d:\projects\tutorials-poc`.
- All commands assume Bash (Git Bash on Windows). Forward slashes.
- Per-file `// @vitest-environment happy-dom` pragma for component tests.
- TDD discipline: every code task starts with a failing test.
- Each task ends with one focused commit.
- ECharts/ChartTypeSwitcher mocked in component tests where transitively imported.
- The existing `analyticsQuery` tool stays untouched — Phase 5 only **extends** its system-prompt context (currentSpec/lastResult).
- LLM never receives raw PII. Client-side redaction in `redactPii.ts` replaces values with `'[REDACTED]'` for any column where `listExposedEntities.columns[].pii === true`. Limit row sample to 50 rows for context-window safety.
- The `generateAnalyticsQuery` server wrapper validates the LLM-emitted QuerySpec via `validateQuerySpec`, then re-derives SQL via `specToSql` — LLM SQL is never executed.

**Deferred for a follow-up PR (explicitly NOT in scope of this plan):**

- **`analyticsQuery` envelope k-anon extension.** Spec §5 line 473 describes a `privacy: { mode: 'k-anon', k: 5, suppressedCells: N }` envelope plus `impliedSpec`. Phase 5 only extends the system-prompt context — the dispatcher envelope is unchanged. Track as a follow-up.
- **"Direct answer" message bubble** for `analyticsQuery` results. Spec §5 (lines 609-613) describes a third bubble type beyond Generated-Query and Explanation. Phase 5 ships the latter two; the Direct-Answer bubble lands in a follow-up.
- **Replace / Merge ▾ split button** on "View in builder". Phase 5 ships a single "View in builder" button which always Replace's the spec. Merge (graft only the changed clauses) is a follow-up; a TODO comment in `JouleMessage.vue` will mark it.
- **Header context indicator + welcome chips.** Spec §5 (lines 615-617) describes a "📎 Current spec sent · Last result ✓" indicator and starter prompt chips. Phase 5 ships an empty-state hint instead. Polish work for a follow-up.

---

## Phase 5 task list

1. `generateAnalyticsQuery` tool definition + dispatcher (TDD; backend)
2. `explainAnalyticsResult` tool definition + dispatcher (TDD; backend)
3. Extend `chat-context.js`'s `adminLayer` with `currentSpec` + `lastResult` summary (TDD; backend)
4. `redactPii.ts` utility (TDD; frontend)
5. `useJouleChat.ts` composable — SSE consumer (TDD; frontend)
6. `useJouleContext.ts` composable — pulls currentSpec + lastResult + redacts (TDD; frontend)
7. `JouleMessage.vue` — message bubble component supporting all event types (TDD)
8. `JoulePanel.vue` — right-rail panel with input + message list + close button (TDD)
9. Wire JoulePanel into `App.vue` (toggle from shellbar Joule button)
10. SqlTab integration — pass current spec/result to JoulePanel via composable; "View in builder" round-trip
11. Final regression sweep + lint + build
12. srv-qa cp-list verification
13. Open PR

---

## Task 1: `generateAnalyticsQuery` tool

**Files:**
- Create: `srv/lib/analytics-llm-context.js` (helper: builds entityMap + sqlNames maps from cds.model)
- Modify: `srv/lib/chat-orchestrator.js` (add tool def + dispatcher branch + SSE event)
- Create: `srv/__tests__/chat-orchestrator-analytics-tools.test.js`

The LLM emits a QuerySpec JSON; the server validates it via `validateQuerySpec`, re-derives SQL via `specToSql` (LLM SQL is never executed), runs it with a 10-row preview cap, and returns `{ spec, sql, errors, preview }`. SSE emits a `generated-query` event so the SPA can render a "View in builder" button.

- [ ] **Step 1: Verify branch state**

```bash
git branch --show-current
```

Expected: `feat/analytics-builder-phase5-joule`. Abort if it shows `main`.

- [ ] **Step 2: Create the LLM-context helper**

Create `srv/lib/analytics-llm-context.js`:

```javascript
import cds from '@sap/cds'

let _cache = null

export function getAnalyticsContext() {
  if (_cache) return _cache
  const isHana = cds.db && cds.db.kind === 'hana'
  const entityMap = new Map()
  const sqlNames = {}
  for (const def of Object.values(cds.model.definitions)) {
    if (def.kind !== 'entity') continue
    if (!def['@analytics.exposed']) continue
    if (!def.name.startsWith('com.sap.developers.ims.')) continue
    if (/^com\.sap\.developers\.ims\.Analytics(QueryHistory|SavedQuery)$/.test(def.name)) continue
    const projectionName = def.name.split('.').pop()
    const hanaName = def.name.replace(/\./g, '_').toUpperCase()
    const sqliteName = def.name.replace(/\./g, '_')
    const cols = new Map()
    for (const [name, elem] of Object.entries(def.elements || {})) {
      if (elem.virtual || elem.target) continue
      cols.set(name, { type: elem.type, length: elem.length })
    }
    entityMap.set(projectionName, { columns: cols })
    sqlNames[projectionName] = isHana ? hanaName : sqliteName
  }
  _cache = { entityMap, sqlNames }
  return _cache
}

export function _resetAnalyticsContextForTest() { _cache = null }
```

- [ ] **Step 3: Write the failing test**

Create `srv/__tests__/chat-orchestrator-analytics-tools.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

const { dispatchTool } = await import('../lib/chat-orchestrator.js')

describe('generateAnalyticsQuery (Phase 5)', () => {
  it('validates LLM-emitted spec and returns sql + preview on success', async () => {
    const user = new cds.User.Privileged()
    const llmSpec = {
      version: 1,
      from: { entity: 'TaskRecords', alias: 'tr' },
      joins: [],
      filterTree: null,
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'tr', column: 'ID' } }],
      orderBy: [],
      limit: 5,
    }
    const result = await dispatchTool('generateAnalyticsQuery', { spec: llmSpec }, user)
    expect(result.errors).toEqual([])
    expect(result.spec).toEqual(llmSpec)
    expect(result.sql).toMatch(/SELECT\s+tr\.ID\s+FROM/i)
    expect(Array.isArray(result.preview?.rows)).toBe(true)
  })

  it('returns errors on invalid spec', async () => {
    const user = new cds.User.Privileged()
    const badSpec = {
      version: 1,
      from: { entity: 'NopeEntity', alias: 'n' },
      joins: [], filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 'n', column: 'whatever' } }],
      orderBy: [], limit: null,
    }
    const result = await dispatchTool('generateAnalyticsQuery', { spec: badSpec }, user)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.sql).toBeUndefined()
  })

  it('returns friendly error when spec missing', async () => {
    const user = new cds.User.Privileged()
    const result = await dispatchTool('generateAnalyticsQuery', {}, user)
    expect(result.error).toMatch(/spec.*required/i)
  })
})
```

- [ ] **Step 4: Run to confirm failure**

```bash
npm test -- --project=unit chat-orchestrator-analytics-tools
```

Expected: 3 FAIL — `dispatchTool('generateAnalyticsQuery', ...)` returns the unknown-tool error.

- [ ] **Step 5: Add the tool definition**

In `srv/lib/chat-orchestrator.js`, after the existing `ANALYTICS_QUERY_TOOL` block (~line 85), add:

```javascript
const GENERATE_ANALYTICS_QUERY_TOOL = {
  type: 'function',
  function: {
    name: 'generateAnalyticsQuery',
    description: [
      'Translate a natural-language analytics request into a structured QuerySpec',
      'that the user can review in the chip builder. The QuerySpec is validated and',
      'SQL is re-derived server-side; do NOT emit raw SQL. Use this when the user',
      'wants to construct or refine a query that they will run themselves.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        spec: {
          type: 'object',
          description: 'A QuerySpec v1 object. See @srv-lib/query-spec-validator.mjs for the schema.',
        },
        explanation: {
          type: 'string',
          description: 'A short (1-2 sentence) plain-language explanation of what the query does.',
        },
      },
      required: ['spec'],
    },
  },
}
```

- [ ] **Step 6: Add the dispatcher branch**

In `dispatchTool()`, add a branch for `'generateAnalyticsQuery'`. Use top-level imports (already present is `import cds from '@sap/cds'`); add at the top of the file alongside other imports:

```javascript
import { validateQuerySpec } from './query-spec-validator.mjs'
import { specToSql } from './spec-to-sql.mjs'
import { getAnalyticsContext } from './analytics-llm-context.js'
```

Then in `dispatchTool()`:

```javascript
if (name === 'generateAnalyticsQuery') {
  const spec = args?.spec
  if (!spec || typeof spec !== 'object') {
    return { error: 'spec is required (QuerySpec v1 object)' }
  }
  const { entityMap, sqlNames } = getAnalyticsContext()
  const { errors } = validateQuerySpec(spec, entityMap)
  if (errors.length > 0) return { errors, spec }
  let sql
  try { sql = specToSql(spec, sqlNames) }
  catch (e) { return { errors: [{ chipId: null, message: `spec-to-sql failed: ${e.message}` }], spec } }
  const wrapped = `SELECT * FROM (${sql}) t LIMIT 11`
  let rows = []
  try { rows = await cds.db.run(wrapped) }
  catch (e) { return { errors: [{ chipId: null, message: `query execution failed: ${e.message}` }], spec, sql } }
  const truncated = rows.length > 10
  const preview = {
    columns: rows.length ? Object.keys(rows[0]) : [],
    rows: (truncated ? rows.slice(0, 10) : rows).map(r => Object.values(r).map(v => v === null ? null : String(v))),
    truncated,
  }
  return { errors: [], spec, sql, explanation: args?.explanation || '', preview }
}
```

- [ ] **Step 7: Add the tool to admin context**

In `toolsForContext()`, append `GENERATE_ANALYTICS_QUERY_TOOL` to the admin tool array alongside `ANALYTICS_QUERY_TOOL`.

- [ ] **Step 8: Add the SSE event emission**

`chat-orchestrator.js` has a `for (const tc of collectedToolCalls)` loop (around line 417-425) that walks each completed tool call and emits an SSE envelope based on `tc.name`. Currently the chain is `if (tc.name === 'analyticsQuery' && ...) sse(res, ...) else if (tc.name === 'getRelevantSteps' && ...) sse(res, ...)`. Append the new branch to that `else if` chain — keep the chain order so success and validation-failure both flow:

```javascript
else if (tc.name === 'generateAnalyticsQuery' && result && Array.isArray(result.errors)) {
  sse(res, { type: 'generated-query', spec: result.spec, sql: result.sql, errors: result.errors, explanation: result.explanation, preview: result.preview })
}
```

- [ ] **Step 9: Run tests to verify pass**

```bash
npm test -- --project=unit chat-orchestrator-analytics-tools
```

Expected: 3 PASS.

- [ ] **Step 10: Commit**

```bash
git add srv/lib/chat-orchestrator.js srv/lib/analytics-llm-context.js srv/__tests__/chat-orchestrator-analytics-tools.test.js
git commit -m "feat(chat): generateAnalyticsQuery tool"
```

---

## Task 2: `explainAnalyticsResult` tool

**Files:**
- Modify: `srv/lib/chat-orchestrator.js` (add tool def + dispatcher + SSE event)
- Modify: `srv/__tests__/chat-orchestrator-analytics-tools.test.js`

The LLM receives a redacted result sample (columns + up to 50 rows, PII already stripped client-side) and produces a plain-language summary. Server is a passthrough — no SQL, no DB. Returns `{ summary }`. The dispatcher caps `rows.length` at 50 server-side as a defence-in-depth check.

- [ ] **Step 1: Append failing tests**

Append to `srv/__tests__/chat-orchestrator-analytics-tools.test.js`:

```javascript
describe('explainAnalyticsResult (Phase 5)', () => {
  it('passes columns + capped rows through to result and returns the summary', async () => {
    const user = new cds.User.Privileged()
    const result = await dispatchTool('explainAnalyticsResult', {
      columns: ['id', 'count'],
      rows: [['a', 3], ['b', 7]],
      summary: 'Two groups, 10 events total.',
    }, user)
    expect(result.summary).toBe('Two groups, 10 events total.')
    expect(result.columns).toEqual(['id', 'count'])
    expect(result.rows).toHaveLength(2)
  })

  it('caps rows to 50 server-side', async () => {
    const user = new cds.User.Privileged()
    const bigRows = Array.from({ length: 200 }, (_, i) => [`row${i}`])
    const result = await dispatchTool('explainAnalyticsResult', {
      columns: ['id'], rows: bigRows, summary: 'cap me',
    }, user)
    expect(result.rows).toHaveLength(50)
    expect(result.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit chat-orchestrator-analytics-tools
```

Expected: 2 new FAIL.

- [ ] **Step 3: Add the tool definition**

After `GENERATE_ANALYTICS_QUERY_TOOL`:

```javascript
const EXPLAIN_ANALYTICS_RESULT_TOOL = {
  type: 'function',
  function: {
    name: 'explainAnalyticsResult',
    description: [
      'Produce a 1-3 sentence plain-language summary of an analytics result',
      'sample. The user has just run a query and wants context. The columns +',
      'rows are already PII-redacted client-side; do NOT echo cell values',
      'verbatim if they look sensitive. Highlight totals, outliers, trends.',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        columns: { type: 'array', items: { type: 'string' } },
        rows: { type: 'array', items: { type: 'array' } },
        summary: { type: 'string', description: 'Your 1-3 sentence summary.' },
      },
      required: ['columns', 'rows', 'summary'],
    },
  },
}
```

- [ ] **Step 4: Add the dispatcher branch**

```javascript
if (name === 'explainAnalyticsResult') {
  const cols = Array.isArray(args?.columns) ? args.columns : []
  const allRows = Array.isArray(args?.rows) ? args.rows : []
  const truncated = allRows.length > 50
  const rows = truncated ? allRows.slice(0, 50) : allRows
  return {
    columns: cols,
    rows,
    truncated: !!truncated,  // always boolean for envelope-shape stability
    summary: typeof args?.summary === 'string' ? args.summary : '',
  }
}
```

- [ ] **Step 5: Add SSE emission**

```javascript
else if (tc.name === 'explainAnalyticsResult' && result && typeof result.summary === 'string') {
  sse(res, { type: 'explanation', summary: result.summary, columns: result.columns, rows: result.rows, truncated: result.truncated })
}
```

- [ ] **Step 6: Register in toolsForContext**

Append `EXPLAIN_ANALYTICS_RESULT_TOOL` to the admin branch.

- [ ] **Step 7: Run to verify pass**

```bash
npm test -- --project=unit chat-orchestrator-analytics-tools
```

Expected: 5 PASS.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/chat-orchestrator.js srv/__tests__/chat-orchestrator-analytics-tools.test.js
git commit -m "feat(chat): explainAnalyticsResult tool"
```

---

## Task 3: Extend `chat-context.js` `adminLayer` with analytics page context

**Files:**
- Modify: `srv/lib/chat-context.js` (extend existing `adminLayer` to recognize `tool === 'analytics-builder'`)
- Create: `srv/__tests__/chat-context-analytics.test.js`

**IMPORTANT:** `buildSystemPrompt(pageContext, user)` is two-positional-args. `pageLayer` routes by `pageContext.kind`; only `kind === 'admin'` reaches `adminLayer`. Phase 5 piggy-backs on the admin shape: `{ kind: 'admin', tool: 'analytics-builder', currentSpec, lastResult }` — we do NOT add a new `kind`.

When the admin layer detects `tool === 'analytics-builder'`, it appends:

- Current QuerySpec summary (one line: `FROM <entity> <alias>, N select chips, filters: yes/none, groupBy: N/none, limit X`)
- Last result summary (one line: `N rows (truncated?), columns: c1, c2, ...`)
- A short directive telling the model to use `generateAnalyticsQuery` / `explainAnalyticsResult` and to copy the user's current spec when refining.

- [ ] **Step 1: Inspect current adminLayer**

```bash
grep -n "function adminLayer" srv/lib/chat-context.js
sed -n '90,105p' srv/lib/chat-context.js
```

Expect signature `function adminLayer(ctx)`, body that already references `ctx.tool` and `ctx.entity`.

- [ ] **Step 2: Write failing test**

Create `srv/__tests__/chat-context-analytics.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import { buildSystemPrompt } from '../lib/chat-context.js'

describe('chat-context analytics-builder pageContext (Phase 5)', () => {
  it('renders currentSpec + lastResult when tool === analytics-builder', () => {
    const prompt = buildSystemPrompt({
      kind: 'admin',
      tool: 'analytics-builder',
      currentSpec: {
        version: 1,
        from: { entity: 'TaskRecords', alias: 'tr' },
        select: [{ kind: 'column', ref: { alias: 'tr', column: 'ID' } }],
        filterTree: null, joins: [], groupBy: [], orderBy: [], limit: 50,
      },
      lastResult: { columns: ['ID'], rowCount: 7, truncated: false },
    }, null)
    expect(prompt).toMatch(/analytics-builder/i)
    expect(prompt).toMatch(/TaskRecords/)
    expect(prompt).toMatch(/7 rows/i)
    expect(prompt).toMatch(/generateAnalyticsQuery|explainAnalyticsResult/)
  })

  it('handles admin pageContext without analytics-builder gracefully', () => {
    const prompt = buildSystemPrompt({ kind: 'admin', tool: 'changelog' }, null)
    expect(prompt).toMatch(/admin/i)
    expect(prompt).not.toMatch(/TaskRecords/)
  })

  it('no-op when on a non-admin page', () => {
    const prompt = buildSystemPrompt({ kind: 'tutorial', slug: 'x' }, null)
    expect(prompt).not.toMatch(/analytics-builder/i)
  })
})
```

- [ ] **Step 3: Run failing test**

```bash
npm test -- --project=unit chat-context-analytics
```

Expected: 3 FAIL.

- [ ] **Step 4: Extend `adminLayer`**

In `srv/lib/chat-context.js`, modify the `adminLayer(ctx)` function. After the existing `ctx.entity` block and before the closing `lines.push('You may call searchAdminDocs ...')` line, add:

```javascript
if (ctx.tool === 'analytics-builder') {
  if (ctx.currentSpec && typeof ctx.currentSpec === 'object') {
    const s = ctx.currentSpec;
    const fromLine = s.from ? `${s.from.entity} ${s.from.alias}` : '(no entity)';
    const cols = Array.isArray(s.select) ? s.select.length : 0;
    const filt = s.filterTree ? 'filters: yes' : 'filters: none';
    const grp = Array.isArray(s.groupBy) && s.groupBy.length ? `groupBy: ${s.groupBy.length}` : 'groupBy: none';
    lines.push(`Current spec: FROM ${fromLine}, ${cols} select chips, ${filt}, ${grp}, limit ${s.limit ?? 'unset'}.`);
  } else {
    lines.push('User is starting from a blank query.');
  }
  if (ctx.lastResult && typeof ctx.lastResult === 'object') {
    const r = ctx.lastResult;
    const colList = Array.isArray(r.columns) ? r.columns.join(', ') : '(no columns)';
    lines.push(`Last result: ${r.rowCount ?? 0} rows${r.truncated ? ' (truncated)' : ''}, columns: ${colList}.`);
  }
  lines.push('Use the `generateAnalyticsQuery` tool to translate natural-language requests into a QuerySpec. Use the `explainAnalyticsResult` tool to summarize a result the user has just run. When refining, copy the user\'s current spec and modify only what changed.');
}
```

Also update the existing trailing line so the tool list reflects the new tools:

```javascript
lines.push('You may call searchAdminDocs, searchTutorials, analyticsQuery, generateAnalyticsQuery, or explainAnalyticsResult. Never expose user identity, email, or request IP.');
```

- [ ] **Step 5: Verify pageContext threading in server.js**

```bash
grep -n "pageContext" srv/server.js | head -10
```

Confirm `pageContext` is destructured from the request body and threaded into `streamChat`/`buildSystemPrompt`. No changes needed if so.

- [ ] **Step 6: Run tests to verify pass**

```bash
npm test -- --project=unit chat-context-analytics
```

Expected: 3 PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/chat-context.js srv/__tests__/chat-context-analytics.test.js
git commit -m "feat(chat): analytics-builder pageContext in adminLayer"
```

---

## Task 4: `redactPii.ts` utility (frontend)

**Files:**
- Create: `app/analytics-explorer/src/lib/redactPii.ts`
- Create: `app/analytics-explorer/src/lib/__tests__/redactPii.test.ts`

Client-side filter that takes `{ columns, rows }` + the entity-metadata `pii` flags from `getCachedEntityMetadata()` and replaces values with `'[REDACTED]'` for any column where `pii === true`. Pure function — easy to unit-test, no Vue dependency.

- [ ] **Step 1: Write failing test**

Create `app/analytics-explorer/src/lib/__tests__/redactPii.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import { redactPii } from '../redactPii'
import type { ExposedEntity } from '../../api/entities'

const entities: ExposedEntity[] = [
  {
    name: 'Users', sqlName: 'COM_SAP_DEVELOPERS_IMS_USERS', label: 'Users',
    columns: [
      { name: 'ID', type: 'cds.UUID', pii: false },
      { name: 'email', type: 'cds.String', pii: true },
      { name: 'firstName', type: 'cds.String', pii: true },
      { name: 'createdAt', type: 'cds.Timestamp', pii: false },
    ],
  },
] as any

describe('redactPii', () => {
  it('replaces PII column values with [REDACTED]', () => {
    const out = redactPii({
      entityName: 'Users',
      columns: ['ID', 'email', 'firstName', 'createdAt'],
      rows: [['u1', 'a@b.com', 'Alice', '2026-01-01']],
    }, entities)
    expect(out.rows[0]).toEqual(['u1', '[REDACTED]', '[REDACTED]', '2026-01-01'])
    expect(out.redactedColumns).toEqual(['email', 'firstName'])
  })

  it('passes through non-PII columns unchanged', () => {
    const out = redactPii({
      entityName: 'Users',
      columns: ['ID', 'createdAt'],
      rows: [['u1', '2026-01-01']],
    }, entities)
    expect(out.rows[0]).toEqual(['u1', '2026-01-01'])
    expect(out.redactedColumns).toEqual([])
  })

  it('returns input unchanged when entity is unknown', () => {
    const out = redactPii({
      entityName: 'Unknown',
      columns: ['x'],
      rows: [['y']],
    }, entities)
    expect(out.rows[0]).toEqual(['y'])
  })

  it('caps rows at 50 by default', () => {
    const big = Array.from({ length: 200 }, (_, i) => ['u' + i, `email${i}`, 'Alice', '2026'])
    const out = redactPii({
      entityName: 'Users',
      columns: ['ID', 'email', 'firstName', 'createdAt'],
      rows: big,
    }, entities)
    expect(out.rows).toHaveLength(50)
    expect(out.truncated).toBe(true)
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
cd app/analytics-explorer && npx vitest run src/lib/__tests__/redactPii.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `app/analytics-explorer/src/lib/redactPii.ts`:

```typescript
import type { ExposedEntity } from '../api/entities'

export interface RedactInput {
  entityName: string
  columns: string[]
  rows: any[][]
}

export interface RedactOutput {
  columns: string[]
  rows: any[][]
  redactedColumns: string[]
  truncated: boolean
}

const REDACTED = '[REDACTED]' as const
const MAX_ROWS = 50

export function redactPii(input: RedactInput, entities: ExposedEntity[]): RedactOutput {
  const entity = entities.find(e => e.name === input.entityName)
  const piiSet = new Set<string>()
  if (entity) {
    for (const col of entity.columns) {
      if ((col as any).pii === true) piiSet.add(col.name)
    }
  }
  const redactIdx = input.columns
    .map((c, i) => piiSet.has(c) ? i : -1)
    .filter(i => i >= 0)

  const truncated = input.rows.length > MAX_ROWS
  const sourceRows = truncated ? input.rows.slice(0, MAX_ROWS) : input.rows
  const rows = redactIdx.length === 0
    ? sourceRows.map(r => r.slice())
    : sourceRows.map(r => r.map((v, i) => redactIdx.includes(i) ? REDACTED : v))

  return {
    columns: input.columns.slice(),
    rows,
    redactedColumns: input.columns.filter(c => piiSet.has(c)),
    truncated,
  }
}
```

- [ ] **Step 4: Run to verify pass**

```bash
cd app/analytics-explorer && npx vitest run src/lib/__tests__/redactPii.test.ts
```

Expected: 4 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/lib/redactPii.ts app/analytics-explorer/src/lib/__tests__/redactPii.test.ts
git commit -m "feat(analytics): redactPii client-side utility"
```

---

## Task 5: `useJouleChat.ts` composable — SSE consumer

**Files:**
- Create: `app/analytics-explorer/src/composables/useJouleChat.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useJouleChat.test.ts`

Vue composable that manages chat state (`messages`, `streaming`, `error`) and a `send(prompt, pageContext)` action. Posts to `/chat/stream` and parses the SSE event stream — accumulating `delta` chunks into the assistant message, appending discrete `generated-query` and `explanation` events as separate message bubbles. Cancellable via `AbortController`.

State shape:

```typescript
type Message =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'generated-query'; spec: any; sql: string; explanation: string; preview: any; errors: any[] }
  | { id: string; role: 'assistant'; kind: 'explanation'; summary: string }
  | { id: string; role: 'assistant'; kind: 'error'; text: string }
```

- [ ] **Step 1: Write failing test**

Create `app/analytics-explorer/src/composables/__tests__/useJouleChat.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useJouleChat } from '../useJouleChat'

const encoder = new TextEncoder()
function sseStream(events: string[]) {
  return new ReadableStream({
    start(controller) {
      for (const e of events) controller.enqueue(encoder.encode(e))
      controller.close()
    },
  })
}

beforeEach(() => {
  vi.spyOn(globalThis, 'fetch' as any).mockImplementation(async () => ({
    ok: true,
    body: sseStream([
      'data: {"type":"delta","text":"Hello "}\n\n',
      'data: {"type":"delta","text":"world"}\n\n',
      'data: {"type":"done"}\n\n',
    ]),
  } as any))
})
afterEach(() => vi.restoreAllMocks())

describe('useJouleChat', () => {
  it('streams delta chunks into a single assistant text message', async () => {
    const chat = useJouleChat()
    await chat.send('hi', { kind: 'admin', tool: 'analytics-builder' })
    expect(chat.messages.value).toHaveLength(2)
    expect(chat.messages.value[0]).toMatchObject({ role: 'user', text: 'hi' })
    expect(chat.messages.value[1]).toMatchObject({ role: 'assistant', kind: 'text', text: 'Hello world' })
    expect(chat.streaming.value).toBe(false)
  })

  it('appends generated-query as its own message', async () => {
    vi.mocked(globalThis.fetch as any).mockResolvedValueOnce({
      ok: true,
      body: sseStream([
        'data: {"type":"delta","text":"Here you go: "}\n\n',
        'data: {"type":"generated-query","spec":{"version":1},"sql":"SELECT 1","explanation":"trivial","preview":{"columns":[],"rows":[],"truncated":false},"errors":[]}\n\n',
        'data: {"type":"done"}\n\n',
      ]),
    })
    const chat = useJouleChat()
    await chat.send('build me one', { kind: 'admin', tool: 'analytics-builder' })
    const last = chat.messages.value[chat.messages.value.length - 1]
    expect(last.kind).toBe('generated-query')
    expect((last as any).sql).toBe('SELECT 1')
  })

  it('records error message on non-ok response', async () => {
    vi.mocked(globalThis.fetch as any).mockResolvedValueOnce({ ok: false, status: 500, statusText: 'boom', body: null })
    const chat = useJouleChat()
    await chat.send('hi', { kind: 'admin', tool: 'analytics-builder' })
    expect(chat.messages.value.at(-1)?.kind).toBe('error')
    expect(chat.streaming.value).toBe(false)
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
cd app/analytics-explorer && npx vitest run src/composables/__tests__/useJouleChat.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `app/analytics-explorer/src/composables/useJouleChat.ts`:

```typescript
import { ref, type Ref } from 'vue'

export type JouleMessage =
  | { id: string; role: 'user'; text: string }
  | { id: string; role: 'assistant'; kind: 'text'; text: string }
  | { id: string; role: 'assistant'; kind: 'generated-query'; spec: any; sql: string; explanation: string; preview: any; errors: any[] }
  | { id: string; role: 'assistant'; kind: 'explanation'; summary: string; columns?: string[]; rows?: any[][] }
  | { id: string; role: 'assistant'; kind: 'error'; text: string }

let _idSeq = 0
const nextId = () => `m${++_idSeq}`

export function useJouleChat() {
  const messages: Ref<JouleMessage[]> = ref([])
  const streaming = ref(false)
  const error = ref<string | null>(null)
  let abort: AbortController | null = null

  async function send(prompt: string, pageContext: any) {
    if (streaming.value) return
    error.value = null
    messages.value.push({ id: nextId(), role: 'user', text: prompt })
    streaming.value = true
    abort = new AbortController()

    try {
      // Build the full conversation history for /chat/stream. Server expects
      // an array of { role, content } turns; we map our richer message shape
      // down. Tool-result envelopes stay client-side (server has its own loop).
      const wireMessages = messages.value
        .filter(m => m.role === 'user' || (m.role === 'assistant' && m.kind === 'text'))
        .map(m => ({
          role: m.role,
          content: m.role === 'user' ? (m as any).text : (m as any).text,
        }))
      const res = await fetch('/chat/stream', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ messages: wireMessages, pageContext }),
        signal: abort.signal,
      } as any)

      if (!res.ok || !res.body) {
        messages.value.push({ id: nextId(), role: 'assistant', kind: 'error', text: `HTTP ${res.status} ${res.statusText || ''}`.trim() })
        return
      }

      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let assistantTextMsg: JouleMessage | null = null

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const events = buf.split('\n\n')
        buf = events.pop() || ''
        for (const ev of events) {
          const line = ev.split('\n').find(l => l.startsWith('data: '))
          if (!line) continue
          const json = line.slice(6).trim()
          if (!json) continue
          let parsed: any
          try { parsed = JSON.parse(json) } catch { continue }
          if (parsed.type === 'delta') {
            if (!assistantTextMsg) {
              assistantTextMsg = { id: nextId(), role: 'assistant', kind: 'text', text: '' }
              messages.value.push(assistantTextMsg)
            }
            // Mutate text in place — Vue 3's reactivity proxy picks up nested
            // property writes, and we avoid O(n²) array reallocation per token.
            ;(assistantTextMsg as any).text += parsed.text || ''
          } else if (parsed.type === 'generated-query') {
            messages.value.push({ id: nextId(), role: 'assistant', kind: 'generated-query', spec: parsed.spec, sql: parsed.sql, explanation: parsed.explanation, preview: parsed.preview, errors: parsed.errors || [] })
            assistantTextMsg = null
          } else if (parsed.type === 'explanation') {
            messages.value.push({ id: nextId(), role: 'assistant', kind: 'explanation', summary: parsed.summary, columns: parsed.columns, rows: parsed.rows })
            assistantTextMsg = null
          } else if (parsed.type === 'error') {
            messages.value.push({ id: nextId(), role: 'assistant', kind: 'error', text: parsed.message || 'unknown error' })
          }
          // 'done' is a no-op; the loop ends when reader closes.
        }
      }
    } catch (e: any) {
      if (e.name !== 'AbortError') {
        error.value = e.message
        messages.value.push({ id: nextId(), role: 'assistant', kind: 'error', text: e.message })
      }
    } finally {
      streaming.value = false
      abort = null
    }
  }

  function cancel() { abort?.abort() }
  function clear() { messages.value = []; error.value = null }

  return { messages, streaming, error, send, cancel, clear }
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
cd app/analytics-explorer && npx vitest run src/composables/__tests__/useJouleChat.test.ts
```

Expected: 3 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/composables/useJouleChat.ts app/analytics-explorer/src/composables/__tests__/useJouleChat.test.ts
git commit -m "feat(analytics): useJouleChat SSE composable"
```

---

## Task 6: `useJouleContext.ts` composable — page-context builder

**Files:**
- Create: `app/analytics-explorer/src/composables/useJouleContext.ts`
- Create: `app/analytics-explorer/src/composables/__tests__/useJouleContext.test.ts`

Pulls `currentSpec` from `useQuerySpec()`, `lastResult` (passed in from `SqlTab.vue`), and the current `tab` to produce the `pageContext` object passed to `useJouleChat.send()`. Applies PII redaction to `lastResult.rows` via `redactPii`. Cap-redact-summarize is a single concern; isolating it makes both `JoulePanel` and tests simple.

- [ ] **Step 1: Write failing test**

Create `app/analytics-explorer/src/composables/__tests__/useJouleContext.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

vi.mock('../useQuerySpec', () => {
  const spec = ref({
    version: 1,
    from: { entity: 'Users', alias: 'u' },
    select: [{ kind: 'column', id: 's1', ref: { alias: 'u', column: 'ID' } }],
    filterTree: null, joins: [], groupBy: [], orderBy: [], limit: 10,
  })
  return { useQuerySpec: () => ({ spec, mode: ref('builder') }) }
})

vi.mock('../../api/entities', () => ({
  getCachedEntityMetadata: async () => ([
    {
      name: 'Users', sqlName: 'COM_SAP_DEVELOPERS_IMS_USERS', label: 'Users',
      columns: [
        { name: 'ID', type: 'cds.UUID', pii: false },
        { name: 'email', type: 'cds.String', pii: true },
      ],
    },
  ]),
}))

import { useJouleContext } from '../useJouleContext'

describe('useJouleContext', () => {
  it('builds pageContext with currentSpec and redacted lastResult', async () => {
    const ctx = useJouleContext()
    ctx.setLastResult({ entityName: 'Users', columns: ['ID', 'email'], rows: [['u1', 'a@b.com']], rowCount: 1, truncated: false })
    ctx.setTab('sql')
    const pc = await ctx.build()
    expect(pc.kind).toBe('admin')
    expect(pc.tool).toBe('analytics-builder')
    expect(pc.tab).toBe('sql')
    expect(pc.currentSpec.from.entity).toBe('Users')
    expect(pc.lastResult.rows[0]).toEqual(['u1', '[REDACTED]'])
    expect(pc.lastResult.redactedColumns).toEqual(['email'])
  })

  it('omits lastResult when none has been recorded', async () => {
    const ctx = useJouleContext()
    ctx.setTab('sql')
    const pc = await ctx.build()
    expect(pc.lastResult).toBeUndefined()
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
cd app/analytics-explorer && npx vitest run src/composables/__tests__/useJouleContext.test.ts
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement**

Create `app/analytics-explorer/src/composables/useJouleContext.ts`:

```typescript
import { ref, type Ref } from 'vue'
import { useQuerySpec } from './useQuerySpec'
import { getCachedEntityMetadata } from '../api/entities'
import { redactPii } from '../lib/redactPii'

export interface LastResultInput {
  entityName: string
  columns: string[]
  rows: any[][]
  rowCount: number
  truncated: boolean
}

let _singleton: ReturnType<typeof create> | null = null

function create() {
  const tab = ref<'sql' | 'history' | 'saved'>('sql')
  const lastResult: Ref<LastResultInput | null> = ref(null)

  function setTab(t: 'sql' | 'history' | 'saved') { tab.value = t }
  function setLastResult(r: LastResultInput | null) { lastResult.value = r }

  async function build() {
    const { spec } = useQuerySpec()
    const pc: any = {
      kind: 'admin', tool: 'analytics-builder',
      tab: tab.value,
      currentSpec: spec.value,
    }
    if (lastResult.value) {
      const entities = await getCachedEntityMetadata()
      const redacted = redactPii({
        entityName: lastResult.value.entityName,
        columns: lastResult.value.columns,
        rows: lastResult.value.rows,
      }, entities)
      pc.lastResult = {
        columns: redacted.columns,
        rows: redacted.rows,
        rowCount: lastResult.value.rowCount,
        truncated: lastResult.value.truncated || redacted.truncated,
        redactedColumns: redacted.redactedColumns,
      }
    }
    return pc
  }

  return { setTab, setLastResult, build, lastResult, tab }
}

export function useJouleContext() {
  if (!_singleton) _singleton = create()
  return _singleton
}

export function _resetForTest() { _singleton = null }
```

- [ ] **Step 4: Run to verify pass**

```bash
cd app/analytics-explorer && npx vitest run src/composables/__tests__/useJouleContext.test.ts
```

Expected: 2 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/composables/useJouleContext.ts app/analytics-explorer/src/composables/__tests__/useJouleContext.test.ts
git commit -m "feat(analytics): useJouleContext composable"
```

---

## Task 7: `JouleMessage.vue` — message bubble component

**Files:**
- Create: `app/analytics-explorer/src/components/joule/JouleMessage.vue`
- Create: `app/analytics-explorer/src/components/joule/__tests__/JouleMessage.test.ts`

Renders a single message bubble; switches on `message.kind`:

- `text` (user or assistant) → plain text bubble
- `generated-query` → SQL preview block + "View in builder" button (emits `view-in-builder` with the spec) + privacy badge ("PII redacted")
- `explanation` → summary + optional small column header strip
- `error` → red bubble with the error text

- [ ] **Step 1: Write failing test**

Create `app/analytics-explorer/src/components/joule/__tests__/JouleMessage.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import JouleMessage from '../JouleMessage.vue'

describe('JouleMessage', () => {
  it('renders user text', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'user', text: 'hello' } },
    })
    expect(w.text()).toContain('hello')
    expect(w.classes()).toContain('joule-msg-user')
  })

  it('renders assistant text', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'assistant', kind: 'text', text: 'hi back' } },
    })
    expect(w.text()).toContain('hi back')
  })

  it('renders generated-query with SQL + View in builder button', () => {
    const w = mount(JouleMessage, {
      props: {
        message: {
          id: 'm1', role: 'assistant', kind: 'generated-query',
          spec: { version: 1, from: { entity: 'Users', alias: 'u' } },
          sql: 'SELECT * FROM USERS',
          explanation: 'all users',
          preview: { columns: ['id'], rows: [['u1']], truncated: false },
          errors: [],
        },
      },
    })
    expect(w.text()).toContain('SELECT * FROM USERS')
    expect(w.find('[data-test="view-in-builder"]').exists()).toBe(true)
  })

  it('emits view-in-builder when button clicked', async () => {
    const w = mount(JouleMessage, {
      props: {
        message: {
          id: 'm1', role: 'assistant', kind: 'generated-query',
          spec: { version: 1, from: { entity: 'Users', alias: 'u' } },
          sql: 'SELECT 1', explanation: '', preview: { columns: [], rows: [], truncated: false }, errors: [],
        },
      },
    })
    await w.find('[data-test="view-in-builder"]').trigger('click')
    expect(w.emitted('view-in-builder')).toBeTruthy()
    expect((w.emitted('view-in-builder')![0][0] as any).from.entity).toBe('Users')
  })

  it('renders explanation summary', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'assistant', kind: 'explanation', summary: 'There are 7 rows.' } },
    })
    expect(w.text()).toContain('There are 7 rows.')
  })

  it('renders error with error class', () => {
    const w = mount(JouleMessage, {
      props: { message: { id: 'm1', role: 'assistant', kind: 'error', text: 'boom' } },
    })
    expect(w.text()).toContain('boom')
    expect(w.classes()).toContain('joule-msg-error')
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
cd app/analytics-explorer && npx vitest run src/components/joule/__tests__/JouleMessage.test.ts
```

Expected: FAIL — file missing.

- [ ] **Step 3: Implement**

Create `app/analytics-explorer/src/components/joule/JouleMessage.vue`:

```vue
<script setup lang="ts">
import '@ui5/webcomponents/dist/Button.js'
import type { JouleMessage } from '../../composables/useJouleChat'

const props = defineProps<{ message: JouleMessage }>()
const emit = defineEmits<{ (e: 'view-in-builder', spec: any): void }>()

function onViewInBuilder() {
  if (props.message.kind === 'generated-query') emit('view-in-builder', (props.message as any).spec)
}
</script>

<template>
  <div
    class="joule-msg"
    :class="{
      'joule-msg-user': message.role === 'user',
      'joule-msg-assistant': message.role === 'assistant',
      'joule-msg-error': message.kind === 'error',
    }"
  >
    <template v-if="message.role === 'user'">
      <div class="bubble">{{ (message as any).text }}</div>
    </template>

    <template v-else-if="message.kind === 'text'">
      <div class="bubble">{{ (message as any).text }}</div>
    </template>

    <template v-else-if="message.kind === 'generated-query'">
      <div class="bubble">
        <p v-if="(message as any).explanation" class="explanation">{{ (message as any).explanation }}</p>
        <pre class="sql"><code>{{ (message as any).sql }}</code></pre>
        <div class="actions">
          <ui5-button design="Emphasized" data-test="view-in-builder" @click="onViewInBuilder">View in builder</ui5-button>
          <span class="badge" title="PII columns redacted before sending to the AI">🔒 PII redacted</span>
        </div>
        <ul v-if="(message as any).errors?.length" class="errors">
          <li v-for="(e, i) in (message as any).errors" :key="i">{{ e.message }}</li>
        </ul>
      </div>
    </template>

    <template v-else-if="message.kind === 'explanation'">
      <div class="bubble">{{ (message as any).summary }}</div>
    </template>

    <template v-else-if="message.kind === 'error'">
      <div class="bubble error">{{ (message as any).text }}</div>
    </template>
  </div>
</template>

<style scoped>
.joule-msg { display: flex; margin-bottom: 0.5rem; }
.joule-msg-user { justify-content: flex-end; }
.joule-msg-assistant { justify-content: flex-start; }
.bubble {
  max-width: 90%;
  padding: 0.5rem 0.75rem;
  border-radius: 8px;
  background: var(--sapList_Background);
  border: 1px solid var(--sapField_BorderColor);
  font-size: 0.85rem;
  white-space: pre-wrap;
}
.joule-msg-user .bubble { background: var(--sapButton_Emphasized_Background); color: var(--sapButton_Emphasized_TextColor); }
.bubble.error { background: var(--sapErrorBackground); border-color: var(--sapErrorBorderColor); color: var(--sapErrorTextColor); }
.explanation { margin: 0 0 0.4rem; font-style: italic; color: var(--sapNeutralTextColor); }
.sql { background: var(--sapShell_Background); padding: 0.5rem; border-radius: 4px; overflow-x: auto; font-size: 0.75rem; margin: 0; }
.actions { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.4rem; }
.badge { font-size: 0.7rem; color: var(--sapNeutralTextColor); }
.errors { color: var(--sapErrorColor); margin: 0.4rem 0 0; padding-left: 1rem; font-size: 0.78rem; }
</style>
```

- [ ] **Step 4: Run to verify pass**

```bash
cd app/analytics-explorer && npx vitest run src/components/joule/__tests__/JouleMessage.test.ts
```

Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/components/joule/
git commit -m "feat(analytics): JouleMessage bubble component"
```

---

## Task 8: `JoulePanel.vue` — right-rail panel

**Files:**
- Create: `app/analytics-explorer/src/components/joule/JoulePanel.vue`
- Create: `app/analytics-explorer/src/components/joule/__tests__/JoulePanel.test.ts`

Persistent right-rail panel (~340px wide; pushes layout when open). Composes:

- Header: "Joule" title + close button (emits `close`)
- Scrolling `<JouleMessage>` list (auto-scrolls to bottom on new message)
- Input row: textarea + Send button + "Stop" button when `streaming`
- Empty-state hint: "Ask me to summarize your last query, or to build one. Example: 'group task records by event, count completions'."

Wires `useJouleChat()` + `useJouleContext()` and emits `view-in-builder` upward (parent decides what to do).

- [ ] **Step 1: Write failing test**

Create `app/analytics-explorer/src/components/joule/__tests__/JoulePanel.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'

const sendMock = vi.fn(async () => {})
const messagesRef = ref<any[]>([])
const streamingRef = ref(false)

vi.mock('../../composables/useJouleChat', () => ({
  useJouleChat: () => ({
    messages: messagesRef,
    streaming: streamingRef,
    error: ref(null),
    send: sendMock,
    cancel: vi.fn(),
    clear: vi.fn(),
  }),
}))

vi.mock('../../composables/useJouleContext', () => ({
  useJouleContext: () => ({
    setTab: vi.fn(),
    setLastResult: vi.fn(),
    build: vi.fn(async () => ({ kind: 'admin', tool: 'analytics-builder' })),
    lastResult: ref(null),
    tab: ref('sql'),
  }),
}))

import JoulePanel from '../JoulePanel.vue'

beforeEach(() => {
  sendMock.mockClear()
  messagesRef.value = []
  streamingRef.value = false
})

describe('JoulePanel', () => {
  it('renders empty-state hint when no messages', () => {
    const w = mount(JoulePanel)
    expect(w.text()).toMatch(/ask me/i)
  })

  it('emits close when close button clicked', async () => {
    const w = mount(JoulePanel)
    await w.find('[data-test="joule-close"]').trigger('click')
    expect(w.emitted('close')).toBeTruthy()
  })

  it('calls send with built pageContext when Send clicked', async () => {
    const w = mount(JoulePanel)
    await w.find('textarea').setValue('summarize this')
    await w.find('[data-test="joule-send"]').trigger('click')
    await flushPromises()
    expect(sendMock).toHaveBeenCalledWith('summarize this', expect.objectContaining({ kind: 'admin', tool: 'analytics-builder' }))
  })

  it('forwards view-in-builder from JouleMessage', async () => {
    messagesRef.value = [{
      id: 'm1', role: 'assistant', kind: 'generated-query',
      spec: { version: 1, from: { entity: 'X', alias: 'x' } },
      sql: 'SELECT 1', explanation: '', preview: { columns: [], rows: [], truncated: false }, errors: [],
    }]
    const w = mount(JoulePanel)
    await w.find('[data-test="view-in-builder"]').trigger('click')
    expect(w.emitted('view-in-builder')).toBeTruthy()
  })

  it('shows Stop button while streaming', async () => {
    streamingRef.value = true
    const w = mount(JoulePanel)
    expect(w.find('[data-test="joule-stop"]').exists()).toBe(true)
  })
})
```

- [ ] **Step 2: Run failing test**

```bash
cd app/analytics-explorer && npx vitest run src/components/joule/__tests__/JoulePanel.test.ts
```

Expected: FAIL — file missing.

- [ ] **Step 3: Implement**

Create `app/analytics-explorer/src/components/joule/JoulePanel.vue`:

```vue
<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import JouleMessage from './JouleMessage.vue'
import { useJouleChat } from '../../composables/useJouleChat'
import { useJouleContext } from '../../composables/useJouleContext'

const emit = defineEmits<{ (e: 'close'): void; (e: 'view-in-builder', spec: any): void }>()

const chat = useJouleChat()
const ctx = useJouleContext()
const draft = ref('')
const listRef = ref<HTMLDivElement | null>(null)

async function onSend() {
  const text = draft.value.trim()
  if (!text || chat.streaming.value) return
  draft.value = ''
  const pc = await ctx.build()
  await chat.send(text, pc)
}

function onStop() { chat.cancel() }
function onClose() { emit('close') }
function onViewInBuilder(spec: any) { emit('view-in-builder', spec) }
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend() }
}

watch(chat.messages, async () => {
  await nextTick()
  if (listRef.value) listRef.value.scrollTop = listRef.value.scrollHeight
}, { deep: true })
</script>

<template>
  <aside class="joule-panel" aria-label="Joule chat">
    <header class="joule-header">
      <strong>Joule</strong>
      <ui5-button design="Transparent" icon="decline" data-test="joule-close" @click="onClose" />
    </header>

    <div ref="listRef" class="joule-list">
      <p v-if="chat.messages.value.length === 0" class="hint">
        Ask me to summarize your last query, or to build one.<br>
        Example: <em>“group task records by event, count completions”</em>.
      </p>
      <JouleMessage
        v-for="m in chat.messages.value"
        :key="m.id"
        :message="m"
        @view-in-builder="onViewInBuilder"
      />
    </div>

    <div class="joule-input">
      <textarea
        v-model="draft"
        rows="2"
        placeholder="Ask Joule…"
        :disabled="chat.streaming.value"
        @keydown="onKeydown"
      />
      <ui5-button
        v-if="!chat.streaming.value"
        design="Emphasized"
        data-test="joule-send"
        :disabled="!draft.trim()"
        @click="onSend"
      >Send</ui5-button>
      <ui5-button
        v-else
        design="Negative"
        data-test="joule-stop"
        @click="onStop"
      >Stop</ui5-button>
    </div>
  </aside>
</template>

<style scoped>
.joule-panel {
  display: flex; flex-direction: column;
  width: 340px; flex-shrink: 0;
  border-left: 1px solid var(--sapField_BorderColor);
  background: var(--sapBaseColor, white);
  height: 100%;
}
.joule-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.joule-list {
  flex: 1; overflow-y: auto; padding: 0.5rem 0.75rem;
}
.hint { font-size: 0.8rem; color: var(--sapNeutralTextColor); }
.joule-input {
  display: flex; gap: 0.4rem; padding: 0.5rem;
  border-top: 1px solid var(--sapField_BorderColor);
}
.joule-input textarea {
  flex: 1; resize: none; font: inherit; padding: 0.4rem;
  border: 1px solid var(--sapField_BorderColor); border-radius: 4px;
}
</style>
```

- [ ] **Step 4: Run to verify pass**

```bash
cd app/analytics-explorer && npx vitest run src/components/joule/__tests__/JoulePanel.test.ts
```

Expected: 5 PASS.

- [ ] **Step 5: Commit**

```bash
git add app/analytics-explorer/src/components/joule/JoulePanel.vue app/analytics-explorer/src/components/joule/__tests__/JoulePanel.test.ts
git commit -m "feat(analytics): JoulePanel right-rail component"
```

---

## Task 9: Wire JoulePanel into App.vue

**Files:**
- Modify: `app/analytics-explorer/src/App.vue` (add toggle state + render JoulePanel)
- Modify: `app/analytics-explorer/src/__tests__/App.test.ts` (extend existing test)

The shellbar Joule button currently has an empty `onJouleClick()` stub at App.vue:97/110-112. Replace with a `panelOpen` ref + a slide-in/out of `<JoulePanel>` to the right of the existing layout. Persist the open state to `localStorage` key `analytics.joule.open`.

- [ ] **Step 1: Extend App.test.ts**

Add to `app/analytics-explorer/src/__tests__/App.test.ts`:

```typescript
import { mount } from '@vue/test-utils'
import App from '../App.vue'

it('toggles JoulePanel on shellbar click', async () => {
  const w = mount(App)
  expect(w.findComponent({ name: 'JoulePanel' }).exists()).toBe(false)
  await w.find('[data-test="shellbar-joule"]').trigger('click')
  expect(w.findComponent({ name: 'JoulePanel' }).exists()).toBe(true)
})
```

- [ ] **Step 2: Implement in App.vue**

In the `<script setup>` section, after existing imports add:

```typescript
import { ref, watch } from 'vue'
import JoulePanel from './components/joule/JoulePanel.vue'
import { useQuerySpec } from './composables/useQuerySpec'

const STORAGE_KEY = 'analytics.joule.open'
const panelOpen = ref(localStorage.getItem(STORAGE_KEY) === '1')
const querySpec = useQuerySpec()

function onJouleClick() { panelOpen.value = !panelOpen.value }
function onJouleClose() { panelOpen.value = false }
function onViewInBuilder(spec: any) {
  // SqlTab is already mounted; setSpec on the singleton store flows through.
  querySpec.setSpec(spec)
}
watch(panelOpen, v => localStorage.setItem(STORAGE_KEY, v ? '1' : '0'))
```

In the `<template>`:

1. Find the existing shellbar Joule item (around line 109-112) and add `data-test="shellbar-joule"` to it (and confirm `@click="onJouleClick"` is wired — the existing stub already calls `onJouleClick`).
2. Find the main flex row that wraps `<router-view>` or whichever component holds the tabs. The existing layout is a single column today; wrap it in a horizontal flex if not already, and add the panel as the rightmost sibling:

```html
<!-- existing main content (router-view / TabsHost / etc.) -->
<div class="main-row">
  <div class="content-col">
    <!-- existing content stays here -->
  </div>
  <JoulePanel
    v-if="panelOpen"
    @close="onJouleClose"
    @view-in-builder="onViewInBuilder"
  />
</div>
```

Add scoped CSS:

```css
.main-row { display: flex; flex: 1; min-height: 0; }
.content-col { flex: 1; min-width: 0; display: flex; flex-direction: column; }
```

If the existing layout already wraps content in a flex row, only add the `<JoulePanel>` sibling and skip the wrapper.

- [ ] **Step 3: Run unit + component tests**

```bash
cd app/analytics-explorer && npx vitest run src/__tests__/App.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/analytics-explorer/src/App.vue app/analytics-explorer/src/__tests__/App.test.ts
git commit -m "feat(analytics): wire JoulePanel into App.vue"
```

---

## Task 10: SqlTab integration — feed JoulePanel + handle "View in builder"

**Files:**
- Modify: `app/analytics-explorer/src/components/SqlTab.vue` (push runResults + entityName to useJouleContext)

Whenever `runFromChips()` or `onResults()` updates `lastResults.value`, also call `useJouleContext().setLastResult({ entityName: spec.from.entity, columns, rows: rows.slice(0, 50), rowCount, truncated })`. The "View in builder" emission from `JoulePanel` is already handled in App.vue via `setSpec()`; no SqlTab change needed for that path.

- [ ] **Step 1: Test the wiring (snapshot via existing SqlTab test)**

If `SqlTab.test.ts` exists, extend with a test that mocks `useJouleContext` and asserts `setLastResult` is called after a chip-run. If no test file exists, skip the unit test — the integration happens through composable side-effects already covered elsewhere.

- [ ] **Step 2: Implement**

In `SqlTab.vue`:

```typescript
import { useJouleContext } from '../composables/useJouleContext'
const jouleCtx = useJouleContext()

function feedJouleContext(r: SqlResult) {
  if (!spec.value || !r) return
  jouleCtx.setLastResult({
    entityName: spec.value.from.entity,
    columns: r.columns,
    rows: r.rows.slice(0, 50),
    rowCount: r.metadata?.rowCount ?? r.rows.length,
    truncated: r.metadata?.truncated ?? false,
  })
}
```

Call `feedJouleContext(r)` after both `lastResults.value = r` (in `runFromChips`) and `lastResults.value = { ... }` (in `onResults`).

- [ ] **Step 3: Run all analytics-explorer tests**

```bash
cd app/analytics-explorer && npm test
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add app/analytics-explorer/src/components/SqlTab.vue
git commit -m "feat(analytics): feed last-result into Joule context"
```

---

## Task 11: Final regression sweep + lint + build

- [ ] **Step 1: Full unit + hybrid test sweep**

```bash
npm test -- --project=unit
```

Expected: all passing.

- [ ] **Step 2: Frontend build**

```bash
npm run build:analytics-explorer
```

Expected: vite build completes; output copies into approuter static.

- [ ] **Step 3: Lint**

```bash
npm run lint
```

Expected: no new violations.

- [ ] **Step 4: Smoke test against local hybrid**

```bash
npm run dev:hybrid
# in browser: open /analytics-ui/, click Joule shellbar button, type "summarize my last query"
```

Verify: panel opens, message stream lands, redaction badge shown for any PII columns, "View in builder" round-trips spec into chip bar.

---

## Task 12: srv-qa cp-list verification

This bit us twice in the past four days (see [[feedback-srv-qa-cp-list-recurring]] and [[feedback-check-srv-qa-when-changing-srv]]). Phase 5 may add new transitive imports from `srv/lib/chat-orchestrator.js` — walk **every** new import path and verify each appears in the QA cp list.

- [ ] **Step 1: Walk transitive imports from chat-orchestrator.js**

```bash
grep -E "^import .* from '\\./" srv/lib/chat-orchestrator.js
grep -E "^import .* from '\\./" srv/lib/analytics-llm-context.js
grep -E "^import .* from '\\./" srv/lib/chat-context.js
```

Expected new file paths to verify in srv-qa cp list:
- `srv/lib/analytics-llm-context.js` (Phase 5 NEW)
- `srv/lib/query-spec-validator.mjs` (Phase 1 — existing)
- `srv/lib/spec-to-sql.mjs` (Phase 1 — existing)

- [ ] **Step 2: Inspect `.deploy/mta.yaml` srv-qa cp list**

```bash
grep -A 80 "name: tutorials-srv-qa" .deploy/mta.yaml | grep "cp -r\|cp "
```

- [ ] **Step 3: Add missing files**

For each transitive import that is not already in the cp list, add a `cp` line. At minimum, `srv/lib/analytics-llm-context.js`. If `query-spec-validator.mjs` or `spec-to-sql.mjs` are missing (they were added in Phase 1; verify), add those too.

- [ ] **Step 4: Note QA-only verification in PR**

Boot of QA-only verifiable post-deploy. Note in PR description: "QA boot must succeed; transitive imports walked from chat-orchestrator.js."

- [ ] **Step 5: Commit if changes**

```bash
git add .deploy/mta.yaml
git commit -m "chore(deploy): include analytics-llm-context.js in srv-qa cp list"
```

---

## Task 13: Open PR

- [ ] **Step 1: Verify branch state**

```bash
git branch --show-current
git status
```

Expected: `feat/analytics-builder-phase5-joule`, clean.

- [ ] **Step 2: Push**

```bash
git push -u origin feat/analytics-builder-phase5-joule
```

- [ ] **Step 3: Open PR**

```bash
gh pr create \
  --base main \
  --title "feat(analytics): Phase 5 — Joule integration (right-rail panel + 3 tools)" \
  --body "$(cat <<'EOF'
## Summary

Final phase of the Analytics SQL Builder. Adds a persistent right-rail Joule panel
to the analytics explorer plus three chat-orchestrator tools:

- **`generateAnalyticsQuery`** (NEW) — LLM emits a QuerySpec; server validates
  via `validateQuerySpec`, re-derives SQL via `specToSql`, runs with a 10-row
  preview cap, returns `{ spec, sql, preview, errors }`. LLM SQL is **never**
  executed — the server always re-derives.
- **`explainAnalyticsResult`** (NEW) — LLM produces a 1-3 sentence summary of a
  result sample (50-row cap, columns + rows already PII-redacted client-side).
- **`analyticsQuery`** (EXTENDED) — `chat-context.js` `adminLayer` now surfaces
  the user's `currentSpec` + `lastResult` summary when
  `pageContext.kind === 'admin' && pageContext.tool === 'analytics-builder'`.

## Privacy

`redactPii.ts` strips values in any column where `@analytics.pii: true` before
the result sample is sent to the LLM. JouleMessage shows a "🔒 PII redacted"
badge on every generated-query bubble.

## QA / Deploy notes

- New file `srv/lib/analytics-llm-context.js` added to `.deploy/mta.yaml`
  srv-qa cp list (Task 12).
- After deploy: open `/analytics-ui/`, click the Joule shellbar button, run a
  query, then ask "summarize this".

Closes the Phase 5 spec (section 5 of the brainstorming spec).
EOF
)"
```

- [ ] **Step 4: Save memory entry**

After PR opens, save a memory entry summarizing the change and update `MEMORY.md`.

---
