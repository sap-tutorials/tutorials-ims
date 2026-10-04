---
title: A2A Quickstart
description: Consume the SAP Developers tutorial platform as an A2A (Agent-to-Agent) agent.
---

# A2A Quickstart

The SAP Developers site exposes a first-party **[A2A protocol](https://a2a-protocol.org)** agent
so a *central* SAP Joule instance — or another trusted BTP integration — can consume the
platform's Joule capabilities **agent-to-agent**. Unlike the [MCP server](./mcp-quickstart.md),
which exposes discrete tools a client orchestrates itself, A2A exposes the platform as a single
agent: you hand it a natural-language task and it runs its own agentic loop (search, knowledge
graph, progress) and returns a completed A2A `Task`.

> **Two audiences, one endpoint.** The Agent Card is **public** — anyone can discover the agent
> and its skills without a token. Actually *calling* a skill requires a SAP IAS bearer token via
> **OAuth2 client-credentials** (machine-to-machine) — provisioned by a BTP admin, not self-service.
> There is no PKCE, interactive, or self-service PAT path for A2A. If you only want to inspect the
> agent, start at [Public discovery](#public-discovery) and stop there.

## Available skills

The Agent Card advertises five skills. Select one per request with `metadata.skillId`; omit it
to use `tutorial-chat`.

| Skill (`skillId`) | Auth | What it does |
|---|---|---|
| `tutorial-chat` | IAS token | Conversational Q&A over tutorials, missions, and learning paths. Runs the full agentic loop. **Default**; supports streaming via `message/stream`. |
| `search-tutorials` | IAS token | Semantic/keyword search over the tutorial catalog. |
| `user-progress` | IAS token **+ forwarded user token** | The signed-in developer's tutorial/mission progress. Returns empty results if the end-user's identity is not forwarded. |
| `knowledge-graph` | IAS token | Concept expansion and learning-path reasoning over the tutorial knowledge graph. |
| `tutorial-steps` | IAS token | Returns the most relevant tutorial step content so a calling agent can quote exact instructions. |

## Base URLs

- **Production:** `https://developers.sap.com` (cutover end of July 2026)
- **Dev:** ask your admin for the current dev route

Replace `<base>` in the examples below with the appropriate URL.

## Public discovery

Fetch the Agent Card — no auth, safe from a browser or `curl`:

```bash
curl <base>/.well-known/agent-card.json
```

Key fields:

- `url` — the JSON-RPC endpoint (`<base>/a2a`).
- `skills[]` — the five skills above, with `id`, `description`, `tags`, and `examples`.
- `securitySchemes.ias.flows.clientCredentials.tokenUrl` — the SAP IAS token endpoint you
  authenticate against (see below).
- `capabilities.streaming` — `true` (SSE via `message/stream`).
- `documentationUrl` — points at `<base>/.well-known/a2a-instructions.md`, the canonical
  consumption guide.
- `metadata.available` — `false` when an admin has disabled A2A; when disabled, `POST /a2a`
  returns **HTTP 503**.

## Authentication (internal / partner)

All `/a2a` calls require a SAP IAS access token obtained via **OAuth2 client-credentials**
(`grant_type=client_credentials`) against the IAS token endpoint
`https://atxgsg7zi.accounts.ondemand.com/oauth2/token`. There is **no** PKCE, interactive
browser, or self-service PAT path for A2A — this is a pure machine-to-machine flow.

### 1. Get client credentials

You need a `client_id` / `client_secret` pair from the A2A IAS client bound to the platform.
The credentials live in the `tutorials-identity` IAS service binding (the `identity` service
instance adopted as `existing-service`):

```bash
# dev
cf env tutorials-srv      | jq '.VCAP_SERVICES.identity[0].credentials'
# prod
cf env tutorials-prod-srv | jq '.VCAP_SERVICES.identity[0].credentials'
```

The `credentials` object carries `clientid` and `clientsecret`. Use these as `<client_id>` and
`<client_secret>` in the token exchange below. The token endpoint is always
`https://atxgsg7zi.accounts.ondemand.com/oauth2/token` (the IAS tenant is `atxgsg7zi`).

If you are integrating a separate consumer (e.g. a standalone central Joule instance), the
consumer's IAS application must be registered in the same IAS tenant and granted the `openid`
scope against the platform's IAS client. **This is a BTP-admin step** — contact the platform
team to arrange the application registration. It is not self-service.

### 2. Exchange for a token

```bash
export TOKEN_URL="$(curl -s <base>/.well-known/agent-card.json \
  | jq -r '.securitySchemes.ias.flows.clientCredentials.tokenUrl')"

export TOKEN="$(curl -s "$TOKEN_URL" \
  -u "<client_id>:<client_secret>" \
  -d 'grant_type=client_credentials&scope=openid' | jq -r '.access_token')"
```

For `user-progress`, additionally forward the end-user's identity token (the platform reads the
end-user from it); a pure client-credentials token yields empty progress results.

## Calling the agent

JSON-RPC 2.0 over `POST <base>/a2a`.

### `message/send` (synchronous)

Returns a completed `Task` with results in `result.artifacts`:

```bash
curl -X POST <base>/a2a \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/send",
       "params":{"message":{"role":"user","parts":[{"kind":"text","text":"Find CAP tutorials"}]},
                 "metadata":{"skillId":"search-tutorials"}}}'
```

### `message/stream` (SSE — chat)

Omit `skillId` (or set `tutorial-chat`) and call `message/stream`. The response is an SSE stream of
A2A events: `status-update` (state `working` → `completed`), `artifact-update` (tutorial cards,
citations), and a final `status-update` with `final: true`.

```bash
curl -N -X POST <base>/a2a \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"message/stream",
       "params":{"message":{"role":"user","parts":[{"kind":"text","text":"How do I get started with CAP?"}]}}}'
```

### `tasks/get`, `tasks/cancel`

```bash
curl -X POST <base>/a2a \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"<taskId>"}}'
```

Task snapshots are retained ~15 minutes and are coherent across server instances.

## Choosing a skill

- Free-form questions / multi-step reasoning → omit `skillId` (uses `tutorial-chat`, which
  internally routes to search, knowledge graph, and progress).
- A single known capability → set `metadata.skillId` to one of the four discrete skills.

## Errors

Standard JSON-RPC 2.0 error objects:

| Code | Meaning | HTTP |
|---|---|---|
| `-32001` | Auth required (missing/invalid bearer or scope) | 401 |
| `-32601` | Unknown method | 200 (JSON-RPC error) |
| `-32602` | Bad params / unknown `skillId` | 200 (JSON-RPC error) |
| `-32603` | Internal error | 200 (JSON-RPC error) |

When A2A is disabled by an admin, `POST /a2a` returns **HTTP 503** and the Agent Card sets
`metadata.available: false`.

## Admin configuration

A2A is configured by an admin at **`/admin-ui/#joule`** (the "A2A (Agent-to-Agent) Endpoint" panel
on the Joule settings page), stored on the `ChatSettings` singleton — these are DB-backed settings,
not environment variables, and changes take effect within ~5 seconds without a restart:

- **A2A Enabled** — master switch; off → `POST /a2a` returns 503 and the card signals unavailability.
- **Public Base URL** — the base advertised in the Agent Card `url`; blank auto-detects from
  `VCAP_APPLICATION.application_uris`.
- **OAuth Token URL** — the SAP IAS token endpoint advertised in the card's `ias` security scheme.

## See also

- Canonical served guide: [`/.well-known/a2a-instructions.md`](https://github.com/sap-tutorials/tutorials-ims/blob/main/srv/mcp/a2a-instructions.md)
- [MCP Quickstart](./mcp-quickstart.md) — the complementary tool-oriented surface.
- [API landing page](https://developers.sap.com/api-docs/) — all published surfaces.
