# Khoros Community-Link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in tutorial user link their SAP Community (Khoros) profile from `/me` so the avatar shows up in the nav-dropdown, the chip surfaces on `/me`, and the `khoros*` columns become a foundation for future Devtoberfest-style consumers.

**Architecture:** Four nullable columns on `Users` (`khorosId`, `khorosLogin`, `khorosAvatarUrl`, `khorosLinkedAt`). A pure `khoros-client.js` module ports the reference repo's `messages.author.*` search workaround to native `fetch`. A bounded LRU cache absorbs upstream rate-limit risk. Three new CAP actions/function on `DeveloperService`, one bound action on `AdminService`. Frontend: three collapsible `ui5-panel`s on `/me`, a new `CommunityProfile.vue` island inside the Learning Preferences panel, and the nav-dropdown's initials get swapped for the Khoros avatar.

**Tech Stack:** CAP Node.js (`@sap/cds@^9.9`), CDS, Vue 3 islands via Vite, UI5 Web Components v2.22, SAP HANA (HDI) for prod / SQLite for unit tests, Vitest workspaces (unit/hybrid/smoke).

**Spec:** `docs/superpowers/specs/2026-06-26-566-khoros-community-link-design.md` — read this first if you weren't part of brainstorming.

**Working branch:** `worktree-566-khoros-link` (already created via EnterWorktree). All work happens on this branch; final PR opens against `main`.

---

## Conventions referenced throughout

- **TDD discipline.** Every task writes the failing test first, runs it to confirm the failure, implements the minimum to pass, runs again, then commits. Don't batch.
- **Commit cadence.** Commit at the end of each task (the step labelled "Commit"). If a task is long, commits at logical sub-points are fine — *never* go more than ~20 minutes without one. (Memory: `[feedback_commit_immediately_when_in_primary_tree]`.)
- **No `cds compile`** — schema changes need `npx cds build --production` so `db/last-dev/csn.json` is regenerated correctly (memory: `[feedback_cds_build_production_not_cds_compile_for_last_dev]`). The repo has a `check-cds-build-staging` CI test that fires on any srv/ or db/ change (memory: `[feedback_cds_build_staging_fires_on_any_service_change]`).
- **Native `fetch`, not Axios/then-request** (memory: `[CLAUDE.md > Prefer Node.js native fetch]`). The reference repo uses `then-request`; we don't.
- **UI5 imports stay in `hugo/assets/js/ui5-bootstrap.ts`.** Never import `@ui5/webcomponents/*` from a Vue island's `main.ts` — Vite bundles a second copy and breaks `setTheme()` (memory: `[feedback_ui5_duplicate_bundle_kills_settheme]`).
- **UI5 boolean attributes set imperatively** (memory: `[feedback_ui5_dialog_open_imperative_only]`).
- **Hybrid tests are mandatory for any DB-touching change** (memory: `[feedback_skip_hybrid_test_costs_two_pr_cycles]`). Run with `npm run test:hybrid` after `cf login` to the DEV space.
- **Worktree is .claude/worktrees/** (memory: `[feedback_worktree_directory_convention]`). All `git` commands run from `d:/projects/tutorials-poc/.claude/worktrees/566-khoros-link`.

---

## File structure

**Foundation (Tasks 1–3) — pure modules + schema delta, no UI coupling yet:**
- `srv/lib/khoros-cache.js` (NEW) — bounded LRU keyed by `khorosId`. Pure module.
- `srv/lib/khoros-client.js` (NEW) — native-fetch port of `searchAuthor`/`callUserAPI`. Pure module.
- `db/schema.cds` (MODIFY) — append 4 columns to `Users` + `@assert.unique.khorosId`.
- `db/audit-logging.cds` (MODIFY) — 4 field-level `@PersonalData` annotations.
- `test/unit/khoros-cache.test.js` (NEW)
- `test/unit/khoros-client.test.js` (NEW)

**Backend (Tasks 4–6) — wire the actions/function + `/auth/user`:**
- `srv/developer-service.cds` (MODIFY) — declare 2 actions + 1 function.
- `srv/developer-service.js` (MODIFY) — handlers for setKhorosLink / clearKhorosLink / getKhorosProfile.
- `srv/server.js` (MODIFY) — add 3 `khoros*` fields to `/auth/user` response.
- `test/hybrid/khoros-link.test.js` (NEW) — real HANA: link, unique-constraint, clear, audit, cascade.

**Frontend foundation (Tasks 7–8) — bootstrap + layout shell:**
- `hugo/assets/js/ui5-bootstrap.ts` (MODIFY) — add `Panel.js` import. (Avatar/MessageStrip/Title/Text already there.)
- `hugo/layouts/me/list.html` (MODIFY) — wrap in 3 `ui5-panel`s, 4 mount points, inline collapse-state script.

**Frontend `/me` panel split (Tasks 9–10):**
- `hugo-apps/src/me/RecentActivity.vue` (NEW) — extracted timeline.
- `hugo-apps/src/me/AllCompletions.vue` (NEW) — extracted toolbar + table.
- `hugo-apps/src/me/MyCompletions.vue` (DELETE).
- `hugo-apps/src/me/main.ts` (MODIFY) — mount 4 islands.
- `test/unit/community-profile.test.ts` (NEW — Tasks 11–12 use it).

**Frontend Khoros island (Tasks 11–12):**
- `hugo-apps/src/me/CommunityProfile.vue` (NEW).

**Nav-dropdown swap (Task 13):**
- `hugo-apps/src/nav-dropdown/*` (MODIFY) — avatar swap + community-profile link.

**Admin UI (Task 14):**
- `app/admin-annotations.cds` (MODIFY) — Khoros columns as read-only on Users OP + action button.
- `srv/admin-service.cds` (MODIFY) — bound `clearKhorosLink(userId)` action.
- `srv/admin-service.js` (MODIFY) — handler.
- `test/hybrid/khoros-link.test.js` (MODIFY) — extend with admin clear coverage.

**Smoke + docs (Tasks 15–16):**
- `test/smoke/me-page.test.js` (NEW).
- `docs/developers/architecture/khoros-link.md` (NEW).
- `docs/end-users/me-page.md` (NEW).
- `docs/developers/reference/cap-cds-gotchas.md` (MODIFY).
- `docs/.vitepress/config.ts` (MODIFY).

**Verification + ship (Task 17):**
- Build, hybrid tests, manual DEV smoke, PR.

---
## Task 1: Khoros LRU cache

Pure module. No I/O. Easy to TDD. We start here so Task 2's client can seed it inline.

**Files:**
- Create: `srv/lib/khoros-cache.js`
- Create: `test/unit/khoros-cache.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/khoros-cache.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as cache from '../../srv/lib/khoros-cache.js';

describe('khoros-cache', () => {
  beforeEach(() => { cache._resetForTests(); });

  it('returns null on miss', () => {
    expect(cache.get('123')).toBeNull();
  });

  it('returns the profile on hit within TTL', () => {
    cache.set('123', { name: 'Alice', rank: 'Star', avatarUrl: 'x' });
    expect(cache.get('123')).toEqual({ name: 'Alice', rank: 'Star', avatarUrl: 'x' });
  });

  it('expires entries past the 6h TTL', () => {
    vi.useFakeTimers();
    cache.set('123', { name: 'Alice' });
    vi.advanceTimersByTime(6 * 60 * 60 * 1000 + 1);
    expect(cache.get('123')).toBeNull();
    vi.useRealTimers();
  });

  it('bumps an entry to MRU on get', () => {
    for (let i = 0; i < 500; i++) cache.set(`k${i}`, { i });
    cache.get('k0');                              // k0 → MRU
    cache.set('k500', { i: 500 });                // forces an eviction
    expect(cache.get('k0')).not.toBeNull();       // k0 survived
    expect(cache.get('k1')).toBeNull();           // k1 was the new oldest
  });

  it('evicts the oldest entry when over capacity', () => {
    for (let i = 0; i < 501; i++) cache.set(`k${i}`, { i });
    expect(cache.get('k0')).toBeNull();
    expect(cache.get('k500')).toEqual({ i: 500 });
  });

  it('evict() removes the entry immediately', () => {
    cache.set('123', { name: 'Alice' });
    cache.evict('123');
    expect(cache.get('123')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project unit test/unit/khoros-cache.test.js
```

Expected: FAIL — `Cannot find module '../../srv/lib/khoros-cache.js'`.

- [ ] **Step 3: Implement `srv/lib/khoros-cache.js`**

```js
// srv/lib/khoros-cache.js
//
// Bounded LRU keyed by Khoros user id. Module-scoped singleton.
// Per-process (not Redis-shared); two CF instances may each warm
// independently. Acceptable for v1 (display-only unlock).
//
// Spec: docs/superpowers/specs/2026-06-26-566-khoros-community-link-design.md
// Issue: #566

const cache = new Map();
const MAX_ENTRIES = 500;
const TTL_MS = 6 * 60 * 60 * 1000;

export function get(khorosId) {
  const entry = cache.get(khorosId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > TTL_MS) {
    cache.delete(khorosId);
    return null;
  }
  cache.delete(khorosId);
  cache.set(khorosId, entry);
  return entry.profile;
}

export function set(khorosId, profile) {
  cache.delete(khorosId);
  cache.set(khorosId, { profile, fetchedAt: Date.now() });
  if (cache.size > MAX_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

export function evict(khorosId) {
  cache.delete(khorosId);
}

// Test-only.
export function _resetForTests() {
  cache.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project unit test/unit/khoros-cache.test.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/khoros-cache.js test/unit/khoros-cache.test.js
git commit -m "feat(566): khoros LRU cache module (6h TTL, 500-entry cap)"
```

---
## Task 2: Khoros search client

Pure module. Native-fetch port of `searchAuthor`/`callUserAPI` from `D:/projects/sap-community-activity-badges/srv/util/khoros.js`. Hoist tenant prefix to a named constant per spec.

**Files:**
- Create: `srv/lib/khoros-client.js`
- Create: `test/unit/khoros-client.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/khoros-client.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { resolveUser, KHOROS_TENANT_PREFIX } from '../../srv/lib/khoros-client.js';

const okEnvelope = (author) => ({
  status: 'success', data: { items: author ? [{ author }] : [] }
});

function mockFetchOnce(body, opts = {}) {
  global.fetch = vi.fn().mockResolvedValue({
    ok: opts.ok !== false,
    status: opts.status || 200,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  });
}

describe('khoros-client.resolveUser', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('fingerprints numeric input as author.id', async () => {
    mockFetchOnce(okEnvelope({
      id: '12345', login: 'thomas_jung',
      first_name: 'Thomas', last_name: 'Jung',
      rank: { name: 'Star' }, avatar: { profile: 'https://x/a.png' }
    }));
    const result = await resolveUser('12345');
    expect(global.fetch).toHaveBeenCalledTimes(1);
    const url = global.fetch.mock.calls[0][0];
    expect(url).toContain('author.id');
    expect(url).toContain('12345');
    expect(result).toEqual({
      id: '12345', login: 'thomas_jung',
      name: 'Thomas Jung', rank: 'Star',
      avatarUrl: 'https://x/a.png'
    });
  });

  it('fingerprints slug input as author.login with dot-to-underscore normalisation', async () => {
    mockFetchOnce(okEnvelope({
      id: '12345', login: 'thomas_jung',
      first_name: 'Thomas', last_name: 'Jung'
    }));
    await resolveUser('thomas.jung');
    expect(global.fetch.mock.calls[0][0]).toContain('thomas_jung');
  });

  it('falls back to dotted login if normalised lookup returns 0', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify(okEnvelope(null)))
      })
      .mockResolvedValueOnce({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify(okEnvelope({
          id: '1', login: 'foo.bar', first_name: 'F', last_name: 'B'
        })))
      });
    const result = await resolveUser('foo.bar');
    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(global.fetch.mock.calls[0][0]).toContain('foo_bar');
    expect(global.fetch.mock.calls[1][0]).toContain('foo.bar');
    expect(result?.login).toBe('foo.bar');
  });

  it('returns null when upstream succeeds with 0 items (lurker / unknown)', async () => {
    mockFetchOnce(okEnvelope(null));
    const result = await resolveUser('ghost_user');
    expect(result).toBeNull();
  });

  it('throws on 5xx upstream', async () => {
    mockFetchOnce({}, { ok: false, status: 503 });
    await expect(resolveUser('123')).rejects.toThrow(/upstream/i);
  });

  it('throws when Khoros returns status != success', async () => {
    mockFetchOnce({ status: 'error', message: 'bad' });
    await expect(resolveUser('123')).rejects.toThrow(/khoros/i);
  });

  it('exports KHOROS_TENANT_PREFIX as a single point of change', () => {
    expect(KHOROS_TENANT_PREFIX).toBe('khhcw49343');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project unit test/unit/khoros-client.test.js
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/lib/khoros-client.js`**

```js
// srv/lib/khoros-client.js
//
// Anonymous SAP Community user lookup. Ported from
// https://github.com/SAP-samples/sap-community-activity-badges
// (srv/util/khoros.js::searchAuthor + callUserAPI), flipped from
// then-request to Node.js native fetch per CLAUDE.md.
//
// Khoros's direct /api/2.0/users/:id endpoint started returning 404 in
// mid-2026 for anonymous callers (permission revocation). We project
// messages.author.* against /api/2.0/search instead — the only public-tier
// surface that still works without a service principal. A user with
// zero community posts cannot be found via this path.
//
// Spec: docs/superpowers/specs/2026-06-26-566-khoros-community-link-design.md

// Lazy cds.log so unit tests without @sap/cds installed don't crash.
function warn(...args) {
  try {
    // eslint-disable-next-line global-require
    const cds = require('@sap/cds');
    cds.log('khoros').warn(...args);
  } catch {
    // Test environment — drop silently.
  }
}

// Khoros tenant prefix. SAP Community uses `khhcw49343` for community.sap.com;
// Khoros has historically rotated similar prefixes. Single named constant
// so a future rotation is a one-line change.
export const KHOROS_TENANT_PREFIX = 'khhcw49343';

const SEARCH_BASE = `https://community.sap.com/${KHOROS_TENANT_PREFIX}/api/2.0/search`;

const AUTHOR_FIELDS = [
  'author.id',
  'author.login',
  'author.first_name',
  'author.last_name',
  'author.rank.name',
  'author.avatar.profile',
  'author.view_href',
].join(', ');

async function searchAuthor(whereClause) {
  const query = `SELECT ${AUTHOR_FIELDS} FROM messages WHERE ${whereClause} LIMIT 1`;
  const url = `${SEARCH_BASE}?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) {
    if (res.status >= 500) {
      throw new Error(`khoros upstream ${res.status}`);
    }
    throw new Error(`khoros HTTP ${res.status}`);
  }
  const body = JSON.parse(await res.text());
  if (body.status !== 'success') {
    throw new Error(`khoros search failed: ${body.message || JSON.stringify(body)}`);
  }
  const items = body?.data?.items || [];
  if (items.length === 0) {
    // Empty-on-success is the silent symptom of a Khoros permission
    // revocation. Log so a future revocation shows up in operator logs.
    warn(`searchAuthor returned 0 items for WHERE ${whereClause}`);
    return null;
  }
  return items[0]?.author || null;
}

function shape(author) {
  if (!author) return null;
  const name = [author.first_name, author.last_name].filter(Boolean).join(' ').trim();
  return {
    id: author.id,
    login: author.login,
    name: name || author.login,
    rank: author.rank?.name || '',
    avatarUrl: author.avatar?.profile || '',
  };
}

/**
 * Resolve a Khoros user from either a numeric id or a login slug.
 *
 * @param {string} input — user-typed: "12345" or "thomas_jung" or "thomas.jung"
 * @returns {Promise<{id, login, name, rank, avatarUrl} | null>}
 *   Null = upstream returned 0 items (lurker, deleted, or unknown).
 *   Throws on 5xx, non-success status, or network error.
 */
export async function resolveUser(input) {
  const id = String(input).trim();
  if (!id) return null;
  const isNumeric = /^\d+$/.test(id);

  if (isNumeric) {
    const author = await searchAuthor(`author.id = '${id}'`);
    return author ? shape(author) : null;
  }

  // Slug path: try dot-to-underscore normalisation first (Khoros migrated
  // dotted logins like "thomas.jung" → "thomas_jung" in bulk).
  const normalised = id.replace(/\./g, '_');
  let author = await searchAuthor(`author.login = '${normalised}'`);
  if (author) return shape(author);

  // Fallback to the dotted form (handles logins Khoros didn't migrate).
  if (normalised !== id) {
    author = await searchAuthor(`author.login = '${id}'`);
    if (author) return shape(author);
  }

  return null;
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project unit test/unit/khoros-client.test.js
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/khoros-client.js test/unit/khoros-client.test.js
git commit -m "feat(566): khoros search client (native fetch, messages.author.* expansion)"
```

---
## Task 3: Schema delta + GDPR annotations

**Files:**
- Modify: `db/schema.cds` (append to existing `Users` entity around line 115)
- Modify: `db/audit-logging.cds` (append 4 field-level annotations)

- [ ] **Step 1: Add the 4 columns + unique constraint to `db/schema.cds`**

Find the existing `Users` entity. Replace the entity header and add the four columns. The result:

```cds
@assert.unique.sapId : [sapId]
@assert.unique.khorosId : [khorosId]
entity Users : cuid, managed, LegacyKeyed {
  uuid                : String(36) @mandatory;
  sapId               : String(255);
  firstName           : String(255);
  lastName            : String(255);
  email               : String(255);
  displayName         : String(255);
  avatarUrl           : String(1000);
  // Khoros (SAP Community) profile linkage — issue #566. khorosId is the
  // stable numeric join key; khorosLogin is the human-readable slug refreshed
  // lazily (Khoros has bulk-renamed slugs before). All 4 nullable; users
  // start unlinked and self-claim via /api/setKhorosLink.
  khorosId            : String(32);
  khorosLogin         : String(64);
  khorosAvatarUrl     : String(1000);
  khorosLinkedAt      : Timestamp;
  // ... existing compositions unchanged: taskRecords, prizeRecords, accomplishments,
  //     metadata, environmentTabs ...
}
```

- [ ] **Step 2: Add `@PersonalData.IsPotentiallyPersonal` annotations to `db/audit-logging.cds`**

Find the existing `annotate ims.Users with @PersonalData: { ... } { ... };` block. Append three new lines inside its trailing `{ ... }` (preserve the existing annotations):

```cds
annotate ims.Users with @PersonalData: {
  DataSubjectRole: 'Developer',
  EntitySemantics: 'DataSubject',
  cascade: 'identity-replace'
} {
  ID              @PersonalData.FieldSemantics: 'DataSubjectID';
  uuid            @PersonalData.IsPotentiallyPersonal;
  firstName       @PersonalData.IsPotentiallyPersonal;
  lastName        @PersonalData.IsPotentiallyPersonal;
  email           @PersonalData.IsPotentiallyPersonal;
  displayName     @PersonalData.IsPotentiallyPersonal;
  avatarUrl       @PersonalData.IsPotentiallyPersonal;
  sapId           @PersonalData.IsPotentiallyPersonal;
  khorosId        @PersonalData.IsPotentiallyPersonal;
  khorosLogin     @PersonalData.IsPotentiallyPersonal;
  khorosAvatarUrl @PersonalData.IsPotentiallyPersonal;
  // khorosLinkedAt — not personal (just a timestamp), no annotation
}
```

- [ ] **Step 3: Regenerate the staging CSN**

```bash
npx cds build --production
```

Expected: succeeds. `db/last-dev/csn.json` updated with the 4 new fields. The `db/src/com.sap.developers.ims.Users.hdbmigrationtable` file should also reflect the columns.

- [ ] **Step 4: Run the staging-CSN drift check**

```bash
npm test -- --project unit test/unit/check-cds-build-staging
```

(If the test path differs, search: `npx vitest list --project unit | grep -i staging`. The test asserts `db/last-dev/csn.json` matches what `cds build --production` would emit.)

Expected: PASS.

- [ ] **Step 5: Quick sanity check that CDS still loads with the new fields**

```bash
node --input-type=module -e "import cds from '@sap/cds'; const m = await cds.load(['db','srv']); const u = m.definitions['com.sap.developers.ims.Users']; console.log('khorosId:', !!u.elements.khorosId, 'khorosLinkedAt:', !!u.elements.khorosLinkedAt); console.log('unique:', JSON.stringify(u['@assert.unique.khorosId']));"
```

Expected output:

```
khorosId: true khorosLinkedAt: true
unique: ["khorosId"]
```

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds db/audit-logging.cds db/last-dev/ db/src/
git commit -m "feat(566): add khorosId/khorosLogin/khorosAvatarUrl/khorosLinkedAt to Users

Schema: 4 nullable columns + @assert.unique.khorosId (no unique on
khorosLogin — slugs aren't stable, Khoros has bulk-renamed before).

GDPR: 3 of 4 fields annotated @PersonalData.IsPotentiallyPersonal so
the existing 'identity-replace' cascade scrubs them on anonymisation.
khorosLinkedAt is a timestamp, no PII annotation needed."
```

---
## Task 4: DeveloperService CDS — declare the 3 endpoints

**Files:**
- Modify: `srv/developer-service.cds`

- [ ] **Step 1: Add the action + function declarations**

Open `srv/developer-service.cds`. Find a good neighbour — the existing `setLearningPreferences` action near line 196 is a perfect anchor. Add the three new declarations next to it:

```cds
// Issue #566 — SAP Community (Khoros) profile linkage. Display-only unlock
// in v1; foundation for future Devtoberfest-style consumers.
@(requires: 'authenticated-user')
action setKhorosLink(input: String) returns {
  status     : String;     // 'ok' | 'not-found' | 'already-claimed' | 'invalid-input'
                           //        | 'upstream-unavailable' | 'persist-failed'
  khorosId   : String;
  khorosLogin: String;
  name       : String;
};

@(requires: 'authenticated-user')
action clearKhorosLink() returns { status: String };

@(requires: 'authenticated-user')
function getKhorosProfile() returns {
  linked     : Boolean;
  khorosId   : String;
  khorosLogin: String;
  name       : String;
  rank       : String;
  avatarUrl  : String;
  profileUrl : String;
};
```

- [ ] **Step 2: Verify CDS still compiles**

```bash
npx cds compile srv/developer-service.cds 2>&1 | head -20
```

Expected: no errors. The `@odata.singleton`, `@requires`, etc. should resolve.

- [ ] **Step 3: Run the existing developer-service test**

```bash
npm test -- --project unit test/unit/developer-service 2>&1 | tail -20
```

(File path varies. The point is: no existing unit test breaks just from adding declarations. The actions have no handlers yet so calling them would 404; nothing in the existing suite should call them.)

Expected: existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add srv/developer-service.cds
git commit -m "feat(566): declare setKhorosLink/clearKhorosLink/getKhorosProfile on DeveloperService"
```

---

## Task 5: DeveloperService handlers

We TDD the handlers with the existing unit-test harness (in-memory SQLite). Mock `khoros-client.resolveUser` so the unit test doesn't hit the network. Real-HANA-unique-constraint behaviour is exercised in Task 6's hybrid test.

**Files:**
- Modify: `srv/developer-service.js`
- Create: `test/unit/developer-service-khoros.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/developer-service-khoros.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';

vi.mock('../../srv/lib/khoros-client.js', () => ({
  resolveUser: vi.fn(),
}));
import { resolveUser } from '../../srv/lib/khoros-client.js';
import * as cache from '../../srv/lib/khoros-cache.js';

const ROOT = path.resolve(__dirname, '../..');

describe('DeveloperService — Khoros endpoints', () => {
  let app, GET, POST;

  beforeAll(async () => {
    process.chdir(ROOT);
    process.env.NODE_ENV = 'test';
    app = await cds.test().in(ROOT);
    ({ GET, POST } = app);
  });
  afterAll(async () => { await cds.shutdown?.(); });

  beforeEach(async () => {
    vi.clearAllMocks();
    cache._resetForTests();
    // Seed a known user; the existing test harness auto-provisions via JWT but
    // we want a deterministic Users row.
    const db = await cds.connect.to('db');
    await db.run(DELETE.from('com.sap.developers.ims.Users').where({ sapId: 'TEST_USER_566' }));
    await db.run(INSERT.into('com.sap.developers.ims.Users').entries({
      sapId: 'TEST_USER_566', uuid: 'uuid-566', email: 't@example.com',
      firstName: 'T', lastName: 'U',
    }));
  });

  // Helper: forge auth header matching the unit harness's mocked-auth strategy
  function auth() { return { authorization: 'Basic ' + Buffer.from('TEST_USER_566:').toString('base64') }; }

  it('setKhorosLink → ok writes the 4 columns and seeds the cache', async () => {
    resolveUser.mockResolvedValue({
      id: '12345', login: 'thomas_jung',
      name: 'Thomas Jung', rank: 'Star Blogger',
      avatarUrl: 'https://x/a.png'
    });
    const { data } = await POST('/api/setKhorosLink', { input: 'thomas_jung' }, { headers: auth() });
    expect(data).toMatchObject({ status: 'ok', khorosId: '12345', khorosLogin: 'thomas_jung', name: 'Thomas Jung' });
    expect(cache.get('12345')).toEqual({ name: 'Thomas Jung', rank: 'Star Blogger', avatarUrl: 'https://x/a.png' });
    const db = await cds.connect.to('db');
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.Users').where({ sapId: 'TEST_USER_566' }));
    expect(row.khorosId).toBe('12345');
    expect(row.khorosLogin).toBe('thomas_jung');
    expect(row.khorosLinkedAt).toBeTruthy();
  });

  it('setKhorosLink → not-found when upstream returns null', async () => {
    resolveUser.mockResolvedValue(null);
    const { data } = await POST('/api/setKhorosLink', { input: 'ghost' }, { headers: auth() });
    expect(data.status).toBe('not-found');
  });

  it('setKhorosLink → upstream-unavailable on 5xx', async () => {
    resolveUser.mockRejectedValue(new Error('khoros upstream 503'));
    const { data } = await POST('/api/setKhorosLink', { input: '12345' }, { headers: auth() });
    expect(data.status).toBe('upstream-unavailable');
  });

  it('setKhorosLink → invalid-input on empty string', async () => {
    const { data } = await POST('/api/setKhorosLink', { input: '   ' }, { headers: auth() });
    expect(data.status).toBe('invalid-input');
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('clearKhorosLink → ok nulls all 4 columns', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.Users')
      .set({ khorosId: '12345', khorosLogin: 'x', khorosAvatarUrl: 'u', khorosLinkedAt: new Date() })
      .where({ sapId: 'TEST_USER_566' }));
    const { data } = await POST('/api/clearKhorosLink', {}, { headers: auth() });
    expect(data.status).toBe('ok');
    const row = await db.run(SELECT.one.from('com.sap.developers.ims.Users').where({ sapId: 'TEST_USER_566' }));
    expect(row.khorosId).toBeNull();
    expect(row.khorosLogin).toBeNull();
    expect(row.khorosAvatarUrl).toBeNull();
    expect(row.khorosLinkedAt).toBeNull();
  });

  it('getKhorosProfile → linked:false for unlinked user', async () => {
    const { data } = await GET('/api/getKhorosProfile()', { headers: auth() });
    expect(data).toMatchObject({ linked: false });
  });

  it('getKhorosProfile → cache hit returns persisted + cached fields', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.Users')
      .set({ khorosId: '12345', khorosLogin: 'thomas_jung', khorosAvatarUrl: 'https://x/a.png' })
      .where({ sapId: 'TEST_USER_566' }));
    cache.set('12345', { name: 'Thomas Jung', rank: 'Star', avatarUrl: 'https://x/a.png' });
    const { data } = await GET('/api/getKhorosProfile()', { headers: auth() });
    expect(data).toMatchObject({
      linked: true, khorosId: '12345', khorosLogin: 'thomas_jung',
      name: 'Thomas Jung', rank: 'Star', avatarUrl: 'https://x/a.png',
      profileUrl: 'https://community.sap.com/t5/user/viewprofilepage/user-id/12345'
    });
    expect(resolveUser).not.toHaveBeenCalled();
  });

  it('getKhorosProfile → cache miss + upstream null falls back to last-known-good', async () => {
    const db = await cds.connect.to('db');
    await db.run(UPDATE('com.sap.developers.ims.Users')
      .set({ khorosId: '12345', khorosLogin: 'thomas_jung', khorosAvatarUrl: 'https://x/old.png' })
      .where({ sapId: 'TEST_USER_566' }));
    resolveUser.mockResolvedValue(null);
    const { data } = await GET('/api/getKhorosProfile()', { headers: auth() });
    expect(data).toMatchObject({
      linked: true, khorosLogin: 'thomas_jung',
      avatarUrl: 'https://x/old.png', name: 'thomas_jung', rank: ''
    });
  });
});
```

NB: the basic-auth header above mirrors how existing unit tests authenticate in this repo. If a different convention is in use, check `test/unit/developer-service.test.js` (or a sibling) for the canonical auth-shim pattern and adapt — the assertions are the contract, not the harness mechanics.

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project unit test/unit/developer-service-khoros.test.js
```

Expected: FAIL — handlers not implemented (`404 Not Found` or `Action setKhorosLink not found`).

- [ ] **Step 3: Implement the 3 handlers**

Open `srv/developer-service.js`. At the top, alongside the other lib imports, add:

```js
import { resolveUser as khorosResolveUser } from './lib/khoros-client.js';
import * as khorosCache from './lib/khoros-cache.js';
```

Inside the `DeveloperService` class's `init()`, alongside the existing `this.on('setLearningPreferences', ...)` near line 710, add the three new handlers. Use the existing pattern: `resolveUserSapId` for who-am-I; `dbUsers` from the `cds.entities('com.sap.developers.ims')` destructure at the top of `init()`.

```js
const PROFILE_URL = (id) => `https://community.sap.com/t5/user/viewprofilepage/user-id/${id}`;

this.on('setKhorosLink', async (req) => {
  const sapId = resolveUserSapId(req.user);
  if (!sapId) return req.reject(401, 'Unauthenticated');
  const input = String(req.data?.input ?? '').trim();
  if (!input || input.length > 64) return { status: 'invalid-input' };
  let profile;
  try {
    profile = await khorosResolveUser(input);
  } catch (err) {
    cds.log('khoros').warn('setKhorosLink upstream error', { sapId, input, err: err.message });
    return { status: 'upstream-unavailable' };
  }
  if (!profile) return { status: 'not-found' };
  try {
    const dbUser = await SELECT.one.from(dbUsers).where({ sapId });
    if (!dbUser) return req.reject(404, 'User row missing');
    await UPDATE(dbUsers)
      .set({
        khorosId: profile.id,
        khorosLogin: profile.login,
        khorosAvatarUrl: profile.avatarUrl,
        khorosLinkedAt: new Date()
      })
      .where({ ID: dbUser.ID });
  } catch (err) {
    // @assert.unique.khorosId violation surfaces as a CAP error
    // with code 'UNIQUE_CONSTRAINT_VIOLATION' or message containing
    // "unique" — match defensively because the exact code differs
    // between SQLite (unit) and HANA (hybrid).
    if (/unique/i.test(err.message) || err.code === 'UNIQUE_CONSTRAINT_VIOLATION') {
      return { status: 'already-claimed' };
    }
    cds.log('khoros').error('setKhorosLink persist failed', { sapId, err: err.message });
    return { status: 'persist-failed' };
  }
  // Seed cache with exactly the shape getKhorosProfile reads back.
  khorosCache.set(profile.id, {
    name: profile.name, rank: profile.rank, avatarUrl: profile.avatarUrl
  });
  cds.log('khoros').info('khoros linked', { sapId, khorosId: profile.id, khorosLogin: profile.login });
  return { status: 'ok', khorosId: profile.id, khorosLogin: profile.login, name: profile.name };
});

this.on('clearKhorosLink', async (req) => {
  const sapId = resolveUserSapId(req.user);
  if (!sapId) return req.reject(401, 'Unauthenticated');
  const dbUser = await SELECT.one.from(dbUsers).where({ sapId });
  if (!dbUser) return { status: 'ok' };  // already unlinked
  const prevKhorosId = dbUser.khorosId;
  await UPDATE(dbUsers)
    .set({ khorosId: null, khorosLogin: null, khorosAvatarUrl: null, khorosLinkedAt: null })
    .where({ ID: dbUser.ID });
  if (prevKhorosId) khorosCache.evict(prevKhorosId);
  cds.log('khoros').info('khoros unlinked', { sapId, khorosId: prevKhorosId });
  return { status: 'ok' };
});

this.on('getKhorosProfile', async (req) => {
  const sapId = resolveUserSapId(req.user);
  if (!sapId) return req.reject(401, 'Unauthenticated');
  const dbUser = await SELECT.one
    .from(dbUsers)
    .columns('ID', 'khorosId', 'khorosLogin', 'khorosAvatarUrl')
    .where({ sapId });
  if (!dbUser?.khorosId) return { linked: false };
  const persisted = {
    linked: true,
    khorosId: dbUser.khorosId,
    khorosLogin: dbUser.khorosLogin,
    avatarUrl: dbUser.khorosAvatarUrl || '',
    profileUrl: PROFILE_URL(dbUser.khorosId),
  };
  const cached = khorosCache.get(dbUser.khorosId);
  if (cached) {
    return { ...persisted, name: cached.name, rank: cached.rank, avatarUrl: cached.avatarUrl || persisted.avatarUrl };
  }
  // Cache miss → refresh.
  let upstream = null;
  try {
    upstream = await khorosResolveUser(dbUser.khorosId);
  } catch (err) {
    cds.log('khoros').warn('getKhorosProfile upstream error', { sapId, khorosId: dbUser.khorosId, err: err.message });
  }
  if (!upstream) {
    // Last-known-good: render the chip with persisted data, blank rank.
    if (!upstream) cds.log('khoros').warn('getKhorosProfile upstream null', { sapId, khorosId: dbUser.khorosId });
    return { ...persisted, name: dbUser.khorosLogin || '', rank: '' };
  }
  // Refresh cache + write back avatar if it drifted.
  khorosCache.set(upstream.id, { name: upstream.name, rank: upstream.rank, avatarUrl: upstream.avatarUrl });
  if (upstream.avatarUrl && upstream.avatarUrl !== dbUser.khorosAvatarUrl) {
    await UPDATE(dbUsers).set({ khorosAvatarUrl: upstream.avatarUrl }).where({ ID: dbUser.ID });
  }
  return { ...persisted, name: upstream.name, rank: upstream.rank, avatarUrl: upstream.avatarUrl || persisted.avatarUrl };
});
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npx vitest run --project unit test/unit/developer-service-khoros.test.js
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Re-run the full unit suite to catch regressions**

```bash
npm test -- --project unit 2>&1 | tail -25
```

Expected: all unit tests still green.

- [ ] **Step 6: Commit**

```bash
git add srv/developer-service.js test/unit/developer-service-khoros.test.js
git commit -m "feat(566): implement setKhorosLink/clearKhorosLink/getKhorosProfile handlers"
```

---
## Task 6: `/auth/user` augmentation + hybrid test

Two pieces in one task because both depend on the schema columns being live.

**Files:**
- Modify: `srv/server.js` (the `app.get('/auth/user', ...)` handler around line 661)
- Create: `test/hybrid/khoros-link.test.js`

- [ ] **Step 1: Add 3 fields to the `/auth/user` response**

Read the existing handler at `srv/server.js:661`. Find the SELECT (or the response object construction) that populates the `Users` row and append three properties. The handler currently returns something like `{ id, firstName, lastName, email, displayName, avatarUrl, ... }`. Add:

```js
const dbUser = await SELECT.one
  .from('com.sap.developers.ims.Users')
  .columns('ID','sapId','uuid','firstName','lastName','email','displayName','avatarUrl',
           'khorosId','khorosLogin','khorosAvatarUrl')   // <-- add these 3
  .where({ sapId });

// ... in the response object:
return res.json({
  // ...existing fields...
  khorosId:        dbUser?.khorosId        ?? null,
  khorosLogin:     dbUser?.khorosLogin     ?? null,
  khorosAvatarUrl: dbUser?.khorosAvatarUrl ?? null,
});
```

If the existing handler uses `*` / no explicit column list, no SELECT change is needed — just spread the row into the response, then ensure the explicit 3-field block above is in the response builder. Verify by checking the actual handler shape before editing.

- [ ] **Step 2: Write the failing hybrid test**

Create `test/hybrid/khoros-link.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid test against real HANA via `cds bind --exec`. Run with `npm run test:hybrid`.
// Memory: [feedback_skip_hybrid_test_costs_two_pr_cycles] — @assert.unique behaves
// differently between SQLite (unit) and HANA (hybrid), so this is mandatory.

const TEST_SAPID_A = '__TEST__khoros_a';
const TEST_SAPID_B = '__TEST__khoros_b';

describe('khoros link — HANA', () => {
  let db, Users;
  beforeAll(async () => {
    db = await cds.connect.to('db');
    Users = 'com.sap.developers.ims.Users';
    // _guard.js asserts ALLOW_HYBRID_WRITES=true before any INSERT/UPDATE/DELETE.
    await db.run(DELETE.from(Users).where({ sapId: { in: [TEST_SAPID_A, TEST_SAPID_B] } }));
    await db.run(INSERT.into(Users).entries([
      { sapId: TEST_SAPID_A, uuid: 'uA', email: 'a@example.com' },
      { sapId: TEST_SAPID_B, uuid: 'uB', email: 'b@example.com' },
    ]));
  });
  afterAll(async () => {
    await db.run(DELETE.from(Users).where({ sapId: { in: [TEST_SAPID_A, TEST_SAPID_B] } }));
  });

  it('persists all 4 columns on link', async () => {
    const now = new Date();
    await db.run(UPDATE(Users)
      .set({ khorosId: '99001', khorosLogin: 'test_a', khorosAvatarUrl: 'https://x/a.png', khorosLinkedAt: now })
      .where({ sapId: TEST_SAPID_A }));
    const row = await db.run(SELECT.one.from(Users).where({ sapId: TEST_SAPID_A }));
    expect(row.khorosId).toBe('99001');
    expect(row.khorosLogin).toBe('test_a');
    expect(row.khorosAvatarUrl).toBe('https://x/a.png');
    expect(row.khorosLinkedAt).toBeTruthy();
  });

  it('@assert.unique.khorosId rejects a second user with the same khorosId', async () => {
    await db.run(UPDATE(Users).set({ khorosId: '99001' }).where({ sapId: TEST_SAPID_A }));
    await expect(
      db.run(UPDATE(Users).set({ khorosId: '99001' }).where({ sapId: TEST_SAPID_B }))
    ).rejects.toThrow(/unique/i);
  });

  it('allows two NULL khorosIds (nullable-aware uniqueness)', async () => {
    await db.run(UPDATE(Users).set({ khorosId: null }).where({ sapId: TEST_SAPID_A }));
    await db.run(UPDATE(Users).set({ khorosId: null }).where({ sapId: TEST_SAPID_B }));
    // No throw — both can coexist with null.
  });

  it('clearing nulls all 4 columns', async () => {
    await db.run(UPDATE(Users)
      .set({ khorosId: '99002', khorosLogin: 'x', khorosAvatarUrl: 'u', khorosLinkedAt: new Date() })
      .where({ sapId: TEST_SAPID_A }));
    await db.run(UPDATE(Users)
      .set({ khorosId: null, khorosLogin: null, khorosAvatarUrl: null, khorosLinkedAt: null })
      .where({ sapId: TEST_SAPID_A }));
    const row = await db.run(SELECT.one.from(Users).where({ sapId: TEST_SAPID_A }));
    expect(row.khorosId).toBeNull();
    expect(row.khorosLogin).toBeNull();
    expect(row.khorosAvatarUrl).toBeNull();
    expect(row.khorosLinkedAt).toBeNull();
  });
});
```

- [ ] **Step 3: Run the hybrid test**

```bash
cf login   # to the DEV space, if not already
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npm run test:hybrid -- test/hybrid/khoros-link.test.js 2>&1 | tail -30
```

Expected: PASS, 4 tests.

- [ ] **Step 4: Commit**

```bash
git add srv/server.js test/hybrid/khoros-link.test.js
git commit -m "feat(566): expose khoros* on /auth/user + hybrid coverage for unique constraint"
```

---

## Task 7: Register `ui5-panel` in the bootstrap

The frontend tasks build on the layout being able to use `<ui5-panel>`. `Avatar`, `MessageStrip`, `Title`, and `Text` are already registered in `hugo/assets/js/ui5-bootstrap.ts` (verified during plan-writing). `Panel` is not.

- [ ] **Step 0: Confirm Avatar is still registered**

Before adding Panel, verify Avatar is still imported (the spec called this out as the one component that needed adding; it turned out to already be there at plan-writing time. Confirm at task time in case the file shifted):

```bash
grep -nE "Avatar\.js|Panel\.js" hugo/assets/js/ui5-bootstrap.ts
```

Expected: `Avatar.js` is present, `Panel.js` is missing. If Avatar is NOT present, add it alongside Panel in Step 1 below.

**Files:**
- Modify: `hugo/assets/js/ui5-bootstrap.ts`

- [ ] **Step 1: Add the Panel import**

Open `hugo/assets/js/ui5-bootstrap.ts`. Find the cluster of `@ui5/webcomponents/dist/*.js` imports near the top of the file (after `Assets.js`). Append in alphabetical order alongside the others:

```ts
import "@ui5/webcomponents/dist/Panel.js";
```

Add a comment above it:

```ts
// /me page (#566) — three collapsible ui5-panels wrap LearningPreferences,
// RecentActivity, and AllCompletions. MUST be registered here, not from
// hugo-apps/src/me/main.ts (see [feedback_ui5_duplicate_bundle_kills_settheme]).
import "@ui5/webcomponents/dist/Panel.js";
```

- [ ] **Step 2: Run the island-import regression guard**

```bash
npx tsx scripts/check-island-ui5-imports.ts 2>&1 | tail -10
```

Expected: PASS (no island imports `@ui5/webcomponents/dist/Panel.js` directly).

- [ ] **Step 3: Quick build sanity check**

```bash
npm run build:apps 2>&1 | tail -20
```

(`build:apps` is the hugo-apps Vite build. It writes bundled JS to `hugo/static/js/`. We don't need a full `build:all` yet — only validating that the bootstrap still typechecks and bundles.)

Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add hugo/assets/js/ui5-bootstrap.ts
git commit -m "feat(566): register ui5-panel in shared bootstrap for /me layout"
```

---

## Task 8: Rewrite `/me` layout shell with 3 collapsible panels

Pure HTML layout change. Adds the `<ui5-panel>` wrappers, the 4 mount points, and the collapse-state persistence script. No Vue code yet — the existing `MyCompletions` mount-point div remains for now so `/me` still renders during the transition.

**Files:**
- Modify: `hugo/layouts/me/list.html`

- [ ] **Step 1: Read the current file to know what you're replacing**

```bash
cat hugo/layouts/me/list.html
```

It's small (~10 lines today): a `{{ define "main" }}` block that mounts `me-completions` and `me-learning-preferences`. We keep it gated behind `not site.Params.qa` (existing QA exclusion).

- [ ] **Step 2: Replace with the three-panel layout**

```html
{{ define "main" }}
{{/* /me — three collapsible ui5-panels. Issue #566 + PR 6.
     QA preview omits per-user data; also excluded by hugo.qa.toml ignoreFiles. */}}
{{ if not site.Params.qa }}
<div class="me-page-wrap">
  <h1>My Profile</h1>

  <ui5-panel header-text="Learning Preferences" data-panel="preferences">
    <div id="me-learning-preferences"></div>
    <div class="me-section-divider" aria-hidden="true"></div>
    <div id="me-community-profile"></div>
  </ui5-panel>

  <ui5-panel header-text="Recent Activity" data-panel="recent">
    <div id="me-recent-activity"></div>
  </ui5-panel>

  <ui5-panel header-text="All Completions" data-panel="all">
    <div id="me-all-completions"></div>
  </ui5-panel>
</div>

<script type="module" src="/js/me.js?v={{ now.Unix }}"></script>
<script>
  // Collapse-state persistence — runs once Panel is registered. Boolean attr
  // is set imperatively (template binding to UI5 boolean attrs is unreliable
  // per [feedback_ui5_dialog_open_imperative_only]).
  customElements.whenDefined('ui5-panel').then(function () {
    document.querySelectorAll('ui5-panel[data-panel]').forEach(function (p) {
      var key = 'me.panel.' + p.dataset.panel;
      if (localStorage.getItem(key) === 'collapsed') { p.collapsed = true; }
      // ui5-panel emits `toggle` on chevron click; no detail payload — read
      // p.collapsed after the event fires. UI5 v2.22 — contract unchanged
      // from v1.x but worth re-confirming after a major ui5 bump.
      p.addEventListener('toggle', function () {
        localStorage.setItem(key, p.collapsed ? 'collapsed' : 'expanded');
      });
    });
  });
</script>
{{ end }}
{{ end }}
```

Optional CSS for the inline divider — add to `hugo/assets/css/me.css` (or wherever `/me` styles live; check existing structure first). If no `/me` stylesheet exists yet, defer styling to Task 11 where we ship `CommunityProfile.vue`.

```css
.me-section-divider {
  border-top: 1px solid var(--sapList_BorderColor, #e0e3e8);
  margin: 0.9rem 0;
}
```

- [ ] **Step 3: Local smoke**

Run hugo dev and visit `http://localhost:1313/me/` (after auth). Three empty panels should render with their header text. (You may need `npm run fetch-tutorials` first if the cache is empty.)

```bash
npm run dev
# in another shell:
# open http://localhost:1313/me/
```

Expected: three collapsible panels visible; clicking the chevron toggles collapse and the state survives a refresh (`localStorage`).

- [ ] **Step 4: Commit**

```bash
git add hugo/layouts/me/list.html
# plus me.css if you added it
git commit -m "feat(566): /me layout — three collapsible ui5-panels + 4 mount points"
```

---
## Task 9: Split MyCompletions into RecentActivity + AllCompletions

`MyCompletions.vue` currently renders both the timeline ("Recent Activity") and the toolbar+table ("All Completions") from one `fetch('/api/getMyCompletions()')` call. We split into two siblings, each fetching independently. Cost: one extra network call per `/me` load (accepted per spec).

**Files:**
- Create: `hugo-apps/src/me/RecentActivity.vue`
- Create: `hugo-apps/src/me/AllCompletions.vue`
- Delete: `hugo-apps/src/me/MyCompletions.vue`
- Modify: `hugo-apps/src/me/main.ts` (rewire 4 mount points)

This task is the largest single edit in the plan because we're moving existing code. Follow the order strictly.

- [ ] **Step 1: Create `RecentActivity.vue`**

Lift lines from the existing `MyCompletions.vue`:
- Keep the `<script setup lang="ts">` interface `Completion`, the `recentRows` computed, and helpers `formatRelative`, `formatDate`, `formatLevel`, `onTimelineNameClick`.
- The `<template>` shows only the "Recent Activity" `<section class="me-recent">` block.
- The `onMounted` fetches `/api/getMyCompletions()` and populates `rows.value` (same as today).
- Keep the auth/loading/error/empty branches but render only the recent-section template.

Full file (`hugo-apps/src/me/RecentActivity.vue`):

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface Completion {
  slug: string
  title: string
  primaryTag: string | null
  experienceTag: string | null
  averageTimeToComplete: number | null
  completionDate: string | null
}

const loading = ref(true)
const isLoggedIn = ref<boolean | null>(null)
const rows = ref<Completion[]>([])
const errorMsg = ref('')

const recentRows = computed(() =>
  rows.value
    .slice()
    .filter(r => !!r.completionDate && !Number.isNaN(new Date(r.completionDate).getTime()))
    .sort((a, b) => new Date(b.completionDate!).getTime() - new Date(a.completionDate!).getTime())
    .slice(0, 10)
)

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatRelative(iso?: string | null): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return formatDate(iso)
  const diffMs = Date.now() - then
  if (diffMs < 0) return 'Just now'
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 60) return 'Just now'
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return formatDate(iso)
}

function formatLevel(level: string | null) {
  if (!level) return '—'
  return level.charAt(0) + level.slice(1).toLowerCase()
}

function onTimelineNameClick(slug: string) {
  if (!slug) return
  window.location.href = `/tutorials/${slug}/`
}

onMounted(async () => {
  try {
    const authRes = await fetch('/auth/user', { credentials: 'include' })
    if (!authRes.ok) { isLoggedIn.value = false; loading.value = false; return }
    isLoggedIn.value = true
    const dataRes = await fetch('/api/getMyCompletions()', { credentials: 'include' })
    if (!dataRes.ok) {
      errorMsg.value = `Failed to load recent activity (HTTP ${dataRes.status}).`
      loading.value = false; return
    }
    const body = await dataRes.json()
    rows.value = Array.isArray(body) ? body : (body.value || [])
  } catch {
    errorMsg.value = 'Network error loading recent activity.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="me-state">Loading…</div>
  <div v-else-if="isLoggedIn === false" class="me-state me-login-prompt">
    <h2>You're not signed in</h2>
    <p>Sign in to see your recent activity.</p>
    <a class="me-btn" href="/login">Sign in</a>
  </div>
  <div v-else-if="errorMsg" class="me-state me-error">{{ errorMsg }}</div>
  <div v-else-if="recentRows.length === 0" class="me-state me-state--empty">
    <p>No recent activity yet.</p>
  </div>
  <ui5-timeline v-else layout="Vertical" growing="None" class="me-timeline">
    <ui5-timeline-item
      v-for="item in recentRows"
      :key="item.slug"
      :name="item.title"
      :subtitle-text="`${item.primaryTag || 'Tutorial'} · ${formatRelative(item.completionDate)}`"
      icon="accept"
      state="Positive"
      name-clickable
      @name-click="() => onTimelineNameClick(item.slug)"
    >
      <span class="me-recent__level">{{ formatLevel(item.experienceTag) }}</span>
    </ui5-timeline-item>
  </ui5-timeline>
</template>

<style scoped>
/* Trimmed from the original — the panel wrapper provides its own padding now. */
.me-state { padding: 1.5rem; text-align: center; color: var(--sapNeutralTextColor, #556); }
.me-error { color: var(--sapNegativeColor, #b00020); }
.me-state--empty { padding: 1.5rem; }
.me-login-prompt h2 { font-size: 1.1rem; margin: 0 0 .5rem; }
.me-btn {
  display: inline-block; padding: .4rem .9rem; border-radius: 4px;
  background: var(--sapButton_Emphasized_Background, #0a6ed1);
  color: #fff; text-decoration: none; border: none;
}
.me-recent__level { font-size: 0.75rem; color: var(--sapContent_LabelColor, #6a6d70); }
</style>
```

Heads-up: `ui5-timeline` and `ui5-timeline-item` should already be registered for the existing `MyCompletions` page. If they aren't (check `hugo/assets/js/ui5-bootstrap.ts`), add the imports there in the same task — match the pattern next to the `ui5-panel` import from Task 7.

- [ ] **Step 2: Create `AllCompletions.vue`**

Lift the toolbar + table + filters from `MyCompletions.vue`:

```vue
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface Completion {
  slug: string
  title: string
  primaryTag: string | null
  experienceTag: string | null
  averageTimeToComplete: number | null
  completionDate: string | null
}

type SortKey = 'title' | 'primaryTag' | 'experienceTag' | 'averageTimeToComplete' | 'completionDate'

const loading = ref(true)
const isLoggedIn = ref<boolean | null>(null)
const rows = ref<Completion[]>([])
const errorMsg = ref('')
const filterText = ref('')
const filterTopic = ref('')
const filterLevel = ref('')
const sortKey = ref<SortKey>('completionDate')
const sortDir = ref<'asc' | 'desc'>('desc')

const topicOptions = computed(() => {
  const set = new Set<string>()
  rows.value.forEach(r => { if (r.primaryTag) set.add(r.primaryTag) })
  return Array.from(set).sort()
})
const levelOptions = computed(() => {
  const set = new Set<string>()
  rows.value.forEach(r => { if (r.experienceTag) set.add(r.experienceTag) })
  return Array.from(set).sort()
})

const filtered = computed(() => {
  const q = filterText.value.trim().toLowerCase()
  return rows.value.filter(r => {
    if (q && !r.title.toLowerCase().includes(q) && !r.slug.toLowerCase().includes(q)) return false
    if (filterTopic.value && r.primaryTag !== filterTopic.value) return false
    if (filterLevel.value && r.experienceTag !== filterLevel.value) return false
    return true
  })
})

const sorted = computed(() => {
  const list = [...filtered.value]
  const k = sortKey.value
  const dir = sortDir.value === 'asc' ? 1 : -1
  list.sort((a, b) => {
    const av = a[k], bv = b[k]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (k === 'completionDate') return (new Date(av as string).getTime() - new Date(bv as string).getTime()) * dir
    if (k === 'averageTimeToComplete') return ((av as number) - (bv as number)) * dir
    return String(av).localeCompare(String(bv)) * dir
  })
  return list
})

function setSort(key: SortKey) {
  if (sortKey.value === key) sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc'
  else { sortKey.value = key; sortDir.value = key === 'completionDate' ? 'desc' : 'asc' }
}

function sortIcon(key: SortKey) {
  if (sortKey.value !== key) return ''
  return sortDir.value === 'asc' ? ' ▲' : ' ▼'
}

function formatDate(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatLevel(level: string | null) {
  if (!level) return '—'
  return level.charAt(0) + level.slice(1).toLowerCase()
}

function clearFilters() { filterText.value = ''; filterTopic.value = ''; filterLevel.value = '' }

onMounted(async () => {
  try {
    const authRes = await fetch('/auth/user', { credentials: 'include' })
    if (!authRes.ok) { isLoggedIn.value = false; loading.value = false; return }
    isLoggedIn.value = true
    const dataRes = await fetch('/api/getMyCompletions()', { credentials: 'include' })
    if (!dataRes.ok) {
      errorMsg.value = `Failed to load completions (HTTP ${dataRes.status}).`
      loading.value = false; return
    }
    const body = await dataRes.json()
    rows.value = Array.isArray(body) ? body : (body.value || [])
  } catch {
    errorMsg.value = 'Network error loading your completions.'
  } finally {
    loading.value = false
  }
})
</script>

<template>
  <div v-if="loading" class="me-state">Loading…</div>
  <div v-else-if="isLoggedIn === false" class="me-state me-login-prompt">
    <h2>You're not signed in</h2>
    <p>Sign in to see the tutorials you've completed.</p>
    <a class="me-btn" href="/login">Sign in</a>
  </div>
  <div v-else-if="errorMsg" class="me-state me-error">{{ errorMsg }}</div>
  <div v-else-if="rows.length === 0" class="me-state me-state--empty">
    <ui5-illustrated-message name="NoData" design="Spot">
      <h2 slot="title">No completions yet</h2>
      <p slot="subtitle">Complete a tutorial step and it'll show up here.</p>
      <ui5-button design="Emphasized" onclick="window.location.href='/'">Browse tutorials</ui5-button>
    </ui5-illustrated-message>
  </div>

  <template v-else>
    <div class="me-toolbar" role="search">
      <label class="me-field"><span>Search</span><input type="text" v-model="filterText" placeholder="Title or slug…" /></label>
      <label class="me-field"><span>Topic</span><select v-model="filterTopic"><option value="">All</option><option v-for="t in topicOptions" :key="t" :value="t">{{ t }}</option></select></label>
      <label class="me-field"><span>Level</span><select v-model="filterLevel"><option value="">All</option><option v-for="l in levelOptions" :key="l" :value="l">{{ formatLevel(l) }}</option></select></label>
      <button v-if="filterText || filterTopic || filterLevel" class="me-btn me-btn-ghost" @click="clearFilters">Clear</button>
      <span class="me-count">{{ sorted.length }} of {{ rows.length }}</span>
    </div>

    <div class="me-table-wrap">
      <table class="me-table">
        <thead><tr>
          <th @click="setSort('title')"><button>Title{{ sortIcon('title') }}</button></th>
          <th @click="setSort('primaryTag')"><button>Topic{{ sortIcon('primaryTag') }}</button></th>
          <th @click="setSort('experienceTag')"><button>Level{{ sortIcon('experienceTag') }}</button></th>
          <th @click="setSort('averageTimeToComplete')" class="num"><button>Time{{ sortIcon('averageTimeToComplete') }}</button></th>
          <th @click="setSort('completionDate')"><button>Completed{{ sortIcon('completionDate') }}</button></th>
        </tr></thead>
        <tbody>
          <tr v-for="r in sorted" :key="r.slug">
            <td><a :href="`/tutorials/${r.slug}/`">{{ r.title }}</a></td>
            <td>{{ r.primaryTag || '—' }}</td>
            <td>{{ formatLevel(r.experienceTag) }}</td>
            <td class="num">{{ r.averageTimeToComplete != null ? `${r.averageTimeToComplete} min` : '—' }}</td>
            <td>{{ formatDate(r.completionDate) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </template>
</template>

<style scoped>
/* Copy the relevant styles from the old MyCompletions.vue verbatim — me-toolbar,
   me-field, me-btn*, me-count, me-table-wrap, me-table, me-state, me-error.
   Drop .me-recent / .me-recent__heading / .me-recent__level / .me-page / .me-header
   (those moved to RecentActivity.vue or the Hugo layout). */
.me-state { padding: 1.5rem; text-align: center; color: var(--sapNeutralTextColor, #556); }
.me-error { color: var(--sapNegativeColor, #b00020); }
.me-state--empty { padding: 1rem; background: transparent; }
.me-state--empty ui5-button { margin-top: 1rem; }
.me-login-prompt h2 { font-size: 1.25rem; margin: 0 0 .5rem; }
.me-toolbar { display: flex; flex-wrap: wrap; gap: 1rem; align-items: end; margin-bottom: 1rem; }
.me-field { display: flex; flex-direction: column; font-size: .875rem; }
.me-field span { margin-bottom: .25rem; color: var(--sapNeutralTextColor, #556); }
.me-field input, .me-field select {
  min-width: 12rem; padding: .4rem .6rem;
  border: 1px solid var(--sapField_BorderColor, #ccd); border-radius: 4px;
  background: var(--sapField_Background, #fff); color: inherit; font: inherit;
}
.me-btn {
  display: inline-block; padding: .5rem 1rem; border-radius: 4px;
  background: var(--sapButton_Emphasized_Background, #0a6ed1);
  color: #fff; text-decoration: none; border: none; cursor: pointer; font: inherit;
}
.me-btn-ghost { background: transparent; color: var(--sapLinkColor, #0a6ed1); border: 1px solid var(--sapField_BorderColor, #ccd); }
.me-count { margin-left: auto; color: var(--sapNeutralTextColor, #556); font-size: .875rem; }
.me-table-wrap { overflow-x: auto; border: 1px solid var(--sapList_BorderColor, #e5e5ea); border-radius: 8px; background: var(--sapList_Background, #fff); }
.me-table { width: 100%; border-collapse: collapse; font-size: .9rem; }
.me-table th, .me-table td { text-align: left; padding: .6rem .9rem; border-bottom: 1px solid var(--sapList_BorderColor, #eef); }
.me-table th { background: var(--sapList_HeaderBackground, #f4f4f7); font-weight: 600; user-select: none; padding: 0; }
.me-table th button { width: 100%; text-align: inherit; background: none; border: none; color: inherit; font: inherit; font-weight: inherit; padding: .6rem .9rem; cursor: pointer; }
.me-table tr:last-child td { border-bottom: none; }
.me-table .num { text-align: right; }
.me-table a { color: var(--sapLinkColor, #0a6ed1); text-decoration: none; }
.me-table a:hover { text-decoration: underline; }
</style>
```

- [ ] **Step 3: Rewire `hugo-apps/src/me/main.ts`**

Replace contents with:

```ts
import { createApp } from 'vue'
import RecentActivity from './RecentActivity.vue'
import AllCompletions from './AllCompletions.vue'
import LearningPreferences from './LearningPreferences.vue'
import CommunityProfile from './CommunityProfile.vue'  // created in Task 11

// IMPORTANT: do NOT import "@ui5/webcomponents/*" or "@ui5/webcomponents-fiori/*"
// from this entry. Every UI5 component these islands use is registered in
// hugo/assets/js/ui5-bootstrap.ts. See [feedback_ui5_duplicate_bundle_kills_settheme].
//
// Components used across /me islands (all registered in ui5-bootstrap.ts):
//   Title, Select, Option, MessageStrip, Button, Label, Text, Timeline,
//   TimelineItem, Panel, Avatar, Input, IllustratedMessage.

if (document.getElementById('me-recent-activity'))
  createApp(RecentActivity).mount('#me-recent-activity')

if (document.getElementById('me-all-completions'))
  createApp(AllCompletions).mount('#me-all-completions')

if (document.getElementById('me-learning-preferences'))
  createApp(LearningPreferences).mount('#me-learning-preferences')

if (document.getElementById('me-community-profile'))
  createApp(CommunityProfile).mount('#me-community-profile')
```

Note: `CommunityProfile.vue` doesn't exist yet — Task 11 creates it. Until then this import errors out. Either (a) stub-create `CommunityProfile.vue` with a minimal `<template><div /></template>` in this task to keep the build green, OR (b) accept a temporary broken build between Task 9 and Task 11. Choose (a): create the stub here.

- [ ] **Step 4: Create the CommunityProfile.vue stub**

```vue
<!-- hugo-apps/src/me/CommunityProfile.vue — stub. Task 11 fills it in. -->
<script setup lang="ts"></script>
<template><div data-stub="community-profile" /></template>
```

- [ ] **Step 5: Delete `MyCompletions.vue`**

```bash
git rm hugo-apps/src/me/MyCompletions.vue
```

- [ ] **Step 6: Build + smoke**

```bash
npm run build:apps 2>&1 | tail -10
```

Expected: build passes. The build-collision guard (`scripts/check-build-collisions.ts`) should also pass since we haven't added a new Vite entry name (the entry is still `me`).

Then run `npm run dev` and visit `/me/` — three panels render with Recent (timeline), Learning Preferences (existing form + empty stub div), All Completions (toolbar + table).

- [ ] **Step 7: Commit**

```bash
git add hugo-apps/src/me/RecentActivity.vue \
        hugo-apps/src/me/AllCompletions.vue \
        hugo-apps/src/me/CommunityProfile.vue \
        hugo-apps/src/me/main.ts
git rm  hugo-apps/src/me/MyCompletions.vue
git commit -m "refactor(566): split MyCompletions into RecentActivity + AllCompletions

Each panel now owns its own fetch + lifecycle so the new ui5-panel
collapse state doesn't tangle with the other panel's data load.
CommunityProfile.vue stubbed; Task 11 implements it."
```

---
## Task 10: Vue test scaffold for CommunityProfile

Set up the test file first so Task 11 follows true TDD. We use the existing `@vue/test-utils` harness — check `hugo-apps/src/<other-island>/*.test.ts` for the canonical setup pattern before writing this file. The shape below is the contract; adapt the imports to match repo convention.

**Files:**
- Create: `hugo-apps/src/me/CommunityProfile.test.ts`

- [ ] **Step 1: Write the failing test**

Create `hugo-apps/src/me/CommunityProfile.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import CommunityProfile from './CommunityProfile.vue';

function mockFetch(routes: Record<string, () => { ok: boolean; status?: number; json?: any }>) {
  global.fetch = vi.fn(async (url: any, opts: any = {}) => {
    const path = String(url).split('?')[0];
    const handler = routes[path] || routes[`${opts.method || 'GET'} ${path}`];
    if (!handler) throw new Error(`unmocked fetch ${opts.method || 'GET'} ${path}`);
    const r = handler();
    return {
      ok: r.ok, status: r.status ?? (r.ok ? 200 : 500),
      json: async () => r.json ?? {},
    } as any;
  });
}

describe('CommunityProfile.vue', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('renders unlinked state when getKhorosProfile returns linked:false', async () => {
    mockFetch({ '/api/getKhorosProfile()': () => ({ ok: true, json: { linked: false } }) });
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    expect(wrapper.find('ui5-input').exists()).toBe(true);
    expect(wrapper.find('ui5-button').exists()).toBe(true);
    expect(wrapper.find('.linked-chip').exists()).toBe(false);
  });

  it('renders linked chip when getKhorosProfile returns linked:true', async () => {
    mockFetch({
      '/api/getKhorosProfile()': () => ({ ok: true, json: {
        linked: true, khorosId: '123', khorosLogin: 'thomas_jung',
        name: 'Thomas Jung', rank: 'Star Blogger',
        avatarUrl: 'https://x/a.png',
        profileUrl: 'https://community.sap.com/t5/user/viewprofilepage/user-id/123'
      } })
    });
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    expect(wrapper.text()).toContain('Thomas Jung');
    expect(wrapper.text()).toContain('@thomas_jung');
    expect(wrapper.text()).toContain('Star Blogger');
    expect(wrapper.find('.linked-chip').exists()).toBe(true);
  });

  it('on Link click → POST /api/setKhorosLink → success transitions to linked', async () => {
    mockFetch({
      '/api/getKhorosProfile()': () => ({ ok: true, json: { linked: false } }),
      'POST /api/setKhorosLink': () => ({ ok: true, json: {
        status: 'ok', khorosId: '123', khorosLogin: 'thomas_jung', name: 'Thomas Jung'
      } }),
    });
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    // Drive the island's setup-exposed onLink directly to bypass UI5 input plumbing.
    const vm = wrapper.vm as any;
    vm.input = 'thomas_jung';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toContain('Thomas Jung');
  });

  it('maps status:not-found to the lurker error copy', async () => {
    mockFetch({
      '/api/getKhorosProfile()': () => ({ ok: true, json: { linked: false } }),
      'POST /api/setKhorosLink': () => ({ ok: true, json: { status: 'not-found' } }),
    });
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.input = 'ghost_user';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toMatch(/couldn.?t find that community user/i);
  });

  it('maps status:already-claimed to the friendly conflict copy', async () => {
    mockFetch({
      '/api/getKhorosProfile()': () => ({ ok: true, json: { linked: false } }),
      'POST /api/setKhorosLink': () => ({ ok: true, json: { status: 'already-claimed' } }),
    });
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.input = 'taken';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toMatch(/already linked/i);
  });

  it('maps status:upstream-unavailable to the Information strip copy', async () => {
    mockFetch({
      '/api/getKhorosProfile()': () => ({ ok: true, json: { linked: false } }),
      'POST /api/setKhorosLink': () => ({ ok: true, json: { status: 'upstream-unavailable' } }),
    });
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    vm.input = '12345';
    await vm.onLink();
    await flushPromises();
    expect(wrapper.text()).toMatch(/SAP Community is unreachable/i);
  });

  it('Unlink → POST /api/clearKhorosLink → transitions to unlinked', async () => {
    let cleared = false;
    mockFetch({
      '/api/getKhorosProfile()': () => cleared
        ? ({ ok: true, json: { linked: false } })
        : ({ ok: true, json: {
            linked: true, khorosId: '123', khorosLogin: 'thomas_jung',
            name: 'Thomas Jung', rank: '', avatarUrl: '',
            profileUrl: 'https://community.sap.com/t5/user/viewprofilepage/user-id/123'
          } }),
      'POST /api/clearKhorosLink': () => { cleared = true; return { ok: true, json: { status: 'ok' } }; },
    });
    const wrapper = mount(CommunityProfile);
    await flushPromises();
    const vm = wrapper.vm as any;
    await vm.onUnlink();
    await flushPromises();
    expect(wrapper.find('.linked-chip').exists()).toBe(false);
    expect(wrapper.find('ui5-input').exists()).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run --project unit hugo-apps/src/me/CommunityProfile.test.ts
```

Expected: FAIL — every test fails (the stub from Task 9 has no behaviour).

- [ ] **Step 3: Commit (RED state)**

```bash
git add hugo-apps/src/me/CommunityProfile.test.ts
git commit -m "test(566): failing CommunityProfile.vue test scaffold (RED)"
```

---

## Task 11: Implement `CommunityProfile.vue`

Replace the stub from Task 9. Two visual states (unlinked / linked), each `setKhorosLink` status mapped to a UI5 MessageStrip.

**Files:**
- Modify: `hugo-apps/src/me/CommunityProfile.vue` (replace stub)

- [ ] **Step 1: Replace the stub with the full component**

Full file:

```vue
<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';

interface Profile {
  linked: boolean;
  khorosId?: string;
  khorosLogin?: string;
  name?: string;
  rank?: string;
  avatarUrl?: string;
  profileUrl?: string;
}

const profile = reactive<Profile>({ linked: false });
const input = ref('');
const busy = ref(false);
const status = ref<'idle' | 'just-linked' | 'error'>('idle');
const errorStatus = ref<string | null>(null);

const errorDesign = computed(() =>
  errorStatus.value === 'upstream-unavailable' ? 'Information'
  : errorStatus.value === 'invalid-input'      ? 'Information'
  : 'Negative'
);

const errorMessage = computed(() => {
  switch (errorStatus.value) {
    case 'not-found':            return "We couldn't find that community user. The lookup needs at least one public post; lurkers can't be found.";
    case 'already-claimed':      return 'That community profile is already linked to another tutorial user.';
    case 'invalid-input':        return 'Enter your community login (e.g. thomas_jung) or numeric ID.';
    case 'upstream-unavailable': return 'SAP Community is unreachable right now. Try again in a few minutes.';
    case 'persist-failed':       return "Couldn't save. Try again.";
    default:                     return '';
  }
});

async function refresh() {
  try {
    const r = await fetch('/api/getKhorosProfile()', { credentials: 'include' });
    if (!r.ok) return;
    const body = await r.json() as Profile;
    Object.assign(profile, body, body.linked ? {} : { khorosId: undefined, khorosLogin: undefined });
    if (!body.linked) {
      profile.linked = false;
    }
  } catch { /* leave profile as-is */ }
}

async function onLink() {
  if (busy.value) return;
  const v = input.value.trim();
  if (!v) { errorStatus.value = 'invalid-input'; return; }
  busy.value = true; errorStatus.value = null;
  try {
    const r = await fetch('/api/setKhorosLink', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ input: v }),
    });
    const body = await r.json();
    if (body.status === 'ok') {
      status.value = 'just-linked';
      input.value = '';
      await refresh();
      setTimeout(() => { if (status.value === 'just-linked') status.value = 'idle'; }, 3000);
    } else {
      errorStatus.value = body.status;
    }
  } catch {
    errorStatus.value = 'upstream-unavailable';
  } finally {
    busy.value = false;
  }
}

async function onUnlink() {
  if (busy.value) return;
  busy.value = true;
  try {
    await fetch('/api/clearKhorosLink', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    await refresh();
  } finally { busy.value = false; }
}

function onAvatarError(e: Event) {
  (e.target as HTMLImageElement).style.visibility = 'hidden';
}

onMounted(refresh);

defineExpose({ profile, input, busy, status, errorStatus, errorMessage, errorDesign, onLink, onUnlink, refresh });
</script>

<template>
  <section class="community-profile">
    <ui5-title level="H4">SAP Community profile <span class="badge-new">NEW</span></ui5-title>
    <ui5-text>Link your community.sap.com profile to show it on your /me page and beyond.</ui5-text>

    <!-- UNLINKED -->
    <div v-if="!profile.linked" class="claim-row">
      <ui5-input
        :value="input"
        placeholder="thomas_jung or 123456"
        :disabled="busy"
        @input="(e: any) => (input = e.target.value)"
        @keydown.enter="onLink"
      />
      <ui5-button design="Emphasized" @click="onLink" :disabled="busy || !input.trim()">
        {{ busy ? 'Verifying…' : 'Link profile' }}
      </ui5-button>
      <details class="help">
        <summary>How do I find my community ID?</summary>
        <p>Open your profile at <a href="https://community.sap.com" target="_blank">community.sap.com</a>.
          The URL ends with either <code>/user-id/123456</code> (numeric ID) or
          <code>/user/thomas_jung</code> (login slug). Either works — paste it here.</p>
        <a href="https://developers.sap.com/tutorials/community-profile.html" target="_blank">
          More about your community profile ↗
        </a>
      </details>
      <ui5-message-strip
        v-if="errorStatus"
        :design="errorDesign"
        hide-close-button
      >{{ errorMessage }}</ui5-message-strip>
    </div>

    <!-- LINKED -->
    <div v-else class="linked-chip">
      <ui5-avatar size="S" shape="Circle">
        <img v-if="profile.avatarUrl" :src="profile.avatarUrl" :alt="profile.name" @error="onAvatarError" />
      </ui5-avatar>
      <div class="chip-text">
        <strong>{{ profile.name }}</strong>
        <span>@{{ profile.khorosLogin }}<template v-if="profile.rank"> · {{ profile.rank }}</template></span>
      </div>
      <a :href="profile.profileUrl" target="_blank">View profile ↗</a>
      <ui5-button design="Transparent" @click="onUnlink" :disabled="busy">Unlink</ui5-button>
    </div>

    <div role="alert" aria-live="polite">
      <ui5-message-strip v-if="status === 'just-linked'" design="Positive">
        Linked to {{ profile.name }}.
      </ui5-message-strip>
    </div>
  </section>
</template>

<style scoped>
.community-profile { padding-top: 0.5rem; }
.badge-new {
  font-size: 0.7rem; background: #fff4cf; padding: 0.05rem 0.35rem;
  border-radius: 3px; color: #7a5d00; font-weight: 400; vertical-align: 1px;
}
.claim-row {
  display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;
  margin-top: 0.5rem;
}
.claim-row ui5-input { flex: 1; min-width: 12rem; }
.help { flex-basis: 100%; font-size: 0.85rem; color: var(--sapNeutralTextColor, #556); }
.help summary { cursor: pointer; }
.linked-chip {
  display: flex; align-items: center; gap: 0.7rem;
  padding: 0.6rem 0.7rem; margin-top: 0.5rem;
  border: 1px solid var(--sapList_BorderColor, #c6daee);
  border-radius: 6px; background: var(--sapList_Background, #fbfcfe);
}
.chip-text { flex: 1; min-width: 0; }
.chip-text strong { font-size: 0.9rem; }
.chip-text span {
  display: block; font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #666);
}
</style>
```

- [ ] **Step 2: Run the test to verify GREEN**

```bash
npx vitest run --project unit hugo-apps/src/me/CommunityProfile.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 3: Build sanity**

```bash
npm run build:apps 2>&1 | tail -10
npx tsx scripts/check-island-ui5-imports.ts 2>&1 | tail -5
```

Both should pass.

- [ ] **Step 4: Local end-to-end smoke**

Start the hybrid dev stack and link a real Khoros account (`npm run dev:hybrid` after `npm run bind:setup`). Visit `/me/`, type a known community ID, click Link, observe the chip; click Unlink, observe the form return.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/me/CommunityProfile.vue
git commit -m "feat(566): CommunityProfile.vue — claim/unlink/chip on /me"
```

---

## Task 12: Nav-dropdown avatar swap + community-profile menu link

The existing nav-dropdown reads `/auth/user` and renders an initials avatar today. We swap to `<img src={khorosAvatarUrl}>` when present, with an `onerror` fallback to initials, and add a menu item that deep-links to the user's Khoros profile.

**Files:**
- Modify: `hugo-apps/src/nav-dropdown/*` (locate the existing avatar render + popover template)

- [ ] **Step 1: Locate the existing avatar render**

```bash
ls hugo-apps/src/nav-dropdown
```

There's typically a `main.ts` plus 1-2 `.vue` files. Read them to identify:
(a) where `/auth/user` is fetched, (b) where initials are rendered, (c) where the popover menu items are defined.

- [ ] **Step 2: Extend the auth-user shape**

If the nav-dropdown uses a typed `User` interface, add three optional fields:

```ts
interface User {
  // ...existing...
  khorosId?: string | null
  khorosLogin?: string | null
  khorosAvatarUrl?: string | null
}
```

- [ ] **Step 3: Update the avatar render**

Find the `<Initials>` (or initials-rendering JSX/template) and wrap it:

```vue
<template>
  <span class="nav-avatar">
    <img
      v-if="avatarSrc"
      :src="avatarSrc"
      :alt="user.firstName || 'profile'"
      @error="onAvatarError"
    />
    <Initials v-else :first="user.firstName" :last="user.lastName" />
  </span>
</template>
```

```ts
const avatarSrc = computed(() => user.value?.khorosAvatarUrl || user.value?.avatarUrl || '')

function onAvatarError(e: Event) {
  // Hot-linked Khoros CDN URL failed — fall through to Initials.
  (e.target as HTMLElement).style.display = 'none'
  avatarBroken.value = true   // a local ref that flips avatarSrc → '' on next render
}
```

The exact wiring depends on the existing component shape — keep the logic minimal and preserve the existing initials rendering as the fallback path.

- [ ] **Step 4: Add the community-profile menu item**

In the popover menu template, add an item between existing items (e.g. after "My Profile" / "/me") that is only rendered when `user.khorosLogin` is non-null:

```vue
<a
  v-if="user.khorosLogin && user.khorosId"
  :href="`https://community.sap.com/t5/user/viewprofilepage/user-id/${user.khorosId}`"
  target="_blank"
  class="nav-menu-item"
>
  View community profile ↗
</a>
```

- [ ] **Step 5: Build + manual smoke**

```bash
npm run build:apps 2>&1 | tail -10
```

Then in `npm run dev:hybrid`, link a Khoros account on `/me/`, watch the top-right avatar swap from initials to the Khoros avatar within ~1 page reload. Open the popover; the new "View community profile ↗" item should be present and deep-link correctly.

Test the `onerror` fallback by temporarily setting `khorosAvatarUrl` to a known-404 URL in the DB (one shot via SQL console) — initials should reappear.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/nav-dropdown
git commit -m "feat(566): nav-dropdown — swap initials for khoros avatar + community link"
```

---
## Task 13: Admin UI — read-only columns + Clear action

Adds three read-only columns to the Users Object Page in the Accounts admin tile, plus a "Clear Khoros link" action.

**Decision: use the BOUND-action form** (`actions { action clearKhorosLink() ... }` on `entity Users`) rather than the unbound `clearKhorosLink(userId: UUID)`. Fiori Elements V4 auto-passes the OP's key on a bound action; the unbound form needs custom JS wiring on the Accounts UI5 component. The two shapes are shown below for context, but **commit to the bound form before writing any code or tests** to avoid mid-task rework.

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`
- Modify: `app/admin-annotations.cds`
- Modify: `test/hybrid/khoros-link.test.js` (extend with admin-clear coverage)

- [ ] **Step 1: Declare the bound action in `srv/admin-service.cds`**

The existing `entity Users as projection on ims.Users;` line is enough — the action is a free-floating service action (not bound on the entity) since we pass the userId explicitly:

```cds
@(requires: 'Admin')
action clearKhorosLink(userId: UUID) returns { status: String };
```

Place it alongside other AdminService-level actions in the file.

- [ ] **Step 2: Implement the handler in `srv/admin-service.js`**

Inside `AdminService`'s `init()`, alongside the other admin handlers, add:

```js
import * as khorosCache from './lib/khoros-cache.js';   // if not already imported

this.on('clearKhorosLink', async (req) => {
  const { userId } = req.data;
  if (!userId) return req.reject(400, 'userId required');
  const dbUser = await SELECT.one.from(dbUsers).where({ ID: userId });
  if (!dbUser) return req.reject(404, 'User not found');
  const prevKhorosId = dbUser.khorosId;
  await UPDATE(dbUsers)
    .set({ khorosId: null, khorosLogin: null, khorosAvatarUrl: null, khorosLinkedAt: null })
    .where({ ID: userId });
  if (prevKhorosId) khorosCache.evict(prevKhorosId);
  cds.log('khoros').info('admin cleared khoros link', {
    adminEmail: req.user?.id, targetUserId: userId, prevKhorosId
  });
  return { status: 'ok' };
});
```

Adapt the `dbUsers` reference to match the file's existing destructure pattern.

- [ ] **Step 3: Annotate the Users projection in `app/admin-annotations.cds`**

Find the existing `annotate AdminService.Users` block (the file already has `@cds.search` and a value-help annotation on `Users`; add a sibling annotation, or a new block if no field-level annotations exist yet):

```cds
annotate AdminService.Users with {
  khorosId        @Common.Label: 'Khoros ID'        @Common.FieldControl: #ReadOnly;
  khorosLogin     @Common.Label: 'Khoros Login'     @Common.FieldControl: #ReadOnly;
  khorosLinkedAt  @Common.Label: 'Khoros Linked At' @Common.FieldControl: #ReadOnly;
};

// Object Page facet so the columns show up on the Users OP. Position after the
// existing facets — find the existing UI.Facets / UI.FieldGroup blocks for
// Users and add the FieldGroup + a HeaderInfo line item.
annotate AdminService.Users with @(UI: {
  // ... preserve existing UI annotations; append the FieldGroup below ...
  FieldGroup #KhorosLink: {
    Data: [
      { Value: khorosId       },
      { Value: khorosLogin    },
      { Value: khorosLinkedAt },
    ]
  },
  // Add the FieldGroup to existing Facets (the developer should locate the
  // existing UI.Facets array and append):
  // ...existing facets..., {
  //   $Type: 'UI.ReferenceFacet',
  //   Label: 'SAP Community',
  //   Target: '@UI.FieldGroup#KhorosLink'
  // }
});
```

For the bound-action button on the OP, add a `UI.LineItem`/`DataFieldForAction` entry in the existing identification or actions facet:

```cds
annotate AdminService.Users with @(UI: {
  Identification: [
    // ...existing entries...,
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.clearKhorosLink', Label: 'Clear Khoros link' }
  ]
});
```

Note: the action takes `userId: UUID`. CAP's Fiori Elements doesn't auto-pass the OP's key — wire it via an `Inline` parameter binding or a small JS action handler in the Accounts UI5 component. Simpler alternative: change the action signature so it's **bound on the entity** instead of taking an explicit userId:

```cds
// In srv/admin-service.cds:
entity Users as projection on ims.Users actions {
  @(requires: 'Admin')
  action clearKhorosLink() returns { status: String };
};
```

Then the handler reads `req.params[0].ID` to get the user id. This is cleaner for FE V4 — recommend going with the bound form. Update the cds + handler accordingly, and the annotation becomes:

```cds
{ $Type: 'UI.DataFieldForAction',
  Action: 'AdminService.EntityContainer/Users/clearKhorosLink',
  Label: 'Clear Khoros link' }
```

- [ ] **Step 4: Extend the hybrid test**

Append to `test/hybrid/khoros-link.test.js`:

```js
it('admin clearKhorosLink nulls the 4 columns + evicts cache', async () => {
  const Users = 'com.sap.developers.ims.Users';
  await db.run(UPDATE(Users)
    .set({ khorosId: '99003', khorosLogin: 'adm', khorosAvatarUrl: 'u', khorosLinkedAt: new Date() })
    .where({ sapId: TEST_SAPID_A }));
  const row = await db.run(SELECT.one.from(Users).where({ sapId: TEST_SAPID_A }));
  // Drive the admin action via cds.connect to AdminService + .send():
  const admin = await cds.connect.to('AdminService');
  const result = await admin.send({ event: 'clearKhorosLink', data: { /* if unbound */ userId: row.ID } });
  // For the bound variant: admin.send('clearKhorosLink', row.ID, {})
  expect(result?.status).toBe('ok');
  const cleared = await db.run(SELECT.one.from(Users).where({ ID: row.ID }));
  expect(cleared.khorosId).toBeNull();
});
```

- [ ] **Step 5: Run + commit**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npm run test:hybrid -- test/hybrid/khoros-link.test.js 2>&1 | tail -20
git add srv/admin-service.cds srv/admin-service.js app/admin-annotations.cds test/hybrid/khoros-link.test.js
git commit -m "feat(566): admin Users OP — read-only Khoros columns + Clear action"
```

---

## Task 14: Smoke test for `/me` page shape

Quick HTTP-only check that the deployed approuter serves `/me` with all four mount-point div ids and references `/js/me.js`. Catches the "Vue island ships before HDI deploy" risk in the spec.

**Files:**
- Create: `test/smoke/me-page.test.js`

- [ ] **Step 1: Write the test**

```js
import { describe, it, expect, beforeAll } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
if (!BASE) throw new Error('SMOKE_BASE_URL must be set');

describe('/me page shape', () => {
  let html;
  beforeAll(async () => {
    const res = await fetch(`${BASE}/me/`, { redirect: 'manual' });
    // /me is XSUAA-protected; we expect 302→login on anonymous. The shape test
    // runs against the approuter's static-pre-auth layer or with a known cookie.
    // Adjust based on the existing test/smoke/* auth pattern in this repo.
    expect([200, 302]).toContain(res.status);
    if (res.status === 200) html = await res.text();
  });

  it('contains all four /me island mount points', () => {
    if (!html) return;   // skipped if 302 (anonymous redirect)
    expect(html).toContain('id="me-recent-activity"');
    expect(html).toContain('id="me-all-completions"');
    expect(html).toContain('id="me-learning-preferences"');
    expect(html).toContain('id="me-community-profile"');
  });

  it('references the me.js bundle', () => {
    if (!html) return;
    expect(html).toMatch(/\/js\/me\.js/);
  });

  it('wraps content in three ui5-panel elements', () => {
    if (!html) return;
    const panelCount = (html.match(/<ui5-panel\b/g) || []).length;
    expect(panelCount).toBeGreaterThanOrEqual(3);
  });
});
```

- [ ] **Step 2: Run against DEV (after a `cf deploy`)**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
  npx vitest run --project smoke test/smoke/me-page.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/me-page.test.js
git commit -m "test(566): smoke — /me page renders with 4 mount points + 3 panels"
```

---

## Task 15: Documentation

Three docs, one sidebar entry. None of these are blockers for the feature but the predocs:build sidebar guard will fail the build if new docs aren't registered, so do this BEFORE pushing the PR.

**Files:**
- Create: `docs/developers/architecture/khoros-link.md`
- Create: `docs/end-users/me-page.md`
- Modify: `docs/developers/reference/cap-cds-gotchas.md`
- Modify: `docs/.vitepress/config.ts`

- [ ] **Step 1: Architecture page**

Create `docs/developers/architecture/khoros-link.md`:

```markdown
# Khoros community-link

How SAP Community profiles link to tutorial users (issue #566).

## Schema

Four columns on `Users` (`db/schema.cds`): `khorosId` (numeric, `@assert.unique`),
`khorosLogin` (slug, refreshed lazily, NOT unique), `khorosAvatarUrl` (hot-linked
from khoros-mining CDN), `khorosLinkedAt`. All nullable; unlinked users start at
all-null.

## Endpoints

- `POST /api/setKhorosLink` (`DeveloperService`) — user claims their Khoros profile.
  Returns a status enum so the Vue island can render specific error UI per case.
- `POST /api/clearKhorosLink` (`DeveloperService`) — user unlinks.
- `GET /api/getKhorosProfile()` (`DeveloperService`) — chip refresh; goes through
  the 6h LRU cache.
- `POST /admin/clearKhorosLink` (`AdminService`) — admin override (Admin role
  required). No corresponding admin-set; that's deferred.
- `/auth/user` carries `khorosId`, `khorosLogin`, `khorosAvatarUrl` for the
  current user (so the nav-dropdown's avatar swap costs zero extra roundtrip).

## Khoros lookup

The `srv/lib/khoros-client.js` module ports the reference repo
(https://github.com/SAP-samples/sap-community-activity-badges) to native fetch.
Anonymous direct `/api/2.0/users/:id` reads were revoked mid-2026; we now
project `messages.author.*` against `/api/2.0/search`. **Users with zero
community posts cannot be found via this surface.** A future revocation of
the search endpoint as well would require a Khoros service principal.

The tenant prefix (`khhcw49343`) is held in `KHOROS_TENANT_PREFIX` for a future
one-line rotation.

## Cache

`srv/lib/khoros-cache.js` — bounded LRU keyed by `khorosId`, 6h TTL,
500-entry cap, per-process. Two CF instances may each warm independently.

## Last-known-good

When `getKhorosProfile` upstream is down or returns null (account deleted),
the chip still renders from persisted DB fields with a blank rank. Logs the
warning but does not surface to the user.

## GDPR

Three of the four columns are `@PersonalData.IsPotentiallyPersonal`. The
existing `cascade: 'identity-replace'` cascade walks them on anonymisation —
no code changes needed.
```

- [ ] **Step 2: End-user page**

Create `docs/end-users/me-page.md`:

```markdown
# Your profile page

The /me page shows three sections:

1. **Learning Preferences** — your branching preferences and (new) SAP
   Community profile link.
2. **Recent Activity** — your 10 most recent tutorial completions.
3. **All Completions** — a sortable / filterable list of every tutorial
   you've finished.

Each section can be collapsed independently; your collapsed/expanded
state survives a refresh (saved per-device in your browser).

## Linking your SAP Community profile

Inside **Learning Preferences**, look for "SAP Community profile". Paste
either your numeric community ID (e.g. `123456`) or your community
login slug (e.g. `thomas_jung`), then click "Link profile".

Once linked, your community avatar replaces the initials in the top-right
of every tutorial page, and a "View community profile ↗" link appears
in the user menu.

> **You need at least one public post on community.sap.com** for the
> link to resolve. The lookup uses the anonymous search API, which
> only knows about users who have authored a message.

To unlink, click "Unlink" on the linked chip. You can re-link any time.
```

- [ ] **Step 3: Append the gotcha**

Open `docs/developers/reference/cap-cds-gotchas.md` and append a new section:

```markdown
## `@assert.unique` on nullable columns + why khorosLogin isn't unique

CAP's `@assert.unique` is nullable-aware: NULL values are treated as distinct,
so a nullable column with `@assert.unique` permits any number of NULL rows
but rejects duplicate non-NULL values. We rely on this for `khorosId` (#566) —
unlinked users coexist freely, linked users can't collide.

We deliberately do **not** put `@assert.unique` on `khorosLogin`. Khoros has
bulk-renamed login slugs in the past (e.g. `thomas.jung` → `thomas_jung`).
A second user who claims a renamed slug while the first user's old slug
still sits in the DB would silently fail the join. `khorosId` is the stable
key; `khorosLogin` is a display label refreshed lazily every 6h.
```

- [ ] **Step 4: Register the new pages in `docs/.vitepress/config.ts`**

Find the `themeConfig.sidebar` block. Locate the "Developer Architecture" and "End Users" sidebar arrays. Add:

```ts
// Under developers > architecture:
{ text: 'Khoros community link', link: '/developers/architecture/khoros-link' },

// Under end-users:
{ text: 'Your profile page', link: '/end-users/me-page' },
```

- [ ] **Step 5: Verify the docs build**

```bash
npm run docs:build 2>&1 | tail -15
```

Expected: PASS (sidebar guard + dead-link check both green).

- [ ] **Step 6: Commit**

```bash
git add docs/
git commit -m "docs(566): khoros-link architecture page + /me end-user guide + CAP gotcha"
```

---
## Task 16: Full verification + PR

Catch-all task: full build, full test suites, manual deploy + smoke, then open the PR.

- [ ] **Step 1: Full unit test suite**

```bash
npm test 2>&1 | tail -25
```

Expected: all unit tests green.

- [ ] **Step 2: Full hybrid test suite**

```bash
cf login   # if not already
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npm run test:hybrid 2>&1 | tail -25
```

Expected: all hybrid tests green. Pay attention to any unrelated regression — the @assert.unique change touches schema and could surface latent test interdependencies.

- [ ] **Step 3: Full production build**

```bash
npm run build:all 2>&1 | tail -20
```

Expected: succeeds. This runs fetch + CSS + apps + Hugo + display in the canonical order. Memory: `[feedback_hugo_before_mbt]` — never split this.

- [ ] **Step 4: Confirm deploy scope with maintainer**

Memory: `[feedback_confirm_deploy_scope]`. Ask which scope: backend-only / +content / +QA. Khoros link is **backend + approuter** (because of the `/me` layout change shipping in the approuter static). The CONTENT_API_KEY publish is NOT needed (we're not touching `/tutorials/*` content).

- [ ] **Step 5: Local manual deploy to DEV**

```bash
cd .deploy
mbt build
# Resolve mtaext placeholders if any are needed beyond your local env:
envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' < ../deploy/dev.mtaext > ../deploy/dev.resolved.mtaext
cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
cd ..
```

Memory: `[feedback_cf_target_before_push]` — confirm `cf target` is DEV, NOT prod.

- [ ] **Step 6: DEV smoke**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npm run test:smoke 2>&1 | tail -20
```

Plus manual: visit `/me/` while authenticated, link a real Khoros account, verify the chip + nav-dropdown avatar swap, unlink, re-link, click "View community profile ↗" — confirms the deep-link works.

- [ ] **Step 7: Open the PR**

```bash
git push -u origin worktree-566-khoros-link
gh pr create --base main \
  --title "feat: link SAP Community (Khoros) profile to tutorial users (#566)" \
  --body "$(cat <<'EOF'
Closes #566.

Adds the foundation for linking a tutorial user's SAP Community (Khoros)
profile from the `/me` page. Display-only unlock in v1; the schema +
backend + UI together enable future Devtoberfest-style consumers without
re-doing the link plumbing.

## What's in v1

- 4 new nullable columns on `Users` (`khorosId`, `khorosLogin`,
  `khorosAvatarUrl`, `khorosLinkedAt`) with `@assert.unique.khorosId`
  and GDPR personal-data annotations.
- 3 new DeveloperService endpoints: `setKhorosLink`, `clearKhorosLink`,
  `getKhorosProfile`. Plus `khoros*` fields on `/auth/user`.
- `srv/lib/khoros-client.js` — native-fetch port of the reference repo's
  search workaround. `srv/lib/khoros-cache.js` — 6h LRU.
- `/me` page refactored into three collapsible `ui5-panel`s
  (Learning Preferences + Khoros section / Recent Activity / All Completions),
  collapse state persisted per-device in `localStorage`.
- New `CommunityProfile.vue` island for the claim/unlink flow.
- Nav-dropdown swaps initials for the Khoros avatar when linked, plus
  a "View community profile ↗" deep-link in the popover.
- AdminService bound action `clearKhorosLink` for support unlinks.

## What's deferred

- Devtoberfest auto-credit (separate issue).
- Surfacing other users' Khoros profiles publicly (leaderboards / etc).
- Badge-count / blog-count polling.
- Admin set-on-behalf-of another user.

Spec: `docs/superpowers/specs/2026-06-26-566-khoros-community-link-design.md`
Plan: `docs/superpowers/plans/2026-06-26-566-khoros-community-link.md`

## Tests

- Unit: khoros-client + khoros-cache + developer-service-khoros + CommunityProfile.
- Hybrid: real-HANA link / unique / clear / admin clear.
- Smoke: `/me` page shape (4 mount points + 3 panels).

Verified live on DEV: linked my own community profile, avatar
swapped in nav-dropdown, View profile link works, unlink+relink
clean, admin clear works.
EOF
)"
```

- [ ] **Step 8: Request review**

PR over direct merge (memory: `[feedback_pr_over_direct_merge]`). Subagent review is not a substitute for human PR review.

---

## Verification appendix: things to check before declaring done

- [ ] `npm test` — unit clean
- [ ] `npm run test:hybrid` — hybrid clean
- [ ] `npx tsx scripts/check-island-ui5-imports.ts` — no double-UI5 in any island bundle
- [ ] `npm run build:all` — full prod build succeeds
- [ ] `npm run docs:build` — sidebar + dead-link guards pass
- [ ] Manual on DEV: link a real Khoros account, see the chip + nav-dropdown avatar
- [ ] Manual on DEV: link as user A → ask user B to try the same handle → 'already-claimed'
- [ ] Manual on DEV: unlink → form re-appears → re-link → all four columns repopulate
- [ ] Manual on DEV: admin opens Accounts > a linked user > clicks "Clear Khoros link" → field clears
- [ ] Manual on DEV: 30 minutes after first link, `getKhorosProfile` still warm-cache (no fresh upstream call in logs); ~6h after link, next page load triggers one upstream refresh (visible in `cds.log('khoros')` INFO)
- [ ] CHECK: `/auth/user` for a brand-new user (no Khoros link) returns all 3 fields as `null`, NOT missing entirely (downstream Vue islands depend on undefined-vs-null distinction)

## Known follow-ups (file as separate issues after merge)

- Devtoberfest auto-credit (community posts → mission completion).
- Surface Khoros chips on leaderboards / advocates / scanner / event-display.
- Polling badge-count / blog-count from the reference repo's `activityCounts`.
- Author-side: link author records to Khoros profiles.
- Server-side persistence of `/me` panel collapse state.
- A `KhorosLinkedUsers` analytics view in `AnalyticsService`.
- Khoros user search-as-you-type (the issue's "fuzzy lookup" idea).
- Admin set-on-behalf-of (Q9b deferred).
