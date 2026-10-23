# Badge Scanner v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Vue badge scanner's camera + `null of 2` count, and extend it to show contestant identity (`LastName, F.`), claimed prize names, and per-event aggregate stats.

**Architecture:** Two new/changed CAP function handlers on the existing `ScannerService` (`getContestant` extended, `getEventStats` added), consumed by the existing Vue island at `hugo-apps/src/scanner-vue/`. Camera fix is a one-line `nextTick` ordering change. CQL only; `@requires: 'MobileApp'` unchanged.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds` ≥10.1), CQL, Vue 3 (`<script setup>`), Fundamental Styles, Vitest. All tests — CAP (`cds.test`) and Vue island (happy-dom) — run from the **root** `vitest.config.ts` `unit` project: `npx vitest run --project unit <path>`. The `unit` project already includes `hugo-apps/src/**/*.{test,spec}.{js,ts}` with happy-dom (an existing `scanner-vue/__tests__/scanner-claim.test.ts` runs there). Do NOT add a vitest config under `hugo-apps/` — there is none and none is needed.

**Spec:** `docs/superpowers/specs/2026-10-23-badge-scanner-v2-design.md`

## Global Constraints

- **CQL/CDS only — no raw SQL.** (Project rule; the `forUpdate()` cap in `claimPrizeForContestant` is untouched.)
- **Event scoping = `TaskRecords.event_ID == event.ID`** (badge/app-space path), NOT the Devtoberfest date-window. Event resolved by `Events.legacyId == eventId`.
- **Completion semantic:** has-ever-completed, DISTINCT by `(user_ID, taskLegacyId)`, counting `status in ('COMPLETED','SUPERSEDED')`. Identical for per-contestant and per-event aggregates.
- **PII:** identity response carries `lastName` (full) + `firstInitial` (single uppercase char, derived server-side). **No email, no full first name, ever crosses the wire.**
- **Statuses are `CLAIMED` / `EARNED` only** (probed on DEV). "Claimed" = `CLAIMED`.
- **Auth:** `@requires: 'MobileApp'` on the service, unchanged. No new scope.
- **Branch/PR:** `worktree-scanner-badge-v2` off `origin/DEV`; PR → **DEV**.

## Review Focus

- **Contestant with zero completions / zero prizes** — card must render `0`s and "None yet", never blank or `null` (the bug being fixed; owned by Task 1 tests).
- **Unresolvable / absent `eventId` (0 or no matching Event)** — `getContestant` must still return the contestant; `getEventStats` returns a null-ish/empty shape and the Vue panel hides, no error (owned by Task 2 + Task 4 tests).
- **`firstName` empty/null** — `firstInitial` must be `''`, not throw on `.charAt(0)` (owned by Task 1 tests).
- **Event stats must not leak cross-event rows** — a CLAIMED/completion row on a *different* event must not count (owned by Task 2 tests).
- **API returns `null` claimedCount** — Vue must render `0 of 2`, not `null of 2` (owned by Task 4 tests).

---

### Task 1: Extend `getContestant` — identity + claimed prize names

**Files:**
- Modify: `srv/scanner-service.cds:7-13` (return shape)
- Modify: `srv/scanner-service.js:11-52` (`getContestant` handler)
- Test: `test/unit/scanner-contestant-count.test.js` (extend)

**Interfaces:**
- Produces: `getContestant(accountNumber: String, eventId: Integer)` now returns
  `{ lastName: String, firstInitial: String, tutorialsCompleted: Integer, groupsCompleted: Integer, missionsCompleted: Integer, claimedCount: Integer, claimedPrizeNames: array of String, prizeRecords: String }`.
  `firstInitial` = first char of `firstName` uppercased, or `''` if empty.
  `claimedPrizeNames` = names of CLAIMED prizes for (user, event) with a non-null `prize`; null-`prize` rows contribute a generic `'Prize'` entry so the list length tracks `claimedCount`.

- [ ] **Step 1: Write failing tests** in `test/unit/scanner-contestant-count.test.js`:
  - seed a user with `firstName:'Thomas', lastName:'Jung'`; assert `result.lastName === 'Jung'` and `result.firstInitial === 'T'`.
  - seed a user with `firstName:''`; assert `firstInitial === ''` (no throw).
  - seed 1 CLAIMED PrizeRecord for the event with `prize_ID` → a Prizes row `name:'Sticker Pack'`; assert `result.claimedPrizeNames` deep-equals `['Sticker Pack']`.
  - assert existing `claimedCount` / `prizeRecords` assertions still hold.

- [ ] **Step 2: Run to verify fail** — `npx vitest run --project unit test/unit/scanner-contestant-count.test.js`. Expected: FAIL (new keys undefined).

- [ ] **Step 3: Implement.** In `.cds` add `lastName`, `firstInitial`, `claimedPrizeNames : array of String` to the return. In `.js`: select `firstName, lastName` off the user; `firstInitial = (user.firstName||'').trim().charAt(0).toUpperCase()`; when fetching CLAIMED PrizeRecords, expand `prize` (`.columns('status','prize_ID', {ref:['prize'],expand:['name']})` or a follow-up `SELECT Prizes` by collected ids) and build `claimedPrizeNames` (real name, else `'Prize'`). Keep the existing count/`prizeRecords` logic.

- [ ] **Step 4: Run to verify pass** — `npx vitest run --project unit test/unit/scanner-contestant-count.test.js`. Expected: PASS.

- [ ] **Step 5: Commit** — `git add srv/scanner-service.cds srv/scanner-service.js test/unit/scanner-contestant-count.test.js && git commit -m "feat(scanner): getContestant returns identity + claimed prize names (#badge-v2)"`

---

### Task 2: Add `getEventStats` function

**Files:**
- Modify: `srv/scanner-service.cds` (add function after line 25, before closing `}`)
- Modify: `srv/scanner-service.js` (add `this.on('getEventStats', ...)` handler)
- Test: `test/unit/scanner-event-stats.test.js` (create)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: `getEventStats(eventId: Integer)` returns
  `{ eventName: String, prizesClaimed: Integer, prizesAvailable: Integer, earnedAwaitingHandover: Integer, participants: Integer, participantsClaimed: Integer, tutorialsCompleted: Integer, groupsCompleted: Integer, missionsCompleted: Integer }`.
  Unresolvable `eventId` → all-zero/empty object with `eventName: null` (handler returns, does not reject).

- [ ] **Step 1: Write failing tests** in `test/unit/scanner-event-stats.test.js` (`cds.test('serve')` like the sibling test). Seed: event `evt-main` (legacyId 10000015) + `evt-other`; 3 Prizes on evt-main (`prizesAvailable=3`); PrizeRecords — 2 CLAIMED + 1 EARNED on evt-main (across 2 users), 1 CLAIMED on evt-other; TaskRecords — user A: 2 TUTORIAL COMPLETED (distinct taskLegacyId) + 1 GROUP on evt-main; user B: 1 TUTORIAL on evt-main; 1 TUTORIAL on evt-other (must NOT count). Assert:
  - `prizesClaimed===2`, `prizesAvailable===3`, `earnedAwaitingHandover===1`
  - `participants===2`, `participantsClaimed===2`
  - `tutorialsCompleted===3`, `groupsCompleted===1`, `missionsCompleted===0`
  - cross-event: evt-other's rows absent from evt-main totals
  - unresolvable eventId `999999` → `{ eventName:null, prizesClaimed:0, participants:0, ... }`, no throw.

- [ ] **Step 2: Run to verify fail** — `npx vitest run --project unit test/unit/scanner-event-stats.test.js`. Expected: FAIL (`getEventStats` not found).

- [ ] **Step 3: Implement.** Resolve event by `legacyId`; if none → return zero object. `prizesAvailable` = `SELECT.from(Prizes).where({event_ID})` count; `prizesClaimed`/`earnedAwaitingHandover` = counts of PrizeRecords where `{event_ID, status}`; `participantsClaimed` = distinct `user_ID` over CLAIMED. For participants + completion totals: `SELECT from TaskRecords where {event_ID, status:{in:['COMPLETED','SUPERSEDED']}}`, dedupe in JS by `(user_ID, taskLegacyId)` then count by `taskType` and distinct users (same loop pattern as `getContestant`). CQL only.

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `git add srv/scanner-service.cds srv/scanner-service.js test/unit/scanner-event-stats.test.js && git commit -m "feat(scanner): add getEventStats event-aggregate function (#badge-v2)"`

---

### Task 3: Fix Vue camera (nextTick ordering)

**Files:**
- Modify: `hugo-apps/src/scanner-vue/ScannerApp.vue` (`onScan`, add `nextTick` import)
- Test: `hugo-apps/src/scanner-vue/__tests__/scanner-camera-order.test.ts` (create)

**Interfaces:**
- Consumes: nothing. Produces: nothing for later tasks (behavioral fix).

- [ ] **Step 1: Write failing test.** A light unit test (no full mount): import a small extracted `scanOrder` helper OR assert ordering via a mock. Simplest: extract the ordering into a testable function `beginScan(setState, nextTickFn, scanFn)` that calls `setState('scanning')`, `await nextTickFn()`, then `scanFn()`, and assert `scanFn` is called only after `nextTickFn` resolves (spy order). Place the helper in `ScannerApp.vue`'s script or a sibling `scan-order.ts` and import it.

- [ ] **Step 2: Run to verify fail** — `npx vitest run --project unit hugo-apps/src/scanner-vue/__tests__/scanner-camera-order.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `import { ref, computed, nextTick } from 'vue'`; in `onScan`, after `state.value = 'scanning'` add `await nextTick()` before `const result = await scan()`. (If the ordering helper was extracted, wire `onScan` to it.)

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `git add hugo-apps/src/scanner-vue/ && git commit -m "fix(scanner): await nextTick before camera scan so video ref is mounted (#badge-v2)"`

---

### Task 4: Vue UI — identity, claimed names, event stats, null-count guard

**Files:**
- Modify: `hugo-apps/src/scanner-vue/types.ts` (add fields + `EventStats`)
- Modify: `hugo-apps/src/scanner-vue/useScannerApi.ts` (add `getEventStats`, numeric coercion)
- Modify: `hugo-apps/src/scanner-vue/ScannerApp.vue` (render identity line, claimed-names list, event-stats section)
- Test: `hugo-apps/src/scanner-vue/__tests__/scanner-coercion.test.ts` (create)

**Interfaces:**
- Consumes: `getContestant` and `getEventStats` shapes from Tasks 1 & 2.
- Produces: `ContestantData` gains `lastName: string; firstInitial: string; claimedPrizeNames: string[]`. New `EventStats` interface mirroring Task 2's return.

- [ ] **Step 1: Write failing test** in `scanner-coercion.test.ts`: a unit test over `useScannerApi`'s unwrap/coerce — given a stubbed `fetch` returning `{ value: { claimedCount: null, tutorialsCompleted: null } }`, assert `getContestant` resolves `claimedCount === 0` and `tutorialsCompleted === 0` (never null). (Stub global `fetch`.)

- [ ] **Step 2: Run to verify fail** — `npx vitest run --project unit hugo-apps/src/scanner-vue/__tests__/scanner-coercion.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `types.ts`: add the three fields to `ContestantData`; add `EventStats`.
  - `useScannerApi.ts`: add `getEventStats(eventId)` (fetch `/scanner/getEventStats(eventId=${eventId})`, `json.value ?? json`); in `getContestant` coerce numeric fields with `?? 0` and default `claimedPrizeNames` to `[]`.
  - `ScannerApp.vue`: identity header → `{{ contestant.lastName }}, {{ contestant.firstInitial }}.`; render `claimedPrizeNames` as a list, empty → "None yet"; in `loadContestant`, after loading the contestant, `if (scanResult.payload.eventId) eventStats.value = await getEventStats(eventId)`; add an event-stats section (claimed vs available, earned-awaiting, participants/claimed, completion totals) shown only when `eventStats` is set.

- [ ] **Step 4: Run to verify pass** — same command. Expected: PASS.

- [ ] **Step 5: Commit** — `git add hugo-apps/src/scanner-vue/ && git commit -m "feat(scanner): identity line, claimed prize names, event stats panel, null-count guard (#badge-v2)"`

---

### Task 5: Verify full suite + lint

**Files:** none (verification only).

- [ ] **Step 1:** Run CAP unit scanner tests — `npx vitest run --project unit test/unit/scanner-*.test.js`. Expected: all PASS.
- [ ] **Step 2:** Run Vue island tests — `npx vitest run --project unit hugo-apps/src/scanner-vue/`. Expected: all PASS.
- [ ] **Step 3:** Typecheck the island — `cd hugo-apps && npx vue-tsc --noEmit` (or the project's configured check). Expected: no new errors in `scanner-vue/`.
- [ ] **Step 4: Commit** any lint/type fixup if needed, else no-op.

---

## Notes for the executor

- Deploy/verify-on-DEV is **out of plan scope** (separate step after merge, per spec Rollout). Do not deploy from the feature branch.
- `cds bind --exec` is blocked inside this worktree by a harness guard — run any DB-bound command from the main checkout `D:\projects\tutorials-poc`, not here. Unit tests (`cds.test`) use in-memory SQLite and need no binding.
