// test/unit/srv/navigator-catalog-unavailable.test.js
//
// Asserts that navigatorCatalogHandler suppresses ALL links (view path and
// nested-group JS path) for a mission with temporarilyUnavailable:true.
//
// Also locks the null-flag correctness point:
//   - A mission seeded WITHOUT temporarilyUnavailable (column is NULL, i.e. a
//     legacy/migrated row created before the field existed) MUST still produce
//     its tutorial links and appear in missionRefs.
//   - A mission seeded with temporarilyUnavailable:false (explicit default)
//     likewise MUST appear.
//   - Only temporarilyUnavailable:true suppresses.
//
// Harness: cds.test in-memory SQLite (mirrors build-catalog-unavailable.test.js).
// Issue #2864.

import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';

function makeReq(extra = {}) {
  return { query: { nocache: '1' }, ...extra };
}

function makeRes() {
  const res = {
    _payload: undefined,
    _status: 200,
    _headers: {},
    setHeader: function (k, v) { this._headers[k] = v; return this; },
    json:      function (p) { this._payload = p; return this; },
    status:    function (s) { this._status = s; return this; },
  };
  return res;
}

describe('navigatorCatalogHandler — temporarilyUnavailable suppression (#2864)', () => {
  let handler;

  // Slugs used to probe the response
  const DISABLED_SLUG  = 'test-nav-disabled-2864';   // temporarilyUnavailable:true  — view path
  const NORMAL_SLUG    = 'test-nav-normal-2864';      // temporarilyUnavailable:false — view path
  const NULL_FLAG_SLUG = 'test-nav-null-flag-2864';   // temporarilyUnavailable NOT SET (NULL) — legacy row

  // Nested-group path slugs
  const DISABLED_NG_SLUG = 'test-nav-ng-disabled-2864'; // disabled mission, nested-group path
  const NORMAL_NG_SLUG   = 'test-nav-ng-normal-2864';   // normal mission,   nested-group path

  // Tutorial slugs reachable via those missions
  const TUT_VIA_DISABLED  = 'tut-via-disabled-2864';
  const TUT_VIA_NORMAL    = 'tut-via-normal-2864';
  const TUT_VIA_NULL_FLAG = 'tut-via-null-flag-2864';
  const TUT_NG_DISABLED   = 'tut-ng-disabled-2864';
  const TUT_NG_NORMAL     = 'tut-ng-normal-2864';

  beforeAll(async () => {
    await project;

    const mod = await import('../../../srv/lib/navigator-catalog.js');
    handler = mod.navigatorCatalogHandler;
    // Bypass the 5-min response cache so our seeded data is always visible.
    if (mod.invalidateNavigatorCache) mod.invalidateNavigatorCache();

    const {
      Missions, CompletionPaths, CompletionPathItems,
      Groups, GroupPathItems, Tutorials,
    } = cds.entities(NS);

    // -----------------------------------------------------------------------
    // Tutorials
    // -----------------------------------------------------------------------
    const tutDisabledId  = cds.utils.uuid();
    const tutNormalId    = cds.utils.uuid();
    const tutNullFlagId  = cds.utils.uuid();
    const tutNgDisId     = cds.utils.uuid();
    const tutNgNormalId  = cds.utils.uuid();

    // legacyId must match taskLegacyId in CompletionPathItems because
    // NavigatorCatalog joins: inner join Tutorials as tut on tut.legacyId = item.taskLegacyId
    await INSERT.into(Tutorials).entries([
      { ID: tutDisabledId,  legacyId: 97001, slug: TUT_VIA_DISABLED,  title: 'Tutorial via Disabled Mission' },
      { ID: tutNormalId,    legacyId: 97002, slug: TUT_VIA_NORMAL,    title: 'Tutorial via Normal Mission' },
      { ID: tutNullFlagId,  legacyId: 97003, slug: TUT_VIA_NULL_FLAG, title: 'Tutorial via Null-flag Mission' },
      { ID: tutNgDisId,     legacyId: 97011, slug: TUT_NG_DISABLED,   title: 'Tutorial in Nested Group of Disabled Mission' },
      { ID: tutNgNormalId,  legacyId: 97012, slug: TUT_NG_NORMAL,     title: 'Tutorial in Nested Group of Normal Mission' },
    ]);

    // -----------------------------------------------------------------------
    // VIEW PATH — three missions exercising the NavigatorCatalog view filter
    // -----------------------------------------------------------------------

    // 1. Disabled mission (temporarilyUnavailable:true) — direct TUTORIAL item
    const disabledId   = cds.utils.uuid();
    const disabledPath = cds.utils.uuid();
    await INSERT.into(Missions).entries([{
      ID: disabledId, legacyId: 97001,
      title: 'Disabled Navigator Mission', slug: DISABLED_SLUG,
      published: true, temporarilyUnavailable: true,
    }]);
    await INSERT.into(CompletionPaths).entries([{
      ID: disabledPath, mission_ID: disabledId, name: 'Disabled Path',
    }]);
    await INSERT.into(CompletionPathItems).entries([{
      ID: cds.utils.uuid(), path_ID: disabledPath,
      tutorial_ID: tutDisabledId, taskLegacyId: 97001, taskType: 'TUTORIAL', itemOrder: 1,
    }]);

    // 2. Normal mission (temporarilyUnavailable:false) — direct TUTORIAL item
    const normalId   = cds.utils.uuid();
    const normalPath = cds.utils.uuid();
    await INSERT.into(Missions).entries([{
      ID: normalId, legacyId: 97002,
      title: 'Normal Navigator Mission', slug: NORMAL_SLUG,
      published: true, temporarilyUnavailable: false,
    }]);
    await INSERT.into(CompletionPaths).entries([{
      ID: normalPath, mission_ID: normalId, name: 'Normal Path',
    }]);
    await INSERT.into(CompletionPathItems).entries([{
      ID: cds.utils.uuid(), path_ID: normalPath,
      tutorial_ID: tutNormalId, taskLegacyId: 97002, taskType: 'TUTORIAL', itemOrder: 1,
    }]);

    // 3. Legacy/migrated mission — temporarilyUnavailable NOT SET (NULL column).
    //    Must still produce its tutorial links (only `true` suppresses).
    const nullFlagId   = cds.utils.uuid();
    const nullFlagPath = cds.utils.uuid();
    await INSERT.into(Missions).entries([{
      ID: nullFlagId, legacyId: 97003,
      title: 'Null-flag Navigator Mission', slug: NULL_FLAG_SLUG,
      published: true,
      // temporarilyUnavailable intentionally omitted → NULL in DB
    }]);
    await INSERT.into(CompletionPaths).entries([{
      ID: nullFlagPath, mission_ID: nullFlagId, name: 'Null-flag Path',
    }]);
    await INSERT.into(CompletionPathItems).entries([{
      ID: cds.utils.uuid(), path_ID: nullFlagPath,
      tutorial_ID: tutNullFlagId, taskLegacyId: 97003, taskType: 'TUTORIAL', itemOrder: 1,
    }]);

    // -----------------------------------------------------------------------
    // NESTED-GROUP PATH — two missions with taskType='GROUP' items
    // -----------------------------------------------------------------------

    // Groups and their GroupPathItems
    const grpDisId = cds.utils.uuid();
    const grpNgId  = cds.utils.uuid();

    await INSERT.into(Groups).entries([
      { ID: grpDisId, legacyId: 97011, slug: 'grp-dis-2864', title: 'Group of Disabled NG Mission', published: true },
      { ID: grpNgId,  legacyId: 97012, slug: 'grp-ng-2864',  title: 'Group of Normal NG Mission',   published: true },
    ]);
    await INSERT.into(GroupPathItems).entries([
      { ID: cds.utils.uuid(), group_ID: grpDisId, tutorial_ID: tutNgDisId,    itemOrder: 1 },
      { ID: cds.utils.uuid(), group_ID: grpNgId,  tutorial_ID: tutNgNormalId, itemOrder: 1 },
    ]);

    // Disabled nested-group mission
    const ngDisId   = cds.utils.uuid();
    const ngDisPath = cds.utils.uuid();
    await INSERT.into(Missions).entries([{
      ID: ngDisId, legacyId: 97021,
      title: 'Disabled NG Mission', slug: DISABLED_NG_SLUG,
      published: true, temporarilyUnavailable: true,
    }]);
    await INSERT.into(CompletionPaths).entries([{
      ID: ngDisPath, mission_ID: ngDisId, name: 'NG Disabled Path',
    }]);
    await INSERT.into(CompletionPathItems).entries([{
      ID: cds.utils.uuid(), path_ID: ngDisPath,
      group_ID: grpDisId, taskType: 'GROUP', itemOrder: 1,
    }]);

    // Normal nested-group mission
    const ngNormalId   = cds.utils.uuid();
    const ngNormalPath = cds.utils.uuid();
    await INSERT.into(Missions).entries([{
      ID: ngNormalId, legacyId: 97022,
      title: 'Normal NG Mission', slug: NORMAL_NG_SLUG,
      published: true, temporarilyUnavailable: false,
    }]);
    await INSERT.into(CompletionPaths).entries([{
      ID: ngNormalPath, mission_ID: ngNormalId, name: 'NG Normal Path',
    }]);
    await INSERT.into(CompletionPathItems).entries([{
      ID: cds.utils.uuid(), path_ID: ngNormalPath,
      group_ID: grpNgId, taskType: 'GROUP', itemOrder: 1,
    }]);
  });

  // -----------------------------------------------------------------------
  // Helper: call the handler once and return the payload
  // -----------------------------------------------------------------------
  async function getNavigator() {
    const req = makeReq();
    const res = makeRes();
    await handler(req, res);
    return res._payload;
  }

  // -----------------------------------------------------------------------
  // VIEW PATH TESTS
  // -----------------------------------------------------------------------

  it('disabled mission (true): NO tutorial mappings reference its slug', async () => {
    const payload = await getNavigator();
    const mappings = payload?.tutorialMappings ?? [];
    // No tutorialMappings should route via the disabled mission
    const hit = mappings.find(m => m.missionSlug === DISABLED_SLUG);
    expect(hit).toBeUndefined();
  });

  it('disabled mission (true): NOT in missionRefs', async () => {
    const payload = await getNavigator();
    const missions = payload?.missions ?? [];
    const hit = missions.find(m => m.slug === DISABLED_SLUG);
    expect(hit).toBeUndefined();
  });

  it('disabled mission (true): its tutorial slug absent from tutorialMappings', async () => {
    const payload = await getNavigator();
    const slugSet = new Set((payload?.tutorialMappings ?? []).map(m => m.slug));
    expect(slugSet.has(TUT_VIA_DISABLED)).toBe(false);
  });

  it('normal mission (false): appears in missionRefs and its tutorial in tutorialMappings', async () => {
    const payload = await getNavigator();
    const missions = payload?.missions ?? [];
    expect(missions.find(m => m.slug === NORMAL_SLUG)).toBeDefined();
    const slugSet = new Set((payload?.tutorialMappings ?? []).map(m => m.slug));
    expect(slugSet.has(TUT_VIA_NORMAL)).toBe(true);
  });

  it('null-flag mission (NULL column): appears in missionRefs and its tutorial in tutorialMappings', async () => {
    // CRITICAL: a legacy row with NULL in temporarilyUnavailable MUST NOT be suppressed.
    // This test locks the null-tolerant WHERE form in the view.
    const payload = await getNavigator();
    const missions = payload?.missions ?? [];
    expect(missions.find(m => m.slug === NULL_FLAG_SLUG)).toBeDefined();
    const slugSet = new Set((payload?.tutorialMappings ?? []).map(m => m.slug));
    expect(slugSet.has(TUT_VIA_NULL_FLAG)).toBe(true);
  });

  // -----------------------------------------------------------------------
  // NESTED-GROUP PATH TESTS
  // -----------------------------------------------------------------------

  it('disabled nested-group mission (true): NOT in missionRefs from nested-group path', async () => {
    const payload = await getNavigator();
    const missions = payload?.missions ?? [];
    const hit = missions.find(m => m.slug === DISABLED_NG_SLUG);
    expect(hit).toBeUndefined();
  });

  it('disabled nested-group mission (true): its tutorial NOT in tutorialMappings', async () => {
    const payload = await getNavigator();
    const slugSet = new Set((payload?.tutorialMappings ?? []).map(m => m.slug));
    expect(slugSet.has(TUT_NG_DISABLED)).toBe(false);
  });

  it('normal nested-group mission (false): appears in missionRefs and its tutorial in tutorialMappings', async () => {
    const payload = await getNavigator();
    const missions = payload?.missions ?? [];
    expect(missions.find(m => m.slug === NORMAL_NG_SLUG)).toBeDefined();
    const slugSet = new Set((payload?.tutorialMappings ?? []).map(m => m.slug));
    expect(slugSet.has(TUT_NG_NORMAL)).toBe(true);
  });
});
