# Group / Mission completion rollup — design

**Issue:** Mission & Group completions flatlined at the 2026-08-10 PROD cutover.
**Date:** 2026-08-20

## Problem

Since the Aug-10 cutover to the CAP platform, no GROUP or MISSION `TaskRecords`
are being created (analytics report: blue MISSION and pink GROUP lines drop to
zero on Aug 10 while orange STEP / green TUTORIAL keep flowing).

Root cause (confirmed by code audit): **CAP never implemented the
TUTORIAL→GROUP→MISSION rollup.** The legacy Java IMS computed these on
completion; the CAP rewrite writes STEP→TUTORIAL (`_updateTutorialProgress`)
and stops there. The only path that can mint GROUP/MISSION rows is the generic
legacy `createTaskRecord` action, which nothing in CAP calls internally — it
depended on the now-decommissioned legacy front end / IMS. A
`calculateMissionProgress` helper exists (`srv/lib/status-calculator.js:8`) but
is dead code.

## Goals

1. **Live rollup** — when a tutorial completion changes, recompute the parent
   group(s) and mission(s) and upsert GROUP/MISSION `TaskRecords` with full
   progress (IN_PROGRESS + COMPLETED).
2. **NGDS flow-through (live)** — a GROUP/MISSION transitioning to COMPLETED in
   PROD fires the existing `maybeAutoSendCompletion` path (already gated by
   env=prod + kill-switch + epoch + identity; GROUP/MISSION already eligible).
3. **Backfill** — recompute GROUP/MISSION completions for tutorial completions
   dated on/after the cutover (Aug 10), for users who earned them on the new
   platform.
4. **NGDS flow-through (backfill)** — a separate, explicit, rate-limited,
   resumable step that sends the backfilled GROUP/MISSION completions to NGDS,
   respecting the same gates. Receiver-side dedup on `trackingInfo.tracking`
   (= `submissionIdCompleted`) makes re-runs safe.

Non-goals / deferred: IN_PROGRESS progress bars for groups/missions in the
`/me` UI (data is written; UI is separate). See "Open scope decisions".

## Membership model (confirmed against `db/schema.cds`)

- `Missions` → `CompletionPaths` (`mission`) → `CompletionPathItems` (`path`).
  Item `taskType ∈ {TUTORIAL, GROUP, CHECKPOINT, PUZZLE, PETOBERFEST}` (note:
  path items are never MISSION/STEP). Items carry `tutorial` and `group` assocs,
  `itemOrder`, and alt-group fields (`altGroupKey`, `altGroupLabel`).
- A mission's tutorials = direct `TUTORIAL` items **plus** the tutorials of any
  nested `GROUP` item (resolved via that group's `GroupPathItems`).
- `Groups` → `GroupPathItems` (`group` → `tutorial`), with the same alt-group
  fields.
- `Groups` and `Missions` both derive from `TaskBase` → have `legacyId` +
  `title`. GROUP/MISSION `TaskRecords` key by `taskLegacyId = <entity>.legacyId`,
  `titleSnapshot = <entity>.title`.

### Slot model (all item types; alt-group "any branch satisfies")

A **slot** is one required position in a group/mission, represented by a set of
`(taskType, taskLegacyId)` **tokens**. Items sharing the same `(itemOrder,
altGroupKey)` with a non-null `altGroupKey` collapse into ONE slot (pick-one
branch, tokens unioned); linear items are their own single-token slot. A slot is
**satisfied** when the user has a COMPLETED (non-SUPERSEDED) `TaskRecord`
matching **any** of the slot's tokens. Progress =
`round(satisfiedSlots / totalSlots * 100)`; status COMPLETED at 100%, else
IN_PROGRESS. (Reuses `calculateMissionProgress(satisfied, total)`.)

Item types covered (Tom's decision — include all now): `TUTORIAL`, `PUZZLE`,
`CHECKPOINT`, `PETOBERFEST` are direct slot tokens; a nested `GROUP` item is one
slot satisfied when that group is itself complete (recursively — groups contain
only `TUTORIAL` tutorials per `GroupPathItems`). The user's completed-token set
for a mission is fetched once: COMPLETED non-SUPERSEDED `TaskRecords` whose
`(taskType, taskLegacyId)` fall in the mission's full token set.

## Architecture

### New module: `srv/lib/completion-rollup.js`

Pure-ish (does its own SELECTs via passed `db`); no service coupling. Exports:

- `slotsForGroup(groupId, db)` → `[{ tutorialLegacyIds: number[] }]` (alt-group
  collapsed).
- `slotsForMission(missionId, db)` → `[{ kind:'tutorials', tutorialLegacyIds }
  | { kind:'group', groupId }]`.
- `computeStatus(slots, completedTutorialLegacyIdSet, db)` → `{ progress,
  status, latestCompletionDate }` (recursively resolves nested-group slots).
- `findParents(task, db)` where `task = { taskType, taskLegacyId, tutorialId? }`
  → `{ groupIds:Set, missionIds:Set }`. Groups apply only to `TUTORIAL` tasks
  (via `GroupPathItems.tutorial`). Missions found directly via
  `CompletionPathItems{taskType, taskLegacyId}` → path → mission, plus (for
  TUTORIALs) via `CompletionPathItems{taskType:'GROUP', group ∈ groupIds}` →
  path → mission.
- `upsertRollupRecord({ dbUser, kind, entity, progress, status,
  completionDate, db, send })` → SELECT-then-UPDATE-or-INSERT on
  `(user_ID, taskLegacyId, taskType, status != 'SUPERSEDED')`, mirroring
  `_updateTutorialProgress`. Uses `stampSubmissionId` (stable tracking id),
  `getNextLegacyId('TaskRecords', db)`, `attemptNumber: 1`. When `send` and the
  row transitioned → COMPLETED, calls `maybeAutoSendCompletion`.
- `rollUpParentsForCompletion({ dbUser, task, db, send=true })` — orchestrator:
  `findParents`, recompute each affected group then each affected mission
  (missions computed recursively from raw records, independent of whether the
  GROUP row is written yet), upsert. Single entry point for all callers.

### Live wiring

Call `rollUpParentsForCompletion` after the relevant record settles:

- `srv/developer-service.js` `_updateTutorialProgress` — after the TUTORIAL
  upsert (both branches), `task={TUTORIAL, tutorial.legacyId, tutorialId:
  tutorial.ID}`. Recompute always (handles completion + regression).
- `srv/developer-service.js` `resetTutorialProgress` — after superseding, same
  task shape (a reset can drop a group/mission from COMPLETED → IN_PROGRESS).
- `srv/puzzle-service.js` (~:221) — after a `recorded:true` PUZZLE insert,
  `task={PUZZLE, puzzle.legacyId}`.
- `srv/lib/petoberfest-upload.js` (~:79) — after an `awarded:true` insert,
  `task={PETOBERFEST, contest.legacyId}`.
- `srv/developer-service.js` `createTaskRecord` — on the edge→COMPLETED for
  `taskType==='CHECKPOINT'`, `task={CHECKPOINT, taskLegacyId}`. (GROUP/MISSION
  direct writes there are left as legacy no-ops for the rollup — the next
  tutorial completion recomputes authoritatively.)

`rollUpParentsForCompletion` never throws into the completion tx (wrapped; logs
+ metrics on fault).

### NGDS live flow-through

`upsertRollupRecord` calls the existing `maybeAutoSendCompletion` on the
COMPLETED edge. No change to gates; GROUP/MISSION are already eligible and the
env=prod + kill-switch + epoch + identity guards apply unchanged.

### Backfill: `scripts/backfill-group-mission-completions.mjs`

- Runs via `cds.connect` (hybrid/prod bind). Flags: `--since=<ISO>` (default the
  cutover epoch from `ImsConfig 'ngds.autosend.epoch'`, fallback
  `2026-08-10T00:00:00Z`), `--dry-run`, `--user=<sapId>` (single-user test),
  `--batch=<n>`.
- Candidate users = users with a COMPLETED TUTORIAL record whose
  `completionDate >= since`.
- For each user: load their completed tutorial legacyIds, `findParents` across
  all of them (union), recompute + `upsertRollupRecord({ ..., send:false })`.
  `completionDate` for a newly-COMPLETED group/mission = the max completionDate
  among its satisfying tutorials (true completion moment; passes the epoch gate).
- **No NGDS send here** (bulk); reports created/updated/completed counts.
  Resumable/idempotent by construction (upsert keyed on the record identity).

### Backfill NGDS send: `scripts/backfill-ngds-send.mjs`

- Separate, deliberate step. Selects GROUP/MISSION COMPLETED records eligible to
  send (post-epoch, `createdBy != 'migration'`, resolvable identity) in
  `completionDate` order, and calls `sendTaskRecordToNgds` per row, **respecting
  the same env=prod + kill-switch gate** via `isAutoSendActive`.
- Rate-limited (default ~1.5/s, `--rate` flag) and resumable via a cursor stored
  in `ImsConfig 'ngds.backfill.cursor'`. Receiver dedups on the stable
  `submissionIdCompleted`, so a re-run is safe.
- Flags: `--dry-run` (counts only, no POST), `--limit`, `--since`, `--rate`.
- **Operator-run only** — this design builds the mechanism; Tom triggers the
  actual prod run and enables the kill-switch.

## Testing

- **Unit** (`test/lib/completion-rollup.test.js`, in-memory sqlite via
  `cds.test`): slot collapsing (linear, alt-group any-branch), nested-group
  mission, `findParents` (direct + via-group), progress/status math, upsert
  create vs update, regression (COMPLETED→IN_PROGRESS on reset), idempotency
  (re-run = no dup rows).
- **Service** (`test/developer-service.test.js` additions): completing the last
  step of the last tutorial in a group flips GROUP → COMPLETED; completing the
  last tutorial of a mission (direct + nested) flips MISSION → COMPLETED;
  alt-group mission completes when one branch is done.
- **NGDS edge**: assert `maybeAutoSendCompletion` fires once on the COMPLETED
  edge and not on repeat saves (spy/mocked in unit env — auto-send inactive
  outside prod, so this asserts the *call*, not a real POST).
- **Backfill**: dry-run counts; a synthetic user with post-cutover tutorial
  completions gains the right GROUP/MISSION rows; re-run creates no duplicates.
- Full `npm test` green; `npx cds deploy --to sqlite::memory:` clean (no schema
  change expected — reusing existing entities/enums).

## Resolved scope decisions

1. **Rollup rows:** full progress (IN_PROGRESS + COMPLETED).
2. **Backfill scope:** tutorial (and other item) completions dated on/after the
   cutover (Aug 10).
3. **Alt-groups:** any branch satisfies the slot.
4. **Non-tutorial mission items:** included now — `TUTORIAL`, `PUZZLE`,
   `CHECKPOINT`, `PETOBERFEST` all count toward mission/group completion, with
   rollup triggers added at each completion point (see Live wiring).
5. **`createTaskRecord` GROUP/MISSION path:** left intact (legacy compat) but no
   longer authoritative; the next item completion recomputes/overwrites.
6. **No schema migration** — all fields/enums already exist.

The backfill NGDS-send step (goal 4) is **operator-run**: this work builds the
mechanism; Tom triggers the prod run and enables the kill-switch.

## Rollout

1. Merge → deploy to DEV → verify live: complete a group's last tutorial as a
   test user, confirm GROUP+MISSION rows appear; confirm analytics lines resume.
2. Run backfill in DEV (`--dry-run` then real) → verify counts.
3. PROD: deploy, run backfill, then (Tom) enable NGDS kill-switch + run the NGDS
   send step. NGDS epoch already suppresses pre-cutover; backfill dates are
   post-cutover.
