import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { runBackfill } from '../../scripts/backfill-group-mission-completions.mjs';

cds.test('serve', '--project', '.', '--in-memory');

describe('runBackfill', () => {
  const U = 'bu000000-0000-0000-0000-000000000001';
  beforeAll(async () => {
    const e = cds.entities('com.sap.developers.ims');
    await INSERT.into(e.Users).entries({ ID: U, sapId: 'P000999', legacyId: 9999 });
    await INSERT.into(e.Tutorials).entries({ ID: 'bt000000-0000-0000-0000-000000000001', slug: 'bf-t1', title: 'T1', legacyId: 9101, status: 'ACTIVE' });
    await INSERT.into(e.Groups).entries({ ID: 'bg000000-0000-0000-0000-000000000001', slug: 'bf-g', title: 'G', legacyId: 9200, status: 'ACTIVE' });
    await INSERT.into(e.GroupPathItems).entries({ group_ID: 'bg000000-0000-0000-0000-000000000001', tutorial_ID: 'bt000000-0000-0000-0000-000000000001', itemOrder: 1, legacyId: 9301 });
    await INSERT.into(e.Missions).entries({ ID: 'bm000000-0000-0000-0000-000000000001', slug: 'bf-m', title: 'M', legacyId: 9400, status: 'ACTIVE' });
    await INSERT.into(e.CompletionPaths).entries({ ID: 'bp000000-0000-0000-0000-000000000001', mission_ID: 'bm000000-0000-0000-0000-000000000001', name: 'P', legacyId: 9500 });
    await INSERT.into(e.CompletionPathItems).entries({ path_ID: 'bp000000-0000-0000-0000-000000000001', taskType: 'GROUP', group_ID: 'bg000000-0000-0000-0000-000000000001', taskLegacyId: 9200, itemOrder: 1, legacyId: 9600 });
    // A post-cutover tutorial completion, with no GROUP/MISSION row yet:
    await INSERT.into(e.TaskRecords).entries({ user_ID: U, taskLegacyId: 9101, taskType: 'TUTORIAL', status: 'COMPLETED', progress: 100, completionDate: '2026-08-15T10:00:00.000Z', legacyId: 91010 });
  });

  it('dry-run reports counts and writes nothing', async () => {
    const r = await runBackfill({ since: '2026-08-10T00:00:00Z', dryRun: true, db: cds.db });
    expect(r.users).toBeGreaterThanOrEqual(1);
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grp = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskType: 'GROUP', taskLegacyId: 9200 });
    expect(grp).toBeUndefined();
  });

  it('real run writes COMPLETED group + mission and is idempotent', async () => {
    await runBackfill({ since: '2026-08-10T00:00:00Z', dryRun: false, db: cds.db });
    await runBackfill({ since: '2026-08-10T00:00:00Z', dryRun: false, db: cds.db });
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grpRows = await SELECT.from(TaskRecords).where({ user_ID: U, taskType: 'GROUP', taskLegacyId: 9200, status: { '!=': 'SUPERSEDED' } });
    const mis = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskType: 'MISSION', taskLegacyId: 9400 });
    expect(grpRows).toHaveLength(1);
    expect(grpRows[0].status).toBe('COMPLETED');
    expect(mis.status).toBe('COMPLETED');
  });
});
