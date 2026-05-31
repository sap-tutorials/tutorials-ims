# Analytics SQL Builder — Phase 1 (Backend Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land all backend changes the SQL-tab redesign needs — isomorphic QuerySpec types/validator/spec-to-sql, two new entities (history + saved queries), `@analytics.filter`/`@analytics.pii` annotations, enriched `listExposedEntities`, `runSelectQuery` envelope, `sampleDistinct`, and `exportSelectQuery` — without touching the frontend. Old client keeps working; new server provides the surface Phases 2–5 will consume.

**Architecture:** Pure-function modules in `srv/lib/` (CJS) re-exported via Vite alias for browser consumption in later phases. Two new entities share a `AnalyticsQueryShape` aspect. All new endpoints behind the existing `@requires: 'Admin'` gate; `runSelectQuery` envelope extended additively. CSV export streams via HANA cursor (constant memory). Filter/PII annotations are schema-level CDS, not runtime config.

**Tech Stack:** CAP Node.js (`@sap/cds`), HANA Cloud, node-sql-parser, Vitest.

**Spec:** [docs/superpowers/specs/2026-05-31-analytics-sql-builder-design.md](../specs/2026-05-31-analytics-sql-builder-design.md)

**Branch:** `feat/analytics-builder-phase1-backend` (create from `spec/analytics-sql-builder` so the spec ships alongside the first implementation PR).

**Conventions used in this plan:**

- All paths repo-relative from `d:\projects\tutorials-poc`.
- All commands assume Bash (Git Bash on Windows). Forward slashes.
- Project is ESM (`"type": "module"`); the new isomorphic modules are CJS (`.cjs`) so browser bundlers and Node both consume them, matching the existing `srv/lib/analytics-sql-validator.cjs` pattern.
- Vitest 4.1.5 — omit `--reporter=basic`. Filter form `npm test -- -t "<title>"` is preferred for single-test runs.
- TDD discipline: every code task starts with a failing test and a run that confirms the failure mode.
- Each task ends with one focused commit. Conventional commit prefix (`feat`, `feat(srv)`, `test`, `chore`, etc.).
- The hybrid HANA tests (`npm run test:hybrid`) require `cf login` to DEV space and `ALLOW_HYBRID_WRITES=true`. Smoke tests run in CI post-deploy — not part of this plan's local loop.
- **srv-qa cp list:** the QA srv hand-curates its imports in `.deploy/mta.yaml`. New `srv/lib/*` files MUST be inspected for QA impact before final commit (lesson [feedback_check_srv_qa_when_changing_srv]). Phase 1 adds `srv/lib/analytics-export-stream.js`, `srv/lib/analytics-distinct-sample.js`, `srv/lib/spec-to-sql.cjs`, `srv/lib/query-spec-validator.cjs`, `srv/lib/analytics-history-writer.js`. Of these, only those imported transitively by `srv-qa` need adding. AnalyticsService is **not** mounted in srv-qa today (admin scope only; QA srv is author-preview), so the cp list should remain unchanged — but **verify** in Task 14.
- **CRLF caution:** previous worktree work has flipped LF→CRLF on Windows ([feedback_crlf_regression_on_windows]). After multi-section edits, run `file <path>` and normalize via Node if mixed.

---

## Phase 1 task list

1. Create branch + add Phase 1 conventions to README of `srv/lib/`
2. Add `AnalyticsQueryShape` aspect + `AnalyticsQueryHistory` + `AnalyticsSavedQuery` entities to `db/schema-ext.cds`
3. Verify model compiles + drift check passes
4. Add `@analytics.filter` and `@analytics.pii` annotations to ~15 columns
5. Bump `analytics-sql-validator.cjs` char limit + add scalar-function whitelist (with TDD)
6. Create `srv/lib/query-spec-validator.cjs` (pure function: validates QuerySpec) — TDD
7. Create `srv/lib/spec-to-sql.cjs` (pure function: QuerySpec → HANA SQL) — TDD
8. Enrich `listExposedEntities`: add `hanaType`, `filterMode`, `filterSample`, `pii`, `associations` — TDD
9. Add `AnalyticsService` projections + actions to `srv/analytics-service.cds` (`QueryHistory`, `SavedQueries`, `sampleDistinct`, `exportSelectQuery`)
10. Implement `sampleDistinct` handler in `srv/lib/analytics-distinct-sample.js` — TDD
11. Wire `sampleDistinct` into `srv/analytics-service.js`
12. Extend `runSelectQuery` envelope (privacy + historyId + source) and write history row — TDD
13. Implement `exportSelectQuery` streaming CSV in `srv/lib/analytics-export-stream.js` — TDD
14. Wire `exportSelectQuery` into `srv/analytics-service.js` (express bridge for streaming)
15. Implement `SavedQueries` CRUD + actions (rename, setVisibility, duplicate, recordRun) with `@restrict` — TDD
16. Extend cleanup cron job with history-row pruning (keep last 200 per user)
17. Hybrid HANA test: end-to-end run + history write + saved-query CRUD + sampleDistinct + CSV export
18. srv-qa cp-list verification + final commit
19. Open PR

---

## Task 1: Create Phase 1 branch and brief README

**Files:**
- Create branch from `spec/analytics-sql-builder`
- Create: `srv/lib/README.md` — short module-purpose index for `analytics-*` and `query-spec-*` files (helps future agents navigate the new module proliferation)

- [ ] **Step 1: Create the Phase 1 branch**

```bash
git checkout spec/analytics-sql-builder
git pull --ff-only
git checkout -b feat/analytics-builder-phase1-backend
git branch --show-current
```

Expected output: `feat/analytics-builder-phase1-backend`

- [ ] **Step 2: Create `srv/lib/README.md`**

```markdown
# srv/lib

Shared modules consumed by the CAP services in `srv/`.

## Analytics Builder modules (Phase 1, 2026-05-31)

- `analytics-sql-validator.cjs` — strict allowlist + SELECT-only validator on raw SQL. Used by `runSelectQuery`, `sampleDistinct`, and `exportSelectQuery`. Re-emits via Postgresql dialect for HANA compat.
- `query-spec-validator.cjs` — validates a QuerySpec (referential integrity, op/value compatibility, OR-group depth ≤ 4). Pure function. **Isomorphic** — re-exported via Vite alias for browser consumption in Phase 2.
- `spec-to-sql.cjs` — deterministic QuerySpec → HANA-flavoured SQL. Pure function. **Isomorphic** alongside `query-spec-validator.cjs`.
- `analytics-distinct-sample.js` — annotation-gated DISTINCT sampling for filter-chip dropdowns.
- `analytics-export-stream.js` — HANA-cursor-based CSV streaming (constant memory, 100k-row / 60s caps).
- `analytics-history-writer.js` — small helper to insert into `AnalyticsQueryHistory` from `runSelectQuery`.

## Other modules

(Existing — not re-documented here.)
```

- [ ] **Step 3: Commit**

```bash
git add srv/lib/README.md
git commit -m "chore(srv/lib): add module index README ahead of Phase 1"
```

---

## Task 2: Add history + saved-query entities to schema

**Files:**
- Modify: `db/schema-ext.cds` (append new aspect + entities at end of file)

- [ ] **Step 1: Append the new aspect and entities**

Open `db/schema-ext.cds` and add at the end:

```cds
// ─── Analytics Builder (Phase 1, 2026-05-31) ──────────────────────────────
// Two entities sharing one shape via aspect. AnalyticsQueryHistory is auto-
// written on every runSelectQuery; AnalyticsSavedQuery is created via the
// "Save as…" admin action. Both are admin-only (AnalyticsService gate).

aspect AnalyticsQueryShape {
  spec        : LargeString;             // JSON-stringified QuerySpec (v1 schema)
  sql         : LargeString;             // Rendered SQL at run time
  rowCount    : Integer;
  durationMs  : Integer;
  truncated   : Boolean default false;
  privacyMode : String(16);              // 'raw' | 'k-anon'
}

@PersonalData : { EntitySemantics: 'Other' }
extend ims with entity AnalyticsQueryHistory : managed, AnalyticsQueryShape {
  key ID      : UUID;
  source      : String(16);              // 'builder' | 'editor' | 'joule' | 'replay'
}

@PersonalData    : { EntitySemantics: 'Other' }
@cds.changelog   : true
extend ims with entity AnalyticsSavedQuery : managed, AnalyticsQueryShape {
  key ID      : UUID;
  name        : String(120) not null;
  description : String(500);
  visibility  : String(16) default 'private';   // 'private' | 'shared-admins'
  lastRunAt   : Timestamp;
}
```

Note the `extend ims with entity` pattern — `ims` is the shorthand alias from the existing `using { com.sap.developers.ims as ims }` line at the top of the file. The CUID `key ID : UUID` pattern matches existing entities in `db/schema.cds`.

- [ ] **Step 2: Verify the model compiles**

Run:

```bash
npx cds compile db/schema.cds --to sql 2>/dev/null | grep -E "ANALYTICSQUERYHISTORY|ANALYTICSSAVEDQUERY" | head -10
```

Expected: Two `CREATE TABLE` lines for `COM_SAP_DEVELOPERS_IMS_ANALYTICSQUERYHISTORY` and `COM_SAP_DEVELOPERS_IMS_ANALYTICSSAVEDQUERY`.

If compile fails, the most likely culprits are: (a) `extend ims` requires the alias to be in scope — if you accidentally placed the block above the `using` line, move it; (b) `@cds.changelog` requires the `@cap-js/change-tracking` plugin which is already a project dep — if it errors, run `npm ls @cap-js/change-tracking` to confirm.

- [ ] **Step 3: Commit**

```bash
git add db/schema-ext.cds
git commit -m "feat(db): add AnalyticsQueryHistory + AnalyticsSavedQuery entities"
```

---

## Task 3: Run drift check + existing tests for regression

**Files:** none modified — verification only.

- [ ] **Step 1: Run schema drift check**

```bash
npm test -- --project=unit -t "schema drift"
```

Expected: PASS. The existing drift check (per [project_qa_shared_aspects]) compares prod and QA HDI shapes; new entities should land in prod only and not affect QA (Phase 1 is admin-scope, not QA).

If the drift test fails because it expected the new tables in QA too: open `srv/__tests__/schema-drift.test.js` and add the two new entities to the prod-only allow-list (search for `JobLocks` — that's the existing prod-only carve-out and the same pattern applies).

- [ ] **Step 2: Run all existing unit tests**

```bash
npm test -- --project=unit 2>&1 | tail -20
```

Expected: All ~620 tests pass (project baseline per [project_main_test_failures]). Any failure is a regression — investigate before continuing.

- [ ] **Step 3: Commit any drift-allowlist changes**

If you had to amend the drift test:

```bash
git add srv/__tests__/schema-drift.test.js
git commit -m "test(drift): allow Phase 1 admin entities to be prod-only"
```

If no changes were needed, skip the commit.

---

## Task 4: Add `@analytics.filter` and `@analytics.pii` annotations

**Files:**
- Modify: `db/schema-ext.cds` (add annotation block)

- [ ] **Step 1: Add filter and PII annotations**

Append the following block to `db/schema-ext.cds` (after the existing `@analytics : { exposed: true }` block, before any `// ───` divider):

```cds
// ─── Analytics filter modes (Phase 1, 2026-05-31) ────────────────────────
// Schema-driven UI hints for the analytics builder filter chip popover.
// Default for unannotated columns: 'free' (text input, no DB sampling).

annotate ims.Tasks with {
  status     @analytics.filter: { mode: 'enum', sample: true };
  taskType   @analytics.filter: { mode: 'enum', sample: true };
  event_ID   @analytics.filter: { mode: 'enum', sample: true };
  createdAt  @analytics.filter: { mode: 'date' };
  modifiedAt @analytics.filter: { mode: 'date' };
};

annotate ims.TaskRecords with {
  status      @analytics.filter: { mode: 'enum', sample: true };
  completedAt @analytics.filter: { mode: 'date' };
};

annotate ims.Missions with {
  slug @analytics.filter: { mode: 'enum', sample: true };
};

annotate ims.Events with {
  slug     @analytics.filter: { mode: 'enum', sample: true };
  startsAt @analytics.filter: { mode: 'date' };
};

// PII flags: client-side redaction in Joule sampleRows before send to LLM.
annotate ims.Users with {
  email    @analytics.pii: true;
  fullName @analytics.pii: true;
};
```

Verify the column names exist on each entity before committing — `Tasks.event_ID` vs `Tasks.event` is a known footgun. Run:

```bash
grep -E "event_ID|event :" db/schema.cds | head -5
```

If the column is named differently (e.g. `event : Association to Events`), adjust the annotation to use the actual element name. The CDS compiler will catch typos in Step 2 anyway.

- [ ] **Step 2: Verify the annotations resolve**

```bash
npx cds compile db/schema.cds --to json 2>/dev/null | grep -E "@analytics.filter|@analytics.pii" | head -10
```

Expected: at least 10 lines showing the annotations attached to the right elements.

If the count is suspicious, run:

```bash
npx cds compile db/schema.cds 2>&1 | grep -i "warning\|error" | head -10
```

- [ ] **Step 3: Commit**

```bash
git add db/schema-ext.cds
git commit -m "feat(db): annotate filter modes + PII flags on analytics entities"
```

---

## Task 5: Bump validator char limit + scalar-function whitelist (TDD)

**Files:**
- Modify: `srv/lib/analytics-sql-validator.cjs`
- Modify: `srv/lib/__tests__/analytics-sql-validator.test.js`

- [ ] **Step 1: Write the failing tests**

Append to `srv/lib/__tests__/analytics-sql-validator.test.js`:

```javascript
describe('analytics-sql-validator — Phase 1 additions', () => {
  it('accepts SQL up to 16384 chars', () => {
    const padding = ' '.repeat(15000)
    const sql = `SELECT id /* ${padding} */ FROM TaskRecords`.replace('/*', '').replace('*/', '')
    // simpler — just generate a long valid SELECT with a big OR list
    const filler = Array.from({ length: 800 }, (_, i) => `id = '${i}'`).join(' OR ')
    const longSql = `SELECT id FROM TaskRecords WHERE ${filler}`
    expect(longSql.length).toBeGreaterThan(4096)
    expect(longSql.length).toBeLessThan(16384)
    const r = validateSelect(longSql, ALLOWED)
    expect(r.sql).toMatch(/SELECT/i)
  })

  it('rejects SQL above 16384 chars', () => {
    const filler = Array.from({ length: 1200 }, (_, i) => `id = '${i}'`).join(' OR ')
    const tooLong = `SELECT id FROM TaskRecords WHERE ${filler}`
    expect(tooLong.length).toBeGreaterThan(16384)
    expect(() => validateSelect(tooLong, ALLOWED)).toThrow(/exceeds maximum/)
  })

  it('accepts whitelisted scalar functions YEAR/MONTH/TO_DATE', () => {
    const r = validateSelect(
      'SELECT YEAR(createdAt) AS y, MONTH(createdAt) AS m FROM TaskRecords', ALLOWED)
    expect(r.sql.toUpperCase()).toContain('YEAR')
  })

  it('rejects suspicious functions (os_command, dbms_pipe)', () => {
    expect(() =>
      validateSelect("SELECT os_command('ls') FROM TaskRecords", ALLOWED)
    ).toThrow(/function|allowlist|not allowed|select/i)
  })
})
```

- [ ] **Step 2: Run the new tests to confirm they fail**

```bash
npm test -- --project=unit -t "Phase 1 additions"
```

Expected: 4 FAIL.
- The 16384-char test fails with `exceeds maximum 4096`.
- The 16384-reject test passes accidentally (fails with `4096`, which is also a substring) — that's fine; the next test is the real check.
- The YEAR/MONTH test parses fine today (function calls are passed through node-sql-parser); will continue to pass after our change.
- The os_command test currently **passes through** because the existing validator has no function-name allowlist — that's the gap we're closing.

If the YEAR/MONTH test fails today, leave it — Step 3 will make it pass cleanly.

- [ ] **Step 3: Update the validator constants and add the function-name check**

Edit `srv/lib/analytics-sql-validator.cjs`:

Change line 3:

```javascript
const MAX_LEN = 16384
```

Add a new constant under the `parser` declaration:

```javascript
// Whitelisted HANA scalar functions for expression-chip output.
// Identifiers compared upper-case against AST function names.
const ALLOWED_FUNCTIONS = new Set([
  'COUNT', 'SUM', 'AVG', 'MIN', 'MAX',           // aggregate (always allowed)
  'YEAR', 'MONTH', 'DAY', 'HOUR', 'MINUTE', 'SECOND',
  'TO_DATE', 'TO_VARCHAR', 'TO_CHAR', 'TO_NVARCHAR',
  'COALESCE', 'NULLIF', 'IFNULL',
  'UPPER', 'LOWER', 'TRIM', 'LENGTH', 'SUBSTRING',
  'CAST', 'CASE',
  'CURRENT_DATE', 'CURRENT_TIMESTAMP', 'ADD_DAYS',
])
```

Add a new helper near the bottom (above `module.exports`):

```javascript
function collectFunctions(node, out) {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) { node.forEach(n => collectFunctions(n, out)); return }
  // node-sql-parser surfaces function calls as { type: 'function', name: { name: [{ value }] }, ... }
  // or { type: 'aggr_func', name: 'COUNT', ... } for aggregates.
  if (node.type === 'function' && node.name) {
    const fnName = Array.isArray(node.name?.name)
      ? node.name.name.map(n => n.value).join('.').toUpperCase()
      : (typeof node.name === 'string' ? node.name : '').toUpperCase()
    if (fnName) out.add(fnName)
  }
  if (node.type === 'aggr_func' && typeof node.name === 'string') {
    out.add(node.name.toUpperCase())
  }
  for (const v of Object.values(node)) collectFunctions(v, out)
}
```

In `validateSelect`, after the existing `for (const t of referenced)` allowlist loop, add:

```javascript
const calledFunctions = new Set()
collectFunctions(ast, calledFunctions)
for (const fn of calledFunctions) {
  if (!ALLOWED_FUNCTIONS.has(fn)) {
    throw new Error(`Function '${fn}' is not in the analytics function allowlist`)
  }
}
```

- [ ] **Step 4: Run the new tests to confirm they pass**

```bash
npm test -- --project=unit -t "Phase 1 additions"
```

Expected: 4 PASS.

- [ ] **Step 5: Run the full validator test file to confirm no regression**

```bash
npm test -- --project=unit analytics-sql-validator
```

Expected: All tests pass (existing 16+ cases plus the 4 new ones).

If any existing test now fails because it called a function we forgot to whitelist (e.g. `LOWER` or `CONCAT`), check whether the function is genuinely needed and either add it to `ALLOWED_FUNCTIONS` (with a comment) or update the test if it's testing rejected behavior.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/analytics-sql-validator.cjs srv/lib/__tests__/analytics-sql-validator.test.js
git commit -m "feat(analytics-sql-validator): bump 16k char limit + scalar-fn allowlist"
```

---

## Task 6: Create `query-spec-validator.cjs` (TDD)

**Files:**
- Create: `srv/lib/query-spec-validator.cjs`
- Create: `srv/lib/__tests__/query-spec-validator.test.js`

This module validates a QuerySpec produced by the chip builder or by Joule. Its job is to fail fast on referential breakage (`ColumnRef.alias` not in scope), op/value mismatch, OR-group depth > 4, and missing required fields. It does NOT call any DB and does NOT generate SQL.

- [ ] **Step 1: Write the failing tests**

Create `srv/lib/__tests__/query-spec-validator.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
const { validateQuerySpec } = require('../query-spec-validator.cjs')

const VALID_ENTITIES = new Map([
  ['Tasks',    { columns: new Map([['id',{type:'cds.UUID'}],['status',{type:'cds.String'}],['createdAt',{type:'cds.Timestamp'}],['user_ID',{type:'cds.UUID'}]]) }],
  ['Users',    { columns: new Map([['ID',{type:'cds.UUID'}],['email',{type:'cds.String'}]]) }],
])

describe('query-spec-validator', () => {
  const baseSpec = () => ({
    version: 1,
    from: { entity: 'Tasks', alias: 't' },
    joins: [],
    filterTree: null,
    groupBy: [],
    select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
    orderBy: [],
    limit: null,
  })

  it('accepts a minimal valid spec', () => {
    const r = validateQuerySpec(baseSpec(), VALID_ENTITIES)
    expect(r.errors).toEqual([])
  })

  it('rejects unknown entity in from', () => {
    const s = baseSpec(); s.from.entity = 'Nope'
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.message.match(/entity.*Nope/i))).toBe(true)
  })

  it('rejects ColumnRef referencing unknown alias', () => {
    const s = baseSpec(); s.select[0].ref.alias = 'x'
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 's1' && e.message.match(/alias.*x/i))).toBe(true)
  })

  it('rejects ColumnRef with unknown column on a known alias', () => {
    const s = baseSpec(); s.select[0].ref.column = 'nopeCol'
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 's1' && e.message.match(/column.*nopeCol/i))).toBe(true)
  })

  it('rejects "between" with non-range value', () => {
    const s = baseSpec()
    s.filterTree = { id: 'fg0', kind: 'group', conjunction: 'and', children: [
      { id: 'f1', ref: { alias: 't', column: 'createdAt' }, op: 'between',
        value: { kind: 'literal', value: '2026-01-01' } }
    ] }
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 'f1' && e.message.match(/between.*range/i))).toBe(true)
  })

  it('rejects "in" with non-list value', () => {
    const s = baseSpec()
    s.filterTree = { id: 'fg0', kind: 'group', conjunction: 'and', children: [
      { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'in',
        value: { kind: 'literal', value: 'PENDING' } }
    ] }
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 'f1' && e.message.match(/in.*list/i))).toBe(true)
  })

  it('rejects OR-group nested deeper than 4', () => {
    let inner = { id: 'leaf', ref: { alias: 't', column: 'id' }, op: 'eq',
      value: { kind: 'literal', value: 'x' } }
    for (let i = 0; i < 5; i++) {
      inner = { id: `g${i}`, kind: 'group', conjunction: 'or', children: [inner] }
    }
    const s = baseSpec(); s.filterTree = inner
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.message.match(/depth/i))).toBe(true)
  })

  it('accepts a 2-table join with valid ON', () => {
    const s = baseSpec()
    s.joins = [{ id: 'j1', kind: 'inner',
      target: { entity: 'Users', alias: 'u' },
      on: { leftRef: {alias:'t',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }]
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors).toEqual([])
  })

  it('rejects a join where ON references an unknown alias', () => {
    const s = baseSpec()
    s.joins = [{ id: 'j1', kind: 'inner',
      target: { entity: 'Users', alias: 'u' },
      on: { leftRef: {alias:'zz',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }]
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 'j1' && e.message.match(/alias.*zz/i))).toBe(true)
  })

  it('rejects an aggregation chip with unknown function', () => {
    const s = baseSpec()
    s.select.push({ kind: 'aggregation', id: 's2', fn: 'STDEV', ref: '*' })
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.chipId === 's2' && e.message.match(/STDEV|fn/i))).toBe(true)
  })

  it('rejects empty select array', () => {
    const s = baseSpec(); s.select = []
    const r = validateQuerySpec(s, VALID_ENTITIES)
    expect(r.errors.some(e => e.message.match(/select.*empty|at least one/i))).toBe(true)
  })

  it('rejects unsupported FilterOp for column type (between on String)', () => {
    const s = baseSpec()
    s.filterTree = { id: 'fg0', kind: 'group', conjunction: 'and', children: [
      { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'between',
        value: { kind: 'range', value: ['A', 'Z'] } }
    ] }
    const r = validateQuerySpec(s, VALID_ENTITIES)
    // 'between' on string is technically valid SQL but we restrict to numeric/date in v1
    expect(r.errors.some(e => e.chipId === 'f1')).toBe(true)
  })
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
npm test -- --project=unit query-spec-validator
```

Expected: All tests FAIL with `Cannot find module '../query-spec-validator.cjs'`.

- [ ] **Step 3: Implement the validator**

Create `srv/lib/query-spec-validator.cjs`:

```javascript
'use strict'

const VALID_FNS = new Set(['count', 'sum', 'avg', 'min', 'max'])
const MAX_GROUP_DEPTH = 4

const OP_VALUE_KIND = {
  eq:'literal', neq:'literal', gt:'literal', gte:'literal', lt:'literal', lte:'literal',
  contains:'literal', startsWith:'literal', endsWith:'literal',
  in:'list',
  between:'range',
  isNull:'literal',
  sinceDays:'relative', inLastDays:'relative',
  inCurrent:'period',
}

const STRING_TYPES   = new Set(['cds.String', 'cds.LargeString'])
const NUMERIC_TYPES  = new Set(['cds.Integer', 'cds.Decimal', 'cds.Double', 'cds.Int64'])
const TEMPORAL_TYPES = new Set(['cds.Date', 'cds.DateTime', 'cds.Timestamp'])

function classifyType(t) {
  if (NUMERIC_TYPES.has(t)) return 'numeric'
  if (TEMPORAL_TYPES.has(t)) return 'temporal'
  if (STRING_TYPES.has(t))  return 'string'
  return 'other'
}

const OP_TYPE_OK = {
  eq: ['string','numeric','temporal','other'],
  neq:['string','numeric','temporal','other'],
  gt: ['numeric','temporal'],
  gte:['numeric','temporal'],
  lt: ['numeric','temporal'],
  lte:['numeric','temporal'],
  contains: ['string'], startsWith:['string'], endsWith:['string'],
  in: ['string','numeric','other'],
  between:    ['numeric','temporal'],
  isNull:     ['string','numeric','temporal','other'],
  sinceDays:  ['temporal'], inLastDays:['temporal'], inCurrent:['temporal'],
}

function validateQuerySpec(spec, entityMap) {
  const errors = []
  const push = (chipId, message) => errors.push({ chipId, message })

  if (!spec || typeof spec !== 'object') return { errors: [{ chipId: null, message: 'spec must be an object' }] }
  if (spec.version !== 1) return { errors: [{ chipId: null, message: 'unsupported QuerySpec version' }] }

  // Build alias map: alias -> entity definition
  const aliasMap = new Map()
  if (!spec.from || !spec.from.entity || !spec.from.alias) {
    push(null, 'spec.from is required (entity + alias)')
  } else if (!entityMap.has(spec.from.entity)) {
    push(null, `unknown entity '${spec.from.entity}' in from`)
  } else {
    aliasMap.set(spec.from.alias, entityMap.get(spec.from.entity))
  }

  // Joins (in order — each join's ON can reference previously-introduced aliases only)
  for (const j of (spec.joins || [])) {
    if (!j.target || !entityMap.has(j.target.entity)) {
      push(j.id, `unknown entity '${j.target?.entity}' in join`)
      continue
    }
    if (aliasMap.has(j.target.alias)) {
      push(j.id, `duplicate alias '${j.target.alias}' in join`)
      continue
    }
    // ON refs validated against aliasMap as it stands BEFORE this join is added
    const checkRef = (ref, label) => {
      if (!aliasMap.has(ref.alias) && ref.alias !== j.target.alias) {
        push(j.id, `join ON ${label} references unknown alias '${ref.alias}'`)
        return false
      }
      const e = aliasMap.get(ref.alias) || entityMap.get(j.target.entity)
      if (!e.columns.has(ref.column)) {
        push(j.id, `join ON ${label} references unknown column '${ref.column}' on alias '${ref.alias}'`)
        return false
      }
      return true
    }
    if (j.on) {
      checkRef(j.on.leftRef, 'leftRef')
      checkRef(j.on.rightRef, 'rightRef')
    } else {
      push(j.id, 'join is missing ON condition')
    }
    aliasMap.set(j.target.alias, entityMap.get(j.target.entity))
  }

  const checkColumnRef = (ref, chipId, label) => {
    if (!aliasMap.has(ref.alias)) {
      push(chipId, `${label}: unknown alias '${ref.alias}'`)
      return null
    }
    const ent = aliasMap.get(ref.alias)
    if (!ent.columns.has(ref.column)) {
      push(chipId, `${label}: unknown column '${ref.column}' on alias '${ref.alias}'`)
      return null
    }
    return ent.columns.get(ref.column)
  }

  // Filter tree
  function walkFilter(node, depth) {
    if (!node) return
    if (depth > MAX_GROUP_DEPTH) {
      push(node.id, `filter group exceeds max nesting depth ${MAX_GROUP_DEPTH}`)
      return
    }
    if (node.kind === 'group') {
      if (!Array.isArray(node.children) || node.children.length === 0) {
        push(node.id, 'filter group must have at least one child')
        return
      }
      if (!['and','or'].includes(node.conjunction)) {
        push(node.id, `invalid conjunction '${node.conjunction}'`)
      }
      node.children.forEach(c => walkFilter(c, depth + 1))
      return
    }
    // leaf
    const colMeta = checkColumnRef(node.ref, node.id, 'filter ref')
    const expectedKind = OP_VALUE_KIND[node.op]
    if (!expectedKind) {
      push(node.id, `unknown filter op '${node.op}'`)
      return
    }
    if (!node.value || node.value.kind !== expectedKind) {
      push(node.id, `op '${node.op}' requires value.kind '${expectedKind}'`)
    }
    if (colMeta) {
      const cls = classifyType(colMeta.type)
      const okTypes = OP_TYPE_OK[node.op] || []
      if (!okTypes.includes(cls)) {
        push(node.id, `op '${node.op}' not valid for column type '${colMeta.type}' (classified as ${cls})`)
      }
    }
  }
  walkFilter(spec.filterTree, 1)

  // groupBy
  for (const g of (spec.groupBy || [])) {
    checkColumnRef(g.ref, g.id, 'groupBy')
  }

  // select — must have at least one chip
  if (!Array.isArray(spec.select) || spec.select.length === 0) {
    push(null, 'select must have at least one chip')
  } else {
    for (const s of spec.select) {
      if (s.kind === 'column') {
        checkColumnRef(s.ref, s.id, 'select column')
      } else if (s.kind === 'aggregation') {
        if (!VALID_FNS.has(s.fn)) {
          push(s.id, `aggregation fn '${s.fn}' is not valid (allowed: ${[...VALID_FNS].join(', ')})`)
        }
        if (s.ref !== '*' && s.ref) {
          checkColumnRef(s.ref, s.id, 'aggregation column')
        }
      } else if (s.kind === 'expression') {
        if (!s.alias) push(s.id, 'expression chip requires alias')
        if (typeof s.sql !== 'string' || !s.sql.trim()) push(s.id, 'expression chip requires sql')
        // Note: full SQL parse happens at the chip-popover-Apply step in the
        // browser (Phase 2); here we only check the shape.
      } else {
        push(s.id, `unknown select kind '${s.kind}'`)
      }
    }
  }

  // orderBy
  for (const o of (spec.orderBy || [])) {
    if (o.by?.kind === 'columnRef') {
      checkColumnRef(o.by.ref, o.id, 'orderBy')
    } else if (o.by?.kind === 'selectId') {
      if (!spec.select.some(s => s.id === o.by.id)) {
        push(o.id, `orderBy references unknown selectId '${o.by.id}'`)
      }
    } else {
      push(o.id, `orderBy must reference a select id or a columnRef`)
    }
    if (!['asc','desc'].includes(o.direction)) {
      push(o.id, `orderBy direction must be 'asc' or 'desc'`)
    }
  }

  // limit
  if (spec.limit !== null && spec.limit !== undefined) {
    if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > 100000) {
      push(null, `limit must be a positive integer ≤ 100000 or null`)
    }
  }

  return { errors }
}

module.exports = { validateQuerySpec }
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npm test -- --project=unit query-spec-validator
```

Expected: All 12 tests PASS. If a test fails, read the assertion carefully — most failures here are off-by-one in the entity-map shape (`entityMap.get('Tasks').columns` is a `Map`, not an Object).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/query-spec-validator.cjs srv/lib/__tests__/query-spec-validator.test.js
git commit -m "feat(srv/lib): add query-spec-validator (isomorphic)"
```

---

## Task 7: Create `spec-to-sql.cjs` (TDD)

**Files:**
- Create: `srv/lib/spec-to-sql.cjs`
- Create: `srv/lib/__tests__/spec-to-sql.test.js`

Pure function: validated QuerySpec → HANA SQL string. Must be deterministic for caching, must produce SQL that the existing `analytics-sql-validator.cjs` accepts, must auto-derive GROUP BY from non-aggregation SELECT chips when at least one aggregation chip exists.

- [ ] **Step 1: Write the failing tests**

Create `srv/lib/__tests__/spec-to-sql.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
const { specToSql } = require('../spec-to-sql.cjs')

const SQL_NAMES = { Tasks: 'TASKS', Users: 'USERS' } // logical → physical (test uses uppercase)

describe('spec-to-sql', () => {
  it('emits a minimal single-table SELECT', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [], filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/^SELECT\s+t\.id\s+FROM\s+TASKS\s+t\s*$/)
  })

  it('quotes string literals in eq filters and uses parens around tree', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: 'PENDING' } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain("WHERE (t.status = 'PENDING')")
  })

  it('escapes single quotes in string literals', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: "O'Brien" } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain("'O''Brien'")
  })

  it('rejects raw single-quote injection attempts via list values', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'in',
          value: { kind: 'list', value: ["x'; DROP TABLE Tasks; --"] } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain("''; DROP TABLE Tasks; --")  // properly escaped
    expect(sql).not.toMatch(/; DROP TABLE Tasks; --'\)/)  // not unterminated
  })

  it('emits OR group with proper parens and AND default at top', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'eq',
          value: { kind: 'literal', value: 'PENDING' } },
        { id: 'fg2', kind: 'group', conjunction: 'or', children: [
          { id: 'f2', ref: { alias: 't', column: 'taskType' }, op: 'eq',
            value: { kind: 'literal', value: 'A' } },
          { id: 'f3', ref: { alias: 't', column: 'taskType' }, op: 'eq',
            value: { kind: 'literal', value: 'B' } },
        ] }
      ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/WHERE \(t\.status = 'PENDING' AND \(t\.taskType = 'A' OR t\.taskType = 'B'\)\)/)
  })

  it('emits INNER JOIN with ON', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [{ id: 'j1', kind: 'inner', target: { entity: 'Users', alias: 'u' },
        on: { leftRef: {alias:'t',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }],
      filterTree: null, groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain('INNER JOIN USERS u ON t.user_ID = u.ID')
  })

  it('auto-derives GROUP BY from non-aggregation SELECT chips when an aggregation is present', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 't', column: 'status' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
      ],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toContain('GROUP BY t.status')
    expect(sql).toMatch(/SELECT t\.status, COUNT\(\*\) AS cnt/)
  })

  it('does not emit GROUP BY when no aggregation present', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column', id: 's1', ref: { alias: 't', column: 'status' } },
        { kind: 'column', id: 's2', ref: { alias: 't', column: 'id' } },
      ],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).not.toContain('GROUP BY')
  })

  it('orders by selectId alias and supports asc/desc', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [], filterTree: null, groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 't', column: 'status' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'cnt' },
      ],
      orderBy: [{ id:'o1', by: { kind: 'selectId', id: 's2' }, direction: 'desc' }],
      limit: 10,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/ORDER BY cnt DESC/)
    expect(sql).toMatch(/LIMIT 10\s*$/)
  })

  it('emits sinceDays as ADD_DAYS expression', () => {
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' }, joins: [],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'createdAt' }, op: 'sinceDays',
          value: { kind: 'relative', value: 30 } } ] },
      groupBy: [],
      select: [{ kind: 'column', id: 's1', ref: { alias: 't', column: 'id' } }],
      orderBy: [], limit: null,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(sql).toMatch(/t\.createdAt >= ADD_DAYS\(CURRENT_DATE,\s*-30\)/)
  })

  it('produces SQL that passes analytics-sql-validator', () => {
    const { validateSelect } = require('../analytics-sql-validator.cjs')
    const ALLOWED = new Set(['TASKS', 'USERS', 'Tasks', 'Users'])
    const spec = {
      version: 1,
      from: { entity: 'Tasks', alias: 't' },
      joins: [{ id: 'j1', kind: 'inner', target: { entity: 'Users', alias: 'u' },
        on: { leftRef: {alias:'t',column:'user_ID'}, rightRef: {alias:'u',column:'ID'} } }],
      filterTree: { id: 'fg', kind: 'group', conjunction: 'and', children: [
        { id: 'f1', ref: { alias: 't', column: 'status' }, op: 'in',
          value: { kind: 'list', value: ['PENDING', 'IN_PROGRESS'] } } ] },
      groupBy: [],
      select: [
        { kind: 'column',      id: 's1', ref: { alias: 't', column: 'event_ID' } },
        { kind: 'aggregation', id: 's2', fn: 'count', ref: '*', alias: 'task_count' },
      ],
      orderBy: [{ id:'o1', by: { kind: 'selectId', id: 's2' }, direction: 'desc' }],
      limit: 10,
    }
    const sql = specToSql(spec, SQL_NAMES)
    expect(() => validateSelect(sql, ALLOWED)).not.toThrow()
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm test -- --project=unit spec-to-sql
```

Expected: all FAIL with module-not-found.

- [ ] **Step 3: Implement spec-to-sql**

Create `srv/lib/spec-to-sql.cjs`:

```javascript
'use strict'

// Pure function: QuerySpec (already validated by query-spec-validator) → HANA SQL.
// Output is deterministic; same input always produces the same string.
// Output is intentionally UN-parenthesized at the top SELECT level so it
// composes cleanly with the runSelectQuery wrapper: `SELECT * FROM (...) t LIMIT N`.

const AGG_FN = {
  count: 'COUNT', sum: 'SUM', avg: 'AVG', min: 'MIN', max: 'MAX',
}

function escapeLiteral(v) {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number')  return String(v)
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return "'" + String(v).replace(/'/g, "''") + "'"
}

function renderValue(value) {
  switch (value.kind) {
    case 'literal':
      return escapeLiteral(value.value)
    case 'list': {
      const items = (value.value || []).map(escapeLiteral).join(', ')
      return `(${items})`
    }
    case 'range':
      return `${escapeLiteral(value.value[0])} AND ${escapeLiteral(value.value[1])}`
    case 'relative':
      // sinceDays / inLastDays — caller decides ADD_DAYS vs ADD_MONTHS via op
      return String(Math.floor(Number(value.value)))
    case 'period':
      return value.value
    default:
      throw new Error(`spec-to-sql: unsupported value.kind '${value.kind}'`)
  }
}

function renderRef(ref) {
  // Caller has already validated alias.column; no need to re-quote here.
  return `${ref.alias}.${ref.column}`
}

function renderLeaf(leaf) {
  const ref = renderRef(leaf.ref)
  switch (leaf.op) {
    case 'eq':         return `${ref} = ${renderValue(leaf.value)}`
    case 'neq':        return `${ref} <> ${renderValue(leaf.value)}`
    case 'gt':         return `${ref} > ${renderValue(leaf.value)}`
    case 'gte':        return `${ref} >= ${renderValue(leaf.value)}`
    case 'lt':         return `${ref} < ${renderValue(leaf.value)}`
    case 'lte':        return `${ref} <= ${renderValue(leaf.value)}`
    case 'contains':   return `${ref} LIKE '%' || ${renderValue(leaf.value)} || '%'`
    case 'startsWith': return `${ref} LIKE ${renderValue(leaf.value)} || '%'`
    case 'endsWith':   return `${ref} LIKE '%' || ${renderValue(leaf.value)}`
    case 'in':         return `${ref} IN ${renderValue(leaf.value)}`
    case 'between':    return `${ref} BETWEEN ${renderValue(leaf.value)}`
    case 'isNull':     return `${ref} IS NULL`
    case 'sinceDays':
    case 'inLastDays':
      return `${ref} >= ADD_DAYS(CURRENT_DATE, -${renderValue(leaf.value)})`
    case 'inCurrent': {
      const period = renderValue(leaf.value).toUpperCase()
      // Map period to a HANA truncation predicate
      const map = { DAY: '1', WEEK: '7', MONTH: '30', QUARTER: '90', YEAR: '365' }
      const days = map[period] || '1'
      return `${ref} >= ADD_DAYS(CURRENT_DATE, -${days})`
    }
    default:
      throw new Error(`spec-to-sql: unsupported op '${leaf.op}'`)
  }
}

function renderFilterTree(node) {
  if (!node) return null
  if (node.kind === 'group') {
    const inner = node.children.map(renderFilterTree).filter(Boolean)
    if (!inner.length) return null
    const joined = inner.join(node.conjunction === 'or' ? ' OR ' : ' AND ')
    const wrapped = `(${joined})`
    return node.negated ? `NOT ${wrapped}` : wrapped
  }
  // leaf
  const rendered = renderLeaf(node)
  return node.negated ? `NOT (${rendered})` : rendered
}

function renderSelectItem(item) {
  if (item.kind === 'column') {
    const ref = renderRef(item.ref)
    return item.alias ? `${ref} AS ${item.alias}` : ref
  }
  if (item.kind === 'aggregation') {
    const fn = AGG_FN[item.fn]
    const inner = item.ref === '*' ? '*' : renderRef(item.ref)
    const distinct = item.distinct ? 'DISTINCT ' : ''
    const expr = `${fn}(${distinct}${inner})`
    return item.alias ? `${expr} AS ${item.alias}` : expr
  }
  if (item.kind === 'expression') {
    // The chip-popover already validated the expression via node-sql-parser.
    // We trust the alias (required) and emit verbatim.
    return `${item.sql} AS ${item.alias}`
  }
  throw new Error(`spec-to-sql: unsupported select.kind '${item.kind}'`)
}

function deriveAutoGroupBy(select) {
  const hasAgg = select.some(s => s.kind === 'aggregation')
  if (!hasAgg) return []
  return select
    .filter(s => s.kind !== 'aggregation')
    .map(s => {
      if (s.kind === 'column')     return renderRef(s.ref)
      if (s.kind === 'expression') return s.sql  // group by the expression text itself
      return null
    })
    .filter(Boolean)
}

function specToSql(spec, sqlNames) {
  if (!spec || spec.version !== 1) throw new Error('spec-to-sql: unsupported spec version')

  const fromTable = sqlNames[spec.from.entity]
  if (!fromTable) throw new Error(`spec-to-sql: no SQL name for entity '${spec.from.entity}'`)

  const parts = []
  const selectClause = spec.select.map(renderSelectItem).join(', ')
  parts.push(`SELECT ${selectClause}`)
  parts.push(`FROM ${fromTable} ${spec.from.alias}`)

  for (const j of (spec.joins || [])) {
    const jTable = sqlNames[j.target.entity]
    if (!jTable) throw new Error(`spec-to-sql: no SQL name for joined entity '${j.target.entity}'`)
    const jKind = j.kind === 'left' ? 'LEFT JOIN' : 'INNER JOIN'
    const onLeft  = renderRef(j.on.leftRef)
    const onRight = renderRef(j.on.rightRef)
    parts.push(`${jKind} ${jTable} ${j.target.alias} ON ${onLeft} = ${onRight}`)
  }

  const where = renderFilterTree(spec.filterTree)
  if (where) parts.push(`WHERE ${where}`)

  // Auto-derived + explicit group keys
  const autoGroup = deriveAutoGroupBy(spec.select)
  const explicitGroup = (spec.groupBy || []).map(g => renderRef(g.ref))
  const allGroup = [...autoGroup, ...explicitGroup]
  if (allGroup.length) parts.push(`GROUP BY ${allGroup.join(', ')}`)

  if ((spec.orderBy || []).length) {
    const orderParts = spec.orderBy.map(o => {
      let ref
      if (o.by.kind === 'selectId') {
        const target = spec.select.find(s => s.id === o.by.id)
        if (!target) throw new Error(`spec-to-sql: orderBy references unknown selectId '${o.by.id}'`)
        ref = target.alias || (target.kind === 'column' ? renderRef(target.ref) : null)
        if (!ref) throw new Error(`spec-to-sql: orderBy.selectId target has no alias`)
      } else {
        ref = renderRef(o.by.ref)
      }
      return `${ref} ${o.direction === 'desc' ? 'DESC' : 'ASC'}`
    })
    parts.push(`ORDER BY ${orderParts.join(', ')}`)
  }

  if (spec.limit) parts.push(`LIMIT ${Math.floor(spec.limit)}`)

  return parts.join(' ')
}

module.exports = { specToSql }
```

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm test -- --project=unit spec-to-sql
```

Expected: 10 PASS. The SQL-injection test verifies double-quote escaping; the validator-pass test confirms our generated SQL is accepted by the existing security gate.

If the "minimal SELECT" test fails because of trailing whitespace or column-order differences, tweak the regex — those are formatting nitpicks, not bugs. The injection-escape test must pass exactly as written.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/spec-to-sql.cjs srv/lib/__tests__/spec-to-sql.test.js
git commit -m "feat(srv/lib): add spec-to-sql (isomorphic, deterministic)"
```

---

## Stopping point — Phase 1, Part A

Tasks 1–7 land the **foundation**: the new branch, the schema additions (entities + annotations), and the three pure-function modules (validator bump + query-spec-validator + spec-to-sql) all backed by TDD. At this point the new modules are covered by ~30 unit tests and the existing 620-test baseline still passes.

The plan continues with **Tasks 8–19** (handler integration, action implementations, hybrid tests, srv-qa verification, PR). Those tasks depend on the foundation landing cleanly first — if any of Tasks 1–7 has an unexpected failure mode, we'd want to address it before writing more plan against it.

To keep the plan reviewable and avoid the output-token overflow we just hit, I'll write **Part B (Tasks 8–19)** in a follow-up file:

- `docs/superpowers/plans/2026-05-31-analytics-builder-phase1-backend-part-b.md`

That file will pick up at Task 8 (`listExposedEntities` enrichment) and run through the PR. The two parts are sequential — execute Part A first, get clean test runs, then move to Part B.

---

## Part A summary checklist

- [ ] Task 1: Branch + README
- [ ] Task 2: New entities
- [ ] Task 3: Drift + regression
- [ ] Task 4: Filter/PII annotations
- [ ] Task 5: Validator bump + scalar fn allowlist (TDD)
- [ ] Task 6: query-spec-validator.cjs (TDD)
- [ ] Task 7: spec-to-sql.cjs (TDD)

After these are green, proceed to Part B.
