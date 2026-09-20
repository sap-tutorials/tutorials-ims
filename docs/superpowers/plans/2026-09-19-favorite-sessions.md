# Favorite Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in user favorite one or more TechEd and Devtoberfest sessions, and add a "show only favorites" filter to both event families across their grid/schedule/calendar views.

**Architecture:** One user-scoped `SessionFavorites` entity with a `sourceType` discriminator (TechEd uses `slug`, Devtoberfest uses facade `ID`). Two `@requires:'authenticated-user'` ops on `DeveloperService` (`toggleSessionFavorite`, `getMyFavorites`), user always resolved from JWT in-handler (never a param — IDOR). A new shared island module (`favorites.ts`) + one shared feed fetch drive an auth-gated star toggle and a URL-deep-linked "favorites only" facet across the existing islands. Public pages, optional authed overlay, degrade to anonymous.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), CDS/CQL, Vue 3 + Vite islands, Vitest (island units), cds.test in-memory SQLite (service units).

**Spec:** `docs/superpowers/specs/2026-09-19-favorite-sessions-design.md`

## Global Constraints

- **User identity from JWT only.** Resolve via `resolveUserSapId(req.user)` → `SELECT Users where {sapId}` (or `provisionDbUser(req.user)` for get-or-create) INSIDE the handler. NEVER trust a client-supplied user id/param. (`srv/lib/resolve-db-user.js`, IDOR regression `test/hybrid/developer-progress-idor.test.js`.)
- **No raw SQL** — `cds.ql`/CQL only.
- **`@requires` guards** every user-scoped op.
- **Explicit UUID on INSERT** — `ID: cds.utils.uuid()` (bare `cds.db` INSERT skips the key-gen handler, #1614).
- **GDPR cascade is annotation-driven** — any new per-user entity MUST get a `@PersonalData` annotation in `db/audit-logging.cds` or it is silently missed by DSR erasure.
- **Namespace:** `com.sap.developers.ims` (`cds.entities('com.sap.developers.ims')`).
- **Shared island modules** import by relative path; a new file under `src/devtoberfest-schedule-shared/` needs NO `vite.config.ts` change (only new *islands* do).
- **Windows worktree:** subagent edits can flip LF→CRLF — verify `file <path>` after multi-edit and normalize before commit.

---

### Task 1: `SessionFavorites` entity + GDPR cascade annotation

**Files:**
- Modify: `db/schema.cds` (add entity near other user-scoped entities, after `UserLearningPreferences`)
- Modify: `db/audit-logging.cds` (add `@PersonalData` cascade annotation)
- Test: `test/unit/session-favorites-model.test.js` (create)

**Interfaces:**
- Produces: entity `com.sap.developers.ims.SessionFavorites` with elements `ID` (cuid key), `user` (Association to Users, FK `user_ID`), `sourceType` (String enum TECHED|DEVTOBERFEST), `sessionRef` (String 200), plus `managed` audit fields. Unique on `[user, sourceType, sessionRef]`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/session-favorites-model.test.js
const cds = require('@sap/cds');
const { expect } = cds.test('serve', '--project', '.', '--in-memory');

describe('SessionFavorites model', () => {
  it('persists a per-user favorite and enforces the unique triple', async () => {
    const db = await cds.connect.to('db');
    const { Users, SessionFavorites } = cds.entities('com.sap.developers.ims');
    const uid = cds.utils.uuid();
    await INSERT.into(Users).entries({ ID: uid, uuid: 't-fav-1', sapId: 't-fav-1', legacyId: 990001 });
    await INSERT.into(SessionFavorites).entries({
      ID: cds.utils.uuid(), user_ID: uid, sourceType: 'TECHED', sessionRef: 'ai-001',
    });
    const rows = await SELECT.from(SessionFavorites).where({ user_ID: uid });
    expect(rows.length).to.equal(1);
    expect(rows[0].sourceType).to.equal('TECHED');
    expect(rows[0].sessionRef).to.equal('ai-001');

    // duplicate triple must be rejected by @assert.unique
    let failed = false;
    try {
      await INSERT.into(SessionFavorites).entries({
        ID: cds.utils.uuid(), user_ID: uid, sourceType: 'TECHED', sessionRef: 'ai-001',
      });
    } catch { failed = true; }
    expect(failed).to.equal(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/session-favorites-model.test.js`
Expected: FAIL — entity `SessionFavorites` not found in model.

- [ ] **Step 3: Add the entity to `db/schema.cds`**

Add after the `UserLearningPreferences` entity (search for `entity UserLearningPreferences`):

```cds
// #2393 — per-user favorited event sessions. Discriminator + loose sessionRef
// because TechEd (owned TechEdSessions, keyed by slug) and Devtoberfest
// (cross-container facade external.devtoberfest.Session, key ID String(36))
// have different identity schemes — same pattern as TaskRecords' taskType+taskLegacyId.
// Favorite = a row exists; unfavorite = row deleted (no soft-delete/status).
entity SessionFavorites : cuid, managed {
  user       : Association to Users @mandatory;
  sourceType : String enum { TECHED; DEVTOBERFEST; } @mandatory;
  sessionRef : String(200) @mandatory;
}
@assert.unique.favorite: [user, sourceType, sessionRef];
```

> Note: `@assert.unique` annotates the entity; place the annotation line immediately above the entity or as `annotate ... with @assert.unique...`. Match the file's existing style — if other entities use inline `@assert.unique` above the `entity` keyword, do that; otherwise append an `annotate ims.SessionFavorites with @assert.unique.favorite: [user, sourceType, sessionRef];`.

- [ ] **Step 4: Add the GDPR cascade annotation to `db/audit-logging.cds`**

Mirror the `UserLearningPreferences` / `UserMetaData` `cascade: 'delete'` blocks:

```cds
annotate ims.SessionFavorites with @PersonalData: {
  EntitySemantics: 'DataSubjectDetails',
  cascade        : 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/session-favorites-model.test.js`
Expected: PASS.

- [ ] **Step 6: Verify line endings, commit**

```bash
file db/schema.cds db/audit-logging.cds test/unit/session-favorites-model.test.js
git add db/schema.cds db/audit-logging.cds test/unit/session-favorites-model.test.js
git commit -m "feat(#2393): SessionFavorites entity + GDPR cascade annotation"
```

---

### Task 2: `getMyFavorites` function on DeveloperService

**Files:**
- Modify: `srv/developer-service.cds` (declare function)
- Modify: `srv/developer-service.js` (register `this.on('getMyFavorites', ...)` inside `init()`, before `super.init()`)
- Test: `test/unit/session-favorites.test.js` (create)

**Interfaces:**
- Consumes: `SessionFavorites` entity (Task 1); `resolveUserSapId(req.user)` (`srv/lib/resolve-db-user.js`).
- Produces: `function getMyFavorites() returns array of { sourceType : String; sessionRef : String; }`. Anonymous → `[]`. Only the caller's rows.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/session-favorites.test.js
const cds = require('@sap/cds');
const project = cds.test('serve', '--project', '.', '--in-memory');
const { expect } = project;
const NS = 'com.sap.developers.ims';

const USER = { sapId: '__test__-fav-u1' };
const OTHER = { sapId: '__test__-fav-u2' };

async function seedUser(sapId) {
  const { Users } = cds.entities(NS);
  const existing = await SELECT.one.from(Users).where({ sapId });
  if (existing) return existing.ID;
  const ID = cds.utils.uuid();
  await INSERT.into(Users).entries({ ID, uuid: sapId, sapId, legacyId: Math.floor(Math.random() * 1e6) + 900000 });
  return ID;
}

describe('getMyFavorites', () => {
  beforeAll(async () => {
    const uid = await seedUser(USER.sapId);
    const oid = await seedUser(OTHER.sapId);
    const { SessionFavorites } = cds.entities(NS);
    await INSERT.into(SessionFavorites).entries([
      { ID: cds.utils.uuid(), user_ID: uid, sourceType: 'TECHED', sessionRef: 'ai-001' },
      { ID: cds.utils.uuid(), user_ID: uid, sourceType: 'DEVTOBERFEST', sessionRef: 'dtf-xyz' },
      { ID: cds.utils.uuid(), user_ID: oid, sourceType: 'TECHED', sessionRef: 'SECRET-OTHER' },
    ]);
  });

  it('returns only the calling user rows', async () => {
    const res = await project.get('/api/getMyFavorites()', { auth: { username: USER.sapId } });
    const rows = res.data.value ?? res.data;
    expect(rows.map((r) => r.sessionRef).sort()).to.eql(['ai-001', 'dtf-xyz']);
    expect(rows.some((r) => r.sessionRef === 'SECRET-OTHER')).to.equal(false);
  });

  it('returns [] for anonymous', async () => {
    const res = await project.get('/api/getMyFavorites()').catch((e) => e);
    // authenticated-user guard → 401 for truly anonymous; the island treats 401 as {favorites:[]}
    const status = res.response?.status ?? res.status;
    expect([200, 401]).to.include(status);
  });
});
```

> Note on the anonymous case: `getMyFavorites` is `@requires:'authenticated-user'`, so an unauthenticated OData GET returns **401**, and the island's `fetchMyFavorites` maps 401 → `{authenticated:false, favorites:[]}` (Task 5). That is the intended contract; the test asserts 401-or-200, and Task 5 tests the client-side degrade.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/unit/session-favorites.test.js`
Expected: FAIL — `getMyFavorites` not found (404) / unknown action.

- [ ] **Step 3: Declare the function in `srv/developer-service.cds`**

Add near `getMyCompletions` (search `function getMyCompletions`):

```cds
  // #2393 — the caller's favorited sessions (both event families). Anonymous is
  // blocked by the guard (401); the island degrades that to an empty overlay.
  @(requires: 'authenticated-user')
  function getMyFavorites() returns array of {
    sourceType : String;
    sessionRef : String;
  };
```

- [ ] **Step 4: Register the handler in `srv/developer-service.js`**

Inside `init()`, before `await super.init()`, add (uses the same `dbUsers` from the init destructure; add `SessionFavorites` to that destructure or re-call `cds.entities` locally):

```js
    this.on('getMyFavorites', async (req) => {
      const { SessionFavorites } = cds.entities('com.sap.developers.ims');
      const sapId = resolveUserSapId(req.user);
      const dbUser = sapId ? await SELECT.one.from(dbUsers).columns('ID').where({ sapId }) : null;
      if (!dbUser) return [];
      const rows = await SELECT.from(SessionFavorites)
        .columns('sourceType', 'sessionRef')
        .where({ user_ID: dbUser.ID });
      return rows.map((r) => ({ sourceType: r.sourceType, sessionRef: r.sessionRef }));
    });
```

- [ ] **Step 5: Run to verify it passes**

Run: `npx vitest run test/unit/session-favorites.test.js`
Expected: PASS.

- [ ] **Step 6: Verify line endings, commit**

```bash
file srv/developer-service.cds srv/developer-service.js test/unit/session-favorites.test.js
git add srv/developer-service.cds srv/developer-service.js test/unit/session-favorites.test.js
git commit -m "feat(#2393): getMyFavorites DeveloperService function"
```

---

### Task 3: `toggleSessionFavorite` action (insert/delete + validation)

**Files:**
- Modify: `srv/developer-service.cds` (declare action)
- Modify: `srv/developer-service.js` (register handler)
- Test: `test/unit/session-favorites.test.js` (extend from Task 2)

**Interfaces:**
- Consumes: `SessionFavorites`, `provisionDbUser(req.user, columns)` OR `resolveUserSapId` + `dbUsers` (`srv/lib/resolve-db-user.js`).
- Produces: `action toggleSessionFavorite(sourceType : String, sessionRef : String) returns { favorited : Boolean; }`. Idempotent toggle: absent → INSERT → `{favorited:true}`; present → DELETE → `{favorited:false}`. Bad `sourceType` or empty `sessionRef` → 400.

- [ ] **Step 1: Write the failing tests (append to `test/unit/session-favorites.test.js`)**

```js
describe('toggleSessionFavorite', () => {
  const S = { sapId: '__test__-fav-toggle' };
  it('toggles insert -> delete -> insert and returns the flag', async () => {
    await seedUser(S.sapId);
    const call = () => project.post('/api/toggleSessionFavorite',
      { sourceType: 'TECHED', sessionRef: 'toggle-me' }, { auth: { username: S.sapId } });

    const r1 = await call();
    expect(r1.data.favorited).to.equal(true);
    const r2 = await call();
    expect(r2.data.favorited).to.equal(false);
    const r3 = await call();
    expect(r3.data.favorited).to.equal(true);

    const { SessionFavorites, Users } = cds.entities(NS);
    const u = await SELECT.one.from(Users).where({ sapId: S.sapId });
    const rows = await SELECT.from(SessionFavorites).where({ user_ID: u.ID, sessionRef: 'toggle-me' });
    expect(rows.length).to.equal(1);
  });

  it('rejects a bad sourceType with 400', async () => {
    const res = await project.post('/api/toggleSessionFavorite',
      { sourceType: 'NOPE', sessionRef: 'x' }, { auth: { username: S.sapId } }).catch((e) => e);
    expect(res.response?.status ?? res.status).to.equal(400);
  });

  it('rejects an empty sessionRef with 400', async () => {
    const res = await project.post('/api/toggleSessionFavorite',
      { sourceType: 'TECHED', sessionRef: '' }, { auth: { username: S.sapId } }).catch((e) => e);
    expect(res.response?.status ?? res.status).to.equal(400);
  });

  it('is IDOR-safe: favorite lands on the JWT user, not any param', async () => {
    // no user id is accepted as a param at all — assert the row is owned by S, not a forged id
    await seedUser(S.sapId);
    await project.post('/api/toggleSessionFavorite',
      { sourceType: 'DEVTOBERFEST', sessionRef: 'idor-check' }, { auth: { username: S.sapId } });
    const { SessionFavorites, Users } = cds.entities(NS);
    const u = await SELECT.one.from(Users).where({ sapId: S.sapId });
    const rows = await SELECT.from(SessionFavorites).where({ sessionRef: 'idor-check' });
    expect(rows.every((r) => r.user_ID === u.ID)).to.equal(true);
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail**

Run: `npx vitest run test/unit/session-favorites.test.js`
Expected: FAIL — `toggleSessionFavorite` not found.

- [ ] **Step 3: Declare the action in `srv/developer-service.cds`**

```cds
  // #2393 — toggle a session favorite for the JWT user (never a param — IDOR).
  @(requires: 'authenticated-user')
  action toggleSessionFavorite(sourceType : String, sessionRef : String) returns {
    favorited : Boolean;
  };
```

- [ ] **Step 4: Register the handler in `srv/developer-service.js`**

```js
    this.on('toggleSessionFavorite', async (req) => {
      const sourceType = String(req.data.sourceType || '');
      const sessionRef = String(req.data.sessionRef || '').trim();
      if (!['TECHED', 'DEVTOBERFEST'].includes(sourceType)) {
        return req.reject(400, 'sourceType must be TECHED or DEVTOBERFEST');
      }
      if (!sessionRef) return req.reject(400, 'sessionRef is required');

      const { SessionFavorites } = cds.entities('com.sap.developers.ims');
      const dbUser = await provisionDbUser(req.user, 'ID'); // get-or-create; resolves from JWT
      if (!dbUser) return req.reject(401, 'Unauthenticated');

      const existing = await SELECT.one.from(SessionFavorites)
        .where({ user_ID: dbUser.ID, sourceType, sessionRef });
      if (existing) {
        await DELETE.from(SessionFavorites).where({ ID: existing.ID });
        return { favorited: false };
      }
      await INSERT.into(SessionFavorites).entries({
        ID: cds.utils.uuid(), user_ID: dbUser.ID, sourceType, sessionRef,
      });
      return { favorited: true };
    });
```

> Import: ensure `provisionDbUser` is imported at the top of `srv/developer-service.js`:
> `import { resolveUserSapId, provisionDbUser } from './lib/resolve-db-user.js';`
> Verify `provisionDbUser`'s exact signature/return in `srv/lib/resolve-db-user.js` first; if it returns the row use `.ID`, if it returns the ID adjust. If `provisionDbUser` is not suitable, open-code the get-or-create exactly as `completeStep` does (resolveUserSapId → SELECT → INSERT with explicit `ID`/`uuid`/`legacyId` via `getNextLegacyId`).

- [ ] **Step 5: Run to verify all favorites tests pass**

Run: `npx vitest run test/unit/session-favorites.test.js`
Expected: PASS (all describe blocks).

- [ ] **Step 6: Verify line endings, commit**

```bash
file srv/developer-service.cds srv/developer-service.js test/unit/session-favorites.test.js
git add srv/developer-service.cds srv/developer-service.js test/unit/session-favorites.test.js
git commit -m "feat(#2393): toggleSessionFavorite action (idempotent, IDOR-safe)"
```

---

### Task 4: Shared favorites client module (`favorites.ts`)

**Files:**
- Create: `hugo-apps/src/devtoberfest-schedule-shared/favorites.ts`
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/feed.ts` (add `fetchMyFavorites`)
- Modify: `hugo-apps/src/devtoberfest-schedule-shared/types.ts` (add `MyFavorites`)
- Test: `hugo-apps/src/devtoberfest-schedule-shared/__tests__/favorites.test.ts` (create)

**Interfaces:**
- Consumes: `/api/getMyFavorites` (Task 2), `/api/toggleSessionFavorite` (Task 3), `opts` (`credentials:'include'`) from `feed.ts`.
- Produces:
  - `types.ts`: `interface MyFavorites { authenticated: boolean; favorites: Array<{ sourceType: string; sessionRef: string }> }`
  - `feed.ts`: `fetchMyFavorites(): Promise<MyFavorites>` — 401/non-2xx/non-JSON/throw → `{ authenticated:false, favorites:[] }`.
  - `favorites.ts`: reactive shared store —
    - `favKey(sourceType: string, ref: string): string` → `` `${sourceType}:${ref}` ``
    - `favSet: Ref<Set<string>>` (module-singleton, `ref(new Set())`)
    - `isFavorite(sourceType: string, ref: string): boolean`
    - `loadFavorites(): Promise<void>` (calls `fetchMyFavorites`, replaces the Set)
    - `toggleFavorite(sourceType: string, ref: string): Promise<void>` (optimistic mutate + POST + revert on failure)

- [ ] **Step 1: Write the failing test**

```ts
// hugo-apps/src/devtoberfest-schedule-shared/__tests__/favorites.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { favKey, isFavorite, favSet, toggleFavorite, loadFavorites } from '../favorites';

describe('favorites store', () => {
  beforeEach(() => { favSet.value = new Set(); vi.restoreAllMocks(); });

  it('favKey is a stable composite', () => {
    expect(favKey('TECHED', 'ai-001')).toBe('TECHED:ai-001');
  });

  it('loadFavorites seeds the set from the feed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, headers: { get: () => 'application/json' },
      json: async () => ({ authenticated: true, favorites: [{ sourceType: 'TECHED', sessionRef: 'ai-001' }] }),
    }));
    await loadFavorites();
    expect(isFavorite('TECHED', 'ai-001')).toBe(true);
    expect(isFavorite('TECHED', 'nope')).toBe(false);
  });

  it('toggleFavorite optimistically adds then reverts on a failed POST', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, headers: { get: () => 'application/json' } }));
    await toggleFavorite('TECHED', 'x-1');
    expect(isFavorite('TECHED', 'x-1')).toBe(false); // reverted
  });

  it('toggleFavorite keeps the change on a successful POST', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, headers: { get: () => 'application/json' }, json: async () => ({ favorited: true }),
    }));
    await toggleFavorite('DEVTOBERFEST', 'd-1');
    expect(isFavorite('DEVTOBERFEST', 'd-1')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/__tests__/favorites.test.ts`
Expected: FAIL — module `../favorites` not found.

- [ ] **Step 3: Add `MyFavorites` to `types.ts`**

```ts
export interface MyFavorites {
  authenticated: boolean;
  favorites: Array<{ sourceType: string; sessionRef: string }>;
}
```

- [ ] **Step 4: Add `fetchMyFavorites` to `feed.ts`**

Mirror `fetchMyCompletions` exactly (same `opts`, same guards):

```ts
import type { MyFavorites } from './types';

export async function fetchMyFavorites(): Promise<MyFavorites> {
  try {
    const r = await fetch('/api/getMyFavorites()', opts);
    if (!r.ok) return { authenticated: false, favorites: [] };
    const ct = r.headers?.get?.('content-type');
    if (ct && !ct.includes('application/json')) return { authenticated: false, favorites: [] };
    const body = await r.json();
    const rows = body?.value ?? body ?? [];
    return { authenticated: true, favorites: Array.isArray(rows) ? rows : [] };
  } catch { return { authenticated: false, favorites: [] }; }
}
```

- [ ] **Step 5: Create `favorites.ts`**

```ts
import { ref, type Ref } from 'vue';
import { fetchMyFavorites } from './feed';

export const favKey = (sourceType: string, ref: string): string => `${sourceType}:${ref}`;

// Module-singleton reactive set, shared across every island mounted on the page.
export const favSet: Ref<Set<string>> = ref(new Set<string>());

export function isFavorite(sourceType: string, sref: string): boolean {
  return favSet.value.has(favKey(sourceType, sref));
}

export async function loadFavorites(): Promise<void> {
  const { favorites } = await fetchMyFavorites();
  favSet.value = new Set(favorites.map((f) => favKey(f.sourceType, f.sessionRef)));
}

export async function toggleFavorite(sourceType: string, sref: string): Promise<void> {
  const key = favKey(sourceType, sref);
  const had = favSet.value.has(key);
  // optimistic
  const next = new Set(favSet.value);
  if (had) next.delete(key); else next.add(key);
  favSet.value = next;
  try {
    const r = await fetch('/api/toggleSessionFavorite', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ sourceType, sessionRef: sref }),
    });
    if (!r.ok) throw new Error(`toggle failed ${r.status}`);
  } catch {
    // revert
    const revert = new Set(favSet.value);
    if (had) revert.add(key); else revert.delete(key);
    favSet.value = revert;
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest-schedule-shared/__tests__/favorites.test.ts`
Expected: PASS.

- [ ] **Step 7: Verify line endings, commit**

```bash
file hugo-apps/src/devtoberfest-schedule-shared/favorites.ts hugo-apps/src/devtoberfest-schedule-shared/feed.ts hugo-apps/src/devtoberfest-schedule-shared/types.ts
git add hugo-apps/src/devtoberfest-schedule-shared/favorites.ts hugo-apps/src/devtoberfest-schedule-shared/feed.ts hugo-apps/src/devtoberfest-schedule-shared/types.ts hugo-apps/src/devtoberfest-schedule-shared/__tests__/favorites.test.ts
git commit -m "feat(#2393): shared favorites client store + fetchMyFavorites"
```

---

### Task 5: TechEd favorites facet — `filter.ts` + `url-state.ts`

**Files:**
- Modify: `hugo-apps/src/teched-sessions-grid/filter.ts` (add `favorites` predicate)
- Modify: `hugo-apps/src/teched-sessions-grid/url-state.ts` (add `fav` param)
- Test: `hugo-apps/src/teched-sessions-grid/__tests__/filter.test.ts` (extend)
- Test: `hugo-apps/src/teched-sessions-grid/__tests__/url-state.test.ts` (extend if exists; else create)

**Interfaces:**
- Consumes: `favKey` semantics (a `Set<string>` of `"${sourceType}:${sessionRef}"`).
- Produces:
  - `TechEdFilterState` gains `favorites?: boolean` and `favKeys?: Set<string>` (the caller passes the favorited-slug keys; TechEd sourceType is always `'TECHED'`).
  - `filterSessions` drops any session whose `TECHED:${slug}` is not in `favKeys` when `favorites` is on.
  - `TechEdUrlState` gains `fav: boolean`; `parseTechEdUrl` reads `fav=1`; `toTechEdQuery` writes `fav=1`.

- [ ] **Step 1: Write the failing tests**

Extend `filter.test.ts`:

```ts
it('filters to favorites only', () => {
  const favKeys = new Set(['TECHED:ai-001']);
  const out = filterSessions(data, { favorites: true, favKeys });
  expect(out.map((s) => s.slug)).toEqual(['ai-001']);
});

it('favorites AND venue combine', () => {
  const favKeys = new Set(['TECHED:ai-001', 'TECHED:some-virtual']);
  const out = filterSessions(data, { favorites: true, favKeys, venue: 'BERLIN' });
  expect(out.every((s) => s.venue === 'BERLIN')).toBe(true);
  expect(out.every((s) => favKeys.has(`TECHED:${s.slug}`))).toBe(true);
});

it('favorites off ignores favKeys', () => {
  expect(filterSessions(data, { favorites: false, favKeys: new Set() })).toHaveLength(data.length);
});
```

Extend/create `url-state.test.ts`:

```ts
it('round-trips the fav flag', () => {
  expect(parseTechEdUrl('?fav=1').fav).toBe(true);
  expect(parseTechEdUrl('').fav).toBe(false);
  expect(toTechEdQuery({ ...DEFAULT_URL_STATE, fav: true })).toContain('fav=1');
  expect(toTechEdQuery({ ...DEFAULT_URL_STATE, fav: false })).not.toContain('fav');
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd hugo-apps && npx vitest run src/teched-sessions-grid/__tests__/filter.test.ts src/teched-sessions-grid/__tests__/url-state.test.ts`
Expected: FAIL — `favorites`/`fav` unknown.

- [ ] **Step 3: Extend `filter.ts`**

Add to `TechEdFilterState`:
```ts
  favorites?: boolean;
  favKeys?: Set<string>;   // keys shaped "TECHED:<slug>"
```
Add inside `filterSessions`, before `return true;`:
```ts
      if (state.favorites && !(state.favKeys?.has(`TECHED:${s.slug}`))) return false;
```

- [ ] **Step 4: Extend `url-state.ts`**

- Add `readonly fav: boolean;` to `TechEdUrlState`.
- Add `fav: false` to `DEFAULT_URL_STATE`.
- In `parseTechEdUrl`, add `fav: p.get('fav') === '1',`.
- In `toTechEdQuery`, add `if (state.fav) p.set('fav', '1');`.

- [ ] **Step 5: Run to verify they pass**

Run: `cd hugo-apps && npx vitest run src/teched-sessions-grid/__tests__/filter.test.ts src/teched-sessions-grid/__tests__/url-state.test.ts`
Expected: PASS.

- [ ] **Step 6: Verify line endings, commit**

```bash
file hugo-apps/src/teched-sessions-grid/filter.ts hugo-apps/src/teched-sessions-grid/url-state.ts
git add hugo-apps/src/teched-sessions-grid/filter.ts hugo-apps/src/teched-sessions-grid/url-state.ts hugo-apps/src/teched-sessions-grid/__tests__/
git commit -m "feat(#2393): TechEd favorites filter facet + fav URL param"
```

---

### Task 6: TechEd grid UI — star toggle + favorites-only toggle

**Files:**
- Modify: `hugo-apps/src/teched-sessions-grid/App.vue`

**Interfaces:**
- Consumes: `useAuth` (`../devtoberfest-schedule-shared/useAuth`), `favSet`/`isFavorite`/`toggleFavorite`/`loadFavorites` (`../devtoberfest-schedule-shared/favorites`), the `favorites`/`favKeys` filter fields (Task 5), the `fav` URL field (Task 5).
- Produces: an auth-gated ⭐ button on each session card; an auth-gated "Show favorites only" toolbar toggle bound to the `fav` URL state; the grid's computed filtered list passes `{ favorites: favOnly, favKeys: favSet.value }` into `filterSessions`.

- [ ] **Step 1: Wire the store + auth (script setup)**

- Import `useAuth`, and `favSet, isFavorite, toggleFavorite, loadFavorites`.
- `const { isAuthenticated } = useAuth();`
- On mount (where the feed loads, App.vue ~:69), also `if (isAuthenticated.value) loadFavorites();` and re-run `loadFavorites()` on the `auth-resolved`-driven `isAuthenticated` transition (watch `isAuthenticated`).
- Add reactive `favOnly` bound to the URL `fav` flag (reuse the existing url-state read/write path the other facets use).

- [ ] **Step 2: Pass the facet into the existing filtered computed**

Find the computed that calls `filterSessions(...)` and extend the state object:
```ts
filterSessions(sessions.value, {
  /* ...existing facets... */
  favorites: favOnly.value,
  favKeys: favSet.value,
})
```

- [ ] **Step 3: Add the star button to the card template**

On each session card (near the title/actions), add:
```html
<button
  v-if="isAuthenticated"
  class="fav-star"
  :class="{ 'is-fav': isFavorite('TECHED', s.slug) }"
  :aria-pressed="isFavorite('TECHED', s.slug)"
  :aria-label="isFavorite('TECHED', s.slug) ? 'Remove from favorites' : 'Add to favorites'"
  @click.stop.prevent="toggleFavorite('TECHED', s.slug)"
>★</button>
```
(Match the existing card markup/classes; `@click.stop` so it doesn't open the DetailPanel.)

- [ ] **Step 4: Add the "favorites only" toolbar toggle**

Next to the existing facets (venue toggle group / clubhouse toggle, App.vue ~:325-406), gated on auth:
```html
<button
  v-if="isAuthenticated"
  class="facet-toggle"
  :class="{ active: favOnly }"
  @click="favOnly = !favOnly"
>★ Favorites</button>
```
Wire `favOnly` to write `fav` into the URL query via the existing `toTechEdQuery` sync.

- [ ] **Step 5: Manual dev smoke + build check**

Run: `cd hugo-apps && npm run build`
Expected: build succeeds, `teched-sessions-grid` entry emits, manifest updates.
(A logged-in visual check happens post-deploy in Task 9 — this step only proves the island compiles.)

- [ ] **Step 6: Verify line endings, commit**

```bash
file hugo-apps/src/teched-sessions-grid/App.vue
git add hugo-apps/src/teched-sessions-grid/App.vue srv/lib/island-manifest.json
git commit -m "feat(#2393): TechEd grid star toggle + favorites-only filter"
```

---

### Task 7: TechEd schedule + calendar views — same facet

**Files:**
- Modify: `hugo-apps/src/teched-schedule/App.vue`
- Modify: `hugo-apps/src/teched-calendar/App.vue`

**Interfaces:**
- Consumes: same store + `useAuth` + `filterSessions`/facet as Task 6.
- Produces: star toggle per row/entry + "favorites only" toggle in each view, gated on auth, sharing the same `favSet` singleton (so favoriting in grid reflects in schedule without reload).

- [ ] **Step 1: Replicate the Task 6 wiring in `teched-schedule/App.vue`**

Same imports, `loadFavorites` on mount/auth, `favOnly` state, extend that view's row-filter to drop non-favorites when `favOnly` (if the schedule view filters client-side differently, add the same `favKeys.has('TECHED:'+slug)` guard to its filter path). Add a compact star control per row and a toolbar "★ Favorites" toggle, both `v-if="isAuthenticated"`.

- [ ] **Step 2: Replicate in `teched-calendar/App.vue`**

Same pattern; calendar entries get a small star affordance + the toolbar toggle. If the calendar groups by time, favorites-only simply reduces the entries fed into the grouping.

- [ ] **Step 3: Build check**

Run: `cd hugo-apps && npm run build`
Expected: both entries compile, manifest updates.

- [ ] **Step 4: Verify line endings, commit**

```bash
file hugo-apps/src/teched-schedule/App.vue hugo-apps/src/teched-calendar/App.vue
git add hugo-apps/src/teched-schedule/App.vue hugo-apps/src/teched-calendar/App.vue srv/lib/island-manifest.json
git commit -m "feat(#2393): TechEd schedule + calendar favorites facet"
```

---

### Task 8: Devtoberfest views — star toggle + favorites-only facet

**Files:**
- Modify: `hugo-apps/src/devtoberfest-schedule/App.vue`
- Modify: `hugo-apps/src/devtoberfest-sessions-grid/App.vue`
- Modify: `hugo-apps/src/devtoberfest-sessions-calendar/App.vue`

**Interfaces:**
- Consumes: same store; Devtoberfest sessions favorite on `sourceType='DEVTOBERFEST'` and their facade `ID` (the row's `ID`/`sessionId` field — confirm the field name in the feed row type before wiring; it is the `String(36)` id, NOT the slug).
- Produces: star toggle per row + "favorites only" filter in all three Devtoberfest views, gated on auth, keyed `DEVTOBERFEST:<id>`.

- [ ] **Step 1: Confirm the Devtoberfest session id field**

Read `hugo-apps/src/devtoberfest-schedule-shared/types.ts` `Session`/`ScheduleRow` to find the id field name used for `sessionRef` (the facade `ID` String(36)). Use that consistently as the favorite ref.

- [ ] **Step 2: Wire `devtoberfest-schedule/App.vue`**

- Import `useAuth` + store fns.
- `loadFavorites()` in the existing `loadData` parallel block (App.vue ~:97-100), alongside `fetchFeed`/`fetchMyCompletions`.
- Add `favOnly` reactive to the client filter (App.vue ~:64-74): add `if (favOnly.value && !isFavorite('DEVTOBERFEST', row.<idField>)) return false;`.
- Add a star control per row (next to the existing conditionally-rendered Status ✓ column, App.vue ~:230,293-295), `v-if="isAuthenticated"`, `@click.stop="toggleFavorite('DEVTOBERFEST', row.<idField>)"`.
- Add a "★ Favorites" toolbar toggle `v-if="isAuthenticated"`.

- [ ] **Step 3: Wire `devtoberfest-sessions-grid/App.vue` and `devtoberfest-sessions-calendar/App.vue`**

Same store + auth + `favOnly` filter guard + per-item star + toolbar toggle, keyed `DEVTOBERFEST:<idField>`.

- [ ] **Step 4: Build check**

Run: `cd hugo-apps && npm run build`
Expected: all three entries compile, manifest updates.

- [ ] **Step 5: Verify line endings, commit**

```bash
file hugo-apps/src/devtoberfest-schedule/App.vue hugo-apps/src/devtoberfest-sessions-grid/App.vue hugo-apps/src/devtoberfest-sessions-calendar/App.vue
git add hugo-apps/src/devtoberfest-schedule/App.vue hugo-apps/src/devtoberfest-sessions-grid/App.vue hugo-apps/src/devtoberfest-sessions-calendar/App.vue srv/lib/island-manifest.json
git commit -m "feat(#2393): Devtoberfest views favorites star + filter"
```

---

### Task 9: Full-suite green + docs + PR

**Files:**
- Modify: `docs/developers/reference/teched.md` (short "Favorite sessions (#2393)" section) — and note the Devtoberfest side if a devtoberfest reference doc exists; otherwise the teched.md section covers both since the store is shared.

- [ ] **Step 1: Run the service unit suite**

Run: `npm test`
Expected: PASS, including the new `session-favorites*.test.js`. If unrelated pre-existing failures appear, note them but do not fix out of scope.

- [ ] **Step 2: Run the island unit suite**

Run: `cd hugo-apps && npx vitest run`
Expected: PASS, including favorites + filter + url-state tests.

- [ ] **Step 3: Document the feature**

Add to `docs/developers/reference/teched.md` a section describing: the `SessionFavorites` entity (discriminator + loose `sessionRef`), the two DeveloperService ops (JWT-scoped, IDOR-safe), the shared `favorites.ts` store + `fetchMyFavorites` degrade-to-anonymous, the `fav=1` URL facet, and that the star + filter are auth-gated (hidden anonymous). Note the `@PersonalData cascade:'delete'` GDPR wiring.

- [ ] **Step 4: Commit docs**

```bash
git add docs/developers/reference/teched.md
git commit -m "docs(#2393): favorite sessions feature"
```

- [ ] **Step 5: Push + open PR**

```bash
git push -u origin worktree-favorite-sessions-2393
gh pr create --repo sap-tutorials/tutorials-ims --base DEV \
  --title "feat(#2393): favorite TechEd + Devtoberfest sessions + favorites-only filter" \
  --body "Implements #2393. New SessionFavorites entity (discriminator, IDOR-safe JWT-scoped ops), shared favorites store, auth-gated star + 'favorites only' filter across all TechEd + Devtoberfest views. Spec: docs/superpowers/specs/2026-09-19-favorite-sessions-design.md"
```

> PR targets `DEV` (memory: PRs target DEV; main is protected). Do NOT deploy from this feature branch — post-merge, a deploy from fresh `origin/DEV` handles the DEV rollout, and the auth-gated visual check happens there.

---

## Self-Review notes

- **Spec coverage:** entity (T1) ✅, GDPR cascade (T1) ✅, `getMyFavorites` (T2) ✅, `toggleSessionFavorite` insert/delete/validate (T3) ✅, IDOR test (T3) ✅, shared client store + degrade-to-anonymous (T4) ✅, TechEd facet+URL (T5) ✅, TechEd grid/schedule/calendar UI (T6,T7) ✅, all 3 Devtoberfest views (T8) ✅, tests + docs + PR (T9) ✅. No custom Express route (per spec) ✅.
- **Type consistency:** `favKey`/`favSet`/`isFavorite`/`toggleFavorite`/`loadFavorites` names identical across T4→T6→T7→T8; `favorites`/`favKeys` filter fields identical T5→T6/T7; `fav` URL field identical T5→T6. `MyFavorites` shape identical T4 producer ↔ consumers.
- **Verify-before-code flags:** `provisionDbUser` signature (T3 Step 4) and the Devtoberfest session id field name (T8 Step 1) are called out as read-first checks, not assumed.
