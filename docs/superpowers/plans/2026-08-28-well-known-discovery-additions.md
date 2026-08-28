# `.well-known` Discovery Additions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the four remaining `.well-known` discovery pieces (`openid-configuration`, `mcp.json`, a `WWW-Authenticate` discovery pointer, and the PROD Akamai edge-forward request) on top of the already-shipped Option-A OAuth/security.txt surface.

**Architecture:** The OAuth discovery + security.txt docs already ship as runtime approuter middleware (`approuter/lib/well-known-oauth.js`, `approuter/lib/security-txt.js`), registered `insertMiddleware.first` in `approuter/server.js`. New work mirrors those exact patterns — small CommonJS middleware modules, VCAP/request-derived values, GET/HEAD-only, pass-through otherwise — plus a docs fix and an ops ticket.

**Tech Stack:** Node.js CommonJS (approuter middleware), `@sap/approuter`, Vitest (`unit` + `hybrid` projects), no new dependencies.

**Spec:** `docs/superpowers/specs/2026-08-28-well-known-oauth-discovery-design.md`

## Global Constraints

- **Keep Option A.** Do NOT change `authorization_servers`/`issuer` (they point at the XSUAA URL) or the fully-qualified scope logic in `resolveScope()`.
- **No static files, no envsubst.** All values derive at runtime from `VCAP_SERVICES.xsuaa[0].credentials` and the request host (`resolveBaseUrl`).
- **Middleware discipline:** GET/HEAD only where serving a document; every non-matching path/method calls `next()` (never swallows other routes). Register new handlers in `approuter/server.js` `insertMiddleware.first`, before `staticHandler`/`proxyHandler`.
- **Scope string:** always the qualified form via `resolveScope()` (`<xsappname>.Tutorial.MCP`) — bare `Tutorial.MCP` is rejected by XSUAA.
- Run unit tests from repo root: `npx vitest run --project unit <file>`.

---

### Task 1: `/.well-known/openid-configuration` alias

**Files:**
- Modify: `approuter/lib/well-known-oauth.js`
- Test: `test/unit/well-known-oauth.test.js` (create)

**Interfaces:**
- Consumes: existing `resolveIssuer()`, `resolveScope()`, `authorizationServerMetadata(issuer, scope)`, `AUTH_SERVER_PATH` in the same module.
- Produces: new export `OPENID_CONFIG_PATH = '/.well-known/openid-configuration'`; `wellKnownOAuthHandler` now also answers that path with the auth-server metadata body.

- [ ] **Step 1: Write the failing test** — create `test/unit/well-known-oauth.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const XSUAA = { xsuaa: [{ credentials: {
  url: 'https://tenant.authentication.eu10-005.hana.ondemand.com',
  xsappname: 'tutorials!t676072',
} }] };

function mockRes() {
  return {
    statusCode: null, headers: null, body: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    end(p) { this.body = p; return this; },
  };
}

let mod, prevVcap;
beforeAll(() => { prevVcap = process.env.VCAP_SERVICES; process.env.VCAP_SERVICES = JSON.stringify(XSUAA);
  mod = require('../../approuter/lib/well-known-oauth.js'); });
afterAll(() => { if (prevVcap === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = prevVcap; });

describe('well-known-oauth: openid-configuration alias', () => {
  it('serves openid-configuration with the same body as oauth-authorization-server', () => {
    const { wellKnownOAuthHandler, OPENID_CONFIG_PATH, authorizationServerMetadata, resolveScope } = mod;
    expect(OPENID_CONFIG_PATH).toBe('/.well-known/openid-configuration');
    const res = mockRes();
    let nexted = false;
    wellKnownOAuthHandler({ method: 'GET', url: OPENID_CONFIG_PATH, headers: {} }, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    const doc = JSON.parse(res.body);
    expect(doc).toEqual(authorizationServerMetadata(
      'https://tenant.authentication.eu10-005.hana.ondemand.com', resolveScope()));
    expect(doc.code_challenge_methods_supported).toContain('S256');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/well-known-oauth.test.js`
Expected: FAIL — `OPENID_CONFIG_PATH` is `undefined` / path falls through to `next()`.

- [ ] **Step 3: Implement** — in `approuter/lib/well-known-oauth.js`:

Add near the other path constants:
```js
const OPENID_CONFIG_PATH = '/.well-known/openid-configuration'
```
Change the path guard in `wellKnownOAuthHandler` from:
```js
if (pathOnly !== AUTH_SERVER_PATH && pathOnly !== PROTECTED_RESOURCE_PATH) {
  return next()
}
```
to include the alias:
```js
if (pathOnly !== AUTH_SERVER_PATH && pathOnly !== PROTECTED_RESOURCE_PATH && pathOnly !== OPENID_CONFIG_PATH) {
  return next()
}
```
Change the auth-server branch from:
```js
if (pathOnly === AUTH_SERVER_PATH) {
  return sendJson(res, 200, authorizationServerMetadata(issuer, scope))
}
```
to:
```js
if (pathOnly === AUTH_SERVER_PATH || pathOnly === OPENID_CONFIG_PATH) {
  return sendJson(res, 200, authorizationServerMetadata(issuer, scope))
}
```
Add `OPENID_CONFIG_PATH` to `module.exports`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/well-known-oauth.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add approuter/lib/well-known-oauth.js test/unit/well-known-oauth.test.js
git commit -m "feat(approuter): serve /.well-known/openid-configuration as oauth-authorization-server alias"
```

---

### Task 2: `/.well-known/mcp.json` courtesy manifest

**Files:**
- Create: `approuter/lib/well-known-mcp-manifest.js`
- Modify: `approuter/server.js` (require + wire in `insertMiddleware.first`)
- Test: `test/unit/well-known-mcp-manifest.test.js` (create)

**Interfaces:**
- Consumes: `resolveBaseUrl(req)`, `resolveScope()` from `./well-known-oauth`.
- Produces: export `{ mcpManifestHandler, MCP_MANIFEST_PATH, buildManifest }`.

- [ ] **Step 1: Write the failing test** — create `test/unit/well-known-mcp-manifest.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const XSUAA = { xsuaa: [{ credentials: {
  url: 'https://tenant.authentication.eu10-005.hana.ondemand.com',
  xsappname: 'tutorials!t676072',
} }] };
function mockRes() {
  return { statusCode: null, headers: null, body: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; return this; },
    end(p) { this.body = p; return this; } };
}
const REQ = { method: 'GET', url: '/.well-known/mcp.json',
  headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'developers.sap.com' } };

let mod, prevVcap;
beforeAll(() => { prevVcap = process.env.VCAP_SERVICES; process.env.VCAP_SERVICES = JSON.stringify(XSUAA);
  mod = require('../../approuter/lib/well-known-mcp-manifest.js'); });
afterAll(() => { if (prevVcap === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = prevVcap; });

describe('well-known-mcp-manifest', () => {
  it('serves mcp.json with server list and qualified scope', () => {
    const { mcpManifestHandler } = mod;
    const res = mockRes();
    let nexted = false;
    mcpManifestHandler(REQ, res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toMatch(/application\/json/);
    const doc = JSON.parse(res.body);
    expect(doc.servers.map(s => s.name)).toEqual(['search', 'homepage', 'graph', 'developer']);
    const dev = doc.servers.find(s => s.name === 'developer');
    expect(dev.url).toBe('https://developers.sap.com/mcp-auth/api');
    expect(dev.scope).toBe('tutorials!t676072.Tutorial.MCP');
    expect(doc.authorization.protected_resource)
      .toBe('https://developers.sap.com/.well-known/oauth-protected-resource');
  });

  it('passes through non-matching paths and non-GET methods', () => {
    const { mcpManifestHandler } = mod;
    for (const req of [
      { method: 'GET', url: '/.well-known/other', headers: {} },
      { method: 'POST', url: '/.well-known/mcp.json', headers: {} },
    ]) {
      const res = mockRes(); let nexted = false;
      mcpManifestHandler(req, res, () => { nexted = true; });
      expect(nexted).toBe(true);
      expect(res.statusCode).toBeNull();
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/well-known-mcp-manifest.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — create `approuter/lib/well-known-mcp-manifest.js`:

```js
// approuter/lib/well-known-mcp-manifest.js
//
// Serves /.well-known/mcp.json — a NON-STANDARD convenience manifest listing the
// hosted MCP endpoints. NOT part of the MCP spec (server publishing is via the
// central MCP Registry's server.json); we serve it as a courtesy. Runtime
// middleware, mirroring well-known-oauth.js / security-txt.js. Base URL from the
// request; scope from the bound XSUAA binding (qualified form).

const { resolveBaseUrl, resolveScope } = require('./well-known-oauth')

const MCP_MANIFEST_PATH = '/.well-known/mcp.json'

function buildManifest(baseUrl, scope) {
  return {
    $comment: 'Non-standard convenience manifest; not part of the MCP specification.',
    name: 'SAP Developers MCP',
    provider: 'SAP Tutorials (developers.sap.com)',
    servers: [
      { name: 'search',    url: `${baseUrl}/mcp/search`,   auth: 'none' },
      { name: 'homepage',  url: `${baseUrl}/mcp/homepage`, auth: 'none' },
      { name: 'graph',     url: `${baseUrl}/mcp/graph`,    auth: 'none' },
      { name: 'developer', url: `${baseUrl}/mcp-auth/api`,  auth: 'oauth2', scope },
    ],
    authorization: { protected_resource: `${baseUrl}/.well-known/oauth-protected-resource` },
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' })
  res.end(JSON.stringify(body, null, 2))
}

function mcpManifestHandler(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next()
  const pathOnly = (req.url || '').split('?')[0]
  if (pathOnly !== MCP_MANIFEST_PATH) return next()

  const baseUrl = resolveBaseUrl(req)
  if (!baseUrl) return sendJson(res, 503, { error: 'mcp_manifest_unavailable' })
  return sendJson(res, 200, buildManifest(baseUrl, resolveScope()))
}

module.exports = { mcpManifestHandler, MCP_MANIFEST_PATH, buildManifest }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/well-known-mcp-manifest.test.js`
Expected: PASS.

- [ ] **Step 5: Wire into the approuter** — in `approuter/server.js`, near the existing requires (`const { wellKnownOAuthHandler } = require('./lib/well-known-oauth')`):

```js
const { mcpManifestHandler } = require('./lib/well-known-mcp-manifest')
```
In the `insertMiddleware.first` array, add it right after the oauth handler:
```js
        first: [
          { path: '/', handler: wellKnownOAuthHandler },
          { path: '/', handler: mcpManifestHandler },
          { path: '/', handler: securityTxtHandler },
          // …rest unchanged…
```

- [ ] **Step 6: Commit**

```bash
git add approuter/lib/well-known-mcp-manifest.js approuter/server.js test/unit/well-known-mcp-manifest.test.js
git commit -m "feat(approuter): serve /.well-known/mcp.json courtesy manifest"
```

---

### Task 3: `WWW-Authenticate` discovery pointer on `/mcp-auth` 401

**Files:**
- Create: `approuter/lib/mcp-auth-challenge.js`
- Modify: `approuter/server.js` (require + wire)
- Test: `test/unit/mcp-auth-challenge.test.js` (create)

**Interfaces:**
- Consumes: `resolveBaseUrl(req)`, `resolveScope()` from `./well-known-oauth`.
- Produces: export `{ mcpAuthChallengeHandler, MCP_AUTH_PREFIXES }`.

- [ ] **Step 1: Spike (record findings in the commit body).** Confirm in `approuter/server.js` that `/mcp-auth/*` and `/mcp-admin/*` are proxied via `xs-app.json` XSUAA routes and that `insertMiddleware.first` runs before that auth. A request WITHOUT an `Authorization` header currently 401s (or 302-redirects) at the approuter with no discovery pointer. The handler short-circuits ONLY the no-`Authorization`-header case, so a valid bearer always passes through untouched. If a browser-cookie session (no bearer) legitimately hits `/mcp-auth`, that is out of scope (this namespace is programmatic MCP only) — note it and proceed.

- [ ] **Step 2: Write the failing test** — create `test/unit/mcp-auth-challenge.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const XSUAA = { xsuaa: [{ credentials: {
  url: 'https://tenant.authentication.eu10-005.hana.ondemand.com',
  xsappname: 'tutorials!t676072',
} }] };
function mockRes() {
  return { statusCode: null, headers: {}, body: null,
    setHeader(k, v) { this.headers[k] = v; },
    writeHead(s, h) { this.statusCode = s; Object.assign(this.headers, h || {}); return this; },
    end(p) { this.body = p; return this; } };
}
let mod, prevVcap;
beforeAll(() => { prevVcap = process.env.VCAP_SERVICES; process.env.VCAP_SERVICES = JSON.stringify(XSUAA);
  mod = require('../../approuter/lib/mcp-auth-challenge.js'); });
afterAll(() => { if (prevVcap === undefined) delete process.env.VCAP_SERVICES; else process.env.VCAP_SERVICES = prevVcap; });

describe('mcp-auth-challenge', () => {
  it('401s with a resource_metadata pointer when no bearer on /mcp-auth', () => {
    const { mcpAuthChallengeHandler } = mod;
    const res = mockRes(); let nexted = false;
    mcpAuthChallengeHandler(
      { method: 'POST', url: '/mcp-auth/api',
        headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'developers.sap.com' } },
      res, () => { nexted = true; });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
    expect(res.headers['WWW-Authenticate']).toBe(
      'Bearer resource_metadata="https://developers.sap.com/.well-known/oauth-protected-resource", scope="tutorials!t676072.Tutorial.MCP"');
  });

  it('passes through when an Authorization bearer is present', () => {
    const { mcpAuthChallengeHandler } = mod;
    const res = mockRes(); let nexted = false;
    mcpAuthChallengeHandler(
      { method: 'POST', url: '/mcp-auth/api', headers: { authorization: 'Bearer abc' } },
      res, () => { nexted = true; });
    expect(nexted).toBe(true);
    expect(res.statusCode).toBeNull();
  });

  it('ignores unrelated paths', () => {
    const { mcpAuthChallengeHandler } = mod;
    const res = mockRes(); let nexted = false;
    mcpAuthChallengeHandler({ method: 'GET', url: '/tutorials/foo', headers: {} }, res, () => { nexted = true; });
    expect(nexted).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/mcp-auth-challenge.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement** — create `approuter/lib/mcp-auth-challenge.js`:

```js
// approuter/lib/mcp-auth-challenge.js
//
// Emits the MCP-spec-preferred discovery trigger: a 401 with a
// `WWW-Authenticate: Bearer resource_metadata="…"` pointer on the protected MCP
// namespaces, so compliant clients follow the pointer to the protected-resource
// metadata instead of blindly probing /.well-known. Runtime middleware; mirrors
// the srv-side /mcp-pat short-circuit in srv/server.js. Only fires when NO
// Authorization header is present, so a valid bearer always passes through.

const { resolveBaseUrl, resolveScope } = require('./well-known-oauth')

const MCP_AUTH_PREFIXES = ['/mcp-auth', '/mcp-admin']

function matchesProtectedMcp(pathOnly) {
  return MCP_AUTH_PREFIXES.some(p => pathOnly === p || pathOnly.startsWith(p + '/'))
}

function mcpAuthChallengeHandler(req, res, next) {
  const pathOnly = (req.url || '').split('?')[0]
  if (!matchesProtectedMcp(pathOnly)) return next()

  const authz = req.headers && req.headers.authorization
  if (authz && authz.startsWith('Bearer ')) return next()

  const baseUrl = resolveBaseUrl(req)
  const scope = resolveScope()
  if (baseUrl) {
    res.setHeader('WWW-Authenticate',
      `Bearer resource_metadata="${baseUrl}/.well-known/oauth-protected-resource", scope="${scope}"`)
  }
  res.writeHead(401, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ error: 'unauthorized', error_description: 'Bearer token required.' }))
}

module.exports = { mcpAuthChallengeHandler, MCP_AUTH_PREFIXES }
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/mcp-auth-challenge.test.js`
Expected: PASS.

- [ ] **Step 6: Wire into the approuter** — in `approuter/server.js`, add the require:
```js
const { mcpAuthChallengeHandler } = require('./lib/mcp-auth-challenge')
```
In `insertMiddleware.first`, add it after the well-known handlers and before `staticHandler`/`proxyHandler`:
```js
          { path: '/', handler: mcpAuthChallengeHandler },
```

- [ ] **Step 7: Commit**

```bash
git add approuter/lib/mcp-auth-challenge.js approuter/server.js test/unit/mcp-auth-challenge.test.js
git commit -m "feat(approuter): add resource_metadata WWW-Authenticate pointer on /mcp-auth 401"
```

---

### Task 4: Extend the hybrid discovery test

**Files:**
- Modify: `test/hybrid/oauth-discovery.test.js`

**Interfaces:** consumes deployed approuter over `SMOKE_BASE_URL`/`HYBRID_APPROUTER_URL`; self-skips when unreachable (existing pattern).

- [ ] **Step 1: Add assertions** — append two `it()` blocks inside the existing `describeIf`:

```js
  it('serves /.well-known/openid-configuration identical to oauth-authorization-server', async () => {
    const [as, oidc] = await Promise.all([
      fetch(`${BASE}/.well-known/oauth-authorization-server`).then(r => r.json()),
      fetch(`${BASE}/.well-known/openid-configuration`).then(r => r.json()),
    ]);
    expect(oidc).toEqual(as);
  });

  it('serves /.well-known/mcp.json with the four servers', async () => {
    const res = await fetch(`${BASE}/.well-known/mcp.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
    const doc = await res.json();
    expect(doc.servers.map(s => s.name)).toEqual(['search', 'homepage', 'graph', 'developer']);
    expect(doc.authorization.protected_resource).toContain('/.well-known/oauth-protected-resource');
  });
```

- [ ] **Step 2: Run (expected skip locally)**

Run: `npx vitest run --project hybrid test/hybrid/oauth-discovery.test.js`
Expected: SKIP (target unreachable without `SMOKE_BASE_URL`) — confirms the file parses and the suite loads. Live assertion happens post-deploy against the real approuter host (see Task 6).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/oauth-discovery.test.js
git commit -m "test(hybrid): assert openid-configuration + mcp.json on deployed approuter"
```

---

### Task 5: Fix the architecture doc + draft the Akamai edge ticket

**Files:**
- Modify: `docs/developers/architecture/mcp-server.md` (§`.well-known` discovery)
- Create: `docs/developers/operations/akamai-well-known-forward.md`

- [ ] **Step 1: Correct the architecture doc.** Replace the §`.well-known` discovery paragraph that claims static files (`approuter/static/.well-known/`, "substituted at deploy time from `deploy/*.mtaext`") with the reality:

```markdown
## `.well-known` discovery

Discovery documents are served as **runtime approuter middleware**
(`insertMiddleware.first` in `approuter/server.js`), NOT static files — values
derive at request time from the bound XSUAA VCAP credentials and the request
host, so they are correct in every environment with no build-time substitution.

- `approuter/lib/well-known-oauth.js` — `/.well-known/oauth-authorization-server`
  (RFC 8414), its alias `/.well-known/openid-configuration`, and
  `/.well-known/oauth-protected-resource` (RFC 9728). `authorization_servers`/
  `issuer` point at the XSUAA URL (Option A); `scopes_supported` advertises the
  fully-qualified `<xsappname>.Tutorial.MCP` (bare `Tutorial.MCP` is rejected by
  XSUAA with `invalid_scope`).
- `approuter/lib/well-known-mcp-manifest.js` — `/.well-known/mcp.json`, a
  non-standard courtesy manifest listing the MCP mounts. Not part of the MCP spec.
- `approuter/lib/security-txt.js` — `/.well-known/security.txt` (RFC 9116).
- `approuter/lib/mcp-auth-challenge.js` — a 401 on `/mcp-auth/*` and `/mcp-admin/*`
  without a bearer carries `WWW-Authenticate: Bearer resource_metadata="…"`, the
  MCP-preferred discovery trigger.

**Edge note:** on `developers.sap.com`, Akamai 403s `/.well-known/*` at the edge
except `security.txt`. The edge must forward these paths to origin — see
[operations/akamai-well-known-forward.md](../operations/akamai-well-known-forward.md).
```

- [ ] **Step 2: Create the Akamai request doc** — `docs/developers/operations/akamai-well-known-forward.md`:

```markdown
# Akamai edge: forward `/.well-known/*` to origin

## Problem

On `developers.sap.com`, Akamai returns **403** for every `/.well-known/*` path
except `security.txt` (verified: `Server: AkamaiGHost` on the 403). The origin
approuter serves the MCP OAuth discovery documents correctly, but the edge blocks
them before they reach origin, so MCP clients cannot auto-discover the server.

## Request to the Akamai/edge team

Forward the following origin paths on `developers.sap.com` to the approuter origin
(pass-through, no edge auth, cacheable per origin `Cache-Control`):

- `/.well-known/oauth-authorization-server`
- `/.well-known/oauth-protected-resource`
- `/.well-known/openid-configuration`
- `/.well-known/mcp.json`
- `/.well-known/security.txt` (keep working; origin now also serves it)

Simplest rule: forward the whole `/.well-known/*` prefix to origin.

## Verification after the rule lands

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://developers.sap.com/.well-known/oauth-authorization-server   # expect 200
curl -s https://developers.sap.com/.well-known/oauth-protected-resource | jq .
curl -s -D - -o /dev/null https://developers.sap.com/mcp-auth/api | grep -i www-authenticate                 # expect resource_metadata pointer
```

DEV has no Akamai in front, so all paths work there as soon as the approuter deploys.
```

- [ ] **Step 3: Commit**

```bash
git add docs/developers/architecture/mcp-server.md docs/developers/operations/akamai-well-known-forward.md
git commit -m "docs: correct .well-known architecture + add Akamai edge-forward request"
```

---

### Task 6: Deploy to DEV and verify live (needs Tom's cf session)

**Files:** none (verification only).

- [ ] **Step 1:** Get the correct DEV approuter route from Tom: `cf routes` (the hybrid test's hardcoded fallback `tutorials-approuter-dev.cfapps.eu10-005…` is stale — its root 404s). Deploy the approuter per the CLAUDE.md canonical local deploy (full `build:all` → `mbt build` → `cf deploy … -e ../deploy/dev.mtaext`).
- [ ] **Step 2:** `curl` all five `/.well-known/*` paths against the real DEV approuter → expect 200 + correct bodies; `curl -D-` `/mcp-auth/api` → 401 with the `resource_metadata` pointer.
- [ ] **Step 3:** Run the hybrid suite against DEV: `SMOKE_BASE_URL=<dev-approuter> npx vitest run --project hybrid test/hybrid/oauth-discovery.test.js` → PASS (no longer skipped).
- [ ] **Step 4:** File the Akamai ticket from Task 5's doc for the PROD path.

---

## Self-Review

- **Spec coverage:** openid-configuration (Task 1), mcp.json (Task 2), WWW-Authenticate pointer (Task 3), hybrid tests (Task 4), doc fix + Akamai ticket (Task 5), live DEV verify (Task 6). All four spec items covered. Option A untouched (global constraint).
- **Placeholder scan:** none — every code/test block is concrete.
- **Type consistency:** `resolveBaseUrl`/`resolveScope` are the real exports of `well-known-oauth.js` (verified). New exports (`OPENID_CONFIG_PATH`, `mcpManifestHandler`, `mcpAuthChallengeHandler`, `MCP_AUTH_PREFIXES`) are consistent across their defining task and the `server.js` wiring.
