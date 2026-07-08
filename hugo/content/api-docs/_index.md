---
title: API
description: developers.sap.com is a developer site — so it's accessible via API too. HTTP services, the sap-devs CLI, an MCP server, and feeds you can script against.
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

**Install**

```bash
npm i -g sap-devs
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

The full command reference lives with the CLI itself: run `sap-devs help` or see the [sap-devs project repository](https://github.com/SAP-samples/sap-devs).

## MCP server

`sap-devs mcp serve` starts a [Model Context Protocol](https://modelcontextprotocol.io) server on stdio that exposes SAP developer knowledge as tools to AI agents (Claude Code, Cursor, Windsurf, and anything else that speaks MCP).

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
