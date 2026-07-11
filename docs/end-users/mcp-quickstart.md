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
| SearchService | `/mcp/search` | `search_tutorials`, `list_missions`, `get_mission`, `get_tutorial` |
| HomepageService | `/mcp/homepage` | `get_recent_news`, `get_recent_videos` |
| KnowledgeGraphService | `/mcp/graph` | `kg_prerequisites`, `kg_what_to_learn_next` |

One-liners:

- **`search_tutorials`** — full-text search across published tutorials.
- **`list_missions`** — enumerate curated learning missions.
- **`get_mission`** — fetch a mission's ordered tutorial list by slug.
- **`get_tutorial`** — fetch a single tutorial's metadata and rendered steps.
- **`get_recent_news`** — recent SAP Developer News episodes shown on the homepage.
- **`get_recent_videos`** — recent SAP Developers YouTube videos shown on the homepage.
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

Edit `claude_desktop_config.json` and point at the authenticated endpoint:

```json
{
  "mcpServers": {
    "sap-developers-auth": {
      "url": "<base>/mcp-auth/api"
    }
  }
}
```

Claude Desktop discovers the OAuth server automatically via the `.well-known/oauth-authorization-server` document served at `<base>`. On first connection it opens a browser tab for consent (PKCE, no client secret required). After approval, the access token is stored by Claude Desktop and refreshed silently.

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

> **Note:** The PAT mint UI follow-up is tracked in issue #1132. Until that ships, tokens can be minted via the API endpoint documented in [mcp-server.md](../developers/reference/mcp-server.md).

## Sign in with Claude Code (OAuth via mcp-remote)

Claude Code's native HTTP client handles OAuth automatically when the server advertises `.well-known/oauth-authorization-server`. Add a `.mcp.json` at your project root:

```json
{
  "mcpServers": {
    "sap-developers-auth": {
      "type": "http",
      "url": "<base>/mcp-auth/api"
    },
    "sap-developers-search": {
      "type": "http",
      "url": "<base>/mcp/search"
    }
  }
}
```

For clients that only speak stdio, bridge through `mcp-remote` which handles the OAuth PKCE handshake and forwards authenticated requests:

```bash
npm install -g mcp-remote
```

```json
{
  "mcpServers": {
    "sap-developers-auth": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "<base>/mcp-auth/api"]
    }
  }
}
```

On first run, `mcp-remote` opens your browser for the OAuth consent flow. After approval the token is cached in `~/.mcp-auth/`.

## Headless / CI with a Personal Access Token

For CI pipelines, scripts, and headless agents that cannot complete an interactive OAuth flow, use a Personal Access Token (PAT).

**Mint a PAT:**

1. Sign in to `<base>/admin-ui/#pats` as a user with the `Tutorials MCP Users` role collection.
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

## What's next

Phase 3 will open deeper knowledge-graph tools (concept expansion, community browsing, on-demand extraction). The `/mcp/*`, `/mcp-auth/*`, and `/mcp-pat/*` namespaces are stable — client configs will not need to change.
