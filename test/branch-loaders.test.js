import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { makeBranchLoaders } from '../srv/lib/branch/loaders.js';
import { __resetForTest as resetCentroidCache } from '../srv/lib/tutorial-centroid.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const USER_ID  = 'aaaaaaaa-9100-0000-0000-000000000001';
const TUT_A_ID = 'aaaaaaaa-9100-0000-0000-000000000010';
const TUT_B_ID = 'aaaaaaaa-9100-0000-0000-000000000011';

function vec(values) {
  // CDS Vector(N) on SQLite stores the raw bytes; matches how the embedding
  // pipeline writes them (Float32Array → Buffer).
  const f = new Float32Array(values);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

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

  it('loadProfile returns null when user has no UserLearningPreferences row (PR 6 typed read)', async () => {
    const loaders = makeBranchLoaders();
    const profile = await loaders.loadProfile({ id: 'xsuaa-9100' });
    // PR 6 replaced the PR 1 placeholder (UserMetaData key/value flatten) with a
    // typed SELECT against UserLearningPreferences. With no row seeded for this
    // user the typed read returns null; positive-shape coverage lives in
    // test/unit/branch/loaders.test.js.
    expect(profile).toBeNull();
  });

  describe('loadUserCentroid (bulk path, issue #294)', () => {
    beforeAll(async () => {
      const { Tutorials, TutorialEmbedding } = cds.entities('com.sap.developers.ims');
      await INSERT.into(Tutorials).entries({
        ID: TUT_B_ID, legacyId: 99101, slug: '__test__-tut-b', title: '__TEST__ Tut B', status: 'ACTIVE'
      });
      // Two completed tutorials × two embedding rows each.
      await INSERT.into(TutorialEmbedding).entries(
        { tutorial_ID: TUT_A_ID, stepNumber: 1, embedding: vec([1, 0, 0]) },
        { tutorial_ID: TUT_A_ID, stepNumber: 2, embedding: vec([0, 1, 0]) },
        { tutorial_ID: TUT_B_ID, stepNumber: 1, embedding: vec([0, 0, 1]) },
        { tutorial_ID: TUT_B_ID, stepNumber: 2, embedding: vec([1, 1, 1]) },
      );
    });
    afterAll(async () => {
      const { Tutorials, TutorialEmbedding } = cds.entities('com.sap.developers.ims');
      await DELETE.from(TutorialEmbedding).where({ tutorial_ID: { in: [TUT_A_ID, TUT_B_ID] } });
      await DELETE.from(Tutorials).where({ ID: TUT_B_ID });
      // Drop any centroids the previous tests may have warmed.
      resetCentroidCache();
    });

    it('returns a Float32Array averaging the per-tutorial centroids', async () => {
      resetCentroidCache();
      const loaders = makeBranchLoaders();
      const v = await loaders.loadUserCentroid({
        completedSlugs: ['__test__-tut-a', '__test__-tut-b']
      });
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(3);
      // Tut A centroid = avg([1,0,0],[0,1,0]) = [0.5, 0.5, 0]
      // Tut B centroid = avg([0,0,1],[1,1,1]) = [0.5, 0.5, 1]
      // User centroid  = avg(A,B)             = [0.5, 0.5, 0.5]
      expect(v[0]).toBeCloseTo(0.5, 5);
      expect(v[1]).toBeCloseTo(0.5, 5);
      expect(v[2]).toBeCloseTo(0.5, 5);
    });

    it('returns null when there are no completed slugs', async () => {
      const loaders = makeBranchLoaders();
      expect(await loaders.loadUserCentroid({ completedSlugs: [] })).toBeNull();
      expect(await loaders.loadUserCentroid({})).toBeNull();
      expect(await loaders.loadUserCentroid(null)).toBeNull();
    });

    it('returns null when no completed slug resolves to a known tutorial', async () => {
      resetCentroidCache();
      const loaders = makeBranchLoaders();
      const v = await loaders.loadUserCentroid({
        completedSlugs: ['__test__-does-not-exist-1', '__test__-does-not-exist-2']
      });
      expect(v).toBeNull();
    });

    it('caps slug input at 50 (defensive bound, issue #294 spec §5.6)', async () => {
      resetCentroidCache();
      const loaders = makeBranchLoaders();
      // 51 slugs: only the first 50 are considered. We don't have 50 fixtures,
      // but the cap is upstream of the DB call so the assertion is on
      // "doesn't throw and returns a finite centroid from whatever resolves."
      const slugs = Array.from({ length: 51 }, (_, i) => `__test__-missing-${i}`);
      slugs[0] = '__test__-tut-a';
      const v = await loaders.loadUserCentroid({ completedSlugs: slugs });
      expect(v).toBeInstanceOf(Float32Array);
      expect(v.length).toBe(3);
    });
  });
});
