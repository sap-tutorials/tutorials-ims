# Phase 3: Long-tail env-var migration — design

**Issue:** [#466](https://github.com/sap-tutorials/tutorials-ims/issues/466) — final phase of the runtime-config research from [#444](https://github.com/sap-tutorials/tutorials-ims/issues/444).

**Date:** 2026-06-20

**Research-design parent:** [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md)

**Sibling specs (already shipped):**

- Phase 2-A foundation + KG migration: [docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md](2026-06-20-issue-463-runtime-config-foundation-design.md) — PR #471
- Phase 2-B Secrets visibility: [docs/superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md](2026-06-20-issue-464-secrets-visibility-design.md) — PR #482

## TL;DR

Migrate the 9 remaining long-tail env vars (`UI_EVENTS_ENABLED`, `SEARCH_RATE_LIMIT_MAX`, `SEARCH_RATE_LIMIT_WINDOW_MS`, `NAV_INCLUDE_NESTED_GROUPS`, `DASHBOARD_URL`, `ALLOWED_CORS_ORIGINS`, `REBUILD_TARGET_ENV`, `TECH_USERS`, `TECH_USERS_MAPPING`) to per-domain typed-singleton entities, mirroring the patterns shipped in #471 and #482. Five new admin tiles (`uiEvents`, `search`, `navigator`, `display`, `tenant`) replicate the kg-settings template. The admin-shell side-nav gets a new "Runtime Settings" parent group containing all 7 runtime-config tiles (the 5 new + Knowledge Graph from #463 + Secrets from #464); Knowledge Graph and Secrets RELOCATE out of the System group.

After this PR, every runtime-tunable env var from the #444 inventory is DB-backed.

---

## Implementation choices made during brainstorming

| Decision | Choice |
| --- | --- |
| PR shape | **Single PR — all 5 domains.** The kg-settings + Secrets templates are now battle-tested. One deploy completes the env→DB story. ~25-30 plan tasks. |
| Special-shape vars (CORS, TECH_USERS, TECH_USERS_MAPPING) | **Store as raw String/LargeString** matching today's env-var format. Consumers keep their existing parse logic; resolver returns the raw string. Minimal consumer-side change. |
| `REBUILD_TARGET_ENV` pattern | **Read-on-demand at scheduleRebuild() call time.** Drops the module-load `_state.environment` snapshot. `scheduleRebuild()` becomes async. |
| Search rate-limiter | **5s standard TTL with caveat.** Rebuilt every ~5s within the resolver TTL window. Accepted security trade-off: documented in PR body as ~120 req/10s burst-tolerance vs documented 60 req/min. Acceptable for accidental-abuse defense. |
| Admin tile organization | **5 separate tiles in a NEW "Runtime Settings" nav-group parent.** Knowledge Graph + Secrets relocate from the System group into Runtime Settings. Group defaults to collapsed. |
| Tile shape | **Custom XML form per tile** matching kg-settings precedent (NOT Fiori Elements). Each tile is small (1-4 fields). |

---

## Scope inventory (verified)

9 distinct env vars consumed in 8 srv/ files (`grep -rln 'process\.env\.X'`):

| Env var | Consumer file(s) | Today's pattern |
| --- | --- | --- |
| `UI_EVENTS_ENABLED` | `srv/lib/ui-event-handler.js` | Module-load snapshot in `_state.enabled` |
| `SEARCH_RATE_LIMIT_MAX` | `srv/server.js` | Boot-time rate-limiter init |
| `SEARCH_RATE_LIMIT_WINDOW_MS` | `srv/server.js` | Boot-time rate-limiter init |
| `NAV_INCLUDE_NESTED_GROUPS` | `srv/lib/navigator-catalog.js` | Per-call helper `shouldIncludeNestedGroups()` |
| `DASHBOARD_URL` | `srv/admin-service.js`, `srv/jobs/scheduler.js` | Inline `process.env.X \|\| 'literal'` (2 sites, identical fallback) |
| `ALLOWED_CORS_ORIGINS` | `srv/server.js` | Boot-time Set built from comma-CSV |
| `REBUILD_TARGET_ENV` | `srv/lib/rebuild-trigger.js` | Module-load `_state.environment` |
| `TECH_USERS` | `srv/lib/tech-user-auth.js` | Per-call `loadTechUsers()` (parses on each invocation) |
| `TECH_USERS_MAPPING` | `srv/lib/tech-user-auth.js` | Per-call `loadTechUserMapping()` |

10 total consumer call-sites across 8 files (`DASHBOARD_URL` is the only one with 2 sites).

---

## CDS schema

Append to [db/schema.cds](../../../db/schema.cds) at end-of-file. **Note:** this worktree may have branched before #471/#482 merged. The 5 new entities go at end-of-file regardless of whether `KnowledgeGraphSettings` and `Secrets` are present in this worktree's view of `schema.cds` (idempotent appendable pattern matching #463/#464's plan-template).

```cds


// Phase 3 (#466): UI events telemetry feature flag.
// Resolver at srv/lib/runtime-config/ui-events-settings.js layers DB > env > default.
// CSV seed must stay empty (HDI-clobbers-admin-edits footgun).
entity UiEventsSettings : cuid, managed {
  enabled              : Boolean;
}

// Phase 3 (#466): Search /search/* per-IP rate limit.
// rateLimitMax = requests-per-window; rateLimitWindowMs = rolling window in ms.
// Range upper bound on windowMs at 600000 (10min) prevents an admin from
// configuring a 1-hour rate-limit cell that would persist rejection state
// across deploys.
entity SearchSettings : cuid, managed {
  rateLimitMax         : Integer @assert.range: [0, 100000];
  rateLimitWindowMs    : Integer @assert.range: [1000, 600000];
}

// Phase 3 (#466): Navigator nested-group inclusion flag.
// When true, /build/navigator emits cards for nested groups (richer behavior,
// ~65 extra cards on dev). False matches developers.sap.com chip-counts.
// See issue #364.
entity NavigatorSettings : cuid, managed {
  includeNestedGroups  : Boolean;
}

// Phase 3 (#466): Display dashboard URL used in contributor-notification emails.
// Default fallback (when null) is the prod approuter URL.
entity DisplaySettings : cuid, managed {
  dashboardUrl         : String(500);
}

// Phase 3 (#466): Tenant-wide config bag.
// allowedCorsOrigins: comma-separated origin URLs (raw env-var format).
// rebuildTargetEnv: enum dev/qa/prod controlling rebuild-trigger workflow_dispatch target.
// techUsers: legacy JSON-array format (raw env-var format).
// techUsersMapping: 'tech_id1:real_uuid1;tech_id2:real_uuid2' (raw env-var format).
//
// Special-shape fields stored as raw String/LargeString — consumers keep their
// existing parse logic. No write-time validation in this PR (matches today's
// env-var typo failure mode); add @assert.format if validation becomes painful.
entity TenantSettings : cuid, managed {
  allowedCorsOrigins   : LargeString;
  rebuildTargetEnv     : String(10);
  techUsers            : LargeString;
  techUsersMapping     : LargeString;
}
```

All fields nullable (no `default` clauses). The `@assert.range` on the SearchSettings columns is operational (not validation against malicious input — schema-level guard against typos like a runaway `rateLimitMax: 1000000`).

### Change-tracking

Append to [db/change-tracking.cds](../../../db/change-tracking.cds):

```cds

// Phase 3 (#466): track admin edits to runtime-tunable settings.
annotate ims.UiEventsSettings  with @changelog;
annotate ims.SearchSettings    with @changelog;
annotate ims.NavigatorSettings with @changelog;
annotate ims.DisplaySettings   with @changelog;
annotate ims.TenantSettings    with @changelog;
```

### AdminService projections

Append to [srv/admin-service.cds](../../../srv/admin-service.cds), inside the service block before its closing `}`. All five are `@odata.singleton` (each entity has exactly one row, like ChatSettings / KnowledgeGraphSettings).

```cds

  @odata.singleton @requires: 'Admin'
  entity UiEventsSettings as projection on ims.UiEventsSettings;

  @odata.singleton @requires: 'Admin'
  entity SearchSettings as projection on ims.SearchSettings;

  @odata.singleton @requires: 'Admin'
  entity NavigatorSettings as projection on ims.NavigatorSettings;

  @odata.singleton @requires: 'Admin'
  entity DisplaySettings as projection on ims.DisplaySettings;

  @odata.singleton @requires: 'Admin'
  entity TenantSettings as projection on ims.TenantSettings;
```

### Empty CSV seeds

5 new files, header-only:

- `db/data/com.sap.developers.ims-UiEventsSettings.csv` — `ID;enabled`
- `db/data/com.sap.developers.ims-SearchSettings.csv` — `ID;rateLimitMax;rateLimitWindowMs`
- `db/data/com.sap.developers.ims-NavigatorSettings.csv` — `ID;includeNestedGroups`
- `db/data/com.sap.developers.ims-DisplaySettings.csv` — `ID;dashboardUrl`
- `db/data/com.sap.developers.ims-TenantSettings.csv` — `ID;allowedCorsOrigins;rebuildTargetEnv;techUsers;techUsersMapping`

(`createdAt`/`createdBy`/`modifiedAt`/`modifiedBy` from `managed` aspect are excluded from CSV headers, matching the [Categories CSV](../../../db/data/com.sap.developers.ims-Categories.csv) precedent.)

---

## Resolver libs

5 new files under `srv/lib/runtime-config/`. Each follows the kg-settings template (PR #471):

- 5-second in-module `Map`+timestamp cache (no `lru-cache` dep)
- Layered precedence: DB row → env var → hardcoded default
- `Boolean()` coercion on Boolean fields (SQLite stores 0/1; `??` doesn't fall through 0)
- `pick(row, lower, upper)` helper for CAP-lowercase vs HANA-UPPERCASE column-name handling
- `_resetCacheForTests` named export for unit-test TTL assertions
- Try/catch fallback from `cds.entities()` to raw SQL for build-pipeline contexts

### Per-resolver hardcoded defaults

| Resolver | Field | Default |
| --- | --- | --- |
| `ui-events-settings.js` | `enabled` | `false` |
| `search-settings.js` | `rateLimitMax` | `60` |
| `search-settings.js` | `rateLimitWindowMs` | `60_000` (1 min) |
| `navigator-settings.js` | `includeNestedGroups` | `false` |
| `display-settings.js` | `dashboardUrl` | `'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard'` |
| `tenant-settings.js` | `allowedCorsOrigins` | `'http://localhost:1313,http://localhost:5000,http://localhost:4004'` |
| `tenant-settings.js` | `rebuildTargetEnv` | `'dev'` |
| `tenant-settings.js` | `techUsers` | `''` (empty — current `loadTechUsers()` treats null as "no tech users") |
| `tenant-settings.js` | `techUsersMapping` | `''` (empty) |

### Sample resolver shape (`ui-events-settings.js`)

```javascript
// srv/lib/runtime-config/ui-events-settings.js
// Resolves the UI-events telemetry feature flag. Layered precedence:
//   1. UiEventsSettings row via cds.entities (CAP runtime path)
//   2. UiEventsSettings raw-SQL UPPERCASE (HANA build-pipeline path)
//   3. process.env.UI_EVENTS_ENABLED
//   4. Hardcoded default: enabled=false
//
// Inspired by srv/lib/runtime-config/kg-settings.js (#463). 5-second
// Map+timestamp cache. Backwards-compatible: with empty DB row, behavior
// matches today's process.env reads.

import cds from '@sap/cds';

const LOG = cds.log('ui-events-settings-resolver');

const TTL_MS = 5_000;
let _cachedAt = 0;
let _cached = null;

const DEFAULTS = { enabled: false };

async function readRow() {
  try {
    const { UiEventsSettings } = cds.entities('com.sap.developers.ims');
    return (await SELECT.one.from(UiEventsSettings)) ?? null;
  } catch {
    try {
      const db = await cds.connect.to('db');
      const rows = await db.run(
        'SELECT enabled FROM COM_SAP_DEVELOPERS_IMS_UIEVENTSSETTINGS LIMIT 1'
      );
      return rows?.[0] ?? null;
    } catch (err) {
      LOG.warn('UiEventsSettings read failed; using env-var defaults', err.message);
      return null;
    }
  }
}

function pick(row, lower, upper) {
  if (row == null) return null;
  const v = row[lower];
  if (v !== undefined && v !== null) return v;
  const u = row[upper];
  return u !== undefined && u !== null ? u : null;
}

function envFlag(name) {
  const v = process.env[name];
  if (v === undefined) return null;
  return v === 'true';
}

export async function resolveUiEventsSettings() {
  const now = Date.now();
  if (_cached && (now - _cachedAt) < TTL_MS) return _cached;

  const row = await readRow();
  const settings = {
    enabled: Boolean(
      pick(row, 'enabled', 'ENABLED')
      ?? envFlag('UI_EVENTS_ENABLED')
      ?? DEFAULTS.enabled
    ),
  };

  _cached = settings;
  _cachedAt = now;
  return settings;
}

export function _resetCacheForTests() {
  _cached = null;
  _cachedAt = 0;
}
```

The other 4 resolvers follow this exact shape — substitute entity name, env var name(s), and field list. Plan tasks include each resolver's full source.

---

## Consumer conversions

Eight files modified, ten conversion sites. Each follows the kg-settings precedent (`srv/knowledge-graph-service.js` HTTP gate from #463) — swap `process.env.X` for a resolver call.

### UI-Events — `srv/lib/ui-event-handler.js`

Today: module-load capture at line 21. After: `enabled` resolved per `recordEvent()` call.

```javascript
// Before:
let _state = {
  enabled: process.env.UI_EVENTS_ENABLED === 'true',
  insertFn: defaultInsert,
};

// After:
import { resolveUiEventsSettings } from './runtime-config/ui-events-settings.js';

let _state = { insertFn: defaultInsert };

export async function recordEvent(event) {
  const { enabled } = await resolveUiEventsSettings();
  if (!enabled) return;
  // ...rest of the logic unchanged
}
```

**Behavior change:** `recordEvent()` becomes async. Callers must `await` (verify in plan).

### Search — `srv/server.js` lines 319-322

Boot-time rate-limiter init becomes lazy-rebuilt-with-5s-cache. **Documented security trade-off:** counter resets within the 5s TTL window allow ~120 req/10s vs documented 60 req/min. Acceptable for accidental-abuse defense (the rate-limiter's purpose).

```javascript
// Before:
const searchLimiter = createIpRateLimiter({
  windowMs: Number(process.env.SEARCH_RATE_LIMIT_WINDOW_MS) || 60 * 1000,
  max: Number(process.env.SEARCH_RATE_LIMIT_MAX) || 60
});
app.use('/search', ipRateLimitMiddleware(searchLimiter, { logName: 'search-rate-limit' }));

// After:
import { resolveSearchSettings } from './lib/runtime-config/search-settings.js';

let _cachedLimiter = null;
let _cachedLimiterAt = 0;
const LIMITER_TTL_MS = 5_000;

async function getSearchLimiter() {
  const now = Date.now();
  if (_cachedLimiter && (now - _cachedLimiterAt) < LIMITER_TTL_MS) return _cachedLimiter;
  const { rateLimitMax, rateLimitWindowMs } = await resolveSearchSettings();
  _cachedLimiter = createIpRateLimiter({ windowMs: rateLimitWindowMs, max: rateLimitMax });
  _cachedLimiterAt = now;
  return _cachedLimiter;
}

app.use('/search', async (req, res, next) => {
  const limiter = await getSearchLimiter();
  return ipRateLimitMiddleware(limiter, { logName: 'search-rate-limit' })(req, res, next);
});
```

### Navigator — `srv/lib/navigator-catalog.js`

`shouldIncludeNestedGroups()` becomes async.

```javascript
// Before:
function shouldIncludeNestedGroups() {
  return process.env.NAV_INCLUDE_NESTED_GROUPS === 'true';
}

// After:
import { resolveNavigatorSettings } from './runtime-config/navigator-settings.js';

async function shouldIncludeNestedGroups() {
  return (await resolveNavigatorSettings()).includeNestedGroups;
}
```

**Caller-side change at line 189:** `if (shouldIncludeNestedGroups() && ...)` becomes `if ((await shouldIncludeNestedGroups()) && ...)`. Plan must verify the enclosing function is async.

### Display — `srv/admin-service.js:791` + `srv/jobs/scheduler.js:134`

Both consumer sites use the identical hardcoded fallback URL. The fallback moves into the resolver's `DEFAULTS.dashboardUrl` so they stay in sync forever.

```javascript
// Before (BOTH sites):
const dashboardUrl = process.env.DASHBOARD_URL || 'https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard';

// After (admin-service.js):
import { resolveDisplaySettings } from './lib/runtime-config/display-settings.js';
const { dashboardUrl } = await resolveDisplaySettings();

// After (scheduler.js — note path):
import { resolveDisplaySettings } from '../lib/runtime-config/display-settings.js';
const { dashboardUrl } = await resolveDisplaySettings();
```

### Tenant — 4 files

#### `srv/server.js` lines 107-111 — CORS allowlist

Set rebuilt on each request (resolver's 5s string-cache absorbs the cost). New `Set()` per request is microseconds.

```javascript
// Before:
const ALLOWED_CORS_ORIGINS = new Set(
  (process.env.ALLOWED_CORS_ORIGINS || 'http://localhost:1313,http://localhost:5000,http://localhost:4004')
    .split(',').map(s => s.trim()).filter(Boolean)
);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_CORS_ORIGINS.has(origin)) {
    // ...set CORS headers
  }
  next();
});

// After:
import { resolveTenantSettings } from './lib/runtime-config/tenant-settings.js';

app.use(async (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const { allowedCorsOrigins } = await resolveTenantSettings();
    const allowed = new Set(
      allowedCorsOrigins.split(',').map(s => s.trim()).filter(Boolean)
    );
    if (allowed.has(origin)) {
      // ...set CORS headers
    }
  }
  next();
});
```

The hardcoded localhost fallback moves into the resolver's `DEFAULTS.allowedCorsOrigins`. The middleware no longer carries fallback logic.

#### `srv/lib/rebuild-trigger.js` — drop module-load snapshot

```javascript
// Before:
let _state = {
  token: process.env.GITHUB_DISPATCH_TOKEN ?? null,
  environment: process.env.REBUILD_TARGET_ENV ?? 'dev',
  // ...
};

export function scheduleRebuild(reason) {
  // uses _state.environment
}

// After:
import { resolveTenantSettings } from './runtime-config/tenant-settings.js';

let _state = {
  token: process.env.GITHUB_DISPATCH_TOKEN ?? null,
  // environment removed
  // ...
};

export async function scheduleRebuild(reason) {
  const { rebuildTargetEnv } = await resolveTenantSettings();
  // use rebuildTargetEnv (resolver default 'dev')
  // ...
}
```

**Behavior change:** `scheduleRebuild()` becomes async. Plan task explicitly greps for `scheduleRebuild(` callers and verifies all either `await` or explicitly fire-and-forget with a comment. CAP after-handlers DO support async returns, so `srv/server.js` admin-write hooks should be fine, but plan must verify.

#### `srv/lib/tech-user-auth.js` — both `loadTechUsers()` and `loadTechUserMapping()` become async

```javascript
// Before:
function loadTechUsers() {
  const raw = process.env.TECH_USERS;
  if (!raw) { techUsers = new Map(); return techUsers; }
  // ...parse logic unchanged
}

// After:
import { resolveTenantSettings } from './runtime-config/tenant-settings.js';

async function loadTechUsers() {
  const { techUsers: raw } = await resolveTenantSettings();
  if (!raw) { techUsers = new Map(); return techUsers; }
  // ...parse logic unchanged
}

// Same shape for loadTechUserMapping().
```

Plan must verify all callers handle async correctly.

---

## Admin tiles (5 new)

All 5 mirror the kg-settings custom-XML form pattern (no Fiori Elements). Each tile lives at `app/admin/<domain>/webapp/` with: `manifest.json`, `Component.js`, `index.html`, `view/Settings.view.xml`, `controller/Settings.controller.js`, `i18n/i18n.properties` (6 files per tile = 30 files total).

### Per-tile field counts

| Tile path | Domain | Fields | Notes |
| --- | --- | --- | --- |
| `app/admin/uiEvents/` | UI Events | 1 (Switch) | Simplest; just an enabled flag |
| `app/admin/search/` | Search | 2 (Number × 2) | Rate-limit max + window-ms |
| `app/admin/navigator/` | Navigator | 1 (Switch) | includeNestedGroups |
| `app/admin/display/` | Display | 1 (Input) | dashboardUrl |
| `app/admin/tenant/` | Tenant | 4 (TextArea × 3 + ComboBox) | CORS, rebuildTargetEnv enum, techUsers, techUsersMapping |

### Tenant tile detail (most complex)

```xml
<Label text="{i18n>fieldAllowedCorsOrigins}" />
<TextArea value="{settings>/allowedCorsOrigins}" rows="3"
          placeholder="http://localhost:1313,http://localhost:5000" />

<Label text="{i18n>fieldRebuildTargetEnv}" />
<ComboBox selectedKey="{settings>/rebuildTargetEnv}">
  <core:Item key="dev" text="dev" />
  <core:Item key="qa" text="qa" />
  <core:Item key="prod" text="prod" />
</ComboBox>

<Label text="{i18n>fieldTechUsers}" />
<TextArea value="{settings>/techUsers}" rows="6"
          placeholder='[{"id":"tech1","name":"Tech User 1","sapId":"S0123"}]' />

<Label text="{i18n>fieldTechUsersMapping}" />
<TextArea value="{settings>/techUsersMapping}" rows="3"
          placeholder="tech1:uuid-1;tech2:uuid-2" />
```

**No write-time validation** in this PR — admins typing malformed JSON get a runtime parse error in the consumer (same failure mode as today's env-var typos). Add `@assert.format` / before-update handlers in a Phase 4 follow-up if validation becomes painful.

### Per-tile MessageStrip texts (UX honesty)

Each tile gets a MessageStrip at the top explaining (a) what the knob does, (b) the 5-second cache TTL, (c) special cases for that domain.

- **UI Events**: "Telemetry endpoint gate. When OFF, /api/ui-events accepts the POST but silently drops the row (request still 204s). Changes propagate within 5 seconds across all server instances."
- **Search**: "Per-IP rate-limit on /search/* requests. `rateLimitMax` is requests-per-window; `rateLimitWindowMs` is the rolling window in ms (60000 = 1min). Rate-limiter is rebuilt every ~5s within the cache TTL — counters reset within that window. Acceptable for accidental-abuse defense."
- **Navigator**: "When ON, /build/navigator emits cards for nested groups (richer behavior, ~65 extra cards on dev). OFF matches developers.sap.com chip-counts. See issue #364."
- **Display**: "Tutorial dashboard URL used in contributor-notification emails. Defaults to the prod approuter URL when null. Override per-environment if you need staged dashboards."
- **Tenant**: "Tenant-wide config. CORS origins are comma-separated. Tech users are JSON-array format (legacy). Tech user mapping is `tech_id:real_uuid;...`. Rebuild target env controls which CF approuter the workflow_dispatch fires against. Format errors surface at consumer-runtime (same failure mode as env-var typos)."

### Controller pattern

Each controller is ~80 lines, identical pattern matching kg-settings:

- `onInit()` — set up `settings` JSONModel, call `_loadSettings()`
- `_loadSettings()` — `fetch('/admin/<EntityName>')` with `credentials: 'include'`
- `onSave()` — CSRF round-trip via HEAD `/admin/$metadata`, then PATCH
- `onReload()` — re-call `_loadSettings()`

Always-enabled Save button (no dirty-flag tracking, matching the Joule precedent).

---

## Admin-shell wiring (consolidated diff)

The largest single-file diff in the PR. 5 new tiles × 5 wiring locations + nav-group restructuring + 2 existing tiles relocated.

### `app/admin-shell/scripts/copy-components.js`

Append 5 entries to the COMPONENTS array (any position; the script just iterates):

```javascript
'uiEvents',
'search',
'navigator',
'display',
'tenant',
```

### `app/admin-shell/webapp/manifest.json` — 4 blocks × 5 sub-entries = 20 manifest entries

#### `resourceRoots` block (5 entries)

```json
"sap.tutorials.admin.uiEvents":  "./components/uiEvents",
"sap.tutorials.admin.search":    "./components/search",
"sap.tutorials.admin.navigator": "./components/navigator",
"sap.tutorials.admin.display":   "./components/display",
"sap.tutorials.admin.tenant":    "./components/tenant"
```

#### `componentUsages` block (5 entries)

`uiEventsSettingsComponent`, `searchSettingsComponent`, `navigatorSettingsComponent`, `displaySettingsComponent`, `tenantSettingsComponent`. Each follows the `jouleSettingsComponent` shape:

```json
"uiEventsSettingsComponent": {
  "name": "sap.tutorials.admin.uiEvents",
  "settings": {},
  "componentData": {},
  "lazy": true
}
```

#### `targets` block (5 entries) — UNIQUE prefix codes required

| Target name | Prefix code |
| --- | --- |
| `uiEventsSettingsTarget` | `ue` |
| `searchSettingsTarget` | `sr` (NOT `se` — taken by Secrets) |
| `navigatorSettingsTarget` | `nv` |
| `displaySettingsTarget` | `dp` |
| `tenantSettingsTarget` | `tn` |

Plan must grep existing prefixes (`'prefix':`) before adding to verify uniqueness.

#### `routes` block (5 entries)

```json
{ "name": "uiEvents",  "pattern": "uiEvents",  "target": [{"name": "uiEventsSettingsTarget", "prefix": "ue"}] },
{ "name": "search",    "pattern": "search",    "target": [{"name": "searchSettingsTarget", "prefix": "sr"}] },
{ "name": "navigator", "pattern": "navigator", "target": [{"name": "navigatorSettingsTarget", "prefix": "nv"}] },
{ "name": "display",   "pattern": "display",   "target": [{"name": "displaySettingsTarget", "prefix": "dp"}] },
{ "name": "tenant",    "pattern": "tenant",    "target": [{"name": "tenantSettingsTarget", "prefix": "tn"}] }
```

**Highest JSON-syntax-error risk in the PR.** Plan task should run `mcp__plugin_ui5_ui5-mcp-server__run_manifest_validation` after each cluster of 5 entries (4 validation runs total), not just at the end.

### `app/admin-shell/webapp/view/Shell.view.xml` — TWO changes

#### Change 1: Add new "Runtime Settings" nav-group parent

Insert AFTER the System group's closing `</tnt:NavigationListItem>`:

```xml
<tnt:NavigationListItem text="Runtime Settings" icon="sap-icon://settings" expanded="{viewModel>/groupExpanded/runtimeSettings}">
  <tnt:NavigationListItem text="Knowledge Graph" key="knowledgeGraph" />
  <tnt:NavigationListItem text="UI Events" key="uiEvents" />
  <tnt:NavigationListItem text="Search" key="search" />
  <tnt:NavigationListItem text="Navigator" key="navigator" />
  <tnt:NavigationListItem text="Display" key="display" />
  <tnt:NavigationListItem text="Tenant" key="tenant" />
  <tnt:NavigationListItem text="Secrets" key="secrets" />
</tnt:NavigationListItem>
```

#### Change 2: Remove relocated entries from System group

The System group keeps `Operations`, `Pipeline Log`, `Job Log`, `Account Merges`, `Change Log`, `Board`, `Joule Settings`, `Privacy`. The two lines to delete:

```xml
<tnt:NavigationListItem text="Knowledge Graph" key="knowledgeGraph" />  <!-- DELETE -->
<tnt:NavigationListItem text="Secrets" key="secrets" />                  <!-- DELETE -->
```

### `app/admin-shell/webapp/controller/Shell.controller.js` — THREE changes

#### Change 1: Initialize `groupExpanded.runtimeSettings`

In `onInit()`, find the existing `groupExpanded: { content: false, rewards: false, ... }` literal and add `runtimeSettings: false` (collapsed by default).

#### Change 2: NAV_KEY_TO_ROUTE — 5 new entries

```javascript
uiEvents:  "uiEvents",
search:    "search",
navigator: "navigator",
display:   "display",
tenant:    "tenant",
```

#### Change 3: NAV_KEY_TO_TITLE — 5 new entries

```javascript
uiEvents:  "UI Events",
search:    "Search",
navigator: "Navigator",
display:   "Display",
tenant:    "Tenant",
```

The plan task verifies BOTH maps got all 5 entries (5th wiring location lesson from #463).

---

## `mta.yaml` srv-qa cp chain

5 new resolver lib files in the `srv/lib/runtime-config/` subdirectory. **Worktree-state aware** plan task:

- **If `srv/lib/runtime-config/` already has a cp segment** (i.e. the worktree was rebased onto post-#471 main): append 5 new resolver filenames to the existing segment.
- **If not** (worktree fork-from-pre-#471): add `mkdir -p srv/lib/runtime-config` to the mkdir chain AND a fresh cp segment with 6 files (5 new + `kg-settings.js` for safety).

Plan instruction: implementer subagent inspects line 97 first and acts accordingly. **DEFENSIVE addition** — same rationale as #464: srv-qa doesn't load the resolvers today, but adding the cp lines preserves the convention that all `srv/lib/runtime-config/*` ships to QA.

---

## Tests

5 new resolver test files under `test/unit/runtime-config/`, ~5-7 cases each, total ~30 unit-test cases.

| Test file | Cases | Coverage |
| --- | --- | --- |
| `ui-events-settings.test.js` | 5 | hardcoded default, env fallback, DB row wins, null DB column, TTL cache hit, TTL reset |
| `search-settings.test.js` | 6 | + range-validation edge: rateLimitMax = 0 (allowed) |
| `navigator-settings.test.js` | 5 | same shape as ui-events |
| `display-settings.test.js` | 5 | + default URL fallback when null |
| `tenant-settings.test.js` | 7 | covers all 4 fields + LargeString round-trip |

Each test bootstraps `cds.deploy(path.join(process.cwd(), 'db', 'schema.cds')).to('sqlite::memory:')` once, deletes its entity row in `beforeEach`, calls `_resetCacheForTests()`, and asserts the layered DB → env → default precedence.

**Hybrid tests: out of scope.** The resolver pattern is identical across 7 domains by Phase 3; testing the same code paths 5 more times against real HANA is N=5 redundancy, not N=5 coverage. The kg-settings hybrid test in main covers the resolver pattern itself.

---

## Operations doc

`docs/developers/operations/runtime-config.md` — new doc, ~150 lines:

- **Overview** — what's tunable per-domain, link to research-design parent
- **How to flip a runtime-config flag** — admin UI path per domain
- **Per-domain field reference** — what each field controls + the env-var name it replaced
- **5-second cache TTL** — why flag-flips take ≤5s to propagate
- **Backwards-compat invariant** — env vars stay in mtaext through a soak window
- **Special-shape vars** — CSV/JSON/semicolon-pair format hints for CORS, TECH_USERS, TECH_USERS_MAPPING
- **Search rate-limiter caveat** — counter-reset within 5s TTL window
- **Navigation breadcrumb** — Runtime Settings group location

The doc is structured so each domain section is independently appendable. Phase 2-C (#465) will append a "Secrets — encrypted values" section here when it ships.

---

## Acceptance criteria (from issue #466)

- [ ] All 9 long-tail env vars resolve from DB → env → default in tested order (verified via ~30 unit tests across 5 resolver files).
- [ ] All 5 admin tiles show + edit + save their fields (manual smoke during DEV deploy).
- [ ] Tiles load at `/admin-ui/#uiEvents`, `#search`, `#navigator`, `#display`, `#tenant`.
- [ ] "Runtime Settings" nav-group appears below the System group, contains 7 tiles, defaults to collapsed.
- [ ] Knowledge Graph + Secrets tiles are NO LONGER under the System group (relocated).
- [ ] Change-tracking entries appear in `/admin-ui/#changelog-display` for each of the 5 new entities.
- [ ] 5-second TTL verified via test for each resolver.
- [ ] Existing env-var paths still work when DB rows are absent (regression).
- [ ] CSV seeds are empty (5 new files, header-only).
- [ ] **PR body call-out** for the 3 behavior changes: (a) `recordEvent()` async, (b) `scheduleRebuild()` async, (c) Search rate-limit counter resets every 5s.
- [ ] `.deploy/mta.yaml` srv-qa cp chain handles the 5 new resolver files.
- [ ] Operations doc at `docs/developers/operations/runtime-config.md`.

---

## Risks & open questions

| Risk | Mitigation |
| --- | --- |
| `scheduleRebuild()` callers may silently fire-and-forget if not awaited. | Plan task explicitly greps for `scheduleRebuild(` callers and verifies all either `await` or comment-document fire-and-forget. CAP after-handlers DO support async returns — admin-write hooks should be fine. |
| `shouldIncludeNestedGroups()` becomes async; line 189's truthy-check would always-truthy on the Promise. | Plan task ensures `await` is added at the call-site AND the enclosing function is async. Existing handler does DB work, almost certainly already async — verify in plan. |
| Search rate-limit counter resets within 5s TTL — bounded attack surface widening. | Documented in PR body + tile MessageStrip. Acceptable for accidental-abuse defense (the rate-limiter's actual purpose). Phase 4 follow-up if adversarial threat-model becomes a concern. |
| 25-sub-entry manifest.json diff is JSON-syntax-error-prone. | Plan task runs `mcp__plugin_ui5_ui5-mcp-server__run_manifest_validation` after each cluster of 5 entries (4 validations total). |
| Prefix-code collisions in target entries. | `sr` (NOT `se` for Secrets), `ue`, `nv`, `dp`, `tn` — plan verifies via `grep "'prefix':"` before adding. |
| Knowledge Graph + Secrets tile relocation visible to bookmark users. | Routes UNCHANGED (`/admin-ui/#secrets`, `/admin-ui/#knowledgeGraph` still work). Visual location changes — call out in PR body with before/after screenshots. |
| Worktree branched before #471/#482 merged — KnowledgeGraphSettings + Secrets entities + tiles + nav entries may not exist locally. | Plan uses idempotent appendable patterns throughout (end-of-file, end-of-array, append-block). Plan worktree-context warning at top spells out both pre-rebase and post-rebase states. |
| `mta.yaml` srv-qa cp segment may or may not have `srv/lib/runtime-config/` already (pre/post-#471). | Plan task inspects line 97 first, acts based on observed state. Defensive cp regardless. |
| `tnt:NavigationListItem` 3-level hierarchy concerns. | Solved by making "Runtime Settings" a peer of System, not a child. Matches Content/Rewards/Feedback peer-parent pattern. |

---

## PR body skeleton

```markdown
# feat: Phase 3 long-tail env-var migration (#466)

Closes #466. Final phase of the runtime-config research from #444.
Migrates 9 long-tail env vars across 5 domains to per-domain typed
singletons. Replicates patterns from #471 (Phase 2-A) and #482 (Phase 2-B).

After this PR, every runtime-tunable env var from the #444 inventory
is DB-backed.

## ⚠️ 3 behavior changes
1. `recordEvent()` in srv/lib/ui-event-handler.js is now async (5s
   resolver TTL replaces module-load env-snapshot).
2. `scheduleRebuild()` in srv/lib/rebuild-trigger.js is now async.
   Callers in srv/server.js admin-write hooks must `await`.
3. Search rate-limiter is rebuilt every ~5s, which resets internal
   counters. Effectively: 60+60=120 requests possible per 10s window
   (vs documented 60/min). Acceptable for accidental-abuse defense.

## ⚠️ UX change
Knowledge Graph + Secrets tiles MOVED from "System" to a new
"Runtime Settings" nav-group. Routes UNCHANGED — bookmarks still work.

## What's in the PR
- 5 schema entities (UiEvents, Search, Navigator, Display, Tenant)
- 5 resolver libs in srv/lib/runtime-config/
- 5 admin tiles in app/admin/<domain>/webapp/
- 8 consumer-file conversions across 10 sites
- Admin-shell: 5 manifest sub-entries × 4 blocks + nav-group restructuring
- 30 unit tests
- 1 operations doc

## Test plan
- [x] Unit tests pass (30 cases)
- [ ] DEV deploy: 5 tiles load, edit, save
- [ ] DEV deploy: Knowledge Graph + Secrets visible in Runtime Settings group
- [ ] DEV deploy: Knowledge Graph + Secrets routes still work (regression)

## Out of scope
- Phase 2-C (#465) encrypted secrets — gated on key-management
- Removing env vars from mtaext — soak window
```

---

## Out of scope

- **Phase 2-C (#465) encrypted secrets store.** Gated on encryption-key management decision.
- **Removing env vars from mtaext.** Stays through a soak window after this PR ships.
- **Write-time format validation** for CORS / TECH_USERS / TECH_USERS_MAPPING. Phase 4 follow-up if needed.
- **Hybrid tests** for the 5 new resolvers. Pattern-redundancy with kg-settings hybrid test in main.
- **i18n migration** of existing hardcoded admin-shell labels. Out of scope (that's a separate cleanup PR).
- **Joule Settings relocation.** Stays in System group; moving it would be a design departure outside this PR's scope.

---

## References

- Research-design parent: [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](2026-06-20-runtime-config-research-design.md)
- Sibling Phase 2-A: [docs/superpowers/specs/2026-06-20-issue-463-runtime-config-foundation-design.md](2026-06-20-issue-463-runtime-config-foundation-design.md), PR #471
- Sibling Phase 2-B: [docs/superpowers/specs/2026-06-20-issue-464-secrets-visibility-design.md](2026-06-20-issue-464-secrets-visibility-design.md), PR #482
- Issue: [#466](https://github.com/sap-tutorials/tutorials-ims/issues/466)
- Memory: [feedback_cap_csv_seeds_clobber_admin_data], [feedback_srv_qa_cp_list_recurring], [feedback_subagent_writes_can_leak_to_parent_repo], [feedback_default_off_flags_need_live_smoke], [project_463_runtime_config_foundation_shipped] (5th wiring lesson), [project_464_secrets_visibility_shipped] (list-shape pattern + admin-shell i18n bundle).
