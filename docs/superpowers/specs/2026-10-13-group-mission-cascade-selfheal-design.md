# Group / Mission completion cascade + self-heal — design

**Issue:** #2732 — Restore Group/Mission completion cascade + self-heal
(regressed at CAP cutover; root cause of #2718/#2719/#2722).
**Date:** 2026-10-13
**Builds on:** `docs/superpowers/specs/2026-08-20-group-mission-completion-rollup-design.md`
(the forward, event-driven rollup — kept, not replaced).

## Problem

Group/Mission completion is a **stored, event-triggered `TaskRecord`** that is
**not recomputed on read** and does **not self-heal** when completion paths
change. The Aug-20 rollup restored the forward cascade (child completion →
GROUP → MISSION) but left three structural weaknesses, each the cause of a
user-reported breakage:

- **A — downgrade on recompute.** `upsertRollupRecord`
  (`srv/lib/completion-rollup.js:208-222`) unconditionally UPDATEs an existing
  record to the recomputed status, so a slot change can demote a historical
  completer from COMPLETED → IN_PROGRESS on their next action. Legacy
  (`UpdateParentsStatusServiceImpl.updateParents()`) short-circuited and never
  downgraded a COMPLETED parent.
- **B — INACTIVE tutorials counted as required slots.** `loadGroupSlots`
  (`:98-116`) and `loadMissionSlots` (`:119-138`) key on `tutorial.legacyId`
  and never read/filter `Tutorials.status`. A retired/INACTIVE tutorial still
  in a path (e.g. `cp-aibus-dox-booster-app`, live in 3 missions) counts as a
  required slot the user can never satisfy → mission uncompletable.
- **C — no self-heal on mapping change.** The rollup fires only on a **new**
  child completion event. Editing a `CompletionPathItems`/`GroupPathItems`
  mapping updates nobody; there is no post-save hook and no reconcile job. A
  PROD scan found **~50 dead-tutorial slots across ~31 missions/groups** (only
  3 reported) — the latent exposure is broad.

## Goals

1. **A — never downgrade a COMPLETED parent** on recompute/reconcile (match
   legacy short-circuit). An explicit child RESET/supersede may still demote.
2. **B — exclude INACTIVE tutorials from slots**, and guard the resulting
   empty-slots case so a fully-INACTIVE mission is NOT auto-marked complete.
3. **C — self-heal**: reconcile affected users when a completion path changes
   (targeted, on admin SAVE) plus a nightly full reconcile backstop that
   repairs the ~50 already-stranded entities.
4. **Admin visibility** — an on-demand admin endpoint listing missions/groups
   that currently contain an INACTIVE/unresolvable slot, so authors can fix
   the mappings.

Non-goals / explicitly out of scope:
- **Derive-on-read.** Stored GROUP/MISSION `TaskRecords` remain the source of
  truth (analytics + `/build/my-progress` depend on them). We repair drift,
  we do not eliminate the store.
- **Schema migration.** All fields/enums already exist; no DB change.
- **NGDS backfill-send mechanics** — unchanged from the Aug-20 design; the
  reconcile reuses the same `send` gating in `upsertRollupRecord`.
- **`NavigatorCatalog` view** (`db/views.cds:76-95`) — left as-is. It is the
  `@analytics.exposed` card-display view; only the completion-math slot loaders
  are changed here. (Explicit decision — avoid analytics-view blast radius.)

## Decisions (resolved in brainstorming)

| # | Decision |
|---|----------|
| Self-heal model | Keep stored records; targeted reconcile on SAVE **+** nightly full reconcile job as backstop. |
| INACTIVE guard | Filter INACTIVE from slot loaders; when filtering empties the slots (`total===0`), **skip the upsert** (no auto-complete) and flag. |
| Downgrade | Recompute/reconcile never downgrades COMPLETED (`allowDowngrade:false` default); explicit child RESET passes `allowDowngrade:true`. |
| INACTIVE filter scope | Slot loaders only — **not** `NavigatorCatalog`. |
| Admin surfacing | On-demand admin GET endpoint, computed from slot loaders; no persisted flag table. |

## Architecture

### A — no-downgrade short-circuit (`srv/lib/completion-rollup.js`)

`upsertRollupRecord` gains an `allowDowngrade = false` option.

```
existing is COMPLETED, recomputed status is lower (IN_PROGRESS):
  allowDowngrade === false  → leave status COMPLETED; progress may still
                              ratchet UP (never below its current value);
                              skip the status change. No NGDS re-fire.
  allowDowngrade === true   → UPDATE to the recomputed status (demote),
                              existing behavior.
```

- Progress on a held-COMPLETED record never moves backward: when holding
  status, set `progress = max(existing.progress, recomputed.progress)` (keeps
  100% for a completed parent even if a slot was removed).
- `rollUpParentsForCompletion` and the reconcile module call with the default
  (`allowDowngrade:false`). The only caller passing `true` is the explicit
  tutorial RESET/supersede path in `srv/developer-service.js:~308` (where a
  genuine child reset should drop the parent). All other callers
  (`:433/:454` CHECKPOINT, `:1276` tutorial complete, puzzle, petoberfest,
  account-merge) keep the default — a *completion* event never needs to
  downgrade.
- The existing no-op fast path (`existing.progress === progress &&
  existing.status === status`) stays.

### B — INACTIVE filter + empty-slot guard (`srv/lib/completion-rollup.js`)

- `loadGroupSlots`: the `chunkedIn(Tutorials, 'ID', …)` fetch (`:104`) adds
  `'status'` to its columns; drop any item whose tutorial `status === 'INACTIVE'`
  (NULL and `'ACTIVE'` kept) before `collapseSlots`.
- `loadMissionSlots`: direct `TUTORIAL` items need the same status check. Fetch
  the referenced tutorials' `status` (by `tutorial_ID`, chunked) and drop
  INACTIVE tokens; GROUP items are resolved recursively (already filtered by
  `loadGroupSlots`).
- **Empty-slot guard** in `rollUpParentsForCompletion` (and reconcile): after
  `evaluateSlots`, if `total === 0`, do **not** call
  `calculateMissionProgress` / `upsertRollupRecord`. Instead
  `metrics.counter('rollup.empty_slots')` and
  `cds.log('rollup').warn('empty slots after INACTIVE filter', {kind, legacyId})`.
  This prevents the `total===0 → 100% COMPLETED` false-complete.
  (Existing `slots.length === 0` early-continues at `:296/:306` already cover
  the no-items case; the new guard covers the *filtered-to-empty* case and adds
  the counter/log.)

### C — self-heal reconcile — new module `srv/lib/completion-reconcile.js`

Reuses the slot loaders / `evaluateSlots` / `upsertRollupRecord` from
`completion-rollup.js` (export what's needed). Never throws into a caller's
txn (same wrapped contract).

```js
// Recompute GROUP/MISSION records for ONE mission/group across the users
// who could be affected. userIds omitted → all users holding a non-SUPERSEDED
// record for this entity (bounded, indexed by taskLegacyId+taskType).
reconcileEntityForUsers({ kind, legacyId, db, userIds, send=false })

// Backstop sweep: every published mission + group, batched over users.
// Repairs the ~50 pre-existing stranded entities; safe to re-run (upsert).
reconcileAll({ db, batch=500, send=false })
```

- `reconcileEntityForUsers`:
  1. resolve entity UUID from legacyId; load slots (INACTIVE-filtered);
     if `total===0` → flag + skip (Section B guard).
  2. candidate users = `userIds` or `SELECT distinct user_ID FROM TaskRecords
     WHERE taskLegacyId=<legacyId> AND taskType=<kind> AND status!='SUPERSEDED'`
     — **plus** users who satisfy the slots but have no parent record yet
     (so a repaired mapping can newly *grant* completion): union with users
     holding COMPLETED child records for the slot tokens.
  3. per user: `getUserCompletedMap` over the slot tokens → `evaluateSlots` →
     `upsertRollupRecord({ allowDowngrade:false, send })`.
- `reconcileAll`: iterate published `Missions` + `Groups`, call
  `reconcileEntityForUsers` per entity (no `userIds` → full user set),
  accumulate `{created, updated, completed, flagged}` counts; batch user
  fetches by `IN_CHUNK`.
- `send=false` by default (bulk reconcile does not fire NGDS; mirrors the
  Aug-20 backfill which separates send into an operator step). Targeted SAVE
  reconcile also `send=false` — a mapping edit is not a user "earning" moment.

### C — triggers

**Targeted, on admin SAVE** (`srv/admin-service.js`, next to `:1144-1147`):

```js
const reconcileAfterPathEdit = (parentKey) => async (data, req) => { … };
this.after(['CREATE','UPDATE','DELETE'], 'CompletionPathItems', …);
this.after(['CREATE','UPDATE','DELETE'], 'GroupPathItems', …);
```

- Resolve the directly-edited entity from the saved/deleted row:
  `CompletionPathItems` → parent **mission** (via `path_ID →
  CompletionPaths.mission`); `GroupPathItems` → parent **group** (`group_ID`).
- Enqueue `reconcileEntityForUsers({ kind, legacyId })` for that entity
  **fire-and-forget** (`setImmediate`, own `cds.tx`), wrapped so a reconcile
  fault never fails the author's SAVE.
- **Group → containing-mission fan-out:** editing a `GroupPathItems` row
  changes a group's slots, which can change the completion of any mission that
  nests that group. So a group edit also resolves the missions referencing the
  group (`CompletionPathItems{taskType:'GROUP', group_ID} → CompletionPaths →
  mission`) and reconciles each. A `CompletionPathItems` edit needs no fan-out
  (the mission is reconciled directly, and groups it references are unchanged).
- DELETE: `req.data`/`params` give the key; resolve parent before the row is
  gone (use `req.params`), reconcile the parent entity.

**Nightly full** (`srv/jobs/scheduler.js`, via `registerJob`):

```js
registerJob({
  jobName: 'reconcile-completions',
  schedule: '17 4 * * *',        // off-minute, outside the 04:00/:33 cluster
  ttlMs: 1_800_000,              // 30 min headroom; expected sub-minute
  description: 'Self-heal GROUP/MISSION completion records (drift + INACTIVE)',
  fn: () => reconcileAll({ db: cds.db }),
});
```

- Manually runnable via admin `AdminService.JobControls.runJob('reconcile-completions')`.
- Fail-open: job errors never touch request-time reads.
- `srv-qa` cp-list audit: `completion-reconcile.js` is a transitive dep only
  of `scheduler.js`/`admin-service.js`, **not** of `content-store.js`, so no
  `srv-qa` `cp` entry is required — confirm during implementation.

### D — admin visibility endpoint

Read-only, admin-scoped, computed on demand (no persisted table):

- `GET /admin/completion-health` (or a bound AdminService function —
  implementation picks whichever fits the existing admin surface; prefer a
  bound function on `AdminService` for auth consistency).
- Walks published missions + groups, loads slots, reports entities whose raw
  path items reference an INACTIVE tutorial or an unresolvable `taskLegacyId`,
  and entities that filter to `total===0`. Returns
  `[{ kind, legacyId, title, slug, badSlots:[{taskLegacyId, reason}] }]`.
- Backed by a shared helper in `completion-reconcile.js`
  (`findUnhealthyEntities(db)`) so the job and the endpoint agree.

## Data flow

```
child completion ─► rollUpParentsForCompletion (unchanged entry)
                      └► upsertRollupRecord(allowDowngrade:false)   [A]
                         slots INACTIVE-filtered, empty-guarded     [B]

admin edits path item ─► after-SAVE hook ─► reconcileEntityForUsers [C targeted]
                                              (fire-and-forget)

nightly 04:17 ─► reconcile-completions job ─► reconcileAll          [C backstop]

admin opens health view ─► GET /admin/completion-health ─► findUnhealthyEntities [D]
```

## Error handling

- Every rollup/reconcile entry wrapped (`try/catch`, `cds.log('rollup').error`,
  `metrics.counter('rollup.failures')`); never throws into a user txn or a
  SAVE txn.
- SAVE-hook reconcile runs in its own transaction via `setImmediate`; a failure
  logs and increments a counter, SAVE already committed.
- Empty-slot/INACTIVE conditions log + counter, not throw.

## Testing

- **Unit** `test/lib/completion-reconcile.test.js` (in-mem sqlite via `cds.test`):
  - no-downgrade: existing COMPLETED + recomputed IN_PROGRESS, `allowDowngrade:false`
    → stays COMPLETED, progress not reduced; `allowDowngrade:true` → demotes.
  - INACTIVE filter: an INACTIVE tutorial in a group/mission path is excluded
    from slots; a user completing the remaining ACTIVE slots completes the entity.
  - empty-slot guard: all-INACTIVE mission → no upsert, `rollup.empty_slots`
    counter incremented, no false COMPLETED.
  - `reconcileEntityForUsers`: repairs a stranded COMPLETED user whose stored
    record went stale after a slot was repointed; grants completion to a user
    who already satisfies a newly-corrected mapping.
  - `reconcileAll`: synthetic set of missions/groups → correct counts; re-run
    idempotent (no dup rows).
- **Service** `test/admin-service.test.js` additions: editing a
  CompletionPathItems/GroupPathItems row triggers a reconcile of affected users
  (assert the record is corrected after the SAVE settles).
- **Admin endpoint**: `findUnhealthyEntities` returns a mission with an INACTIVE
  slot; clean fixtures return `[]`.
- Full `npm test` green; `npx cds deploy --to sqlite::memory:` clean (no schema
  change).

## Rollout

1. Merge → deploy to **DEV** → unit/service green in CI.
2. DEV: run `reconcile-completions` manually via admin `runJob`; verify the 3
   reported missions (12479, 12052, 16326) and spot-check a few of the ~50
   stranded entities now complete for users who earned them.
3. DEV: open `/admin/completion-health`; confirm it lists the INACTIVE-slot
   missions (authors fix mappings; re-run reconcile).
4. Verify a live mapping edit in admin reconciles affected users (targeted hook).
5. PROD (post-cutover, end-July 2026 or per Tom): deploy, run the full
   reconcile once, then nightly keeps it healed. NGDS send stays `send=false`
   in reconcile — any backfill-send remains the separate operator step.

## Open implementation checks (resolve during build, not blocking)

- Confirm `reconcile-completions` is **not** a `content-store.js` transitive
  dep (so no `srv-qa` cp-list change) — re-walk imports.
- Confirm whether admin visibility is better as a bound `AdminService`
  function vs. an Express route (prefer bound function for XSUAA scope reuse).
- Confirm the DELETE-hook can resolve the parent legacyId from `req.params`
  before the row is removed.
