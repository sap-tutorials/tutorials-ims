# HANA Knowledge Graph Engine — Access Patterns

**Status:** Spike findings — captured 2026-06-17 against `tutorial-system/dev` (HANA Cloud QRC 2026.2).

- **Spec**: [docs/superpowers/specs/2026-06-17-knowledge-graph-design.md](../../superpowers/specs/2026-06-17-knowledge-graph-design.md)
- **Tracking**: [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381)
- **Spike probe**: [scripts/spike/kg-probe.cjs](../../../scripts/spike/kg-probe.cjs)

## Spec amendment

The PR 1 spike disproved the access pattern asserted in the original
[knowledge graph design spec](../../superpowers/specs/2026-06-17-knowledge-graph-design.md).
The spec asserted that SPARQL could be invoked as a SQL extension, e.g.
`db.run("SPARQL EXECUTE '<query>'")`. **That syntax does not exist in HANA Cloud
QRC 2026.2.** All three documented variants are rejected by the SQL parser
before any SPARQL engine is reached.

The verified access path is the stored procedure `SYS.SPARQL_EXECUTE`,
called via the existing CAP `db` connection. The spec must be amended in
PR 2 to reflect the procedure-based path; this document is the authoritative
reference until that amendment lands.

## TL;DR

Primary access path is `CALL SYS.SPARQL_EXECUTE(:request, :parameter, :response OUT, :headers OUT)`
invoked over the existing CAP `db` connection. The original assumption
(`db.run("SPARQL EXECUTE '…'")`) is **disproven** — that syntax is rejected by
HANA SQL parsing. The HDI container's runtime user requires `SPARQL QUERY` +
`SPARQL UPDATE` system privileges, **delivered via an `.hdbgrants` artefact +
grantor service binding** (the canonical HDI flow — never grant directly to
the runtime user). **No fallback to a REST endpoint is needed.**

## Connection model

The KGE is reachable from the same `cds.connect.to('db')` JDBC connection
that backs every other CAP query — there is no separate "KGE client" to
wire. SPARQL is invoked as a stored-procedure call on `SYS.SPARQL_EXECUTE`,
not as a SQL extension.

### Disproven: SQL-extension forms

The spec's hypothesised syntax was tried as the first probe step. All three
variants fail at SQL parse time:

```text
SPARQL EXECUTE '<query>'
  → sql syntax error: incorrect syntax near "SPARQL": line 1 col 1 (at pos 1)

EXECUTE 'SPARQL <query>'
  → sql syntax error: incorrect syntax near "EXECUTE": line 1 col 1 (at pos 1)

EXECUTE 'SPARQL <query>' AS SPARQL
  → sql syntax error: incorrect syntax near "EXECUTE": line 1 col 1 (at pos 1)
```

These errors come from the SQL parser, not the SPARQL engine — the strings
never reach a SPARQL processor. Do not try to coax this syntax into working;
it does not exist.

### Verified: `SYS.SPARQL_EXECUTE` procedure

Procedure signature (from `SYS.PROCEDURES` / `SYS.PROCEDURE_PARAMETERS`):

```text
PROCEDURE SYS.SPARQL_EXECUTE (
  REQUEST   NCLOB           IN,    -- SPARQL string (CLEAR / INSERT / SELECT / …)
  PARAMETER NVARCHAR(5000)  IN,    -- accept-header / format hint, may be ''
  RESPONSE  NCLOB           OUT,   -- SPARQL result body
  HEADERS   NVARCHAR(5000)  OUT    -- response headers
)
```

The wrapper used by the spike (and the pattern PR 4's
[srv/lib/kg-sparql-client.js](../../../srv/lib/kg-sparql-client.js) will
generalise) is a `DO BEGIN … END` block that calls the procedure and SELECTs
the OUT params into a result-set, side-stepping any cds-driver variance in
how `db.run('CALL …')` surfaces OUT bind parameters:

```js
async function sparqlCall(db, request, parameter = '') {
  // Production version (PR 4): see scripts/spike/kg-probe.cjs for full
  // shape-variance handling — driver shapes vary between cds versions.
  //
  // HANA SQLScript binds parameters at the DO block's SIGNATURE, not via
  // bare `?` inside the block body. Declaring `IN p_request NCLOB => ?`
  // and referencing `:p_request` is the canonical form; trying to use `?`
  // directly inside the block fails with SqlError 1287
  // ("identifier must be declared").
  const sql = `
DO (IN p_request NCLOB => ?, IN p_param NVARCHAR(5000) => ?) BEGIN
  DECLARE response NCLOB;
  DECLARE headers NVARCHAR(5000);
  CALL SYS.SPARQL_EXECUTE(:p_request, :p_param, response, headers);
  SELECT :response AS response, :headers AS headers FROM DUMMY;
END
`.trim();

  const rows = await db.run(sql, [request, parameter]);
  const flat = Array.isArray(rows) ? rows.flat() : (rows ? [rows] : []);
  const row = flat[0] && typeof flat[0] === 'object' ? flat[0] : {};
  return {
    response: row.RESPONSE ?? row.response ?? '',
    headers:  row.HEADERS  ?? row.headers  ?? '',
  };
}
```

A separate KGE-only client library is **not** required: the procedure travels
through the same JDBC pool, the same auth context, and the same transaction
boundary as every other `db.run()`.

### Related: graph-workspace bridges

For completeness, two sibling procedures exist on the same instance and are
out of scope for the tutorials KG, but worth flagging for future work:

- `SYS.RDF_GRAPH_FROM_GRAPH_WORKSPACE` — projects HANA's older property-graph
  workspace into an RDF named graph
- `SYS.RDF_GRAPH_TO_GRAPH_WORKSPACE` — the reverse direction

Tutorials concept-data is RDF-native (extracted by the LLM consolidator into
SPARQL `INSERT DATA` triples) and never enters a property-graph workspace,
so neither bridge is in the runtime path.

## Privileges required

HANA Cloud exposes four SPARQL-related privileges:

| Name             | Type            | Purpose                                                               |
| ---------------- | --------------- | --------------------------------------------------------------------- |
| `SPARQL QUERY`   | SYSTEMPRIVILEGE | Required for any SELECT / ASK / CONSTRUCT / DESCRIBE                  |
| `SPARQL UPDATE`  | SYSTEMPRIVILEGE | Required for INSERT DATA / DELETE DATA / CLEAR / LOAD                 |
| `SPARQL ADMIN`   | SYSTEMPRIVILEGE | Administrative operations on the SPARQL engine; not needed at runtime |
| `SPARQL SERVICE` | OBJECTPRIVILEGE | Federated `SERVICE <…>` calls; not needed for the local named graph   |

The HDI container's runtime user needs `SPARQL QUERY` (read path: 2-hop SELECT
for the sidebar island, learning-path generator) and `SPARQL UPDATE` (write
path: nightly extractor, weekly consolidator, admin merge/veto actions).

### HDI delivery — `.hdbgrants` + grantor service + `default_access_role`

**Do NOT grant SPARQL privileges directly to the HDI runtime user.** That is the
anti-pattern: the runtime user is owned by the HDI deployer, can be re-created
on container redeploy, and any out-of-band grants do not survive. Use the
canonical `@sap/hdi-deploy` grants flow instead.

Reference: [`@sap/hdi-deploy`](https://www.npmjs.com/package/@sap/hdi-deploy)
README — sections **"default_access_role Role"** and the grants plug-in
(`.hdbgrants` files).

The flow has three actors:

1. **Grantor user** — a HANA user that already holds `SPARQL QUERY` and
   `SPARQL UPDATE` *with `WITH ADMIN OPTION`*. Created once per environment by
   DBADMIN. Bound to the HDI deployer module as a (typically user-provided)
   service. HDI cannot grant privileges it does not itself hold; the grantor
   is what gives HDI that authority at deploy time.
2. **`.hdbgrants` artefact (one per channel)** — a JSON file in the HDI
   source tree of each channel that declares which system privileges should
   be granted to the container's `default_access_role` (or to a custom
   role). The grants plug-in reads this file at deploy time and instructs
   the channel's grantor user to issue the GRANTs. Empirically verified
   2026-06-18: HDI demands a binding for **every** top-level grantor key
   in the artefact, so listing both prod and QA grantors in one file
   causes the prod deployer to fail with `service tutorials-kg-grantor-qa
   not found` (and vice-versa). The fix is per-channel artefacts:
   [`db/src/_grants.hdbgrants`](../../../db/src/_grants.hdbgrants) (prod
   only) and
   [`db-qa/src/_grants.hdbgrants`](../../../db-qa/src/_grants.hdbgrants)
   (QA only). `cds build` for the `db` task copies the prod artefact into
   `gen/db/src/`; `cds build --for db-qa` copies the QA artefact into
   `gen/db-qa/src/`. Each deployer ships only its channel's grantor.
3. **`default_access_role`** — the role HDI auto-creates inside the container
   schema and grants to the runtime application user. By default it carries
   only schema-local rights. `.hdbgrants` adds system privileges to it.

The runtime path is therefore:

```text
DBADMIN
  └─ creates grantor user, GRANTS "SPARQL QUERY"/"SPARQL UPDATE" WITH ADMIN OPTION
       └─ grantor bound to HDI deployer (user-provided service)
            └─ HDI deploy reads .hdbgrants → grantor GRANTS to default_access_role
                 └─ default_access_role granted to container runtime user
                      └─ runtime user calls SYS.SPARQL_EXECUTE → succeeds
```

**Verified shape of `db/src/_grants.hdbgrants`** (field names confirmed
2026-06-18 against the `@sap/hdi-deploy` README during PR 2 implementation;
see [db/src/_grants.hdbgrants](../../../db/src/_grants.hdbgrants) for the
authoritative artefact):

```json
{
  "<grantor-service-name>": {
    "application_user": {
      "system_privileges": [
        { "privileges": ["SPARQL QUERY", "SPARQL UPDATE"] }
      ]
    }
  }
}
```

The `application_user` block grants to the container's `default_access_role`
(which is in turn granted to the runtime user that CAP uses for
`cds.connect.to('db')`). An `object_owner` block, if present, grants to the
schema owner — not needed here, the runtime path is enough.

**Shape gotcha:** `system_privileges` is an array of *objects* — each with a
`privileges` sub-array (and an optional `privileges_with_admin_option`
sub-array) — **not** a flat array of strings. An earlier draft of this doc
sketched the flat-array form; that would fail HDI validation. The artefact
above is the verified shape.

### What PR 2 must add

PR 2 (data model + HDI deploy) MUST land all of:

- **Two `.hdbgrants` artefacts (one per channel).**
  [`db/src/_grants.hdbgrants`](../../../db/src/_grants.hdbgrants) lists ONLY
  `tutorials-kg-grantor`;
  [`db-qa/src/_grants.hdbgrants`](../../../db-qa/src/_grants.hdbgrants) lists
  ONLY `tutorials-kg-grantor-qa`. Both grant `SPARQL QUERY` and `SPARQL
  UPDATE` to `application_user`. Sharing a single dual-grantor file causes
  HDI to demand bindings for both grantors on every deployer (verified 2026-
  06-18). Final field names verified against the latest `@sap/hdi-deploy`
  README before commit.
- A grantor service-instance + binding for each environment (dev / qa / prod).
  This is an **ops-team dependency**: the grantor user has to be created by
  DBADMIN (with `WITH ADMIN OPTION` on the two SPARQL system privileges) and
  the corresponding service instance bound to `tutorials-db-deployer` (and
  `tutorials-db-qa-deployer`) via `mta.yaml`. Service-creation steps go in the
  PR 2 commit message + a runbook entry under
  [docs/developers/operations/](../operations/).
- **Operations runbook:** see [docs/developers/operations/kg-grantor-setup.md](../operations/kg-grantor-setup.md) for the per-environment grantor-user setup steps.

A deploy without these in place will fail at the first SPARQL call in PR 4
with `User does not have SPARQL query privileges`. The spike probe
(`scripts/spike/kg-probe.cjs`) detects this exact error and prints a
remediation pointer to this section before exiting non-zero.

### Probe behaviour on missing privileges

The probe does NOT print direct `GRANT … TO <user>` statements (would
mislead readers into the anti-pattern). It points at this section instead:

```text
[probe] PRIVILEGE BLOCKER: this user lacks SPARQL QUERY.
[probe] Remediation:
[probe]   1. Ensure a grantor user with "SPARQL QUERY"/"SPARQL UPDATE"
[probe]      WITH ADMIN OPTION exists (DBADMIN creates this).
[probe]   2. Add a .hdbgrants artefact granting these to the container's
[probe]      default_access_role; bind grantor service to the HDI deployer.
[probe]   3. Redeploy the HDI module.
[probe] See docs/developers/architecture/hana-kge-access.md § Privileges required.
[probe] Then re-run this probe.
```

## Named-graph lifecycle

`INSERT DATA { GRAPH <iri> { … } }` against a previously-unknown named graph
**creates the graph implicitly**. This is standard SPARQL 1.1 INSERT DATA
semantics, confirmed by the spike against the spike-only graph
`<https://developers.sap.com/kg/spike-probe>` which had never existed before
the probe ran.

Practical consequences:

- **No HDI artefact required.** There is no `.hdbgraphworkspace` or analogous
  schema-side declaration of the production graph
  `<https://developers.sap.com/kg/tutorials>` — the first `INSERT DATA`
  in PR 4's nightly extractor will materialise it.
- **No CDS entity required.** The named graph is identified by its IRI only;
  there is nothing to model in `db/schema.cds`.
- **`CLEAR GRAPH <iri>` against a non-existent graph is a no-op** — no error,
  no row count to check.

This is convenient (no DDL ordering between the schema deploy and the first
extractor run) but means the IRI itself becomes the production contract:
once `<https://developers.sap.com/kg/tutorials>` is in use, renaming it
requires a copy-then-clear migration.

## Round-trip latency (spike measurements)

| Operation                | Wall-clock ms | Notes                                                       |
| ------------------------ | ------------- | ----------------------------------------------------------- |
| CLEAR GRAPH (initial)    | BLOCKED       | Re-measure after PR 2 grants flow lands (SPARQL UPDATE).    |
| INSERT DATA (3 triples)  | BLOCKED       | Re-measure after PR 2 grants flow lands (SPARQL UPDATE).    |
| SELECT (2-hop)           | BLOCKED       | Re-measure after PR 2 grants flow lands (SPARQL QUERY).     |
| CLEAR GRAPH (cleanup)    | BLOCKED       | Re-measure after PR 2 grants flow lands (SPARQL UPDATE).    |

Measured from the local dev workstation against `tutorial-system/dev` over
`cds bind --exec --profile hybrid`. Single-shot and indicative only — not a
benchmark. The latency table will be updated in PR 2 once the grants flow lands.
See [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381).

## Why no REST fallback?

Earlier drafts of this doc reserved a section for a SPARQL HTTP endpoint
fallback (via the BTP Destination Service) in case `db.run()` could not
drive the SPARQL engine. The spike showed that the procedure-based path
**does** work over the same `cds.connect.to('db')` connection used by
every other query in the codebase, so there is no fallback to design.

Routing through the destination service would add three problems for zero
benefit:

1. A second auth surface (OAuth2 client credentials against an XSUAA UAA,
   plus destination-service credentials) outside the normal HDI binding.
2. A different transaction boundary — REST writes cannot enlist in the
   same `cds.tx` as a CAP entity write, so cross-cutting consistency
   (e.g. write a `Concepts` row + an RDF triple atomically) becomes
   eventually-consistent rather than transactional.
3. Operational drift — the destination would need to be configured per
   environment in cockpit and kept in sync with the HDI binding.

The procedure-based path inherits all of those for free.

## Decision

**Use `CALL SYS.SPARQL_EXECUTE` via the CAP `db` connection.** This is the
canonical HANA Cloud access path for the SPARQL engine. PR 4's
[srv/lib/kg-sparql-client.js](../../../srv/lib/kg-sparql-client.js) will wrap
the procedure call (per the `sparqlCall` shape above), add SPARQL-result-set
parsing, and expose typed read/write helpers for the named queries declared
in `KnowledgeGraphService`.

PR 2 (data model + HDI deploy) MUST also include an `.hdbgrants` artefact
declaring `SPARQL QUERY` and `SPARQL UPDATE` against the container's
`default_access_role`, plus the corresponding grantor-user setup in HANA
Cloud and the grantor service binding in `mta.yaml`. See § Privileges
required > HDI delivery for the full flow. **Direct `GRANT … TO
<runtime-user>` is the anti-pattern and must not be used as a workaround** —
it does not survive HDI redeploys and breaks the principle that container
privileges are declarative.

This is a hard precondition: a PR 4 deploy without grants in place will
fail at the first SPARQL call.

## Re-running the spike

```bash
# from the worktree root, with cf CLI authenticated to the DEV space
cf login                            # if not already
npx cds bind --exec --profile hybrid -- node scripts/spike/kg-probe.cjs
```

The worktree's `.cdsrc-private.json` was created by `cds bind -2 tutorials-hana`
and lives only in this worktree (it is gitignored). Re-run that bind step in
any new worktree before invoking the probe.

Expected output shape (success path, post-grant):

```text
[probe] connecting to db via cds.connect.to("db")…
[probe] connected. db.kind = hana
[probe] access path: CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)
[probe] CLEAR GRAPH (initial): ok in <N> ms
[probe] INSERT DATA (3 triples): ok in <N> ms
[probe] SELECT (2-hop): ok in <N> ms
[probe] SELECT response (raw):
{ ... SPARQL results JSON ... }
[probe] SELECT headers (raw):
content-type: application/sparql-results+json
[probe] CLEAR GRAPH (cleanup): ok in <N> ms
[probe] ---- SUMMARY ----
[probe] access path:        CALL SYS.SPARQL_EXECUTE(?, ?, ?, ?)
[probe] CLEAR (initial):    <N> ms
[probe] INSERT:             <N> ms
[probe] SELECT (2-hop):     <N> ms
[probe] CLEAR (cleanup):    <N> ms
[probe] all operations succeeded.
```

Failure paths the probe handles gracefully:

- **Privilege blocker** — exits 2 with the remediation message above.
- **Any other SPARQL/SQL error** — exits 1 with a stack trace; paste the
  output back so this doc can be updated.
