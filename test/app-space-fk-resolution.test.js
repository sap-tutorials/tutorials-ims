import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

// Issue #1866 (App-Space arm): getAppSpaceProgress / getEventProgress resolved
// each CompletionPathItem's task via `taskLegacyId` only. Manually-authored
// content (e.g. the DSAG-Jahreskongress 2026 / SAP Connect 2026 event missions)
// populates the item's `tutorial_ID` FK (UUID) but leaves `taskLegacyId` NULL,
// so those items missed the task map entirely and the App-Space page rendered
// empty tutorial cards (title/url/description blank) even though the badge
// showed. The mission catalog builder (build-catalog.js) already resolved
// tutorial_ID first; srv/lib/path-item-task-resolver.js now gives the two
// progress handlers the same FK-first behavior.
const EVENT_ID   = 10009009;
const MISSION_ID = '11111111-1866-aaaa-0000-000000000001';
const PATH_ID    = '22222222-1866-aaaa-0000-000000000001';

// Three tutorials exercising the three item shapes.
const TUT_FK_ONLY   = { ID: 'cccccccc-1866-aaaa-0000-000000000011', legacyId: 10009075, slug: 'fk-only-agent',     title: 'FK Only Agent' };
const TUT_LEGACY    = { ID: 'cccccccc-1866-aaaa-0000-000000000012', legacyId: 10009076, slug: 'legacy-only-agent', title: 'Legacy Only Agent' };
const TUT_BOTH      = { ID: 'cccccccc-1866-aaaa-0000-000000000013', legacyId: 10009077, slug: 'both-set-agent',    title: 'Both Set Agent' };

describe('App-Space / event progress: FK-first tutorial resolution (#1866)', () => {
  beforeAll(async () => {
    const { Events, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([TUT_FK_ONLY, TUT_LEGACY, TUT_BOTH]);

    await INSERT.into(Missions).entries({
      ID: MISSION_ID, legacyId: 10009001, title: 'Event Mission', slug: 'event-mission',
      description: 'Mission for the app-space event', published: true, event_ID: null,
    });

    await INSERT.into(Events).entries({
      ID: 'eeeeeeee-1866-aaaa-0000-000000000001', legacyId: EVENT_ID,
      name: 'FK Resolution Test Event', eventType: 'OTHER', mission_ID: MISSION_ID,
    });

    await INSERT.into(CompletionPaths).entries({
      ID: PATH_ID, legacyId: 10009050, name: 'Event Mission', mission_ID: MISSION_ID,
    });

    await INSERT.into(CompletionPathItems).entries([
      // FK-only: tutorial_ID set, taskLegacyId NULL (the broken shape).
      { ID: 'dddddddd-1866-aaaa-0000-000000000001', path_ID: PATH_ID, itemOrder: 1,
        taskType: 'TUTORIAL', taskLegacyId: null, tutorial_ID: TUT_FK_ONLY.ID },
      // Legacy-only: taskLegacyId set, tutorial_ID NULL (legacy shape).
      { ID: 'dddddddd-1866-aaaa-0000-000000000002', path_ID: PATH_ID, itemOrder: 2,
        taskType: 'TUTORIAL', taskLegacyId: TUT_LEGACY.legacyId, tutorial_ID: null },
      // Both set: FK wins, must still resolve correctly.
      { ID: 'dddddddd-1866-aaaa-0000-000000000003', path_ID: PATH_ID, itemOrder: 3,
        taskType: 'TUTORIAL', taskLegacyId: TUT_BOTH.legacyId, tutorial_ID: TUT_BOTH.ID },
    ]);
  });

  afterAll(async () => {
    const { Events, Missions, CompletionPaths, CompletionPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(CompletionPathItems).where({ path_ID: PATH_ID });
    await DELETE.from(CompletionPaths).where({ ID: PATH_ID });
    await DELETE.from(Events).where({ legacyId: EVENT_ID });
    await DELETE.from(Missions).where({ ID: MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [TUT_FK_ONLY.ID, TUT_LEGACY.ID, TUT_BOTH.ID] } });
  });

  it('getAppSpaceProgress populates title/url for all three item shapes', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${EVENT_ID})`);

    const items = data.paths.flatMap(p => p.items);
    expect(items).toHaveLength(3);

    const byTitle = Object.fromEntries(items.map(i => [i.title, i]));

    // FK-only item: previously blank; now resolved via tutorial_ID.
    expect(byTitle[TUT_FK_ONLY.title]).toBeDefined();
    expect(byTitle[TUT_FK_ONLY.title].url).toBe(`/tutorials/${TUT_FK_ONLY.slug}.html`);
    expect(byTitle[TUT_FK_ONLY.title].imsId).toBe(TUT_FK_ONLY.legacyId); // effective legacyId

    // Legacy-only item: unchanged fallback path still works.
    expect(byTitle[TUT_LEGACY.title].url).toBe(`/tutorials/${TUT_LEGACY.slug}.html`);
    expect(byTitle[TUT_LEGACY.title].imsId).toBe(TUT_LEGACY.legacyId);

    // Both set: FK wins, resolves to the same tutorial.
    expect(byTitle[TUT_BOTH.title].url).toBe(`/tutorials/${TUT_BOTH.slug}.html`);
    expect(byTitle[TUT_BOTH.title].imsId).toBe(TUT_BOTH.legacyId);

    // No empty cards.
    for (const i of items) {
      expect(i.title).not.toBe('');
      expect(i.url).not.toBe('');
    }
  });

  it('getEventProgress resolves the FK-only item too', async () => {
    const { data } = await project.get(`/api/getEventProgress(missionLegacyId=10009001)`,
      { auth: { username: 'developer', password: 'developer' } });
    const items = data.paths.flatMap(p => p.items);
    const fkItem = items.find(i => i.title === TUT_FK_ONLY.title);
    expect(fkItem).toBeDefined();
    expect(fkItem.url).toBe(`/tutorials/${TUT_FK_ONLY.slug}.html`);
    expect(fkItem.imsId).toBe(TUT_FK_ONLY.legacyId);
  });
});

// App-Space rendering fixes: (1) a path whose item is a GROUP must expand into
// the group's child tutorials (previously rendered "0 tutorials"); (2) each
// path must show its OWN CompletionPaths.description, not the mission's.
const G_EVENT_ID   = 10009209;
const G_MISSION_ID = '11111111-9209-aaaa-0000-000000000001';
const G_PATH_GROUP = '22222222-9209-aaaa-0000-000000000001'; // path containing a GROUP item
const G_PATH_FLAT  = '22222222-9209-aaaa-0000-000000000002'; // path with a direct tutorial
const G_GROUP_ID   = '33333333-9209-aaaa-0000-000000000001';
const G_TUT_A = { ID: 'cccccccc-9209-aaaa-0000-000000000001', legacyId: 10009281, slug: 'group-child-a', title: 'Group Child A' };
const G_TUT_B = { ID: 'cccccccc-9209-aaaa-0000-000000000002', legacyId: 10009282, slug: 'group-child-b', title: 'Group Child B' };
const G_TUT_FLAT = { ID: 'cccccccc-9209-aaaa-0000-000000000003', legacyId: 10009283, slug: 'flat-tut', title: 'Flat Tutorial' };

describe('App-Space: GROUP expansion + per-path description', () => {
  beforeAll(async () => {
    const { Events, Missions, Groups, CompletionPaths, CompletionPathItems, GroupPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');

    await INSERT.into(Tutorials).entries([G_TUT_A, G_TUT_B, G_TUT_FLAT]);
    await INSERT.into(Missions).entries({
      ID: G_MISSION_ID, legacyId: 10009201, title: 'Garage Mission', slug: 'garage-mission',
      description: 'Ready to get your hands dirty? Swing by the Developer Garage.', published: true, event_ID: null,
    });
    await INSERT.into(Events).entries({
      ID: 'eeeeeeee-9209-aaaa-0000-000000000001', legacyId: G_EVENT_ID,
      name: 'Garage Event', eventType: 'OTHER', mission_ID: G_MISSION_ID,
    });
    await INSERT.into(Groups).entries({
      ID: G_GROUP_ID, legacyId: 10009250, title: 'Joule Studio Group', slug: 'joule-studio-group', published: true,
    });
    await INSERT.into(CompletionPaths).entries([
      // Path 1: its own description + a GROUP item (no direct tutorials).
      { ID: G_PATH_GROUP, legacyId: 10009260, name: 'Joule Studio (web)', mission_ID: G_MISSION_ID,
        description: 'Joule Studio (web)' },
      // Path 2: its own description + a direct tutorial.
      { ID: G_PATH_FLAT, legacyId: 10009261, name: 'Joule Work', mission_ID: G_MISSION_ID,
        description: 'Joule Work path description' },
    ]);
    await INSERT.into(CompletionPathItems).entries([
      // GROUP item on path 1 — carries group_ID, no tutorial.
      { ID: 'dddddddd-9209-aaaa-0000-000000000001', path_ID: G_PATH_GROUP, itemOrder: 1,
        taskType: 'GROUP', taskLegacyId: null, group_ID: G_GROUP_ID },
      // Direct tutorial on path 2.
      { ID: 'dddddddd-9209-aaaa-0000-000000000002', path_ID: G_PATH_FLAT, itemOrder: 1,
        taskType: 'TUTORIAL', taskLegacyId: null, tutorial_ID: G_TUT_FLAT.ID },
    ]);
    await INSERT.into(GroupPathItems).entries([
      { ID: 'ffffffff-9209-aaaa-0000-000000000001', group_ID: G_GROUP_ID, tutorial_ID: G_TUT_A.ID, itemOrder: 1 },
      { ID: 'ffffffff-9209-aaaa-0000-000000000002', group_ID: G_GROUP_ID, tutorial_ID: G_TUT_B.ID, itemOrder: 2 },
    ]);
  });

  afterAll(async () => {
    const { Events, Missions, Groups, CompletionPaths, CompletionPathItems, GroupPathItems, Tutorials } =
      cds.entities('com.sap.developers.ims');
    await DELETE.from(GroupPathItems).where({ group_ID: G_GROUP_ID });
    await DELETE.from(CompletionPathItems).where({ path_ID: { in: [G_PATH_GROUP, G_PATH_FLAT] } });
    await DELETE.from(CompletionPaths).where({ ID: { in: [G_PATH_GROUP, G_PATH_FLAT] } });
    await DELETE.from(Groups).where({ ID: G_GROUP_ID });
    await DELETE.from(Events).where({ legacyId: G_EVENT_ID });
    await DELETE.from(Missions).where({ ID: G_MISSION_ID });
    await DELETE.from(Tutorials).where({ ID: { in: [G_TUT_A.ID, G_TUT_B.ID, G_TUT_FLAT.ID] } });
  });

  it('expands a GROUP path item into its child tutorials (not "0 tutorials")', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${G_EVENT_ID})`);

    const groupPath = data.paths.find(p => p.id === 10009260);
    expect(groupPath).toBeDefined();
    const tutorials = groupPath.items.filter(i => i.type === 'TUTORIAL');
    expect(tutorials.map(t => t.title)).toEqual([G_TUT_A.title, G_TUT_B.title]); // ordered by itemOrder
    for (const t of tutorials) {
      expect(t.type).toBe('TUTORIAL'); // not 'GROUP' — the frontend counts only TUTORIAL
      expect(t.url).not.toBe('');
    }
    // No leftover untyped GROUP card.
    expect(groupPath.items.some(i => i.type === 'GROUP')).toBe(false);
  });

  it('each path shows its OWN description, not the mission description', async () => {
    const { data } = await project.get(`/api/getAppSpaceProgress(eventLegacyId=${G_EVENT_ID})`);
    const byId = Object.fromEntries(data.paths.map(p => [p.id, p]));
    expect(byId[10009260].description).toBe('Joule Studio (web)');
    expect(byId[10009261].description).toBe('Joule Work path description');
    // The two descriptions differ (the bug made them identical = mission text).
    expect(byId[10009260].description).not.toBe(byId[10009261].description);
    expect(byId[10009260].description).not.toContain('hands dirty');
  });
});
