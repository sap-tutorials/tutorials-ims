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
      'ID', 'USER_ID', 'TASK_ID', 'TASK_TYPE', 'STATUS', 'PROGRESS', 'ATTEMPT_NUMBER',
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
    // #600 ATTEMPT_NUMBER at index 6 shifted COMPLETION_DATE to index 8.
    // First row was COMPLETED (legacyId:1, ordered first)
    expect(rows[0][8]).toBeTruthy();            // COMPLETION_DATE present
    expect(rows[1][8] ?? '').toBe('');          // COMPLETION_DATE empty for IN_PROGRESS
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

describe('exports/completion-path-to-task', () => {
  let mod;
  beforeAll(async () => { mod = await import('../../../srv/exports/completion-path-to-task.js'); });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { CompletionPathItems, CompletionPaths, Tutorials, Groups, Prizes } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(CompletionPathItems));
    await db.run(DELETE.from(CompletionPaths));
    await db.run(DELETE.from(Tutorials));
    await db.run(DELETE.from(Groups));
    await db.run(DELETE.from(Prizes));
  });

  it('emits the legacy IMS_COMPLETION_PATH_TO_TASK header', () => {
    expect(mod.legacyHeader).toEqual(['PATH_ID', 'TUTORIAL_ID', 'GROUP_ID', 'CHECKPOINT_TITLE', 'PRIZE_ID', 'ITEM_ORDER']);
  });

  it('populates exactly one of TUTORIAL_ID/GROUP_ID/CHECKPOINT_TITLE per row', async () => {
    const db = await cds.connect.to('db');
    const { CompletionPaths, CompletionPathItems, Tutorials, Groups } = cds.entities('com.sap.developers.ims');
    const pathId = '11111111-1111-1111-1111-111111111111';
    const tutId  = '22222222-2222-2222-2222-222222222222';
    const grpId  = '33333333-3333-3333-3333-333333333333';
    await db.run(INSERT.into(CompletionPaths).entries({ ID: pathId, legacyId: 1000, name: 'P' }));
    await db.run(INSERT.into(Tutorials).entries({ ID: tutId, legacyId: 100, title: 'T', slug: 't' }));
    await db.run(INSERT.into(Groups).entries({ ID: grpId, legacyId: 200, title: 'G' }));
    await db.run(INSERT.into(CompletionPathItems).entries([
      { ID: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', legacyId: 1, path_ID: pathId, taskType: 'TUTORIAL', tutorial_ID: tutId, taskLegacyId: 100, itemOrder: 1 },
      { ID: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', legacyId: 2, path_ID: pathId, taskType: 'GROUP', group_ID: grpId, taskLegacyId: 200, itemOrder: 2 },
      { ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc', legacyId: 3, path_ID: pathId, taskType: 'CHECKPOINT', checkpointTitle: 'Final boss', itemOrder: 3 }
    ]));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);
    expect(rows).toHaveLength(3);

    const [tut, grp, chk] = rows;
    expect([tut[1], tut[2], tut[3]]).toEqual([100, '', '']); // TUTORIAL row: TUTORIAL_ID set
    expect([grp[1], grp[2], grp[3]]).toEqual(['', 200, '']); // GROUP row: GROUP_ID set
    expect([chk[1], chk[2], chk[3]]).toEqual(['', '', 'Final boss']); // CHECKPOINT row
  });
});

describe('exports/step-failures', () => {
  let mod;
  beforeAll(async () => { mod = await import('../../../srv/exports/step-failures.js'); });

  beforeEach(async () => {
    const db = await cds.connect.to('db');
    const { StepFailures, TaskRecords, Users } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(StepFailures));
    await db.run(DELETE.from(TaskRecords));
    await db.run(DELETE.from(Users));
  });

  it('emits the FULL legacy IMS_STEP_FAILURE header (13 columns)', () => {
    expect(mod.legacyHeader).toEqual([
      'ID', 'TASK_RECORD_ID', 'STEP_NUMBER', 'FAILURE_DATE', 'ERROR_MESSAGE',
      'RULE', 'QUESTION', 'MATCH', 'ANSWER', 'STEP_URL', 'TUTORIAL_ID', 'TITLE',
      'CREATED_AT'
    ]);
  });

  it('emits empty strings for the 7 missing legacy fields on every row', async () => {
    const db = await cds.connect.to('db');
    const { Users, TaskRecords, StepFailures } = cds.entities('com.sap.developers.ims');
    const userId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const trId   = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    await db.run(INSERT.into(Users).entries({ ID: userId, uuid: userId }));
    await db.run(INSERT.into(TaskRecords).entries({
      ID: trId, user_ID: userId, taskLegacyId: 100, taskType: 'TUTORIAL', status: 'IN_PROGRESS', legacyId: 1
    }));
    await db.run(INSERT.into(StepFailures).entries({
      ID: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
      legacyId: 2, taskRecord_ID: trId, stepNumber: 3, errorMessage: 'boom'
    }));

    const rows = [];
    for await (const row of mod.rows(db, { pageSize: 100 })) rows.push(row);
    expect(rows).toHaveLength(1);
    const [r] = rows;
    expect(r[1]).toBe(trId);    // TASK_RECORD_ID = UUID string
    expect(r[2]).toBe(3);       // STEP_NUMBER
    expect(r[4]).toBe('boom');  // ERROR_MESSAGE
    // 7 missing columns (indices 5..11) are empty strings
    [5, 6, 7, 8, 9, 10, 11].forEach(i => expect(r[i]).toBe(''));
  });
});
