// test/lib/completion-reconcile.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { reconcileEntityForUsers, findUnhealthyEntities } from '../../srv/lib/completion-reconcile.js';

const NS = 'com.sap.developers.ims';
cds.test(cds.root);

describe('completion-reconcile', () => {
  let db;
  beforeEach(async () => {
    db = await cds.connect.to('db');
    const E = cds.entities(NS);
    await db.run(INSERT.into(E.Users).entries({ ID: 'u-rc', sapId: 'RC1' }));
    // Mission with two ACTIVE tutorials; user completed BOTH as TUTORIAL records
    // but has a STALE mission record stuck at IN_PROGRESS/50 (simulating drift).
    await db.run(INSERT.into(E.Tutorials).entries(
      { ID: 't-a', legacyId: 5001, slug: 'a', status: 'ACTIVE' },
      { ID: 't-b', legacyId: 5002, slug: 'b', status: 'ACTIVE' },
    ));
    await db.run(INSERT.into(E.Missions).entries({ ID: 'm-rc', legacyId: 5500, title: 'RC', published: true }));
    await db.run(INSERT.into(E.CompletionPaths).entries({ ID: 'cp-rc', mission_ID: 'm-rc', legacyId: 5600 }));
    await db.run(INSERT.into(E.CompletionPathItems).entries(
      { ID: 'i-a', path_ID: 'cp-rc', taskType: 'TUTORIAL', taskLegacyId: 5001, itemOrder: 10 },
      { ID: 'i-b', path_ID: 'cp-rc', taskType: 'TUTORIAL', taskLegacyId: 5002, itemOrder: 20 },
    ));
    await db.run(INSERT.into(E.TaskRecords).entries(
      { ID: 'r-a', user_ID: 'u-rc', taskLegacyId: 5001, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 550001, attemptNumber: 1 },
      { ID: 'r-b', user_ID: 'u-rc', taskLegacyId: 5002, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, legacyId: 550002, attemptNumber: 1 },
      { ID: 'r-m', user_ID: 'u-rc', taskLegacyId: 5500, taskType: 'MISSION', status: 'IN_PROGRESS', progress: 50, legacyId: 550003, attemptNumber: 1 },
    ));
  });
  afterEach(async () => {
    const E = cds.entities(NS);
    await db.run(DELETE.from(E.TaskRecords).where({ ID: { in: ['r-a', 'r-b', 'r-m'] } }));
    // also clean up any new mission records upserted by reconcile (auto-created row won't have a known ID)
    await db.run(DELETE.from(E.TaskRecords).where({ user_ID: 'u-rc' }));
    await db.run(DELETE.from(E.CompletionPathItems).where({ ID: { in: ['i-a', 'i-b'] } }));
    await db.run(DELETE.from(E.CompletionPaths).where({ ID: 'cp-rc' }));
    await db.run(DELETE.from(E.Missions).where({ ID: 'm-rc' }));
    await db.run(DELETE.from(E.Tutorials).where({ ID: { in: ['t-a', 't-b'] } }));
    await db.run(DELETE.from(E.Users).where({ ID: 'u-rc' }));
  });

  it('repairs a stale mission record to COMPLETED', async () => {
    const res = await reconcileEntityForUsers({ kind: 'MISSION', legacyId: 5500, db, send: false });
    const { TaskRecords } = cds.entities(NS);
    const [row] = await db.run(SELECT.from(TaskRecords).where({ user_ID: 'u-rc', taskType: 'MISSION' }));
    expect(row.status).toBe('COMPLETED');
    expect(row.progress).toBe(100);
    expect(res.completed).toBeGreaterThan(0);
  });

  it('findUnhealthyEntities flags a mission with an INACTIVE slot', async () => {
    const { Tutorials } = cds.entities(NS);
    await db.run(UPDATE(Tutorials, 't-b').set({ status: 'INACTIVE' }));
    const bad = await findUnhealthyEntities(db);
    const m = bad.find(e => e.legacyId === 5500);
    expect(m).toBeDefined();
    expect(m.badSlots.some(s => s.taskLegacyId === 5002 && s.reason === 'inactive')).toBe(true);
  });
});
