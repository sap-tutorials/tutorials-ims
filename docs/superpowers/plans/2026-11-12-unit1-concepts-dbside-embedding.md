# Unit 1 — Concepts DB-Side Embedding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Populate `Concepts.embeddingVec` by HANA's own `VECTOR_EMBEDDING` (via `TUTORIALS_AICORE`) instead of the Node embedding client, on HANA profiles only, leaving SQLite/unit tests on the Node path.

**Architecture:** Add a HANA-only CDS `stored` calculated element that recomputes `embeddingVec` from `name`/`description` on every write (CAP compiles it to `GENERATED ALWAYS AS VECTOR_EMBEDDING(...)`). The Node concept-embedding backfill stops writing `embeddingVec` on HANA (a generated column rejects explicit writes) and continues writing only the legacy `embedding` BLOB; on SQLite it is unchanged. Behind a DB flag, DEV-first, with a one-shot re-embed-on-migrate to refresh the stale corpus (spike #3114).

**Tech Stack:** SAP CAP (`@sap/cds` 10.x), HANA Cloud Vector Engine (`VECTOR_EMBEDDING`, `REAL_VECTOR`), `TUTORIALS_AICORE` remote source, per-profile `cds.requires.db.model` dialect split (`db/hana` vs `db/sqlite`).

**Spec:** `docs/superpowers/specs/2026-11-12-hana-db-side-embeddings-design.md` (Unit 1); spike result on issue #3114.

## Global Constraints

- Embedding model/dim: **`text-embedding-3-small`, 1536-dim** — must match `ChatSettings.embeddingModel` default and the existing corpus. Spike proved HANA `VECTOR_EMBEDDING` and the Node path are cosine-identical for this model.
- HANA-only CDS goes under `db/hana/` (loaded only for `[hybrid]`/`[production]` via `cds.requires.db.model`); the SQLite/unit path stays on the Node writer. Never let the calc element reach the SQLite dialect.
- Never SELECT a HANA `REAL_VECTOR`/BLOB with `COUNT()` or alongside metadata via CDS QL — raw `db.run()` only (project gotcha).
- CAP calc-element rule: expression references same-row fields only; reproduce the Node text **byte-identically**: `[name, description].filter(Boolean).join(' — ')` → NULL/empty-safe SQL (drop empty parts, no NULL-propagation).
- `Vector` elements are not OData-exposable (already true; must stay true).
- Flag default **OFF**, DEV-first. Rollback = revert the `db/hana` calc element + restore the Node `embeddingVec` write.
- PR targets **DEV**.

## Review Focus

- **Generated-column write rejection:** once `embeddingVec` is `GENERATED ALWAYS AS`, any residual explicit `SET EMBEDDINGVEC = ...` on HANA (backfill, concept-mint path in `extract-concepts-job.js`/`fetch-teched-sessions-job.js` via `kg-merge-on-write`) throws. Task 2 + Task 4 tests must assert no HANA write path targets `embeddingVec`.
- **NULL/empty text parity:** a concept with `description` NULL or empty must embed `name` alone (Node drops empty parts); a bare `name || ' — ' || description` NULL-propagates to a NULL vector. Task 1 test pins the empty-description case.
- **Model-version string in DDL:** the calc element bakes a model string into DDL; if it doesn't resolve on `TUTORIALS_AICORE` the deploy/first-write fails. Task 1 verification runs the exact expression on DEV before committing to DDL.
- **Stale-corpus coexistence:** existing rows were embedded by an older model (0.828 self-sim, spike). After the flag flips, old rows and newly-generated rows differ until re-embedded. Task 5 owns the one-shot re-embed and asserts post-migrate self-similarity ≈ 1.0 on a sample.
- **Deploy-time remote-source access:** the HDI deploy identity creating the generated column needs `EXECUTE` on `TUTORIALS_AICORE` (spike ran as runtime identity). Task 3 verifies via an actual hybrid `cds deploy`/make-graph dry-run before the real deploy.

---

### Task 1: HANA-only stored calc element for `embeddingVec`

**Files:**
- Create: `db/hana/concepts-embedding.cds`
- Reference: `db/knowledge-graph.cds:23-36` (base `Concepts`, do not edit the base `embeddingVec` line — the HANA extend overrides persistence on HANA profiles only)

**Interfaces:**
- Produces: on HANA profiles, `Concepts.embeddingVec` is `GENERATED ALWAYS AS vector_embedding(<nullsafe name—description>, 'DOCUMENT', '<model.version>', TUTORIALS_AICORE)` — no longer client-writable.

- [ ] **Step 1: Verify the exact expression on DEV HANA before writing DDL**

Run (hybrid, against DEV `tutorials-hana`, as in spike #3114) the candidate null-safe expression and confirm non-null 1536-dim + cosine≈1.0 vs a freshly Node-embedded identical text:
```sql
VECTOR_EMBEDDING(
  TRIM(BOTH ' — ' FROM COALESCE(NAME,'') || CASE WHEN NAME IS NOT NULL AND DESCRIPTION IS NOT NULL THEN ' — ' ELSE '' END || COALESCE(DESCRIPTION,'')),
  'DOCUMENT', 'text-embedding-3-small', TUTORIALS_AICORE)
```
Expected: non-null `REAL_VECTOR`, dim 1536. Confirm the exact resolvable model-version string (bare `text-embedding-3-small` resolved in the spike; pin `.N` only if DDL requires it).

- [ ] **Step 2: Write the calc element**

In `db/hana/concepts-embedding.cds`, `using` the base `Concepts` from `../knowledge-graph` and `extend` it, replacing `embeddingVec` with a `stored` calc element using the Step-1-verified expression. Header-comment why (HANA-only; SQLite keeps the Node writer; byte-identical to `concept-embedding-backfill.js:116`).

- [ ] **Step 3: Verify it compiles for the HANA profile only**

Run: `cds compile db/ -2 sql --profile hybrid` → `embeddingVec` appears as a generated column.
Run: `cds compile db/ -2 sql` (development) → unchanged; no `vector_embedding` in SQLite DDL.
Expected: HANA DDL has `GENERATED ALWAYS AS`; dev/SQLite DDL does not.

- [ ] **Step 4: Commit**
```bash
git add db/hana/concepts-embedding.cds
git commit -m "feat(#2810): HANA stored calc element for Concepts.embeddingVec"
```

### Task 2: Stop the Node backfill writing `embeddingVec` on HANA

**Files:**
- Modify: `srv/jobs/concept-embedding-backfill.js` (HANA branch of the write, ~`:130-158`; `fetchCandidates` HANA query, `:49-58`)
- Test: nearest existing spec — follow the pattern of the job's current unit test (locate via `rg -l concept-embedding-backfill srv/**/__tests__`)

**Interfaces:**
- Consumes: Task 1's generated column (HANA writes to `embeddingVec` now fail).
- Produces: on HANA, backfill writes only `EMBEDDING` (legacy BLOB); `embeddingVec` is auto-maintained. On SQLite, backfill writes the BLOB as before (SQLite has no `embeddingVec` generated column; keep current behavior).

- [ ] **Step 1: Write the failing test**

Assert: when `isHana(db)` is true, the UPDATE statement the job issues contains `SET EMBEDDING = ?` and does **not** contain `EMBEDDINGVEC`. When false (SQLite), behavior unchanged. Mock `db.run` to capture SQL.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- <backfill test file>`
Expected: FAIL — current HANA UPDATE still sets `EMBEDDINGVEC = TO_REAL_VECTOR(?)`.

- [ ] **Step 3: Remove the `EMBEDDINGVEC` assignment from the HANA UPDATE**

Drop `EMBEDDINGVEC = TO_REAL_VECTOR(?)` (and its param) from the HANA branch only; keep `EMBEDDING = ?`. Adjust `fetchCandidates` HANA predicate so it no longer treats `EMBEDDINGVEC IS NULL` as a reason to re-embed (the generated column is never NULL for valid text) — select on `EMBEDDING IS NULL` only.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- <backfill test file>` → PASS.

- [ ] **Step 5: Commit**
```bash
git add srv/jobs/concept-embedding-backfill.js <test file>
git commit -m "feat(#2810): backfill stops writing embeddingVec on HANA (generated column)"
```

### Task 3: Audit + fix other HANA write paths touching `embeddingVec`

**Files:**
- Inspect/modify: concept-mint write paths — `srv/jobs/extract-concepts-job.js:270-286`, `srv/jobs/fetch-teched-sessions-job.js:222-236`, and their shared `kg-merge-on-write` `resolveConceptCandidates` (locate exact file via `rg -l resolveConceptCandidates srv`)
- Test: the kg-merge-on-write unit test (locate via `rg -l kg-merge-on-write srv/**/__tests__`)

**Interfaces:**
- Consumes: Task 1's generated column.
- Produces: no HANA code path issues an explicit `embeddingVec` write.

- [ ] **Step 1: Find every `embeddingVec`/`EMBEDDINGVEC` write**

Run: `rg -n "EMBEDDINGVEC|embeddingVec" srv/ --type js` — enumerate writers vs readers. Readers (`concept-embedding-query.js`, `semantic-search.js`) are untouched.

- [ ] **Step 2: Write the failing test**

For each HANA writer found, assert it no longer emits an `embeddingVec` assignment under `isHana`. (If Step 1 shows the mint path only writes the BLOB and lets backfill fill the vector, assert that and note no code change needed.)

- [ ] **Step 3: Run test to verify it fails (or passes with no-change-needed)**

Run: `npm test -- <kg-merge test>`. If it already passes, record in the task that no mint-path change was required and skip to Task 4.

- [ ] **Step 4: Remove any remaining HANA `embeddingVec` writes**

- [ ] **Step 5: Run tests → PASS. Commit.**
```bash
git commit -am "fix(#2810): no HANA path writes generated embeddingVec column"
```

### Task 4: DEV deploy dry-run (make-graph + remote-source access)

**Decision (fixed):** **No runtime flag.** The generated column can't be runtime-toggled, so rollout is deploy-gated: deploy `db/hana/concepts-embedding.cds` to DEV only; "enable on PROD" = deploy the `.cds` to PROD; rollback = revert the `.cds` + redeploy. The Node backfill's legacy BLOB write (Task 2) is the behavior on every env; only the `embeddingVec` source changes where the `.cds` is deployed.

**Files:** none changed in this task — it is a verification gate.

**Interfaces:**
- Consumes: Tasks 1-3.

- [ ] **Step 1: Hybrid make-graph dry-run on DEV**

Run a hybrid `cds deploy --dry` / `cds build --production` against DEV `tutorials-hana` and confirm the generated column's make-graph succeeds — i.e. the deploy identity can create a column that calls `TUTORIALS_AICORE` (design Q1). If it fails on remote-source access at deploy, STOP and surface — grant parity with the runtime `external_privileges_role` is then required.
Expected: make-graph succeeds; no `TUTORIALS_AICORE` access error.

### Task 5: One-shot re-embed on migrate + hybrid verification test

**Files:**
- Create: a thin hybrid test `test/hybrid/concepts-dbside-embedding.hybrid.test.js` (pattern: existing `test:hybrid` specs)
- Reference: re-embed is achieved simply by touching rows (any UPDATE recomputes the generated column) or `CREATE_VECTOR_EMBEDDINGS`/a no-op UPDATE of `name` — executor picks per existing migration conventions.

**Interfaces:**
- Consumes: deployed Task 1 column on DEV.

- [ ] **Step 1: Write the hybrid test**

Assert (via `cds bind --exec`, real HANA): (a) inserting/updating a Concept row yields a non-null 1536-dim `embeddingVec`; (b) its cosine vs a freshly Node-embedded identical text ≈ 1.0 (±1e-3); (c) a NULL-description row embeds `name` alone and is non-null.

- [ ] **Step 2: Run against DEV**

Run: `npm run test:hybrid -- concepts-dbside-embedding` (requires `cf login` DEV). Expected: PASS.

- [ ] **Step 3: Re-embed existing rows**

Trigger a no-op UPDATE across ACTIVE+published Concepts so the generated column refreshes the stale corpus (spike: old rows at 0.828). Verify a sample now self-matches ≈1.0.

- [ ] **Step 4: Commit**
```bash
git add test/hybrid/concepts-dbside-embedding.hybrid.test.js
git commit -m "test(#2810): hybrid proof of DB-side Concepts embedding + corpus re-embed"
```

### Task 6: Docs + runbook note

**Files:**
- Modify: `docs/developers/operations/hana-aicore-embeddings.md` (Appendix 1 — mark Concepts as the first feature moved DB-side, with the enable/rollback + re-embed steps)
- Modify: the Unit 1 section of the design doc — mark shipped.

- [ ] **Step 1:** Write the enable/rollback runbook entry (deploy `db/hana/concepts-embedding.cds`, re-embed, verify; rollback = revert + restore Node dual-write). Commit.
