// srv/__tests__/navigator-visibility.test.js
// Task 2: NavigatorCatalog view must only return LISTED (or null) tutorials (#3099)
// TDD: write failing test first, then add WHERE filter to db/views.cds.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('NavigatorCatalog visibility filter', () => {
  let NavigatorCatalog, Tutorials, Missions, CompletionPaths, CompletionPathItems;

  // Use high legacy IDs unlikely to collide with other test suites.
  const MISSION_ID = 99501;
  const PATH_ID    = 99502;
  const TUT_LISTED     = 99511;
  const TUT_UNLISTED   = 99512;
  const TUT_ROLE_GATED = 99513;
  const TUT_NULL_VIS   = 99514; // no visibility set → db default 'LISTED' on new rows,
                                 // but we force null to simulate pre-activation rows

  const insertedMissionId   = { ref: null };
  const insertedPathId      = { ref: null };

  beforeAll(async () => {
    ({
      NavigatorCatalog, Tutorials, Missions, CompletionPaths, CompletionPathItems
    } = cds.entities('com.sap.developers.ims'));

    // ---- seed mission + path ----
    await INSERT.into(Missions).entries([{
      ID: cds.utils.uuid(),
      legacyId: MISSION_ID,
      title: 'Nav Vis Mission',
      slug: 'nav-vis-mission',
      status: 'ACTIVE',
      published: true   // must be true for NavigatorCatalog WHERE clause
    }]);
    const missionRow = await SELECT.one.from(Missions).where({ legacyId: MISSION_ID });
    insertedMissionId.ref = missionRow.ID;

    await INSERT.into(CompletionPaths).entries([{
      ID: cds.utils.uuid(),
      legacyId: PATH_ID,
      name: 'Nav Vis Path',
      slug: 'nav-vis-path',
      mission_ID: missionRow.ID
    }]);
    const pathRow = await SELECT.one.from(CompletionPaths).where({ legacyId: PATH_ID });
    insertedPathId.ref = pathRow.ID;

    // ---- seed four tutorials with distinct visibility ----
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), legacyId: TUT_LISTED,     slug: 'nav-vis-listed',     status: 'ACTIVE', visibility: 'LISTED' },
      { ID: cds.utils.uuid(), legacyId: TUT_UNLISTED,   slug: 'nav-vis-unlisted',   status: 'ACTIVE', visibility: 'UNLISTED' },
      { ID: cds.utils.uuid(), legacyId: TUT_ROLE_GATED, slug: 'nav-vis-role-gated', status: 'ACTIVE', visibility: 'ROLE_GATED' },
      { ID: cds.utils.uuid(), legacyId: TUT_NULL_VIS,   slug: 'nav-vis-null',       status: 'ACTIVE', visibility: null }
    ]);

    // ---- wire all four into the path ----
    await INSERT.into(CompletionPathItems).entries([
      { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_LISTED,     taskType: 'TUTORIAL', itemOrder: 1 },
      { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_UNLISTED,   taskType: 'TUTORIAL', itemOrder: 2 },
      { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_ROLE_GATED, taskType: 'TUTORIAL', itemOrder: 3 },
      { ID: cds.utils.uuid(), path_ID: pathRow.ID, taskLegacyId: TUT_NULL_VIS,   taskType: 'TUTORIAL', itemOrder: 4 }
    ]);
  });

  afterAll(async () => {
    // Clean up in dependency order.
    await DELETE.from(CompletionPathItems).where({ path_ID: insertedPathId.ref });
    await DELETE.from(CompletionPaths).where({ ID: insertedPathId.ref });
    await DELETE.from(Missions).where({ ID: insertedMissionId.ref });
    await DELETE.from(Tutorials).where({
      legacyId: { in: [TUT_LISTED, TUT_UNLISTED, TUT_ROLE_GATED, TUT_NULL_VIS] }
    });
  });

  it('LISTED tutorial appears in NavigatorCatalog', async () => {
    const rows = await SELECT.from(NavigatorCatalog).where({ missionId: MISSION_ID });
    const slugs = rows.map(r => r.tutorialSlug);
    expect(slugs).toContain('nav-vis-listed');
  });

  it('UNLISTED tutorial does NOT appear in NavigatorCatalog', async () => {
    const rows = await SELECT.from(NavigatorCatalog).where({ missionId: MISSION_ID });
    const slugs = rows.map(r => r.tutorialSlug);
    expect(slugs).not.toContain('nav-vis-unlisted');
  });

  it('ROLE_GATED tutorial does NOT appear in NavigatorCatalog', async () => {
    const rows = await SELECT.from(NavigatorCatalog).where({ missionId: MISSION_ID });
    const slugs = rows.map(r => r.tutorialSlug);
    expect(slugs).not.toContain('nav-vis-role-gated');
  });

  it('null-visibility tutorial appears in NavigatorCatalog (pre-activation rows not hidden)', async () => {
    const rows = await SELECT.from(NavigatorCatalog).where({ missionId: MISSION_ID });
    const slugs = rows.map(r => r.tutorialSlug);
    expect(slugs).toContain('nav-vis-null');
  });
});
