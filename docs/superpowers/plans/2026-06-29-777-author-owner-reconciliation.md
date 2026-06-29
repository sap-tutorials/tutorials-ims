# Issue #777 — Reconcile author/owner across MyTutorials + advocate page + admin Tutorial Health: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One canonical CDS view (`MyTutorialsView`) that returns the deduped UNION of four sources for "tutorials belonging to user X" so every consumer (Sage's `/author/MyTutorials`, advocate page, admin Tutorial Health) sees the same count. Plus a one-shot backfill script that resolves 66 legacy `TutorialMeta.owner` text-only rows to `Users` FKs.

**Architecture:** Three-layer view following the existing `Tasks` view precedent (`db/views.cds:7-51`). Layer 1 is `UNION ALL` of 4 equally-shaped narrow SELECTs. Layer 2 GROUP-BYs to dedup with `MIN(priority)`. Layer 3 joins back to `Tutorials` + `TutorialMeta` for the rich field set. The view exposes `userUuid as userId`, matching the established `req.user.id === Users.uuid` invariant.

**Tech Stack:** CDS (`db/views.cds`), Node.js/CAP (`srv/author-service.js`, `srv/routes/advocates-public.js`, `srv/server.js`), vanilla JS UI5 controller (`app/admin-shell/webapp/controller/TutorialDashboard.controller.js`), Node CJS script (`scripts/backfill-tutorial-meta-author.cjs`), vitest unit + hybrid tests.

**Spec:** [`docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md`](../specs/2026-06-29-777-author-owner-reconciliation-design.md)

---

## File Structure

### Modified files (5)

- `db/views.cds` (line ~216 — replace existing `MyTutorialsView`) — rewrite as three layered views (`MyTutorialsRaw` → `MyTutorialsBestPriority` → `MyTutorialsView`).
- `srv/author-service.js` (~line 70-74) — change the `before('READ', MyTutorials)` filter from `{ ownerUserId: userId }` to `{ userId }`.
- `srv/routes/advocates-public.js` (~line 96-103) — replace `SELECT.from(Tutorials).where({ author_ID: { in: userIds } })` with `SELECT.from(MyTutorialsView).where({ userId: { in: userUuids } })` and adapt the surrounding Map-building logic.
- `srv/server.js` (~line 845-887, the `/auth/user` handler) — add `userId` (the `Users.uuid`) to the response. Required by the admin Tutorial Health filter change.
- `app/admin-shell/webapp/controller/TutorialDashboard.controller.js` (~line 87 + the `_loadUserEmail` method) — read `userId` from `/auth/user`; change the "monitored by me" filter to use `userId` instead of `email`.

### Created files (4)

- `srv/lib/resolve-my-tutorials.js` — JS wrapper around `MyTutorialsView`. Single function `resolveMyTutorials(db, { userId }) → Promise<Tutorial[]>`. Consumed by `advocates-public.js`.
- `scripts/backfill-tutorial-meta-author.cjs` — one-shot backfill. Resolves legacy `TutorialMeta.owner` text-only rows against `Users`, writes `ownerEmail` ONLY (not `author_ID` — that's owned by the existing `backfill-tutorial-authors.cjs`).
- `test/unit/srv/resolve-my-tutorials.test.js` — 8-case unit test.
- `test/hybrid/my-tutorials-view-union.test.js` — exercises the actual HANA view shape.
- `test/unit/scripts/backfill-tutorial-meta-author.test.js` — 6-case unit test for the backfill resolution logic.

### NOT modified

- `srv/lib/resolve-tutorial-author.js` — PUBLISH-TIME resolver. Different purpose. Leave untouched.
- `db/schema.cds` — no schema change.
- `srv/admin-service.cds` — `MyTutorialsView` is exposed via AuthorService only; admin Tutorial Health switches to filtering its existing `TutorialMeta` binding by JOINing to the same view OR (simpler) reads from a new `AdminService.MyTutorials` projection. Task 6 picks the path.

---

## Task 1: Rewrite `MyTutorialsView` as a three-layer UNION (spec §1.1)

**Files:**
- Modify: `db/views.cds` (replace lines ~216-260 — the existing single-source `MyTutorialsView`)

This task is the structural heart of the PR. Everything else either feeds the view (Task 3 backfill) or consumes it (Tasks 2, 4, 5, 6).

- [ ] **Step 1: Read the existing view**

Run:
```bash
cd D:/projects/tutorials-poc/.claude/worktrees/777-author-owner-reconciliation
sed -n '210,265p' db/views.cds
```

Expected: the existing single-source `MyTutorialsView` definition (line 216), which uses `INNER JOIN Users ON u.email = m.ownerEmail` and exposes `u.uuid as ownerUserId`. Memorize the existing exposed field list — Layer 3 must preserve it.

- [ ] **Step 2: Replace the existing `MyTutorialsView` with three layered views**

Locate `view MyTutorialsView as` (around line 216) and replace through its closing semicolon. The new content is:

```cds
// --- Issue #777: three-layer canonical author/owner view ----------------
// Layer 1 UNION ALL of 4 sources; Layer 2 dedup with MIN(priority);
// Layer 3 joins back to Tutorials + TutorialMeta for rich fields.
// See docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md
// §1.1. The view's userId column is u.uuid (NOT u.ID) — matches req.user.id
// per the established CAP invariant (see §4.4 of the spec).

view MyTutorialsRaw as
  // Source 1: strict author FK — priority 1 (highest confidence)
  SELECT from ims.Tutorials as t
    inner join ims.Users as u on u.ID = t.author_ID
  {
    key t.ID            as tutorial_ID,
    key u.uuid          as userUuid,
    1                   as priority : Integer
  }
  UNION ALL
  // Source 2: contributor FK — priority 2
  SELECT from ims.TutorialContributors as c
    inner join ims.Users as u on u.ID = c.user_ID
  {
    key c.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    2                   as priority : Integer
  }
  UNION ALL
  // Source 3: post-publish ownerEmail match — priority 3
  SELECT from ims.TutorialMeta as m
    inner join ims.Users as u on u.email = m.ownerEmail
  {
    key m.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    3                   as priority : Integer
  }
  UNION ALL
  // Source 4: legacy free-text owner match — priority 4 (lowest)
  // Equality not LIKE — see spec §1.2 rationale.
  SELECT from ims.TutorialMeta as m
    inner join ims.Users as u
      on m.owner = u.email
      or m.owner = u.firstName || ' ' || u.lastName
  {
    key m.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    4                   as priority : Integer
  };

view MyTutorialsBestPriority as
  select from MyTutorialsRaw {
    key tutorial_ID,
    key userUuid,
    min(priority)       as bestPriority : Integer
  }
  group by tutorial_ID, userUuid;

view MyTutorialsView as
  select from MyTutorialsBestPriority as b
    inner join ims.Tutorials      as t on t.ID = b.tutorial_ID
    inner join ims.TutorialMeta   as m on m.tutorial.ID = t.ID
  {
    key t.ID                                as tutorial_ID,
    key b.userUuid                          as userId,
    b.bestPriority,
    t.slug,
    t.title,
    t.primaryTag,
    t.status,
    m.reviewedDate,
    m.monitoredStatus,
    m.notificationNumber,
    m.lastNotificationDate                  as notificationDate,
    m.firstNotificationDate,
    m.owner                                 as owner,
    m.ownerEmail                            as ownerEmail,
    m.repository.name                       as repositoryName : String,
    case when m.monitoredStatus = 'ACTIVE'
         then true else false end           as monitored : Boolean,
    days_between(m.reviewedDate, $now)      as daysSinceReview : Integer
  };
```

Three views, each individually CDL-idiomatic. The exposed Layer 3 field list matches the existing view's exposed columns plus the new `bestPriority` column. The `ownerUserId` column is renamed `userId` — Task 2 updates the AuthorService filter to match.

- [ ] **Step 3: CDS build to confirm the views compile**

Run:
```bash
npx cds build --production 2>&1 | tail -20
```

Expected: build succeeds without errors. CDS may warn about UNION ALL not being supported on SQLite — that's expected (HANA only). If it errors on the SQL syntax, double-check the column-projection syntax in Layer 1.

- [ ] **Step 4: Commit**

```bash
git add db/views.cds
git -c core.autocrlf=false commit -m "feat(#777): rewrite MyTutorialsView as three-layer UNION

Replaces today's single-source INNER JOIN Users ON u.email = m.ownerEmail
with a UNION ALL of four sources (author FK, contributor FK, ownerEmail,
legacy free-text owner) deduped by MIN(priority).

Three layered views following the existing Tasks view precedent
(db/views.cds:7-51):
  - MyTutorialsRaw: UNION ALL of 4 narrow SELECTs
  - MyTutorialsBestPriority: GROUP BY with MIN(priority)
  - MyTutorialsView: joins back to Tutorials + TutorialMeta for rich fields

Layer 3 exposes userUuid as userId — matches req.user.id (the
established CAP invariant: req.user.id === Users.uuid, NOT
Users.ID; FK columns target Users.ID, so UNION branches JOIN Users
to translate).

Other surfaces (AuthorService before-handler, advocates-public.js,
admin Tutorial Health filter) updated in follow-up tasks."
```

---

## Task 2: Update AuthorService before-handler to filter on `userId`

**Files:**
- Modify: `srv/author-service.js` (line ~70-74)

The existing handler filters on `ownerUserId` (the old column name). Task 1's rename makes `userId` the canonical column. Trivial one-line change.

- [ ] **Step 1: Locate the existing handler**

Run:
```bash
sed -n '68,76p' srv/author-service.js
```

Expected:
```js
  this.before('READ', MyTutorials, (req) => {
    const userId = req.user?.id;
    if (!userId || userId === 'anonymous') return req.reject(401, 'Authentication required');
    req.query.where({ ownerUserId: userId });
  });
```

- [ ] **Step 2: Change `ownerUserId` to `userId`**

Edit the line:

```js
    req.query.where({ ownerUserId: userId });
```

to:

```js
    req.query.where({ userId });
```

- [ ] **Step 3: Commit**

```bash
git add srv/author-service.js
git -c core.autocrlf=false commit -m "feat(#777): AuthorService MyTutorials filter on userId not ownerUserId

The new MyTutorialsView (Task 1) renames the old ownerUserId column
to userId to reflect that it returns matches across all four sources,
not just the legacy email-based one. Filter semantics unchanged
otherwise — still req.user.id matched against Users.uuid."
```

---

## Task 3: Add `userId` to `/auth/user` response

**Files:**
- Modify: `srv/server.js` (~line 845-887, the `/auth/user` handler)

The admin Tutorial Health controller needs the user's `Users.uuid` to filter `MyTutorialsView`. Today's `/auth/user` returns email but not the UUID. Add the lookup.

- [ ] **Step 1: Read the existing handler**

Run:
```bash
sed -n '845,890p' srv/server.js
```

Expected: see the existing GET `/auth/user` handler. It returns `{authenticated, id, email, givenName, familyName, isAdmin, isAuthor, khorosId, khorosLogin, khorosAvatarUrl}`.

- [ ] **Step 2: Verify `req.user.id === Users.uuid` for the current handler, then add `userId` to the response**

`req.user.id` already === `Users.uuid` (the established invariant per spec §4.4). Today's handler returns `id: user.id` — this IS the UUID. So we just need to expose it under a clearer key.

Quick verification before editing — confirm the running srv really populates `user.id` from the XSUAA `sub` (= `Users.uuid`) on DEV:

```bash
# Hit /auth/user via the deployed approuter as Tom; compare returned `id` against Tom's Users.uuid:
curl -s -b "$YOUR_AUTH_COOKIE" https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/auth/user | node -e "
let s = ''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => {
  const r = JSON.parse(s);
  console.log('auth/user.id =', r.id);
});
"
# Expected: a UUID matching Users.uuid for Tom (b7559332-... per the live probe).
# If it doesn't match (e.g. it returns Users.ID instead), STOP — the spec §4.4 invariant
# is wrong and §4.4 + this task both need rework.
```

If verification passes, locate the `res.json({...})` call (around line 877-887) and add `userId: user.id`:

```js
    res.json({
      authenticated: true,
      id: user.id,
      userId: user.id,  // #777: explicit alias of id, kept stable as the Users.uuid value (req.user.id === Users.uuid established invariant — verified per spec §4.4)
      email: user.attr?.email || '',
      givenName: user.attr?.given_name || user.attr?.givenName || '',
      familyName: user.attr?.family_name || user.attr?.familyName || '',
      isAdmin: user.is?.('Admin') === true,
      isAuthor: user.is?.('Tutorial.Author') === true,
      khorosId,
      khorosLogin,
      khorosAvatarUrl,
    });
```

Note: we're NOT doing a DB lookup (spec §2.3 originally prescribed one). The existing `id` field already holds the right value when the invariant holds; we just give it a more discoverable name (`userId`) that the controller can use without confusing it with `email`. If verification above failed, fall back to the spec's prescribed `SELECT.one.from(Users).where({ email }).columns('uuid')` pattern instead.

- [ ] **Step 3: Commit**

```bash
git add srv/server.js
git -c core.autocrlf=false commit -m "feat(#777): expose userId in /auth/user response

Adds userId field to /auth/user, aliased to req.user.id (the
Users.uuid established CAP invariant). The admin Tutorial Health
controller (Task 5) uses this to filter MyTutorialsView by userId
instead of by email."
```

---

## Task 4: Add `srv/lib/resolve-my-tutorials.js` + unit test

**Files:**
- Create: `srv/lib/resolve-my-tutorials.js`
- Create: `test/unit/srv/resolve-my-tutorials.test.js`

A thin JS wrapper over the view, consumed by `advocates-public.js` (Task 6) and any future JS-side caller. The wrapper is testable in isolation.

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/srv/resolve-my-tutorials.test.js`:

```js
// test/unit/srv/resolve-my-tutorials.test.js
//
// Pure-ish wrapper over MyTutorialsView for JS callers. The view does
// all the actual work (UNION ALL of 4 sources, MIN(priority) dedup);
// this wrapper exists so JS code doesn't have to embed CQN/SQL.
//
// Tests use vitest's vi.mock to stub the db.run result.

import { describe, it, expect, vi } from 'vitest';
import { resolveMyTutorials } from '../../../srv/lib/resolve-my-tutorials.js';

describe('resolveMyTutorials', () => {
  it('returns empty array when userId is null', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, { userId: null });
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('returns empty array when userId is undefined', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, {});
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('queries MyTutorialsView with userId filter', async () => {
    const stubRows = [
      { slug: 'cap-handlers',  title: 'CAP Handlers',  bestPriority: 1 },
      { slug: 'btp-onboard',   title: 'BTP Onboarding', bestPriority: 3 },
    ];
    const fakeDb = { run: vi.fn().mockResolvedValue(stubRows) };
    const out = await resolveMyTutorials(fakeDb, { userId: 'abc-123' });
    expect(out).toEqual(stubRows);
    expect(fakeDb.run).toHaveBeenCalledTimes(1);
  });

  it('supports plural userIds via { userIds }', async () => {
    const stubRows = [{ slug: 'x', title: 'X', bestPriority: 1 }];
    const fakeDb = { run: vi.fn().mockResolvedValue(stubRows) };
    const out = await resolveMyTutorials(fakeDb, { userIds: ['a', 'b'] });
    expect(out).toEqual(stubRows);
    expect(fakeDb.run).toHaveBeenCalledTimes(1);
  });

  it('returns [] when both userId and userIds are missing', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, {});
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('returns [] when userIds is an empty array', async () => {
    const fakeDb = { run: vi.fn() };
    const out = await resolveMyTutorials(fakeDb, { userIds: [] });
    expect(out).toEqual([]);
    expect(fakeDb.run).not.toHaveBeenCalled();
  });

  it('selects only the columns advocates-public.js needs', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([]) };
    await resolveMyTutorials(fakeDb, { userId: 'abc' });
    // Inspect the CQN: it should request slug, title, userId, bestPriority.
    const cqn = fakeDb.run.mock.calls[0][0];
    const cqnString = JSON.stringify(cqn);
    expect(cqnString).toContain('slug');
    expect(cqnString).toContain('title');
    expect(cqnString).toContain('userId');
  });

  it('does not throw when row data is empty', async () => {
    const fakeDb = { run: vi.fn().mockResolvedValue([]) };
    const out = await resolveMyTutorials(fakeDb, { userId: 'abc' });
    expect(out).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run test/unit/srv/resolve-my-tutorials.test.js 2>&1 | tail -15
```

Expected: ImportError — `resolve-my-tutorials.js` doesn't exist yet.

- [ ] **Step 3: Implement the wrapper**

Create `srv/lib/resolve-my-tutorials.js`:

```js
// srv/lib/resolve-my-tutorials.js
//
// Issue #777. Thin JS wrapper over MyTutorialsView (db/views.cds) for
// callers that don't go through the CAP OData layer. The view does the
// real work (UNION ALL of 4 sources, MIN(priority) dedup, JOIN back to
// Tutorials + TutorialMeta); this wrapper just keeps the SELECT shape
// in one place so advocates-public.js doesn't have to know CQN.
//
// Spec: docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md §1.3
// Sibling (publish-time, distinct purpose): srv/lib/resolve-tutorial-author.js

import cds from '@sap/cds';

/**
 * Return tutorials "belonging to" a user via the canonical four-source view.
 *
 * @param {object} db     - cds db service (typically cds.db or the result of cds.connect.to('db'))
 * @param {object} opts
 * @param {string|null} [opts.userId]   - single Users.uuid value (NOT Users.ID)
 * @param {string[]} [opts.userIds]     - plural Users.uuid array — overrides userId if both given
 * @returns {Promise<Array<{ slug: string, title: string, userId: string, bestPriority: number }>>}
 */
export async function resolveMyTutorials(db, opts = {}) {
  const ids = Array.isArray(opts.userIds)
    ? opts.userIds
    : opts.userId
      ? [opts.userId]
      : [];
  if (ids.length === 0) return [];

  const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
  return db.run(
    SELECT.from(MyTutorialsView)
      .columns('tutorial_ID', 'userId', 'slug', 'title', 'bestPriority')
      .where({ userId: { in: ids } }),
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run:
```bash
npx vitest run test/unit/srv/resolve-my-tutorials.test.js 2>&1 | tail -10
```

Expected: all 8 cases pass.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/resolve-my-tutorials.js test/unit/srv/resolve-my-tutorials.test.js
git -c core.autocrlf=false commit -m "feat(#777): add srv/lib/resolve-my-tutorials.js wrapper + unit test

Thin JS wrapper over MyTutorialsView for JS callers. The view does
the actual UNION ALL + dedup work; this wrapper keeps the SELECT
shape in one place so advocates-public.js doesn't have to know CQN.

Eight unit-test cases cover: null/undefined userId guards, single
vs plural ids, empty array guard, column selection, empty-row
result handling.

Sibling (distinct purpose): srv/lib/resolve-tutorial-author.js is
the publish-time resolver that SETS author_ID. This one is the
read-time wrapper."
```

---

## Task 5: Rewrite admin Tutorial Health "monitored by me" filter

**Files:**
- Modify: `app/admin-shell/webapp/controller/TutorialDashboard.controller.js` (`_loadUserEmail` method + `_buildFilters` method)

Today's filter compares `owner` (the free-text field) to the user's email. Task 1's new view changes the semantic — we want to filter by `userId`. The controller needs to bind to a `MyTutorials` projection.

**Sub-decision: how does the admin tile access the view?** Two options:

- **(a) Bind `admin>/TutorialMeta` to the existing table; switch filter logic** — change the filter from `owner EQ email` to a more complex expression that requires the row's tutorial_ID to also appear in `admin>/MyTutorials`. OData doesn't do subqueries cleanly; this is awkward.
- **(b) Add `MyTutorials` projection to AdminService; rebind the table when "monitored by me" is on** — but the columns differ from `TutorialMeta`, requires column-level work.
- **(c) Simplest pragmatic path** — keep `admin>/TutorialMeta` binding; when "monitored by me" is on, fetch the user's `MyTutorials` (filtered by userId) as an in-memory list and apply a `tutorial_ID IN [...]` filter on the table. **One extra `fetch()` per toggle**, small payload (probably <100 IDs), zero schema change.

Picking **(c)** — pragmatic, no schema change, fits the controller pattern.

- [ ] **Step 1: Extend `_loadUserEmail` to also load `userId`**

Locate the `_loadUserEmail` method (around line 87-95):

```js
    _loadUserEmail: function () {
      fetch("/auth/user", { credentials: "include" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (data && data.email) { this._sUserEmail = data.email; }
        }.bind(this))
        .catch(function () { /* filter will fall back to no-op */ });
    },
```

Replace with:

```js
    _loadUserEmail: function () {
      fetch("/auth/user", { credentials: "include" })
        .then(function (res) { return res.ok ? res.json() : null; })
        .then(function (data) {
          if (data && data.email) { this._sUserEmail = data.email; }
          if (data && data.userId) { this._sUserId = data.userId; }
        }.bind(this))
        .catch(function () { /* filter will fall back to no-op */ });
    },
```

- [ ] **Step 2: Add a method that fetches the user's tutorial IDs from MyTutorialsView**

Insert after `_loadUserEmail` (so it sits near related auth-loading code):

```js
    // Issue #777: fetch the user's "mine" tutorial IDs via the canonical
    // MyTutorialsView (4-source UNION). Returns a Promise resolving to
    // an array of tutorial_ID strings. Falls back to [] on any error
    // so the admin tile degrades gracefully (no toggle works, no crash).
    //
    // $top=1000 cap: practical ceiling well above the expected per-user
    // count. Tom on DEV has ~77; the most prolific real-world author is
    // unlikely to exceed a few hundred. If anyone ever does, the filter
    // truncates silently — the toggle still works, just shows the top 1000.
    // For thousands-of-tutorials users this approach hits OData URL length
    // limits before $top does; the right fix at that scale is a server-side
    // bound endpoint (e.g. /admin/MyTutorialIds), out of scope here.
    _fetchMyTutorialIds: function () {
      if (!this._sUserId) return Promise.resolve([]);
      // AuthorService exposes MyTutorials; use it directly. Other paths
      // (admin OData expand) would require AdminService to project
      // MyTutorialsView, which is heavier than needed here.
      return fetch("/author/MyTutorials?$select=tutorial_ID&$top=1000", { credentials: "include" })
        .then(function (res) { return res.ok ? res.json() : { value: [] }; })
        .then(function (data) {
          return (data.value || []).map(function (r) { return r.tutorial_ID; });
        })
        .catch(function () { return []; });
    },
```

- [ ] **Step 3: Change the filter logic in `_buildFilters`**

Locate the existing "monitored by me" branch (around line 74):

```js
      if (this._bFilterMonitored && this._sUserEmail) {
        aUser.push(new Filter("owner", FilterOperator.EQ, this._sUserEmail));
      }
```

Replace with a version that uses a cached tutorial-ID list (Step 4 wires up the cache):

```js
      if (this._bFilterMonitored && Array.isArray(this._aMyTutorialIds) && this._aMyTutorialIds.length > 0) {
        // Filter against the cached "my tutorials" set fetched via
        // /author/MyTutorials (the canonical 4-source UNION view) — #777.
        // Empty list means no rows match, which is the right semantic.
        var aIdFilters = this._aMyTutorialIds.map(function (id) {
          return new Filter("tutorial_ID", FilterOperator.EQ, id);
        });
        aUser.push(new Filter({ filters: aIdFilters, and: false }));
      } else if (this._bFilterMonitored && Array.isArray(this._aMyTutorialIds) && this._aMyTutorialIds.length === 0) {
        // Toggle is ON but the user has zero tutorials — apply a
        // never-match filter so the table renders empty (not unfiltered).
        aUser.push(new Filter("tutorial_ID", FilterOperator.EQ, "__NO_MATCH__"));
      }
```

- [ ] **Step 4: Refresh the tutorial-ID cache when the toggle goes ON**

Locate `onFilterMonitored` (the toggle handler):

```js
    onFilterMonitored: function (oEvent) {
      this._bFilterMonitored = oEvent.getParameter("selected");
      this._applyFilters();
    },
```

Replace with:

```js
    onFilterMonitored: function (oEvent) {
      this._bFilterMonitored = oEvent.getParameter("selected");
      if (this._bFilterMonitored) {
        // Refresh the "mine" tutorial-ID list each time the toggle is
        // turned ON — keeps the data fresh after admin writes.
        this._fetchMyTutorialIds().then(function (ids) {
          this._aMyTutorialIds = ids;
          this._applyFilters();
        }.bind(this));
      } else {
        this._applyFilters();
      }
    },
```

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/controller/TutorialDashboard.controller.js
git -c core.autocrlf=false commit -m "feat(#777): admin Tutorial Health 'monitored by me' uses MyTutorialsView

Replaces the old 'owner EQ email' filter with a canonical fetch
against /author/MyTutorials (the 4-source UNION view rewritten in
Task 1). When the toggle is turned on, the controller fetches the
user's tutorial-ID list and applies a tutorial_ID IN [...] filter
to the local TutorialMeta binding.

Fetches once per toggle-on, falls back to empty list on error,
applies a never-match filter when the user has zero tutorials (so
table renders empty, not unfiltered).

Tom's previous count was 11 (email-only). After this change + the
view rewrite, count rises to ~77 (matches legacy IMS behavior)."
```

---

## Task 6: Update advocates-public.js to use MyTutorialsView

**Files:**
- Modify: `srv/routes/advocates-public.js` (~line 96-103, the `SELECT.from(Tutorials).where({ author_ID: { in: userIds } })` query)

Today the route queries `Tutorials.author_ID` (the FK that only source 1 sets). After this change, advocates see ALL their tutorials across the four sources.

- [ ] **Step 1: Read the existing query**

Run:
```bash
sed -n '94,115p' srv/routes/advocates-public.js
```

Expected: see the `authoredRows` query that uses `SELECT.from(Tutorials).columns('slug', 'title', 'author_ID').where({ author_ID: { in: userIds } })`. Note: `userIds` here is an array of `Users.ID` values (NOT `Users.uuid`).

- [ ] **Step 2: Convert `Users.ID` userIds to `Users.uuid` for the new view**

The `advocates` rows have `user_ID` (FK to `Users.ID`). The new `MyTutorialsView.userId` is `Users.uuid`. We need to translate.

Locate the existing `userIds` variable definition (around line 80):

```js
  const userIds = [...new Set(advocates.map((a) => a.user_ID).filter(Boolean))];
```

Add an extra query to translate `Users.ID` → `Users.uuid`:

```js
  // Issue #777: the new MyTutorialsView exposes userUuid as userId
  // (matches req.user.id), but advocate.user_ID is the Users.ID FK.
  // Translate the set so we can query MyTutorialsView.
  const userIdToUuidRows = userIds.length
    ? await db.run(SELECT.from(Users).columns('ID', 'uuid').where({ ID: { in: userIds } }))
    : [];
  const userIdToUuid = new Map(userIdToUuidRows.map((u) => [u.ID, u.uuid]));
  const userUuids = userIdToUuidRows.map((u) => u.uuid);
```

- [ ] **Step 3: Replace the `authoredRows` query**

Find:

```js
    // Tutorials authored by any of those users.
    userIds.length
      ? db.run(
          SELECT.from(Tutorials)
            .columns('slug', 'title', 'author_ID')
            .where({ author_ID: { in: userIds } }),
        )
      : [],
```

Replace with:

```js
    // Issue #777: query MyTutorialsView (4-source UNION) instead of
    // Tutorials.author_ID alone, so advocates see all their tutorials
    // (authored + contributed + ownerEmail-matched + legacy-text).
    userUuids.length
      ? db.run(
          SELECT.from(MyTutorialsView)
            .columns('slug', 'title', 'userId')
            .where({ userId: { in: userUuids } }),
        )
      : [],
```

- [ ] **Step 4: Update the import + Map-building logic**

The `authoredByUserId` Map currently maps `Users.ID` → tutorials. The new query returns `userId` which is `Users.uuid`. Two paths:

- (a) Change the Map to be keyed by `Users.uuid` and update `shapeAdvocateRow` to lookup by `userIdToUuid.get(a.user_ID)`.
- (b) Translate back in the Map-building step.

(b) is the smaller-blast-radius change. Find the existing Map build:

```js
  for (const row of authoredRows) {
    const arr = authoredByUserId.get(row.author_ID) || [];
    arr.push({ slug: row.slug, title: row.title });
    authoredByUserId.set(row.author_ID, arr);
  }
```

Replace with:

```js
  // Issue #777: authoredRows now comes from MyTutorialsView with userId
  // (= Users.uuid). Translate back to Users.ID so authoredByUserId stays
  // keyed by the same value shapeAdvocateRow expects (a.user_ID).
  const uuidToUserId = new Map(userIdToUuidRows.map((u) => [u.uuid, u.ID]));
  for (const row of authoredRows) {
    const usersId = uuidToUserId.get(row.userId);
    if (!usersId) continue;
    const arr = authoredByUserId.get(usersId) || [];
    arr.push({ slug: row.slug, title: row.title });
    authoredByUserId.set(usersId, arr);
  }
```

Also update the `cds.entities` destructure to include `MyTutorialsView`. Find:

```js
  const { AdvocateTopics, AdvocateLinks, Tags, Users, Tutorials, TutorialContributors } =
    cds.entities('com.sap.developers.ims');
```

Change to:

```js
  const { AdvocateTopics, AdvocateLinks, Tags, Users, Tutorials, TutorialContributors, MyTutorialsView } =
    cds.entities('com.sap.developers.ims');
```

- [ ] **Step 5: Run existing advocates tests to make sure nothing broke**

Run:
```bash
npx vitest run test/unit/srv/advocates-route.test.js 2>&1 | tail -10
```

If that test file doesn't exist (or the location is different), run all srv tests:
```bash
npx vitest run test/unit/srv/ 2>&1 | tail -10
```

Expected: green. The advocate tests probably use mocked `db.run` — they may need to mock `MyTutorialsView` queries instead of `Tutorials` queries. If they fail, update the mocks to match.

- [ ] **Step 6: Commit**

```bash
git add srv/routes/advocates-public.js
git -c core.autocrlf=false commit -m "feat(#777): advocate page reads MyTutorialsView (4-source UNION)

Today the advocate page's authoredTutorials list reads
Tutorials.author_ID — only source #1 of the four. After this PR,
the public advocate page shows the broader set: author FK +
contributor FK + ownerEmail + legacy free-text. For Tom, count
rises from 7 -> 77.

Two translations needed:
- userIds (Users.ID, from advocate.user_ID) -> userUuids
  (Users.uuid, what MyTutorialsView.userId exposes) for the WHERE
  clause.
- userUuid -> Users.ID for the authoredByUserId Map keys (preserves
  the existing shapeAdvocateRow contract).

Adds a single SELECT for the Users.ID -> Users.uuid translation."
```

---

## Task 7: Add the backfill script + unit test

**Files:**
- Create: `scripts/backfill-tutorial-meta-author.cjs`
- Create: `test/unit/scripts/backfill-tutorial-meta-author.test.js`

The script resolves the 66 legacy `TutorialMeta.owner` text-only rows. Mirrors `scripts/backfill-tutorial-authors.cjs` in shape but writes ONLY `ownerEmail` (not `author_ID` — that's owned by the existing script).

- [ ] **Step 1: Write the failing unit test**

Create `test/unit/scripts/backfill-tutorial-meta-author.test.js`:

```js
// test/unit/scripts/backfill-tutorial-meta-author.test.js
//
// Tests the pure resolution helper extracted from
// scripts/backfill-tutorial-meta-author.cjs. The script itself is a CJS
// CLI driver; the helper is small enough to import + test cleanly.

import { describe, it, expect } from 'vitest';

// The helper is exported via the script — we import it directly.
// CJS require from ESM-vitest works because the script declares
// module.exports.
const path = require('node:path');
const helperPath = path.resolve(__dirname, '../../../scripts/backfill-tutorial-meta-author.cjs');
const { resolveLegacyOwner } = require(helperPath);

const users = [
  { ID: 'u1', uuid: 'uuid1', email: 'thomas.jung@sap.com', firstName: 'Thomas', lastName: 'Jung' },
  { ID: 'u2', uuid: 'uuid2', email: 'john.smith@sap.com',  firstName: 'John',   lastName: 'Smith' },
  { ID: 'u3', uuid: 'uuid3', email: 'jane.doe@sap.com',    firstName: 'John',   lastName: 'Smith' },  // duplicate name!
];

describe('resolveLegacyOwner', () => {
  it('case 1: email-shape value matches Users.email', () => {
    const r = resolveLegacyOwner('thomas.jung@sap.com', users);
    expect(r.match).toBeTruthy();
    expect(r.match.ID).toBe('u1');
    expect(r.proposedEmail).toBe('thomas.jung@sap.com');
  });

  it('case 2: name-shape value matches Users.firstName + lastName', () => {
    const r = resolveLegacyOwner('Thomas Jung', users);
    expect(r.match).toBeTruthy();
    expect(r.match.ID).toBe('u1');
    expect(r.proposedEmail).toBe('thomas.jung@sap.com');
  });

  it('case 3: compound "Name <email>" extracts the email', () => {
    const r = resolveLegacyOwner('Thomas Jung <thomas.jung@sap.com>', users);
    expect(r.match).toBeTruthy();
    expect(r.match.ID).toBe('u1');
    expect(r.proposedEmail).toBe('thomas.jung@sap.com');
  });

  it('case 4: ambiguous name match — multiple candidates → orphan', () => {
    const r = resolveLegacyOwner('John Smith', users);
    expect(r.match).toBeNull();
    expect(r.candidates).toHaveLength(2);
    expect(r.orphanReason).toBe('ambiguous');
  });

  it('case 5: no match anywhere → orphan', () => {
    const r = resolveLegacyOwner('Unknown Person', users);
    expect(r.match).toBeNull();
    expect(r.candidates).toEqual([]);
    expect(r.orphanReason).toBe('unmatched');
  });

  it('case 6: null / empty input → orphan (defensive)', () => {
    const r1 = resolveLegacyOwner(null, users);
    expect(r1.match).toBeNull();
    expect(r1.orphanReason).toBe('empty');
    const r2 = resolveLegacyOwner('', users);
    expect(r2.match).toBeNull();
    expect(r2.orphanReason).toBe('empty');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npx vitest run test/unit/scripts/backfill-tutorial-meta-author.test.js 2>&1 | tail -10
```

Expected: error about missing `scripts/backfill-tutorial-meta-author.cjs`.

- [ ] **Step 3: Create the backfill script**

Create `scripts/backfill-tutorial-meta-author.cjs`:

```js
/* eslint-disable no-console */
/**
 * backfill-tutorial-meta-author.cjs — One-shot backfill for
 * TutorialMeta.ownerEmail (issue #777).
 *
 * Spec: docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md §1.4
 * Sibling: scripts/backfill-tutorial-authors.cjs (writes author_ID; run
 * AFTER this script per spec §6).
 *
 * Resolution: legacy TutorialMeta.owner is free-text — typically the
 * frontmatter `author_name` value from old-IMS. May be:
 *   - "thomas.jung@sap.com"            (email shape)
 *   - "Thomas Jung"                    (name shape)
 *   - "Thomas Jung <thomas.jung@sap.com>" (compound)
 * We resolve to a Users row by matching email first, then exact
 * firstName + ' ' + lastName.
 *
 * Modes:
 *   default        — DRY RUN. Writes CSV reports, zero DB writes.
 *   --dry-run      — explicit alias.
 *   --commit       — execute UPDATEs (ownerEmail only; NEVER author_ID).
 *
 * Idempotency:
 *   Every UPDATE is gated by `WHERE OWNEREMAIL IS NULL`. Re-runs are
 *   safe and only touch rows still unset.
 *
 * Output:
 *   .migration-data/tutorial-meta-author-proposed.csv
 *   .migration-data/tutorial-meta-author-orphans.csv
 *
 * Usage:
 *   npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs
 *   npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --commit
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
let commit = false;
for (const a of argv) {
  if (a === '--commit') commit = true;
  else if (a === '--dry-run') commit = false;
}

const REPORT_DIR = path.resolve(__dirname, '..', '.migration-data');
const PROPOSED_PATH = path.join(REPORT_DIR, 'tutorial-meta-author-proposed.csv');
const ORPHANS_PATH = path.join(REPORT_DIR, 'tutorial-meta-author-orphans.csv');

// --- Pure resolver (exported for testing) ----------------------------------

/**
 * Resolve a legacy TutorialMeta.owner string to a Users row.
 *
 * @param {string|null} ownerText - the legacy `owner` value
 * @param {Array<{ID, uuid, email, firstName, lastName}>} users
 * @returns {{
 *   match: object|null,
 *   candidates: object[],
 *   proposedEmail: string|null,
 *   orphanReason: 'empty'|'unmatched'|'ambiguous'|null,
 * }}
 */
function resolveLegacyOwner(ownerText, users) {
  if (ownerText == null || ownerText === '') {
    return { match: null, candidates: [], proposedEmail: null, orphanReason: 'empty' };
  }

  // 1. Try to extract an embedded email — e.g. "Thomas Jung <thomas.jung@sap.com>".
  const emailMatch = ownerText.match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  if (emailMatch) {
    const email = emailMatch[0].toLowerCase().trim();
    const candidates = users.filter((u) => u.email && u.email.toLowerCase() === email);
    if (candidates.length === 1) {
      return { match: candidates[0], candidates, proposedEmail: candidates[0].email, orphanReason: null };
    }
    if (candidates.length > 1) {
      return { match: null, candidates, proposedEmail: null, orphanReason: 'ambiguous' };
    }
    // Email-shaped but no Users row matches → unmatched.
    return { match: null, candidates: [], proposedEmail: null, orphanReason: 'unmatched' };
  }

  // 2. Try name-shape: exact "firstName lastName".
  const trimmed = ownerText.trim();
  const candidates = users.filter((u) => {
    if (!u.firstName || !u.lastName) return false;
    return `${u.firstName} ${u.lastName}` === trimmed;
  });
  if (candidates.length === 1) {
    return { match: candidates[0], candidates, proposedEmail: candidates[0].email, orphanReason: null };
  }
  if (candidates.length > 1) {
    return { match: null, candidates, proposedEmail: null, orphanReason: 'ambiguous' };
  }

  return { match: null, candidates: [], proposedEmail: null, orphanReason: 'unmatched' };
}

// Export for unit tests.
module.exports = { resolveLegacyOwner };

// --- Script body -----------------------------------------------------------

async function main() {
  await cds.connect.to('db');
  const db = cds.db;

  // Load all Users — small table, easier than per-row lookups.
  const users = await db.run(
    `SELECT "ID", "uuid", "email", "firstName", "lastName" FROM "COM_SAP_DEVELOPERS_IMS_USERS"`,
  );
  console.log(`[backfill] Loaded ${users.length} users.`);

  // Load all TutorialMeta rows where owner is set but ownerEmail is NULL.
  const metaRows = await db.run(
    `SELECT m."ID", m."OWNER", t."slug" AS "tutorialSlug"
     FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" m
     INNER JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = m."tutorial_ID"
     WHERE m."OWNER" IS NOT NULL AND m."OWNEREMAIL" IS NULL`,
  );
  console.log(`[backfill] Candidate rows: ${metaRows.length} (owner set, ownerEmail null)`);

  const proposed = [];
  const orphans = [];
  for (const r of metaRows) {
    const result = resolveLegacyOwner(r.OWNER, users);
    if (result.match) {
      proposed.push({
        metaId: r.ID,
        tutorialSlug: r.tutorialSlug,
        ownerInput: r.OWNER,
        proposedEmail: result.proposedEmail,
        matchedUserId: result.match.ID,
      });
    } else {
      orphans.push({
        metaId: r.ID,
        tutorialSlug: r.tutorialSlug,
        ownerInput: r.OWNER,
        reason: result.orphanReason,
        candidates: result.candidates.map((c) => `${c.email}(${c.ID})`).join('|'),
      });
    }
  }

  // Write CSVs.
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(
    PROPOSED_PATH,
    'metaId,tutorialSlug,ownerInput,proposedEmail,matchedUserId\n' +
      proposed.map((p) => `${p.metaId},${p.tutorialSlug},"${p.ownerInput}",${p.proposedEmail},${p.matchedUserId}`).join('\n'),
  );
  fs.writeFileSync(
    ORPHANS_PATH,
    'metaId,tutorialSlug,ownerInput,reason,candidates\n' +
      orphans.map((o) => `${o.metaId},${o.tutorialSlug},"${o.ownerInput}",${o.reason},"${o.candidates}"`).join('\n'),
  );

  console.log(`[backfill] Proposed: ${proposed.length}, orphans: ${orphans.length}`);
  console.log(`[backfill]   ${PROPOSED_PATH}`);
  console.log(`[backfill]   ${ORPHANS_PATH}`);

  if (!commit) {
    console.log('[backfill] DRY RUN — no DB writes. Use --commit to apply.');
    process.exit(0);
  }

  // Apply UPDATEs.
  let updated = 0;
  for (const p of proposed) {
    const res = await db.run(
      `UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" SET "OWNEREMAIL" = ? WHERE "ID" = ? AND "OWNEREMAIL" IS NULL`,
      [p.proposedEmail, p.metaId],
    );
    if (res > 0) updated++;
  }
  console.log(`[backfill] Applied ${updated} ownerEmail UPDATEs.`);
  console.log(
    `[backfill] NEXT: re-run scripts/backfill-tutorial-authors.cjs --commit to pick up these rows via author_ID.`,
  );
}

if (require.main === module) {
  main().catch((e) => {
    console.error('[backfill] FAILED:', e.message);
    console.error(e.stack);
    process.exit(1);
  });
}
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run:
```bash
npx vitest run test/unit/scripts/backfill-tutorial-meta-author.test.js 2>&1 | tail -10
```

Expected: all 6 cases pass.

- [ ] **Step 5: Add an `npm run` alias**

Edit `package.json` to add the script under `"scripts":` (near the existing `migrate:authors` line):

```json
    "migrate:meta-authors": "cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --commit",
```

Confirm with:
```bash
grep -n "migrate:meta-authors" package.json
```

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-tutorial-meta-author.cjs test/unit/scripts/backfill-tutorial-meta-author.test.js package.json
git -c core.autocrlf=false commit -m "feat(#777): add scripts/backfill-tutorial-meta-author.cjs

Resolves the 66 legacy TutorialMeta.owner text-only rows to Users
FKs. Writes ONLY TutorialMeta.ownerEmail (NOT author_ID — that's
owned by scripts/backfill-tutorial-authors.cjs).

Run sequence after deploy:
  npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --dry-run
  # review CSVs
  npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --commit
  # re-run sibling script:
  npm run migrate:authors

Pure resolveLegacyOwner() helper extracted + tested (6 unit-test
cases: email-shape, name-shape, compound, ambiguous, unmatched,
empty/null defensive).

CSV outputs:
  .migration-data/tutorial-meta-author-proposed.csv
  .migration-data/tutorial-meta-author-orphans.csv

Idempotent: all UPDATEs gated by 'WHERE OWNEREMAIL IS NULL'."
```

---

## Task 8: Add hybrid test for the layered view

**Files:**
- Create: `test/hybrid/my-tutorials-view-union.test.js`

This is the EXPLAIN-PLAN verification gate from spec §4.7. Without it we don't know HANA can run the view efficiently.

- [ ] **Step 1: Write the hybrid test**

Create `test/hybrid/my-tutorials-view-union.test.js`:

```js
// test/hybrid/my-tutorials-view-union.test.js
//
// Issue #777. Exercises MyTutorialsView (4-source UNION ALL via three
// layered views) against real HANA. Inserts synthetic test data covering
// each source path, then queries the view and asserts:
//   1. All four sources contribute rows.
//   2. A user present in multiple sources gets ONE row with the highest-
//      confidence (lowest-priority-number) source as bestPriority.
//   3. The userId column resolves to Users.uuid, not Users.ID — the
//      established CAP invariant per spec §4.4.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { assertHybridWritesAllowed } from './_guard.js';

cds.test('serve');

describe('MyTutorialsView — 4-source UNION (hybrid, HANA only)', () => {
  let db;
  const TS = `__TEST__${Date.now()}__`;

  // Synthetic IDs.
  const userId = `${TS}user1`;     // Users.ID
  const userUuid = `${TS}uuid1`;   // Users.uuid (matches req.user.id)
  const tutA = `${TS}tutA`;        // tutorial only via author_ID
  const tutB = `${TS}tutB`;        // tutorial only via TutorialContributors.user_ID
  const tutC = `${TS}tutC`;        // tutorial only via TutorialMeta.ownerEmail
  const tutD = `${TS}tutD`;        // tutorial only via legacy TutorialMeta.owner text
  const tutE = `${TS}tutE`;        // tutorial via BOTH author_ID and ownerEmail (multi-source)

  beforeAll(async () => {
    assertHybridWritesAllowed();
    db = await cds.connect.to('db');

    // Insert synthetic Users row.
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_USERS" ("ID", "uuid", "email", "firstName", "lastName") VALUES (?, ?, ?, ?, ?)`,
      [userId, userUuid, `${TS}user1@example.com`, 'Test', 'User'],
    );

    // Insert 5 synthetic Tutorials.
    for (const id of [tutA, tutB, tutC, tutD, tutE]) {
      await db.run(
        `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALS" ("ID", "slug", "title", "status") VALUES (?, ?, ?, 'ACTIVE')`,
        [id, `${TS}slug-${id}`, `Test Tutorial ${id}`],
      );
    }

    // Source 1: tutA gets author_ID = userId.
    await db.run(`UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALS" SET "author_ID" = ? WHERE "ID" = ?`, [userId, tutA]);
    // Source 1 + 3: tutE gets author_ID AND a TutorialMeta with matching ownerEmail.
    await db.run(`UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALS" SET "author_ID" = ? WHERE "ID" = ?`, [userId, tutE]);

    // Source 2: TutorialContributors row for tutB.
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS" ("ID", "tutorial_ID", "user_ID", "name", "email", "role")
       VALUES (?, ?, ?, ?, ?, ?)`,
      [`${TS}contrib1`, tutB, userId, 'Test User', `${TS}user1@example.com`, 'contributor'],
    );

    // Source 3: TutorialMeta row with ownerEmail for tutC.
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" ("ID", "tutorial_ID", "owner", "ownerEmail") VALUES (?, ?, ?, ?)`,
      [`${TS}meta3`, tutC, `${TS}user1@example.com`, `${TS}user1@example.com`],
    );

    // Source 4: TutorialMeta row with legacy free-text owner for tutD (NULL ownerEmail).
    await db.run(
      `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" ("ID", "tutorial_ID", "owner", "ownerEmail") VALUES (?, ?, ?, NULL)`,
      [`${TS}meta4`, tutD, 'Test User'],
    );

    // For tutA/tutB/tutE we also need TutorialMeta rows because the
    // outer view INNER JOINs TutorialMeta. Use minimal rows.
    for (const tId of [tutA, tutB, tutE]) {
      await db.run(
        `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" ("ID", "tutorial_ID") VALUES (?, ?)`,
        [`${TS}meta-${tId}`, tId],
      );
    }
    // Also wire up source 3 for tutE (it has both source 1 and source 3 contributing).
    await db.run(
      `UPDATE "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" SET "ownerEmail" = ? WHERE "tutorial_ID" = ?`,
      [`${TS}user1@example.com`, tutE],
    );
  });

  afterAll(async () => {
    if (db) {
      // Clean up in reverse order of dependencies.
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS" WHERE "ID" LIKE '${TS}%'`);
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA" WHERE "ID" LIKE '${TS}%'`);
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" LIKE '${TS}%'`);
      await db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_USERS" WHERE "ID" LIKE '${TS}%'`);
    }
  });

  it('userId column resolves to Users.uuid (not Users.ID)', async () => {
    const rows = await db.run(
      `SELECT "tutorial_ID", "userId", "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ?`,
      [userUuid],
    );
    // Should return all five tutorials (tutA, tutB, tutC, tutD, tutE).
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // Filter must NOT match Users.ID.
    const wrongRows = await db.run(
      `SELECT "tutorial_ID" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ?`,
      [userId],  // Users.ID, not uuid
    );
    expect(wrongRows.length).toBe(0);
  });

  it('source 1 (author_ID) contributes tutA with priority 1', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutA],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(1);
  });

  it('source 2 (contributor FK) contributes tutB with priority 2', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutB],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(2);
  });

  it('source 3 (ownerEmail) contributes tutC with priority 3', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutC],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(3);
  });

  it('source 4 (legacy owner text) contributes tutD with priority 4', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutD],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(4);
  });

  it('multi-source (tutE: author_ID + ownerEmail) → one row, MIN(priority) = 1', async () => {
    const rows = await db.run(
      `SELECT "bestPriority" FROM "COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW" WHERE "userId" = ? AND "tutorial_ID" = ?`,
      [userUuid, tutE],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].bestPriority).toBe(1);
  });
});
```

Note: the actual view name on HANA after `cds build` is `COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW` (uppercase, underscores). Verify with `SELECT TABLE_NAME FROM SYS.VIEWS WHERE TABLE_NAME LIKE '%MYTUTORIALS%'` during implementation.

- [ ] **Step 2: Run the hybrid test (requires cf login + ALLOW_HYBRID_WRITES=true)**

Run:
```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/my-tutorials-view-union.test.js 2>&1 | tail -20
```

Expected: all 6 cases pass. If "view name not found", adjust based on actual HANA artifact naming.

- [ ] **Step 3: Run EXPLAIN PLAN measurement (spec §4.7 mandate)**

Run via `cds bind --exec`:

```bash
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
cds.connect.to('db').then(async db => {
  const plan = await db.run(\"EXPLAIN PLAN FOR SELECT * FROM COM_SAP_DEVELOPERS_IMS_MYTUTORIALSVIEW WHERE \\\"userId\\\" = 'dummy-uuid'\");
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}).catch(e => { console.error(e.message); process.exit(1); });
" 2>&1 | tail -40
```

Expected: HANA returns a query plan. Look for the `userId = ?` filter applied EARLY (within each UNION ALL branch's INNER JOIN to Users), NOT after the GROUP BY. If filter appears late (full-table scan + late filter), the spec §4.7 fallback applies: refactor Layer 1 to expose `userUuid` as a parameter for early pushdown.

If the plan looks healthy (filter pushed down), document the EXPLAIN output in the PR body as evidence. If not, surface to Tom — likely a Layer 1 parametrization tweak before merge.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/my-tutorials-view-union.test.js
git -c core.autocrlf=false commit -m "test(#777): hybrid test for MyTutorialsView 4-source UNION

Exercises the new three-layer view against real HANA. Six cases:
- userId resolves to Users.uuid not Users.ID (the established invariant)
- Each of the 4 source paths contributes a row with the right priority
- Multi-source tutorial (author_ID + ownerEmail) gets ONE row with
  MIN(priority) = 1 — confirms the GROUP BY dedup works

Uses ALLOW_HYBRID_WRITES=true guard + __TEST__-prefixed synthetic
data per the hybrid-test convention."
```

---

## Task 9: Open the PR

**Files:** none

- [ ] **Step 1: Push the branch**

```bash
git push -u origin 777-author-owner-reconciliation
```

- [ ] **Step 2: Write the PR body file**

```bash
cat > PR_BODY.md << 'PR_BODY_EOF'
Closes #777.

## What

One canonical CDS view (`MyTutorialsView`, rewritten as 3 layers) returns the deduped UNION of four sources for "tutorials belonging to user X" so every consumer (Sage's `/author/MyTutorials`, advocate page, admin Tutorial Health) sees the same count.

For Tom, who reported the inconsistency:

| Surface | Before | After |
|---|---|---|
| Legacy IMS Sage | 77 | 77 (parity restored) |
| Admin Tutorial Health | 11 | ~77 |
| `/author/MyTutorials` | 11 (0 in Sage's session) | ~77 |
| Advocate page | 7 | ~77 |

Plus a one-shot backfill script that resolves the 66 legacy `TutorialMeta.owner` text-only rows to `Users` FKs.

## Spec & plan

- Spec: [docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md](docs/superpowers/specs/2026-06-29-777-author-owner-reconciliation-design.md)
- Plan: [docs/superpowers/plans/2026-06-29-777-author-owner-reconciliation.md](docs/superpowers/plans/2026-06-29-777-author-owner-reconciliation.md)

## How

**The view (Task 1):** Three layered CDS views. Layer 1 `MyTutorialsRaw` is a `UNION ALL` of 4 equally-shaped SELECTs (one per source). Layer 2 `MyTutorialsBestPriority` GROUP BYs with `MIN(priority)` to dedup. Layer 3 `MyTutorialsView` joins back to `Tutorials` + `TutorialMeta` for the rich field set. Follows the existing `Tasks` view precedent (db/views.cds:7-51).

**Critical invariant preserved:** `req.user.id === Users.uuid` (NOT `Users.ID`). All four UNION branches JOIN Users to translate `Users.ID` FK references into `Users.uuid` so the outer view's `userId` column matches the existing CAP filter convention.

**Consumers (Tasks 2-6):**
- `srv/author-service.js` filter changes from `ownerUserId` to `userId`.
- `srv/server.js` `/auth/user` exposes `userId` as an alias of `id`.
- `srv/routes/advocates-public.js` reads MyTutorialsView via a new `srv/lib/resolve-my-tutorials.js` wrapper.
- `app/admin-shell/webapp/controller/TutorialDashboard.controller.js` "monitored by me" filter fetches the user's tutorial-ID list from `/author/MyTutorials` instead of email-matching `TutorialMeta.owner`.

**Backfill (Task 7):** `scripts/backfill-tutorial-meta-author.cjs` resolves legacy `TutorialMeta.owner` text-only rows. Writes ONLY `TutorialMeta.ownerEmail` (NOT `author_ID` — that's owned by the existing `scripts/backfill-tutorial-authors.cjs`). Run sequence after deploy:

```bash
npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --dry-run
# review .migration-data/tutorial-meta-author-{proposed,orphans}.csv
npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --commit
npm run migrate:authors  # the existing script picks up the new ownerEmail rows
```

## Tests

- New: `test/unit/srv/resolve-my-tutorials.test.js` (8 cases for the JS wrapper).
- New: `test/unit/scripts/backfill-tutorial-meta-author.test.js` (6 cases for the resolveLegacyOwner helper).
- New: `test/hybrid/my-tutorials-view-union.test.js` (6 cases for the actual HANA view + EXPLAIN PLAN gate).
- Existing advocates and AuthorService smoke tests should pass with no changes; the response shape is unchanged.

## EXPLAIN PLAN verification

Per spec §4.7, the layered view's `WHERE userId = ?` filter must push down through each UNION ALL branch. Task 8 documents the procedure. Plan output attached as a comment after running on DEV.

## Rollback

`git revert` + redeploy. Reverts the view to its previous shape. Counts drop back to 11/7/0 across surfaces. No data corruption — backfill only writes to NULL fields.

## Manual smoke after deploy

1. Hit `/admin-ui/#dashboard` as Tom — "Monitored by me" toggle shows ~77 tutorials.
2. Visit `/developer-advocates/` and find Tom's card → ~77 authored.
3. Sage hits `/author/MyTutorials` → returns ~77 rows.
4. Run backfill `--dry-run`, review CSVs.
5. Run backfill `--commit`.
6. Re-run `npm run migrate:authors`.
7. Verify counts unchanged on all surfaces (still ~77).
PR_BODY_EOF
```

- [ ] **Step 3: Create the PR**

```bash
gh pr create --base main --head 777-author-owner-reconciliation \
  --title "feat(#777): reconcile author/owner across MyTutorials + advocate + admin" \
  --body-file ./PR_BODY.md
```

- [ ] **Step 4: Remove the body file (do NOT commit it)**

```bash
rm PR_BODY.md
```

- [ ] **Step 5: Verify CI green**

Watch the standard CI run. Expected: green. Hybrid test will only run in environments with HANA + `ALLOW_HYBRID_WRITES=true` — CI does not. Manual run is the EXPLAIN PLAN gate.

---

## Task 10: Post-merge deploy + verify

**Files:** none

This task only runs after Tom explicitly signals deploy (per memories [[feedback_merge_confirmation_not_deploy_authorization]] / [[feedback_confirm_deploy_scope]]).

- [ ] **Step 1: Confirm deploy scope with Tom**

Ask: "Ready to deploy #777 to DEV? Scope is `db/views.cds` (view rewrite), `srv/` (author/advocates/server changes), `app/admin-shell/` (admin tile controller), one new script + tests. Includes the existing PR queue from earlier (#755, #766, #768, #770/771, #772, #773, #778 also waiting). Anything to bundle in?" Wait for explicit yes.

- [ ] **Step 2: Switch to primary tree, pull main, verify CF target**

```bash
cd D:/projects/tutorials-poc
git checkout main
git pull --ff-only origin main
cf target
```

Expected: DEV space. If wrong, STOP.

- [ ] **Step 3: Resolve mtaext placeholders**

Per CLAUDE.md "Local manual deploy":

```bash
test -n "$CONTENT_API_KEY" || { echo "ERROR: CONTENT_API_KEY not set"; exit 1; }
test -n "$REBUILD_API_KEY" || { echo "ERROR: REBUILD_API_KEY not set"; exit 1; }
test -n "$APPROUTER_URL"   || { echo "ERROR: APPROUTER_URL not set"; exit 1; }
test -n "$GITHUB_DISPATCH_TOKEN" || { echo "ERROR: GITHUB_DISPATCH_TOKEN not set"; exit 1; }

envsubst '$CONTENT_API_KEY $REBUILD_API_KEY $APPROUTER_URL $GITHUB_DISPATCH_TOKEN' \
  < deploy/dev.mtaext > deploy/dev.resolved.mtaext

if grep -qE '\$\{?[A-Z_]+\}?' deploy/dev.resolved.mtaext; then
  echo "ERROR: unresolved placeholder"; exit 1
else
  echo "OK: all placeholders resolved"
fi
```

- [ ] **Step 4: Build + deploy**

```bash
cd D:/projects/tutorials-poc
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f
```

- [ ] **Step 5: Run the backfill (post-deploy data step)**

```bash
cd D:/projects/tutorials-poc
npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --dry-run
```

Review `.migration-data/tutorial-meta-author-proposed.csv` and `.migration-data/tutorial-meta-author-orphans.csv` with Tom.

If Tom approves:

```bash
npx cds bind --exec -- node scripts/backfill-tutorial-meta-author.cjs --commit
npm run migrate:authors
```

- [ ] **Step 6: Manual smoke**

Walk Tom through the 7-step manual smoke from the PR body. Confirm counts.

- [ ] **Step 7: No commit (deploy step)**

---

## Notes / hazards

- **The 5-tutorial gap (77 → 7) caught by spec review is real.** Don't try to "fix" it by adding more sources to the resolver — it'll re-introduce the same fragility old IMS had. The backfill is the long-term fix; the new UNION view is the bridge that gets users to 77 today.
- **`req.user.id === Users.uuid` is the load-bearing invariant.** If a downstream consumer EVER passes a `Users.ID` to the filter, it returns zero. The hybrid test in Task 8 explicitly checks this.
- **Don't drop source #4 (legacy text-match) after the backfill.** The backfill resolves what it can; some legacy rows will stay unresolved (orphans). Source #4 is the safety net for those. After the backfill it stops being the primary signal.
- **The two backfill scripts write distinct columns.** New: `ownerEmail` only. Existing: `author_ID` only. Documented in spec §6. Run NEW first, then RE-RUN EXISTING.
- **CRLF on Windows:** all commits use `git -c core.autocrlf=false commit`.
- **Worktree for implementation; primary tree for deploy.** Tasks 1-9 in worktree; Task 10 in primary tree against `main`.
- **EXPLAIN PLAN is mandatory before merge.** Task 8 Step 3 isn't optional — it's the gate that confirms HANA isn't doing a full-table scan.
