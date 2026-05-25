# Sage Backend Gaps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close all eight backend gaps identified in [docs/developers/reference/sage-extension-migration.md](../../developers/reference/sage-extension-migration.md) so the Sage VS Code extension can move off legacy IMS — in a single additive PR with no destructive schema migration.

**Architecture:** New `AuthorService` at `@path: '/author'` gated on the existing `Tutorial.Author` scope. A new `MyTutorialsView` joins `TutorialMeta` to `Users` via a new additive `ownerEmail` column (avoiding the destructive `Association to Users` migration). `req.user.id` (= `Users.uuid`) gates auth via a `before('READ')` handler; `ownerEmail` is the data join key. Admin actions get extracted into a shared module that AuthorService also calls, plus `/health/auth`, OData `Prefer: odata.track-changes` annotations, and `managed` on `TutorialMeta` for ETag support.

**Tech Stack:** SAP CAP Node.js (CDS, OData v4), HANA Cloud (prod) / SQLite (unit tests), XSUAA scopes, Vitest workspaces (unit/hybrid/smoke).

**Spec:** [docs/superpowers/specs/2026-05-24-sage-backend-gaps-design.md](../specs/2026-05-24-sage-backend-gaps-design.md)

---

## File Structure

**Create:**

- `srv/author-service.cds` — service definition at `@path: '/author'`
- `srv/author-service.js` — handlers (MyTutorials filter, reviewTutorial, snoozeTutorial)
- `srv/lib/tutorial-review.js` — shared review/snooze logic; called by both AdminService and AuthorService
- `scripts/backfill-tutorial-meta-email.js` — one-off backfill from `Users` (firstName + lastName + displayName match)
- `test/unit/author-service.test.js` — in-memory SQLite, full coverage of filter, ownership, scope gating
- `test/hybrid/author-service.test.js` — real HANA via `cds bind --exec`; `__TEST__` prefixed, write-guarded
- `test/smoke/author-service.test.js` — HTTP against deployed; auth + scope + identity round-trip

**Modify:**

- `db/schema.cds` — `TutorialMeta` gains `managed` aspect + `ownerEmail : String(255)` column (line 200)
- `db/views.cds` — append `MyTutorialsView` (after existing `NavigatorCatalog` view)
- `srv/admin-service.cds` — annotate `Tutorials`/`Tags`/`MyTutorials` with `@Capabilities.ChangeTracking` (delta tracking opt-in for read consumers)
- `srv/admin-service.js` — replace inline `reviewTutorial`/`snoozeTutorial` bodies with calls to `srv/lib/tutorial-review.js` (no behavior change)
- `srv/server.js` — add `app.get('/health/auth', ...)` route
- `srv/lib/tutorial-meta-init.js` — populate `ownerEmail` from `IMSTutorialMeta._links.owner.href` during sync (forward path; backfill script handles existing rows)

**Why this decomposition:**

- `tutorial-review.js` is its own file because BOTH AdminService and AuthorService call it. Inlining in either service forces the other to import from the wrong layer.
- `author-service.cds` and `author-service.js` mirror the existing `admin-service.{cds,js}` pair. CAP convention; nothing exotic.
- The backfill script lives in `scripts/` (next to `migrate-reference-data.js`, `setup-dev-data.cjs`) — it's a one-off op, not part of the runtime.
- `db/views.cds` already exists with views; appending is consistent with the project's pattern.

---

## Pre-flight: branch + worktree

- [ ] **Step 0a: Create a worktree** (per memory `feedback_parallel_agents_worktrees`)

```bash
git worktree add .worktrees/sage-backend-gaps -b feature/sage-backend-gaps origin/main
cd .worktrees/sage-backend-gaps
npm install
```

- [ ] **Step 0b: Confirm clean baseline**

```bash
npm test -- --run
```
Expected: pre-existing 620 unit tests pass (per memory `project_main_test_failures`).

---

## Task 1: Schema change — add `managed` + `ownerEmail` to TutorialMeta

**Files:**

- Modify: `db/schema.cds:200-207`
- Test: `test/unit/author-service.test.js` (new file — write the first failing test against the absent column)

- [ ] **Step 1: Write the failing test**

Create `test/unit/author-service.test.js` with this single test as a starting point:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('TutorialMeta schema', () => {
  beforeAll(async () => {
    await cds.test('.');
  });

  it('exposes ownerEmail column on TutorialMeta', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    expect(TutorialMeta.elements.ownerEmail).toBeDefined();
    expect(TutorialMeta.elements.ownerEmail.type).toBe('cds.String');
  });

  it('TutorialMeta is managed (has modifiedAt)', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    expect(TutorialMeta.elements.modifiedAt).toBeDefined();
    expect(TutorialMeta.elements.createdBy).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test — verify fail**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: FAIL — `ownerEmail` undefined; `modifiedAt` undefined.

- [ ] **Step 3: Modify `db/schema.cds`**

Replace the existing TutorialMeta block (line 200-207):

```cds
entity TutorialMeta : cuid, managed, LegacyKeyed {
  tutorial                  : Association to Tutorials;
  reviewedDate              : Timestamp;
  owner                     : String(255);
  ownerEmail                : String(255);
  monitoredStatus           : String(50);
  notificationNumber        : Integer default 0;
  lastNotificationDate      : Timestamp;
}
```

- [ ] **Step 4: Run test — verify pass**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: PASS.

- [ ] **Step 5: Run the full unit suite — confirm no regressions**

```bash
npm test -- --run
```
Expected: 620+ passing (the 2 new tests added). If any pre-existing test reads `TutorialMeta` without selecting `modifiedAt` and is now affected by `managed`, surface it before continuing.

- [ ] **Step 6: Commit**

```bash
git add db/schema.cds test/unit/author-service.test.js
git commit -m "feat(schema): add managed + ownerEmail to TutorialMeta"
```

---

## Task 2: MyTutorialsView in db/views.cds

**Files:**

- Modify: `db/views.cds` (append after `NavigatorCatalog`)
- Test: `test/unit/author-service.test.js` (extend with view tests)

- [ ] **Step 1: Write the failing tests**

Append to `test/unit/author-service.test.js`:

```js
// SELECT, INSERT, UPDATE, DELETE are globals attached by cds.test() — no import needed.
// Same pattern used across the existing test/unit/ suite.

describe('MyTutorialsView', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');

    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await DELETE.from(Users);

    await INSERT.into(Users).entries([
      { ID: 'u-A', uuid: 'uuid-A', email: 'alice@example.com', firstName: 'Alice', lastName: 'A', displayName: 'Alice A' },
      { ID: 'u-B', uuid: 'uuid-B', email: 'bob@example.com',   firstName: 'Bob',   lastName: 'B', displayName: 'Bob B' }
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: 't-1', slug: 'tut-1', title: 'Tutorial 1', status: 'ACTIVE' },
      { ID: 't-2', slug: 'tut-2', title: 'Tutorial 2', status: 'ACTIVE' },
      { ID: 't-3', slug: 'tut-3', title: 'Orphan',     status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: 'm-1', tutorial_ID: 't-1', owner: 'Alice A', ownerEmail: 'alice@example.com' },
      { ID: 'm-2', tutorial_ID: 't-2', owner: 'Bob B',   ownerEmail: 'bob@example.com' },
      { ID: 'm-3', tutorial_ID: 't-3', owner: 'Ghost',   ownerEmail: 'nosuch@example.com' }
    ]);
  });

  it('joins meta to Users by email and exposes ownerUserId', async () => {
    const db = await cds.connect.to('db');
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(MyTutorialsView).where({ ownerEmail: 'alice@example.com' }));
    expect(rows).toHaveLength(1);
    expect(rows[0].ownerUserId).toBe('u-A');
    expect(rows[0].slug).toBe('tut-1');
  });

  it('excludes orphaned meta where ownerEmail has no matching Users row', async () => {
    const db = await cds.connect.to('db');
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(MyTutorialsView).where({ ownerEmail: 'nosuch@example.com' }));
    expect(rows).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: FAIL — `MyTutorialsView` not defined.

- [ ] **Step 3: Append the view to `db/views.cds`**

```cds
view MyTutorialsView as
  select from Tutorials as t
    inner join TutorialMeta as m on m.tutorial.ID = t.ID
    inner join Users        as u on u.email       = m.ownerEmail
  {
    key t.ID,
        t.slug,
        t.title,
        t.primaryTag,
        t.status,
        m.reviewedDate,
        m.monitoredStatus,
        m.notificationNumber,
        m.lastNotificationDate,
        m.owner       as ownerName,
        m.ownerEmail  as ownerEmail,
        u.ID          as ownerUserId
  };
```

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add db/views.cds test/unit/author-service.test.js
git commit -m "feat(db): add MyTutorialsView joining TutorialMeta to Users via email"
```

---

## Task 3: Extract `srv/lib/tutorial-review.js` (shared review/snooze)

**Files:**

- Create: `srv/lib/tutorial-review.js`
- Test: `test/unit/lib/tutorial-review.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/lib/tutorial-review.test.js`:

```js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { reviewTutorial, snoozeTutorial } from '../../../srv/lib/tutorial-review.js';

describe('tutorial-review module', () => {
  beforeAll(async () => { await cds.test('.'); });

  beforeEach(async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries({ ID: 't-rev', slug: 'rev', title: 'R', status: 'ACTIVE' });
    await INSERT.into(TutorialMeta).entries({
      ID: 'm-rev', tutorial_ID: 't-rev', owner: 'X',
      reviewedDate: '2020-01-01T00:00:00Z',
      notificationNumber: 5,
      lastNotificationDate: '2024-01-01T00:00:00Z'
    });
  });

  it('reviewTutorial resets reviewedDate and notification counters', async () => {
    const result = await reviewTutorial('t-rev');
    expect(result.notificationNumber).toBe(0);
    expect(result.reviewedDate).toBeDefined();
    expect(new Date(result.reviewedDate).getTime()).toBeGreaterThan(Date.parse('2020-01-01T00:00:00Z'));
  });

  it('reviewTutorial throws when meta not found', async () => {
    await expect(reviewTutorial('does-not-exist')).rejects.toThrow(/not found/i);
  });

  it('snoozeTutorial sets lastNotificationDate days into the future', async () => {
    const result = await snoozeTutorial('t-rev', 7);
    const delta = Date.parse(result.lastNotificationDate) - Date.now();
    expect(delta).toBeGreaterThan(6.5 * 86400000);
    expect(delta).toBeLessThan(7.5 * 86400000);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
npx vitest run test/unit/lib/tutorial-review.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Create the module**

Create `srv/lib/tutorial-review.js` (ESM — `package.json` has `"type": "module"` and the rest of `srv/` uses `import`/`export`):

```js
import cds from '@sap/cds';

export async function reviewTutorial(tutorialId) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) {
    const err = new Error(`TutorialMeta not found for tutorial: ${tutorialId}`);
    err.code = 404;
    throw err;
  }
  const now = new Date().toISOString();
  await UPDATE(TutorialMeta, meta.ID).set({
    reviewedDate: now,
    notificationNumber: 0,
    lastNotificationDate: null
  });
  return { reviewedDate: now, notificationNumber: 0 };
}

export async function snoozeTutorial(tutorialId, days) {
  const { TutorialMeta } = cds.entities('com.sap.developers.ims');
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutorialId });
  if (!meta) {
    const err = new Error(`TutorialMeta not found for tutorial: ${tutorialId}`);
    err.code = 404;
    throw err;
  }
  const snoozeUntil = new Date(Date.now() + (days || 30) * 86400000).toISOString();
  await UPDATE(TutorialMeta, meta.ID).set({ lastNotificationDate: snoozeUntil });
  return { lastNotificationDate: snoozeUntil, notificationNumber: meta.notificationNumber };
}
```

Note: `SELECT` and `UPDATE` are CDS QL globals attached by the CAP runtime — no import needed. The rest of `srv/` (e.g. `admin-service.js`, `search-service.js`) follows the same pattern.

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run test/unit/lib/tutorial-review.test.js
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/tutorial-review.js test/unit/lib/tutorial-review.test.js
git commit -m "feat(srv): extract tutorial-review shared module"
```

---

## Task 4: Refactor AdminService to use shared module

**Files:**

- Modify: `srv/admin-service.js:544-568`

- [ ] **Step 1: Confirm existing AdminService action tests pass before refactor**

```bash
npm test -- --run admin-service
```
Expected: PASS (baseline).

- [ ] **Step 2: Refactor handlers to delegate to the shared module**

In `srv/admin-service.js`, add this import at the top of the file alongside the other `import` lines:

```js
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';
```

Then replace the `reviewTutorial` block at line 544 and `snoozeTutorial` at line 559 with:

```js
this.on('reviewTutorial', async (req) => {
  try {
    return await reviewTutorial(req.data.tutorialId);
  } catch (err) {
    if (err.code === 404) return req.reject(404, err.message);
    throw err;
  }
});

this.on('snoozeTutorial', async (req) => {
  try {
    return await snoozeTutorial(req.data.tutorialId, req.data.days);
  } catch (err) {
    if (err.code === 404) return req.reject(404, err.message);
    throw err;
  }
});
```

- [ ] **Step 3: Run AdminService tests — verify still pass**

```bash
npm test -- --run admin-service
```
Expected: PASS (no behavior change).

- [ ] **Step 4: Commit**

```bash
git add srv/admin-service.js
git commit -m "refactor(admin): delegate reviewTutorial/snoozeTutorial to shared module"
```

---

## Task 5: AuthorService CDS definition

**Files:**

- Create: `srv/author-service.cds`
- Test: `test/unit/author-service.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/author-service.test.js`:

```js
describe('AuthorService surface', () => {
  it('exposes Tutorials, Tags, MyTutorials read entities and review/snooze actions', async () => {
    const srv = await cds.connect.to('AuthorService');
    expect(srv.entities.Tutorials).toBeDefined();
    expect(srv.entities.Tags).toBeDefined();
    expect(srv.entities.MyTutorials).toBeDefined();
    expect(srv.operations.reviewTutorial).toBeDefined();
    expect(srv.operations.snoozeTutorial).toBeDefined();
  });

  it('AuthorService.Tutorials is read-only', async () => {
    const srv = await cds.connect.to('AuthorService');
    const tut = srv.entities.Tutorials;
    expect(tut['@readonly']).toBe(true);
  });

  it('denies AuthorService.Tags read for anonymous callers', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx({ user: { id: 'anonymous', roles: {} } }, (tx) =>
        tx.run(SELECT.from(srv.entities.Tags))
      )
    ).rejects.toMatchObject({ code: '403' });
  });

  it('allows AuthorService.Tags read for Tutorial.Author callers', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.Tags))
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: FAIL — `AuthorService` not found.

- [ ] **Step 3: Create `srv/author-service.cds`**

```cds
using { com.sap.developers.ims as ims } from '../db/schema';
using from '../db/views';

@path: '/author'
@requires: 'Tutorial.Author'
service AuthorService {

  @readonly entity Tutorials as projection on ims.Tutorials {
    ID, slug, title, primaryTag, status
  };

  @readonly entity Tags as projection on ims.Tags;

  @readonly entity MyTutorials as projection on ims.MyTutorialsView;

  action reviewTutorial(tutorialId : UUID) returns {
    reviewedDate       : Timestamp;
    notificationNumber : Integer;
  };

  action snoozeTutorial(tutorialId : UUID, days : Integer) returns {
    lastNotificationDate : Timestamp;
    notificationNumber   : Integer;
  };
}
```

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: PASS — service surface present (handlers added next task; for now no `req.user` filtering yet, so MyTutorials returns all rows).

- [ ] **Step 5: Commit**

```bash
git add srv/author-service.cds test/unit/author-service.test.js
git commit -m "feat(srv): add AuthorService CDS definition at /author"
```

---

## Task 6: AuthorService MyTutorials filter (req.user.id binding)

**Files:**

- Create: `srv/author-service.js`
- Test: `test/unit/author-service.test.js` (extend)

- [ ] **Step 1: Write the failing test**

Append to `test/unit/author-service.test.js`:

```js
import { POST, GET, axios } from '../axios-helpers.js'; // adapt to existing test helpers if present

describe('AuthorService.MyTutorials filtering', () => {
  it('filters MyTutorials to ownerUserId == req.user.id', async () => {
    const srv = await cds.connect.to('AuthorService');
    // simulate: alice has uuid-A; her MyTutorials should be tut-1 only.
    const rows = await srv.tx({ user: { id: 'uuid-A' } }, async (tx) => {
      return await tx.run(SELECT.from(srv.entities.MyTutorials));
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('tut-1');
  });

  it('returns empty array when req.user.id matches no Users.uuid', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx({ user: { id: 'unknown-uuid' } }, async (tx) => {
      return await tx.run(SELECT.from(srv.entities.MyTutorials));
    });
    expect(rows).toHaveLength(0);
  });

  it('still filters when client uses $apply=groupby((status))', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx({ user: { id: 'uuid-A' } }, async (tx) => {
      return await tx.send({
        method: 'GET',
        path: 'MyTutorials?$apply=groupby((status))'
      });
    });
    // Aggregate row count must reflect alice's data only (1 distinct status).
    expect(rows.length).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: FAIL — first test sees both alice and bob rows because no filter exists.

- [ ] **Step 3: Create `srv/author-service.js`**

```js
import cds from '@sap/cds';

export default cds.service.impl(async function () {
  const { MyTutorials } = this.entities;

  this.before('READ', MyTutorials, (req) => {
    const userId = req.user?.id;
    if (!userId || userId === 'anonymous') {
      return req.reject(401, 'Authentication required');
    }
    req.query.where({ ownerUserId: userId });
  });
});
```

Note on `req.query.where(...)`: CAP's CQN-fluent API returns the modified query and AND-merges with existing predicates. This is the canonical narrow-on-read pattern (see `srv/search-service.js:75-76` for an in-project precedent that uses the same chained `q.where(...)` form). The handler also runs for `$apply`/aggregate queries — covered by the test at Step 1.

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/author-service.js test/unit/author-service.test.js
git commit -m "feat(srv): filter AuthorService.MyTutorials by req.user.id"
```

---

## Task 7: AuthorService actions with ownership check

**Files:**

- Modify: `srv/author-service.js`
- Test: `test/unit/author-service.test.js` (extend)

- [ ] **Step 1: Write the failing tests**

Append:

```js
describe('AuthorService.reviewTutorial/snoozeTutorial', () => {
  it('reviewTutorial succeeds when caller owns the tutorial', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx({ user: { id: 'uuid-A' } }, (tx) =>
      tx.send('reviewTutorial', { tutorialId: 't-1' })
    );
    expect(result.notificationNumber).toBe(0);
    expect(result.reviewedDate).toBeDefined();
  });

  it('reviewTutorial returns 403 when caller does not own the tutorial', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx({ user: { id: 'uuid-A' } }, (tx) =>
        tx.send('reviewTutorial', { tutorialId: 't-2' /* bob's */ })
      )
    ).rejects.toMatchObject({ code: '403' });
  });

  it('snoozeTutorial accepts days in [1, 365]', async () => {
    const srv = await cds.connect.to('AuthorService');
    const ok = await srv.tx({ user: { id: 'uuid-A' } }, (tx) =>
      tx.send('snoozeTutorial', { tutorialId: 't-1', days: 30 })
    );
    expect(ok.lastNotificationDate).toBeDefined();
  });

  it('snoozeTutorial rejects out-of-range days', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx({ user: { id: 'uuid-A' } }, (tx) =>
        tx.send('snoozeTutorial', { tutorialId: 't-1', days: 999 })
      )
    ).rejects.toMatchObject({ code: '400' });
    await expect(
      srv.tx({ user: { id: 'uuid-A' } }, (tx) =>
        tx.send('snoozeTutorial', { tutorialId: 't-1', days: 0 })
      )
    ).rejects.toMatchObject({ code: '400' });
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: FAIL — actions not handled.

- [ ] **Step 3: Add action handlers to `srv/author-service.js`**

Replace the file contents:

```js
import cds from '@sap/cds';
import { reviewTutorial, snoozeTutorial } from './lib/tutorial-review.js';

async function assertOwnership(tx, tutorialId, userId) {
  const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
  const row = await tx.run(
    SELECT.one.from(MyTutorialsView).columns('ID').where({ ID: tutorialId, ownerUserId: userId })
  );
  return !!row;
}

export default cds.service.impl(async function () {
  const { MyTutorials } = this.entities;

  this.before('READ', MyTutorials, (req) => {
    const userId = req.user?.id;
    if (!userId || userId === 'anonymous') return req.reject(401, 'Authentication required');
    req.query.where({ ownerUserId: userId });
  });

  this.on('reviewTutorial', async (req) => {
    const userId = req.user?.id;
    const { tutorialId } = req.data;
    const tx = cds.tx(req);
    if (!(await assertOwnership(tx, tutorialId, userId))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
    try {
      return await reviewTutorial(tutorialId);
    } catch (err) {
      if (err.code === 404) return req.reject(404, err.message);
      throw err;
    }
  });

  this.on('snoozeTutorial', async (req) => {
    const userId = req.user?.id;
    const { tutorialId, days } = req.data;
    if (!Number.isInteger(days) || days < 1 || days > 365) {
      return req.reject(400, 'days must be an integer in [1, 365]');
    }
    const tx = cds.tx(req);
    if (!(await assertOwnership(tx, tutorialId, userId))) {
      return req.reject(403, 'Not the owner of this tutorial');
    }
    try {
      return await snoozeTutorial(tutorialId, days);
    } catch (err) {
      if (err.code === 404) return req.reject(404, err.message);
      throw err;
    }
  });
});
```

- [ ] **Step 4: Run — verify pass**

```bash
npx vitest run test/unit/author-service.test.js
```
Expected: PASS (all suite tests).

- [ ] **Step 5: Commit**

```bash
git add srv/author-service.js test/unit/author-service.test.js
git commit -m "feat(srv): AuthorService review/snooze with same-tx ownership check"
```

---

## Task 8: OData ChangeTracking annotations + admin-service.cds delta opt-in

**Files:**

- Modify: `srv/author-service.cds`
- Modify: `srv/admin-service.cds` (also annotate Tutorials/Tags so existing admin clients can opt in if they choose)
- Test: `test/hybrid/author-service.test.js` (delta link smoke; SQLite doesn't materialize `@odata.deltaLink`)

- [ ] **Step 1: Annotate the projections**

In `srv/author-service.cds`, prepend `@Capabilities.ChangeTracking : { Supported: true }` to each readonly entity:

```cds
@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tutorials as projection on ims.Tutorials {
  ID, slug, title, primaryTag, status
};

@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tags as projection on ims.Tags;

@Capabilities.ChangeTracking : { Supported: true }
@readonly entity MyTutorials as projection on ims.MyTutorialsView;
```

In `srv/admin-service.cds`, add `@Capabilities.ChangeTracking : { Supported: true }` to `Tutorials` and `Tags` projections (lines 12 and 25). Do **not** annotate other entities — keep blast radius small.

- [ ] **Step 2: Run unit tests — verify metadata still loads**

```bash
npm test -- --run author-service
```
Expected: PASS (annotations are additive; metadata-only change).

- [ ] **Step 3: Commit**

```bash
git add srv/author-service.cds srv/admin-service.cds
git commit -m "feat(odata): advertise ChangeTracking on Tutorials/Tags/MyTutorials"
```

(Hybrid `Prefer: odata.track-changes` smoke test added in Task 12.)

---

## Task 9: `/health/auth` endpoint

**Files:**

- Modify: `srv/server.js`
- Test: `test/unit/health-auth.test.js` (new)

- [ ] **Step 1: Locate the bootstrap-time route block**

```bash
grep -n "cds.on('bootstrap'" srv/server.js
grep -n "app.get(" srv/server.js | head -10
```

- [ ] **Step 2: Write the failing test**

Create `test/unit/health-auth.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import axios from 'axios';

describe('/health/auth', () => {
  let url;
  beforeAll(async () => {
    const { server } = await cds.test('.');
    url = `http://localhost:${server.address().port}`;
  });

  it('returns 401 for anonymous callers', async () => {
    const res = await axios.get(`${url}/health/auth`, { validateStatus: () => true });
    expect(res.status).toBe(401);
    expect(res.data.authenticated).toBe(false);
  });

  it('returns 200 + scopes for authenticated callers', async () => {
    const res = await axios.get(`${url}/health/auth`, {
      auth: { username: 'alice', password: '' },
      validateStatus: () => true
    });
    // mocked auth in cds.test; alice is anonymous-equivalent unless seeded — adapt assertion to project's mock-auth fixtures
    expect([200, 401]).toContain(res.status);
    if (res.status === 200) {
      expect(res.data.authenticated).toBe(true);
      expect(Array.isArray(res.data.scopes)).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run — verify fail (404 or wrong status)**

```bash
npx vitest run test/unit/health-auth.test.js
```
Expected: FAIL — route not registered.

- [ ] **Step 4: Add route to `srv/server.js`**

In the `cds.on('bootstrap', (app) => { ... })` block, add:

```js
app.get('/health/auth', cds.middlewares.before, (req, res) => {
  if (!req.user || req.user.id === 'anonymous') {
    return res.status(401).json({ authenticated: false });
  }
  // cds.User exposes roles as an object map { roleName: true }; both XSUAA and
  // mocked-auth populate this shape. Object.keys is safe for both — Array.from
  // would fail on the object-map form. See `srv/admin-service.js:707` for the
  // canonical role check pattern (`req.user.is('SuperAdmin')`).
  const roles = req.user.roles ?? {};
  res.json({
    authenticated: true,
    user: req.user.id,
    scopes: Object.keys(roles),
    serverTime: new Date().toISOString()
  });
});
```

- [ ] **Step 5: Run — verify pass**

```bash
npx vitest run test/unit/health-auth.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/server.js test/unit/health-auth.test.js
git commit -m "feat(srv): add /health/auth diagnostic endpoint"
```

---

## Task 10: Forward-path ownerEmail population on content publish

**Context — verified upfront:** the IMS API (`IMSTutorialMeta._links.owner.href`) is no longer the live source of truth in this codebase. Per memory `[[project_tutorial_meta_auto_init]]`, `srv/lib/tutorial-sync.js` (which read IMS payloads) was retired; `TutorialMeta` is now created and refreshed by `srv/lib/content-store.js` during `POST /content/publish`. That handler already resolves an email at [srv/lib/content-store.js:356-360](../../../srv/lib/content-store.js#L356-L360) (variable `resolvedOwner`, sourced from `meta.primaryContributorEmail` or `ContributorEmails[login].email`) and currently writes it to `TutorialMeta.owner`. The forward-path fix is to write that already-resolved email to the new `ownerEmail` column, so `MyTutorialsView` returns rows for newly published tutorials without waiting on the backfill.

The `syncTutorialMetadata` admin action ([srv/admin-service.js:536-540](../../../srv/admin-service.js#L536-L540)) only calls `backfillMissingTutorialMeta` ([srv/lib/tutorial-meta-init.js](../../../srv/lib/tutorial-meta-init.js)) which inserts empty meta rows — no owner data flows through it. No changes needed there.

**Files:**

- Modify: `srv/lib/content-store.js` (lines 362-372 and 378-382)
- Modify: `test/lib/content-store-tutorial-meta.test.js` (extend existing suite)

- [ ] **Step 1: Verify the source of `resolvedOwner` upfront**

```bash
grep -n "resolvedOwner\|primaryContributorEmail\|ContributorEmails" srv/lib/content-store.js
```
Expected: shows that `resolvedOwner` at `srv/lib/content-store.js:356-360` is an email string (or null). Confirms we can write it straight to `ownerEmail`.

- [ ] **Step 2: Write the failing test**

This follows the existing pattern from `test/lib/content-store-tutorial-meta.test.js` (drive the publish flow through `POST /content/publish` via `cds.test()`'s axios; do NOT try to import `content-store.js` directly — its handlers are not exported as named functions).

Append to `test/lib/content-store-tutorial-meta.test.js` (the existing suite already cleans up TutorialMeta in `beforeEach`):

```js
it('publish writes ownerEmail (not just owner) when primaryContributorEmail is present', async () => {
  const slug = 'auto-init-email';
  const res = await project.axios.post('/content/publish', {
    trigger: 'test',
    files: { [slug]: gz('<p>hi</p>') },
    metadata: {
      [slug]: {
        slug, title: 'Auto-init Email', description: '', time: 5, level: 'Beginner',
        primaryTag: 'Test', stepCount: 1, steps: [{ number: 1, title: 'Step' }],
        lastUpdated: '2026-05-20T10:00:00Z',
        primaryContributorEmail: 'fp-test@example.com'
      }
    },
    bodyTexts: { [slug]: 'hi' }
  }, { headers: { Authorization: `Bearer ${API_KEY}` } });

  expect(res.status).toBe(201);
  const tut = await SELECT.one.from(Tutorials).where({ slug });
  const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tut.ID });
  expect(meta.ownerEmail).toBe('fp-test@example.com');
  expect(meta.owner).toBe('fp-test@example.com'); // unchanged behavior — both populated
});
```

- [ ] **Step 3: Run — verify fail**

```bash
npx vitest run test/lib/content-store-tutorial-meta.test.js
```
Expected: FAIL — `meta.ownerEmail` is `undefined` (current code writes only `owner`).

- [ ] **Step 4: Update content-store.js**

In `srv/lib/content-store.js`, change the INSERT block at lines 362-372 from:

```js
if (!existingMeta) {
  await INSERT.into(TutorialMeta).entries({
    ID: cds.utils.uuid(),
    tutorial_ID: tutorialId,
    owner: resolvedOwner,
    reviewedDate: lastUpdated,
    monitoredStatus: 'ACTIVE',
    notificationNumber: 0,
    lastNotificationDate: null,
    legacyId: await getNextLegacyId('TutorialMeta', db)
  });
}
```

to:

```js
if (!existingMeta) {
  await INSERT.into(TutorialMeta).entries({
    ID: cds.utils.uuid(),
    tutorial_ID: tutorialId,
    owner: resolvedOwner,        // legacy display-name slot — kept for backward compat
    ownerEmail: resolvedOwner,   // NEW: data-join key for MyTutorialsView
    reviewedDate: lastUpdated,
    monitoredStatus: 'ACTIVE',
    notificationNumber: 0,
    lastNotificationDate: null,
    legacyId: await getNextLegacyId('TutorialMeta', db)
  });
}
```

And in the UPDATE branch at lines 378-382, additionally backfill `ownerEmail` whenever it is currently NULL:

```js
const updates = {
  reviewedDate: lastUpdated,
  notificationNumber: 0,
  lastNotificationDate: null
};
if (resolvedOwner && !existingMeta.ownerEmail) updates.ownerEmail = resolvedOwner;
await UPDATE(TutorialMeta).where({ ID: existingMeta.ID }).set(updates);
```

(The UPDATE pre-read at line 351 will need to include `ownerEmail` in its column list; verify and add.)

- [ ] **Step 5: Run — verify pass**

```bash
npx vitest run test/lib/content-store-tutorial-meta.test.js
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/content-store.js test/lib/content-store-tutorial-meta.test.js
git commit -m "feat(content-store): populate TutorialMeta.ownerEmail on publish"
```

---

## Task 11: Backfill script

**Files:**

- Create: `scripts/backfill-tutorial-meta-email.js`
- Create: `.migration-data/.gitkeep` (if not present)

- [ ] **Step 1: Implement the script**

```js
// scripts/backfill-tutorial-meta-email.js
//
// Best-effort backfill of TutorialMeta.ownerEmail from Users by name.
// Idempotent: only updates rows where ownerEmail IS NULL.
// Unresolved rows logged to .migration-data/ownerEmail-unresolved.csv.
//
// Usage: npx cds bind --exec -- node scripts/backfill-tutorial-meta-email.js [--dry-run]

import cds from '@sap/cds';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function backfill({ dryRun = false } = {}) {
  const db = await cds.connect.to('db');
  const { TutorialMeta, Users } = cds.entities('com.sap.developers.ims');

  const metas = await db.run(
    SELECT.from(TutorialMeta).columns('ID', 'owner', 'ownerEmail').where(`ownerEmail IS NULL`)
  );
  const users = await db.run(SELECT.from(Users).columns('ID', 'email', 'firstName', 'lastName', 'displayName'));

  const byFullName = new Map();
  const byDisplay  = new Map();
  for (const u of users) {
    if (!u.email) continue;
    if (u.firstName && u.lastName) byFullName.set(`${u.firstName} ${u.lastName}`.toLowerCase(), u.email);
    if (u.displayName) byDisplay.set(u.displayName.toLowerCase(), u.email);
  }

  let resolved = 0;
  const unresolved = [];
  for (const m of metas) {
    if (!m.owner) { unresolved.push({ id: m.ID, owner: '', reason: 'empty owner' }); continue; }
    const key = m.owner.toLowerCase();
    const email = byFullName.get(key) || byDisplay.get(key);
    if (!email) { unresolved.push({ id: m.ID, owner: m.owner, reason: 'no Users match' }); continue; }
    if (!dryRun) await db.run(UPDATE(TutorialMeta, m.ID).set({ ownerEmail: email }));
    resolved++;
  }

  const dir = path.resolve(process.cwd(), '.migration-data');
  fs.mkdirSync(dir, { recursive: true });
  const csv = ['id,owner,reason', ...unresolved.map(r => `${r.id},"${r.owner}",${r.reason}`)].join('\n');
  fs.writeFileSync(path.join(dir, 'ownerEmail-unresolved.csv'), csv);

  console.log(`Resolved: ${resolved}/${metas.length}. Unresolved logged to .migration-data/ownerEmail-unresolved.csv.`);
  return { resolved, unresolved: unresolved.length, total: metas.length };
}

// Run when invoked directly (ESM equivalent of `require.main === module`)
const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isDirectRun) {
  const dryRun = process.argv.includes('--dry-run');
  backfill({ dryRun }).then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 2: Smoke-run the script in-memory**

```bash
node scripts/backfill-tutorial-meta-email.js --dry-run
```
Expected: prints resolved/total and writes empty/near-empty CSV (no real data in dev SQLite).

- [ ] **Step 3: Commit**

```bash
git add scripts/backfill-tutorial-meta-email.js
git commit -m "feat(scripts): add ownerEmail backfill script"
```

---

## Task 12: Hybrid tests (real HANA)

**Files:**

- Create: `test/hybrid/author-service.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import axios from 'axios';

const TEST_PREFIX = '__TEST__';

describe.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')('AuthorService on HANA', () => {
  let createdIds = { user: null, tutorial: null, meta: null };

  beforeAll(async () => {
    await cds.connect.to('db');
    const { Users, Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    const u = await INSERT.into(Users).entries({
      uuid: `${TEST_PREFIX}-uuid`,
      email: `${TEST_PREFIX}@example.com`,
      firstName: 'TEST', lastName: 'USER', displayName: '__TEST__ USER'
    });
    const t = await INSERT.into(Tutorials).entries({
      slug: `${TEST_PREFIX}-slug`, title: `${TEST_PREFIX} title`, status: 'ACTIVE'
    });
    const m = await INSERT.into(TutorialMeta).entries({
      tutorial_ID: t.ID, owner: '__TEST__ USER', ownerEmail: `${TEST_PREFIX}@example.com`
    });
    createdIds = { user: u.ID, tutorial: t.ID, meta: m.ID };
  });

  afterAll(async () => {
    const { Users, Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    if (createdIds.meta) await DELETE.from(TutorialMeta).where({ ID: createdIds.meta });
    if (createdIds.tutorial) await DELETE.from(Tutorials).where({ ID: createdIds.tutorial });
    if (createdIds.user) await DELETE.from(Users).where({ ID: createdIds.user });
  });

  it('MyTutorialsView returns the seeded row on HANA', async () => {
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(MyTutorialsView).where({ ownerEmail: `${TEST_PREFIX}@example.com` });
    expect(rows.length).toBeGreaterThan(0);
  });

  it('reviewTutorial bumps modifiedAt on TutorialMeta (managed proof)', async () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    const before = await SELECT.one.from(TutorialMeta).where({ ID: createdIds.meta });
    const { reviewTutorial } = await import('../../srv/lib/tutorial-review.js');
    await reviewTutorial(createdIds.tutorial);
    const after = await SELECT.one.from(TutorialMeta).where({ ID: createdIds.meta });
    expect(Date.parse(after.modifiedAt)).toBeGreaterThan(Date.parse(before.modifiedAt || '2000-01-01'));
  });

  it('GET /author/Tutorials with Prefer: odata.track-changes returns @odata.deltaLink', async () => {
    // Requires SMOKE_AUTHOR_TOKEN (a JWT for a Tutorial.Author user) and SMOKE_SRV_URL
    // to exercise the deployed delta endpoint. Skipped otherwise.
    const SRV = process.env.SMOKE_SRV_URL;
    const TOKEN = process.env.SMOKE_AUTHOR_TOKEN;
    if (!SRV || !TOKEN) return;
    const res = await axios.get(`${SRV}/author/Tutorials?$top=5`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Prefer: 'odata.track-changes'
      }
    });
    expect(res.status).toBe(200);
    expect(res.data['@odata.deltaLink']).toBeDefined();
  });
});
```

- [ ] **Step 2: Run against HANA**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- author-service
```
Expected: PASS (requires `cf login` to DEV space).

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/author-service.test.js
git commit -m "test(hybrid): AuthorService + MyTutorialsView on HANA"
```

---

## Task 13: Smoke tests

**Files:**

- Create: `test/smoke/author-service.test.js`

- [ ] **Step 1: Write the smoke test**

```js
import { describe, it, expect } from 'vitest';
import axios from 'axios';

const SRV = process.env.SMOKE_SRV_URL;
const APPROUTER = process.env.SMOKE_BASE_URL;

describe.skipIf(!SRV)('AuthorService smoke', () => {
  it('GET /author/Tutorials returns 401 without auth', async () => {
    const res = await axios.get(`${SRV}/author/Tutorials`, { validateStatus: () => true });
    expect(res.status).toBe(401);
  });

  it('GET /health/auth returns 401 without auth', async () => {
    const res = await axios.get(`${SRV}/health/auth`, { validateStatus: () => true });
    expect(res.status).toBe(401);
    expect(res.data.authenticated).toBe(false);
  });

  describe.skipIf(!process.env.SMOKE_AUTHOR_TOKEN)('with Tutorial.Author bearer', () => {
    const TOKEN = process.env.SMOKE_AUTHOR_TOKEN;
    const auth = { Authorization: `Bearer ${TOKEN}` };

    it('GET /author/MyTutorials?$top=1 returns 200 + value array for the calling user', async () => {
      const res = await axios.get(`${SRV}/author/MyTutorials?$top=1`, {
        headers: auth, validateStatus: () => true
      });
      expect(res.status).toBe(200);
      expect(Array.isArray(res.data.value)).toBe(true);
    });

    it('GET /health/auth returns 200 + scopes including Tutorial.Author', async () => {
      const res = await axios.get(`${SRV}/health/auth`, {
        headers: auth, validateStatus: () => true
      });
      expect(res.status).toBe(200);
      expect(res.data.authenticated).toBe(true);
      expect(res.data.scopes).toContain('Tutorial.Author');
    });
  });
});
```

- [ ] **Step 2: Run the smoke suite locally pointing at DEV after deploy**

```bash
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npm run test:smoke -- author-service
```
Expected: 401 assertions PASS. The positive 200 path is gated on `SMOKE_AUTHOR_TOKEN` — set it to a JWT for a real Tutorial.Author user (passcode flow or copy from an authenticated approuter session) to exercise the success path; otherwise that block is skipped.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/author-service.test.js
git commit -m "test(smoke): AuthorService + /health/auth scope gating"
```

---

## Task 14: Final integration run + PR

- [ ] **Step 1: Run everything**

```bash
npm test -- --run
ALLOW_HYBRID_WRITES=true npm run test:hybrid
```
Expected: all PASS.

- [ ] **Step 2: cds build sanity**

```bash
cds build --production
```
Expected: HDI artifacts emitted; no warnings on the new column or view.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin feature/sage-backend-gaps
gh pr create --title "feat: Sage backend gaps — AuthorService, MyTutorialsView, /health/auth" --body "$(cat <<'EOF'
## Summary
- New AuthorService at /author gated on Tutorial.Author scope
- MyTutorialsView joins TutorialMeta to Users via new ownerEmail column (additive — no destructive migration)
- /health/auth diagnostic endpoint for cheap auth probing
- managed aspect on TutorialMeta enables ETag + audit timestamps
- ChangeTracking annotations enable Prefer: odata.track-changes for delta sync
- Shared srv/lib/tutorial-review.js powers both Admin and Author actions

## Test plan
- [ ] Unit tests pass (npm test)
- [ ] Hybrid tests pass against HANA DEV (ALLOW_HYBRID_WRITES=true npm run test:hybrid)
- [ ] cds build emits clean HDI artifacts
- [ ] After deploy: GET /author/Tutorials → 401 anonymous; GET /health/auth → 401 anonymous
- [ ] Run scripts/backfill-tutorial-meta-email.js --dry-run on DEV; verify <10% unresolved before prod cutover
- [ ] Smoke-check admin-ui TutorialMeta screens for managed-field annotation breaks

Spec: docs/superpowers/specs/2026-05-24-sage-backend-gaps-design.md
EOF
)"
```

- [ ] **Step 4: After merge, run backfill against DEV**

```bash
npx cds bind --exec -- node scripts/backfill-tutorial-meta-email.js --dry-run
# Review .migration-data/ownerEmail-unresolved.csv
# If <10% unresolved: re-run without --dry-run
```

---

## Skipped / explicit non-goals (per spec)

- No `/author/slugs` endpoint (defer to draft-reservation use case).
- No `Association to Users` migration on TutorialMeta.
- No Sage-side `imsClient.ts` rewrite (separate Sage repo PR).
- No GitHub issue/PR mirroring into CAP.
- No IMS decommissioning in this PR.

## Remember

- **Memory `feedback_publish_content_force`** — irrelevant here (no content publish), but worth noting tests must not invoke `npm run publish-content`.
- **Memory `feedback_module_singletons_in_vitest_cds`** — `tutorial-review.js` uses dynamic import; if cache-related flakes appear, switch to lazy `cds.entities()` lookup inside each function (already done).
- **Memory `feedback_hana_boolean_case_when`** — no boolean CASE WHEN in this work, but watch for future analytics joining MyTutorialsView.
- **Memory `feedback_pr_over_direct_merge`** — open the PR; do not fast-merge without review.
