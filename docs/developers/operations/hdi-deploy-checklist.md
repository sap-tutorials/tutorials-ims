# HDI Deploy Checklist

Procedure for safe HDI deploys to `tutorials-hana` (DEV) and `tutorials-hana-qa` (QA). Filed after the 2026-06-05 data-loss incident (issue [#257](https://github.com/sap-tutorials/tutorials-ims/issues/257)).

> **See also:** [2026-06-05 HDI Data Loss postmortem](../../postmortems/2026-06-05-hdi-data-loss.md) — the incident this checklist responds to.

## Why this exists

On 2026-06-05 a series of HDI deploys (4+ iterations of the `.hdbindex` saga, [PRs around #227 / #249 / #253](https://github.com/sap-tutorials/tutorials-ims/issues/257)) wiped relational catalog data: `Missions`, `Groups`, `CompletionPaths`, `Events`, `TutorialTags`, `MissionTags`, `Accomplishments`, plus ~20 other tables — while preserving `Tutorials`, `TutorialMeta`, `ContentFiles`, `Steps`, `Users`, `TaskRecords`. The smoking gun was two `Rolled back` deploys in the deployer log; older logs aged out before forensic capture.

**Root cause never fully isolated** because CF retains only ~30 minutes of `cf logs --recent` after a deploy completes. Post-mortem visibility is the missing piece this checklist fixes.

## TL;DR

Before any HDI-touching deploy:

```bash
# 1. Snapshot current row counts
mkdir -p .hana-snapshots
npm run hana:rowcounts -- --snapshot .hana-snapshots/pre-deploy-$(date +%Y%m%dT%H%M%S).json

# 2. Save the deployer log for forensics
cf logs tutorials-db-deployer --recent > .hana-snapshots/db-deployer-pre-$(date +%Y%m%dT%H%M%S).log

# 3. Deploy
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f

# 4. Save the post-deploy log immediately
cf logs tutorials-db-deployer --recent > .hana-snapshots/db-deployer-post-$(date +%Y%m%dT%H%M%S).log

# 5. Scrape the post-deploy log for danger patterns
npm run hana:scrape-deployer-log -- --file .hana-snapshots/db-deployer-post-$(date +%Y%m%dT%H%M%S).log

# 6. Compare row counts; non-zero exit = tripwire fired
npm run hana:rowcounts -- --diff .hana-snapshots/pre-deploy-<timestamp>.json
```

If step 5 or 6 fails, **stop** and investigate before further deploys.

## The two prevention tools

### `npm run hana:rowcounts`

Reads `SYS.M_TABLES` for all `COM_SAP_DEVELOPERS_IMS_*` tables and snapshots row counts.

| Mode | Purpose |
|---|---|
| `--probe` | Print table count + total rows. No file IO. Quick smoke. |
| `--snapshot <file>` | Write a full snapshot. Run before every deploy. |
| `--diff <file>` | Compare current state to snapshot. **Exits 2 if any table dropped >5% of its rows** (configurable via `--threshold-pct=N`). |

**Tripwire details:**

- Tables with `<10` rows in the snapshot are excluded — they fluctuate freely (test data, seed CSVs, single-row config).
- The 5% threshold is a `--threshold-pct=N` flag, override per deploy if you intentionally cleaned up large amounts of data.
- A schema mismatch (snapshot was taken against a different HDI container) prints a warning but still compares.

### `npm run hana:scrape-deployer-log`

Reads `cf logs tutorials-db-deployer --recent` (or `--file <path>` for offline analysis) and looks for patterns that indicate data loss:

| Pattern | Severity | Meaning |
|---|---|---|
| `Rolled back` | CRITICAL | Previous build was rolled back — schema may be in an inconsistent state |
| `Files to undeploy: [non-empty]` | CRITICAL | Listed artifacts WILL be dropped |
| `TABLE_REPLACE` | CRITICAL | Explicit table-replace operation (data loss) |
| `DROP TABLE` | CRITICAL | Direct drop issued by HDI |
| `deleted files not in undeploy.json` | WARNING | Schema artifacts removed without explicit undeploy listing |
| `Container … is being rebuilt` | WARNING | Full container rebuild in progress |
| `[1-9]\d* deleted files are scheduled` | WARNING | Non-zero deleted files scheduled for undeploy |

Exit codes: 0 = no critical findings, 2 = critical pattern detected.

## Standing rules going forward

1. **Never deploy `.hdbindex` / `@sql.append` / `.hdbmigrationtable` changes without a prior snapshot.** The two-minute snapshot would have caught the 2026-06-05 incident at step 6 of the next deploy, instead of being discovered hours later when a user reported "All 0 items".

2. **Never iterate HDI-syntax fixes via repeated deploys.** Each retry is a new opportunity for HDI to enter rollback. Validate the syntax locally with `cds build --production` and `mbt build` first; only deploy after the local artifacts look right.

3. **Save the deployer log immediately after each deploy.** `cf logs --recent` is a ring buffer — it loses old entries as the app emits new ones. The 2026-06-05 forensics gap was caused by waiting too long to read the log.

   *Update (#257 follow-up):* `tutorials-db-deployer` and `tutorials-db-qa-deployer` are now bound to `tutorials-cloud-logging` (mta.yaml). Their stdout is forwarded by the CF loggregator and persisted in **SAP Cloud Logging with ~30-day retention** — multi-day forensics no longer require local capture. The CI step still captures `cf logs --recent` to `.hana-snapshots/` for immediate scraping, but the canonical multi-day source is now Cloud Logging. Open the dashboard via the **Operations → Pipeline Logs** tile in `/admin-ui/` or directly via `cf service-key tutorials-cloud-logging tutorials-cloud-logging-key` → `dashboards.kibana.endpoint`.

4. **Read the warning section of every deploy log.** The "WARNING: deleted files not in undeploy.json" output today flagged 5 stale `.hdbview` / `.hdbtable` artifacts. This warning has been present for a while and was ignored — but it indicates `undeploy.json` is out of date and CF is doing more delete work than expected. **Fix it: add the listed files to `undeploy.json`** so future deploys are explicit about what they're removing.

5. **Run `npm run test:smoke` after deploy.** It hits `/build/catalog`, `/build/navigator`, `/api/Tutorials/$count` — basic data presence checks. The smoke tests are not currently row-count-aware (filed as a follow-up — see [#257](https://github.com/sap-tutorials/tutorials-ims/issues/257) preventive measure 5), but presence is the first line of defense.

## Schema-deploy fast path (DON'T)

Per [[cf-push-db-deployer-fast-path]] memory, there's a `cf push tutorials-db-deployer -p ../gen/db --no-route ...` shortcut that bypasses `mbt build`. It saves ~10 minutes but **bypasses the full `cds build --production` validation chain**. Reserve it for read-only schema introspection or rollback to a known-good gen/db artifact. **For real schema changes, always go through `mbt build`.**

## Recovery cookbook

If a deploy IS the trigger and data is lost:

### Option A: HANA Cloud point-in-time recovery (preferred)

If PITR is enabled on the HDI container:

1. Open SAP HANA Cloud Cockpit → tutorials-hana → Overview → Backup & Recovery
2. Restore to a snapshot timestamp before the bad deploy
3. PITR restores the entire HDI schema; no per-table reconciliation needed

### Option B: migrate-from-hana from IMS prod

If PITR is unavailable or out of retention:

```bash
# Cached IMS prod creds live in .migration-data/ims-creds.json (gitignored)
export IMS_HANA_CREDENTIALS=$(cat .migration-data/ims-creds.json)

# Dry-run first — confirms IMS connectivity + dry-prints the rows
node scripts/migrate-from-hana.js --dry-run --entity=tags,events,groups,missions,completionpaths,completionpathitems,prizes,tutorialtags

# Live (DELETEs target table rows then INSERTs fresh from IMS)
node scripts/migrate-from-hana.js --entity=tags,events,groups,missions,completionpaths,completionpathitems,prizes,tutorialtags

# Assign slugs from .migration-data/slug-mapping.json + delete autotest_* rows
npx cds bind --exec -- node scripts/setup-dev-data.cjs
```

**Caveats** discovered on 2026-06-05:

- Excluding `tutorials` from the entity scope (recommended to avoid clobbering existing TUTORIALS rows) leaves `CompletionPathItems.TUTORIAL_ID = NULL` because the script's `uuidMap.tutorials.get(legacyId)` map is empty.
- The downstream effect: `/build/catalog` returns missions/groups but `tutorialMappings: 0` until the CPI is reconciled separately.
- Reconciling CPI via slug-based join (CPI.TASKLEGACYID → IMS task slug → existing TUTORIALS.SLUG → TUTORIALS.ID) is a follow-up script; not yet built.
- `IMS_TASK` rows are kept indefinitely with `TASK_STATUS = 'DELETED'` for audit. Run a `DELETE FROM ... WHERE STATUS = 'DELETED'` cleanup pass after migration.
- Re-importing TAGS bumps the row count from ~200 (curated) to ~5,621 (full IMS history including duplicates by name across years). This is an acceptable degradation; UI surfaces use slug-based filtering not raw tag rows.

### Option C: Hugo rebuild + redeploy

After A or B, the `/browse/` page still shows the **pre-incident catalog** because its data file is BAKED into Hugo at build time. To refresh:

```bash
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

This is required for the user-visible recovery to surface, regardless of whether you used A or B.

## What this doesn't fix

- **PITR enablement on `tutorials-hana`**. This is a service-instance-level config change in BTP, not a code change. Verify with the BTP admin team. Until PITR is enabled, every HDI mishap risks data loss again.
- **Forensic log retention** (DONE 2026-06-06): the deployer apps are now bound to `tutorials-cloud-logging` so their stdout persists with ~30-day retention. CF's ring buffer is still the immediate source for the CI scrape step, but multi-day post-mortems can now query Cloud Logging directly.

## See also

- Issue [#257](https://github.com/sap-tutorials/tutorials-ims/issues/257) — the data-loss event this checklist responds to
- [`scripts/check-hana-rowcounts.cjs`](../../../scripts/check-hana-rowcounts.cjs) — the snapshot/diff tool source
- [`scripts/scrape-deployer-log.cjs`](../../../scripts/scrape-deployer-log.cjs) — the log scraper source
- [`scripts/migrate-from-hana.js`](../../../scripts/migrate-from-hana.js) — IMS-prod-to-DEV recovery tool
- [`db/undeploy.json`](../../../db/undeploy.json) — explicit undeploy allowlist; keep it current
