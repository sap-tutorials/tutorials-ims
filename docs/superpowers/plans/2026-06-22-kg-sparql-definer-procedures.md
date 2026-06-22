# KG SPARQL DEFINER procedures — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all `CALL SYS.SPARQL_EXECUTE(...)` invocations behind 4 HDI `.hdbprocedure` artefacts declared `SQL SECURITY DEFINER`, so SPARQL calls execute as the HDI container's stable object-owner identity instead of per-binding runtime users. Eliminates the per-graph ACL pinning that has forced 2+ IRI bumps in 2 days.

**Architecture:** 4 procedures (`KG_GRAPH_CLEAR`, `KG_GRAPH_INSERT`, `KG_QUERY`, `KG_ADMIN_RUNSPARQL`) own all SPARQL assembly from typed parameters. A rewritten `srv/lib/kg-sparql-client.js` exports 4 typed functions that `CALL` the procedures positionally. All callers (`kg-graph-rebuild.js`, `knowledge-graph-service.js`) migrate to the typed API in the same PR — no adapter layer. SPARQL template strings in `kg-queries.js` are deleted; the procedure bodies become the single source of truth. QA channel gets stub procedures that `SIGNAL` so accidental calls fail loud.

**Tech Stack:** HANA Cloud HDI (`.hdbprocedure`, `.hdbgrants`), SAP CAP Node.js (`@sap/cds`), Vitest (unit + hybrid), CF Cloud Foundry deploy.

**Spec:** [`docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md`](../specs/2026-06-22-kg-sparql-definer-procedures-design.md)

---

## Pre-flight

Before starting, confirm:

- You're on branch `feat/kg-sparql-definer-procedures` (created during brainstorming)
- `git status` is clean (the spec commit `d80939fb` is on this branch)
- `cf target` is `tutorial-system/dev` (don't probe HANA without confirming this — wrong target = wrong HANA per memory `feedback_cf_target_before_push`)
- `npm test` currently passes (sanity baseline; you'll modify some of these tests)

---

## Discoveries from Task 1 implementation (read before Tasks 2-9)

Task 1 (`KG_GRAPH_CLEAR`) was implemented on 2026-06-22 against DEV HANA. Five HANA-Cloud-specific facts that diverge from the plan's original code samples — all subsequent procedure tasks must follow these corrections:

### 1. `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '...'` does NOT compile

HANA Cloud SQLScript rejects the bare `SQLSTATE` form. Use the CONDITION pattern instead:

```sql
DECLARE KG_INVALID_IRI CONDITION FOR SQL_ERROR_CODE 10001;
-- ... later, when you want to raise:
SIGNAL KG_INVALID_IRI;
```

**Error codes are in the user-defined range 10000-19999.** Each procedure should use a distinct error code so JS callers can distinguish (Task 1 used 10001 for `KG_INVALID_IRI`, 10002 for `KG_NOT_AVAILABLE_ON_QA` in the QA stub). JS-side detection: `err.code === 10001` (the numeric code propagates through the driver).

**Task 2/3/4 error-code assignments:**

| Procedure | Condition name | Code |
|---|---|---|
| `KG_GRAPH_CLEAR` | `KG_INVALID_IRI` | `10001` (in use) |
| QA stub (all 4 procs) | `KG_NOT_AVAILABLE_ON_QA` | `10002` (in use) |
| `KG_GRAPH_INSERT` | `KG_INVALID_IRI` | `10001` (reuse) |
| `KG_GRAPH_INSERT` | `KG_EMPTY_TRIPLES` | `10003` |
| `KG_GRAPH_INSERT` | `KG_TRIPLES_INVALID` | `10004` |
| `KG_QUERY` | `KG_UNKNOWN_QUERY` | `10005` |
| `KG_QUERY` | `KG_INVALID_TUTORIAL_IRI` | `10006` |
| `KG_QUERY` | `KG_INVALID_USER_ID` | `10007` |
| `KG_ADMIN_RUNSPARQL` | `KG_EMPTY_SPARQL` | `10008` |
| `KG_ADMIN_RUNSPARQL` | `KG_INVALID_IS_UPDATE_FLAG` | `10009` |

### 2. `CALL SYS.SPARQL_EXECUTE(...)` is rejected in DEFINER procedures (cross-schema)

HDI refuses cross-schema references in DEFINER-security procedures. Workaround already shipped in Task 1: `db/src/SYS_SPARQL_EXECUTE.hdbsynonym` resolves `SYS_SPARQL_EXECUTE` → `SYS.SPARQL_EXECUTE`, and `db/src/.hdiconfig` registers the `hdbsynonym` plugin. **All procedure bodies in Tasks 2-4 must use `CALL SYS_SPARQL_EXECUTE(...)` (the synonym), NOT `CALL SYS.SPARQL_EXECUTE(...)`.** Same applies to the QA stubs (though they won't reach the CALL — they just SIGNAL).

The synonym + .hdiconfig entry are already on `feat/kg-sparql-definer-procedures` from Task 1's commit `422c61e7`. Tasks 2-4 don't need to re-add them.

### 3. `application_user.schema_privileges.EXECUTE` in `_grants.hdbgrants` was NOT needed

The plan's Step 5 in Task 1 asked for `"schema_privileges": [{ "privileges": ["EXECUTE"] }]` under `application_user`. The implementer omitted it; HDI's `default_access_role` auto-grants EXECUTE on all container-owned procedures to bound runtime users. Verified empirically: the hybrid test's `cds bind --exec` user (which has zero explicit privileges on `KG_GRAPH_CLEAR` per `SYS.GRANTED_PRIVILEGES`) successfully invokes the procedure. **Tasks 2-4 should NOT add `schema_privileges.EXECUTE` to the grants files.**

### 4. `object_owner.system_privileges.SPARQL_*` IS required

Because the procedure runs `SQL SECURITY DEFINER`, the body executes as the HDI container's object-owner (`#OO`). `#OO` needs its own `SPARQL QUERY` / `SPARQL UPDATE` system privileges. **This addition is already in both `_grants.hdbgrants` files** (committed in Task 1's `422c61e7`); Tasks 2-4 don't need to re-add it.

The grants file shape after Task 1 (for reference):

```json
{
  "tutorials-kg-grantor": {
    "application_user": {
      "system_privileges": [
        { "privileges": ["SPARQL QUERY", "SPARQL UPDATE"] }
      ]
    },
    "object_owner": {
      "system_privileges": [
        { "privileges": ["SPARQL QUERY", "SPARQL UPDATE"] }
      ]
    }
  }
}
```

### 5. `db.run('CALL <proc>(?, ?, ?)', [...args, null, null])` does NOT work for OUT params

The `@cap-js/hana` driver does not support OUT-param binding via `db.run`. Wrap every CALL in a `DO BEGIN ... END` block (matches the existing pattern in `scripts/spike/kg-probe.cjs:146-180` and `srv/lib/kg-sparql-client.js`'s legacy `SPARQL_DO_BLOCK`). For example, calling `KG_GRAPH_CLEAR(graph_iri, response, headers)`:

```js
const DO_CALL = `DO (IN p NVARCHAR(500) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_GRAPH_CLEAR(:p, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;
const rows = await db.run(DO_CALL, [graphIri]);
// rows = [{ RESPONSE: '...', HEADERS: '...' }]
```

**Impact on Tasks 6 and the hybrid tests:**

- The JS-side typed client in Task 6 (`srv/lib/kg-sparql-client.js`'s `callProcedure` private) must build per-procedure DO-block wrappers, NOT issue `db.run('CALL "<procname>"(?, ?, ?, ?)', [...inArgs, null, null])` as Task 6's original sketch said. Tasks 2-4's hybrid tests use this DO-block pattern; copy that pattern into the JS client.
- A reasonable approach in Task 6: a private `wrapInDoBlock(procName, inArgTypes)` helper that generates the DO block per procedure shape. Or: just hard-code the 4 DO blocks (one per procedure) since there are only 4 — YAGNI on the generic builder.

### Additional notes

- **Happy-path test for `KG_GRAPH_CLEAR`** is intentionally weak (asserts `not.toMatchObject({ code: 328 })` — anything OTHER than "procedure not found"). This is because the test seeds the graph via raw `application_user`-bound SPARQL, then calls the procedure which runs as `#OO`; the actual CLEAR fails due to the very ACL collision the design is fixing. The test has a TODO comment marked for Task 2 — once `KG_GRAPH_INSERT` is deployed, update the happy path to use `KG_GRAPH_INSERT` for the seed (so the seed comes from `#OO`), then `KG_GRAPH_CLEAR` succeeds. **Task 2 implementer: tighten this test.**

- **Deploy speed:** Task 1 took ~7 attempts to land due to the iterative discovery of these 5 issues. Tasks 2-4 should each take 1 attempt now that the corrections are documented here. If a task hits a new HANA-syntax wall not listed above, STOP and report — don't loop on iterations.

---

## Task 0: Set up the procedures directory structure

**Files:**
- Create: `db/src/procedures/.gitkeep` (empty)
- Create: `db-qa/src/procedures/.gitkeep` (empty)

**Why a separate directory:** Keeps the 4 procedure files together and discoverable, rather than scattered alongside the 50+ `.hdbmigrationtable` files in `db/src/`. HDI's plugin matching is file-suffix-based; subdirectories under `src/` are fine.

- [ ] **Step 1: Create the prod-channel directory**

```bash
mkdir -p db/src/procedures
touch db/src/procedures/.gitkeep
```

- [ ] **Step 2: Create the QA-channel directory**

```bash
mkdir -p db-qa/src/procedures
touch db-qa/src/procedures/.gitkeep
```

- [ ] **Step 3: Verify HDI plugin is registered for `.hdbprocedure`**

Check both `.hdiconfig` files include the procedure plugin (they should already — see `.deploy/mta.yaml:22-23` which patches them at deploy time, but the static files matter for local `cds build`).

```bash
cat db/src/.hdiconfig | grep -A 2 hdbprocedure
cat db-qa/src/.hdiconfig | grep -A 2 hdbprocedure
```

Expected: both show `"plugin_name": "com.sap.hana.di.procedure"`. If a file is missing the entry, add it via `jq` (mirror the mta.yaml lines).

- [ ] **Step 4: Commit the empty directories**

```bash
git add db/src/procedures/.gitkeep db-qa/src/procedures/.gitkeep
git commit -m "chore(kg): create procedures/ directories for #533 follow-up

Prep work for the 4 SPARQL DEFINER procedures. The directories
hold the .hdbprocedure files added in subsequent tasks. Prod
versions under db/src/procedures/; QA stubs under db-qa/src/procedures/.

See docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
for the design.

Refs #533."
```

---

## Task 1: `KG_GRAPH_CLEAR` procedure (TDD via hybrid test)

**Files:**
- Create: `db/src/procedures/KG_GRAPH_CLEAR.hdbprocedure`
- Create: `db-qa/src/procedures/KG_GRAPH_CLEAR.hdbprocedure` (stub)
- Modify: `db/src/_grants.hdbgrants` (add object_privileges block)
- Modify: `db-qa/src/_grants.hdbgrants` (same)
- Test (hybrid): `test/hybrid/kg-procedures-graph-ops.test.js` (NEW — will hold tests for CLEAR + INSERT)

**Why first:** `KG_GRAPH_CLEAR` is the simplest of the four (one IRI input, no NCLOB params, one validation pass). Establishes the file-naming, IRI-validation, and grant pattern the other three reuse. TDD via hybrid test because we can't unit-test SQLScript without a HANA harness.

- [ ] **Step 1: Write the failing hybrid test**

Create `test/hybrid/kg-procedures-graph-ops.test.js` with 3 describe-it blocks:

1. Happy path: seed a graph via raw SPARQL, call `CALL KG_GRAPH_CLEAR(?, ?, ?)` with a valid `urn:test:...` IRI, assert no error
2. Invalid IRI rejection: call with `'not-an-iri'`, assert throws containing `KG_INVALID_IRI`
3. Over-length IRI: call with a 501-char IRI, assert same rejection

The test uses a per-run `urn:test:kg-procs:<timestamp>-<rand>` IRI so parallel runs don't collide. `beforeAll` seeds the graph via raw `DO BEGIN CALL SYS.SPARQL_EXECUTE ... END` (NOT via the procedure under test); `afterAll` does best-effort cleanup the same way.

Set `process.env.ALLOW_HYBRID_WRITES = 'true'` in `beforeAll` to pass the write-safety guard (see `test/hybrid/_guard.js`).

- [ ] **Step 2: Run test, verify FAIL**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-procedures-graph-ops.test.js
```

Expected: all 3 tests fail with `invalid procedure name: KG_GRAPH_CLEAR` or equivalent.

- [ ] **Step 3: Write the procedure body**

Create `db/src/procedures/KG_GRAPH_CLEAR.hdbprocedure`:

```sql
PROCEDURE KG_GRAPH_CLEAR (
  IN graph_iri NVARCHAR(500),
  OUT response NCLOB,
  OUT headers NVARCHAR(5000)
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  DECLARE iri_ok INTEGER;
  DECLARE sparql NCLOB;

  -- Validate IRI shape: http(s) or urn:; safe-chars only; length 1-500.
  -- LIKE_REGEXPR returns 1 on match. Two separate checks (http/https vs
  -- urn:) are clearer than one combined regex.
  iri_ok := 0;
  IF :graph_iri LIKE_REGEXPR '^https?://[A-Za-z0-9./_-]+$' OR
     :graph_iri LIKE_REGEXPR '^urn:[A-Za-z0-9:_-]+$' THEN
    iri_ok := 1;
  END IF;
  IF iri_ok = 0 OR LENGTH(:graph_iri) < 1 OR LENGTH(:graph_iri) > 500 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_INVALID_IRI';
  END IF;

  sparql := 'CLEAR GRAPH <' || :graph_iri || '>';
  CALL SYS.SPARQL_EXECUTE(:sparql, '', response, headers);
END;
```

Add a header comment block above `PROCEDURE` (per the codebase convention) explaining:
- Why DEFINER (per-graph ACL elimination — link to memory `hana_sparql_per_graph_acl_creator_owns`)
- The spec path
- That QA has a stub with the same signature

- [ ] **Step 4: Write the QA stub**

Create `db-qa/src/procedures/KG_GRAPH_CLEAR.hdbprocedure` with identical signature but body:

```sql
PROCEDURE KG_GRAPH_CLEAR (
  IN graph_iri NVARCHAR(500),
  OUT response NCLOB,
  OUT headers NVARCHAR(5000)
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_NOT_AVAILABLE_ON_QA';
END;
```

Header should reference the spec's `## QA channel` section.

- [ ] **Step 5: Grant EXECUTE — edit `db/src/_grants.hdbgrants` AND `db-qa/src/_grants.hdbgrants`**

The grants file currently grants `SPARQL QUERY` + `SPARQL UPDATE` to `application_user`. Add an `object_owner.schema_privileges.EXECUTE` block so the grantor passes EXECUTE on the schema's procedures to `default_access_role`:

```json
{
    "tutorials-kg-grantor": {
        "application_user": {
            "system_privileges": [
                { "privileges": ["SPARQL QUERY", "SPARQL UPDATE"] }
            ],
            "schema_privileges": [
                { "privileges": ["EXECUTE"] }
            ]
        }
    }
}
```

Mirror in `db-qa/src/_grants.hdbgrants` with the grantor name `tutorials-kg-grantor-qa`. The `application_user` key targets the role the HDI runtime users inherit; `schema_privileges.EXECUTE` lets them call any procedure in the schema, including our 4.

- [ ] **Step 6: Run `cds build --production`**

```bash
npx cds build --production
```

Expected: builds without errors. The new procedure files copy into `gen/db/src/procedures/`. Verify:

```bash
ls gen/db/src/procedures/
```

Expected output: `KG_GRAPH_CLEAR.hdbprocedure` exists.

- [ ] **Step 7: Deploy db-deployer only (fast path)**

Per memory `feedback-cf-push-db-deployer-fast-path`, schema-only changes can skip `mbt build`:

```bash
cf push tutorials-db-deployer -f .deploy/manifest.yml || \
  (cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f --module tutorials-db-deployer)
```

Verify the deploy task succeeded:

```bash
cf tasks tutorials-db-deployer | head -3
```

Expected: the newest row shows `state: SUCCEEDED`.

- [ ] **Step 8: Re-run the hybrid test — expect PASS**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-procedures-graph-ops.test.js
```

Expected: 3/3 pass. If the happy-path test fails with "User is not allowed to perform this action - (EXECUTE)", the grants didn't apply — re-check step 5 + step 7.

- [ ] **Step 9: Commit**

```bash
git add db/src/procedures/KG_GRAPH_CLEAR.hdbprocedure \
        db-qa/src/procedures/KG_GRAPH_CLEAR.hdbprocedure \
        db/src/_grants.hdbgrants db-qa/src/_grants.hdbgrants \
        test/hybrid/kg-procedures-graph-ops.test.js
git commit -m "feat(kg): KG_GRAPH_CLEAR DEFINER procedure + grants (#533)

First of 4 SPARQL DEFINER procedures from the Phase 1.5 design spec.
Runs as HDI container object-owner regardless of which binding called
it; eliminates the per-graph ACL pin documented in memory
hana_sparql_per_graph_acl_creator_owns.

QA gets a SIGNAL '45000' KG_NOT_AVAILABLE_ON_QA stub (same signature)
so srv-qa code compiles against the same JS client.

Tests: 3 hybrid tests against real HANA — happy path + 2 invalid-IRI
rejection paths.

Refs #533, #525, #381."
```

---

## Task 2: `KG_GRAPH_INSERT` procedure

> **⚠ Read `## Discoveries from Task 1 implementation` first (top of plan).** The code samples in this task's Step 3 below still show the original (incorrect) `SIGNAL SQLSTATE` form and `CALL SYS.SPARQL_EXECUTE` — both have been corrected in Task 1's actual code. Use the corrections from the Discoveries section: `DECLARE <cond> CONDITION FOR SQL_ERROR_CODE <n>; SIGNAL <cond>;` and `CALL SYS_SPARQL_EXECUTE(...)`. Step 5 (grants) is now a no-op — grants are already in place from Task 1.

**Files:**
- Create: `db/src/procedures/KG_GRAPH_INSERT.hdbprocedure`
- Create: `db-qa/src/procedures/KG_GRAPH_INSERT.hdbprocedure` (stub)
- Modify: `test/hybrid/kg-procedures-graph-ops.test.js` (add CLEAR-of-INSERT-created-graph test)

**Why second:** INSERT is the operation that creates the graph (via implicit-create). Pairing it with CLEAR proves the full create + wipe cycle works through the procedure layer — which is the proof the design exists for. Tests stay in the same hybrid file as Task 1 so the CLEAR + INSERT round-trip can share fixtures.

- [ ] **Step 1: Write the failing hybrid tests**

Append to `test/hybrid/kg-procedures-graph-ops.test.js`:

1. Happy path: call `KG_GRAPH_INSERT` against a fresh `urn:test:...` IRI with a single N-Triples line; assert no error. Then call `KG_GRAPH_CLEAR` (the procedure from Task 1) — proves the same procedure layer can both create and wipe.
2. Invalid IRI rejection: call with `'not-an-iri'` and valid triples; expect `KG_INVALID_IRI`.
3. Empty triples rejection: call with valid IRI but `''` for triples; expect `KG_EMPTY_TRIPLES`.
4. Defensive `} }` rejection: call with triples containing `<a> <b> <c> . } } DROP GRAPH <evil>`; expect `KG_TRIPLES_INVALID`.

- [ ] **Step 2: Run, verify FAIL**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-procedures-graph-ops.test.js
```

Expected: the 4 new tests fail with `invalid procedure name: KG_GRAPH_INSERT`. The 3 CLEAR tests from Task 1 continue to pass.

- [ ] **Step 3: Write the procedure**

Create `db/src/procedures/KG_GRAPH_INSERT.hdbprocedure`:

```sql
PROCEDURE KG_GRAPH_INSERT (
  IN graph_iri NVARCHAR(500),
  IN triples NCLOB,
  OUT response NCLOB,
  OUT headers NVARCHAR(5000)
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  DECLARE iri_ok INTEGER;
  DECLARE sparql NCLOB;
  DECLARE triples_len BIGINT;

  -- Same IRI validation as KG_GRAPH_CLEAR (intentionally duplicated — HANA
  -- SQLScript doesn't have a clean shared-helper mechanism inside .hdbprocedure
  -- files. Repeating ~6 lines is cheaper than introducing a fifth procedure.)
  iri_ok := 0;
  IF :graph_iri LIKE_REGEXPR '^https?://[A-Za-z0-9./_-]+$' OR
     :graph_iri LIKE_REGEXPR '^urn:[A-Za-z0-9:_-]+$' THEN
    iri_ok := 1;
  END IF;
  IF iri_ok = 0 OR LENGTH(:graph_iri) < 1 OR LENGTH(:graph_iri) > 500 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_INVALID_IRI';
  END IF;

  triples_len := LENGTH(:triples);
  IF triples_len IS NULL OR triples_len = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_EMPTY_TRIPLES';
  END IF;

  -- Defensive: reject any '} }' substring (escape-the-INSERT-DATA-block guard).
  -- JS-side N-Triples generator never emits '} }'; this is belt-and-suspenders.
  IF :triples LIKE '%} }%' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_TRIPLES_INVALID';
  END IF;

  sparql := 'INSERT DATA { GRAPH <' || :graph_iri || '> { ' || :triples || ' } }';
  CALL SYS.SPARQL_EXECUTE(:sparql, '', response, headers);
END;
```

- [ ] **Step 4: Write the QA stub** — identical signature, `SIGNAL '45000' SET MESSAGE_TEXT = 'KG_NOT_AVAILABLE_ON_QA'`.

- [ ] **Step 5: `cds build --production`**, verify file lands under `gen/db/src/procedures/`.

- [ ] **Step 6: Deploy db-deployer only** (same fast-path approach as Task 1, step 7).

- [ ] **Step 7: Re-run the hybrid test — expect 7/7 PASS**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-procedures-graph-ops.test.js
```

The 3 CLEAR tests + 4 INSERT tests all pass.

- [ ] **Step 8: Commit**

```bash
git add db/src/procedures/KG_GRAPH_INSERT.hdbprocedure \
        db-qa/src/procedures/KG_GRAPH_INSERT.hdbprocedure \
        test/hybrid/kg-procedures-graph-ops.test.js
git commit -m "feat(kg): KG_GRAPH_INSERT DEFINER procedure (#533)

Second of 4 SPARQL DEFINER procedures. Implicit-creates the named
graph as the HDI object-owner — pairs with KG_GRAPH_CLEAR (Task 1)
for the full bootstrap+wipe cycle that graphRebuild() needs.

Validations: same IRI shape rules as KG_GRAPH_CLEAR + non-empty
triples + defensive '} }' rejection (escape-the-INSERT-DATA-block
guard; JS-side generator never emits it but the procedure is
belt-and-suspenders).

Tests: 4 new hybrid tests bring the file to 7 passing.

Refs #533, #381."
```

---

## Task 3: `KG_QUERY` dispatcher procedure

> **⚠ Read `## Discoveries from Task 1 implementation` first (top of plan).** The code samples in this task's Step 3 below still show the original (incorrect) `SIGNAL SQLSTATE` form and `CALL SYS.SPARQL_EXECUTE` — both have been corrected in Task 1's actual code. Use the corrections from the Discoveries section: `DECLARE <cond> CONDITION FOR SQL_ERROR_CODE <n>; SIGNAL <cond>;` and `CALL SYS_SPARQL_EXECUTE(...)`. Use the error-code assignments from the Discoveries table (10005-10007 for this procedure's conditions). No grants changes needed in this task.

**Files:**
- Create: `db/src/procedures/KG_QUERY.hdbprocedure`
- Create: `db-qa/src/procedures/KG_QUERY.hdbprocedure` (stub)
- Test (hybrid): `test/hybrid/kg-procedures-query.test.js` (NEW)

**Why a dispatcher:** Spec § "The 4 procedures" specifies a CASE-on-query-name dispatch so adding a 4th named query is one procedure edit instead of one new procedure. The trade-off is a single ~120-line procedure body vs three smaller ones; we picked the dispatcher (Approach 1 from brainstorming).

**Source SPARQL strings to migrate:** `srv/lib/kg-queries.js:237` (NEIGHBORHOOD_QUERY), `:284` (PATH_BETWEEN_QUERY), `:299` (CONCEPTS_FOR_USER_QUERY). Copy verbatim; only the `$SLUG`/`$FROM_SLUG`/`$TO_SLUG`/`$USER_ID` placeholders get rewritten as `' || :p1 || '` etc. The hardcoded `FROM <https://developers.sap.com/kg/tutorials-v2>` becomes:

```sql
'FROM <' || COALESCE(:override_graph_iri, 'https://developers.sap.com/kg/tutorials-v2') || '>'
```

- [ ] **Step 1: Write the failing hybrid tests**

Create `test/hybrid/kg-procedures-query.test.js`. Test cases:

1. **Unknown query rejection**: `CALL KG_QUERY('BOGUS', 'x', null, null, null, ?, ?)` → expect `KG_UNKNOWN_QUERY`
2. **NEIGHBORHOOD with valid tutorial IRI**: seed a tiny TEST graph (`urn:test:kg-query:<run>`) via raw SPARQL with one tutorial + one concept + one `kg:teaches` triple; call `KG_QUERY('NEIGHBORHOOD', '<full-tutorial-iri>', null, null, '<test-graph-iri>', ?, ?)`; assert `response` is non-empty JSON containing the concept
3. **NEIGHBORHOOD rejects invalid tutorial IRI**: call with `'http://evil.example.com/x'`; expect `KG_INVALID_TUTORIAL_IRI`
4. **PATH_BETWEEN smoke**: same TEST graph, call `KG_QUERY('PATH_BETWEEN', '<from-iri>', '<to-iri>', null, '<test-graph-iri>', ?, ?)`; assert no error (full path-finding logic is out of scope — just dispatch correctness)
5. **CONCEPTS_FOR_USER smoke**: call `KG_QUERY('CONCEPTS_FOR_USER', '<user-uuid>', null, null, '<test-graph-iri>', ?, ?)`; assert no error

Use a fresh `urn:test:kg-query:<timestamp>-<rand>` graph per test run, seeded in `beforeAll`, cleared in `afterAll`.

- [ ] **Step 2: Run, verify FAIL** (procedure doesn't exist yet)

- [ ] **Step 3: Write the procedure**

Create `db/src/procedures/KG_QUERY.hdbprocedure`. Structure:

```sql
PROCEDURE KG_QUERY (
  IN query_name NVARCHAR(50),
  IN p1 NVARCHAR(500),
  IN p2 NVARCHAR(500),
  IN p3 NVARCHAR(500),
  IN override_graph_iri NVARCHAR(500),
  OUT response NCLOB,
  OUT headers NVARCHAR(5000)
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  DECLARE sparql NCLOB;
  DECLARE from_clause NVARCHAR(550);

  -- Default graph IRI when override is NULL. The hardcoded value MUST
  -- stay in sync with srv/lib/kg-graph-rebuild.js DEFAULT_GRAPH_IRI.
  from_clause := 'FROM <' ||
    COALESCE(:override_graph_iri, 'https://developers.sap.com/kg/tutorials-v2') ||
    '>';

  CASE :query_name
    WHEN 'NEIGHBORHOOD' THEN
      -- Per-branch validation: p1 must be the tutorial-IRI form.
      IF :p1 IS NULL OR
         NOT (:p1 LIKE_REGEXPR '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_INVALID_TUTORIAL_IRI';
      END IF;
      sparql :=
        'PREFIX kg: <https://developers.sap.com/kg/>' || CHAR(10) ||
        'SELECT DISTINCT ?type ?targetSlug ?targetLabel ?weight' || CHAR(10) ||
        from_clause || CHAR(10) ||
        /* ... rest of NEIGHBORHOOD_QUERY body from kg-queries.js:237-281,
           with every '<https://developers.sap.com/kg/tutorial/$SLUG>' rewritten
           as '<' || :p1 || '>' (no inner string concat — :p1 already includes
           the IRI prefix because JS pre-built it via iriTutorial(slug)) */
        '...';

    WHEN 'PATH_BETWEEN' THEN
      -- p1 = fromSlug-as-IRI, p2 = toSlug-as-IRI. Same shape validator.
      IF :p1 IS NULL OR
         NOT (:p1 LIKE_REGEXPR '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$') OR
         :p2 IS NULL OR
         NOT (:p2 LIKE_REGEXPR '^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_INVALID_TUTORIAL_IRI';
      END IF;
      sparql := /* PATH_BETWEEN_QUERY from kg-queries.js:284-298, similar rewrite */ '...';

    WHEN 'CONCEPTS_FOR_USER' THEN
      -- p1 = userId UUID. Use the existing UUID regex from kg-queries.js.
      IF :p1 IS NULL OR
         NOT (:p1 LIKE_REGEXPR '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') THEN
        SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_INVALID_USER_ID';
      END IF;
      sparql := /* CONCEPTS_FOR_USER_QUERY from kg-queries.js:299-307 */ '...';

    ELSE
      SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_UNKNOWN_QUERY';
  END CASE;

  CALL SYS.SPARQL_EXECUTE(:sparql, '', response, headers);
END;
```

**Important details when writing the procedure body:**

- Copy `NEIGHBORHOOD_QUERY`, `PATH_BETWEEN_QUERY`, `CONCEPTS_FOR_USER_QUERY` verbatim from `srv/lib/kg-queries.js`. Don't paraphrase.
- HANA SQLScript string literals use single quotes; the SPARQL bodies contain none of their own (verify before pasting). If they do, double the single-quotes per SQL syntax.
- The `from_clause` is built ONCE at the top; each branch concatenates it via `' || from_clause || '`.
- `:p1` for NEIGHBORHOOD is the FULL tutorial IRI (JS-side built via `iriTutorial(slug)`). Per spec § "JS-side typed client" and brainstorming option (y), the procedure does NOT re-assemble from a slug.

- [ ] **Step 4: Write the QA stub** — `SIGNAL '45000' KG_NOT_AVAILABLE_ON_QA`.

- [ ] **Step 5: `cds build --production`** + verify file lands.

- [ ] **Step 6: Deploy db-deployer only.**

- [ ] **Step 7: Re-run the new hybrid test — expect 5/5 PASS**

If the NEIGHBORHOOD test fails with a SPARQL parser error, the most likely cause is a stray single-quote in the copied query body that wasn't doubled.

- [ ] **Step 8: Commit**

```bash
git add db/src/procedures/KG_QUERY.hdbprocedure \
        db-qa/src/procedures/KG_QUERY.hdbprocedure \
        test/hybrid/kg-procedures-query.test.js
git commit -m "feat(kg): KG_QUERY dispatcher DEFINER procedure (#533)

Third of 4 SPARQL DEFINER procedures. Dispatches NEIGHBORHOOD /
PATH_BETWEEN / CONCEPTS_FOR_USER via CASE on :query_name. SPARQL
bodies copied verbatim from kg-queries.js (to be deleted in a
later task). Per-branch validation rejects malformed inputs with
KG_INVALID_TUTORIAL_IRI or KG_INVALID_USER_ID; unknown query names
get KG_UNKNOWN_QUERY.

The override_graph_iri parameter lets hybrid tests target a TEST
graph instead of the hardcoded prod IRI (tutorials-v2). NULL =
prod default.

Refs #533, #381."
```

---

## Task 4: `KG_ADMIN_RUNSPARQL` procedure

> **⚠ Read `## Discoveries from Task 1 implementation` first (top of plan).** The code samples in this task's Step 3 below still show the original (incorrect) `SIGNAL SQLSTATE` form and `CALL SYS.SPARQL_EXECUTE` — both have been corrected in Task 1's actual code. Use the corrections from the Discoveries section: `DECLARE <cond> CONDITION FOR SQL_ERROR_CODE <n>; SIGNAL <cond>;` and `CALL SYS_SPARQL_EXECUTE(...)`. Use the error-code assignments from the Discoveries table (10008-10009 for this procedure's conditions). No grants changes needed in this task.

**Files:**
- Create: `db/src/procedures/KG_ADMIN_RUNSPARQL.hdbprocedure`
- Create: `db-qa/src/procedures/KG_ADMIN_RUNSPARQL.hdbprocedure` (stub)
- Test (hybrid): `test/hybrid/kg-procedures-admin.test.js` (NEW)

**Why last of the 4:** The admin escape hatch is the simplest in shape (verbatim SPARQL forwarding, no per-operation validation) but the most semantically risky (it accepts arbitrary SPARQL). Doing it last means the safer procedures land first and we can verify the dispatcher works before opening up the wildcard surface.

The procedure trusts that the JS layer has authenticated the caller (XSUAA `KnowledgeGraph.Admin` scope check at the CDS-service layer). The `:is_update` flag is informational/audit — both paths go through the same `SYS.SPARQL_EXECUTE` call.

- [ ] **Step 1: Write the failing hybrid tests**

Create `test/hybrid/kg-procedures-admin.test.js`:

1. **Read passthrough**: `CALL KG_ADMIN_RUNSPARQL('SELECT (1 AS ?one) WHERE {}', 'N', ?, ?)` → expect non-empty response containing the `?one = 1` binding
2. **Write passthrough**: seed a fresh test graph via `KG_GRAPH_INSERT` (the procedure from Task 2), then call `KG_ADMIN_RUNSPARQL('SELECT ?o WHERE { GRAPH <urn:...> { <urn:a> <urn:b> ?o } }', 'N', ?, ?)` → expect the seeded triple
3. **Invalid is_update flag**: `CALL KG_ADMIN_RUNSPARQL('SELECT (1 AS ?one) WHERE {}', 'X', ?, ?)` → expect `KG_INVALID_IS_UPDATE_FLAG`
4. **Empty sparql**: `CALL KG_ADMIN_RUNSPARQL('', 'N', ?, ?)` → expect `KG_EMPTY_SPARQL`

- [ ] **Step 2: Run, verify FAIL**.

- [ ] **Step 3: Write the procedure**

```sql
PROCEDURE KG_ADMIN_RUNSPARQL (
  IN sparql NCLOB,
  IN is_update NVARCHAR(1),
  OUT response NCLOB,
  OUT headers NVARCHAR(5000)
)
LANGUAGE SQLSCRIPT
SQL SECURITY DEFINER
AS
BEGIN
  IF :sparql IS NULL OR LENGTH(:sparql) = 0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_EMPTY_SPARQL';
  END IF;
  IF :is_update IS NULL OR :is_update NOT IN ('Y', 'N') THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_INVALID_IS_UPDATE_FLAG';
  END IF;
  -- :is_update is informational; we do NOT branch on it. Audit happens at the
  -- JS layer (knowledge-graph-service.js:625 audit('KnowledgeGraphRunSparql')).
  -- The flag exists so a future HANA-side audit hook can log INSERT vs SELECT
  -- without re-parsing the SPARQL.
  CALL SYS.SPARQL_EXECUTE(:sparql, '', response, headers);
END;
```

- [ ] **Step 4: Write the QA stub** — same `SIGNAL '45000' KG_NOT_AVAILABLE_ON_QA`.

- [ ] **Step 5: `cds build --production`**, verify, deploy db-deployer.

- [ ] **Step 6: Re-run all 3 hybrid procedure test files — expect everything green**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid \
  test/hybrid/kg-procedures-graph-ops.test.js \
  test/hybrid/kg-procedures-query.test.js \
  test/hybrid/kg-procedures-admin.test.js
```

Expected: 7 + 5 + 4 = 16 hybrid tests passing.

- [ ] **Step 7: Commit**

```bash
git add db/src/procedures/KG_ADMIN_RUNSPARQL.hdbprocedure \
        db-qa/src/procedures/KG_ADMIN_RUNSPARQL.hdbprocedure \
        test/hybrid/kg-procedures-admin.test.js
git commit -m "feat(kg): KG_ADMIN_RUNSPARQL DEFINER procedure (#533)

Last of 4 SPARQL DEFINER procedures. Admin escape hatch — forwards
arbitrary SPARQL to SYS.SPARQL_EXECUTE verbatim. XSUAA scope check
stays at the JS layer (knowledge-graph-service.js); procedure trusts
the caller is authenticated.

Validations: non-empty sparql, is_update flag in {'Y','N'}.

All 4 procedures landed. Next: rewrite kg-sparql-client.js as a
typed dispatch module + migrate callers.

Refs #533, #381."
```

---

## Task 5: Cross-binding ACL proof test

**Files:**
- Test (hybrid): `test/hybrid/kg-procedure-acl.test.js` (NEW)

**Why this exists:** The whole premise of the design is that DEFINER procedures let two different binding-runtime-users both write to the same graph. Without this test the design has no regression guard — a future "let's optimise by inlining SYS.SPARQL_EXECUTE back into a DO block" change would re-introduce the 2026-06-22 bug invisibly.

The test demonstrates: a graph created by Binding-A via the procedure is also writable from Binding-B via the procedure. Per memory `hana_sparql_per_graph_acl_creator_owns`, this is only possible if the procedure body runs as a shared identity (the object-owner) regardless of caller.

- [ ] **Step 1: Write the proof test**

Create `test/hybrid/kg-procedure-acl.test.js`. Header comment block:

> Regression test for the DEFINER-rights claim that motivates the procedure layer. Two distinct HDI binding-runtime-users both write to the same named graph via KG_GRAPH_INSERT; if the procedure body ran with invoker rights, the SECOND binding's INSERT would fail "User is not allowed to perform this action - (INSERT)". Passing this test confirms the body runs as the stable object-owner identity.

The test fetches credentials via `cf service-key` (matches the pattern in `scripts/check-hana-rowcounts.cjs:69` and other check scripts), connects with `hdb` directly, and confirms:

1. `SELECT CURRENT_USER FROM DUMMY` returns different values for the two connections (proves they ARE different runtime users)
2. Binding-A calls `KG_GRAPH_INSERT` against `urn:test:acl-proof:<run>` — succeeds (creates the graph)
3. Binding-B calls `KG_GRAPH_INSERT` against the same IRI — succeeds (would fail if procedure ran with invoker rights)
4. Binding-B calls `KG_GRAPH_CLEAR` against the same IRI — succeeds
5. Cleanup: best-effort CLEAR from Binding-A

If the test can't fetch a second service-key (CF permissions vary across environments), it skips with a warning. The test fails loudly only when it CAN run both bindings AND the second one fails — the meaningful signal.

- [ ] **Step 2: Run, verify PASS** (procedures are already deployed from Tasks 1-4)

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-procedure-acl.test.js
```

Expected: PASS. If it fails, the DEFINER mode isn't taking effect; check the procedure files include the literal `SQL SECURITY DEFINER` line (not `INVOKER`, which is the HANA default).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/kg-procedure-acl.test.js
git commit -m "test(kg): cross-binding ACL proof for DEFINER procedures (#533)

Regression test for the per-graph ACL fix. Demonstrates two
distinct HDI binding-runtime-users can both write to the same
named graph via KG_GRAPH_INSERT. If the procedure body ever
reverts to invoker rights, this test fails loudly.

Skips with a warning when only one binding is reachable in the
current CF target (defensive — environments vary on service-key
permissions).

Refs #533."
```

---

## Task 6: Rewrite `kg-sparql-client.js` as a typed dispatch module

> **⚠ Read `## Discoveries from Task 1 implementation` first (top of plan).** The `callProcedure(db, procName, [...inArgs, null, null])` pattern this task's body describes does NOT work — `db.run('CALL <proc>(?, ?, ?)', [...])` cannot bind OUT params via `@cap-js/hana`. The corrected approach: build per-procedure DO-block wrappers (one per procedure — there are only 4, so hard-code them; YAGNI on a generic builder). See the Discoveries section's "Impact on Tasks 6 and the hybrid tests" subsection for the working pattern, plus the existing reference at `srv/lib/kg-sparql-client.js`'s legacy `SPARQL_DO_BLOCK` constant (still present in this file pre-rewrite) and `scripts/spike/kg-probe.cjs:146-180`.

**Files:**
- Modify: `srv/lib/kg-sparql-client.js` (rewrite — keep only error classes, timeout helper, classifyAndThrow)
- Test: `test/unit/kg-sparql-client-validation.test.js` (NEW)
- Test: `test/unit/kg-sparql-client-dispatch.test.js` (NEW)

**The keep / delete inventory:**

| What | Action |
|---|---|
| `SparqlPrivilegeError`, `SparqlSyntaxError`, `SparqlTimeoutError` classes | KEEP — same surface |
| `coerceRow()` helper | KEEP — still needed for OUT-param row coercion |
| `classifyAndThrow()` helper | KEEP — error mapping unchanged |
| `withTimeout()` helper | KEEP — same timeout semantics |
| `SPARQL_DO_BLOCK` constant | DELETE — procedures are the new boundary |
| `invoke()` private function | DELETE — replaced by `callProcedure()` |
| `sparqlExec()` export | DELETE — no pass-through path |
| `sparqlQuery()` export | DELETE — no pass-through path |
| `QUERY_PARAM_SHAPES` (NEW) | ADD — named-keys → positional mapping |
| `kgGraphClear()` export | ADD |
| `kgGraphInsert()` export | ADD |
| `kgQuery()` export | ADD |
| `kgAdminRunSparql()` export | ADD |
| `callProcedure()` private | ADD |
| `__TESTING__` block | KEEP, contents change (export `QUERY_PARAM_SHAPES` for tests) |

- [ ] **Step 1: Write the failing validation tests**

Create `test/unit/kg-sparql-client-validation.test.js`. Test cases:

1. `kgGraphClear`: rejects null/undefined/non-string `graphIri`; rejects bad-shape; rejects >500 chars
2. `kgGraphInsert`: same IRI validation + rejects null/empty `triples` + rejects >16MB triples (use a string-length check, not actually a 16MB allocation in the test)
3. `kgQuery`: rejects unknown `queryName`; rejects missing `params`; rejects `params` with extras vs `required` keys per query; rejects values >500 chars; accepts valid `overrideGraphIri`
4. `kgAdminRunSparql`: rejects empty `sparql`; rejects non-bool `isUpdate`; rejects >16MB sparql

All validators throw synchronously (`expect(() => fn(...))` not `expect(fn(...)).rejects`). Use `TypeError` for type-shape errors, `RangeError` for length-bound errors.

- [ ] **Step 2: Write the failing dispatch tests**

Create `test/unit/kg-sparql-client-dispatch.test.js`. Mock `db.run`, assert each function dispatches to the right `CALL "KG_..."(?, ?, ...)` with positional args in the right order:

1. `kgGraphClear({ db, graphIri: 'urn:t' })` → `db.run('CALL KG_GRAPH_CLEAR(?, ?, ?)', ['urn:t', null, null])`
2. `kgGraphInsert({ db, graphIri: 'urn:t', triples: '<a> <b> <c> .' })` → positional `['urn:t', '<a> <b> <c> .', null, null]`
3. `kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug: 'foo' } })` → positional `['NEIGHBORHOOD', 'foo', null, null, null, null, null]`
4. `kgQuery({ db, queryName: 'PATH_BETWEEN', params: { fromSlug: 'a', toSlug: 'b' }, overrideGraphIri: 'urn:test' })` → positional `['PATH_BETWEEN', 'a', 'b', null, 'urn:test', null, null]`
5. `kgAdminRunSparql({ db, sparql: 'SELECT ?x WHERE {}', isUpdate: false })` → positional `['SELECT ?x WHERE {}', 'N', null, null]`
6. `kgAdminRunSparql({ db, ..., isUpdate: true })` → `isUpdate` maps to `'Y'`

Each test mocks `db.run` to return a stub row like `[{ RESPONSE: 'ok', HEADERS: '' }]` and verifies the return shape `{ response, headers, latencyMs }`.

- [ ] **Step 3: Run both test files, verify FAIL** (exports don't exist yet)

```bash
npx vitest run test/unit/kg-sparql-client-validation.test.js test/unit/kg-sparql-client-dispatch.test.js
```

Expected: tests fail with `kgGraphClear is not a function` etc.

- [ ] **Step 4: Rewrite `srv/lib/kg-sparql-client.js`** — replace `invoke()` + `sparqlExec` + `sparqlQuery` + `SPARQL_DO_BLOCK` with `QUERY_PARAM_SHAPES`, `validateIri`/`validateNclob` helpers, `callProcedure(db, procName, inArgs, opts)` private (uses existing `withTimeout` / `classifyAndThrow` / `coerceRow`), and the 4 new exports. Full implementation sketch in spec § "JS-side typed client" — copy directly.

Keep the top half of the file (error classes, regex constants, `DEFAULT_TIMEOUT_MS`, `withTimeout`, `classifyAndThrow`, `coerceRow`) unchanged. Update the `__TESTING__` block to export `QUERY_PARAM_SHAPES` and `IRI_RE` for the new tests.

- [ ] **Step 5: Run both unit test files — expect PASS**

```bash
npx vitest run test/unit/kg-sparql-client-validation.test.js test/unit/kg-sparql-client-dispatch.test.js
```

Expected: all tests pass.

- [ ] **Step 6: Verify no compile errors**

```bash
node --check srv/lib/kg-sparql-client.js
```

Then run the broader unit suite to catch cascading import errors from callers that still reference deleted exports:

```bash
npm test 2>&1 | tail -30
```

Expected: tests fail in `kg-graph-rebuild*`, `kg-queries*`, and `knowledge-graph-service*` test files (those still import the deleted `sparqlExec`/`sparqlQuery`). This is expected — they get fixed in Tasks 7-9.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/kg-sparql-client.js \
        test/unit/kg-sparql-client-validation.test.js \
        test/unit/kg-sparql-client-dispatch.test.js
git commit -m "feat(kg): rewrite kg-sparql-client as typed dispatch module (#533)

Replaces sparqlExec / sparqlQuery (SPARQL-string passthrough) with
4 typed exports that CALL the procedures from Tasks 1-4. Error
semantics unchanged (same classes, same classifyAndThrow). Callers
in kg-graph-rebuild.js / knowledge-graph-service.js / kg-queries.js
still reference the old exports and will fail; fixed in Tasks 7-9.

Refs #533, #381."
```

---

## Task 7: Shrink `kg-queries.js` to validators only

**Files:**
- Modify: `srv/lib/kg-queries.js`
- Modify: `test/unit/kg-queries.test.js`

**What goes / what stays:**

| Export | Action |
|---|---|
| `SLUG_RE` (line 51) | KEEP — used by JS callers to pre-validate slugs |
| `substitute()` (line 160) | KEEP — used by JS-side IRI assembly (e.g. `iriTutorial(slug)`) |
| Typed placeholders `FROM_SLUG` / `TO_SLUG` / `USER_ID` / `LIMIT` | KEEP — same use case as `SLUG` |
| `NEIGHBORHOOD_QUERY` (line 237) | DELETE — moved into `KG_QUERY.hdbprocedure` |
| `PATH_BETWEEN_QUERY` (line 284) | DELETE — moved into `KG_QUERY.hdbprocedure` |
| `CONCEPTS_FOR_USER_QUERY` (line 299) | DELETE — moved into `KG_QUERY.hdbprocedure` |

The substitute helper STILL has value — JS callers use it to build the tutorial-IRI string from a validated slug (e.g. `iriTutorial(slug)` builds `<https://developers.sap.com/kg/tutorial/${slug}>`). The IRI itself is then passed as `params.slug` to `kgQuery`. The validation chain is: JS validates slug → JS assembles IRI → procedure receives IRI → procedure re-validates IRI (defense in depth).

- [ ] **Step 1: Identify which tests in `test/unit/kg-queries.test.js` survive**

The existing test file has 5 `describe` blocks covering ~36 tests. After this task:

| Describe block | Action |
|---|---|
| `kg-queries — exported templates` (5 tests) | DELETE — templates are gone |
| `substitute — happy path` (5 tests) | KEEP — but remove the one test that references `NEIGHBORHOOD_QUERY` (line 75 era) since the export is gone |
| `substitute — slug validation rejects bad shapes` (12 tests) | KEEP — pure validation logic, unchanged |
| `substitute — placeholder discovery` (3 tests) | KEEP |
| `substitute — additional typed placeholders` (~11 tests covering FROM/TO/USER_ID/LIMIT) | KEEP |

Result: ~36 → ~30 tests survive. The spec said "~12-15"; that was conservative. ~30 is the actual count and it's fine.

- [ ] **Step 2: Update `test/unit/kg-queries.test.js`**

Delete the `kg-queries — exported templates` describe block entirely. In the `substitute — happy path` block, delete the test that asserts `substitute(NEIGHBORHOOD_QUERY, { SLUG: ... })` builds something — replace with a test that uses an inline minimal template instead. The other tests don't reference the deleted exports.

Update the file header comment to reflect that this module is now validator-only.

- [ ] **Step 3: Run the test file — verify it still passes WITHOUT the deleted exports**

This will FAIL because the imports still reference `NEIGHBORHOOD_QUERY` etc.

```bash
npx vitest run test/unit/kg-queries.test.js
```

Fix the import statement at the top to drop the deleted names. Re-run; expect ~30 tests pass.

- [ ] **Step 4: Update `srv/lib/kg-queries.js`**

Delete lines 237 onwards (`NEIGHBORHOOD_QUERY`, `PATH_BETWEEN_QUERY`, `CONCEPTS_FOR_USER_QUERY` exports + their multi-line template strings). Update the file header comment block (the first ~30 lines) to reflect the narrowed scope — something like:

```js
// srv/lib/kg-queries.js
//
// JS-side slug validation + substitute() helper used to pre-build tutorial
// IRIs before passing them to kgQuery() in kg-sparql-client.js.
//
// **The SPARQL template strings that used to live here moved into the HDI
// procedure KG_QUERY (see db/src/procedures/KG_QUERY.hdbprocedure).** The
// procedure is now the single source of truth for SPARQL shape. This module
// retains only the validators that JS-side callers need to verify inputs
// before passing them to the procedure.
//
// See docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md
// for the design rationale.
```

- [ ] **Step 5: Run the unit suite** — expect `kg-queries.test.js` passes, but other tests that imported the deleted SPARQL templates fail (`knowledge-graph-service*`). Fixed in Task 9.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/kg-queries.js test/unit/kg-queries.test.js
git commit -m "refactor(kg): shrink kg-queries.js to validators only (#533)

SPARQL template strings (NEIGHBORHOOD_QUERY, PATH_BETWEEN_QUERY,
CONCEPTS_FOR_USER_QUERY) moved into the KG_QUERY.hdbprocedure
dispatcher (Task 3). This module retains SLUG_RE + substitute() +
the typed placeholders — the JS-side validators JS callers still
need before passing inputs to the procedure layer.

Tests: kg-queries.test.js shrinks from ~36 to ~30 tests (the
template-string assertions had nothing left to test).

Refs #533, #381."
```

---

## Task 8: Migrate `kg-graph-rebuild.js` to typed client

**Files:**
- Modify: `srv/lib/kg-graph-rebuild.js`
- Modify: `test/unit/kg-graph-rebuild-bootstrap.test.js`

**The 3 call sites** (all in `graphRebuild()`):

| Line | Today | After |
|---|---|---|
| 205 | `await sparqlExec(db, \`INSERT DATA { GRAPH <${targetGraph}> { ${BOOTSTRAP_TRIPLE} } }\`)` | `await kgGraphInsert({ db, graphIri: targetGraph, triples: BOOTSTRAP_TRIPLE })` |
| 208 | `await sparqlExec(db, \`CLEAR GRAPH <${targetGraph}>\`)` | `await kgGraphClear({ db, graphIri: targetGraph })` |
| 216 | `await sparqlExec(db, buildInsertData(targetGraph, batch))` | `await kgGraphInsert({ db, graphIri: targetGraph, triples: batch.join(' ') })` |

`buildInsertData(graphIri, batch)` (line ~63) is deleted — the procedure builds the `INSERT DATA { GRAPH <...> { ... } }` wrapper. The remaining N-Triples body is just `batch.join(' ')` (each line in `batch` already ends with `.` per the projection generator's contract).

- [ ] **Step 1: Update `test/unit/kg-graph-rebuild-bootstrap.test.js`**

The existing test mocks `sparqlExec` and asserts call sequence on SPARQL strings via regex. Re-mock to the new typed exports:

```js
const kgGraphClearMock = vi.fn();
const kgGraphInsertMock = vi.fn();

vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgGraphClear: (...args) => kgGraphClearMock(...args),
  kgGraphInsert: (...args) => kgGraphInsertMock(...args),
}));
```

Update the 5 assertions:

1. "First call is bootstrap INSERT" → `kgGraphInsertMock.mock.calls[0][0]` has `triples === BOOTSTRAP_TRIPLE`
2. "Second call is CLEAR" → `kgGraphClearMock.mock.calls[0][0].graphIri === targetGraph`
3. "Bootstrap uses BOOTSTRAP_TRIPLE exactly" → assert against the `triples` arg
4. "Default IRI when no graphIri arg" → `kgGraphInsertMock.mock.calls[0][0].graphIri === DEFAULT_GRAPH_IRI`
5. "CLEAR errors propagate" → `kgGraphClearMock.mockRejectedValueOnce(...)` after bootstrap succeeds

The existing kg-projection.js mock + the cds mock stay unchanged.

- [ ] **Step 2: Run, verify FAIL** (kg-graph-rebuild.js still imports sparqlExec)

```bash
npx vitest run test/unit/kg-graph-rebuild-bootstrap.test.js
```

- [ ] **Step 3: Update `srv/lib/kg-graph-rebuild.js`**

Change the import line (~30):

```js
import { kgGraphClear, kgGraphInsert } from './kg-sparql-client.js';
```

Delete `buildInsertData()` (~lines 60-65).

Update the 3 call sites in `graphRebuild()` (per the table above).

Update the header comment block to mention the procedure boundary.

- [ ] **Step 4: Run the unit test — expect PASS**

```bash
npx vitest run test/unit/kg-graph-rebuild-bootstrap.test.js \
                test/unit/kg-graph-rebuild-predicate-counts.test.js
```

Expected: both pass. The predicate-counts test (Task 5 of issue #526) doesn't touch the SPARQL layer so it should be unaffected.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/kg-graph-rebuild.js test/unit/kg-graph-rebuild-bootstrap.test.js
git commit -m "refactor(kg): migrate graphRebuild to typed procedure calls (#533)

Three call sites in graphRebuild():
  - Bootstrap INSERT → kgGraphInsert (Task 2)
  - CLEAR GRAPH    → kgGraphClear (Task 1)
  - Batch INSERT   → kgGraphInsert (per batch)

buildInsertData() helper deleted — the procedure builds the
INSERT DATA { GRAPH <...> { ... } } wrapper now.

Bootstrap-before-CLEAR test re-mocks to assert the typed-call
sequence instead of SPARQL-string regex match.

Refs #533, #525, #381."
```

---

## Task 9: Migrate `knowledge-graph-service.js` to typed client

**Files:**
- Modify: `srv/knowledge-graph-service.js`
- Add: `detectUpdate()` helper inside this file (or extract to `srv/lib/sparql-update-detect.js` if other callers will need it — they won't right now, so keep it local)

**The 2 call sites:**

| Line | Today | After |
|---|---|---|
| 532 | `({ response } = await sparqlQuery(db, sparql))` (neighborhood) | `({ response } = await kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug: iriTutorial(slug) } }))` |
| 634 | `({ response } = await sparqlQuery(db, query))` (admin runSparql) | `({ response } = await kgAdminRunSparql({ db, sparql: query, isUpdate: detectUpdate(query) }))` |

**For the neighborhood handler (line 532):** the `params.slug` value is the FULL tutorial IRI (per spec § brainstorming option y). Look at lines just above the call site — the existing code already builds `sparql` by substituting `$SLUG` into `NEIGHBORHOOD_QUERY`. After migration, that substitution code is gone; we just pass the IRI to `kgQuery`. The full IRI is `iriTutorial(slug)` — look for the helper (or build via `'https://developers.sap.com/kg/tutorial/' + slug`).

**For the admin handler (line 634):** wire the `isUpdate` audit field into the existing `audit('KnowledgeGraphRunSparql', { ... })` call at line 625-629 — spec § "Audit sink" specifies this.

`detectUpdate(sparql)` regex (per spec):

```js
const SPARQL_UPDATE_RE = /^\s*(INSERT|DELETE|CLEAR|DROP|CREATE|LOAD|COPY|MOVE|ADD)\b/i;
function detectUpdate(sparql) {
  return SPARQL_UPDATE_RE.test(sparql);
}
```

- [ ] **Step 1: Update the import statement**

Top of `srv/knowledge-graph-service.js`:

```js
import { kgQuery, kgAdminRunSparql } from './lib/kg-sparql-client.js';
```

Delete the old `sparqlExec` / `sparqlQuery` imports.

- [ ] **Step 2: Migrate line 532 (neighborhood handler)**

Find the block that builds `sparql` from `NEIGHBORHOOD_QUERY` (will be a `substitute(NEIGHBORHOOD_QUERY, { SLUG: slug })` or similar). Delete that assembly block. Replace the `sparqlQuery(db, sparql)` call with:

```js
const tutorialIri = 'https://developers.sap.com/kg/tutorial/' + slug;
({ response } = await kgQuery({
  db,
  queryName: 'NEIGHBORHOOD',
  params: { slug: tutorialIri },
}));
```

(Adjust to match the existing variable name + slug source in the actual code.)

- [ ] **Step 3: Migrate line 634 (admin runSparql)**

Add the `detectUpdate` helper near the top of the file (or just above the admin handler). Update the audit call to include `isUpdate`:

```js
const isUpdate = detectUpdate(query);
await audit('KnowledgeGraphRunSparql', {
  user: req.user?.id ?? 'unknown',
  queryLength: query.length,
  query: truncatedForLog,
  isUpdate,
});

let response;
try {
  ({ response } = await kgAdminRunSparql({ db, sparql: query, isUpdate }));
} catch (err) { ... }
```

- [ ] **Step 4: Run the unit suite — expect green**

```bash
npm test
```

Expected: every previously-failing test now passes. If `knowledge-graph-service.test.js` (existence depends — check before running) fails on a stale mock, update those mocks to target the new typed exports.

- [ ] **Step 5: Run the hybrid tests against DEV HANA — expect green**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid
```

This runs every hybrid test — including the existing `kg-graph-rebuild.test.js` and `kg-named-queries.test.js` which were not directly modified in this task but DO exercise the new code path. **Expect both to fail initially** with mock-related errors (`sparqlExec is not defined` or `cannot find module kg-queries.NEIGHBORHOOD_QUERY`). When that happens, update those two test files:

- `kg-graph-rebuild.test.js`: re-mock `kgGraphClear` + `kgGraphInsert` instead of `sparqlExec` (mirror the pattern from `test/unit/kg-graph-rebuild-bootstrap.test.js` in Task 8)
- `kg-named-queries.test.js`: replace any reference to the deleted `NEIGHBORHOOD_QUERY` template string with a call through `kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug: tutorialIri }, overrideGraphIri: TEST_GRAPH_IRI })`. The `overrideGraphIri` parameter on `kgQuery` exists specifically for this test's needs.

Re-run; expect green.

- [ ] **Step 6: Commit**

```bash
git add srv/knowledge-graph-service.js
git commit -m "refactor(kg): migrate knowledge-graph-service to typed client (#533)

Two call sites:
  - Neighborhood handler   → kgQuery({ queryName: 'NEIGHBORHOOD', ... })
  - Admin runSparql action → kgAdminRunSparql({ sparql, isUpdate })

Adds detectUpdate() helper using SPARQL_UPDATE_RE on the verbs that
mutate state (INSERT/DELETE/CLEAR/DROP/CREATE/LOAD/COPY/MOVE/ADD).
The audit('KnowledgeGraphRunSparql', ...) payload gains an isUpdate
boolean field per the spec's audit sink contract.

All 4 procedures + the typed client + the migrated callers form a
complete end-to-end chain. Hybrid tests against DEV HANA pass.

Refs #533, #381."
```

---

## Task 10: Smoke test for deployed runtime

**Files:**
- Create: `test/smoke/kg-deployed.test.js`

**What it covers:** End-to-end probe through the deployed approuter + srv. Requires an authenticated `KnowledgeGraph.Admin`-scoped token in `SMOKE_KG_ADMIN_TOKEN` env var (set in CI secrets, can be obtained locally via XSUAA passcode flow). Skips with a warning if the env var isn't set.

**Test cases:**

1. `POST /graph/triggerGraphRebuild` with the bearer token → expect `200` + JSON body containing `tripleCount > 0` and `graphVersion` matching UUID shape
2. `GET /graph/neighborhood?slug=<known-slug>` → expect `200` + JSON body with ≥ 1 row (use a slug we KNOW has concepts; check `Concepts` table in DEV for a real slug to bake in)

The "known slug" decision matters: we want a slug with stable concept coverage so the test doesn't flake when extractor passes update the graph. Pick one tutorial that's been around since the first extractor pass (e.g. `hana-cloud-create-database` or whatever shows up in the DEV `TutorialConceptLinks` table as the highest-link-count slug). Document the choice in the test file header.

- [ ] **Step 1: Find a stable slug for the smoke test**

```bash
npx cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  (async () => {
    const db = await cds.connect.to('db');
    const rows = await db.run(\`
      SELECT TOP 5 t.SLUG, COUNT(*) AS LINKS
        FROM COM_SAP_DEVELOPERS_IMS_TUTORIALCONCEPTLINKS l
        JOIN COM_SAP_DEVELOPERS_IMS_TUTORIALS t ON t.ID = l.TUTORIAL_ID
       GROUP BY t.SLUG
       ORDER BY LINKS DESC
    \`);
    console.log(rows);
    process.exit(0);
  })();
"
```

Pick the top slug and use it in the test.

- [ ] **Step 2: Write the smoke test**

Create `test/smoke/kg-deployed.test.js` following the existing pattern in `test/smoke/` (other smoke tests use `SMOKE_BASE_URL` env var for the approuter URL). Header:

```js
// test/smoke/kg-deployed.test.js
//
// HTTP-based smoke test for the KG layer post-deploy. Runs in CI after
// every successful MTA deploy. Requires:
//   - SMOKE_BASE_URL = approuter URL
//   - SMOKE_KG_ADMIN_TOKEN = bearer token with KnowledgeGraph.Admin scope
//
// Skips with a warning if either env var is missing.
```

Use `fetch()` (native Node 22+ per project baseline). Assert:
- Trigger call: `response.status === 200`, `body.tripleCount > 0`, `body.graphVersion` matches UUID regex
- Neighborhood call: `response.status === 200`, parsed body has `.length >= 1`

Set a generous timeout on the trigger call (60-90 seconds — cold-graph rebuild can take ~30s for 1089 concepts, and tests may run on a cold cache).

- [ ] **Step 3: Document the env vars in the test file + suggest adding them to CI**

The actual CI wiring (adding `SMOKE_KG_ADMIN_TOKEN` to GitHub secrets) is out of scope for this PR — file as follow-up. The test exists and runs locally; CI gets it when the secret is provisioned.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/kg-deployed.test.js
git commit -m "test(kg): smoke test for deployed KG runtime (#533)

HTTP probe through the deployed approuter + srv. Asserts:
  - POST /graph/triggerGraphRebuild returns 200 + tripleCount > 0
  - GET /graph/neighborhood?slug=<stable-slug> returns >= 1 row

Skips with a warning if SMOKE_BASE_URL or SMOKE_KG_ADMIN_TOKEN env
vars are missing. CI wiring (adding the admin token to GitHub
secrets) is a follow-up.

Refs #533."
```

---

## Task 11: Deploy to DEV + verify outcome A or B

**Files:** none (deploy + verification only)

**Per spec § Rollout**, follow the 6-step plan with the explicit decision rule for Outcome A vs B.

- [ ] **Step 1: Local rebuild**

```bash
npx cds build --production
```

Expected: builds without errors. The 4 procedures + grants changes are now in `gen/db/src/procedures/` and `gen/db/src/_grants.hdbgrants`.

- [ ] **Step 2: Run the CDS-build-staging check locally (PR #524's lint)**

```bash
npx tsx scripts/check-cds-build-staging.ts
```

Expected: passes. New `.hdbprocedure` files won't conflict with tracked artifacts since the staging check only diffs `db/last-dev/` + `db/src/*.hdbmigrationtable`.

- [ ] **Step 3: Verify the srv-qa cp-list still passes**

```bash
npx tsx scripts/check-srv-qa-cp-list.ts
```

Expected: passes. We didn't add any new `srv/lib/*.js` files (only modified existing ones); QA cp-list shouldn't drift.

- [ ] **Step 4: `mbt build` + `cf deploy`**

```bash
cd .deploy
mbt build
cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
cd ..
```

Verify the MTA op shows `FINISHED`:

```bash
cf mta-ops --last 1
```

If db-deployer task fails, check `cf logs tutorials-db-deployer --recent` — most likely cause is a SPARQL-string syntax error in `KG_QUERY.hdbprocedure` from a missed single-quote. Iterate.

- [ ] **Step 5: Run the urn:test probe (ground-truth check)**

```bash
npx cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  (async () => {
    const db = await cds.connect.to('db');
    const iri = 'urn:test:procedure-proof:' + Date.now();
    await db.run('CALL KG_GRAPH_INSERT(?, ?, ?, ?)', [iri, '<urn:a> <urn:b> <urn:c> .', null, null]);
    await db.run('CALL KG_GRAPH_CLEAR(?, ?, ?)', [iri, null, null]);
    console.log('Procedure layer works for fresh IRIs.');
    process.exit(0);
  })().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
"
```

Expected: prints "Procedure layer works for fresh IRIs." If FAIL, the deploy didn't fully apply — check db-deployer task logs.

- [ ] **Step 6: Trigger graphRebuild via admin UI**

Open https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/admin-ui/#/concepts

Click **"Trigger Graph Rebuild"**. Watch DevTools Network tab for `POST /graph/triggerGraphRebuild`. Expected response: `200` with body containing `tripleCount`, `graphVersion`, `conceptCount`, `edgeCount`, predicate counts.

- [ ] **Step 7: Apply the Outcome A / B decision rule**

- **Outcome A**: Step 5 succeeded AND step 6 returned `tripleCount > 0`. Skip to Task 12 — done.
- **Outcome B**: Step 5 succeeded BUT step 6 returned `"User is not allowed to perform this action - (INSERT)"` on `tutorials-v2`. Per spec § Rollout decision rule, **do not debug** — bump to v3:
  1. Edit `srv/lib/kg-graph-rebuild.js` `DEFAULT_GRAPH_IRI` → `'https://developers.sap.com/kg/tutorials-v3'`
  2. Edit `db/src/procedures/KG_QUERY.hdbprocedure` `from_clause` default → same v3
  3. `cds build --production`, `mbt build`, `cf deploy`
  4. Click the button again. This time it succeeds because the procedure (as object-owner) is the FIRST writer to `tutorials-v3`, so ACL pins to the stable object-owner identity going forward.
  5. Commit the v3 bump as a separate commit on the same branch: `fix(kg): bump DEFAULT_GRAPH_IRI to v3 (procedure-mediated creation — last bump)`.

- [ ] **Step 8: Verify the sidebar renders**

Visit a tutorial OP whose slug shows in `Concepts` (use the one picked in Task 10 Step 1). Confirm the sidebar shows the 4 sections (Key concepts / Prerequisites / Related / What to learn next) with actual content. Take a screenshot for the PR.

- [ ] **Step 9: Run the deployed smoke test**

```bash
SMOKE_BASE_URL='https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com' \
SMOKE_KG_ADMIN_TOKEN='<your token>' \
npm run test:smoke -- test/smoke/kg-deployed.test.js
```

Expected: 2/2 pass.

---

## Task 12: Open the PR

**Files:** none (PR work only)

- [ ] **Step 1: Final test run — full suite**

```bash
npm test
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid
```

Both should be fully green.

- [ ] **Step 2: Push the branch**

```bash
git push -u origin feat/kg-sparql-definer-procedures
```

- [ ] **Step 3: Open the PR via `gh pr create`**

PR title: `feat(kg): SPARQL DEFINER procedures eliminate per-graph ACL (#533)`

PR body should reference the spec doc, list the 4 procedures, summarize the test coverage, mention which Outcome (A or B) was hit during DEV verification, and link the memories created during the 2026-06-22 debugging session (`hana_sparql_per_graph_acl_creator_owns`, `xsuaa_scope_changes_need_manual_update_service`).

Closes #533.

- [ ] **Step 4: Update memory after merge**

After the PR merges + deploys to prod (if applicable), append a memory entry noting the DEFINER procedures pattern is now the canonical way to call SYS.SPARQL_EXECUTE in this codebase. Cross-reference from existing `hana_sparql_per_graph_acl_creator_owns` memory to point future readers at the solution.

---

## Cross-cutting concerns

**TDD discipline:** Each procedure task (1-4) follows red-green: write the hybrid test first, see it fail with "procedure not found", then write the procedure, deploy, see it pass. Same pattern for the JS rewrite in Task 6 (validation + dispatch tests fail until the new exports exist). Do NOT skip the FAIL step — it's how you know the test actually exercises the new code rather than passing trivially.

**Commit granularity:** One commit per task as outlined. Each commit leaves the codebase in a deployable state EXCEPT Tasks 6-8 inclusive — those temporarily break callers that haven't migrated yet. That window is OK because the PR doesn't merge until Task 12; in the meantime CI may show red on Tasks 6-8.

**Deploy timing:** Tasks 1-4 each redeploy the db-deployer. This is cheap (~2 min) and necessary because the hybrid tests need the procedures live. Tasks 5-9 don't redeploy (no DB changes). Task 11 is the final full MTA deploy that gets srv onto the typed client.

**Memory references:**
- `hana_sparql_per_graph_acl_creator_owns` — the bug this fix addresses
- `xsuaa_scope_changes_need_manual_update_service` — XSUAA-update gotcha; relevant if the smoke test 403s
- `feedback-cf-push-db-deployer-fast-path` — the fast-path deploy used in Tasks 1-4
- `feedback_cf_target_before_push` — always verify CF target before destructive ops
- `feedback_cds_build_artifacts_with_schema_pr` — relevant for Task 11 step 2

**Out of scope (file as follow-ups if relevant):**
- DBADMIN cleanup of the orphan `tutorials` + `tutorials-v2` graphs (taking ~0 space; cosmetic)
- Adding `SMOKE_KG_ADMIN_TOKEN` to GitHub Actions secrets (CI wiring)
- Extending the CDS-build-staging linter to track `.hdbprocedure` files alongside `.hdbmigrationtable` (proactive)
