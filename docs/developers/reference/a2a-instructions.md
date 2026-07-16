# SAP Tutorials A2A Agent — Consumption Guide

This service exposes an [A2A protocol](https://a2a-protocol.org) agent so a central
SAP Joule instance can consume the tutorial platform's Joule capabilities.

## Discovery

Fetch the Agent Card (public, no auth):

    GET https://<host>/.well-known/agent-card.json

It declares five skills: `tutorial-chat` (conversational, streaming), `search-tutorials`,
`user-progress`, `knowledge-graph`, and `tutorial-steps`.

## Authentication

All `/a2a` calls require an XSUAA JWT carrying the `Tutorial.MCP` scope (OAuth2
client-credentials against the `tokenUrl` in the card's `securitySchemes.xsuaa`).
`user-progress` additionally needs the end-user's identity forwarded in the token;
without it, it returns empty results.

## Transport

JSON-RPC 2.0 over HTTP `POST https://<host>/a2a`.

### message/send (synchronous)

    {"jsonrpc":"2.0","id":1,"method":"message/send",
     "params":{"message":{"role":"user","parts":[{"kind":"text","text":"Find CAP tutorials"}]},
               "metadata":{"skillId":"search-tutorials"}}}

Returns a completed `Task` with results in `result.artifacts`.

### message/stream (SSE — chat skill)

Omit `skillId` (or set `tutorial-chat`) and call `message/stream`. The response is an
SSE stream of A2A events: `status-update` (state `working`→`completed`), `artifact-update`
(tutorial cards, citations), and a final `status-update` with `final:true`.

### tasks/get, tasks/cancel

    {"jsonrpc":"2.0","id":2,"method":"tasks/get","params":{"id":"<taskId>"}}

Task snapshots are retained ~15 minutes and are coherent across server instances.

## Choosing a skill

- Free-form questions / multi-step reasoning → omit `skillId` (uses `tutorial-chat`, which
  internally routes to search, knowledge graph, and progress tools).
- A single known capability → set `metadata.skillId` to one of the discrete skills.

## Errors

JSON-RPC 2.0 error objects: `-32001` auth required (HTTP 401), `-32601` unknown method,
`-32602` bad params / unknown skill, `-32603` internal. When `A2A_ENABLED=false` the
endpoint returns HTTP 503 and the Agent Card sets `metadata.available:false`.
