---
title: MCP Quickstart
description: Connect your MCP client to the SAP Developers hosted MCP server.
---

# MCP Quickstart

The SAP Developers site exposes a hosted **Model Context Protocol (MCP)** server so your AI client — Claude Desktop, Claude Code, or any MCP-compatible tool — can search tutorials, read missions, and query the knowledge graph directly. No SDK, no scraping.

Phase 1 is **anonymous and read-only**. There's no sign-in and no API key. The approuter's per-IP throttle still applies, so treat it as a shared resource.

## Available services

Three CDS services are mounted under `/mcp/*` using `@cap-js/mcp@1.1.1` over the **Streamable HTTP** transport (MCP protocol version 2025-06). Each service exposes two auto-generated tools (`describe`, `query`) plus one tool per CDS action.

| Service | Mount | Curated tools |
| --- | --- | --- |
| SearchService | `/mcp/search` | `search_tutorials`, `list_missions`, `get_mission`, `get_tutorial`, `search_events` |
| HomepageService | `/mcp/homepage` | `get_recent_news`, `get_recent_videos`, `get_news_detail` |
| KnowledgeGraphService | `/mcp/graph` | `kg_prerequisites`, `kg_what_to_learn_next` |

One-liners:

- **`search_tutorials`** — full-text search across published tutorials.
- **`list_missions`** — enumerate curated learning missions.
- **`get_mission`** — fetch a mission's ordered tutorial list by slug.
- **`get_tutorial`** — fetch a single tutorial's metadata and rendered steps.
- **`search_events`** — search the public SAP community events catalog (CodeJams, Devtoberfest, TechEd, user groups) by text, type, and region.
- **`get_recent_news`** — recent SAP Developer News episodes shown on the homepage.
- **`get_recent_videos`** — recent SAP Developers YouTube videos shown on the homepage.
- **`get_news_detail`** — full article body for one news item, fetched by its URL (complements `get_recent_news`).
- **`kg_prerequisites`** — concepts you should already know before this tutorial.
- **`kg_what_to_learn_next`** — recommended follow-on tutorials from the knowledge graph.

Full parameter reference: [docs/developers/reference/mcp-server.md](../developers/reference/mcp-server.md).

## Base URLs

- **Production:** `https://developers.sap.com` (cutover end of July 2026)
- **Dev:** ask your admin for the current dev route

Replace `<base>` in the examples below with the appropriate URL.

## Claude Desktop

Edit `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "sap-developers-search": {
      "url": "<base>/mcp/search"
    },
    "sap-developers-homepage": {
      "url": "<base>/mcp/homepage"
    },
    "sap-developers-graph": {
      "url": "<base>/mcp/graph"
    }
  }
}
```

Restart Claude Desktop. The tools appear in the tools picker.

## Claude Code

Add a `.mcp.json` at the root of your project:

```json
{
  "mcpServers": {
    "sap-developers-search": {
      "type": "http",
      "url": "<base>/mcp/search"
    },
    "sap-developers-homepage": {
      "type": "http",
      "url": "<base>/mcp/homepage"
    },
    "sap-developers-graph": {
      "type": "http",
      "url": "<base>/mcp/graph"
    }
  }
}
```

## Joule Work Desktop

> **Naming:** SAP ships no product literally called "Joule Studio Desktop." The desktop client
> that connects to a remote MCP server by pasting a URL is **Joule Work Desktop** (GA expected
> Q3–Q4 2026). If you meant the cloud low-code agent builder **Joule Studio, classic edition**,
> see [Joule Studio (classic edition)](#joule-studio-classic-edition) below — it connects via a
> BTP destination, not a URL.

Joule Work Desktop connects to an MCP server by registering the server's URL. For our
**anonymous, read-only Phase 1** services this is all you need — no sign-in, no destination:

1. In Joule Work Desktop, add / register an MCP server.
2. Paste the service URL, e.g. `<base>/mcp/search` (the server speaks Streamable HTTP, which
   Joule Work Desktop expects).
3. Repeat for `<base>/mcp/homepage` and `<base>/mcp/graph` as needed.

The curated tools then appear to Joule.

> **Authenticated tools (`/mcp-auth/*`) are not reachable from Joule Work Desktop's native flow.**
> Pasting an authenticated URL triggers Joule Work Desktop's OAuth 2.0 handshake, which uses
> **Dynamic Client Registration (RFC 7591)** — it `POST`s to a `/register` endpoint to
> self-register a client. XSUAA does **not** support DCR; OAuth clients must be **pre-registered**
> (the same limitation described for native Claude clients above). So the personalized tools
> (`get_my_tutorials`, `complete_step`, …) can't be used through Joule Work Desktop today —
> stick to the anonymous `/mcp/*` URLs.

## Joule Studio (classic edition)

If instead you are building a **Joule agent** in the cloud low-code **Joule Studio, classic
edition**, MCP servers are added via an **SAP BTP destination**, not a raw URL. Only the
anonymous Phase 1 `/mcp/*` services fit cleanly (the authenticated namespaces need a
pre-registered OAuth client, and interactive/authorization-code OAuth is not supported here).

1. In **SAP BTP Cockpit**, create a **streamable HTTPS** destination whose URL points at
   `<base>` (the destination URL **must not** end in `/mcp`), with the additional property
   **`sap-joule-studio-mcp-server = true`**. Create it with the **same name** in both the Joule
   Studio classic subaccount and the Joule subaccount, and register it in the control tower.
2. In your Joule agent, open the **MCP Servers** tab → **Add MCP Server**.
3. Give it a **Name** and **Description**, set **Path** to the service you want (e.g.
   `/mcp/search`), pick the destination, review the listed **Tools**, and choose **Add Server**.

SSE-type destinations are **not** supported. For servers that do require auth, SAP recommends
**Client Credentials**; **OAuth2 Authorization Code** and **Principal Propagation** are not
supported. Full reference: [Add MCP Servers to Your Joule Agent](https://help.sap.com/docs/joule-studio-classic/joule-studio-classic-edition/add-mcp-servers-to-your-joule-agent).

## Older stdio-only clients

Clients that only speak stdio (older Claude Desktop builds, custom scripts) can bridge through **`mcp-remote`**:

```bash
npm install -g mcp-remote
```

Then in your client config:

```json
{
  "mcpServers": {
    "sap-developers-search": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<base>/mcp/search"]
    }
  }
}
```

Repeat the block for `/mcp/homepage` and `/mcp/graph` as needed.

## Transport notes

The server speaks Streamable HTTP. Clients may send `Accept: application/json` or `Accept: text/event-stream`. JSON-only clients get JSON responses; SSE-capable clients get streaming responses when appropriate. You don't need to configure this — MCP clients negotiate it.

## Troubleshooting

- **`initialize` returns 401.** You hit `/mcp-auth/*` by mistake. That namespace is reserved for Phase 2 authenticated tools; use `/mcp/*` in Phase 1.
- **`tools/list` returns an empty array.** Wrong service path. Each service is mounted separately — `/mcp/search`, `/mcp/homepage`, `/mcp/graph`. There is no aggregate `/mcp` root.
- **First response is slow (5–15s).** Cold start. The CAP backend spins down when idle. Subsequent requests are fast.
- **Nothing returns and no error.** Anonymous IP throttle. Back off and retry.

## Sign in with Claude Desktop (OAuth)

Phase 2 adds authenticated tools under `/mcp-auth/*` — your tutorial progress, events, and personalized recommendations. To use them, sign in with your SAP universal ID via OAuth.

> **If your Claude Desktop build uses native OAuth, it may fail with
> `does not support dynamic client registration`** — the same XSUAA/DCR limitation described
> in the Claude Code section below. XSUAA requires a **pre-registered** client, so clients
> that insist on RFC 7591 self-registration cannot connect directly. If you hit this, bridge
> through **`mcp-remote`** with the pre-registered `client_id` (see the Claude Code section),
> or use a **[PAT](#headless--ci-with-a-personal-access-token)**.

For builds that accept a pre-registered client, bridge through `mcp-remote`:

```json
{
  "mcpServers": {
    "sap-developers-auth": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "<base>/mcp-auth/api",
        "--static-oauth-client-info", "{\"client_id\":\"sb-tutorials-prod!t676072\"}",
        "--host", "localhost"
      ]
    }
  }
}
```

> **The `client_id` is environment-specific — match it to your `<base>`:**
>
> | Environment | `<base>` | `client_id` |
> | --- | --- | --- |
> | **Production** | `https://developers.sap.com` | `sb-tutorials-prod!t676072` |
> | **Dev** | your dev route | `sb-tutorials!t676072` |
>
> Dev and prod live in the same XSUAA tenant, so prod uses the distinct xsappname
> `tutorials-prod` (hence the `sb-tutorials-prod!…` client). Using the dev `client_id`
> against production fails at `/oauth/authorize` with **"The request for authorization was
> invalid"** — the dev client can't be granted the prod-owned `Tutorial.MCP` scope that the
> `.well-known` discovery advertises.

On first connection `mcp-remote` opens a browser tab for consent (PKCE, no client secret required). The endpoints are discovered automatically from `<base>/.well-known/oauth-authorization-server`; you supply only the `client_id`. After approval, the token is cached and refreshed silently.

**Available authenticated tools** (DeveloperService + HomepageService):

| Tool | What it does |
| --- | --- |
| `get_my_tutorials` | Your in-progress and completed tutorials |
| `get_my_missions` | Your mission progress |
| `get_my_events` | Your registered upcoming events |
| `get_my_completed_steps` | Completed step numbers for a specific tutorial |
| `get_tutorial_step` | Full HTML content of a tutorial step |
| `complete_step` | Mark a step done |
| `reset_tutorial_progress` | Reset all progress on a tutorial |
| `get_my_recommended_tutorials` | Persona-ranked tutorial recommendations |
| `get_my_recommended_missions` | Persona-ranked mission recommendations |

> **Mint a PAT:** open [`/me/tokens/`](/me/tokens/) (self-service — any signed-in user with the **Tutorials MCP Users** role collection) and use **Create token**. The token is shown once at mint time — copy it immediately.

## Sign in with Claude Code (OAuth via mcp-remote)

> **Claude Code's *native* `type: http` OAuth does NOT work against this server.** Its
> built-in OAuth client requires **Dynamic Client Registration** (RFC 7591) — it tries to
> `POST` to a `registration_endpoint` to self-register. XSUAA does not support DCR; OAuth
> clients must be **pre-registered**. Pointing Claude Code's native HTTP client at
> `/mcp-auth/api` fails with `SDK auth failed: Incompatible auth server: does not support
> dynamic client registration`. Use **`mcp-remote`** (below), which accepts a pre-registered
> `client_id`, or use a **[PAT](#headless--ci-with-a-personal-access-token)** (simplest for
> Claude Code — no browser flow).

Bridge through `mcp-remote`, which performs the OAuth 2.1 authorization-code + PKCE handshake
against the pre-registered public client and forwards the bearer to `/mcp-auth/api`:

```bash
npm install -g mcp-remote
```

```json
{
  "mcpServers": {
    "sap-developers-auth": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote", "<base>/mcp-auth/api",
        "--static-oauth-client-info", "{\"client_id\":\"sb-tutorials-prod!t676072\"}",
        "--host", "localhost"
      ]
    }
  }
}
```

`sb-tutorials-prod!t676072` is the **XSUAA-generated public client** for the production
`tutorials-prod` application (XSUAA auto-creates exactly one `sb-<xsappname>!<instance-suffix>`
client per instance — there is no separately-named MCP client). **This id is
environment-specific** — dev's client is `sb-tutorials!t676072` (see the table above). To
confirm the current id for your environment, read the bound credentials:
`cf env tutorials-prod-srv` (prod) or `cf env tutorials-srv` (dev) → `VCAP_SERVICES.xsuaa[0].credentials.clientid`.
The flow uses PKCE with no client secret. On first run, `mcp-remote` opens your browser for the
SAP universal-ID consent flow; after approval the token is cached in `~/.mcp-auth/` and refreshed
silently. The server advertises its endpoints at `<base>/.well-known/oauth-authorization-server`,
so `mcp-remote` discovers the authorize/token URLs automatically — you only supply the `client_id`.

> **Flag note:** use `--static-oauth-client-info '{"client_id":"…"}'`, **not**
> `--static-oauth-client-id`. The latter is not a real `mcp-remote` flag — it is silently
> ignored, so `mcp-remote` falls back to Dynamic Client Registration and fails with
> `does not support dynamic client registration`. Only `--static-oauth-client-info` (a JSON
> blob carrying `client_id`) short-circuits registration.

> **Callback-host note (`--host localhost`):** XSUAA matches the OAuth `redirect_uri`
> literally against the client's registered list, which whitelists
> `http://localhost:*/oauth/callback`. Some `mcp-remote` builds bind the callback to the
> loopback **IP** `127.0.0.1` instead (RFC 8252's preferred default), producing
> `http://127.0.0.1:<port>/oauth/callback` — which does **not** match `localhost` and fails
> at `/oauth/authorize` with **"redirect_uri does not match the configuration."** Passing
> `--host localhost` forces the registered hostname to match. If you still hit this, delete
> the cached tokens in `~/.mcp-auth/` and reconnect.

> **Simplest path for Claude Code:** skip OAuth entirely and use a
> [Personal Access Token](#headless--ci-with-a-personal-access-token). The PAT path needs no
> browser handshake and no pre-registered client.

## Headless / CI with a Personal Access Token

For CI pipelines, scripts, and headless agents that cannot complete an interactive OAuth flow, use a Personal Access Token (PAT).

**Mint a PAT:**

1. Sign in to `<base>/me/tokens/` as a user with the `Tutorials MCP Users` role collection.
2. Click **New token**, give it a name, select scopes (`read` for read-only tools; `read write` to allow `complete_step` and `reset_tutorial_progress`), set a TTL.
3. Copy the displayed token — it is shown once only. The server stores only a SHA-256 hash.

**Configure your MCP client:**

```json
{
  "mcpServers": {
    "sap-developers-auth": {
      "url": "<base>/mcp-pat/api",
      "headers": {
        "Authorization": "Bearer pat_..."
      }
    }
  }
}
```

PATs are validated by the `mcp-pat-middleware` in the CAP backend. An expired or revoked PAT returns 401.

## Reading tutorial content as resources (Phase 3)

MCP clients can read tutorials, missions, and concepts as first-class resources:

- `tutorial://<slug>` — a tutorial's metadata, step titles, and rendered HTML.
- `mission://<slug>` — a mission and its ordered tutorials.
- `concept://<id>` — a knowledge-graph concept and the tutorials that teach it.

List them with `resources/list`; read one with `resources/read` and the URI. Example (Claude Desktop): just ask "read tutorial://hcp-create-trial-account and summarize step 2".

## Prompt templates (Phase 3)

The server ships reusable prompt templates, discoverable via `prompts/list`:

| Prompt | Arguments | What it does |
|---|---|---|
| `summarize_mission_for_beginner` | `mission_slug` | Beginner-friendly mission summary |
| `generate_lab_exercise` | `tutorial_slug`, `step?` | A hands-on lab from a tutorial |
| `explain_concept` | `concept_id` | Explains a KG concept and its tutorials |
| `suggest_learning_path` | `from_slug`, `to_slug` | Ordered path between two tutorials |

Invoke with `prompts/get`; the client fills the arguments.

## What's next

Phase 3 is shipping. The `/mcp/*`, `/mcp-auth/*`, and `/mcp-pat/*` namespaces are stable — client configs will not need to change.
