# AI-Graded Questions — Yellow-answer UX + reset fixes (issue #3120)

**Date:** 2026-11-13
**Issue:** [sap-tutorials/tutorials-ims#3120](https://github.com/sap-tutorials/tutorials-ims/issues/3120)
**Author's decisions captured:** 2026-11-13 (Tom)

## Intent and why

AI grades free-text tutorial answers into three bands: **pass** (Green), **partial**
(Yellow), **fail** (Red). The grading works, but the Yellow path is confusing:

- A Yellow answer today silently becomes `result='accepted'`: it shows a green
  "Good enough — you've got the main idea" strip, **disables the textbox**, unlocks the
  Done button, and persists as `{correct:true}`. The learner cannot tell whether they
  passed, cannot edit their answer, and the "Completed" button being clickable adds doubt
  (issue screenshot 1).
- On reload/revisit, the persisted `{correct:true}` rehydrates the step as **fully Green
  with every question marked ✓** (`Validation.vue:107-114`), erasing the Yellow nuance and
  leaving a generic green banner detached above the (now green) question — the "orphaned
  banner" in issue screenshot 2.
- Reset progress is hard-gated to 100%-complete tutorials, so a learner stuck on a Yellow
  or wrong answer mid-tutorial has no way to start over (issue, final paragraph).

The goal: make the Yellow verdict unambiguous, give the learner a clear path (improve it or
explicitly continue), stop the reload nuance-loss, and allow resetting progress before the
whole tutorial is finished.

## Goals

1. A Yellow answer shows an explicit, honest verdict ("⚠ Partially correct — see hint") and
   does **not** silently auto-unlock. The learner either improves the answer (Resubmit) or
   makes a deliberate **Continue anyway** choice that unlocks Done.
2. The answer textbox stays **editable** in the Yellow state (and after acknowledging), so
   the learner is never looking at a greyed-out box they think is broken.
3. On reload/revisit, a Yellow step rehydrates as **Yellow** (its ⚠ badge + advisory hint),
   not as fake Green. No orphaned/mismatched banner.
4. Learners can reset progress at **any** point where they have progress, not only at 100%.
5. No existing learner loses in-flight progress (back-compat for old localStorage keys).

## Non-goals

- No change to the AI grader itself (prompt `validate-answer-prompt.js`, verdict enum
  `pass|partial|fail`, `/api/validate-answer`, `ValidateAnswerSubmissions` telemetry). Grading
  is correct; this is a presentation + progress-state change.
- No change to the parallel "challenge widget" freeText grader
  (`srv/lib/challenge-grade-tool.js`, `/api/challenge-grade`, `ChallengeAnswers`,
  `hugo-apps/src/challenge-render/`). Out of scope unless a follow-up asks.
- No change to MCQ (radio/checkbox) grading semantics — only the shared disable guard is
  touched where it currently keys off `accepted`.
- No scoring/points/badge changes.

## Anti-goals (would make this a failure even if it "works")

- Making a Yellow answer silently pass without the learner knowing — the current bug.
- Making a Yellow answer *block* progression entirely (regressing #2348's intent that a
  learner who got the core idea isn't forced to resubmit). The learner must always have a
  one-click way forward.
- A reset path that supersedes in-progress rows without clearing step status (the exact
  #2446 defect). The relaxed gate must preserve the "fresh attempt reads empty" invariant.

## Constraints

- Vue island under `hugo-apps/src/validation/` built into `hugo/static/js/`; UI5 web
  components; `{{ }}` text interpolation only, **never `v-html`** (reference-answer redaction
  is the first defence, Vue auto-escape the second — preserved).
- CAP Node.js backend; **CQL/`cds.ql` only, never raw SQL**; `resetTutorialProgress` is
  `@requires: 'authenticated-user'` and shared by OData + MCP twins — any gate change must
  apply at the shared handler `doResetTutorialProgress`.
- localStorage persistence must stay tolerant of private-mode/quota failures (silent).
- Reset is rate-limited (5/hr) — unchanged.

## Approaches considered

**A — Repurpose `accepted` into an interactive acknowledged state. (CHOSEN)**
Keep the verdict aggregation (`Validation.vue:340-341`: all pass-or-partial, ≥1 partial →
the Yellow band) but change the *behavior* of that band: render "⚠ Partially correct", keep
the textarea editable, show `[Resubmit]` + `[Continue anyway]`, and only persist/emit/unlock
when the learner clicks **Continue anyway**. Persist a richer shape so reload rehydrates
Yellow, not Green.
- *Trades off:* persistence shape migration (`{correct}` → `{outcome}`) with a back-compat
  read shim; one new deliberate user action on the Yellow path.
- *Why chosen:* smallest conceptual change; reuses existing verdict aggregation; directly
  produces Tom's chosen mockup.

**B — New dedicated `result` state (`needs-ack`), leave `accepted` as-is or remove it.**
- *Trades off:* an extra template block + persistence value + test surface; two near-identical
  states ("pass-or-partial, no fail") to keep in sync.
- *Why not:* `accepted` already means exactly "pass-or-partial, no fail"; splitting adds
  states without new meaning.

**C — Backend-driven acknowledgement (store the ack server-side in `ValidateAnswerSubmissions`).**
- *Why not:* progression/unlock is already a pure client concern (localStorage +
  `step-validated` event + `data-validated`); adding a server round-trip for an ack is cost
  with no benefit, and the Done gate (`tutorial.ts`) doesn't read server state for this.

Tom picked **A**, with the textbox **staying editable after acknowledging** (a later
edit+Resubmit can still improve Yellow→Green; Done stays unlocked once earned), and a
**back-compat read shim** for old localStorage keys.

### Reset gate: cost evaluation (Tom asked to confirm it's cheap before committing)

Allowing mid-tutorial reset is **LOW** complexity. The existing handler already does the
right thing for partial state:
- `liveRows` (`developer-service.js:236-240`) collects **all** non-SUPERSEDED STEP +
  TUTORIAL rows and supersedes them in one UPDATE (`:270-272`) — not dependent on completion.
- Next attempt number = `Math.max(...liveRows.attemptNumber)+1` (`:264`) — works with or
  without a completed TUTORIAL row.
- `getProgress` / `_getCurrentTutorialAttempt` (`:1199-1211`) scope to the current
  non-SUPERSEDED attempt, so a bumped attempt reads empty — the #2446 "step status not
  cleared" defect does **not** apply to this handler as written; that defect was the OData/MCP
  path bypassing the *UI's* gate, while this handler supersedes live step rows regardless.

The `if (!priorTutorialRow) reject(409)` at `:259-261` is **not just UI polish — it is the
#2446 regression guard.** Correction after builder review: `test/unit/reset-tutorial-progress.test.js:138-188`
asserts the 409 AND that partial progress stays untouched (no row superseded). #2446 itself
([issue](https://github.com/sap-tutorials/tutorials-ims/issues/2446)) was a **points/rollup**
bug: completing one step of a multi-step activity marked the whole activity complete and
awarded full points. The 409 was the blunt fix chosen then.

**Why relaxing is now safe (and the decision):** the current handler supersedes **all** live
STEP+TUTORIAL rows (`:236-240, :270-272`), calls `rollUpParentsForCompletion(..., allowDowngrade:true)`
(`:298-303`) which downgrades a COMPLETED parent, and `getProgress`/`_getCurrentTutorialAttempt`
scope to the new non-SUPERSEDED attempt — so the inconsistent points/rollup view that motivated
#2446 cannot recur. **Tom's decision (2026-11-13): relax the gate fully.** The two #2446 unit
assertions invert (partial reset → 200, all live rows SUPERSEDED, fresh attempt reads empty).
The replacement regression guard is a NEW test reproducing #2446's *actual* symptom — a
partial reset followed by `getProgress` + parent rollup must show empty progress and a
downgraded (not completed, not over-pointed) parent. The smoke test
(`test/smoke/reset-tutorial-progress.smoke.test.js:39-66`) already assumes this relaxed
behavior (200 + nullable `previousAttemptCompletedAt`), so the contract is unified on relax.

## The how (decided)

### 1. Persistence shape (`hugo-apps/src/validation/grading.ts`)

Replace the `{correct:boolean}` persisted shape with an outcome-carrying shape, keeping the
same localStorage key (`tutorial-validation-<slug>-<step>`):

```ts
type PersistedOutcome = 'pass' | 'accepted';
// written shape: { outcome: 'pass' | 'accepted', timestamp: number }
```

- `writePersisted(slug, step, outcome)` — persists `{outcome, timestamp}`. (Signature changes
  from `(…, correct:boolean)` to `(…, outcome:PersistedOutcome)`; callers updated.)
- `readPersisted(slug, step)` returns `{ outcome: 'pass' | 'accepted' } | null`, with the
  **back-compat read shim**: a legacy `{correct:true}` value reads as `{outcome:'pass'}`.
  Anything else → null. Tolerant of parse/quota failures (returns null), unchanged.

### 2. Vue island (`hugo-apps/src/validation/Validation.vue`)

**State machine.** The `accepted` branch in `onSubmit` (`:355-362`) no longer auto-unlocks:
- `allPass` → `result='correct'`: unchanged (persist `'pass'`, emit, lock).
- `allAccepted && anyPartial` → `result='accepted'`: set `hint`, render the new Yellow UX,
  but **do not** `writePersisted` and **do not** `emitStepValidated` here. The step is not
  unlocked until the learner acknowledges.
- `partial` (blocking hard-fail-with-hint) / `incorrect` / `disabled` / `error`: unchanged.

**New acknowledge action.** Add `onContinueAnyway()`:
- `writePersisted(slug, step, 'accepted')`, `emitStepValidated()`, set a local
  `acknowledged` ref true so the strip switches to a settled "✓ Counts — you can continue"
  confirmation. Textbox stays editable (Tom's choice).

**Textbox disable guard** (`:577`, and radio `:559` / checkbox `:539`): change from
`result === 'correct' || result === 'accepted'` to **`result === 'correct'`** only. The
Yellow/`accepted` box is now editable. (MCQ: in the `accepted` band the options likewise stay
enabled so the learner can change selection and Resubmit — but MCQ questions grade exact-match
pass/fail and don't produce `partial`, so in practice `accepted` only arises with ≥1 free-text
partial; the guard change is still correct and consistent.)

**Template — Yellow (`accepted`) block** replaces the current auto-success strip for this
state:
```
⚠ Partially correct — your answer covers the main idea.
   One thing to consider: {{ hint }}         (when hint present)
[ textarea EDITABLE, shows the learner's answer ]
[Resubmit]            [Continue anyway]
```
- `[Resubmit]` = the existing submit path (re-grades; can reach `correct`).
- `[Continue anyway]` = `onContinueAnyway()`.
- After acknowledging (`acknowledged===true`): strip becomes
  `✓ Counts — you've continued. You can still refine your answer and resubmit.` and the
  `[Continue anyway]` button is gone; `[Resubmit]` remains.
- Per-question ⚠ badge (`:513`) and per-question hint (`:586-592`) render as today.

**Submit button visibility** (`:620`): today hidden when `result ∈ {correct, accepted}`.
Change so it's hidden only for `correct`; for `accepted` the Resubmit/Continue buttons own the
actions (the generic Submit button is not shown in the `accepted` block — Resubmit is its
stand-in).

**Rehydration on mount** (`:106-116`): read the new outcome.
- `outcome==='pass'` → `result='correct'`, backfill every question `verdict:'pass'`, emit
  (unchanged behavior).
- `outcome==='accepted'` → `result='accepted'`, `acknowledged=true` (they had continued),
  emit `step-validated` (Done stays unlocked across reloads), and render the settled Yellow
  confirmation. Per-question badges: we do **not** have the stored per-question verdicts, so
  rehydrate the aggregate as Yellow without fabricating per-question ✓. (Decision: show the
  settled "✓ Counts" confirmation strip; leave per-question badges unset on pure reload — the
  learner already saw them at submit time. This avoids the fake-green bug without persisting
  the full per-question array.)

### 3. CAP backend (`srv/developer-service.js`, `srv/developer-service.cds`)

- `doResetTutorialProgress` (`:209-310`): **relax the 100% gate fully** (Tom's decision —
  see Approaches). Remove the `if (!priorTutorialRow) reject(409)` at `:259-261` so a reset
  proceeds whenever `liveRows.length > 0`. `previousAttemptCompletedAt` is `null` for a partial
  reset (already captured via optional chaining at `:250`; `.cds` return type is already
  nullable DateTime — no schema change). All other steps (supersede live rows, insert fresh
  attempt+1 IN_PROGRESS TUTORIAL row, audit event, parent rollup with `allowDowngrade`)
  unchanged. Rate limit unchanged.
- The `liveRows.length===0` early return (`:242-244`) still handles the genuine no-progress
  case (returns the fresh-start shape).
- Audit event `TutorialProgressReset` payload gains nothing new; `previousAttemptCompletedAt`
  may now be null (already the shape).
- MCP twin `resetTutorialProgressFor` shares the same handler — inherits the relaxation.

### 4. Reset button visibility (`hugo-apps/src/tutorial-reset/TutorialReset.vue`)

- `onMounted` (`:65-94`): change the show condition from
  `completedSteps.length >= stepCount` to `completedSteps.length > 0` (show whenever there is
  any progress). Button label stays "Reset progress and try again" (still accurate).
- `confirmReset()` dispatch→reload ordering (`:129-132`) unchanged.
- Consider the confirm copy: when not fully complete, the confirm dialog should say it clears
  **all** progress for the tutorial (not just "re-do a completed tutorial"). Minor copy tweak;
  builder's call to keep it accurate for the partial case.

## What's left to the builder

- Exact UI5 control choice for the `[Resubmit]`/`[Continue anyway]` pairing and the settled
  confirmation strip design (follow the existing `partial`/`incorrect` strip+button sibling
  pattern at `:640-699`; `ui5-message-strip` has no action slot).
- Exact wording of the settled-after-ack confirmation and the partial-reset confirm dialog
  copy, within the intent above. **My call (builder-check M3):** reword the confirm body at
  `TutorialReset.vue:198-201` from "clear your completion record … start again from step 1"
  to "clear all your progress for this tutorial" so it's accurate for a never-completed reset.
- Whether to keep the literal state name `accepted` or rename to `acknowledged`/`partial-ok`
  internally — cosmetic; keep `accepted` to minimize churn unless clarity demands otherwise.
- Test updates (full list — builder check M1/M2 found the doc's first pass incomplete). Follow TDD:
  - `hugo-apps/src/validation/Validation.test.ts` — the #2348 accepted test at `:358` flips
    from "auto-unlock on submit" to "requires Continue anyway"; the all-pass persistence
    assertion at `:238` flips from `"correct":true` to `"outcome":"pass"`; add a
    Resubmit-improves-to-pass test; add a reload-rehydrates-Yellow (not fake-green) test.
  - `test/unit/validation-grading.test.js:202-236` — update `readPersisted`/`writePersisted`
    assertions to the new `{outcome}` shape; add a legacy `{correct:true}` → `{outcome:'pass'}`
    read-shim test.
  - **Both `writePersisted` production call sites** (`Validation.vue:353` → `'pass'`, and the
    accepted branch moved into `onContinueAnyway` → `'accepted'`) — builder-check M1.
  - `hugo-apps/src/tutorial-reset/TutorialReset.test.ts` — button shows at partial progress.
  - `test/unit/reset-tutorial-progress.test.js:138-188` — **invert** the two #2446 assertions
    (partial reset → 200, all live rows SUPERSEDED, fresh attempt reads empty). **Add the
    replacement #2446 regression guard:** partial reset followed by `getProgress` returns
    `completedSteps:[]` AND the parent group/mission rolls up to NOT-completed with no stale
    points — reproducing #2446's actual points/rollup symptom.
  - MCP reset-twin test inherits the relaxation — update any 409 assertion there.
  - `test/smoke/reset-tutorial-progress.smoke.test.js` — already assumes relaxed behavior;
    confirm it stays green (no change expected).
- Verify `tutorial.ts` Done-gate (`:577-622`) needs no change: it unlocks on `step-validated`,
  which now fires on Continue-anyway and on `correct` — confirm no code assumes `accepted`
  auto-fired it on submit.

## Verification (Tom's #1 rule: test the actual thing)

- Unit/island tests above, run scoped (`npm test -- <file>`).
- Manual/e2e against a tutorial with a free-text AI question: submit a partial answer →
  see ⚠ + editable box + both buttons; Resubmit a better answer → Green; reload → still
  Yellow (not fake Green); reset at partial progress → clears, button visible mid-tutorial.
- Backend reset: hybrid/integration test that a mid-tutorial reset yields an empty current
  attempt (`getProgress` returns `completedSteps:[]`).
