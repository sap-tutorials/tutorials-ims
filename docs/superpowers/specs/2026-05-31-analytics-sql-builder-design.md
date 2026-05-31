# Analytics Explorer SQL Query Builder + Joule — Design

**Date:** 2026-05-31
**Status:** Design approved; ready for implementation plan
**Owner:** Tom Jung
**Surface:** `app/analytics-explorer/` SQL tab + `srv/analytics-service.*` + `srv/lib/chat-orchestrator.js`

## Summary

Replace the current bare-Monaco "SQL" tab in the Analytics Explorer with a **chip-driven visual query builder**, keep Monaco as an explicit escape hatch, and integrate **Joule** as a persistent right-rail conversational panel. Joule can answer aggregate questions directly (with k-anonymity enforced) or generate a builder-fillable QuerySpec from natural language. Ship server-backed query history, named/shared saved queries, virtualized 5k-row result table with inline charting and per-row drilldown, and streaming CSV export beyond the result cap. All behind the existing `@requires: 'Admin'` scope; additive to the current envelope so old clients keep working.

## Context

The Analytics Explorer ([PR #37, 2026-05-23](https://github.com/sap-tutorials/tutorials-ims/pull/37)) shipped three tabs: **Explore** (drag-drop OData `$apply` chart builder, single-entity), **SQL** (bare Monaco editor + entity sidebar + flat HTML result table), **Dashboard** (localStorage-persisted grids). The SQL tab fills a real gap — joins, subqueries, raw row access — but it requires the user to write HANA SQL by hand.

Today's SQL tab is brittle in five ways: (1) no query history, (2) no result pagination beyond the inline 200-row cap, (3) errors surface only as a status-bar string, (4) no Joule integration despite chat infrastructure being live elsewhere, (5) no metadata beyond column names — no FK relationships for joins, no distinct-value sampling for filter values.

This design closes those gaps while preserving the existing security model: same allowlist validator (`srv/lib/analytics-sql-validator.cjs`), same SELECT-only enforcement, same 30s timeout, same admin scope.

## Goals

1. **No-SQL-needed primary path.** A user with no SQL knowledge can build join + filter + group + aggregate + order + limit queries entirely via clickable chips, run them, see the result, and export.
2. **SQL escape hatch preserved.** Power users can take over from the builder, edit the SQL directly in Monaco, and run unrestricted (subject to the existing validator).
3. **Joule as natural-language surface.** "Tasks completed per month last quarter" → either a direct k-anon answer in chat or a builder-fillable QuerySpec, user's choice.
4. **Audit-grade history + reuse.** Every query run is captured automatically; admins can name and share favorite queries with other admins.
5. **Privacy boundary visible.** Every result carries a clear badge: `Raw query — no privacy filter` (builder/editor path) vs `Privacy-filtered (k≥5) — N cells suppressed` (Joule's `analyticsQuery` path).
6. **Additive ship.** No feature flag; old clients work against new server, new client falls back gracefully against old server.

## Non-goals (v1)

- Window functions, CTEs.
- Cross-section drag (a SELECT can't become a GROUP BY by dragging).
- Result diff between two runs.
- Saving a chart definition (the Explore tab handles persistable charts).
- Drilldown stack deeper than 1 (drill-from-drilldown replaces, not nests).
- Per-cell editing in the result table.
- Per-tool rate limits in Joule (single counter for v1).
- New telemetry tables (using `cds.log('analytics')` for v1).
- Public-docs (VitePress) update — analytics is admin-only.

## Architecture & component map

The SQL tab becomes a chip-driven query builder + Monaco escape hatch + Joule conversational panel, all reading and writing the same canonical state shape (**QuerySpec**). Existing `runSelectQuery` validator/handler stay unchanged in their security contract; everything new is additive.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ SQL Tab                                                                      │
│ ┌──────────────────────────────────────────────────────┬──────────────────┐ │
│ │ Builder (chip bar)                                   │  💬 Joule        │ │
│ │  FROM Tasks · JOIN Users ON … · WHERE status=PENDING │  panel           │ │
│ │  · GROUP BY month · SELECT count(*) · ORDER BY · LIMIT│ (right column)  │ │
│ ├──────────────────────────────────────────────────────┤                  │ │
│ │ Live SQL preview (Monaco, read-only when builder is  │ messages,        │ │
│ │ source of truth)                                      │ "View in        │ │
│ ├──────────────────────────────────────────────────────┤  builder",       │ │
│ │ [Results | SQL Editor | History | Saved] tab strip   │ tool badges      │ │
│ │ ▶ Run    [● Raw / ● k-anon badge]    [Export CSV]    │                  │ │
│ │ Virtualized table · 5,000 row inline cap             │                  │ │
│ └──────────────────────────────────────────────────────┴──────────────────┘ │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Frontend modules — `app/analytics-explorer/`

| File | Purpose |
|---|---|
| `src/types/query-spec.ts` | TypeScript types for QuerySpec (canonical state shape) |
| `src/lib/spec-to-sql.ts` | Pure function `QuerySpec → string` (HANA-flavoured SQL) |
| `src/lib/spec-validator.ts` | In-browser validation via node-sql-parser (catches "ambiguous column not in GROUP BY" before Run) |
| `src/composables/useQuerySpec.ts` | Single source-of-truth state store; one `setSpec(spec)` mutation surface used by builder, Joule, history, saved queries, drilldown |
| `src/composables/useEntityGraph.ts` | Loads enriched entity metadata (columns + types + associations + filter modes) once; exposes derived "joinable to" lookups. **Caches `sampleDistinct(table, column)` results in-memory keyed by `${table}.${column}`, session-scoped (no TTL — reset on page reload).** |
| `src/components/builder/ClauseChipBar.vue` | The chip bar (FROM, JOINs, filter tree, GROUP BYs, SELECTs, ORDER BYs, LIMIT) |
| `src/components/builder/chips/*.vue` | One file per chip kind: FromChip, JoinChip, FilterChip, FilterGroupChip, GroupByChip, SelectChip, OrderByChip, LimitChip |
| `src/components/builder/SqlPreview.vue` | Read-only Monaco showing live-generated SQL |
| `src/components/results/ResultsTable.vue` | Virtualized table (replaces 200-row HTML table); right-click → drilldown |
| `src/components/results/ResultsChart.vue` | ECharts-based view toggle (auto-detect + manual override) |
| `src/components/results/PrivacyBadge.vue` | Renders `result.privacy` as a badge |
| `src/components/joule/JoulePanel.vue` | Right-rail chat: SSE consumer, message list, input, View-in-builder per message |
| `src/components/tabs/HistoryTab.vue` | Server-backed history list, click to load |
| `src/components/tabs/SavedQueriesTab.vue` | CRUD + sharing for saved queries |
| `src/components/tabs/SqlEditorTab.vue` | Existing Monaco editor, lifted into a tab; "Take over from builder" flips source-of-truth |
| `src/api/joule.ts` | SSE client to `/chat/stream` with `pageContext` plumbing |
| `src/api/saved-queries.ts` | CRUD calls to `/admin/analytics/SavedQueries` and `QueryHistory` |
| `src/api/export.ts` | Streaming download from `/admin/analytics/exportSelectQuery` |
| `src/api/distinct.ts` | `sampleDistinct(table, column)` for enum-mode filter chips |

### Backend modules — `srv/`

| File | Purpose |
|---|---|
| `srv/analytics-service.cds` | Adds `AnalyticsQueryHistory`/`AnalyticsSavedQuery` projections; `exportSelectQuery`, `sampleDistinct`; extends `listExposedEntities` with `hanaType`, `filterMode`, `associations` |
| `srv/analytics-service.js` | Handlers for new actions; `runSelectQuery` updated to write to history and return `{ privacy, historyId }` envelope |
| `srv/lib/spec-to-sql.cjs` | **Isomorphic** — same module re-exported via Vite alias for browser; deterministic spec → SQL |
| `srv/lib/query-spec-validator.cjs` | **Isomorphic** — referential integrity, op-vs-type compatibility, OR-group depth cap |
| `srv/lib/analytics-export-stream.js` | HANA cursor-based CSV streaming (constant memory; 100k-row / 60s caps) |
| `srv/lib/analytics-distinct-sample.js` | Annotation-gated distinct-value sampling |
| `srv/lib/chat-orchestrator.js` | Adds `generateAnalyticsQuery` and `explainAnalyticsResult` tools; `analyticsQuery` envelope extended with `privacy` |
| `srv/lib/chat-context.js` | Plumbs `pageContext.tool === 'analytics-builder'` and `pageContext.currentSpec` into the system prompt with QuerySpec schema as a few-shot |
| `db/schema-ext.cds` | Adds `@analytics.filter` annotations to ~15 columns; `@analytics.pii` on Users PII columns; declares `AnalyticsQueryHistory`/`AnalyticsSavedQuery` with `@PersonalData` + `@cds.changelog` |

### Auth model (unchanged contract)

- All `/admin/analytics/*` endpoints stay `@requires: 'Admin'`.
- Chat reaches Joule via existing `/chat/stream` SSE; analytics tool surface gated by `user.is('Admin')` in the orchestrator.
- Saved queries: `visibility: 'shared-admins'` is visible to anyone with the Admin scope; `'private'` is filtered by `createdBy = $user.id`. `@restrict` rules prevent cross-user UPDATE/DELETE.

### Key architectural property: one mutation surface

Every path that changes builder state — clicking a chip, Joule emitting a spec, loading from history, loading a saved query, importing edited SQL, drilldown, "Back to grouped query" — calls `useQuerySpec().setSpec(newSpec)`. Same path, same validation, same reactive derivation of the SQL preview. That property makes "View in builder," "Replay from history," and "Edit in Monaco" all trivial; it's also why drilldown (which is just `setSpec` with a stack push) is depth-1 in v1 with a clean upgrade path.

## QuerySpec data model

QuerySpec is the canonical state shape that the builder, Joule, history, saved queries, and the SQL generator all read and write. Anything that can be expressed as a chip in the bar maps to one node in QuerySpec, and vice versa.

```typescript
// src/types/query-spec.ts

export interface QuerySpec {
  version: 1                              // bump on breaking shape changes
  from: TableRef                          // exactly one root table
  joins: Join[]                           // 0..n; order matters (left-to-right composition)
  filterTree: FilterNode | null           // recursive AND/OR tree; null = no filters
  groupBy: GroupKey[]                     // 0..n explicit additional keys (auto-derived keys not stored here)
  select: SelectItem[]                    // 1..n; order = column order in result
  orderBy: OrderClause[]                  // 0..n
  limit: number | null                    // null = use server cap (5000)
}

export interface TableRef {
  entity: string                          // logical name from listExposedEntities (e.g. "Tasks")
  alias: string                           // auto-generated, immutable for chip lifetime ("t", "t2", "u")
}

export interface Join {
  id: string
  kind: 'inner' | 'left'                  // v1; 'right'/'full' deferred
  target: TableRef
  on: { leftRef: ColumnRef, rightRef: ColumnRef }   // single equality predicate in v1
}

export interface ColumnRef {
  alias: string                           // table alias, must already exist in spec
  column: string
}

export type FilterNode =
  | Filter                                // leaf
  | { id: string, kind: 'group',
      conjunction: 'and' | 'or',
      negated?: boolean,                  // NOT (...) wrapping
      children: FilterNode[] }            // 1..n; max nesting depth 4

export interface Filter {
  id: string
  ref: ColumnRef
  op: FilterOp                            // see below
  value: FilterValue
  negated?: boolean
}

export type FilterOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'in' | 'contains' | 'startsWith' | 'endsWith'
  | 'between' | 'isNull'
  | 'sinceDays' | 'inLastDays' | 'inCurrent'

export type FilterValue =
  | { kind: 'literal',  value: string | number | boolean | null }
  | { kind: 'list',     value: (string | number)[] }
  | { kind: 'range',    value: [string|number, string|number] }
  | { kind: 'relative', value: number, unit?: 'days' | 'months' | 'years' }
  | { kind: 'period',   value: 'day' | 'week' | 'month' | 'quarter' | 'year' }

// Valid (op, value.kind) pairs — enforced by query-spec-validator:
//   eq | neq | gt | gte | lt | lte | contains | startsWith | endsWith → 'literal'
//   in                                                                 → 'list'
//   between                                                            → 'range'
//   isNull                                                             → 'literal' with value === null
//   sinceDays | inLastDays                                             → 'relative'
//   inCurrent                                                          → 'period'

export interface GroupKey {
  id: string
  ref: ColumnRef
  // No bucketing in v1; achieved via SelectItem.kind='expression' re-using the alias here.
}

export type SelectItem =
  | { kind: 'column',      id: string, ref: ColumnRef, alias?: string }
  | { kind: 'aggregation', id: string, fn: AggFn, ref: ColumnRef | '*', distinct?: boolean, alias?: string }
  | { kind: 'expression',  id: string, sql: string, alias: string,
      referencedAliases: string[] }       // admin-typed escape hatch; whitelisted scalar functions only

export type AggFn = 'count' | 'sum' | 'avg' | 'min' | 'max'

export interface OrderClause {
  id: string
  by: { kind: 'selectId', id: string } | { kind: 'columnRef', ref: ColumnRef }
  direction: 'asc' | 'desc'
}
```

### Derivation rules

**Auto-GROUP BY.** Every SELECT chip that is **not** a `kind: 'aggregation'` becomes an implicit GROUP BY key, *unless* there are zero aggregation chips at all (raw-row mode — no GROUP BY emitted). The `groupBy` array in QuerySpec is the **explicit additional** group keys. The bar always renders both auto-derived (with `(auto)` subscript) and explicit GROUP BY chips; auto chips are read-only and managed via the corresponding SELECT chip.

When the user adds the *first* aggregation chip to a previously-raw query, a one-shot inline banner explains the auto-GROUP-BY: `ⓘ GROUP BY auto-added: t.event_ID, t.status. [ Show me ] [ Got it ]`. Stored in localStorage as seen so it never bothers the same admin twice.

**Alias generation.** `useQuerySpec.addJoin(entity)` allocates the next free alias: first letter of entity name lowercased, append counter if taken (`t`, `t2`, `u`, `m`, `m2`). Aliases are immutable once allocated — changing the underlying entity drops the chip and creates a new one with a new alias, so existing references get a clear "alias removed" validation error.

**Filter tree construction.** Top-level is always a `kind: 'group'` node (even with one child) so the UI always has a place to attach a conjunction toggle. Multi-select Ctrl/⌘-click on chips at the same level offers `Group these (AND) / (OR)`; ungroup lives in the bracket-chip's right-click menu. Wrapping in NOT is via the same group's chip-popover.

### Validation layers (in order)

1. **Static (pure, browser, every spec change)**: `src/lib/spec-validator.ts` — referential integrity (`ColumnRef.alias` exists), filter-op vs column-type compatibility, OR-group nesting depth ≤ 4, expression-chip parses with node-sql-parser. Errors attach to chip ids; offending chips render red.
2. **Generated SQL parse (browser)**: `spec-to-sql(spec)` runs through node-sql-parser; parse errors are dev-warning-level (indicates spec generator bug).
3. **Server-side**: `runSelectQuery` runs the generated SQL through `analytics-sql-validator.cjs` (allowlist, no DDL/DML, etc.). Same gate as today.

## Backend changes

### Schema additions — `db/schema-ext.cds`

```cds
namespace com.sap.developers.ims;
using { managed, cuid } from '@sap/cds/common';

aspect AnalyticsQueryShape {
  spec        : LargeString;             // JSON-stringified QuerySpec (v1 schema)
  sql         : LargeString;             // Rendered SQL at run time
  rowCount    : Integer;
  durationMs  : Integer;
  truncated   : Boolean default false;
  privacyMode : String(16);              // 'raw' | 'k-anon'
}

@PersonalData : { EntitySemantics: 'Other' }
@cds.autoexpose
entity AnalyticsQueryHistory : cuid, managed, AnalyticsQueryShape {
  source      : String(16);              // 'builder' | 'editor' | 'joule' | 'replay'
}
// History cap: existing daily cleanup cron (srv/jobs/cleanup.js) extended with
// a sweep that keeps the most recent 200 rows per createdBy; older rows hard-deleted.

@PersonalData    : { EntitySemantics: 'Other' }
@cds.changelog   : true
@cds.autoexpose
entity AnalyticsSavedQuery : cuid, managed, AnalyticsQueryShape {
  name        : String(120) not null;
  description : String(500);
  visibility  : String(16) default 'private';   // 'private' | 'shared-admins'
  lastRunAt   : Timestamp;
}
```

`@PersonalData` enables `@cap-js/audit-logging` to log read/write/anonymize automatically. `@cds.changelog: true` on saved queries surfaces edits in the existing changelog Fiori app.

**Filter-mode annotations** (~15 columns):

```cds
annotate Tasks with {
  status     @analytics.filter: { mode: 'enum', sample: true };
  taskType   @analytics.filter: { mode: 'enum', sample: true };
  event_ID   @analytics.filter: { mode: 'enum', sample: true };
  createdAt  @analytics.filter: { mode: 'date' };
  modifiedAt @analytics.filter: { mode: 'date' };
};
annotate TaskRecords with {
  status      @analytics.filter: { mode: 'enum', sample: true };
  completedAt @analytics.filter: { mode: 'date' };
};
annotate Missions with {
  slug @analytics.filter: { mode: 'enum', sample: true };
};
annotate Events with {
  slug     @analytics.filter: { mode: 'enum', sample: true };
  startsAt @analytics.filter: { mode: 'date' };
};
// All other columns: no annotation = default 'free' = text input, no DB sampling.
```

**PII annotations** (for client-side redaction before send to Joule):

```cds
annotate Users with {
  email    @analytics.pii: true;
  fullName @analytics.pii: true;
};
```

### Service additions — `srv/analytics-service.cds`

```cds
service AnalyticsService @(path: '/admin/analytics', requires: 'Admin') {

  function listExposedEntities() returns array of {
    name        : String;
    sqlName     : String;
    label       : String;
    description : String;
    columns     : array of {
      name        : String;
      type        : String;
      hanaType    : String;        // NEW
      nullable    : Boolean;
      length      : Integer;
      filterMode  : String;        // NEW: 'enum'|'free'|'date'|'numeric-range'
      filterSample: Boolean;       // NEW
      pii         : Boolean;       // NEW
    };
    associations: array of {       // NEW
      name           : String;
      targetEntity   : String;
      cardinality    : String;     // 'to-one' | 'to-many'
      onLocal        : array of String;
      onTarget       : array of String;
    };
  };

  action runSelectQuery(sql: String, source: String) returns {
    columns  : array of String;
    rows     : array of String;
    metadata : { rowCount: Integer; truncated: Boolean; durationMs: Integer };
    privacy  : { mode: String; suppressedCells: Integer };  // NEW
    historyId: UUID;                                         // NEW
  };

  function sampleDistinct(table: String, column: String, limit: Integer) returns {
    values   : array of String;
    truncated: Boolean;
  };

  action exportSelectQuery(sql: String) returns LargeBinary;

  @readonly entity QueryHistory as projection on AnalyticsQueryHistory
    where createdBy = $user;

  entity SavedQueries as projection on AnalyticsSavedQuery actions {
    action rename(name: String, description: String) returns SavedQueries;
    action setVisibility(visibility: String) returns SavedQueries;
    action duplicate() returns SavedQueries;
    action recordRun(rowCount: Integer, durationMs: Integer) returns SavedQueries;
  };
}

annotate AnalyticsService.SavedQueries with @restrict: [
  { grant: 'READ',              where: 'visibility = ''shared-admins'' or createdBy = $user' },
  { grant: ['CREATE'] },
  { grant: ['UPDATE','DELETE'], where: 'createdBy = $user' }
];
```

### Handler changes — `srv/analytics-service.js`

**`listExposedEntities` enrichment**: precise SQL type via existing `cdsTypeToHanaType` map; association metadata mined from `cds.model.definitions[entity].elements` where `element.target` is set and target is itself `@analytics.exposed`; filter-mode + pii fields read straight from column-level annotations (default `'free'`/`false`).

**`runSelectQuery` envelope changes**:

1. After validation + execution + serialization, INSERT a row into `AnalyticsQueryHistory` in the same transaction; capture `historyId`.
2. Return new envelope: existing `columns`/`rows`/`metadata` plus `privacy: { mode: 'raw', suppressedCells: 0 }` and `historyId`.
3. `source` parameter (`'builder' | 'editor' | 'joule' | 'replay'`) recorded on the history row. Drilldowns use `source: 'replay'`.

**`runSelectQuery` always returns `privacy.mode = 'raw'`.** Builder/editor paths never produce `'k-anon'` — only the chat orchestrator's `analyticsQuery` tool does, because k-anonymity is enforced at the structured-aggregate layer, not on raw SQL execution. The two modes are mutually exclusive in v1.

**`sampleDistinct(table, column, limit)`** — annotation-gated:

```js
async function sampleDistinct(req) {
  const { table, column, limit = 100 } = req.data;
  const allowed = getAllowedTableNames();
  if (!allowed.has(table.toLowerCase())) return req.reject(403, 'Table not exposed.');
  const meta = getColumnAnnotation(table, column);
  if (!meta || meta.filterMode !== 'enum' || !meta.sample) {
    return req.reject(403, `Column ${column} not eligible for distinct sampling.`);
  }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(column)) return req.reject(400, 'Bad column.');
  const cap = Math.min(Math.max(limit, 1), 200);
  const sql = `SELECT DISTINCT "${column}" AS V FROM ${qualified(table)} ORDER BY 1 LIMIT ${cap + 1}`;
  const rows = await db.run(sql);                // 30s timeout via Promise.race like runSelectQuery
  const truncated = rows.length > cap;
  return { values: rows.slice(0, cap).map(r => String(r.V ?? '')), truncated };
}
```

Even an admin can't sample `Users.email` because it doesn't carry `filterMode: 'enum'`. That's the schema-driven privacy boundary.

**`exportSelectQuery`** streams via HANA cursor (constant memory). Same validator as `runSelectQuery`, wrapped at `LIMIT 100000` instead of 5001. Hard caps: 100k rows AND 60s wall-clock; both surfaced as a comment line at the bottom of the CSV. No history row written for exports.

```js
async function streamCsv(req, res) {
  const { sql } = req.data;
  const validated = validateSelect(sql, getAllowedTableNames());
  const wrapped = `SELECT * FROM (${validated.sql}) t LIMIT 100000`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="analytics-${Date.now()}.csv"`);
  res.setHeader('Cache-Control', 'no-store');

  const startedAt = Date.now();
  const dbc = await cds.connect.to('db');
  const conn = await dbc.acquire();
  try {
    const stmt = await conn.prepare(wrapped);
    const cursor = await stmt.execute([]);
    let header = false, rowCount = 0;
    for await (const row of iterateRows(cursor)) {
      if (!header) { res.write(csvHeader(Object.keys(row))); header = true; }
      res.write(csvRow(Object.values(row)));
      rowCount++;
      if (rowCount % 1000 === 0 && Date.now() - startedAt > 60_000) {
        res.write(`\n# truncated: 60s wall-clock cap (${rowCount} rows)\n`);
        break;
      }
    }
    res.end();
    log.info({ user: req.user.id, sqlLength: sql.length, durationMs: Date.now() - startedAt, rowCount, action: 'exportSelectQuery' });
  } finally { await dbc.release(conn); }
}
```

### Validator updates — `srv/lib/analytics-sql-validator.cjs`

Two additive changes, no contract break:

1. **Char limit bump 4096 → 16384.** Chip-builder generates verbose qualified SQL.
2. **Whitelisted scalar functions** for expression-chip output: `YEAR`, `MONTH`, `DAY`, `TO_DATE`, `TO_VARCHAR`, `COALESCE`, `CASE`/`WHEN`/`THEN`/`ELSE`/`END`. Existing function-name allowlist extended; rejected function names (`os_command`, `dbms_pipe.*`) covered by existing tests.

The MySQL-parse / Postgresql-emit pattern (per `feedback_node_sql_parser_dialect`) is preserved.

### Chat-orchestrator additions — `srv/lib/chat-orchestrator.js`

**`generateAnalyticsQuery`** (new):

```jsonc
// input
{ "question": "tasks completed per month last quarter",
  "currentSpec": { /* QuerySpec | null */ },
  "intent": "new" | "refine" | "answer-then-refine" }

// output
{ "querySpec": { /* QuerySpec, version: 1 */ },
  "sql": "SELECT … FROM …",
  "explanation": "Filters tasks completed in the last 90 days, groups by completedAt month, counts.",
  "warnings": [ "Joins via Tasks.user_ID = Users.ID — confirm this is the right link table" ] }
```

Server-side wrapper:

1. LLM emits the structure (forced via tool-use).
2. Validate the QuerySpec via `query-spec-validator.cjs`. On failure: tool returns error string, LLM retries — capped at 1 retry.
3. **Re-derive SQL server-side** via the same `spec-to-sql` function. The LLM-provided `sql` is discarded — we never trust LLM-written SQL.
4. The generated SQL runs through `analytics-sql-validator.cjs`. The user is never offered a spec whose generated SQL the server would reject.
5. **`generateAnalyticsQuery` does NOT execute the query** — it only builds.

**`analyticsQuery`** (existing): envelope extended with `privacy: { mode: 'k-anon', k: 5, suppressedCells: N }` and `impliedSpec: QuerySpec`.

**`explainAnalyticsResult`** (new):

```jsonc
{ "question": "why are May counts so much higher?" }
// →
{ "explanation": "May contains the AAA event which …" }
```

Pulls `pageContext.lastResult` and `pageContext.currentSpec`; reasons grounded in that data; **does not call the DB**.

### Page context plumbing

`/chat/stream` request body for the SQL tab:

```jsonc
{ "kind": "admin",
  "tool": "analytics-builder",
  "currentSpec": { /* QuerySpec | null */ },
  "lastResult": {
    "columns": [{ "name": "month", "type": "string" }, …],
    "sampleRows": [ /* up to 50 rows */ ],
    "rowCount": 1247,
    "truncated": false,
    "privacy": { "mode": "raw" }
  } }
```

Constraints (defended client and server):

- `sampleRows` capped at 50.
- **PII redaction client-side** before send: columns with `@analytics.pii: true` → `[REDACTED]` in `sampleRows`. The LLM never sees PII via the result-shape channel.
- `currentSpec` capped at QuerySpec v1 size (~16 KB).
- No history or saved-queries content sent — only current spec + most recent result. No long-term memory across sessions.

`srv/lib/chat-context.js` adds an `analytics-builder` block to the system prompt: QuerySpec JSON schema, 5 few-shot examples, rules ("never invent table or column names; only use entities from the listExposedEntities response sent in this turn"), and the privacy contract. Block is ~800 tokens; cached via existing prompt cache.

## Frontend chip builder UX

### Layout

Always-visible chip bar at top; live SQL preview below; tab strip switches the bottom area between **Results** / **SQL Editor** / **History** / **Saved**. Joule panel is a persistent right-rail. Min supported width: 1280 px (desktop-only by design).

### Chip interaction model

Every chip is a button-shaped element showing a compact summary; **click opens a popover** with the full editor (per Q4 confirmation). ⊕ buttons add new chips. Right-click (and `⋯` menu icon on hover) gives Duplicate / Delete / Disable. Disabled chips render greyed and are skipped during SQL generation. Drag-reorder is supported within a clause section (JOINs, SELECTs); cross-section drag is **not** supported in v1.

Chip validity is rendered via a `Map<chipId, ValidationIssue[]>` derived from the spec each turn:

- Valid: default UI5 token style.
- Warning (e.g., auto-GROUP-BY change pending confirmation): amber border + tooltip.
- Error (e.g., references a removed alias): red border, popover opens to the offending field.

### Chip kinds (one popover per kind)

- **FROM** — Single chip, never deletable. Changing entity prompts confirmation (resets the query).
- **JOIN** — ⊕ enabled only when associations exist. Popover lists **suggested joins** first (from association metadata), custom join as fallback. Type: INNER / LEFT (v1).
- **Filter / FilterGroup** — Filter tree rendered as `WHERE ( ... AND ( ... OR ... ) )` with visible bracket chips. Bracket chips toggle conjunction (AND/OR), allow NOT-wrapping, and offer ungroup. Multi-select Ctrl/⌘-click on sibling chips offers `Group these (AND) / (OR)`. Max nesting depth 4. Filter chip popover renders different controls per `filterMode`:
  - `enum` + `sample: true`: column → operator → multi-select dropdown (lazy-loaded via `sampleDistinct`).
  - `date`: column → operator (between/before/after/sinceDays/inCurrent) → date picker / number input / period picker.
  - `numeric-range`: numeric inputs.
  - `free` (default): plain text input. Operator set restricted (no `in` for free-text — paste-the-spreadsheet attack vector).
- **GROUP BY** — Always visible (per Q4 amendment). Auto-derived chips marked `(auto)` and read-only; explicit chips editable. ⊕ adds an explicit key.
- **SELECT** — ⊕ quick-pick: column → aggregation → expression (third option a click further to make it path-of-most-friction). Aggregation popover: function (count/sum/avg/min/max), column or `*`, DISTINCT toggle, alias. Expression popover: monospace input, syntax-error indicator from node-sql-parser, required alias, ƒ icon on the chip.
- **ORDER BY** — Order by SELECT-item id (preferred — survives renames) or arbitrary column. Direction toggle. Multiple allowed; drag-reorder controls precedence.
- **LIMIT** — Single chip; number input + "use server cap (5000)" toggle.

### Live SQL preview

Monaco instance, **read-only**, ~8 lines visible (scrollable beyond). Re-renders on every `setSpec`. The same component is what the SQL Editor tab can promote to source-of-truth — under the hood, "Take over from builder" flips a `mode: 'builder' | 'editor'` ref in `useQuerySpec`. While in editor mode the chip bar greys out with a "← Return to builder (overwrites your edits)" link. One-way sync: builder → SQL is automatic; SQL → builder requires Joule's `generateAnalyticsQuery` round-trip or a user-confirmed discard gesture.

### Run / status / privacy badge

- **▶ Run button.** Disabled when spec has any error-level validation issue (warnings still allow run); tooltip lists offending chips. Hotkey `Ctrl/⌘ + Enter`.
- **Privacy badge.** From `result.privacy.mode`:
  - `'raw'` → grey-on-amber pill: `Raw query — no privacy filter`.
  - `'k-anon'` → green pill: `Privacy-filtered (k≥5) — N cells suppressed`.
  - No badge until first run completes.
- **Export CSV button.** Disabled while previous export is running. Cap-hit comments surfaced as a toast.
- **Status text.** `12 rows · 184 ms · history #h7f3` — the `historyId` is clickable, opens History tab pre-scrolled.

### Result tabs

**Results** — Replaces 200-row HTML table with virtualized `tanstack/vue-table` + virtual-scroll wrapper. Up to 5,000 rows. Column headers show name + inferred type. Right-click on a column header offers Sort / Hide / Copy column name. NULL renders as muted `∅`; LOB-ish strings truncate at 200 chars with expand affordance. Read-only.

The Results tab carries a **Table / Chart** view toggle:

- **Auto chart-type detection** reuses `useChartConfig.suggestChartType()` against the result columns.
- **Manual override** via ⚙ icon: small modal sets chart type, x-dim, y-measure, color-by.
- **Charting limits**: disabled when result rows > 10,000 OR when there's no numeric/temporal column. Tooltip explains.
- Privacy badge stays attached to the result envelope, renders above the chart.
- Chart config is **not** part of QuerySpec — ephemeral view setting. To save a chart definition, use the Explore tab.

**Per-row drilldown** — Right-click a result cell → "Drill into this row" (or column header `⋯` menu → "Drill into selected rows" for multi-row). Derivation:

1. Take current QuerySpec.
2. Strip every aggregation SELECT chip (and auto-derived GROUP BY keys that depended on them).
3. Add equality filters for every non-aggregation SELECT chip, keyed off the clicked row's value, in a fresh top-level AND group.
4. Replace SELECT with a `kind: 'column'` chip per non-aggregation column from the original.
5. Set fresh `LIMIT 200`.

Loaded into builder via `setSpec`; runs immediately. Banner: `↩ Drilldown view — showing rows behind {t.event_ID = evt-2026-01}. [ Back to grouped query ]`. Implemented as a depth-1 stack in `useQuerySpec` — drilling from inside a drilldown replaces, not nests. Drilldown queries get `source: 'replay'`.

Drilldown is disabled when:
- No aggregation chips in current spec (already showing raw rows).
- Spec uses an `expression`-kind SELECT chip (can't reverse `YEAR(t.createdAt)` to a row predicate).
- Clicked row has NULL in a column that would become a drilldown predicate.
- Query was sourced from SQL Editor in take-over mode.

**SQL Editor** — Existing Monaco editor lifted into a tab. Two modes: sync (mirrors builder, read-only) and take-over (editable, builder greys out, source-of-truth flips). Returning to builder from take-over discards SQL changes (we don't parse arbitrary HANA SQL back into QuerySpec).

**History** — Server-backed `AnalyticsQueryHistory` projection, reverse-chrono, paged 50 per page. Each row: timestamp, SQL summary (first 80 chars), source badge, row count, duration, privacy badge. Click → loads spec into builder, switches to Results tab. Right-click → "Save as…" promotes to `AnalyticsSavedQuery`. Search filters by SQL substring (client-side over loaded page; v2 adds full-text).

**Saved** — Same shape with name + description columns, no source badge, "Edit" button per row. Inline-editable name/description. Visibility dropdown (private / shared-admins). "Shared by Tom" byline on cross-admin queries. Sort by name / created / lastRunAt. The "Save current query" button lives in the **chip bar header**, not in this tab — saving doesn't require leaving the work surface.

### Loading states & errors

- Spec change → SQL preview: synchronous, no spinner.
- Run query: button shows spinner; result tab shows skeleton; cancel button after 5s via `AbortController`.
- Query error: structured error card above result table (red border, offending SQL line highlighted via `errorAt` if returned), with "Copy error to Joule" button that pre-fills chat input.
- Network errors: retried once with exponential backoff; second failure → inline retryable card.

### Theming, responsiveness, accessibility

- All chips use UI5 web components (`<ui5-token>`, `<ui5-popover>`, `<ui5-button>`) so Horizon light/dark Just Works via `useTheme`.
- Min width 1280; below 1024 a "switch to Explore" notice is shown. Joule panel collapses to icon rail at narrower widths.
- Every chip popover is keyboard-navigable (Tab cycles fields, Enter applies, Escape cancels). Run hotkey `Ctrl/⌘ + Enter`. Focus ring uses `--sapContent_FocusColor`.
- ARIA: clause sections are `role="region"`; chip bar is `role="toolbar"` with `aria-controls` pointing at SQL preview.

## Joule integration

The Joule panel is a persistent right-rail (Q3-A) with three narrow tools (Q9-B+C). Goal: turn natural language into either a direct k-anon answer (Q10-B inline, with "View in builder") or a builder-fillable QuerySpec, plus reason about results already on screen.

### Panel anatomy

Three message types, distinguished by leading icon:

- **ⓘ Generated query** — output of `generateAnalyticsQuery`. Renders QuerySpec as a compact chip-bar preview (read-only mini version of the same chip components). Buttons: `View in builder` (primary), `Show SQL ▾` (expands to rendered SQL), `Replace` / `Merge ▾`.
- **📊 Direct answer** — output of `analyticsQuery`. Inline mini-table or bullet list (≤10 rows; "and 47 more — view in builder" if larger). Always carries privacy badge: `🔒 k-anon (k≥5)` or `⚠ Raw — k-anon not applied`. `View in builder` button promotes the implicit QuerySpec.
- **💡 Explanation** — output of `explainAnalyticsResult`. Plain-text reasoning, no buttons.

Panel header has a small **context indicator** (`📎 Current spec sent · Last result ✓`) — hover reveals the exact JSON sent on the next message (debuggability + privacy transparency).

**Welcome chips** appear when conversation is empty: 4–5 hand-curated starter prompts pulled from `srv/lib/chat-context.js` admin examples. Click → fills input and submits.

### Replace vs Merge

When clicking `View in builder` with a non-empty current spec:

- **Replace** (button label `Replace`, primary): `setSpec(joule.spec)` overwrites everything. Default for empty / fresh-start.
- **Merge ▾** (dropdown, secondary): combines Joule's spec with current spec. Sub-options (only meaningful ones enabled):
  - `Add Joule's filters to my query` — concatenate filter children into top-level AND group.
  - `Replace my SELECT with Joule's` — keep from/joins/filters, swap SELECT + auto-GROUP-BY.
  - `Add Joule's joins` — add joined tables not already present.
- **Side-by-side** (in `⋯` menu): modal with diffed chip bars; user picks chips from each side via checkboxes.

First time the user clicks `View in builder` with a non-empty current spec, a one-shot tooltip explains the merge options.

### Tool surface

Three tools (Q9-B+C). Schemas defined inline in **Backend changes → Chat-orchestrator additions** (`generateAnalyticsQuery` input/output, `analyticsQuery` extended envelope, `explainAnalyticsResult`); spec validation shared via isomorphic `srv/lib/query-spec-validator.cjs`. Implementation lives in `srv/lib/chat-orchestrator.js`.

### SSE message protocol

Reuses existing SSE format. New messages are tool-use envelopes:

```
event: tool_use
data: { "tool": "generateAnalyticsQuery", "input": {...} }

event: tool_result
data: { "tool": "generateAnalyticsQuery", "output": {...} }

event: text
data: { "delta": "Filters tasks completed in the last…" }
```

`JoulePanel.vue` consumes the stream: text deltas append to current bubble; tool envelopes insert structured messages.

### Auth & rate limiting

- Same `/chat/stream` middleware: `contextMw → authMw → businessHandler`. `user.is('Admin')` gates analytics tool surface.
- Existing `maxRequestsPerUser` from `ChatSettings`. Per-tool counters logged but not enforced separately in v1 (one config setting beats five).
- All three tool calls write to `cds.log('analytics')` with `{ user, tool, durationMs, sqlLength, rowCount, suppressedCells, source: 'joule' }`.

### Error & uncertainty handling

- LLM emits invalid QuerySpec → wrapper retries once with validator error appended; second failure → soft error bubble.
- Generated SQL rejected by `analytics-sql-validator.cjs` → same path.
- `analyticsQuery` cannot answer → orchestrator falls back to `generateAnalyticsQuery` automatically; message rendered as "I couldn't compute that directly, but here's a query that should work — review and run."
- Joule timeout / SSE drop → existing reconnect logic; partial messages kept as draft bubbles.
- K-anon suppression cleared every cell → "All cells fall below the privacy floor (k≥5). Try grouping more broadly or filtering to a larger cohort." with `[ Refine query ]` button.

### Empty / disabled states

- Empty: welcome chips.
- `ChatSettings.ragEnabled = false` / Joule disabled: panel renders inline notice "Joule is disabled for this workspace. Use the chip builder." Tab still works; panel collapses to 32-px icon rail.
- Admin on viewport < 1280: panel collapses to click-to-expand drawer.

## Testing strategy

### Unit tests (in-memory SQLite, fast)

| Test file | Coverage |
|---|---|
| `srv/lib/__tests__/query-spec-validator.test.js` | Referential integrity, op-vs-type compatibility, OR-group recursion + max depth 4, expression-chip parses, QuerySpec size cap. ~25 cases. |
| `srv/lib/__tests__/spec-to-sql.test.js` | Round-trip: every QuerySpec → SQL → parse via node-sql-parser → no errors. Snapshot tests for ~15 representative specs. |
| `srv/lib/__tests__/analytics-sql-validator.test.js` (extends) | New: 16,384-char limit; expression-chip-emitted SQL with each whitelisted scalar function; rejected function names; CSV-export wrapper SQL passes the same gate. |
| `srv/lib/__tests__/analytics-distinct-sample.test.js` | Annotation gate (no `Users.email` sampling); SQL injection in column name → 400; truncated flag. |
| `srv/lib/__tests__/analytics-export-stream.test.js` | CSV header row; constant memory across 50k synthetic rows; 60s wall-clock cap appends truncation comment; allowlist gate. |
| `srv/lib/__tests__/chat-orchestrator-analytics.test.js` | Stub LLM: invalid QuerySpec → 1 retry → soft error; SQL re-derived from validated spec; envelope shapes. |
| `srv/test/admin/analytics-history.test.js` | History row written; `createdBy = $user` filter; cleanup job prunes to last 200 per user. |
| `srv/test/admin/analytics-saved-queries.test.js` | CRUD; visibility filter; cross-user UPDATE/DELETE refused; `recordRun`. |
| `app/analytics-explorer/src/lib/__tests__/spec-to-sql.test.ts` | Browser-side mirror of server test — same fixtures, byte-for-byte SQL output. Guards against drift. |
| `app/analytics-explorer/src/lib/__tests__/spec-validator.test.ts` | Browser-side mirror of `query-spec-validator`. |
| `app/analytics-explorer/src/composables/__tests__/useQuerySpec.test.ts` | `setSpec` is the only mutation surface; chip add/remove/reorder; drilldown stack push/pop; alias allocator. |
| `app/analytics-explorer/src/composables/__tests__/useEntityGraph.test.ts` | "Joinable to" lookups; filter-mode resolution; sampleDistinct cache hit. |
| `app/analytics-explorer/src/components/__tests__/JoulePanel.test.ts` | SSE message handling; PII redaction in `sampleRows` before send; View-in-builder → `setSpec`. |

The shared isomorphic modules (`spec-to-sql`, `query-spec-validator`) live at `srv/lib/` and are re-exported via Vite's `resolve.alias`. Both test suites run the same fixture set.

### Hybrid tests (real HANA via `cds bind --exec`)

| Test file | Coverage |
|---|---|
| `test/hybrid/analytics-builder.test.js` | E2E: 2-table join with filter + GROUP BY + aggregation; assert row shape, `historyId`, history row written, `privacy.mode='raw'`. |
| `test/hybrid/analytics-export-stream.test.js` | Stream CSV from 5-table join; constant memory; truncation comment; validator gate equivalence. |
| `test/hybrid/analytics-distinct-sample.test.js` | Sample distinct values for `Tasks.status` against real HANA; ordering, truncated flag; annotation gate denies `Users.email`. |
| `test/hybrid/analytics-saved-queries.test.js` | Cross-admin visibility check (two test admin users via existing hybrid bootstrap). |
| `test/hybrid/joule-analytics-tools.test.js` | Stubbed LLM but real DB: `generateAnalyticsQuery` produces a spec, generated SQL runs, envelope correct. |

Write-safety guard (`test/hybrid/_guard.js`) covers new tables: `__TEST__` prefix on `AnalyticsSavedQuery.name`, cleanup in `afterAll`. Test-generated history rows use `source = 'replay'` and prune by name pattern.

### Smoke tests (HTTP against deployed)

| Test file | Coverage |
|---|---|
| `test/smoke/analytics-builder.test.js` | `listExposedEntities` returns new fields; `runSelectQuery` returns `privacy` + `historyId`; `sampleDistinct` on known enum column. |
| `test/smoke/analytics-export.test.js` | `exportSelectQuery` returns `text/csv` with `Content-Disposition: attachment`; small synthetic query, header + data row. |
| `test/smoke/analytics-saved-queries.test.js` | Create + read + delete a saved query end-to-end. |
| `test/smoke/analytics-ui.test.js` | `/analytics-ui/` returns 200; references new builder bundle. |

### What we deliberately don't test

- LLM output quality (telemetry covers it).
- ECharts rendering pixel-perfect (own test suite).
- Drag-reorder UX gestures (cover state mutation; manual QA for gesture).

### Coverage targets

- New `srv/lib/*` modules: 90%+ line coverage.
- `useQuerySpec.ts`: 95%+.
- Component coverage: behavioural tests for critical paths (spec → SQL preview, drilldown, View-in-builder).

## Telemetry & observability

Existing `cds.log('analytics')` is source of truth. Every endpoint emits a structured log line; existing log-shipper picks it up. New log lines:

```jsonc
{ event: 'analytics.runSelectQuery', user, sqlLength, durationMs, rowCount, truncated,
  source: 'builder' | 'editor' | 'joule' | 'replay',
  privacy: { mode: 'raw', suppressedCells: 0 } }

{ event: 'analytics.generateQuery', user, durationMs, validatorRetries, warnings: 2,
  specSize: 1247, sqlLength: 384 }

{ event: 'analytics.directQuery', user, durationMs, rowCount,
  privacy: { mode: 'k-anon', k: 5, suppressedCells: 4 } }

{ event: 'analytics.explain', user, durationMs, sampleRowsSent: 50, piiRedacted: 3 }

{ event: 'analytics.export', user, sqlLength, durationMs, rowCount,
  capHit: 'rowCount' | 'wallClock' | null }

{ event: 'analytics.sampleDistinct', user, table, column, rowsReturned, truncated }
```

### Dashboards (manual setup post-deploy)

Saved Cloud Logging queries:

- `runSelectQuery` count per `source` per day → adoption of builder vs editor vs Joule.
- p50/p95/p99 of `runSelectQuery.durationMs` per source → did builder-generated SQL get slower than hand-written?
- `generateAnalyticsQuery.validatorRetries > 0` rate → LLM spec-emit quality.
- `export.capHit` distribution → are admins hitting caps?
- Privacy mode distribution per user → analyst vs admin patterns.

### In-product audit

`@PersonalData` annotations on the two new entities mean `@cap-js/audit-logging` already fires `READ`/`UPDATE`/`DELETE` events. Existing changelog Fiori app shows `AnalyticsSavedQuery` edits. No new infra.

## Performance budgets

Smoke-test-asserted; deploy fails on regression:

- `listExposedEntities`: ≤ 200 ms p95 against deployed HANA.
- `runSelectQuery` envelope build (excluding DB time): ≤ 50 ms.
- `sampleDistinct`: ≤ 500 ms p95 on production data.
- `exportSelectQuery` first byte: ≤ 1 s; rest streams.
- `JoulePanel` first paint: ≤ 100 ms after tab switch.
- `setSpec` → SQL preview re-render: ≤ 16 ms (one frame) for typical specs (≤20 chips).

Spec-validator runs on every state change — must stay under 1 ms for typical specs. node-sql-parser parse only on expression-chip popover-Apply, not every keystroke.

## Rollout plan

**No feature flag** — same as the original analytics-explorer ship. Admin scope is the gate; only admins see the new SQL tab. Backend additions are additive (new endpoints, new entities, extended envelopes). Old clients work against new server (extra fields ignored). New client against old server falls back gracefully.

### Sequence

1. **Local hybrid dev** (`npm run dev:hybrid`). Schema changes via `cds deploy --to hana`. Manual exercise: build a spec with one of every chip kind; run; export; save; share; replay.
2. **DEV deploy** via existing `mbt build && cf deploy` pipeline. Smoke tests run as post-deploy gate.
3. **Tom's manual checklist**:
   - Build a 3-join, OR-grouped, aggregated query in the chip bar; click Run; verify virtualized table.
   - Toggle to chart view; verify auto-detection and manual override modal.
   - Right-click a result row → drilldown → Back to grouped query.
   - Switch to SQL Editor; "Take over from builder"; tweak SQL; run; verify `source: 'editor'` and chip bar greyed.
   - Open Joule panel; ask "tasks completed per month last quarter"; click `View in builder`; click Run.
   - Ask Joule a follow-up: "why are May counts higher?"; verify Explanation message with no DB hit (logs).
   - Export a 1k-row CSV; open it; verify header + privacy comment at bottom.
   - Save the query as `__TEST__ Tom's check`; reload the page; load it from Saved tab; verify it runs.
   - Toggle visibility to `shared-admins`; verify in another admin browser session.
   - Clean up: delete `__TEST__ Tom's check`.

### Documentation

One new page: `docs/developers/architecture/analytics-builder.md`:

- QuerySpec contract (with the worked example below).
- How to add a new column annotation to expand the filter UI.
- How to add a new tool to the Joule analytics surface.
- Performance budgets and where to look in Cloud Logging.

The existing analytics-explorer doc gets a paragraph pointer + screenshot of new UI.

QA-channel docs unchanged — analytics-explorer is admin-only and not exposed via QA srv.

### Memory entries (post-deploy)

- `project_analytics_builder_shipped.md` (PR # + commit hash, what's in it, what's deferred).
- `feedback_query_spec_isomorphic.md` only if the isomorphic-module pattern trips up subsequent edits.

## Worked example

User clicks: From `Tasks`, Join `Users` ON `Tasks.user_ID = Users.ID`, filter `Tasks.status` IN (`PENDING`, `IN_PROGRESS`), group by `Tasks.event_ID`, select `Tasks.event_ID` and `count(*)`, order by `count(*) desc`, limit 10.

```json
{
  "version": 1,
  "from":   { "entity": "Tasks", "alias": "t" },
  "joins": [{
    "id": "j1", "kind": "inner",
    "target": { "entity": "Users", "alias": "u" },
    "on": { "leftRef": {"alias":"t","column":"user_ID"}, "rightRef": {"alias":"u","column":"ID"} }
  }],
  "filterTree": {
    "id": "fg0", "kind": "group", "conjunction": "and",
    "children": [{
      "id": "f1",
      "ref": {"alias":"t","column":"status"},
      "op": "in",
      "value": { "kind":"list", "value":["PENDING","IN_PROGRESS"] }
    }]
  },
  "groupBy": [],
  "select": [
    { "kind":"column",      "id":"s1", "ref":{"alias":"t","column":"event_ID"} },
    { "kind":"aggregation", "id":"s2", "fn":"count", "ref":"*", "alias":"task_count" }
  ],
  "orderBy": [{ "id":"o1", "by":{"kind":"selectId","id":"s2"}, "direction":"desc" }],
  "limit": 10
}
```

Generated SQL:

```sql
SELECT t.event_ID, COUNT(*) AS task_count
FROM   COM_SAP_DEVELOPERS_IMS_TASKS t
INNER JOIN COM_SAP_DEVELOPERS_IMS_USERS u ON t.user_ID = u.ID
WHERE  t.status IN ('PENDING','IN_PROGRESS')
GROUP BY t.event_ID
ORDER BY task_count DESC
LIMIT 10
```

Same shape goes into history (auto), can be saved by name, is what Joule's `generateAnalyticsQuery` returns, and is what `View in builder` round-trips through `setSpec`.

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| LLM emits invalid QuerySpec consistently for a class of questions | M | Server-side validator + 1 retry + soft error; tune via system prompt + few-shots; telemetry surfaces retry rate. |
| Spec-to-SQL drift between Node and browser implementations | M | Single isomorphic module; identical fixture suite runs in both unit test workspaces. |
| Result-table virtualization perf on slow admin laptops | L | 5,000-row inline cap (already enforced) + chart-view 10k cap; export covers larger needs. |
| K-anon bypass via raw query (admin runs SELECT against `Users`) | M | Privacy badge makes it visible; admin scope already required; PII redaction prevents leakage to LLM. Not a new risk — same as today. |
| Schema annotation churn | L | Annotations live in `db/schema-ext.cds`; default-`free`; no backfill needed when adding more. |
| Saved-queries grow unbounded | L | No automatic cap in v1 (admin-only, low write volume); `lastRunAt`-based pruning in v2 if needed. |
| Joule pageContext leaks PII via sampleRows | L | Client-side `@analytics.pii` redaction; 50-row cap; server-side log of `piiRedacted` count to detect bypass attempts. |
| Drilldown produces empty results | M | UI surfaces "No matching rows" + "Back to grouped query" button always visible; not a blocking failure. |
| Hybrid test write-safety guard misses new tables | L | `__TEST__` prefix on saved-query name; `source = 'replay'` filter for history; explicit `afterAll` cleanup. |

## Open decisions (resolved)

All clarifying questions resolved during brainstorming:

| Q | Decision | Section |
|---|---|---|
| 1 | Builder + Monaco coexist; builder primary, one-way sync | Architecture |
| 2 | Multi-entity with explicit joins (FK metadata required) | Architecture |
| 3 | Persistent right-side Joule panel | Joule |
| 4 | Chip-style builder + tabbed bottom (Results / SQL Editor / History / Saved) | Frontend |
| 5 | Schema-annotated filter modes (`enum`/`free`/`date`/`numeric-range`) | Backend |
| 6 | Free-form SELECT chips with auto-derived GROUP BY | QuerySpec |
| 7 | Per-user persisted history + named saved queries with sharing | Backend |
| 8 | Virtualized 5k-row table + streaming CSV export | Frontend |
| 9 | Three narrow tools (`generateAnalyticsQuery`, `analyticsQuery`, `explainAnalyticsResult`) | Joule |
| 10 | Inline answer in chat + "View in builder" button | Joule |
| 11 | Privacy badge (raw vs k-anon); no enforcement in builder | Backend |
| 4-amend | OR groups in filters; inline charting; per-row drilldown; chip-popover-on-click; GROUP BY always visible | Frontend |
