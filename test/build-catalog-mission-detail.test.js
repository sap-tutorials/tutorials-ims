import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { __resetCacheForTest } from '../srv/lib/branch/mission-detail.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

const CHAT_SETTINGS_ID = '00000000-0000-0000-0000-00000000c8a7';

const MISSION_ID    = '11111111-9200-0000-0000-000000000001';
const PATH_ID       = '22222222-9200-0000-0000-000000000001';
const TUT_INTRO_ID  = '33333333-9200-0000-0000-000000000010';
const TUT_HANA_ID   = '33333333-9200-0000-0000-000000000020';
const TUT_PG_ID     = '33333333-9200-0000-0000-000000000030';
const TUT_VERIFY_ID = '33333333-9200-0000-0000-000000000040';

describe('/build/mission/:slug — alt-group grouping', () => {
  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 99200, title: '__TEST__ Mission', slug: '__test__-mission', published: true
    });
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 99201, mission_ID: MISSION_ID, name: 'Path 1', slug: '__test__-path-1'
    });
    await INSERT.into(Tutorials).entries([
      { ID: TUT_INTRO_ID,  legacyId: 99210, slug: '__test__-intro',  title: 'Intro',  status: 'ACTIVE' },
      { ID: TUT_HANA_ID,   legacyId: 99220, slug: '__test__-hana',   title: 'HANA',   status: 'ACTIVE' },
      { ID: TUT_PG_ID,     legacyId: 99230, slug: '__test__-pg',     title: 'PG',     status: 'ACTIVE' },
      { ID: TUT_VERIFY_ID, legacyId: 99240, slug: '__test__-verify', title: 'Verify', status: 'ACTIVE' },
    ]);
    await INSERT.into(CompletionPathItems).entries([
      { ID: '44444444-9200-0000-0000-000000000010', legacyId: 99250, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_INTRO_ID,  itemOrder: 0 },
      { ID: '44444444-9200-0000-0000-000000000020', legacyId: 99251, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_HANA_ID,   itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'HANA Cloud', altCondition: "profile.deployment == 'cloud'" },
      { ID: '44444444-9200-0000-0000-000000000030', legacyId: 99252, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_PG_ID,     itemOrder: 1, altGroupKey: 'deployment', altGroupLabel: 'PostgreSQL' },
      { ID: '44444444-9200-0000-0000-000000000040', legacyId: 99253, path_ID: PATH_ID, taskType: 'TUTORIAL', tutorial_ID: TUT_VERIFY_ID, itemOrder: 2 },
    ]);
    __resetCacheForTest();
  });
  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials, ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_INTRO_ID, TUT_HANA_ID, TUT_PG_ID, TUT_VERIFY_ID] } });
    await DELETE.from(ChatSettings).where({ ID: CHAT_SETTINGS_ID });
  });

  it('returns 200 and groups alt-group items into a single altGroup record', async () => {
    // Default ChatSettings (branchingEnabled may be false) is enough to test grouping
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const { status, data } = await project.get('/build/mission/__test__-mission?nocache=1');
    expect(status).toBe(200);
    expect(data.missionSlug).toBe('__test__-mission');
    expect(data.items).toHaveLength(3); // intro, altGroup, verify
    const altGroup = data.items.find(i => i.type === 'altGroup');
    expect(altGroup).toBeDefined();
    expect(altGroup.groupKey).toBe('deployment');
    expect(altGroup.branches.map(b => b.key).sort()).toEqual(['hana-cloud', 'postgresql']); // labels are slugified for keys
    expect(altGroup.recommendation).toBeDefined();
  });

  it('omits the recommendation field when branchingEnabled is false', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: false });

    const { data } = await project.get('/build/mission/__test__-mission?nocache=1');
    const altGroup = data.items.find(i => i.type === 'altGroup');
    expect(altGroup.recommendation).toBeUndefined();
  });

  it('returns 404 for unknown slug', async () => {
    const res = await project.get('/build/mission/does-not-exist').catch(e => e);
    expect(res.response?.status || res.status).toBe(404);
  });

  it('anonymous user gets a deterministic-default recommendation when flag is on', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });

    const { data } = await project.get('/build/mission/__test__-mission?nocache=1');
    const altGroup = data.items.find(i => i.type === 'altGroup');
    expect(altGroup.recommendation.reason.kind).toBe('default');
  });
});
