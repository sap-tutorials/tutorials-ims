# Backfilling Users.email / firstName / lastName / displayName from SCI

Step-by-step runbook for bulk-populating profile fields on `Users` rows that landed without them — typically after an IMS migration / cutover. Source of truth is the SCI (SAP ID Service) legacy `/cps/user/{sapId}.json` endpoint, the same one the legacy IMS Java `SciClientImpl` used per-login.

Companion to [Migration from IMS](migration-from-ims.md) — this is "Step 5" in spirit (after user progress lands, profile fields lag).

## When to run

- After every bulk user migration / IMS cutover when `Users.email` is NULL on a significant fraction of rows.
- After any one-shot import that creates `Users` rows from a `sapId`-only source (e.g. seeding accounts before they've ever logged in).
- **Not** routinely — the CAP runtime self-heals on user login. This is a one-shot to unblock bulk reporting paths (admin search-by-email, advocate value-help, #620 tutorial-author backfill).

A quick check for whether you need to run it:

```bash
npx cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  (async () => {
    await cds.connect.to('db');
    const r = await cds.db.run('SELECT COUNT(*) AS C FROM \"COM_SAP_DEVELOPERS_IMS_USERS\" WHERE EMAIL IS NULL AND SAPID IS NOT NULL');
    console.log('candidates:', r[0].C);
    process.exit(0);
  })();
"
```

If `candidates` is in the tens of thousands or more, run this. If it's < 100, the self-heal-on-login path will close the gap organically.

## Prerequisites

- `cf login` to the target subaccount (e.g. `tutorial-system / dev`).
- `tutorials-destination` service bound to a CAP app in the same subaccount (the script uses `@sap-cloud-sdk/connectivity` to resolve the destination).
- Valid `SCI_prod` destination in the BTP cockpit with a **real** password — not the literal `<removed>` placeholder that BTP cockpit export writes. The cockpit transfers the destination shell on export/import, but not the credential — you must re-paste the real password after an import.
- Service account on the `tutorial-system` subaccount has read access to the SCI legacy CPS endpoint. SCIM is not required.

## Step 1 — Verify the destination before the backfill

Always run the probe first. It distinguishes "credentials are wrong" from "rate-limit cooldown" — two failures with the same 403 symptom.

```bash
npx cds bind --exec -- node scripts/probe-sci-destination.cjs
```

Expected output (excerpt):

```text
=== SCI_prod (https://accounts.sap.com, user=…, pwdLen=24) ===
  [200] Legacy CPS endpoint
        path: /cps/user/P1941183212.json
        body: {"user":{"mail":"…","firstName":"…","lastName":"…","displayName":"…",…
  [401] SCIM ServiceProviderConfig (open)
  …
```

The line that matters is `[200] Legacy CPS endpoint`. The SCIM lines are expected to be 401/403 — the SA doesn't have SCIM Read Users role and the backfill doesn't use SCIM. If the legacy CPS line is anything other than 200, **do not run the backfill** — see Troubleshooting below.

You can probe a specific sapId and / or destination:

```bash
npx cds bind --exec -- node scripts/probe-sci-destination.cjs P1234567890 SCI_prod
```

## Step 2 — Smoke test (dry-run, 10 rows)

Always do this before any commit run. It exercises the full pipeline (destination resolution, paging, SCI fetch, report write) without touching the database.

```bash
npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --limit=10
```

Expected output (excerpt):

```text
[backfill-user-profiles] DRY RUN — no DB writes
[backfill-user-profiles] candidates_total: 789080
[backfill-user-profiles] page offset=0 size=10 fetched=10
[backfill-user-profiles] sapId=P… → matched (email=…, displayName=…)
…
[backfill-user-profiles] processed=10 matched=10 updated=0 (dry-run) not_found=0 failed=0
[backfill-user-profiles] report: .migration-data/user-profile-backfill-<ts>.json
```

If `matched` is significantly less than `processed`, inspect the report — a high `not_found_404` count is normal (ex-employees), but a high `failed_other` count means the SCI endpoint is misbehaving (rate-limit or auth drift). Go back to Step 1.

## Step 3 — Calibrate rate before going full-volume

SCI throttles aggressively. The default `--concurrency=5` empirically trips a per-account / per-IP block after ~10 burst calls (observed during #632 dev, 2026-06-25). Once tripped, every sapId returns 403 for 30-60 min — including ones that worked moments earlier.

Run progressively larger batches at increasing `--throttle-ms` values until you find a sustainable rate. **The script does not commit during these calibration runs** (no `--commit` flag).

```bash
# 100-row probe at 1 req/s
npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --limit=100 --throttle-ms=1000

# If clean, push to 500 rows at 500 ms
npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --limit=500 --throttle-ms=500

# If clean, push to 1000 rows at 200 ms
npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --limit=1000 --throttle-ms=200
```

Record the largest run that finished with zero `failed_other` entries. That `--throttle-ms` value is your sustainable rate. As of 2026-06-25, there is no historical baseline — the legacy IMS Java app runs at trickle-rate (one CPS call per login) and never hit the bulk limit. Update this section once a real rate is measured.

If every calibration run trips 403, the SCI block is in effect — wait 30-60 min and try again at a lower rate. If it never clears at any rate, the credentials may have drifted; go back to Step 1.

## Step 4 — Full backfill

```bash
npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --commit --throttle-ms=<calibrated>
```

Expected ETA at common rates (789k candidates):

| `--throttle-ms` | ETA          |
| --------------- | ------------ |
| 100             | ~22 hours    |
| 500             | ~110 hours   |
| 1000            | ~220 hours   |
| 2000            | ~440 hours   |

If the calibrated rate makes the wall-clock infeasible, that's the signal to escalate to the SCI / Customer Identity team for a rate-limit lift on the technical user — bulk reads at trickle-rate is not a real fix for a 789k backfill. Track the request and document the outcome here.

The JSON report lands at `.migration-data/user-profile-backfill-<ts>.json` with full counters and per-error detail. The directory is gitignored.

## Step 5 — Resume after a crash

The script writes its current offset to the report on every page. If it crashes (or you Ctrl-C it), re-run with `--offset=N` where N is the last successful row number from the previous report.

```bash
npx cds bind --exec -- node scripts/backfill-user-profiles.cjs --commit --throttle-ms=<n> --offset=450000
```

Resume is safe because the idempotent UPDATE gate (`WHERE EMAIL IS NULL`) means re-processing the same row a second time is a no-op. Worst case `--offset=0` re-walks everything, which is slow but correct.

## Step 6 — Verify the result

```bash
npx cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  (async () => {
    await cds.connect.to('db');
    const r = await cds.db.run('SELECT COUNT(*) AS C FROM \"COM_SAP_DEVELOPERS_IMS_USERS\"');
    const r2 = await cds.db.run('SELECT COUNT(*) AS C FROM \"COM_SAP_DEVELOPERS_IMS_USERS\" WHERE EMAIL IS NOT NULL');
    console.log('total:', r[0].C, 'with email:', r2[0].C, 'ratio:', (r2[0].C / r[0].C).toFixed(3));
    process.exit(0);
  })();
"
```

Expected ratio post-backfill is roughly `(789k - 404s) / 789k` ≈ 0.95-0.99 depending on how many ex-employee sapIds 404'd. A ratio below 0.5 means the backfill silently failed at scale — inspect the most recent JSON report's `failed_other` array and re-run with `--offset=<first-failure>` after diagnosing.

Then re-run the #620 tutorial-author backfill ([backfill-tutorial-authors.cjs](../../../scripts/backfill-tutorial-authors.cjs)) — it should now match a non-zero fraction of contributors.

## Troubleshooting

**Probe returns `[403]` on the legacy CPS line**

Two possible causes, in order of likelihood:

1. **Rate-limit cooldown.** Most common. Wait 30-60 min and re-probe at 1 req/min. If the second probe (after the wait) returns 200, the cause was rate-limit; proceed with calibration at `--throttle-ms=1000+`.
2. **Destination password drifted.** If the wait doesn't clear the 403, check the `SCI_prod` destination in the BTP cockpit. Look specifically at the password field — BTP cockpit destination **export** writes the literal `<removed>` for passwords, and import does NOT prompt for it. Re-paste the real password and save.

If the wait + password re-paste still 403s, the service-account role on the SCI tenant may have been removed. Contact the SCI / Customer Identity team for the `tutorial-system` subaccount.

**`SCI_prod destination not visible. Bind tutorials-destination and verify cockpit entry.`**

The destination service binding isn't reachable from the current CDS context. Run `cf bind-service` to bind `tutorials-destination` to a CAP app in the subaccount, or verify the `SCI_prod` entry exists in the destination service (BTP cockpit → Connectivity → Destinations).

**`SCI_prod destination password is empty or redacted. Edit destination in BTP cockpit.`**

Same as the password-drift case above. Re-paste the real password in the cockpit.

**Report shows high `failed_other` count mid-run**

You've hit the rate-limit threshold partway through. The script keeps going with its retry-once-then-fail policy, so a chunk of rows will be marked failed in the report. Two options:

1. Wait for the cooldown, then re-run with `--offset=<row-where-failures-started>` to re-process the failed rows. The idempotent gate means rows already updated are skipped.
2. Lower `--throttle-ms` and re-start.

## What this does NOT do

- **No `avatarUrl` backfill.** The CPS response shape has no photo URL field. SCIM would, but the technical user lacks the SCIM Read Users role on this tenant and the advocate-photo path uses a separate `AdvocatePhotos` BLOB store anyway.
- **No SCIM calls.** The script only uses `/cps/user/{sapId}.json`. SCIM endpoints are probed by `probe-sci-destination.cjs` for diagnostic purposes only.
- **No new `Users` rows.** UPDATE-only. If a `sapId` exists in SCI but not in `Users`, this script will not create the row — that's the migrator's job.
- **No change tracking suppression.** `Users` is not `@changelog`-tracked today (only `@PersonalData`-annotated), so audit-log events for the UPDATEs WILL fire. Expected volume is one event per updated row. If that becomes a problem, file a follow-up — the existing `x-migration-mode` header pattern (`migration-from-ims.md` § Step 1) would need to be extended to direct-DB writers.

## See also

- [Migration from IMS](migration-from-ims.md) — Steps 1-4 (reference data, user progress, tutorial authorship).
- [BTP destinations (SCI / NGDS)](btp-destinations.md) — destination-service setup.
- Issue [#632](https://github.com/sap-tutorials/tutorials-ims/issues/632) — origin of this script.
- PR [#634](https://github.com/sap-tutorials/tutorials-ims/pull/634) — discovered the empty-email gap.
