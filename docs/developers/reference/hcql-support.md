# HCQL Protocol Adapter Support

**Status:** Beta (CAP 10, shipped June 2026). This feature is enabled on 9 read-heavy services in this project — see the table below.

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
- **Kill switch:** delete `srv/hcql-enablement.cds`, run `cds build --production`, then `mbt build` + `cf deploy`. ~15 minutes end-to-end.

## Known runtime hazards

- **Malformed CQN crashes the process.** CAP 10.0.3's HCQL adapter runs under `cds.uncaughtErrors = "exit"`. A request body that fails to parse as CQL (missing `SELECT`, invalid entity reference) throws an uncaught exception that exits the Node process. In Cloud Foundry the app restarts within seconds, but a malicious or buggy client can force restart loops. Do NOT expose HCQL to untrusted clients until CAP hardens the adapter. Existing @requires/@readonly gates still apply for cross-scope protection, but the exit-on-error hazard is behind them.
- **Content-Type sensitivity.** The adapter only reads bodies under `application/json` or `text/plain` (Node.js CQL text bodies). Other MIME types silently skip body parsing and trigger the crash above. Clients must set `Content-Type: application/json`.
- **Same URL as OData.** Every enabled service exposes both protocols at the same path. Route dispatch is by request-body shape — `{ "SELECT": ... }` → HCQL; anything else → OData. This is a CAP design choice, not a bug.

## Enabled services

| Service | HCQL path | Auth |
|---|---|---|
| `AdminService`          | `/admin`             | XSUAA + `Admin` |
| `AuthorService`         | `/author`            | XSUAA + `Tutorial.Author` |
| `AnalyticsService`      | `/admin/analytics`   | XSUAA + `Admin` |
| `ExportsService`        | `/admin/exports`     | XSUAA + `Admin` |
| `ConsolidationService`  | `/api/v1`            | XSUAA + `ConsolidationScope` |
| `KnowledgeGraphService` | `/graph`             | Public (entities `@readonly`) |
| `HomepageService`       | `/homepage`          | Public + per-entity `@requires` |
| `SearchService`         | `/search`            | Public |
| `DeveloperService`      | `/api`               | Public + per-entity `@requires` |

**Note on actions-only services:** `ExportsService`, `ConsolidationService`, and `HomepageService` expose only actions and functions — no queryable entities. The `@hcql` annotation is present for completeness and to avoid toggling it separately when the adapter matures. HCQL `SELECT` queries against these services return a `400` (no entity in scope). OData continues to serve them normally.

Not enabled (out of scope for #995): `ChatService`, `DisplayService`, `EventStreamService` (WebSocket surfaces), `CronService` (no entities), `ScannerService` (function-only).

## Curl examples

The base URL depends on the environment:

- Local: `http://localhost:4004`
- Dev: `https://tutorials-approuter-dev.cfapps.eu10-005.hana.ondemand.com`

Replace `$BASE_URL` and `$JWT` in the examples below.

### AdminService (admin scope required)

```bash
curl -X POST "$BASE_URL/admin" \
  -H "Authorization: Bearer $JWT" \
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
curl -X POST "$BASE_URL/author" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{ "SELECT": { "from": { "ref": ["AuthorService.Tutorials"] }, "limit": { "rows": { "val": 3 } } } }'
```

### AnalyticsService (admin scope required)

```bash
curl -X POST "$BASE_URL/admin/analytics" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{ "SELECT": { "from": { "ref": ["AnalyticsService.Tutorials"] }, "limit": { "rows": { "val": 5 } } } }'
```

### ExportsService (admin scope required)

ExportsService exposes only the `exportLegacyData` action — no queryable entities. HCQL `SELECT` does not apply. Use the OData action endpoint to trigger exports:

```bash
curl -X POST "$BASE_URL/admin/exports/exportLegacyData" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -d '{ "format": "csv" }'
```

### ConsolidationService (ConsolidationScope required)

ConsolidationService exposes only the `userMerge` action and `getMergeStatus` function — no queryable entities. HCQL `SELECT` does not apply. Use the OData function endpoint:

```bash
curl -X GET "$BASE_URL/api/v1/getMergeStatus(uuid='<USER_UUID>')" \
  -H "Authorization: Bearer $JWT" \
  -H "Accept: application/json"
```

### KnowledgeGraphService (public)

```bash
curl -X POST "$BASE_URL/graph" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{ "SELECT": { "from": { "ref": ["KnowledgeGraphService.Concepts"] }, "columns": [{"ref":["slug"]},{"ref":["title"]}], "limit": { "rows": { "val": 5 } } } }'
```

### HomepageService (public)

HomepageService exposes only functions (`events`, `videos`, `news`, `shelves`, etc.) — no queryable entities. HCQL `SELECT` does not apply. Use the OData function endpoints:

```bash
curl -X GET "$BASE_URL/homepage/events()" \
  -H "Accept: application/json"
```

### SearchService (public)

```bash
curl -X POST "$BASE_URL/search" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{ "SELECT": { "from": { "ref": ["SearchService.SearchableItems"] }, "columns": [{"ref":["ID"]}], "limit": { "rows": { "val": 3 } } } }'
```

### DeveloperService (public + per-entity requires)

Most `DeveloperService` entities require `authenticated-user`. The example below uses `Tutorials` (requires auth token):

```bash
curl -X POST "$BASE_URL/api" \
  -H "Authorization: Bearer $JWT" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json" \
  -d '{ "SELECT": { "from": { "ref": ["DeveloperService.Tutorials"] }, "columns": [{"ref":["slug"]}], "limit": { "rows": { "val": 3 } } } }'
```

## Post-deploy smoke matrix

Run after every deploy that touches HCQL:

1. **Public 200** — anonymous curl to `$BASE_URL/search` returns `200` + JSON body with a `data` array.
2. **Scoped 401** — anonymous curl to `$BASE_URL/admin` returns `401 Unauthorized`.
3. **Scoped 403 without scope** — authenticated curl (valid JWT but no `Admin` scope) to `$BASE_URL/admin` returns `403 Forbidden`.

Paste the three response codes into the PR that changes HCQL configuration.

## Disabling HCQL (kill switch)

```bash
git rm srv/hcql-enablement.cds
npx cds build --production
git commit -am "revert: disable HCQL adapter (kill switch)"
# From the primary tree, on main:
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

After redeploy, the URLs remain (OData is still served at the same paths), but POSTs with a CQN body shape return the same response OData would give (typically `405` or `400` for `SELECT`-shaped bodies against an OData endpoint).

## Known caveats

- **Content-Type:** `application/cqn+json` is the final protocol MIME type under specification. Today (CAP 10.0.3), use `application/json` — sending `application/cqn+json` crashes the body parser and exits the process (see "Known runtime hazards" above).
- **HCQL response envelope** is `{ "data": [...] }`, not OData's `{ "value": [...] }`. Callers must not assume OData envelope shape.

## Related

- Design spec: [docs/superpowers/specs/2026-07-05-995-hcql-support-design.md](../../superpowers/specs/2026-07-05-995-hcql-support-design.md)
- Issue: [sap-tutorials/tutorials-ims#995](https://github.com/sap-tutorials/tutorials-ims/issues/995)
- Upstream: [CAP 10 June 2026 release notes](https://cap.cloud.sap/docs/releases/2026/jun26#new-hcql-protocol-adapter)
