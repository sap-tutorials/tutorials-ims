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
