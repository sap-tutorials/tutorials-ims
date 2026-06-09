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
