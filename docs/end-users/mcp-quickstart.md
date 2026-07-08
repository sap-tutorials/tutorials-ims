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

## What's next

Phase 2 will add authenticated tools under `/mcp-auth/*` — writing progress, submitting event codes, personalized recommendations tied to your SAP universal ID. Phase 3 opens deeper knowledge-graph tools (concept expansion, community browsing, on-demand extraction). Both phases are on the roadmap after PROD cutover; the `/mcp-auth/*` namespace is reserved now so client configs won't need to change later.
