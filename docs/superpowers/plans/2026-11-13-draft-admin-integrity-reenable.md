# Draft Admin Integrity Re-enable Implementation Plan (#2993)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver CAP 10.2's Optimized Draft Deletion end-to-end — native `NOT VALIDATED` cascade constraints on all 46 `*_drafts` tables flowing through our `.hdbmigrationtable` build, `draft_admin_integrity` + `draft_orphan_cleanup` + `deleteStrategy: dad` re-enabled, with a `dad` handler-firing audit proven on real HANA.

**Architecture:** CAP's compiler already emits the 46 `DraftAdministrativeData_DraftUUID → DRAFT_DraftAdministrativeData(DraftUUID)` cascade constraints (`NOT VALIDATED`) under a full `to.hdi` compile. The one unknown is why they do not surface through our `to.hana`/`.hdbmigrationtable` delta path; Task 1 diagnoses and fixes that. Everything after is config flips gated on real-HANA verification, in the order: constraints-deployed → preflight-green → flag-on → handler-audit.

**Tech Stack:** SAP CAP (`@sap/cds@10.2.2`, `@sap/cds-dk@10.2.0`, compiler 7.2.1), SAP HANA Cloud (HDI), MTA/mbt deploy, Vitest, Node 22.

**Spec:** `docs/superpowers/specs/2026-11-13-draft-admin-integrity-reenable-design.md`

## Global Constraints

- Branch off fresh `origin/DEV`; PR targets **DEV**, never main. Never deploy a feature branch.
- `CDS_*` env overrides do NOT reach these flags — only baked `package.json` / `.cdsrc.json` values count.
- Do NOT enable `cds.features.assert_integrity` (model-wide FKs — explicit non-goal).
- Do NOT hand-author `.hdbconstraint` files or reintroduce `scripts/patch-draft-cascade-constraints.cjs` (rejected approach B; reverted in #3003). If native output cannot flow, **stop and escalate** — do not hand-roll.
- Authoritative count: **46** draft cascade constraints, `ON DELETE CASCADE`, `NOT VALIDATED`, one per `*_drafts` table.
- Flags stay OFF in `package.json` until constraints are verified present on the target HANA schema (the #2909 anti-pattern is flag-on-without-constraints).
- Real draft shadow tables are `ADMINSERVICE_*_DRAFTS`; the draft admin parent is `DRAFT_DraftAdministrativeData`.
- Deploy hygiene: `cf target` before push; pause sap-devs scheduler during long deploys; clean Hugo tree (#2886).

## Review Focus

- **Pre-existing orphans at deploy time** — constraints are `NOT VALIDATED`, so an orphan-laden schema must still deploy without error (covered by Task 3's deploy + Task 2's build asserting `NOT VALIDATED`).
- **`dad` bypassing `after('DISCARD')` reconcile** — rollup correctness could silently regress; the SQLite gate test cannot see it (Task 5 HANA-level audit).
- **`dad` bypassing `after('DELETE')` child reconcile on active-entity delete** — same class, delete path rather than discard (Task 5).
- **Preflight reading flag-on but constraints absent** — must WARN (not pass) so a bad deploy is caught before serving (Task 4).
- **Non-mission draft entities (Tutorials, Groups, Steps)** — the cascade must cover all 46 tables, not just Missions; a partial set leaves other entities corruptible (Task 2 count assertion = 46).

---

### Task 1: Make native draft cascade constraints flow through the production build

**Files:**
- Investigate (read-only): `node_modules/@sap/cds-dk/lib/build/plugins/hana/{index.js,2migration.js}`, `node_modules/@sap/cds-dk/node_modules/@sap/cds/lib/compile/cdsc.js`, `node_modules/@sap/cds-dk/node_modules/@sap/cds-compiler/lib/transform/forRelationalDB.js`
- Likely modify (one of): `.cdsrc.json` (journaling/compile config), `package.json` (dependency bump), or `patches/` (minimal `patch-package` shim) — determined by the diagnosis
- No test file (exit criterion is a build-artifact assertion, Step 4)

**Interfaces:**
- Produces: a `cds build --production` that writes 46 `AdminService.*_drafts_DraftAdministrativeData.hdbconstraint` files into `gen/db/src/gen/`, each `ON DELETE CASCADE … NOT VALIDATED`. Tasks 2–3 consume this build output.

- [ ] **Step 1: Reproduce the gap.** Set `cds.fiori.draft_admin_integrity: true` in `package.json` (both blocks), run `CDS_ENV=production npx cds build --production`, confirm `find gen -name '*DraftAdministrativeData*.hdbconstraint' | wc -l` = 0. This is the known failing baseline.

- [ ] **Step 2: Diagnose which path drops the constraints.** The generator (`forRelationalDB.js:348`) runs only if `sqlDialect !== 'plain'` AND `options.draft_admin_integrity === true`. The full `to.hdi` compile emits all 46; our build uses `.hdbmigrationtable` via `cds.compile.to.hana` → `to.hdi.migration` (3-arg delta, `cdsc.js:154` option-flatten). Instrument the option object reaching the compiler in the migration path (temporary logging in a tmp-dir script that loads cds-dk's compiler — NOT by editing node_modules; that is blocked). Rank-ordered suspects: (a) `@cds.persistence.journal` interaction, (b) option-flatten at `cdsc.js:154`, (c) cds-dk 10.2.0 / compiler 7.2.1 gap needing a version bump or `patch-package` shim.

- [ ] **Step 3: Apply the narrowest fix that satisfies Step 4.** Config change (a/b) preferred; dependency bump or `patch-package` shim (c) only if config cannot. If a cds-dk/cds bump is used, re-verify the committed `cds-caching+2.1.0.patch` still applies (CLAUDE.md gotcha) and run `npm test -- test/admin-drafts-cascade-gate.test.js`. **If none of (a)–(c) yields the exit criterion without hand-rolling, STOP and escalate to the user — do not proceed.**

- [ ] **Step 4: Verify the exit criterion.**
Run: `CDS_ENV=production npx cds build --production && find gen -name '*DraftAdministrativeData*.hdbconstraint' | wc -l`
Expected: `46`. Then confirm one file contains `ON DELETE CASCADE` and `NOT VALIDATED` (not `VALIDATED`/`ENFORCED`-only):
Run: `grep -l 'NOT VALIDATED' gen/db/src/gen/AdminService.Missions_drafts_DraftAdministrativeData.hdbconstraint`
Expected: the file path (match found).

- [ ] **Step 5: Revert the `draft_admin_integrity` flag back to `false`** in both `package.json` blocks (the build change from Step 3 stays; the flag flip was only to prove the build). Confirm `grep -c '"draft_admin_integrity": false' package.json` = 2.

- [ ] **Step 6: Commit** (build-config change only, flags still off)

```bash
git add .cdsrc.json package.json patches/ 2>/dev/null
git commit -m "build(#2993): surface native draft cascade constraints in hdbmigrationtable build"
```

---

### Task 2: Build-artifact test asserting the 46 NOT VALIDATED cascades

**Files:**
- Create: `test/draft-cascade-build.test.js`
- Depends on Task 1's build output

**Interfaces:**
- Consumes: Task 1's `cds build` producing 46 draft `.hdbconstraint`s.
- Produces: a CI-runnable guard that the constraints exist and are `NOT VALIDATED` — prevents silent regression of Task 1.

- [ ] **Step 1: Write the failing test.** A Vitest test that runs (or reads a committed fixture of) the production build's draft constraint files and asserts count and shape. Because a full `cds build` in a unit test is slow, compile in-process via cds-dk's compiler with `draft_admin_integrity: true` + `sqlDialect: 'hana'` (pattern proven in the spike probe) and assert on the emitted `.hdbconstraint` strings.

```javascript
import { describe, it, expect } from 'vitest';
// loads cds-dk's compiler, compiles ['db','srv'], collects *.hdbconstraint
describe('#2993 native draft cascade constraints', () => {
  it('emits 46 DraftAdministrativeData ON DELETE CASCADE constraints', () => {
    const draftCascades = compileAndCollectDraftCascades(); // array of constraint strings
    expect(draftCascades.length).toBe(46);
  });
  it('emits them NOT VALIDATED (deploy-safe over existing orphans)', () => {
    const draftCascades = compileAndCollectDraftCascades();
    for (const c of draftCascades) {
      expect(c).toMatch(/ON DELETE CASCADE/);
      expect(c).toMatch(/NOT VALIDATED/);
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails** if Task 1 is incomplete.
Run: `npm test -- test/draft-cascade-build.test.js`
Expected: PASS once Task 1 landed (if run before Task 1's fix, count ≠ 46 → FAIL).

- [ ] **Step 3: Implement the `compileAndCollectDraftCascades()` helper** in the test file — resolve cds-dk's `@sap/cds-compiler`, `cds.load(['db','srv'])`, `compiler.to.hdi(csn, { draft_admin_integrity: true, sqlDialect: 'hana' })`, filter keys ending `.hdbconstraint` whose content matches `DraftAdministrativeData` + `CASCADE`.

- [ ] **Step 4: Run to verify it passes.**
Run: `npm test -- test/draft-cascade-build.test.js`
Expected: PASS (both assertions).

- [ ] **Step 5: Commit**

```bash
git add test/draft-cascade-build.test.js
git commit -m "test(#2993): assert 46 NOT VALIDATED draft cascade constraints emit"
```

---

### Task 3: Deploy constraints to DEV HANA (flags still OFF) — REQUIRES LIVE ENV

**Files:**
- No source change; this is a deploy + artifact-verification task. Requires `cf login` to DEV.

**Interfaces:**
- Consumes: Task 1 build output. Produces: 46 constraints present on DEV HANA schema; precondition for Task 4.

- [ ] **Step 1: Confirm clean baseline (informational).** `npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --dry-run` → record orphan count. (Not a gate — constraints are `NOT VALIDATED` — but informs Task 5 expectations.)

- [ ] **Step 2: Full build + deploy to DEV** per CLAUDE.md canonical local deploy (`npm run build:all` then `mbt build` + `cf deploy … -e ../deploy/dev.mtaext -f`), wrapped in `scripts/quiet-run.sh`. `cf target` first; confirm DEV space.

- [ ] **Step 3: Verify constraints landed in the mtar AND the schema.** Crack the mtar (as Step 3.5 admin-bundle check does) to confirm the 46 `.hdbconstraint`s shipped. Then on DEV HANA via `cds bind`: query `SYS.REFERENTIAL_CONSTRAINTS` for FKs on `ADMINSERVICE_*_DRAFTS` referencing `DRAFT_DraftAdministrativeData`.
Expected: 46 constraints present, `IS_VALIDATED = 'FALSE'`.

- [ ] **Step 4: Confirm no deploy error over existing orphans** (proves `NOT VALIDATED` behavior). If Step 1 found orphans, the successful deploy is the evidence. Record in the PR.

---

### Task 4: Verify preflight reports verified (46/46) on DEV — REQUIRES LIVE ENV

**Files:**
- Read: `srv/lib/draft-integrity-preflight.js` (existing `checkDraftCascadeConstraints`, `wireDraftIntegrityPreflight`)
- Modify only if the preflight's discovery misses the real count

**Interfaces:**
- Consumes: Task 3's deployed constraints. Produces: green preflight — the gate that authorizes Task 5's flag flip.

- [ ] **Step 1: Read DEV CAP startup logs** (`cf logs tutorials-srv --recent`) after Task 3's deploy. The flag is still OFF, so the preflight may report the informational "flag off" path — confirm the constraint-discovery query itself returns 46 (add a one-off diagnostic log or query `SYS.TABLE_COLUMNS`/`SYS.REFERENTIAL_CONSTRAINTS` directly via `cds bind`).

- [ ] **Step 2: If discovery count ≠ 46, fix the preflight discovery** (the stale 27-entry `DRAFT_TABLES` list is deprecated; discovery must come from the live catalog). Add/adjust so it reports `verified (46/46)` once the flag is on.

- [ ] **Step 3: Commit any preflight fix**

```bash
git add srv/lib/draft-integrity-preflight.js
git commit -m "fix(#2993): preflight discovers all 46 draft cascade tables"
```

---

### Task 5: Audit `dad` handler-firing + HANA-level reconcile test — REQUIRES LIVE ENV

**Files:**
- Create: `test/admin-drafts-dad-reconcile.hybrid.test.js` (HANA-bound, via `cds bind --exec`)
- Read: `test/admin-drafts-discard-reconcile.test.js` (existing SQLite reconcile test to mirror), `srv/lib/completion-reconcile.js`, `srv/lib/pipeline-log-reconciler.js`, `srv/lib/topic-cluster-reconcile.js`

**Interfaces:**
- Consumes: Task 4 green preflight. Produces: proof that `after('DISCARD')`/`after('DELETE')` reconcile side effects still fire under `dad`. PROD-blocking gate.

- [ ] **Step 1: Write the failing HANA-level test.** Mirror `admin-drafts-discard-reconcile.test.js`'s seed/assert strategy (seed a user whose rollup heals on reconcile), but run against real HANA via `cds bind --exec` with `deleteStrategy: dad` active. Assert the reconcile side effect (user rollup heals to COMPLETED after a Mission draft discard) still occurs.

```javascript
// test/admin-drafts-dad-reconcile.hybrid.test.js — run via npm run test:hybrid
it('fires MISSION reconcile when a Mission draft is discarded under dad', async () => {
  // seed active mission + user at COMPLETED-eligible state
  // draftEdit then DISCARD the mission draft
  // assert reconcile ran: user rollup === 'COMPLETED'
});
```

- [ ] **Step 2: Run against HANA with dad temporarily on** (via `cds bind --exec` + a scoped env/config enabling `dad` for the test run).
Expected: establishes whether reconcile fires or is bypassed. If bypassed → the test FAILS, exposing the regression.

- [ ] **Step 3: If `dad` bypasses the hooks, add an explicit reconcile trigger** on the draft-delete path that `dad` preserves (e.g. an `after('DELETE')` on `DRAFT.DraftAdministrativeData` or the service-level discard handler), so reconcile fires regardless of strategy. Keep the pre-10.2 hooks for the flat fallback.

- [ ] **Step 4: Run to verify it passes.**
Run: `npm run test:hybrid -- test/admin-drafts-dad-reconcile.hybrid.test.js`
Expected: PASS (reconcile fires under dad).

- [ ] **Step 5: Commit**

```bash
git add test/admin-drafts-dad-reconcile.hybrid.test.js srv/
git commit -m "test(#2993): prove dad draft discard still fires rollup reconcile on HANA"
```

---

### Task 6: Flip the flags + deleteStrategy, redeploy DEV, gate green — REQUIRES LIVE ENV

**Files:**
- Modify: `package.json` (both `cds.fiori` blocks) — set `draft_admin_integrity: true`, add `draft_orphan_cleanup: true`; set `cds.drafts.deleteStrategy: dad` (placement following existing fiori-config convention)

**Interfaces:**
- Consumes: Tasks 3 (constraints deployed), 4 (preflight green), 5 (hooks proven). This is the only task that turns on runtime behavior.

- [ ] **Step 1: Set the flags.** `draft_admin_integrity: true` + `draft_orphan_cleanup: true` in both `package.json` fiori blocks; add `deleteStrategy: dad`. Confirm `grep -c '"draft_admin_integrity": true' package.json` = 2.

- [ ] **Step 2: Run the SQLite gate test** (flag-agnostic, must stay green).
Run: `npm test -- test/admin-drafts-cascade-gate.test.js`
Expected: PASS (zero child draft orphans after Mission draftEdit→discard).

- [ ] **Step 3: Full build + deploy to DEV** (`scripts/quiet-run.sh`, `cf target` first).

- [ ] **Step 4: Verify preflight now logs verified (46/46)** (not WARN) in DEV startup logs.
Run: `cf logs tutorials-srv --recent | grep draft-integrity-preflight`
Expected: `verified (46/46)`.

- [ ] **Step 5: DEV smoke.** Via `cds bind`, perform a real Mission draftEdit→discard, then query `ADMINSERVICE_COMPLETIONPATHITEMS_DRAFTS` for rows with the discarded `DraftAdministrativeData_DraftUUID`.
Expected: zero orphaned child draft rows on real HANA.

- [ ] **Step 6: Commit**

```bash
git add package.json
git commit -m "feat(#2993): re-enable draft_admin_integrity + orphan_cleanup + dad strategy"
```

---

### Task 7: Rewrite runbook + correct CLAUDE.md gotcha

**Files:**
- Rewrite: `docs/developers/operations/draft-integrity-reenable.md`
- Modify: `CLAUDE.md` ("Optimized draft deletion" gotcha)

**Interfaces:**
- Consumes: the verified sequence from Tasks 1–6. Produces: docs matching reality.

- [ ] **Step 1: Rewrite `draft-integrity-reenable.md`.** Remove Steps 1–2's hand-rolled ENFORCED-FK / pre-sweep premise and all references to `scripts/patch-draft-cascade-constraints.cjs` (does not exist; reverted #3003). Document the native `NOT VALIDATED` path and the verified ordering: build-change → deploy constraints (flags off) → preflight green → flag flip → dad hook audit.

- [ ] **Step 2: Correct the CLAUDE.md gotcha.** State: constraints are CAP-native and `NOT VALIDATED`; the real blocker was the `to.hana`/`.hdbmigrationtable` build-format path (not HDI make-graph errors 8250014/8212001, not hand-authoring). Update the #2993 status line.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/operations/draft-integrity-reenable.md CLAUDE.md
git commit -m "docs(#2993): rewrite re-enable runbook for native NOT VALIDATED path"
```

---

## Notes on execution

Tasks 1, 2, 7 are workstation-local (no HANA). Tasks 3–6 **require a live DEV HANA + `cf login`** and cannot be verified locally — they are the honest ceiling of what can be done without the environment. Task 1 may **stop-and-escalate** if no non-hand-rolled fix satisfies its exit criterion. Task 5 may surface a real `dad` regression requiring a handler change (Step 3). Do not flip any flag (Task 6) until Tasks 3–5 are green on DEV.
