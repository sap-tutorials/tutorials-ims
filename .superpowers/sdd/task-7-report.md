# Task 7 Report — Compose router (`srv/lib/mcp-compose-router.js`)

## Status: COMPLETE

## Files created
- `srv/lib/mcp-compose-router.js` — default export `makeComposeRouter(srv)`; named exports `buildServer`, `flags`, `promptMapSingleton`.
- `test/unit/mcp-compose-router.test.js` — 3 unit tests (brief-exact).

## Imports-ok result
`node -e "import('./srv/lib/mcp-compose-router.js').then(()=>console.log('imports ok'))..."` → **`imports ok`**

All deep imports verified to resolve at runtime:
- `@cap-js/mcp/lib/tools.js` → registerGenericReadTool, registerCallActionTool, registerPerActionTools, registerDescribeTool, getInstructions ✅
- `@cap-js/mcp/lib/auth.js` → checkAuthorization ✅
- `@cap-js/mcp/lib/utils/service-name.js` → resolvePrefix ✅
- `@cap-js/mcp/lib/utils/cds-to-schema.js` → getDescription ✅
- `@modelcontextprotocol/sdk/server/mcp.js` → McpServer ✅
- `@modelcontextprotocol/sdk/server/streamableHttp.js` → StreamableHTTPServerTransport ✅
- `@modelcontextprotocol/sdk/types.js` → GetPromptRequestSchema, ListPromptsRequestSchema ✅
- `./mcp-resources.js` → registerResources ✅
- `./mcp-prompt-loader.js` → loadPrompts, listPrompts, getPrompt ✅
- `./metrics.js` → counter ✅

## Test command + output
`npx vitest run test/unit/mcp-compose-router.test.js`
```
 Test Files  1 passed (1)
      Tests  3 passed (3)
```
TDD sequence honored: failing test first (module-not-found), then implementation, then pass.

## Capability-gating verification
- `flags()` defaults all-on: `{ phase3:true, resources:true, prompts:true, adminTools:true }` — each env var is on unless `=== 'false'`. ✅
- `buildServer` default (all-on): `caps.tools = {listChanged:false}`, `caps.resources = {subscribe:false,listChanged:false}`, `caps.prompts = {listChanged:false}`; `registerResource` called. ✅
- `MCP_RESOURCES_ENABLED=false`: `caps.resources` undefined, `caps.tools` still `{listChanged:false}`. ✅

## metrics.counter API check
Confirmed `srv/lib/metrics.js` exports `counter(name)` — matches the brief's `metrics.counter?.('mcp_compose_fallback_total')` call. No API mismatch; the `?.` guard remains as a safety net.

## Deviations / import-path corrections
None. All import specifiers used exactly as verified in the brief; no corrections needed. Implementation is byte-for-brief (buildServer + makeComposeRouter + flags + promptMapSingleton).

## Other checks
- `npx cds compile srv --to json` → exit 0.

---

## Fix Note — commit 010abe54 (fix(#1106): declare prompts capability before wiring handlers + empty-tools parity)

### Critical bug fixed: prompts capability declared before setRequestHandler

SDK's `setRequestHandler` calls `assertRequestHandlerCapability` which throws
`"Server does not support prompts"` unless `_capabilities.prompts` is already set via
`registerCapabilities`. The prior code called `setRequestHandler` then `registerCapabilities`.

**Reordering applied in `buildServer`:**
1. Compute full `caps` object (tools + resources if flag + prompts if flag)
2. `server.server.registerCapabilities(caps)` — ONCE, BEFORE any `setRequestHandler`
3. `registerTools()` (empty-tools else branch added — see below)
4. If resources flag: call `registerResourcesFn`
5. If prompts flag: wire `ListPromptsRequestSchema` + `GetPromptRequestSchema` handlers

### Empty-tools else branch added

When `entityCount===0 && actionCount===0`, the default `registerTools` closure now registers
`ListToolsRequestSchema → {tools:[]}` to mirror adapter parity. `ListToolsRequestSchema`
added to the `@modelcontextprotocol/sdk/types.js` import.

### ORDER OK probe output
```
ORDER OK
```

### Test output (4 tests, including new real-SDK regression guard)
```
 Test Files  1 passed (1)
      Tests  4 passed (4)
   Duration  898ms
```

New test: `real SDK McpServer: buildServer does not throw and advertises prompts capability`
— constructs a real `McpServer`, calls `buildServer` with a non-empty promptMap, asserts no throw
and `realServer.server._capabilities` contains `{ prompts: { listChanged: false } }`.
