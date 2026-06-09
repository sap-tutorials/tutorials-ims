import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { makeBranchLoaders } from '../srv/lib/branch/loaders.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const USER_ID  = 'aaaaaaaa-9100-0000-0000-000000000001';
const TUT_A_ID = 'aaaaaaaa-9100-0000-0000-000000000010';

describe('makeBranchLoaders', () => {
  beforeAll(async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Users).entries({ ID: USER_ID, uuid: 'xsuaa-9100', email: '__TEST__user@example.invalid' });
    await INSERT.into(Tutorials).entries({ ID: TUT_A_ID, legacyId: 99100, slug: '__test__-tut-a', title: '__TEST__ Tut A', status: 'ACTIVE' });
    await INSERT.into(TaskRecords).entries({
      user_ID: USER_ID, taskLegacyId: 99100, taskType: 'TUTORIAL', status: 'COMPLETED',
      modifiedAt: new Date().toISOString(), completionDate: new Date().toISOString()
    });
  });
  afterAll(async () => {
    const { Users, Tutorials, TaskRecords } = cds.entities('com.sap.developers.ims');
    await DELETE.from(TaskRecords).where({ user_ID: USER_ID });
    await DELETE.from(Tutorials).where({ ID: TUT_A_ID });
    await DELETE.from(Users).where({ ID: USER_ID });
  });

  it('loadCompletedSlugs returns slugs for an authenticated user', async () => {
    const loaders = makeBranchLoaders();
    const slugs = await loaders.loadCompletedSlugs({ id: 'xsuaa-9100' });
    expect(slugs).toContain('__test__-tut-a');
  });

  it('loadCompletedSlugs returns [] for anonymous user', async () => {
    const loaders = makeBranchLoaders();
    const slugs = await loaders.loadCompletedSlugs(null);
    expect(slugs).toEqual([]);
  });

  it('loadProfile returns null in v1 (UserMetaData is key/value, no fixed-vocab columns yet — see Reviewer addendum C)', async () => {
    const loaders = makeBranchLoaders();
    const profile = await loaders.loadProfile({ id: 'xsuaa-9100' });
    // PR 6 will populate the fixed-vocab fields. Until then, loadProfile reads
    // key/value rows; with no seeded keys in this fixture, it returns null.
    expect(profile).toBeNull();
  });
});
