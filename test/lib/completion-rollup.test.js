import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import {
  collapseSlots, evaluateSlots, tokenFor,
  loadGroupSlots, loadMissionSlots, findParents,
  rollUpParentsForCompletion,
} from '../../srv/lib/completion-rollup.js';

cds.test('serve', '--project', '.', '--in-memory');

describe('collapseSlots', () => {
  it('makes one slot per linear item', () => {
    const slots = collapseSlots([
      { taskType: 'TUTORIAL', taskLegacyId: 10, itemOrder: 1, altGroupKey: null, groupId: null },
      { taskType: 'PUZZLE',   taskLegacyId: 20, itemOrder: 2, altGroupKey: null, groupId: null },
    ]);
    expect(slots).toEqual([{ tokens: ['TUTORIAL:10'] }, { tokens: ['PUZZLE:20'] }]);
  });

  it('collapses an alt-group into one multi-token slot', () => {
    const slots = collapseSlots([
      { taskType: 'TUTORIAL', taskLegacyId: 10, itemOrder: 1, altGroupKey: 'A', groupId: null },
      { taskType: 'TUTORIAL', taskLegacyId: 11, itemOrder: 1, altGroupKey: 'A', groupId: null },
    ]);
    expect(slots).toHaveLength(1);
    expect(new Set(slots[0].tokens)).toEqual(new Set(['TUTORIAL:10', 'TUTORIAL:11']));
  });

  it('emits GROUP items as group slots, never alt-collapsed', () => {
    const slots = collapseSlots([
      { taskType: 'GROUP', taskLegacyId: 99, itemOrder: 1, altGroupKey: null, groupId: 5 },
    ]);
    expect(slots).toEqual([{ groupId: 5 }]);
  });
});

describe('evaluateSlots', () => {
  const done = new Set(['TUTORIAL:10']);
  it('counts a satisfied token slot', () => {
    expect(evaluateSlots([{ tokens: ['TUTORIAL:10'] }], done, () => [])).toEqual({ satisfied: 1, total: 1 });
  });
  it('any branch satisfies an alt-group slot', () => {
    expect(evaluateSlots([{ tokens: ['TUTORIAL:10', 'TUTORIAL:11'] }], done, () => [])).toEqual({ satisfied: 1, total: 1 });
  });
  it('a group slot needs all its inner slots satisfied', () => {
    const resolve = () => [{ tokens: ['TUTORIAL:10'] }, { tokens: ['TUTORIAL:12'] }];
    expect(evaluateSlots([{ groupId: 5 }], done, resolve)).toEqual({ satisfied: 0, total: 1 });
    const done2 = new Set(['TUTORIAL:10', 'TUTORIAL:12']);
    expect(evaluateSlots([{ groupId: 5 }], done2, resolve)).toEqual({ satisfied: 1, total: 1 });
  });
  it('tokenFor builds the composite key', () => {
    expect(tokenFor('MISSION', 7)).toBe('MISSION:7');
  });
});

describe('completion-rollup DB membership', () => {
  const G = 'gggggggg-0000-0000-0000-000000000001';
  const M = 'mmmmmmmm-0000-0000-0000-000000000001';
  const P = 'pppppppp-0000-0000-0000-000000000001';
  const T1 = 'ta000000-0000-0000-0000-000000000001';
  const T2 = 'ta000000-0000-0000-0000-000000000002';

  beforeAll(async () => {
    const { Tutorials, Groups, GroupPathItems, Missions, CompletionPaths, CompletionPathItems } =
      cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: T1, slug: 'roll-t1', title: 'T1', legacyId: 5101, status: 'ACTIVE' },
      { ID: T2, slug: 'roll-t2', title: 'T2', legacyId: 5102, status: 'ACTIVE' },
    ]);
    await INSERT.into(Groups).entries({ ID: G, slug: 'roll-g', title: 'G', legacyId: 5200, status: 'ACTIVE' });
    await INSERT.into(GroupPathItems).entries([
      { group_ID: G, tutorial_ID: T1, itemOrder: 1, legacyId: 5301 },
      { group_ID: G, tutorial_ID: T2, itemOrder: 2, legacyId: 5302 },
    ]);
    await INSERT.into(Missions).entries({ ID: M, slug: 'roll-m', title: 'M', legacyId: 5400, status: 'ACTIVE' });
    await INSERT.into(CompletionPaths).entries({ ID: P, mission_ID: M, name: 'P', legacyId: 5500 });
    await INSERT.into(CompletionPathItems).entries([
      { path_ID: P, taskType: 'GROUP', group_ID: G, taskLegacyId: 5200, itemOrder: 1, legacyId: 5601 },
    ]);
  });

  it('loadGroupSlots resolves tutorial legacyIds', async () => {
    const slots = await loadGroupSlots(G, cds.db);
    expect(slots).toEqual([{ tokens: ['TUTORIAL:5101'] }, { tokens: ['TUTORIAL:5102'] }]);
  });

  it('loadMissionSlots emits a group slot keyed by group legacyId', async () => {
    const slots = await loadMissionSlots(M, cds.db);
    expect(slots).toEqual([{ groupId: 5200 }]);
  });

  it('findParents finds the group and the mission for a tutorial', async () => {
    const { groupLegacyIds, missionIds } = await findParents(
      { taskType: 'TUTORIAL', taskLegacyId: 5101, tutorialId: T1 }, cds.db);
    expect(groupLegacyIds).toContain(5200);
    expect(missionIds).toContain(M);
  });
});

describe('rollUpParentsForCompletion', () => {
  const U = 'uuuuuuuu-0000-0000-0000-000000000001';
  const G = 'gg111111-0000-0000-0000-000000000001';
  const M = 'mm111111-0000-0000-0000-000000000001';
  const P = 'pp111111-0000-0000-0000-000000000001';
  const T1 = 'tt111111-0000-0000-0000-000000000001';
  const T2 = 'tt111111-0000-0000-0000-000000000002';

  beforeAll(async () => {
    const e = cds.entities('com.sap.developers.ims');
    await INSERT.into(e.Users).entries({ ID: U, sapId: 'P000123', legacyId: 9001 });
    await INSERT.into(e.Tutorials).entries([
      { ID: T1, slug: 'r3-t1', title: 'T1', legacyId: 6101, status: 'ACTIVE' },
      { ID: T2, slug: 'r3-t2', title: 'T2', legacyId: 6102, status: 'ACTIVE' },
    ]);
    await INSERT.into(e.Groups).entries({ ID: G, slug: 'r3-g', title: 'G', legacyId: 6200, status: 'ACTIVE' });
    await INSERT.into(e.GroupPathItems).entries([
      { group_ID: G, tutorial_ID: T1, itemOrder: 1, legacyId: 6301 },
      { group_ID: G, tutorial_ID: T2, itemOrder: 2, legacyId: 6302 },
    ]);
    await INSERT.into(e.Missions).entries({ ID: M, slug: 'r3-m', title: 'M', legacyId: 6400, status: 'ACTIVE' });
    await INSERT.into(e.CompletionPaths).entries({ ID: P, mission_ID: M, name: 'P', legacyId: 6500 });
    await INSERT.into(e.CompletionPathItems).entries({ path_ID: P, taskType: 'GROUP', group_ID: G, taskLegacyId: 6200, itemOrder: 1, legacyId: 6601 });
  });

  async function completeTut(legacyId) {
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TaskRecords).entries({
      user_ID: U, taskLegacyId: legacyId, taskType: 'TUTORIAL', status: 'COMPLETED',
      progress: 100, completionDate: new Date().toISOString(), legacyId: 70000 + legacyId,
    });
  }

  it('partial tutorial completion writes IN_PROGRESS group + mission', async () => {
    await completeTut(6101);
    await rollUpParentsForCompletion({ dbUser: { ID: U }, task: { taskType: 'TUTORIAL', taskLegacyId: 6101, tutorialId: T1 }, db: cds.db, send: false });
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grp = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6200, taskType: 'GROUP' });
    const mis = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6400, taskType: 'MISSION' });
    expect(grp.status).toBe('IN_PROGRESS');
    expect(grp.progress).toBe(50);
    expect(mis.status).toBe('IN_PROGRESS');
  });

  it('final tutorial completion flips group + mission to COMPLETED (idempotent)', async () => {
    await completeTut(6102);
    await rollUpParentsForCompletion({ dbUser: { ID: U }, task: { taskType: 'TUTORIAL', taskLegacyId: 6102, tutorialId: T2 }, db: cds.db, send: false });
    await rollUpParentsForCompletion({ dbUser: { ID: U }, task: { taskType: 'TUTORIAL', taskLegacyId: 6102, tutorialId: T2 }, db: cds.db, send: false });
    const { TaskRecords } = cds.entities('com.sap.developers.ims');
    const grpRows = await SELECT.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6200, taskType: 'GROUP', status: { '!=': 'SUPERSEDED' } });
    const mis = await SELECT.one.from(TaskRecords).where({ user_ID: U, taskLegacyId: 6400, taskType: 'MISSION' });
    expect(grpRows).toHaveLength(1);
    expect(grpRows[0].status).toBe('COMPLETED');
    expect(mis.status).toBe('COMPLETED');
  });
});
