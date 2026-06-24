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
6. **Insert fresh TUTORIAL-level row.** New row: `{ user_ID, taskLegacyId: tutorial.legacyId, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 0, attemptNumber: maxAttempt + 1, titleSnapshot: tutorial.title, legacyId: await getNextLegacyId('TaskRecords', db) }`.
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

When the INSERT does fire (no live row found), it must include `attemptNumber` — the value comes from the user's current tutorial-level attempt (look up `dbTaskRecords` `WHERE taskType: 'TUTORIAL' AND taskLegacyId: tutorial.legacyId AND status != 'SUPERSEDED'` and read its `attemptNumber`; default `1` if no row exists, matching today's default for first-time users).

### Rate limit

Wrap the action handler in the same per-user rate-limit pattern as `/api/codecheck` and `/api/validate-answer`: **5 resets per user per hour**. Prevents griefing / accidental loops. The existing limiter at `srv/lib/ip-rate-limit.js` is per-IP; the codecheck/validate-answer pattern is per-user (keyed on `dbUser.ID`) — use that variant. On 429, return `{ error: 'rate_limited' }` with status 429.

### Audit event handler

In `srv/admin-service.js` (the existing audit-event observer registers there), add a no-op listener for `TutorialProgressReset` that just logs to the audit framework. Same pattern as the existing `SecretValueWritten` / `SecretValueRotated` events.

## Read-path updates

Every site that reads `TaskRecords` needs review. The `SUPERSEDED` value is new; today's reads use implicit "all rows" semantics.

| File | Function | Today | After |
|---|---|---|---|
| `srv/developer-service.js` | `getProgress` (line 71) | `status: 'COMPLETED'` filter | Same filter + scope to latest attempt for this user+tutorial (filter `attemptNumber: <latest>`). SUPERSEDED rows excluded naturally. |
| `srv/developer-service.js` | `_updateTutorialProgress` (line 648) | Counts steps with `status: 'COMPLETED'` | Same, but scoped to current attempt's `attemptNumber`. |
| `srv/developer-service.js` | `_getProgressForTutorial` (line 701) | Counts steps with `status: 'COMPLETED'` | Same, scoped to current attempt. |
| `srv/developer-service.js` | `getMyCompletions` (line 271) / `srv/lib/getMyCompletedTutorials.js` | `status: 'COMPLETED'` filter | Expand to `status: { in: ['COMPLETED', 'SUPERSEDED'] }`, group by tutorial, return MAX(completionDate). SUPERSEDED rows DO surface here as past completions. |
| `srv/admin-service.js` | Event progress + mission rollups (lines 507-602) | All COMPLETED rows | "User has at least one COMPLETED row for this task" — independent of `attemptNumber`. Re-completions don't inflate counts. |
| `srv/scanner-service.js` | `getContestant` | All COMPLETED rows | Same "at least one COMPLETED row" semantic. Prize claims don't double-credit on re-completion. |
| `srv/analytics-service.cds` | Read-only projections | (none) | Verify the saved-queries that read TaskRecords don't accidentally count SUPERSEDED rows as in-progress; document the new enum value in the saved-query comments. |

The "at least one COMPLETED row" semantic for scanner/missions is the right default because completing a tutorial twice shouldn't count as two completions for prize / mission-progress purposes — that would let a learner game any per-completion rewards. If we ever need a "completion count" metric, that's an explicit follow-up.

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

Because step 6 also does a full page reload, the localStorage cleanup MUST happen BEFORE reload — synchronously, in the same tick as the success response handler.

#### Why reload, not in-place update

The tutorial page has ~5 different reactive surfaces tracking completion state: the validation widget (Vue), the Done buttons on each step (vanilla JS), the data-validated attribute on each `.tutorial-step` div (set imperatively from validation.js), the localStorage `tutorial-validation-*` keys, and the page-level "Tutorial complete!" banner (rendered server-side from Hugo frontmatter — wait, no; it's rendered client-side). Reconciling all of those in-place is error-prone and adds a lot of code paths to test. A full reload after localStorage cleanup gets us to a fresh "first-time visitor" rendering with minimal new code.

Trade-off: ~1 second flash of full page reload. Acceptable for an action the learner explicitly confirmed they wanted.

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

- End-to-end reset against the real DEV HANA: complete a test tutorial, reset, re-complete, verify both attempts coexist in the live DB. Cleanup in `afterAll` to leave no test data behind.

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
