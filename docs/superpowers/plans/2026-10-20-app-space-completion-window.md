# App Space Completion Time Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** In the App Space progress handler, only count a tutorial completion toward the track/prize when it happened within the event's `[startDate, endDate]`; surface pre/post-event completions as a distinct "redo" state in the App Space UI.

**Architecture:** Server-side status downgrade in `getAppSpaceProgress` only — a `COMPLETED` TaskRecord whose `completionDate` is outside the event window (or whose window can't be gated) is re-emitted as a new plain-string status `COMPLETED_OUT_OF_WINDOW`. The Vue client already gates track/prize completion strictly on `=== 'COMPLETED'`, so the downgraded items stop counting automatically; the client adds a distinct visual state + hint for the new token.

**Tech Stack:** CAP Node.js (`@sap/cds`) service handler; Vue 3 SFC (`AppSpace.vue`); Vitest/CAP unit tests against in-memory SQLite (`npm test`).

**Spec:** `docs/superpowers/specs/2026-10-20-app-space-completion-window-design.md`

## Global Constraints

- Change is **App Space only** — `srv/developer-service.js` `getAppSpaceProgress`. Do **not** touch `getEventProgress`, `createTaskRecord`, `PrizeRecords`, or the scanner/claim path.
- No new entity, CDS field, or DB migration. `status` returned by the function is declared `String` (unconstrained) in `srv/developer-service.cds:250` — the new token needs no schema change.
- New status token is exactly `COMPLETED_OUT_OF_WINDOW`.
- Window bounds are **inclusive** `[startDate, endDate]`.
- **Fail-open:** gate only when **both** `startDate` and `endDate` are present; if **either** is null/absent → no gating (COMPLETED stays COMPLETED).
- Gate applies **only to `taskType === 'TUTORIAL'`** items; other item types pass through unchanged.
- A COMPLETED record with **null `completionDate`** counts as out-of-window (only when the event is gated, i.e. both dates present).
- Do **not** copy `cat-game-award.js`'s `eventIsLive` verbatim — it tolerates open bounds; our fail-open rule is stricter (both-dates-present-or-no-gate). Reuse only its inclusive both-bounds comparison.
- `completionDate` is ISO-8601 UTC (`new Date().toISOString()`); compare via `Date.parse` / epoch ms.

## Review Focus

- **completionDate exactly on a bound** — `completionDate === startDate` or `=== endDate` must count as in-window (inclusive). Covered by Task 1 boundary test.
- **Half-dated event (one date null)** — must NOT gate; copying `eventIsLive` would wrongly gate it. Covered by Task 1 fail-open tests (null-start and null-end variants).
- **Null completionDate on a gated event** — must downgrade to out-of-window, not silently stay COMPLETED. Covered by Task 1.
- **Non-TUTORIAL items (CHECKPOINT/PRIZE)** — must never be downgraded even if timestamped oddly. Covered by Task 1 pass-through test.
- **Client gating regression** — a `COMPLETED_OUT_OF_WINDOW` item must not advance `completedCount`/`isTrackComplete`/`isItemUnlocked`. Covered by Task 2 (verify strict `=== 'COMPLETED'` preserved) — no new "counts" path added.

---

### Task 1: Window-gate the status in `getAppSpaceProgress`

**Files:**
- Modify: `srv/developer-service.js` — `getAppSpaceProgress`, item-shaping block (~719–731); status line at `:724`.
- Test: `test/app-space-completion-window.test.js` (create)

**Interfaces:**
- Consumes: existing `getAppSpaceProgress` return shape; `event` row (with `startDate`, `endDate`), `record` (TaskRecord with `status`, `completionDate`), `i.taskType` all already in scope at the shaping point.
- Produces: per-item `status` may now be the string `'COMPLETED_OUT_OF_WINDOW'` for TUTORIAL items completed outside a gated event window. All other behavior/shape unchanged.
- Helper (builder's choice of placement — inline or small local fn): `effectiveAppSpaceStatus(record, event, taskType) -> string`. Returns `record.status` unchanged unless: `taskType === 'TUTORIAL'` AND `record.status === 'COMPLETED'` AND event is gatable (both `startDate` & `endDate` present) AND `completionDate` is null or outside inclusive `[startDate, endDate]` → returns `'COMPLETED_OUT_OF_WINDOW'`.

- [ ] **Step 1: Write the failing tests**

Create `test/app-space-completion-window.test.js`. Follow the existing App Space test's harness/bootstrap pattern (`test/app-space-fk-resolution.test.js`) for spinning up the service against in-memory SQLite, seeding an Event (with mission → path → a TUTORIAL path-item), a user, and a TaskRecord. Call `getAppSpaceProgress({ eventLegacyId })` and assert on the returned item's `status`.

Tests (one event window = `startDate` 2026-10-10T00:00:00Z, `endDate` 2026-10-12T23:59:59Z unless noted):
```
test('in-window COMPLETED stays COMPLETED')            // completionDate 2026-10-11T12:00:00Z → 'COMPLETED'
test('before startDate → COMPLETED_OUT_OF_WINDOW')      // 2026-09-01T00:00:00Z
test('after endDate → COMPLETED_OUT_OF_WINDOW')         // 2026-11-01T00:00:00Z
test('completionDate === startDate counts (inclusive)') // 2026-10-10T00:00:00Z → 'COMPLETED'
test('completionDate === endDate counts (inclusive)')   // 2026-10-12T23:59:59Z → 'COMPLETED'
test('null completionDate on gated event → OUT_OF_WINDOW')
test('event with null startDate → no gating (fail-open)')   // out-of-range date still 'COMPLETED'
test('event with null endDate → no gating (fail-open)')     // out-of-range date still 'COMPLETED'
test('IN_PROGRESS record passes through unchanged')     // status stays 'IN_PROGRESS'
test('non-TUTORIAL (CHECKPOINT) COMPLETED never downgraded') // even with out-of-range completionDate
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app-space-completion-window`
Expected: FAIL — out-of-window cases still return `'COMPLETED'` (gate not yet implemented).

- [ ] **Step 3: Implement the gate**

In `srv/developer-service.js`, add the helper (local to the file/handler) per the Interfaces block, and replace the status assignment at `:724`:
`status: record?.status || ''` → `status: effectiveAppSpaceStatus(record, event, i.taskType) || ''`.
Inclusive comparison via epoch ms (`Date.parse`). Gatable = both `event.startDate` and `event.endDate` are truthy. Add a one-line comment citing `#2866` + the fail-open (both-dates-or-no-gate) rule. Do **not** import/copy `eventIsLive`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- app-space-completion-window`
Expected: PASS (all cases).

- [ ] **Step 5: Run the broader suite for regressions**

Run: `npm test -- app-space`
Expected: PASS — `app-space-fk-resolution` and any other app-space tests still green.

- [ ] **Step 6: Commit**

```bash
git add srv/developer-service.js test/app-space-completion-window.test.js
git commit -m "feat(#2866): gate App Space tutorial completions to the event window"
```

---

### Task 2: "Redo" visual state in `AppSpace.vue`

**Files:**
- Modify: `hugo-apps/src/app-space/AppSpace.vue` — `itemStatusClass()` (~253–259); step-content template (insert after the desc `<p>` at ~528); per-state CSS (~1039–1087 and theme blocks ~1389/1539).
- (No new test file; UI assertion is advisory per repo e2e nudge — see Step 5.)

**Interfaces:**
- Consumes: per-item `status` from Task 1, which may be `'COMPLETED_OUT_OF_WINDOW'`.
- Produces: items with that status render with a dedicated class (`step--redo`) and an inline hint; they remain **not** counted by `completedCount()`/`isTrackComplete()`/`isItemUnlocked()`/`progressPercent()`.

- [ ] **Step 1: Verify the "doesn't count" guarantee is preserved**

Confirm (read-only) that `completedCount()` (~217), `isTrackComplete()` (~226), `progressPercent()` (~229–232), and all three branches of `isItemUnlocked()` (~240/244/248) still test strict `=== 'COMPLETED'`. Add **no** branch that treats `COMPLETED_OUT_OF_WINDOW` as complete. (This is the regression guard from Review Focus.)

- [ ] **Step 2: Add the `step--redo` class branch**

In `itemStatusClass()`, add a branch returning `'step--redo'` when `item.status === 'COMPLETED_OUT_OF_WINDOW'` (place it before/independent of the `COMPLETED` check so it can't be shadowed).

- [ ] **Step 3: Add the inline redo hint**

In the step-content block, after the optional desc `<p>` (~528), add:
`<p v-if="item.status === 'COMPLETED_OUT_OF_WINDOW'" class="step-redo-hint">Completed before the event — reset your progress and redo it during the event to earn your prize.</p>`
Wording/markup may be adjusted to match surrounding style; it must point at the **existing** reset feature and must not imply a new control.

- [ ] **Step 4: Add `step--redo` CSS**

Add a `step--redo` ruleset alongside `.step--completed` / `.step--earned` (~1039–1087) and matching theme variants (~1389/1539), visually distinct from both not-started and completed (e.g. a "needs attention"/amber treatment for the bubble + content). Keep consistent with existing per-state patterns.

- [ ] **Step 5: Build the island to verify it compiles**

Run: `npm run build:apps` (or the project's app-space island build — confirm via `jq '.scripts' package.json`). Wrap in `scripts/quiet-run.sh` if output is long.
Expected: build succeeds, no Vue/TS errors in `AppSpace.vue`.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/app-space/AppSpace.vue
git commit -m "feat(#2866): show distinct redo state for out-of-window App Space completions"
```

---

## Notes for the executor

- Confirm the exact app-space island build script before Task 2 Step 5 (`jq '.scripts' package.json` — likely `build:apps`/`build:hugo-apps`). Use `scripts/quiet-run.sh` for any long build/test output per repo token-efficiency rules.
- On Windows worktrees, verify edited files kept LF (`file <path>`) before committing; normalize if a tool flipped to CRLF.
- Branch: `worktree-issue-2866-appspace-window`. PR targets `DEV` (never `main`). Do not deploy from a feature branch.
