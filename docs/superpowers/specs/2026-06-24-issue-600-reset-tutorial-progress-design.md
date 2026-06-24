# Issue #600 — Reset tutorial progress (let users complete it again)

**Status:** Approved (Tom Jung, 2026-06-24)
**Issue:** [#600](https://github.com/sap-tutorials/tutorials-ims/issues/600)
**Spec author:** Brainstorming session 2026-06-24

## Problem

Today once a learner completes a tutorial, every step stays marked complete forever. There's no way to "retake" the tutorial — useful when the tutorial or the underlying SAP product has updated, or when the learner simply wants to refresh their memory.

The learner needs an explicit option to reset their progress on a single tutorial AND have the system **preserve the prior completion** as history (the `/me/` page already lists past completions; that history must not be lost).

## Goals (in scope)

- A "Reset progress and try again" affordance on a tutorial page, visible only when the learner has previously completed it.
- A confirmation dialog before the reset fires.
- Server-side reset that:
  - Clears live progress for this tutorial only (steps + tutorial-level rollup).
  - Preserves the original `completionDate`, `completionTime`, and `submissionIdCompleted` on the previously-completed rows so `/me/` still surfaces them as past completions.
  - Lets the learner complete the tutorial fresh — the new attempt is independent of the prior one.
- A per-user audit trail (the existing `@PersonalData.cascade: 'audit-only'` on `TaskRecords` covers writes; we supplement with one `TutorialProgressReset` custom audit event for traceability).

## Non-goals (yagni)

- Resetting a single step (only whole tutorials).
- Resetting at MISSION / GROUP level (Tom: tutorial-only).
- Showing attempt history in the UI (the data model supports it; the UI doesn't surface it in v1).
- Revoking accomplishments / prizes the learner already earned.
- Enforcing "tutorial must be 100% complete before reset is allowed" on the server. The UI only shows the button when complete, but the API accepts reset on a partial attempt too (rare; if someone wants to wipe a half-finished attempt, that should also work).

## Data model

Single column + one enum value addition to [`db/schema.cds`](../../../db/schema.cds#L131) on the `TaskRecords` entity:

```cds
entity TaskRecords : cuid, managed, LegacyKeyed {
  // ... existing fields ...
  status        : String enum { COMPLETED; IN_PROGRESS; SUPERSEDED; };  // ← add SUPERSEDED
  attemptNumber : Integer default 1;                                    // ← NEW
}
```

Effective natural key becomes `(user, taskLegacyId, taskType, attemptNumber)`. Today the codebase treats `(user, taskLegacyId, taskType)` as effectively unique; adding `attemptNumber` is backward-compatible because every existing row defaults to `attemptNumber: 1`.

### Migration

New entry in `db/src/com.sap.developers.ims.TaskRecords.hdbmigrationtable`:

```sql
ALTER TABLE com_sap_developers_ims_TaskRecords
  ADD (attemptNumber INTEGER DEFAULT 1);
```

The `SUPERSEDED` string-enum value needs no DDL change beyond CDS recompilation.

### Why versioning (and not just status-flip)

A simpler "flip status from `COMPLETED` to `IN_PROGRESS` on the existing row" approach was considered and rejected — it erases `completionDate` semantically (a `COMPLETED` row's completionDate is its truth; an `IN_PROGRESS` row's completionDate is meaningless), so the `/me/` page would lose the past-completion record. Tom's requirement to "keep past completions on the /me/ page" rules this out.

Two alternatives also considered and rejected:

- **Separate `TaskAttempts` entity** with a foreign key from `TaskRecords`: more normalized, but adds a join everywhere `TaskRecords` is read. Higher refactoring cost for marginal benefit.
- **Shadow `TaskRecordHistory` table**: COPY current COMPLETED rows on reset, then mark the live rows fresh. Lowest churn on existing query paths but doubles row count and forces UNION reads on `/me/`.

`attemptNumber` column is the lightest change with the strongest data integrity guarantees.

## Server-side action

New action on [`srv/developer-service.cds`](../../../srv/developer-service.cds):

```cds
@(requires: 'authenticated-user')
action resetTutorialProgress(slug : String) returns {
  newAttemptNumber : Integer;
  previousAttemptCompletedAt : DateTime;   // null if the prior attempt wasn't completed
  supersededRecordCount : Integer;
};
```

### Handler logic (in `srv/developer-service.js`)

In one transaction (CAP wraps each action handler in a tx by default; explicit `cds.tx` only needed if we step outside `req` for any reason):

1. **Resolve and authenticate.** `(slug → tutorial)` via `SELECT.one.from(dbTutorials).where({ slug })`; reject 404 if not found. Resolve `dbUser` via the existing `resolveUserSapId(user)` pattern from `completeStep` (line 67 of `developer-service.js`); reject 401 if not authenticated.
2. **Find current-attempt rows.** `SELECT` all TaskRecords for this user where:
   - `taskLegacyId` is in the union of the tutorial's `Steps.legacyId` values + the tutorial's own `legacyId`
   - `status != 'SUPERSEDED'`
3. **Idempotent no-op.** If the result set is empty, return `{ newAttemptNumber: 1, previousAttemptCompletedAt: null, supersededRecordCount: 0 }`. No rows mutated.
4. **Determine next attempt.** `maxAttempt = MAX(attemptNumber)` across the result set.
5. **Supersede current rows.** `UPDATE` the result set with `{ status: 'SUPERSEDED' }`. Do NOT touch `completionDate`, `completionTime`, `submissionIdCompleted`, `progress` — those are historical truth. The `modifiedAt` field gets auto-updated by `managed` aspect (acceptable).
6. **Insert fresh TUTORIAL-level row.** Allocate the legacyId via `await getNextLegacyId('TaskRecords', db)` BEFORE step 5's UPDATE if you want to fail-fast on sequence exhaustion — otherwise a sequence allocation failure after step 5 leaves the rows SUPERSEDED with no fresh TUTORIAL row to follow (the action handler will throw and CAP rolls back the transaction, so this is recoverable; ordering it before step 5 is belt-and-braces). New row: `{ user_ID, taskLegacyId: tutorial.legacyId, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 0, attemptNumber: maxAttempt + 1, titleSnapshot: tutorial.title, legacyId: <pre-allocated> }`.
7. **Step rows lazy-initialized.** Do NOT pre-create step rows for the new attempt. The existing lazy-insert in `completeStep` ([srv/developer-service.js:147-164](../../../srv/developer-service.js#L147-L164)) creates them naturally as the user progresses through the new attempt. (One small modification needed there — see "Companion change to completeStep" below.)
8. **Emit audit event.** `await cds.emit('TutorialProgressReset', { user: dbUser.ID, tutorialSlug: slug, attemptNumber: maxAttempt + 1, supersededRecordCount, previousAttemptCompletedAt })`. The `@PersonalData.cascade: 'audit-only'` on `TaskRecords` already routes the UPDATE/INSERT writes to the audit-log infra; this supplemental event makes the *intent* discoverable in the audit stream (separate from N anonymous TaskRecord writes).
9. **Return** `{ newAttemptNumber: maxAttempt + 1, previousAttemptCompletedAt: <COMPLETED row's completionDate from step 5's result set, or null>, supersededRecordCount: <count> }`.

### Companion change to `completeStep`

The "is this step already completed?" lookup ([srv/developer-service.js:147-151](../../../srv/developer-service.js#L147-L151)) needs to scope to the live attempt:

```js
// Before:
const existing = await SELECT.one.from(dbTaskRecords).where({
  user_ID: dbUser.ID,
  taskLegacyId: step.legacyId,
  taskType: 'STEP'
});

// After:
const existing = await SELECT.one.from(dbTaskRecords).where({
  user_ID: dbUser.ID,
  taskLegacyId: step.legacyId,
  taskType: 'STEP',
  status: { '!=': 'SUPERSEDED' }
});
```

Without this, the lazy-insert path would false-positive on a superseded row from a prior attempt and skip the INSERT — leaving the new attempt unable to mark steps complete.

When the INSERT does fire (no live row found), it must include `attemptNumber` — the value comes from the user's current tutorial-level attempt: `SELECT.one.from(dbTaskRecords).columns('attemptNumber').where({ user_ID, taskLegacyId: tutorial.legacyId, taskType: 'TUTORIAL', status: { '!=': 'SUPERSEDED' } })`. `SELECT.one` returns `null` (not a `{attemptNumber: 1}` shape) when no row exists, so the code must default with `?? 1` — `const attemptNumber = (await SELECT.one...)?.attemptNumber ?? 1`. This matches today's default for first-time users on their first ever step completion.

### Companion change to `_updateTutorialProgress` upsert lookup

`_updateTutorialProgress` ([srv/developer-service.js:678](../../../srv/developer-service.js#L678)) does its own `SELECT.one ... WHERE taskType: 'TUTORIAL'` to upsert the tutorial-level row. Today's filter:

```js
const existing = await SELECT.one.from(dbTaskRecords).where({
  user_ID: dbUser.ID,
  taskLegacyId: tutorial.legacyId,
  taskType: 'TUTORIAL'
});
```

After SUPERSEDED ships, this `SELECT.one` returns an arbitrary row from `{SUPERSEDED attempt-1, IN_PROGRESS attempt-2}` and the subsequent UPDATE could mutate the SUPERSEDED row, **destroying its preserved `completionDate` — directly violating Tom's "keep past completions on /me/" requirement**. The fix is to add the same `status: { '!=': 'SUPERSEDED' }` filter here:

```js
const existing = await SELECT.one.from(dbTaskRecords).where({
  user_ID: dbUser.ID,
  taskLegacyId: tutorial.legacyId,
  taskType: 'TUTORIAL',
  status: { '!=': 'SUPERSEDED' }
});
```

Without this, the bulk-SQL MERGE bug (below) and this in-process UPDATE share the same failure mode: silent mutation of the historical record.

### Companion change to the bulk-SQL MERGE

[`srv/lib/recompute-tutorial-progress-bulk-sql.js`](../../../srv/lib/recompute-tutorial-progress-bulk-sql.js) runs a HANA MERGE statement at publish time to recompute `(progress, status)` on TUTORIAL TaskRecords. Today the BASE selector reads:

```sql
SELECT ... FROM TASKRECORDS BASE
WHERE BASE.TASKTYPE = 'TUTORIAL'
  AND BASE.TASKLEGACYID IN (...)
```

After SUPERSEDED ships, this MERGE would spuriously update SUPERSEDED TUTORIAL rows (their step-count would be zero, their computed progress would flip to 0, their `completionDate` could be cleared). **This destroys historical truth.** Fix: add `AND BASE.STATUS != 'SUPERSEDED'` to the BASE filter, AND `AND SR.STATUS = 'COMPLETED'` on the joined step rows is already correct (naturally excludes SUPERSEDED step rows from the count). Also update the doc comment in that file that claims the MERGE is idempotent — it's only idempotent if SUPERSEDED is explicitly excluded.

### Rate limit

Wrap the action handler in the same per-user rate-limit pattern as `/api/codecheck` and `/api/validate-answer`: **5 resets per user per hour**. Prevents griefing / accidental loops. The existing limiter at `srv/lib/ip-rate-limit.js` is per-IP; the codecheck/validate-answer pattern is per-user (keyed on `dbUser.ID`) — use that variant. On 429, return `{ error: 'rate_limited' }` with status 429.

### Audit event handler

In `srv/admin-service.js` (the existing audit-event observer registers there), add a no-op listener for `TutorialProgressReset` that just logs to the audit framework. Same pattern as the existing `SecretValueWritten` / `SecretValueRotated` events.

## Read-path updates

Every site that reads `TaskRecords` needs review. The `SUPERSEDED` value is new; today's reads use implicit "all rows" or `status: 'COMPLETED'` semantics.

### Definitions

Two distinct semantics apply across read sites:

- **"Current-attempt"** semantic — only rows on the user's live attempt for this tutorial. Used by per-tutorial progress (the tutorial page, the lazy Done-button state, the `_updateTutorialProgress` upsert). Implemented as `status: { '!=': 'SUPERSEDED' }` AND, where multiple attempts could exist, scoped to the latest `attemptNumber`.
- **"Has-ever-completed"** semantic — was this `(user, taskLegacyId)` pair completed at least once, on any attempt? Used by leaderboards, scanner prize claims, mission rollups, dashboards, /me/ history. Implemented as `status IN ('COMPLETED', 'SUPERSEDED')`, deduplicated by `(user_ID, taskLegacyId)` at the application layer (or via `DISTINCT` if a DB query).

The "has-ever-completed" semantic is the operative answer for the scanner ambiguity the reviewer flagged: a user mid-attempt-2 (SUPERSEDED + IN_PROGRESS) **does count as a completer** for prize/mission/leaderboard purposes, because their attempt 1 stands as historical truth. Today's filter (`status: 'COMPLETED'`) needs to expand to `status IN ('COMPLETED', 'SUPERSEDED')` at every "has-ever-completed" site to preserve this behavior.

### Read-site audit (exhaustive)

| File | Function / location | Semantic | Today | After |
|---|---|---|---|---|
| `srv/developer-service.js` | `getProgress` (line 71) | current-attempt | `status: 'COMPLETED'` | `status: 'COMPLETED', attemptNumber: <latest for user+tutorial>` |
| `srv/developer-service.js` | `_updateTutorialProgress` step count (line 655) | current-attempt | `status: 'COMPLETED'` | `status: 'COMPLETED', attemptNumber: <latest>` |
| `srv/developer-service.js` | `_updateTutorialProgress` upsert lookup (line 678) | current-attempt | `taskType: 'TUTORIAL'` | `taskType: 'TUTORIAL', status: { '!=': 'SUPERSEDED' }` — see Companion change above |
| `srv/developer-service.js` | `_getProgressForTutorial` (line 701) | current-attempt | `status: 'COMPLETED'` | `status: 'COMPLETED', attemptNumber: <latest>` |
| `srv/developer-service.js` | `completeStep` existing-row lookup (line 147) | current-attempt | `taskType: 'STEP'` | `taskType: 'STEP', status: { '!=': 'SUPERSEDED' }` — see Companion change to completeStep above |
| `srv/developer-service.js` | `getMyCompletions` / `srv/lib/user-progress.js` getMyCompletedTutorials | has-ever-completed | `status: 'COMPLETED'` | `status: { in: ['COMPLETED', 'SUPERSEDED'] }`, group by tutorial, `MAX(completionDate)` |
| `srv/lib/user-progress.js` | `getUserProgress`, `getProgressLookup` (used by Joule chat) | mixed | filter by taskType only | Filter `status: { '!=': 'SUPERSEDED' }` for "in-progress" surfaces; `status: { in: ['COMPLETED', 'SUPERSEDED'] }` for "completed slugs" listings |
| `srv/admin-service.js` | `getEventStatistics` (line 509) | has-ever-completed | No `status` filter | Filter `status: { '!=': 'SUPERSEDED' }` to exclude historical-only rows from in-progress counts; include SUPERSEDED in completion totals via the same `IN ('COMPLETED','SUPERSEDED')` rule |
| `srv/admin-service.js` | Event progress + mission rollups (lines 516, 529, 543, 559, 573, 601) | has-ever-completed | `status: 'COMPLETED'` | `status: { in: ['COMPLETED', 'SUPERSEDED'] }` + DISTINCT by `(user_ID, taskLegacyId)` — completing twice doesn't inflate counts |
| `srv/admin-service.js` | `avgProgressByTaskType` (line 996) | has-ever-completed | No status filter | Filter `status: { '!=': 'SUPERSEDED' }` from the average — SUPERSEDED rows represent superseded snapshots whose progress is misleading |
| `srv/scanner-service.js` | `getContestant` | has-ever-completed | `status: 'COMPLETED'` | `status: { in: ['COMPLETED', 'SUPERSEDED'] }`, DISTINCT by `taskLegacyId` |
| `srv/display-service.js` | `getEventBuckets`, `getEventBurnup`, `getEventTrackStats`, `getCompletionSpeed`, `getLeaderboard` | has-ever-completed | `status: 'COMPLETED'` | `status: { in: ['COMPLETED', 'SUPERSEDED'] }`, DISTINCT by `(user_ID, taskLegacyId)` per query |
| `srv/event-stream-service.js` | `getEventBuckets` | has-ever-completed | `status: 'COMPLETED'` | Same as display-service.getEventBuckets |
| `srv/lib/co-completion.js` | Co-completion pair builder | has-ever-completed | `status: 'COMPLETED'` | `status: { in: ['COMPLETED', 'SUPERSEDED'] }`, DISTINCT by `(user_ID, taskLegacyId)`. Failure mode without this: a user who reset and is mid-attempt-2 drops out of pair counts during the window between reset and re-completion. |
| `srv/lib/recompute-tutorial-progress-bulk-sql.js` | HANA MERGE statement | current-attempt | `BASE.TASKTYPE = 'TUTORIAL'` (no status filter) | `BASE.TASKTYPE = 'TUTORIAL' AND BASE.STATUS != 'SUPERSEDED'` — see Companion change above |
| `srv/lib/content-store.js` | `recomputeTutorialProgress` (line 87) — per-row SQLite-portable variant, used both directly in tests and as the fallback shape imported by the bulk-SQL module | current-attempt | TUTORIAL rec SELECT at line 97 has no `status` filter; completed-step SELECT at line 105 filters `status: 'COMPLETED'`; UPDATE at line 108 sets `completionDate: null` when status flips off COMPLETED | Add `status: { '!=': 'SUPERSEDED' }` to BOTH the tutorialRecs SELECT (line 97) and the completed-step SELECT (line 105). **Same corruption mode as the bulk-SQL MERGE** — without the filter, this function will wipe `completionDate` on SUPERSEDED rows after a publish, destroying historical truth. The fallback path matters because the bulk-SQL module imports it and the test suite exercises it directly on SQLite. |
| `db/views.cds` | `CompletionAnalytics` view (line 137) — projection over TaskRecords joined with users/tutorials; drives saved-query analytics and the AdminService's `analyticsQuery` runner | has-ever-completed | `where tr.status = 'COMPLETED'` | Expand to `where tr.status in ('COMPLETED', 'SUPERSEDED')`. Document in the saved-query SQL comments that consumer queries must `DISTINCT user_ID, tutorial_ID` to avoid inflating counts on re-completion. This is an HDI view change — coordinate with `.github/workflows/schema-drift-check.yml`; expect drift-check to flag the view as renamed/modified during the deploy. |
| `srv/lib/admin-analytics-schema.js` | `facts.completion.baseFilter` (line 11) — defines the metric envelope for ad-hoc admin analytics | has-ever-completed | `baseFilter: { status: 'COMPLETED' }` | `baseFilter: { status: { in: ['COMPLETED', 'SUPERSEDED'] } }`. Add a top-of-file comment that any saved query using `facts.completion` must DISTINCT by `(user_ID, tutorial_ID)` (or the analytics-side equivalent) — without this, users with reset+re-complete inflate completion totals. |
| `srv/lib/kg/concepts-for-user.js` | Raw SQL knowledge-graph "concepts user knows" derivation (line 52) | has-ever-completed | `STATUS IN ('COMPLETED', 'IN_PROGRESS')` | `STATUS IN ('COMPLETED', 'IN_PROGRESS', 'SUPERSEDED')`. Without this, a user mid-attempt-2 loses every concept their attempt 1 earned — Joule's recommendations would regress. The downstream classification at line 124 (`if (status === 'COMPLETED') learned.add(...)`) treats `SUPERSEDED` as not-learned; **change to `if (status === 'COMPLETED' \|\| status === 'SUPERSEDED')`** so historical completions still count as "knows X". |
| `srv/lib/kg/joule-tool-find-path.js` | Raw SQL "where am I in my learning?" inference (line 120) | has-ever-completed | `r.STATUS = 'COMPLETED'` | `r.STATUS IN ('COMPLETED', 'SUPERSEDED')`. Joule's path-finder uses the user's most recent completion as the anchor for next-step recommendations; excluding SUPERSEDED would lose signal on every reset user. |
| `srv/exports/task-records.js` | Admin CSV export | mixed | All rows | No filter change required (admin export should show ALL rows including SUPERSEDED for audit). Add `attemptNumber` column to the export schema so reviewers can distinguish attempts. |
| `srv/analytics-service.cds` | Read-only projections + saved queries | depends | No filter | Document the new enum value in saved-query comments; review the ad-hoc analytics SQL validator allowlist to confirm `SUPERSEDED` is acceptable in user-supplied `WHERE` clauses |
| `srv/lib/account-merge.js` | TaskRecords `UPDATE` on account merge | (write path) | Status-agnostic | No change — walks rows by `user_ID`, status-agnostic. Note: any new rows created during the merged user's session retain the merged user's `attemptNumber` history. |

### Why DISTINCT-by-(user, task) matters

For "has-ever-completed" semantics, simply including SUPERSEDED in the filter is not sufficient — a user who completed a tutorial 3 times now has 1 IN_PROGRESS + 2 SUPERSEDED + 1 most-recent COMPLETED rows. Counting `WHERE status IN ('COMPLETED','SUPERSEDED')` returns 3, inflating leaderboards / prize counts / mission completion percentages. Every "has-ever-completed" query must DISTINCT by `(user_ID, taskLegacyId)` to count one logical completion regardless of attempt count.

**Important — DISTINCT is NEW behavior, not preserved behavior.** Today's code at admin-service.js lines 516/529/543/559/573 (and the parallel display-service / event-stream / co-completion sites) does plain `SELECT.from(TaskRecords).where({status: 'COMPLETED'})` with NO DISTINCT. There may already be users with two COMPLETED rows for the same task today (e.g. via legacy migration or some now-fixed code path) that today's code already double-counts. The DISTINCT clause this spec introduces will correct that latent pre-existing inflation in addition to handling re-completions correctly. Implementers should not assume DISTINCT is a no-op refactoring — it's a behavioral change worth calling out in the PR description and verifying via a hybrid spot-check (find any user with N=COUNT(COMPLETED+SUPERSEDED) > 1 for the same task, confirm dashboards still show them as 1 completion).

In CDS QL, this is `SELECT.distinct.columns('user_ID', 'taskLegacyId').from(dbTaskRecords).where(...)`. In raw HANA SQL (for the rollup queries that already use it), `SELECT DISTINCT USER_ID, TASKLEGACYID FROM ...`.

### `/me/` page dedupe rule

`getMyCompletedTutorials` returns one row per `(user, tutorialSlug)` pair, with `completionDate = MAX(completionDate WHERE status IN ('COMPLETED','SUPERSEDED'))`. The page already shows tutorials the user once completed; this preserves that contract even after reset.

Edge case: a learner who reset and is mid-way through attempt 2 has a SUPERSEDED row (from attempt 1) AND an IN_PROGRESS row (attempt 2). The `/me/` page should still show this tutorial as a past completion (because attempt 1's COMPLETED status is real history) — but the learner can also see it on the tutorial page as "in progress."

## Frontend (Hugo + Vue island)

### New island

`hugo-apps/src/tutorial-reset/TutorialReset.vue` — small island, mounted at the top of the tutorial-page completion-success state.

#### Mount

In [`hugo/layouts/tutorials/u1-object-page.html`](../../../hugo/layouts/tutorials/u1-object-page.html), add a mount node next to the existing completion banner:

```html
<div class="tutorial-reset-mount" data-slug="{{ .Params.slug }}"></div>
```

The mount script lives at `hugo-apps/src/tutorial-reset/index.ts` (new entry in `hugo-apps/vite.config.ts`), output `hugo/static/js/tutorial-reset.js`. Hugo's `head.html` adds:

```html
<script type="module" src="/js/tutorial-reset.js"></script>
```

#### Behavior

1. On mount: read `data-slug` from the mount element + fetch `/api/getProgress?slug=<slug>`.
2. If `completedSteps.length < totalSteps`, render nothing (button hidden — tutorial not yet complete).
3. If complete, render a `<ui5-button design="Default" icon="restart">Reset progress and try again</ui5-button>` above the existing completion banner.
4. Click → open `<ui5-dialog>` with:
   - Title: "Reset progress?"
   - Body: *"Resetting will clear your progress on this tutorial so you can complete it again. Your previous completion will be preserved in your past completions on the /me/ page."*
   - Footer: `[Cancel]` (default), `[Reset progress]` (design="Negative" — orange/red, signals deliberate destructive action; NOT Emphasized which is primary-action blue).
5. Confirm click → `POST /api/resetTutorialProgress` with `{ slug }`.
6. On 200:
   - Dispatch a `tutorial-reset` CustomEvent on `document` with `detail: { slug, newAttemptNumber }`.
   - Close the dialog + remove the reset button from DOM (the tutorial is no longer complete).
   - Reload the page (`window.location.reload()`) — simplest path to get the per-step UI back into "not yet done" state without a full reactive rewrite of the validation widgets. (See "Why reload, not in-place update" below.)
7. On 429: surface message strip with "You've reset progress too many times — please wait a few minutes."
8. On other error: surface generic message strip with the error text.

#### Companion: localStorage cleanup on reset event

A small inline `<script>` (or a hook in the existing `validation.js` bundle) listens for `document.addEventListener('tutorial-reset', e => ...)` and:

- Iterates `localStorage` keys matching `tutorial-validation-<slug>-*` (using `e.detail.slug`) and removes them.
- Removes `data-validated="true"` from `.tutorial-step[data-step="*"]` elements.

Without this cleanup, the validation widgets would re-mount in their persisted-correct state (the green "Correct! Well done." strip) from the previous attempt — contradicting the server-side reset.

Because step 6 also does a full page reload, the localStorage cleanup MUST happen BEFORE reload — synchronously, in the same tick as the success response handler. Specifically: the click handler must call `document.dispatchEvent(new CustomEvent('tutorial-reset', { detail: { slug } }))` and `window.location.reload()` in the same synchronous block with **no `await` between them**. Since `document.dispatchEvent` invokes listeners synchronously and `localStorage.removeItem` is also synchronous, the cleanup completes before `reload()` returns control to the event loop. If an `await` is introduced between dispatch and reload (e.g. to await an analytics ping), the browser could race the reload ahead of the listener queue on some engines — don't do that.

#### Why reload, not in-place update

The tutorial page has ~5 different reactive surfaces tracking completion state: the validation widget (Vue), the Done buttons on each step (vanilla JS), the data-validated attribute on each `.tutorial-step` div (set imperatively from validation.js), the localStorage `tutorial-validation-*` keys, and the page-level "Tutorial complete!" banner (rendered server-side from Hugo frontmatter — wait, no; it's rendered client-side). Reconciling all of those in-place is error-prone and adds a lot of code paths to test. A full reload after localStorage cleanup gets us to a fresh "first-time visitor" rendering with minimal new code.

Trade-off: ~1 second flash of full page reload. Acceptable for an action the learner explicitly confirmed they wanted.

### Admin UI (Fiori Elements over TaskRecords projection)

[`srv/admin-service.cds:52`](../../../srv/admin-service.cds#L52) projects TaskRecords directly. After this PR, admins browsing that list will see two new visible attributes: the new `SUPERSEDED` enum value in the status column, and the `attemptNumber` column.

UI guidance for the Fiori Elements list:

- Default filter: show only non-SUPERSEDED rows (`status != 'SUPERSEDED'`). Admins are usually debugging current state, not history.
- Add a chip or section-filter "Show superseded attempts" that flips the default. SUPERSEDED rows should be visually distinguished (greyed out, lower opacity, OR a "historical" badge in the status cell).
- Add `attemptNumber` to the list-view default columns so admins can identify which attempt a row belongs to.

These are small additions to [`app/admin-annotations.cds`](../../../app/admin-annotations.cds) — the `@UI.LineItem` and `@UI.SelectionFields` for TaskRecords. No new admin component needed.

## Testing

### Unit tests (vitest, in-memory SQLite)

`test/unit/reset-tutorial-progress.test.js` — new file:

- **Happy path**: Seed a user with a 3-step tutorial completed (3 STEP rows + 1 TUTORIAL row, all `status: COMPLETED, attemptNumber: 1`). Call `resetTutorialProgress({ slug })`. Assert:
  - 4 rows updated to `status: SUPERSEDED`, all retain `completionDate`.
  - 1 new TUTORIAL row inserted with `status: IN_PROGRESS, progress: 0, attemptNumber: 2`.
  - Response `{ newAttemptNumber: 2, previousAttemptCompletedAt: <orig date>, supersededRecordCount: 4 }`.
- **Idempotent no-op**: Call `resetTutorialProgress` for a tutorial the user has never touched. Assert `{ newAttemptNumber: 1, previousAttemptCompletedAt: null, supersededRecordCount: 0 }`, no rows changed.
- **Mid-progress reset**: Tutorial with 2 of 3 STEP rows COMPLETED + 1 TUTORIAL row IN_PROGRESS. Call reset. Assert all 3 rows superseded, new TUTORIAL row inserted with attemptNumber: 2.
- **completeStep after reset**: After a reset, complete step 1 of the new attempt. Assert new STEP row inserted with attemptNumber: 2, `status: COMPLETED`. Assert the prior attempt's STEP row (attemptNumber: 1, SUPERSEDED) is untouched.
- **getProgress after reset**: Returns empty `completedSteps` even though SUPERSEDED rows exist for the user+tutorial.
- **getMyCompletions after reset (before re-completion)**: Returns the tutorial with the original `completionDate` (the SUPERSEDED row's preserved date).
- **getMyCompletions after reset AND re-completion**: Returns the tutorial with the MOST RECENT `completionDate` (the new attempt's completion). Dedupe rule.
- **Audit event**: Assert `cds.emit('TutorialProgressReset', ...)` was called with the expected payload.
- **Rate limit**: 6th call within the hour returns 429.
- **Unauthenticated**: Reject 401.
- **Unknown slug**: Reject 404.

### Hybrid test (real HANA via `cds bind --exec`)

`test/hybrid/reset-tutorial-progress.test.js`:

- **End-to-end attempt cycle**: complete a test tutorial, reset, re-complete, verify both attempts coexist in the live DB with the correct status / attemptNumber / completionDate values. Cleanup in `afterAll` to leave no test data behind.
- **Read-path regression suite** (the back-stop the reviewer flagged): after the reset-mid-attempt-2 state is set up, exercise every "has-ever-completed" surface and assert it still counts the user:
  - `/api/getMyCompletions` — shows the tutorial with the original `completionDate`.
  - Scanner-service `getContestant` (call the function directly) — counts the tutorial as completed for prize eligibility.
  - Display-service `getLeaderboard` — user's leaderboard score includes this tutorial.
  - User-progress lookup (the chat-side helper) — `completedSlugs` contains the tutorial; `inProgress` ALSO contains it (because attempt 2 is in progress).
  - Bulk-SQL recompute — invoke `recompute-tutorial-progress-bulk-sql.js` manually after the reset and assert the SUPERSEDED TUTORIAL row's `completionDate` is UNCHANGED.
  - Per-row recompute (the SQLite-portable fallback) — invoke `content-store.js#recomputeTutorialProgress` directly after the reset and assert the SUPERSEDED TUTORIAL row's `completionDate` is UNCHANGED. This is a distinct code path from the bulk-SQL MERGE; the test must cover both.
  - KG concepts-for-user — assert the user's concept set after reset (mid-attempt-2) still includes every concept earned via attempt 1.
  - Joule path-finder — assert the path-finder still anchors on the attempt-1 completion.
  Pass criteria: every surface returns the same shape as if the user had simply never reset.

### Frontend test

`hugo-apps/src/tutorial-reset/TutorialReset.test.ts`:

- Mount the island with a stubbed `fetch` that returns `getProgress` = complete. Assert the button renders.
- Mount with `getProgress` = partial. Assert the button does NOT render.
- Click the button → assert dialog opens.
- Confirm in dialog → assert `POST /api/resetTutorialProgress` was called with the slug. Assert `tutorial-reset` CustomEvent fired with the right detail. Assert localStorage cleanup happened (stubbed `localStorage`).
- 429 response → assert the rate-limit message strip shows.

### Smoke test

`test/smoke/reset-tutorial-progress.smoke.test.js`:

- Authenticate against deployed DEV approuter, POST to `/api/resetTutorialProgress` with a slug, verify 200 + expected response shape. Cleanup: re-complete the tutorial to leave the test user's state stable.

## Audit / privacy

- The existing `@PersonalData: { EntitySemantics: 'DataSubjectDetails', cascade: 'audit-only' }` annotation on `TaskRecords` ([db/audit-logging.cds:38-43](../../../db/audit-logging.cds#L38-L43)) automatically routes UPDATE/INSERT writes to the audit framework. No additional annotation needed.
- The supplemental `TutorialProgressReset` event makes the *intent* of the reset discoverable in audit logs (otherwise it would appear as N anonymous TaskRecord status mutations).
- Anonymization cascade: SUPERSEDED rows are still TaskRecords with `user` references; the existing anonymization-cascade code (`db/audit-logging.cds` + `srv/lib/anonymize-user.js`) handles them automatically because the cascade is keyed on the `user` association, not on `status`.

## Observability

Add the new audit event to the saved analytics queries in [`srv/lib/ai-grading-saved-queries.js`](../../../srv/lib/ai-grading-saved-queries.js)-style pattern (a new `srv/lib/reset-progress-saved-queries.js` if we want admin visibility — *optional*, can be deferred). Minimum: a single query that surfaces "tutorials reset in the last 7 days, count per slug" so we can see if a particular tutorial is generating a lot of resets (signals tutorial-quality issues).

## Migration plan

This is **additive** for existing users — every existing TaskRecord defaults to `attemptNumber: 1` after the migration runs. No data backfill needed. No frontend behavior change for users who haven't completed any tutorial yet.

Deploy order:

1. CDS + HDI migration (adds the column).
2. CAP service redeploy (action + handler + read-path updates).
3. Frontend island ships in the same Hugo build / mta deploy as the CAP changes.

The CDS + frontend can ship in one MTA deploy — they don't have a deploy-order interdependency once the column exists in HANA.

**Schema-drift-check coordination.** The `db/views.cds` `CompletionAnalytics` view change (expanding the `where tr.status = ...` filter) WILL trip [`.github/workflows/schema-drift-check.yml`](../../../.github/workflows/schema-drift-check.yml) when the workflow compares prod vs QA HDI artefacts. Expected behavior: the workflow will flag the view as modified during the deploy window. This is acceptable — drift-check is informational; the modification is intentional. Mention this in the deploy PR body so the reviewer knows the drift-check noise is expected. After both environments are on the new view shape, drift-check goes quiet again.

## Risk

Low-medium.

- **Schema migration**: one `ALTER TABLE ADD` column with `DEFAULT 1`. Reversible (the column is additive); rolling back means accepting that the data model now has `attemptNumber` but no code uses it.
- **Read-path updates**: the bulk of the implementation risk. Every place that reads TaskRecords needs review per the table above. The hybrid test against real HANA is the back-stop for "did we miss a read site?"
- **Frontend**: small island, full page reload after reset, low complexity.
- **Audit / privacy**: zero risk — the existing annotation already covers writes; the new event is supplemental.

## Open follow-ups (not in this PR)

- Show attempt count in the `/me/` page ("you've completed this tutorial 3 times"). Data model supports it; UI surface deferred.
- Per-mission reset affordance ("reset every tutorial in this mission"). Tom: out of scope for v1.
- Per-step reset. Not requested; UI complexity not worth it.
- Admin observability for reset trends (mentioned under Observability).

---

**End of spec.** Implementation plan to be authored next via `writing-plans` skill.
