---
title: API Consumption
description: How to consume the SAP Developers APIs (MCP, Admin OData, GraphQL) from your own clients — what works headless today, what needs a browser, and how to authenticate each.
---

# Consuming the developers.sap.com APIs

This page is the map: which API surfaces exist, which you can call from a **script / non-browser client** (headless) versus which require an interactive **browser login** today, and how to authenticate each. It links to the detailed walk-throughs rather than repeating them.

> **Honest status:** not every surface is headless-consumable yet. This page documents **what works today**. Known gaps have tracked issues (see [Gaps & future work](#gaps--future-work)) — if a flow isn't listed as working here, it isn't supported yet; please don't infer it from a related one.

## The surfaces at a glance

| Surface | Base path | Headless (script/curl)? | Auth today | Walk-through |
| --- | --- | --- | --- | --- |
| **MCP — anonymous** | `/mcp/*` | ✅ Yes | None (per-IP throttle) | [MCP quickstart](mcp-quickstart.md) |
| **MCP — PAT** | `/mcp-pat/*` | ✅ Yes | `Authorization: Bearer pat_…` (self-service token) | [MCP quickstart › PAT](mcp-quickstart.md) |
| **MCP — OAuth** | `/mcp-auth/*` | ✅ Yes (one interactive consent, then cached/refreshed) | OAuth 2.0 Authorization Code + PKCE, public client (no secret) | [MCP quickstart › OAuth](mcp-quickstart.md) |
| **A2A** | (JSON-RPC) | ✅ Yes | see A2A guide | [A2A quickstart](a2a-quickstart.md) |
| **Admin OData** | `/admin-pat/*` | ✅ **Yes — PAT (`admin` scope)** | Mint a PAT with `admin` scope at `/me/tokens/` (requires the Tutorials Admin role); send it as `Authorization: Bearer pat_…` | this page (below) |
| **GraphQL** | `/graphql-pat` | ✅ **Yes — PAT (`admin` scope)** | Same admin-scoped PAT; `Authorization: Bearer pat_…` | this page (below) |

**Rule of thumb:** for programmatic/scripted access, use the **MCP** surface for your own data. For **admin data**, use an **admin-scoped PAT** against the `/admin-pat/*` (OData) or `/graphql-pat` (GraphQL) surfaces, as shown below.

## MCP surface — the headless-capable one

The MCP server is the supported way to consume site data from your own tooling (AI clients, scripts). Three tiers, all documented in full in the **[MCP quickstart](mcp-quickstart.md)**:

- **Anonymous `/mcp/*`** — read-only search / missions / knowledge-graph tools. No sign-in, no key.
- **PAT `/mcp-pat/*`** — your personal data (progress, events, recommendations) via a **Personal Access Token**:
  1. Sign in to [`/me/tokens/`](/me/tokens/) (any user with the **Tutorials MCP Users** role collection).
  2. **Create token**, choose scopes — `read` for read-only tools, `read write` to also allow `complete_step` / `reset_tutorial_progress` — set a TTL. The token (`pat_…`) is shown **once**; copy it immediately.
  3. Call `/mcp-pat/*` with `Authorization: Bearer pat_…`. Expired/revoked → 401.
- **OAuth `/mcp-auth/*`** — the same authenticated tools via a real OAuth login (public client, Authorization Code + PKCE S256, no client secret), typically through `mcp-remote`. One interactive browser consent, then the token is cached and refreshed silently.

See the quickstart for client config (Claude Desktop/Code, `mcp-remote`), the environment-specific `client_id`s, and the full tool list.

## Admin OData surface — headless with an admin-scoped PAT

The admin OData service (`AdminService`) backs the admin UI. You can run rich OData queries against it headlessly via the `/admin-pat/*` prefix with an admin-scoped PAT:

```
GET /admin-pat/Tutorials?$filter=owner eq 'me@sap.com'
  &$select=title,slug
  &$expand=completionStats($select=completions),feedbackItems($select=npsScore,comment)
```

### How to authenticate

1. Sign in to the admin UI and open `/me/tokens/`. Mint a PAT with the **admin** scope
   (only offered if you hold the *Tutorials Admin* role). Copy the token — shown once.
2. Call the OData surface headlessly via the `/admin-pat/*` prefix:

```bash
curl -s -H "Authorization: Bearer pat_xxx" \
  "https://<host>/admin-pat/Tutorials?\$filter=owner eq 'me@sap.com'&\$expand=completionStats,feedbackItems"
```

The same per-user Admin authorization applies as in the browser; a revoked grant (or an expired PAT) stops working within ~60 seconds.

## GraphQL surface — headless with an admin-scoped PAT

`/graphql-pat` is available headlessly with the same admin-scoped PAT. Example:

```bash
curl -s -X POST -H "Authorization: Bearer pat_xxx" \
  -H "Content-Type: application/json" \
  -d '{"query":"{ allTutorials(filter:{owner:\"me@sap.com\"}){title slug completions}}"}' \
  "https://<host>/graphql-pat"
```

Use the same admin PAT minted at `/me/tokens/` (see [Admin OData](#admin-odata-surface--headless-with-an-admin-scoped-pat) above).

## Admin PAT security

> **Admin PATs are high-value bearer credentials.** Store them in an environment
> variable or a secret store — **never** commit them to client config files such as
> Claude Code `settings.json`. Use the shortest TTL that works (admin PATs max out at
> 90 days, default 30). Revoke when done via `/me/tokens/` or an admin
> `revokeAdminGrant`. A Credential-Store-backed option for MCP-client PATs is tracked
> separately (see follow-up ticket).

## Gaps & future work

Documented honestly so you know where the edges are:

- **developers.sap.com/api-docs/ portal restructure** — a reorganization of the public API-catalog pages for easier discovery is separate future work, tracked in [#2575](https://github.com/sap-tutorials/tutorials-ims/issues/2575).

## See also

- [MCP quickstart](mcp-quickstart.md) — full MCP walk-through (all three tiers, client config, tools).
- [A2A quickstart](a2a-quickstart.md) — Agent-to-Agent JSON-RPC consumption.
- Operators: the canonical internal endpoint reference is `docs/developers/operations/testing-endpoints.md`.
