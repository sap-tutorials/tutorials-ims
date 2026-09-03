---
title: API
description: developers.sap.com is a developer site — so it's accessible via API too. HTTP services, a hosted MCP server, the sap-devs CLI, and feeds you can script against.
weight: 35
---

developers.sap.com is a developer site. Everything the browser sees is available as an API — query it, script against it, embed it. Below are the surfaces we publish.

> **Rate limits & abuse.** Anonymous endpoints are best-effort and may be throttled without notice. Authenticated endpoints inherit XSUAA quotas from your service key. Don't hammer them.

## HTTP APIs

### Public / anonymous read

No token required. Safe to hit from a browser, a Lambda, or `curl` on a laptop.

{{< api-endpoint-table section="public" >}}

Every OData service also serves `$metadata` (EDMX / CSDL) at `<path>/$metadata` — point a code-gen client at that URL and you're done.

### Signed-in developer surface — `Tutorial.API` scope

For scripting against **your own** progress + preferences. Requires an XSUAA bearer with the `Tutorial.API` scope (granted via the **Tutorials API Consumer** role collection). See [Getting a token](/api-docs/graphql/#getting-a-token) on the GraphQL page for the OAuth2 auth-code+PKCE and client-credentials flows.

{{< api-endpoint-table section="developer" >}}

Full endpoint inventory + auth scopes: [`docs/developers/operations/testing-endpoints.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/testing-endpoints.md).

### Author / admin surfaces

These exist and are documented, but require elevated XSUAA scopes (`Tutorial.Author`, `Admin`, `KnowledgeGraph.Admin`, `SuperAdmin`) that are only assigned to internal staff and QA channel authors. If you have the scope and want to script against them, see [`testing-endpoints.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/testing-endpoints.md) — surfaces include `/admin/*` (`AdminService`), `/admin/analytics/*` (`AnalyticsService`, allowlisted SELECT-only SQL), `/admin/exports/*` (`ExportsService`), `/display/*` (`DisplayService`), `/content/publish` + `/content/rollback` (bearer-token content push), `/graph/publishConcept` + `/graph/unpublishConcept`, and `/author/generateOsVariants`.

## sap-devs CLI

`sap-devs` is a companion CLI that bundles the same SAP developer content and context this site consumes — CAP / BTP / ABAP tips, canonical code samples, error lookups, tutorial search, event listings, and more — so you can get to it without leaving your terminal.

**Install** — the CLI ships as a self-contained binary (it's no longer published to npm). Pick your platform:

```bash
# macOS (Homebrew)
brew tap SAP-samples/sap-devs-cli https://github.com/SAP-samples/sap-devs-cli.git
brew install --cask sap-devs

# Windows (Scoop)
scoop bucket add sap-devs https://github.com/SAP-samples/sap-devs-cli.git
scoop install sap-devs

# Linux / manual — download the archive for your platform from GitHub Releases,
# extract it, and put the binary on your PATH:
# https://github.com/SAP-samples/sap-devs-cli/releases
```

Then run the first-time setup:

```bash
sap-devs init            # first-time setup wizard
sap-devs sync --force    # pull latest content
```

**Common commands**

```bash
sap-devs tip                             # a quick best-practice reminder
sap-devs errors search "No 'default' database configured"
sap-devs samples search "cap handler"    # canonical code samples
sap-devs tutorial search "cap getting started"
sap-devs tutorial show cap-getting-started
sap-devs news                            # recent SAP Developer News episodes
sap-devs learning search "btp architect" # SAP Learning Journeys
sap-devs discovery services search "hana cloud"
sap-devs doctor                          # tool + project health check
sap-devs help                            # full command list
```

The full command reference lives with the CLI itself: run `sap-devs help` or see the [sap-devs project repository](https://github.com/SAP-samples/sap-devs-cli).

## MCP server

There are **two** MCP surfaces here, and they're different things:

1. **The hosted MCP server** — served by this site over HTTP, so an AI client can search tutorials, read missions, query the knowledge graph, and (signed in) read *your* progress. No SDK, no scraping.
2. **The `sap-devs` CLI MCP** — a local stdio server bundled with the `sap-devs` CLI that exposes SAP developer knowledge (tips, samples, error lookups) to your agent.

### Hosted MCP (over HTTP)

Each CDS service is mounted separately under `/mcp/*` over the [Model Context Protocol](https://modelcontextprotocol.io) **Streamable HTTP** transport. There is no aggregate `/mcp` root — point your client at the specific service you want.

| Mount | Auth | Curated tools |
|---|---|---|
| `/mcp/search` | none | `search_tutorials`, `list_missions`, `get_mission`, `get_tutorial` |
| `/mcp/graph` | none | `kg_shared_concepts`, `kg_neighborhood`, `kg_search_concepts`, `kg_community` |
| `/mcp/homepage` | signed-in | `get_my_recommended_tutorials`, `get_my_recommended_missions` |
| `/mcp/api` | signed-in | `get_my_tutorials`, `get_my_missions`, `get_my_events`, `get_my_completed_steps`, `get_tutorial_step`, `complete_step`, `reset_tutorial_progress` |

`describe` and `query` are auto-generated on every mount. The `/mcp/graph` mount additionally exposes MCP **resources** (`tutorial://<slug>`, `mission://<slug>`, `concept://<id>`) and **prompt templates** (`prompts/list`).

**Anonymous read** — just point a Streamable-HTTP client at the mount. Claude Code:

```json
{
  "mcpServers": {
    "sap-developers-search": { "type": "http", "url": "https://developers.sap.com/mcp/search" },
    "sap-developers-graph":  { "type": "http", "url": "https://developers.sap.com/mcp/graph" }
  }
}
```

**Signed-in tools** (your progress, recommendations, marking steps done) live behind two authenticated tiers:

- **`/mcp-auth/*`** — OAuth 2.1 + PKCE. Requires the `Tutorial.MCP` scope (**Tutorials MCP Users** role collection). XSUAA has no dynamic client registration, so bridge through [`mcp-remote`](https://www.npmjs.com/package/mcp-remote) with the pre-registered public client.
- **`/mcp-pat/*`** — a **Personal Access Token** for headless / CI clients that can't do a browser flow. Mint one at [`/me/tokens/`](/me/tokens/) (self-service; requires the **Tutorials MCP Users** role collection), then send `Authorization: Bearer pat_...`. Scopes: `read` (read tools) or `write` (also allows `complete_step` / `reset_tutorial_progress`). The plaintext token is shown once.

Full connection walkthrough (Claude Desktop, Claude Code, `mcp-remote`, PATs, troubleshooting): [MCP Quickstart](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/end-users/mcp-quickstart.md). Tool + parameter reference: [mcp-server.md](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/reference/mcp-server.md).

### Local `sap-devs` CLI MCP (over stdio)

`sap-devs mcp serve` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio that exposes SAP developer knowledge as tools to AI agents (Claude Code, Cursor, Windsurf, and anything else that speaks MCP). This is unrelated to the hosted server above — it ships with the CLI and runs on your machine.

**Available tools** — `list_packs`, `get_context`, `get_tip`, `search_resources`, `get_known_errors`, `get_recent_news`, `get_news_detail`, `search_tutorials`, `search_learning_journeys`, `get_samples`, `check_tools`, `check_project`, `search_events`, `search_videos`, `search_discovery`, plus `cf_*` / `btp_*` inspection tools that surface your local Cloud Foundry and BTP state to the agent.

**Claude Code**

```bash
claude mcp add sap-devs-server -- sap-devs mcp serve
```

**Cursor / Windsurf** — add to your MCP settings JSON:

```json
{
  "mcpServers": {
    "sap-devs-server": { "command": "sap-devs", "args": ["mcp", "serve"] }
  }
}
```

Once connected, ask your agent "what's new in SAP" or paste an SAP error and it will resolve against the live content instead of stale training data.

## Feeds

{{< api-endpoint-table section="feeds" >}}

## Reference documentation

> **These docs are written for the internal team. They're public because the repo is public. They can change without notice and aren't part of any supported contract.**

Curated pointers into the developer docs that a curious integrator might find useful:

- [Homepage architecture](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/architecture/homepage.md) — how the verb spine and homepage shelves are wired.
- [Build pipeline](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/architecture/build.md) — how tutorials flow from the `sap-tutorials` GitHub org into Hugo + HANA.
- [Testing endpoints](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/testing-endpoints.md) — canonical inventory of every UI + API surface with auth scopes.
- [Rebuild-content workflow](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/operations/rebuild-content-workflow.md) — how content gets republished to HANA.
- [HCQL protocol adapter](https://github.com/sap-tutorials/tutorials-ims/blob/main/docs/developers/reference/hcql-support.md) — CAP 10's Hybrid CQN adapter, enabled on the read-heavy services above.

## Feedback & contributions

Bug or gap? Open an issue on the [tutorials-ims repo](https://github.com/sap-tutorials/tutorials-ims/issues). PRs welcome.

{{< scavenger-hunt >}}
