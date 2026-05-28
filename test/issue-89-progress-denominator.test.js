// Tests for issue #89 — partial-completion shown as 100% in navigator card.
// Root cause: completeStep used the count of Step rows in the DB as the
// denominator for tutorial progress, but Step rows are lazily inserted on
// each click. So "1/1=100%" could fire after a single click. The fix routes
// the denominator through `Tutorials.stepCount` (set authoritatively by
// publish-content), and recomputes existing TUTORIAL TaskRecords when a
// publish updates the step count.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { recomputeTutorialProgress } from '../srv/lib/content-store.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const NS = 'com.sap.developers.ims';

describe('Issue #89: tutorial progress denominator', () => {
  let TUTORIAL_ID;
  let TUTORIAL_LEGACY;

  beforeAll(async () => {
    const { Tutorials, Steps } = cds.entities(NS);
    TUTORIAL_ID = 'aaaaaaaa-89ee-0000-0000-000000000001';
    TUTORIAL_LEGACY = 89001;

    // 11-step tutorial (matches the abap-connectivity-daemon-simple shape)
    // but only 4 of them exist in the DB to mirror the bug condition before
    // publish-content has populated all of them.
    await INSERT.into(Tutorials).entries({
      ID: TUTORIAL_ID,
      slug: 'issue-89-tutorial',
      title: 'Issue 89 Tutorial',
      legacyId: TUTORIAL_LEGACY,
      stepCount: 11,
      status: 'ACTIVE'
    });

    await INSERT.into(Steps).entries([
      { ID: 'bbbb89ee-0000-0000-0000-000000000001', tutorial_ID: TUTORIAL_ID, stepOrder: 1, title: 'Step 1', legacyId: 89101 },
      { ID: 'bbbb89ee-0000-0000-0000-000000000002', tutorial_ID: TUTORIAL_ID, stepOrder: 2, title: 'Step 2', legacyId: 89102 },
      { ID: 'bbbb89ee-0000-0000-0000-000000000003', tutorial_ID: TUTORIAL_ID, stepOrder: 3, title: 'Step 3', legacyId: 89103 },
      { ID: 'bbbb89ee-0000-0000-0000-000000000004', tutorial_ID: TUTORIAL_ID, stepOrder: 4, title: 'Step 4', legacyId: 89104 }
    ]);
  });

  it('completing all 4 DB-resident steps does not flip TUTORIAL TaskRecord to 100%', async () => {
    for (const n of [1, 2, 3, 4]) {
      const { status } = await project.post('/api/completeStep',
        { slug: 'issue-89-tutorial', stepNumber: n },
        { auth: { username: 'tom89', password: 'tom89' } });
      expect(status).toBe(200);
    }

    const { Users, TaskRecords } = cds.entities(NS);
    const user = await SELECT.one.from(Users).where({ uuid: 'tom89' });
    expect(user).toBeDefined();
    const tutRec = await SELECT.one.from(TaskRecords).where({
      user_ID: user.ID,
      taskLegacyId: TUTORIAL_LEGACY,
      taskType: 'TUTORIAL'
    });
    expect(tutRec).toBeDefined();
    // 4 of 11 = 36%, NOT 100%, even though only 4 Step rows exist in DB.
    expect(tutRec.progress).toBe(36);
    expect(tutRec.status).toBe('IN_PROGRESS');
  });

  it('recomputeTutorialProgress flips a stale 100% row back to IN_PROGRESS when the step count grows', async () => {
    const { Tutorials, Steps, TaskRecords, Users } = cds.entities(NS);
    const TID = 'aaaaaaaa-89ee-0000-0000-000000000002';
    const LID = 89002;

    // Simulate the legacy state: tutorial existed with stepCount=null, user
    // completed all 2 known steps, _updateTutorialProgress wrote 100%/COMPLETED.
    await INSERT.into(Tutorials).entries({
      ID: TID,
      slug: 'issue-89-tutorial-stale',
      title: 'Stale Tutorial',
      legacyId: LID,
      status: 'ACTIVE'
    });
    await INSERT.into(Steps).entries([
      { ID: 'bbbb89ee-0000-0000-0000-000000000010', tutorial_ID: TID, stepOrder: 1, title: 'Step 1', legacyId: 89201 },
      { ID: 'bbbb89ee-0000-0000-0000-000000000011', tutorial_ID: TID, stepOrder: 2, title: 'Step 2', legacyId: 89202 }
    ]);
    const userId = 'cccc89ee-0000-0000-0000-000000000001';
    await INSERT.into(Users).entries({ ID: userId, uuid: 'stale-user', legacyId: 89901 });
    await INSERT.into(TaskRecords).entries([
      { user_ID: userId, taskLegacyId: 89201, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 89911 },
      { user_ID: userId, taskLegacyId: 89202, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 89912 },
      { user_ID: userId, taskLegacyId: LID, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 89913, completionDate: new Date().toISOString() }
    ]);

    // Now simulate publish-content arriving with the true step count (10),
    // and inserting the 8 missing Step rows.
    const newSteps = [];
    for (let i = 3; i <= 10; i += 1) {
      newSteps.push({
        ID: `bbbb89ee-0002-0000-0000-${String(i).padStart(12, '0')}`,
        tutorial_ID: TID,
        stepOrder: i,
        title: `Step ${i}`,
        legacyId: 89200 + i
      });
    }
    await INSERT.into(Steps).entries(newSteps);

    const db = await cds.connect.to('db');
    const result = await recomputeTutorialProgress(db, NS, TID, 10);
    expect(result.updated).toBe(1);

    const updated = await SELECT.one.from(TaskRecords).where({
      user_ID: userId,
      taskLegacyId: LID,
      taskType: 'TUTORIAL'
    });
    expect(updated.progress).toBe(20); // 2/10
    expect(updated.status).toBe('IN_PROGRESS');
    expect(updated.completionDate).toBeNull();
  });

  it('recomputeTutorialProgress is a no-op when row already matches', async () => {
    const { Tutorials, Steps, TaskRecords, Users } = cds.entities(NS);
    const TID = 'aaaaaaaa-89ee-0000-0000-000000000003';
    const LID = 89003;

    await INSERT.into(Tutorials).entries({
      ID: TID, slug: 'issue-89-noop', title: 'Noop', legacyId: LID, status: 'ACTIVE'
    });
    await INSERT.into(Steps).entries([
      { ID: 'bbbb89ee-0000-0000-0000-000000000020', tutorial_ID: TID, stepOrder: 1, title: 'S1', legacyId: 89301 },
      { ID: 'bbbb89ee-0000-0000-0000-000000000021', tutorial_ID: TID, stepOrder: 2, title: 'S2', legacyId: 89302 }
    ]);
    const userId = 'cccc89ee-0000-0000-0000-000000000002';
    await INSERT.into(Users).entries({ ID: userId, uuid: 'noop-user', legacyId: 89902 });
    await INSERT.into(TaskRecords).entries([
      { user_ID: userId, taskLegacyId: 89301, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 89921 },
      { user_ID: userId, taskLegacyId: 89302, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 89922 },
      { user_ID: userId, taskLegacyId: LID, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 89923 }
    ]);

    const db = await cds.connect.to('db');
    const result = await recomputeTutorialProgress(db, NS, TID, 2);
    expect(result.updated).toBe(0);
  });

  it('recomputeTutorialProgress short-circuits on invalid stepCount', async () => {
    const db = await cds.connect.to('db');
    expect((await recomputeTutorialProgress(db, NS, TUTORIAL_ID, 0)).updated).toBe(0);
    expect((await recomputeTutorialProgress(db, NS, TUTORIAL_ID, null)).updated).toBe(0);
    expect((await recomputeTutorialProgress(db, NS, TUTORIAL_ID, -3)).updated).toBe(0);
  });
});
