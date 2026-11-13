# AI-Graded Yellow UX + Reset Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Yellow (partial) AI-graded answer an explicit, interactive state (editable box + Resubmit/Continue-anyway, no silent unlock), stop the reload-as-fake-green bug, and allow resetting tutorial progress at any point.

**Architecture:** Three loosely-coupled changes. (1) `grading.ts` persistence migrates from `{correct:boolean}` to `{outcome:'pass'|'accepted'}` with a legacy read shim. (2) `Validation.vue` stops auto-unlocking on `accepted`: it keeps the textbox editable and gates the unlock behind a new `onContinueAnyway()`; reload rehydrates Yellow as Yellow. (3) The CAP `doResetTutorialProgress` handler drops its 100%-complete 409 gate; the `TutorialReset.vue` button shows at any progress. The old #2446 409 guard is replaced by a new rollup/points regression test.

**Tech Stack:** Vue 3 (`<script setup lang="ts">`) + UI5 web components, Vitest; CAP Node.js (`cds.ql`), the repo's CAP test harness.

**Spec:** `docs/superpowers/specs/2026-11-13-ai-graded-yellow-ux-design.md`

## Global Constraints

- Vue text interpolation `{{ }}` only for model/hint output — **never `v-html`** (reference-answer redaction is first defence, Vue auto-escape second).
- UI5 boolean attributes via `v-bind="cond ? { disabled: true } : {}"` — never `:disabled="cond"` (presence = truthy; see existing comments at `Validation.vue:534`, `TutorialReset.vue:210`).
- localStorage access stays wrapped in try/catch returning a safe default (private-mode/quota tolerant).
- Backend: **CQL/`cds.ql` only, never raw SQL**. `resetTutorialProgress` is `@requires:'authenticated-user'`; the gate change lives in the shared `doResetTutorialProgress` so both the OData action and the MCP twin `resetTutorialProgressFor` inherit it.
- localStorage key unchanged: `tutorial-validation-<slug>-<stepNumber>` (every other reader matches by key *prefix*, not value shape — migration is invisible to them).
- Tests run scoped: `npm test -- <file>` (full suite is hook-blocked locally).

## Review Focus

- **Private-mode / quota localStorage failure during the outcome migration** — `readPersisted`/`writePersisted` must still return null / no-op silently, never throw into mount or submit. Covered: Task 1 Step 1 (a throwing-localStorage case).
- **A legacy `{correct:true}` key written before this change** — a learner mid-tutorial must still see their passed step as passed. Covered: Task 1 (legacy-read-shim test).
- **Reload of an acknowledged Yellow step** — Done must stay unlocked (the `data-validated` attribute path), and the step must render Yellow, not fake-green. Covered: Task 3 (rehydrate-accepted test asserting `result==='accepted'` + `emitStepValidated` side-effects, no fabricated per-question `pass`).
- **Partial reset leaving a stale parent rollup / phantom points** — the exact #2446 symptom; the 409 guard that prevented it is being removed. Covered: Task 4 (new rollup regression test: after a partial reset, `getProgress` empty AND parent group not COMPLETED).
- **A reset when the user has zero progress** — must not create a spurious attempt or error. Covered: Task 4 (no-progress reset returns fresh-start shape, no rows superseded).

---

### Task 1: Persistence shape migration (`grading.ts`)

**Files:**
- Modify: `hugo-apps/src/validation/grading.ts:106-140`
- Test: `test/unit/validation-grading.test.js` (existing suite ~`:202-236`)

**Interfaces:**
- Produces:
  - `type PersistedOutcome = 'pass' | 'accepted'`
  - `readPersisted(slug: string, stepNumber: number): { outcome: PersistedOutcome } | null` — legacy `{correct:true}` reads as `{outcome:'pass'}`.
  - `writePersisted(slug: string, stepNumber: number, outcome: PersistedOutcome): void` — writes `{outcome, timestamp}`.
  - `persistKey(slug, stepNumber)` unchanged.

- [ ] **Step 1: Write the failing tests** in `test/unit/validation-grading.test.js`, replacing the current `readPersisted`/`writePersisted` assertions:

```js
// writePersisted now takes an outcome enum and stores it
it('writePersisted stores {outcome} shape', () => {
  writePersisted('slug', 2, 'accepted');
  expect(JSON.parse(store['tutorial-validation-slug-2']).outcome).toBe('accepted');
});
it('writePersisted pass stores outcome pass', () => {
  writePersisted('slug', 1, 'pass');
  expect(JSON.parse(store['tutorial-validation-slug-1']).outcome).toBe('pass');
});
// readPersisted returns the outcome
it('readPersisted returns the stored outcome', () => {
  writePersisted('slug', 3, 'accepted');
  expect(readPersisted('slug', 3)).toEqual({ outcome: 'accepted' });
});
// legacy back-compat: old {correct:true} reads as pass
it('readPersisted reads legacy {correct:true} as outcome pass', () => {
  store['tutorial-validation-slug-9'] = JSON.stringify({ correct: true, timestamp: 1 });
  expect(readPersisted('slug', 9)).toEqual({ outcome: 'pass' });
});
it('readPersisted returns null on malformed / missing / throwing storage', () => {
  expect(readPersisted('slug', 404)).toBeNull();
  store['tutorial-validation-slug-5'] = 'not json';
  expect(readPersisted('slug', 5)).toBeNull();
});
```

(Match the suite's existing localStorage-mock setup — reuse its `store`/`localStorage` stub; keep the existing describe block.)

- [ ] **Step 2: Run tests, verify they fail**
Run: `npm test -- validation-grading`
Expected: FAIL (new shape not implemented; legacy shim absent).

- [ ] **Step 3: Implement the new `readPersisted`/`writePersisted`** in `grading.ts:106-140`.
`readPersisted`: parse the key; return `{outcome:'pass'}` when `parsed.outcome==='pass'` OR legacy `parsed.correct===true`; `{outcome:'accepted'}` when `parsed.outcome==='accepted'`; else null; all wrapped try/catch → null. `writePersisted(slug, step, outcome)`: `setItem(persistKey, JSON.stringify({outcome, timestamp: Date.now()}))` in try/catch (silent). Export `PersistedOutcome`.

- [ ] **Step 4: Run tests, verify pass**
Run: `npm test -- validation-grading`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add hugo-apps/src/validation/grading.ts test/unit/validation-grading.test.js
git commit -m "refactor(validation): persist AI-graded outcome (pass|accepted) with legacy read shim (#3120)"
```

---

### Task 2: Yellow state becomes interactive in `Validation.vue` (logic)

**Files:**
- Modify: `hugo-apps/src/validation/Validation.vue` — `onSubmit` accepted branch (`:355-362`), add `onContinueAnyway`, add `acknowledged` ref, rehydrate (`:106-116`), `writePersisted` call sites (`:353`, `:361`).
- Test: `hugo-apps/src/validation/Validation.test.ts`

**Interfaces:**
- Consumes: `writePersisted(slug, step, 'pass'|'accepted')`, `readPersisted → {outcome}` from Task 1.
- Produces (component VM, asserted by tests): `result` ref unchanged union; new `const acknowledged = ref(false)`; new `function onContinueAnyway(): void`.

- [ ] **Step 1: Write/flip the failing tests** in `Validation.test.ts`:
  - **Flip Test 4 (`:358`)** — rename intent to "pass + partial → result=accepted, hint shown, but step NOT yet validated": assert `result==='accepted'`, `hint==='Consider edge cases.'`, and **`eventSpy` NOT called** (no auto-unlock). Then call `getVm(wrapper).onContinueAnyway()`, `await nextTick()`, and assert `eventSpy` called once and `getVm(wrapper).acknowledged === true`.
  - **Flip Test 5 (`:386`)** — `result==='accepted'`, `hint===''`, `eventSpy` not called on submit.
  - **Add** "Continue anyway persists accepted": spy/stub on the localStorage store; after `onContinueAnyway()`, assert `store['tutorial-validation-<slug>-<step>']` contains `"outcome":"accepted"`.
  - **Add** "Resubmit after accepted can reach correct": seed a partial grade → accepted; then set a better answer, re-submit with both AI mocks returning `pass`; assert `result==='correct'` and store contains `"outcome":"pass"`.
  - **Update** the all-pass persistence assertion (currently `:238`, `.toContain('"correct":true')`) → `.toContain('"outcome":"pass"')`.

- [ ] **Step 2: Run tests, verify they fail**
Run: `npm test -- Validation.test`
Expected: FAIL (`onContinueAnyway`/`acknowledged` undefined; accepted still auto-emits).

- [ ] **Step 3: Implement the logic** in `Validation.vue`:
  - Add `const acknowledged = ref(false)`.
  - In `onSubmit`, all-pass branch (`:350-354`): change `writePersisted(props.slug, props.stepNumber, true)` → `writePersisted(props.slug, props.stepNumber, 'pass')`; set `acknowledged.value = false`.
  - `accepted` branch (`:355-362`): set `result='accepted'`, `hint=firstHint`, set `acknowledged.value = false`, and **remove** the `writePersisted` + `emitStepValidated` calls (unlock now deferred).
  - Add `function onContinueAnyway()`: `writePersisted(props.slug, props.stepNumber, 'accepted'); emitStepValidated(); acknowledged.value = true;`.
  - Rehydration (`:106-116`): read `const persisted = readPersisted(...)`. If `persisted?.outcome === 'pass'`: existing behavior (submitted, `result='correct'`, backfill every question `verdict:'pass'`, `emitStepValidated()`). If `persisted?.outcome === 'accepted'`: `submitted.value=true; result.value='accepted'; acknowledged.value=true; emitStepValidated();` — do **not** backfill per-question `pass`.

- [ ] **Step 4: Run tests, verify pass**
Run: `npm test -- Validation.test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add hugo-apps/src/validation/Validation.vue hugo-apps/src/validation/Validation.test.ts
git commit -m "feat(validation): Yellow answers require explicit Continue-anyway, no silent unlock (#3120)"
```

---

### Task 3: Yellow state template + editable box in `Validation.vue`

**Files:**
- Modify: `hugo-apps/src/validation/Validation.vue` — textarea disable guard (`:577`), radio (`:559`), checkbox (`:539`); accepted strip (`:477-483`); submit-button visibility (`:620`); add the Resubmit/Continue-anyway block.
- Test: `hugo-apps/src/validation/Validation.test.ts`

**Interfaces:**
- Consumes: `result`, `acknowledged`, `onContinueAnyway`, `onSubmit` (Task 2).

- [ ] **Step 1: Write the failing DOM tests** in `Validation.test.ts`:
  - "accepted state keeps the textarea editable": after a submit → accepted, assert the `ui5-textarea` has **no** `disabled` attribute.
  - "accepted state shows Resubmit and Continue anyway buttons": assert both buttons present by text; assert the "⚠ Partially correct" strip text is rendered.
  - "after acknowledge, Continue-anyway button is gone, textarea still editable, confirmation shown": call `onContinueAnyway()`, `await nextTick()`; assert no "Continue anyway" button, textarea still not disabled, and the settled confirmation text present.
  - "correct state still disables the textarea": all-pass submit → assert textarea `disabled`.

(Query via `wrapper.find`/`findAll` on the component's rendered UI5 custom elements as the existing tests do.)

- [ ] **Step 2: Run tests, verify they fail**
Run: `npm test -- Validation.test`
Expected: FAIL (box still disabled on accepted; buttons absent).

- [ ] **Step 3: Implement the template changes** in `Validation.vue`:
  - Textarea `:577`, radio `:559`, checkbox `:539`: change the disable guard from `result === 'correct' || result === 'accepted'` to `result === 'correct'`.
  - Replace the accepted success strip (`:477-483`) with a conditional strip:
    - when `result==='accepted' && !acknowledged`: `design="Information"`, text `⚠ Partially correct — your answer covers the main idea.` + `<template v-if="hint"> One thing to consider: {{ hint }}</template>`.
    - when `result==='accepted' && acknowledged`: `design="Positive"`, text `✓ Counts — you've continued. You can still refine your answer and resubmit.`.
  - Add, inside the form after the fieldsets (sibling to the other result blocks, following the `:640-699` strip+button pattern), a block `v-if="submitted && result==='accepted'"` containing a **Resubmit** button (`@click="onSubmit"`, `type="button"`, disabled while `pending`) and, `v-if="!acknowledged"`, a **Continue anyway** button (`design="Emphasized"`, `@click="onContinueAnyway"`). The generic Submit button at `:620` already hides when `result==='accepted'`, so Resubmit is the only submit affordance in this state — leave `:620` unchanged.

- [ ] **Step 4: Run tests, verify pass**
Run: `npm test -- Validation.test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add hugo-apps/src/validation/Validation.vue hugo-apps/src/validation/Validation.test.ts
git commit -m "feat(validation): editable Yellow box + Resubmit/Continue-anyway UI (#3120)"
```

---

### Task 4: Relax the reset gate (CAP backend)

**Files:**
- Modify: `srv/developer-service.js:252-261` (remove the 409 gate).
- Test: `test/unit/reset-tutorial-progress.test.js:138-188` (invert #2446 assertions; add rollup regression test).

**Interfaces:**
- Consumes: existing `doResetTutorialProgress(sapId, slug, req, tokenSource)`, `getProgress`, `rollUpParentsForCompletion`.
- Produces: no signature change; behavior: reset proceeds whenever `liveRows.length > 0`, else returns `{newAttemptNumber:1, previousAttemptCompletedAt:null, supersededRecordCount:0}`.

- [ ] **Step 1: Flip + add the failing tests** in `test/unit/reset-tutorial-progress.test.js`:
  - **Flip `:151-188`** ("rejects reset of a partially-completed tutorial with 409") → "resets a partially-completed tutorial (200, supersedes partial progress)": seed step-1-done + tutorial IN_PROGRESS; call reset; assert it resolves (no reject), the STEP + TUTORIAL live rows are now `SUPERSEDED`, and a fresh IN_PROGRESS TUTORIAL row exists at attempt 2.
  - **Flip `:138-149`** (second-reset 409) → assert the second reset also resolves 200 (the attempt-2 IN_PROGRESS row is itself resettable) and bumps to attempt 3.
  - **Add the #2446 rollup regression guard** — "partial reset clears parent rollup + points (replaces #2446 409 guard)": seed a tutorial that belongs to a group/mission with the parent rolled to COMPLETED off a single step (reproduce #2446's shape), partial-reset the tutorial, then assert `getProgress(slug)` returns `completedSteps: []` AND the parent group/mission TaskRecord is NOT `COMPLETED` (downgraded by `rollUpParentsForCompletion(allowDowngrade:true)`). If the existing seed helpers don't build a parent, extend them minimally within this test.
  - Keep the 404 (`:190-196`) and 401 (`:198+`) tests as-is. Confirm the no-progress path returns the fresh-start shape (add an assertion if not already covered).

- [ ] **Step 2: Run tests, verify they fail**
Run: `npm test -- reset-tutorial-progress`
Expected: FAIL (handler still rejects partial reset with 409).

- [ ] **Step 3: Remove the 409 gate** in `developer-service.js`: delete the `if (!priorTutorialRow) return req.reject(409, ...)` block (`:259-261`) and its now-stale comment (`:252-258`). Keep `previousAttemptCompletedAt = priorTutorialRow?.completionDate ?? null` (`:247-250`) — it already yields null for a partial reset. Leave the `liveRows.length===0` early return (`:242-244`) intact.

- [ ] **Step 4: Run tests, verify pass**
Run: `npm test -- reset-tutorial-progress`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add srv/developer-service.js test/unit/reset-tutorial-progress.test.js
git commit -m "feat(reset): allow mid-tutorial reset; replace #2446 409 guard with rollup regression test (#3120)"
```

---

### Task 5: Show the Reset button at any progress (`TutorialReset.vue`)

**Files:**
- Modify: `hugo-apps/src/tutorial-reset/TutorialReset.vue` — show-condition (`:76-89`), confirm-dialog body copy (`:198-201`).
- Test: `hugo-apps/src/tutorial-reset/TutorialReset.test.ts`

**Interfaces:**
- Consumes: `/api/getProgress` response `{completedSteps:[]}`.

- [ ] **Step 1: Write/flip the failing tests** in `TutorialReset.test.ts`:
  - "shows the reset button when there is partial progress": mock `getProgress` → `{completedSteps:[1]}` with `data-step-count=3`; assert `showReset` true / button rendered.
  - "hides the reset button when there is zero progress": `{completedSteps:[]}`; assert button not rendered.
  - Keep/adjust any existing "shows at full completion" test so it still passes under the new `> 0` condition.

- [ ] **Step 2: Run tests, verify they fail**
Run: `npm test -- TutorialReset.test`
Expected: FAIL (button hidden at partial progress).

- [ ] **Step 3: Implement** in `TutorialReset.vue`: change `onMounted` show condition from `if (completedCount >= stepCount)` to `if (completedCount > 0)` (`:87`); the `stepCount` read can stay (now unused for the decision but harmless) or be removed — keep minimal. Reword the confirm body (`:199-200`) from "clear your completion record for this tutorial and you'll start again from step 1" to "clear all your progress for this tutorial and you'll start again from step 1".

- [ ] **Step 4: Run tests, verify pass**
Run: `npm test -- TutorialReset.test`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add hugo-apps/src/tutorial-reset/TutorialReset.vue hugo-apps/src/tutorial-reset/TutorialReset.test.ts
git commit -m "feat(reset): show Reset button at any progress + accurate confirm copy (#3120)"
```

---

### Task 6: Full-suite verification + build sanity

**Files:** none (verification only).

- [ ] **Step 1: Run the validation + reset test files together**
Run: `npm test -- validation-grading Validation.test TutorialReset.test reset-tutorial-progress`
Expected: all PASS.

- [ ] **Step 2: Type-check / island build** (the islands ship from `hugo-apps/`)
Run: `npm run build:apps` (or the hugo-apps build script per `jq '.scripts' package.json`)
Expected: build succeeds, no TS errors from the changed files.

- [ ] **Step 3: Grep for stale `writePersisted(..., true/false)` or `.correct` readers** to confirm no missed caller.
Run: `rg "writePersisted\(|\.correct\b|result === 'accepted'" hugo-apps/src`
Expected: only the intended call sites remain; no `writePersisted(..., true)`.

- [ ] **Step 4: Commit** any doc/CHANGELOG touch-ups if the repo expects them (otherwise skip).

---

## Notes for the executor

- The CAP reset handler change is the only backend change and is behind `authenticated-user`; the MCP twin inherits it — no separate MCP code edit, but update the MCP reset test if it asserts 409.
- Done-button gate in `hugo/assets/js/tutorial.ts:577-622` needs **no** change (verified): it unlocks on `step-validated` / `data-validated="true"`, both now fired by `onContinueAnyway` and by the accepted-rehydrate path.
- The homepage/approuter build is out of scope; this is island + backend only. A deploy is a separate step the user will decide on.
