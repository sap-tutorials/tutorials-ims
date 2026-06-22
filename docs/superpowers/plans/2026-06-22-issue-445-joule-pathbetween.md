# Phase 2 — Joule findLearningPath Implementation Plan (Issue #445)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working Joule `findLearningPath` chat tool against the hybrid pathBetween SPARQL strategy designed in the spec.

**Architecture:** Three layers — (1) replace the `PATH_BETWEEN` stub in `db/src/procedures/KG_QUERY.hdbprocedure` with a three-arm UNION SPARQL (PREREQ + CO_COMPLETED + SHARED_CONCEPT); (2) add `srv/lib/kg/concepts-for-user.js` (routes through `KG_ADMIN_RUNSPARQL`, no schema change); (3) add `srv/lib/kg/joule-tool-find-path.js` + wire it into `chat-orchestrator.js` behind a new `ChatSettings.kgPathBetweenEnabled` flag.

**Tech Stack:** HANA HDI `.hdbprocedure` + CDS entity `.hdbmigrationtable`, Node.js ESM modules in `srv/lib/kg/`, vitest, the existing `kgQuery()` + `kgAdminRunSparql()` typed clients from PR #555. No new npm dependencies.

**Spec:** [docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md](../specs/2026-06-22-issue-445-joule-pathbetween-design.md)

---

## File map (decomposition lock-in)

| File | Action | Lines | Responsibility |
|---|---|---|---|
| `db/src/procedures/KG_QUERY.hdbprocedure` | MODIFY | ~70 added in PATH_BETWEEN branch | Replace stub at line 147-170 with the 3-arm UNION SPARQL |
| `db/schema.cds` | MODIFY | 1 line added | Add `kgPathBetweenEnabled : Boolean default false;` to `ChatSettings` entity at line 501 |
| `srv/lib/kg/concepts-for-user.js` | CREATE | ~140 lines | TaskRecords join → tutorial IRIs → KG_ADMIN_RUNSPARQL SPARQL → `{ learned, partial }` |
| `srv/lib/kg/joule-tool-find-path.js` | CREATE | ~250 lines | `FIND_LEARNING_PATH_TOOL` descriptor + `findLearningPathHandler` function |
| `srv/lib/chat-orchestrator.js` | MODIFY | ~15 lines | Import + conditional tool registration in `toolsForContext` + dispatch arm |
| `srv/knowledge-graph-service.js` | MODIFY | ~10 lines | Wire `conceptsForUser` action handler to delegate to `getConceptsForUser` |
| `test/unit/kg-path-between-handler.test.js` | CREATE | ~280 lines | 15 unit tests for `findLearningPathHandler` |
| `test/unit/concepts-for-user.test.js` | CREATE | ~140 lines | 6 unit tests for `getConceptsForUser` |
| `test/hybrid/kg-path-between.test.js` | CREATE | ~200 lines | 8 hybrid tests against DEV KG_QUERY |
| `test/hybrid/concepts-for-user.test.js` | CREATE | ~130 lines | 5 hybrid tests against DEV TaskRecords + KGE |
| `test/hybrid/joule-tool-pick-find-path.test.js` | CREATE | ~150 lines | 12-fixture AI-judge gated by `HYBRID_AI_TESTS=true` |
| `test/smoke/joule-find-learning-path.test.js` | CREATE | ~60 lines | 1 smoke test against deployed `/chat/stream` |
| `docs/developers/architecture/knowledge-graph.md` | MODIFY | ~50 added | Phase 2 section: hybrid UNION strategy + flag |
| `docs/developers/operations/testing-endpoints.md` | MODIFY | ~10 added | `findLearningPath` row in Joule tools subsection |
| `docs/developers/operations/runtime-config.md` | MODIFY | 1 row added | `kgPathBetweenEnabled` row in the ChatSettings flag table |

---

## Cross-cutting conventions

- **CRLF on Windows.** After every write/edit, run `file <path>` and confirm "ASCII text" or "UTF-8 Unicode text" (not "CRLF"). Memory: `feedback_crlf_regression_on_windows`. Fix with `sd -F $'\r' '' <file>` if needed.
- **Worktree branch verification.** Every implementer subagent prompt must include the branch-state guardrail from PR #560's implementer prompts — `pwd` + `git branch --show-current` checked in the SAME bash invocation as `git commit`. Memory: `feedback_branch_slip_after_long_session`.
- **No parent-worktree writes.** After each commit, verify `git -C ../../.. log --oneline -1` shows the upstream main commit unchanged.
- **Module style.** All TypeScript/JS in `srv/lib/` uses ESM (`import`/`export`). Match surrounding file's import style.
- **Test framework.** vitest. `import { describe, it, expect } from 'vitest'`.
- **Procedure DO-block CALL pattern.** Per memory `kg_sparql_definer_procedures_canonical` + `hana_sqlscript_divergences_from_training_data`, never call `db.run('CALL <proc>(?, ?, ?)', [...args, null, null])` directly. The existing `kgQuery()` typed client at `srv/lib/kg-sparql-client.js` already handles wrapping in a DO block.
- **Regex iteration in TS/JS files.** Use `String.prototype.matchAll()` for repeated regex matches rather than `RegExp.prototype` iteration — sidesteps a security-hook false positive on `.exec()` and avoids stateful-regex bugs.
- **Procedure validates :p2 even when SPARQL ignores it.** The existing `KG_QUERY.hdbprocedure` line 152-154 validator already enforces that `:p2` matches the canonical tutorial IRI shape. The new SPARQL body does NOT reference `:p2` (the JS layer does post-query filtering for `toSlug`), but the procedure keeps the validator as defense-in-depth. Document in the procedure comment.

---

## Task 0: Verify clean baseline + run the counted-property-path spike

Before any code changes: confirm worktree is at baseline; run a 1-minute spike to verify HANA KGE accepts `(^kg:requires){1,5}` counted-path syntax. If unsupported, the procedure's ARM 1 falls back to `(^kg:requires)+` + JS-side depth cap.

**Files:** none (verification only)

- [ ] **Step 1: Verify worktree + branch + recent commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/issue-445-joule-pathbetween
pwd
git branch --show-current
git log --oneline main..HEAD
```

Expected: `pwd` ends with `/issue-445-joule-pathbetween`; branch = `feat/445-joule-pathbetween`; 1 commit ahead of main (the spec).

- [ ] **Step 2: Run counted-property-path spike**

Write to a temp file inside the worktree (modules can't resolve from /tmp):

```bash
cat > _counted_path_spike.cjs <<'PYEOF'
const cds = require('@sap/cds');
const DO_QUERY = `DO (IN s NCLOB => ?, IN f NVARCHAR(1) => ?) BEGIN
  DECLARE response NCLOB; DECLARE headers NVARCHAR(5000);
  CALL KG_ADMIN_RUNSPARQL(:s, :f, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`;
async function run(label, sparql) {
  const t = Date.now();
  try {
    const result = await cdsDb.run(DO_QUERY, [sparql, 'N']);
    const rows = Array.isArray(result) ? result : (result?.changes?.[1] || []);
    const firstRow = Array.isArray(rows) ? rows[0] : rows;
    const resp = firstRow?.RESPONSE?.toString?.() || '';
    const matchCount = (resp.match(/<result>/g) || []).length;
    console.log(`[${label}] ${Date.now()-t}ms  results=${matchCount}`);
  } catch (e) {
    console.log(`[${label}] FAIL: ${(e.message||'').split('\n')[0].slice(0,200)}`);
  }
}
const G = '<https://developers.sap.com/kg/tutorials-v3>';
const P = 'PREFIX kg: <https://developers.sap.com/kg/> ';
let cdsDb;
(async () => {
  cdsDb = await cds.connect.to('db');
  await run('A. counted {1,3}', `${P}SELECT ?a ?c WHERE { GRAPH ${G} { ?a (^kg:requires){1,3} ?c } } LIMIT 5`);
  await run('B. counted {1,5}', `${P}SELECT ?a ?c WHERE { GRAPH ${G} { ?a (^kg:requires){1,5} ?c } } LIMIT 5`);
  await run('C. plus +', `${P}SELECT ?a ?c WHERE { GRAPH ${G} { ?a (^kg:requires)+ ?c } } LIMIT 5`);
  await run('D. coCompletedWith {1,3}', `${P}SELECT ?a ?b WHERE { GRAPH ${G} { ?a (kg:coCompletedWith){1,3} ?b } } LIMIT 5`);
  process.exit(0);
})().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
PYEOF
npx cds bind --exec -- node ./_counted_path_spike.cjs
rm -f ./_counted_path_spike.cjs
```

- [ ] **Step 3: Record the outcome**

| Outcome | Implication for Task 2 |
|---|---|
| A + B + D succeed | **Use `{n,m}` counted paths** (spec's primary choice) |
| A + B FAIL, C succeeds | **Use `+` plus closure + JS depth cap** — procedure uses `(^kg:requires)+`; JS handler bounds path depth via response inspection |
| All fail | STOP. Surface to controller. KGE regressed or graph state changed. |

Note the chosen variant in the report. Task 2's implementer reads this back.

- [ ] **Step 4: Run targeted baseline tests**

```bash
npx vitest run scripts/__tests__/sanitize-html.test.ts scripts/lint-rules/__tests__/ 2>&1 | tail -6
```

Note green baseline counts.

**No commit on Task 0.** Verification-only.

---

## Task 1: ChatSettings — add `kgPathBetweenEnabled` flag column

**Files:**
- Modify: `db/schema.cds:501` (`ChatSettings` entity)

- [ ] **Step 1: Locate the entity definition**

```bash
sed -n '501,530p' db/schema.cds
```

Expected: `entity ChatSettings : cuid, managed {` at line 501, with sibling boolean flags `ragEnabled`, `codeCheckEnabled`, `branchingEnabled`.

- [ ] **Step 2: Add the new column**

Use the Edit tool. Find:

```cds
  branchingEnabled     : Boolean default false;
```

Replace with:

```cds
  branchingEnabled     : Boolean default false;
  kgPathBetweenEnabled : Boolean default false;
```

Match the indentation and column alignment of surrounding flags.

- [ ] **Step 3: Regenerate HDI artifacts**

```bash
npx cds build --production
```

Expected: build succeeds. Confirm:

```bash
ls gen/db/src/*ChatSettings* 2>/dev/null | head
```

Should show a `COM_SAP_DEVELOPERS_IMS_CHATSETTINGS.hdbmigrationtable`.

- [ ] **Step 4: Update `db/last-dev/` reference**

```bash
npx tsx scripts/check-cds-build-staging.ts 2>&1 | tail -10
```

If it fails on drift:

```bash
cp gen/db/src/COM_SAP_DEVELOPERS_IMS_CHATSETTINGS.hdbmigrationtable db/last-dev/COM_SAP_DEVELOPERS_IMS_CHATSETTINGS.hdbmigrationtable
diff <(jq -S . gen/db/src/csn.json) <(jq -S . db/last-dev/csn.json) | head -30
# If diff is clean except for ChatSettings.elements.kgPathBetweenEnabled:
cp gen/db/src/csn.json db/last-dev/csn.json
```

Re-run `check-cds-build-staging.ts`; expect pass.

- [ ] **Step 5: Verify CRLF + commit**

```bash
file db/schema.cds db/last-dev/COM_SAP_DEVELOPERS_IMS_CHATSETTINGS.hdbmigrationtable db/last-dev/csn.json
git branch --show-current
git add db/schema.cds db/last-dev/
git commit -m "feat(kg): ChatSettings.kgPathBetweenEnabled flag for Phase 2 (#445)

Adds a boolean column to ChatSettings (default false) gating the new
findLearningPath Joule tool. When false, the tool is NOT registered in
the LLM's tool list (orchestrator filters it out alongside ragEnabled,
codeCheckEnabled, branchingEnabled).

Schema-only. Activates after MTA redeploy; admin flips on via the
existing Joule Chat Settings tile.

Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md
Refs #445."
```

---

## Task 2: KG_QUERY procedure — replace PATH_BETWEEN stub with three-arm UNION

**Files:**
- Modify: `db/src/procedures/KG_QUERY.hdbprocedure:147-170`

Task 0's spike outcome determines the SPARQL variant. The default below uses `{n,m}`; swap to `+` if Task 0 indicated the fallback path.

- [ ] **Step 1: Read the current PATH_BETWEEN branch**

```bash
sed -n '145,175p' db/src/procedures/KG_QUERY.hdbprocedure
```

Note the existing `:p1`/`:p2` validator (lines 152-154). **Keep unchanged.**

- [ ] **Step 2: Replace the stub body**

Find lines ~158-170 (the stub after the validator). Replace the `sparql := …` assignment with:

```sql
    -- PATH_BETWEEN: three-arm UNION SPARQL.
    -- See docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md
    -- for the rationale (sparse kg:requires graph; coverage-fallback design).
    --
    -- NOTE: :p2 (toSlug IRI) is VALIDATED by the block above (defense-in-depth)
    -- but is INTENTIONALLY NOT referenced in the SPARQL body. JS-layer
    -- post-processing does the toSlug match. This produces graceful fallback
    -- ('closest topical neighbors') when no exact path to toSlug exists,
    -- rather than the 'no path found' answer the issue body originally
    -- proposed. See spec § "Layer 1 — KG_QUERY procedure: PATH_BETWEEN branch".
    sparql :=
      'PREFIX kg: <https://developers.sap.com/kg/>' || CHAR(10) ||
      'SELECT ?b ?pathType ?pathTypeRank ?hopCount' || CHAR(10) ||
      from_clause || CHAR(10) ||
      'WHERE {' || CHAR(10) ||
      '  {' || CHAR(10) ||
      '    # ARM 1: Prerequisite chain (preferred when data supports it)' || CHAR(10) ||
      '    <' || :p1 || '> kg:teaches ?c1 .' || CHAR(10) ||
      '    ?c1 (^kg:requires){1,5} ?cN .' || CHAR(10) ||
      '    ?b kg:teaches ?cN .' || CHAR(10) ||
      '    FILTER(?b != <' || :p1 || '>)' || CHAR(10) ||
      '    BIND("PREREQ" AS ?pathType)' || CHAR(10) ||
      '    BIND(1 AS ?pathTypeRank)' || CHAR(10) ||
      '    BIND(0 AS ?hopCount)' || CHAR(10) ||
      '  } UNION {' || CHAR(10) ||
      '    # ARM 2: Co-completion adjacency (behavioral signal, dense)' || CHAR(10) ||
      '    <' || :p1 || '> (kg:coCompletedWith){1,3} ?b .' || CHAR(10) ||
      '    FILTER(?b != <' || :p1 || '>)' || CHAR(10) ||
      '    BIND("CO_COMPLETED" AS ?pathType)' || CHAR(10) ||
      '    BIND(2 AS ?pathTypeRank)' || CHAR(10) ||
      '    BIND(0 AS ?hopCount)' || CHAR(10) ||
      '  } UNION {' || CHAR(10) ||
      '    # ARM 3: Shared-concept proximity (semantic, always-on)' || CHAR(10) ||
      '    <' || :p1 || '> kg:teaches ?c .' || CHAR(10) ||
      '    ?b kg:teaches ?c .' || CHAR(10) ||
      '    FILTER(?b != <' || :p1 || '>)' || CHAR(10) ||
      '    BIND("SHARED_CONCEPT" AS ?pathType)' || CHAR(10) ||
      '    BIND(3 AS ?pathTypeRank)' || CHAR(10) ||
      '    BIND(0 AS ?hopCount)' || CHAR(10) ||
      '  }' || CHAR(10) ||
      '}' || CHAR(10) ||
      'ORDER BY ?pathTypeRank' || CHAR(10) ||
      'LIMIT 10';
```

**Task 0 fallback variant**: if `{1,5}` was unsupported, change `(^kg:requires){1,5}` → `(^kg:requires)+` and `(kg:coCompletedWith){1,3}` → `(kg:coCompletedWith)+`. JS-side handler in Task 5 will trim paths exceeding depth via the `?b` candidate list cap.

- [ ] **Step 3: Rebuild + deploy db-deployer to DEV**

Per memory `feedback-cf-push-db-deployer-fast-path`, schema/procedure-only changes don't need `mbt build`:

```bash
npx cds build --production
cd .deploy 2>/dev/null || cd ../../../.deploy
cf push tutorials-db-deployer -p ../gen/db
cd -
```

Watch `cf logs tutorials-db-deployer --recent | tail -50` on errors. Per memory `feedback_cf_target_before_push`: verify `cf target` first; should show `tutorial-system / dev`.

- [ ] **Step 4: Verify procedure deployed**

```bash
cat > _verify_proc.cjs <<'EOF'
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  const rows = await db.run(`SELECT PROCEDURE_NAME, SQL_SECURITY FROM SYS.PROCEDURES WHERE SCHEMA_NAME = (SELECT SCHEMA_NAME FROM SYS.M_HDI_CONTAINERS WHERE CONTAINER_NAME LIKE 'tutorials-hana%') AND PROCEDURE_NAME = 'KG_QUERY'`);
  console.log(JSON.stringify(rows, null, 2));
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
EOF
npx cds bind --exec -- node ./_verify_proc.cjs
rm -f ./_verify_proc.cjs
```

Expected: `[{ "PROCEDURE_NAME": "KG_QUERY", "SQL_SECURITY": "DEFINER" }]`.

- [ ] **Step 5: Verify CRLF + commit**

```bash
file db/src/procedures/KG_QUERY.hdbprocedure
git branch --show-current
git add db/src/procedures/KG_QUERY.hdbprocedure
git commit -m "feat(kg): KG_QUERY PATH_BETWEEN three-arm UNION SPARQL (#445)

Replaces the LIMIT 0 stub at the PATH_BETWEEN branch with the hybrid
SPARQL from the Phase 2 spec: three UNION arms (PREREQ / CO_COMPLETED /
SHARED_CONCEPT) tagged with pathTypeRank for ORDER BY.

:p2 (toSlug IRI) remains validated by the existing validator (defense-
in-depth) but is NOT referenced in the SPARQL body — JS-layer post-
processing does toSlug matching for graceful fallback ('closest topical
neighbors' when exact target is unreachable).

Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md
Refs #445."
```

---

## Task 3: KG_QUERY hybrid test (against deployed procedure)

**Files:**
- Create: `test/hybrid/kg-path-between.test.js`

Lands BEFORE the JS handler so we have a procedure-level regression guard.

- [ ] **Step 1: Inspect existing pattern**

```bash
head -80 test/hybrid/kg-procedures-query.test.js
```

Mirror style.

- [ ] **Step 2: Write the hybrid test**

Use the Write tool. The file uses `String.prototype.matchAll()` for regex iteration (memory: avoid security-hook false positive on `.exec()`). Full file content:

```js
// test/hybrid/kg-path-between.test.js
// Hybrid tests for KG_QUERY procedure's PATH_BETWEEN branch (issue #445 Phase 2).
//
// Runs against the deployed DEV procedure after Task 2's HDI deploy.
//
// HOW TO RUN
//   ALLOW_HYBRID_WRITES=true npx cds bind --exec -- \
//     npx vitest run --project hybrid test/hybrid/kg-path-between.test.js

import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const DO_CALL_KG_QUERY = `DO (IN qn NVARCHAR(50) => ?, IN p1 NVARCHAR(500) => ?, IN p2 NVARCHAR(500) => ?, IN p3 NVARCHAR(500) => ?, IN ogi NVARCHAR(500) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL KG_QUERY(:qn, :p1, :p2, :p3, :ogi, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END`

async function callPathBetween(db, fromIri, toIri) {
  const rows = await db.run(DO_CALL_KG_QUERY, ['PATH_BETWEEN', fromIri, toIri, null, null])
  const r = Array.isArray(rows) ? rows[0] : rows?.changes?.[1]?.[0] || rows
  return r?.RESPONSE?.toString?.() || r?.RESPONSE || ''
}

function parseResults(xml) {
  if (!xml) return []
  const out = []
  // matchAll() avoids stateful regex pitfalls + the security-hook false positive on .exec()
  for (const m of xml.matchAll(/<result>([\s\S]*?)<\/result>/g)) {
    const block = m[1]
    const bindings = {}
    for (const bm of block.matchAll(/<binding name="([^"]+)">[\s\S]*?<(uri|literal)[^>]*>([^<]+)</g)) {
      bindings[bm[1]] = bm[3]
    }
    out.push(bindings)
  }
  return out
}

const FROM_TUT = 'https://developers.sap.com/kg/tutorial/hana-cloud-cap-create-project'
const TO_TUT = 'https://developers.sap.com/kg/tutorial/abap-dev-enhance-cds-view'

describe('KG_QUERY PATH_BETWEEN — three-arm hybrid SPARQL (issue #445)', () => {
  let db

  beforeAll(async () => {
    db = await cds.connect.to('db')
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService'
    if (!isHana) throw new Error('kg-path-between.test.js requires HANA. Use `npm run test:hybrid`.')
  })

  it('returns non-empty results for a known DEV slug pair', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    expect(parseResults(xml).length).toBeGreaterThan(0)
  })

  it('ORDER BY pathTypeRank: results are non-decreasing by rank', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    const ranks = parseResults(xml).map(r => Number(r.pathTypeRank))
    for (let i = 1; i < ranks.length; i++) {
      expect(ranks[i]).toBeGreaterThanOrEqual(ranks[i - 1])
    }
  })

  it('CO_COMPLETED arm fires for a slug with known co-completion neighbors', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    const coCompleted = parseResults(xml).filter(r => r.pathType === 'CO_COMPLETED')
    expect(coCompleted.length).toBeGreaterThan(0)
  })

  it('SHARED_CONCEPT arm fires for a slug with kg:teaches edges', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    const shared = parseResults(xml).filter(r => r.pathType === 'SHARED_CONCEPT')
    expect(shared.length).toBeGreaterThan(0)
  })

  it('LIMIT 10 enforced: never more than 10 results', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    expect(parseResults(xml).length).toBeLessThanOrEqual(10)
  })

  it('?b never equals the source IRI (FILTER works)', async () => {
    const xml = await callPathBetween(db, FROM_TUT, TO_TUT)
    for (const r of parseResults(xml)) {
      expect(r.b).not.toBe(FROM_TUT)
    }
  })

  it('rejects invalid :p1 IRI with code 10006', async () => {
    await expect(
      db.run(DO_CALL_KG_QUERY, ['PATH_BETWEEN', 'not-a-valid-iri', TO_TUT, null, null])
    ).rejects.toMatchObject({ code: 10006 })
  })

  it('rejects invalid :p2 IRI with code 10006', async () => {
    await expect(
      db.run(DO_CALL_KG_QUERY, ['PATH_BETWEEN', FROM_TUT, 'not-a-valid-iri', null, null])
    ).rejects.toMatchObject({ code: 10006 })
  })
})
```

- [ ] **Step 3: Run the test against DEV**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-path-between.test.js 2>&1 | tail -15
```

Expected: 8/8 passing. If the chosen FROM_TUT slug doesn't exist in DEV, swap for an active one (`SELECT TOP 1 SLUG FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE STATUS='ACTIVE' ORDER BY ...`).

- [ ] **Step 4: Verify CRLF + commit**

```bash
file test/hybrid/kg-path-between.test.js
git branch --show-current
git add test/hybrid/kg-path-between.test.js
git commit -m "test(kg): hybrid tests for KG_QUERY PATH_BETWEEN three-arm SPARQL (#445)

8 tests against the deployed PATH_BETWEEN procedure from Task 2.

Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md"
```

---

## Task 4: `srv/lib/kg/concepts-for-user.js` — implementation (TDD)

**Files:**
- Create: `srv/lib/kg/concepts-for-user.js`
- Create: `test/unit/concepts-for-user.test.js`

- [ ] **Step 1: Create the directory + write the failing test first**

```bash
mkdir -p srv/lib/kg
```

Create `test/unit/concepts-for-user.test.js`:

```js
// test/unit/concepts-for-user.test.js
// Unit tests for srv/lib/kg/concepts-for-user.js (issue #445 Phase 2).
// Pure JS, mocks db.run + kgAdminRunSparql.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgAdminRunSparql: vi.fn(async () => ({
    response: `<?xml version="1.0"?>
<sparql xmlns="http://www.w3.org/2005/sparql-results#">
  <head><variable name="c"/><variable name="status"/></head>
  <results>
    <result>
      <binding name="c"><uri>https://developers.sap.com/kg/concept/cap-handlers</uri></binding>
      <binding name="status"><literal>COMPLETED</literal></binding>
    </result>
    <result>
      <binding name="c"><uri>https://developers.sap.com/kg/concept/cap-cds-query</uri></binding>
      <binding name="status"><literal>IN_PROGRESS</literal></binding>
    </result>
  </results>
</sparql>`,
    headers: '',
    latencyMs: 12,
  })),
}))

const { getConceptsForUser } = await import('../../srv/lib/kg/concepts-for-user.js')

function makeDb({ taskRecords = [], slugLookup = {} } = {}) {
  return {
    run: vi.fn(async (sqlOrCqn) => {
      const sql = typeof sqlOrCqn === 'string' ? sqlOrCqn : String(sqlOrCqn)
      if (sql.includes('TASKRECORDS')) return taskRecords
      if (sql.includes('TUTORIALS')) {
        return Object.entries(slugLookup).map(([ID, SLUG]) => ({ ID, SLUG }))
      }
      return []
    }),
  }
}

describe('getConceptsForUser', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects empty userId with TypeError', async () => {
    await expect(getConceptsForUser({ db: makeDb(), userId: '' })).rejects.toThrow(TypeError)
  })

  it('rejects malformed userId with TypeError', async () => {
    await expect(getConceptsForUser({ db: makeDb(), userId: 'has spaces' })).rejects.toThrow(TypeError)
  })

  it('returns empty { learned, partial } for user with no TaskRecords', async () => {
    const db = makeDb({ taskRecords: [] })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    expect(r).toEqual({ learned: [], partial: [], truncatedAt500: false })
  })

  it('partitions concepts by STATUS (COMPLETED→learned; IN_PROGRESS→partial)', async () => {
    const db = makeDb({
      taskRecords: [
        { TUTORIAL_ID: 'tut-1', STATUS: 'COMPLETED' },
        { TUTORIAL_ID: 'tut-2', STATUS: 'IN_PROGRESS' },
      ],
      slugLookup: { 'tut-1': 'cap-handlers-tutorial', 'tut-2': 'cds-query-tutorial' },
    })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    expect(r.learned).toContain('cap-handlers')
    expect(r.partial).toContain('cap-cds-query')
  })

  it('sets truncatedAt500: true when TaskRecords exceed cap', async () => {
    const taskRecords = Array.from({ length: 501 }, (_, i) => ({ TUTORIAL_ID: `t${i}`, STATUS: 'COMPLETED' }))
    const slugLookup = Object.fromEntries(Array.from({ length: 501 }, (_, i) => [`t${i}`, `slug-${i}`]))
    const db = makeDb({ taskRecords, slugLookup })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    expect(r.truncatedAt500).toBe(true)
  })

  it('dedupes: a concept in both buckets resolves to learned only', async () => {
    const db = makeDb({
      taskRecords: [{ TUTORIAL_ID: 't1', STATUS: 'COMPLETED' }, { TUTORIAL_ID: 't2', STATUS: 'IN_PROGRESS' }],
      slugLookup: { 't1': 'cap', 't2': 'cap' },
    })
    const r = await getConceptsForUser({ db, userId: '11111111-2222-3333-4444-555555555555' })
    const overlap = r.learned.filter(c => r.partial.includes(c))
    expect(overlap).toEqual([])
  })
})
```

- [ ] **Step 2: Run, confirm FAIL**

```bash
npx vitest run test/unit/concepts-for-user.test.js 2>&1 | tail -10
```

Expected: failed to resolve import.

- [ ] **Step 3: Write the implementation**

Create `srv/lib/kg/concepts-for-user.js` (use `matchAll()` for the SPARQL XML parser; do NOT use `.exec()` in iteration — security-hook false positive):

```js
// srv/lib/kg/concepts-for-user.js
//
// Joule-side helper for Issue #445 Phase 2 conceptsForUser. Returns the
// concepts the user has fully learned (from COMPLETED tutorials) and
// partially learned (from IN_PROGRESS tutorials), expressed as concept
// slugs (the trailing path segment of the concept IRI).
//
// Why not in KG_QUERY procedure: the graph does not carry user→tutorial
// edges (Phase 4 architectural decision; userIds stay out of the graph
// for privacy). KG_QUERY is fixed-arity (5 IN params); a variable-length
// list of tutorial IRIs cannot fit. We route through KG_ADMIN_RUNSPARQL
// instead — it accepts arbitrary JS-built SPARQL.
//
// Privacy: no user IDs reach HANA KGE. Only opaque tutorial IRIs are
// in the SPARQL body. TaskRecords queries inherit CAP audit logging.
//
// Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md

import cds from '@sap/cds'
import { kgAdminRunSparql } from '../kg-sparql-client.js'

const LOG = cds.log('concepts-for-user')

// UUID v4 shape OR a CAP-style SAP-ID (alphanumeric, 1-64 chars, plus hyphens/underscores).
const USER_ID_RE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_-]{1,64})$/

const TUTORIAL_IRI_PREFIX = 'https://developers.sap.com/kg/tutorial/'
const CONCEPT_IRI_PREFIX = 'https://developers.sap.com/kg/concept/'
const MAX_TASK_RECORDS = 500

/**
 * @param {object} args
 * @param {object} args.db - CDS db handle from cds.connect.to('db')
 * @param {string} args.userId - UUID or SAP-ID of the user
 * @returns {Promise<{ learned: string[], partial: string[], truncatedAt500: boolean }>}
 * @throws TypeError if userId is empty or malformed
 */
export async function getConceptsForUser({ db, userId }) {
  if (typeof userId !== 'string' || !userId.trim() || !USER_ID_RE.test(userId)) {
    throw new TypeError(`Invalid userId: ${JSON.stringify(userId)}`)
  }
  if (!db || typeof db.run !== 'function') {
    throw new TypeError('db must be a CDS service with a .run() method')
  }

  // Step 1: read TaskRecords. Cap at MAX_TASK_RECORDS+1 to detect truncation.
  const taskRecords = await db.run(
    `SELECT TUTORIAL_ID, STATUS FROM COM_SAP_DEVELOPERS_IMS_TASKRECORDS
     WHERE USER_ID = ? AND STATUS IN ('COMPLETED', 'IN_PROGRESS')
     ORDER BY COMPLETEDAT DESC NULLS LAST
     LIMIT ${MAX_TASK_RECORDS + 1}`,
    [userId]
  )
  if (!taskRecords || taskRecords.length === 0) {
    return { learned: [], partial: [], truncatedAt500: false }
  }
  const truncatedAt500 = taskRecords.length > MAX_TASK_RECORDS
  const capped = truncatedAt500 ? taskRecords.slice(0, MAX_TASK_RECORDS) : taskRecords

  // Step 2: look up slugs.
  const tutorialIds = [...new Set(capped.map(r => r.TUTORIAL_ID).filter(Boolean))]
  if (tutorialIds.length === 0) {
    return { learned: [], partial: [], truncatedAt500 }
  }
  const placeholders = tutorialIds.map(() => '?').join(',')
  const slugRows = await db.run(
    `SELECT ID, SLUG FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS WHERE ID IN (${placeholders})`,
    tutorialIds
  )
  const idToSlug = new Map((slugRows || []).map(r => [r.ID, r.SLUG]))

  // Build (iri, status) pairs with shape validation.
  const pairs = []
  for (const tr of capped) {
    const slug = idToSlug.get(tr.TUTORIAL_ID)
    if (!slug) continue
    const slugLc = slug.toLowerCase()
    if (!/^[a-z0-9-]{1,80}$/.test(slugLc)) continue
    pairs.push({ iri: `${TUTORIAL_IRI_PREFIX}${slugLc}`, status: tr.STATUS })
  }
  if (pairs.length === 0) {
    return { learned: [], partial: [], truncatedAt500 }
  }

  // Step 3: SPARQL with VALUES clause.
  const valuesBody = pairs.map(p => `(<${p.iri}> "${p.status}")`).join(' ')
  const sparql = `
PREFIX kg: <https://developers.sap.com/kg/>
SELECT ?c ?status
FROM <https://developers.sap.com/kg/tutorials-v3>
WHERE {
  VALUES (?t ?status) { ${valuesBody} }
  ?t kg:teaches ?c .
}
LIMIT 5000`

  // Step 4: route through KG_ADMIN_RUNSPARQL.
  let sparqlResult
  try {
    sparqlResult = await kgAdminRunSparql({ db, sparql, isUpdate: false })
  } catch (err) {
    LOG.warn('kgAdminRunSparql failed for getConceptsForUser:', err.message)
    return { learned: [], partial: [], truncatedAt500 }
  }

  // Step 5: parse XML with matchAll.
  const xml = sparqlResult?.response || ''
  const learned = new Set()
  const partial = new Set()
  for (const m of xml.matchAll(/<result>([\s\S]*?)<\/result>/g)) {
    const block = m[1]
    const cMatch = block.match(/<binding name="c">\s*<uri>([^<]+)<\/uri>/)
    const sMatch = block.match(/<binding name="status">\s*<literal[^>]*>([^<]+)</)
    if (!cMatch || !sMatch) continue
    const conceptIri = cMatch[1]
    const status = sMatch[1]
    const conceptSlug = conceptIri.startsWith(CONCEPT_IRI_PREFIX)
      ? conceptIri.slice(CONCEPT_IRI_PREFIX.length)
      : conceptIri
    if (status === 'COMPLETED') learned.add(conceptSlug)
    else if (status === 'IN_PROGRESS') partial.add(conceptSlug)
  }
  // Dedupe: learned wins.
  for (const c of learned) partial.delete(c)

  return { learned: [...learned], partial: [...partial], truncatedAt500 }
}
```

- [ ] **Step 4: Run, confirm PASS**

```bash
npx vitest run test/unit/concepts-for-user.test.js 2>&1 | tail -10
```

Expected: 6/6 passing.

- [ ] **Step 5: Verify CRLF + commit**

```bash
file srv/lib/kg/concepts-for-user.js test/unit/concepts-for-user.test.js
git branch --show-current
git add srv/lib/kg/concepts-for-user.js test/unit/concepts-for-user.test.js
git commit -m "feat(kg): getConceptsForUser helper for Joule pathBetween (#445)

Joins TaskRecords -> tutorial slugs -> tutorial IRIs -> KG_ADMIN_RUNSPARQL
SPARQL with VALUES clause -> { learned: concept-slugs, partial: ... }.

Caps at 500 most-recent records; deduplicates (learned wins).

No graph schema change; routes through kgAdminRunSparql since variable-
arity input doesn't fit KG_QUERY's fixed shape.

Tests: 6/6 unit, mocked db + mocked kgAdminRunSparql.

Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md
Refs #445."
```

---

## Task 5: `srv/lib/kg/joule-tool-find-path.js` — handler + descriptor (TDD)

**Files:**
- Create: `srv/lib/kg/joule-tool-find-path.js`
- Create: `test/unit/kg-path-between-handler.test.js`

The most substantive task. ~15 unit tests cover the handler's many branches.

- [ ] **Step 1: Inspect the established Joule-tool pattern**

```bash
head -80 srv/lib/branch/joule-tool.js
```

Mirror this style: export a `*_TOOL` descriptor + a `*Handler` async function.

- [ ] **Step 2: Write the failing tests**

Use the Write tool. Create `test/unit/kg-path-between-handler.test.js` with 15 cases covering:

1. Validation rejection: malformed `toSlug` returns friendly error string (no throw)
2. Validation rejection: malformed `fromSlug` (when provided)
3. `fromSlug` provided + valid: SPARQL called with that fromSlug
4. `fromSlug` omitted + user has TaskRecords: most-recent COMPLETED inferred; `fromSlugInferred: true` in telemetry
5. `fromSlug` omitted + zero TaskRecords + user provided: unanchored (uses toSlug as anchor); SPARQL called with `fromSlug = toSlug`
6. `fromSlug` omitted + no user at all: unanchored
7. SPARQL XML parsed → `[{slug, pathType, hopCount}]` shape
8. Empty SPARQL result → "no path found" string
9. `exactTargetReached === true` when toSlug is in candidates → promoted to position 1
10. User-coverage filter: candidate's concepts fully in `learned` → dropped
11. User-coverage filter exception: LLM-named `toSlug` never dropped
12. Dedup by slug: same slug from multiple arms → only lowest pathTypeRank survives
13. Hydration: `Tutorials.title` + `Tutorials.estimatedTimeMinutes` joined
14. Telemetry: both `path_requested` and `path_returned` emit; `path_returned` includes `latencyMs`
15. Timeout from `kgQuery` → friendly error + `error: 'timeout'` in telemetry

Test skeleton (~280 lines). Use mock factories similar to `concepts-for-user.test.js`:

```js
// test/unit/kg-path-between-handler.test.js
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../srv/lib/kg-sparql-client.js', () => ({
  kgQuery: vi.fn(),
  kgAdminRunSparql: vi.fn(),
  SparqlTimeoutError: class SparqlTimeoutError extends Error {},
}))
vi.mock('../../srv/lib/kg/concepts-for-user.js', () => ({
  getConceptsForUser: vi.fn(async () => ({ learned: [], partial: [], truncatedAt500: false })),
}))

const { kgQuery, SparqlTimeoutError } = await import('../../srv/lib/kg-sparql-client.js')
const { getConceptsForUser } = await import('../../srv/lib/kg/concepts-for-user.js')
const { findLearningPathHandler, FIND_LEARNING_PATH_TOOL } = await import('../../srv/lib/kg/joule-tool-find-path.js')

function makeDb({ taskRecords = [], tutorialRows = [] } = {}) {
  return {
    run: vi.fn(async (sqlOrCqn) => {
      const sql = typeof sqlOrCqn === 'string' ? sqlOrCqn : String(sqlOrCqn)
      if (sql.includes('TASKRECORDS')) return taskRecords
      if (sql.includes('TUTORIALS')) return tutorialRows
      if (sql.includes('UIEVENT')) return []  // telemetry insert
      return []
    }),
  }
}

function makeTelemetry() {
  const emitted = []
  return {
    emitted,
    emit: (event, payload) => emitted.push({ event, payload }),
  }
}

function buildXmlResponse(results) {
  const body = results.map(r => `
    <result>
      <binding name="b"><uri>https://developers.sap.com/kg/tutorial/${r.slug}</uri></binding>
      <binding name="pathType"><literal>${r.pathType}</literal></binding>
      <binding name="pathTypeRank"><literal datatype="http://www.w3.org/2001/XMLSchema#integer">${r.rank}</literal></binding>
      <binding name="hopCount"><literal datatype="http://www.w3.org/2001/XMLSchema#integer">0</literal></binding>
    </result>`).join('')
  return `<?xml version="1.0"?><sparql><results>${body}</results></sparql>`
}

describe('FIND_LEARNING_PATH_TOOL descriptor', () => {
  it('has the expected tool name and required toSlug param', () => {
    expect(FIND_LEARNING_PATH_TOOL.function.name).toBe('findLearningPath')
    expect(FIND_LEARNING_PATH_TOOL.function.parameters.required).toEqual(['toSlug'])
  })

  it('description names sibling tools to prevent collision', () => {
    const desc = FIND_LEARNING_PATH_TOOL.function.description
    expect(desc).toMatch(/getRelevantSteps/)
    expect(desc).toMatch(/checkCode/)
  })
})

describe('findLearningPathHandler', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects malformed toSlug with friendly error (no throw)', async () => {
    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'not a slug!' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(typeof result).toBe('string')
    expect(result).toMatch(/toSlug/i)
  })

  it('rejects malformed fromSlug with friendly error', async () => {
    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'valid-slug', fromSlug: 'BAD!!!' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(typeof result).toBe('string')
    expect(result).toMatch(/fromSlug/i)
  })

  it('uses provided fromSlug verbatim', async () => {
    kgQuery.mockResolvedValueOnce({ response: buildXmlResponse([]), headers: '', latencyMs: 10 })
    await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'target-slug', fromSlug: 'source-slug' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(kgQuery).toHaveBeenCalledWith(expect.objectContaining({
      queryName: 'PATH_BETWEEN',
      params: { fromSlug: 'source-slug', toSlug: 'target-slug' },
    }))
  })

  it('infers fromSlug from user most-recent COMPLETED TaskRecord', async () => {
    kgQuery.mockResolvedValueOnce({ response: buildXmlResponse([]), headers: '', latencyMs: 10 })
    const tel = makeTelemetry()
    await findLearningPathHandler({
      db: makeDb({
        taskRecords: [{ SLUG: 'most-recent-slug' }],
        tutorialRows: [],
      }),
      args: { toSlug: 'target-slug' },
      user: { id: '11111111-2222-3333-4444-555555555555' },
      telemetry: tel,
    })
    expect(kgQuery).toHaveBeenCalledWith(expect.objectContaining({
      params: { fromSlug: 'most-recent-slug', toSlug: 'target-slug' },
    }))
    const reqEvent = tel.emitted.find(e => e.event === 'kg.joule.path_requested')
    expect(reqEvent.payload.fromSlugInferred).toBe(true)
  })

  it('uses toSlug as anchor when user has no TaskRecords and no fromSlug provided', async () => {
    kgQuery.mockResolvedValueOnce({ response: buildXmlResponse([]), headers: '', latencyMs: 10 })
    await findLearningPathHandler({
      db: makeDb({ taskRecords: [] }),
      args: { toSlug: 'target-slug' },
      user: { id: '11111111-2222-3333-4444-555555555555' },
      telemetry: makeTelemetry(),
    })
    expect(kgQuery).toHaveBeenCalledWith(expect.objectContaining({
      params: { fromSlug: 'target-slug', toSlug: 'target-slug' },
    }))
  })

  it('uses toSlug as anchor when no user provided (anonymous)', async () => {
    kgQuery.mockResolvedValueOnce({ response: buildXmlResponse([]), headers: '', latencyMs: 10 })
    await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'target-slug' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(kgQuery).toHaveBeenCalledWith(expect.objectContaining({
      params: { fromSlug: 'target-slug', toSlug: 'target-slug' },
    }))
  })

  it('parses SPARQL XML into candidates with slug+pathType+hopCount', async () => {
    kgQuery.mockResolvedValueOnce({
      response: buildXmlResponse([
        { slug: 'cap-handlers', pathType: 'PREREQ', rank: 1 },
        { slug: 'fiori-deploy', pathType: 'CO_COMPLETED', rank: 2 },
      ]),
      headers: '',
      latencyMs: 50,
    })
    const result = await findLearningPathHandler({
      db: makeDb({
        tutorialRows: [
          { SLUG: 'cap-handlers', TITLE: 'CAP Handlers', ESTIMATEDTIMEMINUTES: 30 },
          { SLUG: 'fiori-deploy', TITLE: 'Fiori Deploy', ESTIMATEDTIMEMINUTES: 45 },
        ],
      }),
      args: { toSlug: 'cap-handlers', fromSlug: 'starting-point' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(result).toMatch(/CAP Handlers/)
    expect(result).toMatch(/Fiori Deploy/)
  })

  it('returns "no path found" string when zero candidates', async () => {
    kgQuery.mockResolvedValueOnce({ response: buildXmlResponse([]), headers: '', latencyMs: 10 })
    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'unreachable-target', fromSlug: 'orphan-source' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(result).toMatch(/couldn't find a path/i)
  })

  it('promotes exactTargetReached toSlug to position 1', async () => {
    kgQuery.mockResolvedValueOnce({
      response: buildXmlResponse([
        { slug: 'unrelated', pathType: 'SHARED_CONCEPT', rank: 3 },
        { slug: 'target-slug', pathType: 'CO_COMPLETED', rank: 2 },
      ]),
      headers: '',
      latencyMs: 30,
    })
    const result = await findLearningPathHandler({
      db: makeDb({
        tutorialRows: [
          { SLUG: 'unrelated', TITLE: 'Unrelated', ESTIMATEDTIMEMINUTES: 15 },
          { SLUG: 'target-slug', TITLE: 'Target', ESTIMATEDTIMEMINUTES: 20 },
        ],
      }),
      args: { toSlug: 'target-slug', fromSlug: 'src' },
      user: null,
      telemetry: makeTelemetry(),
    })
    // 'Target' (the toSlug) should appear before 'Unrelated' in the rendered output
    expect(result.indexOf('Target')).toBeLessThan(result.indexOf('Unrelated'))
  })

  it('filters candidates fully covered by user.learned concepts', async () => {
    getConceptsForUser.mockResolvedValueOnce({
      learned: ['concept-a', 'concept-b'],
      partial: [],
      truncatedAt500: false,
    })
    kgQuery.mockResolvedValueOnce({
      response: buildXmlResponse([
        { slug: 'covered-slug', pathType: 'CO_COMPLETED', rank: 2 },
      ]),
      headers: '',
      latencyMs: 20,
    })
    const result = await findLearningPathHandler({
      db: makeDb({
        tutorialRows: [{ SLUG: 'covered-slug', TITLE: 'Covered', ESTIMATEDTIMEMINUTES: 10, CONCEPTS: ['concept-a', 'concept-b'] }],
      }),
      args: { toSlug: 'something-else', fromSlug: 'src' },
      user: { id: '11111111-2222-3333-4444-555555555555' },
      telemetry: makeTelemetry(),
    })
    // covered-slug is the only candidate AND it's fully covered AND it's not toSlug
    // → it's dropped → no path found
    expect(result).toMatch(/couldn't find a path/i)
  })

  it('coverage-filter exception: LLM-named toSlug is never dropped', async () => {
    getConceptsForUser.mockResolvedValueOnce({
      learned: ['concept-a'],
      partial: [],
      truncatedAt500: false,
    })
    kgQuery.mockResolvedValueOnce({
      response: buildXmlResponse([
        { slug: 'covered-target', pathType: 'CO_COMPLETED', rank: 2 },
      ]),
      headers: '',
      latencyMs: 20,
    })
    const result = await findLearningPathHandler({
      db: makeDb({
        tutorialRows: [{ SLUG: 'covered-target', TITLE: 'Covered', ESTIMATEDTIMEMINUTES: 10, CONCEPTS: ['concept-a'] }],
      }),
      args: { toSlug: 'covered-target', fromSlug: 'src' },
      user: { id: '11111111-2222-3333-4444-555555555555' },
      telemetry: makeTelemetry(),
    })
    // toSlug == covered-target → kept despite full coverage
    expect(result).toMatch(/Covered/)
  })

  it('dedupes same slug from multiple arms (lowest rank wins)', async () => {
    kgQuery.mockResolvedValueOnce({
      response: buildXmlResponse([
        { slug: 'twice-listed', pathType: 'PREREQ', rank: 1 },
        { slug: 'twice-listed', pathType: 'CO_COMPLETED', rank: 2 },
        { slug: 'twice-listed', pathType: 'SHARED_CONCEPT', rank: 3 },
      ]),
      headers: '',
      latencyMs: 20,
    })
    const result = await findLearningPathHandler({
      db: makeDb({
        tutorialRows: [{ SLUG: 'twice-listed', TITLE: 'Twice', ESTIMATEDTIMEMINUTES: 10 }],
      }),
      args: { toSlug: 'something', fromSlug: 'src' },
      user: null,
      telemetry: makeTelemetry(),
    })
    // 'Twice' appears exactly once + reason is PREREQ (Prerequisite chain)
    const twiceMatches = result.match(/Twice/g) || []
    expect(twiceMatches.length).toBe(1)
    expect(result).toMatch(/Prerequisite chain/)
  })

  it('hydrates with title + estimated time', async () => {
    kgQuery.mockResolvedValueOnce({
      response: buildXmlResponse([{ slug: 'has-title', pathType: 'SHARED_CONCEPT', rank: 3 }]),
      headers: '',
      latencyMs: 20,
    })
    const result = await findLearningPathHandler({
      db: makeDb({
        tutorialRows: [{ SLUG: 'has-title', TITLE: 'Some Title', ESTIMATEDTIMEMINUTES: 25 }],
      }),
      args: { toSlug: 'has-title', fromSlug: 'src' },
      user: null,
      telemetry: makeTelemetry(),
    })
    expect(result).toMatch(/Some Title/)
    expect(result).toMatch(/25 min/)
  })

  it('emits both path_requested and path_returned events', async () => {
    kgQuery.mockResolvedValueOnce({ response: buildXmlResponse([]), headers: '', latencyMs: 12 })
    const tel = makeTelemetry()
    await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'x', fromSlug: 'y' },
      user: null,
      telemetry: tel,
    })
    expect(tel.emitted.find(e => e.event === 'kg.joule.path_requested')).toBeDefined()
    const retEvent = tel.emitted.find(e => e.event === 'kg.joule.path_returned')
    expect(retEvent).toBeDefined()
    expect(typeof retEvent.payload.latencyMs).toBe('number')
  })

  it('handles SparqlTimeoutError gracefully with telemetry error tag', async () => {
    kgQuery.mockRejectedValueOnce(new SparqlTimeoutError('timeout'))
    const tel = makeTelemetry()
    const result = await findLearningPathHandler({
      db: makeDb(),
      args: { toSlug: 'x', fromSlug: 'y' },
      user: null,
      telemetry: tel,
    })
    expect(typeof result).toBe('string')
    const retEvent = tel.emitted.find(e => e.event === 'kg.joule.path_returned')
    expect(retEvent.payload.error).toBe('timeout')
  })
})
```

- [ ] **Step 3: Run, confirm FAIL**

```bash
npx vitest run test/unit/kg-path-between-handler.test.js 2>&1 | tail -10
```

Expected: failed to resolve import.

- [ ] **Step 4: Write the handler implementation**

Create `srv/lib/kg/joule-tool-find-path.js`. The file is ~250 lines — use `String.prototype.matchAll()` for SPARQL XML parsing; do NOT use `.exec()` in iteration.

The full implementation MUST:

1. **Export `FIND_LEARNING_PATH_TOOL`** with the descriptor from spec § Layer 3
2. **Export `findLearningPathHandler({ db, args, user, telemetry })`** that:
   - Validates `args.toSlug` against `SLUG_RE = /^[a-z0-9-]{1,80}$/` (lowercased). Reject with `"That tutorial slug doesn't look right — try one like \\\`hana-cloud-cap-create-project\\\`. (got: <slug>)"`.
   - Validates `args.fromSlug` if provided
   - Resolves the effective `fromSlug`:
     - If provided: use it
     - Else if user.id present: `SELECT t.SLUG FROM TaskRecords r JOIN Tutorials t ON t.ID=r.TUTORIAL_ID WHERE r.USER_ID=? AND r.STATUS='COMPLETED' ORDER BY r.COMPLETEDAT DESC LIMIT 1`. If empty: fall through to unanchored.
     - Unanchored: `fromSlug = toSlug` (uses toSlug as its own neighborhood center)
   - Emits `path_requested` telemetry
   - Records `t0 = Date.now()`
   - Calls `kgQuery({ db, queryName: 'PATH_BETWEEN', params: { fromSlug, toSlug } })`
   - Catches `SparqlTimeoutError` and `SparqlSyntaxError` from kg-sparql-client; on error, emits `path_returned` with `error: <kind>` + returns "Internal error finding a learning path — please try a more specific question."
   - Parses XML with `matchAll()` → `[{ slug, pathType, hopCount }]`
   - Dedupes by slug (lowest rank wins) — sorts by `pathTypeRank` ASC first, then iterates keeping first per slug
   - If `toSlug` is in candidates, promotes to head (preserving the order of others)
   - If `user.id` present, calls `getConceptsForUser({ db, userId: user.id })`, filters covered candidates EXCEPT toSlug
   - Hydrates from `Tutorials` table (title, estimatedTimeMinutes, optionally CONCEPTS for the coverage check)
   - Emits `path_returned` with full payload
   - Returns rendered string:
     ```
     Here's a path from `<fromSlug>` to `<toSlug>`:

     1. **<title>** — [<slug>](https://developers.sap.com/tutorials/<slug>.html)
        ~<minutes> min · <reason>
     2. ...
     ```
3. **Telemetry uses `db.run(INSERT.into(UIEvent)…)`** via the `telemetry` callback if provided; falls back to a no-op if not. The orchestrator passes a real telemetry shim; unit tests pass a fake one.

(Implementation detail TBD by the implementer; the contract above + the unit tests fully specify behavior.)

- [ ] **Step 5: Run, confirm 15/15 PASS**

```bash
npx vitest run test/unit/kg-path-between-handler.test.js 2>&1 | tail -10
```

Expected: 15/15 passing. If any fail, the implementation deviated from the contract above. Fix without re-architecting.

- [ ] **Step 6: Verify CRLF + commit**

```bash
file srv/lib/kg/joule-tool-find-path.js test/unit/kg-path-between-handler.test.js
git branch --show-current
git add srv/lib/kg/joule-tool-find-path.js test/unit/kg-path-between-handler.test.js
git commit -m "feat(kg): findLearningPath Joule tool handler + descriptor (#445)

Exports FIND_LEARNING_PATH_TOOL (LLM-facing descriptor with negative-
space callouts naming getRelevantSteps/checkCode for collision avoidance)
and findLearningPathHandler (validate -> resolve fromSlug -> kgQuery ->
parse XML -> dedupe by slug, lowest-rank wins -> promote exactTargetReached
toSlug -> filter user-covered candidates (except toSlug) -> hydrate ->
render numbered list).

Telemetry: kg.joule.path_requested + kg.joule.path_returned.

15/15 unit tests passing.

Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md
Refs #445."
```

---

## Task 6: Wire findLearningPath into chat-orchestrator.js

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`

- [ ] **Step 1: Add the import**

```bash
sed -n '1,20p' srv/lib/chat-orchestrator.js
```

Find the existing kg-imports area (or just before `toolsForContext`). Add:

```js
import { FIND_LEARNING_PATH_TOOL, findLearningPathHandler } from './kg/joule-tool-find-path.js'
```

- [ ] **Step 2: Add conditional tool registration in `toolsForContext`**

Find the existing block (around line 195-205 with `if (settings?.branchingEnabled) { tools.push(GET_BRANCH_RECOMMENDATION_TOOL) }`). After that line, add:

```js
    if (settings?.kgPathBetweenEnabled) {
      tools.push(FIND_LEARNING_PATH_TOOL)
    }
```

- [ ] **Step 3: Add the dispatch arm**

Find the existing dispatch chain (around line 376-440). After `if (name === 'getBranchRecommendation') { … }`, add:

```js
  if (name === 'findLearningPath') {
    try {
      // findLearningPathHandler is the canonical impl for #445 Phase 2.
      // It receives the chat-orchestrator-managed telemetry shim so its
      // kg.joule.path_* events land in UIEvent via the standard path.
      return await findLearningPathHandler({ db: cds.db, args, user, telemetry })
    } catch (err) {
      LOG.warn('findLearningPath dispatch failed:', err.message)
      return 'Internal error finding a learning path — please try a more specific question.'
    }
  }
```

(Adapt the exact variable names — `cds.db` vs. the existing `db` reference, `user` vs. `req.user`, `telemetry` vs. the local shim name — to match the surrounding dispatch arms.)

- [ ] **Step 4: Run the existing chat-orchestrator tests + tool-pick tests**

```bash
npx vitest run test/unit/chat-orchestrator.test.js srv/lib/branch/*.test.js 2>&1 | tail -10
```

Expected: no regressions.

- [ ] **Step 5: Verify CRLF + commit**

```bash
file srv/lib/chat-orchestrator.js
git branch --show-current
git add srv/lib/chat-orchestrator.js
git commit -m "feat(kg): wire findLearningPath into chat-orchestrator (#445)

Three additions: import + conditional tool registration in
toolsForContext (gated by ChatSettings.kgPathBetweenEnabled) + dispatch
arm that delegates to findLearningPathHandler.

Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md
Refs #445."
```

---

## Task 7: Wire `conceptsForUser` CDS action handler

**Files:**
- Modify: `srv/knowledge-graph-service.js`

- [ ] **Step 1: Find the existing stub**

```bash
grep -nE "conceptsForUser|conceptCoverage" srv/knowledge-graph-service.js | head
```

Find the existing `this.on('conceptsForUser', …)` handler (around line 666) that returns the stub `{learned: [], partial: []}`.

- [ ] **Step 2: Replace the stub**

Update the handler to:

```js
this.on('conceptsForUser', async (req) => {
  const userId = req.data.userId || req.user?.id
  if (!userId) return { learned: [], partial: [] }
  try {
    const { getConceptsForUser } = await import('./lib/kg/concepts-for-user.js')
    const { ChatSettings } = cds.entities('com.sap.developers.ims')
    const settings = await SELECT.one.from(ChatSettings)
    if (!settings?.kgPathBetweenEnabled) {
      return { learned: [], partial: [] }
    }
    const result = await getConceptsForUser({ db: cds.db, userId })
    return { learned: result.learned, partial: result.partial }
  } catch (err) {
    log.warn(`kg-service: conceptsForUser failed: ${err.message}`)
    return { learned: [], partial: [] }
  }
})
```

- [ ] **Step 3: Run unit tests (broader sweep — knowledge-graph-service has unit tests)**

```bash
npx vitest run test/unit/knowledge-graph-service.test.js 2>&1 | tail -10
```

Expected: no regressions.

- [ ] **Step 4: Verify CRLF + commit**

```bash
file srv/knowledge-graph-service.js
git branch --show-current
git add srv/knowledge-graph-service.js
git commit -m "feat(kg): wire conceptsForUser CDS action to helper (#445)

Replaces the Phase 2 stub at the conceptsForUser action handler with
a delegation to getConceptsForUser. Flag-gated by
ChatSettings.kgPathBetweenEnabled (returns empty coverage when off).

Spec: docs/superpowers/specs/2026-06-22-issue-445-joule-pathbetween-design.md
Refs #445."
```

---

## Task 8: Hybrid test for conceptsForUser

**Files:**
- Create: `test/hybrid/concepts-for-user.test.js`

Mirror style from `test/hybrid/kg-procedures-graph-ops.test.js`. Tests use `__TEST__`-prefixed user data and clean up in `afterAll`.

- [ ] **Step 1: Write the hybrid test**

5 tests:
1. With zero TaskRecords for a fake user → empty coverage
2. With one COMPLETED TaskRecord → 1+ concepts in `learned`
3. With one IN_PROGRESS TaskRecord → 1+ concepts in `partial`
4. With both → partition correctly + dedupe (learned wins)
5. `truncatedAt500: true` when seeded with 501 TaskRecords (heavy setup; optional)

Use the `_guard.js` hybrid-write-safety pattern.

- [ ] **Step 2: Run + commit**

(Detailed test body left to implementer; pattern is well-established. Commit message: `test(kg): hybrid tests for getConceptsForUser (#445)`.)

---

## Task 9: AI-judge fixture for tool-pick

**Files:**
- Create: `test/hybrid/joule-tool-pick-find-path.test.js`

Gated by `HYBRID_AI_TESTS=true`. Per memory `HYBRID_AI_TESTS=true to opt into category-classifier hybrid test`, this gate keeps the default `npm run test:hybrid` at $0.

- [ ] **Step 1: Look up the existing AI-judge pattern**

```bash
head -80 test/hybrid/categories-classifier.test.js
```

Mirror the structure: import the orchestrator helper that runs a real LLM tool-pick call against a prompt, assert which tool was picked.

- [ ] **Step 2: Write the 12-fixture test**

Use the prompts from spec § "AI-judge fixture (12 prompts)" verbatim. Pass threshold ≥90% (11/12). One known-failing prompt is allowed; >1 fails the test.

- [ ] **Step 3: Commit**

```
test(joule): AI-judge fixture for findLearningPath tool-pick (#445)

12-prompt fixture asserting the LLM picks the right tool (findLearningPath
vs getRelevantSteps vs checkCode vs no-tool). Pass threshold ≥90% (11/12).

Gated by HYBRID_AI_TESTS=true; default test:hybrid runs at $0.
```

---

## Task 10: Smoke test for deployed runtime

**Files:**
- Create: `test/smoke/joule-find-learning-path.test.js`

Single test: POST to `/chat/stream` with a known findLearningPath-shaped prompt. Asserts response includes a numbered list with at least 3 tutorial slugs.

- [ ] **Step 1: Mirror the existing kg-deployed smoke**

```bash
head -80 test/smoke/kg-deployed.test.js
```

- [ ] **Step 2: Write the smoke test**

Skip-on-missing-env pattern. Uses `SMOKE_BASE_URL` + `SMOKE_AUTH_TOKEN`. 90s timeout per memory `kg-deployed smoke pattern`.

- [ ] **Step 3: Commit**

```
test(smoke): joule findLearningPath end-to-end probe (#445)

POSTs to /chat/stream with a fixture prompt; asserts response includes
the numbered learning-path list. Self-skips when SMOKE_AUTH_TOKEN
absent.
```

---

## Task 11: Documentation

**Files:**
- Modify: `docs/developers/architecture/knowledge-graph.md`
- Modify: `docs/developers/operations/testing-endpoints.md`
- Modify: `docs/developers/operations/runtime-config.md`

- [ ] **Step 1: Architecture page — add Phase 2 section**

Insert a new `## Phase 2 — pathBetween (findLearningPath)` section. ~50 lines: hybrid UNION strategy, why prereq is sparse (link to spec), JS-side post-processing, the `kgPathBetweenEnabled` flag.

- [ ] **Step 2: Testing endpoints — add findLearningPath row**

Add to the Joule tools subsection.

- [ ] **Step 3: Runtime config — add flag row**

Add to the ChatSettings flag table.

- [ ] **Step 4: VitePress build check**

```bash
npm run docs:build 2>&1 | tail -5
```

Expected: `build complete`. Memory `feedback_vitepress_mtaext_dead_links` — angle brackets in prose get parsed as HTML; if the docs build fails on `<this-PR>` style placeholders, replace with the actual PR number or use code-spans.

- [ ] **Step 5: Commit**

```
docs(kg): Phase 2 findLearningPath rollout notes (#445)
```

---

## Task 12: Final verification

**Files:** none

- [ ] **Step 1: Run all touched-area tests**

```bash
npx vitest run test/unit/concepts-for-user.test.js test/unit/kg-path-between-handler.test.js test/hybrid/kg-path-between.test.js 2>&1 | tail -10
```

Expected: green.

- [ ] **Step 2: Run broader unit sweep**

```bash
npm test 2>&1 | grep -E "Test Files|Tests +[0-9]" | tail -5
```

Expected: prior-baseline counts + ~21 new unit tests, no other regressions. Pre-existing flaky tests (github-rest, branch-loaders) tolerable.

- [ ] **Step 3: Confirm full file change list**

```bash
git log --stat main..HEAD
```

Expected: matches the file map exactly.

- [ ] **Step 4: CRLF sweep**

```bash
file db/schema.cds db/src/procedures/KG_QUERY.hdbprocedure srv/lib/kg/*.js srv/lib/chat-orchestrator.js srv/knowledge-graph-service.js test/unit/concepts-for-user.test.js test/unit/kg-path-between-handler.test.js test/hybrid/kg-path-between.test.js test/hybrid/concepts-for-user.test.js test/hybrid/joule-tool-pick-find-path.test.js test/smoke/joule-find-learning-path.test.js docs/developers/architecture/knowledge-graph.md docs/developers/operations/testing-endpoints.md docs/developers/operations/runtime-config.md
```

Expected: all "ASCII text" or "UTF-8 Unicode text", never "CRLF".

- [ ] **Step 5: Parent worktree clean**

```bash
git -C ../../.. log --oneline -1
```

Expected: unchanged from session start.

---

## Task 13: Push branch + open PR

**Files:** none

- [ ] **Step 1: Push**

```bash
git push -u origin feat/445-joule-pathbetween
```

- [ ] **Step 2: Open PR via gh**

Write the PR body to `_pr_body.md` then `gh pr create --base main --head feat/445-joule-pathbetween --title "feat(kg): Phase 2 — Joule findLearningPath tool with hybrid path strategy (#445)" --body-file _pr_body.md`. Body content covers: Why (the spike-driven pivot), Design (3-layer architecture + spec link), What ships (table), Test coverage delta, Deploy (no deploy in this PR; admin flips flag post-MTA-redeploy), Traceability (#381, #445, #555 cross-refs).

- [ ] **Step 3: Comment on issue #445 with the PR link**

---

## Out of scope (do NOT do in this PR)

- **MTA redeploy** — Tom batches deploys; this PR doesn't trigger one
- **Filling in Phase 2 rollout note** — that happens 48h post-flag-flip, not in this PR
- **Prereq-graph enrichment job** — separate Phase 2.5 follow-up issue
- **`kg:completedBy` user→tutorial edge** — Phase 4 architectural change
- **Explore UI page** — Phase 3 (#446) territory
- **k-shortest paths** — return one path per pathType

---

## Common-mistake red flags for the implementer

- **Branch-slip after long sessions** (memory `feedback_branch_slip_after_long_session`) — verify `git branch --show-current` in the same bash invocation as every `git commit`
- **CRLF on Windows** (memory `feedback_crlf_regression_on_windows`) — `file` check after every write
- **Subagent writes leaking to parent repo** (memory `feedback_subagent_writes_can_leak_to_parent_repo`) — `git -C ../../.. status` clean check after every commit
- **Security hook false positive on `.exec()` regex** (from PR #555 + PR #560 experience) — prefer `String.prototype.matchAll()` for regex iteration in source files
- **VitePress angle-bracket parsing** (memory `feedback_vitepress_mtaext_dead_links` + experience from PR #560) — avoid literal `<placeholder>` prose; use code-spans or actual numbers
- **Don't redeploy** (memory `feedback_confirm_deploy_scope`) — this PR does NOT deploy; Tom batches
- **CAP CSV seeds clobber admin data** (memory `feedback_cap_csv_seeds_clobber_admin_data`) — `ChatSettings` is admin-editable. The new `kgPathBetweenEnabled` column does NOT need a CSV seed; existing rows get the default `false` automatically
- **`cds.entities` runtime-only** (memory `feedback_cds_entities_runtime_only`) — the test mocks bypass this; the production handler uses `cds.entities` correctly via dynamic import
