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
| **Admin OData** | `/admin/*` | ❌ **No — browser session only** | Interactive XSUAA login + **Tutorials Admin** role | this page (below) |
| **GraphQL** | `/graphql` | ❌ **No — browser session only** | Interactive XSUAA login | this page (below) |

**Rule of thumb:** for programmatic/scripted access, use the **MCP** surface. The **Admin OData** and **GraphQL** surfaces are, today, only reachable from a browser where you're already signed in to the admin UI.

## MCP surface — the headless-capable one

The MCP server is the supported way to consume site data from your own tooling (AI clients, scripts). Three tiers, all documented in full in the **[MCP quickstart](mcp-quickstart.md)**:

- **Anonymous `/mcp/*`** — read-only search / missions / knowledge-graph tools. No sign-in, no key.
- **PAT `/mcp-pat/*`** — your personal data (progress, events, recommendations) via a **Personal Access Token**:
  1. Sign in to [`/me/tokens/`](/me/tokens/) (any user with the **Tutorials MCP Users** role collection).
  2. **Create token**, choose scopes — `read` for read-only tools, `read write` to also allow `complete_step` / `reset_tutorial_progress` — set a TTL. The token (`pat_…`) is shown **once**; copy it immediately.
  3. Call `/mcp-pat/*` with `Authorization: Bearer pat_…`. Expired/revoked → 401.
- **OAuth `/mcp-auth/*`** — the same authenticated tools via a real OAuth login (public client, Authorization Code + PKCE S256, no client secret), typically through `mcp-remote`. One interactive browser consent, then the token is cached and refreshed silently.

See the quickstart for client config (Claude Desktop/Code, `mcp-remote`), the environment-specific `client_id`s, and the full tool list.

## Admin OData surface — browser-session only (today)

The admin OData service (`AdminService`, mounted at `/admin`) backs the admin UI. You can run rich OData queries against it, for example to monitor your own tutorials' completions and feedback:

```
GET /admin/Tutorials?$filter=owner eq 'DJ Adams'
  &$select=title,slug
  &$expand=completionStats($select=completions),feedbackItems($select=npsScore,comment)
```

**This query is valid** — `completionStats` and `feedbackItems` are real associations on the `Tutorials` projection, and `owner` is filterable. The catch is **authentication, not the query.**

### What works today

- **In the browser.** While signed in to the admin UI (`/admin-ui/`, which requires the **Tutorials Admin** role), paste the full `/admin/Tutorials?...` URL into the same browser. Your existing session cookie authorizes it and you get JSON back. This is the supported way to run ad-hoc admin OData queries today.

### What does NOT work today (and why)

- **A PAT does not work on `/admin/*`.** PATs are scoped to the `/mcp-pat/*` namespace and never carry the `Admin` authorization. A PAT against `/admin/*` is redirected to login.
- **Client-credentials (technical user) cannot reach it.** The `Admin` scope is granted only to **named users** who hold the Tutorials Admin role collection — it is not in the XSUAA instance's `authorities`, so a `client_credentials` token cannot carry it.
- **So there is no headless/`curl` path to admin OData today.** If your `curl` with a bearer token redirects to the XSUAA login page, that is expected — not a misconfigured token.

If you need admin data **programmatically**, the available option today is the **MCP PAT tier** for your own per-user data (progress/events/recommendations). Full headless admin-OData access is tracked as future work (see below).

## GraphQL surface — browser-session only (today)

`/graphql` is likewise behind the interactive XSUAA session (CAP enforces the `Tutorial.API` requirement). Same situation as admin OData: usable from an authenticated browser session, no supported headless token flow today.

## Gaps & future work

Documented honestly so you know where the edges are:

- **Headless admin OData access** — enabling `curl`/script access to `/admin/*` (e.g. a per-user PAT tier extended to admin, or a reviewed technical-user scope) is a security-sensitive capability not yet built. Tracked in [#2574](https://github.com/sap-tutorials/tutorials-ims/issues/2574).
- **developers.sap.com/api-docs/ portal restructure** — a reorganization of the public API-catalog pages for easier discovery is separate future work, tracked in [#2575](https://github.com/sap-tutorials/tutorials-ims/issues/2575).

## See also

- [MCP quickstart](mcp-quickstart.md) — full MCP walk-through (all three tiers, client config, tools).
- [A2A quickstart](a2a-quickstart.md) — Agent-to-Agent JSON-RPC consumption.
- Operators: the canonical internal endpoint reference is `docs/developers/operations/testing-endpoints.md`.
