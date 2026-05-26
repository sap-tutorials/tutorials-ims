# Admin Analytics Explorer — Design

**Status:** Draft
**Date:** 2026-05-23
**Author:** Tom Jung (with Claude)

## Summary

Add an ad-hoc analytics tool to the admin UI that lets admins build charts and dashboards against a curated set of HANA-backed CDS views. The UX is ported from the reference at `D:\projects\hana-developer-cli-tool-example\app\vue\src\views\Analytics.vue` — three tabs (Explore / SQL / Dashboard), drag-drop dimension/measure config, echarts visualization, localStorage-saved dashboards. The backend is a new `AnalyticsService` mounted at `/admin/analytics`, exposing only entities annotated `@analytics.exposed: true`.

The existing `app/admin/analytics/` Fiori Elements ListReport on `CompletionAnalytics` is kept as a "legacy" sibling under the Analytics nav, so admins can still use the prebuilt FE filter bar / variant management for that one report.

## Goals

- Admins can pick a whitelisted view, drag dimensions and measures, and see a chart update live.
- Admins can write constrained SELECT statements against the same allowlist when the drag-drop UI isn't expressive enough.
- Admins can compose tiles into a dashboard and revisit it (browser-local).
- Adding a new exposed view to the tool is a two-line CDS change (annotation + projection) — no UI code change.
- No raw HANA SQL surface; everything goes through CDS, OData $apply, or a validated SELECT-only SQL action.

## Non-goals (v1)

- Server-persisted or shared dashboards (localStorage only).
- Saved-query / query-history panels in the SQL tab.
- Scheduled reports, email exports, CSV/Excel download.
- Drill-through from a chart datum to a row inspection.
- URL-deep-linkable cross-filter state.
- A second AppRouter module — same MTA, same approuter, same XSUAA.

See **Out of Scope / v2 followups** below for the full deferred list.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  AppRouter (XSUAA, scope: admin)                                    │
│  ├─ /admin-ui/*       → existing SAPUI5 admin shell                 │
│  │     side-nav:                                                    │
│  │       "Analytics"               → href="/analytics-ui/"          │
│  │       "Completion analytics (legacy)" → existing FE ListReport   │
│  └─ /analytics-ui/*   → NEW Vue 3 SPA (Vite-built static)           │
│        ├─ /           explore (drag-drop dims/measures)             │
│        ├─ /sql        constrained SELECT editor                     │
│        └─ /dashboard  localStorage tile grid                        │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────┐
│  CAP srv                                                            │
│  AnalyticsService @(path:'/admin/analytics') @requires:'admin'      │
│    @readonly entity <Each> as projection on ims.<Each>              │
│    function listExposedEntities()                                   │
│    action runSelectQuery(sql)                                       │
│  srv/lib/analytics-sql-validator.js  (pure, unit-testable)          │
└─────────────────────────────────────────────────────────────────────┘
                                   │
                                   ▼
                       HANA HDI container
```

Three units, three interfaces:

- **`/analytics-ui/`** — Vue SPA. Knows OData URLs and the `runSelectQuery` action. No DB knowledge.
- **`AnalyticsService`** — CAP service. Knows `@analytics.exposed` entities and runs CDS QL. No UI knowledge.
- **`analytics-sql-validator.js`** — pure module. Parses a SQL string and either throws or returns a validated query. No CAP, no HTTP. Unit-testable in isolation.

## Module layout

```
app/
  analytics-explorer/                  ← NEW Vite project (peer to admin-shell/)
    package.json
    vite.config.ts
    index.html
    src/
      App.vue                          ← shellbar + router-view
      main.ts                          ← Vue app, UI5 imports, theme bootstrap
      router.ts                        ← hash router /, /sql, /dashboard
      api/
        odata.ts                       ← buildApplyUrl(config) → URL
        sql.ts                         ← POST runSelectQuery
        entities.ts                    ← cached fetch of listExposedEntities()
      composables/                     ← ported from reference
        useChartConfig.ts              (verbatim)
        useChartEngine.ts              (verbatim)
        useDataSource.ts               (rewritten — talks to AnalyticsService)
        useDashboardStore.ts           (verbatim)
        useDashboardGrid.ts            (verbatim)
        useCrossFilter.ts              (verbatim)
        useChartTheme.ts               (NEW — Horizon light/dark for echarts)
      components/                      ← ported from reference
        ExploreTab.vue                 (verbatim)
        SqlTab.vue                     (verbatim)
        DashboardTab.vue               (verbatim)
        DataSourcePicker.vue           (rewritten — flat exposed-entity list)
        DragDropConfig.vue             (verbatim)
        FilterBar.vue                  (verbatim)
        ChartRenderer.vue              (verbatim)
        ChartTypeSwitcher.vue          (verbatim)
        AggregationBadge.vue           (verbatim)
        AddChartModal.vue              (verbatim)
        DashboardGrid.vue              (verbatim)
        DashboardToolbar.vue           (verbatim)
        ChartTile.vue                  (verbatim)
        QueryEditor.vue                (trimmed — no saved-queries / history)

srv/
  analytics-service.cds                ← NEW
  analytics-service.js                 ← NEW (handles listExposedEntities + runSelectQuery)
  lib/
    analytics-sql-validator.js         ← NEW (pure module)
    __tests__/
      analytics-sql-validator.test.js  ← NEW

db/
  schema-ext.cds                       ← extend with @analytics.exposed annotations

approuter/
  xs-app.json                          ← add /analytics-ui/ + /admin/analytics/ routes
  server.js                            ← analyticsAppHandler middleware (local dev)

.deploy/
  mta.yaml                             ← copy app/analytics-explorer/dist into approuter/static
```

## Backend — `AnalyticsService`

Sibling of `AdminService`, mounted at `/admin/analytics`, gated by the `admin` role.

```cds
// srv/analytics-service.cds
using { sap.tutorials.ims as ims } from '../db/schema';

@requires : 'admin'
service AnalyticsService @(path : '/admin/analytics') {

  @readonly entity Tasks                  as projection on ims.Tasks;
  @readonly entity NavigatorCatalog       as projection on ims.NavigatorCatalog;
  @readonly entity SearchableItems        as projection on ims.SearchableItems;
  @readonly entity CompletionAnalytics    as projection on ims.CompletionAnalytics;

  @readonly entity TaskRecords            as projection on ims.TaskRecords;
  @readonly entity Users                  as projection on ims.Users;
  @readonly entity Missions               as projection on ims.Missions;
  @readonly entity Groups                 as projection on ims.Groups;
  @readonly entity Tutorials              as projection on ims.Tutorials;
  @readonly entity Events                 as projection on ims.Events;
  @readonly entity PrizeRecords           as projection on ims.PrizeRecords;
  @readonly entity AccomplishmentRecords  as projection on ims.AccomplishmentRecords;

  function listExposedEntities() returns array of {
    name        : String;
    label       : String;
    description : String;
    columns     : array of {
      name     : String;
      type     : String;
      nullable : Boolean;
      length   : Integer null;
    };
  };

  action runSelectQuery(sql : String) returns {
    columns  : array of String;
    rows     : array of array of String;
    metadata : { rowCount : Integer; truncated : Boolean; durationMs : Integer; };
  };
}
```

### `listExposedEntities` handler

Walks `cds.model.definitions`, returns metadata for entities that have **both** `@analytics.exposed: true` **and** a corresponding projection in `AnalyticsService`. The dual check prevents drift between annotation and exposed surface.

```js
srv.on('listExposedEntities', () => {
  const out = [];
  for (const e of Object.values(cds.model.definitions)) {
    if (e.kind !== 'entity' || !e['@analytics.exposed']) continue;
    const projectionName = e.name.split('.').pop();
    const projection = srv.entities[projectionName];
    if (!projection) continue;
    out.push({
      name: projectionName,
      label: e['@analytics.label'] || projectionName,
      description: e.doc || '',
      columns: Object.entries(projection.elements)
        .filter(([_, c]) => !c.virtual && !c.target)
        .map(([n, c]) => ({
          name: n,
          type: c.type,
          nullable: c.notNull !== true,
          length: c.length || null,
        })),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
});
```

**Helpers used in the handlers below:**

- `cdsTypeToHanaType(cdsType: string)` — small map (`'cds.String' → 'NVARCHAR'`, `'cds.Integer' → 'INTEGER'`, etc.). One file in `app/analytics-explorer/src/api/cds-types.ts`. Used only by the frontend.
- `getCachedEntityMetadata()` — frontend memoizes the first `listExposedEntities()` response for the session. Cleared on hard reload.
- `stringify(value)` — handler-side coercion to JSON-safe strings: `null → null`, `Date → ISO 8601`, `Buffer → base64`, `boolean/number → String(v)`, `string → v`. Decided once, used uniformly.
- Annotation access: `e['@analytics.exposed']` and `e['@analytics.label']` — CAP flattens nested annotation objects (`@analytics : { exposed, label }`) into dotted keys at compile time, so the dotted form in handler code matches the nested form in `schema-ext.cds`.

### `runSelectQuery` handler

```js
srv.on('runSelectQuery', async (req) => {
  const { sql } = req.data;
  if (!sql || sql.length > 4096) {
    return req.reject(400, 'Query missing or exceeds 4 KB');
  }
  let validated;
  try {
    validated = validateSelect(sql, getAllowedTableNames(cds.model, srv));
  } catch (err) {
    return req.reject(400, err.message);
  }
  const start = Date.now();
  const wrapped = `SELECT * FROM (${validated.sql}) LIMIT 5001`;
  // 30s soft timeout via Promise.race. HANA's WITH HINT clause does NOT
  // support a STATEMENT_TIMEOUT hint, and the session-level
  // SET 'STATEMENT_TIMEOUT' would leak across the pooled connection.
  const rows = await Promise.race([
    cds.run(wrapped),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Query exceeded 30s timeout')), 30000)
    ),
  ]);
  const durationMs = Date.now() - start;
  const truncated = rows.length > 5000;
  const data = truncated ? rows.slice(0, 5000) : rows;
  const columns = data.length ? Object.keys(data[0]) : validated.selectedColumns;
  cds.log('analytics-sql').info({
    user: req.user.id, sqlLength: sql.length, durationMs, rowCount: data.length, truncated,
  });
  return {
    columns,
    rows: data.map(r => columns.map(c => stringify(r[c]))),
    metadata: { rowCount: data.length, truncated, durationMs },
  };
});
```

### `analytics-sql-validator.js`

Pure module. Uses **`node-sql-parser`** (MIT, ~1MB) to parse and walk the AST.

Validation rules:

1. Reject if `sql.length > 4096`.
2. Reject if `sql` contains `--` or `/*` comment markers (defensive — the parser strips them, but we don't want comment-based smuggling).
3. Parse with `parser.astify(sql, { database: 'mariadb' })`. Reject if parse fails.
4. Reject if result is an array (multiple statements).
5. Reject if `ast.type !== 'select'`.
6. Walk every table reference (`ast.from`, every `JOIN`, every subquery `FROM`). Reject if any table name (case-insensitive) isn't in the `allowedTableNames` set.
7. Return `{ sql: parser.sqlify(ast), selectedColumns: <derived from ast.columns> }` — re-emitted SQL ensures we run the parsed-and-validated form, not the raw input.

`getAllowedTableNames(cdsModel, srv)` returns a `Set<string>` of HANA-mapped table names (`SAP_TUTORIALS_IMS_TASKRECORDS` etc.) **plus** the projection entity names (so users can write `SELECT * FROM TaskRecords`). The handler tries both forms; whichever matches the projection's underlying entity is allowed.

## View allowlist mechanism

`db/schema-ext.cds` carries the annotations:

```cds
// db/schema-ext.cds — additions
using sap.tutorials.ims as ims from './schema';

annotate ims.Tasks                  with @analytics : { exposed: true, label: 'Tasks (denormalized)' };
annotate ims.NavigatorCatalog       with @analytics : { exposed: true, label: 'Navigator catalog' };
annotate ims.SearchableItems        with @analytics : { exposed: true, label: 'Searchable items' };
annotate ims.CompletionAnalytics    with @analytics : { exposed: true, label: 'Completion analytics' };
annotate ims.TaskRecords            with @analytics : { exposed: true, label: 'Task records' };
annotate ims.Users                  with @analytics : { exposed: true, label: 'Users' };
annotate ims.Missions               with @analytics : { exposed: true, label: 'Missions' };
annotate ims.Groups                 with @analytics : { exposed: true, label: 'Groups' };
annotate ims.Tutorials              with @analytics : { exposed: true, label: 'Tutorials' };
annotate ims.Events                 with @analytics : { exposed: true, label: 'Events' };
annotate ims.PrizeRecords           with @analytics : { exposed: true, label: 'Prize records' };
annotate ims.AccomplishmentRecords  with @analytics : { exposed: true, label: 'Accomplishment records' };
```

**Adding a new exposed entity is two changes:**

1. `annotate ims.X with @analytics : { exposed: true, label: '...' };` in `schema-ext.cds`
2. `@readonly entity X as projection on ims.X;` in `analytics-service.cds`

The runtime `listExposedEntities` discovery, the SQL validator's allowlist, and the OData picker all derive from these two — never drift, never need a third place to update.

## Frontend — Vue 3 + UI5 Web Components

### Tabs

Reference's three-tab structure ports unchanged. `views/Analytics.vue` is verbatim — `ui5-tabcontainer` over `ExploreTab`, `SqlTab`, `DashboardTab`.

### Three rewrites

The reference talks to HANA. We talk to AnalyticsService. The data layer changes; the view layer doesn't.

**`composables/useDataSource.ts`** — rewritten:

```ts
export function useDataSource() {
  const columns = ref<ColumnMetadata[]>([])
  const rowCount = ref<number | null>(null)

  async function loadMetadata(entityName: string): Promise<void> {
    const meta = await getCachedEntityMetadata()  // fetches /admin/analytics/listExposedEntities() once
    const entry = meta.find(e => e.name === entityName)
    if (!entry) throw new Error(`Unknown entity: ${entityName}`)
    columns.value = entry.columns.map(c => ({
      column: c.name,
      dataType: cdsTypeToHanaType(c.type),
      nullable: c.nullable,
      length: c.length,
    }))
    rowCount.value = null  // fetched lazily on first aggregation
  }

  async function fetchAggregated(config: ChartConfig) {
    const url = buildApplyUrl(config)
    const json = await fetch(url, { headers: { Accept: 'application/json' }})
                       .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json() })
    return normalizeApplyResponse(json, config)
  }
  // ... clear() etc unchanged
}
```

**`api/odata.ts`** — `buildApplyUrl(config: ChartConfig)` translates a ChartConfig into a URL with `$apply=filter(...)/groupby((dims),aggregate(metric with sum as alias))/orderby/topcount`. Pure function, ~80 lines, unit-tested.

**`api/sql.ts`** — wraps `POST /admin/analytics/runSelectQuery`.

**`components/DataSourcePicker.vue`** — flat list of exposed entities (label + description), populated from `getCachedEntityMetadata()`. No HDI schema browse, no object-type tabs.

**`components/QueryEditor.vue`** — Monaco editor + run button + `ui5-table` result grid. Drops the reference's "saved queries" and "query history" panels for v1.

### What's dropped from the reference

- Cross-filter URL persistence — keep in-memory only.
- Saved queries / query history.
- Schema browser in DataSourcePicker.
- `AggregationBadge`'s "n of N rows" detail uses `$count` lazily on Aggregation popover open.

### What ports verbatim

`useChartEngine.ts` (353 lines), `useChartConfig.ts`, `useDashboardStore.ts`, `useDashboardGrid.ts`, `useCrossFilter.ts`, all chart components, drag/drop, filter bar, dashboard grid, add-chart modal, dashboard toolbar, chart tile. **~1,800 lines of vetted code.**

## Chart engine

| Concern | Library | Notes |
|---|---|---|
| Charts | `echarts@^5` | Vendor-chunked, ~360 KB gzipped |
| Drag/drop | `vuedraggable@^4` | Sortable.js binding |
| Grid | `vue-grid-layout-v3@^1` | Dashboard tile resize/reorder |
| Code editor | `monaco-editor@^0.45` + `monaco-sql-languages` | **Lazy-loaded** on first SQL tab open |
| UI primitives | `@ui5/webcomponents`, `@ui5/webcomponents-fiori` | Already in project |

Bundle target: **<800 KB gzipped** for `/analytics-ui/index.html` initial load (excludes Monaco — lazy).

**Lazy-loading strategy:**

- **Monaco** — dynamic `import('monaco-editor')` triggered the first time `SqlTab.vue` is mounted. Vite emits this as a separate chunk; subsequent SQL-tab visits hit the cached chunk. Verifiable by `vite build --mode production` chunk size report.
- **echarts** — vendor-chunked but eagerly imported (Explore tab is the default and needs it). Revisit if the bundle target slips.

### Chart types (8 total — ported from reference)

bar · line · pie · scatter · heatmap · groupedBar · kpi · table.
Suggestion rules from reference's `suggestChartType(dims, measures)` kept verbatim. User override preserved.

### Theming

`composables/useChartTheme.ts` (NEW — ~50 lines):

1. Build two echarts theme objects from CSS custom properties (`--sapChartLineColor1..12`, `--sapTextColor`, `--sapBackgroundColor`).
2. `echarts.registerTheme('horizon-light', cfg)` and `'horizon-dark'`.
3. `MutationObserver` on `<html data-theme>` re-inits visible chart instances on theme change. Mirrors the U13 mermaid pattern.

## Dashboards (localStorage)

Single key: `sap-tutorials-analytics-dashboards-v1`.

```ts
interface DashboardStore {
  version: 1;
  dashboards: Dashboard[];
  activeId: string | null;
}

interface Dashboard {
  id: string;          // crypto.randomUUID()
  name: string;
  createdAt: string;   // ISO 8601
  updatedAt: string;
  tiles: DashboardTile[];
}

interface DashboardTile {
  id: string;
  position: { x: number; y: number; w: number; h: number };
  config: ChartConfig;  // entity + dims + measures + filters + chartType
}
```

Operations from reference's `useDashboardStore.ts` port unchanged: `create`, `setActive`, `remove`, `save` (debounced 250ms), `exportDashboard` (Blob download), `importDashboard`.

**Defensive handling:**

- `QuotaExceededError` on save → `ui5-message-strip` "Storage full. Export and prune older dashboards." Don't silently lose data.
- JSON parse error on load → empty store, log warn.
- Unknown `version` → empty store. Never auto-migrate; fail safe.
- Import validates each tile's `config.entity` against current `listExposedEntities()`. Tiles referencing dropped entities are skipped with a `ui5-message-strip` warning per dropped tile.

**Cross-filter** is in-memory only (`useCrossFilter.ts` ports verbatim). Click a bar in tile A → other tiles get `{column, value}` filter for the session. "Clear cross-filters" button visible only when active. Cross-filters do not persist with the dashboard JSON.

**Cross-tab sync:** skip for v1 (last-write-wins acceptable at admin user count).

## Authentication & routing

`/analytics-ui/*` is XSUAA-protected end-to-end, identical scope to `/admin-ui/`.

`approuter/xs-app.json` — new entries above the `/admin-ui/` block:

```json
{
  "source": "^/analytics-ui/(.*)$",
  "target": "$1",
  "localDir": "static/analytics-ui",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.admin"
},
{
  "source": "^/admin/analytics/(.*)$",
  "target": "/admin/analytics/$1",
  "destination": "srv-api",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.admin"
}
```

CAP service uses `@requires : 'admin'` — same role as `AdminService`, so any current admin works without re-grant.

**Local hybrid dev** — `approuter/server.js` adds an `analyticsAppHandler` middleware mirroring the existing `adminAppsHandler`, serving `app/analytics-explorer/dist/` at `/analytics-ui/`. Same Windows workarounds.

**Side-nav link in admin shell** — `view/Shell.view.xml` "Analytics" item changes from a route binding to:

```xml
<NavigationListItem text="Analytics" icon="bar-chart" href="/analytics-ui/" target="_self" />
<NavigationListItem text="Completion analytics (legacy)" icon="line-chart" select=".onNavigate" key="analytics" />
```

The legacy item points to the existing FE ListReport route, preserving prebuilt FE filter bar / variant management for that one report.

## Deployment

Single MTA, no new modules.

1. **Build step** — `npm run build` in `app/analytics-explorer/` (Vite → `dist/`).
2. **MTA copy** — `.deploy/mta.yaml` adds one line to the approuter build commands:

   ```yaml
   - cp -r ../app/analytics-explorer/dist/. static/analytics-ui/
   ```

3. **Top-level npm scripts**:

   ```json
   "build:analytics-explorer": "cd app/analytics-explorer && npm run build",
   "build:all": "... && npm run build:analytics-explorer && ..."
   ```

CI (`deploy.yml`) inherits via `npm run build:all`.

## Testing strategy

| Layer | Workspace | File | Coverage |
|---|---|---|---|
| Pure unit | `unit` | `srv/lib/__tests__/analytics-sql-validator.test.js` | DDL/DML rejection, allowlist enforcement, comment stripping, multi-statement rejection, length cap, empty input |
| Pure unit | `unit` | `app/analytics-explorer/src/api/__tests__/odata.test.ts` | `buildApplyUrl` produces correct $apply for representative ChartConfigs (filter only, groupby + aggregate, orderby + topcount, multi-measure) |
| Pure unit | `unit` | `app/analytics-explorer/src/composables/__tests__/useChartConfig.test.ts` | `suggestChartType` matrix |
| CAP integration (SQLite) | `unit` | `srv/__tests__/analytics-service.test.js` | `listExposedEntities` returns annotated set, $apply over an exposed entity, $apply 403 on a non-exposed entity, `runSelectQuery` happy path + rejected payloads |
| HANA hybrid | `hybrid` | `test/hybrid/analytics-hybrid.test.js` | `runSelectQuery` over real `CompletionAnalytics`, verify timeout + LIMIT wrap, BLOB-safe column handling, $apply over `Tasks` view |
| Smoke | `smoke` | `test/smoke/analytics.test.js` | `/analytics-ui/` returns 200 with auth, 401 without; `/admin/analytics/$metadata` 200 with auth |

**Frontend visual / interaction tests are out of scope** — no Playwright wired for admin apps; manual smoke + dev-mode verification (consistent with how U1–U18 shipped).

## Risks & open questions

- **OData `$apply` quirks on HANA** — CAP's HANA adapter handles most aggregation, but date-grain operations (`year()`, `month()`) sometimes need workarounds. Discover during CompletionAnalytics testing pass; either add a small server-side date-bucket helper or constrain Explore-tab date dimensions to a single grain initially. Resolved during plan execution, not here.
- **`node-sql-parser` HANA dialect coverage** — the parser's `mariadb` dialect is closest to HANA SQL. 30-min spike during plan execution to confirm it accepts realistic SELECTs (joins, window functions, `WITH` clauses). Fallback: tighter regex-based gate.
- **Bundle size on slow networks** — first-load target 800 KB gzipped is reasonable for an admin tool. Echarts alone is ~360 KB. If we exceed, lazy-load echarts on first chart render too.
- **Annotation–projection drift** — mitigated by the `listExposedEntities` dual check. Adding an annotation without a projection silently drops the entity from the picker but doesn't crash. Adding a projection without an annotation exposes OData but the picker won't list it — surface this as a startup warning in the handler.

## Out of scope / v2 followups

1. **Server-persisted dashboards with sharing.** Designed-in seam: `useDashboardStore.save()` is the only place that hits localStorage. v2 swaps it for a CAP entity backend behind the same interface.
2. **Saved SQL queries / query history** in the SQL tab.
3. **Scheduled reports / email exports.**
4. **Drill-through** from a chart datum to a full row inspection.
5. **Cross-filter URL persistence / deep-linkable analyses.**
6. **CSV / Excel export of result sets.**
7. **Annotation-driven projection generation** (auto-emit `@readonly entity X as projection on …` from `@analytics.exposed`). Manual for v1.
8. **Chart annotations / target lines.**
9. **Per-chart caching with TTL** — currently every drag re-fires an OData request. Acceptable initially; revisit if admins complain.
