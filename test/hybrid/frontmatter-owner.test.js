// test/hybrid/frontmatter-owner.test.js
//
// Plan: docs/superpowers/plans/2026-06-30-frontmatter-authoritative-tutorial-owner.md (task 7)
//
// Verifies the architectural switch introduced in Task 7:
//   - frontmatterGithubLogin in the publish payload is the authoritative
//     ownership signal: it OVERWRITES Tutorials.author_ID (not just fills NULL)
//   - Users.githubLogin bootstrap: when a Users row has a NULL githubLogin
//     and the publish payload carries a matching frontmatterGithubLogin, the
//     bootstrap pass fills Users.githubLogin so Phase 0 can resolve on the
//     same iteration.
//
// Runs against real HANA (DEV space). All writes are gated by
// ALLOW_HYBRID_WRITES=true and prefixed with __TEST__ to prevent production
// contamination. afterAll cleans up in FK dependency order.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';
import { linkTutorialAuthorship } from '../../srv/lib/content-publish-session.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__fm-owner-';

describe.runIf(isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true')(
  'frontmatter-authoritative owner (Task 7) [hybrid]',
  () => {
    const cleanup = { users: [], tutorials: [], contributors: [], meta: [] };

    beforeAll(async () => {
      const db = await cds.connect.to('db');
      const isHana =
        db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      if (!isHana) {
        throw new Error(
          'frontmatter-owner.test.js must run against HANA. ' +
            'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
        );
      }
    });

    afterAll(async () => {
      const { Tutorials, TutorialContributors, TutorialMeta, Users } =
        cds.entities(NS);
      for (const id of cleanup.contributors)
        await DELETE.from(TutorialContributors).where({ ID: id });
      for (const id of cleanup.meta)
        await DELETE.from(TutorialMeta).where({ ID: id });
      for (const id of cleanup.tutorials)
        await DELETE.from(Tutorials).where({ ID: id });
      for (const id of cleanup.users)
        await DELETE.from(Users).where({ ID: id });
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 1 — frontmatter-wins overwrite
    //
    // Riley is the initial author_ID (as if she committed last).
    // Tom's login appears in the frontmatter.
    // After linkTutorialAuthorship, author_ID MUST flip to Tom.
    // -------------------------------------------------------------------------
    it('Test 1 — frontmatter overwrite: author_ID flips from Riley to Tom', async () => {
      const slug = TEST_PREFIX + 'overwrite-' + Date.now();

      const tomId = cds.utils.uuid();
      const rileyId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      cleanup.users.push(tomId, rileyId);
      cleanup.tutorials.push(tutId);

      const { Users, Tutorials } = cds.entities(NS);

      await INSERT.into(Users).entries({
        ID: tomId,
        uuid: tomId,
        sapId: TEST_PREFIX + 'tom-' + tomId.slice(0, 8),
        email: TEST_PREFIX + 'tom-' + tomId.slice(0, 8) + '@example.com',
        displayName: TEST_PREFIX + 'Tom',
        githubLogin: 'tom-test-login-' + tomId.slice(0, 8),
      });
      await INSERT.into(Users).entries({
        ID: rileyId,
        uuid: rileyId,
        sapId: TEST_PREFIX + 'riley-' + rileyId.slice(0, 8),
        email: TEST_PREFIX + 'riley-' + rileyId.slice(0, 8) + '@example.com',
        displayName: TEST_PREFIX + 'Riley',
        githubLogin: 'riley-test-login-' + rileyId.slice(0, 8),
      });

      // Tutorial seeded with Riley as author_ID (simulating the old state
      // where the most-recent committer latched in).
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug,
        title: TEST_PREFIX + slug,
        status: 'ACTIVE',
        author_ID: rileyId,
      });

      // Fetch the Tom login we inserted so we can use it in the payload.
      const tomRow = await SELECT.one.from(Users).where({ ID: tomId }).columns('githubLogin');
      const tomLogin = tomRow.githubLogin;

      // Simulate a publish metadata payload where frontmatter says Tom
      // owns this tutorial (even though Riley is current author_ID).
      await linkTutorialAuthorship(NS, {
        [slug]: {
          primaryContributorEmail:
            TEST_PREFIX + 'riley-' + rileyId.slice(0, 8) + '@example.com',
          primaryContributorLogin: 'riley-test-login-' + rileyId.slice(0, 8),
          frontmatterGithubLogin: tomLogin,
        },
      });

      const t = await SELECT.one.from(Tutorials).where({ ID: tutId }).columns('author_ID');
      expect(t.author_ID).toBe(tomId);
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 2 — fill-NULL guard preserved for non-frontmatter fallback
    //
    // No frontmatterGithubLogin. author_ID is NULL. The resolver falls through
    // to owner-email fallback. author_ID MUST be populated (fill-NULL path).
    // -------------------------------------------------------------------------
    it('Test 2 — fallback fill-NULL: author_ID populated when no frontmatter login', async () => {
      const slug = TEST_PREFIX + 'fillnull-' + Date.now();

      const userId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      cleanup.users.push(userId);
      cleanup.tutorials.push(tutId);

      const { Users, Tutorials } = cds.entities(NS);

      const email = TEST_PREFIX + 'user-' + userId.slice(0, 8) + '@example.com';
      await INSERT.into(Users).entries({
        ID: userId,
        uuid: userId,
        sapId: TEST_PREFIX + 'u-' + userId.slice(0, 8),
        email,
        displayName: TEST_PREFIX + 'User',
      });
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug,
        title: TEST_PREFIX + slug,
        status: 'ACTIVE',
        // author_ID intentionally NULL — represents a tutorial not yet linked
      });

      await linkTutorialAuthorship(NS, {
        [slug]: {
          primaryContributorEmail: email,
          // No frontmatterGithubLogin — should fall through to owner-email
        },
      });

      const t = await SELECT.one.from(Tutorials).where({ ID: tutId }).columns('author_ID');
      expect(t.author_ID).toBe(userId);
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 3 — fill-NULL guard preserved: admin-set author_ID NOT overwritten by
    // non-frontmatter fallback
    //
    // author_ID is already set to adminUserId. No frontmatterGithubLogin. The
    // resolver would resolve via owner-email to a different user, but the
    // IS NULL gate must prevent overwriting the admin-set value.
    // -------------------------------------------------------------------------
    it('Test 3 — fill-NULL guard: admin-set author_ID not overwritten by email fallback', async () => {
      const slug = TEST_PREFIX + 'guard-' + Date.now();

      const adminUserId = cds.utils.uuid();
      const commitUserId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      cleanup.users.push(adminUserId, commitUserId);
      cleanup.tutorials.push(tutId);

      const { Users, Tutorials } = cds.entities(NS);

      const commitEmail = TEST_PREFIX + 'commit-' + commitUserId.slice(0, 8) + '@example.com';
      await INSERT.into(Users).entries({
        ID: adminUserId,
        uuid: adminUserId,
        sapId: TEST_PREFIX + 'admin-' + adminUserId.slice(0, 8),
        email: TEST_PREFIX + 'admin-' + adminUserId.slice(0, 8) + '@example.com',
        displayName: TEST_PREFIX + 'AdminUser',
      });
      await INSERT.into(Users).entries({
        ID: commitUserId,
        uuid: commitUserId,
        sapId: TEST_PREFIX + 'commit-' + commitUserId.slice(0, 8),
        email: commitEmail,
        displayName: TEST_PREFIX + 'CommitUser',
      });
      // Tutorial pre-set to adminUserId (simulating an admin correction)
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug,
        title: TEST_PREFIX + slug,
        status: 'ACTIVE',
        author_ID: adminUserId,
      });

      // Publish payload without frontmatter login — would resolve via email
      // to commitUserId, but must NOT overwrite the admin-set adminUserId.
      await linkTutorialAuthorship(NS, {
        [slug]: {
          primaryContributorEmail: commitEmail,
          // No frontmatterGithubLogin
        },
      });

      const t = await SELECT.one.from(Tutorials).where({ ID: tutId }).columns('author_ID');
      expect(t.author_ID).toBe(adminUserId); // unchanged
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 4 — bootstrap: Users.githubLogin populated from frontmatter when NULL
    //
    // User has no githubLogin. Frontmatter carries a login for this user
    // (matched via email). After linkTutorialAuthorship, Users.githubLogin MUST
    // be populated AND the tutorial's author_ID MUST be set to that user.
    // -------------------------------------------------------------------------
    it('Test 4 — bootstrap: Users.githubLogin filled from frontmatter when NULL', async () => {
      const slug = TEST_PREFIX + 'bootstrap-' + Date.now();
      const fmLogin = TEST_PREFIX + 'bootstrap-login-' + Date.now();

      const userId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      cleanup.users.push(userId);
      cleanup.tutorials.push(tutId);

      const { Users, Tutorials } = cds.entities(NS);

      const email = TEST_PREFIX + 'boot-' + userId.slice(0, 8) + '@example.com';
      await INSERT.into(Users).entries({
        ID: userId,
        uuid: userId,
        sapId: TEST_PREFIX + 'boot-' + userId.slice(0, 8),
        email,
        displayName: TEST_PREFIX + 'BootUser',
        // githubLogin intentionally NULL — bootstrap should fill it
      });
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug,
        title: TEST_PREFIX + slug,
        status: 'ACTIVE',
        // author_ID NULL — should be resolved via Phase 0 after bootstrap
      });

      await linkTutorialAuthorship(NS, {
        [slug]: {
          primaryContributorEmail: email,
          frontmatterGithubLogin: fmLogin,
        },
      });

      // Users.githubLogin must now be set
      const u = await SELECT.one.from(Users).where({ ID: userId }).columns('githubLogin');
      expect(u.githubLogin).toBe(fmLogin);

      // Tutorials.author_ID must point to this user (via Phase 0 on this iteration)
      const t = await SELECT.one.from(Tutorials).where({ ID: tutId }).columns('author_ID');
      expect(t.author_ID).toBe(userId);
    }, 60_000);
  }
);
