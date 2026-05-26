import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID       = 'aaaaaaaa-9001-0000-0000-000000000001';
const STANDALONE_GROUP_ID = 'cccccccc-9001-0000-0000-000000000001';
const STANDALONE_TUT1_ID  = 'cccccccc-9001-0000-0000-000000000011';
const STANDALONE_TUT2_ID  = 'cccccccc-9001-0000-0000-000000000012';
const STANDALONE_GPI1_ID  = 'cccccccc-9001-0000-0000-000000000021';
const STANDALONE_GPI2_ID  = 'cccccccc-9001-0000-0000-000000000022';

describe('/build/navigator: standalone Group surfacing', () => {
  beforeAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 99001, name: '__TEST__ Standalone Tag' });

    await INSERT.into(Tutorials).entries([
      { ID: STANDALONE_TUT1_ID, legacyId: 99011, title: '__TEST__ Standalone Tut 1', slug: 'test-standalone-tut-1', status: 'ACTIVE' },
      { ID: STANDALONE_TUT2_ID, legacyId: 99012, title: '__TEST__ Standalone Tut 2', slug: 'test-standalone-tut-2', status: 'ACTIVE' },
    ]);

    await INSERT.into(Groups).entries({
      ID: STANDALONE_GROUP_ID, legacyId: 99001,
      title: '__TEST__ Standalone Group', description: 'desc',
      experienceTag: 'beginner', primaryTagRef_ID: TAG_ID,
      published: true, status: 'ACTIVE',
    });

    await INSERT.into(GroupPathItems).entries([
      { ID: STANDALONE_GPI1_ID, legacyId: 99021, group_ID: STANDALONE_GROUP_ID, tutorial_ID: STANDALONE_TUT1_ID, itemOrder: 0 },
      { ID: STANDALONE_GPI2_ID, legacyId: 99022, group_ID: STANDALONE_GROUP_ID, tutorial_ID: STANDALONE_TUT2_ID, itemOrder: 1 },
    ]);
  });

  afterAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: { in: [STANDALONE_GPI1_ID, STANDALONE_GPI2_ID] } });
    await DELETE.from(Groups).where({ ID: STANDALONE_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [STANDALONE_TUT1_ID, STANDALONE_TUT2_ID] } });
    await DELETE.from(Tags).where({ ID: TAG_ID });
  });

  it('returns the standalone Group in groups[] without a missionId', async () => {
    const { status, data } = await project.get('/build/navigator?nocache=1');
    expect(status).toBe(200);

    const ours = data.groups.find(g => g.id === 99001);
    expect(ours).toBeDefined();
    expect(ours.title).toBe('__TEST__ Standalone Group');
    expect(ours.missionId).toBeFalsy();
  });

  it('emits tutorialMappings for standalone Group tutorials with groupId but no missionId', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const tut1 = data.tutorialMappings.find(t => t.slug === 'test-standalone-tut-1');
    expect(tut1).toBeDefined();
    expect(tut1.groupId).toBe(99001);
    expect(tut1.groupTitle).toBe('__TEST__ Standalone Group');
    expect(tut1.missionId).toBeFalsy();
  });

  it('preserves itemOrder for prev/next chaining within the standalone Group', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const tut1 = data.tutorialMappings.find(t => t.slug === 'test-standalone-tut-1');
    const tut2 = data.tutorialMappings.find(t => t.slug === 'test-standalone-tut-2');
    expect(tut1.next).toBe('test-standalone-tut-2');
    expect(tut2.prev).toBe('test-standalone-tut-1');
  });
});
