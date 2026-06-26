// Issue #644 — Puzzle task type + Puzzles entity + per-taskType
// projections on AdminService.
//
// Asserts:
//   1. The Puzzles entity exists and accepts a row (TaskBase shape).
//   2. TaskRecords.taskType accepts 'PUZZLE'.
//   3. Per-taskType admin projections return only their own rows.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

const USER_ID = '64464464-9100-0000-0000-000000000001';

describe('Issue #644 — PUZZLE task type + per-type AdminService projections', () => {
  beforeAll(async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(Users).entries({ ID: USER_ID, uuid: 'puzzle-test', sapId: 'P644' });
  });

  beforeEach(async () => {
    const { TaskRecords, Puzzles } = cds.entities('com.sap.developers.ims');
    // Clean up only puzzle/test rows so other tests sharing this DB don't see
    // surprise inserts. Bracket on our deterministic UUID prefix.
    await DELETE.from(TaskRecords).where({ user_ID: USER_ID });
    await DELETE.from(Puzzles).where({ legacyId: { in: [9001, 9002] } });
  });

  it('Puzzles entity accepts a row', async () => {
    const { Puzzles } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Puzzles).entries({
      ID: '64464464-9200-0000-0000-000000000001',
      legacyId: 9001,
      title: 'Joule Trivia',
      description: 'Daily AI puzzle',
      status: 'ACTIVE'
    });
    const rows = await SELECT.from(Puzzles).where({ legacyId: 9001 });
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe('Joule Trivia');
  });

  it("TaskRecords.taskType accepts 'PUZZLE'", async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TaskRecords).entries({
      ID: '64464464-9300-0000-0000-000000000001',
      user_ID: USER_ID,
      taskLegacyId: 9001,
      taskType: 'PUZZLE',
      status: 'COMPLETED',
      progress: 100
    });
    const rows = await SELECT.from(TaskRecords)
      .where({ user_ID: USER_ID, taskType: 'PUZZLE' });
    expect(rows).toHaveLength(1);
  });

  it('Per-taskType projections each return only their own rows', async () => {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const seed = (n, type, legacyId) => ({
      ID: `64464464-9400-${String(n).padStart(4, '0')}-0000-000000000000`,
      user_ID: USER_ID, taskLegacyId: legacyId, taskType: type,
      status: 'COMPLETED', progress: 100
    });
    await INSERT.into(TaskRecords).entries([
      seed(1, 'TUTORIAL',   100),
      seed(2, 'MISSION',    200),
      seed(3, 'GROUP',      300),
      seed(4, 'STEP',       400),
      seed(5, 'CHECKPOINT', 500),
      seed(6, 'PUZZLE',     600)
    ]);

    // Hit AdminService via HTTP so @requires:'Admin' is satisfied via basic
    // auth — same pattern as test/admin-service.test.js et al.
    const filter = `?$filter=user_ID eq '${USER_ID}'`;
    const get = async (entity) => {
      const { data } = await project.GET(`/admin/${entity}${filter}`, adminAuth);
      return data.value.map(r => r.taskType);
    };

    expect(await get('TutorialTaskRecords')).toEqual(['TUTORIAL']);
    expect(await get('MissionTaskRecords')).toEqual(['MISSION']);
    expect(await get('GroupTaskRecords')).toEqual(['GROUP']);
    expect(await get('StepTaskRecords')).toEqual(['STEP']);
    expect(await get('CheckpointTaskRecords')).toEqual(['CHECKPOINT']);
    expect(await get('PuzzleTaskRecords')).toEqual(['PUZZLE']);
  });
});
