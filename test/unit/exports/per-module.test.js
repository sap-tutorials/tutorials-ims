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

describe('exports/task-records', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('../../../srv/exports/task-records.js');
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(TaskRecords));
    await db.run(DELETE.from(Users));
  });

  it('emits the legacy IMS_TASK_RECORD header', () => {
    expect(mod.legacyHeader).toEqual([
      'ID', 'USER_ID', 'TASK_ID', 'TASK_TYPE', 'STATUS', 'PROGRESS',
      'COMPLETION_TIME', 'COMPLETION_DATE', 'CONTENT_LANGUAGE', 'SITE_LANGUAGE',
      'SUBMISSION_ID_STARTED', 'SUBMISSION_ID_COMPLETED', 'TITLE_SNAPSHOT',
      'PROGRESS_NOTE', 'EVENT', 'CREATED_AT', 'MODIFIED_AT'
    ]);
  });

  it('emits UUID strings for ID/USER_ID, taskLegacyId for TASK_ID, null COMPLETION_DATE for in-progress', async () => {
    const db = await cds.connect.to('db');
    const { TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await db.run(INSERT.into(Users).entries({ ID: userId, uuid: userId }));
    await db.run(INSERT.into(TaskRecords).entries([
      { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', user_ID: userId, taskLegacyId: 101, taskType: 'TUTORIAL', status: 'COMPLETED', completionDate: '2026-05-23T10:00:00Z', legacyId: 1 },
      { ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', user_ID: userId, taskLegacyId: 102, taskType: 'TUTORIAL', status: 'IN_PROGRESS', legacyId: 2 }
    ]));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);

    expect(rows).toHaveLength(2);
    expect(typeof rows[0][0]).toBe('string'); // ID is UUID string
    expect(rows[0][1]).toBe(userId);            // USER_ID
    expect(rows[0][2]).toBe(101);               // TASK_ID = taskLegacyId
    // First row was COMPLETED (legacyId:1, ordered first)
    expect(rows[0][7]).toBeTruthy();            // COMPLETION_DATE present
    expect(rows[1][7] ?? '').toBe('');          // COMPLETION_DATE empty for IN_PROGRESS
  });
});
