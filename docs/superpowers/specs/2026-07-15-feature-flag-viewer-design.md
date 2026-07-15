# Feature Flag Viewer — Design

**Date:** 2026-07-15
**Status:** Approved (design phase)
**Surface:** Admin UI (`/admin-ui/`), new read-only tile

## Problem

The project has ~20 feature flags spread across two mechanisms — environment
variables read via `process.env` scattered through `srv/**`, and boolean columns
on three CDS singleton settings entities (`ChatSettings`,
`KnowledgeGraphSettings`, `UiEventsSettings`). There is **no single place** that
shows their current state.

Critically, a flag's code-level *default* says nothing about its *current* value:
an env var may be set via `cf set-env` on the running app, and a settings row may
carry a non-null `true`/`false` that overrides both env and default. Today the
only way to know a flag's effective state is to read source and inspect the
platform. Operators need a viewer that reports the **live resolved state** plus
guidance on how to change each flag.

## Goals

- One admin page listing **every** feature flag (on and off), its live resolved
  state, why it has that value, and how to change it.
- Read-only. No writes from this page (env flags require `cf set-env` + restart;
  DB toggles already have their own per-tile settings editors).
- Stay complete over time — a drift test fails the build when a new flag is
  added without registering it.

## Non-Goals

- Editing flags in place (explicitly out of scope; existing settings tiles and
  `cf set-env` remain the change mechanisms).
- Cross-instance / platform-API introspection. The viewer reports the serving
  srv instance's own view of `process.env` and the DB. This is accurate for what
  that instance runs; the page is labelled as such.
- Surfacing non-flag config (thresholds/budgets are shown as informational rows
  where they share a registry, but tuning them is not a goal).

## Decisions (from brainstorming)

1. **Read-only viewer** — view + "how to change" pointer, no writes.
2. **Single hand-authored registry + drift test** — one descriptor file is the
   source of truth; a test guarantees completeness against rot.
3. **Resolved value + winning layer + raw values** — each row shows the
   effective value, which layer won (`db` / `env` / `default`), and the three
   raw underlying values side by side.
4. **Register all flags** (on and off), not just off-by-default ones. State is a
   per-row field, so "what's currently off" is a one-click filter.
5. **UI = Fiori Elements** ListReport + ObjectPage (mirrors `kgCommunities`),
   lowest custom-code path, consistent admin aesthetic.

## Architecture

```
srv/lib/feature-flags/registry.js      ← hand-authored descriptors (source of truth)
srv/lib/feature-flags/resolve.js       ← resolves each descriptor → effective state
srv/admin-service.cds                  ← + read-only entity FeatureFlags @requires:'Admin'
srv/admin-service.js                   ← on('READ','FeatureFlags') → resolve.js
app/admin-annotations.cds              ← FE annotations (LR columns + OP facets)
app/admin/featureFlags/                ← FE app folder (manifest auto-generated)
app/admin-shell/webapp/model/navigation.json          ← + nav entry (runtimeSettings group)
app/admin-shell/webapp/controller/Shell.controller.js ← + NAV_KEY_TO_ROUTE / NAV_KEY_TO_TITLE
test/unit/feature-flags-registry.test.js  ← drift test + resolution unit tests
```

### 1. Registry — `srv/lib/feature-flags/registry.js`

A single exported array of descriptors. Env-flag entry:

```js
{
  key: 'KG_PAGERANK_ENABLED',       // entity key (unique, stable, no DB)
  label: 'KG PageRank blend',
  category: 'Knowledge Graph',
  kind: 'env',                      // 'env' | 'db-setting' | 'constant'
  valueType: 'boolean',             // 'boolean' | 'number'
  envVar: 'KG_PAGERANK_ENABLED',
  envRule: 'true-enables',          // 'true-enables' | 'false-disables' | 'numeric'
  default: false,
  issue: '#916',
  status: 'ga',                     // 'ga' | 'dev-only' | 'beta' | 'parked'
  description: 'Blends per-tutorial PageRank into KG neighborhood ranking.',
  howToChange: {
    method: 'cf-env',
    command: 'cf set-env tutorials-srv KG_PAGERANK_ENABLED true && cf restart tutorials-srv',
  },
}
```

DB-setting entry differs in:

```js
{
  key: 'ChatSettings.communityPeersEnabled',
  kind: 'db-setting',
  entity: 'ChatSettings',           // used to resolve via the owning resolver
  column: 'communityPeersEnabled',
  resolver: 'chat',                 // which resolveXSettings() owns it
  howToChange: {
    method: 'admin-tile',
    tile: 'joule',
    hash: '#joule',
    note: 'Field not yet on the Joule Settings form; PATCH /admin/ChatSettings(<ID>) directly until added.',
  },
  // ...label/category/issue/status/description as above
}
```

`kind:'constant'` (e.g. `KG_WEIGHT`) renders the value but marks it
"not runtime-configurable" and has no `howToChange`.

**Registry covers all known flags** — env flags (both `true-enables` and
`false-disables` polarity kill switches), DB toggles across the three settings
entities, and constants. On-by-default flags are included; state is per-row.

### 2. Resolution — `srv/lib/feature-flags/resolve.js`

Exports `resolveFeatureFlags()` returning one row per descriptor. Per descriptor:

| field | source |
|---|---|
| `key`, `label`, `category`, `kind`, `issue`, `description`, `status` | registry (static) |
| `rawEnvValue` | `process.env[envVar] ?? null`, as string |
| `rawDbValue` | for `db-setting`: the actual column value from the settings row (single fetch per entity), else `null` |
| `defaultValue` | registry `default`, as string |
| `effectiveValue` | **db-setting:** call the owning `resolveXSettings()` and read the field (single source of truth for `??`/`Boolean()` layering + 5s cache). **env:** apply `envRule` to `rawEnvValue`. **constant:** the constant |
| `winningLayer` | `'db'` if db column non-null; else `'env'` if env var set; else `'default'` (constants → `'constant'`) |
| `enabled` | normalized boolean for badge + filtering (numbers: `> 0`) |
| `howToChangeText` | pre-rendered command string or tile pointer |

**Precedence is resolved through the existing resolvers**, not re-implemented:
`resolveKnowledgeGraphSettings()`, `resolveUiEventsSettings()`, and the chat
resolver already encode DB→env→default layering. `resolve.js` additionally reads
the raw settings rows once (per entity) only to populate `rawDbValue` and decide
`winningLayer`. If a resolver changes, the viewer follows automatically.

### 3. Entity — `AdminService.FeatureFlags`

Read-only, `@requires: 'Admin'`, no backing table. Key = `key`. All fields from
§2 as elements. `on('READ')` in `srv/admin-service.js` calls
`resolveFeatureFlags()`. `@readonly` + `@Capabilities` insert/update/delete
false. Supports `$filter`/`$orderby` in-memory (small fixed set).

### 4. Drift test — `test/unit/feature-flags-registry.test.js`

- **Registry shape:** every descriptor has required fields; `key` unique;
  `kind`/`envRule`/`status` in allowed enums; `db-setting` entries name a real
  entity+column.
- **Env coverage:** grep `srv/**/*.js` for `process.env.<NAME>` where NAME
  matches `_ENABLED$` / `_WEIGHT$` / `_THRESHOLD$` / known KG prefixes; assert
  each discovered NAME is registered or on an explicit `IGNORE` list (each
  ignore commented with why — e.g. infra vars like `METRICS_ENABLED` if
  intentionally excluded).
- **DB coverage:** load the CDS model; read boolean fields on `ChatSettings` /
  `KnowledgeGraphSettings` / `UiEventsSettings`; assert each is registered or
  ignored.
- **Resolution logic:** with mocked resolvers + `process.env`, assert
  `winningLayer` precedence (db beats env beats default) and `envRule` polarity
  (`false-disables` reads on when unset, off when `'false'`).

### 5. UI — `app/admin/featureFlags/` (Fiori Elements)

- **ListReport** over `AdminService.FeatureFlags`: columns Label, Category,
  State (green/grey badge via `@UI.Criticality` off `enabled`), Winning layer,
  Status, Issue. FE gives free filtering by category / enabled / status.
- **ObjectPage:** full description; the three raw values (`rawDbValue`,
  `rawEnvValue`, `defaultValue`); `status`; and `howToChangeText` (the
  `cf set-env …` command or the admin-tile pointer).
- **Shell wiring:** create folder `app/admin/featureFlags/` (the shell
  manifest generator auto-builds componentUsage/route/target once the folder
  exists with `Component.js`+`manifest.json` whose `sap.app.id` last segment is
  `featureFlags`). Then hand-edit the two known lists:
  - `navigation.json` → add `{ "key":"featureFlags", "title":"Feature Flags",
    "requiredScope":"Admin" }` to the `runtimeSettings` group.
  - `Shell.controller.js` → add `featureFlags` to `NAV_KEY_TO_ROUTE` and
    `NAV_KEY_TO_TITLE`.
- Per-app `manifest.json` uses the shell's `/admin/` OData model (mirror
  `kgCommunities`' dataSource `uri:"/admin/"`, `contextPath:"/FeatureFlags"`).

### 6. Error handling

- Per-flag resolution wrapped in try/catch: a resolver throw yields
  `effectiveValue:'error'`, `winningLayer:'unknown'`, and never a 500 (mirrors
  the fail-quiet `after('READ')` patterns already in `admin-service.js`).
- Empty/failed registry load → empty ListReport ("No data"), not a crash.

### 7. Testing

- Unit: registry shape + drift (§4).
- Unit: resolution handler with mocked resolvers/env — precedence + polarity.
- No hybrid/HANA test: no new table; the underlying resolvers already have
  coverage.

## Rollout

- No schema/migration change (no new table). No CSV seed change.
- Deploy scope: backend (srv) + approuter (admin UI static). Standard MTA deploy.
- No env flag gates this viewer itself — it is always visible to the `Admin`
  XSUAA scope.

## Open risks / notes

- The viewer reflects the **serving instance's** `process.env`. Under multiple
  CF instances all share the same `cf set-env` values, so this is accurate; the
  page carries a one-line note stating it reports the serving instance.
- `KG_WEIGHT` is a hardcoded constant, not env-driven — registered as
  `kind:'constant'`, shown but marked not runtime-configurable, so operators are
  not misled into `cf set-env KG_WEIGHT`.
- The registry is the one hand-maintained list; the drift test is what keeps it
  from rotting (per the project's "hand-curated registration lists rot" lesson).
