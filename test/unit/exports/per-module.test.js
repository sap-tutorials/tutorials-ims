import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('exports/tasks', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('../../../srv/exports/tasks.js');
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Missions, Groups, Steps, Checkpoints } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(Tutorials));
    await db.run(DELETE.from(Missions));
    await db.run(DELETE.from(Groups));
    await db.run(DELETE.from(Steps));
    await db.run(DELETE.from(Checkpoints));
  });

  it('emits the legacy IMS_TASK header', () => {
    expect(mod.legacyHeader).toEqual([
      'ID', 'TITLE', 'DESCRIPTION', 'STATUS', 'DELETION_REASON',
      'PRIMARY_TAG', 'EXPERIENCE_TAG', 'AVERAGE_TIME_TO_COMPLETE',
      'TASK_TYPE', 'CREATED_AT', 'MODIFIED_AT'
    ]);
  });

  it('yields legacyId as ID and pages stably across types', async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Missions } = cds.entities('com.sap.developers.ims');
    await db.run(INSERT.into(Tutorials).entries([
      { ID: '11111111-1111-1111-1111-111111111111', legacyId: 101, title: 'T1', slug: 't1', status: 'ACTIVE' },
      { ID: '22222222-2222-2222-2222-222222222222', legacyId: 102, title: 'T2', slug: 't2', status: 'ACTIVE' }
    ]));
    await db.run(INSERT.into(Missions).entries([
      { ID: '33333333-3333-3333-3333-333333333333', legacyId: 201, title: 'M1', status: 'ACTIVE' }
    ]));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 2 })) rows.push(row);

    expect(rows).toHaveLength(3);
    // Stable order: GROUP < MISSION < TUTORIAL alphabetically; only MISSION + TUTORIAL inserted
    expect(rows[0][0]).toBe(201);            // MISSION first
    expect(rows[0][8]).toBe('MISSION');
    expect(rows[1][0]).toBe(101);            // TUTORIAL legacyId=101
    expect(rows[1][8]).toBe('TUTORIAL');
    expect(rows[2][0]).toBe(102);            // TUTORIAL legacyId=102
  });
});
