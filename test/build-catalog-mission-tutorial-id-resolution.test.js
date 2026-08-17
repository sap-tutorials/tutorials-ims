import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Issue #1866: a mission whose CompletionPath carries a DIRECT taskType='TUTORIAL'
// item that has `tutorial_ID` (UUID) populated but `taskLegacyId` NULL — the shape
// produced by manually-authored content (the high-ID batch on prod, e.g. "Learn
// about the SAP Business AI Platform" mission 10000001 → path
// "use-joule-work-to-contextualize-and-reason" → "Get productive with Joule Work").
//
// build-catalog.js used to resolve direct-path tutorials ONLY via
// `slugByLegacyId.get(i.taskLegacyId)`, so a null/unmapped taskLegacyId dropped the
// tutorial from the mission hierarchy (tasksCount=0, empty path-group). The mission
// SSR page (catalog-data.js) resolves via `i.tutorial_ID` and rendered the tutorial
// fine, so the two drifted — and the baked tutorial breadcrumb, sourced from
// /build/catalog via fetch-tutorials, lost its Mission crumb. The standalone Group
// (same slug, linked via GroupPathItems/UUID) then became the tutorial's only nav
// owner: breadcrumb showed Group but no Mission.
const TAG_ID     = 'aaaaaaaa-1866-0000-0000-000000000001';
const MISSION_ID = '11111111-1866-0000-0000-000000000001';
const PATH_ID    = '22222222-1866-0000-0000-000000000001';
const TUT_ID     = 'cccccccc-1866-0000-0000-000000000011';
const CPI_ID     = 'cccccccc-1866-0000-0000-000000000031';

describe('/build/catalog: direct-path tutorial with tutorial_ID but no taskLegacyId (#1866)', () => {
  beforeAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tags).entries({ ID: TAG_ID, legacyId: 918660, name: '__TEST__ 1866 Tag' });
    await INSERT.into(Tutorials).entries({
      ID: TUT_ID, legacyId: 918661, title: '__TEST__ 1866 Tut', slug: 'test-1866-tut', status: 'ACTIVE',
    });
    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 918660, title: '__TEST__ 1866 Mission',
      slug: 'test-1866-mission', description: 'desc', experienceTag: 'beginner',
      primaryTagRef_ID: TAG_ID, published: true,
    });
    // Path name != mission title so the mission is NOT collapsed to isFlat — it
    // stays a real (synthetic) group card carrying the tutorial, matching the
    // prod shape where the path is named after the group.
    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 918662, mission_ID: MISSION_ID,
      name: '__TEST__ 1866 Group', slug: 'test-1866-group',
    });
    // The crux: tutorial_ID is set, taskLegacyId is intentionally omitted (null).
    await INSERT.into(CompletionPathItems).entries({
      ID: CPI_ID, legacyId: 918663, path_ID: PATH_ID,
      taskType: 'TUTORIAL', tutorial_ID: TUT_ID, itemOrder: 0,
    });
  });

  afterAll(async () => {
    const { Tags, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ ID: CPI_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: TUT_ID });
    await DELETE.from(Tags).where({ ID: TAG_ID });
  });

  it('resolves the direct-path tutorial slug into the mission hierarchy', async () => {
    const { status, data } = await project.get('/build/catalog');
    expect(status).toBe(200);

    const hier = data.hierarchies.find(h => h.missionImsId === 918660);
    expect(hier).toBeDefined();
    // The synthetic path-group must carry the tutorial so the mission owns it.
    const group = hier.groups.find(g => g.slug === 'test-1866-group');
    expect(group).toBeDefined();
    expect(group.tutorialSlugs).toEqual(['test-1866-tut']);
  });

  it('counts the tutorial in the mission tasksCount', async () => {
    const { data } = await project.get('/build/catalog');
    const mission = data.missions.find(m => m.imsId === 918660);
    expect(mission).toBeDefined();
    expect(mission.tasksCount).toBe(1);
  });
});
