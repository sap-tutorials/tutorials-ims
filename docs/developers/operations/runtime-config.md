# Runtime Configuration — operations runbook

**Spec:** [docs/superpowers/specs/2026-06-20-issue-466-long-tail-env-migration-design.md](../../superpowers/specs/2026-06-20-issue-466-long-tail-env-migration-design.md)

**Issue:** [#466](https://github.com/sap-tutorials/tutorials-ims/issues/466)

**Research-design parent:** [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](../../superpowers/specs/2026-06-20-runtime-config-research-design.md)

## Overview

Phase 3 (#466) migrates the 9 remaining long-tail env vars to per-domain DB-backed singletons. After this PR, every runtime-tunable env var from the #444 inventory is DB-backed (Phase 2-A KG, Phase 2-B Secrets, Phase 3 long-tail = 3 PRs total).

Each runtime-tunable knob lives in a per-domain `*Settings` HANA entity, edited via the corresponding admin tile in the **Runtime Settings** nav-group of `/admin-ui/`. Resolvers in `srv/lib/runtime-config/` layer DB → env → hardcoded defaults with a 5-second in-module cache.

## How to flip a runtime-config flag

1. Navigate to `/admin-ui/`.
2. Open the **Runtime Settings** nav-group (default expanded).
3. Click the relevant tile:
   - `Knowledge Graph` (Phase 2-A)
   - `UI Events` (Phase 3)
   - `Search` (Phase 3)
   - `Navigator` (Phase 3)
   - `Display` (Phase 3)
   - `Tenant` (Phase 3)
   - `Secrets` (Phase 2-B; metadata-only)
4. Edit the field(s).
5. Click **Save**. Changes propagate to all server instances within ~5 seconds (resolver TTL).

## Per-domain field reference

### UI Events

- **Endpoint:** `/admin/UiEventsSettings`
- **Replaced env var:** `UI_EVENTS_ENABLED`
- **Field:** `enabled` (Boolean) — telemetry endpoint gate. When OFF, `/api/ui-events` accepts the POST but silently drops the row (request still 204s).
- **Hardcoded default:** `false`

### Search

- **Endpoint:** `/admin/SearchSettings`
- **Replaced env vars:** `SEARCH_RATE_LIMIT_MAX`, `SEARCH_RATE_LIMIT_WINDOW_MS`
- **Fields:**
  - `rateLimitMax` (Integer, range 0..100000) — requests per window. Default 60.
  - `rateLimitWindowMs` (Integer, range 1000..600000) — rolling window in ms. Default 60000 (1 min). Capped at 10 min to prevent operator footgun (hour-long rate-limit cells).
- **Caveat:** rate-limiter is rebuilt every ~5s within the cache TTL — counters reset within that window. Effectively allows ~120 req per 10s vs documented 60/min cap. Acceptable for accidental-abuse defense (the rate-limiter's actual purpose); not designed for adversarial traffic.

### Navigator

- **Endpoint:** `/admin/NavigatorSettings`
- **Replaced env var:** `NAV_INCLUDE_NESTED_GROUPS`
- **Field:** `includeNestedGroups` (Boolean) — when ON, `/build/navigator` emits cards for nested groups (richer behavior, ~65 extra cards on dev). OFF matches developers.sap.com chip-counts. See issue #364.
- **Hardcoded default:** `false`

### Display

- **Endpoint:** `/admin/DisplaySettings`
- **Replaced env var:** `DASHBOARD_URL`
- **Field:** `dashboardUrl` (String 500) — tutorial dashboard URL used in contributor-notification emails.
- **Hardcoded default:** `https://tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/ui/tutorialDashboard` (the prod approuter URL).

### Tenant

- **Endpoint:** `/admin/TenantSettings`
- **Replaced env vars:** `ALLOWED_CORS_ORIGINS`, `REBUILD_TARGET_ENV`, `TECH_USERS`, `TECH_USERS_MAPPING`
- **Fields:**
  - `allowedCorsOrigins` (LargeString) — comma-separated origin URLs (raw env-var format). Default: `http://localhost:1313,http://localhost:5000,http://localhost:4004`.
  - `rebuildTargetEnv` (String 10) — `dev` / `qa` / `prod` controlling rebuild-trigger workflow_dispatch target. **DB is unconstrained `String(10)`** — only the ComboBox in the admin tile enforces the enum. Direct OData PATCH bypasses validation; deliberate stance matching the no-write-time-validation pattern for the other Tenant fields.
  - `techUsers` (LargeString) — legacy JSON-array format (raw env-var format). Default: empty.
  - `techUsersMapping` (LargeString) — `tech_id1:real_uuid1;tech_id2:real_uuid2` (raw env-var format). Default: empty.

## 5-second cache TTL

All 5 resolvers cache the resolved value for 5 seconds in-module via `Map`+timestamp. After admin save, all server instances see the new value within 5 seconds.

- **Cron consumers** (e.g. `srv/jobs/scheduler.js` daily jobs) re-read at tick-start, so flag-flips apply on the next tick.
- **HTTP consumers** (e.g. `srv/lib/ui-event-handler.js`'s `handleUIEvent`, the Search rate-limiter) see flips within 5s.
- **Module-load snapshots** (e.g. `srv/lib/rebuild-trigger.js` previously captured `_state.environment` at boot) have been refactored to per-call resolver reads. `scheduleRebuild()` is now async.

## Backwards-compat invariant

Env vars stay in mtaext through a **soak window** after this PR ships. Removing them is a separate cleanup PR — out of scope of #466.

If a Settings row is empty (no admin save yet), the resolver falls through to the env var. So this PR is a no-op until an admin actually edits a field.

## Special-shape vars

Three Tenant fields preserve the raw env-var format for parser-compatibility:

- **CORS origins** (`allowedCorsOrigins`): comma-separated, e.g. `http://localhost:1313,http://localhost:5000`. Per-request resolver call rebuilds the `Set` (microseconds; resolver caches the underlying string for 5s).
- **Tech users** (`techUsers`): legacy JSON-array format, e.g. `[{"id":"tech1","name":"Tech User 1","sapId":"S0123"}]`. Parsed by `srv/lib/tech-user-auth.js` `loadTechUsers()` (now async).
- **Tech-user mapping** (`techUsersMapping`): semicolon-separated key:value pairs, e.g. `tech1:uuid-1;tech2:uuid-2`. Parsed by `loadTechUserMapping()` (now async).

Format errors surface at consumer-runtime (same failure mode as today's env-var typos). No write-time validation in this PR.

## Search rate-limiter caveat

Repeated for emphasis: the rate-limiter is rebuilt every ~5s within the resolver cache TTL. Counters reset on rebuild. This effectively allows up to **~120 requests per 10s** vs the documented 60-per-minute cap. Bounded surface widening (still fixed-rate, not unbounded). Acceptable for accidental-abuse defense; not adversarial. Phase 4 follow-up if this becomes a concern.

## Navigation breadcrumb

The **Runtime Settings** nav-group lives below the **System** group in the admin-shell side-nav. Default expanded. Contains 7 tiles (5 from Phase 3 + Knowledge Graph from #463 + Secrets from #464 — the latter two relocate from System into Runtime Settings).

## Phase 2-C Secrets encrypted-values append-point

This doc is structured so each domain section is independently appendable. When Phase 2-C (#465) ships, append a "Secrets — encrypted values" section here.

## Cross-links

- [docs/developers/operations/secrets-tracking.md](secrets-tracking.md) (Phase 2-B Secrets visibility runbook)
- [docs/developers/operations/github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md)
- [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](../../superpowers/specs/2026-06-20-runtime-config-research-design.md)
