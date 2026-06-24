# HANA / HDI / SQL gotchas

A reference of HANA-, HDI-, and SQL-specific pitfalls that have bitten this project. Each section is a single discovered failure mode with cause, why, and how to apply. These were originally one-fact agent-memory files; consolidated here so platform engineers find them via the VitePress sidebar instead of by guessing memory names.

> Originally maintained as separate memory entries under `~/.claude/projects/d--projects-tutorials-poc/memory/`. Promoted to docs 2026-06-24 to make them discoverable to humans + agents alike.

## How to use this doc

Search (Ctrl-F) for the error message you're seeing, the API you're using, or the symptom. Each section is independent — read only the one you need.

## Sections

- [HANA raw SQL requires UPPERCASE identifiers](#hana-raw-sql-requires-uppercase-identifiers)
- [HANA boolean CASE WHEN — compare to literal, never bare](#hana-boolean-case-when-compare-to-literal-never-bare)
- [HANA WITH HINT scope — STATEMENT_TIMEOUT is not a hint](#hana-with-hint-scope-statement_timeout-is-not-a-hint)
- [HANA Cloud SQLScript divergences from training data](#hana-cloud-sqlscript-divergences-from-training-data)
- [HANA SPARQL per-graph ACL — creator owns the graph](#hana-sparql-per-graph-acl-creator-owns-the-graph)
- [KG SPARQL DEFINER procedures — the canonical pattern](#kg-sparql-definer-procedures-the-canonical-pattern)
- [node-sql-parser dialect for HANA — use Postgresql, never MySQL](#node-sql-parser-dialect-for-hana-use-postgresql-never-mysql)
- [HDI .hdbindex syntax — three rules](#hdi-hdbindex-syntax-three-rules)
- [HDI deploys can silently wipe data on retry](#hdi-deploys-can-silently-wipe-data-on-retry)
- [.hdbgrants files have no comment keys](#hdbgrants-files-have-no-comment-keys)
- [HDI grants — unbound top-level keys hard-fail; split per channel](#hdi-grants-unbound-top-level-keys-hard-fail-split-per-channel)
- [HDI orphan views from removed annotations](#hdi-orphan-views-from-removed-annotations)
- [.hdiconfig top-level vs gen — plugins must be in both](#hdiconfig-top-level-vs-gen-plugins-must-be-in-both)
- [CUPS credentials.tags, not service-level tags](#cups-credentialstags-not-service-level-tags)
- [Composite-PK collision on FK redirect during merge](#composite-pk-collision-on-fk-redirect-during-merge)

---

## HANA raw SQL requires UPPERCASE identifiers

When writing raw `db.run(sql)` SQL against HANA in CAP, **identifiers
must match HANA's actual table/column casing**. HDI deploys with HANA's
default UPPERCASE folding for unquoted identifiers, so:

- `COM_SAP_DEVELOPERS_IMS_ADVOCATES` (the actual stored name)
- columns: `ID`, `SLUG`, `PHOTO256`, `PHOTOMIMETYPE`, etc. (all UPPERCASE)

Quoted lowercase fails:

```sql
-- BREAKS: invalid table name
SELECT "ID" FROM "com_sap_developers_ims_Advocates" WHERE LOWER("slug") = ?
```

Quoted identifiers preserve the literal case as written — so quoting a
lowercase name searches for a different (non-existent) table.

**Fix patterns** (either works):

1. Unquoted UPPERCASE — natural HANA SQL:
   ```sql
   SELECT ID FROM COM_SAP_DEVELOPERS_IMS_ADVOCATES WHERE LOWER(SLUG) = ?
   ```

2. Quoted UPPERCASE — explicit, also fine:
   ```sql
   SELECT "ID" FROM "COM_SAP_DEVELOPERS_IMS_ADVOCATES" WHERE LOWER("SLUG") = ?
   ```

Use unquoted UPPERCASE by default (matches `srv/lib/content-store.js`
precedent and reads as natural HANA SQL). The aliased output columns
can stay lowercase-quoted so JS-side property access reads naturally:

```sql
SELECT PHOTO256 AS "blob", PHOTOMIMETYPE AS "mimeType" FROM ...
```

**Discovery story (2026-06-17)**: shipped the developer-advocates
feature with quoted lowercase SQL because Vitest unit tests against
SQLite use CDS QL (which CAP rewrites correctly) and the hybrid HANA
test was gated on `cf login` so it never ran in CI. First DEV deploy
failed `/api/advocates/:slug/photo` with HTTP 500. Fix landed as
PR #390 — 6 lines, foreground deploy, smoke went 6/6.

**How to apply**: when adding raw SQL to a CAP project, default to
UPPERCASE-unquoted. If you must quote (e.g. to disambiguate against a
reserved word), use UPPERCASE inside the quotes. Mirror
`feedback_cap_largebinary_default_select_and_stream` which records
the related "use raw SQL on HANA for BLOB reads" rule. The full chain
of advocate-specific CAP gotchas is documented in
`project_developer_advocates_impl`.

---

## HANA boolean CASE WHEN — compare to literal, never bare

In CDS views/aggregates, when a `Boolean` column is used as the WHEN predicate of a `CASE` expression, write it as `case when col = true then ... else ... end` — never `case when col then ...`.

**Why:** HANA's strict-SQL compiler rejects the bare-column form with `Syntax error: "incorrect syntax near "THEN"" [8250009]` at hdbview deploy time. SQLite (used by `cds.test --in-memory`) accepts it, so unit tests pass and the failure only surfaces during HDI deploy in BTP. This bit us on `TutorialFeedbackAggregate` in [db/views.cds](../../../db/views.cds) on 2026-05-21 — db-deployer failed all 3 retries until the view was rewritten as `wasAuthenticated = true`.

**How to apply:** When reviewing or writing CDS views or aggregates that aggregate Boolean fields (`sum(case when ... then 1 else 0 end)` is the common shape), grep the change for `case when <ident> then` where `<ident>` is a Boolean — flag it and require explicit `= true` / `= false`. Same applies to `where` clauses on Boolean columns in handwritten CQL passed to HANA.

Related: `hana-cds-divergence` (placeholder for future cross-backend gotchas).

---

## HANA WITH HINT scope — STATEMENT_TIMEOUT is not a hint

HANA's `WITH HINT (...)` clause only accepts optimizer/execution hints (`RESULT_CACHE_*`, `IGNORE_PLAN_CACHE`, `NO_INLINE`, `USE_HEX_PLAN`, etc.). It does NOT accept `STATEMENT_TIMEOUT` — every query embedding that hint returns 400 with `hint error: invalid hint: STATEMENT_TIMEOUT`.

For statement timeouts on HANA there are only two real mechanisms, and both have downsides for CAP:
- Session variable `SET 'STATEMENT_TIMEOUT' = '<sec>'` — valid HANA, but session-scoped, so with CAP's connection pooling the cap leaks to whichever request next picks up the same pooled connection.
- Workload class with `STATEMENT TIMEOUT` — proper enforcement, but requires DBA setup at the user/role level, not per-query.

For ad-hoc query tools (e.g. AnalyticsService.runSelectQuery), prefer a JS-side `Promise.race` timeout. Pair it with `LIMIT 5001` wrapping and an allowlist validator. The query may continue server-side past the timeout but the UI returns promptly — acceptable for admin tooling.

**Why:** The 2026-05-23 admin-analytics-explorer spec assumed `STATEMENT_TIMEOUT(30)` was a valid HANA hint. It isn't. Every Analytics Explorer SQL tab call returned 400 from deploy until PR #62 (2026-05-26) replaced the hint with `Promise.race`. Reproduced via hana-cli: `SELECT 1 FROM DUMMY WITH HINT (STATEMENT_TIMEOUT(30))` → `hint error: invalid hint`.

**How to apply:** Before specifying any new HANA hint, verify it via `hana-cli` (`hana_query_simple`) against deployed HANA — don't trust hint names that "sound right." For new admin/ad-hoc query features, default to JS Promise.race timeouts; reach for HANA workload classes only when DBA-level enforcement is required. Related: [node-sql-parser dialect for HANA — use Postgresql, never MySQL](#node-sql-parser-dialect-for-hana-use-postgresql-never-mysql) for similar HANA SQL gotchas.

---

## HANA Cloud SQLScript divergences from training data

When writing `.hdbprocedure` files for HANA Cloud — especially `SQL SECURITY DEFINER` ones — these five facts diverge from common LLM training data + generic SQL stdlib references. Discovered iteratively during PR #555 ([KG SPARQL DEFINER procedures — the canonical pattern](#kg-sparql-definer-procedures-the-canonical-pattern)). Cost ~7 deploy iterations on Task 1; documenting here so future procedure work is 1-attempt.

**1. `SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = '...'` does NOT compile in HANA Cloud.**
Use the CONDITION pattern instead:
```sql
DECLARE MY_ERR CONDITION FOR SQL_ERROR_CODE 10001;
-- later:
SIGNAL MY_ERR;
```
Error codes 10000-19999 are the user-defined range. JS callers detect via `err.code === 10001`.

**2. `CALL SYS.SPARQL_EXECUTE(...)` is rejected in DEFINER procedures (cross-schema).**
HDI refuses to compile DEFINER-security procedures that reference objects in foreign schemas. Workaround: ship a `.hdbsynonym` file mapping the local name → `SYS.<proc>`, register `hdbsynonym` plugin in `.hdiconfig`, then `CALL <localname>(...)` from the procedure body. Example: `db/src/SYS_SPARQL_EXECUTE.hdbsynonym` resolves `SYS_SPARQL_EXECUTE` → `SYS.SPARQL_EXECUTE`.

**3. `@cap-js/hana` driver does NOT bind OUT params via `db.run('CALL <proc>(?, ?, ?)', [...args, null, null])`.**
The `null` placeholders for OUT slots don't work — the driver silently drops them. Wrap every CALL in a `DO BEGIN ... END` block and SELECT the OUT-param values back as a result set:
```sql
DO (IN p NVARCHAR(500) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL MY_PROC(:p, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END
```
Then `db.run(DO_BLOCK, [graphIri])` returns `[{ RESPONSE, HEADERS }]`. Pattern visible in `scripts/spike/kg-probe.cjs:146-180` and `srv/lib/kg-sparql-client.js` (after PR #555).

**4. HDI `default_access_role` auto-grants EXECUTE on container procedures.**
The plan originally called for `application_user.schema_privileges.EXECUTE` in `_grants.hdbgrants` to let bound runtime users CALL the procedures. **Not needed.** HDI auto-grants EXECUTE on all container-owned procedures to the role; every binding's runtime user inherits via the role. Verified empirically: `cds bind --exec` user shows zero explicit privileges in `SYS.GRANTED_PRIVILEGES` yet successfully CALLs the procedures.

**5. `SQL SECURITY DEFINER` body needs its own system privileges granted to `object_owner`.**
Because the body runs as the container's `#OO`, system privileges held by `application_user` don't help — `#OO` needs them directly. For SPARQL procedures specifically:
```json
{
  "tutorials-kg-grantor": {
    "application_user": { "system_privileges": [{ "privileges": ["SPARQL QUERY", "SPARQL UPDATE"] }] },
    "object_owner":      { "system_privileges": [{ "privileges": ["SPARQL QUERY", "SPARQL UPDATE"] }] }
  }
}
```
Both blocks needed. Missing the `object_owner` block → DEFINER body fails at runtime with privilege errors even when callers succeed at the JS layer.

**Combined effect:** A working DEFINER procedure pattern requires (1) DECLARE/SIGNAL not SQLSTATE, (2) synonym for cross-schema, (3) DO-block wrappers on the JS side, (4) NO `application_user.schema_privileges.EXECUTE`, (5) YES `object_owner.system_privileges.<X>`. Get any one wrong and the deploy fails or the runtime fails with a misleading error.

Related: [KG SPARQL DEFINER procedures — the canonical pattern](#kg-sparql-definer-procedures-the-canonical-pattern), [HANA SPARQL per-graph ACL — creator owns the graph](#hana-sparql-per-graph-acl-creator-owns-the-graph), [HANA raw SQL requires UPPERCASE identifiers](#hana-raw-sql-requires-uppercase-identifiers).

---

## HANA SPARQL per-graph ACL — creator owns the graph

HANA Cloud's SPARQL engine (`CALL SYS.SPARQL_EXECUTE`) treats each named graph as a privately-owned object. The user who executes the FIRST `INSERT DATA` on a graph becomes its owner. Other users — including ones with the system-level `SPARQL UPDATE` privilege granted via the `.hdbgrants` flow — cannot INSERT/CLEAR/SELECT on that graph and get:

```
User is not allowed to perform this action - (INSERT) on https://...
```

The `.hdbgrants` flow grants `SPARQL UPDATE` to `default_access_role`, which IS auto-granted to every binding's runtime user — but that grants SYSTEM-level write, not per-graph ACL.

Surfaced 2026-06-22 twice:
1. **Issue #533**: prior debug session accidentally created `https://developers.sap.com/kg/tutorials` under a non-runtime user. Deployed srv could never INSERT to it. Fixed by bumping to `…/tutorials-v2` in PR #534.
2. **Same day, same evening**: my `cds bind --exec -- node scripts/diag/trigger-kg-rebuild.cjs` ran graphRebuild as **MY** runtime user (`cds bind` binds to one HDI service-key; deployed srv binds to a DIFFERENT one) — the bootstrap INSERT step succeeded and created `…/tutorials-v2` under my user. Deployed srv then got "User is not allowed (INSERT)" on `…/tutorials-v2`.

**Why this is subtle:**
- Multiple HDI runtime users coexist (each binding has its own service-key)
- `cf service-key tutorials-hana` and the `tutorials-srv → tutorials-hana` binding produce DIFFERENT runtime users
- All have the `default_access_role` and thus system-level SPARQL UPDATE
- But the first to INSERT on a graph IRI owns it; others get ACL-denied

**How to apply:**

1. **Never probe a prod KG IRI from `cds bind --exec`.** The IRI used by the deployed srv must FIRST be written by the deployed srv's own runtime user. Use a separate IRI (e.g. `urn:test:probe:<timestamp>`) for any verification probes.

2. When debugging graph access:
   - The runtime user that owns a graph is shown in the error: `..._<HASH>_RT`
   - `SELECT CURRENT_USER FROM DUMMY` via `cds bind --exec` shows your local probe user
   - These will be DIFFERENT — that's the bug

3. To unblock a wrongly-owned IRI:
   - Bump the IRI in `srv/lib/kg-graph-rebuild.js` + 3 `FROM <…>` in `srv/lib/kg-queries.js`
   - DO NOT immediately probe the new IRI from `cds bind` (you'll lock it under your user again)
   - Deploy, then trigger via the admin UI `triggerGraphRebuild` button OR wait for the cron at Sun 03:47 UTC
   - First INSERT comes from deployed srv's runtime user → it owns the graph → admin UI re-clicks work fine forever after

4. DBADMIN cleanup of orphan graphs is a separate concern — they take ~0 space (no triples after CLEAR), but if too many accumulate, ask DBADMIN to drop them.

**Long-term fix shipped (PR #555, 2026-06-22):** [KG SPARQL DEFINER procedures — the canonical pattern](#kg-sparql-definer-procedures-the-canonical-pattern). All SPARQL now routes through `.hdbprocedure` artifacts declared `SQL SECURITY DEFINER`, so every call lands as the HDI container's stable object-owner identity (`#OO`) regardless of caller. Per-graph ACL becomes a non-issue. The graph IRI bumped one final time (v3) so the procedure became the FIRST writer — no more bumps should ever be needed.

Related: [KG SPARQL DEFINER procedures — the canonical pattern](#kg-sparql-definer-procedures-the-canonical-pattern) (the fix), [HANA Cloud SQLScript divergences from training data](#hana-cloud-sqlscript-divergences-from-training-data) (5 HANA Cloud SQLScript pitfalls discovered while building it), [HDI orphan views from removed annotations](#hdi-orphan-views-from-removed-annotations) (similar "wrong-owner / un-grantable" pattern in views, fixed via `db/undeploy.json`).

---

## KG SPARQL DEFINER procedures — the canonical pattern

**Canonical pattern (as of PR #555, 2026-06-22):** All SPARQL invocations from CAP code MUST go through one of four HDI procedures declared `SQL SECURITY DEFINER`. Never call `SYS.SPARQL_EXECUTE` directly from JS — the typed client `srv/lib/kg-sparql-client.js` is the only entry point.

The 4 procedures (in `db/src/procedures/`):
- `KG_GRAPH_CLEAR(iri)` — wipe a named graph
- `KG_GRAPH_INSERT(iri, triples)` — INSERT DATA wrapper (procedure builds the `INSERT DATA { GRAPH <…> { … } }` envelope; caller passes raw N-Triples)
- `KG_QUERY(query_name, p1, p2, p3, override_iri)` — dispatcher for the 3 registered named queries (NEIGHBORHOOD live; PATH_BETWEEN + CONCEPTS_FOR_USER as Phase 2 stubs)
- `KG_ADMIN_RUNSPARQL(sparql, is_update)` — admin escape hatch; XSUAA `KnowledgeGraph.Admin` scope check stays at the JS layer

JS surface in `srv/lib/kg-sparql-client.js`:
```js
kgGraphClear({ db, graphIri, timeoutMs })
kgGraphInsert({ db, graphIri, triples, timeoutMs })
kgQuery({ db, queryName, params, overrideGraphIri, timeoutMs })
kgAdminRunSparql({ db, sparql, isUpdate, timeoutMs })
```

**Why DEFINER:** The procedure body runs as the HDI container's object-owner (`#OO`) regardless of which binding's runtime user invoked it. `#OO` is stable across all bindings + deploys, so every SPARQL call lands as the same logical identity → per-graph ACL becomes a non-issue. Fixes [HANA SPARQL per-graph ACL — creator owns the graph](#hana-sparql-per-graph-acl-creator-owns-the-graph).

**Cross-schema gotcha:** HDI refuses to compile DEFINER-security procedures that cross schema boundaries (`CALL SYS.SPARQL_EXECUTE` fails). Workaround: `db/src/SYS_SPARQL_EXECUTE.hdbsynonym` resolves the local name `SYS_SPARQL_EXECUTE` → `SYS.SPARQL_EXECUTE`; procedures call the synonym. See [HANA Cloud SQLScript divergences from training data](#hana-cloud-sqlscript-divergences-from-training-data) for related HANA Cloud SQLScript syntax pitfalls.

**Error codes (10001-10009):** procedures SIGNAL user-defined codes via `DECLARE <name> CONDITION FOR SQL_ERROR_CODE <n>`. Range allocated:
- 10001 KG_INVALID_IRI, 10002 KG_NOT_AVAILABLE_ON_QA (stub), 10003 KG_EMPTY_TRIPLES, 10004 KG_TRIPLES_INVALID (`} }` injection guard)
- 10005 KG_UNKNOWN_QUERY, 10006 KG_INVALID_TUTORIAL_IRI, 10007 KG_INVALID_USER_ID
- 10008 KG_EMPTY_SPARQL, 10009 KG_INVALID_IS_UPDATE_FLAG

JS callers detect via `err.code === <number>`.

**Regression guard:** `test/hybrid/kg-procedure-acl.test.js` creates a second ephemeral CF service key, opens two `hdb` connections with different `CURRENT_USER`, and proves both can INSERT/CLEAR the same graph through the procedures. If anyone ever inlines `SYS.SPARQL_EXECUTE` back into a DO block, this test fails immediately.

**Graph IRI:** As of PR #555 the canonical default is `https://developers.sap.com/kg/tutorials-v3`. v2 was ACL-pinned to a non-`#OO` user from past writes; v3 is owned by `#OO` because the procedure was the FIRST writer. **No more bumps should ever be needed** — every future write goes through the procedure, lands as `#OO`, the ACL is permanent.

**Spec + plan:** `docs/superpowers/specs/2026-06-22-kg-sparql-definer-procedures-design.md` and `docs/superpowers/plans/2026-06-22-kg-sparql-definer-procedures.md`. The plan's "Discoveries from Task 1 implementation" section captures the 5 HANA Cloud SQLScript divergences from initial sketches.

Related: [HANA SPARQL per-graph ACL — creator owns the graph](#hana-sparql-per-graph-acl-creator-owns-the-graph), [HANA Cloud SQLScript divergences from training data](#hana-cloud-sqlscript-divergences-from-training-data).

---

## node-sql-parser dialect for HANA — use Postgresql, never MySQL

When using `node-sql-parser` to validate-and-re-emit SQL that will execute against SAP HANA, call `parser.sqlify(ast, { database: 'Postgresql' })` — never `'MySQL'`.

**Why:** MySQL dialect emits backtick-quoted identifiers (`` `taskType` ``). HANA only accepts ANSI double-quote identifiers (`"taskType"`). Postgresql dialect emits double-quotes. The bug is silent for unquoted identifiers — only manifests when the parser quotes a column (reserved word, mixed case, special char). The hybrid happy-path test in the analytics-explorer caught nothing because it used `SELECT * FROM CompletionAnalytics` with no quoted identifiers; final code review caught it via inspection.

**How to apply:** Any time a `node-sql-parser` `sqlify` call is added or copied from another project, check the `database` option matches the runtime DB's identifier-quoting style. The parsing side (the input dialect) is a separate concern — the emit side is what the DB actually receives. For the analytics validator, see `srv/lib/analytics-sql-validator.cjs` in tutorials-poc.

Related: `project-admin-analytics-explorer` — the consumer.

---

## HDI .hdbindex syntax — three rules

For CAP projects deploying secondary indexes via `.hdbindex` design-time files (the only path when @sql.append doesn't fit, since `@sql.append` rejects ';' and can't emit separate CREATE INDEX statements):

1. **No `CREATE` keyword.** Start the file with `INDEX <name> ON <table> (<cols>)`. The HDI `com.sap.hana.di.index` plugin parses this design-time form, NOT raw `CREATE INDEX ... ;` SQL.

2. **Physical (underscored) table name in the `ON` clause.** CAP transforms namespace dots to underscores when emitting the HANA physical table name (`com.sap.developers.ims.UIEvent` → `com_sap_developers_ims_UIEvent`). The `.hdbindex` file must reference that physical name, NOT the dotted design-time resource ID. HDI's `db://` dependency resolver still finds the migration table file because it parses the table file's `COLUMN TABLE <physical_name> (...)` declaration and registers both the file-name and physical-name resources.

3. **Bare identifiers; quote only reserved words.** Index name and table name go bare (no double-quotes). Quote individual columns only when they're HANA reserved words like `"TIMESTAMP"` (which the COLUMN TABLE declaration also quotes). Match what the table file uses for case-sensitivity.

The `.hdiconfig` must also list the plugin: `"hdbindex": { "plugin_name": "com.sap.hana.di.index" }`. Default CAP `.hdiconfig` doesn't include this — added in PR #249.

Sources of truth (canonical examples on GitHub):
- [SAP-samples/hana-shine-xsa CUSTOMER_NAME_IDX.hdbindex](https://github.com/SAP-samples/hana-shine-xsa/blob/main/core-db/src/data/CUSTOMER_NAME_IDX.hdbindex) — `INDEX "CUSTOMER_NAME_IDX" ON "Customers" (NAME)`
- [muzeyr/sap-cap-node bookshop generated index](https://github.com/muzeyr/sap-cap-node/blob/main/db/src/gen/sap.capire.bookshop.Books.texts.locale.hdbindex) — `UNIQUE INVERTED INDEX sap_capire_bookshop_Books_texts_locale ON sap_capire_bookshop_Books_texts (locale, ID)` — note bare identifiers + underscored physical name.

Verified on HANA: `INVERTED VALUE` (HANA's column-store secondary-index type) — perf-equivalent to B-tree for equality + range queries. Lives in [tutorials-poc db/src/IDX_UIEVENT_*.hdbindex](../../../db/src/) after PR #253. Related: `feedback_audit_all_callers_of_buggy_primitive` for why we now know all three syntax rules.

---

## HDI deploys can silently wipe data on retry

HDI deploys are NOT a guarantee of data preservation. On 2026-06-05 a 4-iteration `.hdbindex` saga (#227 / #249 / #253) silently wiped 20+ relational catalog tables on the DEV HDI container — Missions, Groups, CompletionPaths, Events, TutorialTags, MissionTags, Accomplishments, FeaturedTasks, MissionSlugRedirects, etc. — while preserving Tutorials, TutorialMeta, ContentFiles, Steps, Users, TaskRecords. Smoking gun: two `Rolled back` deploys (request IDs 1143 + 1148) at 22:05 + 22:21 UTC on 2026-06-05.

**Root cause not fully isolated** because CF retains `cf logs --recent` for only ~30 minutes after a deploy completes. Older logs aged out before forensic capture. Likely trigger: HDI rolled back a failed `.hdbindex` deploy, and during rollback executed compensating `TABLE_REPLACE` / `DROP TABLE` operations on tables referenced via the same dependency graph.

**How to apply** going forward (codified in PR #258):

1. **Always snapshot before any HDI-touching deploy:**
   ```bash
   mkdir -p .hana-snapshots
   npm run hana:rowcounts -- --snapshot .hana-snapshots/pre-deploy-$(date +%Y%m%dT%H%M%S).json
   ```
2. **Save the deployer log immediately after each deploy** (CF ring-buffer truncates):
   ```bash
   cf logs tutorials-db-deployer --recent > .hana-snapshots/db-deployer-post-$(date +%Y%m%dT%H%M%S).log
   ```
3. **Run the scraper** — exits 2 on `Rolled back` / `TABLE_REPLACE` / `DROP TABLE` / non-empty `Files to undeploy`:
   ```bash
   npm run hana:scrape-deployer-log -- --file .hana-snapshots/db-deployer-post-<ts>.log
   ```
4. **Run the diff tripwire** — exits 2 if any table dropped >5% of its rows:
   ```bash
   npm run hana:rowcounts -- --diff .hana-snapshots/pre-deploy-<ts>.json
   ```

**Recovery cookbook** (if data IS lost):
- **Option A (best): HANA Cloud PITR** — restore the entire HDI schema to a pre-incident snapshot. Requires PITR to be enabled on the service instance — verify with the BTP admin team. Until enabled, every HDI mishap risks data loss again.
- **Option B (fallback): `migrate-from-hana.js` from cached IMS prod creds in `.migration-data/ims-creds.json`**. Catalog scope only: `--entity=tags,events,groups,missions,completionpaths,completionpathitems,prizes,tutorialtags`. Then `npx cds bind --exec -- node scripts/setup-dev-data.cjs` to assign slugs + clean autotest junk. Then manually `DELETE FROM ... WHERE STATUS = 'DELETED'` on MISSIONS+GROUPS to clear ~21K soft-deleted rows from IMS prod.
- **Caveat on Option B:** excluding `tutorials` from the migration scope (recommended to preserve TUTORIALMETA FK references) leaves `CompletionPathItems.TUTORIAL_ID = NULL` on all imported rows because the migration script's `uuidMap.tutorials.get(...)` is empty. Result: `/build/catalog` returns missions but `tutorialMappings: 0` until reconciled separately. Reconciling CPI via slug-based join is a follow-up script (not yet built per Tom's "prevention is more important than full restore" priority on 2026-06-05).
- **Option C (always required after A or B): full Hugo rebuild + redeploy** to refresh the `Site.Data.browse` baked file on `/browse/`.

**Standing rules going forward** (full text in `docs/developers/operations/hdi-deploy-checklist.md`):

1. Never iterate HDI-syntax fixes via repeated deploys. Each retry is a new opportunity for HDI to enter rollback. Validate locally with `cds build --production` and `mbt build` first.
2. Never skip `mbt build` for schema changes. The `cf-push-db-deployer-fast-path` shortcut `cf-push-db-deployer-fast-path` saves 10 minutes but bypasses the full validation chain.
3. Read the warning section of every deploy log. The "WARNING: deleted files not in undeploy.json" output flagged 5 stale artifacts today and was ignored — but it indicates `undeploy.json` is out of date.
4. Run `npm run test:smoke` after deploy. It hits `/build/catalog`, `/build/navigator`, `/api/Tutorials/$count` — basic data presence checks.

**Reproduces in test:** `scripts/__tests__/check-hana-rowcounts.test.ts` includes a "reproduces the 2026-06-05 wipe pattern" test that asserts the tripwire fires when MISSIONS goes from 240 → 0 and GROUPS from 260 → 1 — the actual wipe shape from the incident.

Related: `project-204-deploy-flag-flipped` (the deploy that surfaced this), `feedback-check-chatsettings-after-deploy` (related ChatSettings reset, separate root cause), `cf-push-db-deployer-fast-path` (the shortcut to avoid for schema changes).

Issue: tutorials-ims#257. Prevention PR: tutorials-ims#258.

---

## .hdbgrants files have no comment keys

`.hdbgrants` files are JSON, and `@sap/hdi-deploy` iterates EVERY top-level key as a bound-grantor service name. There is no "ignored key" convention; the leading-underscore pattern (`_comment_purpose`, `_comment_field_verification`, etc. — common in `.hdiconfig`, npm package configs, JSON Schema) is a per-tool fiction that HDI grants does NOT honor. Top-level `_comment_X` keys produce:

```
Error: service _comment_purpose not found; the service definition does not exist.
```

Caught 2026-06-18 (PR #407) on the first deploy after PR #403 landed.

**Why:** JSON has no comment syntax. Tools that read JSON for application config (`.hdiconfig`, package.json) often filter unknown keys. Tools that read JSON as a list of named entities (HDI grants, k8s manifests, some service definitions) treat every key as significant. ALWAYS check what the consumer does before relying on `_*` to be skipped.

**How to apply:**
1. **For `.hdbgrants` files specifically: only valid grantor service names at the top level.** No comments, no metadata.
2. **Document design rationale in a SIBLING `.md` file outside the HDI scan path.** This repo's pattern: `db/src/_grants.hdbgrants` (the file HDI processes) + `db/_grants.hdbgrants.md` (design notes). The `.md` lives ABOVE `db/src/` because `cds build` only copies `db/src/` and HDI only scans `gen/db/src/`.
3. **For other `.json` files where you want comments**, audit your consumer's behavior first:
   - JSON Schema-validated configs: usually tolerate `$comment` (the official metadata key)
   - tsconfig.json: tolerates `//`-style comments (it's actually JSON5/JSONC)
   - HDI artifacts (.hdbgrants, .hdbcds, etc.): NO comments of any kind
   - npm package.json: tolerates `_*` keys (informally; but uses them for engine-specific overrides — check before using)

Related: [HDI grants — unbound top-level keys hard-fail; split per channel](#hdi-grants-unbound-top-level-keys-hard-fail-split-per-channel) (same file, different bug, also caught the same day); [CUPS credentials.tags, not service-level tags](#cups-credentialstags-not-service-level-tags) (the broader saga).

---

## HDI grants — unbound top-level keys hard-fail; split per channel

`@sap/hdi-deploy`'s grants-file processor (`db/src/_grants.hdbgrants` and similar) iterates EVERY top-level key as a service to be bound — and treats it as REQUIRED, not optional. If a key names a service that's not bound to the current deployer, the deploy hard-fails with:

```
Error: service <key-name> not found; the service definition does not exist.
```

PR #403 listed both `tutorials-kg-grantor` (bound to `tutorials-db-deployer`) and `tutorials-kg-grantor-qa` (bound to `tutorials-db-qa-deployer`) as keys in a single shared `db/src/_grants.hdbgrants`, hedging that "if empirical behaviour rejects unbound grantors, split into per-channel artefacts as a follow-up." Empirical behaviour rejected them on first deploy that re-staged db-deployer (caught 2026-06-18, PR #411).

**Why:** The HDI grants README says "For each grantor in the file, the HDI Deployer looks up a bound service with the name…" The verb "looks up" implied to the original author that lookup misses might be tolerated. They are not — the lookup miss raises an exception that aborts the artifact deploy.

**How to apply:**
1. **One grants file = one channel = one top-level key.** If you have multiple deployers (prod + qa), give each a SOURCE dir with its own `src/_grants.hdbgrants`. Use `.cdsrc.json` build-tasks to keep the source dirs separate; `cds build` copies `.hdb*` files verbatim from `<src>/src/` into `gen/<dest>/src/`. Project's existing pattern: `db/` → `gen/db/` (prod) and `db-qa/` → `gen/db-qa/` (qa).
2. **Local verification of grants file split:**
   ```bash
   jq -c keys db/src/_grants.hdbgrants    # ["tutorials-kg-grantor"]
   jq -c keys db-qa/src/_grants.hdbgrants  # ["tutorials-kg-grantor-qa"]
   ```
   Each MUST return exactly one key, matching the bound-grantor for the deployer that ships that file. NEVER run `jq` against `gen/` — that's build output and may be stale; always against source.
3. **Pre-deploy mtar verification:**
   ```bash
   cd .deploy/..deploy_mta_inspect && unzip -p ../mta_archives/*.mtar tutorials-db-deployer/data.zip > prod.zip
   unzip -p prod.zip src/_grants.hdbgrants | jq -c keys
   ```
   Confirms the deployer's archive contains the right key set, BEFORE running cf deploy.

Related: [.hdbgrants files have no comment keys](#hdbgrants-files-have-no-comment-keys) (same architectural pattern: top-level keys are interpreted strictly); `feedback_cap_csv_seeds_clobber_admin_data` (also "the deploy framework uses files in ways that surprise authors").

---

## HDI orphan views from removed annotations

When you remove `@analytics.exposed`, `@cds.persistence.exists`, or change a service projection that previously emitted a generated view, the corresponding `gen/db/src/gen/*.hdbview` file disappears from build artifacts — but the live view stays in HANA, "owned" by HDI.

On the next deploy that touches an underlying column, HDI's "redeploy dependent views" pass tries to recompile the stale view SQL with the new schema and **fails the entire HDI deploy**.

Surfaced on 2026-06-21 (PR #519): `ANALYTICSSERVICE_TUTORIALREPOSITORIES` had been orphaned in DEV HANA since some prior `@analytics.exposed` removal. PR #517 (TutorialRepositories column reshape) was the first deploy after that to alter the underlying table, exposing the latent breakage.

**Why:** `gen/db/src/gen/` is the source of truth for HDI's "what should be deployed". HDI doesn't auto-drop artifacts that disappear from the archive — that's `db/undeploy.json`'s job.

**How to apply:**
- When removing an `@*.exposed` or similar projection-driving annotation in CDS, immediately check `gen/db/src/gen/` (after `cds build --production`) for which generated artifacts disappeared, and add their paths to `db/undeploy.json`.
- Pair-search HANA's `SYS.VIEWS` for views matching the dropped pattern when diagnosing "could not redeploy" errors: `SELECT VIEW_NAME FROM SYS.VIEWS WHERE SCHEMA_NAME = CURRENT_SCHEMA AND VIEW_NAME LIKE '%FOO%'`. If the view is there but the file isn't in `gen/db/src/gen/`, you've found an orphan.

Related: [HDI deploys can silently wipe data on retry](#hdi-deploys-can-silently-wipe-data-on-retry) [.hdbgrants files have no comment keys](#hdbgrants-files-have-no-comment-keys).

**Follow-up worth opening:** post-deploy CI check that diffs `gen/db/src/gen/` against `SYS.VIEWS` in the target HDI container, alerts on orphans. Would catch the same drift proactively.

---

## .hdiconfig top-level vs gen — plugins must be in both

HDI deploys use TWO `.hdiconfig` files: `db/src/.hdiconfig` (hand-authored artifacts root) and `gen/db/src/gen/.hdiconfig` (CDS-build-generated artifacts root). CDS build owns the gen one — it adds plugins for `hdbtable`, `hdbview`, `hdbtabledata`, etc. as it generates. The top-level `db/src/.hdiconfig` is hand-curated and only gets new plugin entries when a human adds a hand-authored artifact under `db/src/` with a new file suffix.

**Failure mode:** Adding `db/src/SYS_SPARQL_EXECUTE.hdbsynonym` (PR #381, KG SPARQL) without also adding `"hdbsynonym": {"plugin_name":"com.sap.hana.di.synonym"}` to `db/src/.hdiconfig` makes HDI deploys fail with:
```
Error: "src/SYS_SPARQL_EXECUTE.hdbsynonym": could not create a compile unit for the file [8211714]
Error: "src/.hdiconfig": Configuration does not define a build plugin for file suffix "hdbsynonym" [8210015]
```

The `gen/.hdiconfig` has the right plugins from CDS build, but HDI looks at `src/.hdiconfig` for files under `src/` directly.

**How to apply:** When adding any new file under `db/src/` with an extension not already in `db/src/.hdiconfig` (`.hdbsynonym`, `.hdbrole`, `.hdbgrants`, `.hdbvirtualfunction`, etc.), update `db/src/.hdiconfig` in the same PR. Run `mbt build && cf deploy --module tutorials-db-deployer` locally before merging.

Common plugin name mappings:
- `.hdbsynonym` → `com.sap.hana.di.synonym`
- `.hdbrole` → `com.sap.hana.di.role`
- `.hdbgrants` → `com.sap.hana.di.grants` (note: only inside .hdbgrants, not top-level)
- `.hdbvirtualfunction` → `com.sap.hana.di.virtualfunction`

PR #546 added `hdbsynonym` to fix this.

Related: [HDI .hdbindex syntax — three rules](#hdi-hdbindex-syntax-three-rules), [HDI grants — unbound top-level keys hard-fail; split per channel](#hdi-grants-unbound-top-level-keys-hard-fail-split-per-channel).

---

## CUPS credentials.tags, not service-level tags

When HDI's grants-file processor binds a user-provided service for grantor work, its error message is misleading:

```
Error: service <name> not found; the service is user-provided, but is missing
the tag 'hana' or the tag 'password' in the credentials properties.
```

"the credentials properties" refers to the **`credentials.tags`** array inside the binding body, NOT the service-level tags shown by `cf service <name>`. Two distinct CF concepts share the word "tags":

1. **Service-level tags** (`cf update-user-provided-service -t "hana"` or `cf curl /v3/service_instances?names=...|jq '.tags'`) — frozen at bind-time per app, often stale if updated after binding.
2. **Credential-body tags** (`-p '{"tags":["hana","password"], ...}'`) — re-read every time the deployer launches.

HDI's grants resolver reads `credentials.tags`. Setting service-level tags via `-t` and re-binding does NOT necessarily update the binding's `credentials.tags`. Caught 2026-06-18 — agent first set service-level `-t hana`, then `-t hana,password`, then finally added `tags: ["hana","password"]` INSIDE the credentials body. Only the third attempt cleared HDI's check.

**Why:** CF's user-provided service binding is captured into VCAP_SERVICES at bind time. Service-level metadata changes (including the `tags` field) require a fresh bind to propagate, but even the rebind doesn't always pull the new top-level tag into the binding's `credentials` block. Putting the tag INSIDE the credentials JSON puts it where HDI looks regardless.

**How to apply:**
1. **For HANA-grantor cups, always put tags inside the credentials body, not just as service-level tags.** Canonical shape:
   ```bash
   cf update-user-provided-service tutorials-kg-grantor \
     -p '{
       "user":"...",
       "password":"...",
       "host":"...",
       "port":"...",
       "schema":"...",
       "driver":"com.sap.db.jdbc.Driver",
       "url":"jdbc:sap://...",
       "tags":["hana","password"]
     }'
   ```
2. **Verify what HDI will actually see** (NOT what `cf service` says) via:
   ```bash
   cf env <deployer-app> | grep -A5 '<service-name>'
   ```
   Look for `"tags":[...]` INSIDE the `credentials` block of the matching service. If `credentials.tags` is missing or empty, HDI will fail no matter what `cf service` shows.
3. **`cf restage <app>` forces a fresh binding pickup.** If you've updated the cups but the bound app still shows old `credentials.tags`, restage the app — this re-evaluates VCAP_SERVICES from the current cups state.

Related: [HDI grants — unbound top-level keys hard-fail; split per channel](#hdi-grants-unbound-top-level-keys-hard-fail-split-per-channel) (same deploy chain, different layer); [.hdbgrants files have no comment keys](#hdbgrants-files-have-no-comment-keys) (also "JSON convention X consumed strictly by tool Y").

---

## Composite-PK collision on FK redirect during merge

When implementing a "merge two rows" repair script, the naive `UPDATE child SET parent_FK = winner WHERE parent_FK = loser` works only for child tables with single-column PK on `ID` (cuid-style). For child tables with **composite PK that includes the FK column** (e.g. `TutorialEmbedding(tutorial_ID, stepNumber)`, `TutorialTags(tutorial_ID, tag_ID)`), the UPDATE collides on PK if both winner and loser have rows with the same other-key value. HANA enforces the PK; the UPDATE throws `unique constraint violated`; the transaction aborts.

Surfaced 2026-06-17 during the [project_fix_duplicate_slugs] live merge of 123 Tutorials dup-groups: TutorialEmbedding had 26 collision groups (188 rows), TutorialTags had 93 of 123 (292 rows).

**Why:** A schema-aware merge must classify each FK target table by PK shape, not assume single-column PK. The composite-PK case needs "merge or drop" semantics: if the winner already has a row with the same other-key tuple, DELETE the loser's row (loser data is stale by definition); otherwise UPDATE the loser's row to point at winner.

**How to apply:**
- Before writing a merge script, walk the schema for every FK column pointing at the parent and check `key` annotations on each child entity. Composite PKs are easy to miss because CDS uses `key` field-by-field rather than a top-level constraint.
- Implementation pattern in [scripts/merge-duplicate-slugs.cjs](D:/projects/tutorials-poc/scripts/merge-duplicate-slugs.cjs): `FK_REDIRECTS` carries `{ tbl, col, kind, otherKeys? }` where `kind` is `'simple'` or `'composite-pk'`. The `redirectFkSafe(tx, tbl, col, otherKeys, loserId, winnerId)` helper SELECTs winner's other-key tuples, partitions loser rows into delete-vs-redirect buckets, deletes the colliders, then UPDATEs the rest.
- Snapshot BEFORE the merge so dropped loser rows are recoverable.
- Wrap the per-row merge in `db.tx` so a partial failure rolls back rather than half-merging.

Related: [project_fix_duplicate_slugs], [feedback_audit_all_callers_of_buggy_primitive] (the publish path's slug upsert had the right contract; the migrator didn't audit-and-mirror it).
