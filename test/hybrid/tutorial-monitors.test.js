// test/hybrid/tutorial-monitors.test.js
//
// #923 — hybrid test for the TutorialMonitors entity, MyMonitoredTutorialsView,
// the AuthorService.toggleMonitor action, and the caller-scoped
// GET /author/MyOwnedTutorials behavior.
//
// Runs against real HANA (DEV space). All writes gated by
// ALLOW_HYBRID_WRITES=true; test rows prefixed with __TEST__; cleanup in
// afterAll in FK dependency order.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const NS = 'com.sap.developers.ims';
const TEST_PREFIX = '__TEST__923-';

describe.runIf(isSafeForWrites() && process.env.ALLOW_HYBRID_WRITES === 'true')(
  'TutorialMonitors + toggleMonitor + MyOwnedTutorials [hybrid]',
  () => {
    const cleanup = { users: [], tutorials: [], monitors: [] };

    beforeAll(async () => {
      const db = await cds.connect.to('db');
      const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      if (!isHana) {
        throw new Error(
          'tutorial-monitors.test.js must run against HANA. ' +
            'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
        );
      }
    });

    afterAll(async () => {
      const { Tutorials, TutorialMonitors, Users } = cds.entities(NS);
      for (const id of cleanup.monitors)
        await DELETE.from(TutorialMonitors).where({ ID: id });
      for (const id of cleanup.tutorials)
        await DELETE.from(Tutorials).where({ ID: id });
      for (const id of cleanup.users)
        await DELETE.from(Users).where({ ID: id });
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 1 — TutorialMonitors entity accepts a valid (user, tutorial) pair
    // -------------------------------------------------------------------------
    it('Test 1 — INSERT into TutorialMonitors succeeds for a valid pair', async () => {
      const userId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      const monitorId = cds.utils.uuid();
      cleanup.users.push(userId);
      cleanup.tutorials.push(tutId);
      cleanup.monitors.push(monitorId);

      const { Users, Tutorials, TutorialMonitors } = cds.entities(NS);
      await INSERT.into(Users).entries({
        ID: userId, uuid: userId,
        sapId: TEST_PREFIX + 'u-' + userId.slice(0, 8),
        email: TEST_PREFIX + 'u-' + userId.slice(0, 8) + '@example.com',
      });
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug: TEST_PREFIX + 'tut-' + tutId.slice(0, 8),
        title: TEST_PREFIX + 'Test Tutorial',
        status: 'ACTIVE',
      });
      await INSERT.into(TutorialMonitors).entries({
        ID: monitorId, user_ID: userId, tutorial_ID: tutId,
      });

      const row = await SELECT.one.from(TutorialMonitors)
        .columns('ID', 'user_ID', 'tutorial_ID')
        .where({ ID: monitorId });
      expect(row).toBeTruthy();
      expect(row.user_ID).toBe(userId);
      expect(row.tutorial_ID).toBe(tutId);
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 2 — @assert.unique.userTutorial blocks duplicates
    // -------------------------------------------------------------------------
    it('Test 2 — duplicate (user, tutorial) INSERT is rejected', async () => {
      const userId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      const monitorIdA = cds.utils.uuid();
      const monitorIdB = cds.utils.uuid();
      cleanup.users.push(userId);
      cleanup.tutorials.push(tutId);
      cleanup.monitors.push(monitorIdA); // only A will insert successfully

      const { Users, Tutorials, TutorialMonitors } = cds.entities(NS);
      await INSERT.into(Users).entries({
        ID: userId, uuid: userId,
        sapId: TEST_PREFIX + 'dupe-' + userId.slice(0, 8),
        email: TEST_PREFIX + 'dupe-' + userId.slice(0, 8) + '@example.com',
      });
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug: TEST_PREFIX + 'dupe-tut-' + tutId.slice(0, 8),
        title: TEST_PREFIX + 'Dupe Test', status: 'ACTIVE',
      });
      await INSERT.into(TutorialMonitors).entries({
        ID: monitorIdA, user_ID: userId, tutorial_ID: tutId,
      });

      let threw = false;
      try {
        await INSERT.into(TutorialMonitors).entries({
          ID: monitorIdB, user_ID: userId, tutorial_ID: tutId,
        });
      } catch (err) {
        threw = true;
        expect(String(err.message || err)).toMatch(/unique|assert|duplicate/i);
      }
      expect(threw).toBe(true);
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 3 — MyMonitoredTutorialsView returns only the caller's rows
    // (verifies the userId column resolves to Users.uuid, not Users.ID)
    // -------------------------------------------------------------------------
    it('Test 3 — MyMonitoredTutorialsView scoped by Users.uuid', async () => {
      const aliceId = cds.utils.uuid();
      const bobId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      cleanup.users.push(aliceId, bobId);
      cleanup.tutorials.push(tutId);

      const { Users, Tutorials, TutorialMonitors, MyMonitoredTutorialsView } = cds.entities(NS);
      const aliceUuid = cds.utils.uuid();
      const bobUuid   = cds.utils.uuid();

      await INSERT.into(Users).entries({
        ID: aliceId, uuid: aliceUuid,
        sapId: TEST_PREFIX + 'alice-' + aliceId.slice(0, 8),
        email: TEST_PREFIX + 'alice-' + aliceId.slice(0, 8) + '@example.com',
      });
      await INSERT.into(Users).entries({
        ID: bobId, uuid: bobUuid,
        sapId: TEST_PREFIX + 'bob-' + bobId.slice(0, 8),
        email: TEST_PREFIX + 'bob-' + bobId.slice(0, 8) + '@example.com',
      });
      await INSERT.into(Tutorials).entries({
        ID: tutId,
        slug: TEST_PREFIX + 'scope-' + tutId.slice(0, 8),
        title: TEST_PREFIX + 'Scope Test', status: 'ACTIVE',
      });
      // Only Alice monitors this tutorial.
      const monitorId = cds.utils.uuid();
      cleanup.monitors.push(monitorId);
      await INSERT.into(TutorialMonitors).entries({
        ID: monitorId, user_ID: aliceId, tutorial_ID: tutId,
      });

      const aliceRows = await SELECT.from(MyMonitoredTutorialsView)
        .where({ userId: aliceUuid, tutorial_ID: tutId });
      const bobRows = await SELECT.from(MyMonitoredTutorialsView)
        .where({ userId: bobUuid, tutorial_ID: tutId });
      expect(aliceRows).toHaveLength(1);
      expect(bobRows).toHaveLength(0);
    }, 60_000);

    // -------------------------------------------------------------------------
    // Test 4 — soft-deleted tutorials are filtered from the view
    // -------------------------------------------------------------------------
    it('Test 4 — INACTIVE/DELETED tutorials do not surface on the view', async () => {
      const userId = cds.utils.uuid();
      const activeTut = cds.utils.uuid();
      const inactiveTut = cds.utils.uuid();
      cleanup.users.push(userId);
      cleanup.tutorials.push(activeTut, inactiveTut);

      const { Users, Tutorials, TutorialMonitors, MyMonitoredTutorialsView } = cds.entities(NS);
      const uuid = cds.utils.uuid();
      await INSERT.into(Users).entries({
        ID: userId, uuid,
        sapId: TEST_PREFIX + 'soft-' + userId.slice(0, 8),
        email: TEST_PREFIX + 'soft-' + userId.slice(0, 8) + '@example.com',
      });
      await INSERT.into(Tutorials).entries({
        ID: activeTut,
        slug: TEST_PREFIX + 'active-' + activeTut.slice(0, 8),
        title: TEST_PREFIX + 'Active', status: 'ACTIVE',
      });
      await INSERT.into(Tutorials).entries({
        ID: inactiveTut,
        slug: TEST_PREFIX + 'inactive-' + inactiveTut.slice(0, 8),
        title: TEST_PREFIX + 'Inactive', status: 'INACTIVE',
      });
      const mA = cds.utils.uuid();
      const mI = cds.utils.uuid();
      cleanup.monitors.push(mA, mI);
      await INSERT.into(TutorialMonitors).entries({
        ID: mA, user_ID: userId, tutorial_ID: activeTut,
      });
      await INSERT.into(TutorialMonitors).entries({
        ID: mI, user_ID: userId, tutorial_ID: inactiveTut,
      });

      const rows = await SELECT.from(MyMonitoredTutorialsView).where({ userId: uuid });
      const slugs = rows.map((r) => r.slug);
      expect(slugs).toContain(TEST_PREFIX + 'active-' + activeTut.slice(0, 8));
      expect(slugs).not.toContain(TEST_PREFIX + 'inactive-' + inactiveTut.slice(0, 8));
    }, 60_000);
  }
);
