# Migrating from the legacy Java IMS

Step-by-step runbook for moving reference data + user progress out of the
legacy `imsprod` system into the CAP backend without polluting
`sap.changelog.Changes` with thousands of bogus migration entries.

## Prerequisites

- `cf login` to the **target** subaccount (DEV / TEST / PROD).
- `IMS_BASE_URL` — usually the production IMS approuter URL.
- `CAP_BASE_URL` — the target CAP srv URL.
- `IMS_AUTH_TOKEN` — bearer token for the source IMS.
- Admin-role XSUAA token for the target CAP srv (e.g. via the bound migration tech user).

## Step 1 — Reference data

Export from IMS, import to CAP. The importer sends `x-migration-mode: true`
so change tracking is automatically suppressed for the duration of each
admin POST/PATCH.

```bash
npm run migrate:reference -- export
npm run migrate:reference -- import
node scripts/migrate-reference-data.js populate-slugs
```

The slug-population pass PATCHes `Missions.slug` and `CompletionPaths.slug` —
both are tracked entities; the same header suppresses changelog entries.

## Step 2 — User progress

```bash
npm run migrate:users -- export
npm run migrate:users -- import
```

Paged + resumable. The header is sent here too as defense-in-depth — none
of the user-progress entities (`Users`, `TaskRecords`, `AccomplishmentRecords`,
`PrizeRecords`) are `@changelog`-tracked today, but if any are added in the
future the migrator is already guarded.

## Step 3 — Direct HANA-to-HANA (alternate to step 1)

```bash
npm run migrate:hana
```

> ⚠️ **Known gap.** On HANA, `@cap-js/change-tracking` deploys
> `AFTER INSERT/UPDATE/DELETE` triggers at the DB level. Direct
> `hdb`-driver writes (which is what `migrate-from-hana.js` does) DO
> fire those triggers — the per-request `x-migration-mode` header
> only protects the REST migrators (Steps 1+2). Until the script is
> updated to set `SESSION_CONTEXT('ct.skip') = 'true'` on its target
> session, prefer Steps 1+2, OR truncate `sap.changelog.Changes`
> after the run with a one-shot SQL `DELETE` scoped by `createdAt` or
> `createdBy`. Followup ticket recommended; explicitly out-of-scope of #394.

## Audit logging

`Users` is `@PersonalData`-annotated (`db/audit-logging.cds`). The
`@cap-js/audit-logging` plugin still emits read/write events on personal
data during migration — this runbook does NOT suppress those. Expected
volume is small (one event per user-create); if that becomes a problem,
file a follow-up.

## Verification

After the migration completes, count rows added to `sap.changelog.Changes`
during the migration window. The expected delta for the migrated entities
is **zero** (excluding any concurrent admin UI activity).

```bash
# Snapshot before; run migration; snapshot after; subtract.
# Example (cds bind --exec; uses ESM via --input-type=module):
npx cds bind --exec -- node --input-type=module -e "
  import cds from '@sap/cds';
  await cds.connect.to('db');
  const Changes = cds.entities['sap.changelog.Changes'];
  const since = process.argv[1];
  const rows = await SELECT.from(Changes).where({ createdAt: { '>=': since } });
  console.log(rows.length + ' changelog rows since ' + since);
" -- "$(date -u -Iseconds)"
```

## See also

- [BTP role migration](btp-role-migration.md)
- Spec: `docs/superpowers/specs/2026-06-18-394-disable-change-tracking-during-migration-design.md`
- Hybrid test (proves the suppression works on real HANA): [`test/hybrid/migration-mode.test.js`](../../../test/hybrid/migration-mode.test.js)
