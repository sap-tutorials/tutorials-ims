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

describe('exports/task-to-parent', () => {
  let mod;
  beforeAll(async () => {
    mod = await import('../../../srv/exports/task-to-parent.js');
  });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { Steps, Tutorials, Groups, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(GroupPathItems));
    await db.run(DELETE.from(Steps));
    await db.run(DELETE.from(Tutorials));
    await db.run(DELETE.from(Groups));
  });

  it('emits the legacy IMS_TASK_TO_PARENT header', () => {
    expect(mod.legacyHeader).toEqual(['PARENT_TASK_ID', 'CHILD_TASK_ID', 'ITEM_ORDER']);
  });

  it('unions Step->Tutorial and Tutorial->Group edges', async () => {
    const db = await cds.connect.to('db');
    const { Tutorials, Steps, Groups, GroupPathItems } = cds.entities('com.sap.developers.ims');
    const tutId = '11111111-1111-1111-1111-111111111111';
    const grpId = '22222222-2222-2222-2222-222222222222';
    await db.run(INSERT.into(Tutorials).entries({ ID: tutId, legacyId: 500, title: 'T', slug: 't' }));
    await db.run(INSERT.into(Groups).entries({ ID: grpId, legacyId: 700, title: 'G' }));
    await db.run(INSERT.into(Steps).entries({
      ID: '33333333-3333-3333-3333-333333333333',
      legacyId: 600, title: 'S1', tutorial_ID: tutId, stepOrder: 1
    }));
    await db.run(INSERT.into(GroupPathItems).entries({
      ID: '44444444-4444-4444-4444-444444444444',
      legacyId: 800, group_ID: grpId, tutorial_ID: tutId, itemOrder: 2
    }));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);

    // Step->Tutorial: parent=500 (tutorial.legacyId), child=600 (step.legacyId), order=1
    // GroupPathItem: parent=700 (group.legacyId), child=500 (tutorial.legacyId), order=2
    expect(rows).toEqual(expect.arrayContaining([
      [500, 600, 1],
      [700, 500, 2]
    ]));
    expect(rows).toHaveLength(2);
  });
});

describe('exports/completion-path', () => {
  let mod;
  beforeAll(async () => { mod = await import('../../../srv/exports/completion-path.js'); });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { CompletionPaths, Missions } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(CompletionPaths));
    await db.run(DELETE.from(Missions));
  });

  it('emits the legacy IMS_COMPLETION_PATH header', () => {
    expect(mod.legacyHeader).toEqual(['ID', 'NAME', 'MISSION_ID', 'ITEM_ORDER']);
  });

  it('emits legacyId as ID and mission.legacyId as MISSION_ID', async () => {
    const db = await cds.connect.to('db');
    const { Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');
    const misId = '11111111-1111-1111-1111-111111111111';
    await db.run(INSERT.into(Missions).entries({ ID: misId, legacyId: 900, title: 'M' }));
    await db.run(INSERT.into(CompletionPaths).entries({
      ID: '22222222-2222-2222-2222-222222222222',
      legacyId: 1000, name: 'P1', mission_ID: misId
    }));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);
    expect(rows).toHaveLength(1);
    expect(rows[0][0]).toBe(1000); // ID
    expect(rows[0][1]).toBe('P1'); // NAME
    expect(rows[0][2]).toBe(900);  // MISSION_ID
  });
});
