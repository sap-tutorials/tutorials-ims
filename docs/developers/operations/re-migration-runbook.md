# Re-migration runbook (DEV rehearsal + July prod cutover)

Operational sequence to re-run [`scripts/migrate-from-hana.js`](../../../scripts/migrate-from-hana.js)
against the DEV CAP HANA after the migrator-corruption fixes land, with
explicit pre-flight checks, baseline snapshots, and a post-migration
audit that proves the four corruption shapes from the 2026-06-20 HANA
audit are zero. The same playbook is the rehearsal for the July prod
cutover.

## Background & motivation

The **2026-06-20 HANA audit** of the DEV CAP database surfaced four
corruption shapes that all trace back to bugs in the cutover migrator,
not to runtime drift:

| # | Shape                                  | Symptom in product                                         |
|---|----------------------------------------|------------------------------------------------------------|
| 1 | Duplicate Step rows per tutorial       | Per-step UI silently fails to mark steps complete          |
| 2 | `Tutorials.stepCount` is `NULL`        | Mission/Group cards render `0/?` progress                  |
| 3 | `CompletionPaths.slug` is `NULL`       | `/build/catalog` emits numeric IDs, navigator drops cards  |
| 4 | `Users.sapId` is `NULL`                | XSUAA principal cannot resolve back to a User row at login |

**PR A** (branch [`fix/migrator-corruption-sources`](https://github.com/sap-tutorials/tutorials-ims/pulls?q=head%3Afix%2Fmigrator-corruption-sources))
fixes all four at the source in [`scripts/migrate-from-hana.js`](../../../scripts/migrate-from-hana.js).
**PR B** (branch [`feat/schema-uniqueness-guardrails`](https://github.com/sap-tutorials/tutorials-ims/pulls?q=head%3Afeat%2Fschema-uniqueness-guardrails))
adds DB-level constraints in [`db/schema.cds`](../../../db/schema.cds)
so the same shapes can never silently re-appear. The two PRs MUST
land in this order: PR A first (so the data violations clear when the
migrator re-runs), then PR B (so the new constraints don't reject the
existing dirty rows on HDI deploy — see
[postmortem 2026-06-05 HDI Data Loss](../../postmortems/2026-06-05-hdi-data-loss.md)
for what happens when constraints meet incompatible data).

This runbook is the rehearsal for **DEV today** and the same playbook
for the **July prod cutover**. Data loss in DEV is acceptable; the
runbook still captures row-count baselines so the prod run has a
sanity reference.

## Pre-flight checklist

Run through this list in order. Stop and resolve any failure before
moving on; a half-completed migration is harder to recover from than a
delayed one.

1. **Java IMS prod is queryable.** This is the source of truth for the
   migration. Confirm:

   ```bash
   curl -sf https://imsprod-approuter.cfapps.us30.hana.ondemand.com/v2/info > /dev/null && echo OK
   ```

   If this fails, escalate before continuing — there is no plan B for a
   missing source.

2. **CF target is the migration target, NOT IMS prod.** Per the
   `feedback_cf_target_before_push` memory note, we have nearly
   deployed to IMS prod by accident. For the DEV rehearsal:

   ```bash
   cf target
   # Expect:
   #   org:    tutorial-system
   #   space:  dev
   # If you see "imsprod" or "us30" anywhere, STOP — `cf login -a https://api.cf.eu10-005.hana.ondemand.com`.
   ```

   For the July prod cutover the target is the equivalent prod org/space
   on the new BTP subaccount (see the `project_btp_subaccount_migration`
   memory note for context).

3. **PR A is merged AND deployed.** The migrator running on local disk
   has the fixes:

   ```bash
   git log --oneline main | head -5    # confirm fix/migrator-corruption-sources commit landed
   ```

   No deploy is required for the migrator itself (it runs as a local
   Node script via `cds bind --exec`), but any runtime code paths
   touched by PR A must be on the deployed `tutorials-srv`.

4. **PR B is NOT YET MERGED.** Verify the schema guardrails branch is
   still open:

   ```bash
   gh pr list --head feat/schema-uniqueness-guardrails --json state -q '.[0].state'
   # Expect: "OPEN" (not "MERGED").
   ```

   Merging PR B before re-migration ships HDI constraints that the
   current corrupt rows would violate, which would fail the next deploy.
   PR B's gating note documents this dependency.

5. **`npx cds bind --exec` works.** The migrator authenticates through
   it; an expired token surfaces here instead of mid-migration:

   ```bash
   npx cds bind --exec -- node -e 'require("@sap/cds").connect.to("db").then(() => console.log("OK"))'
   ```

6. **No concurrent deploy in progress.** Check
   [the Actions tab](https://github.com/sap-tutorials/tutorials-ims/actions)
   for an in-flight `deploy.yml` or `rebuild-content.yml`. A deploy that
   restarts `tutorials-srv` while the migrator is mid-truncate leaves
   the DB in a half-cleared state.

## Snapshot baseline

Before any destructive step, capture row counts and corruption-shape
counts. In DEV this is for parity; in prod it is the sanity reference
for sign-off. Run via [hana-cli](https://www.npmjs.com/package/hana-cli)
or `npx cds bind --exec -- node -e '...'`.

```sql
-- Per-entity row counts.
SELECT 'Tutorials' AS ENTITY, COUNT(*) AS CT FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS
UNION ALL SELECT 'Missions',         COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_MISSIONS
UNION ALL SELECT 'Groups',           COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_GROUPS
UNION ALL SELECT 'CompletionPaths',  COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS
UNION ALL SELECT 'Steps',            COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_STEPS
UNION ALL SELECT 'Users',            COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_USERS
UNION ALL SELECT 'TaskRecords',      COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS
UNION ALL SELECT 'Tags',             COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TAGS
UNION ALL SELECT 'Events',           COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_EVENTS;
```

```sql
-- Four corruption shapes from the 2026-06-20 audit. Post-migration ALL must drop to 0.
SELECT 'Step dups remaining' AS METRIC, COUNT(*) AS VALUE FROM (
  SELECT T."ID" FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS T
   WHERE T."STEPCOUNT" > 0
     AND (SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_STEPS S
           WHERE S."TUTORIAL_ID" = T."ID") > T."STEPCOUNT"
)
UNION ALL SELECT 'NULL stepCount tutorials',
  COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE "STEPCOUNT" IS NULL
UNION ALL SELECT 'NULL slug CompletionPaths',
  COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS WHERE "SLUG" IS NULL
UNION ALL SELECT 'NULL sapId Users',
  COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_USERS WHERE "SAPID" IS NULL;
```

Persist the output to `.migration-data/baseline-YYYY-MM-DD.json`. The
`.migration-data/` directory is gitignored, so the snapshot stays out
of the repo but survives across script runs in the same worktree.

> **Why JSON, not just stdout?** The numbers feed back into post-migration
> audit (section "Post-migration audit") and into the prod sign-off
> sheet. A typed file is safer than scrollback.

## Truncate the target schema

The migrator does **NOT** ship a global `--truncate` or `--reset` flag.
Truncation is per-entity and built into the migration helpers:

- `migrateEntity` (used for tags, events, groups, missions, tutorials,
  steps, users, completionpaths, completionpathitems, grouppathitems,
  prizes, accomplishments, accomplishmentrecords, prizerecords,
  tutorialtags) clears its target table at the top of each run via
  `DELETE FROM <table>` when `upsertOnSlug` is `false`.
  See [scripts/migrate-from-hana.js:222-230](../../../scripts/migrate-from-hana.js#L222-L230).
- `migrateEntityPaginated` (used only for taskrecords) does the same
  unconditional `DELETE FROM` at the top of its run.
  See [scripts/migrate-from-hana.js:355-362](../../../scripts/migrate-from-hana.js#L355-L362).
- The `upsertOnSlug: true` path (currently `tutorials`, `missions`,
  `groups`) does NOT truncate — it matches on `LOWER(SLUG)` and either
  updates the existing row or inserts a new one. This is the path that
  PR A's fixes flow through for tutorials.

This means **a vanilla re-run does not need any pre-truncate step**.
The migrator clears each table just-in-time as it processes it.

If you want a forced clean slate (e.g. to confirm corruption shape #4
has fully disappeared rather than been masked by an upsert), truncate
manually in **FK-correct order** before running the migrator. From
[`db/schema.cds`](../../../db/schema.cds) the dependency order is:

```sql
-- Dependent tables first; parents last. Run inside a single SQL session
-- via hana-cli or `npx cds bind --exec`.
DELETE FROM COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_PRIZERECORDS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_STEPS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_MISSIONS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_GROUPS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_PRIZES;
DELETE FROM COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_EVENTS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_TAGS;
DELETE FROM COM_SAP_DEVELOPERS_IMS_USERS;
```

> **Skip this step on the upsert path.** If the goal is "re-run the
> migrator without losing CAP-era admin edits to mission/group slugs",
> let the upsert path do its job. Force-truncate only when the audit
> output proves an upsert won't clear the corruption shape (e.g. NULL
> sapId rows that would survive an UPDATE).

## Run the migrator

The canonical invocation for the DEV rehearsal:

```bash
# From repo root.
# Source credentials default to the IMS QA HDI container (cf service-key
# `ims-hana-qa-container` / `ims-hana-qa-container-key`). Override via env
# vars or CLI flags if you're pulling from prod IMS instead.
npx cds bind --exec -- node scripts/migrate-from-hana.js
```

Flags (all optional):

| Flag                                     | Purpose                                                                                       |
|------------------------------------------|-----------------------------------------------------------------------------------------------|
| `--dry-run`                              | Map rows in memory, log samples, never write. Use as final pre-flight before the real run.   |
| `--discover`                             | Connect to source only, list source tables. Useful when source schema is unknown.             |
| `--list-entities`                        | Print the migration order table (1. tags → 12. tutorialtags) and exit.                        |
| `--source-only`                          | Connect to source, skip target. Diagnostic.                                                   |
| `--entity=tutorials,users,...`           | Only migrate the listed entity names. Names match the `name:` field in each `migrateEntity` config. |
| `--source-instance=<name>`               | Override default `ims-hana-qa-container`. For prod cutover: pass the IMS prod HDI service.    |
| `--source-key=<name>`                    | Override default `ims-hana-qa-container-key`. Pair with `--source-instance`.                  |
| `--target-instance=<name>`               | Override default `tutorials-hana`. Should not need changing in DEV.                           |
| `--target-key=<name>`                    | Override default `tutorials-hana-key`.                                                        |

Source-credentials env-var overrides (first match wins, see
[scripts/migrate-from-hana.js:9-23](../../../scripts/migrate-from-hana.js#L9-L23)):

1. `IMS_HANA_CREDENTIALS` — full JSON `{host, port, user, password, schema}`.
2. `IMS_DB_URL` + `IMS_DB_USERNAME` + `IMS_DB_PASSWORD` — values from
   `cf env <ims-app>`.
3. CLI flags `--source-instance` / `--source-key`.

Target credentials use the same shape: `CAP_HANA_CREDENTIALS` env var,
or the CLI flags, or the defaults.

**Recommended sequence:**

```bash
# 1. Print the migration order so you know what's coming.
node scripts/migrate-from-hana.js --list-entities

# 2. Dry-run end-to-end. No writes. Confirms source connectivity, mapping
#    logic, and that every entity reads non-zero rows.
npx cds bind --exec -- node scripts/migrate-from-hana.js --dry-run

# 3. Real run. Per-entity progress on stdout; tee to a log file for the
#    sign-off record.
npx cds bind --exec -- node scripts/migrate-from-hana.js \
  2>&1 | tee .migration-data/migration-$(date -u +%Y-%m-%dT%H%M%SZ).log
```

Expected wall-clock on DEV: ~3-5 minutes for reference data + a few
minutes per million TaskRecords (paginated by 50,000 rows). Exit code
0 on success.

## Perf report (issue #474)

Every successful run drops a per-entity timing report at:

```text
.migration-data/perf-history/<startedAt>-<env>.json
```

Shape (excerpt):

```json
{
  "metadata": { "startedAt": "...", "env": "dev", "sourceHost": "...", "targetHost": "..." },
  "summary": {
    "totalDurationMin": 312.4,
    "totalInserted": 11412588,
    "overallRowsPerSec": 609,
    "entityCount": 17
  },
  "entities": [
    {
      "name": "tags", "mode": "single-shot", "durationMs": 1240,
      "durationSec": 1.2, "inserted": 482, "errors": 0, "rowsPerSec": 389
    },
    {
      "name": "taskrecords", "mode": "paginated",
      "durationMs": 18124000, "inserted": 10823412,
      "pageSize": 50000, "pageCount": 217,
      "pages": [
        { "lo": 1, "hi": 50000, "sourceRowCount": 50000, "durationMs": 84120, "inserted": 50000 }
      ]
    }
  ]
}
```

Per-paginated-entity, the `pages[]` array lets you see whether
throughput degrades at the tail (e.g., target MERGE INTO cost rising
as the table grows). Compare reports across runs by diffing the
summary block; the entities/pages arrays give the drill-down for
investigating regressions.

`.migration-data/` is gitignored — perf-history files stay local. Keep
the JSON for any run that's interesting (corruption-fix validation,
July cutover rehearsal, prod cutover itself); the file format is the
baseline against which the #474 perf optimizations will be measured.

## Post-migration audit

Re-run the **four corruption-shape queries** from the baseline section.
Expected: every `VALUE` is `0`.

If any count is non-zero, the matching fix in PR A failed. Diagnose
each below; do NOT merge PR B until all four are zero.

| Non-zero metric                | Likely cause                                                  | What to inspect                                                                                                                       |
|--------------------------------|---------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------------------|
| `Step dups remaining > 0`      | Step `STEPORDER` mapping or `TUTORIAL_ID` parent resolution.  | [scripts/migrate-from-hana.js:751-771](../../../scripts/migrate-from-hana.js#L751-L771) — `stepParentMap` and the steps `mapRow`.    |
| `NULL stepCount tutorials > 0` | The post-migration `stepCount` aggregation never ran.         | PR A should compute `stepCount` either in `mapRow` or as a follow-up SQL pass; verify either landed.                                 |
| `NULL slug CompletionPaths > 0`| CP slug derivation helper. CompletionPaths derive slug from the parent mission.                | [scripts/migrate-from-hana.js:839-850](../../../scripts/migrate-from-hana.js#L839-L850) — confirm `mapRow` emits `SLUG`.             |
| `NULL sapId Users > 0`         | Either source data has NULL `SAP_ID` (acceptable) or PR A's fallback never wrote. | If the row count matches `.migration-data/null-sapid-users.json`, this is expected source-data state and not a fix failure. Document the count in sign-off. Otherwise inspect [scripts/migrate-from-hana.js:773-788](../../../scripts/migrate-from-hana.js#L773-L788). |

> **The Users `sapId` case is the only one where a non-zero count can
> still be a green light** — IMS source data is the ground truth, and
> some legacy users genuinely have no SAP ID. The runbook treats
> "matches the documented null-sapid-users count" as pass.

## Reconcile post-migration state

The migrator restores the IMS-side data, but a couple of CAP-era
artefacts need re-applying:

1. **Populate slugs for missions/groups.** Per the `DEV Database Setup`
   section in the project's `CLAUDE.md`, the migrator leaves
   `Missions.slug` and `Groups.slug` NULL (the IMS source doesn't have
   a slug column for these). Run:

   ```bash
   npx cds bind --exec -- node scripts/setup-dev-data.cjs
   ```

   This script also clears `__TEST__`-prefixed autotest junk; pass
   `--skip-cleanup` if a separate test run is mid-flight. `--skip-slugs`
   and `--dry-run` are also available.

2. **Republish tutorial content BLOBs.** The migrator restores the
   `Tutorials` row metadata, but `ContentFiles` (gzipped HTML in HANA)
   is independent of the IMS source. Republish from the latest Hugo
   build:

   ```bash
   export CONTENT_API_KEY="tutorials-content-publish-2024"
   CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
     npm run publish-content -- --force
   ```

   `--force` skips the `/content/hashes` round-trip — appropriate here
   since post-migration the server has zero ContentFiles for the new
   `Tutorials.id` values, so a delta would behave the same but at
   higher latency.

3. **Smoke tests.** Three quick assertions that catch most cutover
   regressions:

   ```bash
   # Catalog returns missions with text slugs.
   curl -sf https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/build/catalog \
     | jq '.missions | length'                       # > 0

   # Tutorial content serves.
   curl -sIfL https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/abap-create-project/ \
     | head -1                                       # 200 OK

   # Hybrid tests (proves schema + data shape compatible with srv code).
   ALLOW_HYBRID_WRITES=true npm run test:hybrid
   ```

## Sign-off & merge sequence

The DEV runbook is complete when all four steps below are green. Do
NOT skip ahead.

1. The four corruption-shape queries from the audit return `0` on every
   row (with the documented `NULL sapId` carve-out from the source).
2. Smoke tests in section "Reconcile post-migration state" all pass.
3. **Merge PR B** ([`feat/schema-uniqueness-guardrails`](https://github.com/sap-tutorials/tutorials-ims/pulls?q=head%3Afeat%2Fschema-uniqueness-guardrails)).
   The MTA deploy after merge fails fast if any data still violates the
   new constraints — that's the constraint working as intended; rewind
   to step 1.
4. CI hybrid suite on the post-PR-B deploy is green:
   `gh run list --workflow=deploy.yml --branch=main --limit=1` → success.

DEV runbook ends here.

## July prod cutover plan

The same playbook applies to the July prod cutover with three
adjustments. Treat the DEV rehearsal above as the **dress rehearsal**;
data loss is acceptable in DEV but **not** in prod.

1. **Source is now Java IMS prod, not IMS QA.** Override the source
   credentials at the top of section "Run the migrator":

   ```bash
   # Either via cf service-key (preferred — let the script call cf):
   npx cds bind --exec -- node scripts/migrate-from-hana.js \
     --source-instance=ims-hana-prod-container \
     --source-key=ims-hana-prod-container-key

   # Or by environment variable (when prod creds aren't bound to the local CF target):
   IMS_HANA_CREDENTIALS='{"host":"...","port":"...","user":"...","password":"...","schema":"..."}' \
     npx cds bind --exec -- node scripts/migrate-from-hana.js
   ```

   Whichever you pick, **double-check that the target is the new
   tutorial-system PROD subaccount on EU10-005**, not the legacy IMS US30
   prod. See section "Pre-flight checklist" item 2.

2. **Pre-flight extras.** Before running the prod migrator:

   - The BTP subaccount migration (legacy IMS US30 → DevRel & Community
     Tools EU10-005) is complete and role collections are populated
     (see [BTP role migration](btp-role-migration.md)).
   - Maintenance window is scheduled and communicated. The migrator
     truncates target tables; users hitting the site mid-migration get
     intermittent 404s on `/tutorials/*` and 500s on `/build/catalog`.
   - **Take a HANA point-in-time backup or note the latest automated
     snapshot timestamp.** The default backup retention is 14 days but
     verify on the prod subaccount before kickoff. Per
     [memory feedback_hdi_deploys_can_wipe_data](https://github.com/sap-tutorials/tutorials-ims/blob/main/CLAUDE.md),
     a forced-truncate-then-failed-migration is the closest thing this
     project has to "production data loss". A backup is the only
     guaranteed revert path.

3. **Sign-off bar is higher.** In addition to the DEV criteria:

   - Per-entity row counts in the post-migration baseline match the
     pre-migration source counts within ±0 for reference data
     (tutorials, missions, groups, tags, events, completionpaths) and
     ±2 for activity data (TaskRecords, AccomplishmentRecords,
     PrizeRecords) per
     [the cutover-rehearsal spec](../../../superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md).
   - User progress smoke: log in as a known-good test user, navigate
     to a tutorial they completed pre-migration, verify the per-step
     progress UI marks completed steps.
   - Joule chat smoke (if `ChatSettings.enabled = true`): one round
     trip on `/chat/stream` returns a non-empty response.

## See also

- [Migration from IMS](migration-from-ims.md) — the canonical reference-data + user-progress flow.
- [Dedupe Step rows](dedupe-step-rows.md) — companion data-repair runbook for the legacy duplicate Step rows.
- [BTP role migration](btp-role-migration.md) — role-collection user assignments (independent of data-layer migration).
- [HDI deploy checklist](hdi-deploy-checklist.md) — required reading before merging PR B.
- [Postmortem 2026-06-05 HDI Data Loss](../../postmortems/2026-06-05-hdi-data-loss.md) — what happens when constraints meet incompatible data.
- Source: [`scripts/migrate-from-hana.js`](../../../scripts/migrate-from-hana.js) (1080 lines).
- Cutover-rehearsal spec: [`docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md`](../../superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md).
