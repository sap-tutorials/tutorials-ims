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
