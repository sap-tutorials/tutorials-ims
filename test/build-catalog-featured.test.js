import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

const TAG_ID = 'aaaaaaaa-3333-0000-0000-000000000001';
const MISSION_ID = '11111111-3333-0000-0000-000000000001';
const FEATURED_ID = '33333333-3333-0000-0000-000000000001';

describe('/build/catalog featured field', () => {
  beforeAll(async () => {
    const { Tags, Missions, FeaturedTasks } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 93001, name: '__TEST__ Featured Tag' });
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 93001, title: '__TEST__ Featured Mission',
      slug: 'test-featured', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: TAG_ID, published: true,
    });
    await INSERT.into(FeaturedTasks).entries({
      ID: FEATURED_ID, legacyId: 93001,
      taskLegacyId: 93001, taskType: 'MISSION', featuredOrder: 1,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, FeaturedTasks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(FeaturedTasks).where({ ID: FEATURED_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tags).where({ ID: TAG_ID });
  });

  it('includes featured array with mission entries ordered by featuredOrder', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);
    expect(Array.isArray(data.featured)).toBe(true);

    const ours = data.featured.find(f => f.slug === 'test-featured');
    expect(ours).toBeDefined();
    expect(ours.type).toBe('mission');
    expect(ours.title).toBe('__TEST__ Featured Mission');
    expect(ours.description).toBe('desc');
  });

  it('caps the featured array at 6 entries', async () => {
    const { data } = await project.get('/build/catalog');
    expect(data.featured.length).toBeLessThanOrEqual(6);
  });
});
