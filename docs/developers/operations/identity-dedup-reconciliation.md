# Identity dedup — duplicate-email reconciliation runbook (#2651)

**Status:** NOT auto-executed. Human-operator procedure. The dry-run numbers are reviewed with the maintainer before any mutation runs.

## Background

Pre-#2552 (and, until #2661, for IAS logins), the same human could get a second `Users` row — the login resolver minted a new row instead of matching the existing one on email. `reconcileDuplicateEmails` (`srv/jobs/identity-dedup-job.js`) walks duplicate-email `Users` clusters, picks the canonical row per cluster (`pickCanonicalRow`), and folds the others into it via `mergeAccounts`. ~349 clusters in PROD at the time of #2661.

## Why this is a manual step (not a scheduled/admin job)

`reconcileDuplicateEmails` is deliberately **NOT** registered in `JOB_REGISTRY` (`srv/jobs/scheduler.js`). Registry entries get BOTH a cron schedule AND a one-click admin `runJob` button — either path would let a stray trigger execute merges across all clusters with no dry-run gate. A mutating reconciliation must stay invocation-only, with the operator explicitly choosing `dryRun`.

## Invocation path

Run against the target environment's HANA via the documented hybrid/cf-env read path (same binding method used for PROD probes — move `.cdsrc-private.json` aside in the primary tree, write `default-env.json` from `cf env tutorials-srv`, confirm the connection authenticates as the intended prod container, restore afterward).

From a `cds repl` bound to the environment:
```js
const { reconcileDuplicateEmails } = await import('./srv/jobs/identity-dedup-job.js');

// STEP 1 — DRY RUN (no mutation). Capture the report.
const dry = await reconcileDuplicateEmails({ dryRun: true });
console.log(JSON.stringify(dry, null, 2));
// Expect roughly: { clusters, merges, pointsBefore, pointsAfter, capTrims, executed: false }
```

## STEP 2 — Review with maintainer (gate)

- `clusters` — matches the PROD dup-email count established during root-cause probing.
- `merges` — number of secondary rows to fold in.
- `pointsBefore` vs `pointsAfter` — the delta is points lost to the daily-5 / event-100 caps on collision. Some trim is expected and correct (ruling: trim to 100); a LARGE unexpected gap is a red flag — stop and investigate.
- `capTrims` — total points trimmed by the per-event 100-cap. Should be modest.

Only proceed to Step 3 after the maintainer approves the numbers.

## STEP 3 — EXECUTE (mutating)

Confirm `cf target` is the intended environment first. Then:
```js
const live = await reconcileDuplicateEmails({ dryRun: false });
console.log(JSON.stringify(live, null, 2)); // executed: true
```
Run `{ dryRun: false, limit: 1 }` first as a canary — collapse ONE cluster, verify it (below), then run the full batch.

## STEP 4 — Re-verify (close the loop)

1. **The reporter (see #2651 for the account):** previously-forked rows now resolve to a single consolidated row. `SELECT` their `Users` rows by email → one canonical row carrying the real sapId.
2. **Counter == leaderboard:** stranded `CatGameAwards` points now join a `GAMEBOARD_PARTICIPANT_V1` row (the inner-join to `EventRegistrations` was why stranded awards were invisible). `GAMEBOARD_BONUS_V1` points for that user now appear on the leaderboard and match the in-game counter.
3. **Sample a few other reconciled clusters** to confirm no over-merge (two distinct humans wrongly collapsed) — spot-check that merged clusters shared a real verified email, not a GitHub-synthetic noreply address (filtered by `NOREPLY_GITHUB_RE`, but confirm).

## Rollback note

`mergeAccounts` records every merge in `SecondaryAccounts` (status MERGED, `mergedAt`, `primaryAccount_ID`) — the audit trail of what was folded where, and the basis for any manual unwind if an over-merge is discovered. There is no automated un-merge; investigate via `SecondaryAccounts` before executing.
