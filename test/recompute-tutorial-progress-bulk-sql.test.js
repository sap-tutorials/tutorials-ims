// Unit tests for recomputeTutorialProgressBulkSQL (#382 phase E).
// SQLite path delegates to the existing per-tutorial JS implementation in
// content-store.js; this exercises that fallback for parity. The HANA-specific
// MERGE INTO branch will be exercised by test/hybrid/recompute-tutorial-progress-bulk-sql.test.js (Phase C).

import cds from '@sap/cds';
import { describe, it, expect, beforeAll } from 'vitest';
import { recomputeTutorialProgressBulkSQL } from '../srv/lib/recompute-tutorial-progress-bulk-sql.js';
import { recomputeTutorialProgress } from '../srv/lib/content-store.js';

const NS = 'com.sap.developers.ims';
const cds_test = cds.test('serve', '--in-memory').in(__dirname, '..');

describe('recomputeTutorialProgressBulkSQL — SQLite fallback parity (#382 phase E)', () => {
  let db;

  beforeAll(async () => {
    await cds_test;
    db = await cds.connect.to('db');
  });

  it('matches per-tutorial recomputeTutorialProgress for a single tutorialId', async () => {
    const { Users, Tutorials, Steps, TaskRecords } = cds.entities(NS);

    // Seed: one user, one tutorial with stepCount=4, three STEP completions, one stale TUTORIAL record at progress=0
    const userId = cds.utils.uuid();
    const tutorialId = cds.utils.uuid();
    const tutorialLegacyId = 11000001;
    const stepLegacyIds = [11000002, 11000003, 11000004, 11000005];

    await INSERT.into(Users).entries({ ID: userId, uuid: 'fixture-user-1', legacyId: 11099001 });
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, legacyId: tutorialLegacyId, slug: 'fixture-tutorial-bulk-1',
      title: 'Fixture', stepCount: 4, status: 'ACTIVE'
    });
    for (let i = 0; i < 4; i++) {
      await INSERT.into(Steps).entries({
        ID: cds.utils.uuid(), tutorial_ID: tutorialId, stepOrder: i + 1,
        title: `Step ${i + 1}`, legacyId: stepLegacyIds[i]
      });
    }
    // 3 of 4 steps completed
    for (let i = 0; i < 3; i++) {
      await INSERT.into(TaskRecords).entries({
        ID: cds.utils.uuid(), user_ID: userId, taskType: 'STEP',
        status: 'COMPLETED', taskLegacyId: stepLegacyIds[i], progress: 100,
        legacyId: 11099100 + i
      });
    }
    // Stale TUTORIAL record at progress=0
    const tutRecId = cds.utils.uuid();
    await INSERT.into(TaskRecords).entries({
      ID: tutRecId, user_ID: userId, taskType: 'TUTORIAL',
      status: 'IN_PROGRESS', taskLegacyId: tutorialLegacyId, progress: 0,
      legacyId: 11099110
    });

    // Run the bulk function — SQLite path delegates to recomputeTutorialProgress per tutorial
    const result = await recomputeTutorialProgressBulkSQL(db, NS, [tutorialId]);
    expect(result.rechecked).toBeGreaterThanOrEqual(1);
    expect(result.updated).toBe(1);

    const updated = await SELECT.one.from(TaskRecords).where({ ID: tutRecId });
    expect(updated.progress).toBe(75);  // round(3/4 * 100) = 75
    expect(updated.status).toBe('IN_PROGRESS');
  });

  it('no-op when tutorialIds is empty', async () => {
    const result = await recomputeTutorialProgressBulkSQL(db, NS, []);
    expect(result).toEqual({ rechecked: 0, updated: 0 });
  });

  it('no-op when tutorialIds is not an array', async () => {
    expect(await recomputeTutorialProgressBulkSQL(db, NS, null)).toEqual({ rechecked: 0, updated: 0 });
    expect(await recomputeTutorialProgressBulkSQL(db, NS, undefined)).toEqual({ rechecked: 0, updated: 0 });
  });

  it('handles multiple tutorialIds in one call (cross-tutorial isolation)', async () => {
    const { Users, Tutorials, Steps, TaskRecords } = cds.entities(NS);

    // Two users, two tutorials. Run only with tutorial A; assert B's TUTORIAL record untouched.
    const userAId = cds.utils.uuid();
    const userBId = cds.utils.uuid();
    const tutAId = cds.utils.uuid();
    const tutBId = cds.utils.uuid();
    const tutALegacy = 12000001;
    const tutBLegacy = 12000002;
    const stepALegacy = [12000010, 12000011];
    const stepBLegacy = [12000020, 12000021];

    await INSERT.into(Users).entries([
      { ID: userAId, uuid: 'fixture-user-A', legacyId: 12099001 },
      { ID: userBId, uuid: 'fixture-user-B', legacyId: 12099002 }
    ]);
    await INSERT.into(Tutorials).entries([
      { ID: tutAId, legacyId: tutALegacy, slug: 'fixture-tut-A', title: 'A', stepCount: 2, status: 'ACTIVE' },
      { ID: tutBId, legacyId: tutBLegacy, slug: 'fixture-tut-B', title: 'B', stepCount: 2, status: 'ACTIVE' }
    ]);
    await INSERT.into(Steps).entries([
      { ID: cds.utils.uuid(), tutorial_ID: tutAId, stepOrder: 1, title: 'A1', legacyId: stepALegacy[0] },
      { ID: cds.utils.uuid(), tutorial_ID: tutAId, stepOrder: 2, title: 'A2', legacyId: stepALegacy[1] },
      { ID: cds.utils.uuid(), tutorial_ID: tutBId, stepOrder: 1, title: 'B1', legacyId: stepBLegacy[0] },
      { ID: cds.utils.uuid(), tutorial_ID: tutBId, stepOrder: 2, title: 'B2', legacyId: stepBLegacy[1] }
    ]);

    // User A: completed both A's steps. STALE TUTORIAL record at progress=0.
    await INSERT.into(TaskRecords).entries([
      { ID: cds.utils.uuid(), user_ID: userAId, taskType: 'STEP', status: 'COMPLETED', taskLegacyId: stepALegacy[0], progress: 100, legacyId: 12099101 },
      { ID: cds.utils.uuid(), user_ID: userAId, taskType: 'STEP', status: 'COMPLETED', taskLegacyId: stepALegacy[1], progress: 100, legacyId: 12099102 }
    ]);
    const tutARecId = cds.utils.uuid();
    await INSERT.into(TaskRecords).entries({
      ID: tutARecId, user_ID: userAId, taskType: 'TUTORIAL', status: 'IN_PROGRESS',
      taskLegacyId: tutALegacy, progress: 0, legacyId: 12099110
    });

    // User B: completed 1 of B's steps. STALE TUTORIAL record at progress=99 (artificial; should NOT be touched).
    await INSERT.into(TaskRecords).entries({
      ID: cds.utils.uuid(), user_ID: userBId, taskType: 'STEP', status: 'COMPLETED',
      taskLegacyId: stepBLegacy[0], progress: 100, legacyId: 12099201
    });
    const tutBRecId = cds.utils.uuid();
    await INSERT.into(TaskRecords).entries({
      ID: tutBRecId, user_ID: userBId, taskType: 'TUTORIAL', status: 'IN_PROGRESS',
      taskLegacyId: tutBLegacy, progress: 99, legacyId: 12099210
    });

    const seedB = await SELECT.one.from(TaskRecords).where({ ID: tutBRecId });

    // Run bulk recompute ONLY on tutorial A
    const result = await recomputeTutorialProgressBulkSQL(db, NS, [tutAId]);
    expect(result.updated).toBe(1);

    const afterA = await SELECT.one.from(TaskRecords).where({ ID: tutARecId });
    expect(afterA.progress).toBe(100);
    expect(afterA.status).toBe('COMPLETED');

    // B is untouched (still its bogus seed value)
    const afterB = await SELECT.one.from(TaskRecords).where({ ID: tutBRecId });
    expect(afterB.progress).toBe(seedB.progress);
    expect(afterB.status).toBe(seedB.status);

    // Now run bulk on BOTH — A is converged so only B is updated.
    const result2 = await recomputeTutorialProgressBulkSQL(db, NS, [tutAId, tutBId]);
    expect(result2.updated).toBe(1);

    const finalB = await SELECT.one.from(TaskRecords).where({ ID: tutBRecId });
    expect(finalB.progress).toBe(50); // 1/2 = 50
    expect(finalB.status).toBe('IN_PROGRESS');
  });

  it('legacy publishHandler parity: identical end-state via bulk function vs per-tutorial JS', async () => {
    const { Users, Tutorials, Steps, TaskRecords } = cds.entities(NS);

    // Seed two parallel fixtures with identical shape; run the OLD function
    // on fixture-1, the NEW bulk function on fixture-2; assert end-states identical.
    const seed = async (suffix) => {
      const userId = cds.utils.uuid();
      const tutId = cds.utils.uuid();
      const tutLegacy = 13000000 + suffix * 100;
      const stepLegacy = [tutLegacy + 1, tutLegacy + 2, tutLegacy + 3];
      await INSERT.into(Users).entries({ ID: userId, uuid: `parity-user-${suffix}`, legacyId: 13099000 + suffix });
      await INSERT.into(Tutorials).entries({
        ID: tutId, legacyId: tutLegacy, slug: `fixture-parity-${suffix}`,
        title: `Parity ${suffix}`, stepCount: 3, status: 'ACTIVE'
      });
      await INSERT.into(Steps).entries([
        { ID: cds.utils.uuid(), tutorial_ID: tutId, stepOrder: 1, title: 'S1', legacyId: stepLegacy[0] },
        { ID: cds.utils.uuid(), tutorial_ID: tutId, stepOrder: 2, title: 'S2', legacyId: stepLegacy[1] },
        { ID: cds.utils.uuid(), tutorial_ID: tutId, stepOrder: 3, title: 'S3', legacyId: stepLegacy[2] }
      ]);
      // 2 of 3 steps completed
      await INSERT.into(TaskRecords).entries([
        { ID: cds.utils.uuid(), user_ID: userId, taskType: 'STEP', status: 'COMPLETED', taskLegacyId: stepLegacy[0], progress: 100, legacyId: 13099100 + suffix * 10 },
        { ID: cds.utils.uuid(), user_ID: userId, taskType: 'STEP', status: 'COMPLETED', taskLegacyId: stepLegacy[1], progress: 100, legacyId: 13099101 + suffix * 10 }
      ]);
      // Stale TUTORIAL record at progress=100 / COMPLETED (deliberately wrong)
      const tutRecId = cds.utils.uuid();
      await INSERT.into(TaskRecords).entries({
        ID: tutRecId, user_ID: userId, taskType: 'TUTORIAL', status: 'COMPLETED',
        taskLegacyId: tutLegacy, progress: 100, completionDate: new Date().toISOString(),
        legacyId: 13099110 + suffix * 10
      });
      return { userId, tutId, tutLegacy, tutRecId };
    };

    const fix1 = await seed(1);
    const fix2 = await seed(2);

    // Old path (per-tutorial JS)
    const oldResult = await recomputeTutorialProgress(db, NS, fix1.tutId, 3);
    // New path (bulk)
    const newResult = await recomputeTutorialProgressBulkSQL(db, NS, [fix2.tutId]);

    expect(oldResult.updated).toBe(1);
    expect(newResult.updated).toBe(1);

    const after1 = await SELECT.one.from(TaskRecords).where({ ID: fix1.tutRecId });
    const after2 = await SELECT.one.from(TaskRecords).where({ ID: fix2.tutRecId });

    // End-states should be identical row-for-row on the user-visible columns.
    expect(after1.progress).toBe(after2.progress);
    expect(after1.status).toBe(after2.status);
    expect(after1.progress).toBe(67); // round(2/3 * 100) = 67
    expect(after1.status).toBe('IN_PROGRESS');
    // completionDate should have been cleared because the row is no longer COMPLETED
    expect(after1.completionDate).toBeFalsy();
    expect(after2.completionDate).toBeFalsy();
  });
});
