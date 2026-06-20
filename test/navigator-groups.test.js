import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { _resetCacheForTests as _resetNavigatorCache } from '../srv/lib/runtime-config/navigator-settings.js';

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

describe('/build/navigator: nested Group inside a Mission', () => {
  const NESTED_TAG_ID    = 'aaaaaaaa-9002-0000-0000-000000000001';
  const NESTED_MISSION_ID = '11111111-9002-0000-0000-000000000001';
  const NESTED_PATH_ID    = '22222222-9002-0000-0000-000000000001';
  const NESTED_GROUP_ID   = 'cccccccc-9002-0000-0000-000000000001';
  const NESTED_TUT_ID     = 'cccccccc-9002-0000-0000-000000000011';
  const NESTED_GPI_ID     = 'cccccccc-9002-0000-0000-000000000021';
  const NESTED_CPI_ID     = 'cccccccc-9002-0000-0000-000000000031';

  // Issue #364: opt back into nested-group card emission for the duration of
  // these assertions. Default behavior (NAV_INCLUDE_NESTED_GROUPS unset) hides
  // the nested-group card to match the legacy AEM-curated navigator's chip
  // count. The contract this describe block exercises is the richer behavior
  // operators can opt into per environment. The default-off path is asserted
  // in a separate describe block below.
  const _origFlag = process.env.NAV_INCLUDE_NESTED_GROUPS;
  beforeAll(async () => {
    process.env.NAV_INCLUDE_NESTED_GROUPS = 'true';
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: NESTED_TAG_ID, legacyId: 99002, name: '__TEST__ Nested Tag' });
    await INSERT.into(Tutorials).entries({
      ID: NESTED_TUT_ID, legacyId: 99031, title: '__TEST__ Nested Tut', slug: 'test-nested-tut', status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: NESTED_GROUP_ID, legacyId: 99002, title: '__TEST__ Nested Group',
      description: 'desc', experienceTag: 'beginner', primaryTagRef_ID: NESTED_TAG_ID,
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      ID: NESTED_GPI_ID, legacyId: 99041, group_ID: NESTED_GROUP_ID, tutorial_ID: NESTED_TUT_ID, itemOrder: 0,
    });
    await INSERT.into(Missions).entries({
      ID: NESTED_MISSION_ID, legacyId: 99002, title: '__TEST__ Nested Mission',
      slug: 'test-nested-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: NESTED_TAG_ID, published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: NESTED_PATH_ID, legacyId: 99003,
      mission_ID: NESTED_MISSION_ID, name: '__TEST__ Nested Path', slug: 'test-nested-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: NESTED_CPI_ID, legacyId: 99051,
      path_ID: NESTED_PATH_ID, taskType: 'GROUP',
      group_ID: NESTED_GROUP_ID, taskLegacyId: 99002, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: NESTED_CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: NESTED_PATH_ID });
    await DELETE.from(Missions).where({ ID: NESTED_MISSION_ID });
    await DELETE.from(GroupPathItems).where({ ID: NESTED_GPI_ID });
    await DELETE.from(Groups).where({ ID: NESTED_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: NESTED_TUT_ID });
    await DELETE.from(Tags).where({ ID: NESTED_TAG_ID });
    // Restore the env var so subsequent describe blocks see the default.
    if (_origFlag === undefined) delete process.env.NAV_INCLUDE_NESTED_GROUPS;
    else process.env.NAV_INCLUDE_NESTED_GROUPS = _origFlag;
  });

  it('emits the nested Group as a member of the Mission', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const grp = data.groups.find(g => g.id === 99002);
    expect(grp).toBeDefined();
    expect(grp.missionId).toBe(99002);
    expect(grp.title).toBe('__TEST__ Nested Group');
  });

  it('expands the nested Group: tutorial gets BOTH missionId and groupId', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const tut = data.tutorialMappings.find(t => t.slug === 'test-nested-tut');
    expect(tut).toBeDefined();
    expect(tut.missionId).toBe(99002);
    expect(tut.missionTitle).toBe('__TEST__ Nested Mission');
    expect(tut.groupId).toBe(99002);
    expect(tut.groupTitle).toBe('__TEST__ Nested Group');
  });

  // Defines the merge semantics for the (intentionally edge-case) scenario where a
  // tutorial is referenced BOTH directly under a Mission CompletionPath AND under a
  // nested Group inside the same or a different Mission. We accept duplicate entries
  // in tutorialMappings (one from each path), and document that the Vue consumer's
  // `find(t => t.slug === ...)` returns the first match — so the direct-under-Mission
  // entry (emitted first via NavigatorCatalog) wins for prev/next chaining. If author
  // content needs the Group entry to win, restructure the content (don't dual-place).
  it('allows tutorial to appear in both direct Mission path and nested Group (no merge, both kept)', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const matches = data.tutorialMappings.filter(t => t.slug === 'test-nested-tut');
    // At least one entry MUST be emitted; if author authors dual-placement, two are acceptable.
    expect(matches.length).toBeGreaterThanOrEqual(1);
    // Whichever entry the consumer's .find() returns first must have the nested Group's groupId
    // (because in this fixture there is no direct-under-Mission CompletionPathItem for this tutorial).
    expect(matches[0].groupId).toBe(99002);
  });
});

// Issue #364: validates the strict-prod-parity default. Same fixture shape as the
// describe block above (one Mission whose CompletionPath references one nested
// Group), but the env var is left UNSET so the navigator-card emission for the
// nested group should be suppressed. tutorialMappings still emit so routing
// continues to work.
describe('/build/navigator: nested Group default-off (Issue #364)', () => {
  const D_TAG_ID    = 'aaaaaaaa-9009-0000-0000-000000000001';
  const D_MISSION_ID = '11111111-9009-0000-0000-000000000001';
  const D_PATH_ID    = '22222222-9009-0000-0000-000000000001';
  const D_GROUP_ID   = 'cccccccc-9009-0000-0000-000000000001';
  const D_TUT_ID     = 'cccccccc-9009-0000-0000-000000000011';
  const D_GPI_ID     = 'cccccccc-9009-0000-0000-000000000021';
  const D_CPI_ID     = 'cccccccc-9009-0000-0000-000000000031';

  beforeAll(async () => {
    // Belt-and-suspenders: explicitly clear the flag in case prior describe
    // didn't restore (the prior afterAll DOES restore — this is defense in depth).
    delete process.env.NAV_INCLUDE_NESTED_GROUPS;
    // Reset resolver cache so the prior block's `true` value (cached for 5s)
    // doesn't leak into this block's default-off assertion.
    _resetNavigatorCache();
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: D_TAG_ID, legacyId: 99009, name: '__TEST__ Default-Off Tag' });
    await INSERT.into(Tutorials).entries({
      ID: D_TUT_ID, legacyId: 99131, title: '__TEST__ Default-Off Tut', slug: 'test-defaultoff-tut', status: 'ACTIVE',
    });
    await INSERT.into(Groups).entries({
      ID: D_GROUP_ID, legacyId: 99019, title: '__TEST__ Default-Off Group',
      description: 'desc', experienceTag: 'beginner', primaryTagRef_ID: D_TAG_ID,
      published: true, status: 'ACTIVE',
    });
    await INSERT.into(GroupPathItems).entries({
      ID: D_GPI_ID, legacyId: 99041, group_ID: D_GROUP_ID, tutorial_ID: D_TUT_ID, itemOrder: 0,
    });
    await INSERT.into(Missions).entries({
      ID: D_MISSION_ID, legacyId: 99019, title: '__TEST__ Default-Off Mission',
      slug: 'test-defaultoff-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: D_TAG_ID, published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: D_PATH_ID, legacyId: 99019,
      mission_ID: D_MISSION_ID, name: '__TEST__ Default-Off Path', slug: 'test-defaultoff-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: D_CPI_ID, legacyId: 99051,
      path_ID: D_PATH_ID, taskType: 'GROUP',
      group_ID: D_GROUP_ID, taskLegacyId: 99019, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Groups, Tutorials, GroupPathItems } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: D_CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: D_PATH_ID });
    await DELETE.from(Missions).where({ ID: D_MISSION_ID });
    await DELETE.from(GroupPathItems).where({ ID: D_GPI_ID });
    await DELETE.from(Groups).where({ ID: D_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: D_TUT_ID });
    await DELETE.from(Tags).where({ ID: D_TAG_ID });
  });

  it('does NOT emit a nested-group card by default', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const grp = data.groups.find(g => g.id === 99019);
    expect(grp).toBeUndefined();
  });

  it('still emits tutorialMappings entries for tutorials inside the nested group (routing intact)', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const tut = data.tutorialMappings.find(t => t.slug === 'test-defaultoff-tut');
    expect(tut).toBeDefined();
    expect(tut.missionId).toBe(99019);
    expect(tut.groupId).toBe(99019);
  });
});

describe('/build/navigator: Checkpoint markers', () => {
  const CP_TAG_ID     = 'aaaaaaaa-9003-0000-0000-000000000001';
  const CP_MISSION_ID = '11111111-9003-0000-0000-000000000001';
  const CP_PATH_ID    = '22222222-9003-0000-0000-000000000001';
  const CP_CPI_ID     = 'cccccccc-9003-0000-0000-000000000031';

  beforeAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: CP_TAG_ID, legacyId: 99003, name: '__TEST__ Checkpoint Tag' });
    await INSERT.into(Missions).entries({
      ID: CP_MISSION_ID, legacyId: 99003, title: '__TEST__ Checkpoint Mission',
      slug: 'test-checkpoint-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: CP_TAG_ID, published: true, status: 'ACTIVE',
    });
    await INSERT.into(CompletionPaths).entries({
      ID: CP_PATH_ID, legacyId: 99004,
      mission_ID: CP_MISSION_ID, name: '__TEST__ Checkpoint Path', slug: 'test-checkpoint-path',
    });
    await INSERT.into(CompletionPathItems).entries({
      ID: CP_CPI_ID, legacyId: 99052,
      path_ID: CP_PATH_ID, taskType: 'CHECKPOINT',
      checkpointTitle: 'Win a coffee mug', itemOrder: 5,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems } = cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: CP_CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: CP_PATH_ID });
    await DELETE.from(Missions).where({ ID: CP_MISSION_ID });
    await DELETE.from(Tags).where({ ID: CP_TAG_ID });
  });

  it('does not put checkpoints into tutorialMappings', async () => {
    const { data } = await project.get('/build/navigator?nocache=1');
    const stray = data.tutorialMappings.find(t => t.slug === 'Win a coffee mug' || t.title === 'Win a coffee mug');
    expect(stray).toBeUndefined();
  });
});

describe('/build/navigator: cache invalidation on admin writes', () => {
  // PR #349's strict published-flag guard requires SuperAdmin to flip the
  // published bit in either direction (including draft activation when the
  // draft sets published=true). Use the superadmin mocked user so this
  // test's draft-activate step succeeds.
  const adminAuth = { auth: { username: 'superadmin', password: 'superadmin' } };
  const INV_TAG_ID    = 'aaaaaaaa-9004-0000-0000-000000000001';
  const INV_GROUP_ID  = 'cccccccc-9004-0000-0000-000000000001';
  const INV_TUT_ID    = 'cccccccc-9004-0000-0000-000000000011';
  const INV_GPI_ID    = 'cccccccc-9004-0000-0000-000000000021';
  const INV_GROUP_TAG_ID = 'cccccccc-9004-0000-0000-000000000031';

  beforeAll(async () => {
    const { Tags, Tutorials } = cds.entities('com.sap.developers.ims');
    await INSERT.into(Tags).entries({ ID: INV_TAG_ID, legacyId: 99004, name: '__TEST__ Invalidation Tag' });
    await INSERT.into(Tutorials).entries({
      ID: INV_TUT_ID, legacyId: 99060, title: '__TEST__ Invalidation Tut',
      slug: 'test-invalidation-tut', status: 'ACTIVE',
    });
  });

  afterAll(async () => {
    const { Tags, Tutorials, Groups, GroupPathItems, GroupTags } = cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ ID: INV_GPI_ID });
    await DELETE.from(GroupTags).where({ ID: INV_GROUP_TAG_ID });
    await DELETE.from(Groups).where({ ID: INV_GROUP_ID });
    await DELETE.from(Tutorials).where({ ID: INV_TUT_ID });
    await DELETE.from(Tags).where({ ID: INV_TAG_ID });
  });

  it('reflects newly inserted Group on next call without ?nocache=1', async () => {
    // First call populates the cache without our group present
    const a = await project.get('/build/navigator');
    expect(a.data.groups.find(g => g.title === '__TEST__ Invalidation Group')).toBeUndefined();

    // Insert a Group via the AdminService projection (so the after-hook fires).
    // AdminService.Groups is draft-enabled, so we POST to create a draft, then
    // call draftActivate to trigger CREATE on the active projection — that is
    // what the srv.after hook listens on. We do not pin legacyId here because
    // the AdminService 'before CREATE' hook auto-assigns one via a sequence
    // when the active CREATE fires (the draft-supplied value is not preserved).
    const { status: createStatus } = await project.post('/admin/Groups', {
      ID: INV_GROUP_ID,
      title: '__TEST__ Invalidation Group', description: 'desc',
      experienceTag: 'beginner', primaryTagRef_ID: INV_TAG_ID,
      published: true, status: 'ACTIVE',
      tags: [{ ID: INV_GROUP_TAG_ID, tag_ID: INV_TAG_ID }],
      items: [{
        ID: INV_GPI_ID,
        tutorial_ID: INV_TUT_ID, itemOrder: 0,
      }],
    }, { ...adminAuth, headers: { Prefer: 'handling=lenient' } });
    expect(createStatus).toBe(201);

    const { status: activateStatus } = await project.post(
      `/admin/Groups(ID=${INV_GROUP_ID},IsActiveEntity=false)/AdminService.draftActivate`,
      {}, adminAuth
    );
    expect(activateStatus).toBe(201);

    // Second call (no nocache flag) should reflect the new Group — proving the
    // srv.after CREATE hook on AdminService called invalidateNavigatorCache().
    const b = await project.get('/build/navigator');
    expect(b.data.groups.find(g => g.title === '__TEST__ Invalidation Group')).toBeDefined();
  });
});
