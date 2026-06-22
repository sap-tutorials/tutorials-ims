# KG SPARQL DEFINER procedures — design

**Status:** Design for #533 (per-graph ACL) follow-up, Phase 1.5 of [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381).
**Date:** 2026-06-22
**Branch:** `feat/kg-sparql-definer-procedures`

## Problem

The 2026-06-21/22 KG verification arc exposed a recurring failure mode: HANA Cloud KGE applies **per-graph ACL** where the runtime user that first executes `INSERT DATA { GRAPH <iri> { ... } }` becomes the graph's owner. Subsequent runtime users — including ones with the same system-level `SPARQL UPDATE` privilege granted via the `.hdbgrants` flow — get `"User is not allowed to perform this action - (INSERT)"` when they try to write to that graph.

The HDI container has **multiple runtime users** (one per service-binding), all with `default_access_role` (which carries system-level `SPARQL UPDATE`). But the per-graph ACL is exact-user, not role-based. So:

- `cds bind --exec` probes lock the graph to the local-dev runtime user
- the deployed `tutorials-srv` runs as a different runtime user
- the deployed app cannot write to a graph created by a probe

We've bumped the graph IRI twice already (`tutorials` → `tutorials-v2` after [#534](https://github.com/sap-tutorials/tutorials-ims/pull/534); a v3 bump was prepared and abandoned in favour of this design). Each bump is a workaround that lasts until the next probe-or-restart cycle locks the new IRI under the wrong user.

**Root cause:** SPARQL invocation runs with **invoker rights** by default — the calling runtime user's identity reaches `SYS.SPARQL_EXECUTE`, and HANA records that identity as the graph creator. Different binding = different invoker = different recorded creator = ACL collision.

## Approach

Wrap every `CALL SYS.SPARQL_EXECUTE(...)` invocation in an HDI `.hdbprocedure` declared with **`SQL SECURITY DEFINER`**. The procedure body executes as the HDI container's **object-owner user** (`#OO`) regardless of which runtime user called the procedure. The object-owner identity is stable across bindings, deploys, and probes — so every SPARQL call lands at HANA's KGE as the same logical identity, and per-graph ACL becomes a non-issue.

Combined with this, the SPARQL layer gets a **typed-procedure boundary** instead of a SPARQL-string passthrough: the JS layer no longer constructs arbitrary SPARQL. Each procedure owns one SPARQL shape, assembled inside the procedure from typed parameters. This eliminates a class of SPARQL-injection risks at the JS-to-DB boundary.

## Architecture

```text
                       BEFORE                                          AFTER
                       ──────                                          ─────
srv code                                                srv code
   │                                                       │
   ▼                                                       ▼
kg-sparql-client.js                                     kg-sparql-client.js
   │ db.run(DO BEGIN CALL SYS.SPARQL_EXECUTE END)          │ db.run(CALL "KG_..."(?, ?, ?, ?))
   ▼                                                       ▼
HANA SQL engine                                         HANA SQL engine
   │ runs as <binding>_RT                                  │ procedure call as <binding>_RT
   ▼                                                       │ but body runs as #OO (object owner)
SYS.SPARQL_EXECUTE                                          ▼
   │ per-graph ACL pins to <binding>_RT                SYS.SPARQL_EXECUTE
                                                           │ per-graph ACL pins to #OO (stable)
```

Two interface contracts:

- **JS → procedure**: `srv/lib/kg-sparql-client.js` exports 4 typed functions. SPARQL never crosses this boundary as a string except through `kgAdminRunSparql` (XSUAA-gated escape hatch).
- **Procedure → SPARQL**: each procedure assembles its SPARQL from typed parameters and calls `SYS.SPARQL_EXECUTE`. The procedure body is the single source of truth for SPARQL shape.

## The 4 procedures

All four live under `db/src/procedures/` with `SQL SECURITY DEFINER`. Mirrored under `db-qa/src/procedures/` as stubs (see [QA channel](#qa-channel)).

### `KG_GRAPH_CLEAR(IN graph_iri NVARCHAR(500), OUT response NCLOB, OUT headers NVARCHAR(5000))`

Assembles `'CLEAR GRAPH <' || :graph_iri || '>'` and forwards to `SYS.SPARQL_EXECUTE`. Validates `:graph_iri` against `^https?://[A-Za-z0-9./_-]+$` OR `^urn:[A-Za-z0-9:_-]+$`; raises `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_INVALID_IRI'` on mismatch. Length 1-500.

### `KG_GRAPH_INSERT(IN graph_iri NVARCHAR(500), IN triples NCLOB, OUT response NCLOB, OUT headers NVARCHAR(5000))`

Assembles `'INSERT DATA { GRAPH <' || :graph_iri || '> { ' || :triples || ' } }'`. Same `graph_iri` validation. `:triples` must be non-empty. Defensive: `:triples` must NOT contain the literal substring `'} }'` (followed by non-whitespace) — prevents a malicious N-Triples body from escaping the `INSERT DATA` block and appending another SPARQL operation. The JS-side N-Triples generator never emits `} }`, so this is belt-and-suspenders.

### `KG_QUERY(IN query_name NVARCHAR(50), IN p1 NVARCHAR(500), IN p2 NVARCHAR(500), IN p3 NVARCHAR(500), IN override_graph_iri NVARCHAR(500), OUT response NCLOB, OUT headers NVARCHAR(5000))`

Named-query dispatcher. Body:

```sql
CASE :query_name
  WHEN 'NEIGHBORHOOD'      THEN /* assembles SPARQL using :p1 (tutorial IRI) */
  WHEN 'PATH_BETWEEN'      THEN /* using :p1 (from), :p2 (to) */
  WHEN 'CONCEPTS_FOR_USER' THEN /* using :p1 (userId) */
  ELSE SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_UNKNOWN_QUERY'
END CASE
```

Each branch contains the verbatim SPARQL from today's `kg-queries.js`, with the variable IRI slots concatenated from `:p1`/`:p2`/`:p3`. The `FROM <graph>` clause uses the hardcoded prod IRI when `:override_graph_iri` is null, otherwise uses the override (for hybrid tests against TEST graphs).

Per-parameter validation happens **inside each `WHEN` branch** so each query gets only the validators it cares about (e.g. NEIGHBORHOOD validates `:p1` against `^https://developers\.sap\.com/kg/tutorial/[a-z0-9-]{1,80}$`). JS pre-validates too.

### `KG_ADMIN_RUNSPARQL(IN sparql NCLOB, IN is_update NVARCHAR(1), OUT response NCLOB, OUT headers NVARCHAR(5000))`

Admin escape hatch. Forwards `:sparql` to `SYS.SPARQL_EXECUTE` verbatim. The `:is_update` flag (`'Y'`/`'N'`) is informational/audit only — both paths use the same `SYS.SPARQL_EXECUTE` API. The XSUAA `KnowledgeGraph.Admin` scope check stays at the CDS-service layer in `knowledge-graph-service.js`; the procedure trusts that the JS layer has authenticated the caller.

**Audit sink for `is_update`**: the existing `audit('KnowledgeGraphRunSparql', { ... })` call in `knowledge-graph-service.js:625` (the JS-side admin handler) gains an `isUpdate: boolean` field in its payload. The procedure itself does not log — HANA-side procedure audit is overhead for marginal value when the JS layer is already auditing every admin invocation.

### `EXECUTE` grants

The existing `db/src/_grants.hdbgrants` adds object privileges for `default_access_role` on the 4 procedure objects. Every binding's runtime user inherits the role and gains `EXECUTE` on all four.

## JS-side typed client

`srv/lib/kg-sparql-client.js` is rewritten as a typed dispatch module. Today's `SPARQL_DO_BLOCK` const, `invoke()` private function, and `sparqlExec`/`sparqlQuery` exports are **all deleted** — no compatibility layer.

```js
// All four return { response, headers, latencyMs } — same shape as today's invoke().
// All four throw SparqlPrivilegeError / SparqlSyntaxError / SparqlTimeoutError
// on the same conditions today's invoke() does. The classify-and-throw logic is
// unchanged; only the call shape changes.

export function kgGraphClear({ db, graphIri, timeoutMs })
export function kgGraphInsert({ db, graphIri, triples, timeoutMs })
export function kgQuery({ db, queryName, params, overrideGraphIri, timeoutMs })
export function kgAdminRunSparql({ db, sparql, isUpdate, timeoutMs })
```

**Internal shape**: All four delegate to a private `callProcedure(db, procName, args, opts)` helper that (1) wraps `db.run('CALL "<procname>"(?, ?, ?, ?)', [...args, null, null])` (the last two `null`s reserve OUT-param slots), (2) coerces the result row via the existing `coerceRow` helper, (3) wraps with `withTimeout` and `classifyAndThrow` (both reused unchanged).

**Procedure name resolution**: `cds.connect.to('db')` is already in the HDI container schema, so unqualified procedure names (`CALL KG_GRAPH_CLEAR(?, ?, ?)`) resolve correctly. This matches how every other table reference in this codebase works.

**Named-keys mapping for `kgQuery`**:

```js
const QUERY_PARAM_SHAPES = Object.freeze({
  NEIGHBORHOOD:      { required: ['slug'],              order: ['slug'] },
  PATH_BETWEEN:      { required: ['fromSlug', 'toSlug'], order: ['fromSlug', 'toSlug'] },
  CONCEPTS_FOR_USER: { required: ['userId'],            order: ['userId'] },
});

// Example:
//   kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug: 'foo' } })
//   → CALL KG_QUERY('NEIGHBORHOOD', 'foo', NULL, NULL, NULL, ?, ?)
//
//   kgQuery({ db, queryName: 'PATH_BETWEEN', params: { fromSlug: 'a', toSlug: 'b' } })
//   → CALL KG_QUERY('PATH_BETWEEN', 'a', 'b', NULL, NULL, ?, ?)
```

Validation enforces `Object.keys(params)` exactly matches `QUERY_PARAM_SHAPES[queryName].required` — extras throw, missing throws, unknown `queryName` throws. Positional resolution happens via `order`. The positional contract is centralised in this module and not duplicated in callers.

**JS-side validation per entry point**:

| Function | Validates |
|---|---|
| `kgGraphClear` | `graphIri` matches `^https?://[A-Za-z0-9./_-]+$` or `^urn:...$`, length 1-500 |
| `kgGraphInsert` | same graphIri rules; `triples` non-empty string, NCLOB-length ≤ 16MB (sanity cap, real batches ~30KB) |
| `kgQuery` | `queryName` ∈ allowlisted set; `params` is an object whose keys exactly match the query's `required`; each value is a string ≤ 500 chars; optional `overrideGraphIri` validated as IRI |
| `kgAdminRunSparql` | `sparql` non-empty string ≤ 16MB; `isUpdate ∈ {true, false}` (mapped to `'Y'`/`'N'`) |

JS validators throw `TypeError`/`RangeError` synchronously **before** the DB call. The procedure's own validation is the second line of defence.

## Caller migration (same PR)

Three files migrate to the typed client in the same PR — no adapter layer ever exists.

**`srv/lib/kg-graph-rebuild.js`** — 3 call sites:
- Bootstrap INSERT → `kgGraphInsert({ db, graphIri: targetGraph, triples: BOOTSTRAP_TRIPLE })`
- CLEAR GRAPH → `kgGraphClear({ db, graphIri: targetGraph })`
- Per-batch INSERT DATA → `kgGraphInsert({ db, graphIri: targetGraph, triples: batchAsNTriples })`

The existing `buildInsertData(graphIri, batch)` helper (which wrapped the N-Triples batch in `INSERT DATA { GRAPH <...> { ... } }`) becomes redundant — the procedure builds the wrapper. JS just passes the raw N-Triples body. **Net: `buildInsertData` deleted, callers cleaner.**

**`srv/knowledge-graph-service.js`** — 2 call sites:
- Neighborhood handler (`line 532`): `sparqlQuery(db, builtSparql)` → `kgQuery({ db, queryName: 'NEIGHBORHOOD', params: { slug } })`. The pre-built SPARQL string assembly above this line is no longer needed.
- Admin runSparql (`line 634`): `sparqlQuery(db, query)` → `kgAdminRunSparql({ db, sparql: query, isUpdate: detectUpdate(query) })`. `detectUpdate(sparql)` is a small helper using regex on `^\s*(INSERT|DELETE|CLEAR|DROP|CREATE|LOAD)\b/i`.

**`srv/lib/kg-queries.js`** — the SPARQL template exports (`NEIGHBORHOOD_QUERY`, `PATH_BETWEEN_QUERY`, `CONCEPTS_FOR_USER_QUERY`) are **deleted**. The procedures own them. The `substitute()` helper and slug-validation regex (`SLUG_RE`) are **kept** — JS callers still validate slugs before passing to `kgQuery({ params: { slug } })`. The module shrinks to a slug-validation module; the filename stays (renaming adds blast radius). The module header comment **must be updated** to reflect the narrower scope — the existing header documents this file as the SPARQL template source, which is no longer accurate post-migration. A future reader expecting SPARQL strings here should be redirected to the procedures by the header.

## Testing

### Unit tests

| File | What it covers | New / Modified |
|---|---|---|
| `test/unit/kg-sparql-client-validation.test.js` | JS-side input validation for all 4 entry points — IRI shape, NCLOB length caps, queryName allowlist, named-keys shape match per query, isUpdate flag mapping | NEW |
| `test/unit/kg-sparql-client-dispatch.test.js` | Mock `db.run`, assert each entry point dispatches to the right `CALL KG_..."(?, ?, ?, ?)"` with positional args in the right order | NEW |
| `test/unit/kg-queries.test.js` | Slug validation regex + `substitute()` helper (the parts that survive) | MODIFIED — shrinks from ~36 to ~12-15 tests |
| `test/unit/kg-graph-rebuild-bootstrap.test.js` | Bootstrap-before-CLEAR contract from #525 — re-mock to assert `kgGraphInsert` then `kgGraphClear` call sequence (was: `sparqlExec` twice with regex match on SPARQL string) | MODIFIED — assertion target shifts from SPARQL strings to typed-call sequence |
| `test/unit/kg-graph-rebuild-predicate-counts.test.js` | Predicate-count projection from #526 — unchanged (doesn't touch the SPARQL layer) | UNCHANGED |

### Hybrid tests (real HANA via `cds bind --exec`)

| File | Concern |
|---|---|
| `test/hybrid/kg-graph-rebuild.test.js` | Existing end-to-end test. Migrates to typed client. Uses `KG_QUERY`'s `override_graph_iri` param to target the test graph instead of prod. |
| `test/hybrid/kg-named-queries.test.js` | Same migration: now invokes `kgQuery({ queryName, params, overrideGraphIri: TEST_GRAPH_IRI })`. Procedure dispatch verified against real HANA. |
| `test/hybrid/kg-procedure-acl.test.js` | **NEW — the proof DEFINER works.** Demonstrates two different runtime users (the `cds bind` user and a synthetic second binding via `cf service-key`) can both write to the same graph after one creates it via the procedure. This would have caught today's bug if it had existed yesterday. |

### Smoke test (deployed runtime)

`test/smoke/kg-deployed.test.js` — NEW. Probes the deployed srv via authenticated HTTP. Hits `POST /graph/triggerGraphRebuild` with a `KnowledgeGraph.Admin`-scoped token, asserts `200` + `tripleCount > 0`, then `GET /graph/neighborhood?slug=<known-slug>` returns ≥1 result row.

### What is NOT tested

- **No isolated unit test of `.hdbprocedure` SQL bodies**. HANA SQLScript doesn't have a usable unit-test harness. Hybrid tests are the only place we can verify procedure parse + execute behaviour. Matches the rest of the codebase's HANA-side practice (no test for `.hdbgrants` either).
- **No assertion that the procedure runs as object-owner vs invoker**. HANA doesn't expose `CURRENT_USER` differently across the call boundary in a way we can cheaply assert. Proof is **observational** via `kg-procedure-acl.test.js` — two binding-users can both write to the same graph, which is only possible if the procedure body runs as a shared identity.

## QA channel

QA gets stub procedures under `db-qa/src/procedures/` with identical signatures but bodies of:

```sql
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'KG_NOT_AVAILABLE_ON_QA'
```

The same `_grants.hdbgrants` mirror grants `EXECUTE` on the QA stubs to QA's `default_access_role`. srv-qa code that compiles to call `kgQuery` etc. will fail gracefully at runtime if anything actually invokes the KG path — but the QA srv doesn't have KG cron jobs scheduled (the consolidator and extractor only run on the prod srv), so this should never fire in practice. The stubs exist to keep the deploy artefact-set consistent and to make any accidental call loud rather than silent.

## Rollout

1. **Local rebuild** — `cds build --production` regenerates `gen/db/src/gen/` with the new procedure artefacts. CDS-build-staging check (PR #524) passes (new files, no existing-tracked-artefact diff).
2. **`mbt build` + `cf deploy`** — HDI deployer creates the 4 procedures + grants `EXECUTE` to `default_access_role`. srv apps restart with the new typed client.
3. **Probe** — from `cds bind --exec`, call `kgGraphClear({ db, graphIri: 'urn:test:procedure-proof:' + Date.now() })`. If success, procedure layer works.
4. **Trigger rebuild** — click the admin UI button OR `cf run-task` an invocation of `triggerGraphRebuild`. The procedure-mediated bootstrap+CLEAR+INSERT runs against `tutorials-v2`.
5. **Outcome A: success** — `GraphMetadata` populates with `tripleCount > 0`. Sidebar starts rendering on tutorial OPs. Done.
6. **Outcome B: `tutorials-v2` still ACL-blocked** — one-line bump to `tutorials-v3` in the procedure body (`KG_QUERY` branches + `DEFAULT_GRAPH_IRI` in `kg-graph-rebuild.js`). Redeploy. The procedure now creates the graph as object-owner; future bindings inherit access via the procedure boundary, so this is the last bump ever needed.

**Decision rule for A vs B**: step 3's `urn:test:...` probe (a fresh IRI the object-owner has never touched) is the ground truth. If step 3 succeeds AND step 4 against `tutorials-v2` returns the same `User is not allowed (INSERT)` error we saw on 2026-06-22, the implementer **skips straight to Outcome B**. Do not debug — the v2 IRI's ACL pin survives even from the object-owner, and bumping is faster than diagnosing the cleanup path for an orphan graph. Outcome A is only declared when the step-4 rebuild produces a non-zero `tripleCount`.

## Risk surface

| Risk | Likelihood | Mitigation |
|---|---|---|
| Procedure SQL syntax error breaks the HDI deploy | Low — bodies are mechanical concatenation of known-good SPARQL | `cds build --production` catches syntactic errors locally before deploy. Hybrid test catches semantic errors before merge. |
| `EXECUTE` grant doesn't land on `default_access_role` for some bindings | Low — `_grants.hdbgrants` is the canonical channel | `kg-procedure-acl.test.js` would fire on this. |
| `tutorials-v2` (still owned by user-A from yesterday's probe) blocks the FIRST `kgGraphInsert` from the procedure | Medium — unverified until deploy | Procedure runs as object-owner, so its INSERT against `tutorials-v2` either (a) succeeds because the object-owner has implicit access to all container-owned graphs, or (b) fails because the per-graph ACL pins to user-A even for the object-owner. If (b), Outcome B above kicks in: bump to `tutorials-v3` and the procedure creates it cleanly. |
| Existing `runSparql` admin endpoint behaviour changes for users | Low — same XSUAA gate, same SPARQL forwarding | Smoke test + manual click verification on deploy. |

## Removed code

After this PR:
- `srv/lib/kg-sparql-client.js`: `SPARQL_DO_BLOCK` const + private `invoke()` + the two pass-through exports → **all gone**. Module ~30% smaller.
- `srv/lib/kg-queries.js`: `NEIGHBORHOOD_QUERY`, `PATH_BETWEEN_QUERY`, `CONCEPTS_FOR_USER_QUERY` template strings → **gone**. Module ~70% smaller; validators remain.
- `srv/lib/kg-graph-rebuild.js`: `buildInsertData()` helper → **gone**.
- `test/unit/kg-queries.test.js`: ~36 tests → ~12-15 (validation-only).

**Net**: the boundary moves from JS-side SPARQL-string assembly to DB-side procedure assembly. JS surface for SPARQL shrinks; HANA-side surface grows by ~4 files (~200 lines of SQLScript). The shared interface is 4 typed procedure calls.

## Refs

- #533 (the per-graph ACL bug this fixes)
- #525 / PR #529 (bootstrap fix — still correct, still needed)
- #526 / PR #530 (predicate counts — still correct, still needed)
- PR #534 (`tutorials-v2` IRI bump — the workaround this design supersedes)
- Memory: `hana_sparql_per_graph_acl_creator_owns`
- Memory: `xsuaa_scope_changes_need_manual_update_service`
- Original KG design: [`docs/superpowers/specs/2026-06-17-knowledge-graph-design.md`](./2026-06-17-knowledge-graph-design.md) — its line 624 ("INSERT DATA into an unknown named graph creates it implicitly … Privileges are SPARQL QUERY + SPARQL UPDATE delivered via `.hdbgrants`") is the assumption this design corrects. The original spec was right about implicit-create but missed that creator-ownership pins per-graph ACL; this design eliminates that pin by making the creator a stable object-owner identity.
