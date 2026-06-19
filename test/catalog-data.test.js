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

// #382 phase F1 — Mission renderer support for direct-TUTORIAL CompletionPathItems.
// Some missions point at tutorials directly via CompletionPathItems(taskType='TUTORIAL'),
// without an intermediate Group wrapper. Mirrors the pattern in
// srv/lib/build-catalog.js:91-117 — synthesize a path-as-group from direct
// TUTORIAL items so they render alongside any taskType=GROUP items.
describe('catalog-data — mission with direct-TUTORIAL CompletionPathItems', () => {
  const NS = 'com.sap.developers.ims';
  // Disjoint IDs from the main fixture so afterAll-style isolation between
  // describes isn't needed.
  const TAG_ID    = 'aaaaaaaa-cd99-0000-0000-000000000001';
  const TUT_DA_ID = 'cccccccc-cd99-0000-0000-000000000001';
  const TUT_DB_ID = 'cccccccc-cd99-0000-0000-000000000002';
  const TUT_DC_ID = 'cccccccc-cd99-0000-0000-000000000003';
  const GROUP_ID  = 'gggggggg-cd99-0000-0000-000000000001';
  const TUT_NESTED_ID = 'cccccccc-cd99-0000-0000-000000000004';
  // Mission with ONLY direct TUTORIAL items.
  const MISSION_DIRECT_ID = 'mmmmmmmm-cd99-0000-0000-000000000001';
  const PATH_DIRECT_ID    = 'eeeeeeee-cd99-0000-0000-000000000001';
  // Mission with MIXED direct TUTORIAL + nested GROUP items.
  const MISSION_MIXED_ID  = 'mmmmmmmm-cd99-0000-0000-000000000002';
  const PATH_MIXED_ID     = 'eeeeeeee-cd99-0000-0000-000000000002';

  beforeAll(async () => {
    const { Tags, Tutorials, Groups, GroupPathItems, Missions,
            CompletionPaths, CompletionPathItems } = cds.entities(NS);
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 99099, name: '__TEST__ tag F1' });
    await INSERT.into(Tutorials).entries([
      { ID: TUT_DA_ID, slug: '__test__-cd-direct-a', title: '__TEST__ Direct A',
        description: 'da', experienceTag: 'beginner', averageTimeToComplete: 7,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 2 },
      { ID: TUT_DB_ID, slug: '__test__-cd-direct-b', title: '__TEST__ Direct B',
        description: 'db', experienceTag: 'intermediate', averageTimeToComplete: 11,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 3 },
      { ID: TUT_DC_ID, slug: '__test__-cd-direct-c', title: '__TEST__ Direct C',
        description: 'dc', experienceTag: 'advanced', averageTimeToComplete: 22,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 5 },
      { ID: TUT_NESTED_ID, slug: '__test__-cd-nested', title: '__TEST__ Nested',
        description: 'nest', experienceTag: 'beginner', averageTimeToComplete: 8,
        primaryTagRef_ID: TAG_ID, status: 'ACTIVE', stepCount: 2 },
    ]);
    // Group with a single tutorial — used by the MIXED mission.
    await INSERT.into(Groups).entries({
      ID: GROUP_ID, legacyId: 99110, slug: '__test__-cd-nested-group',
      title: '__TEST__ Nested Group', description: 'ng',
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      group_ID: GROUP_ID, tutorial_ID: TUT_NESTED_ID, itemOrder: 1,
    });

    // Mission #1: only direct TUTORIAL items. The path has a name + slug
    // so the synthetic group can use them.
    await INSERT.into(Missions).entries({
      ID: MISSION_DIRECT_ID, legacyId: 99210, slug: '__test__-cd-direct-mission',
      title: '__TEST__ Direct Mission', description: 'dm-desc',
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_DIRECT_ID, mission_ID: MISSION_DIRECT_ID,
      name: '__TEST__ Direct Path', slug: '__test__-cd-direct-path', legacyId: 99310,
    });
    await INSERT.into(CompletionPathItems).entries([
      { path_ID: PATH_DIRECT_ID, tutorial_ID: TUT_DA_ID, taskType: 'TUTORIAL', itemOrder: 1 },
      { path_ID: PATH_DIRECT_ID, tutorial_ID: TUT_DB_ID, taskType: 'TUTORIAL', itemOrder: 2 },
      { path_ID: PATH_DIRECT_ID, tutorial_ID: TUT_DC_ID, taskType: 'TUTORIAL', itemOrder: 3 },
    ]);

    // Mission #2: mix of direct TUTORIAL + nested GROUP. Synthetic-group
    // (from direct items) must render BEFORE the nested group, matching
    // build-catalog.js:117 ordering.
    await INSERT.into(Missions).entries({
      ID: MISSION_MIXED_ID, legacyId: 99211, slug: '__test__-cd-mixed-mission',
      title: '__TEST__ Mixed Mission', description: 'mm-desc',
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_MIXED_ID, mission_ID: MISSION_MIXED_ID,
      name: '__TEST__ Mixed Path', slug: '__test__-cd-mixed-path', legacyId: 99311,
    });
    await INSERT.into(CompletionPathItems).entries([
      { path_ID: PATH_MIXED_ID, tutorial_ID: TUT_DA_ID, taskType: 'TUTORIAL', itemOrder: 1 },
      { path_ID: PATH_MIXED_ID, group_ID: GROUP_ID,    taskType: 'GROUP',    itemOrder: 2 },
    ]);
  });

  it('synthesizes a path-as-group from direct TUTORIAL items', async () => {
    const ctx = await loadMissionContext('__test__-cd-direct-mission');
    expect(ctx).not.toBeNull();
    expect(ctx.groups).toHaveLength(1);
    const synth = ctx.groups[0];
    expect(synth.isSynthetic).toBe(true);
    expect(synth.title).toBe('__TEST__ Direct Path');
    expect(synth.slug).toBe('__test__-cd-direct-path');
    expect(synth.tutorials).toHaveLength(3);
    expect(synth.tutorials.map(t => t.slug)).toEqual([
      '__test__-cd-direct-a',
      '__test__-cd-direct-b',
      '__test__-cd-direct-c',
    ]);
  });

  it('aggregates totalTime + tutorialCount + level across direct TUTORIAL items', async () => {
    const ctx = await loadMissionContext('__test__-cd-direct-mission');
    expect(ctx.tutorialCount).toBe(3);
    expect(ctx.groupCount).toBe(1);  // 1 synthetic group
    expect(ctx.totalTime).toBe(40);  // 7 + 11 + 22
    expect(ctx.level).toBe('advanced');  // max severity wins
  });

  it('emits synthetic group BEFORE nested groups (mixed mission)', async () => {
    const ctx = await loadMissionContext('__test__-cd-mixed-mission');
    expect(ctx).not.toBeNull();
    expect(ctx.groups).toHaveLength(2);
    // Synthetic first, real group second — matches build-catalog.js:117
    expect(ctx.groups[0].isSynthetic).toBe(true);
    expect(ctx.groups[0].slug).toBe('__test__-cd-mixed-path');
    expect(ctx.groups[0].tutorials).toHaveLength(1);
    expect(ctx.groups[0].tutorials[0].slug).toBe('__test__-cd-direct-a');
    expect(ctx.groups[1].isSynthetic).toBeFalsy();
    expect(ctx.groups[1].slug).toBe('__test__-cd-nested-group');
    expect(ctx.groups[1].tutorials).toHaveLength(1);
    expect(ctx.groups[1].tutorials[0].slug).toBe('__test__-cd-nested');
  });

  it('regression: GROUP-only missions still render normally without isSynthetic flag', async () => {
    // The original fixture (__test__-cd-mission) has only a taskType=GROUP item.
    const ctx = await loadMissionContext('__test__-cd-mission');
    expect(ctx).not.toBeNull();
    expect(ctx.groups).toHaveLength(1);
    expect(ctx.groups[0].isSynthetic).toBeFalsy();
    expect(ctx.groups[0].slug).toBe('__test__-cd-group');
  });
});
