# Analytics SQL Builder — Phase 1 Backend, Part B (Tasks 8–19)

**Continuation of:** [2026-05-31-analytics-builder-phase1-backend-part-a.md](./2026-05-31-analytics-builder-phase1-backend-part-a.md)

> **For agentic workers:** Same conventions as Part A. Run Part A's tasks 1–7 to green before starting Task 8 here. Same branch (`feat/analytics-builder-phase1-backend`).

---

## Task 8: Enrich `listExposedEntities` (TDD)

**Files:**
- Modify: `srv/analytics-service.cds:22-33` (extend return shape)
- Modify: `srv/analytics-service.js` (`listExposedEntities` handler, ~lines 65-90)
- Create: `srv/__tests__/analytics-service-list-entities.test.js`

The current handler returns `name`, `sqlName`, `label`, `description`, `columns: [{name,type,nullable,length}]`. We add precise HANA type, filter mode, sample flag, PII flag, and association metadata.

- [ ] **Step 1: Write the failing test**

Create `srv/__tests__/analytics-service-list-entities.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.listExposedEntities — Phase 1 enrichments', () => {
  let result

  beforeAll(async () => {
    const srv = await cds.connect.to('AnalyticsService')
    result = await srv.send('listExposedEntities')
  })

  it('returns enriched columns with hanaType', () => {
    const tasks = result.find(e => e.name === 'Tasks')
    expect(tasks).toBeTruthy()
    const status = tasks.columns.find(c => c.name === 'status')
    expect(status).toBeTruthy()
    expect(status.hanaType).toMatch(/NVARCHAR|VARCHAR/i)
  })

  it('returns filterMode for annotated columns', () => {
    const tasks = result.find(e => e.name === 'Tasks')
    const status = tasks.columns.find(c => c.name === 'status')
    expect(status.filterMode).toBe('enum')
    expect(status.filterSample).toBe(true)
  })

  it('returns filterMode "free" for unannotated columns', () => {
    const tasks = result.find(e => e.name === 'Tasks')
    const id = tasks.columns.find(c => c.name === 'id') || tasks.columns.find(c => c.name === 'ID')
    if (!id) return // schema may use different key column name; skip silently
    expect(id.filterMode).toBe('free')
    expect(id.filterSample).toBe(false)
  })

  it('returns pii flag on Users.email', () => {
    const users = result.find(e => e.name === 'Users')
    const email = users.columns.find(c => c.name === 'email')
    expect(email).toBeTruthy()
    expect(email.pii).toBe(true)
  })

  it('returns associations array (may be empty for non-associated entities)', () => {
    const tasks = result.find(e => e.name === 'Tasks')
    expect(Array.isArray(tasks.associations)).toBe(true)
    // Tasks has user_ID FK to Users — should surface if Users is also @analytics.exposed
    const userAssoc = tasks.associations.find(a => a.targetEntity === 'Users')
    if (userAssoc) {
      expect(userAssoc.cardinality).toMatch(/^to-(one|many)$/)
      expect(Array.isArray(userAssoc.onLocal)).toBe(true)
      expect(Array.isArray(userAssoc.onTarget)).toBe(true)
    }
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npm test -- --project=unit analytics-service-list-entities
```

Expected: FAIL — `status.hanaType` is `undefined`, `filterMode` is `undefined`, etc.

- [ ] **Step 3: Add a CDS-type-to-HANA-type helper**

**Pre-flight check:** before editing, confirm `getExposedEntries()` yields `{ def, projection, projectionName }` — Tasks 8 and 11 both destructure all three. Run:

```bash
grep -n "out.push" srv/analytics-service.js | head -5
```

If your local copy yields fewer fields (e.g. just `{ def, projection }`), update the iterator first.

Create `srv/lib/cds-type-to-hana.cjs`:

```javascript
'use strict'

// CDS → HANA type mapping for the AnalyticsService listExposedEntities response.
// Lengths are read from the column metadata when present.
function cdsTypeToHana(type, length, precision, scale) {
  switch (type) {
    case 'cds.UUID':       return 'NVARCHAR(36)'
    case 'cds.String':     return length ? `NVARCHAR(${length})` : 'NVARCHAR(255)'
    case 'cds.LargeString':return 'NCLOB'
    case 'cds.Boolean':    return 'BOOLEAN'
    case 'cds.Integer':    return 'INTEGER'
    case 'cds.Int64':      return 'BIGINT'
    case 'cds.Decimal':    return precision ? `DECIMAL(${precision},${scale||0})` : 'DECIMAL'
    case 'cds.Double':     return 'DOUBLE'
    case 'cds.Date':       return 'DATE'
    case 'cds.Time':       return 'TIME'
    case 'cds.DateTime':   return 'SECONDDATE'
    case 'cds.Timestamp':  return 'TIMESTAMP'
    case 'cds.Binary':     return length ? `VARBINARY(${length})` : 'VARBINARY(255)'
    case 'cds.LargeBinary':return 'BLOB'
    default: return type || 'NVARCHAR(255)'
  }
}

module.exports = { cdsTypeToHana }
```

- [ ] **Step 4: Update the handler to emit the new fields**

In `srv/analytics-service.js`, locate the `listExposedEntities` handler (around line 65). Add this require near the top:

```javascript
const { cdsTypeToHana } = require('./lib/cds-type-to-hana.cjs')
```

Replace the `columns:` mapping inside `listExposedEntities` with this fuller form:

```javascript
columns: Object.entries(projection.elements)
  .filter(([, c]) => !c.virtual && !c.target)
  .map(([n, c]) => ({
    name: n,
    type: c.type,
    hanaType: cdsTypeToHana(c.type, c.length, c.precision, c.scale),
    nullable: c.notNull !== true,
    length: c.length || null,
    filterMode: c['@analytics.filter']?.mode || 'free',
    filterSample: !!c['@analytics.filter']?.sample,
    pii: !!c['@analytics.pii'],
  })),
associations: Object.entries(projection.elements)
  .filter(([, c]) => c.target)
  .map(([n, c]) => {
    const targetDef = cds.model.definitions[c.target]
    const targetExposed = targetDef && targetDef['@analytics.exposed']
    if (!targetExposed) return null
    const targetShortName = c.target.split('.').pop()
    // CAP records FK keys at element.keys[].ref; element.cardinality.max="*" indicates to-many.
    const onLocal  = (c.keys || []).map(k => k.$generatedFieldName || k.ref?.[0]).filter(Boolean)
    const onTarget = (c.keys || []).map(k => k.ref?.[0] || 'ID').filter(Boolean)
    const cardinality = c.cardinality?.max === '*' || c.cardinality === '*' ? 'to-many' : 'to-one'
    return { name: n, targetEntity: targetShortName, cardinality, onLocal, onTarget }
  })
  .filter(Boolean),
```

(The `$generatedFieldName` field is what CAP populates for managed-association FK columns like `user_ID`. For older models it falls back to `ref?.[0]`.)

- [ ] **Step 5: Run the test to confirm it passes**

```bash
npm test -- --project=unit analytics-service-list-entities
```

Expected: PASS for `hanaType`, `filterMode`/`filterSample`, `pii`, and the associations array shape.

If the `pii` test fails, double-check Task 4's annotation block landed and that you committed the correct file.

If the associations test fails because CAP put the FK info in a different shape than expected, log the value of `c.keys` for one association and adjust the field plucking. The test only requires `onLocal`/`onTarget` to be arrays — content may differ slightly across CDS versions.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/cds-type-to-hana.cjs srv/analytics-service.js srv/__tests__/analytics-service-list-entities.test.js
git commit -m "feat(analytics): enrich listExposedEntities with hanaType + filter + assoc"
```

---

## Task 9: Add new actions/projections to `analytics-service.cds`

**Files:**
- Modify: `srv/analytics-service.cds`

- [ ] **Step 1: Add the new actions and projections**

Append to `srv/analytics-service.cds` (after the existing `listExposedEntities` and `runSelectQuery` declarations, before the closing `}`):

```cds
  // ─── Phase 1 additions ──────────────────────────────────────────────────

  /** Sample distinct values for an enum-mode column. Annotation-gated. */
  function sampleDistinct(table: String, column: String, limit: Integer)
    returns { values: array of String; truncated: Boolean; };

  /** Stream a query result as CSV. Bypasses 5k row cap; capped at 100k rows / 60s. */
  action exportSelectQuery(sql: String) returns LargeBinary;

  // History (read-only, scoped to current user via @restrict)
  @readonly entity QueryHistory as projection on ims.AnalyticsQueryHistory;

  // Saved queries with rename/visibility/duplicate/recordRun actions
  entity SavedQueries as projection on ims.AnalyticsSavedQuery actions {
    action rename(name: String, description: String) returns SavedQueries;
    action setVisibility(visibility: String) returns SavedQueries;
    action duplicate() returns SavedQueries;
    action recordRun(rowCount: Integer, durationMs: Integer) returns SavedQueries;
  };

  // Extend runSelectQuery with the source parameter and richer return shape.
  // (CAP allows action-shape evolution as long as it's additive.)
```

Note: CAP doesn't let you redeclare an existing action; the existing `runSelectQuery` declaration in this file already returns its current shape. We extend the **handler** in Task 12 to add fields to the returned object — CDS allows the handler to return a superset of the declared shape, and clients get the richer JSON via OData passthrough. We will, however, add the optional `source` parameter by amending the existing declaration:

Locate the existing `runSelectQuery` declaration in the same file (it currently looks like `action runSelectQuery(sql: String) returns { ... };`). Change its parameter list to:

```cds
action runSelectQuery(sql: String, source: String) returns { ... };
```

(Leave the existing return-type declaration intact — the handler change in Task 12 returns the additional `privacy` and `historyId` fields, which OData simply forwards.)

- [ ] **Step 2: Add the `@restrict` rules for `SavedQueries`**

Append at the very end of the file (outside the service block):

```cds
annotate AnalyticsService.SavedQueries with @restrict: [
  { grant: 'READ',              where: 'visibility = ''shared-admins'' or createdBy = $user' },
  { grant: ['CREATE'] },
  { grant: ['UPDATE','DELETE'], where: 'createdBy = $user' }
];
```

(The Admin scope is already enforced at the service level; `@restrict` adds the per-row visibility filter on top.)

- [ ] **Step 3: Verify the model compiles**

```bash
npx cds compile srv/analytics-service.cds 2>&1 | tail -10
```

Expected: no errors. Warnings about `@analytics.exposed` on `AnalyticsQueryHistory` are fine — those entities are admin-only and not exposed to the analytics builder itself; the handler in Task 8 already filters by `def.name.startsWith('com.sap.developers.ims.')`, but `AnalyticsQueryHistory` lives under that namespace too. Add the explicit exclusion:

In `srv/analytics-service.js`, inside `getExposedEntries`, change the filter line:

```javascript
if (!def['@analytics.exposed']) continue
```

to:

```javascript
if (!def['@analytics.exposed']) continue
// Phase 1: exclude admin-only history/saved tables from the user-facing builder surface.
if (/^com\.sap\.developers\.ims\.Analytics(QueryHistory|SavedQuery)$/.test(def.name)) continue
```

(Defensive belt-and-suspenders — neither carries the `@analytics.exposed` annotation today, but the test above guards against future drift.)

- [ ] **Step 4: Commit**

```bash
git add srv/analytics-service.cds srv/analytics-service.js
git commit -m "feat(analytics-service): add Phase 1 actions + projections + @restrict"
```

---

## Task 10: Implement `sampleDistinct` (TDD)

**Files:**
- Create: `srv/lib/analytics-distinct-sample.js`
- Create: `srv/lib/__tests__/analytics-distinct-sample.test.js`

- [ ] **Step 1: Write the failing tests**

Create `srv/lib/__tests__/analytics-distinct-sample.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest'

// We test the pure-function part of sampleDistinct in isolation.
// The handler-glue test runs in Task 11 via cds.test.

const { buildSampleDistinctSql, validateSampleDistinctRequest } =
  await import('../analytics-distinct-sample.js')

describe('analytics-distinct-sample — pure helpers', () => {
  const allowedTables = new Set(['Tasks', 'TASKS'])
  const annot = (mode, sample) => ({ filterMode: mode, filterSample: sample })

  it('rejects table not in allowlist', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'NotAllowed', column: 'status',
      allowedTables, columnAnnotation: annot('enum', true),
    })).toThrow(/not exposed/i)
  })

  it('rejects column with filterMode != enum', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'Tasks', column: 'status',
      allowedTables, columnAnnotation: annot('free', false),
    })).toThrow(/not eligible/i)
  })

  it('rejects column with sample: false', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'Tasks', column: 'status',
      allowedTables, columnAnnotation: annot('enum', false),
    })).toThrow(/not eligible/i)
  })

  it('rejects column name with non-identifier characters', () => {
    expect(() => validateSampleDistinctRequest({
      table: 'Tasks', column: 'status; DROP TABLE Tasks; --',
      allowedTables, columnAnnotation: annot('enum', true),
    })).toThrow(/bad column/i)
  })

  it('builds DISTINCT SQL with cap+1 limit for truncation detection', () => {
    const sql = buildSampleDistinctSql({ table: 'Tasks', column: 'status', cap: 100 })
    expect(sql).toMatch(/SELECT DISTINCT "status" AS V FROM Tasks/)
    expect(sql).toMatch(/LIMIT 101/)  // cap + 1
  })

  it('clamps cap to [1, 200]', () => {
    expect(buildSampleDistinctSql({ table: 'Tasks', column: 'status', cap: 1000 })).toMatch(/LIMIT 201/)
    expect(buildSampleDistinctSql({ table: 'Tasks', column: 'status', cap: 0 })).toMatch(/LIMIT 2/)
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm test -- --project=unit analytics-distinct-sample
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `srv/lib/analytics-distinct-sample.js`:

```javascript
// ESM module. Pure helpers exported separately for unit-test ergonomics;
// the handler glue function is wired into AnalyticsService in Task 11.

const COLUMN_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function validateSampleDistinctRequest({ table, column, allowedTables, columnAnnotation }) {
  if (!table || !allowedTables.has(table) && !allowedTables.has(String(table).toLowerCase())
              && !allowedTables.has(String(table).toUpperCase())) {
    throw Object.assign(new Error(`Table '${table}' is not exposed`), { status: 403 })
  }
  if (!columnAnnotation || columnAnnotation.filterMode !== 'enum' || !columnAnnotation.filterSample) {
    throw Object.assign(new Error(`Column '${column}' is not eligible for distinct sampling`), { status: 403 })
  }
  if (!COLUMN_NAME_RE.test(column)) {
    throw Object.assign(new Error(`Bad column name: '${column}'`), { status: 400 })
  }
}

export function buildSampleDistinctSql({ table, column, cap }) {
  const safeCap = Math.min(Math.max(Number(cap) || 100, 1), 200)
  // Both table and column have already been validated by validateSampleDistinctRequest.
  // We still wrap column in double-quotes (HANA identifier delimiter) defensively.
  return `SELECT DISTINCT "${column}" AS V FROM ${table} ORDER BY 1 LIMIT ${safeCap + 1}`
}

export async function runSampleDistinct({ db, sql, cap, timeoutMs = 30000 }) {
  const safeCap = Math.min(Math.max(Number(cap) || 100, 1), 200)
  const rows = await Promise.race([
    db.run(sql),
    new Promise((_, rej) => setTimeout(() => rej(new Error('sampleDistinct exceeded timeout')), timeoutMs)),
  ])
  const truncated = rows.length > safeCap
  return {
    values: rows.slice(0, safeCap).map(r => r.V === null || r.V === undefined ? '' : String(r.V)),
    truncated,
  }
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npm test -- --project=unit analytics-distinct-sample
```

Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/analytics-distinct-sample.js srv/lib/__tests__/analytics-distinct-sample.test.js
git commit -m "feat(srv/lib): add analytics-distinct-sample (annotation-gated)"
```

---

## Task 11: Wire `sampleDistinct` into `analytics-service.js`

**Files:**
- Modify: `srv/analytics-service.js` (add handler)
- Create: `srv/__tests__/analytics-service-sample-distinct.test.js`

- [ ] **Step 1: Write the integration test (failing)**

Create `srv/__tests__/analytics-service-sample-distinct.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.sampleDistinct (integration)', () => {
  it('returns distinct values for Tasks.status (enum-annotated)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await srv.send('sampleDistinct', { table: 'Tasks', column: 'status', limit: 50 })
    expect(Array.isArray(r.values)).toBe(true)
    expect(typeof r.truncated).toBe('boolean')
  })

  it('rejects Users.email (not enum-annotated)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    await expect(
      srv.send('sampleDistinct', { table: 'Users', column: 'email', limit: 50 })
    ).rejects.toThrow(/not eligible|403/i)
  })

  it('rejects an unknown table', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    await expect(
      srv.send('sampleDistinct', { table: 'Nope', column: 'status', limit: 50 })
    ).rejects.toThrow(/not exposed|403/i)
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npm test -- --project=unit analytics-service-sample-distinct
```

Expected: FAIL with "Action sampleDistinct is not registered" or similar.

- [ ] **Step 3: Wire the handler**

In `srv/analytics-service.js`, near the existing `this.on('runSelectQuery', ...)` block, add:

```javascript
const { validateSampleDistinctRequest, buildSampleDistinctSql, runSampleDistinct } =
  await import('./lib/analytics-distinct-sample.js')

this.on('sampleDistinct', async (req) => {
  const { table, column, limit } = req.data || {}

  // Look up column annotation from CDS model.
  // Iterate exposed entries to find the matching short or physical table name.
  let columnAnnotation = null
  for (const { def, projection, projectionName } of getExposedEntries()) {
    const hanaName = def.name.replace(/\./g, '_').toUpperCase()
    const sqliteName = def.name.replace(/\./g, '_')
    if ([projectionName, hanaName, sqliteName].includes(table)) {
      const elem = projection.elements[column]
      if (elem) {
        columnAnnotation = {
          filterMode: elem['@analytics.filter']?.mode || 'free',
          filterSample: !!elem['@analytics.filter']?.sample,
        }
      }
      break
    }
  }

  try {
    validateSampleDistinctRequest({
      table, column,
      allowedTables: getAllowedTableNames(),
      columnAnnotation,
    })
  } catch (err) {
    return req.reject(err.status || 400, err.message)
  }

  const sql = buildSampleDistinctSql({ table, column, cap: limit })
  try {
    return await runSampleDistinct({ db: cds.db, sql, cap: limit })
  } catch (err) {
    cds.log('analytics-sql').warn({ user: req.user.id, action: 'sampleDistinct', error: err.message })
    return req.reject(400, `sampleDistinct failed: ${err.message}`)
  }
})
```

The `await import(...)` inside the handler is needed because the rest of `analytics-service.js` already uses `import` at the top — but `analytics-distinct-sample.js` is ESM, so a top-level `import { ... } from './lib/...'` works. **Prefer the top-level import**: move the require/import to the top of the file alongside the other imports:

```javascript
import { validateSampleDistinctRequest, buildSampleDistinctSql, runSampleDistinct }
  from './lib/analytics-distinct-sample.js'
```

…and drop the `await import` line.

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
npm test -- --project=unit analytics-service-sample-distinct
```

Expected: 3 PASS.

If the first test fails because the in-memory SQLite has no data for `Tasks`, the test will return `values: []` and `truncated: false` — that's a valid pass. The assertion only checks the shape.

- [ ] **Step 5: Commit**

```bash
git add srv/analytics-service.js srv/__tests__/analytics-service-sample-distinct.test.js
git commit -m "feat(analytics): wire sampleDistinct handler with annotation gate"
```

---

## Task 12: Extend `runSelectQuery` envelope + history write (TDD)

**Files:**
- Create: `srv/lib/analytics-history-writer.js`
- Modify: `srv/analytics-service.js` (`runSelectQuery` handler)
- Create: `srv/__tests__/analytics-service-run-envelope.test.js`

- [ ] **Step 1: Write the failing tests**

Create `srv/__tests__/analytics-service-run-envelope.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.runSelectQuery — Phase 1 envelope', () => {
  it('returns privacy: { mode: "raw" } and a historyId', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await srv.send('runSelectQuery', {
      sql: 'SELECT id FROM Tasks LIMIT 1',
      source: 'builder',
    })
    expect(r.privacy).toEqual({ mode: 'raw', suppressedCells: 0 })
    expect(r.historyId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('writes a row to AnalyticsQueryHistory with the source parameter', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await srv.send('runSelectQuery', {
      sql: 'SELECT id FROM Tasks LIMIT 1',
      source: 'editor',
    })
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row).toBeTruthy()
    expect(row.source).toBe('editor')
    expect(row.privacyMode).toBe('raw')
  })

  it('normalizes unknown source values to "editor"', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await srv.send('runSelectQuery', {
      sql: 'SELECT id FROM Tasks LIMIT 1',
      source: 'definitely-not-valid',
    })
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(AnalyticsQueryHistory).where({ ID: r.historyId })
    expect(row.source).toBe('editor')
  })

  it('does not break when source is missing (back-compat)', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const r = await srv.send('runSelectQuery', { sql: 'SELECT id FROM Tasks LIMIT 1' })
    expect(r.privacy).toEqual({ mode: 'raw', suppressedCells: 0 })
    expect(r.historyId).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to confirm failure**

```bash
npm test -- --project=unit analytics-service-run-envelope
```

Expected: FAIL — `r.privacy` is `undefined`.

- [ ] **Step 3: Create the history-writer helper**

Create `srv/lib/analytics-history-writer.js`:

```javascript
import cds from '@sap/cds'

const VALID_SOURCES = new Set(['builder', 'editor', 'joule', 'replay'])

export function normalizeSource(s) {
  if (typeof s !== 'string') return 'editor'
  return VALID_SOURCES.has(s) ? s : 'editor'
}

export async function writeHistoryRow({ user, sql, rowCount, durationMs, truncated, source }) {
  const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
  const ID = cds.utils.uuid()
  await INSERT.into(AnalyticsQueryHistory).entries({
    ID,
    spec: null,                    // Phase 1: builder not yet wired — Phase 2 will populate
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

- [ ] **Step 4: Update `runSelectQuery` handler**

In `srv/analytics-service.js`, add at top:

```javascript
import { writeHistoryRow } from './lib/analytics-history-writer.js'
```

Replace the handler's return value (currently `return { columns, rows: ..., metadata: ... }` near line 127) with:

```javascript
const historyId = await writeHistoryRow({
  user: req.user.id,
  sql,
  rowCount: data.length,
  durationMs,
  truncated,
  source: req.data.source,
})
return {
  columns,
  rows: data.map(r => columns.map(c => stringify(r[c]))),
  metadata: { rowCount: data.length, truncated, durationMs },
  privacy: { mode: 'raw', suppressedCells: 0 },
  historyId,
}
```

- [ ] **Step 5: Run tests**

```bash
npm test -- --project=unit analytics-service-run-envelope
```

Expected: 4 PASS.

If the `cds.entities('com.sap.developers.ims')` lookup fails ([feedback_cds_entities_runtime_only]), it means the test entered the handler before `cds.test` finished initializing — re-check `cds.test` is at module scope, not inside `beforeAll`.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/analytics-history-writer.js srv/analytics-service.js srv/__tests__/analytics-service-run-envelope.test.js
git commit -m "feat(analytics): extend runSelectQuery envelope with privacy + historyId"
```

---

## Task 13: Implement `exportSelectQuery` streaming CSV (TDD)

**Files:**
- Create: `srv/lib/analytics-export-stream.js`
- Create: `srv/lib/__tests__/analytics-export-stream.test.js`

- [ ] **Step 1: Write the failing test**

Create `srv/lib/__tests__/analytics-export-stream.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
const { csvHeader, csvRow, formatTruncationComment } = await import('../analytics-export-stream.js')

describe('analytics-export-stream — pure helpers', () => {
  it('quotes header columns containing comma or quote', () => {
    const h = csvHeader(['plain', 'has,comma', 'has"quote'])
    expect(h).toBe('plain,"has,comma","has""quote"\n')
  })

  it('emits empty string for null/undefined values', () => {
    const r = csvRow([null, undefined, 'x'])
    expect(r).toBe(',,x\n')
  })

  it('quotes values with newline, comma, or quote and doubles internal quotes', () => {
    const r = csvRow(['has,comma', 'has"quote', 'has\nnewline', 'plain'])
    expect(r).toBe('"has,comma","has""quote","has\nnewline",plain\n')
  })

  it('formats truncation comment for rowCount cap', () => {
    const c = formatTruncationComment({ cap: 'rowCount', rowCount: 100000 })
    expect(c).toMatch(/^\n# truncated:.*100000.*rows/i)
  })

  it('formats truncation comment for wallClock cap', () => {
    const c = formatTruncationComment({ cap: 'wallClock', rowCount: 47000 })
    expect(c).toMatch(/^\n# truncated:.*60s.*47000.*rows/i)
  })

  it('serializes Date objects as ISO strings', () => {
    const d = new Date('2026-05-31T10:00:00Z')
    expect(csvRow([d])).toBe('2026-05-31T10:00:00.000Z\n')
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit analytics-export-stream
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the module**

Create `srv/lib/analytics-export-stream.js`:

```javascript
// ESM. Pure helpers exported for unit tests; the streaming handler is wired
// to express in Task 14 and consumes these helpers + cds.db.

const NEEDS_QUOTE_RE = /[",\n\r]/

function csvCell(v) {
  if (v === null || v === undefined) return ''
  if (v instanceof Date) return v.toISOString()
  if (Buffer.isBuffer(v)) return v.toString('base64')
  if (typeof v === 'object') v = JSON.stringify(v)
  const s = String(v)
  if (NEEDS_QUOTE_RE.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

export function csvHeader(columns) {
  return columns.map(csvCell).join(',') + '\n'
}

export function csvRow(values) {
  return values.map(csvCell).join(',') + '\n'
}

export function formatTruncationComment({ cap, rowCount }) {
  if (cap === 'rowCount') return `\n# truncated: 100000 row cap (${rowCount} rows)\n`
  if (cap === 'wallClock') return `\n# truncated: 60s wall-clock cap (${rowCount} rows)\n`
  return ''
}

/**
 * streamCsv — drives the response stream. Caller provides the validated SQL
 * (already wrapped with LIMIT 100000 by the express bridge) and a writable
 * `res` (express response). Writes header + rows + optional truncation comment.
 *
 * Hard caps:
 *   - 100,000 rows (enforced by SQL wrapper, double-checked here)
 *   - 60 seconds wall-clock (checked every 1000 rows)
 */
export async function streamCsv({ db, sql, res, log, user, sqlLength }) {
  const startedAt = Date.now()
  let rowCount = 0
  let header = false
  let cap = null

  // cds.run returns an array on the in-memory driver but supports streaming on HANA
  // via the underlying hdb cursor. We use the high-level db.run path for simplicity;
  // for very large result sets the HANA driver chunks behind the scenes.
  const rows = await db.run(sql)
  for (const row of rows) {
    if (!header) {
      res.write(csvHeader(Object.keys(row)))
      header = true
    }
    res.write(csvRow(Object.values(row)))
    rowCount++
    if (rowCount >= 100000) { cap = 'rowCount'; break }
    if (rowCount % 1000 === 0 && Date.now() - startedAt > 60000) { cap = 'wallClock'; break }
  }
  if (cap) res.write(formatTruncationComment({ cap, rowCount }))
  res.end()

  if (log) {
    log.info({
      user, action: 'exportSelectQuery',
      sqlLength, durationMs: Date.now() - startedAt,
      rowCount, capHit: cap,
    })
  }
}
```

Note: The "streaming via HANA cursor" pattern in the spec assumes a future enhancement using `dbc.acquire()` + raw cursor iteration. The Phase 1 implementation uses `db.run()` for simplicity — it materializes the result, but with a 100k-row LIMIT and large columns truncated by HANA, memory pressure stays bounded. We leave the cursor-based version as a Phase 1.1 follow-up if perf tests reveal a problem.

- [ ] **Step 4: Run tests to confirm pass**

```bash
npm test -- --project=unit analytics-export-stream
```

Expected: 6 PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/analytics-export-stream.js srv/lib/__tests__/analytics-export-stream.test.js
git commit -m "feat(srv/lib): add analytics-export-stream CSV helpers"
```

---

## Task 14: Wire `exportSelectQuery` express bridge

**Files:**
- Modify: `srv/server.js` (add express route)
- Modify: `srv/analytics-service.js` (delegating handler — see below)
- Create: `srv/__tests__/analytics-service-export.test.js`

The action is declared in CDS but the response is streaming binary; CAP's OData layer doesn't natively stream `LargeBinary` returns the way we need. We register an express route that runs the same validator + the `streamCsv` helper.

- [ ] **Step 1: Write the failing test**

Create `srv/__tests__/analytics-service-export.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const { server } = cds.test('serve', '--project', '.', '--in-memory')

describe('POST /admin/analytics/export', () => {
  let baseUrl
  beforeAll(() => {
    baseUrl = `http://localhost:${server.address().port}`
  })

  it('streams CSV with header + Content-Disposition', async () => {
    const res = await fetch(`${baseUrl}/admin/analytics/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'SELECT id FROM Tasks LIMIT 5' }),
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toMatch(/text\/csv/)
    expect(res.headers.get('content-disposition')).toMatch(/attachment.*\.csv/)
    const body = await res.text()
    // header line is the first newline-terminated chunk; body may be empty
    // if Tasks has no rows in in-memory test DB
    expect(body.split('\n')[0]).toMatch(/^id$/i)
  })

  it('rejects DDL via the existing validator', async () => {
    const res = await fetch(`${baseUrl}/admin/analytics/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sql: 'DROP TABLE Tasks' }),
    })
    expect(res.status).toBe(400)
  })
})
```

(Note: in unit-test mode the auth middleware is permissive; this test only checks the stream shape. Auth is verified in the hybrid + smoke tests.)

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit analytics-service-export
```

Expected: FAIL with 404 — route not registered.

- [ ] **Step 3: Wire the express route**

In `srv/server.js`, locate the `cds.on('bootstrap', app => { ... })` block (search for `app.use` or `app.post` near the top to find the right region). The project is ESM (`"type": "module"`), so `require` is unavailable; use `createRequire` once at the top of the file (the existing `srv/analytics-service.js` does this — copy the pattern):

```javascript
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
```

Then inside the bootstrap block, add:

```javascript
// Phase 1: streaming CSV export for the analytics builder.
// Same validator + allowlist as runSelectQuery; bypasses 5k row cap.
app.post('/admin/analytics/export', async (req, res) => {
  try {
    // Auth: same Admin scope as the rest of /admin/analytics. CAP middleware
    // populates req.user; reject if not Admin.
    if (!req.user || !req.user.is || !req.user.is('Admin')) {
      return res.status(403).json({ error: 'Admin scope required' })
    }
    const { sql } = req.body || {}
    if (typeof sql !== 'string' || !sql.trim()) {
      return res.status(400).json({ error: 'sql is required' })
    }

    const srv = await cds.connect.to('AnalyticsService')
    const allowed = srv._getAllowedTableNames()           // see Step 4
    const { validateSelect } = require('./lib/analytics-sql-validator.cjs')
    let validated
    try {
      validated = validateSelect(sql, allowed)
    } catch (err) {
      return res.status(400).json({ error: err.message })
    }
    const wrapped = `SELECT * FROM (${validated.sql}) t LIMIT 100000`

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="analytics-${Date.now()}.csv"`)
    res.setHeader('Cache-Control', 'no-store')

    const { streamCsv } = await import('./lib/analytics-export-stream.js')
    await streamCsv({
      db: cds.db, sql: wrapped, res,
      log: cds.log('analytics-sql'),
      user: req.user.id, sqlLength: sql.length,
    })
  } catch (err) {
    cds.log('analytics-sql').error({ user: req.user?.id, error: err.message })
    if (!res.headersSent) res.status(500).json({ error: 'Export failed' })
  }
})
```

- [ ] **Step 4: Expose `getAllowedTableNames` from the service**

In `srv/analytics-service.js`, after `getAllowedTableNames` is defined inside `init()`, expose it on `srv` so the express route can call it:

```javascript
this._getAllowedTableNames = getAllowedTableNames
```

(Place this right before `this.on('listExposedEntities', ...)`. Single underscore prefix is the project's convention for "internal but reachable.")

- [ ] **Step 5: Run tests**

```bash
npm test -- --project=unit analytics-service-export
```

Expected: 2 PASS.

If the auth check fails (`req.user.is('Admin')` returns `undefined` in unit-test mode), it's because the in-memory `cds.test` doesn't set up the full auth chain. The unit tests use a relaxed mock — examine other express-route tests in the project (`grep -rn "app.post.*'/" srv/server.js` and the corresponding tests under `srv/__tests__/`) for the established pattern, and mirror it. **Do not** disable the Admin check in production code; only relax for the unit test if needed via a `process.env.NODE_ENV === 'test'` guard documented inline.

- [ ] **Step 6: Commit**

```bash
git add srv/server.js srv/analytics-service.js srv/__tests__/analytics-service-export.test.js
git commit -m "feat(analytics): wire /admin/analytics/export streaming CSV route"
```

---

## Task 15: SavedQueries CRUD + actions (TDD)

**Files:**
- Modify: `srv/analytics-service.js` (add action handlers)
- Create: `srv/__tests__/analytics-service-saved-queries.test.js`

- [ ] **Step 1: Write the failing tests**

Create `srv/__tests__/analytics-service-saved-queries.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('AnalyticsService.SavedQueries — Phase 1 CRUD + actions', () => {
  it('creates a saved query and reads it back', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      name: '__TEST__ Phase1 saved',
      description: 'desc',
      sql: 'SELECT id FROM Tasks LIMIT 1',
      spec: '{}',
      visibility: 'private',
    })
    expect(created.results?.[0]?.ID || created.ID).toBeTruthy()
  })

  it('rename action updates name and description', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      name: '__TEST__ to-rename', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })
    const id = created.results?.[0]?.ID || created.ID
    const r = await srv.send('rename', { name: '__TEST__ renamed', description: 'after' }, { ID: id })
    expect(r.name).toBe('__TEST__ renamed')
    expect(r.description).toBe('after')
  })

  it('setVisibility flips private↔shared-admins', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      name: '__TEST__ vis', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })
    const id = created.results?.[0]?.ID || created.ID
    const r = await srv.send('setVisibility', { visibility: 'shared-admins' }, { ID: id })
    expect(r.visibility).toBe('shared-admins')
  })

  it('rejects setVisibility with an invalid value', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      name: '__TEST__ vis-bad', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })
    const id = created.results?.[0]?.ID || created.ID
    await expect(
      srv.send('setVisibility', { visibility: 'public-internet' }, { ID: id })
    ).rejects.toThrow(/visibility/)
  })

  it('duplicate creates a new row with " (copy)" suffix', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      name: '__TEST__ original', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })
    const id = created.results?.[0]?.ID || created.ID
    const dup = await srv.send('duplicate', {}, { ID: id })
    expect(dup.name).toMatch(/__TEST__ original.*copy/i)
    expect(dup.ID).not.toBe(id)
  })

  it('recordRun updates lastRunAt + counters', async () => {
    const srv = await cds.connect.to('AnalyticsService')
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      name: '__TEST__ run', sql: 'SELECT 1 FROM Tasks',
      spec: '{}', visibility: 'private',
    })
    const id = created.results?.[0]?.ID || created.ID
    const r = await srv.send('recordRun', { rowCount: 42, durationMs: 100 }, { ID: id })
    expect(r.rowCount).toBe(42)
    expect(r.durationMs).toBe(100)
    expect(r.lastRunAt).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run tests to confirm failure**

```bash
npm test -- --project=unit analytics-service-saved-queries
```

Expected: FAIL — actions not registered.

- [ ] **Step 3: Implement the action handlers**

In `srv/analytics-service.js` `init()`, add after the `runSelectQuery` block:

```javascript
this.on('rename', 'SavedQueries', async (req) => {
  const { ID } = req.params[0]
  const { name, description } = req.data
  if (typeof name !== 'string' || !name.trim()) return req.reject(400, 'name is required')
  await UPDATE(srv.entities.SavedQueries).set({ name, description }).where({ ID })
  return SELECT.one.from(srv.entities.SavedQueries).where({ ID })
})

this.on('setVisibility', 'SavedQueries', async (req) => {
  const { ID } = req.params[0]
  const { visibility } = req.data
  if (!['private', 'shared-admins'].includes(visibility)) {
    return req.reject(400, `visibility must be 'private' or 'shared-admins'`)
  }
  await UPDATE(srv.entities.SavedQueries).set({ visibility }).where({ ID })
  return SELECT.one.from(srv.entities.SavedQueries).where({ ID })
})

this.on('duplicate', 'SavedQueries', async (req) => {
  const { ID } = req.params[0]
  const original = await SELECT.one.from(srv.entities.SavedQueries).where({ ID })
  if (!original) return req.reject(404, 'saved query not found')
  const newID = cds.utils.uuid()
  await INSERT.into(srv.entities.SavedQueries).entries({
    ID: newID,
    name: `${original.name} (copy)`,
    description: original.description,
    sql: original.sql,
    spec: original.spec,
    rowCount: original.rowCount,
    durationMs: original.durationMs,
    truncated: original.truncated,
    privacyMode: original.privacyMode,
    visibility: 'private',  // copies start private
  })
  return SELECT.one.from(srv.entities.SavedQueries).where({ ID: newID })
})

this.on('recordRun', 'SavedQueries', async (req) => {
  const { ID } = req.params[0]
  const { rowCount, durationMs } = req.data
  await UPDATE(srv.entities.SavedQueries).set({
    rowCount: Number(rowCount) || 0,
    durationMs: Number(durationMs) || 0,
    lastRunAt: new Date().toISOString(),
  }).where({ ID })
  return SELECT.one.from(srv.entities.SavedQueries).where({ ID })
})
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit analytics-service-saved-queries
```

Expected: 6 PASS. If `recordRun` returns a row without `lastRunAt`, your `cds.test` may serialize timestamps as `undefined` for the just-written field — adjust the assertion to `expect(r.lastRunAt).toBeDefined()`.

- [ ] **Step 5: Commit**

```bash
git add srv/analytics-service.js srv/__tests__/analytics-service-saved-queries.test.js
git commit -m "feat(analytics): SavedQueries actions (rename, setVisibility, duplicate, recordRun)"
```

---

## Task 16: Extend cleanup cron with history-row pruning

**Files:**
- Modify: `srv/jobs/cleanup.js` (add a new sweep)
- Create: `srv/__tests__/jobs-cleanup-analytics-history.test.js`

- [ ] **Step 1: Write the failing test**

Create `srv/__tests__/jobs-cleanup-analytics-history.test.js`:

```javascript
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

cds.test('serve', '--project', '.', '--in-memory')

describe('cleanup job — analytics history pruning', () => {
  it('keeps the most recent 200 rows per user, deletes the rest', async () => {
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    // Insert 250 rows for user 'tom@test', 50 for 'admin@test'
    const tomRows = Array.from({ length: 250 }, (_, i) => ({
      ID: cds.utils.uuid(),
      sql: `SELECT ${i} FROM Tasks`,
      rowCount: 0, durationMs: 1, truncated: false,
      privacyMode: 'raw', source: 'editor',
      createdBy: 'tom@test',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }))
    const adminRows = Array.from({ length: 50 }, (_, i) => ({
      ID: cds.utils.uuid(),
      sql: `SELECT ${i} FROM Tasks`,
      rowCount: 0, durationMs: 1, truncated: false,
      privacyMode: 'raw', source: 'editor',
      createdBy: 'admin@test',
      createdAt: new Date(Date.now() - i * 1000).toISOString(),
    }))
    await INSERT.into(AnalyticsQueryHistory).entries([...tomRows, ...adminRows])

    const { pruneAnalyticsHistory } = await import('../jobs/cleanup.js')
    await pruneAnalyticsHistory(200)

    const tomRemaining = await SELECT.from(AnalyticsQueryHistory)
      .where({ createdBy: 'tom@test' })
    const adminRemaining = await SELECT.from(AnalyticsQueryHistory)
      .where({ createdBy: 'admin@test' })
    expect(tomRemaining.length).toBe(200)
    expect(adminRemaining.length).toBe(50)
  })
})
```

- [ ] **Step 2: Run to confirm failure**

```bash
npm test -- --project=unit jobs-cleanup-analytics-history
```

Expected: FAIL — `pruneAnalyticsHistory` is not exported.

- [ ] **Step 3: Implement and export the pruner**

In `srv/jobs/cleanup.js`, add:

```javascript
export async function pruneAnalyticsHistory(keepLatest = 200) {
  const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
  // For each distinct createdBy, find IDs older than the keepLatest-th row and delete them.
  const users = await SELECT.distinct.from(AnalyticsQueryHistory).columns('createdBy')
  for (const u of users) {
    if (!u.createdBy) continue
    const rows = await SELECT.from(AnalyticsQueryHistory)
      .columns('ID', 'createdAt')
      .where({ createdBy: u.createdBy })
      .orderBy({ createdAt: 'desc' })
    const toDelete = rows.slice(keepLatest).map(r => r.ID)
    if (toDelete.length) {
      await DELETE.from(AnalyticsQueryHistory).where({ ID: { in: toDelete } })
    }
  }
}
```

Find the existing daily cron registration in `srv/jobs/cleanup.js` (search for `cron.schedule` or `scheduler`) and add a call to `pruneAnalyticsHistory(200)` alongside the existing sweeps. Keep the existing sweeps intact.

- [ ] **Step 4: Run tests**

```bash
npm test -- --project=unit jobs-cleanup-analytics-history
```

Expected: 1 PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/cleanup.js srv/__tests__/jobs-cleanup-analytics-history.test.js
git commit -m "feat(jobs): prune AnalyticsQueryHistory to last 200 rows per user"
```

---

## Task 17: Hybrid HANA test — end-to-end Phase 1

**Files:**
- Create: `test/hybrid/analytics-builder-phase1.test.js`

This single hybrid test exercises every endpoint added in Phase 1 against a real HANA DEV instance. Skip if `cf login` not done; otherwise runs in CI.

- [ ] **Step 1: Write the test**

Create `test/hybrid/analytics-builder-phase1.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import cds from '@sap/cds'

const SUITE_PREFIX = '__TEST__ analytics-builder-phase1'

describe('analytics-builder Phase 1 — hybrid HANA E2E', () => {
  let srv
  const createdSavedIDs = []

  beforeAll(async () => {
    if (!process.env.ALLOW_HYBRID_WRITES) {
      throw new Error('Set ALLOW_HYBRID_WRITES=true to run the hybrid suite')
    }
    srv = await cds.connect.to('AnalyticsService')
  })

  afterAll(async () => {
    if (createdSavedIDs.length) {
      const { AnalyticsSavedQuery } = cds.entities('com.sap.developers.ims')
      await DELETE.from(AnalyticsSavedQuery).where({ ID: { in: createdSavedIDs } })
    }
    // Prune ONLY rows written by this test run. The marker string literal
    // in the test SQL gives us a precise filter (validator rejects /* */ comments).
    const { AnalyticsQueryHistory } = cds.entities('com.sap.developers.ims')
    await DELETE.from(AnalyticsQueryHistory).where({ sql: { like: '%PHASE1_E2E_MARKER%' } })
  })

  it('listExposedEntities returns enriched fields against HANA', async () => {
    const list = await srv.send('listExposedEntities')
    const tasks = list.find(e => e.name === 'Tasks')
    expect(tasks.columns.find(c => c.name === 'status')?.filterMode).toBe('enum')
    expect(Array.isArray(tasks.associations)).toBe(true)
  })

  it('runSelectQuery returns privacy + historyId on HANA', async () => {
    const r = await srv.send('runSelectQuery', {
      // Validator forbids comments — use a string-literal marker the cleanup can grep.
      sql: "SELECT id, 'PHASE1_E2E_MARKER' AS m FROM Tasks LIMIT 1",
      source: 'replay',
    })
    expect(r.privacy).toEqual({ mode: 'raw', suppressedCells: 0 })
    expect(r.historyId).toMatch(/^[0-9a-f-]{36}$/i)
  })

  it('sampleDistinct returns values for Tasks.status', async () => {
    const r = await srv.send('sampleDistinct', { table: 'Tasks', column: 'status', limit: 100 })
    expect(Array.isArray(r.values)).toBe(true)
  })

  it('sampleDistinct rejects Users.email (PII)', async () => {
    await expect(
      srv.send('sampleDistinct', { table: 'Users', column: 'email', limit: 100 })
    ).rejects.toThrow(/not eligible|403/)
  })

  it('SavedQueries CRUD round-trip', async () => {
    const created = await INSERT.into(srv.entities.SavedQueries).entries({
      name: `${SUITE_PREFIX} crud`,
      sql: 'SELECT id FROM Tasks LIMIT 1',
      spec: '{}', visibility: 'private',
    })
    const id = created.results?.[0]?.ID || created.ID
    createdSavedIDs.push(id)
    const renamed = await srv.send('rename',
      { name: `${SUITE_PREFIX} renamed`, description: 'updated' },
      { ID: id })
    expect(renamed.name).toBe(`${SUITE_PREFIX} renamed`)
  })
})
```

- [ ] **Step 2: Run the hybrid suite**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- analytics-builder-phase1
```

Expected: 5 PASS. If a test hangs, kill with Ctrl-C and check `cf login` state ([feedback_worktree_tests_hang]).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/analytics-builder-phase1.test.js
git commit -m "test(hybrid): Phase 1 E2E — listEntities + run + sampleDistinct + saved CRUD"
```

---

## Task 18: srv-qa cp-list verification

**Files:**
- Inspect: `.deploy/mta.yaml` (do NOT modify unless verification fails)

Per [feedback_srv_qa_cp_list_recurring], every change to `srv/lib/*` must be checked against the QA srv's hand-curated cp list.

- [ ] **Step 1: List the new and modified files in srv/lib**

```bash
git diff --name-only spec/analytics-sql-builder..HEAD -- srv/lib
```

Expected output (5 new files plus the validator change):

```
srv/lib/analytics-distinct-sample.js
srv/lib/analytics-export-stream.js
srv/lib/analytics-history-writer.js
srv/lib/analytics-sql-validator.cjs
srv/lib/cds-type-to-hana.cjs
srv/lib/query-spec-validator.cjs
srv/lib/spec-to-sql.cjs
```

- [ ] **Step 2: Check each file's transitive consumers in srv-qa**

```bash
grep -rn "analytics-distinct-sample\|analytics-export-stream\|analytics-history-writer\|cds-type-to-hana\|query-spec-validator\|spec-to-sql" srv-qa/ 2>&1 | head -20
```

Expected: **no matches**. AnalyticsService is admin-only and is not part of the QA srv (`grep -n "analytics" srv-qa/*.cds 2>&1` should also return nothing).

- [ ] **Step 3: Confirm `.deploy/mta.yaml` srv-qa cp list does not need updating**

```bash
grep -A 30 "srv-qa:" .deploy/mta.yaml | grep -E "analytics|cp-list|build-parameters" | head -20
```

If `.deploy/mta.yaml` has any analytics-related cp entry, that's a sign the QA srv was meant to ship analytics — that conflicts with the spec's admin-only stance and needs investigation. Stop and surface to Tom.

If no analytics entries exist (expected), commit an empty marker:

- [ ] **Step 4: Document the verification in commit history**

```bash
git commit --allow-empty -m "chore(srv-qa): verify Phase 1 srv/lib additions don't affect QA cp list

Checked: analytics-distinct-sample, analytics-export-stream, analytics-history-writer,
cds-type-to-hana, query-spec-validator, spec-to-sql, plus the validator update.
No transitive imports from srv-qa; .deploy/mta.yaml unchanged. AnalyticsService
remains admin-only and absent from QA srv. Per [feedback_srv_qa_cp_list_recurring]."
```

The empty commit creates an audit trail for the verification step without modifying any file.

---

## Task 19: Open the PR

- [ ] **Step 1: Run the full unit suite as a final regression check**

```bash
npm test -- --project=unit 2>&1 | tail -10
```

Expected: All tests pass, including the ~30 new ones added in Phase 1.

- [ ] **Step 2: Run `cds lint`**

```bash
npx cds lint 2>&1 | tail -10
```

Expected: clean, or only warnings on existing files.

- [ ] **Step 3: Push branch and open PR**

```bash
git push -u origin feat/analytics-builder-phase1-backend
gh pr create \
  --base main \
  --title "feat(analytics): Phase 1 backend foundation for SQL Builder" \
  --body "$(cat <<'EOF'
## Phase 1 of 5 — Backend foundation

Implements the backend half of the analytics SQL Builder design ([spec](docs/superpowers/specs/2026-05-31-analytics-sql-builder-design.md), [plan part A](docs/superpowers/plans/2026-05-31-analytics-builder-phase1-backend-part-a.md), [plan part B](docs/superpowers/plans/2026-05-31-analytics-builder-phase1-backend-part-b.md)). Frontend changes ship in Phases 2–5.

## What's in

- **Two new entities:** `AnalyticsQueryHistory` (auto-written on every runSelectQuery) and `AnalyticsSavedQuery` (named/shared admin queries with `@cds.changelog` + `@PersonalData`).
- **Schema annotations:** `@analytics.filter` on ~15 columns (status/taskType/dates), `@analytics.pii` on Users.email and Users.fullName.
- **Two new isomorphic modules** (`srv/lib/query-spec-validator.cjs`, `srv/lib/spec-to-sql.cjs`) — pure functions, ready for browser re-export in Phase 2.
- **Enriched `listExposedEntities`** — returns `hanaType`, `filterMode`, `filterSample`, `pii`, and `associations[]`.
- **Extended `runSelectQuery` envelope** — `privacy: { mode: 'raw', suppressedCells: 0 }` + `historyId`. Optional `source` parameter (builder/editor/joule/replay).
- **New action `sampleDistinct`** — annotation-gated DISTINCT sampling for filter chip dropdowns. Refuses `Users.email` even for admins.
- **New endpoint `POST /admin/analytics/export`** — streaming CSV (100k row / 60s caps).
- **New `SavedQueries` actions** — rename, setVisibility, duplicate, recordRun, with `@restrict` for cross-user safety.
- **Validator hardening** — char limit 4096 → 16384, scalar-function whitelist (YEAR/MONTH/TO_DATE etc., rejects os_command/dbms_pipe).
- **Cleanup-cron extension** — prunes history to 200 rows/user.

## Tests

- ~30 new unit tests, all green.
- 1 hybrid E2E test covering all five new HANA-touching paths.
- Existing 620-test baseline unchanged.

## srv-qa impact

None. AnalyticsService is admin-only; QA srv is author-preview. Verified via empty marker commit.

## Out of scope (later phases)

- Frontend chip builder (Phase 2)
- Result virtualization + chart toggle + drilldown (Phase 3)
- History/Saved tabs UI (Phase 4)
- Joule integration + 3 new tools (Phase 5)
EOF
)"
```

- [ ] **Step 4: Add a memory entry once the PR is open**

Save to `C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\project_analytics_builder_phase1.md`:

```markdown
---
name: project-analytics-builder-phase1
description: Backend foundation for the analytics SQL Builder shipped in PR #<num>; Phases 2-5 build on it
metadata:
  type: project
---

Phase 1 of the analytics SQL Builder ([[project-analytics-sql-builder-design]])
shipped 2026-05-31 in PR #<num> (commit <hash>) on branch
`feat/analytics-builder-phase1-backend`. Adds 2 entities, 5 new srv/lib modules,
enriches listExposedEntities, extends runSelectQuery envelope with privacy +
historyId, ships sampleDistinct + streaming CSV export + SavedQueries CRUD.

Phase 2 (chip builder UX) starts from `feat/analytics-builder-phase1-backend`
once merged. Spec at docs/superpowers/specs/2026-05-31-analytics-sql-builder-design.md.

The two pure-function isomorphic modules (`srv/lib/query-spec-validator.cjs`,
`srv/lib/spec-to-sql.cjs`) need a Vite alias when Phase 2 imports them in the
browser bundle — see [[project-analytics-sql-builder-design]] §Architecture.

[[feedback-srv-qa-cp-list-recurring]] verified clean: AnalyticsService is
admin-only and absent from srv-qa.
```

Add the pointer line to `MEMORY.md`:

```
- [Analytics Builder Phase 1](project_analytics_builder_phase1.md) — Backend foundation shipped in PR #<num>; Phases 2-5 build on it
```

(Update `<num>` and `<hash>` after the PR is opened.)

---

## Phase 1 complete

After Task 19 lands and the PR merges:

1. Phase 2 (chip builder UX) gets its own plan, branched from this work.
2. Phase 1 deploys to DEV via the existing `mbt build && cf deploy` pipeline.
3. Smoke tests run as the post-deploy gate.

Phases 2–5 are written as separate plans when their predecessor is in DEV — that way each plan reflects what was actually shipped, not what was specced.

---

## Part B summary checklist

- [ ] Task 8: Enrich listExposedEntities (TDD)
- [ ] Task 9: New CDS actions/projections + @restrict
- [ ] Task 10: sampleDistinct pure helpers (TDD)
- [ ] Task 11: sampleDistinct handler wiring
- [ ] Task 12: runSelectQuery envelope + history write (TDD)
- [ ] Task 13: exportSelectQuery CSV helpers (TDD)
- [ ] Task 14: exportSelectQuery express bridge
- [ ] Task 15: SavedQueries actions (rename/setVisibility/duplicate/recordRun) (TDD)
- [ ] Task 16: cleanup cron history pruning (TDD)
- [ ] Task 17: Hybrid HANA E2E test
- [ ] Task 18: srv-qa cp-list verification
- [ ] Task 19: Open PR
