// test/integration/ngds-backfill.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { backfillSubmissionIds } from '../../scripts/lib/ngds-backfill.mjs';

const test = cds.test('serve', '--project', '.', '--in-memory');

describe('backfillSubmissionIds', () => {
  beforeAll(async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TaskRecords).entries([
      { ID: 'bf000001-0000-0000-0000-000000000001', taskLegacyId: 5001, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 5001 },
      { ID: 'bf000002-0000-0000-0000-000000000002', taskLegacyId: 5002, taskType: 'TUTORIAL', status: 'IN_PROGRESS', progress: 20, legacyId: 5002 },
      { ID: 'bf000003-0000-0000-0000-000000000003', taskLegacyId: 5003, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 5003, submissionIdCompleted: 'already-set' },
    ]);
  });

  it('dry-run reports candidates without writing', async () => {
    const db = await cds.connect.to('db');
    const r = await backfillSubmissionIds(db, { dryRun: true });
    expect(r.completed).toBe(1);  // only the one missing an id
    expect(r.started).toBe(1);
    expect(r.updated).toBe(0);
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const row = await SELECT.one.from(TaskRecords).where({ ID: 'bf000001-0000-0000-0000-000000000001' });
    expect(row.submissionIdCompleted).toBeFalsy();
  });

  it('execute stamps missing ids and is idempotent', async () => {
    const db = await cds.connect.to('db');
    const r1 = await backfillSubmissionIds(db, { dryRun: false });
    expect(r1.updated).toBe(2);
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const c = await SELECT.one.from(TaskRecords).where({ ID: 'bf000001-0000-0000-0000-000000000001' });
    const s = await SELECT.one.from(TaskRecords).where({ ID: 'bf000002-0000-0000-0000-000000000002' });
    const kept = await SELECT.one.from(TaskRecords).where({ ID: 'bf000003-0000-0000-0000-000000000003' });
    expect(c.submissionIdCompleted).toBeTruthy();
    expect(s.submissionIdStarted).toBeTruthy();
    expect(kept.submissionIdCompleted).toBe('already-set'); // untouched

    const r2 = await backfillSubmissionIds(db, { dryRun: false });
    expect(r2.updated).toBe(0); // idempotent
  });
});
