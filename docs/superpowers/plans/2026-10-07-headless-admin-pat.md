# Headless Admin OData / GraphQL via per-user PATs — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a holder of the *Tutorials Admin* role reach `/admin/*` (OData) and `/graphql` headlessly with a per-user PAT, with admin authority resolved live from a revocable app-managed DB grant.

**Architecture:** A new `admin` PAT scope, gated at mint time on the caller's live XSUAA `Admin` role, records a revocable `AdminGrants` DB row. On each PAT request to new `/admin-pat/*` + `/graphql-pat` approuter routes, a bootstrap middleware (mirroring the existing `/mcp-pat/` block) recognizes `Bearer pat_`, and `lookupPAT` resolves the owner's live grant into `roles:['Admin','Tutorial.API']`. The whole path is gated behind a DEV-first DB flag `PAT_ADMIN_SCOPE_ENABLED` (default OFF) and is fully additive — existing routes and read/write PATs are untouched.

**Tech Stack:** CAP Node.js (`@sap/cds`), SQLite (unit) / HANA (hybrid+prod), @cap-js/mcp + @cap-js/graphql, approuter `xs-app.json`, in-house feature-flag registry (`packages/core/feature-flags`).

**Spec:** `docs/superpowers/specs/2026-10-07-headless-admin-pat-design.md`

## Global Constraints

- **No raw SQL** — use `cds.ql` / CQL (CLAUDE.md hard constraint). Exception: the existing BLOB-locator rule does not apply here (no BLOBs touched).
- **Never bypass CAP auth** — authority flows through `req.user.is(...)` / `@requires`; the PAT path sets a synthetic user then relies on CAP `@requires:'Admin'`.
- **PAT plaintext is returned exactly once at mint; only `hashHex` (SHA-256) is stored** — never persist plaintext. Unchanged from existing behavior.
- **Feature flag default OFF, DEV-first.** `PAT_ADMIN_SCOPE_ENABLED` must gate every new runtime path; flag OFF ⇒ behavior identical to today.
- **Admin PAT TTL:** default **30** days, max **90** days. Read/write PATs keep default 90 / max 365.
- **PRs target `DEV`; `main` is protected.** Final PR base = `DEV`.
- **Approuter query-string gotcha:** a `source` ending `(/.*)?$` without a query group 404s any `?query` request. Headless calls are query-heavy — follow the exact `source` shapes given in Task 6.
- **Header strip is mandatory** on the PAT path or CAP's XSUAA strategy JWT-parses the leftover `Authorization` and 401s (`patMiddleware` already strips; the new bootstrap block must preserve that).
- **Token efficiency:** wrap `npm test` / build / deploy in `scripts/quiet-run.sh`.

---

## File Structure

- `db/mcp-pats.cds` — **modify**: add `AdminGrants` entity alongside `PATs`.
- `srv/lib/mcp-pat-actions.js` — **modify**: `admin` in `VALID_SCOPES`; admin TTL clamp; mint-time Admin gate + `AdminGrants` upsert.
- `srv/lib/mcp-pat-middleware.js` — **modify**: live grant resolution in `lookupPAT` (populate `roles`).
- `srv/lib/admin-grant.js` — **create**: small helper to resolve/upsert/revoke a live `AdminGrants` row (single responsibility; imported by actions + middleware).
- `srv/server.js` — **modify**: new bootstrap middleware recognizing `Bearer pat_` on `/admin-pat/*` + `/graphql-pat`, flag-gated, rewriting to `/admin` + `/graphql`.
- `srv/admin-service.cds` + `srv/admin-service.js` — **modify**: `revokeAdminGrant(user_ID)` action (`@requires:'Admin'`) + handler.
- `packages/core/feature-flags/registry.js` — **modify**: register `PAT_ADMIN_SCOPE_ENABLED`.
- `approuter/xs-app.json` — **modify**: add `/admin-pat/*` + `/graphql-pat` `none` routes (before the catch-all, order matching existing admin/graphql routes).
- `docs/end-users/api-consumption.md` — **modify**: flip Admin/GraphQL rows to headless-capable; working curl flow; PAT hygiene callout.
- Tests: `test/pat-admin-grant.test.js` (unit), `test/pat-admin-headless.test.js` (integration), `test/e2e/` smoke addition.

Dependency order: Task 1 (grant entity) → Task 2 (admin-grant helper) → Task 3 (scopes+mint gate) → Task 4 (lookupPAT roles) → Task 5 (flag) → Task 6 (approuter) → Task 7 (bootstrap middleware) → Task 8 (revoke action) → Task 9 (docs) → Task 10 (smoke/e2e).

---

### Task 1: `AdminGrants` entity

**Files:**
- Modify: `db/mcp-pats.cds`
- Test: `test/pat-admin-grant.test.js`

**Interfaces:**
- Produces: entity `com.sap.developers.ims.AdminGrants { key ID; user: Association to Users; grantedAt: Timestamp; grantedBy: String(255); expiresAt: Timestamp; }`, `@assert.unique.user`.

- [ ] **Step 1: Write the failing test**

```js
// test/pat-admin-grant.test.js
const cds = require('@sap/cds');
const { expect } = require('chai');
describe('AdminGrants entity', () => {
  const { GET, data } = cds.test(__dirname + '/..'); // boots in-memory sqlite
  it('persists a grant row keyed by user with expiry', async () => {
    const db = await cds.connect.to('db');
    const { AdminGrants, Users } = cds.entities('com.sap.developers.ims');
    const [u] = await db.run(SELECT.from(Users).limit(1));
    const exp = new Date(Date.now() + 30 * 864e5).toISOString();
    await db.run(INSERT.into(AdminGrants).entries({
      ID: cds.utils.uuid(), user_ID: u.ID, grantedBy: 'tom@sap.com', expiresAt: exp,
    }));
    const [row] = await db.run(SELECT.from(AdminGrants).where({ user_ID: u.ID }));
    expect(row).to.exist;
    expect(row.grantedBy).to.equal('tom@sap.com');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: FAIL — `AdminGrants` is undefined in `cds.entities(...)`.

- [ ] **Step 3: Add the entity**

In `db/mcp-pats.cds`, after the `PATs` entity, add:

```cds
/** Server-trusted "this user currently has headless admin authority" grant.
 *  Created/affirmed only when the caller holds the real XSUAA Admin role at
 *  PAT mint time (see srv/lib/mcp-pat-actions.js). Presence of a non-expired
 *  row makes an `admin`-scoped PAT resolve roles ['Admin','Tutorial.API'].
 *  Revoke the row (admin action) to kill all that user's admin PATs live. */
entity AdminGrants : cuid, managed {
  user      : Association to ims.Users  @assert.unique;
  grantedAt : Timestamp;
  grantedBy : String(255);   // email of the admin who minted/affirmed
  expiresAt : Timestamp;
}
```

(Reuse whatever `ims` namespace alias `PATs` already uses in this file; match the existing `Association to ims.Users` style verbatim.)

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/mcp-pats.cds test/pat-admin-grant.test.js
git commit -m "feat(db): AdminGrants entity for headless admin PATs (#2574)"
```

---

### Task 2: `admin-grant.js` resolver helper

**Files:**
- Create: `srv/lib/admin-grant.js`
- Test: `test/pat-admin-grant.test.js` (extend)

**Interfaces:**
- Consumes: `AdminGrants` entity (Task 1).
- Produces:
  - `async function resolveAdminGrant(dbUserId) → boolean` — true iff a non-expired grant row exists for `user_ID === dbUserId`. Fail-closed: any error ⇒ `false`.
  - `async function upsertAdminGrant(dbUserId, grantedByEmail, ttlDays) → void` — insert-or-update the single row for that user, setting `grantedAt=now`, `grantedBy`, `expiresAt=now+ttlDays`.
  - `async function revokeAdminGrant(dbUserId) → number` — delete the row(s) for that user; returns count deleted.

- [ ] **Step 1: Write the failing test** (append to `test/pat-admin-grant.test.js`)

```js
const { resolveAdminGrant, upsertAdminGrant, revokeAdminGrant } = require('../srv/lib/admin-grant');
describe('admin-grant helper', () => {
  const { } = cds.test(__dirname + '/..');
  let uid;
  before(async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const [u] = await db.run(SELECT.from(Users).limit(1)); uid = u.ID;
  });
  it('resolves false with no grant', async () => {
    expect(await resolveAdminGrant(uid)).to.equal(false);
  });
  it('upserts then resolves true, and is idempotent (one row)', async () => {
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    const db = await cds.connect.to('db');
    const { AdminGrants } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(AdminGrants).where({ user_ID: uid }));
    expect(rows.length).to.equal(1);
    expect(await resolveAdminGrant(uid)).to.equal(true);
  });
  it('resolves false when expired', async () => {
    await upsertAdminGrant(uid, 'tom@sap.com', 0.0001 / 864e5 * 864e5); // ~now
    await upsertAdminGrant(uid, 'tom@sap.com', -1);                     // already expired
    expect(await resolveAdminGrant(uid)).to.equal(false);
  });
  it('revoke removes the grant', async () => {
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    expect(await revokeAdminGrant(uid)).to.be.greaterThan(0);
    expect(await resolveAdminGrant(uid)).to.equal(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: FAIL — cannot find module `../srv/lib/admin-grant`.

- [ ] **Step 3: Implement the helper**

```js
// srv/lib/admin-grant.js
const cds = require('@sap/cds');
const NS = 'com.sap.developers.ims';

async function resolveAdminGrant(dbUserId) {
  if (!dbUserId) return false;
  try {
    const { AdminGrants } = cds.entities(NS);
    const db = await cds.connect.to('db');
    const [row] = await db.run(SELECT.from(AdminGrants).where({ user_ID: dbUserId }));
    if (!row || !row.expiresAt) return false;
    return new Date(row.expiresAt).getTime() > Date.now();
  } catch (e) {
    cds.log('admin-grant').warn('resolveAdminGrant failed, fail-closed', e.message);
    return false; // fail-closed
  }
}

async function upsertAdminGrant(dbUserId, grantedByEmail, ttlDays) {
  const { AdminGrants } = cds.entities(NS);
  const db = await cds.connect.to('db');
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ttlDays * 864e5).toISOString();
  const [existing] = await db.run(SELECT.from(AdminGrants).where({ user_ID: dbUserId }));
  if (existing) {
    await db.run(UPDATE(AdminGrants).set({ grantedAt: now.toISOString(), grantedBy: grantedByEmail, expiresAt }).where({ user_ID: dbUserId }));
  } else {
    await db.run(INSERT.into(AdminGrants).entries({ ID: cds.utils.uuid(), user_ID: dbUserId, grantedAt: now.toISOString(), grantedBy: grantedByEmail, expiresAt }));
  }
}

async function revokeAdminGrant(dbUserId) {
  const { AdminGrants } = cds.entities(NS);
  const db = await cds.connect.to('db');
  return db.run(DELETE.from(AdminGrants).where({ user_ID: dbUserId }));
}

module.exports = { resolveAdminGrant, upsertAdminGrant, revokeAdminGrant };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: PASS (all 4 cases in the helper block).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/admin-grant.js test/pat-admin-grant.test.js
git commit -m "feat(pat): admin-grant resolve/upsert/revoke helper, fail-closed (#2574)"
```

---

### Task 3: `admin` scope + mint-time Admin gate + admin TTL

**Files:**
- Modify: `srv/lib/mcp-pat-actions.js`
- Test: `test/pat-admin-grant.test.js` (extend) — unit-test the pure pieces; mint flow asserted in Task 7 integration too.

**Interfaces:**
- Consumes: `upsertAdminGrant` (Task 2); `isFlagEnabled('PAT_ADMIN_SCOPE_ENABLED')` (Task 5 registers it — but `isFlagEnabled` tolerates an unregistered key by returning its default; add Task 5 before running the full suite).
- Produces: `VALID_SCOPES` now includes `'admin'`; `clampTtl(ttlDays, { admin })` honors a 30/90 clamp when `admin`; `handleMintPAT` rejects `admin` scope unless `req.user.is('Admin')` and (when allowed) upserts a grant.

- [ ] **Step 1: Write the failing test** (append)

```js
const actions = require('../srv/lib/mcp-pat-actions');
describe('admin scope + TTL', () => {
  it('accepts admin in valid scopes', () => {
    expect(() => actions.__test.assertValidScopes(['admin'])).to.not.throw();
  });
  it('clamps admin TTL to max 90 and default 30', () => {
    expect(actions.__test.clampTtl(365, { admin: true })).to.equal(90);
    expect(actions.__test.clampTtl(undefined, { admin: true })).to.equal(30);
    expect(actions.__test.clampTtl(365, { admin: false })).to.equal(365); // read/write unchanged
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: FAIL — `actions.__test` undefined / `admin` rejected / TTL not clamped.

- [ ] **Step 3: Implement**

In `srv/lib/mcp-pat-actions.js`:

```js
const VALID_SCOPES = new Set(['read', 'write', 'admin']);
const MIN_TTL = 1;
const MAX_TTL = 365;
const DEFAULT_TTL = 90;
const ADMIN_MAX_TTL = 90;
const ADMIN_DEFAULT_TTL = 30;
const { upsertAdminGrant } = require('./admin-grant');
const { isFlagEnabled } = require('../../packages/core/feature-flags/db-flags'); // match existing import path used for MCP_PAT_MINT_ENABLED
```

Replace `clampTtl`:

```js
function clampTtl(ttlDays, { admin = false } = {}) {
  const def = admin ? ADMIN_DEFAULT_TTL : DEFAULT_TTL;
  const max = admin ? ADMIN_MAX_TTL : MAX_TTL;
  const n = Number.isFinite(ttlDays) ? ttlDays : def;
  return Math.min(max, Math.max(MIN_TTL, n));
}
```

In `handleMintPAT`, after `assertValidScopes(scopes)` succeeds and after `dbUser` is resolved, insert the gate (and compute the admin-aware TTL):

```js
  const wantsAdmin = Array.isArray(scopes) && scopes.includes('admin');
  if (wantsAdmin) {
    if (!isFlagEnabled('PAT_ADMIN_SCOPE_ENABLED')) return req.reject(503, 'admin-scoped PATs are disabled');
    if (!req.user.is('Admin')) return req.error(403, 'admin scope requires the Tutorials Admin role');
    await upsertAdminGrant(dbUser.ID, req.user.id, ADMIN_DEFAULT_TTL);
  }
  const ttl = clampTtl(ttlDays, { admin: wantsAdmin });
```

(Replace the existing `const ttl = clampTtl(ttlDays);` line.)

Export test hooks at the bottom (keep existing exports):

```js
module.exports.__test = { assertValidScopes, clampTtl };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/mcp-pat-actions.js test/pat-admin-grant.test.js
git commit -m "feat(pat): admin scope + mint-time Admin gate + 30/90 TTL (#2574)"
```

---

### Task 4: live grant resolution in `lookupPAT`

**Files:**
- Modify: `srv/lib/mcp-pat-middleware.js`
- Test: `test/pat-admin-grant.test.js` (extend)

**Interfaces:**
- Consumes: `resolveAdminGrant` (Task 2).
- Produces: `lookupPAT` returns `roles:['Admin','Tutorial.API']` iff the PAT's `scopes` include `'admin'` AND a live grant exists; `[]` otherwise. `installSyntheticUser`'s existing `is()` closure (which already consults `cached.roles`) then answers `is('Admin')`/`is('Tutorial.API')` true.

- [ ] **Step 1: Write the failing test** (append)

```js
const mw = require('../srv/lib/mcp-pat-middleware');
describe('lookupPAT live admin role resolution', () => {
  let uid;
  before(async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims'); const [u] = await db.run(SELECT.from(Users).limit(1)); uid = u.ID;
  });
  it('admin PAT + live grant → roles include Admin & Tutorial.API', async () => {
    const { upsertAdminGrant } = require('../srv/lib/admin-grant');
    await upsertAdminGrant(uid, 'tom@sap.com', 30);
    const cached = await mw.__test.buildCached({ ID: 'p1', user_ID: uid, scopes: ['admin'], expiresAt: null, revokedAt: null });
    expect(cached.roles).to.include.members(['Admin', 'Tutorial.API']);
  });
  it('read-only PAT with a grant present → no admin role', async () => {
    const cached = await mw.__test.buildCached({ ID: 'p2', user_ID: uid, scopes: ['read'], expiresAt: null, revokedAt: null });
    expect(cached.roles).to.not.include('Admin');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: FAIL — `mw.__test.buildCached` undefined (and `roles` currently hardcoded `[]`).

- [ ] **Step 3: Implement**

In `srv/lib/mcp-pat-middleware.js`, add import near the top:

```js
const { resolveAdminGrant } = require('./admin-grant');
```

Refactor the `lookupPAT` return so the `roles` computation is reusable and live. Replace the hardcoded `roles: []` with a resolved value, extracting the mapping into a small helper used by both `lookupPAT` and the test:

```js
async function computeRoles(scopes, dbUserId) {
  if (Array.isArray(scopes) && scopes.includes('admin') && await resolveAdminGrant(dbUserId)) {
    return ['Admin', 'Tutorial.API'];
  }
  return [];
}
```

In `lookupPAT`, change the returned object's `roles` to be computed:

```js
  const roles = await computeRoles(row.scopes ?? [], row.user_ID);
  return {
    patId: row.ID, userId: row.user_ID, email: user.email, sapId: user.sapId ?? null,
    scopes: row.scopes ?? [], expiresAt: /* unchanged */, revokedAt: /* unchanged */,
    roles,
    attr: { email: user.email, displayName: user.displayName },
  };
```

> **Caching note:** `cached` is stored in cds-caching with a 60s TTL. Because `roles` are baked into the cached object, a grant revoke can take up to 60s to take effect on a hot PAT. Document this in the revoke action (Task 8) and in `api-consumption.md` (Task 9): "revocation is effective within ~60s". If strict-immediate revocation is later required, move `computeRoles` out of the cached object into `installSyntheticUser`. (Not doing that now — YAGNI; 60s is acceptable and matches existing PAT cache semantics.)

Add a test hook that exercises the real path:

```js
module.exports.__test = {
  buildCached: async (row) => {
    const roles = await computeRoles(row.scopes ?? [], row.user_ID);
    return { ...row, roles };
  },
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/mcp-pat-middleware.js test/pat-admin-grant.test.js
git commit -m "feat(pat): resolve live admin roles in lookupPAT (#2574)"
```

---

### Task 5: register `PAT_ADMIN_SCOPE_ENABLED` flag

**Files:**
- Modify: `packages/core/feature-flags/registry.js`
- Test: covered by booting (unit suite loads the registry); add a one-line assertion.

**Interfaces:**
- Produces: flag key `PAT_ADMIN_SCOPE_ENABLED`, `kind:'db'`, `imsConfigKey:'flag.pat.adminScope'`, boolean, default **false**.

- [ ] **Step 1: Write the failing test** (append)

```js
describe('PAT_ADMIN_SCOPE_ENABLED flag', () => {
  it('is registered and defaults OFF', () => {
    const reg = require('../packages/core/feature-flags/registry');
    const list = reg.FLAGS ?? reg.default ?? reg; // match the module's actual export shape
    const flag = (Array.isArray(list) ? list : Object.values(list)).find(f => f.key === 'PAT_ADMIN_SCOPE_ENABLED');
    expect(flag).to.exist; expect(flag.default).to.equal(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: FAIL — flag not found.

- [ ] **Step 3: Add the registry entry**

In `packages/core/feature-flags/registry.js`, add alongside the other PAT/MCP flags (match the `MCP_PAT_MINT_ENABLED` entry shape at lines 269-274 verbatim):

```js
  {
    key: 'PAT_ADMIN_SCOPE_ENABLED', label: 'PAT admin scope (headless admin)', category: 'MCP',
    kind: 'db', imsConfigKey: 'flag.pat.adminScope',
    valueType: 'boolean', default: false, issue: '#2574', status: 'beta',
    description: 'Enables the headless admin PAT path: the `admin` PAT scope, the /admin-pat/* + /graphql-pat approuter routes, and live AdminGrants resolution. Default OFF; flip DEV-first after verification. DB-driven config (ImsConfig key flag.pat.adminScope); no env var.',
    howToChange: featureFlagUpsert('PAT_ADMIN_SCOPE_ENABLED', 'flag.pat.adminScope'),
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: PASS. (If the export-shape line fails, inspect the module's `module.exports` and adjust the one-liner — do not change the registry.)

- [ ] **Step 5: Commit**

```bash
git add packages/core/feature-flags/registry.js test/pat-admin-grant.test.js
git commit -m "feat(flags): register PAT_ADMIN_SCOPE_ENABLED, default OFF (#2574)"
```

---

### Task 6: approuter `/admin-pat/*` + `/graphql-pat` routes

**Files:**
- Modify: `approuter/xs-app.json`

**Interfaces:**
- Produces: two `authenticationType:"none"`, `csrfProtection:false` routes to `srv-api`, placed BEFORE the catch-all static route and after the existing specific routes. The app rewrites `/admin-pat/...`→`/admin/...` and `/graphql-pat`→`/graphql` (Task 7); the approuter `target` forwards the prefixed path to `srv-api` as-is.

- [ ] **Step 1: Add the routes**

Add to the `routes` array (near the existing `/mcp-pat/` route; order only needs to precede the final catch-all). Note the `source` shapes mirror the working routes exactly — `/admin-pat/(.*)$` like `/admin/(.*)$` (captures query via `$1`), `/graphql-pat` with the explicit `(\?.*)?$` query group like `/graphql`:

```json
{
  "source": "^/admin-pat/(.*)$",
  "target": "/admin-pat/$1",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
},
{
  "source": "^/graphql-pat(\\?.*)?$",
  "target": "/graphql-pat",
  "destination": "srv-api",
  "authenticationType": "none",
  "csrfProtection": false
}
```

- [ ] **Step 2: Validate JSON**

Run: `bash scripts/quiet-run.sh node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(approuter): /admin-pat + /graphql-pat none routes for headless PATs (#2574)"
```

---

### Task 7: bootstrap middleware — recognize PAT on `/admin-pat/*` + `/graphql-pat`

**Files:**
- Modify: `srv/server.js`
- Test: `test/pat-admin-headless.test.js` (integration)

**Interfaces:**
- Consumes: `patMiddleware` (already imported at `srv/server.js:66`), `isFlagEnabled`.
- Produces: on a `/admin-pat/*` or `/graphql-pat` request carrying `Authorization: Bearer pat_` AND flag ON — runs `patMiddleware` (sets synthetic user, strips header), rewrites `req.url` to the real `/admin/*` or `/graphql` target, then `next()`. Flag OFF or non-PAT ⇒ `next()` untouched (route 404s / normal path).

- [ ] **Step 1: Write the failing integration test**

```js
// test/pat-admin-headless.test.js
const cds = require('@sap/cds');
const { expect } = require('chai');
describe('headless admin PAT on /admin-pat', () => {
  const { GET, POST } = cds.test(__dirname + '/..');
  // Helper: mint an admin PAT via the service as a mocked Admin user, with flag ON.
  // Uses cds mocked-auth; set the flag via ImsConfig or env shim per the suite's flag harness.
  it('an admin PAT reaches AdminService through /admin-pat', async () => {
    // 1) enable flag (follow the project's existing flag-override test util; e.g. setFlag('PAT_ADMIN_SCOPE_ENABLED', true))
    // 2) mint: POST /pats mintPAT { name, scopes:['admin'] } as a user with .is('Admin')
    // 3) GET /admin-pat/Tutorials?$top=1 with Authorization: Bearer <token>
    // 4) expect 200 and a Tutorials collection
    // See test/ for the existing mocked-admin + PAT mint helpers; reuse them rather than hand-rolling auth.
  });
});
```

> **Implementer:** this integration test MUST be fleshed out using the repo's existing PAT-mint and mocked-admin test helpers (grep `test/` for `mintPAT` and `is('Admin')` harnesses). Do not hand-roll XSUAA. If no helper exists to flip a DB flag inside a test, add a minimal `setFlag` shim in the test using the `ImsConfig` entity (`UPSERT` key `flag.pat.adminScope` = `'true'`), then clear it in `afterEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-headless.test.js`
Expected: FAIL — `/admin-pat/*` 404s (no middleware yet).

- [ ] **Step 3: Implement the bootstrap middleware**

In `srv/server.js`, inside the existing `cds.on('bootstrap', app => { ... })` block (near the `/mcp-pat/` block at ~line 1229), add:

```js
  // Headless admin PAT: recognize Bearer pat_ on /admin-pat/* and /graphql-pat,
  // rewrite to the real /admin + /graphql routers. Flag-gated, fully additive.
  app.use((req, res, next) => {
    const u = req.url;
    const isAdminPat = u.startsWith('/admin-pat/') || u === '/admin-pat';
    const isGqlPat = u === '/graphql-pat' || u.startsWith('/graphql-pat?');
    if (!isAdminPat && !isGqlPat) return next();
    if (!isFlagEnabled('PAT_ADMIN_SCOPE_ENABLED')) return next(); // → 404, path inert
    const authz = req.headers?.authorization;
    if (!authz || !authz.startsWith('Bearer pat_')) {
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      return res.status(401).json({ error: 'PAT required on headless admin routes' });
    }
    return patMiddleware(req, res, (err) => {
      if (err) return next(err);
      if (isAdminPat) {
        const rest = req.url.slice('/admin-pat'.length) || '/';
        req.url = '/admin' + rest;
      } else {
        req.url = '/graphql' + req.url.slice('/graphql-pat'.length); // preserves ?query
      }
      if (req.originalUrl) req.originalUrl = req.url;
      next();
    });
  });
```

Confirm `isFlagEnabled` is imported in `server.js` (it is used elsewhere in the file per the registry wiring; if not, add the same import the `/mcp-pat` region uses).

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-headless.test.js`
Expected: PASS (200 + Tutorials collection).

- [ ] **Step 5: Run the full unit suite (no regressions)**

Run: `bash scripts/quiet-run.sh npm test`
Expected: PASS; existing `/mcp-pat` and PAT tests unaffected.

- [ ] **Step 6: Commit**

```bash
git add srv/server.js test/pat-admin-headless.test.js
git commit -m "feat(server): recognize admin PAT on /admin-pat + /graphql-pat, flag-gated (#2574)"
```

---

### Task 8: `revokeAdminGrant` admin action

**Files:**
- Modify: `srv/admin-service.cds`, `srv/admin-service.js`
- Test: `test/pat-admin-grant.test.js` (extend)

**Interfaces:**
- Consumes: `revokeAdminGrant` helper (Task 2).
- Produces: unbound action `revokeAdminGrant(user_ID: String) returns { revoked: Integer }` on `AdminService` (`@requires:'Admin'` inherited from service). Deletes the grant; effective on hot PATs within ~60s (cache TTL).

- [ ] **Step 1: Write the failing test** (append to `test/pat-admin-grant.test.js`)

```js
describe('AdminService.revokeAdminGrant', () => {
  const { POST } = cds.test(__dirname + '/..');
  it('deletes a user grant (as Admin)', async () => {
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims'); const [u] = await db.run(SELECT.from(Users).limit(1));
    const { upsertAdminGrant, resolveAdminGrant } = require('../srv/lib/admin-grant');
    await upsertAdminGrant(u.ID, 'tom@sap.com', 30);
    // call as mocked admin — reuse the suite's admin auth header/util
    const res = await POST('/admin/revokeAdminGrant', { user_ID: u.ID }, { auth: { username: 'admin', password: 'admin' } });
    expect(res.status).to.equal(200);
    expect(await resolveAdminGrant(u.ID)).to.equal(false);
  });
});
```

> Reuse the repo's existing mocked-admin credentials/util (grep `test/` for how other `AdminService` actions are called under mocked auth). Adjust the auth block to match.

- [ ] **Step 2: Run test to verify it fails**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: FAIL — action not defined (404/400).

- [ ] **Step 3: Implement**

In `srv/admin-service.cds`, add to the `AdminService` body:

```cds
  /** Revoke a user's headless-admin grant (kills their admin PATs within ~60s). */
  action revokeAdminGrant(user_ID : String) returns { revoked : Integer };
```

In `srv/admin-service.js`, register the handler (match the file's existing `srv.on(...)` style):

```js
const { revokeAdminGrant } = require('./lib/admin-grant');
// inside the service implementation function:
srv.on('revokeAdminGrant', async (req) => {
  const n = await revokeAdminGrant(req.data.user_ID);
  return { revoked: Number(n) || 0 };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bash scripts/quiet-run.sh npx mocha test/pat-admin-grant.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/pat-admin-grant.test.js
git commit -m "feat(admin): revokeAdminGrant action to kill headless admin grants (#2574)"
```

---

### Task 9: documentation — flip Admin/GraphQL to headless-capable

**Files:**
- Modify: `docs/end-users/api-consumption.md`

**Interfaces:** none (docs).

- [ ] **Step 1: Update the surfaces table**

Change the two rows (currently "❌ **No — browser session only**"):

```md
| **Admin OData** | /admin-pat/* | ✅ **Yes — PAT (`admin` scope)** | Mint a PAT with `admin` scope at `/me/tokens/` (requires the Tutorials Admin role); send it as `Authorization: Bearer pat_…` | this page (below) |
| **GraphQL** | /graphql-pat | ✅ **Yes — PAT (`admin` scope)** | Same admin-scoped PAT; `Authorization: Bearer pat_…` | this page (below) |
```

- [ ] **Step 2: Rewrite the two "browser-session only (today)" sections**

Replace each with a working flow, e.g.:

````md
### Admin OData surface — headless with an admin-scoped PAT

1. Sign in to the admin UI and open `/me/tokens/`. Mint a PAT with the **admin** scope
   (only offered if you hold the *Tutorials Admin* role). Copy the token — shown once.
2. Call the OData surface headlessly via the `/admin-pat/*` prefix:

```bash
curl -s -H "Authorization: Bearer pat_xxx" \
  "https://<host>/admin-pat/Tutorials?\$filter=owner eq 'me@sap.com'&\$expand=completionStats,feedbackItems"
```

The same per-user Admin authorization applies as in the browser; a revoked grant (or
an expired PAT) stops working within ~60 seconds.
````

Add the equivalent `/graphql-pat` curl example.

- [ ] **Step 3: Add the PAT hygiene callout**

```md
> **Admin PATs are high-value bearer credentials.** Store them in an environment
> variable or a secret store — **never** commit them to client config files such as
> Claude Code `settings.json`. Use the shortest TTL that works (admin PATs max out at
> 90 days, default 30). Revoke when done via `/me/tokens/` or an admin
> `revokeAdminGrant`. A Credential-Store-backed option for MCP-client PATs is tracked
> separately (see follow-up ticket).
```

- [ ] **Step 4: Move the #2574 gap item to done**

In "Gaps & future work", remove the "Headless admin OData access … Tracked in #2574" bullet (now shipped) or mark it done.

- [ ] **Step 5: Commit**

```bash
git add docs/end-users/api-consumption.md
git commit -m "docs: Admin OData + GraphQL now headless-capable via admin PAT (#2574)"
```

---

### Task 10: post-deploy smoke / e2e

**Files:**
- Modify/Create under `test/e2e/` or `test/smoke/` (match the existing smoke harness location)

**Interfaces:**
- Consumes: deployed env; `SMOKE_BASE_URL`, and an admin PAT provided via `SMOKE_ADMIN_PAT` env (self-skips if absent — matches `test:e2e` convention).

- [ ] **Step 1: Write the smoke test (self-skipping)**

```js
// test/e2e/headless-admin-pat.smoke.test.js
const base = process.env.SMOKE_BASE_URL, pat = process.env.SMOKE_ADMIN_PAT;
const run = base && pat ? describe : describe.skip;
run('headless admin PAT (deployed)', () => {
  it('GET /admin-pat/Tutorials?$top=1 returns 200', async () => {
    const res = await fetch(`${base}/admin-pat/Tutorials?$top=1`, { headers: { Authorization: `Bearer ${pat}` } });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  });
  it('POST /graphql-pat returns 200', async () => {
    const res = await fetch(`${base}/graphql-pat`, {
      method: 'POST', headers: { Authorization: `Bearer ${pat}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ __typename }' }),
    });
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`);
  });
});
```

- [ ] **Step 2: Verify it self-skips locally**

Run: `bash scripts/quiet-run.sh npx mocha test/e2e/headless-admin-pat.smoke.test.js`
Expected: `0 passing`, suite skipped (no `SMOKE_*`).

- [ ] **Step 3: Commit**

```bash
git add test/e2e/headless-admin-pat.smoke.test.js
git commit -m "test(e2e): headless admin PAT smoke (self-skips without SMOKE_ADMIN_PAT) (#2574)"
```

---

## Final steps (after all tasks)

- [ ] Run full suite: `bash scripts/quiet-run.sh npm test` — all green.
- [ ] Open PR against **`DEV`** (not `main`): `gh pr create --base DEV`. Body references #2574, lists the flag-OFF default, and the DEV-first flip plan.
- [ ] Do NOT deploy from the feature branch (GOLDEN RULE). Flag flip + verification on DEV happens from a fresh `origin/DEV` after merge.

## Self-Review notes (resolved)

- **Spec coverage:** every spec component maps to a task — AdminGrants (T1), helper (T2), scope+gate+TTL (T3), live roles (T4), flag (T5), approuter option A (T6), bootstrap middleware + header strip (T7), revoke (T8), docs + hygiene (T9), smoke (T10). The settings.json "separate ticket" is explicitly out of scope (noted in T9 callout).
- **Type consistency:** `resolveAdminGrant`/`upsertAdminGrant`/`revokeAdminGrant` signatures identical across T2 definition and T3/T4/T8 consumers; `clampTtl(ttlDays, {admin})` consistent T3; `computeRoles(scopes, dbUserId)` internal to T4.
- **Known soft spots flagged for the implementer:** exact feature-flag module export shape (T5 Step 4), the repo's mocked-admin + flag-override test utilities (T7/T8 reuse existing helpers, don't hand-roll), and `isFlagEnabled` import path (T3) — all called out inline rather than guessed.
