import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const MISSION_ID    = 'aaaaaaaa-9400-0000-0000-000000000001';
const PATH_ID       = 'bbbbbbbb-9400-0000-0000-000000000001';
const TUT_HANA_ID   = 'cccccccc-9400-0000-0000-000000000020';
const TUT_PG_ID     = 'cccccccc-9400-0000-0000-000000000030';

describe('/build/catalog includes altGroups on path-level groups', () => {
  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: TUT_HANA_ID, legacyId: 99420, slug: '__test__-altcat-hana', title: '__TEST__ HANA', status: 'ACTIVE' },
      { ID: TUT_PG_ID,   legacyId: 99430, slug: '__test__-altcat-pg',   title: '__TEST__ PG',   status: 'ACTIVE' },
    ]);
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99400, title: '__TEST__ AltCat Mission', slug: '__test__-altcat-mission', published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 99401, mission_ID: MISSION_ID, name: 'AltCat Path', slug: '__test__-altcat-path',
    });
    await INSERT.into(CompletionPathItems).entries([
      { ID: 'dddddddd-9400-0000-0000-000000000020', legacyId: 99420, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99420, tutorial_ID: TUT_HANA_ID, itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud' },
      { ID: 'dddddddd-9400-0000-0000-000000000030', legacyId: 99430, path_ID: PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99430, tutorial_ID: TUT_PG_ID,   itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
    ]);
  });
  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_HANA_ID, TUT_PG_ID] } });
  });

  it('exposes altGroups on the path-level group with both branches', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    const hierarchy = data.hierarchies.find(h => h.missionImsId === 99400);
    expect(hierarchy).toBeDefined();

    // Fixture path name "AltCat Path" !== mission title "__TEST__ AltCat Mission",
    // so isFlat is false → altGroups live under hierarchy.groups[*].altGroups.
    expect(hierarchy.groups.length).toBeGreaterThan(0); // non-flat sanity
    const pathGroup = hierarchy.groups.find(g => g.altGroups?.length);
    expect(pathGroup).toBeDefined();
    expect(pathGroup.altGroups).toHaveLength(1);
    expect(pathGroup.altGroups[0].groupKey).toBe('deployment');
    expect(pathGroup.altGroups[0].branches.map(b => b.key).sort()).toEqual(['hana-cloud', 'postgresql']);
  });
});

const FLAT_MISSION_ID  = 'aaaaaaaa-9401-0000-0000-000000000001';
const FLAT_PATH_ID     = 'bbbbbbbb-9401-0000-0000-000000000001';
const FLAT_TUT_A_ID    = 'cccccccc-9401-0000-0000-000000000010';
const FLAT_TUT_B_ID    = 'cccccccc-9401-0000-0000-000000000020';

describe('/build/catalog lifts altGroups to hierarchy when isFlat=true', () => {
  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: FLAT_TUT_A_ID, legacyId: 99410, slug: '__test__-altcat-flat-a', title: '__TEST__ A', status: 'ACTIVE' },
      { ID: FLAT_TUT_B_ID, legacyId: 99411, slug: '__test__-altcat-flat-b', title: '__TEST__ B', status: 'ACTIVE' },
    ]);
    // Mission title MUST equal Path name for isFlat=true (per build-catalog.js:106).
    const sharedTitle = '__TEST__ Flat AltCat';
    await INSERT.into(Missions).entries({
      ID: FLAT_MISSION_ID, legacyId: 99410, title: sharedTitle, slug: '__test__-flat-altcat-mission', published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: FLAT_PATH_ID, legacyId: 99411, mission_ID: FLAT_MISSION_ID, name: sharedTitle, slug: '__test__-flat-altcat-path',
    });
    await INSERT.into(CompletionPathItems).entries([
      { ID: 'dddddddd-9401-0000-0000-000000000010', legacyId: 99410, path_ID: FLAT_PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99410, tutorial_ID: FLAT_TUT_A_ID, itemOrder: 1, altGroupKey: 'flavor', altGroupLabel: 'Vanilla' },
      { ID: 'dddddddd-9401-0000-0000-000000000020', legacyId: 99411, path_ID: FLAT_PATH_ID, taskType: 'TUTORIAL', taskLegacyId: 99411, tutorial_ID: FLAT_TUT_B_ID, itemOrder: 1, altGroupKey: 'flavor', altGroupLabel: 'Chocolate' },
    ]);
  });
  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: FLAT_PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: FLAT_PATH_ID });
    await DELETE.from(Missions).where({ ID: FLAT_MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [FLAT_TUT_A_ID, FLAT_TUT_B_ID] } });
  });

  it('exposes altGroups at hierarchy level (not under groups[]) for flat missions', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    const hierarchy = data.hierarchies.find(h => h.missionImsId === 99410);
    expect(hierarchy).toBeDefined();
    expect(hierarchy.groups).toEqual([]); // isFlat → groups stripped
    expect(hierarchy.altGroups).toBeDefined();
    expect(hierarchy.altGroups).toHaveLength(1);
    expect(hierarchy.altGroups[0].groupKey).toBe('flavor');
    expect(hierarchy.altGroups[0].branches.map(b => b.key).sort()).toEqual(['chocolate', 'vanilla']);
  });
});

// Issue #295 — nested Group inside a mission (taskType: 'GROUP') must surface
// its own GroupPathItems alt-groups, not just CompletionPathItems alt-groups.
const NESTED_MISSION_ID = 'aaaaaaaa-9402-0000-0000-000000000001';
const NESTED_PATH_ID    = 'bbbbbbbb-9402-0000-0000-000000000001';
const NESTED_GROUP_ID   = 'eeeeeeee-9402-0000-0000-000000000001';
const NESTED_TUT_A_ID   = 'cccccccc-9402-0000-0000-000000000010';
const NESTED_TUT_B_ID   = 'cccccccc-9402-0000-0000-000000000020';

describe('/build/catalog — issue #295: nested Group inside mission surfaces altGroups', () => {
  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Groups, GroupPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: NESTED_TUT_A_ID, legacyId: 99502, slug: '__test__-nested-altcat-a', title: '__TEST__ A', status: 'ACTIVE' },
      { ID: NESTED_TUT_B_ID, legacyId: 99503, slug: '__test__-nested-altcat-b', title: '__TEST__ B', status: 'ACTIVE' },
    ]);
    await INSERT.into(Missions).entries({
      ID: NESTED_MISSION_ID, legacyId: 99500, title: '__TEST__ Nested AltCat Mission', slug: '__test__-nested-altcat-mission', published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: NESTED_PATH_ID, legacyId: 99501, mission_ID: NESTED_MISSION_ID, name: 'Nested AltCat Path', slug: '__test__-nested-altcat-path',
    });
    await INSERT.into(Groups).entries({
      ID: NESTED_GROUP_ID, legacyId: 99504, slug: '__test__-nested-altcat-group', title: '__TEST__ Nested Group', published: true, status: 'ACTIVE',
    });
    // Path holds a taskType:'GROUP' item pointing at the Group.
    await INSERT.into(CompletionPathItems).entries({
      ID: 'dddddddd-9402-0000-0000-000000000001', legacyId: 99505, path_ID: NESTED_PATH_ID,
      taskType: 'GROUP', taskLegacyId: 99504, group_ID: NESTED_GROUP_ID, itemOrder: 1,
    });
    // GroupPathItems with two branches sharing (itemOrder=1, altGroupKey='deployment').
    await INSERT.into(GroupPathItems).entries([
      { ID: 'ffffffff-9402-0000-0000-000000000010', legacyId: 99506, group_ID: NESTED_GROUP_ID, tutorial_ID: NESTED_TUT_A_ID, itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud' },
      { ID: 'ffffffff-9402-0000-0000-000000000020', legacyId: 99507, group_ID: NESTED_GROUP_ID, tutorial_ID: NESTED_TUT_B_ID, itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
    ]);
  });
  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Groups, GroupPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ group_ID: NESTED_GROUP_ID });
    await DELETE.from(CompletionPathItems).where({ path_ID: NESTED_PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: NESTED_PATH_ID });
    await DELETE.from(Missions).where({ ID: NESTED_MISSION_ID });
    await DELETE.from(Groups).where({ ID: NESTED_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [NESTED_TUT_A_ID, NESTED_TUT_B_ID] } });
  });

  it('exposes altGroups on the nested-group entry inside hierarchies[].groups[]', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    const hierarchy = data.hierarchies.find(h => h.missionImsId === 99500);
    expect(hierarchy).toBeDefined();
    // Mission has 1 path + 1 nested group → 2 entries → not isFlat.
    expect(hierarchy.groups.length).toBe(2);

    const nestedGroup = hierarchy.groups.find(g => g.imsId === 99504);
    expect(nestedGroup).toBeDefined();
    expect(nestedGroup.altGroups).toBeDefined();
    expect(nestedGroup.altGroups).toHaveLength(1);
    expect(nestedGroup.altGroups[0].groupKey).toBe('deployment');
    expect(nestedGroup.altGroups[0].branches.map(b => b.key).sort()).toEqual(['hana-cloud', 'postgresql']);
    expect(nestedGroup.altGroups[0].branches.map(b => b.tutorialSlug).sort()).toEqual([
      '__test__-nested-altcat-a', '__test__-nested-altcat-b',
    ]);
  });
});

// Issue #295 — standalone Group (not nested in any mission) must also surface
// its GroupPathItems alt-groups under standaloneGroups[].
const STANDALONE_GROUP_ID = 'eeeeeeee-9403-0000-0000-000000000001';
const STANDALONE_TUT_A_ID = 'cccccccc-9403-0000-0000-000000000010';
const STANDALONE_TUT_B_ID = 'cccccccc-9403-0000-0000-000000000020';

describe('/build/catalog — issue #295: standalone Group surfaces altGroups', () => {
  beforeAll(async () => {
    const { Groups, GroupPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tutorials).entries([
      { ID: STANDALONE_TUT_A_ID, legacyId: 99602, slug: '__test__-standalone-altcat-a', title: '__TEST__ A', status: 'ACTIVE' },
      { ID: STANDALONE_TUT_B_ID, legacyId: 99603, slug: '__test__-standalone-altcat-b', title: '__TEST__ B', status: 'ACTIVE' },
    ]);
    await INSERT.into(Groups).entries({
      ID: STANDALONE_GROUP_ID, legacyId: 99600, slug: '__test__-standalone-altcat-group', title: '__TEST__ Standalone Group', published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries([
      { ID: 'ffffffff-9403-0000-0000-000000000010', legacyId: 99604, group_ID: STANDALONE_GROUP_ID, tutorial_ID: STANDALONE_TUT_A_ID, itemOrder: 1, altGroupKey: 'flavor', altGroupLabel: 'Vanilla' },
      { ID: 'ffffffff-9403-0000-0000-000000000020', legacyId: 99605, group_ID: STANDALONE_GROUP_ID, tutorial_ID: STANDALONE_TUT_B_ID, itemOrder: 1, altGroupKey: 'flavor', altGroupLabel: 'Chocolate' },
    ]);
  });
  afterAll(async () => {
    const { Groups, GroupPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ group_ID: STANDALONE_GROUP_ID });
    await DELETE.from(Groups).where({ ID: STANDALONE_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [STANDALONE_TUT_A_ID, STANDALONE_TUT_B_ID] } });
  });

  it('exposes altGroups on the standalone group entry under standaloneGroups[]', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    const sg = data.standaloneGroups.find(g => g.imsId === 99600);
    expect(sg).toBeDefined();
    expect(sg.altGroups).toBeDefined();
    expect(sg.altGroups).toHaveLength(1);
    expect(sg.altGroups[0].groupKey).toBe('flavor');
    expect(sg.altGroups[0].branches.map(b => b.key).sort()).toEqual(['chocolate', 'vanilla']);
  });
});
