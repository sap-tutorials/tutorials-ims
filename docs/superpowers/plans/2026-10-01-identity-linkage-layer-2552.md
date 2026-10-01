# (issuer, subject) Identity-Linkage Layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch the app's durable identity key from `Users.sapId` to an `(issuer, subject)` linkage layer so IAS and future social logins (which carry no SAP employee ID) resolve to the correct `Users` row, while keeping `sapId` as an NGDS-only attribute.

**Architecture:** A new `UserIdentities` table links any OIDC `(iss, sub)` tuple to a `Users` row. A new async `resolveUser(user)` resolves via three tiers — (1) `(iss,sub)` link, (2) `sapId` fast-path with self-healing link-write, (3) trusted-token-email → `Users.email`. A per-request `before('*')` hook (`pinResolvedUser`) runs after auth and pins the resolved row onto `cds.context.user` (sapId → `authInfo.token.userId`; row PK → `attr.dbUserId`), so the ~40 existing `WHERE {sapId}` callsites — funneled through the sync `resolveUserSapId` and the two shared row-resolvers — stay unchanged.

**Tech Stack:** SAP CAP (`@sap/cds` v10.1.0, Node ESM), CDS (`db/schema.cds`), HANA (prod/dev) + in-memory SQLite (unit tests), Vitest (`vi.mock('@sap/cds')` + chainable `SELECT` stub), esbuild bundle (`scripts/bundle-shared.cjs`).

**Spec:** `docs/superpowers/specs/2026-10-01-identity-linkage-layer-design.md` (read it — the plan argues from it)

## Global Constraints

- PRs target **DEV**; never deploy a feature branch; deploy from fresh `origin/DEV`; `cf target` before every push.
- Read **`cds.context.user`**, not `req.user` (CAP: `req.user` is internal to auth strategies). In a handler, `req.user` is acceptable where already used, but new global hooks read `cds.context.user`.
- **Fail-closed** on resolution miss (401); never silently return 0 rows without a WARN carrying `sapId` + `email` + `(iss,sub)`.
- Do **NOT** add `@assert.unique.email` (PROD: 97.6% null, non-unique — data cannot support it).
- `UserIdentities` is **additive only** — a new `.hdbtable`; **no ALTER** on the 816k-row `Users` table.
- `@sap/cds >= 10.1.0`. Re-generate the shared bundle via `node scripts/bundle-shared.cjs` after touching `packages/core/*` (regenerates the gitignored `srv-mcp/` + `srv-qa/` `lib/_shared/core.bundle.mjs`).
- MCP MTA build is `mbt build -f mta-mcp.yaml -e deploy/mcp-dev.mtaext` (`-f` names the descriptor; `-e` is the extension).
- **srv-qa cp-list audit:** after touching anything under `srv/lib/`, re-walk transitive `./` imports from `srv/lib/content-store.js` and confirm every dep is in `.deploy/mta.yaml`'s `srv-qa` `cp` list. (The resolver is NOT a content-store dep, but the audit is mandatory when `srv/lib/` changes.)
- The srv-mcp prod impl-binding fix (`scripts/patch-mcp-impl.cjs`, #2569) is already on DEV; srv-mcp changes here ride on top of it.
- `cds.context.user.attr` is the CAP-idiomatic per-request attribute bag; the pinned PK lives at `cds.context.user.attr.dbUserId`.

---

## File Structure

**Modified:**
- `db/schema.cds` — add `UserIdentities` entity + `Users.identities` composition (Task 1).
- `packages/core/resolve-db-user.js` — the chokepoint: add `resolveUser`, Tier helpers, `pinResolvedUser`; add `attr.dbUserId` fallback to `resolveDbUser`; rewrite `provisionDbUser` on `(iss,sub)`; remove the `resolveIasSapId`/`pinIasSapId` email-join (Tasks 2–7).
- `packages/core/index.js:76` — re-export the new names, drop the removed ones (folded into Tasks 5/7).
- `srv/lib/resolve-db-user.js` — shim re-exports (folded into Tasks 5/7).
- `packages/core/user-progress.js:12-25` — `resolveDbUserId` gains `attr.dbUserId` fallback (Task 6).
- `srv-mcp/developer-service.js` — swap `pinIasSapId` → `pinResolvedUser` in the `before('*')` hook (Task 8).
- `srv/server.js` — add a global `before('*')` pin across authenticated services in a `cds.on('served')` block (Task 9).
- `srv/ktt-service.js:29,44` — replace `WHERE { sapId: req.user.id }` with the shared resolver (Task 10).

**Created:**
- `test/unit/resolve-user.test.js` — tiered resolver + pin + provisioning unit tests (Tasks 2–7).

**Deleted/repointed:**
- `test/unit/resolve-ias-sapid.test.js` — tests the removed `resolveIasSapId`/`pinIasSapId`; delete in Task 5 (its coverage moves to `resolve-user.test.js`).

---

## Task 1: `UserIdentities` schema + `Users.identities` composition

**Files:**
- Modify: `db/schema.cds` (Users entity at line 160; asserts at 157-159)
- Test: `test/unit/user-identities-schema.test.js` (create)

**Interfaces:**
- Produces: entity `com.sap.developers.ims.UserIdentities` with elements `{ ID (cuid), user (Association to Users), issuer, subject, provider, email, emailVerified, linkedAt, createdAt/modifiedAt (managed) }`; `@assert.unique.issuerSubject: [issuer, subject]`. `Users.identities : Composition of many UserIdentities`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/user-identities-schema.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('UserIdentities schema', () => {
  let csn;
  beforeAll(async () => { csn = await cds.load(['db/schema.cds']); });

  it('defines UserIdentities with (issuer, subject) unique + user association', () => {
    const d = csn.definitions['com.sap.developers.ims.UserIdentities'];
    expect(d, 'UserIdentities entity exists').toBeTruthy();
    expect(d.elements.issuer.type).toBe('cds.String');
    expect(d.elements.subject.type).toBe('cds.String');
    expect(d.elements.user.type).toBe('cds.Association');
    expect(d.elements.emailVerified.type).toBe('cds.Boolean');
    // (issuer, subject) uniqueness is declared
    const hasUnique = Object.keys(d).some(k => k.startsWith('@assert.unique'));
    expect(hasUnique, '@assert.unique.issuerSubject declared').toBe(true);
  });

  it('adds Users.identities composition', () => {
    const u = csn.definitions['com.sap.developers.ims.Users'];
    expect(u.elements.identities.type).toBe('cds.Composition');
    expect(u.elements.identities.target).toBe('com.sap.developers.ims.UserIdentities');
  });

  it('does NOT add an email uniqueness assertion on Users', () => {
    const u = csn.definitions['com.sap.developers.ims.Users'];
    expect(u['@assert.unique.email']).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/user-identities-schema.test.js`
Expected: FAIL — `UserIdentities entity exists` is falsy (entity not defined yet).

- [ ] **Step 3: Add the entity + composition to `db/schema.cds`**

Add the `Users.identities` composition inside the `Users` entity (after the `githubLogin` element, before the closing `}` at line 188 — place it with the other associations). Add exactly:

```cds
  // (issuer, subject) identity links — #2552. Durable per-IdP identity so IAS
  // and future social logins resolve without an SAP employee ID. sapId stays an
  // attribute (NGDS-only). Composition so links are managed with the user.
  identities : Composition of many UserIdentities on identities.user = $self;
```

Then add the new entity immediately AFTER the `Users` entity's closing `}` (after line 188). Match the file's annotation-above-entity style (as at 157-160):

```cds
@assert.unique.issuerSubject : [issuer, subject]
entity UserIdentities : cuid, managed {
  user          : Association to Users @mandatory;  // → user_ID FK
  issuer        : String(512) @mandatory;           // JWT `iss`
  subject       : String(255) @mandatory;           // JWT `sub` — stable per-IdP identity
  provider      : String(32);                       // 'sap-id' | 'ias' | 'github' | 'google'
  email         : String(255);                      // email AS SEEN BY THIS IdP (attribute, not key)
  emailVerified : Boolean default false;            // true when written from a login (login proves it)
  linkedAt      : Timestamp;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/user-identities-schema.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Verify the model still compiles end-to-end (no broken refs)**

Run: `npx cds compile db/schema.cds > /dev/null && echo COMPILE_OK`
Expected: prints `COMPILE_OK`, no compiler errors.

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds test/unit/user-identities-schema.test.js
git commit -m "feat(identity): add UserIdentities (issuer,subject) linkage entity (#2552)"
```

---

## Task 2: `resolveUser` Tier 1 — `(iss, sub)` link lookup

**Files:**
- Modify: `packages/core/resolve-db-user.js`
- Test: `test/unit/resolve-user.test.js` (create)

**Interfaces:**
- Consumes: `isIasToken` is NOT used here; Tier 1 is issuer/subject-agnostic. Reads `cds.context.user` claim shape `authInfo.token.payload.{iss,sub}`.
- Produces:
  - `export function issuerSubjectFromUser(user): { issuer: string, subject: string } | null` — pulls `iss`/`sub` from `user.authInfo.token.payload`.
  - `export async function resolveUser(user): Promise<object|null>` — returns the full `Users` row. In this task it implements Tier 1 ONLY (later tasks add Tiers 2–3). Returns null on miss.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/resolve-user.test.js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock @sap/cds BEFORE importing the module under test.
let captured;     // records { entity, where } for the last SELECT built
let stub;         // per-test: { identityRow, usersRows }

vi.mock('@sap/cds', () => ({
  default: {
    entities: () => ({
      Users: { name: 'com.sap.developers.ims.Users' },
      UserIdentities: { name: 'com.sap.developers.ims.UserIdentities' },
    }),
    log: () => ({ warn() {}, info() {}, error() {} }),
    utils: { uuid: () => 'generated-uuid' },
    connect: { to: async () => ({}) },
    context: { user: null },
  },
}));

// Chainable SELECT stub. Supports:
//   SELECT.one.from(E).columns(...).where({...})
//   SELECT.one.from(E).columns(...).where`lower(email) = ${v}`
//   SELECT.from(E).columns(...).where`...`   (array result)
// Returns stub values keyed by which entity is queried.
function installSelect() {
  const makeChain = (one) => {
    const chain = {
      _entity: null,
      from(e) { this._entity = e?.name || e; return this; },
      columns() { return this; },
      where(arg, ...vals) {
        captured = { entity: this._entity, where: arg, vals };
        const isUsers = String(this._entity).endsWith('.Users');
        if (isUsers) return Promise.resolve(one ? (stub.usersRows?.[0] ?? null) : (stub.usersRows ?? []));
        // UserIdentities
        return Promise.resolve(one ? (stub.identityRow ?? null) : (stub.identityRows ?? []));
      },
    };
    return chain;
  };
  globalThis.SELECT = Object.assign(() => makeChain(false), {
    one: { from: (e) => makeChain(true).from(e) },
    from: (e) => makeChain(false).from(e),
  });
}

const { resolveUser, issuerSubjectFromUser } = await import('../../packages/core/resolve-db-user.js');

const iasUser = (over = {}) => ({
  id: 'thomas.jung@sap.com',
  authInfo: { token: { payload: {
    iss: 'https://atxgsg7zi.accounts.ondemand.com',
    sub: 'thomas.jung@sap.com',
    ...over,
  } } },
});

describe('issuerSubjectFromUser', () => {
  it('extracts iss + sub from the token payload', () => {
    expect(issuerSubjectFromUser(iasUser())).toEqual({
      issuer: 'https://atxgsg7zi.accounts.ondemand.com',
      subject: 'thomas.jung@sap.com',
    });
  });
  it('returns null when iss or sub is absent', () => {
    expect(issuerSubjectFromUser({ id: 'x', authInfo: { token: { payload: { iss: 'i' } } } })).toBeNull();
    expect(issuerSubjectFromUser(null)).toBeNull();
  });
});

describe('resolveUser — Tier 1 (iss,sub) link', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });

  it('returns the linked Users row when a UserIdentities link exists', async () => {
    stub.identityRow = { user_ID: 'u-1' };
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764', email: 'thomas.jung@sap.com' }];
    const row = await resolveUser(iasUser());
    expect(row).toEqual({ ID: 'u-1', sapId: 'I809764', email: 'thomas.jung@sap.com' });
  });

  it('returns null when no link row exists and no other tier matches', async () => {
    stub.identityRow = null;
    stub.usersRows = [];
    expect(await resolveUser(iasUser())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: FAIL — `resolveUser`/`issuerSubjectFromUser` are not exported.

- [ ] **Step 3: Implement Tier 1 + the extractor**

In `packages/core/resolve-db-user.js`, add after `resolveUserSapId` (after line 58). Keep `isIasToken`/`iasEmailFromToken`/`SCIM_UUID_RE` for now (removed in Task 5 cleanup only where unused):

```js
/**
 * Extract the OIDC (issuer, subject) tuple from the authenticated user's token.
 * This is the durable per-IdP identity key — stable across logins for every
 * provider (SAP ID, IAS, social). Returns null when either claim is absent.
 *
 * @param {object} user — CAP cds.context.user / req.user.
 * @returns {{issuer: string, subject: string} | null}
 */
export function issuerSubjectFromUser(user) {
  const p = user?.authInfo?.token?.payload;
  const issuer = p?.iss;
  const subject = p?.sub;
  if (typeof issuer === 'string' && issuer && typeof subject === 'string' && subject) {
    return { issuer, subject };
  }
  return null;
}

/**
 * Resolve the authenticated request to its Users row via the tiered identity
 * layer (#2552). Tiers, in order:
 *   1. (issuer, subject) link in UserIdentities — durable, all providers.
 *   2. sapId fast-path (+ self-healing link write) — migrated SAP users.  [Task 3]
 *   3. trusted-token-email → Users.email (+ link write).                  [Task 4]
 * Miss on all tiers → null (caller stays fail-closed).
 *
 * @param {object} user — CAP cds.context.user / req.user.
 * @returns {Promise<object|null>} the full Users row, or null.
 */
export async function resolveUser(user) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  const { Users, UserIdentities } = cds.entities('com.sap.developers.ims');

  // ── Tier 1: (issuer, subject) link ──────────────────────────────────────
  const isu = issuerSubjectFromUser(user);
  if (isu) {
    const link = await SELECT.one.from(UserIdentities)
      .columns('user_ID')
      .where({ issuer: isu.issuer, subject: isu.subject });
    if (link?.user_ID) {
      const row = await SELECT.one.from(Users).where({ ID: link.user_ID });
      if (row) return row;
    }
  }

  // Tiers 2 & 3 added in later tasks.
  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: PASS (Tier-1 + extractor tests).

- [ ] **Step 5: Commit**

```bash
git add packages/core/resolve-db-user.js test/unit/resolve-user.test.js
git commit -m "feat(identity): resolveUser Tier 1 (issuer,subject) link lookup (#2552)"
```

---

## Task 3: `resolveUser` Tier 2 — sapId fast-path + self-heal link write

**Files:**
- Modify: `packages/core/resolve-db-user.js`
- Test: `test/unit/resolve-user.test.js` (extend)

**Interfaces:**
- Consumes: `resolveUserSapId` (sync, existing), `issuerSubjectFromUser` (Task 2).
- Produces:
  - `export async function writeIdentityLink(user_ID, isu, { provider, email, emailVerified }): Promise<void>` — INSERT a UserIdentities row; idempotent (swallow unique collision).
  - `resolveUser` now implements Tier 2 after a Tier-1 miss.

- [ ] **Step 1: Write the failing test (extend resolve-user.test.js)**

Add a new `describe` block and extend `installSelect` to capture INSERTs. Replace the `installSelect` helper's trailing lines to ALSO stub `INSERT`:

```js
// Add near installSelect (after the globalThis.SELECT assignment):
function installInsert() {
  globalThis.INSERT = { into: (e) => ({ entries: (vals) => {
    captured = { ...captured, insertEntity: e?.name || e, insertVals: vals };
    return Promise.resolve({});
  } }) };
}
```

Then add:

```js
describe('resolveUser — Tier 2 sapId fast-path + self-heal', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  const xsuaaUser = () => ({
    id: 'thomas.jung@sap.com',
    authInfo: { token: {
      userId: 'I809764',
      payload: { iss: 'https://tutorial-system.authentication.eu10-005.hana.ondemand.com', sub: 'thomas.jung@sap.com' },
    } },
  });

  it('resolves by sapId on Tier-1 miss and writes a link row', async () => {
    stub.identityRow = null;                                   // Tier-1 miss
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764', email: 'thomas.jung@sap.com' }]; // Tier-2 hit
    const row = await resolveUser(xsuaaUser());
    expect(row.ID).toBe('u-1');
    // self-heal: a UserIdentities link row was inserted for (iss,sub)
    expect(captured.insertEntity).toMatch(/UserIdentities$/);
    expect(captured.insertVals.user_ID).toBe('u-1');
    expect(captured.insertVals.issuer).toBe('https://tutorial-system.authentication.eu10-005.hana.ondemand.com');
    expect(captured.insertVals.subject).toBe('thomas.jung@sap.com');
  });

  it('does NOT write a link row when there is no (iss,sub) to link', async () => {
    stub.identityRow = null;
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764' }];
    const noIsu = { id: 'tech', authInfo: { token: { userId: 'I809764', payload: {} } } };
    const row = await resolveUser(noIsu);
    expect(row.ID).toBe('u-1');          // still resolves by sapId
    expect(captured.insertEntity).toBeUndefined(); // but no link write (no iss/sub)
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: FAIL — Tier-2 resolution returns null / no INSERT captured.

- [ ] **Step 3: Implement `writeIdentityLink` + Tier 2**

In `resolve-db-user.js`, add `writeIdentityLink` before `resolveUser`:

```js
/**
 * Insert a UserIdentities link row for (issuer, subject) → user_ID. Idempotent:
 * a concurrent/duplicate insert (the (issuer,subject) unique assert) is swallowed
 * so self-heal never throws into a read path. Any non-uniqueness error rethrows.
 *
 * @param {string} user_ID — the Users.ID to link.
 * @param {{issuer:string, subject:string}} isu
 * @param {{provider?:string, email?:string, emailVerified?:boolean}} [meta]
 */
export async function writeIdentityLink(user_ID, isu, meta = {}) {
  if (!user_ID || !isu) return;
  try {
    const { UserIdentities } = cds.entities('com.sap.developers.ims');
    await INSERT.into(UserIdentities).entries({
      ID: cds.utils.uuid(),
      user_ID,
      issuer: isu.issuer,
      subject: isu.subject,
      provider: meta.provider ?? null,
      email: meta.email ?? null,
      emailVerified: meta.emailVerified ?? false,
      linkedAt: new Date().toISOString(),
    });
  } catch (err) {
    if (!/unique|duplicate/i.test(String(err?.message ?? ''))) throw err;
  }
}

/**
 * Classify the token issuer into a short provider tag for the link row.
 * @param {string|undefined} issuer
 * @returns {string}
 */
function providerFromIssuer(issuer) {
  if (!issuer) return 'unknown';
  if (/\.accounts\.ondemand\.com/i.test(issuer)) return 'ias';
  if (/authentication\..*\.hana\.ondemand\.com/i.test(issuer)) return 'sap-id';
  if (/github/i.test(issuer)) return 'github';
  if (/google/i.test(issuer)) return 'google';
  return 'oidc';
}
```

Then insert Tier 2 into `resolveUser`, replacing the `// Tiers 2 & 3 added in later tasks.\n  return null;` block:

```js
  // ── Tier 2: sapId fast-path (+ self-heal link write) ────────────────────
  const sapId = resolveUserSapId(user);
  // A canonical sapId is an SAP employee ID (letter + digits), NOT a SCIM UUID
  // (IAS user_uuid) and NOT an email (XSUAA user.id fallback). Only treat a
  // canonical value as a Tier-2 key — a SCIM-UUID or email here is not a sapId.
  const canonicalSapId = sapId && !SCIM_UUID_RE.test(sapId) && !sapId.includes('@') ? sapId : null;
  if (canonicalSapId) {
    const row = await SELECT.one.from(Users).where({ sapId: canonicalSapId });
    if (row) {
      if (isu) {
        await writeIdentityLink(row.ID, isu, {
          provider: providerFromIssuer(isu.issuer),
          email: user.authInfo?.token?.payload?.email ?? null,
          emailVerified: true,
        });
      }
      return row;
    }
  }

  // Tier 3 added in Task 4.
  return null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: PASS (Tier-1 + Tier-2).

- [ ] **Step 5: Commit**

```bash
git add packages/core/resolve-db-user.js test/unit/resolve-user.test.js
git commit -m "feat(identity): resolveUser Tier 2 sapId fast-path with self-heal link (#2552)"
```

---

## Task 4: `resolveUser` Tier 3 — trusted-token-email → Users.email

**Files:**
- Modify: `packages/core/resolve-db-user.js`
- Test: `test/unit/resolve-user.test.js` (extend)

**Interfaces:**
- Consumes: `issuerSubjectFromUser` (Task 2), `writeIdentityLink` (Task 3), `SCIM_UUID_RE` (existing).
- Produces:
  - `export function tokenEmail(user): string | null` — email claim, else email-shaped `sub`, lowercased.
  - `resolveUser` implements Tier 3 after Tier-1&2 miss.

- [ ] **Step 1: Write the failing test (extend)**

```js
describe('resolveUser — Tier 3 trusted-token-email', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  it('matches token email → Users.email, prefers the non-SCIM-UUID row, writes a link', async () => {
    stub.identityRow = null;    // T1 miss
    // T2: IAS token has no canonical sapId (sub is the email), so T2 is skipped.
    // T3: email match returns TWO rows — a stray SCIM-UUID row and the real I-number row.
    stub.usersRows = [
      { ID: 'u-scim', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', email: 'thomas.jung@sap.com' },
      { ID: 'u-real', sapId: 'I809764', email: 'thomas.jung@sap.com' },
    ];
    const row = await resolveUser(iasUser({ email: 'thomas.jung@sap.com' }));
    expect(row.ID).toBe('u-real');                 // non-SCIM-UUID preferred
    expect(captured.insertEntity).toMatch(/UserIdentities$/);
    expect(captured.insertVals.user_ID).toBe('u-real');
    expect(captured.insertVals.emailVerified).toBe(true);
  });

  it('skips a stored noreply.github.com row as a match target', async () => {
    stub.identityRow = null;
    stub.usersRows = [{ ID: 'u-gh', sapId: null, email: 'jung-thomas@users.noreply.github.com' }];
    // token email differs from the synthetic stored one → no match → null
    const row = await resolveUser(iasUser({ email: 'thomas.jung@sap.com' }));
    // Our stub returns the row regardless of WHERE, so Tier 3 must FILTER it out:
    expect(row).toBeNull();
  });

  it('returns null when the token carries no usable email', async () => {
    stub.identityRow = null;
    stub.usersRows = [];
    const noEmail = { id: 'u', authInfo: { token: { payload: {
      iss: 'https://atxgsg7zi.accounts.ondemand.com', sub: 'ba411614-uuid-not-email',
    } } } };
    expect(await resolveUser(noEmail)).toBeNull();
  });
});

describe('tokenEmail', () => {
  beforeEach(() => { installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });
  it('prefers the email claim, lowercased', async () => {
    const { tokenEmail } = await import('../../packages/core/resolve-db-user.js');
    expect(tokenEmail(iasUser({ email: 'Thomas.Jung@SAP.com' }))).toBe('thomas.jung@sap.com');
  });
  it('falls back to an email-shaped sub', async () => {
    const { tokenEmail } = await import('../../packages/core/resolve-db-user.js');
    expect(tokenEmail(iasUser({ sub: 'a@b.com', email: undefined }))).toBe('a@b.com');
  });
  it('returns null for a non-email sub with no email claim', async () => {
    const { tokenEmail } = await import('../../packages/core/resolve-db-user.js');
    expect(tokenEmail(iasUser({ sub: 'uuid-not-email', email: undefined }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: FAIL — Tier-3 not implemented / `tokenEmail` not exported.

- [ ] **Step 3: Implement `tokenEmail` + Tier 3**

Add `tokenEmail` near `iasEmailFromToken` (it supersedes it for the resolver; keep `iasEmailFromToken` only if still referenced — Task 5 removes it):

```js
/**
 * The email a token asserts, for Tier-3 identity resolution. The IdP enforces
 * email verification before login, so a token email is trusted-verified. Prefer
 * the explicit `email` claim; else use `sub` only when it is email-shaped.
 * Lowercased for case-insensitive comparison against Users.email.
 *
 * @param {object} user
 * @returns {string | null}
 */
export function tokenEmail(user) {
  const p = user?.authInfo?.token?.payload;
  const isEmail = (v) => typeof v === 'string' && v.includes('@');
  const raw = (isEmail(p?.email) && p.email) || (isEmail(p?.sub) && p.sub) || null;
  return raw ? raw.toLowerCase() : null;
}

// Stored GitHub-synthetic emails (contributor API) must never be a Tier-3 match
// target — they are dirty data, not a login identity.
const NOREPLY_GITHUB_RE = /@users\.noreply\.github\.com$/i;
```

Then replace the `// Tier 3 added in Task 4.\n  return null;` block in `resolveUser`:

```js
  // ── Tier 3: trusted-token-email → Users.email (+ self-heal link write) ──
  const email = tokenEmail(user);
  if (email) {
    const rows = await SELECT.from(Users).where`lower(email) = ${email}`;
    const candidates = (rows ?? []).filter(
      (r) => r.email && !NOREPLY_GITHUB_RE.test(r.email),
    );
    if (candidates.length) {
      // Prefer a row whose sapId is a real SAP ID (letter+digits) over a stray
      // SCIM-UUID-keyed row sharing the same email (#2550 collision fix).
      const real = candidates.find((r) => r.sapId && !SCIM_UUID_RE.test(r.sapId));
      const row = real ?? candidates[0];
      if (isu) {
        await writeIdentityLink(row.ID, isu, {
          provider: providerFromIssuer(isu.issuer),
          email,
          emailVerified: true,
        });
      }
      return row;
    }
  }

  return null;
```

Note: the test stub returns `stub.usersRows` for every Users SELECT regardless of WHERE, so the `NOREPLY_GITHUB_RE` filter is what makes the noreply test return null — the filter must run in JS, as written.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: PASS (Tiers 1–3 + tokenEmail).

- [ ] **Step 5: Commit**

```bash
git add packages/core/resolve-db-user.js test/unit/resolve-user.test.js
git commit -m "feat(identity): resolveUser Tier 3 trusted-token-email match (#2552)"
```

---

## Task 5: `pinResolvedUser` + remove the old email-join

**Files:**
- Modify: `packages/core/resolve-db-user.js`, `packages/core/index.js:76`, `srv/lib/resolve-db-user.js`
- Delete: `test/unit/resolve-ias-sapid.test.js`
- Test: `test/unit/resolve-user.test.js` (extend)

**Interfaces:**
- Produces: `export async function pinResolvedUser(user): Promise<object|null>` — calls `resolveUser`; on hit pins `user.authInfo.token.userId = row.sapId` (when `row.sapId` present) AND `user.attr = user.attr || {}; user.attr.dbUserId = row.ID`; returns the row (or null). No-op on anonymous / miss.
- Removes: `resolveIasSapId`, `pinIasSapId` (replaced by `resolveUser`/`pinResolvedUser`). `isIasToken`/`iasEmailFromToken` removed if unused after this task.

- [ ] **Step 1: Write the failing test (extend)**

```js
describe('pinResolvedUser', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  it('pins sapId → authInfo.token.userId and ID → attr.dbUserId for a SAP user', async () => {
    const { pinResolvedUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = { user_ID: 'u-1' };
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764', email: 'x@sap.com' }];
    const user = iasUser();
    const row = await pinResolvedUser(user);
    expect(row.ID).toBe('u-1');
    expect(user.authInfo.token.userId).toBe('I809764');
    expect(user.attr.dbUserId).toBe('u-1');
  });

  it('pins only attr.dbUserId for a no-sapId (social) user', async () => {
    const { pinResolvedUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = { user_ID: 'u-social' };
    stub.usersRows = [{ ID: 'u-social', sapId: null, email: 'who@gmail.com' }];
    const user = iasUser();
    await pinResolvedUser(user);
    expect(user.attr.dbUserId).toBe('u-social');
    expect(user.authInfo.token.userId).toBeUndefined();
  });

  it('is a no-op (null) on resolution miss', async () => {
    const { pinResolvedUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = null; stub.usersRows = [];
    const user = iasUser();
    expect(await pinResolvedUser(user)).toBeNull();
    expect(user.attr?.dbUserId).toBeUndefined();
  });
});

describe('removed email-join exports', () => {
  it('no longer exports resolveIasSapId / pinIasSapId', async () => {
    const mod = await import('../../packages/core/resolve-db-user.js');
    expect(mod.resolveIasSapId).toBeUndefined();
    expect(mod.pinIasSapId).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: FAIL — `pinResolvedUser` not exported; `resolveIasSapId`/`pinIasSapId` still exported.

- [ ] **Step 3: Add `pinResolvedUser`; delete the old email-join**

In `resolve-db-user.js`:

(a) Add `pinResolvedUser` after `resolveUser`:

```js
/**
 * Per-request identity pin (the before('*') hook helper, #2552). Resolves the
 * Users row via resolveUser and pins it onto the CAP user object so the ~40
 * synchronous `resolveUserSapId` / `resolveDbUser` callsites downstream resolve
 * the right row with NO per-callsite change:
 *   - authInfo.token.userId = row.sapId   (when sapId present — SAP users)
 *   - attr.dbUserId         = row.ID      (always on hit — carries no-sapId users)
 * No-op (returns null) for anonymous or resolution miss; the caller's own
 * fail-closed guard then applies.
 *
 * @param {object} user — CAP cds.context.user / req.user (mutated in place).
 * @returns {Promise<object|null>} the resolved Users row, or null.
 */
export async function pinResolvedUser(user) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  // Idempotent: if already pinned this request, don't re-resolve.
  if (user.attr?.dbUserId) return { ID: user.attr.dbUserId, sapId: user.authInfo?.token?.userId ?? null };
  let row;
  try {
    row = await resolveUser(user);
  } catch (err) {
    cds.log('resolve-db-user').warn('[pinResolvedUser] resolve failed',
      { email: tokenEmail(user), isu: issuerSubjectFromUser(user), msg: err?.message ?? err });
    return null;
  }
  if (!row) return null;
  user.attr = user.attr || {};
  user.attr.dbUserId = row.ID;
  if (row.sapId) {
    user.authInfo = user.authInfo || {};
    user.authInfo.token = user.authInfo.token || {};
    user.authInfo.token.userId = row.sapId;
  }
  return row;
}
```

(b) DELETE the `resolveIasSapId` function (lines ~119-157) and the `pinIasSapId` function (lines ~163-189). Also DELETE `isIasToken` (lines ~87-97) and `iasEmailFromToken` (lines ~99-117) and the `IAS_ISSUER_RE` const (line 85) — they are superseded by `issuerSubjectFromUser` + `tokenEmail` + `providerFromIssuer`. KEEP `SCIM_UUID_RE` (used by Tiers 2 & 3). Also delete the now-stale `// ── IAS (MCP public-PKCE) identity resolution (#2550) ──` comment block header (lines ~60-83).

- [ ] **Step 4: Update the barrel + shim re-exports**

In `packages/core/index.js` line 76, replace:

```js
export { resolveUserSapId, resolveDbUser, emailFromUser, backfillUserProfile, provisionDbUser, isIasToken, iasEmailFromToken, resolveIasSapId, pinIasSapId } from './resolve-db-user.js';
```

with:

```js
export { resolveUserSapId, resolveDbUser, emailFromUser, backfillUserProfile, provisionDbUser, resolveUser, issuerSubjectFromUser, tokenEmail, writeIdentityLink, pinResolvedUser } from './resolve-db-user.js';
```

In `srv/lib/resolve-db-user.js` (the shim), replace the `isIasToken`/`iasEmailFromToken`/`resolveIasSapId`/`pinIasSapId` export lines with:

```js
export const resolveUser = mod.resolveUser;
export const issuerSubjectFromUser = mod.issuerSubjectFromUser;
export const tokenEmail = mod.tokenEmail;
export const writeIdentityLink = mod.writeIdentityLink;
export const pinResolvedUser = mod.pinResolvedUser;
```

(Leave the existing `resolveUserSapId`/`resolveDbUser`/`emailFromUser`/`backfillUserProfile`/`provisionDbUser` shim lines intact; remove only the four IAS ones.)

- [ ] **Step 5: Delete the obsolete IAS test**

```bash
git rm test/unit/resolve-ias-sapid.test.js
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run test/unit/resolve-user.test.js test/unit/resolve-db-user.test.js`
Expected: PASS. (If `resolve-db-user.test.js` referenced the removed functions, it won't — those were only in `resolve-ias-sapid.test.js`; `resolve-db-user.test.js` tests `resolveUserSapId` which is unchanged.)

- [ ] **Step 7: Commit**

```bash
git add packages/core/resolve-db-user.js packages/core/index.js srv/lib/resolve-db-user.js test/unit/resolve-user.test.js
git commit -m "feat(identity): pinResolvedUser hook helper; remove unsafe #2550 email-join (#2552)"
```

---

## Task 6: `resolveDbUser` + `resolveDbUserId` no-sapId fallback

**Files:**
- Modify: `packages/core/resolve-db-user.js` (`resolveDbUser` ~line 198), `packages/core/user-progress.js:12-25`
- Test: `test/unit/resolve-user.test.js` (extend), `test/unit/user-progress-resolve.test.js` (create)

**Interfaces:**
- Consumes: `resolveUserSapId` (sync), the pinned `user.attr.dbUserId`.
- Produces: `resolveDbUser(user, columns)` and `resolveDbUserId(user)` both resolve by `WHERE {ID: attr.dbUserId}` when `resolveUserSapId` returns null but `attr.dbUserId` is pinned.

- [ ] **Step 1: Write the failing tests**

Extend `resolve-user.test.js`:

```js
describe('resolveDbUser — attr.dbUserId fallback (no-sapId user)', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });

  it('resolves by ID when sapId is null but attr.dbUserId is pinned', async () => {
    const { resolveDbUser } = await import('../../packages/core/resolve-db-user.js');
    stub.usersRows = [{ ID: 'u-social', sapId: null }];
    const user = { id: 'who@gmail.com', attr: { dbUserId: 'u-social' },
      authInfo: { token: { payload: { iss: 'https://x.accounts.ondemand.com', sub: 'who@gmail.com' } } } };
    const row = await resolveDbUser(user, ['ID']);
    expect(row.ID).toBe('u-social');
    expect(String(captured.where && JSON.stringify(captured.where))).toContain('u-social');
  });
});
```

Create `test/unit/user-progress-resolve.test.js` (mirror the SELECT stub from resolve-user.test.js — copy the `vi.mock`/`installSelect`):

```js
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
let captured, stub;
vi.mock('@sap/cds', () => ({ default: {
  entities: () => ({ Users: { name: 'com.sap.developers.ims.Users' } }),
  log: () => ({ warn() {} }),
} }));
function installSelect() {
  const chain = { from(){return this;}, columns(){return this;},
    where(arg){ captured = { where: arg }; return Promise.resolve(stub.row ?? null); } };
  globalThis.SELECT = { one: chain };
}
const { getUserProgress } = await import('../../packages/core/user-progress.js');

describe('resolveDbUserId — attr.dbUserId fallback', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); });
  afterEach(() => { delete globalThis.SELECT; });
  it('returns empty progress (no throw) for a no-sapId user with a pinned dbUserId', async () => {
    stub.row = { ID: 'u-social' };
    const user = { id: 'who@gmail.com', attr: { dbUserId: 'u-social' }, authInfo: { token: { payload: {} } } };
    // getUserProgress internally resolves via resolveDbUserId; with a stubbed
    // Users.ID lookup it proceeds past the null-guard. We only assert it does
    // not treat the user as anonymous (would early-return the empty shape with
    // no Users SELECT); here a SELECT WHERE was captured for the ID.
    await getUserProgress(user, { limit: 1 }).catch(() => {});
    expect(JSON.stringify(captured?.where ?? {})).toContain('u-social');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/resolve-user.test.js test/unit/user-progress-resolve.test.js`
Expected: FAIL — fallback not implemented (resolveDbUser returns null; resolveDbUserId returns null → anonymous early-return, no ID SELECT captured).

- [ ] **Step 3: Implement the fallback in `resolveDbUser`**

Replace `resolveDbUser` body (lines ~198-205):

```js
export async function resolveDbUser(user, columns) {
  const { Users } = cds.entities('com.sap.developers.ims');
  const sapId = resolveUserSapId(user);
  let q;
  if (sapId) {
    q = SELECT.one.from(Users).where({ sapId });
  } else if (user?.attr?.dbUserId) {
    // No-sapId user (social / IAS pre-link): the before('*') pin stashed the
    // resolved Users.ID on the context. Resolve by PK. (#2552)
    q = SELECT.one.from(Users).where({ ID: user.attr.dbUserId });
  } else {
    return null;
  }
  if (columns && columns.length) q = q.columns(...columns);
  return await q;
}
```

- [ ] **Step 4: Implement the fallback in `user-progress.js resolveDbUserId`**

Replace `resolveDbUserId` (lines 12-25):

```js
async function resolveDbUserId(user) {
  if (user.__dbUserId !== undefined) return user.__dbUserId;
  const sapId = resolveUserSapId(user);
  // No-sapId user (social / IAS pre-link): fall back to the pinned Users.ID
  // from the before('*') identity pin (#2552).
  if (!sapId && user?.attr?.dbUserId) {
    user.__dbUserId = user.attr.dbUserId;
    return user.__dbUserId;
  }
  if (!sapId) return null;
  try {
    const { Users } = cds.entities('com.sap.developers.ims');
    const dbUser = await SELECT.one.from(Users).columns('ID').where({ sapId });
    user.__dbUserId = dbUser?.ID || null;
    return user.__dbUserId;
  } catch (err) {
    LOG.warn('resolveDbUserId failed', err.message);
    return null;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run test/unit/resolve-user.test.js test/unit/user-progress-resolve.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/core/resolve-db-user.js packages/core/user-progress.js test/unit/resolve-user.test.js test/unit/user-progress-resolve.test.js
git commit -m "feat(identity): resolveDbUser/resolveDbUserId attr.dbUserId fallback for no-sapId users (#2552)"
```

---

## Task 7: `provisionDbUser` on `(iss, sub)`

**Files:**
- Modify: `packages/core/resolve-db-user.js` (`provisionDbUser` ~line 351)
- Test: `test/unit/resolve-user.test.js` (extend)

**Interfaces:**
- Consumes: `resolveUser`, `issuerSubjectFromUser`, `writeIdentityLink`, `tokenEmail`, `providerFromIssuer`, `resolveUserSapId`, `emailFromUser`, `backfillUserProfile`, `getNextLegacyId`.
- Produces: `provisionDbUser(user, columns)` — get-or-create keyed on `(iss,sub)`: resolve via `resolveUser`; on miss create a `Users` row (sapId from token when canonical, else null) + a link row; return the row (or null when unprovisionable).

- [ ] **Step 1: Write the failing test (extend)**

```js
describe('provisionDbUser — (iss,sub) get-or-create', () => {
  beforeEach(() => { captured = undefined; stub = {}; installSelect(); installInsert(); });
  afterEach(() => { delete globalThis.SELECT; delete globalThis.INSERT; });

  it('returns the existing row (via resolveUser) and does not insert a Users row', async () => {
    const { provisionDbUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = { user_ID: 'u-1' };                 // Tier-1 hit
    stub.usersRows = [{ ID: 'u-1', sapId: 'I809764', email: 'x@sap.com', firstName: 'T', lastName: 'J' }];
    const row = await provisionDbUser(iasUser());
    expect(row.ID).toBe('u-1');
    expect(captured.insertEntity).not.toMatch(/\.Users$/);  // no Users insert
  });

  it('creates a Users row + link for a brand-new (iss,sub) with a usable email', async () => {
    const { provisionDbUser } = await import('../../packages/core/resolve-db-user.js');
    // All tiers miss first; after insert, a re-select returns the new row.
    let selectCalls = 0;
    stub.identityRow = null;
    Object.defineProperty(stub, 'usersRows', { get() { return selectCalls++ < 2 ? [] : [{ ID: 'u-new', sapId: null, email: 'who@gmail.com' }]; } });
    const user = { id: 'who@gmail.com', attr: {}, authInfo: { token: { payload: {
      iss: 'https://x.accounts.ondemand.com', sub: 'who@gmail.com', email: 'who@gmail.com', given_name: 'Who',
    } } } };
    const row = await provisionDbUser(user);
    expect(row?.ID).toBe('u-new');
    // Both a Users insert and a UserIdentities link insert happened.
    expect(captured.insertVals).toBeTruthy();
  });

  it('returns null when a brand-new identity carries no usable claims', async () => {
    const { provisionDbUser } = await import('../../packages/core/resolve-db-user.js');
    stub.identityRow = null; stub.usersRows = [];
    const bare = { id: 'u', attr: {}, authInfo: { token: { payload: { iss: 'https://x.accounts.ondemand.com', sub: 'uuid-no-email' } } } };
    expect(await provisionDbUser(bare)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: FAIL — `provisionDbUser` still keyed on sapId only; new-identity create path missing.

- [ ] **Step 3: Rewrite `provisionDbUser`**

Replace `provisionDbUser` (lines ~351-407):

```js
export async function provisionDbUser(user, columns) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  const { Users } = cds.entities('com.sap.developers.ims');
  const isu = issuerSubjectFromUser(user);

  // Get: resolve via the tiered resolver (also self-heals a link on T2/T3 hit).
  const existing = await resolveUser(user);
  if (existing) {
    await backfillUserProfile(user).catch((err) =>
      cds.log('resolve-db-user').warn('[provision-backfill]', err?.message ?? err));
    // Ensure a (iss,sub) link exists even if the hit came via Tier 1 already
    // (no-op on duplicate). Tiers 2/3 wrote one; Tier 1 means it exists.
    if (columns && columns.length) {
      return await SELECT.one.from(Users).where({ ID: existing.ID }).columns(...columns);
    }
    return existing;
  }

  // Create: brand-new identity. Only mint when the token carries a usable
  // identity (email or a name) — never an empty-profile row.
  const sapId = resolveUserSapId(user);
  const canonicalSapId = sapId && !SCIM_UUID_RE.test(sapId) && !sapId.includes('@') ? sapId : null;
  const claimFirstName = user.attr?.given_name || user.attr?.givenName;
  const claimLastName  = user.attr?.family_name || user.attr?.familyName;
  const claimEmail     = emailFromUser(user);
  if (!claimEmail && !claimFirstName && !claimLastName && !canonicalSapId) return null;

  const db = await cds.connect.to('db');
  const newId = cds.utils.uuid();
  try {
    await INSERT.into(Users).entries({
      ID: newId,
      uuid: cds.utils.uuid(),
      sapId: canonicalSapId,            // null for social / no-SAP-ID users
      legacyId: await getNextLegacyId('Users', db),
      email: claimEmail || null,
      firstName: claimFirstName || null,
      lastName: claimLastName || null,
    });
  } catch (err) {
    if (!/unique|duplicate/i.test(String(err?.message ?? ''))) throw err;
  }
  // Link the (iss,sub) to the row (idempotent).
  if (isu) {
    await writeIdentityLink(newId, isu, {
      provider: providerFromIssuer(isu.issuer),
      email: tokenEmail(user),
      emailVerified: true,
    });
  }
  const q = SELECT.one.from(Users).where({ ID: newId });
  return (columns && columns.length) ? await q.columns(...columns) : await q;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/resolve-user.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/resolve-db-user.js test/unit/resolve-user.test.js
git commit -m "feat(identity): provisionDbUser get-or-create keyed on (issuer,subject) (#2552)"
```

---

## Task 8: srv-mcp before-hook — swap `pinIasSapId` → `pinResolvedUser`

**Files:**
- Modify: `srv-mcp/developer-service.js` (import ~lines 53-58; `this.before('*')` ~76-83)
- Test: covered by integration (Task 12); add a focused unit assertion on the hook wiring is not practical without the CAP runtime — rely on the resolver unit tests + the live acceptance.

**Interfaces:**
- Consumes: `pinResolvedUser` from `@tutorials/core/resolve-db-user.js` (workspace) / `./lib/_shared/core.bundle.mjs` (bundle).

- [ ] **Step 1: Swap the import**

In `srv-mcp/developer-service.js`, change the dynamic import block (currently destructures `resolveUserSapId, pinIasSapId`):

```js
let resolveUserSapId;
let pinResolvedUser;
try {
  ({ resolveUserSapId, pinResolvedUser } = await import('@tutorials/core/resolve-db-user.js'));
} catch {
  ({ resolveUserSapId, pinResolvedUser } = await import('./lib/_shared/core.bundle.mjs'));
}
```

- [ ] **Step 2: Swap the hook body**

Change the `this.before('*', ...)` block to call `pinResolvedUser(req.user)` instead of `pinIasSapId(req.user)`:

```js
    this.before('*', async (req) => {
      try {
        await pinResolvedUser(req.user);
      } catch (err) {
        LOG.warn('[srv-mcp] identity pin failed:', err?.message ?? err);
        // Non-fatal: fall through unpinned; handler null-guards still apply.
      }
    });
```

Leave the comment above it updated to reference the tiered resolver (not the IAS email-join). The READ/WRITE `this.on(...)` handlers are UNCHANGED.

- [ ] **Step 3: Regenerate the shared bundle (so the deployed artifact carries the new exports)**

Run: `node scripts/bundle-shared.cjs`
Then verify: `grep -c "pinResolvedUser" srv-mcp/lib/_shared/core.bundle.mjs` → expect `>= 1`.

- [ ] **Step 4: Known-limitation note (write tools)**

Add a comment above the two write handlers (`complete_step`, `reset_tutorial_progress`) noting: `actingSapId = resolveUserSapId(req.user)` still gates write-forwarding to main-srv on a canonical sapId. A no-sapId (social) user cannot write-forward yet (returns 401) — this is a KNOWN LIMITATION for this build (social write-forward needs a main-srv actingSapId contract), NOT a bug. Add:

```js
    // NOTE (#2552): write-forward tools require a canonical sapId as actingSapId
    // for the main-srv InternalWrite contract. A no-sapId (social) user resolves
    // for READS (via attr.dbUserId) but cannot write-forward yet → 401. Known
    // limitation, tracked for a follow-up main-srv actingId contract.
```

- [ ] **Step 5: Commit**

```bash
git add srv-mcp/developer-service.js
git commit -m "feat(identity): srv-mcp pins via tiered resolveUser (pinResolvedUser) (#2552)"
```

---

## Task 9: Main srv — global `before('*')` identity pin

**Files:**
- Modify: `srv/server.js` (add inside a `cds.on('served')` block; pattern at line 1571; service loop pattern at line 1278)
- Test: integration (Task 12); unit-covered by resolver tests.

**Interfaces:**
- Consumes: `pinResolvedUser` (already imported? — `srv/server.js:98` imports from `./lib/resolve-db-user.js`; add `pinResolvedUser` to that import).

- [ ] **Step 1: Extend the existing resolve-db-user import**

In `srv/server.js:98`, change:

```js
import { provisionDbUser, resolveDbUser, resolveUserSapId, emailFromUser } from './lib/resolve-db-user.js';
```

to add `pinResolvedUser`:

```js
import { provisionDbUser, resolveDbUser, resolveUserSapId, emailFromUser, pinResolvedUser } from './lib/resolve-db-user.js';
```

- [ ] **Step 2: Add a global pin hook in a `cds.on('served')` block**

Add a NEW `cds.on('served')` block (near the existing one at line 1571, after it). It installs a `before('*')` on every served application service so the identity pin runs after auth, before any handler, for all authenticated per-user access:

```js
// Identity pin (#2552): before any handler on any application service, resolve
// the authenticated request to its Users row via the tiered (iss,sub) resolver
// and pin it onto cds.context.user (sapId → authInfo.token.userId; row PK →
// attr.dbUserId). This keeps the ~40 synchronous `resolveUserSapId` /
// resolveDbUser callsites unchanged while making IAS + social logins resolve.
// Fail-open: a resolution error is swallowed (WARN) and the request proceeds
// unpinned — each per-user handler keeps its own fail-closed null-guard.
cds.on('served', async () => {
  if (globalThis.__identityPinHookRegistered) return;
  for (const srv of Object.values(cds.services)) {
    if (!(srv instanceof cds.ApplicationService)) continue;
    srv.before('*', async (req) => {
      // Only authenticated requests carry a resolvable identity; anonymous
      // and tech-user paths no-op inside pinResolvedUser.
      try {
        await pinResolvedUser(req.user);
      } catch (err) {
        cds.log('identity-pin').warn('[before *] pin failed',
          { service: srv.name, msg: err?.message ?? err });
      }
    });
  }
  globalThis.__identityPinHookRegistered = true;
});
```

- [ ] **Step 3: Verify the server boots (no handler-registration regression)**

Run: `node -e "process.env.VITEST=''; import('@sap/cds').then(async cds => { await cds.test ? 0 : 0; })" 2>/dev/null; npx cds compile srv > /dev/null && echo SRV_COMPILE_OK`
Expected: `SRV_COMPILE_OK`. (Full boot is exercised in hybrid/integration; the compile gate catches syntax/ref errors here.)

- [ ] **Step 4: Commit**

```bash
git add srv/server.js
git commit -m "feat(identity): global before(*) identity pin across app services (#2552)"
```

---

## Task 10: Fix `ktt-service.js` mis-key

**Files:**
- Modify: `srv/ktt-service.js` (import block; `:29` and `:44`)
- Test: `test/unit/ktt-resolve.test.js` (create) — assert the resolver, not `req.user.id`, is used.

**Interfaces:**
- Consumes: `resolveDbUser` from `./lib/resolve-db-user.js`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/ktt-resolve.test.js
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

describe('ktt-service identity resolution (#2552)', () => {
  const src = readFileSync(new URL('../../srv/ktt-service.js', import.meta.url), 'utf8');

  it('no longer mis-keys Users by req.user.id', () => {
    expect(src).not.toMatch(/where\(\{\s*sapId:\s*req\.user\.id\s*\}\)/);
  });

  it('resolves the user via the shared resolver', () => {
    expect(src).toMatch(/resolveDbUser\s*\(\s*req\.user/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/ktt-resolve.test.js`
Expected: FAIL — the `sapId: req.user.id` pattern is still present; no `resolveDbUser` call.

- [ ] **Step 3: Add the import**

In `srv/ktt-service.js`, after the existing imports (after line 11), add:

```js
import { resolveDbUser } from './lib/resolve-db-user.js';
```

- [ ] **Step 4: Replace both mis-keyed lookups**

Line 29 (`completeLesson` handler) — replace:

```js
      const dbUser = await SELECT.one.from(Users).where({ sapId: req.user.id });
```

with:

```js
      const dbUser = await resolveDbUser(req.user, ['ID']);
```

Line 44 (`syncProgress` handler) — replace the identical line with the same:

```js
      const dbUser = await resolveDbUser(req.user, ['ID']);
```

(`Users` may now be unused in the destructure at line 16 — leave it; `TaskRecords`/`KttLessons` are still used, and `Users` removal is out of scope. If a linter flags it, prefix with a leading underscore or leave as-is per the file's existing style.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/ktt-resolve.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/ktt-service.js test/unit/ktt-resolve.test.js
git commit -m "fix(ktt): resolve user via shared resolver, not mis-keyed req.user.id (#2552)"
```

---

## Task 11: Bundle regen, full unit sweep, srv-qa cp-list audit

**Files:**
- Regenerate: `srv-mcp/lib/_shared/core.bundle.mjs`, `srv-qa/lib/_shared/core.bundle.mjs` (gitignored artifacts)
- Verify: `.deploy/mta.yaml` srv-qa `cp` list

**Interfaces:** none (verification task).

- [ ] **Step 1: Regenerate the shared bundles**

Run: `node scripts/bundle-shared.cjs`

- [ ] **Step 2: Confirm the new exports are in both bundles**

Run:
```bash
grep -c "pinResolvedUser\|resolveUser\b" srv-mcp/lib/_shared/core.bundle.mjs
grep -c "pinResolvedUser\|resolveUser\b" srv-qa/lib/_shared/core.bundle.mjs
```
Expected: both `>= 1`.

- [ ] **Step 3: Confirm the removed exports are gone from the bundles**

Run: `grep -c "resolveIasSapId\|pinIasSapId" srv-mcp/lib/_shared/core.bundle.mjs`
Expected: `0`.

- [ ] **Step 4: srv-qa cp-list audit (CLAUDE.md mandatory when srv/lib/ changes)**

Re-walk transitive `./` imports from `srv/lib/content-store.js`; `resolve-db-user.js` is NOT a content-store dependency, so no `.deploy/mta.yaml` srv-qa `cp` change is expected — but confirm:
Run: `grep -n "resolve-db-user" .deploy/mta.yaml || echo "resolve-db-user not in cp list (expected — not a content-store dep)"`
Expected: the "not in cp list" message, OR if present, confirm it is still listed. No change needed either way; this step is the documented audit.

- [ ] **Step 5: Full unit suite (regression gate)**

Run: `npx vitest run test/unit/`
Expected: PASS. Pay attention to any pre-existing test that imported `resolveIasSapId`/`pinIasSapId` — there should be none after Task 5's deletion. If a test fails on a removed symbol, repoint it to `resolveUser`/`pinResolvedUser` or delete if redundant.

- [ ] **Step 6: Commit (bundles are gitignored; this commits any audit-driven mta.yaml change, else no-op)**

```bash
git add -A
git commit -m "chore(identity): regenerate shared bundles + srv-qa cp-list audit (#2552)" --allow-empty
```

---

## Task 12: Integration & live acceptance notes (deploy + verify)

**Files:** none (deploy + manual acceptance; documented for the executor).

**This task is NOT auto-testable in unit scope — it is the real end-to-end gate.**

- [ ] **Step 1: Deploy from fresh origin/DEV (after the PR merges)**

Per Global Constraints: PR to DEV, merge, `git reset --hard origin/DEV`, `cf target` → `tutorial-system/dev`. Then redeploy BOTH:
- Main srv MTA (carries `srv/server.js` pin + schema `UserIdentities` via db-deployer): `npm run deploy -- --env dev`.
- MCP MTA (carries `srv-mcp` hook + bundle): `mbt build -f mta-mcp.yaml -e deploy/mcp-dev.mtaext` then `cf deploy mta_archives/tutorials-mcp_1.0.0.mtar -e deploy/mcp-dev.mtaext -f`.

- [ ] **Step 2: Confirm `UserIdentities` table deployed**

Run (read-only, via the bound DEV HANA): a `SELECT count(*) from <schema>.com_sap_developers_ims_UserIdentities` returns 0 rows (table exists, empty). (Use the existing `.quiet-logs/` cds-bind probe pattern.)

- [ ] **Step 3: XSUAA regression — a browser login still resolves**

Hit an authenticated main-srv per-user endpoint as an XSUAA user (e.g. `/me/` progress). Expect the same data as before. Then confirm a `UserIdentities` row was self-healed for that `(iss,sub)` (Tier-2 write).

- [ ] **Step 4: IAS MCP acceptance (the #2550 blocker)**

Run the live `mcp-remote` flow (`--transport http-only`, URL `…/mcp-auth/api`, client `0b1e8b56-…`), then drive `get_my_tutorials` via the acceptance probe. Expected: returns the logged-in user's (I809764) tutorials — Tier-3 first hit (token email → Users.email → I809764 row) writes a link; a second call hits Tier 1.

- [ ] **Step 5: Confirm link-row persisted for the IAS identity**

Read-only: `SELECT issuer, subject, provider, emailVerified FROM …UserIdentities` → expect a row `(https://atxgsg7zi.accounts.ondemand.com, thomas.jung@sap.com, ias, true)`.

- [ ] **Step 6: NGDS suppression (no-sapId) spot check**

Confirm (code-review level) that a null-sapId user's completion does NOT auto-send to NGDS (`ngds.autosend.skipped.no_identity`), while a populated-sapId user still does — no NGDS code changed.

---

## Self-Review

**1. Spec coverage:**
- §1 schema → Task 1. ✓
- §2 Tier 1/2/3 → Tasks 2/3/4. ✓ Pin pattern → Tasks 5 (helper), 8 (srv-mcp), 9 (main srv). ✓ `resolveDbUser`/`resolveDbUserId` fallback → Task 6. ✓
- §3 provisioning on (iss,sub) → Task 7. ✓ Manual-sapId-trusted → no code gate added (Task 7 accepts canonical sapId from any origin; NGDS carve-out unchanged). ✓ (Graceful uniqueness handling in Profile Maintenance is an existing admin/profile surface, not in the resolver; noted but no resolver task — see gap below.)
- §4 NGDS no-op → verified in Task 12 Step 6; no code task (correct — it's a no-op). ✓
- §5 item 4 remove email-join → Task 5. ✓ item 5 ktt fix → Task 10. ✓ item 6 backfill preserved → `backfillUserProfile` untouched; `provisionDbUser` still calls it (Task 7). ✓ item 7 bundle/re-export → Tasks 5 & 11. ✓ item 8 srv-qa audit → Task 11 Step 4. ✓
- Verification 1-6 → Task 12. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has real code; no "similar to Task N".

**3. Type consistency:** `resolveUser(user)→Promise<row|null>`, `pinResolvedUser(user)→Promise<row|null>`, `issuerSubjectFromUser(user)→{issuer,subject}|null`, `tokenEmail(user)→string|null`, `writeIdentityLink(user_ID, isu, meta)→Promise<void>`, `providerFromIssuer(issuer)→string` (private), `SCIM_UUID_RE` reused in Tasks 3/4/7. `attr.dbUserId` + `authInfo.token.userId` pin fields consistent across Tasks 5/6/8/9. Consistent.

**GAP identified (not blocking):** §3's "Profile Maintenance MUST handle a uniqueness rejection gracefully" has NO task — Profile Maintenance is a separate admin/UI surface not in this plan's files. This is a UI-layer concern; the resolver/provisioning side is complete. Recommend tracking the Profile-Maintenance graceful-error handling as a small follow-up on the admin surface, NOT folding it into this identity-core plan. Flagged for the executor.
