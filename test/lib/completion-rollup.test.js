import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import {
  collapseSlots, evaluateSlots, tokenFor,
  loadGroupSlots, loadMissionSlots, findParents,
} from '../../srv/lib/completion-rollup.js';

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
  cds.test('serve', '--project', '.', '--in-memory');
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
