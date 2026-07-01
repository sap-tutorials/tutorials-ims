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
