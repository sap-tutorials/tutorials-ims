# Safely Re-enabling `draft_admin_integrity` on Production

**Status:** IN PROGRESS (build-level proof done; deploy-level pending live HANA) — This runbook documents the SAFE re-enable procedure for `cds.fiori.draft_admin_integrity`. The flag is currently **disabled** (`false` in `package.json`). Re-enable ONLY after all green checks — another outage is unacceptable. This runbook exists so it CAN be done safely when the decision is made; it is NOT an instruction to do it now.

**Context:**
- Issue #2909: introduced the flag (CAP 10.2) + missing cascade constraints → PROD outage.
- Issue #2968: added the preflight check `srv/lib/draft-integrity-preflight.js`.
- Issue #2992: disabled the flag for all profiles and fixed the preflight (it had queried non-existent `com_sap_developers_ims_*_drafts` names instead of the real `ADMINSERVICE_*_DRAFTS` discovered from `SYS.TABLE_COLUMNS`).
- Issue #2994: added the orphan cleanup sweep `scripts/cleanup-draft-orphans.cjs`.
- Issue #3003: reverted a hand-rolled constraint attempt (`scripts/patch-draft-cascade-constraints.cjs`) that blocked all MTA deploys (HDI errors 8250014 / 8212001 / 8212012). Hand-rolling is the rejected approach; do not reintroduce it.
- Issue #2993 (this work): pinned `@sap/cds-compiler` to 7.2.1 (root had deduped to 7.0.1, which has no draft-constraint code) so CAP emits the 46 native cascade constraints through the `hdbmigrationtable` build path; added the gate test `test/admin-drafts-cascade-gate.test.js`.

**Key facts:**
- CAP's compiler (`createDraftAdminDataConstraints` in `@sap/cds-compiler` 7.2.1, `lib/transform/forRelationalDB.js`) emits the draft cascade constraints **natively** when `cds.fiori.draft_admin_integrity: true` + non-plain `sqlDialect`. The `package.json` `overrides` pin (`"@sap/cds-compiler": "7.2.1"`) ensures the right compiler is used; without it the root deduped to 7.0.1 (no draft constraint code).
- There are exactly **46 constraints**, one per `*_drafts` shadow table: `ON DELETE CASCADE`, **NOT VALIDATED**, ENFORCED, INITIALLY DEFERRED. FK: `AdminService_<Entity>_drafts.DraftAdministrativeData_DraftUUID → DRAFT_DraftAdministrativeData(DraftUUID)`.
- The constraints are **NOT VALIDATED** — pre-existing orphan rows do **not** block the deploy. The old "sweep orphans before deploy" premise was specific to hand-rolled ENFORCED inline FKs (reverted in #3003) and is void for the native path.
- `CDS_*` env-var overrides do NOT reach `cds.fiori.draft_admin_integrity` on deployed builds — only the baked `package.json` value counts.
- Constraint generation is independent of `cds.features.assert_integrity` (the global FK switch). Do not enable that flag; it is a non-goal.
- Preflight is HANA-only and fail-open; SQLite unit tests do not require cascade constraints.

---

## Prerequisites

- [ ] Git branch is up-to-date with `origin/main` (or `origin/DEV` for DEV environments).
- [ ] You have `cf login` credentials for the target environment (DEV first, then PROD).
- [ ] Node.js 22+ and `npm` are installed locally.
- [ ] `@sap/cds-dk` is globally available (`cds --version`).
- [ ] `cds build --production` emits 46 `AdminService.*_drafts_DraftAdministrativeData.hdbconstraint` files into `gen/db` (build-level proof; verified locally in #2993 Task 1).

---

## Step 1: Verify Build Emits 46 Constraints

Confirm the local build produces the 46 native cascade constraints. **This does NOT require live HANA.**

```bash
npm run build:all
# or for the CAP-only build:
cds build --production
```

After the build, count the constraint files:

```bash
ls gen/db/src/gen/ | grep -c '\.hdbconstraint$'
```

**Expected:** `46`

If the count is wrong:
- Confirm `@sap/cds-compiler` resolves to 7.2.1 (`node -e "console.log(require('@sap/cds-compiler/package.json').version)"` from the project root).
- Confirm `package.json` has `"overrides": { "@sap/cds-compiler": "7.2.1" }` (or equivalent `resolutions`).
- Run `npm install` and retry.

**Do NOT proceed to Step 2 if the count is not 46.**

---

## Step 2: Deploy to Target HANA (Constraints, Flag Still `false`)

The constraints are **NOT VALIDATED** — they deploy safely over any existing schema, even if orphaned draft rows are present. No pre-sweep is required as a deploy precondition.

Before deploying, crack the mtar archive and confirm the `.hdbconstraint` files are present (same pattern as the Step 3.5 admin-bundle check in `scripts/check-shipped-admin-bundle.cjs`):

```bash
# After mbt build completes:
unzip -l .deploy/mta_archives/*.mtar | grep hdbconstraint | wc -l
```

**Expected:** `46`

Deploy to DEV first:

```bash
export CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com"
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

**Verify deployment success and CAP service startup before proceeding.**

---

## Step 3: Verify Preflight Check

After deployment, the CAP service logs startup messages. Look for the preflight result from `srv/lib/draft-integrity-preflight.js`.

**Expected log:**
```
[draft-integrity-preflight] verified (46/46)
```

The preflight discovers tables from `SYS.TABLE_COLUMNS` at runtime — it does not use a hardcoded list.

**If you see a WARN instead:**
```
[draft-integrity-preflight] ⚠ missing: <table-names>
```
**STOP.** The constraints are incomplete or not deployed. Investigate:
- Is the mtar's `gen/db` module serving the `.hdbconstraint` files? (Re-check Step 1/2.)
- Did the HANA HDI deployment succeed? Check `cf logs <srv-app> --recent`.
- Confirm `@sap/cds-compiler` version in the deployed build (check package-lock.json on the branch that was built).

**Do NOT proceed to Step 4 until the preflight logs `verified (46/46)`.**

### Optional: baseline orphan check

The NOT VALIDATED constraints mean pre-existing orphans do not block deployment. However, running a dry-run gives a clean baseline reading for the smoke step later:

```bash
npm run bind:setup   # if this is your first hybrid run
npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --dry-run
```

This is informational only — it is not a deploy gate.

---

## Step 4: Flip the Flags in `package.json`

**ONLY after Steps 1–3 are green on DEV**, update the three flags:

1. Edit `package.json` — find the `"cds": { "fiori": { ... } }` block (two occurrences: top-level and `[development]`) and set:
   ```json
   "cds": {
     "fiori": {
       "draft_admin_integrity": true,
       "draft_orphan_cleanup": true
     },
     "drafts": {
       "deleteStrategy": "dad"
     }
   }
   ```

2. Commit and push:
   ```bash
   git add package.json
   git commit -m "feat(config): enable draft_admin_integrity + orphan_cleanup + dad (#2993)"
   git push origin <branch>
   ```

3. Rebuild and redeploy DEV:
   ```bash
   npm run build:all
   cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
   ```

---

## Step 5: Audit `after('DISCARD')` / `after('DELETE')` Reconcile Hooks Under `dad`

**This step is PROD-blocking.** CAP's `dad` (Draft Admin Data) delete strategy changes which event handlers fire during draft deletion — the DB cascade may bypass app-level reconcile hooks.

This project has custom reconcile handlers:
- `srv/lib/completion-reconcile.js`
- `srv/lib/pipeline-log-reconciler.js`
- `srv/lib/topic-cluster-reconcile.js`

These are tested in `test/admin-drafts-discard-reconcile.test.js` under the flag-OFF path. Under `dad`, verify they still fire:

1. Run the existing reconcile test suite:
   ```bash
   npx vitest run test/admin-drafts-discard-reconcile.test.js
   ```
   This is a SQLite-level test and is flag-agnostic — passing it is necessary but not sufficient.

2. **Add a HANA-level test** (or perform a manual verification on DEV) confirming each `after('DISCARD')` / `after('DELETE')` reconcile side effect still fires after a `dad` draft discard. The SQLite gate test cannot catch a bypass; HANA is required.

**Do NOT proceed to Step 6 (PROD) until the hook audit on DEV is confirmed.**

---

## Step 6: Run the Gate Test (Mission Draft Lifecycle)

The gate test `test/admin-drafts-cascade-gate.test.js` verifies that Mission draftEdit + discard leaves zero orphaned child drafts.

```bash
npx vitest run test/admin-drafts-cascade-gate.test.js
```

**Expected:** All tests pass, including:
- Draft creation, edit, and discard lifecycle.
- Zero orphaned `Missions.drafts` rows after discard.
- Zero orphaned `CompletionPathItems.drafts` rows after parent discard.

**If the test fails,** re-examine Steps 1–5. Do NOT proceed to Step 7 until this test is green.

---

## Step 7: Smoke Test – Mission Discard on Deployed DEV

After the re-deployed DEV service is running with the flags `true`, verify end-to-end:

1. **Via Admin UI** (`/admin-ui/#/admin/missions`):
   - Open an existing Mission draft (or create one).
   - Edit it (change the title or add a step).
   - Click **Discard** (or equivalent).
   - Expected: Discard succeeds; no orphaned rows in `Missions.drafts` or child composition tables.

2. **Verify in the server logs:**
   ```bash
   cf logs <srv-app> --recent | grep -i "error\|draft"
   ```

3. **If discard fails or errors appear,** roll back (see Rollback Plan below) and investigate before attempting PROD.

---

## Environment Order

**Always test DEV first (Steps 1–7), then repeat Step 2 → Step 5 on PROD.**

- **DEV:** Lower risk; catch any logic gaps before production.
- **PROD:** Only after DEV smoke passes for at least 2–4 hours without incident.

---

## Rollback Plan (Emergency)

If any step fails or the deployed service encounters errors:

1. Revert the flags in `package.json`:
   ```json
   "draft_admin_integrity": false,
   "draft_orphan_cleanup": false
   ```
   (Remove `deleteStrategy: dad` or revert to its prior value.)

2. Commit, push, and redeploy:
   ```bash
   git add package.json
   git commit -m "revert(config): disable draft_admin_integrity (#2993)"
   git push origin <branch>
   npm run build:all
   cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/<env>.mtaext -f
   ```

3. The cascade constraints remain in the schema but are inert without the flag — no orphan risk. The app-level reconcile path resumes.

4. If orphaned drafts accumulated during the flag-ON window, sweep them:
   ```bash
   npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --dry-run
   # Review output, then:
   npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --commit
   ```

5. Investigate and involve the team before retrying.

---

## Related Issues

- **#2909:** Introduced the flag (CAP 10.2) + missing cascade constraints → PROD outage.
- **#2968:** Added the preflight check `srv/lib/draft-integrity-preflight.js`.
- **#2992:** Disabled the flag for all profiles and fixed the preflight (queried non-existent `com_sap_developers_ims_*_drafts` instead of real `ADMINSERVICE_*_DRAFTS` from `SYS.TABLE_COLUMNS`).
- **#2994:** Added the orphan cleanup sweep `scripts/cleanup-draft-orphans.cjs`.
- **#3003:** Reverted hand-rolled constraint script (`scripts/patch-draft-cascade-constraints.cjs`) — blocked MTA deploys with HDI errors 8250014 / 8212001 / 8212012; do not reintroduce.
- **#2993 (this work):** Pinned `@sap/cds-compiler` to 7.2.1 so CAP emits 46 native `NOT VALIDATED` cascade constraints through the `hdbmigrationtable` build path; added gate test; rewrote this runbook.

---

## Contacts & Escalation

For questions or issues:
- Check [docs/developers/reference/tutorials-ims-gotchas.md](../reference/tutorials-ims-gotchas.md) for known draft-related gotchas.
- Review the related issues linked above for context.
- Escalate failures to the team via Slack or the issue tracker.
