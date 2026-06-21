# Author Review Lifecycle Long-tail Fix-up — Design

> Spec for [#450](https://github.com/sap-tutorials/tutorials-ims/issues/450). Brainstormed 2026-06-21.

## Summary

The author-review nag system (Riley's legacy IMS rule: 1st nag at N days → monthly thereafter → after 4th message, tutorial is a removal candidate) is **already 80-90% implemented** in `main`. This spec covers the 5 surgical edits that close the remaining gap rather than redesigning a system that already works.

## What's already shipped (verified 2026-06-21 against `f6ddc4d0`)

| Capability | Where |
| --- | --- |
| Counter on `TutorialMeta` (`notificationNumber`, `lastNotificationDate`) | [db/schema.cds](../../../../db/schema.cds) |
| Weekly cron (Monday 09:00 UTC) firing nag emails | [srv/jobs/scheduler.js](../../../../srv/jobs/scheduler.js) — wired with distributed locking + pipeline logging |
| Stale-tutorial detection | [srv/lib/contributor-notifications.js](../../../../srv/lib/contributor-notifications.js) `computeStaleNotifications()` |
| Recipient escalation (owner → +repo-owner → +admins → admins-only) | Same file, `determineRecipients()` (levels 0/1/2/3) |
| `markNotificationSent()` increments counter + stamps timestamp | Same file |
| `reviewTutorial(tutorialId)` action — resets counter + reviewedDate | [srv/lib/tutorial-review.js](../../../../srv/lib/tutorial-review.js); exposed on both `/admin` and `/author` services |
| `snoozeTutorial(tutorialId, days)` action — pushes `lastNotificationDate` into the future | Same file |
| Admin-toggleable kill-switch + admin recipient list | `ImsConfig` keys `isNotificationSendingAllowed` + `emailListForOutdated` |
| Email send via `sendNotificationEmail()` | [srv/lib/mail-client.js](../../../../srv/lib/mail-client.js) |
| Unit + hybrid tests for the review reset path | [test/notification-reset.test.js](../../../../test/notification-reset.test.js), [test/unit/lib/tutorial-review.test.js](../../../../test/unit/lib/tutorial-review.test.js), [test/hybrid/author-service.test.js](../../../../test/hybrid/author-service.test.js) |

## What's NOT shipped (this spec's scope)

1. **`MyTutorialsView.outdated` calc field** — Sage has no derived "tutorial has been ignored 4+ times" signal.
2. **`firstNotificationAt` tracking** — current schema knows when the last nag fired but not when the first did, so Sage can't render "first nag sent on YYYY-MM-DD" context.
3. **Threshold 180 → 90 days** — current `STALE_DAYS_DEFAULT = 180` is more lenient than Riley's IMS rule (90 or 120). Tightening to 90 matches the lower bound.
4. **No unit tests for `srv/lib/contributor-notifications.js`** — the cron-feeding lib has zero direct test coverage today. Other paths (`reviewTutorial`, the OData action, the cron handler) are tested, but the stale-detection + recipient-escalation logic is not.
5. **Reset of `firstNotificationAt`** — when `reviewTutorial()` clears the counter, it must also clear this new field.

## Settled decisions (from 2026-06-21 brainstorming)

1. **Threshold**: 90 days for the first nag (was 180). Riley's lower bound; matches "every quarter" mental model.
2. **`outdated` semantics**: `Boolean = (notificationNumber >= 4)`. Simple derivation from the existing counter; no time-based ceiling, no NULL-handling gymnastics.
3. **`firstNotificationAt`**: add the column + expose via `MyTutorialsView` for Sage's "1st nag sent on..." UX.
4. **Deploy plan**: ship straight to DEV; Tom posts in `#devrel-tools` to flag the upcoming nag wave (some authors will get a first nag the Monday after deploy whose tutorials are 90-179 days stale).

## Changes by file

### 1. `db/schema.cds` — add nullable column

After the existing `lastNotificationDate : Timestamp;` line on `TutorialMeta`, add:

```cds
firstNotificationAt : Timestamp;
```

Stays nullable. Populated only when `markNotificationSent` fires on a tutorial whose `notificationNumber` was 0; cleared by `reviewTutorial`.

### 2. `db/views.cds` — extend `MyTutorialsView`

Add two lines inside the projection's select-list:

```cds
m.firstNotificationAt,
m.notificationNumber >= 4 as outdated : Boolean,
```

Both SQLite (unit tests) and HANA (hybrid + prod) support the inline boolean expression.

### 3. `srv/lib/contributor-notifications.js` — 2 edits

**3a.** Line 3:
```diff
- const STALE_DAYS_DEFAULT = 180;
+ const STALE_DAYS_DEFAULT = 90;
```

**3b.** `markNotificationSent()` (around line 64) — populate `firstNotificationAt` on the first nag only:
```javascript
export async function markNotificationSent(tutorialId) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) return;
  const now = new Date().toISOString();
  const isFirstNag = !meta.notificationNumber;
  await UPDATE(TutorialMeta, meta.ID).set({
    notificationNumber: (meta.notificationNumber || 0) + 1,
    lastNotificationDate: now,
    ...(isFirstNag && { firstNotificationAt: now }),
  });
}
```

The spread-conditional pattern keeps the UPDATE atomic and avoids writing `firstNotificationAt: null` on subsequent nags (which would erroneously clear it if the spread were unconditional).

### 4. `srv/lib/tutorial-review.js` — extend reset

In `reviewTutorial()`'s `.set({...})` block (around line 12), add one line:

```javascript
firstNotificationAt: null,
```

So the reset clears all three notification fields atomically:

```javascript
await UPDATE(TutorialMeta, meta.ID).set({
  reviewedDate: now,
  notificationNumber: 0,
  lastNotificationDate: null,
  firstNotificationAt: null,
});
```

### 5. `srv/jobs/scheduler.js` — update threshold call site

Line 135:
```diff
- const notifications = await computeStaleNotifications(180);
+ const notifications = await computeStaleNotifications(90);
```

The `STALE_DAYS_DEFAULT` constant defaults the lib if called with no arg, but the scheduler currently passes 180 explicitly; both must move together.

## Tests

### Extend existing tests (additive)

**`test/unit/lib/tutorial-review.test.js`** — extend the existing `reviewTutorial` test to assert all 3 fields cleared, including `firstNotificationAt`.

**`test/notification-reset.test.js`** — extend the OData `reviewTutorial` integration test:
- After review, assert `MyTutorials.outdated === false` (since `notificationNumber=0 < 4`).
- Seed a separate tutorial with `notificationNumber=4`, query `MyTutorials`, assert that row's `outdated === true`.

### New test file

**`test/unit/lib/contributor-notifications.test.js`** (the lib has no tests today) — 4 tests:

1. `markNotificationSent` sets `firstNotificationAt` to a recent timestamp when called on a meta-row with `notificationNumber=0`. The meta's `lastNotificationDate` and `firstNotificationAt` are equal on the first call.
2. `markNotificationSent` on a meta with `notificationNumber=2` increments to 3 and updates `lastNotificationDate` but leaves `firstNotificationAt` untouched (still its earlier value).
3. `computeStaleNotifications(90)` returns tutorials with `reviewedDate < NOW() - 90d` AND `notificationNumber <= MAX_NOTIFICATION_LEVEL`. Seed 3 rows: one stale-and-eligible (returned), one stale-but-already-at-level-4 (NOT returned — the lib filters `notificationNumber <= 3`), one fresh (NOT returned).
4. `computeStaleNotifications` filters by `monitoredStatus = 'ACTIVE'` and `tutorial.status = 'ACTIVE'` — seed an inactive tutorial; confirm it's filtered out.

Bootstrap pattern: `cds.test('serve', '--project', '.', '--in-memory')` at module top (per `[feedback_module_singletons_in_vitest_cds]` and the existing `test/unit/lib/tutorial-review.test.js` pattern).

## Rollout

1. Deploy lands in DEV via the next `Build & Deploy` workflow_dispatch run.
2. **Monday after deploy**: the weekly cron fires under the new 90-day threshold. Some authors get a first nag whose `reviewedDate` is 90-179 days old (previously silenced under 180). One-time catch-up only; the 30-day resend interval ensures each author gets at most one nag in this wave.
3. Tom posts in `#devrel-tools` to comm the change pre-deploy and (optionally) again the morning of the cron fire.
4. PROD deploy follows the standard DEV → soak → PROD path.

## Out of scope

- **No `NotificationLog` entity.** The existing counter is sufficient; full audit trail is YAGNI. Reconsider if Sage explicitly needs a timeline view beyond "first nag at X, current count Y, last nag at Z."
- **No threshold-via-ImsConfig.** Hardcoded 90 is fine; if ops wants to tune later, that's a single PR.
- **No daily cron.** Weekly Monday cron works; nags fire at the 30-day resend interval regardless.
- **No `daysSinceReview` calc field.** That's #385 (still open) and not blocking #450's acceptance criteria.
- **No vendor-side change to email content.** Existing `sendNotificationEmail` template stays; downstream `firstNotificationAt` context (if needed in the email body) is a follow-up.
- **No data migration.** Existing rows get `firstNotificationAt = NULL` and are populated naturally as nags fire. Sage UI is told to render "first nag sent on..." only when `firstNotificationAt IS NOT NULL`.

## Acceptance criteria

- [ ] `TutorialMeta.firstNotificationAt` exists as a nullable Timestamp column
- [ ] `MyTutorialsView` exposes `firstNotificationAt` and `outdated` (derived from `notificationNumber >= 4`)
- [ ] `STALE_DAYS_DEFAULT = 90` in `srv/lib/contributor-notifications.js` AND `srv/jobs/scheduler.js` call site
- [ ] `markNotificationSent` sets `firstNotificationAt` ONLY when prior `notificationNumber === 0`
- [ ] `reviewTutorial` clears all 4 review-state fields (`reviewedDate→now`, `notificationNumber→0`, `lastNotificationDate→null`, `firstNotificationAt→null`)
- [ ] `test/unit/lib/contributor-notifications.test.js` exists with 4 passing tests
- [ ] Extended assertions in `test/unit/lib/tutorial-review.test.js` and `test/notification-reset.test.js`
- [ ] `npm run test` (unit suite) is green
- [ ] HDI deploy succeeds (additive nullable column + view extension; no destructive operations per memory `[feedback_hdi_deploys_can_wipe_data]`)
- [ ] No new `cf set-env` required (no new env vars)

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Initial nag wave at first post-deploy cron fires confusing authors | Comm in `#devrel-tools` pre-deploy. 30-day resend interval bounds the wave to ≤1 email per author. |
| Calc field `outdated` evaluates differently on HANA vs SQLite | Hybrid test (existing `test/hybrid/author-service.test.js`) confirms HANA path; unit tests cover SQLite. Both engines support the inline boolean expression. |
| `firstNotificationAt` left NULL for rows already at notification level 1-3 | Acceptable per "no data migration" decision. Next nag fired for those rows leaves `firstNotificationAt` NULL still (because `notificationNumber > 0`). Sage handles NULL gracefully ("first nag sent: —"). |
| HDI deploy regression | Schema change is purely additive (new nullable column + view extension). No destructive operation. Verified against memory `[feedback_hdi_deploys_can_wipe_data]`. |

## References

- Issue: [#450](https://github.com/sap-tutorials/tutorials-ims/issues/450)
- Parent: [#385](https://github.com/sap-tutorials/tutorials-ims/issues/385) (still open; this PR closes #450 only)
- Existing notification stack (read 2026-06-21 against `f6ddc4d0`):
  - [srv/lib/contributor-notifications.js](../../../../srv/lib/contributor-notifications.js)
  - [srv/lib/tutorial-review.js](../../../../srv/lib/tutorial-review.js)
  - [srv/jobs/scheduler.js](../../../../srv/jobs/scheduler.js)
  - [db/views.cds](../../../../db/views.cds) `view MyTutorialsView`
  - [db/schema.cds](../../../../db/schema.cds) `entity TutorialMeta`
- Existing tests:
  - [test/notification-reset.test.js](../../../../test/notification-reset.test.js)
  - [test/unit/lib/tutorial-review.test.js](../../../../test/unit/lib/tutorial-review.test.js)
  - [test/hybrid/author-service.test.js](../../../../test/hybrid/author-service.test.js)
- Brainstorm decisions log: threshold→90d; outdated→`notificationNumber >= 4`; firstNotificationAt→add+expose; deploy→ship straight + Slack comms.
