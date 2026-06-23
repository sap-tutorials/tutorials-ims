import cds from '@sap/cds';
const project = cds.test('serve', '--project', '.', '--in-memory');

describe('loadProfile (PR 6 typed read)', () => {
  it('returns {deployment, role, cloud} shape from UserLearningPreferences', async () => {
    // Use the existing in-memory CDS test serve; create a Users row + a
    // matching UserLearningPreferences row; assert loadProfile returns the
    // typed shape.
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const userUuid = '__test__-pr6-load-1';
    await INSERT.into(Users).entries({
      uuid: userUuid, sapId: userUuid, legacyId: 990001, email: '', firstName: '', lastName: '',
    });
    const dbUserId = (await SELECT.one.from(Users).where({ uuid: userUuid })).ID;
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: dbUserId, deployment: 'cloud', role: 'developer', cloud: 'btp',
    });
    const { makeBranchLoaders } = await import('../../../srv/lib/branch/loaders.js');
    const loaders = makeBranchLoaders();
    const profile = await loaders.loadProfile({ id: userUuid });
    expect(profile).toEqual({ deployment: 'cloud', role: 'developer', cloud: 'btp' });
  });

  it('returns null when user has no UserLearningPreferences row', async () => {
    const { makeBranchLoaders } = await import('../../../srv/lib/branch/loaders.js');
    const loaders = makeBranchLoaders();
    const profile = await loaders.loadProfile({ id: '__test__-pr6-load-noexist' });
    expect(profile).toBeNull();
  });
});
