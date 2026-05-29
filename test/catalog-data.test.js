// test/catalog-data.test.js
//
// Verifies the pure DB access layer used by the server-side catalog renderer
// (issue #91). Uses cds.test in-memory SQLite per the admin-slug-history
// pattern; fixtures are __TEST__-prefixed per the hybrid-write convention.
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { loadGroupContext, loadMissionContext } from '../srv/lib/catalog-data.js';

cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID = 'aaaaaaaa-cd00-0000-0000-000000000001';
const GROUP_ID = 'bbbbbbbb-cd00-0000-0000-000000000001';
const MISSION_ID = 'dddddddd-cd00-0000-0000-000000000001';
const PATH_ID = 'eeeeeeee-cd00-0000-0000-000000000001';
const TUT1_ID = 'cccccccc-cd00-0000-0000-000000000001';
const TUT2_ID = 'cccccccc-cd00-0000-0000-000000000002';

describe('catalog-data', () => {
  beforeAll(async () => {
    const { Tags, Tutorials, Groups, GroupPathItems, Missions,
            CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 99001, name: '__TEST__ tag' });
    await INSERT.into(Tutorials).entries([
      { ID: TUT1_ID, slug: '__test__-cd-tut-1', title: '__TEST__ Tut 1',
        description: 'd1', experienceTag: 'beginner', averageTimeToComplete: 10,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 3 },
      { ID: TUT2_ID, slug: '__test__-cd-tut-2', title: '__TEST__ Tut 2',
        description: 'd2', experienceTag: 'advanced', averageTimeToComplete: 30,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 5 },
    ]);
    await INSERT.into(Groups).entries({
      ID: GROUP_ID, legacyId: 99101, slug: '__test__-cd-group',
      title: '__TEST__ Group', description: 'g-desc',
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries([
      { group_ID: GROUP_ID, tutorial_ID: TUT1_ID, itemOrder: 1 },
      { group_ID: GROUP_ID, tutorial_ID: TUT2_ID, itemOrder: 2 },
    ]);
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99201, slug: '__test__-cd-mission',
      title: '__TEST__ Mission', description: 'm-desc',
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, mission_ID: MISSION_ID, name: 'p1', legacyId: 99301,
    });
    await INSERT.into(CompletionPathItems).entries({
      path_ID: PATH_ID, group_ID: GROUP_ID, taskType: 'GROUP', itemOrder: 1,
    });
  });

  it('loadGroupContext returns null for missing slug', async () => {
    expect(await loadGroupContext('does-not-exist')).toBeNull();
  });

  it('loadGroupContext returns group + ordered tutorials with level/time/stepCount', async () => {
    const ctx = await loadGroupContext('__test__-cd-group');
    expect(ctx).not.toBeNull();
    expect(ctx.group.title).toBe('__TEST__ Group');
    expect(ctx.tutorials).toHaveLength(2);
    expect(ctx.tutorials[0].slug).toBe('__test__-cd-tut-1');
    expect(ctx.tutorials[0].level).toBe('beginner');
    expect(ctx.tutorials[0].time).toBe(10);
    expect(ctx.tutorials[0].stepCount).toBe(3);
    expect(ctx.tutorials[1].slug).toBe('__test__-cd-tut-2');
  });

  it('loadGroupContext returns null when published=false', async () => {
    const { Groups } = cds.entities('com.sap.developers.ims');
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ published: false });
    expect(await loadGroupContext('__test__-cd-group')).toBeNull();
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ published: true });
  });

  it('loadGroupContext returns null when status=INACTIVE', async () => {
    const { Groups } = cds.entities('com.sap.developers.ims');
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ status: 'INACTIVE' });
    expect(await loadGroupContext('__test__-cd-group')).toBeNull();
    await UPDATE(Groups).where({ ID: GROUP_ID }).set({ status: 'ACTIVE' });
  });

  it('loadMissionContext returns mission + nested groups with tutorials', async () => {
    const ctx = await loadMissionContext('__test__-cd-mission');
    expect(ctx).not.toBeNull();
    expect(ctx.mission.title).toBe('__TEST__ Mission');
    expect(ctx.groups).toHaveLength(1);
    expect(ctx.groups[0].slug).toBe('__test__-cd-group');
    expect(ctx.groups[0].tutorials).toHaveLength(2);
  });

  it('group context aggregates totalTime and tutorialCount', async () => {
    const ctx = await loadGroupContext('__test__-cd-group');
    expect(ctx.totalTime).toBe(40);   // 10 + 30
    expect(ctx.tutorialCount).toBe(2);
  });

  it('group context computes level as max severity (advanced > beginner)', async () => {
    const ctx = await loadGroupContext('__test__-cd-group');
    expect(ctx.level).toBe('advanced');
  });
});
