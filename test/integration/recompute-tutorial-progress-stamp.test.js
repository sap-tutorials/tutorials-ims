import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { recomputeTutorialProgress } from '../../srv/lib/content-store.js';

// recomputeTutorialProgress flips a TUTORIAL TaskRecord's status based on STEP
// completions. Post-fix it must stamp the submissionId matching the new status.
const test = cds.test('serve', '--project', '.', '--in-memory');

describe('recomputeTutorialProgress stamps submissionId on status transition', () => {
  beforeAll(async () => {
    const { Users, Tutorials, Steps, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: 'dddddddd-rec0-0000-0000-000000000001', uuid: 'P0006666001', legacyId: 9001, sapId: 'P0006666001' });
    await INSERT.into(Tutorials).entries({ ID: 'eeeeeeee-rec0-0000-0000-000000000001', slug: 'rec-tut', title: 'Recompute Tut', legacyId: 9100, status: 'ACTIVE' });
    await INSERT.into(Steps).entries({ ID: 'ffffffff-rec0-0000-0000-000000000001', tutorial_ID: 'eeeeeeee-rec0-0000-0000-000000000001', legacyId: 9110, title: 'S1' });
    // Completed STEP so recompute drives the TUTORIAL row to COMPLETED (stepCount=1).
    await INSERT.into(TaskRecords).entries({ ID: '11111111-rec0-0000-0000-000000000001', user_ID: 'dddddddd-rec0-0000-0000-000000000001', taskLegacyId: 9110, taskType: 'STEP', status: 'COMPLETED', progress: 100, legacyId: 9200, attemptNumber: 1 });
    // TUTORIAL row currently IN_PROGRESS with NO submissionIdCompleted.
    await INSERT.into(TaskRecords).entries({ ID: '22222222-rec0-0000-0000-000000000001', user_ID: 'dddddddd-rec0-0000-0000-000000000001', taskLegacyId: 9100, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 0, legacyId: 9201, attemptNumber: 1 });
  });

  it('stamps submissionIdCompleted when recompute flips the row to COMPLETED', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const db = await cds.connect.to('db');
    await recomputeTutorialProgress(db, 'com.sap.developers.ims', 'eeeeeeee-rec0-0000-0000-000000000001', 1);
    const row = await SELECT.one.from(TaskRecords).where({ ID: '22222222-rec0-0000-0000-000000000001' });
    expect(row.status).toBe('COMPLETED');
    expect(row.submissionIdCompleted).toBeTruthy();
  });
});
