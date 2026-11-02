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

  it('handles mixed-case URL slug by canonicalizing to lowercase', async () => {
    const { ChatSettings } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: false });

    const { status, data } = await project.get('/build/mission/__TEST__-MISSION?nocache=1');
    expect(status).toBe(200);
    expect(data.missionSlug).toBe('__test__-mission');
  });

  it('skips BranchDecisions write when ?nocache=1 is set (issue #296)', async () => {
    const { ChatSettings, BranchDecisions } = cds.entities('com.sap.developers.ims');
    await UPSERT.into(ChatSettings).entries({ ID: CHAT_SETTINGS_ID, branchingEnabled: true });
    await DELETE.from(BranchDecisions).where({ missionSlug: '__test__-mission' });

    // With ?nocache=1: telemetry row must NOT be written
    await project.get('/build/mission/__test__-mission?nocache=1');
    let rows = await SELECT.from(BranchDecisions).where({ missionSlug: '__test__-mission' });
    expect(rows).toHaveLength(0);

    // Without ?nocache=1: telemetry row IS written (proves the gate is conditional)
    __resetCacheForTest();
    await project.get('/build/mission/__test__-mission');
    rows = await SELECT.from(BranchDecisions).where({ missionSlug: '__test__-mission' });
    expect(rows.length).toBeGreaterThanOrEqual(1);

    await DELETE.from(BranchDecisions).where({ missionSlug: '__test__-mission' });
  });
});

// #2990 — mission-detail /build/mission/:slug returns paths[0] as the
// pathOrder-first path, not insertion order.
// Three paths: name order (Z→M→A) differs from pathOrder (3→NULL→1).
// SQLite NULLs sort FIRST so order is: M Path (null), A Path (1), Z Path (3).
describe('/build/mission/:slug — paths ordered by pathOrder then name (#2990)', () => {
  const MDP_MISSION_ID = '11111111-2990-dc00-0000-000000000001';
  // Three paths; name Z→M→A, pathOrder 3→null→1
  const MDP_PATH_A_ID = '22222222-2990-dc00-0000-000000000001'; // name='A Path', pathOrder=1
  const MDP_PATH_M_ID = '22222222-2990-dc00-0000-000000000002'; // name='M Path', pathOrder=null
  const MDP_PATH_Z_ID = '22222222-2990-dc00-0000-000000000003'; // name='Z Path', pathOrder=3
  const MDP_TUT_ID    = '33333333-2990-dc00-0000-000000000001';

  beforeAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Missions).entries({
      ID: MDP_MISSION_ID, legacyId: 299020, title: '__TEST__ MDP Mission',
      slug: '__test__-mdp-mission', published: true,
    });
    await INSERT.into(CompletionPaths).entries([
      { ID: MDP_PATH_A_ID, legacyId: 299021, mission_ID: MDP_MISSION_ID, name: 'A Path', slug: '__test__-mdp-path-a', pathOrder: 1 },
      { ID: MDP_PATH_M_ID, legacyId: 299022, mission_ID: MDP_MISSION_ID, name: 'M Path', slug: '__test__-mdp-path-m', pathOrder: null },
      { ID: MDP_PATH_Z_ID, legacyId: 299023, mission_ID: MDP_MISSION_ID, name: 'Z Path', slug: '__test__-mdp-path-z', pathOrder: 3 },
    ]);
    await INSERT.into(Tutorials).entries({
      ID: MDP_TUT_ID, legacyId: 299031, slug: '__test__-mdp-tut', title: 'MDP Tutorial', status: 'ACTIVE',
    });
    // Only path A has items — so the handler picks the pathOrder-first path (not insertion order).
    // After the fix, paths[0] should be M Path (null sorts first), so we add an item on M Path.
    // That way if the old legacyId order were used (A=1 < M=2 < Z=3), we'd get A Path instead.
    await INSERT.into(CompletionPathItems).entries({
      ID: '44444444-2990-dc00-0000-000000000001', legacyId: 299041,
      path_ID: MDP_PATH_M_ID, taskType: 'TUTORIAL', tutorial_ID: MDP_TUT_ID, itemOrder: 0,
    });
    __resetCacheForTest();
  });

  afterAll(async () => {
    const { Missions, CompletionPaths, CompletionPathItems, Tutorials, ChatSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: { in: [MDP_PATH_A_ID, MDP_PATH_M_ID, MDP_PATH_Z_ID] } });
    await DELETE.from(CompletionPaths).where({ ID: { in: [MDP_PATH_A_ID, MDP_PATH_M_ID, MDP_PATH_Z_ID] } });
    await DELETE.from(Missions).where({ ID: MDP_MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: MDP_TUT_ID });
    __resetCacheForTest();
  });

  it('paths[0] is the path with the lowest pathOrder (NULL < 1 < 3 on SQLite)', async () => {
    // M Path has pathOrder=null → sorts FIRST on SQLite → becomes paths[0].
    // The handler uses paths[0] exclusively; items should come from M Path.
    const { status, data } = await project.get('/build/mission/__test__-mdp-mission?nocache=1');
    expect(status).toBe(200);
    // missionSlug canonicalized
    expect(data.missionSlug).toBe('__test__-mdp-mission');
    // M Path has the one tutorial item → items should be non-empty
    expect(data.items).toHaveLength(1);
    expect(data.items[0].slug).toBe('__test__-mdp-tut');
  });
});
