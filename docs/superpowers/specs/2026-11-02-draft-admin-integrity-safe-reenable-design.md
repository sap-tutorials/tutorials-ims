# Design: Prove `draft_admin_integrity` is safe to re-enable — keep it OFF for now (#2993)

Date: 2026-11-02
Author: Claude (with Tom)
Status: Draft for approval

## Intent & why

CAP 10.2's `cds.fiori.draft_admin_integrity: true` (#2909) was enabled in
`package.json` to get optimized DB-level cascade draft deletion. The required
`ON DELETE CASCADE` constraints on the `ADMINSERVICE_*_DRAFTS` tables were
**never emitted by the build nor deployed**, so with the flag on the runtime
deleted only the `DRAFT_DRAFTADMINISTRATIVEDATA` parent and orphaned every
child draft row — making missions un-editable in PROD (2026-11-02 outage).
#2992 disabled the flag (all profiles) and fixed the preflight; #2994 shipped a
one-shot orphan sweep.

Tom's decision for this issue: **prove re-enabling is safe, but keep the flag
OFF.** We cannot afford another outage. This issue delivers the *artifacts and
the proof*, not the switch.

## Goals

1. **Author the real cascade constraints as committed, deployable artifacts**
   for every `AdminService.*_drafts` table. The build already emits these tables
   with the `DraftAdministrativeData_DraftUUID` FK column but no cascade clause;
   the work adds `ON DELETE CASCADE` via a build-time patch of
   the generated `.hdbtable` files (see Findings + deliverable 1). They must be
   deployable independently of the flag.
2. **A flag-agnostic gate test** proving `draftEdit → discard` on a Mission
   leaves **zero** orphaned child draft rows. Runs in `npm test` (SQLite).
   Written so it passes both with the flag off (today's app-level reconcile
   path) and would pass with the flag on (DB cascade) — it is the gate that
   must stay green before any future flip.
3. **A re-enable runbook** documenting the exact deploy-then-flip order so the
   issue's steps 2–4 become an executable checklist.

## Non-goals

- Flipping `cds.fiori.draft_admin_integrity` to `true`. Stays `false` in the
  committed `package.json` (base + `[development]`).
- Deploying anything to any environment.
- The orphan *sweep* — already delivered in #2994 (`cleanup-draft-orphans.cjs`).
- Changing the preflight — already fixed in #2992 (discovers real
  `%_DRAFTS` tables from `SYS.TABLE_COLUMNS`).

## Anti-goals (would make this a failure even if it "works")

- Any change that could cause the DB-cascade delete path to become active on a
  live environment (i.e. the flag going on, directly or via a build artifact
  that behaves like enabling it).
- Committed artifacts that `cf deploy` would reject because of existing orphan data
  (the enforced inline FK fails if orphaned draft rows are present — sweep first
  using `cleanup-draft-orphans.cjs`) or that `die` the deploy if a referenced
  draft table does not yet exist on the target.

## Findings (verified this session)

- **The build emits the draft tables WITH the FK column, but WITHOUT the
  cascade clause.** `cds build --production` emits **46**
  `gen/db/src/gen/AdminService.<Entity>_drafts.hdbtable` artifacts (tracked HDI
  `.hdbtable` files). Each carries `DraftAdministrativeData_DraftUUID
  NVARCHAR(36) NOT NULL`, but **no** `FOREIGN KEY ... ON DELETE CASCADE` clause
  — verified by `cat`/`grep` on the generated `AdminService.Missions_drafts.hdbtable`.
  The flag (`draft_admin_integrity` true vs false) does **not** change this
  output. This is the #2909 root cause: the physical draft tables and their FK
  column exist as build artifacts; only the cascade FK clause is missing, so the
  DB never cascades child-row deletion. (An earlier probe reported "zero draft
  artifacts" — that was a bad `fd` glob, not a real absence; corrected here.)
- **`.hdiconfig` does not register the `hdbconstraint` plugin.** `db/src/.hdiconfig`
  registers hdbindex/hdbmigrationtable/hdbprocedure/hdbsequence/hdbsynonym/
  hdbview/hdbrole — **no** `com.sap.hana.di.constraint`. So a committed
  `db/src/*.hdbconstraint` would be **silently ignored** by HDI. Precedent for
  fixing this: the MTA `before-all` already patches the generated `.hdiconfig`
  at build time (today it injects the `hdbprocedure` plugin into both
  `gen/db/src/gen/.hdiconfig` and `gen/db-qa/src/gen/.hdiconfig`).
- **Node flag is all-or-nothing at runtime.** CAP Node v10 has no separate
  `cds.drafts.deleteStrategy: flat|dad` escape hatch (that is the CAP Java
  model). On Node, `draft_admin_integrity: true` switches the runtime to rely on
  the DB cascade. There is no "constraints present but runtime still flat" safe
  middle state on Node — which is exactly why the flag must stay off until the
  cascade FK is proven present on the target env. The `CDS_*` env override does
  not reach `cds.fiori.draft_admin_integrity`, so the value is whatever
  `package.json` bakes at build time.
- **Cascade needed, per table:** `FOREIGN KEY ("DRAFTADMINISTRATIVEDATA_DRAFTUUID")
  REFERENCES "DRAFT_DRAFTADMINISTRATIVEDATA"("DRAFTUUID") ON DELETE CASCADE`,
  deployed ENFORCED (inline FK inside `COLUMN TABLE (...)` is always enforced —
  `NOT VALIDATED` is an `ALTER TABLE`-only affordance). This means orphaned draft
  rows must be swept BEFORE deploying the constraint, or HANA rejects the deploy.
  Local column is bare/unquoted in the generated DDL, so HANA folds it to
  `DRAFTADMINISTRATIVEDATA_DRAFTUUID`; the FK reference must quote that uppercase
  name. Parent table/PK confirmed via `cleanup-draft-orphans.cjs`
  (`DRAFT_DRAFTADMINISTRATIVEDATA(DRAFTUUID)`).
- **QA container is out of scope.** The QA db build model is `db-qa` only and
  does **not** include `AdminService`; `gen/db-qa/src/gen/` emits **0** draft
  tables. QA has no draft shadow tables to protect, so the constraint work is
  **prod-container-only** (`gen/db` → `tutorials-hana`), not symmetric with the
  existing hdbprocedure patch.

## The three deliverables

### 1. Cascade constraint artifacts (authored, committed, NOT deployed-live)

The build emits the 46 `_drafts.hdbtable` files with the FK column but no
cascade clause, and `.hdiconfig` has no `hdbconstraint` plugin. So the mechanism
is **not** committed `db/src/*.hdbconstraint` (HDI would ignore it). Instead,
add the `FOREIGN KEY ("DRAFTADMINISTRATIVEDATA_DRAFTUUID") REFERENCES
"DRAFT_DRAFTADMINISTRATIVEDATA"("DRAFTUUID") ON DELETE CASCADE` clause to each
generated `gen/db/src/gen/AdminService.*_drafts.hdbtable` via a **build-time
patch step**, mirroring the existing MTA `before-all` `.hdiconfig` patch
precedent. The FK is enforced (inline DDL); orphaned rows must be swept before
the constraint-bearing build is deployed. The table list is derived
programmatically from the generated `_drafts.hdbtable` set (not a hand-maintained
list), so it cannot drift from the live draft-table count the preflight checks.
Applied to the **prod `gen/db` tree only** (QA emits no draft tables). The
committed `package.json` flag stays `false` throughout; the patch makes the
constraints *deployable* but the runtime cascade path stays dormant until a
future flip.

### 2. Flag-agnostic gate test

Extend the existing `test/admin-drafts-discard-reconcile.test.js` pattern. A new
test: create a Mission draft with child items, `draftEdit`, then discard; assert
**zero** child draft rows remain for that draft. On the in-memory SQLite unit
run the assertion goes through CAP's `<Entity>.drafts` accessor (e.g.
`CompletionPathItems.drafts` / `GroupPathItems.drafts` filtered by the draft's
`DraftAdministrativeData_DraftUUID`), **not** raw HANA physical-table SQL (those
names don't exist on SQLite, and the HANA cleanup query isn't portable to
`npm test`). Must be green in `npm test` today (proves the app-level reconcile
path leaves no orphans with the flag off) and is the gate re-run before any
future flip.

### 3. Re-enable runbook

A doc (under `docs/developers/operations/`) giving the exact order: sweep orphans
first (`cleanup-draft-orphans.cjs --dry-run` then `--commit` if needed) → deploy
constraints (enforced inline FK — clean schema required) → confirm preflight
logs `verified (N/N)` on the target env → run the gate test green → flip
`package.json` flag → full rebuild + redeploy → smoke draftEdit/discard. Encodes
issue guardrails: flag does not go on until constraints are green on the *target*
env; `CDS_*` env override is not a substitute for the baked `package.json` value.

## Constraints

- Branch from fresh `origin/DEV` (done). PR targets `DEV`; never touch `main`
  directly.
- `npm test` (SQLite) must stay green; the gate test is additive.
- No deploy performed by this issue.

## Left to the builder / plan

- **O1 (builder's call within plan):** the exact form of the build-time patch
  step that appends the cascade FK to each generated
  `gen/db/src/gen/AdminService.*_drafts.hdbtable` — e.g. a Node script wired into
  the MTA `before-all` alongside the existing `.hdiconfig` patch, vs. a
  `cds build` plugin/after-build hook. Decide based on where the existing
  hdbprocedure `.hdiconfig` patch lives and what's least likely to drift. The
  option set from the *original* draft (committed `.hdbconstraint` vs. runtime
  `hdbsql`) is superseded by the corrected Findings: the tables are tracked HDI
  artifacts, so patching the generated `.hdbtable` is the lowest-risk mechanism.
- Confirm whether the patch must also register a plugin in `.hdiconfig` — if the
  FK is inlined into the `.hdbtable` body (part of the `COLUMN TABLE (...)`
  definition), no `hdbconstraint` plugin is needed; if authored as a separate
  constraint artifact, it is. Prefer inlining to avoid the plugin dependency.
- Exact Mission child-draft entities for the gate test's assertions
  (`CompletionPathItems` / `GroupPathItems` draft accessors).
- Whether to also assert on `draftActivate` (not just discard) in the gate test.
```
