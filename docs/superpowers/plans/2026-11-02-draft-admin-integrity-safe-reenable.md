# draft_admin_integrity Safe Re-enable (Prove, Keep OFF) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `cds.fiori.draft_admin_integrity` provably safe to re-enable later — by making the cascade FK deployable and adding the orphan gate test — without turning the flag on now.

**Architecture:** The build emits 46 `AdminService.*_drafts.hdbtable` files carrying the `DraftAdministrativeData_DraftUUID` FK column but no `ON DELETE CASCADE` clause (the #2909 root cause). A build-time patch (extracted into a committed `.cjs`, wired into the MTA `before-all` after `cds build`) appends the cascade FK to each generated draft `.hdbtable` in the prod `gen/db` tree. A flag-agnostic Vitest gate proves Mission draftEdit→discard leaves zero child draft rows on SQLite. A runbook documents the deploy-then-flip order. The `package.json` flag stays `false`.

**Tech Stack:** SAP CAP (`@sap/cds` 10.2.2, Node), SAP HANA HDI (`.hdbtable`), MTA (`.deploy/mta.yaml`), Vitest, SQLite (unit).

**Spec:** `docs/superpowers/specs/2026-11-02-draft-admin-integrity-safe-reenable-design.md`

## Global Constraints

- `cds.fiori.draft_admin_integrity` stays `false` in committed `package.json` (both the base `cds.fiori` block at line ~461 and the `[development]` block at line ~486). No task flips it.
- No deploy to any environment is performed by this plan.
- Branch is `worktree-draft-integrity-constraints-2993`, based on `origin/DEV`. PR targets `DEV`, never `main`.
- `npm test` (in-memory SQLite) must stay green; the gate test is additive.
- Constraint patch applies to the **prod `gen/db` tree only** — QA's db build excludes `AdminService` and emits 0 draft tables.
- Cascade FK form, per table: `FOREIGN KEY (DraftAdministrativeData_DraftUUID) REFERENCES "DRAFT_DRAFTADMINISTRATIVEDATA"("DRAFTUUID") ON DELETE CASCADE` — authored so HANA deploys it `NOT VALIDATED` (skips existing-data check; no pre-clean needed).
- Draft table list is derived programmatically from the generated `*_drafts.hdbtable` files — never hand-maintained (must not drift from the preflight's live `SYS.TABLE_COLUMNS` count).

## Review Focus

- **Zero draft tables found** (glob matches nothing because build layout changed): patch must `die(1)` with a clear message, not silently patch nothing and let a future flip ship an un-cascaded DB → covered in Task 1.
- **Already-patched `.hdbtable`** (re-run / idempotency): appending the FK a second time must be a no-op, not a duplicate-constraint DDL error → covered in Task 1.
- **A draft table that lacks the FK column** (not all `*_drafts` necessarily carry it): patch must skip tables without `DraftAdministrativeData_DraftUUID`, not emit a FK referencing a missing column → covered in Task 1.
- **Discard of a Mission with NO child items** (empty composition): gate test must still pass (zero in, zero orphaned), not assume children exist → covered in Task 2.
- **Flag-on behavior on SQLite** (future flip): gate test asserts via the `.drafts` accessor so it is correct whether deletion came from app-level reconcile or DB cascade → covered in Task 2.

---

### Task 1: Build-time cascade-FK patch for generated draft `.hdbtable` files

**Files:**
- Create: `scripts/patch-draft-cascade-constraints.cjs`
- Create: `test/unit/patch-draft-cascade-constraints.test.js`
- Modify: `.deploy/mta.yaml` (the `before-all` builder, after the `cds build --production` line ~52, in the same shell sequence as the existing `.hdiconfig` patch line ~53)

**Interfaces:**
- Consumes: generated `gen/db/src/gen/AdminService.*_drafts.hdbtable` files (produced by `npx cds build --production`, already run earlier in `before-all`).
- Produces: `patchDraftCascadeConstraints(genDir) -> { patched: string[], skipped: string[] }` exported from the `.cjs`; appends the cascade FK to each draft `.hdbtable` under `genDir` that has the FK column and isn't already patched. Throws if `genDir` contains zero `*_drafts.hdbtable` files.

- [ ] **Step 1: Write the failing unit test**

In `test/unit/patch-draft-cascade-constraints.test.js`, using Vitest + a tmp dir fixture (no CAP boot):
```js
// seed tmp genDir with 2 fixture .hdbtable files:
//   AdminService.Missions_drafts.hdbtable  — has DraftAdministrativeData_DraftUUID column
//   AdminService.NoFk_drafts.hdbtable      — NO such column
// and assert:
test('appends ON DELETE CASCADE FK to draft tables that carry the FK column', () => {
  const r = patchDraftCascadeConstraints(tmp);
  const sql = fs.readFileSync(path.join(tmp, 'AdminService.Missions_drafts.hdbtable'), 'utf8');
  expect(sql).toMatch(/FOREIGN KEY\s*\("?DraftAdministrativeData_DraftUUID"?\)\s*REFERENCES\s+"DRAFT_DRAFTADMINISTRATIVEDATA"\("DRAFTUUID"\)\s+ON DELETE CASCADE/i);
  expect(r.patched).toContain('AdminService.Missions_drafts.hdbtable');
});
test('skips draft tables without the FK column', () => {
  patchDraftCascadeConstraints(tmp);
  const sql = fs.readFileSync(path.join(tmp, 'AdminService.NoFk_drafts.hdbtable'), 'utf8');
  expect(sql).not.toMatch(/ON DELETE CASCADE/i);
});
test('is idempotent — second run adds no duplicate FK', () => {
  patchDraftCascadeConstraints(tmp);
  const first = fs.readFileSync(path.join(tmp, 'AdminService.Missions_drafts.hdbtable'), 'utf8');
  patchDraftCascadeConstraints(tmp);
  expect(fs.readFileSync(path.join(tmp, 'AdminService.Missions_drafts.hdbtable'), 'utf8')).toBe(first);
});
test('throws when no draft tables are found', () => {
  expect(() => patchDraftCascadeConstraints(emptyTmp)).toThrow(/no .*_drafts\.hdbtable/i);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/patch-draft-cascade-constraints.test.js`
Expected: FAIL (module/function not found).

- [ ] **Step 3: Implement `patchDraftCascadeConstraints(genDir)` in `scripts/patch-draft-cascade-constraints.cjs`**

Enumerate `*_drafts.hdbtable` in `genDir` (fs.readdirSync); throw if none. For each file: read; skip if no `DraftAdministrativeData_DraftUUID` token or if `ON DELETE CASCADE` already present (idempotency); otherwise inject the FK clause as the last element inside the `COLUMN TABLE (...)` body (insert a `,` after the current last column/`PRIMARY KEY(...)` entry, before the closing `)`). Also export a CLI entry (`if (require.main === module)`) that reads genDir from `process.argv[2]` default `gen/db/src/gen`, calls the function, logs `patched N / skipped M`, and `process.exit(1)` on throw.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/unit/patch-draft-cascade-constraints.test.js`
Expected: PASS (all 4).

- [ ] **Step 5: Wire into MTA `before-all`**

In `.deploy/mta.yaml`, add a command after the `cds build --production` step and alongside the existing `.hdiconfig` patch (same `before-all` builder): `bash -c "cd .. && node scripts/patch-draft-cascade-constraints.cjs gen/db/src/gen"`. Prod tree only — do NOT add `gen/db-qa/...`.

- [ ] **Step 6: Verify the patch runs against a real build (prod tree)**

Run: `rm -rf gen && npx cds build --production && node scripts/patch-draft-cascade-constraints.cjs gen/db/src/gen && grep -l "ON DELETE CASCADE" gen/db/src/gen/AdminService.Missions_drafts.hdbtable`
Expected: prints the Missions_drafts path (cascade present); CLI logs `patched 46 / skipped 0` (or patched = live FK-bearing count). Then `rm -rf gen` (throwaway).

- [ ] **Step 7: Commit**

```bash
git add scripts/patch-draft-cascade-constraints.cjs test/unit/patch-draft-cascade-constraints.test.js .deploy/mta.yaml
git commit -m "feat(db): build-time ON DELETE CASCADE patch for draft tables, not yet enabled (#2993)"
```

---

### Task 2: Flag-agnostic orphan gate test (Mission draftEdit → discard)

**Files:**
- Create: `test/admin-drafts-cascade-gate.test.js`

**Interfaces:**
- Consumes: CAP draft HTTP actions on `AdminService` via `cds.test('serve','--project','.','--in-memory')` + `adminAuth`, exactly as `test/admin-drafts-discard-reconcile.test.js`. Child-draft rows read via the `.drafts` accessor (e.g. `cds.entities(NS).CompletionPathItems.drafts`), filtered by `DraftAdministrativeData_DraftUUID`.
- Produces: nothing consumed downstream; this is the re-enable gate.

- [ ] **Step 1: Write the failing test**

In `test/admin-drafts-cascade-gate.test.js`, mirroring the harness/auth/seed style of `admin-drafts-discard-reconcile.test.js`:
```js
// Seed a Mission with one CompletionPath + one CompletionPathItem (active).
// draftEdit the Mission; capture the draft's DraftAdministrativeData_DraftUUID
// from the Missions.drafts row. Then DELETE the draft (discard).
it('leaves zero child draft rows after Mission draftEdit→discard (flag-agnostic gate)', async () => {
  // ... seed, draftEdit, read draftUUID ...
  const { CompletionPathItems } = cds.entities(NS);
  const before = await db.run(SELECT.from(CompletionPathItems.drafts)
    .where({ DraftAdministrativeData_DraftUUID: draftUUID }));
  expect(before.length).toBeGreaterThanOrEqual(0); // children may be 0..n
  // ... discard ...
  const after = await db.run(SELECT.from(CompletionPathItems.drafts)
    .where({ DraftAdministrativeData_DraftUUID: draftUUID }));
  expect(after).toHaveLength(0);
});
// Empty-composition case:
it('discard of a Mission draft with no child items leaves zero orphans', async () => { /* seed Mission only, draftEdit, discard, assert 0 */ });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/admin-drafts-cascade-gate.test.js`
Expected: FAIL (file new / assertions not yet satisfied, or compile error until seed written).

- [ ] **Step 3: Implement the test body**

Fill in seed (Users/Missions/CompletionPaths/CompletionPathItems with unique `__TEST__`/high-legacyId values to avoid autotest collisions, per `admin-drafts-discard-reconcile.test.js`), the draftEdit POST to `/admin/Missions(ID=...,IsActiveEntity=true)/AdminService.draftEdit`, read the draft row's `DraftAdministrativeData_DraftUUID`, and the discard DELETE to `/admin/Missions(ID=...,IsActiveEntity=false)`. No production code changes — this test documents current (flag-off) behavior.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/admin-drafts-cascade-gate.test.js`
Expected: PASS (both cases). Then `npm test` to confirm no regression.

- [ ] **Step 5: Commit**

```bash
git add test/admin-drafts-cascade-gate.test.js
git commit -m "test(drafts): flag-agnostic gate — Mission discard leaves zero child draft orphans (#2993)"
```

---

### Task 3: Re-enable runbook

**Files:**
- Create: `docs/developers/operations/draft-integrity-reenable.md`
- Modify: `CLAUDE.md` (the "Optimized draft deletion" gotcha line — add a pointer to the new runbook)

**Interfaces:** none (documentation).

- [ ] **Step 1: Write the runbook**

Document the exact order, encoding the spec guardrails: (1) deploy with the Task-1 patch active so constraints land `NOT VALIDATED` while the flag is still `false` (constraints inert); (2) confirm `srv/lib/draft-integrity-preflight.js` logs `verified (N/N)` on the target env (not a WARN); (3) run `scripts/cleanup-draft-orphans.cjs --dry-run` → expect 0 orphans; (4) run the Task-2 gate test green; (5) only then flip `draft_admin_integrity` to `true` in `package.json` (both blocks), full `npm run build:all` + redeploy; (6) smoke a Mission draftEdit→discard. Note: the `CDS_*` env override does NOT work on the deployed build — the baked `package.json` value is authoritative. DEV before PROD.

- [ ] **Step 2: Add CLAUDE.md pointer**

Append ` Re-enable runbook: docs/developers/operations/draft-integrity-reenable.md` to the existing "Optimized draft deletion" gotcha bullet.

- [ ] **Step 3: Commit**

```bash
git add docs/developers/operations/draft-integrity-reenable.md CLAUDE.md
git commit -m "docs(ops): runbook for safely re-enabling draft_admin_integrity (#2993)"
```

---

## Self-Review

**Spec coverage:** Goal 1 (constraints) → Task 1. Goal 2 (gate test) → Task 2. Goal 3 (runbook) → Task 3. Non-goals (flip flag, deploy, orphan sweep) respected — no task does them. QA-out-of-scope finding → Task 1 Step 5 (prod tree only). Preflight already fixed (#2992) — not re-implemented. All covered.

**Step scan:** Each step yields one checkable action. Task 1 bodies describe only the FK-injection algorithm (not signature-determined); Task 2 leaves the body to the implementer via the harness pattern. No "TBD"/"handle edge cases" lines.

**Type consistency:** `patchDraftCascadeConstraints(genDir)` and its return shape used consistently across Task 1 steps and the MTA wiring. FK clause string identical in Global Constraints, Task 1 test, and Task 3.

**Review Focus:** 5 items, each pinned to a task (empty-tables→T1, idempotency→T1, missing-FK-column→T1, empty-composition→T2, flag-on-accessor→T2).

**Proportion:** Plan is longer than the ~2-screen spec but dominated by exact test assertions and the FK string, not program transcription — acceptable for a TDD plan with 3 tasks.
