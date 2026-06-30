// test/hybrid/admin-advocate-mytutorials.test.js
//
// Plan: docs/superpowers/plans/2026-06-30-frontmatter-authoritative-tutorial-owner.md (task 8)
//
// Verifies the READ-side reconciliation for the admin Advocate Object Page:
//   - AdminService.MyTutorials (projected from MyTutorialsByUserId) returns
//     tutorials owned via Source 3 (TutorialMeta.ownerEmail) — not just the
//     strict author FK (Source 1) or contributor FK (Source 2).
//   - This is the fix for the ~7 vs ~77 discrepancy Tom observed: the old
//     Authored/Contributed dual facet only covered Sources 1 and 2; the new
//     OwnedTutorials facet uses the canonical 4-source MyTutorialsView UNION.
//
// Runs against real HANA (DEV space). All writes are gated by
// ALLOW_HYBRID_WRITES=true and prefixed with __TEST__ to prevent production
// contamination. afterAll cleans up in FK dependency order.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__adv-mytut-';

describe.runIf(isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true')(
  'admin Advocate OwnedTutorials via MyTutorialsView (Task 8) [hybrid]',
  () => {
    const cleanup = { users: [], tutorials: [], meta: [], advocates: [] };

    beforeAll(async () => {
      const db = await cds.connect.to('db');
      const isHana =
        db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      if (!isHana) {
        throw new Error(
          'admin-advocate-mytutorials.test.js must run against HANA. ' +
            'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
        );
      }
    });

    afterAll(async () => {
      const { Tutorials, TutorialMeta, Users, Advocates } = cds.entities(NS);
      // FK order: Advocates → Users, TutorialMeta → Tutorials
      for (const id of cleanup.advocates)
        await DELETE.from(Advocates).where({ ID: id });
      for (const id of cleanup.meta)
        await DELETE.from(TutorialMeta).where({ ID: id });
      for (const id of cleanup.tutorials)
        await DELETE.from(Tutorials).where({ ID: id });
      for (const id of cleanup.users)
        await DELETE.from(Users).where({ ID: id });
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 1 — Source 3 traversal: ownerEmail on TutorialMeta
    //
    // A user is created with no author_ID link on any tutorial (Source 1 = empty)
    // and no TutorialContributors entry (Source 2 = empty). The tutorial is
    // linked only via TutorialMeta.ownerEmail = user.email (Source 3).
    // AdminService.MyTutorials filtered by userId = user.uuid MUST return
    // the tutorial. This proves the OwnedTutorials facet shows ~77 not ~7.
    // -------------------------------------------------------------------------
    it('Test 1 — Source 3 (ownerEmail): MyTutorials returns tutorial when linked only via TutorialMeta.ownerEmail', async () => {
      const userId = cds.utils.uuid();
      const tutId  = cds.utils.uuid();
      const metaId = cds.utils.uuid();
      const advId  = cds.utils.uuid();
      const slug   = (TEST_PREFIX + 'src3-' + Date.now()).toLowerCase();

      cleanup.users.push(userId);
      cleanup.tutorials.push(tutId);
      cleanup.meta.push(metaId);
      cleanup.advocates.push(advId);

      const { Users, Tutorials, TutorialMeta, Advocates } = cds.entities(NS);

      const email = TEST_PREFIX + 'u-' + userId.slice(0, 8) + '@example.com';

      // Create user — no githubLogin (Source 1 bootstrap path irrelevant here)
      await INSERT.into(Users).entries({
        ID:          userId,
        uuid:        userId,
        sapId:       TEST_PREFIX + 'u-' + userId.slice(0, 8),
        email,
        displayName: TEST_PREFIX + 'User',
      });

      // Create tutorial — author_ID intentionally NULL (Source 1 empty)
      await INSERT.into(Tutorials).entries({
        ID:     tutId,
        slug,
        title:  TEST_PREFIX + slug,
        status: 'ACTIVE',
        // author_ID = NULL → Source 1 produces no row in MyTutorialsRaw
      });

      // Create TutorialMeta with ownerEmail = user.email (Source 3)
      await INSERT.into(TutorialMeta).entries({
        ID:            metaId,
        tutorial_ID:   tutId,
        ownerEmail:    email,
        monitoredStatus: 'ACTIVE',
      });

      // Create Advocate linked to this user
      await INSERT.into(Advocates).entries({
        ID:        advId,
        slug:      TEST_PREFIX + 'adv-' + advId.slice(0, 8),
        firstName: TEST_PREFIX + 'First',
        lastName:  TEST_PREFIX + 'Last',
        user_ID:   userId,
      });

      // Query AdminService.MyTutorials filtered by userId = user.uuid
      // userId on MyTutorialsView = Users.uuid (which we set = Users.ID here)
      const { MyTutorialsByUserId } = cds.entities(NS);
      const rows = await SELECT.from(MyTutorialsByUserId)
        .where({ user_ID: userId });

      const found = rows.find(r => r.slug === slug);
      expect(found).toBeDefined();
      expect(found.bestPriority).toBe(3); // Source 3 = ownerEmail
      expect(found.monitoredStatus).toBe('ACTIVE');
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 2 — Source 1 still works: author FK
    //
    // Tutorial with author_ID set (Source 1). MyTutorialsByUserId should return
    // bestPriority = 1, confirming the bridge view preserves all 4 sources.
    // -------------------------------------------------------------------------
    it('Test 2 — Source 1 (author FK): MyTutorials returns tutorial with bestPriority=1', async () => {
      const userId = cds.utils.uuid();
      const tutId  = cds.utils.uuid();
      const metaId = cds.utils.uuid();
      const slug   = (TEST_PREFIX + 'src1-' + Date.now()).toLowerCase();

      cleanup.users.push(userId);
      cleanup.tutorials.push(tutId);
      cleanup.meta.push(metaId);

      const { Users, Tutorials, TutorialMeta } = cds.entities(NS);

      const email = TEST_PREFIX + 'v-' + userId.slice(0, 8) + '@example.com';

      await INSERT.into(Users).entries({
        ID:          userId,
        uuid:        userId,
        sapId:       TEST_PREFIX + 'v-' + userId.slice(0, 8),
        email,
        displayName: TEST_PREFIX + 'UserSrc1',
      });

      // Tutorial with author_ID set → Source 1
      await INSERT.into(Tutorials).entries({
        ID:        tutId,
        slug,
        title:     TEST_PREFIX + slug,
        status:    'ACTIVE',
        author_ID: userId,
      });

      await INSERT.into(TutorialMeta).entries({
        ID:            metaId,
        tutorial_ID:   tutId,
        monitoredStatus: 'ACTIVE',
      });

      const { MyTutorialsByUserId } = cds.entities(NS);
      const rows = await SELECT.from(MyTutorialsByUserId)
        .where({ user_ID: userId });

      const found = rows.find(r => r.slug === slug);
      expect(found).toBeDefined();
      expect(found.bestPriority).toBe(1); // Source 1 = author FK (highest priority)
    }, 60_000);
  }
);
