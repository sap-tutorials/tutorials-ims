import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID     = 'aaaaaaaa-c001-0000-0000-000000000001';
const MISSION_ID = '11111111-c001-0000-0000-000000000001';
const PATH_ID    = '22222222-c001-0000-0000-000000000001';
const GROUP_ID   = 'cccccccc-c001-0000-0000-000000000001';
const TUT_ID     = 'cccccccc-c001-0000-0000-000000000011';
const GPI_ID     = 'cccccccc-c001-0000-0000-000000000021';
const CPI_ID     = 'cccccccc-c001-0000-0000-000000000031';

describe('/build/catalog: nested Group inside a Mission', () => {
  beforeAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 91001, name: '__TEST__ Nested Tag' });
    await INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: 91011, title: '__TEST__ Nested Tut', slug: 'test-bc-nested-tut', status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: GROUP_ID, legacyId: 91001, title: '__TEST__ BC Nested Group',
      description: 'desc', experienceTag: 'beginner', primaryTagRef_ID: TAG_ID,
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      ID: GPI_ID, legacyId: 91021, group_ID: GROUP_ID, tutorial_ID: TUT_ID, itemOrder: 0,
    });
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 91001, title: '__TEST__ BC Nested Mission',
      slug: 'test-bc-nested-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: TAG_ID, published: true,
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 91002, mission_ID: MISSION_ID,
      name: 'Path 1', slug: 'test-bc-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: CPI_ID, legacyId: 91031, path_ID: PATH_ID,
      taskType: 'GROUP', taskLegacyId: 91001, group_ID: GROUP_ID, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(GroupPathItems).where({ ID: GPI_ID });
    await DELETE.from(Groups).where({ ID: GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: TUT_ID });
    await DELETE.from(Tags).where({ ID: TAG_ID });
  });

  it('emits the nested Group as a HierarchyGroup on the mission with resolved tutorialSlugs', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);

    const hier = data.hierarchies.find(h => h.missionImsId === 91001);
    expect(hier).toBeDefined();
    const ourGroup = hier.groups.find(g => g.imsId === 91001);
    expect(ourGroup).toBeDefined();
    expect(ourGroup.title).toBe('__TEST__ BC Nested Group');
    expect(ourGroup.slug).toBe('91001');
    expect(ourGroup.tutorialSlugs).toEqual(['test-bc-nested-tut']);
  });
});

const FLAT_TAG_ID     = 'aaaaaaaa-c001-0000-0000-000000000101';
const FLAT_MISSION_ID = '11111111-c001-0000-0000-000000000101';
const FLAT_PATH_ID    = '22222222-c001-0000-0000-000000000101';
const FLAT_TUT_ID     = 'cccccccc-c001-0000-0000-000000000111';
const FLAT_CPI_ID     = 'cccccccc-c001-0000-0000-000000000131';

describe('/build/catalog: single-path mission with no nested groups (isFlat)', () => {
  beforeAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: FLAT_TAG_ID, legacyId: 91101, name: '__TEST__ Flat Tag' });
    await INSERT.into(Tutorials).entries({
      ID: FLAT_TUT_ID, legacyId: 91111, title: '__TEST__ Flat Tut', slug: 'test-bc-flat-tut', status: 'ACTIVE',
    });
    await INSERT.into(Missions).entries({
      ID: FLAT_MISSION_ID, legacyId: 91101, title: '__TEST__ BC Flat Mission',
      slug: 'test-bc-flat-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: FLAT_TAG_ID, published: true,
    });
    // Path name === Mission title to trigger the isFlat predicate
    await INSERT.into(CompletionPaths).entries({
      ID: FLAT_PATH_ID, legacyId: 91101, mission_ID: FLAT_MISSION_ID,
      name: '__TEST__ BC Flat Mission', slug: 'test-bc-flat-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: FLAT_CPI_ID, legacyId: 91131, path_ID: FLAT_PATH_ID,
      taskType: 'TUTORIAL', taskLegacyId: 91111, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: FLAT_CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: FLAT_PATH_ID });
    await DELETE.from(Missions).where({ ID: FLAT_MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: FLAT_TUT_ID });
    await DELETE.from(Tags).where({ ID: FLAT_TAG_ID });
  });

  it('emits groups: [] and tutorialSlugs: [<slug>] when single-path-no-nested-groups', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    const hier = data.hierarchies.find(h => h.missionImsId === 91101);
    expect(hier).toBeDefined();
    expect(hier.groups).toEqual([]);
    expect(hier.tutorialSlugs).toEqual(['test-bc-flat-tut']);
  });
});

describe('/build/catalog: standalone Group surfacing', () => {
  const SA_TAG_ID     = 'aaaaaaaa-c002-0000-0000-000000000001';
  const SA_GROUP_ID   = 'cccccccc-c002-0000-0000-000000000001';
  const SA_TUT1_ID    = 'cccccccc-c002-0000-0000-000000000011';
  const SA_TUT2_ID    = 'cccccccc-c002-0000-0000-000000000012';
  const SA_GPI1_ID    = 'cccccccc-c002-0000-0000-000000000021';
  const SA_GPI2_ID    = 'cccccccc-c002-0000-0000-000000000022';

  beforeAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: SA_TAG_ID, legacyId: 91002, name: '__TEST__ SA Tag' });
    await INSERT.into(Tutorials).entries([
      { ID: SA_TUT1_ID, legacyId: 91012, title: '__TEST__ SA Tut 1', slug: 'test-bc-sa-tut-1', status: 'ACTIVE' },
      { ID: SA_TUT2_ID, legacyId: 91013, title: '__TEST__ SA Tut 2', slug: 'test-bc-sa-tut-2', status: 'ACTIVE' },
    ]);
    await INSERT.into(Groups).entries({
      ID: SA_GROUP_ID, legacyId: 91002, title: '__TEST__ SA Group',
      description: 'sa-desc', experienceTag: 'beginner', primaryTagRef_ID: SA_TAG_ID,
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries([
      { ID: SA_GPI1_ID, legacyId: 91022, group_ID: SA_GROUP_ID, tutorial_ID: SA_TUT1_ID, itemOrder: 0 },
      { ID: SA_GPI2_ID, legacyId: 91023, group_ID: SA_GROUP_ID, tutorial_ID: SA_TUT2_ID, itemOrder: 1 },
    ]);
  });

  afterAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: { in: [SA_GPI1_ID, SA_GPI2_ID] } });
    await DELETE.from(Groups).where({ ID: SA_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [SA_TUT1_ID, SA_TUT2_ID] } });
    await DELETE.from(Tags).where({ ID: SA_TAG_ID });
  });

  it('emits standalone Groups in standaloneGroups[] with ordered tutorialSlugs', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    expect(Array.isArray(data.standaloneGroups)).toBe(true);

    const ours = data.standaloneGroups.find(g => g.imsId === 91002);
    expect(ours).toBeDefined();
    expect(ours.title).toBe('__TEST__ SA Group');
    expect(ours.slug).toBe('91002');
    expect(ours.description).toBe('sa-desc');
    expect(ours.tutorialSlugs).toEqual(['test-bc-sa-tut-1', 'test-bc-sa-tut-2']);
  });

  it('does NOT include nested Groups in standaloneGroups[] (disjointness invariant)', async () => {
    const { data } = await project.get('/build/catalog');
    // The nested Group from the prior describe block has legacyId 91001 — it must be excluded.
    const nested = data.standaloneGroups.find(g => g.imsId === 91001);
    expect(nested).toBeUndefined();
  });
});
