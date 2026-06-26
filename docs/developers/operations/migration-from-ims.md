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

### Noise cleanup for un-tracked entities (#658)

Nine entities had their `@changelog` annotation dropped after the admin
Change History tile was flooded with no-delta entries:

- Configuration singletons: `ChatSettings`, `KnowledgeGraphSettings`,
  `UiEventsSettings`, `TenantSettings`, `DisplaySettings`,
  `SearchSettings`, `NavigatorSettings` — each had a `before('READ')`
  auto-init handler that INSERTed a default row on first read, tripping
  the AFTER INSERT trigger.
- AI-generated KG tables: `Concepts`, `ConceptEdges` — the
  extract-concepts cron does delete-then-insert on every run, producing
  thousands of trigger-fired rows per tick.

Historical noise is purged automatically once per deploy via
`autoPurgeOnce` in [srv/lib/purge-stale-changelog.js](../../../srv/lib/purge-stale-changelog.js),
held behind a `JobLocks` sentinel. To re-run the purge ad-hoc (e.g. if
the entity list grows in a future PR), call the
`AdminService.purgeNoiseChangeLog(entities)` OData action.

Spec: [2026-06-26-658-changelog-noise-cleanup-design.md](../../superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md).

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

## Step 4 — Backfill tutorial authorship

After `migrate-user-progress.js` (Step 2) succeeds, the `Users` table is populated. Step 1 has already loaded `Tutorials`, `TutorialContributors`, and `TutorialMeta`. **Run the authorship backfill so existing tutorials and contributors get linked to the corresponding Users rows.**

Spec: [`docs/superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md`](../../superpowers/specs/2026-06-24-tutorial-authorship-fk-design.md).

```bash
# Dry run — review the orphans report at .migration-data/tutorial-author-backfill-<ts>.json
npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs

# Commit (npm script alias for --commit)
npm run migrate:authors
```

What the backfill does:

- Builds a `LOWER(TRIM(email)) → Users.ID` map once (warns on duplicate-email Users rows; picks lexicographically-first ID).
- **Phase A** — for every `TutorialContributors` row with `user_ID IS NULL AND email IS NOT NULL`, looks up the email in the map. Hit → `UPDATE … SET user_ID = ? WHERE ID = ? AND user_ID IS NULL`. Miss → orphan entry in the report.
- **Phase B** — for every `Tutorials` row with `author_ID IS NULL`, resolves the primary author via the shared [`srv/lib/resolve-tutorial-author.js`](../../../srv/lib/resolve-tutorial-author.js) resolver: (a) prefer contributors with `role IN ('author','owner')` ordered by `createdAt`, (b) fallback to first contributor, (c) fallback to `TutorialMeta.ownerEmail`. First map-hit wins.
- Writes the full report to `.migration-data/tutorial-author-backfill-<ISO-timestamp>.json` — summary counts, warnings (duplicate user emails), orphan rows by contributor and by tutorial (with the candidate emails tried).

The backfill is **idempotent** and **non-destructive**:

- Every UPDATE is gated by `WHERE …_ID IS NULL`. Re-running with no schema changes produces zero updates.
- Re-running after a fresh `migrate-user-progress.js` batch arrives picks up the new matches automatically.
- Manual admin corrections (a future spec — admin UI for editing authorship) are NEVER overwritten by either the backfill or the live publish path's `linkTutorialAuthorship` step.

Orphans (contributors / tutorials whose email isn't in `Users`) stay null and are listed in the JSON report for manual review.

### See also (Step 4)

- Hybrid test (pins the runbook order on real HANA): [`test/hybrid/migration-runbook-order.test.js`](../../../test/hybrid/migration-runbook-order.test.js)
- Backfill script: [`scripts/backfill-tutorial-authors.cjs`](../../../scripts/backfill-tutorial-authors.cjs)
- Pure resolver (shared with the live publish path): [`srv/lib/resolve-tutorial-author.js`](../../../srv/lib/resolve-tutorial-author.js)
