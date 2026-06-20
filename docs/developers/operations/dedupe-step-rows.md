# Dedupe migrated Step rows

One-shot data repair for the Java IMS cutover footprint in `Steps`. Runs
dry-by-default; no DB writes happen until `--commit` is passed.

## Background

The Java IMS migration (`scripts/migrate-from-hana.js`) inserted Step rows
into the new CAP DB with:

- `STATUS = NULL`
- `stepOrder` 0-based (0, 1, 2, ...)

After cutover, the CAP publish path
([srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js))
re-creates Step rows from the Hugo build with:

- `STATUS = 'ACTIVE'`
- `stepOrder` 1-based (1, 2, 3, ...)

The publish path never noticed or replaced the migrated rows, so today both
populations coexist for almost every tutorial — roughly 9000 migrated rows
plus 9000 native rows.

`getProgress` in [srv/developer-service.js](../../../srv/developer-service.js)
maps each user's STEP `TaskRecord.taskLegacyId` onto `Steps.stepOrder`. The
duplicates inflate `completedSteps[]` with off-by-one 0-based indices that
miss the rendered DOM (`data-step="1..N"`). Symptom: the per-step UI
silently fails to mark steps complete on the detail page, even when the
tutorial-level row says COMPLETED 100%.

### Concrete example

Tutorial `abap-create-project` with declared `stepCount=5` had 6 Step rows:

| legacyId | stepOrder | STATUS | TITLE                              |
|---------:|----------:|--------|------------------------------------|
| 106      | 0         | NULL   | Step 1: Install ABAP Dev Tools     |
| 107      | 1         | ACTIVE | Install ABAP Dev Tools             |
| 108      | 2         | ACTIVE | Create an ABAP Cloud Project       |
| 109      | 3         | ACTIVE | Create an ABAP Package             |
| 110      | 4         | ACTIVE | Test yourself                      |
| 10009603 | 5         | ACTIVE | Test yourself                      |

User TaskRecords reference 106–110 (migrated legacyIds), so Step 5 (legacyId
10009603, added recently) never shows complete on the detail page.

## Affected scope

- 1372 / 1397 tutorials have more Step rows than `Tutorials.stepCount`.
- ≈ 9000 migrated Step rows scheduled for removal.
- TaskRecord redirects: most users who completed Step 1 of any tutorial have
  *both* the migrated and the native record. Those collisions are resolved
  by deleting the migrated record (the native one is canonical).

## Pre-flight: dry-run

Always start with the verbose, scoped dry-run on a single tutorial:

```bash
npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs \
  --slug abap-create-project --dry-run --verbose
```

Expected shape: 1 pair (legacyId 106 → 107), TaskRecord redirects split
into mostly `collision-delete` (users with both records) and a small
`redirect` count (users with only the migrated record).

## Stage the rollout

The script supports `--limit N` so the rollout can be staged:

```bash
# 1. Single tutorial — visually inspect the verbose output.
npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs \
  --slug abap-create-project --commit --verbose

# 2. Smoke 10 tutorials.
npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs \
  --limit 10 --commit

# 3. Smoke 100.
npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs \
  --limit 100 --commit

# 4. Full sweep.
npx cds bind --exec -- node scripts/dedupe-migrated-step-rows.cjs --commit
```

Each tutorial is processed inside its own DB transaction. A failure on
tutorial N rolls back tutorial N only and the loop continues — partial
completion is safe to resume; there is no global transaction to "leave
half open".

## Verify

Two checks after a full commit:

1. Re-run the hybrid CI guard. It must turn green:

   ```bash
   npm run test:hybrid -- test/hybrid/duplicate-step-rows.test.js
   ```

2. Spot-check `abap-create-project`:

   ```bash
   npx cds bind --exec -- node -e '
     const cds = require("@sap/cds");
     (async () => {
       const db = await cds.connect.to("db");
       const r = await db.run(`
         SELECT t."SLUG", t."STEPCOUNT", COUNT(s."ID") AS C
           FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t
           JOIN "COM_SAP_DEVELOPERS_IMS_STEPS" s ON s."TUTORIAL_ID" = t."ID"
          WHERE t."SLUG" = ?
          GROUP BY t."SLUG", t."STEPCOUNT"
       `, ["abap-create-project"]);
       console.log(r);
       process.exit(0);
     })();
   '
   ```

   Expect `STEPCOUNT = C`.

## Rollback

Each tutorial's changes are committed in their own HANA transaction. Once
the transaction commits there is no script-level revert path — the dropped
migrated Step rows and TaskRecord rows are gone.

For full revert, restore from a HANA point-in-time snapshot taken
**before** the script was run with `--commit`. Do not promise revertability
without verifying that a snapshot exists in the BTP backup retention
window (default is 14 days but verify the subaccount setting before each
production run).

The conservative rollout pattern is:

1. Take a HANA backup or note the latest automated snapshot timestamp.
2. Run `--limit 1` first; manually inspect.
3. Stage the rollout in increasing limits.
4. Watch `getProgress` traffic in app logs for any 5xx during/after.

## Flags

| Flag                | Default | Description |
|---------------------|---------|-------------|
| `--dry-run`         | yes     | Plan only, no writes. Implicit when `--commit` is absent. |
| `--commit`          | no      | Apply the changes. Per-tutorial transaction. |
| `--slug <slug>`     | —       | Process one tutorial only. |
| `--limit <N>`       | —       | Process at most N tutorials. |
| `--verbose`         | no      | Log every pair, redirect, collision, orphan. |
