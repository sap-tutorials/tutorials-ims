# MCP server (curated `/mcp/*` surface)

Operator runbook for the anonymous Model Context Protocol surface at `/mcp/*`. The CAP adapter (`@cap-js/mcp@1.1.1`) exposes selected read-only services as MCP tools; visitors' MCP clients connect through the approuter with no XSUAA round-trip.

Adapter: [`@cap-js/mcp@1.1.1`](https://www.npmjs.com/package/@cap-js/mcp) — cds10-compatible; registers itself under `cds.protocols.mcp` so no `protocols` block is needed in project `package.json`.
Approuter route: `/mcp/*` → `srv-api`, `authenticationType: none`, `csrfProtection: false`. The parallel `/mcp-auth/*` prefix is **reserved for Phase 2** — do not repurpose.
Services participating: `SearchService`, `HomepageService`, `KnowledgeGraphService` — each declares `@protocol: ['odata', ..., 'mcp']`. **Never** use the `@mcp` single-protocol shortcut alone: it replaces the default OData mount (same trap as [[cap-graphql-shortcut-replaces-odata]]).

## TL;DR

| You want to | Do this | Turnaround |
|---|---|---|
| Ship a new curated tool | Add a CDS function under one of the three services, redeploy MTA | ~15 min |
| Retire one tool (temporary) | Comment out the CDS function + its handler, redeploy | ~15 min |
| Retire one service's whole MCP surface | Remove `'mcp'` from that service's `@protocol` list, redeploy | ~15 min |
| Full MCP shutdown (ultima ratio) | `npm uninstall @cap-js/mcp`, redeploy | ~15 min |
| Roll back the last change | `cf rollback tutorials-srv` | ~1 min |

## Deploy

The adapter is a normal CAP protocol plugin — it boots with the CAP process and has no separate lifecycle. There is no MCP-specific deploy step. Use the standard MTA workflow:

```bash
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

On boot you'll see the plugin register under `cds.protocols.mcp` and each participating service serve at `/mcp/<serviceRoot>`. Endpoints are `/mcp/search`, `/mcp/homepage`, `/mcp/graph`.

## Disable one curated tool

To pull a single tool off the surface without touching anything else:

1. Comment out the CDS function declaration in the service `.cds` file.
2. Comment out the paired handler registration in the corresponding `srv/*-service.js` (or delete the whole handler — MCP will simply stop advertising the tool once the CDS function is gone).
3. `npm run build:all && cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f`.

Clients that previously used the tool will get an "unknown tool" error on `tools/call` and the tool will not appear in `tools/list`. The other tools on the same service keep working. This is a no-op for well-behaved MCP clients — they refresh `tools/list` on reconnect.

## Disable one whole service's MCP surface

To take one service out of MCP entirely while keeping OData and any other protocols live:

Edit the service definition and drop `'mcp'` from the `@protocol` list. Example, for `KnowledgeGraphService`:

```diff
- @protocol: ['odata', 'hcql', 'mcp']
+ @protocol: ['odata', 'hcql']
service KnowledgeGraphService @(path: '/knowledge-graph') { ... }
```

Redeploy. The service continues to serve OData at its existing path; `/mcp/graph` returns 404. The other two services (`SearchService`, `HomepageService`) are unaffected.

**Do NOT** rewrite this as `@mcp` or `@odata` alone — those are single-protocol shortcuts that replace the default OData mount and will 404 all OData clients too. Always keep `@protocol:` as an explicit list.

## Full MCP shutdown (ultima ratio)

Prefer per-service disable above. If you must pull the whole adapter (adapter bug, CVE, protocol-level abuse), do this:

```bash
npm uninstall @cap-js/mcp
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

The adapter is gone from `cds.protocols` on next boot; every `/mcp/*` request returns 404 at the CAP layer. The approuter still routes the prefix but there's nothing behind it. To restore: `npm install @cap-js/mcp@1.1.1` and redeploy.

## Rollback

There is no MCP-specific state — no manifest, no session store, no outbox rows. Standard app rollback recovers the entire surface:

```bash
cf rollback tutorials-srv
```

If the change touched only `.cds` / `.js` files and not `db/`, this is safe to run at any time. If a schema change rode along, use the normal deploy-rollback procedure (see [mta-deployment.md](mta-deployment.md)).

## Config knobs

All flags live under `cds.mcp.*` in `package.json` (project-level `cds` block). Set at the project root; adapter reads them on boot.

| Flag | Default | Effect |
|---|---|---|
| `per_action_tool` | `true` in this project | Each CDS function surfaces as its own named MCP tool (e.g. `search_semanticSearch`). Flip to `false` to revert to a single generic `call_action` tool that takes an action name + parameters map. Curated tool ergonomics on the client side are much better with `true`. |
| `toon_format` | `true` (adapter default) | Query results serialize as TOON (a compact tabular text format friendlier to LLM token budgets). Set `false` to force JSON when a specific client can't parse TOON. |
| `prefix` | unset | Optional string prefixed to every tool name. Useful when a single MCP client attaches to multiple CAP services and needs to disambiguate tool names. Not currently set in this project — service-per-endpoint gives natural namespacing. |
| `autowire` | `true` | The adapter's own auto-registration of participating services (anything with `mcp` in `@protocol`). Turning this off requires manual wiring per service and is not currently needed. |

To change a flag, edit `package.json` under `cds.mcp`, redeploy. There is no runtime toggle.

## Rate limiting

`/mcp/*` inherits the approuter's anonymous-IP throttle — the same bucket that guards `/tutorials/*` and `/homepage/*` for unauthenticated visitors. If MCP traffic patterns diverge (e.g. one client hammers `tools/list` in tight loops), tune independently in `approuter/xs-app.json` by adding a dedicated route with its own `rateLimit` block for `/mcp/*`. There is no per-tool rate limit inside CAP — the adapter treats every call as a normal CDS function invocation.

## Common failures

### `tools/list` returns empty

Two causes, both diagnosable from a redeploy:

1. The service you expected is missing `'mcp'` from `@protocol`. Check the `.cds` file — the list must literally include `'mcp'`, not `@mcp`.
2. `cds.env.mcp?.autowire === false` (project-level or env override). Restore `cds.mcp.autowire: true` (or delete the key — `true` is the default).

Boot logs show `serving <Service> { at: '/mcp/<root>' }` for each MCP-enabled service. Missing that line = the service is not participating.

### `initialize` returns 401

`/mcp/*` is anonymous. If a client sees 401, the request is not hitting the anonymous route:

- Verify the URL is `/mcp/search`, `/mcp/homepage`, or `/mcp/graph`. Anything else (including `/mcp-auth/*`) is not routed to `srv-api` as anonymous — `/mcp-auth/*` is reserved for Phase 2 and currently returns 404 or 401 depending on approuter config.
- Confirm the client isn't hitting an authenticated CAP service at a different path and appending `/mcp` to it. Only the three curated services participate.

### Connection resets after the first request

The MCP transport in this adapter is **stateless per-request** (`sessionIdGenerator: undefined`, the adapter default). Some MCP clients assume a persistent session and reset when a subsequent request is treated as a fresh handshake. Confirm the client is configured for stateless transport, or wrap it in a helper that reissues `initialize` per call.

### Client sees JSON when it expected SSE (or vice versa)

The adapter picks the response encoding from the client's `Accept` header. If a client omits `Accept: text/event-stream`, it gets a single JSON payload. Set the header explicitly on the client side; no server-side change is needed.

## Metrics

No MCP-specific counters are exported yet. The general `srv-error-rate` alert on 5xx from `tutorials-srv` covers adapter-level failures — if the plugin throws on `tools/list`, that surfaces as a 500 and rolls into the standard alert. Per-tool call counts / latency histograms are a future enhancement (tracked as a nice-to-have; no issue open).

## Phase 2 preparation

The approuter reserves `/mcp-auth/*` for the authenticated MCP surface (Phase 2 — MCP calls that require an XSUAA bearer, e.g. tools that read a user's tutorial progress). **Do not squat on this prefix** for anything else. When Phase 2 lands, the plan is to mount an OAuth-protected sibling of the current adapter under `/mcp-auth/*` while keeping the anonymous `/mcp/*` surface unchanged.

## Phase 2 operations

### Minting a fixture PAT for smoke tests

Smoke tests can verify PAT-authenticated routes by setting the `MCP_SMOKE_PAT` env var before running `npm run test:smoke`. To mint a fixture token:

1. Sign in to `<env-base>/admin-ui/#pats` as a user with `Tutorials MCP Users` role collection.
2. Click **New token**, name it `smoke-fixture`, scopes `read`, TTL 365 days.
3. Copy the displayed `pat_...` value — shown once only.
4. Store it in the env's BTP Credential Store as secret name `mcp-smoke-pat` (or set `MCP_SMOKE_PAT` for local runs).

For emergency rotation without the admin UI (not recommended), call the endpoint directly:

```bash
curl -X POST https://<approuter-url>/pats/mintPAT \
  -H "Authorization: Bearer <xsuaa-jwt>" \
  -H "Content-Type: application/json" \
  -d '{ "name": "smoke-fixture", "scopes": ["read"], "ttlDays": 365 }'
```

> The PAT mint UI is tracked as follow-up issue #1132. Until it ships, minting goes through the API endpoint above or via the `/admin-ui/#pats` admin page.

### Flipping the feature flags

Three Phase 2 feature flags control the MCP surface. All default to `true` (enabled).

```bash
# Disable the authenticated MCP surface entirely
cf set-env tutorials-srv MCP_AUTH_ENABLED false && cf restart tutorials-srv

# Disable PAT minting (existing PATs continue to work)
cf set-env tutorials-srv MCP_PAT_MINT_ENABLED false && cf restart tutorials-srv

# Disable the step-HTML slicer (get_tutorial_step returns 404 for all slugs)
cf set-env tutorials-srv KG_STEP_SLICER_ENABLED false && cf restart tutorials-srv
```

To restore a flag to default, `cf unset-env tutorials-srv <NAME> && cf restart tutorials-srv` (unset = default `true`).

### Granting `Tutorials MCP Users` role collection

The `Tutorials MCP Users` BTP role collection grants `Tutorial.MCP` scope — required for OAuth-authenticated access to `/mcp-auth/*`. Assign it per-user:

```bash
# Single user
btp assign security/role-collection "Tutorials MCP Users" \
  --to-user <email> \
  --subaccount <subaccount-id>
```

For batch assignment (e.g. all IAS users in a team), use the bulk-assign script:

```bash
node scripts/btp-role-collection-sync.js \
  --collection "Tutorials MCP Users" \
  --users emails.txt \
  --subaccount <subaccount-id>
```

Alternatively, assign the role collection via the BTP cockpit: **Security → Role Collections → Tutorials MCP Users → Users → Add**.

### Reading the MCP metrics

Phase 2 emits custom `metrics.counter()` events (embedded labels format). Query them via the standard Prometheus scrape:

**PAT authentication failure rate** (last 5 minutes):

```promql
rate(mcp_pat_auth_total{outcome!="hit"}[5m]) / rate(mcp_pat_auth_total[5m])
```

**Step-slicer cache hit rate**:

```promql
rate(mcp.slice_total{outcome="hit"}[5m]) / rate(mcp.slice_total[5m])
```

**Tool call error rate per service**:

```promql
rate(mcp_tool_total{outcome="error"}[5m]) / rate(mcp_tool_total[5m])
```

Raw counter names (as logged by `metrics.counter()`):

- `mcp.tool[service=DeveloperService,tool=<name>,tokenSource=<pat|anon>,outcome=ok|error]`
- `mcp.tool[service=HomepageService,tool=<name>,tokenSource=<pat|anon>,outcome=ok|error]`
- `mcp.slice[outcome=hit|miss]`
- `mcp_pat_auth[outcome=hit|miss|expired|invalid]`

### Reading the audit trail for authenticated tool calls

The `TutorialProgressReset` audit event (emitted by `reset_tutorial_progress`) now carries a `tokenSource` field. Filter for MCP-originating resets:

```sql
SELECT * FROM "COM_SAP_DEVELOPERS_IMS_AUDITLOG"
WHERE "EVENTSOURCETYPE" = 'TutorialProgressReset'
  AND "TOKENSOURCE" IS NOT NULL
ORDER BY "CREATEDAT" DESC;
```

`tokenSource = 'pat'` = PAT caller; `tokenSource = null` = JWT/OAuth browser caller. `tokenSource` is visible in the existing observability surface — see [docs/developers/architecture/observability.md](../architecture/observability.md).

## References

- Adapter: [`@cap-js/mcp` on npm](https://www.npmjs.com/package/@cap-js/mcp)
- Related memory: [[cap-graphql-shortcut-replaces-odata]] — why `@protocol:` must be a list, not a shortcut
- Related runbook: [mta-deployment.md](mta-deployment.md) — standard deploy path
