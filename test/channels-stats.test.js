// test/channels-stats.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

const STATS_IDS = [
  'aaaaaaaa-9300-0000-0000-000000000001',
  'aaaaaaaa-9300-0000-0000-000000000002',
  'aaaaaaaa-9300-0000-0000-000000000003',
];

describe('GET /build/channels-stats', () => {
  beforeAll(async () => {
    const { Channels } = cds.entities(NS);
    await INSERT.into(Channels).entries([
      {
        ID: STATS_IDS[0], sourceId: 'stats-test-01', name: 'Alpha', url: 'https://alpha.example',
        status: 'Active', ownerType: 'SAP_Official', category: 'Documentation',
        subcategory: 'API Docs', isSapOwned: true, isPublished: true,
      },
      {
        ID: STATS_IDS[1], sourceId: 'stats-test-02', name: 'Beta', url: 'https://beta.example',
        status: 'Archived', ownerType: 'Community_Member', category: 'Community',
        subcategory: 'Forum', isSapOwned: false, isPublished: true,
      },
      {
        ID: STATS_IDS[2], sourceId: 'stats-test-03', name: 'Gamma', url: 'https://gamma.example',
        status: 'Active', ownerType: 'SAP_Developer_Advocate', category: 'Documentation',
        subcategory: null, isSapOwned: true, isPublished: false,
      },
    ]);
  });

  afterAll(async () => {
    const { Channels } = cds.entities(NS);
    await DELETE.from(Channels).where({ ID: { in: STATS_IDS } });
  });

  it('returns 200 with the ChannelsStats shape', async () => {
    const { status, data } = await project.get('/build/channels-stats');
    expect(status).toBe(200);
    expect(typeof data.total).toBe('number');
    expect(typeof data.publishedCount).toBe('number');
    expect(data.byStatus).toBeDefined();
    expect(data.byOwnerType).toBeDefined();
    expect(data.byCategory).toBeDefined();
    expect(data.bySubcategory).toBeDefined();
    expect(data.sapVsCommunity).toBeDefined();
    expect(data.sapVsCommunity).toHaveProperty('sap');
    expect(data.sapVsCommunity).toHaveProperty('community');
    expect(data.activeVsInactive).toBeDefined();
    expect(data.activeVsInactive).toHaveProperty('active');
    expect(data.activeVsInactive).toHaveProperty('inactive');
    expect(typeof data.buildAt).toBe('string');
  });

  it('counts reflect the seeded rows', async () => {
    const { data } = await project.get('/build/channels-stats');
    // At minimum our 3 seeded rows
    expect(data.total).toBeGreaterThanOrEqual(3);
    expect(data.publishedCount).toBeGreaterThanOrEqual(2); // STATS_IDS[0] + [1]
    // Active count includes STATS_IDS[0] + [2]
    expect(data.activeVsInactive.active).toBeGreaterThanOrEqual(2);
    // SAP count: STATS_IDS[0] + [2]
    expect(data.sapVsCommunity.sap).toBeGreaterThanOrEqual(2);
    expect(data.sapVsCommunity.community).toBeGreaterThanOrEqual(1);
    // Documentation category: STATS_IDS[0] + [2]
    expect(data.byCategory['Documentation']).toBeGreaterThanOrEqual(2);
  });

  it('payload does NOT reference linkStatus, lastChecked, or updateFrequency', async () => {
    const { data } = await project.get('/build/channels-stats');
    const bodyStr = JSON.stringify(data);
    expect(bodyStr).not.toMatch(/linkStatus/);
    expect(bodyStr).not.toMatch(/lastChecked/);
    expect(bodyStr).not.toMatch(/updateFrequency/);
  });
});
