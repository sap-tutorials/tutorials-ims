// test/lib/completion-rollup-nodowngrade.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { upsertRollupRecord } from '../../srv/lib/completion-rollup.js';

const NS = 'com.sap.developers.ims';
const { test, data } = cds;
const cdsTest = test(cds.root);

describe('upsertRollupRecord no-downgrade', () => {
  let db, TaskRecords, dbUser;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ TaskRecords } = cds.entities(NS));
    const { Users } = cds.entities(NS);
    await db.run(INSERT.into(Users).entries({ ID: 'u-nd-1', sapId: 'NDU1' }));
    dbUser = { ID: 'u-nd-1' };
    await db.run(INSERT.into(TaskRecords).entries({
      ID: 'tr-nd-1', user_ID: 'u-nd-1', taskLegacyId: 9001, taskType: 'MISSION',
      status: 'COMPLETED', progress: 100, legacyId: 990001, attemptNumber: 1,
      completionDate: '2026-01-01T00:00:00.000Z',
    }));
  });
  afterEach(async () => {
    await db.run(DELETE.from(TaskRecords).where({ user_ID: 'u-nd-1' }));
    const { Users } = cds.entities(NS);
    await db.run(DELETE.from(Users).where({ ID: 'u-nd-1' }));
  });

  it('does NOT demote a COMPLETED record when allowDowngrade is false (default)', async () => {
    await upsertRollupRecord({
      dbUser, taskType: 'MISSION', legacyId: 9001, title: 'M',
      progress: 50, status: 'IN_PROGRESS', completionDate: null, db, send: false,
    });
    const [row] = await db.run(SELECT.from(TaskRecords).where({ ID: 'tr-nd-1' }));
    expect(row.status).toBe('COMPLETED');
    expect(row.progress).toBe(100); // max(100, 50)
    expect(row.completionDate).toContain('2026-01-01');
  });

  it('DOES demote when allowDowngrade is true', async () => {
    await upsertRollupRecord({
      dbUser, taskType: 'MISSION', legacyId: 9001, title: 'M',
      progress: 50, status: 'IN_PROGRESS', completionDate: null, db, send: false,
      allowDowngrade: true,
    });
    const [row] = await db.run(SELECT.from(TaskRecords).where({ ID: 'tr-nd-1' }));
    expect(row.status).toBe('IN_PROGRESS');
    expect(row.progress).toBe(50);
    expect(row.completionDate).toBe(null);
  });
});
