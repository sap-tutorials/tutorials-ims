# NGDS `trackingInfo.tracking` parity fix, backfill, and PROD resend

**Date:** 2026-08-14
**Status:** Design — awaiting review
**Issue trigger:** SMC feedback — PROD NGDS messages arrive without `trackingInfo.tracking`, so SMC filters them out and never assigns badges. Also verify `imsData.IMSName` / `imsData.CommunityID` presence.

## Problem

The NGDS outbound payload built in `srv/lib/ngds-client.js` derives `trackingInfo.tracking`
from the TaskRecord's `submissionIdCompleted` (on completion) or `submissionIdStarted`
(on start). Those fields are **never populated** on the CAP write paths, so `tracking`
is omitted from every payload (the `put()` helper drops null/undefined keys, matching
Gson's default null-omission). SMC uses `tracking` as its dedup/tracking key and filters
out any message lacking it — so no PROD badge is ever assigned.

### Root cause (legacy vs CAP)

Legacy `com.sap.developers.ims` `TaskRecord.java` stamps the id in a JPA lifecycle hook
that fires on **every** persist/update:

```java
@PrePersist @PreUpdate
private void syncTaskType() { ...; updateTaskRecordStatus(this); }

private void updateTaskRecordStatus(TaskRecord tr) {
    if (COMPLETED.equals(status))      { tr.setProgress(100); setSubmissionIdCompleted(); }
    else if (progress == 100)          { tr.setStatus(COMPLETED); setSubmissionIdCompleted(); }
    else                               { tr.setStatus(IN_PROGRESS); setSubmissionIdStarted(); }
}
private void setSubmissionIdCompleted() { if (submissionIdCompleted == null) submissionIdCompleted = UUID.randomUUID().toString(); }
private void setSubmissionIdStarted()   { if (submissionIdStarted   == null) submissionIdStarted   = UUID.randomUUID().toString(); }
```

So legacy `trackingInfo.tracking` was **always** a non-null UUID. The CAP rewrite reused
the field names but never generates the UUID — the two completion write paths
(`createTaskRecord`, `_updateTutorialProgress`) insert/update TaskRecords without setting
`submissionId*`. `ngds-client.js:213` reads the null value and the key is omitted.

### Field parity verdict (answer to the SMC questions)

| Field | Status vs legacy | Notes |
|---|---|---|
| `trackingInfo.tracking` | **MISSING** — root cause | CAP never generates the submission-id UUID legacy stamped in `@PrePersist/@PreUpdate`. |
| `imsData.IMSName` | Present | `ngds-client.js:89`, from mission/tutorial title → `titleSnapshot` fallback. Matches legacy `setImsName(task.getTitle())`. |
| `imsData.CommunityID` | Present (missions only) | `ngds-client.js:163`: `communityMissionId || legacyId` (string). Byte-for-byte with legacy `setTaskRecordImsData`. Depends on migrated `Missions.communityMissionId`; falls back to legacy-id string exactly as legacy. |

## Goals

1. **Fix** — new TaskRecord writes stamp a stable `submissionId` UUID, reproducing legacy
   semantics with **100% parity** (every status-bearing write, all task types).
2. **Backfill** — populate the missing `submissionId` on all historical rows (full
   integrity), idempotently.
3. **Resend** — in PROD, re-POST every NGDS-eligible completion that should have been
   delivered but was filtered, using the (now backfilled) tracking id.

Non-goals: changing the NGDS auth flow, the send allowlist, the auto-send gates, or the
`imsData`/`interactionData`/`context` shapes (all already legacy-faithful).

## Design

### Shared contract

`submissionId` (persisted on the TaskRecord) **is** NGDS `trackingInfo.tracking`. Stable +
idempotent: generated once (only-if-null), reused by every (re)send, so SMC can dedup.

### Artifact 1 — code fix (100% legacy parity)

New pure helper `srv/lib/task-record-submission-id.js`:

```js
import cds from '@sap/cds';

// Stamp the legacy submission-id onto a TaskRecord write payload, mirroring
// com.sap.developers.ims TaskRecord.updateTaskRecordStatus (@PrePersist/@PreUpdate).
//   target   — the object being written (INSERT .entries() or UPDATE .set()).
//   existing — the current DB row on an UPDATE (optional), so we honor legacy's
//              only-if-null semantics and never regenerate a stable id.
// No-op for any status other than COMPLETED / IN_PROGRESS (e.g. SUPERSEDED).
export function stampSubmissionId(target, existing = null) {
  const status = target.status ?? existing?.status;
  if (status === 'COMPLETED') {
    if (!target.submissionIdCompleted && !existing?.submissionIdCompleted)
      target.submissionIdCompleted = cds.utils.uuid();
  } else if (status === 'IN_PROGRESS') {
    if (!target.submissionIdStarted && !existing?.submissionIdStarted)
      target.submissionIdStarted = cds.utils.uuid();
  }
  return target;
}
```

Applied at every status-bearing TaskRecord write:

| File | Site | Op | Action |
|---|---|---|---|
| `developer-service.js` | :221 | INSERT STEP COMPLETED | stamp completed |
| `developer-service.js` | :298 | INSERT TUTORIAL IN_PROGRESS (reset) | stamp started |
| `developer-service.js` | :351 | UPDATE → COMPLETED (createTaskRecord) | stamp completed, `existing` guards only-if-null |
| `developer-service.js` | :374 | INSERT → COMPLETED (createTaskRecord) | stamp completed |
| `developer-service.js` | :1132 | UPDATE → {progress,status} (_updateTutorialProgress) | stamp per status, `existing` guards |
| `developer-service.js` | :1145 | INSERT → {status,progress} (_updateTutorialProgress) | stamp per status |
| `puzzle-service.js` | :208 | INSERT PUZZLE COMPLETED | stamp completed |
| `petoberfest-upload.js` | :39 | INSERT PETOBERFEST COMPLETED | stamp completed |
| `content-store.js` | :128 | UPDATE recompute {progress,status} | stamp per status; add `submissionId*` to the row SELECT (:~105) for only-if-null. Data-only — does **not** send (bulk recompute never floods NGDS). |

Explicit no-ops (helper returns unchanged): `→ SUPERSEDED` updates in both reset paths
(`developer-service.js:293`, `puzzle-service.js:259`) and `account-merge.js:17` (reassigns
`user_ID`, no status transition).

The send allowlist (`TUTORIAL/GROUP/MISSION` in `maybeAutoSendCompletion`) is unchanged —
data parity (stamp all) and send parity (allowlist) are independent, both preserved.

### Artifact 2 — backfill script `scripts/ngds-backfill-submission-ids.cjs`

Internal-only (no external calls), idempotent, full-integrity scope. Runs via
`cds bind --exec` against the target HANA.

- `COMPLETED` rows with null `submissionIdCompleted` → generate one.
- `IN_PROGRESS` rows with null `submissionIdStarted` → generate one.
- `--dry-run` (default): print candidate counts by status; no writes.
- `--execute`: batched parameterized `UPDATE ... WHERE ID = ?` (per-row UUID). Batch size
  configurable (default 500). Re-runnable: only-if-null WHERE clause makes repeats safe.
- Reports rows scanned / updated / skipped.

### Artifact 3 — resend script `scripts/ngds-resend-missing-tracking.cjs`

Re-POSTs eligible completions using the backfilled tracking id. Reuses the **exact**
auto-send gates (from `ngds-autosend.js`) except the CF-space gate (the operator targets
PROD deliberately via `cds bind`):

- `status = 'COMPLETED'`
- `taskType ∈ {TUTORIAL, GROUP, MISSION}`
- `createdBy != 'migration'`
- `completionDate >= ngds.autosend.epoch` (read from `ImsConfig` — no hand-fed date floor;
  same watermark auto-send uses; legacy already credited pre-cutover achievements)
- user has canonical `sapId` (`/^[PSIps]\d{6,}$/`)

For each match it calls the existing `sendTaskRecordToNgds(record, db)` (rebuilds the
legacy payload, now with `tracking`), which **queues to `NGDSFailedMessages` on failure**
so the 2h `ngds-retry` job drains stragglers (closed loop, no new retry infra).

Safety rails:
- `--dry-run` (default): counts + a sample of resolved payloads; no POST.
- `--execute`: required to POST.
- `--limit N`: canary batch — send a handful, confirm badges land at SMC, then full run.
- `--completed-before <iso>`: optional ceiling (pass fix-deploy timestamp to skip records
  already delivered with tracking; harmless either way — SMC dedups on `tracking`).
- Throttled sequential sends (small inter-request delay, default ~50ms) reusing the
  module-level token cache in `ngds-client.js`. Progress logged every N.
- Idempotent/re-runnable: stable backfilled id → identical `tracking` → SMC dedups.

### Data flow / ordering

`fix` (going forward) → `backfill` (historical rows) → `resend` (re-POST historical). The
resend reads the persisted id, so **backfill must run before resend**.

## Error handling

- Helper: pure, cannot throw on valid input; no-op on unexpected status.
- Fix sites: stamping is a field assignment before an existing write; no new failure modes.
- Backfill: per-batch; a failed batch is logged and the script exits non-zero so it can be
  re-run (idempotent).
- Resend: per-record try/catch; failures queue to `NGDSFailedMessages` (existing path) and
  the script continues. Final summary: sent / queued / skipped-by-gate.

## Testing

- **Unit (in-memory):** `stampSubmissionId` truth table (COMPLETED, IN_PROGRESS, SUPERSEDED,
  existing-id-present, target-id-present). A completion driven through `createTaskRecord`
  and `_updateTutorialProgress` persists a non-null `submissionId*`, and the built NGDS
  payload contains `trackingInfo.tracking`. Reset insert persists `submissionIdStarted`.
- **Update existing NGDS payload tests** to assert `tracking` present (currently they may
  assert omission).
- **Regression:** run the full unit suite — stamping IN_PROGRESS/reset rows may trip row-shape
  assertions in progress tests; update any that pin exact TaskRecord fields.
- **Scripts:** dry-run against hybrid HANA (`cds bind --exec`) to verify counts + eligibility
  filter. No `--execute` in automated tests (no external POSTs / no PROD writes in CI).

## Deploy safety

- New `srv/lib/task-record-submission-id.js` is imported transitively from
  `srv/lib/content-store.js` → **add it to the `srv-qa` `cp` list in `.deploy/mta.yaml`**
  (else QA boot crashes at MTA deploy). Re-walk the `content-store.js` `./` import graph
  after the change.
- No schema change (`submissionId*` columns already exist on `TaskRecords`).

## PROD rollout sequence

1. Merge fix via PR (never direct to main) → deploy to PROD (full `mbt build`, standard
   sequence + content publish step).
2. `ngds-backfill-submission-ids.cjs --execute` against PROD HANA (`cds bind --exec`).
3. `ngds-resend-missing-tracking.cjs --limit <small> --execute` — canary; confirm badges
   with the SMC team.
4. `ngds-resend-missing-tracking.cjs --execute` — full run; monitor `ngds.*` metrics and the
   `NGDSFailedMessages` backlog / `NgdsBacklog` alert.

## Assumptions / risks

- **SMC dedups on `trackingInfo.tracking`.** The canary step de-risks this before the full
  blast. If SMC does *not* dedup, use `--completed-before <fix-deploy-ts>` to avoid
  re-sending already-delivered records.
- `ngds.autosend.epoch` is set in PROD to the go-live watermark. Verify its value before the
  resend run; if unset, the resend has no lower bound (migration-stamp guard still excludes
  legacy-carried rows).
- Resend volume unknown until dry-run; the throttle + canary keep the first pass controlled.
