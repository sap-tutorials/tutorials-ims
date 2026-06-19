# Tutorials.legacyId NULL on publish-side INSERT — design

**Issue:** [#431](https://github.com/sap-tutorials/tutorials-ims/issues/431) — Publish-side: new tutorials inserted via `/content/publish/append` get NULL legacyId

**Date:** 2026-06-19

## Problem

`upsertTutorialMetadata` at [srv/lib/content-publish-session.js:300-326](../../../srv/lib/content-publish-session.js#L300) creates new `Tutorials` rows without assigning `legacyId`. The companion Steps INSERT at line 348 correctly uses `getNextLegacyId('Steps', db)` — Tutorials was simply missed.

Surfaced 2026-06-19 during #382 phase F1 mission-data repair: all 4 newly-published meta-tutorials (`use-codecheck-...`, `use-validate-...`, `use-autoauthor-...`, `tutorial-platform-feature-cookbook`) had `Tutorials.LEGACYID = NULL`. Existing tutorials (max legacyId 25214) all have non-NULL values from the IMS migration.

## Why this matters (downstream NULL propagation)

`legacyId` is the join key for several runtime paths:

- **Progress tracking**: `TaskRecords.taskLegacyId` (TUTORIAL records) joins to `Tutorials.legacyId`. The developer-service step-complete handler at [srv/developer-service.js:680, 692](../../../srv/developer-service.js#L680) writes `taskLegacyId: tutorial.legacyId` — so user progress writes carry NULL, breaking the join silently.
- **Mission path resolution**: `CompletionPathItems.taskLegacyId` joins to `Tutorials.legacyId` for mission/group hierarchy reads.
- **Recompute short-circuit**: `recomputeTutorialProgress` at [srv/lib/content-store.js:90](../../../srv/lib/content-store.js#L90) early-returns when `tutorial.legacyId` is null — so `progress`/`status` rows can drift across publishes if `stepCount` later changes.

The carry-forward pattern in the publish session masks the symptom (existing tutorials hold their pre-existing legacyId; only NEW tutorials are broken). This is the same masking pattern that hid #425 and #432.

## Goal

Two parts:

1. **Forward fix**: every new `Tutorials` row inserted via the publish path gets a non-null `legacyId` from `getNextLegacyId('Tutorials', db)`.
2. **Backward repair**: the 5 known NULL rows (4 new meta-tutorials + `test-tutorial`) — and any future stragglers — get sequence values, with downstream `TaskRecords` and `CompletionPathItems` updated so existing user progress and mission paths heal.

## Approach

### 1. Forward fix (single-line addition)

[srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js) line 314–325 currently:

```js
} else {
  tutorialId = cds.utils.uuid();
  await INSERT.into(Tutorials).entries({
    ID: tutorialId,
    slug,
    title: meta.title,
    description: meta.description || null,
    averageTimeToComplete: meta.time || null,
    experienceTag: meta.level || null,
    primaryTag: meta.primaryTag || null,
    stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
    status: 'ACTIVE'
  });
}
```

Becomes:

```js
} else {
  tutorialId = cds.utils.uuid();
  await INSERT.into(Tutorials).entries({
    ID: tutorialId,
    slug,
    title: meta.title,
    description: meta.description || null,
    averageTimeToComplete: meta.time || null,
    experienceTag: meta.level || null,
    primaryTag: meta.primaryTag || null,
    stepCount: Array.isArray(meta.steps) ? meta.steps.length : null,
    status: 'ACTIVE',
    legacyId: await getNextLegacyId('Tutorials', db)
  });
}
```

`getNextLegacyId('Tutorials', db)` already exists in the allowlist at [srv/lib/legacy-id.js:5](../../../srv/lib/legacy-id.js#L5). HANA hits `COM_SAP_DEVELOPERS_IMS_TUTORIALS_SEQ`; SQLite uses an in-memory counter starting at 10,000,000.

### 2. Forward regression test (hybrid HANA test)

Add a new `it()` block to [test/hybrid/content-publish-chunked.test.js](../../../test/hybrid/content-publish-chunked.test.js):

```js
it('upsertTutorialMetadata assigns a non-null legacyId on INSERT for new slugs (#431)', async () => {
  // Drive a chunked publish for a brand-new slug, then assert the resulting
  // Tutorials row carries a positive integer legacyId.
  // ...uses the same helpers + cleanup pattern as the existing tests in this file.
});
```

Mirror the existing `upsertTutorialMetadata matches mixed-case Tutorials.slug case-insensitively` test for setup/teardown shape. Verify legacyId > 0. The unit-test path doesn't apply because `upsertTutorialMetadata` is tightly coupled to `cds.entities()` and DB sequences — the hybrid test is the right altitude.

### 3. Backward repair script: `scripts/repair-tutorial-legacyid.cjs`

New one-shot script following the established pattern of [scripts/dedupe-tutorial-meta.cjs](../../../scripts/dedupe-tutorial-meta.cjs).

**Schema reality check** (verified against [db/schema.cds](../../../db/schema.cds) entities `TaskRecords` line 119 and `CompletionPathItems` line 272):

- `Tutorials` has `legacyId`. ✓
- `CompletionPathItems` has `tutorial : Association to Tutorials` (line 276) — i.e. a direct FK on `tutorial_ID`. The repair joins via this FK, NOT via slug. Reliable.
- `TaskRecords` has neither a `tutorial` association nor a `taskSlug` column — only `taskLegacyId`, `taskType`, and `titleSnapshot`. **There is no clean way to recover orphan TaskRecords whose `taskLegacyId` was written NULL** because the row contains no link back to the Tutorials row. If a user marked a step complete on one of the 4 newly-published meta-tutorials between publish and this fix landing, that row is **unrecoverable from the repair script's perspective** (its `taskLegacyId` stays NULL, its `titleSnapshot` is too brittle for matching, and there's no FK).

We accept TaskRecords orphans as a known data-loss boundary. This affects at most a handful of rows (the 4 meta-tutorials are author-facing reference docs unlikely to have user progress; the 5th is a historical `test-tutorial`). Documented below as out-of-scope.

**Modes:**
- `--dry-run` (default): print plan, no writes.
- `--commit`: execute, snapshot first.
- `--verify-only`: count remaining NULL rows, exit 0 (clean) / 2 (work remains).

**Algorithm (per-tutorial transaction, fail-soft):**

```
For each Tutorials row where legacyId IS NULL:
  open tx
  SELECT FOR UPDATE on the Tutorials row (re-check NULL after lock)
  newId = getNextLegacyId('Tutorials', db)
  snapshot the before-state of: Tutorials row, matching CompletionPathItems
  UPDATE Tutorials SET legacyId = newId WHERE ID = <row.ID> AND legacyId IS NULL
  UPDATE CompletionPathItems SET taskLegacyId = newId
    WHERE taskLegacyId IS NULL
      AND taskType = 'TUTORIAL'
      AND tutorial_ID = <row.ID>      -- direct FK, not a slug match
  commit
on per-tutorial failure: log + continue with next tutorial
```

**Snapshot:** JSONL file at `.migration-data/tutorial-legacyid-repair-backup-<ISO>.jsonl`. One line per touched row (Tutorials + each updated CompletionPathItem). Mirrors `dedupe-tutorial-meta.cjs`'s convention.

**Snapshot guards in the repair logic:**
- If a CompletionPathItem already has a non-NULL `taskLegacyId` that disagrees with the new one, the `WHERE taskLegacyId IS NULL` clause leaves it alone. If the SELECT count exceeds the UPDATE count, log a warning — that row was likely written before the bug existed and shouldn't be silently overwritten.

**Run via:** `npx cds bind --exec -- node scripts/repair-tutorial-legacyid.cjs [--commit]`

### 4. Hybrid regression test for the repair script

Add a hybrid test that:
1. Inserts a Tutorials row with `legacyId: null` (manual INSERT bypassing the fixed path).
2. Inserts a matching CompletionPathItems row with `taskLegacyId: null` and `tutorial_ID` pointing at the new Tutorials row.
3. Runs the repair logic against just that `__TEST__` slug (not the whole DB).
4. Asserts: Tutorials.legacyId now non-null; CompletionPathItems.taskLegacyId now non-null; both carry the same value.

Cleanup uses the existing `__TEST__` prefix convention.

## Why this approach

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **One-line forward fix + per-tutorial-tx repair script** (this design) | Surgical. Forward fix is one line. Repair script reuses existing `getNextLegacyId` + matches the existing repair-script idiom. Fail-soft tx model means a single bad row doesn't block the rest. | Two-part change. | **Chosen** |
| Forward fix only; let downstream rows stay broken | Smallest diff. | User progress on the 4 named meta-tutorials stays orphaned. Mission paths for those slugs stay broken. Tom would still need a manual SQL backfill. | Rejected |
| Forward fix + admin action endpoint instead of script | Self-heal at runtime, no script invocation. | Bigger surface (CDS action + auth scope + audit log). One-shot scripts are the standard pattern in this repo (`dedupe-tutorial-meta.cjs`, `merge-duplicate-slugs.cjs`, `repair-mixed-case-tutorial-duplicates.cjs`). | Rejected |
| Single-tx repair for the whole run (all-or-nothing) | Cleaner verification — either every row is fixed or none. | One bad row rolls back work for all the others; requires re-investigation before another attempt. The 5 known NULL rows are independent of each other; per-row tx is safer. | Rejected |

## Failure modes

| Mode | Symptom | Action |
|---|---|---|
| HANA sequence wraps or fails | `getNextLegacyId('Tutorials', db)` throws | Both INSERT and repair propagate the error. Existing behavior — no special handling. |
| Repair row's slug matches >1 Tutorials row (mixed-case duplicate) | Should not happen post-PR #386 (`@assert.unique.slug`). If it does, repair updates the Tutorials row in question by ID, and the FK-based UPDATE for CompletionPathItems is unaffected (each row's `tutorial_ID` is unambiguous). | Hybrid test asserts the post-#386 invariant holds. |
| Concurrent publish writes a NULL legacyId mid-repair | Per-tutorial `SELECT FOR UPDATE` inside the tx blocks until the publish commits. The repair re-checks the NULL condition after acquiring the lock; if the publish already filled in the legacyId (in a future where the forward fix is deployed), the repair skips that row. | None — the SELECT FOR UPDATE + re-check pattern handles this. |
| CompletionPathItem has `taskLegacyId: <some-other-value>` (not NULL but wrong) | The `WHERE taskLegacyId IS NULL` clause leaves it alone. Logged as "skipped — already has taskLegacyId=X". | Manual triage if the count is non-zero — likely indicates a third bug elsewhere. |
| Orphan TaskRecord rows (user marked step complete during the bug window) | TaskRecords has no slug column and no FK to Tutorials. **Unrecoverable from the repair script.** Their `taskLegacyId` stays NULL; the join to `Tutorials.legacyId` keeps failing. The downstream effect: those users' progress for the 4 meta-tutorials doesn't appear in `/api/getEventProgress` etc. | Accepted data-loss boundary. The 4 named meta-tutorials are author-facing reference docs unlikely to have non-author user progress. If a triage need arises later, file a separate issue for a `titleSnapshot`-based heuristic recovery. |
| Snapshot disk full | `appendSnapshot()` throws; tx rolls back; per-row failure path triggers; script continues to next tutorial. | None — fail-soft handles it. |

## Out of scope

- **Recovering orphan TaskRecords**: see Failure modes table — schema has no FK or slug column on TaskRecords, so rows whose `taskLegacyId` was written NULL during the bug window are unrecoverable from a repair script. If user-progress triage becomes necessary, file a separate issue for a `titleSnapshot`-based heuristic.
- Adding a `@mandatory` constraint on `Tutorials.legacyId` — would require a CSN migration and risks breaking other code paths that legitimately read NULL today (e.g., `recomputeTutorialProgress`'s short-circuit). Defer.
- Migrating away from `legacyId` to UUID-based joins — broader architectural concern (#?, not filed).
- Repairing `Steps.legacyId` NULLs — not surfaced by #431; Steps INSERT already assigns legacyId correctly.
- Backfilling other `*.legacyId` fields elsewhere in the schema.
- Adding a database trigger / `BEFORE INSERT` to assign legacyId at the DB layer — out of pattern; the codebase uses application-layer sequence assignment everywhere.

## Verification

1. **Hybrid test 1 (forward fix)**: a fresh slug published via the chunked path lands in `Tutorials` with `legacyId > 0`.
2. **Hybrid test 2 (repair script)**: a manually-NULLed Tutorials row + a matching CompletionPathItems row both heal to the same legacyId after running the repair logic.
3. **Manual run on DEV** (post-merge, post-deploy): `npx cds bind --exec -- node scripts/repair-tutorial-legacyid.cjs --dry-run` lists the 5 known NULL rows. Then `--commit` heals them. Then `--verify-only` exits 0.
4. **Boot smoke**: `cf logs tutorials-srv --recent | grep upsertTutorialMetadata` shows no errors related to legacyId after the next rebuild-content workflow run.
5. **Post-cleanup data check** (HANA — uppercase per `feedback_hana_raw_sql_uppercase`):

   ```sql
   SELECT COUNT(*) FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "LEGACYID" IS NULL;
   -- Expect: 0 after --commit
   ```

## References

- Issue: [#431](https://github.com/sap-tutorials/tutorials-ims/issues/431)
- Surfacing event: [#382](https://github.com/sap-tutorials/tutorials-ims/issues/382) phase F1 mission registration
- Companion fix: [#428](https://github.com/sap-tutorials/tutorials-ims/issues/428) (mission-renderer fix that made this NULL gap user-visible)
- Same masking pattern: [#425](https://github.com/sap-tutorials/tutorials-ims/issues/425), [#432](https://github.com/sap-tutorials/tutorials-ims/issues/432)
- Memory: `feedback_carry_forward_masks_validator_bugs`
- Affected files: [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js), [srv/lib/legacy-id.js](../../../srv/lib/legacy-id.js)
- Repair-script pattern: [scripts/dedupe-tutorial-meta.cjs](../../../scripts/dedupe-tutorial-meta.cjs)
- Hybrid test pattern: [test/hybrid/content-publish-chunked.test.js](../../../test/hybrid/content-publish-chunked.test.js)
