# Design: Re-enable `draft_admin_integrity` with native cascade constraints + orphan cleanup (#2993)

**Date:** 2026-11-13
**Status:** Proposed — awaiting approval
**Issue:** [#2993](https://github.com/sap-tutorials/tutorials-ims/issues/2993)
**Size:** Project (multi-step, spans config + build pipeline + real-HANA verification)

---

## Intent and the why

CAP 10.2's "Optimized Draft Deletion" (`cds.fiori.draft_admin_integrity`) was enabled in #2909 **without its database half ever deploying** — the runtime began deleting only the `DraftAdministrativeData` record and trusting a DB `ON DELETE CASCADE` that did not exist. Every mission draft activate/discard orphaned child draft rows, making missions un-editable in PROD (2026-11-02 outage). #2992 disabled the flag and fixed the preflight; #3003 reverted a hand-rolled-constraint attempt that blocked all MTA deploys.

This work delivers the **whole feature, correctly**: CAP's native draft cascade constraints flowing through our build, the `dad`-strategy runtime behavior re-enabled on top of them, **and** `draft_orphan_cleanup` as defense-in-depth so a future gap can never silently corrupt drafts again.

**Why the whole feature (not just orphan cleanup):** the decision is to adopt the optimization CAP intends, not just stop the bleeding. Orphan cleanup alone keeps missions editable but leaves draft deletion on the slow per-table `flat` strategy; the full feature gives single-cascade deletion (`dad`) *and* a self-healing safety net.

## Goals

1. CAP's native draft cascade `.hdbconstraint`s (46, one per `*_drafts` table) are generated **and actually land in the deployed MTA** on a real HANA container.
2. `cds.fiori.draft_admin_integrity: true` re-enabled (all profiles) **only after** the constraints are verified deployed via the fixed preflight.
3. `cds.fiori.draft_orphan_cleanup: true` enabled as a permanent safety net, independent of the cascade.
4. The gate test proves Mission draftEdit→discard leaves **zero** orphaned child draft rows.
5. The outage is structurally impossible to repeat: flag-on without constraints-present is caught before serving.

## Non-goals

- Enabling the global `cds.features.assert_integrity` DB-constraints switch (model-wide FKs on all ~146 associations). The spike proved the draft cascade is **independent** of it; we do not touch it.
- Reworking the orphan cleanup sweep script (`scripts/cleanup-draft-orphans.cjs`, #2994) — it stays as the manual emergency tool.
- Changing draft table names or the draft model.

## Anti-goals (what would make this a failure even if it "works")

- Flipping `draft_admin_integrity: true` again while the constraints are not verifiably present on the target HANA schema. This is the exact #2909 mistake; the preflight gate exists to make it impossible.
- Hand-authoring `.hdbconstraint` files. The spike proved CAP generates them natively and `NOT VALIDATED`; hand-rolling re-enters the #3003 HDI make-graph failure. If CAP's native output cannot be made to flow, we **stop and escalate**, we do not hand-roll.
- A deploy that blocks on the constraints (the #3003 regression).

## Constraints

- **Verification requires a real HANA delta deploy.** No local/SQLite build can prove the constraints flow through the `.hdbmigrationtable` path or that HDI accepts them on a delta deploy. DEV HANA is the first real test.
- **`CDS_*` env overrides do not reach these flags** (verified: neither build-time nor runtime). Only baked `package.json` / `.cdsrc.json` values count.
- **DEV/main branching:** feature branch → PR to **DEV**, not main. Never deploy a feature branch; deploy from fresh `origin/DEV`.
- **Deploy hygiene:** `cf target` before push; pause the sap-devs scheduler during long deploys; clean Hugo working tree (#2886 Step 0.5).

## Approaches considered

### A. Native CAP constraints through the build + `dad` + orphan cleanup — **CHOSEN**
Make CAP's native `createDraftAdminDataConstraints` output flow through our `.hdbmigrationtable` build, deploy it `NOT VALIDATED`, verify via preflight, then flip `draft_admin_integrity: true` and enable `draft_orphan_cleanup: true`.
- **Trades off:** carries one genuinely unresolved engineering risk — the constraints generate under the full `to.hdi` compile but were **not observed** surfacing through our `to.hana`/hdbmigrationtable delta path in the spike. Resolving that (config vs. cds-dk behavior) is the core task.
- **Why chosen:** it is the only approach that delivers the whole feature using CAP's own, correctly-formed (`NOT VALIDATED`, deploy-safe) artifacts.

### B. Hand-authored `.hdbconstraint` artifacts — **REJECTED**
Author the 46 cascade constraints by hand.
- **Rejected because:** this is exactly what #3003 reverted (HDI errors 8250014 / 8212001 / 8212012, blocked every MTA deploy). The spike also showed CAP's native output is `NOT VALIDATED` while hand-rolled inline FKs are forced `ENFORCED VALIDATED` — strictly worse.

### C. `draft_orphan_cleanup` only, cascades never enabled — **REJECTED as the whole fix**
- **Rejected because:** the user's decision is to implement the whole feature. Orphan cleanup alone leaves draft deletion on the slow `flat` strategy and does not deliver the optimization. It is **retained as a component** of approach A (goal 3), not the endpoint.

## Builder-check resolutions (verified facts — do not re-investigate)

- **`scripts/patch-draft-cascade-constraints.cjs` does not exist and is not wired** anywhere (verified: absent from the tree; no reference in `package.json` or `scripts/`). It was reverted in #3003 and never re-landed. Do NOT reintroduce it (that is rejected approach B). Any doc mention of it is stale.
- **46 is authoritative.** Compiling this model (`to.hdi`, `draft_admin_integrity: true`, `sqlDialect: hana`) emits exactly **46** `DraftAdministrativeData … ON DELETE CASCADE … NOT VALIDATED` constraints — one per `*_drafts` shadow table. The preflight's stale 27-entry `DRAFT_TABLES` list is deprecated; it discovers tables from `SYS.TABLE_COLUMNS` at runtime, so `N` = 46 on a correctly-deployed schema.
- **`cds.fiori.draft_orphan_cleanup` is a real, recognized key** in installed `@sap/cds@10.2.2` (`cds.env.fiori`, Node runtime, default `false`). Goal 3 will not silently no-op. It belongs in the fiori config block alongside `draft_admin_integrity`.
- **Constraints are CAP-native and `NOT VALIDATED`** — pre-existing orphans do NOT block the deploy. The old runbook's "sweep orphans before deploy" gate does not apply to this path.

## The how — decided

Ordered so correctness gates are green before any risky flip, mirroring `docs/developers/operations/draft-integrity-reenable.md`:

1. **Resolve the build-path question (the core engineering task).** Determine why the 46 native constraints surface through the full `to.hdi` compile but not the observed `cds.compile.to.hana` / `.hdbmigrationtable` delta path. Prime suspects, in order: (a) a journaling / `@cds.persistence.journal` interaction (cf. the known "full `cds build` suppresses hdbmigrationtable version bumps via the cds-caching statistics hana task clobbering the last-dev csn baseline" gotcha — same `to.hana` delta path); (b) an option-flatten on the migration path (`cdsc.js:154` `Object.assign` REVISIT); (c) a genuine cds-dk 10.2.0 / compiler 7.2.1 gap requiring a version bump or `patch-package` shim. **Builder's latitude** on *how* to instrument, but the exit criterion is fixed: a `cds build --production` of this project emits `AdminService.*_drafts_DraftAdministrativeData.hdbconstraint` (×46, `NOT VALIDATED`, `ON DELETE CASCADE`) into `gen/db`. If none of (a)–(c) yields this without hand-rolling, **stop and escalate** — do not fall back to approach B.
2. **Set `cds.features.assert_integrity`?** — No. Confirmed non-goal; the draft pass needs only `draft_admin_integrity` + a non-plain dialect.
3. **Keep flags OFF while building.** Constraints land in the build with `draft_admin_integrity` still `false` in `package.json` (generation is a compile concern; runtime behavior is the flag). Deploy constraints first.
4. **Deploy to DEV HANA (delta).** Verify the `.hdbconstraint`s are in the MTA (crack the mtar, as Step 3.5 does for admin bundles) and that HDI accepts them `NOT VALIDATED` on a delta deploy over the existing container. This is the first real proof.
5. **Verify preflight.** `srv/lib/draft-integrity-preflight.js` must log `verified (N/N)` (not WARN) on DEV. Pre-existing orphans do **not** block (constraints are `NOT VALIDATED`); still run `cleanup-draft-orphans.cjs --dry-run` for a clean baseline reading.
6. **Flip `draft_admin_integrity: true`** (both `package.json` blocks) + **`draft_orphan_cleanup: true`**; set `cds.drafts.deleteStrategy: dad` per CAP docs. Redeploy DEV.
7. **Audit custom draft-deletion handlers under `dad` (REQUIRED — handler-firing change).** CAP docs warn `dad` "changes which event handlers are called during draft deletion." This repo has custom `after('DISCARD')` / `after('DELETE')` reconcile hooks (`srv/lib/completion-reconcile.js`, `srv/lib/pipeline-log-reconciler.js`, `srv/lib/topic-cluster-reconcile.js`) with a dedicated `test/admin-drafts-discard-reconcile.test.js` — added to survive with the flag OFF. Under `dad` the DB cascade may bypass exactly those hooks. The SQLite gate test is flag-agnostic and will NOT catch a bypass. Audit each reconcile hook's behavior under `dad`, and add a **HANA-level** (not SQLite) test proving the reconcile side effects still fire after a `dad` draft discard. This is a PROD-blocking gate.
8. **Gate test green.** `test/admin-drafts-cascade-gate.test.js` — Mission draftEdit→discard leaves zero orphaned child draft rows (SQLite-level runtime check; the HANA cascade is proven by steps 4–5, the hook behavior by step 7).
9. **Smoke on DEV**, then promote the same sequence to PROD via the normal DEV→main release flow.
10. **Rewrite** `docs/developers/operations/draft-integrity-reenable.md` (not a light update): its current Steps 1–2 are built around the *rejected* hand-rolled ENFORCED inline FK (`scripts/patch-draft-cascade-constraints.cjs`, reverted in #3003) whose premise ("sweep orphans BEFORE deploy or HANA rejects it") is **void** for CAP's native `NOT VALIDATED` constraints. Retire that patch-script path from the doc entirely. Also correct the CLAUDE.md "Optimized draft deletion" gotcha: native `NOT VALIDATED` constraints; the real blocker was the build-format path (`to.hana`/`.hdbmigrationtable`), not HDI make-graph or hand-authoring.

## What's left to the builder

- The instrumentation method for step 1 and the specific fix (config change, dependency bump, or minimal `patch-package` shim) — provided the exit criterion in step 1 is met and approach B is not used.
- Exact wording of the doc/gotcha updates.
- Whether `deleteStrategy: dad` is set via `package.json` or `.cdsrc.json` (follow existing fiori-config placement).

## Rollback

- Pre-flip (steps 1–5): constraints are `NOT VALIDATED` and inert without the flag — no behavior change, nothing to roll back beyond reverting the build change.
- Post-flip: revert `draft_admin_integrity` + `draft_orphan_cleanup` + `deleteStrategy` to prior values and redeploy; the constraints may remain (harmless). Orphan sweep via `cleanup-draft-orphans.cjs --commit` if any accumulated.

## Verification (evidence required before "done")

- `cds build --production` emits 46 draft `.hdbconstraint`s locally (step 1 exit criterion).
- mtar contains them (cracked-archive diff).
- DEV HANA delta deploy succeeds; preflight logs `verified (46/46)`.
- Gate test passes.
- **Hook audit (step 7):** a HANA-level test confirms each `after('DISCARD')`/`after('DELETE')` reconcile side effect still fires under `deleteStrategy: dad`. PROD-blocking.
- DEV smoke: a Mission draftEdit→discard, then a direct query confirming zero orphaned child draft rows on real HANA.
