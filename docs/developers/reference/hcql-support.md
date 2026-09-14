# HCQL Protocol Adapter Support

**Status:** Enabled on 5 authenticated services (CAP 10.1.0, re-landed #2247). Requires `@sap/cds >= 10.1.0`.

**Upstream reference:** [CAP 10 June 2026 release notes — New HCQL Protocol Adapter](https://cap.cloud.sap/docs/releases/2026/jun26#new-hcql-protocol-adapter).

---

## What is HCQL?

**HCQL** ("CQL over HTTP") is a CAP protocol adapter that accepts CQN queries as JSON bodies over HTTP. Instead of composing OData URLs like `/admin/Tutorials?$select=slug,title&$top=5`, clients send a CQN `SELECT` object directly:

```json
{ "SELECT": { "from": { "ref": ["AdminService.Tutorials"] }, "columns": [ { "ref": ["slug"] } ], "limit": { "rows": { "val": 5 } } } }
```

CAP Node.js also accepts a **text CQL body** (`Content-Type: text/plain`) as syntactic sugar. Java accepts JSON only; if we ever add a Java service, stick to JSON for cross-runtime portability.

## Beta status caveats

- **Read operations only** are guaranteed stable cross-runtime. Writes may work in Node.js beta but are explicitly unsupported.
- The protocol is **not yet fully specified**. A future CAP release may change wire format.
- **Authenticated services only.** HCQL is intentionally scoped to the 5 services that already require an XSUAA JWT. It is not exposed on any public/anonymous path.
- **Kill switch:** delete `srv/hcql-enablement.cds` AND drop the `hcql` entry from `AdminService`'s `@protocol` list in `srv/admin-service-mcp.cds`, run `cds build --production`, then `mbt build` + `cf deploy`. ~15 minutes end-to-end.

## Malformed CQN behaviour (fixed in 10.1.0)

In CAP 10.0.3 the HCQL adapter had a process-exit DoS: a request body that failed to parse as CQL (missing `SELECT`, invalid entity reference) threw an uncaught exception that exited the Node process. **This is fixed in 10.1.0.** Malformed CQN now returns `HTTP 400` and the server continues running. Authentication is enforced _before_ CQN parsing, so unauthenticated requests are rejected with `401`/`403` before the body is evaluated.

## Architecture: distinct `/hcql/<svc>` paths

HCQL is mounted on separate paths via explicit `@protocol` lists — it does **not** share the OData URL. Each enabled service has two independent mounts:

| Service | OData path | HCQL path |
|---|---|---|
| `AdminService`         | `/admin`           | `POST /hcql/admin`         |
| `AuthorService`        | `/author`          | `POST /hcql/author`        |
| `AnalyticsService`     | `/admin/analytics` | `POST /hcql/analytics`     |
| `ExportsService`       | `/admin/exports`   | `POST /hcql/exports`       |
| `ConsolidationService` | `/api/v1`          | `POST /hcql/consolidation` |

This separation means:
- `GET /admin/Tutorials?$filter=title eq 'x'` → OData 200 (no HCQL interception)
- `POST /admin` with a CQN body → OData 405 (OData path rejects CQN bodies)
- `POST /hcql/admin` with a CQN body → HCQL 200

## Enabled services

| Service | HCQL path | Scope required |
|---|---|---|
| `AdminService`         | `/hcql/admin`         | XSUAA + `Admin` |
| `AuthorService`        | `/hcql/author`        | XSUAA + `Tutorial.Author` |
| `AnalyticsService`     | `/hcql/analytics`     | XSUAA + `Admin` |
| `ExportsService`       | `/hcql/exports`       | XSUAA + `Admin` |
| `ConsolidationService` | `/hcql/consolidation` | XSUAA + `ConsolidationScope` |

**Note on actions-only services:** `ExportsService` and `ConsolidationService` expose only actions and functions — no queryable entities. HCQL `SELECT` queries against these paths return no rows (`{ "data": [] }`). OData continues to serve their actions normally. They are included so the HCQL surface is uniform across the authenticated tier.

Not enabled: the 4 public/anonymous services (`KnowledgeGraphService`, `HomepageService`, `SearchService`, `DeveloperService`) and all WebSocket/function-only surfaces (`ChatService`, `DisplayService`, `EventStreamService`, `CronService`, `ScannerService`).

## Curl examples

The base URL depends on the environment:

- Local: `http://localhost:4004`
- Dev: `https://tutorials-approuter-dev.cfapps.eu10-005.hana.ondemand.com`

Replace `$BASE_URL` and `$JWT` in the examples below. A valid JWT with the required scope is always required.

### CSRF handshake (required through the approuter)

The `/hcql/*` approuter routes enforce CSRF (approuter default, post-#895 — see [Implementation notes](#implementation-notes)). Every POST must carry an `x-csrf-token` obtained via a one-time fetch step:

```bash
# Step 1 — fetch a CSRF token (any GET to a protected route works)
CSRF=$(curl -sI -X GET "$BASE_URL/admin/Tutorials?$top=1" \
  -H "Authorization: Bearer $JWT" \
  -H "x-csrf-token: fetch" | tr -d '\r' | awk -F': ' 'tolower($1)=="x-csrf-token"{print $2}')

# Step 2 — send the HCQL POST with the token (and reuse the same cookie jar if scripting)
```

Send `-H "x-csrf-token: $CSRF"` on each POST below. (Against a bare local `cds watch` on `http://localhost:4004` there is no approuter, so the token step is unnecessary; it is required for every deployed environment.)

### AdminService (Admin scope required)

```bash
curl -X POST "$BASE_URL/hcql/admin" \
  -H "Authorization: Bearer $JWT" \
  -H "x-csrf-token: $CSRF" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{
    "SELECT": {
      "from":    { "ref": ["AdminService.Tutorials"] },
      "columns": [{ "ref": ["slug"] }, { "ref": ["title"] }],
      "limit":   { "rows": { "val": 5 } }
    }
  }'
```

### AuthorService (Tutorial.Author scope required)

```bash
curl -X POST "$BASE_URL/hcql/author" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{ "SELECT": { "from": { "ref": ["AuthorService.Tutorials"] }, "limit": { "rows": { "val": 3 } } } }'
```

### AnalyticsService (Admin scope required)

```bash
curl -X POST "$BASE_URL/hcql/analytics" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{ "SELECT": { "from": { "ref": ["AnalyticsService.Tutorials"] }, "limit": { "rows": { "val": 5 } } } }'
```

### ExportsService (Admin scope required)

ExportsService exposes only the `exportLegacyData` action — no queryable entities. HCQL `SELECT` returns `{ "data": [] }`. Use the OData action endpoint to trigger exports:

```bash
curl -X POST "$BASE_URL/admin/exports/exportLegacyData" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "format": "csv" }'
```

### ConsolidationService (ConsolidationScope required)

ConsolidationService exposes only the `userMerge` action and `getMergeStatus` function — no queryable entities. HCQL `SELECT` returns `{ "data": [] }`. Use the OData function endpoint:

```bash
curl -X GET "$BASE_URL/api/v1/getMergeStatus(uuid='<USER_UUID>')" \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/json"
```

## Post-deploy smoke matrix

Run after every deploy that touches HCQL (the authenticated POSTs — items 3 and 5 — need the `x-csrf-token` handshake from [Curl examples](#curl-examples)):

1. **Auth gate — 401** — anonymous `POST $BASE_URL/hcql/admin` returns `401 Unauthorized`.
2. **Auth gate — 403** — authenticated curl (valid JWT, no `Admin` scope) to `POST $BASE_URL/hcql/admin` returns `403 Forbidden`.
3. **HCQL 200** — authenticated `Admin`-scoped `POST $BASE_URL/hcql/admin` with a valid CQN `SELECT` returns `200` + `{ "data": [...] }`.
4. **OData unaffected** — `GET $BASE_URL/admin/Tutorials?$top=1` returns `200` with OData envelope `{ "value": [...] }`.
5. **Malformed CQN 400** — `POST $BASE_URL/hcql/admin` with `{ "BROKEN": {} }` and a valid `Admin` JWT returns `400` and the server stays alive (verify item 3 still works after).

Paste the five response codes into the PR that changes HCQL configuration.

## Disabling HCQL (kill switch)

Two steps — both are required:

```bash
# 1. Remove the central enablement file (covers 4 services)
git rm srv/hcql-enablement.cds

# 2. Drop the hcql entry from AdminService's @protocol list in
#    srv/admin-service-mcp.cds — change from:
#    @protocol: [{kind:'odata'}, {kind:'mcp', path:'/mcp/admin'}, {kind:'hcql', path:'/hcql/admin'}]
#    to:
#    @protocol: [{kind:'odata'}, {kind:'mcp', path:'/mcp/admin'}]

npx cds build --production
git commit -am "revert: disable HCQL adapter (kill switch)"
# From the primary tree, on main:
cd .deploy && mbt build && cf deploy mta_archives/<env>.mtar -e ../deploy/dev.mtaext -f
```

After redeploy, `POST /hcql/*` returns `404` (the approuter routes remain but the CAP backend no longer serves that path).

## Known caveats

- **`application/cqn+json`** is the final protocol MIME type under specification. Today (CAP 10.1.0), use `application/json` — the spec MIME type may not yet be recognised.
- **HCQL response envelope** is `{ "data": [...] }`, not OData's `{ "value": [...] }`. Callers must not assume OData envelope shape.
- **CAP 10.1.0 required.** HCQL on `@protocol`-isolated paths does not work correctly on 10.0.3: distinct-path mounting is silently ignored and HCQL collides with the OData path, causing OData regressions.

## Implementation notes

HCQL enablement is split across two CDS files:
- `srv/hcql-enablement.cds` — annotates `AuthorService`, `AnalyticsService`, `ExportsService`, `ConsolidationService` with their respective `@protocol` lists.
- `srv/admin-service-mcp.cds` — `AdminService`'s `@protocol` list (which also carries MCP) was extended in-place to include `{kind:'hcql', path:'/hcql/admin'}`.

The approuter (`approuter/xs-app.json` — the only approuter config; the MTA builds the approuter module from `../approuter`, there is no `.deploy/xs-app.json`) has dedicated `/hcql/*` routes with `authenticationType: xsuaa` and JWT-forwarding to `tutorials-srv`. The routes do **not** set `csrfProtection` — they inherit the approuter default (CSRF **on**), enforced by the `check-csrf-clients` static guard (post-#895): only the `/mcp/*` and `/a2a` JSON-RPC routes are allowlisted to disable CSRF. Because HCQL sits behind CSRF protection, clients must perform the `x-csrf-token: fetch` two-step before every POST (see [Curl examples](#curl-examples)). Flipping HCQL to `csrfProtection: false` (the M2M pattern) would require adding its sources to `CSRF_EXEMPT_SOURCES` in `scripts/check-csrf-clients.ts` **and** maintainer sign-off on the issue tracker.

## Related

- Re-land design spec: [docs/superpowers/specs/2026-09-11-2247-hcql-reland-design.md](../../superpowers/specs/2026-09-11-2247-hcql-reland-design.md)
- Original design spec: [docs/superpowers/specs/2026-07-05-995-hcql-support-design.md](../../superpowers/specs/2026-07-05-995-hcql-support-design.md)
- Issue: [sap-tutorials/tutorials-ims#2247](https://github.com/sap-tutorials/tutorials-ims/issues/2247)
- Upstream: [CAP 10 June 2026 release notes](https://cap.cloud.sap/docs/releases/2026/jun26#new-hcql-protocol-adapter)
