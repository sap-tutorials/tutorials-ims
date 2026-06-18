# Disable change tracking during data migration — design

**Status:** Draft
**Issue:** [#394](https://github.com/sap-tutorials/tutorials-ims/issues/394)
**Author:** Tom Jung (with Claude)
**Date:** 2026-06-18

## Problem

Migrating reference data and user progress from the legacy Java IMS to the CAP backend creates spurious rows in `sap.changelog.Changes`. Every record imported via `POST /admin/<Entity>` triggers the `@cap-js/change-tracking` plugin, so a single migration run produces thousands of changelog entries that have no operational value — they record "migration imported X" rather than a real admin action.

Two REST migrators are affected:

- [`scripts/migrate-reference-data.js`](../../../scripts/migrate-reference-data.js) — POSTs to `/admin/<Tutorials|Missions|Groups|Events|Accomplishments|Tags|Prizes>`.
- [`scripts/migrate-user-progress.js`](../../../scripts/migrate-user-progress.js) — POSTs to `/admin/<Users|TaskRecords|AccomplishmentRecords|PrizeRecords>`.

The third migration path, [`scripts/migrate-from-hana.js`](../../../scripts/migrate-from-hana.js), already bypasses the service layer (raw HDI-to-HDI SQL) and never trips change tracking — no work needed there.

## Goal

Suppress change tracking for the duration of admin-authenticated bulk-migration POSTs, while leaving normal admin UI edits fully tracked. Self-cleaning per request: no global toggle, no "remember to turn it back on" step.

Non-goal: cleaning up changelog rows that prior migration runs already created. If needed, that is a one-shot SQL `DELETE` and is out of scope here.

## Approach

The `@cap-js/change-tracking` plugin reads a session variable `ct.skip` (set on `req._tx`) in its before-INSERT/UPDATE/DELETE handler — see [`node_modules/@cap-js/change-tracking/lib/utils/session-variables.js`](../../../node_modules/@cap-js/change-tracking/lib/utils/session-variables.js) (`CT_SKIP_VAR = 'ct.skip'`). When the variable is `'true'`, the plugin no-ops.

Add a small AdminService handler that sets that same variable when:

1. The HTTP request carries header `x-migration-mode: true`, **and**
2. The authenticated user has the admin role (`req.user.is('admin')`).

Both REST migrators send the header. The handler is idempotent and per-request — when the request ends, the session variable goes with it. There is no enable/disable cycle to forget.

### Why not a global env flag

A global `MIGRATION_MODE=true` would be tempting (set it before the run, unset after) but introduces a real failure mode: if the operator forgets to unset it, *all* admin UI edits silently stop being tracked until someone notices. The header-per-request scheme has no such failure mode — the worst case is "header silently ignored" which equals current behavior.

### Why not bypass the AdminService entirely

Rewriting the REST migrators to use `cds.connect.to('db')` + raw SQL (matching `migrate-from-hana.js`) would also work. It was rejected because: (a) it's a significantly larger change to two scripts that currently work, (b) it loses validation/defaults the AdminService applies, and (c) it conflicts with the existing design comment in [`db/change-tracking.cds`](../../../db/change-tracking.cds) which already promises that "service-level annotation excludes bulk imports" — the right fix restores that promise rather than route around the service layer.

## Components

### 1. `srv/lib/migration-mode.js` (new, ~30 lines)

```js
// Pseudocode. Final form determined during implementation.
const cds = require('@sap/cds');

const MIGRATION_HEADER = 'x-migration-mode';
const SESSION_VAR = 'ct.skip';
const log = cds.log('migration-mode');

function registerMigrationModeHandler(srv) {
  srv.before('*', async (req) => {
    const headers = req.http?.headers || req._?.req?.headers;
    if (!headers) return;
    if (String(headers[MIGRATION_HEADER]).toLowerCase() !== 'true') return;

    if (!req.user?.is?.('admin')) {
      log.debug?.(`x-migration-mode header ignored: user not admin`);
      return;
    }

    if (typeof req._tx?.set === 'function') {
      req._tx.set({ [SESSION_VAR]: 'true' });
      log.debug?.(`change tracking skipped for ${req.event} ${req.target?.name}`);
    }
  });
}

module.exports = { registerMigrationModeHandler };
```

Pure handler registration — no I/O, no global state. Exports a single function.

### 2. `srv/admin-service.js` (modify)

Add inside the existing `cds.service.impl` body:

```js
const { registerMigrationModeHandler } = require('./lib/migration-mode');
// ... existing handlers ...
registerMigrationModeHandler(this);
```

One additional require + one call.

### 3. `scripts/migrate-reference-data.js` (modify)

In the `importData()` POST loop, add the header next to `Content-Type` and `Authorization`:

```js
headers: {
  'Content-Type': 'application/json',
  'x-migration-mode': 'true',
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
}
```

### 4. `scripts/migrate-user-progress.js` (modify)

Same one-line header addition in `importUsers()`.

### 5. `docs/developers/operations/migration-from-ims.md` (new, ~50 lines)

Short runbook covering:

- **Prerequisites:** `IMS_BASE_URL`, `CAP_BASE_URL`, `IMS_AUTH_TOKEN`, `cf login` to target subaccount.
- **Step 1 — Reference data:** `npm run migrate:reference -- export` then `... -- import`. Note: change tracking is automatically suppressed via the `x-migration-mode` header sent by the importer.
- **Step 2 — User progress:** `npm run migrate:users` (paged, resumable). Same suppression applies.
- **Step 3 — Direct HANA-to-HANA (optional alternate):** `npm run migrate:hana`. Bypasses AdminService entirely; never tripped change tracking, no flag needed.
- **Verification:** `SELECT count(*) FROM "sap.changelog.Changes" WHERE createdAt > <migration-start>` should return 0 for the migrated entities (excluding any concurrent admin UI activity).
- Cross-link to [`docs/developers/operations/btp-role-migration.md`](../../../docs/developers/operations/btp-role-migration.md).

A one-line addition to `CLAUDE.md`'s `### Data Migration` section: *"REST migrators (`migrate-reference-data.js`, `migrate-user-progress.js`) send `x-migration-mode: true` so change tracking is suppressed during bulk import. See [migration-from-ims.md](docs/developers/operations/migration-from-ims.md)."*

## Authorization

The header is **only honored when `req.user.is('admin')`**. Without that gate, any authenticated user could suppress changelog by adding the header in their own admin POSTs. Both migrators authenticate as admin (via `IMS_AUTH_TOKEN` / cf-bound XSUAA token), so the gate doesn't change their flow.

If the user is anonymous or non-admin, the header is silently ignored (logged at `debug` level) and change tracking proceeds normally — fail-safe by default.

## Error handling

The handler no-ops when:

- header is absent or any value other than `'true'` (case-insensitive)
- `req.user` is anonymous or non-admin
- `req._tx?.set` is unavailable (e.g. read-only request) — change-tracking does its own existence checks too

There is no failure mode where the migration succeeds but change tracking accidentally runs. The plugin reads its own session variable, so the worst case is "header silently ignored, changelog grows" — which equals current behavior.

## Testing

### Unit (vitest, in-memory SQLite)

`test/unit/migration-mode.test.js` — three cases:

1. **Admin POST + header present → no Changes rows.** POST to `/admin/Missions`, then `SELECT count(*) FROM sap.changelog.Changes WHERE entity='AdminService.Missions'` returns 0.
2. **Admin POST without header → Changes rows recorded as today.** Same POST, no header, expect ≥1 row.
3. **Header present + non-admin user → header ignored.** Either the request is rejected by AdminService auth (whichever fires first) or, if it gets through, Changes rows are recorded normally.

### Hybrid / smoke

None added. Session variables behave identically on SQLite and HANA, and the plugin's own test suite covers HANA. Adding hybrid coverage burns CI HANA quota for no marginal confidence.

### Manual verification (one-time, dev subaccount)

1. `cf login` → DEV.
2. `cds bind -2 tutorials-srv:tutorials-db`.
3. Snapshot row count: `cds bind --exec -- node -e "const cds=require('@sap/cds'); cds.connect().then(async db => console.log((await SELECT.from('sap.changelog.Changes').columns('count(*) as n'))[0]))"`.
4. Run a test migration: `npm run migrate:reference -- import` against DEV.
5. Re-snapshot. Expected delta = 0 for the migrated entities.

The PR description includes the snapshot output as evidence.

## Build sequence

1. Add `srv/lib/migration-mode.js` with handler stub. Failing test first (TDD).
2. Implement handler until the unit test passes.
3. Wire into `srv/admin-service.js`.
4. Update `scripts/migrate-reference-data.js` and `scripts/migrate-user-progress.js`.
5. Add `docs/developers/operations/migration-from-ims.md` + the one-line `CLAUDE.md` hook.
6. Manual verification against DEV; capture snapshot output.
7. PR with snapshot output in the description. `Closes #394.`

## Out of scope (YAGNI)

- A global `MIGRATION_MODE` env var. Header-per-request is sufficient and safer.
- Automatic cleanup of pre-existing migration-induced changelog rows. If needed, a one-shot `DELETE FROM "sap.changelog.Changes" WHERE createdBy = '<migration-user>' AND createdAt < '<cutoff>'` is a five-minute SQL run.
- Extending the same flag to non-admin services (DeveloperService, etc.). They aren't `@changelog`-tracked.
- Adding the header to `migrate-from-hana.js`. It uses raw SQL on the HDI container, doesn't go through any CAP service, and never trips change tracking. No flag needed.

## Risks

- **`req._tx?.set` API drift.** If `@cap-js/change-tracking` changes its session-variable mechanism in a future major release, the handler silently stops working (header ignored, changelog grows). Mitigation: the unit test pins the contract; if the test starts failing after a plugin upgrade, the handler is updated to match.
- **Header forgery by a compromised admin token.** If an admin token is leaked, the holder can suppress changelog on their own edits. The same compromise already grants full admin write — suppressing changelog is a marginal additional risk, not a new attack surface.
