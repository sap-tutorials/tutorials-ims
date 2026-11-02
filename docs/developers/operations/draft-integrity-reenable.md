# Safely Re-enabling `draft_admin_integrity` on Production

**Status:** DEFERRED — This runbook documents the SAFE re-enable procedure for `cds.fiori.draft_admin_integrity`. The flag is currently **disabled** (`false` in `package.json`). Re-enable ONLY after all green checks — another outage is unacceptable. This runbook exists so it CAN be done safely when the decision is made; it is NOT an instruction to do it now.

**Context:**
- Issue #2909: introduced the flag (CAP 10.2) + missing cascade constraints → PROD outage.
- Issue #2968: added the preflight check `srv/lib/draft-integrity-preflight.js`.
- Issue #2992: disabled the flag for all profiles and fixed the preflight (it had queried non-existent `com_sap_developers_ims_*_drafts` names instead of the real `ADMINSERVICE_*_DRAFTS` discovered from `SYS.TABLE_COLUMNS`).
- Issue #2994: added the orphan cleanup sweep `scripts/cleanup-draft-orphans.cjs`.
- Issue #2993 (this work): added the build-time FK injection `scripts/patch-draft-cascade-constraints.cjs`, the gate test `test/admin-drafts-cascade-gate.test.js`, and this runbook.

**Key facts:**
- Constraints are built `NOT VALIDATED` (no pre-clean needed); they remain **inert** until `draft_admin_integrity: true` is set.
- `CDS_*` env-var overrides do NOT reach `cds.fiori.draft_admin_integrity` on deployed builds — only the baked `package.json` value counts.
- Preflight is HANA-only and fail-open; SQLite unit tests do not require cascade FKs.

---

## Prerequisites

- [ ] Git branch is up-to-date with `origin/main` (or `origin/DEV` for DEV environments).
- [ ] You have `cf login` credentials for the target environment (DEV first, then PROD).
- [ ] Node.js 22+ and `npm` are installed locally.
- [ ] `@sap/cds-dk` is globally available (`cds --version`).

---

## Step 1: Deploy with Cascade Constraints (Flag Still `false`)

The Task 1 patch `scripts/patch-draft-cascade-constraints.cjs` already injects `ON DELETE CASCADE` foreign keys into the 46 draft tables in the generated `gen/db/src/gen/AdminService.*_drafts.hdbtable` files.

**On the target environment (DEV or PROD):**

1. Ensure the MTA includes the latest `cds build --production` output with the patched constraints.
2. Deploy the MTA as usual (e.g., `npm run deploy -- --env dev` or via CI/CD):
   ```bash
   npm run build:all
   cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
   ```
3. The HANA schema will accept the constraints as `NOT VALIDATED` — existing orphaned rows are unaffected while the flag is `false`.
4. Verify deployment success and CAP service startup.

**Note:** The constraints land on every build already (while `draft_admin_integrity` is `false`). This step merely ensures they have deployed to the target environment HANA schema.

---

## Step 2: Verify Preflight Check

After deployment, the CAP service logs startup messages. Look for the preflight result from `srv/lib/draft-integrity-preflight.js`.

**Expected log:**
```
[draft-integrity-preflight] verified (N/N)
```
where N is the count of verified draft tables (typically 46 for Admin/Mission/Group/Author services + compositions).

**If you see a WARN instead:**
```
[draft-integrity-preflight] ⚠ missing: <table-names>
```
**STOP.** The constraints are incomplete or not deployed. Do not proceed to Step 3. Investigate:
- Is the MTA's `gen/db` module serving the patched HDbtable files?
- Did the HANA HDI deployment succeed (check `cf logs <app> --recent`)?
- Run `cds build --production` locally and verify `gen/db/src/gen/AdminService.*_drafts.hdbtable` files contain the `ON DELETE CASCADE` clause.

---

## Step 3: Sweep Orphaned Drafts (Dry-Run First)

Orphaned draft rows are draft-only children whose parent active entity was deleted or reassigned. The cleanup script `scripts/cleanup-draft-orphans.cjs` identifies and removes them.

**Locally, with credentials bound to the target environment:**

1. Set up the service binding (one-time):
   ```bash
   npm run bind:setup   # if this is your first hybrid run
   ```

2. Run a dry-run to inspect any orphans:
   ```bash
   npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --dry-run
   ```

3. **Expected output:** Zero orphans found:
   ```
   Scanning for orphaned drafts...
   Found 0 orphaned draft rows. (All clean.)
   ```

4. **If orphans are found**, inspect them (the script prints details) and decide whether to proceed. If you expect orphans from the #2909 outage:
   - Commit/note the findings.
   - Run WITHOUT `--dry-run` to delete:
     ```bash
     npx cds bind --exec -- node scripts/cleanup-draft-orphans.cjs --commit
     ```
   - Verify the count matches the dry-run scan.

---

## Step 4: Run the Gate Test (Mission Draft Lifecycle)

The gate test `test/admin-drafts-cascade-gate.test.js` verifies that Mission draftEdit + discard leaves zero orphaned child drafts.

**Locally:**
```bash
npx vitest run test/admin-drafts-cascade-gate.test.js
```

**Expected:** All tests pass (green), including:
- Draft creation, edit, and discard lifecycle.
- Zero orphaned `Missions.drafts` rows after discard.
- Zero orphaned `CompletionPathItems.drafts` rows after parent discard.

**If the test fails,** re-examine Step 1–3. Do NOT proceed to Step 5 until this test is green.

---

## Step 5: Flip the Flag in `package.json`

**ONLY after Steps 1–4 are green on the target environment**, update the flag:

1. Edit `package.json`:
   - Line ~461: find the `"cds": { "fiori": { ... } }` block and set `"draft_admin_integrity": true`.
   - Line ~486: find the `"[development]": { "cds": { "fiori": { ... } } }` block and set `"draft_admin_integrity": true`.

2. Example (before):
   ```json
   "cds": {
     "fiori": {
       "draft_admin_integrity": false
     }
   }
   ```
   Example (after):
   ```json
   "cds": {
     "fiori": {
       "draft_admin_integrity": true
     }
   }
   ```

3. Commit and push the change:
   ```bash
   git add package.json
   git commit -m "feat(config): enable draft_admin_integrity globally (#2993)"
   git push origin <branch>
   ```

4. Run a fresh build with the flag ON:
   ```bash
   npm run build:all
   ```

5. Deploy to the target environment:
   ```bash
   cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
   ```

---

## Step 6: Smoke Test – Mission Discard on Deployed Environment

After the re-deployed service is running with the flag `true`, verify the behavior end-to-end:

1. **Via Admin UI** (`/admin-ui/#/admin/missions`):
   - Create or open an existing Mission draft.
   - Edit it (add a step, change the title, etc.).
   - Click **Discard** (or equivalent button).
   - Expected: Discard succeeds; no orphaned rows left in `Missions.drafts` or child composition tables.

2. **Verify no errors in the server logs:**
   ```bash
   cf logs <app> --recent | grep -i error
   ```

3. **If discard fails or errors appear,** rollback the flag to `false`, redeploy, and investigate the error. Escalate to the team.

---

## Rollback Plan (Emergency)

If any step fails or the deployed service encounters errors:

1. Revert the flag to `false` in `package.json` (Steps 1–2):
   ```json
   "draft_admin_integrity": false
   ```

2. Commit, push, and redeploy:
   ```bash
   git add package.json
   git commit -m "revert(config): disable draft_admin_integrity (#2993)"
   git push origin <branch>
   npm run build:all
   cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/<env>.mtaext -f
   ```

3. The constraints remain in the schema (`NOT VALIDATED`, inert); they cause no harm. The flag controls their enforcement.

4. Investigate the root cause before attempting re-enable again. Involve the team.

---

## Environment Order

**Always test DEV first, then PROD.**

- **DEV:** Lower risk; catch any logic gaps before production.
- **PROD:** Only after DEV smoke test passes for at least 2–4 hours without incident.

---

## Related Issues

- **#2909:** Introduced the flag (CAP 10.2) + missing cascade constraints → PROD outage.
- **#2968:** Added the preflight check `srv/lib/draft-integrity-preflight.js`.
- **#2992:** Disabled the flag for all profiles and fixed the preflight (queried non-existent `com_sap_developers_ims_*_drafts` instead of real `ADMINSERVICE_*_DRAFTS` from `SYS.TABLE_COLUMNS`).
- **#2994:** Added the orphan cleanup sweep `scripts/cleanup-draft-orphans.cjs`.
- **#2993:** Added the build-time FK injection `scripts/patch-draft-cascade-constraints.cjs`, the gate test `test/admin-drafts-cascade-gate.test.js`, and this runbook.

---

## Contacts & Escalation

For questions or issues:
- Check [docs/developers/reference/tutorials-ims-gotchas.md](../reference/tutorials-ims-gotchas.md) for known draft-related gotchas.
- Review the related issues linked above for context.
- Escalate failures to the team via Slack or the issue tracker.
