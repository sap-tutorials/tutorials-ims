import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const HYB_TAG_ID    = 'aaaaaaaa-9999-0000-0000-000000000001';
const HYB_GROUP_ID  = 'cccccccc-9999-0000-0000-000000000001';
const HYB_TUT_ID    = 'cccccccc-9999-0000-0000-000000000011';
const HYB_GPI_ID    = 'cccccccc-9999-0000-0000-000000000021';

describe.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')('navigator: standalone Group surfaces on HANA', () => {
  beforeAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    // Pre-clean: protect against legacyId collisions from prior aborted runs.
    // __TEST__ prefix protects names but not legacyIds; HANA sequence-backed IDs
    // would not collide, but legacyId 99099 is hand-picked here and must be free.
    await DELETE.from(GroupPathItems).where({ legacyId: { in: [99097] } });
    await DELETE.from(Groups).where({ or: [{ legacyId: 99099 }, { title: { like: '__TEST__ Hybrid%' } }] });
    await DELETE.from(Tutorials).where({ or: [{ legacyId: 99098 }, { slug: 'test-hybrid-tut' }] });
    await DELETE.from(Tags).where({ legacyId: 99099 });

    await INSERT.into(Tags).entries({ ID: HYB_TAG_ID, legacyId: 99099, name: '__TEST__ Hybrid Tag' });
    await INSERT.into(Tutorials).entries({
      ID: HYB_TUT_ID, legacyId: 99098, title: '__TEST__ Hybrid Tut',
      slug: 'test-hybrid-tut', status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: HYB_GROUP_ID, legacyId: 99099, title: '__TEST__ Hybrid Group',
      experienceTag: 'beginner', primaryTagRef_ID: HYB_TAG_ID,
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      ID: HYB_GPI_ID, legacyId: 99097,
      group_ID: HYB_GROUP_ID, tutorial_ID: HYB_TUT_ID, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Groups, Tutorials, GroupPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: HYB_GPI_ID });
    await DELETE.from(Groups).where({ ID: HYB_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: HYB_TUT_ID });
    await DELETE.from(Tags).where({ ID: HYB_TAG_ID });
  });

  it('returns the test Group on /build/navigator (HANA)', async () => {
    const res = await fetch('http://localhost:4004/build/navigator?nocache=1');
    expect(res.status).toBe(200);
    const data = await res.json();
    const ours = data.groups.find(g => g.id === 99099);
    expect(ours).toBeDefined();
    const tut = data.tutorialMappings.find(t => t.slug === 'test-hybrid-tut');
    expect(tut).toBeDefined();
    expect(tut.groupId).toBe(99099);
  });
});
