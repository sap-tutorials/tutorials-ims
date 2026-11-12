# Concepts DB-side `embeddingVec` via Full KG Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Concepts.embeddingVec` a true HANA `GENERATED ALWAYS AS (VECTOR_EMBEDDING(...))` column by journaling the entity and forcing a clean drop/recreate of the Concepts table and its 15 dependent KG tables, then rebuilding the knowledge graph from the tutorial corpus.

**Architecture:** The live `Concepts.embeddingVec` never became generated because `db/src/.hdiconfig` registers only the `hdbmigrationtable` plugin (no `hdbtable`), so the plain `.hdbtable` artifact carrying the `GENERATED ALWAYS` clause was silently ignored by HDI. Fix = journal `Concepts` (and the dependent KG tables, if not already) so it compiles to `.hdbmigrationtable`; add the Concepts + dependent artifacts to `db/undeploy.json` so HDI drops the existing populated tables; the v1 migration table then recreates Concepts with the generated column. Because repopulation is a non-deterministic LLM extraction (fresh concept IDs), all 15 dependent link/edge/alias/featured tables are wiped in the same deploy and rebuilt from scratch afterward. Post-deploy: enable KG, re-extract from corpus, publish, backfill `embedding` BLOB; `embeddingVec` auto-generates at insert.

**Tech Stack:** SAP CAP (Node.js), SAP HANA Cloud (HDI, `.hdbmigrationtable`, REAL_VECTOR, VECTOR_EMBEDDING via TUTORIALS_AICORE remote source), `@sap/cds` 10.x. CDS dialect separation (`db/hana/` vs `db/sqlite/`).

**Spec:** This plan (derived from live DEV HANA investigation + Explore agent report in-session; no separate spec doc). The binding authority is the verified facts below.

## Global Constraints

- **NEVER run ad-hoc DDL (CREATE/ALTER/DROP) against the HDI container.** All schema change is design-time through `cds build` + HDI deploy. (HDI correctly blocks ad-hoc DDL; attempting it is a rule violation.)
- **NEVER hand-edit a `.hdbmigrationtable`** — it corrupts the version sequence and breaks sequential HANA migration (neither SQLite nor CI staging catches it). Always let `cds build --production` generate it.
- **The journal + generated-column annotations are HANA-only** (`db/hana/concepts-embedding.cds`, loaded only for `[hybrid]`/`[production]` via `cds.requires.db.model`). SQLite/unit path keeps the plain column + Node writer; never let HANA-only DDL leak into the SQLite model.
- **Every schema change commit MUST include the regenerated build baseline**: `db/last-dev/csn.json` (and `db/last-dev/last-dev.bak/csn.json` if the build updates it) + any new/changed `db/src/*.hdbmigrationtable`. CI `scripts/check-cds-build-staging.ts` fails the PR if `cds build --production` output drifts from the committed copy.
- **This is destructive**: the Concepts table + 15 dependent KG tables are dropped and rebuilt empty. The KG is unusable between deploy and the completion of post-deploy re-extraction. All KG feature flags are DEV-only + default OFF + fail-open, so the user-facing site degrades gracefully, but KG surfaces (`/build/concepts`, concept search, homepage featured topics) are empty until rebuild completes.
- **KG is OFF by default** (`KnowledgeGraphSettings.enabled=false`, seed CSV has header only). Extraction silently no-ops unless KG is enabled FIRST. This is the #1 footgun.
- **PROD promotion is a SEPARATE decision** — this plan targets DEV verification only. Do not promote to `main` until DEV is verified green end-to-end. There is no main-hotfix path.
- **Branch from fresh `origin/DEV`**, PR into DEV, never direct-merge to main, never deploy a feature branch.

## Review Focus

- **KG left disabled after rebuild** → extraction no-ops, Concepts stays permanently empty, every KG surface dead. The runbook (Task 6) must enable KG *before* re-extraction and the verification (Task 7) must assert Concepts row count > 0.
- **Dependent tables NOT dropped alongside Concepts** → dangling `concept_ID` FKs reproduce the #787 crash in `/build/concepts` and KG read handlers. Task 3's `undeploy.json` list must cover all 15 dependents, and Task 7 must assert zero orphaned link rows.
- **SQLite unit suite breaks** because the journal/generated annotation leaked into the shared model or the removed Node writer is still needed on SQLite → `npm test` red. Task 1 must keep the annotation HANA-only; Task 5's hybrid test must self-skip on SQLite.
- **`change-mode` default leaves the generated clause unmigrated** → even journaled, if the table isn't actually dropped (undeploy entry wrong path/format), v1 adopts the existing plain column and the generated clause is cosmetic. Task 7 must assert `GENERATION_TYPE` is non-null on live HANA post-deploy — the single dispositive check.
- **Build baseline not committed** → CI staging check fails, or worse, a partial commit corrupts the migration version sequence. Task 4 regenerates and commits the full baseline; Task 4 verification runs `check-cds-build-staging.ts` locally.

---

### Task 1: Journal Concepts + dependent KG tables (HANA-only annotations)

**Files:**
- Modify: `db/hana/concepts-embedding.cds` (journal annotation already added locally for `Concepts`; keep it, confirm it's HANA-only)
- Verify: `db/persistence.cds` (the 59 existing journal annotations; determine whether the 15 Concepts-dependent tables are already journaled there — ConceptEdges, ConceptAliases, the 8 external ConceptLinks, TutorialConceptLinks, HomepageFeaturedTopics, TechEdSessionConceptLinks)

**Interfaces:**
- Produces: a model where `Concepts` and every table to be dropped in Task 3 compiles to `.hdbmigrationtable` (not `.hdbtable`). Task 3 (undeploy list) and Task 4 (build baseline) depend on knowing the exact set of journaled artifacts.

- [ ] **Step 1: Enumerate which of the 15 dependents are already journaled**

Run: `rg -n "with @cds.persistence.journal" db/persistence.cds` and cross-check against the dependent list (ConceptEdges, ConceptAliases, TutorialConceptLinks, VideoConceptLinks, LearningJourneyConceptLinks, BlogPostConceptLinks, DiscoveryMissionConceptLinks, ApiDocConceptLinks, SampleConceptLinks, HelpDocConceptLinks, CommunityEventConceptLinks, DevtoberfestSessionConceptLinks, TechEdSessionConceptLinks, HomepageFeaturedTopics, ConceptPrereqs if present).
Expected: a definitive list of which dependents are journaled vs plain `.hdbtable`. Record it — Task 3 needs it.

- [ ] **Step 2: Add `@cds.persistence.journal` for any dependent not already journaled**

Journal annotations for the base-schema `ims.*` dependents go in `db/persistence.cds` (loaded all profiles — journal is a no-op on SQLite). Keep the `Concepts` journal annotation in `db/hana/concepts-embedding.cds` only if co-locating with the generated column matters; otherwise move it to `db/persistence.cds` for consistency with the other 59. Decide for consistency: put `Concepts` journal in `db/persistence.cds` alongside the rest, keep only the `@sql.append` generated-column annotation in `db/hana/concepts-embedding.cds`.

- [ ] **Step 3: Compile to confirm artifact types**

Run: `cds build --for hana --production -o <tmp>` then `fd -g '*Concepts*' <tmp>` and check each dependent emits `.hdbmigrationtable`.
Expected: `com.sap.developers.ims.Concepts.hdbmigrationtable` present with the `GENERATED ALWAYS` column; every dependent to be dropped emits `.hdbmigrationtable`.

- [ ] **Step 4: Confirm SQLite model unaffected**

Run: `cds compile db -2 sql --dialect sqlite 2>&1 | rg -i "GENERATED|VECTOR_EMBEDDING"` (default/development profile).
Expected: no output (SQLite keeps plain columns; no HANA DDL leaked).

- [ ] **Step 5: Commit**

```bash
git add db/hana/concepts-embedding.cds db/persistence.cds
git commit -m "feat(kg): journal Concepts + dependent tables for hdbmigrationtable deploy (#2810)"
```

### Task 2: Restore Node embedding writers conditionally OR confirm removal is safe

**Files:**
- Modify: `srv/jobs/concept-embedding-backfill.js` (HANA branch — earlier edit removed `embeddingVec` write)
- Modify: `packages/kg/kg-merge-on-write.js` (`insertMintedConcept` HANA branch — earlier edit removed the `TO_REAL_VECTOR` follow-up UPDATE)

**Interfaces:**
- Consumes: the generated column from Task 1 (once deployed, `embeddingVec` is read-only; writing it errors).
- Produces: write paths that are correct for a GENERATED column (must NOT write `embeddingVec`). Confirms the earlier removals are correct for the post-deploy state.

- [ ] **Step 1: Confirm the earlier write-removals are correct and keep them**

The generated column is read-only; the backfill + mint paths must NOT write `embeddingVec`. The earlier edits (removing `EMBEDDINGVEC = TO_REAL_VECTOR(?)` from backfill SET, dropping the mint follow-up UPDATE) are correct for the post-deploy generated column. Verify they're still present and the HANA branch writes only `embedding` (BLOB).
Run: `rg -n "EMBEDDINGVEC|embeddingVec" srv/jobs/concept-embedding-backfill.js packages/kg/kg-merge-on-write.js`
Expected: no write of `embeddingVec` on the HANA branch.

- [ ] **Step 2: Confirm candidate predicate on backfill HANA branch is `EMBEDDING IS NULL` only**

The generated `embeddingVec` is never NULL once a row exists, so the backfill candidate filter must key on the BLOB `embedding` only. Verify.
Expected: HANA branch selects rows `WHERE EMBEDDING IS NULL` (not `OR EMBEDDINGVEC IS NULL`).

- [ ] **Step 3: No commit needed if already correct** (changes are from the prior branch work; if this is a fresh branch, cherry-pick or re-apply and commit `fix(kg): stop writing generated embeddingVec column on HANA`).

### Task 3: Add Concepts + 15 dependents to `db/undeploy.json`

**Files:**
- Modify: `db/undeploy.json`

**Interfaces:**
- Consumes: the journaled artifact set from Task 1 (artifact file names) — the undeploy path convention is `src/gen/<fqn>.hdbmigrationtable` (NOT `.hdbtable`, since these are now journaled).
- Produces: an undeploy allowlist that drops the existing populated Concepts + dependent tables on next deploy, so v1 migration recreates Concepts with the generated column.

- [ ] **Step 1: Determine the exact artifact path + suffix for a journaled table in undeploy.json**

The existing entries use `.hdbtable` (pre-journaling). For a journaled table the deployed artifact is `src/gen/<fqn>.hdbmigrationtable`. **VERIFY the correct suffix for undeploy of a migration table** — check whether HDI undeploy of a journaled table uses the `.hdbmigrationtable` artifact path, by inspecting how the 57 already-journaled entities are handled (they are NOT in undeploy.json as migration tables — confirming journaled tables are normally NOT dropped). This is the load-bearing unknown: an undeploy entry with the wrong suffix silently fails to drop, leaving the plain column.
Expected: documented correct path format. If uncertain, the safest route is to add BOTH the legacy `.hdbtable` path (drops the pre-journaling fossil table) — since the live Concepts table was created by a pre-journaling deploy, its deployed artifact may still be registered under the `.hdbtable` name.

- [ ] **Step 2: Add Concepts + all 15 dependent artifact paths to undeploy.json**

Insert entries for: Concepts, ConceptEdges, ConceptAliases, TutorialConceptLinks, VideoConceptLinks, LearningJourneyConceptLinks, BlogPostConceptLinks, DiscoveryMissionConceptLinks, ApiDocConceptLinks, SampleConceptLinks, HelpDocConceptLinks, CommunityEventConceptLinks, DevtoberfestSessionConceptLinks, TechEdSessionConceptLinks, HomepageFeaturedTopics (+ ConceptPrereqs / CoCompletions / ConceptRank / TutorialRank sidecars if they carry stale FK/slug data worth clearing).

- [ ] **Step 3: Validate JSON**

Run: `jq . db/undeploy.json`
Expected: parses; new entries present.

- [ ] **Step 4: Commit**

```bash
git add db/undeploy.json
git commit -m "chore(kg): undeploy Concepts + dependents to force clean rebuild (#2810)"
```

### Task 4: Regenerate + commit the build baseline

**Files:**
- Modify: `db/last-dev/csn.json` (+ `.bak` if build touches it)
- Create: `db/src/com.sap.developers.ims.Concepts.hdbmigrationtable` and any newly-journaled dependents' migration tables

**Interfaces:**
- Consumes: Tasks 1-3 model changes.
- Produces: the committed artifacts the deployer (`gen/db`) and CI staging check consume.

- [ ] **Step 1: Run the production build**

Run: `cds build --production` (the same build `mbt build` invokes). Let it write `db/last-dev/` and `db/src/*.hdbmigrationtable`.
Expected: exit 0; new Concepts migration table generated with `== version=1` + the `GENERATED ALWAYS` column.

- [ ] **Step 2: Inspect the generated Concepts migration table**

Run: `rg -n "GENERATED ALWAYS|version=" db/src/com.sap.developers.ims.Concepts.hdbmigrationtable`
Expected: `== version=1` and the full `VECTOR_EMBEDDING(... TUTORIALS_AICORE)` clause. NO `>>>>>` manual-resolution markers.

- [ ] **Step 3: Run the CI staging check locally**

Run: `npx tsx scripts/check-cds-build-staging.ts` (or the npm script that wraps it).
Expected: PASS — committed artifacts match a fresh build.

- [ ] **Step 4: Commit the baseline**

```bash
git add db/last-dev/ db/src/
git status  # confirm nothing under db/src/*.hdbmigrationtable or db/last-dev/ is left unstaged
git commit -m "build(kg): regenerate baseline for journaled Concepts (#2810)"
```

### Task 5: Hybrid test for the generated column contract

**Files:**
- Create/keep: `test/hybrid/concepts-dbside-embedding.hybrid.test.js` (exists from prior work)

**Interfaces:**
- Consumes: deployed generated column (runs only on DEV with `cds bind`).

- [ ] **Step 1: Confirm the hybrid test asserts the dispositive facts**

The test must: INSERT a Concepts row WITHOUT `embeddingVec` → read back non-null `REAL_VECTOR(1536)`; NULL/empty description → embeds name alone; cosine self-consistency ≈ 1.0. Self-skips on SQLite via `isSafeForWrites()`.

- [ ] **Step 2: Add an assertion that `GENERATION_TYPE` is non-null** (the check that would have caught this entire bug)

Query `SYS.TABLE_COLUMNS` for `EMBEDDINGVEC.GENERATION_TYPE`; assert it is non-null (`ALWAYS AS ...`). This is the regression guard for the silent-ignore bug.

- [ ] **Step 3: Commit** (`test(kg): assert embeddingVec is a generated column on HANA`).

### Task 6: Post-deploy KG rebuild runbook

**Files:**
- Create: `docs/developers/operations/kg-rebuild-after-concepts-migration.md`

**Interfaces:**
- Consumes: the deploy from Tasks 1-5. This is the operational sequence, not code — but it is REQUIRED; without it the KG stays empty.

- [ ] **Step 1: Document the exact ordered sequence**

1. Verify deploy green + `GENERATION_TYPE` non-null on live HANA (the Task 7 check).
2. **Enable KG**: set `KnowledgeGraphSettings.enabled=true` (admin UI, or UPSERT via `cds bind --exec`) OR env `KNOWLEDGE_GRAPH_ENABLED=true` on `tutorials-srv`. **Without this, every step below no-ops.**
3. Re-extract from corpus: `npm run kg:reextract` (cap 10000). Requires Tutorials populated + AICore bound. Mints Concepts + TutorialConceptLinks + ConceptEdges. Non-deterministic — fresh IDs.
4. Publish: `cds bind --exec -- node scripts/publish-top-concepts.js --commit` (sets `publishedAt`; read surfaces gate on it).
5. (Optional) hand-seed: `scripts/seed-sapphire-2026-concepts.js --commit`; definitions: `scripts/seed-concept-definitions.cjs --commit`.
6. Backfill `embedding` BLOB: let cron `concept-embedding-backfill` run (hourly) or trigger manually. `embeddingVec` needs no backfill (generated).
7. External links self-repair: the `fetch-*` jobs (videos, community-events, discovery-missions, devtoberfest, etc.) re-mint + re-link their ConceptLinks on next scheduled run once KG is enabled; trigger them manually to accelerate.
8. PageRank/WCC/consolidation crons settle the derived state over the following nights.

- [ ] **Step 2: Document rollback** — if the rebuild fails, the pre-deploy state is unrecoverable (tables dropped); the mitigation is to re-run extraction, not restore. Note this explicitly so the operator knows the drop is the point of no return and must only run when ready to complete the full rebuild.

- [ ] **Step 3: Commit** (`docs(kg): post-Concepts-migration KG rebuild runbook (#2810)`).

### Task 7: DEV deploy + end-to-end verification

**Interfaces:** Consumes everything. This is the gate for PROD-promotion readiness.

- [ ] **Step 1: Deploy to DEV** via deploy-watcher from fresh `origin/DEV` with this branch merged (or deploy the branch to DEV only for verification, per maintainer call). Confirm `cf target` = dev first.

- [ ] **Step 2: Assert deploy green + smoke gate passed.**

- [ ] **Step 3: THE dispositive check — `GENERATION_TYPE` non-null.**

Via fresh HANA service key: `SELECT GENERATION_TYPE, GENERATED_ALWAYS_AS FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME=? AND TABLE_NAME='COM_SAP_DEVELOPERS_IMS_CONCEPTS' AND COLUMN_NAME='EMBEDDINGVEC'`.
Expected: `GENERATION_TYPE` = `ALWAYS AS ...`, expression present. (Pre-fix this was `null`.)

- [ ] **Step 4: Run the post-deploy rebuild runbook (Task 6).** Enable KG → re-extract → publish → embed.

- [ ] **Step 5: Verify KG health.** Concepts row count > 0; a sample INSERT auto-populates `embeddingVec` (1536-dim); zero orphaned link rows (every dependent `concept_ID` resolves to a live Concepts row); `/build/concepts` responds without the #787 crash; a concept vector search returns coherent neighbours.

- [ ] **Step 6: Confirm `ChatSettings.enabled` still true + `cf target` still dev.**

- [ ] **Step 7: Report DEV-verified status + PROD-promotion readiness. PROD is a separate authorization.**
