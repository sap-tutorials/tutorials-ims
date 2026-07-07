import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// #385 PR-3: AuthorService.Tags projection uses HANA-native SUBSTR_AFTER for
// actualTag. SQLite refuses to prepare any query against the deployed view
// because the function is undefined — even when explicit columns omit
// actualTag, SQLite resolves the entire view body. Tests against Tags must
// be gated behind isHana.
const isHana = cds.env.requires.db?.kind === 'hana';

describe('TutorialMeta schema', () => {
  it('exposes ownerEmail column on TutorialMeta', () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    expect(TutorialMeta.elements.ownerEmail).toBeDefined();
    expect(TutorialMeta.elements.ownerEmail.type).toBe('cds.String');
  });

  it('TutorialMeta is managed (has modifiedAt)', () => {
    const { TutorialMeta } = cds.entities('com.sap.developers.ims');
    expect(TutorialMeta.elements.modifiedAt).toBeDefined();
    expect(TutorialMeta.elements.createdBy).toBeDefined();
  });
});

// SELECT, INSERT, DELETE are globals attached by cds.test() / vitest globals — no import needed.

describe('MyTutorialsView', () => {
  beforeAll(async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');

    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await DELETE.from(Users);

    await INSERT.into(Users).entries([
      // #777-followup: tests pass `req.user.id` as the sapId surface (the
      // value that resolveUserSapId(user) returns when the user has no
      // authInfo.token — which is true for mock contexts). To keep the
      // `req.user.id === Users.uuid` test invariant working AFTER the
      // AuthorService handler routes through resolveDbUser (which selects
      // WHERE sapId = resolveUserSapId(user)), we set sapId = uuid here so
      // the resolver can navigate id → sapId match → Users row → uuid.
      { ID: 'u-A', uuid: 'uuid-A', sapId: 'uuid-A', email: 'alice@example.com', firstName: 'Alice', lastName: 'A', displayName: 'Alice A' },
      { ID: 'u-B', uuid: 'uuid-B', sapId: 'uuid-B', email: 'bob@example.com',   firstName: 'Bob',   lastName: 'B', displayName: 'Bob B' }
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: 't-1', slug: 'tut-1', title: 'Tutorial 1', status: 'ACTIVE' },
      { ID: 't-2', slug: 'tut-2', title: 'Tutorial 2', status: 'DRAFT' },
      { ID: 't-3', slug: 'tut-3', title: 'Orphan',     status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: 'm-1', tutorial_ID: 't-1', owner: 'Alice A', ownerEmail: 'alice@example.com' },
      { ID: 'm-2', tutorial_ID: 't-2', owner: 'Bob B',   ownerEmail: 'bob@example.com' },
      { ID: 'm-3', tutorial_ID: 't-3', owner: 'Ghost',   ownerEmail: 'nosuch@example.com' }
    ]);
  });

  it('joins meta to Users by email and exposes userId (Users.uuid)', async () => {
    const db = await cds.connect.to('db');
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(MyTutorialsView).where({ ownerEmail: 'alice@example.com' }));
    expect(rows).toHaveLength(1);
    // #777 renamed `ownerUserId` → `userId` (aliased from Users.uuid, matching
    // req.user.id at the CAP context layer). See db/views.cds MyTutorialsView.
    expect(rows[0].userId).toBe('uuid-A');
    expect(rows[0].slug).toBe('tut-1');
  });

  it('excludes orphaned meta where ownerEmail has no matching Users row', async () => {
    const db = await cds.connect.to('db');
    const { MyTutorialsView } = cds.entities('com.sap.developers.ims');
    const rows = await db.run(SELECT.from(MyTutorialsView).where({ ownerEmail: 'nosuch@example.com' }));
    expect(rows).toHaveLength(0);
  });
});

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
    ).rejects.toMatchObject({ code: 403 });
  });

  // #385 PR-3: gated to HANA — SQLite cannot prepare any query against the
  // AuthorService.Tags view because its body contains HANA-native
  // SUBSTR_AFTER (undefined on SQLite). Test asserts auth (caller-with-role
  // can read). The hybrid test (test/hybrid/385-pr3-authorservice.test.js)
  // covers this on real HANA.
  it.skipIf(!isHana)('allows AuthorService.Tags read for Tutorial.Author callers', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.Tags).columns('ID', 'name'))
    );
    expect(Array.isArray(rows)).toBe(true);
  });
});

describe('AuthorService.MyTutorials filtering', () => {
  it('filters MyTutorials to ownerUserId == req.user.id', async () => {
    const srv = await cds.connect.to('AuthorService');
    // alice has uuid-A; her MyTutorials should be tut-1 only.
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      async (tx) => {
        return await tx.run(SELECT.from(srv.entities.MyTutorials));
      }
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].slug).toBe('tut-1');
  });

  it('returns empty array when req.user.id matches no Users.uuid', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'unknown-uuid', roles: { 'Tutorial.Author': true } } },
      async (tx) => {
        return await tx.run(SELECT.from(srv.entities.MyTutorials));
      }
    );
    expect(rows).toHaveLength(0);
  });

  it('still filters when client groups by status (aggregate query)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const aliceRows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      async (tx) => {
        return await tx.run(
          SELECT.from(srv.entities.MyTutorials).columns('status').groupBy('status')
        );
      }
    );
    const bobRows = await srv.tx(
      { user: { id: 'uuid-B', roles: { 'Tutorial.Author': true } } },
      async (tx) => {
        return await tx.run(
          SELECT.from(srv.entities.MyTutorials).columns('status').groupBy('status')
        );
      }
    );
    // alice owns only tut-1 (ACTIVE); bob owns only tut-2 (DRAFT).
    // If req.query.where() AND-merges correctly, each user sees only their own status.
    // If it replaced the filter, both would see ['ACTIVE','DRAFT'].
    expect(aliceRows.map((r) => r.status)).toEqual(['ACTIVE']);
    expect(bobRows.map((r) => r.status)).toEqual(['DRAFT']);
  });
});

// #862 — MyAuthoredTutorials returns ONLY strict-authorship rows
// (bestPriority = 1, source-1 in db/views.cds MyTutorialsRaw).
//
// Fixture strategy: augment the shared `describe('MyTutorialsView')` fixture
// above rather than replace it (the review/snooze suite below depends on
// t-1 / t-2). We ADD two Alice tutorials that distinguish the two ownership
// sources:
//   tut-A1  — Alice as strict author (Tutorials.author_ID = u-A) AND
//             ownerEmail match. bestPriority = 1 → visible in BOTH endpoints.
//   tut-A2  — Alice as ownerEmail only (no author FK).
//             bestPriority = 3 → visible in MyTutorials, NOT MyAuthoredTutorials.
// Plus t-1 already has Alice as ownerEmail (source 3) — she'll now see both
// t-1 and tut-A2 in MyTutorials (both source-3-only) and just tut-A1 in
// MyAuthoredTutorials.
describe('AuthorService.MyAuthoredTutorials filtering (#862)', () => {
  beforeAll(async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    // Additive INSERTs — the parent `describe('MyTutorialsView')` beforeAll
    // has already populated Users, Tutorials, TutorialMeta and we want to
    // leave those rows in place for the review/snooze suite below.
    await INSERT.into(Tutorials).entries([
      { ID: 't-A1', slug: 'tut-A1', title: 'Alice authored', status: 'ACTIVE', author_ID: 'u-A' },
      { ID: 't-A2', slug: 'tut-A2', title: 'Alice ownerEmail only', status: 'ACTIVE' },
      { ID: 't-B1', slug: 'tut-B1', title: 'Bob authored', status: 'DRAFT', author_ID: 'u-B' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: 'm-A1', tutorial_ID: 't-A1', owner: 'Alice A', ownerEmail: 'alice@example.com' },
      { ID: 'm-A2', tutorial_ID: 't-A2', owner: 'Alice A', ownerEmail: 'alice@example.com' },
      { ID: 'm-B1', tutorial_ID: 't-B1', owner: 'Bob B',   ownerEmail: 'bob@example.com' }
    ]);
  });

  it('exposes MyAuthoredTutorials as a readable entity', async () => {
    const srv = await cds.connect.to('AuthorService');
    expect(srv.entities.MyAuthoredTutorials).toBeDefined();
  });

  it('returns only strict-author rows (bestPriority = 1) for the caller', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyAuthoredTutorials))
    );
    // Alice sees tut-A1 (author FK). She must NOT see:
    //   - tut-A2 (ownerEmail only → priority 3)
    //   - tut-1 (from the parent fixture — ownerEmail only → priority 3)
    //   - tut-B1 (Bob's authored tutorial)
    expect(rows.map((r) => r.slug)).toEqual(['tut-A1']);
    expect(rows[0].bestPriority).toBe(1);
  });

  it('exposes tutorial_ID also as ID for OData clients (#862 reopen)', async () => {
    // Regression guard: Sage's imsApiClient reads `row.ID` on the client
    // side. The underlying MyTutorialsView aliases t.ID as tutorial_ID
    // (to avoid a name clash with the outer OData key logic in #777); the
    // projection now re-exposes tutorial_ID as ID so `row.ID` isn't
    // undefined at the client.
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyAuthoredTutorials))
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].ID).toBe('t-A1');
    // Both aliases coexist on the wire so no consumer breaks.
    expect(rows[0].tutorial_ID).toBe('t-A1');
    expect(rows[0].ID).toBe(rows[0].tutorial_ID);
  });

  it('does NOT leak other users authored tutorials', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyAuthoredTutorials))
    );
    // Bob authored tut-B1 (bestPriority=1) — must not appear for Alice.
    expect(rows.map((r) => r.slug)).not.toContain('tut-B1');
  });

  it('MyTutorials (broad) still returns Alices ownerEmail-only rows alongside her authored one', async () => {
    // Regression guard: this PR must NOT narrow MyTutorials' semantics —
    // #777 wants it broad for advocate/admin surfaces. Alice sees three:
    //   tut-1 (parent-fixture ownerEmail-only), tut-A1 (author FK), tut-A2 (ownerEmail-only).
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyTutorials).orderBy('slug'))
    );
    expect(rows.map((r) => r.slug)).toEqual(['tut-1', 'tut-A1', 'tut-A2']);
  });

  it('rejects anonymous callers (403 at the service-level @requires gate)', async () => {
    // Service-level @requires: 'Tutorial.Author' rejects anonymous callers
    // with 403 BEFORE the before-READ handler fires. Mirrors the existing
    // AuthorService.Tags anonymous-caller test at line ~96.
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx({ user: { id: 'anonymous', roles: {} } }, (tx) =>
        tx.run(SELECT.from(srv.entities.MyAuthoredTutorials))
      )
    ).rejects.toMatchObject({ code: 403 });
  });

  it('returns empty when req.user.id matches no Users.uuid', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'unknown-uuid', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyAuthoredTutorials))
    );
    expect(rows).toHaveLength(0);
  });
});

// #862 reopen — MyOwnedTutorials returns rows where the caller matches
// TutorialMeta on EITHER ownerEmail (priority 3) OR owner-free-text-name
// (priority 4). This is the legacy-IMS "My Tutorials" semantics: Java
// IMS renders IMS_TUTORIAL_AUTHOR.NAME on its "Owner" column, and Sage's
// panel needs to match users whose owner-record has a noreply email
// (priority 3 misses) but the display name matches the SAP corporate
// user (priority 4 hits via `u.firstName || ' ' || u.lastName`).
//
// A brief #923 detour re-pointed this at MyMonitoredTutorialsView; live-
// probing IMS afterwards showed that was the eye-icon watch filter, not
// the default panel. TutorialMonitors + toggleMonitor from #923 remain
// for that feature; MyOwnedTutorials is back on the maintainer signal.
//
// Fixture: for alice (uuid-A, email=alice@example.com, firstName=Alice, lastName=A):
//   - tut-1  (owner='Alice A', ownerEmail=alice@example.com) → priority 3 (ownerEmail wins over name)
//   - tut-A1 (author_ID=u-A + owner='Alice A' + ownerEmail=alice) → priority 1 (author wins)
//   - tut-A2 (owner='Alice A', ownerEmail=alice@example.com) → priority 3
// So MyOwnedTutorials for Alice returns tut-1 and tut-A2 (priority 3 hits).
// tut-A1 is excluded because bestPriority=1 (strict author).
describe('AuthorService.MyOwnedTutorials filtering (#862 reopen)', () => {
  it('exposes MyOwnedTutorials as a readable entity', async () => {
    const srv = await cds.connect.to('AuthorService');
    expect(srv.entities.MyOwnedTutorials).toBeDefined();
  });

  it('returns rows with bestPriority IN (3, 4) — ownerEmail OR owner-name match', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    const slugs = rows.map((r) => r.slug).sort();
    expect(slugs).toEqual(['tut-1', 'tut-A2']);
    for (const r of rows) {
      expect([3, 4]).toContain(r.bestPriority);
    }
  });

  it('does NOT return rows where the caller is strict author (bestPriority=1)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    // tut-A1: alice is BOTH author and ownerEmail — bestPriority=1 wins, so it
    // appears on MyAuthoredTutorials but NOT here.
    expect(rows.map((r) => r.slug)).not.toContain('tut-A1');
    expect(rows.map((r) => r.slug)).not.toContain('tut-B1');
  });

  it('returns a name-only-match row (priority 4) when ownerEmail is NULL but owner is firstName lastName', async () => {
    // Simulates Riley's real production case: IMS_TUTORIAL_AUTHOR.EMAIL is a
    // GitHub noreply placeholder (ownerEmail nulled by the resync placeholder
    // filter), but IMS_TUTORIAL_AUTHOR.NAME is the display name "Riley Rainey"
    // which matches Users.firstName || ' ' || lastName. Priority-4 hits.
    const db = await cds.connect.to('db');
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries({
      ID: 't-noreply-A', slug: 'tut-noreply-A', title: 'Alice name-only',
      status: 'ACTIVE',
    });
    await INSERT.into(TutorialMeta).entries({
      ID: 'm-noreply-A', tutorial_ID: 't-noreply-A',
      owner: 'Alice A', ownerEmail: null,
    });
    try {
      const srv = await cds.connect.to('AuthorService');
      const rows = await srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
      );
      const noreplyRow = rows.find((r) => r.slug === 'tut-noreply-A');
      expect(noreplyRow).toBeDefined();
      expect(noreplyRow.bestPriority).toBe(4);
    } finally {
      await DELETE.from(TutorialMeta).where({ ID: 'm-noreply-A' });
      await DELETE.from(Tutorials).where({ ID: 't-noreply-A' });
    }
  });

  it('populates the ID alias (backward-compat with tutorial_ID)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    for (const r of rows) {
      expect(r.ID).toBeDefined();
      expect(r.ID).toBe(r.tutorial_ID);
    }
  });

  it('returns empty when caller has no matching Users row', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'unknown-uuid', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    expect(rows).toHaveLength(0);
  });

  // #1027 — diagnostic surface: when the caller authenticates but has no
  // matching Users row (stale OAuth clientId, wrong IdP, un-provisioned
  // token, ...), the handler MUST log a WARN so `cf logs tutorials-srv
  // --recent | grep 'Users-row miss'` finds it. Silent 0-row responses
  // hid the real failure mode on #1027 for the better part of an
  // afternoon; the log line is the fix.
  it('logs a Users-row miss WARN when caller has no matching Users row (#1027)', async () => {
    const authorLog = cds.log('author-service');
    const originalWarn = authorLog.warn;
    const warnCalls = [];
    authorLog.warn = (...args) => { warnCalls.push(args.join(' ')); };
    try {
      const srv = await cds.connect.to('AuthorService');
      await srv.tx(
        { user: { id: 'no-such-user', attr: { email: 'ghost@example.com' }, roles: { 'Tutorial.Author': true } } },
        (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
      );
      const missLine = warnCalls.find((s) => s.includes('[Users-row miss]'));
      expect(missLine).toBeDefined();
      // Diagnostic MUST include the endpoint (so multi-endpoint miss batches
      // are distinguishable) and the resolved sapId (direct FK into Users.sapId).
      expect(missLine).toContain('endpoint=MyOwnedTutorials');
      expect(missLine).toContain('resolved-sapId=no-such-user');
      // PII gate: the caller's email and free-text user.id are user-identifiable
      // information and MUST NOT appear in application logs. sapId alone is
      // sufficient for the correlation the log line documents.
      expect(missLine).not.toContain('ghost@example.com');
      expect(missLine).not.toContain('attr.email');
    } finally {
      authorLog.warn = originalWarn;
    }
  });

  // Corollary: when the caller DOES resolve to a Users row, no miss log fires.
  // Guards against a regression where the WARN emits on every request.
  it('does NOT log a Users-row miss when the caller resolves cleanly (#1027)', async () => {
    const authorLog = cds.log('author-service');
    const originalWarn = authorLog.warn;
    const warnCalls = [];
    authorLog.warn = (...args) => { warnCalls.push(args.join(' ')); };
    try {
      const srv = await cds.connect.to('AuthorService');
      await srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
      );
      const missLine = warnCalls.find((s) => s.includes('[Users-row miss]'));
      expect(missLine).toBeUndefined();
    } finally {
      authorLog.warn = originalWarn;
    }
  });
});

// #923 — toggleMonitor action tests. The action is the CAP equivalent of
// Java IMS's POST /tutorialMeta/setMonitoredStatus and controls a user's
// personal watch list. Idempotent per spec.
describe('AuthorService.toggleMonitor (#923)', () => {
  it('status=true creates a TutorialMonitors row for the caller', async () => {
    const db = await cds.connect.to('db');
    const { TutorialMonitors } = cds.entities('com.sap.developers.ims');
    // Start clean for tut-2 + alice
    await DELETE.from(TutorialMonitors).where({ user_ID: 'u-A', tutorial_ID: 't-2' });

    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('toggleMonitor', { tutorialId: 't-2', status: true })
    );
    expect(result).toBe(true);
    const rows = await db.run(SELECT.from(TutorialMonitors)
      .where({ user_ID: 'u-A', tutorial_ID: 't-2' }));
    expect(rows).toHaveLength(1);
    // Cleanup
    await DELETE.from(TutorialMonitors).where({ user_ID: 'u-A', tutorial_ID: 't-2' });
  });

  it('status=true is idempotent (second call still returns true, no dup row)', async () => {
    const db = await cds.connect.to('db');
    const { TutorialMonitors } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialMonitors).where({ user_ID: 'u-A', tutorial_ID: 't-2' });

    const srv = await cds.connect.to('AuthorService');
    const ctx = { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } };
    await srv.tx(ctx, (tx) => tx.send('toggleMonitor', { tutorialId: 't-2', status: true }));
    const secondResult = await srv.tx(ctx, (tx) =>
      tx.send('toggleMonitor', { tutorialId: 't-2', status: true }));
    expect(secondResult).toBe(true);
    const rows = await db.run(SELECT.from(TutorialMonitors)
      .where({ user_ID: 'u-A', tutorial_ID: 't-2' }));
    expect(rows).toHaveLength(1);
    // Cleanup
    await DELETE.from(TutorialMonitors).where({ user_ID: 'u-A', tutorial_ID: 't-2' });
  });

  it('status=false deletes the row and returns false', async () => {
    const db = await cds.connect.to('db');
    const { TutorialMonitors } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialMonitors).entries(
      { ID: 'mon-del-test', user_ID: 'u-A', tutorial_ID: 't-2' }
    );

    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('toggleMonitor', { tutorialId: 't-2', status: false })
    );
    expect(result).toBe(false);
    const rows = await db.run(SELECT.from(TutorialMonitors)
      .where({ user_ID: 'u-A', tutorial_ID: 't-2' }));
    expect(rows).toHaveLength(0);
  });

  it('status=false on a row that does not exist is a no-op (still returns false)', async () => {
    const db = await cds.connect.to('db');
    const { TutorialMonitors } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TutorialMonitors).where({ user_ID: 'u-A', tutorial_ID: 't-2' });

    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('toggleMonitor', { tutorialId: 't-2', status: false })
    );
    expect(result).toBe(false);
  });

  it('rejects anonymous callers', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx({ user: { id: 'anonymous', roles: {} } }, (tx) =>
        tx.send('toggleMonitor', { tutorialId: 't-1', status: true }))
    ).rejects.toMatchObject({ code: 403 });
  });

  it('returns 404 when tutorial does not exist', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('toggleMonitor', {
          tutorialId: '00000000-0000-0000-0000-000000000000',
          status: true,
        })
      )
    ).rejects.toMatchObject({ code: 404 });
  });
});

describe('AuthorService.reviewTutorial/snoozeTutorial', () => {
  it('reviewTutorial succeeds when caller owns the tutorial', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('reviewTutorial', { tutorialId: 't-1' })
    );
    expect(result.notificationNumber).toBe(0);
    expect(result.reviewedDate).toBeDefined();
  });

  it('reviewTutorial returns 403 when caller does not own the tutorial', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('reviewTutorial', { tutorialId: 't-2' /* bob's */ })
      )
    ).rejects.toMatchObject({ code: 403 });
  });

  it('snoozeTutorial accepts days in [1, 365]', async () => {
    const srv = await cds.connect.to('AuthorService');
    const ok = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('snoozeTutorial', { tutorialId: 't-1', days: 30 })
    );
    expect(ok.notificationDate).toBeDefined();
  });

  it('snoozeTutorial rejects out-of-range days', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('snoozeTutorial', { tutorialId: 't-1', days: 999 })
      )
    ).rejects.toMatchObject({ code: 400 });
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('snoozeTutorial', { tutorialId: 't-1', days: 0 })
      )
    ).rejects.toMatchObject({ code: 400 });
  });
});

describe('MyTutorialsView #385 PR-3 shape', () => {
  let MyTutorialsView;

  beforeAll(async () => {
    MyTutorialsView = cds.entities('com.sap.developers.ims').MyTutorialsView;
  });

  it('emits new fields: repositoryName, monitored, daysSinceReview', () => {
    expect(MyTutorialsView.elements.repositoryName).toBeDefined();
    expect(MyTutorialsView.elements.monitored).toBeDefined();
    expect(MyTutorialsView.elements.daysSinceReview).toBeDefined();
  });

  it('emits renamed fields: owner (not ownerName), notificationDate (not lastNotificationDate)', () => {
    expect(MyTutorialsView.elements.owner).toBeDefined();
    expect(MyTutorialsView.elements.notificationDate).toBeDefined();
    expect(MyTutorialsView.elements.ownerName).toBeUndefined();
    expect(MyTutorialsView.elements.lastNotificationDate).toBeUndefined();
  });

  it('does NOT emit the deleted outdated field', () => {
    expect(MyTutorialsView.elements.outdated).toBeUndefined();
  });

  it('daysSinceReview is null when reviewedDate is null', async () => {
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries(
      { ID: 'u-pr3-1', uuid: 'uuid-pr3-1', email: 'nullreview@example.com', firstName: 'N', lastName: 'R', displayName: 'N R' }
    );
    await INSERT.into(Tutorials).entries(
      { ID: 't-pr3-nullreview', slug: 'pr3-nullreview', title: 'No Review', status: 'ACTIVE' }
    );
    await INSERT.into(TutorialMeta).entries(
      { ID: 'm-pr3-nullreview', tutorial_ID: 't-pr3-nullreview', owner: 'X', ownerEmail: 'nullreview@example.com', reviewedDate: null }
    );
    // #777 renamed the view's key from `ID` → `tutorial_ID`.
    const row = await SELECT.one.from(MyTutorialsView).where({ tutorial_ID: 't-pr3-nullreview' });
    expect(row).toBeTruthy();
    expect(row.daysSinceReview).toBeNull();
  });

  it('daysSinceReview is a positive integer when reviewedDate is in the past', async () => {
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries(
      { ID: 'u-pr3-2', uuid: 'uuid-pr3-2', email: 'oldreview@example.com', firstName: 'O', lastName: 'R', displayName: 'O R' }
    );
    await INSERT.into(Tutorials).entries(
      { ID: 't-pr3-oldreview', slug: 'pr3-oldreview', title: 'Old Review', status: 'ACTIVE' }
    );
    const tenDaysAgo = new Date(Date.now() - 10 * 86400000).toISOString();
    await INSERT.into(TutorialMeta).entries(
      { ID: 'm-pr3-oldreview', tutorial_ID: 't-pr3-oldreview', owner: 'X', ownerEmail: 'oldreview@example.com', reviewedDate: tenDaysAgo }
    );
    const row = await SELECT.one.from(MyTutorialsView).where({ tutorial_ID: 't-pr3-oldreview' });
    expect(row).toBeTruthy();
    expect(row.daysSinceReview).toBeGreaterThanOrEqual(10);
    expect(row.daysSinceReview).toBeLessThanOrEqual(11); // allow 1-day tolerance for test timing
  });

  it('monitored is true when monitoredStatus is ACTIVE, false otherwise', async () => {
    const { Tutorials, TutorialMeta, Users } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries([
      { ID: 'u-pr3-3', uuid: 'uuid-pr3-3', email: 'active@example.com', firstName: 'A', lastName: 'C', displayName: 'A C' },
      { ID: 'u-pr3-4', uuid: 'uuid-pr3-4', email: 'inactive@example.com', firstName: 'I', lastName: 'A', displayName: 'I A' }
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: 't-pr3-active', slug: 'pr3-active', title: 'Active', status: 'ACTIVE' },
      { ID: 't-pr3-inactive', slug: 'pr3-inactive', title: 'Inactive', status: 'ACTIVE' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: 'm-pr3-active', tutorial_ID: 't-pr3-active', owner: 'X', ownerEmail: 'active@example.com', monitoredStatus: 'ACTIVE' },
      { ID: 'm-pr3-inactive', tutorial_ID: 't-pr3-inactive', owner: 'X', ownerEmail: 'inactive@example.com', monitoredStatus: 'INACTIVE' }
    ]);
    const activeRow = await SELECT.one.from(MyTutorialsView).where({ tutorial_ID: 't-pr3-active' });
    const inactiveRow = await SELECT.one.from(MyTutorialsView).where({ tutorial_ID: 't-pr3-inactive' });
    expect(activeRow.monitored).toBe(true);
    expect(inactiveRow.monitored).toBe(false);
  });

  it('repositoryName is null when TutorialMeta.repository_ID is unset (chain query NULL-safe)', async () => {
    // Fixture above seeds rows without a repository_ID — chain returns null.
    const row = await SELECT.one.from(MyTutorialsView).where({ tutorial_ID: 't-pr3-active' });
    expect(row.repositoryName).toBeNull();
  });
});

describe.skipIf(!isHana)('AuthorService.Tags #385 PR-3 actualTag (HANA-only)', () => {
  it('emits actualTag virtual column', async () => {
    const srv = await cds.connect.to('AuthorService');
    expect(srv.entities.Tags.elements.actualTag).toBeDefined();
  });

  // Note: behavioral tests for actualTag's SUBSTR_AFTER semantics live in the
  // hybrid test (test/hybrid/385-pr3-authorservice.test.js). On SQLite, the
  // `cds.env.requires.db.kind === 'hana'` gate above skips this entire block.
});

describe('AuthorService.isSlugAvailable #385 PR-3', () => {
  it('returns true for a non-existent slug', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('isSlugAvailable', { slug: 'definitely-not-real-slug-pr3' })
    );
    expect(result).toBe(true);
  });

  it('returns false for an existing slug (the fixture seeds tut-1)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('isSlugAvailable', { slug: 'tut-1' })
    );
    expect(result).toBe(false);
  });

  it('matches case-insensitively (TUT-1 matches existing tut-1)', async () => {
    const srv = await cds.connect.to('AuthorService');
    const result = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.send('isSlugAvailable', { slug: 'TUT-1' })
    );
    expect(result).toBe(false);
  });

  it('returns 400 when slug is empty or null', async () => {
    const srv = await cds.connect.to('AuthorService');
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('isSlugAvailable', { slug: '' })
      )
    ).rejects.toMatchObject({ code: 400 });
    await expect(
      srv.tx(
        { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
        (tx) => tx.send('isSlugAvailable', { slug: null })
      )
    ).rejects.toMatchObject({ code: 400 });
  });
});

// #862 followup — MyTutorialsView filters INACTIVE/DELETED rows at the view
// layer so that soft-delete on Tutorials propagates to all three
// MyTutorials-family endpoints (MyTutorials, MyAuthoredTutorials,
// MyOwnedTutorials) without requiring each handler to re-implement the filter.
//
// Regression guard for the DEV rollout finding: rbrainey-sandbox-1 was soft-
// deleted (Tutorials.status='INACTIVE') but continued to appear on
// MyAuthoredTutorials because the view didn't gate on status.
describe('AuthorService — soft-deleted tutorials do not surface (#862 followup)', () => {
  beforeAll(async () => {
    const { Tutorials, TutorialMeta } = cds.entities('com.sap.developers.ims');
    // Alice-authored INACTIVE tutorial. Should NOT appear on any endpoint.
    await INSERT.into(Tutorials).entries([
      { ID: 't-inactive', slug: 'tut-inactive', title: 'Retired', status: 'INACTIVE', author_ID: 'u-A' }
    ]);
    await INSERT.into(TutorialMeta).entries([
      { ID: 'm-inactive', tutorial_ID: 't-inactive', owner: 'Alice A', ownerEmail: 'alice@example.com' }
    ]);
  });

  it('MyAuthoredTutorials does NOT surface INACTIVE rows', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyAuthoredTutorials))
    );
    expect(rows.map((r) => r.slug)).not.toContain('tut-inactive');
  });

  it('MyOwnedTutorials does NOT surface INACTIVE rows', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials))
    );
    expect(rows.map((r) => r.slug)).not.toContain('tut-inactive');
  });

  it('MyTutorials (broad) does NOT surface INACTIVE rows either', async () => {
    const srv = await cds.connect.to('AuthorService');
    const rows = await srv.tx(
      { user: { id: 'uuid-A', roles: { 'Tutorial.Author': true } } },
      (tx) => tx.run(SELECT.from(srv.entities.MyTutorials))
    );
    expect(rows.map((r) => r.slug)).not.toContain('tut-inactive');
  });
});
