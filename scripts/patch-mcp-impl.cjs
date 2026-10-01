// scripts/patch-mcp-impl.cjs
//
// Build-only fix for the srv-mcp production impl-binding bug (#2550 follow-up).
//
// WHY: CAP resolves a service's implementation file via factory.js `_sibling`,
// which parses the service's `@source` (here `srv-mcp/developer-service.cds`)
// and probes for a sibling `.js` in the SAME directory — i.e. `srv-mcp/
// developer-service.js`. But `cds build` ALWAYS nests handlers under
// `gen/<module>/srv/` (cds.env.folders.srv === 'srv/'), so the built impl lives
// at `gen/srv-mcp/srv/developer-service.js` while `_sibling` looks under
// `gen/srv-mcp/srv-mcp/…` → MISS → CAP falls back to a generic
// ApplicationService with NONE of McpDeveloperService's on-handlers attached.
// Result: every MCP tools/call returns `Service "DeveloperService" has no
// handler for "<tool>"` on the deployed box (local/hybrid work because cds.root
// is the repo root and the sibling resolves there). The main `srv` module dodges
// this only because its folder is literally named `srv`.
//
// FIX: after `cds build --production`, inject `@impl: 'srv/developer-service.js'`
// into the baked CSN. A bare (non-`./`) path is joined onto cds.root
// (factory.js), resolving to `gen/srv-mcp/srv/developer-service.js` — the real
// file. This is BUILD-ONLY (never touches source/hybrid, where auto-discovery
// already works), mirroring the existing gen package.json patch step.
//
// A `./`-prefixed value would NOT work: factory.js joins it onto the @source
// dir, reproducing the wrong `srv-mcp/` path.
//
// Structural follow-up (rename the module source folder to the `srv/`
// convention so this can't recur for future non-`srv` modules): issue #2569.

const fs = require('fs');
const path = require('path');

const CSN = path.resolve('gen/srv-mcp/srv/csn.json');
const SERVICE = 'DeveloperService';
const IMPL = 'srv/developer-service.js';

const csn = JSON.parse(fs.readFileSync(CSN, 'utf8'));
const def = csn.definitions?.[SERVICE];
if (!def) {
  console.error(`[patch-mcp-impl] ${SERVICE} not found in ${CSN} — aborting`);
  process.exit(1);
}
def['@impl'] = IMPL;
fs.writeFileSync(CSN, JSON.stringify(csn));
console.log(`[patch-mcp-impl] set ${SERVICE} @impl = '${IMPL}' in ${path.relative(process.cwd(), CSN)}`);
