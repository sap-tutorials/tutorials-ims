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

## Phase 2-C: Encrypted secrets via BTP Credential Store (#465 / PR #_____)

Extends the metadata-only `Secrets` entity from #482 with value-storage in
**BTP Credential Store**. HANA stays metadata-only; values live in credstore
keyed by `Secrets.key`.

### What's where

| Layer | Stores | Access |
| --- | --- | --- |
| HANA `Secrets` entity | metadata (key, description, kind, rotationOwner, rotationDocsUrl, expiresAt, lastRotatedAt) | OData V4 via `/admin/Secrets` |
| BTP Credential Store | values (plaintext, JWE-on-wire) | Via `srv/lib/credstore.js` chokepoint |

The HANA `Secrets.key` value doubles as the credstore alias. 1:1 join.

### 4 admin-tile operations

All bound to a row in `/admin/Secrets` (open the row's edit dialog, expand
the "Secret Value" Panel):

- **Show Value** — fetches the current value, displays for ~30 seconds in
  an editable-false Input, auto-hides at the server-supplied `expiresAt`.
  Each Show emits a `SecretValueRead` audit event tagged with the admin's
  identity. **Do not click during screenshare**; do not screenshot.
- **Set Value** — opens a sub-dialog with a single masked-Password input.
  On Save, writes the value to credstore and stamps `lastRotatedAt`.
- **Rotate** — for self-gen kinds (`salt`, `content-api-key`), mints a
  fresh 32-byte hex value (64 chars) and writes it. For vendor-side kinds
  (`github-pat`, `service-key`, `smtp-credential`, `other`), opens a
  guidance dialog with the row's `rotationDocsUrl` link + a "Paste new
  value" button bridging to the Set Value flow.
- **Clear Value** — deletes the credstore entry. Metadata row stays.

### Reveal-window behavior

- Default 30 seconds (`REVEAL_WINDOW_MS = 30_000` in
  `srv/admin-service.js`).
- Server-supplied `expiresAt` in the response; client trusts that
  timestamp.
- Client tick (recursive `setTimeout`) updates the visible countdown each
  second; auto-hides at expiry.
- Re-clicking Show before the first reveal expires cancels the prior
  timer and starts fresh (race guard via `_revealTickerId`).

### Audit logs

- **CRUD on Secrets metadata** (description, expiresAt, etc.) — captured
  automatically by `@PersonalData.EntitySemantics: 'Other'` annotation on
  the entity (added in `db/audit-logging.cds` as part of #465). `'Other'`
  is the documented value for entities needing audit logging that aren't
  DataSubjects.
- **Custom OData operations** (setSecretValue, rotateSecretValue,
  clearSecretValue, revealSecretValue) — custom OData V4 functions /
  actions do NOT fire the CRUD interceptors. Each handler emits an
  explicit `audit.log('SecurityEvent', { data: { action, ... } })` call
  via the `auditEvent(action, data)` helper in `srv/admin-service.js`.
  `'SecurityEvent'` is the only registered event name in the
  `@cap-js/audit-logging` plugin's CDS service definition; the action
  discriminator (`SecretValueRead` / `SecretValueRotated` /
  `SecretValueRotateAttempted` / `SecretValueCleared` / `SecretValueWritten`)
  lives in `data.action`.

### Where to find audit events

Per the `@cap-js/audit-logging` plugin's output target (configured in
`package.json` `cds.requires['audit-log']`). Typically goes to the
SAP Audit Log service on BTP; in DEV-only contexts may write to
console. Query by `event: 'SecurityEvent'` AND
`data.action: 'SecretValueRead'` (or the other action values).
Check plugin docs for the canonical place to query in your env.

### Vendor-side rotation runbook

For `github-pat` / `service-key` / `smtp-credential` / `other`:

1. Click **Rotate** in the admin tile → dialog opens.
2. Click the **Rotation docs** link → vendor's UI (GitHub, BTP cockpit,
   etc.).
3. Mint a new credential at the vendor's UI.
4. Click **Paste new value** in the dialog → sub-dialog with masked
   input.
5. Paste the new value, click Save.
6. The tile stamps `lastRotatedAt`. The old credential should be
   revoked at the vendor side independently — Phase 2-C doesn't
   automate revocation.

### Local hybrid dev

Bind the credstore service for local development:

```bash
cds bind --to tutorials-credstore --kind credentials
```

This populates `VCAP_SERVICES` for `npm run dev:hybrid` so the credstore
lib resolves a real binding instead of throwing.

### Security trade-offs of Show Value (documented)

The Show Value flow exposes plaintext to the admin's browser for ~30s.
Three known leak paths, all bounded:

1. **Browser DevTools network panel** logs the response body. Mitigated
   by `Cache-Control: no-store, no-cache, must-revalidate, private` on
   the response, plus audit-log entry on every reveal.
2. **Screenshare** exposes the revealed field. MessageStrip displays
   "Value visible for Ns. Logged in audit trail." to give admins pause.
   Auto-hide bounds the exposure.
3. **Browser autosave / password-manager extensions** could capture
   revealed values. Out-of-band (admin's laptop hygiene).

CAP audit-logging records every reveal with the calling admin's
identity. Trade-off accepted for usability: admins need to copy
current values (e.g. to test a token) without rotating.

### Rotation owner notification (out of scope of #465)

The daily expiry-check cron (#482) still fires expiry warnings via
`/admin/Secrets` `secretWarnings()` function. Phase 2-C does NOT add
programmatic vendor-rotation. That's a Phase 3+ follow-up if needed.

## Cross-links

- [docs/developers/operations/secrets-tracking.md](secrets-tracking.md) (Phase 2-B Secrets visibility runbook)
- [docs/developers/operations/github-dispatch-pat-rotation.md](github-dispatch-pat-rotation.md)
- [docs/superpowers/specs/2026-06-20-runtime-config-research-design.md](../../superpowers/specs/2026-06-20-runtime-config-research-design.md)
