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
    // Test 2 — publish-time author resolution no longer promotes ownerEmail
    // (#862 reopen)
    //
    // No frontmatterGithubLogin. No matching contributor. author_ID stays NULL.
    // Phase (c) ownerEmail fallback was removed because it conflated
    // TutorialMeta.ownerEmail (monitoring signal) with authorship. See the
    // block comment in srv/lib/resolve-tutorial-author.js for full rationale.
    // -------------------------------------------------------------------------
    it('Test 2 — no-Phase-c: author_ID stays NULL when only ownerEmail matches', async () => {
      const slug = TEST_PREFIX + 'nophasec-' + Date.now();

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
          // No frontmatterGithubLogin. No TutorialContributors row inserted.
          // Under the old resolver Phase (c) would set author_ID = userId here
          // via the ownerEmail fallback. Under the new resolver it must stay NULL.
        },
      });

      const t = await SELECT.one.from(Tutorials).where({ ID: tutId }).columns('author_ID');
      expect(t.author_ID).toBeNull();
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 3 — fill-NULL guard preserved: admin-set author_ID NOT overwritten
    //
    // author_ID is already set to adminUserId. No frontmatterGithubLogin.
    // No contributor rows (so Phase (a)/(b) miss). The publish payload's
    // primaryContributorEmail could match commitUserId, but the fill-NULL
    // gate must prevent it from overwriting the admin-set adminUserId.
    // Additionally, with Phase (c) removed (#862 reopen), the resolver never
    // returns commitUserId here anyway — the test now doubly-guards the
    // admin-correction invariant.
    // -------------------------------------------------------------------------
    it('Test 3 — fill-NULL guard: admin-set author_ID not overwritten by publish', async () => {
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

    // -------------------------------------------------------------------------
    // Test 5 — #862 reopen (2026-07-02): ownerEmail comes from the resolved
    // author signal, NOT from contributors[0].email.
    //
    // Two subjects:
    //   - Alice: frontmatter-declared author, has githubLogin='alicetestlogin'
    //     and email='alice@example.com'
    //   - Bob:   NO Users.githubLogin, only email='bob@example.com'; appears
    //     as the "primaryContributorEmail" in the publish payload (i.e. Bob
    //     made the last commit / typo-fix)
    //
    // Under the old (buggy) publish path, upsertTutorialMetadata would have
    // stamped TutorialMeta.ownerEmail = 'bob@example.com'. Under the fix,
    // linkTutorialAuthorship resolves the author to Alice via Phase 0
    // (frontmatterGithubLogin → Users.githubLogin → Users.email), and writes
    // that email — never Bob's — into TutorialMeta.ownerEmail.
    // -------------------------------------------------------------------------
    it('Test 5 — #862 reopen: TutorialMeta.ownerEmail from author, never contributor', async () => {
      const slug = TEST_PREFIX + 'owneremail-' + Date.now();

      const aliceId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      const metaId = cds.utils.uuid();
      cleanup.users.push(aliceId);
      cleanup.tutorials.push(tutId);
      cleanup.meta.push(metaId);

      const { Users, Tutorials, TutorialMeta } = cds.entities(NS);

      const aliceLogin = 'alicetestlogin-' + aliceId.slice(0, 8);
      const aliceEmail = TEST_PREFIX + 'alice-' + aliceId.slice(0, 8) + '@example.com';
      const bobEmail   = TEST_PREFIX + 'bob-'   + tutId.slice(0, 8)   + '@example.com';

      await INSERT.into(Users).entries({
        ID: aliceId,
        uuid: aliceId,
        sapId: TEST_PREFIX + 'alice-' + aliceId.slice(0, 8),
        email: aliceEmail,
        displayName: TEST_PREFIX + 'Alice',
        githubLogin: aliceLogin,
      });
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug,
        title: TEST_PREFIX + slug,
        status: 'ACTIVE',
      });
      // Seed TutorialMeta with NULL ownerEmail — the state upsertTutorial
      // Metadata produces on a fresh publish under the fix.
      await INSERT.into(TutorialMeta).entries({
        ID: metaId,
        tutorial_ID: tutId,
        owner: null,
        ownerEmail: null,
        monitoredStatus: 'ACTIVE',
        notificationNumber: 0,
        legacyId: 9_999_800 + Math.floor(Math.random() * 100),
      });

      await linkTutorialAuthorship(NS, {
        [slug]: {
          primaryContributorEmail: bobEmail,       // Bob is the contributor
          primaryContributorLogin: 'boblogin',
          frontmatterGithubLogin: aliceLogin,      // Alice is the declared owner
        },
      });

      const meta = await SELECT.one
        .from(TutorialMeta)
        .where({ ID: metaId })
        .columns('ownerEmail');

      // #862 reopen — Alice's email wins because she's the frontmatter-
      // declared owner. Bob (the contributor) MUST NOT appear as ownerEmail.
      expect(meta.ownerEmail).toBe(aliceEmail);
      expect(meta.ownerEmail).not.toBe(bobEmail);
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 6 — #862 reopen: no author signal → ownerEmail stays NULL.
    //
    // Payload carries only a contributor's email. No frontmatter login. No
    // TutorialContributors row. Under the old publish path, ownerEmail would
    // get stamped with the contributor's email. Under the fix, ownerEmail
    // stays NULL because linkTutorialAuthorship never resolves an authorUserId.
    // -------------------------------------------------------------------------
    it('Test 6 — #862 reopen: no author resolvable → ownerEmail remains NULL', async () => {
      const slug = TEST_PREFIX + 'noauth-owneremail-' + Date.now();

      const tutId = cds.utils.uuid();
      const metaId = cds.utils.uuid();
      cleanup.tutorials.push(tutId);
      cleanup.meta.push(metaId);

      const { Tutorials, TutorialMeta } = cds.entities(NS);

      const orphanEmail = TEST_PREFIX + 'orphan-' + tutId.slice(0, 8) + '@example.com';

      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug,
        title: TEST_PREFIX + slug,
        status: 'ACTIVE',
      });
      await INSERT.into(TutorialMeta).entries({
        ID: metaId,
        tutorial_ID: tutId,
        owner: null,
        ownerEmail: null,
        monitoredStatus: 'ACTIVE',
        notificationNumber: 0,
        legacyId: 9_999_900 + Math.floor(Math.random() * 100),
      });

      await linkTutorialAuthorship(NS, {
        [slug]: {
          primaryContributorEmail: orphanEmail,  // No matching Users row
          // No frontmatterGithubLogin
        },
      });

      const meta = await SELECT.one
        .from(TutorialMeta)
        .where({ ID: metaId })
        .columns('ownerEmail');

      // NULL stays NULL — absence of an author signal is not filled by a
      // contributor. Admin can set explicitly via the admin UI later.
      expect(meta.ownerEmail).toBeNull();
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 7 — #862 reopen: existing non-NULL ownerEmail is preserved.
    //
    // A tutorial already has ownerEmail set (admin correction or legit legacy
    // IMS migration value). Even if the resolver finds an author whose email
    // differs, ownerEmail MUST NOT be overwritten. The UPDATE is gated by
    // WHERE OWNEREMAIL IS NULL.
    // -------------------------------------------------------------------------
    it('Test 7 — #862 reopen: existing ownerEmail not overwritten by resolver', async () => {
      const slug = TEST_PREFIX + 'preserve-owneremail-' + Date.now();

      const aliceId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      const metaId = cds.utils.uuid();
      cleanup.users.push(aliceId);
      cleanup.tutorials.push(tutId);
      cleanup.meta.push(metaId);

      const { Users, Tutorials, TutorialMeta } = cds.entities(NS);

      const aliceLogin = 'alice-preserve-' + aliceId.slice(0, 8);
      const aliceEmail = TEST_PREFIX + 'alice-preserve-' + aliceId.slice(0, 8) + '@example.com';
      const adminSetEmail = TEST_PREFIX + 'admin-preserve-' + tutId.slice(0, 8) + '@example.com';

      await INSERT.into(Users).entries({
        ID: aliceId,
        uuid: aliceId,
        sapId: TEST_PREFIX + 'alice-preserve-' + aliceId.slice(0, 8),
        email: aliceEmail,
        displayName: TEST_PREFIX + 'Alice',
        githubLogin: aliceLogin,
      });
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug,
        title: TEST_PREFIX + slug,
        status: 'ACTIVE',
      });
      await INSERT.into(TutorialMeta).entries({
        ID: metaId,
        tutorial_ID: tutId,
        owner: adminSetEmail,
        ownerEmail: adminSetEmail,   // ← pre-existing, must not be overwritten
        monitoredStatus: 'ACTIVE',
        notificationNumber: 0,
        legacyId: 9_999_950 + Math.floor(Math.random() * 50),
      });

      await linkTutorialAuthorship(NS, {
        [slug]: {
          frontmatterGithubLogin: aliceLogin,  // Would resolve to Alice
        },
      });

      const meta = await SELECT.one
        .from(TutorialMeta)
        .where({ ID: metaId })
        .columns('ownerEmail');

      // Admin's setting is preserved. The resolver's Alice does NOT overwrite.
      expect(meta.ownerEmail).toBe(adminSetEmail);
      expect(meta.ownerEmail).not.toBe(aliceEmail);
    }, 60_000);
  }
);
