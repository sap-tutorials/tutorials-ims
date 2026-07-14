# Final Review Fixes — #1106 MCP Phase 3

## Fix 1 — kg_neighborhood teaches arm (Option A)

**Choice: Option A** — switch `handleNeighborhood` to call `this.send('neighborhood', {slug})`.

**Why not B or C:**
- Investigation of `knowledge-graph-service.js` confirmed `neighborhoodFull` deliberately omits `teaches`
  (comment at line 1179: "Response envelope carries no `teaches` — redesign concentrates the concept
  list in the sidebar only"). `neighborhood` DOES return `teaches` as `array of ConceptRef`.
- Option B (call both) is unnecessary overhead: `isolated` on tutorial-arm items is never populated
  by either action — `KgIsolation` lookups only run in the CDS `after(READ, Concepts)` hook, not
  in the neighborhood function handlers. So `isolated` would be `false`/undefined from BOTH actions.
  `neighborhoodFull` offered no `isolated` advantage.
- Option A is minimal and correct: single call, all four arms present.

**Item shape difference handled:** `neighborhood`'s tutorial arms carry `{slug, title, weight, reason}`
(no `score`); `teaches` carries concept items `{slug, name, description, published}` (no `title`).
The `norm()` function was updated to:
- `title: i.title ?? i.name ?? i.slug` — concept items have `name` not `title`
- `score: i.score ?? i.weight ?? 0` — tutorial arms have `weight` not `score`

**Test mock updated:** `kg_neighborhood` test suite mock now reflects real `neighborhood` shape:
- Tutorial arm items use `{slug, title, weight, reason}` (not `score`)
- `teaches` arm uses concept items `{slug, name, description, published}` (not `{slug, title, score}`)
- Spy asserts `srv.send` called with `'neighborhood'` not `'neighborhoodFull'`

## Fix 2 — MCP_PHASE3_ENABLED gates /mcp-admin 503

`srv/server.js` `/mcp-admin` middleware updated to check BOTH `f.phase3 === false` OR
`f.adminTools === false`. Previously only checked `adminTools`. Docs (`mcp-server.md:258`) state:
`MCP_PHASE3_ENABLED=false` → `/mcp-admin/*` returns 503. Without the phase3 check, phase3=off
left `/mcp-admin/*` passthrough to whatever was mounted — an operator trap.

Change: single `const f = mcpFlags()` + compound `if (f.phase3 === false || f.adminTools === false)`.

## Test results

- `npx vitest run test/unit/mcp-kg-tools.test.js` — all pass
- `npx vitest run test/unit/mcp-contract.test.js` — all pass (kg_neighborhood params `['slug','depth']` unaffected)
- `npx cds compile srv --to json >/dev/null` — exit 0

## Fix A — compose-router err.message leak (#1106 security)

**File:** `srv/lib/mcp-compose-router.js`

The catch block previously returned `message: 'Internal error: ' + err.message` to the client — leaking internal error detail. Fixed by generating a correlation ID on each failure, logging `err.message` only to the server log, and returning a static `Internal error (id: <correlationId>)` to the client. Operators can correlate a client-reported ID back to the server log line.

## Fix B — resources leak unpublished/inactive content (#1106 security)

**Files:** `srv/lib/mcp-resources.js`, `test/unit/mcp-resources.test.js`

`listResources`, `readTutorialResource`, and `readMissionResource` had no published/status filters, leaking soft-deleted and draft content to MCP clients. Fixed to mirror `catalog-data.js` visibility precedents:

- **Tutorials:** `status != 'INACTIVE'` filter on both `listResources` and `readTutorialResource`. If the row is absent after filtering, `readTutorialResource` returns the empty envelope (totalSteps 0) without calling the slicer.
- **Missions:** `published: true, status: 'ACTIVE'` on both `listResources` and `readMissionResource`. If absent, returns empty envelope without traversing CompletionPaths/Items.
- **Concepts:** `active: true` → `status: 'ACTIVE'` unchanged.
- `listResources` extended with a `where` parameter (CDS-QL predicate object). When both `active` and `where` are set, `active` takes precedence (concepts preserve existing behaviour).

New tests added (6): INACTIVE tutorial empty envelope + no slicer call, unpublished mission empty envelope, `listResources` tutorial/mission where-predicate applied, concept active filter regression guard. All 18 mcp-resources tests pass.

## Test results (security fixes)

- `npx vitest run test/unit/mcp-resources.test.js` — 18 passed (18)
- `npx vitest run test/unit/mcp-compose-router.test.js` — 4 passed (4)
- `npx cds compile srv --to json >/dev/null` — exit 0
