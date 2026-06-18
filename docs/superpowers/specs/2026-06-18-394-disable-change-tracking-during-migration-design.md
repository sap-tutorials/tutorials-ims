# Disable change tracking during data migration — design

**Status:** Draft (rev 2)
**Issue:** [#394](https://github.com/sap-tutorials/tutorials-ims/issues/394)
**Author:** Tom Jung (with Claude)
**Date:** 2026-06-18

## Problem

Migrating reference data from the legacy Java IMS to the CAP backend creates spurious rows in `sap.changelog.Changes`. Every record imported via `POST /admin/<Entity>` or `PATCH /admin/<Entity>(<id>)` triggers the `@cap-js/change-tracking` plugin, so a single migration run produces thousands of changelog entries that have no operational value — they record "migration imported X" rather than a real admin action.

### Affected paths (in scope)

- [`scripts/migrate-reference-data.js`](../../../scripts/migrate-reference-data.js)
  - **`importData()`** — POSTs to `/admin/<Tutorials|Missions|Groups|Events|Accomplishments|Tags|Prizes>`. `Missions`, `Groups`, `Events`, `Accomplishments`, `Prizes` are `@changelog`-tracked at the AdminService layer ([`app/change-tracking.cds`](../../../app/change-tracking.cds)).
  - **`populateSlugs()` (mode `populate-slugs`)** — PATCHes `Missions(id)` and `CompletionPaths(id)` with `slug`. `Missions.slug` is `@changelog`-tracked. **The first version of this spec missed this third code path**; it is included here.
- [`scripts/migrate-user-progress.js`](../../../scripts/migrate-user-progress.js)
  - **`importUsers()`** — POSTs to `/admin/<Users|TaskRecords|AccomplishmentRecords|PrizeRecords>`. **None** of these entities are `@changelog`-tracked today, so the header would be a no-op in practice — but adding it costs one line and gives defense-in-depth in case future entities get `@changelog`. Tom approved including it explicitly in the scope question. **Audit logging** is a separate plugin (`@cap-js/audit-logging`) with a separate suppression API; this spec does not address audit-logging suppression — out of scope for #394, called out below.

### Affected paths (NOT in scope, but with a verification note)

- [`scripts/migrate-from-hana.js`](../../../scripts/migrate-from-hana.js) writes via raw `INSERT`/`UPDATE` on the hdb-driver against `COM_SAP_DEVELOPERS_IMS_*` tables. Initial spec claimed "doesn't trip change tracking." During spec review this turned out to be wrong on HANA: change-tracking on HANA is implemented as **DB-level `AFTER INSERT/UPDATE/DELETE` triggers** ([`@cap-js/change-tracking/lib/hana/triggers.js`](../../../node_modules/@cap-js/change-tracking/lib/hana/triggers.js)) generated at HDI compile time and deployed as `.hdbtrigger` artifacts. The triggers fire regardless of whether the write came through CAP — they read `SESSION_CONTEXT('ct.skip')` and no-op when that is `'true'`. Direct hdb-driver writes against `MISSIONS`, `GROUPS`, `EVENTS` therefore *do* fire the changelog triggers on HANA. Even though this spec's REST-migrator scope doesn't fix that, the runbook MUST cover it to avoid the same accumulation problem when an operator chooses the HANA-to-HANA path. See **Manual verification** and **Out of scope** below for the operational mitigation.

The existing comment in [`db/change-tracking.cds`](../../../db/change-tracking.cds) — *"Annotating at the service level (AdminService) means only admin UI changes are tracked — bulk imports, scheduled jobs, and replication are excluded"* — is therefore aspirational on HANA. Once this spec lands, that comment should be amended to reflect reality (one of the build steps).

## Goal

Suppress change tracking for the duration of admin-authenticated bulk-migration POSTs/PATCHes via the REST migrators, while leaving normal admin UI edits fully tracked. Self-cleaning per request: no global toggle, no "remember to turn it back on" step.

Non-goal: cleaning up changelog rows that prior migration runs already created. If needed, that is a one-shot SQL `DELETE` and is out of scope here.

## Approach

The `@cap-js/change-tracking` plugin reads a session variable `ct.skip` (set on `req._tx`) in its before-INSERT/UPDATE/DELETE handler — see [`session-variables.js`](../../../node_modules/@cap-js/change-tracking/lib/utils/session-variables.js) (`CT_SKIP_VAR = 'ct.skip'`, used at line 181 with `req._tx.set({ [CT_SKIP_VAR]: 'true' })`). On HANA, the deployed trigger SQL reads `SESSION_CONTEXT('ct.skip')` ([`hana/sql-expressions.js:27-30`](../../../node_modules/@cap-js/change-tracking/lib/hana/sql-expressions.js)). When the variable is `'true'`, the trigger no-ops.

Add a small **DB-level** before-handler that sets that same variable when:

1. The HTTP request carries header `x-migration-mode: true`, **and**
2. The authenticated user has the `Admin` role (`req.user.is('Admin')`).

The handler is registered at `cds.db.before(['INSERT', 'UPDATE', 'DELETE'], ...)` — the same hook the plugin itself uses (verbatim event list, see [`node_modules/@cap-js/change-tracking/lib/skipHandlers.js:10`](../../../node_modules/@cap-js/change-tracking/lib/skipHandlers.js)) — where `req._tx` is reliably the DB tx with a working `.set()` method. Both REST migrators send the header. The handler is per-request — when the request ends, the session variable is reset (paired `after` handler).

### Why DB-level, not AdminService-level

The first revision proposed registering on `AdminService` (`srv.before('*', ...)`). Spec review pointed out that `req._tx` at the AdminService layer is the AdminService tx, which delegates to db lazily; whether `_tx.set()` propagates to the eventual DB connection is unverified and platform-dependent. The plugin's own `setSkipSessionVariables` runs inside `cds.db.before(['INSERT','UPDATE','DELETE'])` for exactly that reason. We do the same. The only place we still need the HTTP request is to read the header — that comes from `cds.context.http?.req?.headers` which is reachable from any handler in the call chain.

### Why not a global env flag

A global `MIGRATION_MODE=true` would be tempting (set it before the run, unset after) but introduces a real failure mode: if the operator forgets to unset it, *all* admin UI edits silently stop being tracked until someone notices. The header-per-request scheme has no such failure mode — the worst case is "header silently ignored" which equals current behavior.

### Why not bypass the AdminService entirely

Rewriting the REST migrators to use `cds.connect.to('db')` + raw SQL (matching `migrate-from-hana.js`) would also work for the SQL path — but on HANA, the DB triggers would still fire (see Problem section above). It was rejected because: (a) it's a significantly larger change to two scripts that currently work, (b) it loses validation/defaults the AdminService applies, and (c) it doesn't even solve the underlying problem on HANA.

## Components

### 1. `srv/lib/migration-mode.js` (new, ~50 lines, ESM)

```js
// Pseudocode. Final form determined during implementation.
import cds from '@sap/cds';

const MIGRATION_HEADER = 'x-migration-mode';
const SKIP_VAR = 'ct.skip';
const log = cds.log('migration-mode');

function migrationModeRequested() {
  const headers = cds.context?.http?.req?.headers;
  if (!headers) return false;
  if (String(headers[MIGRATION_HEADER]).toLowerCase() !== 'true') return false;

  const user = cds.context?.user;
  if (!user?.is?.('Admin')) {
    log.debug?.('x-migration-mode header ignored: user not Admin');
    return false;
  }
  return true;
}

export function registerMigrationModeHandler() {
  cds.db?.before(['INSERT', 'UPDATE', 'DELETE'], async (req) => {
    if (!migrationModeRequested()) return;
    if (typeof req._tx?.set !== 'function') {
      log.warn?.('migration mode requested but req._tx.set unavailable');
      return;
    }
    req._tx.set({ [SKIP_VAR]: 'true' });
    req._migrationModeSkipSet = true;
    log.debug?.(`change tracking skipped for ${req.event} ${req.target?.name}`);
  });

  cds.db?.after(['INSERT', 'UPDATE', 'DELETE'], async (_, req) => {
    if (!req._migrationModeSkipSet) return;
    try {
      req._tx?.set?.({ [SKIP_VAR]: 'false' });
    } finally {
      delete req._migrationModeSkipSet;
    }
  });
}
```

Pure handler registration — no I/O, no global state. `cds.context.http?.req?.headers` is the documented stable way to reach Express headers. Role name is `'Admin'` (matches `srv/admin-service.cds:6` `@requires: 'Admin'` and existing patterns at `srv/lib/analytics-export-handler.js:20`). Reset in the paired `after` handler so a pooled DB connection doesn't carry `ct.skip='true'` into the next admin's request — mirrors the plugin's own `resetSkipSessionVariables`.

### 2. `srv/server.js` or `srv/admin-service.js` (modify)

The handler registers against `cds.db`, not against AdminService. The cleanest spot is `srv/server.js` on the `cds.on('served', ...)` hook (where the project already does plugin-style wiring, per `CLAUDE.md`'s Bootstrap note). Adding inside `srv/admin-service.js`'s `init()` would also work — but pinning it to AdminService risks confusion (the handler is DB-level, not service-level). Final placement decided during implementation; both are one-liners.

### 3. `scripts/migrate-reference-data.js` (modify)

Two header sites, not one:

- `importData()` POST loop — add `'x-migration-mode': 'true'` next to `Content-Type` and `Authorization`.
- `populateSlugs()` — the shared `headers` object at the top of the function (around line 147) — same one-line addition. This covers both the Missions PATCH loop and the CompletionPaths PATCH loop because they share the object.

### 4. `scripts/migrate-user-progress.js` (modify)

One-line header addition in `importUsers()`. As noted in **Problem**, none of the user-progress entities are `@changelog`-tracked today — adding it is defense-in-depth (Tom-approved scope).

### 5. Documentation

#### `docs/developers/operations/migration-from-ims.md` (new, ~80 lines)

Short runbook covering:

- **Prerequisites:** `IMS_BASE_URL`, `CAP_BASE_URL`, `IMS_AUTH_TOKEN`, `cf login` to target subaccount.
- **Step 1 — Reference data:**
  - `npm run migrate:reference -- export`
  - `npm run migrate:reference -- import` — change tracking automatically suppressed via `x-migration-mode: true` header (admin role required server-side).
  - `node scripts/migrate-reference-data.js populate-slugs` — same suppression applies.
- **Step 2 — User progress:** `npm run migrate:users` (paged, resumable). Same suppression applies (defense-in-depth).
- **Step 3 — Direct HANA-to-HANA (alternate to step 1):** `npm run migrate:hana`. **Important:** on HANA this still fires the deployed change-tracking triggers (`AFTER INSERT/UPDATE/DELETE`). The script must execute `SET 'ct.skip' = 'true'` on the target hdb session before the data writes — followup task tracked separately, not part of this PR. **Until that lands, prefer steps 1+2 over step 3, OR truncate `sap.changelog.Changes` after step 3 with a one-shot SQL `DELETE` scoped by `createdAt`/`createdBy`.**
- **Audit logging note:** `Users` is `@PersonalData`-annotated (`db/audit-logging.cds`). The `@cap-js/audit-logging` plugin emits read/write events on personal data — this spec does NOT suppress those. If audit-log suppression is required, file a follow-up. The audit log is typically smaller volume than change tracking and may be acceptable as-is.
- **Verification:** SQL one-liner to count `sap.changelog.Changes` rows created during the migration window — should be 0 for the migrated entities.
- Cross-link to [`docs/developers/operations/btp-role-migration.md`](../../../docs/developers/operations/btp-role-migration.md).

The new page MUST be registered in `docs/.vitepress/config.ts` `themeConfig.sidebar` under Operations (neighbor entry: `btp-role-migration`). The `predocs:build` check rejects unregistered pages or dead links (per CLAUDE.md).

#### `CLAUDE.md`

One-line addition to the existing `### Data Migration` section: *"REST migrators (`migrate-reference-data.js`, `migrate-user-progress.js`) send `x-migration-mode: true` so change tracking is suppressed during bulk import. The HANA-to-HANA path (`migrate-from-hana.js`) still fires DB-level changelog triggers — see [migration-from-ims.md](docs/developers/operations/migration-from-ims.md) for mitigations."*

#### `db/change-tracking.cds`

The opening comment is misleading on HANA. Amend to:

> *"Change tracking is configured via @changelog annotations at the service level. Annotating at AdminService means only admin UI changes are tracked **for non-DB-level write paths**. On HANA the plugin generates AFTER INSERT/UPDATE/DELETE triggers at the DB level, so direct hdb-driver writes (e.g. `migrate-from-hana.js`, raw SQL maintenance) DO fire the triggers unless the connection sets `SESSION_CONTEXT('ct.skip') = 'true'`. The REST migrators set this via the `x-migration-mode` header — see [migration-from-ims.md](../docs/developers/operations/migration-from-ims.md)."*

## Authorization

The header is **only honored when `req.user.is('Admin')`** — capital `A`, matching `srv/admin-service.cds:6` `@requires: 'Admin'` and the existing `Admin` role check at `srv/lib/analytics-export-handler.js:20`. Without that gate, any authenticated user could suppress changelog by adding the header in their own POSTs. Both migrators authenticate as Admin (via `IMS_AUTH_TOKEN` / cf-bound XSUAA token), so the gate doesn't change their flow.

If the user is anonymous or non-Admin, the header is silently ignored (logged at `debug` level) and change tracking proceeds normally — fail-safe by default.

## Error handling

The handler no-ops when:

- header is absent or any value other than `'true'` (case-insensitive)
- `cds.context.http` is undefined (non-HTTP inbound channel — internal CAP calls, jobs, tests)
- `cds.context.user` is anonymous or non-Admin
- `req._tx?.set` is unavailable — logged at `warn` level (this is a drift signal, not normal)

The paired `after` handler resets `ct.skip` to `'false'` so pooled DB connections don't carry the flag forward.

There is one residual edge case: if the request throws between the `before` and the `after` handlers, the reset may not run on that connection. The pool's connection-acquire path resets session context for new acquisitions on most drivers, but to be safe we also reset in a `cds.db.on('error', ...)` hook (final wiring decided during implementation; mirrors the plugin's own pattern in `session-variables.js`).

## Testing

### Unit (vitest, in-memory SQLite) — `test/unit/migration-mode.test.js`

Two layers — pin the plugin contract separately from the handler behavior, so a regression in either is diagnosable:

1. **Plugin contract pin (no handler):** open a tx with `cds.tx({...})`, call `tx.set({ 'ct.skip': 'true' })`, INSERT into a `@changelog`-tracked entity, verify zero `sap.changelog.Changes` rows. This pins the plugin's session-variable contract — if a future plugin upgrade changes the variable name or mechanism, this test fails first.
2. **Handler behavior:** mock or spy on `req._tx.set` and verify it's called with `{ 'ct.skip': 'true' }` when (header=true, user.is('Admin')=true) and *not* called in any other combination (header missing, header=false, user not Admin, user anonymous).

### Hybrid (real HANA) — `test/hybrid/migration-mode.test.js`

The reviewer's Major 5 stands: SQLite session-variable behavior may differ from HANA's `SESSION_CONTEXT`. One small hybrid test:

- Insert into `Missions` via `POST /admin/Missions` with the migration header, verify zero rows added to `sap.changelog.Changes` for that entity.
- Insert without the header, verify a row appears.
- Run under the hybrid `_guard.js` (test data prefixed `__TEST__`, cleaned in `afterAll`).

This is one of the cheapest hybrid tests in the suite (two writes + two count queries) and pins HANA-specific behavior the unit test cannot reach.

### Smoke

None added.

### Manual verification (one-time, dev subaccount)

1. `cf login` → DEV.
2. `cds bind -2 tutorials-srv:tutorials-db`.
3. Snapshot row count of `sap.changelog.Changes` via a `cds bind --exec -- node` one-liner.
4. Run a test migration: `npm run migrate:reference -- import` against DEV.
5. Re-snapshot. Expected delta = 0 for the migrated entities.

PR description includes the snapshot output as evidence.

## Build sequence

1. Add `srv/lib/migration-mode.js` (ESM, default OFF — handler does nothing if header is absent). TDD: failing unit test first.
2. Implement handler until both unit tests pass.
3. Wire registration into `srv/server.js` (or `srv/admin-service.js`'s `init()` — final spot decided during impl).
4. Add hybrid test, verify against `cds bind`.
5. Update `scripts/migrate-reference-data.js` (both `importData()` and `populateSlugs()`).
6. Update `scripts/migrate-user-progress.js`.
7. Add `docs/developers/operations/migration-from-ims.md`. Register in `docs/.vitepress/config.ts` sidebar. Run `npm run docs:build` to verify the predocs check passes.
8. Amend the comment header of `db/change-tracking.cds` to reflect HANA-trigger reality.
9. Add the one-line hook in `CLAUDE.md`'s `### Data Migration` section.
10. Manual verification against DEV; capture snapshot output.
11. PR with snapshot output in the description. `Closes #394.`

## Out of scope (YAGNI)

- A global `MIGRATION_MODE` env var. Header-per-request is sufficient and safer.
- Automatic cleanup of pre-existing migration-induced changelog rows. If needed: a one-shot `DELETE FROM "sap.changelog.Changes" WHERE createdBy = '<migration-user>' AND createdAt < '<cutoff>'`.
- Suppressing change tracking for `migrate-from-hana.js` raw-SQL writes. Documented as a known gap with a runbook mitigation; followup ticket recommended. Implementation is not difficult (set `ct.skip='true'` on the target hdb session before writes) but is out of scope for #394's "REST migrators" framing.
- Suppressing `@cap-js/audit-logging` events for `Users` writes during migration. Different plugin, different API; called out in the runbook so the operator knows to expect audit-log entries for migrated users.
- Extending the same flag to non-admin services (DeveloperService etc.). They aren't `@changelog`-tracked.

## Risks

- **Plugin internals drift.** `req._tx`, the `ct.skip` variable name, and `cds.context.http?.req?.headers` are all relatively stable but not part of any public contract. Mitigation: the unit test "plugin contract pin" fails fast if the variable name or mechanism changes.
- **Header forgery by a compromised admin token.** If an admin token is leaked, the holder can suppress changelog on their own edits. The same compromise already grants full admin write — suppressing changelog is a marginal additional risk, not a new attack surface.
- **HANA trigger DB-level firing on `migrate-from-hana.js`.** Out of scope for this spec but called out in the runbook so an operator running step 3 doesn't unknowingly accumulate changelog rows.

## Spec review trail

- **Rev 1 (initial draft):** scoped to `srv.before('*')` on AdminService, role name `'admin'`, missed `populateSlugs()` PATCH path, claimed `migrate-from-hana.js` doesn't trip change tracking on HANA, no audit-logging note, no docs sidebar registration step.
- **Rev 2 (this doc):** moved handler to `cds.db.before('*')` for parity with the plugin's own implementation (Major 5); fixed role to `'Admin'` (Blocker 1); added `populateSlugs()` (Major 2); corrected the HANA-trigger claim with a runbook mitigation (Blocker 2); added audit-logging out-of-scope note (Major 1 nuance); switched code samples to ESM and `init()` placement (Major 3); switched header-access to `cds.context.http?.req?.headers` (Major 4); split unit tests into plugin-contract pin + handler behavior + added a hybrid test (Major 6); added vitepress sidebar registration step (Minor 1); added paired `after` reset for connection pooling (Minor 3).
