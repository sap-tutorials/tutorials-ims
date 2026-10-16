// test/unit/link-authorship-batch.test.js
//
// Task 9 (#2802): verify that linkTutorialAuthorship issues batched lookups for
// tutorial IDs (one LOWER(slug) IN per chunk) and contributors (one
// tutorial_ID IN per chunk), rather than the old per-slug N+1 pattern.
//
// Key assertions:
//   - author_ID, contributor user_ID links, TutorialMeta owner/ownerEmail resolve
//     identically to what the per-row path would produce.
//   - WHERE ... IS NULL conditional-update semantics are preserved:
//     an already-set author_ID is NOT overwritten by the fallback path.
//   - SELECT statement counts confirm batch reads (not per-slug reads).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { linkTutorialAuthorship } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

const TUTORIALS_TABLE       = 'com.sap.developers.ims.Tutorials';
const CONTRIBUTORS_TABLE    = 'com.sap.developers.ims.TutorialContributors';
const TUTORIALMETA_TABLE    = 'com.sap.developers.ims.TutorialMeta';
const USERS_TABLE           = 'com.sap.developers.ims.Users';

describe('linkTutorialAuthorship batched SELECTs (#2802)', () => {
  let db;
  let Tutorials, TutorialContributors, TutorialMeta, Users;

  beforeAll(async () => {
    ({
      Tutorials, TutorialContributors, TutorialMeta, Users,
    } = cds.entities(NS));
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    await DELETE.from(TutorialContributors);
    await DELETE.from(TutorialMeta);
    await DELETE.from(Tutorials);
    await DELETE.from(Users);
  });

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /** Count raw SQL SELECT calls that use LOWER(...) + IN. */
  function makeRunSpy() {
    const origRun = db.run.bind(db);
    let slugInSelects = 0;
    let contributorInSelects = 0;

    db.run = async (q, ...rest) => {
      if (typeof q === 'string') {
        const upper = q.toUpperCase();
        if (upper.includes('LOWER(') && upper.includes(' IN ')) {
          slugInSelects++;
        }
        // contributor batched: tutorial_ID IN (...)
        if (
          upper.includes('"TUTORIAL_ID"') &&
          upper.includes(' IN ') &&
          !upper.includes('LOWER(')
        ) {
          contributorInSelects++;
        }
      }
      return origRun(q, ...rest);
    };

    const restore = () => { db.run = origRun; };
    const counts  = () => ({ slugInSelects, contributorInSelects });
    return { restore, counts };
  }

  // -------------------------------------------------------------------------
  // Test 1: author_ID and contributor user_ID links resolve correctly
  // -------------------------------------------------------------------------
  it('resolves author_ID and contributor user_ID for 2 slugs', async () => {
    const userId1 = cds.utils.uuid();
    const userId2 = cds.utils.uuid();

    await INSERT.into(Users).entries([
      { ID: userId1, uuid: cds.utils.uuid(), email: 'alice@example.com', githubLogin: 'alice', displayName: 'Alice' },
      { ID: userId2, uuid: cds.utils.uuid(), email: 'bob@example.com',   githubLogin: 'bob',   displayName: 'Bob'   },
    ]);

    const tutId1 = cds.utils.uuid();
    const tutId2 = cds.utils.uuid();

    await INSERT.into(Tutorials).entries([
      { ID: tutId1, slug: 'auth-slug-one', title: 'Tutorial One', status: 'ACTIVE' },
      { ID: tutId2, slug: 'auth-slug-two', title: 'Tutorial Two', status: 'ACTIVE' },
    ]);

    // alice is a contributor with role 'author' on tutorial 1
    await INSERT.into(TutorialContributors).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId1, email: 'alice@example.com', role: 'author' },
    ]);
    // bob is a contributor with role 'contributor' on tutorial 2
    await INSERT.into(TutorialContributors).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId2, email: 'bob@example.com', role: 'contributor' },
    ]);

    await INSERT.into(TutorialMeta).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId1, monitoredStatus: 'ACTIVE', notificationNumber: 0 },
      { ID: cds.utils.uuid(), tutorial_ID: tutId2, monitoredStatus: 'ACTIVE', notificationNumber: 0 },
    ]);

    const metadata = {
      'auth-slug-one': { primaryContributorEmail: 'alice@example.com' },
      'auth-slug-two': { primaryContributorEmail: 'bob@example.com' },
    };

    await linkTutorialAuthorship(NS, metadata);

    const tut1 = await SELECT.one.from(Tutorials).where({ ID: tutId1 });
    const tut2 = await SELECT.one.from(Tutorials).where({ ID: tutId2 });

    // author_ID must be resolved from contributor with role 'author'
    expect(tut1.author_ID, 'author_ID for slug-one must resolve to alice').toBe(userId1);
    // author_ID must be resolved from any-contributor fallback
    expect(tut2.author_ID, 'author_ID for slug-two must resolve to bob').toBe(userId2);
  });

  // -------------------------------------------------------------------------
  // Test 2: TutorialMeta ownerEmail and owner resolve from frontmatter
  // -------------------------------------------------------------------------
  it('fills TutorialMeta.ownerEmail (NULL only) and owner from frontmatter', async () => {
    const userId = cds.utils.uuid();
    await INSERT.into(Users).entries([
      { ID: userId, uuid: cds.utils.uuid(), email: 'charlie@example.com', githubLogin: 'charlie', displayName: 'Charlie Dev' },
    ]);

    const tutId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries([
      { ID: tutId, slug: 'meta-owner-slug', title: 'Meta Owner Test', status: 'ACTIVE' },
    ]);

    await INSERT.into(TutorialContributors).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, email: 'charlie@example.com', role: 'author' },
    ]);

    // ownerEmail starts NULL — should be filled
    await INSERT.into(TutorialMeta).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, monitoredStatus: 'ACTIVE', notificationNumber: 0, ownerEmail: null, owner: null },
    ]);

    const metadata = {
      'meta-owner-slug': {
        primaryContributorEmail: 'charlie@example.com',
        frontmatterAuthorName: 'Charlie Dev',
      },
    };

    await linkTutorialAuthorship(NS, metadata);

    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutId });
    expect(meta.ownerEmail, 'ownerEmail must be filled from resolved author').toBe('charlie@example.com');
    expect(meta.owner, 'owner must be filled from frontmatterAuthorName').toBe('Charlie Dev');
  });

  // -------------------------------------------------------------------------
  // Test 3: WHERE ... IS NULL guard — already-set author_ID is NOT overwritten
  // by the fallback (non-frontmatter) path
  // -------------------------------------------------------------------------
  it('does NOT overwrite an already-set author_ID when source is not frontmatter', async () => {
    const existingAuthorId = cds.utils.uuid();
    const newContributorId = cds.utils.uuid();

    await INSERT.into(Users).entries([
      { ID: existingAuthorId, uuid: cds.utils.uuid(), email: 'admin@example.com', displayName: 'Admin' },
      { ID: newContributorId, uuid: cds.utils.uuid(), email: 'newguy@example.com', displayName: 'New Guy' },
    ]);

    const tutId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries([
      {
        ID: tutId, slug: 'null-guard-slug', title: 'Null Guard Test', status: 'ACTIVE',
        // author_ID already set (admin correction)
        author_ID: existingAuthorId,
      },
    ]);

    // newguy is a contributor — without frontmatter, would normally fill NULL author_ID
    await INSERT.into(TutorialContributors).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, email: 'newguy@example.com', role: 'author' },
    ]);

    await INSERT.into(TutorialMeta).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, monitoredStatus: 'ACTIVE', notificationNumber: 0 },
    ]);

    const metadata = {
      'null-guard-slug': {
        // No frontmatterGithubLogin → falls through to contributor-based resolution
        primaryContributorEmail: 'newguy@example.com',
      },
    };

    await linkTutorialAuthorship(NS, metadata);

    const tut = await SELECT.one.from(Tutorials).where({ ID: tutId });
    // The IS NULL guard must preserve the existing admin correction
    expect(tut.author_ID, 'author_ID must NOT be overwritten by contributor fallback').toBe(existingAuthorId);
  });

  // -------------------------------------------------------------------------
  // Test 4: frontmatter signal DOES overwrite existing author_ID
  // -------------------------------------------------------------------------
  it('overwrites author_ID when source is frontmatter (authoritative signal)', async () => {
    const oldAuthorId  = cds.utils.uuid();
    const fmUserId     = cds.utils.uuid();

    await INSERT.into(Users).entries([
      { ID: oldAuthorId, uuid: cds.utils.uuid(), email: 'old@example.com', displayName: 'Old Author' },
      { ID: fmUserId,    uuid: cds.utils.uuid(), email: 'fm@example.com',  githubLogin: 'fmuser', displayName: 'FM Author' },
    ]);

    const tutId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries([
      {
        ID: tutId, slug: 'fm-overwrite-slug', title: 'FM Overwrite Test', status: 'ACTIVE',
        author_ID: oldAuthorId,
      },
    ]);

    await INSERT.into(TutorialContributors).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, email: 'fm@example.com', role: 'author' },
    ]);

    await INSERT.into(TutorialMeta).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, monitoredStatus: 'ACTIVE', notificationNumber: 0 },
    ]);

    const metadata = {
      'fm-overwrite-slug': {
        primaryContributorEmail: 'fm@example.com',
        frontmatterGithubLogin: 'fmuser',  // authoritative frontmatter signal
      },
    };

    await linkTutorialAuthorship(NS, metadata);

    const tut = await SELECT.one.from(Tutorials).where({ ID: tutId });
    // Frontmatter always wins — overwrites even a non-NULL author_ID
    expect(tut.author_ID, 'author_ID must be overwritten by frontmatter signal').toBe(fmUserId);
  });

  // -------------------------------------------------------------------------
  // Test 5: contributor user_ID is opportunistically linked (WHERE IS NULL guard)
  // -------------------------------------------------------------------------
  it('links contributor user_ID (NULL only) for resolved contributor rows', async () => {
    const userId = cds.utils.uuid();
    await INSERT.into(Users).entries([
      { ID: userId, uuid: cds.utils.uuid(), email: 'dana@example.com', displayName: 'Dana' },
    ]);

    const tutId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries([
      { ID: tutId, slug: 'contrib-link-slug', title: 'Contributor Link Test', status: 'ACTIVE' },
    ]);

    const contribId = cds.utils.uuid();
    // contributor row has NULL user_ID — should be linked
    await INSERT.into(TutorialContributors).entries([
      { ID: contribId, tutorial_ID: tutId, email: 'dana@example.com', role: 'author', user_ID: null },
    ]);

    await INSERT.into(TutorialMeta).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, monitoredStatus: 'ACTIVE', notificationNumber: 0 },
    ]);

    const metadata = {
      'contrib-link-slug': { primaryContributorEmail: 'dana@example.com' },
    };

    await linkTutorialAuthorship(NS, metadata);

    const contrib = await SELECT.one.from(TutorialContributors).where({ ID: contribId });
    expect(contrib.user_ID, 'contributor user_ID must be linked').toBe(userId);
  });

  // -------------------------------------------------------------------------
  // Test 6: SELECT count reduction — batched reads, not per-slug
  // -------------------------------------------------------------------------
  it('issues batched IN-list raw SQL SELECTs (not per-slug) for 2 slugs', async () => {
    const userId1 = cds.utils.uuid();
    const userId2 = cds.utils.uuid();

    await INSERT.into(Users).entries([
      { ID: userId1, uuid: cds.utils.uuid(), email: 'e1@example.com', displayName: 'E1' },
      { ID: userId2, uuid: cds.utils.uuid(), email: 'e2@example.com', displayName: 'E2' },
    ]);

    const tutId1 = cds.utils.uuid();
    const tutId2 = cds.utils.uuid();

    await INSERT.into(Tutorials).entries([
      { ID: tutId1, slug: 'count-slug-a', title: 'Count A', status: 'ACTIVE' },
      { ID: tutId2, slug: 'count-slug-b', title: 'Count B', status: 'ACTIVE' },
    ]);

    await INSERT.into(TutorialContributors).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId1, email: 'e1@example.com', role: 'author' },
      { ID: cds.utils.uuid(), tutorial_ID: tutId2, email: 'e2@example.com', role: 'author' },
    ]);

    await INSERT.into(TutorialMeta).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId1, monitoredStatus: 'ACTIVE', notificationNumber: 0 },
      { ID: cds.utils.uuid(), tutorial_ID: tutId2, monitoredStatus: 'ACTIVE', notificationNumber: 0 },
    ]);

    const metadata = {
      'count-slug-a': { primaryContributorEmail: 'e1@example.com' },
      'count-slug-b': { primaryContributorEmail: 'e2@example.com' },
    };

    const spy = makeRunSpy();
    try {
      await linkTutorialAuthorship(NS, metadata);
    } finally {
      spy.restore();
    }

    const { slugInSelects, contributorInSelects } = spy.counts();

    // 2 slugs → exactly 1 batched LOWER(slug) IN lookup (fits in one chunk of 500)
    expect(
      slugInSelects,
      `Expected 1 batched LOWER(slug) IN SELECT for 2 slugs, got ${slugInSelects}`
    ).toBe(1);

    // 2 tutorial IDs → exactly 1 batched contributors IN lookup
    expect(
      contributorInSelects,
      `Expected 1 batched contributors IN SELECT for 2 tutorial IDs, got ${contributorInSelects}`
    ).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Test 7: TutorialMeta.ownerEmail IS NULL guard — does NOT overwrite existing
  // -------------------------------------------------------------------------
  it('does NOT overwrite an already-set ownerEmail', async () => {
    const userId = cds.utils.uuid();
    await INSERT.into(Users).entries([
      { ID: userId, uuid: cds.utils.uuid(), email: 'owner@example.com', displayName: 'Owner' },
    ]);

    const tutId = cds.utils.uuid();
    await INSERT.into(Tutorials).entries([
      { ID: tutId, slug: 'owneremail-guard-slug', title: 'OwnerEmail Guard', status: 'ACTIVE' },
    ]);

    await INSERT.into(TutorialContributors).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutId, email: 'owner@example.com', role: 'author' },
    ]);

    // ownerEmail already set to something different — must NOT be overwritten
    await INSERT.into(TutorialMeta).entries([
      {
        ID: cds.utils.uuid(), tutorial_ID: tutId,
        monitoredStatus: 'ACTIVE', notificationNumber: 0,
        ownerEmail: 'admin-set@example.com',
      },
    ]);

    const metadata = {
      'owneremail-guard-slug': { primaryContributorEmail: 'owner@example.com' },
    };

    await linkTutorialAuthorship(NS, metadata);

    const meta = await SELECT.one.from(TutorialMeta).where({ tutorial_ID: tutId });
    expect(meta.ownerEmail, 'ownerEmail must NOT be overwritten').toBe('admin-set@example.com');
  });
});
