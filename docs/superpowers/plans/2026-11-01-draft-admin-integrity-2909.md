# CAP 10.2 Optimized Draft Deletion (`draft_admin_integrity`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Adopt CAP 10.2's optimized draft deletion (`cds.fiori.draft_admin_integrity: true`) safely — closing the one reconcile-correctness gap it introduces and shipping the DB-constraint migration in the correct order.

**Architecture:** Enabling `draft_admin_integrity: true` makes `cds build` generate `ON DELETE CASCADE` constraints on each draft table's `DraftAdministrativeData_DraftUUID` FK, and changes draft activation/root-cancellation to delete only the `DraftAdministrativeData` record — the DB cascades the child rows. That cascade bypasses CAP's per-row `before/after('DELETE')` handlers. In this project the only correctness-sensitive handlers are the `CompletionPathItems`/`GroupPathItems` FK-capture-and-reconcile pair in `AdminService` (`srv/admin-service.js:1197-1242`), which keep Mission/Group completion rollups consistent. The fix is **additive**: add root-level `DISCARD` handlers on `Missions.drafts`/`Groups.drafts` that fire the same reconcile — DISCARD fires at the draft root before the cascade, independent of per-child-row delete events. The existing child `before/after('DELETE')` handlers stay (they still fire for direct programmatic deletes, which the cascade does not touch). The flag + constraint deployment is sequenced as a DB migration: deploy constraints first, flip the serving flag after.

**Tech Stack:** CAP Node.js `@sap/cds` 10.2, `@cap-js/hana` (prod/hybrid), `@cap-js/sqlite` (dev/test), Fiori draft model, vitest (`cds.test('serve', ...)`), HANA Cloud.

**Spec:** https://cap.cloud.sap/docs/releases/2026/oct26#optimized-draft-deletion

## Global Constraints

- CAP Node.js only — the Java `cds.drafts.deleteStrategy` property does NOT apply; the Node.js lever is `cds.fiori.draft_admin_integrity` (+ companion `cds.fiori.draft_orphan_cleanup`)
- Node.js pinned 22.23.4; `@sap/cds` ^10.2.0 (already on DEV)
- Never write raw SQL — use `cds.ql` / CQL (the existing reconcile helpers already do)
- PR targets `DEV` (never `main`); open a PR, never direct-merge
- Reconcile is fire-and-forget in a detached `cds.tx` and MUST remain fail-open — a reconcile fault must never fail the user's draft operation (see `fireReconcile`, admin-service.js:1159-1165)
- Draft-enabled entities in scope are all in `AdminService`; only `Missions`/`Groups` (via composition children `CompletionPathItems`/`GroupPathItems`) carry reconcile risk — the other 17 draft entities have only cache-bust/snapshot `after('DELETE')` handlers (stale-cache at worst, not data loss)
- The constraint-generation + HANA deploy (Task 3) is a schema migration: constraints deploy FIRST (`NOT VALIDATED`, so existing orphans don't block), the serving flag flips AFTER. Confirm deploy scope + ordering with the maintainer before any PROD step — this plan delivers the code + DEV verification; PROD rollout is a separate authorized deploy.
- `srv-qa` cp-list audit: this plan touches only `srv/admin-service.js` (already a `srv-qa` dep's sibling, not a new `srv/lib/` import) — no new transitive `srv/lib/` dependency is introduced, so the `srv-qa` cp list does not change. Confirm during Task 1 that no new `./lib/*` import is added.

## Review Focus

- **Draft DISCARD bypasses reconcile (the whole point):** under `draft_admin_integrity: true`, discarding a Mission/Group draft that removed a `CompletionPathItems`/`GroupPathItems` child must still reconcile the parent rollup. Task 2's test must prove the DISCARD handler fires the reconcile even though the child `after('DELETE')` does not.
- **Direct programmatic delete still reconciles:** the existing child `before/after('DELETE')` handlers must keep working for non-draft-cascade deletes (e.g. `service.tx()` row deletes, active-entity edits). Task 2 must prove enabling the flag + adding DISCARD handlers did not break the existing CREATE/UPDATE/DELETE child reconcile path.
- **Reconcile stays fail-open:** a thrown error inside the new DISCARD handler must not reject the user's discard. Task 2 asserts the discard still returns success when reconcile internals throw.
- **DISCARD on a draft with no child items is a no-op, not a crash:** discarding a freshly-created Mission draft with zero CompletionPathItems must not throw (undefined FK → skip, matching the existing `legacyId == null` guard).
- **SQLite cascade-constraint parity:** enabling `draft_admin_integrity` generates FK constraints; the dev/test SQLite deploy must still boot. Task 1 must confirm `cds.test('serve', '--in-memory')` starts clean with the flag on (SQLite supports the constraints, but verify no deploy error).

---

## Task 1: Enable the flag and confirm the app still boots (dev/test)

**Files:**
- Modify: `package.json` (`cds.fiori` section — create it)
- Test: `test/admin-drafts.test.js` (existing — used only as a boot smoke here)

**Interfaces:**
- Produces: `cds.fiori.draft_admin_integrity: true` in package.json; a confirmed-booting SQLite test harness that Task 2 builds its new tests on.

- [ ] **Step 1: Add the flag to `package.json`**

In the `cds` block, add a `fiori` section (it does not exist yet):

```json
"fiori": {
  "draft_admin_integrity": true
}
```

- [ ] **Step 2: Confirm no new `srv/lib/*` import is implied**

Run: `grep -n "require('./lib/\|from './lib/" srv/admin-service.js`
Expected: the only reconcile import is the pre-existing `./lib/completion-reconcile.js` (admin-service.js:68). No new lib dep → `srv-qa` cp list unchanged.

- [ ] **Step 3: Run the existing draft test as a boot smoke**

Run: `npx vitest run test/admin-drafts.test.js`
Expected: PASS — the SQLite in-memory deploy boots with the cascade constraints generated, and existing draft create/activate tests still pass. If the deploy errors on constraint generation, STOP and investigate (do not proceed to Task 2).

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "feat(cap): enable cds.fiori.draft_admin_integrity for optimized draft deletion"
```

---

## Task 2: Add root DISCARD reconcile handlers for Missions and Groups

**Files:**
- Modify: `srv/admin-service.js` (add handlers next to the existing SAVE reconcile hooks, after line 1276)
- Test: `test/admin-drafts-discard-reconcile.test.js` (new)

**Interfaces:**
- Consumes: `fireReconcile(kind, legacyId)` (admin-service.js:1159), `resolveGroupLegacy(groupId)` (:1175), `resolveMissionsNestingGroup(groupId)` (:1181), `reconcileEntityForUsers` (imported :68). These are all in scope inside the `init()` closure where the new handlers are registered.
- Produces: `this.after('DISCARD', 'Missions', onMissionDiscard)` and `this.after('DISCARD', 'Groups', onGroupDiscard)` — reconcile the parent rollup on draft discard.

**Behavior the handlers must implement.** On DISCARD of a draft root, the draft's child `CompletionPathItems`/`GroupPathItems` rows are about to be cascade-deleted; the reconcile needs the parent legacyId(s). On a Missions discard, resolve the Mission's own `legacyId` from the draft/active row and `fireReconcile('MISSION', legacyId)`. On a Groups discard, resolve the Group's `legacyId` → `fireReconcile('GROUP', legacyId)`, then `resolveMissionsNestingGroup(groupId)` → `fireReconcile('MISSION', mLegacy)` for each (mirroring `onGroupSave`, admin-service.js:1261-1273). Wrap in try/catch, fail-open. DISCARD refers to the active entity per CAP's event model; the handler reads the ID from `req.data?.ID ?? req.params?.[0]?.ID` and resolves legacyId via the existing resolvers.

- [ ] **Step 1: Write the failing test**

Create `test/admin-drafts-discard-reconcile.test.js`. Model the harness on `test/admin-drafts.test.js` (`cds.test('serve', '--project', '.', '--in-memory')`, `adminAuth`, a seeded Tag). Spy on the reconcile by stubbing `reconcileEntityForUsers` is not possible across the HTTP boundary; instead assert on observable effect: after discarding a Mission draft that had a CompletionPathItems child, the parent Mission's rollup records are reconciled. If asserting the rollup side effect is too heavy for a unit test, assert the handler path instead by spying on `cds.log('rollup')` or by registering a test-only `after('DISCARD','Missions')` probe. Write these three tests:

```js
it('fires MISSION reconcile when a Mission draft is discarded', async () => {
  // create Mission draft (POST /admin/Missions, lenient) → get ID
  // DELETE the draft: project.delete(`/admin/Missions(ID=${id},IsActiveEntity=false)`, adminAuth)
  // assert reconcile fired for the mission's legacyId (via probe/log spy)
});

it('DISCARD of an empty Mission draft does not throw', async () => {
  // create Mission draft with no CompletionPathItems, discard it
  // assert discard returns 204/200 and no error logged
});

it('Group draft discard reconciles the group and nesting missions', async () => {
  // create Group draft, discard, assert GROUP reconcile fired
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/admin-drafts-discard-reconcile.test.js`
Expected: FAIL — no DISCARD handler exists yet, so the reconcile probe/log is never hit.

- [ ] **Step 3: Implement `onMissionDiscard` and `onGroupDiscard` in `srv/admin-service.js`**

Add after line 1276 (right after `this.after('SAVE', 'Groups', onGroupSave)`). Reuse `fireReconcile`, `resolveGroupLegacy`, `resolveMissionsNestingGroup`, and the `cds.entities('com.sap.developers.ims')` access pattern. Register with `this.after('DISCARD', 'Missions', onMissionDiscard)` and `this.after('DISCARD', 'Groups', onGroupDiscard)`. Follow the fail-open try/catch shape of `onGroupSave`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/admin-drafts-discard-reconcile.test.js`
Expected: PASS — all three tests green.

- [ ] **Step 5: Run the existing draft + reconcile tests for regression**

Run: `npx vitest run test/admin-drafts.test.js test/admin-service-reconcile.test.js`
Expected: PASS — the existing child-delete and SAVE reconcile paths are unaffected.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.js test/admin-drafts-discard-reconcile.test.js
git commit -m "fix(admin): reconcile Mission/Group rollups on draft DISCARD (draft_admin_integrity)"
```

---

## Task 3: Document the constraint-deploy migration runbook

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (add a "Draft delete — draft_admin_integrity" entry) OR create `docs/developers/operations/draft-admin-integrity-migration.md` if the gotchas file is the wrong home — pick the gotchas file to match the project's "one doc per subsystem, gotchas for the rest" convention.
- Modify: `CLAUDE.md` Top Gotchas (one bullet linking to the above, matching the existing bullet style)

**Interfaces:**
- Consumes: Tasks 1-2 (flag enabled, handlers in place)
- Produces: a runbook a deployer follows to roll the cascade constraints to HANA in the correct order.

The runbook must capture: (1) constraints generate at `cds build` once the flag is on and deploy to HANA as `.hdbconstraint` with `NOT VALIDATED` (existing orphaned draft rows do not block); (2) deploy order — ship the constraints to a target env and let them land BEFORE relying on cascade behavior, since the Node.js runtime stops issuing per-table draft deletes once the flag serves; (3) optional `cds.fiori.draft_orphan_cleanup: true` to purge pre-existing orphaned draft rows around the migration, then turn back off; (4) rollback — the constraints are additive (`ON DELETE CASCADE` on draft tables only); reverting means flipping the flag off (runtime resumes per-table deletes) and optionally dropping the constraints; (5) DEV→test→PROD ordering per the project's no-main-hotfix model.

- [ ] **Step 1: Write the runbook entry**

Add the migration steps + rollback to the gotchas doc (or new ops doc). Use the spec's exact flag names (`cds.fiori.draft_admin_integrity`, `cds.fiori.draft_orphan_cleanup`). Keep it to the five points above.

- [ ] **Step 2: Add the CLAUDE.md Top Gotchas bullet**

One bullet, matching the existing terse style, linking to the doc. Note the flag is ON as of this PR and that draft discard now reconciles via root DISCARD handlers (not child DELETE events).

- [ ] **Step 3: Verify the doc links resolve**

Run: `grep -n "draft-admin-integrity\|draft_admin_integrity" CLAUDE.md docs/developers/reference/tutorials-ims-gotchas.md`
Expected: the CLAUDE.md bullet references the doc section that exists.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/
git commit -m "docs: draft_admin_integrity migration runbook + gotcha"
```

---

## Task 4: Open PR to DEV

**Files:** none (git/PR only)

**Interfaces:**
- Consumes: Tasks 1-3 complete, tests green

- [ ] **Step 1: Run the scoped verification suite one final time**

Run: `npx vitest run test/admin-drafts.test.js test/admin-drafts-discard-reconcile.test.js test/admin-service-reconcile.test.js`
Expected: all PASS. (Full suite runs in CI — the repo blocks the full local suite.)

- [ ] **Step 2: Run the static guards (they run in CI; catch drift early)**

Run: `npm run static-guards`
Expected: 17/17 pass (confirms no `srv-qa` dep-parity or cp-list drift from the admin-service change).

- [ ] **Step 3: Push and open the PR**

```bash
git push -u origin <branch>
gh pr create --base DEV --title "feat(cap): adopt draft_admin_integrity (optimized draft deletion) #2909" --body "$(cat <<'EOF'
Closes #2909

## Summary
- Enables `cds.fiori.draft_admin_integrity: true` — CAP 10.2 optimized draft deletion (DB `ON DELETE CASCADE` on draft tables; activation/root-cancel delete only the admin record).
- Adds root `after('DISCARD')` reconcile handlers for `Missions`/`Groups` in AdminService. Under the flag, discarding a draft cascade-deletes child `CompletionPathItems`/`GroupPathItems` at the DB level, bypassing the per-row `after('DELETE')` reconcile. The DISCARD handlers restore rollup correctness; the existing child DELETE handlers stay (they still fire for direct programmatic deletes).
- Adds a constraint-deploy migration runbook.

## Migration ordering (NOT done in this PR — separate authorized deploy)
Constraints generate at `cds build` and deploy to HANA as `.hdbconstraint` (`NOT VALIDATED`). Deploy the constraints to a target env BEFORE the flag serves there. See the runbook. Confirm scope + ordering with the maintainer.

## Test plan
- [x] `test/admin-drafts-discard-reconcile.test.js` — new; DISCARD reconcile + empty-draft no-op + group-nesting
- [x] `test/admin-drafts.test.js` + `admin-service-reconcile.test.js` — no regression (SQLite)
- [x] `npm run static-guards` 17/17
- [ ] Hybrid HANA draft-discard verification on DEV (reviewer / post-deploy)
EOF
)"
```

result: PR opened to DEV adopting draft_admin_integrity with DISCARD-reconcile fix and migration runbook
