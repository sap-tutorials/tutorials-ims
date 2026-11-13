# @cap-js/data-privacy DB-task build crash fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `@cap-js/data-privacy` from crashing during `cds build --production` when the plugin's own `sap.ilm.*` aspect model is absent from the CSN being enhanced, and open a PR to upstream.

**Architecture:** The plugin's `cds.on("loaded")` enhancer assumes its `sap.ilm.blocking`/`destruction` aspects are in every CSN it enhances; DB-task builds get a consumer-only CSN without them. Fix: in `enhanceModel`, guarantee those aspect definitions exist in the CSN before the exposure loop (load from the plugin's own `db/dpi.cds` if absent). Add a defensive use-site guard so a future regression warns instead of throwing.

**Tech Stack:** Node.js, `@sap/cds` (compiler/CSN API), the plugin's existing test harness (whatever runner `cap-js/data-privacy` uses — determined in Task 1).

**Spec:** `docs/superpowers/specs/2026-11-13-data-privacy-dbtask-crash-fix-design.md` (in tutorials-ims repo)

**Work location:** a fresh clone of the team's fork of `cap-js/data-privacy`. All file paths below are relative to that clone's root. This plan file lives in tutorials-ims for record.

## Global Constraints

- Target the plugin's `main` branch via the team fork; PR references the existing upstream bug + our repro.
- No behavior change when the plugin's model IS loaded normally (runtime/service CSN) — the fix only adds a fallback when aspects are missing.
- Inject the **narrowest** set of `sap.ilm.*` definitions that makes the DB-task path work (at minimum `blocking` + `destruction`); do NOT pull `sap.ilm.RetentionService` / service artifacts into a DB-task CSN.
- Match the fork repo's existing lint, test, and commit-message conventions (determined in Task 1, not assumed).
- The load-of-own-model fallback must run at most once per `enhanceModel` call and must be idempotent (guarded by the existing `m.meta["sap.ilm.enhanced"]` / a presence check).

## Review Focus

- **Aspect model present (normal runtime load):** fix must be a no-op; `dppBlockingDate`/destruction injection unchanged. → Task 3 test.
- **Aspect model absent (DB-task build):** no throw; aspects still injected on base entity. → Task 2 test.
- **Entity already carrying a blocking/destruction field:** the `else if` branches in `addBlockingAspectToBaseEntity` must not double-inject or crash. → Task 3 test.
- **`enhanceModel` called twice on same model (re-entrancy):** fallback load doesn't duplicate definitions or re-throw. → Task 2 test.
- **Fallback load failure (dpi.cds unresolvable):** backstop guard logs a clear warning and returns, rather than surfacing a raw TypeError. → Task 4 test.

---

### Task 1: Clone fork, establish baseline, locate the test harness

**Files:**
- No source changes. Produces: confirmed test command, confirmed repro.

- [ ] **Step 1:** Clone the team fork of `cap-js/data-privacy` into a fresh empty directory (outside tutorials-ims); `git checkout main`, `git pull`. Record the current HEAD SHA.
- [ ] **Step 2:** `npm install` in the clone.
- [ ] **Step 3:** Identify the test runner + command from `package.json` `scripts.test` and the test dir layout. Record the exact command (e.g. `npm test`) and how to run a single test file.
- [ ] **Step 4:** Run the existing suite once. Expected: GREEN (establishes baseline before any change). Record result.
- [ ] **Step 5:** Confirm the crash exists on this version: find or write a minimal reproduction via the suite's existing fixtures (a model with a `@PersonalData.EntitySemantics: 'DataSubjectDetails'` entity, enhanced without the plugin index model loaded). If no existing fixture triggers it, note that Task 2 creates one. Record whether HEAD reproduces the `exposeEntity.js` TypeError.

---

### Task 2: Failing regression test for the absent-aspect-model case

**Files:**
- Test: new test in the plugin's test dir (exact path from Task 1), e.g. `test/retention-dbtask-build.test.js`

**Interfaces:**
- Consumes: `enhanceModel` from `lib/csn-enhancements/index.js` (default export, `(csn) => csn`), and the CSN-building helpers the existing tests already use.
- Produces: regression test `enhances a DataSubjectDetails entity without the plugin aspect model loaded, without throwing`.

- [ ] **Step 1: Write the failing test.** Build a minimal CSN containing one `DataSubjectDetails` base entity (no query/projection) annotated for personal data, with `sap.ilm.blocking`/`sap.ilm.destruction` **absent** from `definitions`. Call `enhanceModel(csn)`. Assert: (a) it does not throw; (b) afterwards the base entity's `elements` contains the blocking date field (`dppBlockingDate`) and the destruction fields. Add a second assertion: calling `enhanceModel` twice is idempotent (no throw, no duplicate defs).
- [ ] **Step 2: Run it, verify it FAILS** with the `exposeEntity.js:26` TypeError (or injection-missing assertion). Record the failure.

---

### Task 3: Guard-rail test for the model-present (no-regression) case

**Files:**
- Test: same file or a sibling in the plugin test dir.

**Interfaces:**
- Consumes: `enhanceModel`.
- Produces: tests `injects aspects normally when the model is loaded` and `does not double-inject when the entity already has a blocking/destruction field`.

- [ ] **Step 1: Write the test.** Build a CSN that DOES include `sap.ilm.blocking`/`destruction` (mirroring a normal runtime load). Enhance; assert aspects injected exactly once and no change vs. current behavior. Add a case where the base entity already has `dppBlockingDate` → assert the `else if` path runs without error and doesn't duplicate.
- [ ] **Step 2: Run it against unmodified source, verify it PASSES** (this pins current correct behavior before the fix). Record result.

---

### Task 4: Implement approach C + backstop A

**Files:**
- Modify: `lib/csn-enhancements/index.js` (before the per-entity loop, ~line 42) — ensure `sap.ilm` aspect defs present.
- Modify: `lib/csn-enhancements/retention/exposeEntity.js` (`addBlockingAspectToBaseEntity`, line 24-41) — defensive guard.
- Test: a backstop test for the unresolvable-model case (same test dir).

**Interfaces:**
- Consumes: `cds` compiler API (`cds.compile` / `cds.load`), the plugin package root (resolve `db/dpi.cds` relative to the package).
- Produces: a module-private helper that returns/merges the `sap.ilm.*` aspect definitions into a given CSN; `addBlockingAspectToBaseEntity` tolerant of a still-missing def.

- [ ] **Step 1 (backstop test, failing):** Write a test that runs `enhanceModel` on the absent-model CSN but with the fallback load forced to fail (e.g. stub the resolver to throw). Assert: no raw TypeError escapes; a warning is logged via the plugin LOG; `enhanceModel` returns. Run it, verify it FAILS currently.
- [ ] **Step 2:** In `lib/csn-enhancements/index.js`, before the exposure loop, add logic: if `inferredCSN.definitions["sap.ilm.blocking"]` or `["sap.ilm.destruction"]` is absent, resolve the plugin's own `db/dpi.cds`, compile it to CSN, and merge the needed `sap.ilm.*` aspect/type definitions into `inferredCSN.definitions`. Copy the **narrowest** set that satisfies the base-entity path — start with `sap.ilm.blocking` + `sap.ilm.destruction`; add a `sap.ilm` type only if a test proves the exposure path reads it. Guard so it runs at most once and never imports `sap.ilm.RetentionService`.
- [ ] **Step 3:** In `exposeEntity.js:addBlockingAspectToBaseEntity`, add a guard: if `m.definitions["sap.ilm.blocking"]` is still undefined, `LOG.warn(...)` a clear message and `return` without throwing.
- [ ] **Step 4:** Run Tasks 2, 3, and Step-1 backstop tests. Expected: all PASS.
- [ ] **Step 5:** Run the FULL existing plugin suite. Expected: GREEN (no regressions). If any fail, fix before proceeding — do not weaken existing tests.
- [ ] **Step 6: Commit** in the fork with a message matching repo convention (e.g. `fix(retention): ensure sap.ilm aspect model present during DB-task build (#<upstream-bug>)`).

---

### Task 5: End-to-end repro verification against our model

**Files:** none in the fork.

- [ ] **Step 1:** In the tutorials-ims eval worktree, `npm install <path-to-fork-clone>` (or `npm link`) to use the patched plugin.
- [ ] **Step 2:** Run `npx cds build --production` via `scripts/quiet-run.sh`. Expected: completes WITHOUT the `exposeEntity.js` crash. Record exit code.
- [ ] **Step 3:** Revert the local link/install so the eval worktree returns to no-data-privacy state (the eval branch must stay dependency-free per the eval doc). Confirm `git status` clean except intended docs.

---

### Task 6: Open the upstream PR

**Files:** none (GitHub).

- [ ] **Step 1:** Push the fork branch to the team fork remote.
- [ ] **Step 2:** `gh pr create` against `cap-js/data-privacy:main`. Body: root cause (with `exposeEntity.js:26` + `cds.on("loaded")` explanation), the fix (approach C + backstop), the regression test, link to the existing upstream bug, and the before/after `cds build` repro. Mark ready (not draft) since tests pass — unless the team prefers draft.
- [ ] **Step 3:** Report the PR URL.

---

## Self-Review notes

- **Spec coverage:** C (ensure aspects loaded) → Task 4 Step 2; backstop A → Task 4 Step 3; regression test → Task 2; no-regression → Task 3; repro gone → Task 5; PR → Task 6. Blocker 2 explicitly out of scope (spec non-goal). Covered.
- **Open detail from spec** (exact def set to inject) is deliberately left as a test-driven decision in Task 4 Step 2 — narrowest set that passes — not a TBD: the implementer writes one reasonable thing (start with blocking+destruction, widen only if a test fails).
- **Re-entrancy / already-has-field / fallback-failure** all have owning tests (Tasks 2, 3, 4).
- **Proportion:** plan is longer than the ~1-line code change because the risk is in *not* regressing the model-present path and in matching an unfamiliar upstream repo's conventions — the tasks are mostly verification, not code.
