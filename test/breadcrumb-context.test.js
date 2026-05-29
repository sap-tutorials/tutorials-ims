import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID = 'aaaaaaaa-bc00-0000-0000-000000000001';
const TUT_ID = 'cccccccc-bc00-0000-0000-000000000001';
const GROUP_ID = 'bbbbbbbb-bc00-0000-0000-000000000001';
const MISSION_ID = 'dddddddd-bc00-0000-0000-000000000001';
const PATH_ID = 'eeeeeeee-bc00-0000-0000-000000000001';

describe('GET /build/breadcrumb-context', () => {
  beforeAll(async () => {
    const { Tags, Tutorials, Groups, GroupPathItems, Missions,
            CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 99401, name: '__TEST__ bc tag' });
    await INSERT.into(Tutorials).entries({
      ID: TUT_ID, slug: '__test__-bc-tut', title: '__TEST__ Tut',
      experienceTag: 'beginner', primaryTagRef_ID: TAG_ID, status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: GROUP_ID, legacyId: 99411, slug: '__test__-bc-group',
      title: '__TEST__ Group', published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      group_ID: GROUP_ID, tutorial_ID: TUT_ID, itemOrder: 1,
    });
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99421, slug: '__test__-bc-mission',
      title: '__TEST__ Mission', published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, mission_ID: MISSION_ID, name: 'p', legacyId: 99431,
    });
    await INSERT.into(CompletionPathItems).entries({
      path_ID: PATH_ID, group_ID: GROUP_ID, taskType: 'GROUP', itemOrder: 1,
    });
  });

  it('returns parent group + mission for a known tutorial', async () => {
    const { data, status } = await project.get('/build/breadcrumb-context?tutorial=__test__-bc-tut');
    expect(status).toBe(200);
    expect(data.groupSlug).toBe('__test__-bc-group');
    expect(data.groupTitle).toBe('__TEST__ Group');
    expect(data.missionSlug).toBe('__test__-bc-mission');
    expect(data.missionTitle).toBe('__TEST__ Mission');
  });

  it('returns 404 for unknown tutorial', async () => {
    const res = await project.get('/build/breadcrumb-context?tutorial=does-not-exist').catch(e => e.response);
    expect(res.status).toBe(404);
  });

  it('returns 400 for missing parameter', async () => {
    const res = await project.get('/build/breadcrumb-context').catch(e => e.response);
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid slug shape (path traversal)', async () => {
    const res = await project.get('/build/breadcrumb-context?tutorial=../etc/passwd').catch(e => e.response);
    expect(res.status).toBe(400);
  });
});
