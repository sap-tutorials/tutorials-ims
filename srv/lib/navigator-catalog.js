import cds from '@sap/cds';
import { resolveNavigatorSettings } from './runtime-config/navigator-settings.js';
import { onCacheGenerationChange, refreshCacheGeneration } from './content-cache-coherence.js';

let cachedResponse = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// #1592: same cross-instance staleness as the render cache — this response
// cache is process-local, so an admin write on one instance never cleared it
// on the others (it only self-healed after the 5-min TTL). Drop it when a peer
// bumps the shared catalog generation.
onCacheGenerationChange(() => { cachedResponse = null; cacheTimestamp = 0; });

// Issue #364: by default, do NOT emit a top-level groups[] card for groups
// that only appear nested inside a Mission's CompletionPath. The legacy
// AEM-curated navigator only ever surfaced standalone groups (~194), and
// matching that behavior keeps the developers.sap.com-replacement chip
// counts aligned with prod expectations. Set NAV_INCLUDE_NESTED_GROUPS=true
// to opt back into the richer behavior (extra ~65 cards on dev). Tutorials
// inside nested groups still get a tutorialMappings entry so routing works
// regardless of this flag — the flag only gates the navigator-card emission.
//
// The env var is read at request time (not at module load) so tests can flip
// it via beforeAll/afterAll. Note: there's a 5-min response cache; the test
// suite uses ?nocache=1 to bypass.
async function shouldIncludeNestedGroups() {
  return (await resolveNavigatorSettings()).includeNestedGroups;
}

export function invalidateNavigatorCache() {
  cachedResponse = null;
  cacheTimestamp = 0;
}

export async function navigatorCatalogHandler(req, res) {
  const now = Date.now();
  const bypassCache = req.query.nocache === '1';
  // #1592: TTL-gated cross-instance check before trusting our local cache.
  await refreshCacheGeneration();
  if (!bypassCache && cachedResponse && (now - cacheTimestamp) < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
    res.setHeader('Cache-Control', 'public, max-age=60');
    return res.json(cachedResponse);
  }

  const { NavigatorCatalog, Groups, GroupPathItems, Tutorials, CompletionPathItems, CompletionPaths, Missions } = cds.entities('com.sap.developers.ims');

  try {
    const rows = await SELECT.from(NavigatorCatalog).orderBy('missionId', 'pathId', 'itemOrder');

    const missionsMap = new Map();
    const pathsMap = new Map();
    const missionRefs = [];
    const groupRefs = [];
    const tutorialMappings = [];

    // Group rows by mission → path → items (already ordered)
    for (const row of rows) {
      if (!missionsMap.has(row.missionId)) {
        missionsMap.set(row.missionId, { id: row.missionId, title: row.missionTitle, slug: row.missionSlug || String(row.missionId) });
        missionRefs.push(missionsMap.get(row.missionId));
      }

      const pathKey = `${row.missionId}:${row.pathId}`;
      if (!pathsMap.has(pathKey)) {
        pathsMap.set(pathKey, { pathId: row.pathId, pathName: row.pathName, pathSlug: row.pathSlug || String(row.pathId), missionId: row.missionId, missionTitle: row.missionTitle, slugs: [] });
      }
      const slug = row.tutorialSlug.replace(/\.md$/, '');
      pathsMap.get(pathKey).slugs.push(slug);
    }

    // Build groups and tutorial mappings
    for (const [, pathData] of pathsMap) {
      const mission = missionsMap.get(pathData.missionId);
      // A single-path mission is "flat": its lone CompletionPath is a structural
      // container, not a user-facing group, so we suppress the synthetic
      // `path-<legacyId>` group card and lift its tutorials straight under the
      // mission. Previously this also required `pathData.pathName === mission.title`,
      // but prod paths routinely have an empty/differing name — that made isFlat
      // false and emitted a bogus, empty-titled group card linking to
      // /tutorials/group-path-<id>, which 404s (catalog-data.js only serves real
      // Groups). Mirrors srv/lib/build-catalog.js's isFlat (single path + no nested
      // groups → flat). Note: pathsMap is built solely from NavigatorCatalog's
      // TUTORIAL rows, so nested Groups (taskType='GROUP') don't inflate this count
      // and are surfaced separately in the nested-group loop below.
      const isFlat = [...pathsMap.values()].filter(p => p.missionId === pathData.missionId).length === 1;

      if (!isFlat) {
        groupRefs.push({ id: pathData.pathId, title: pathData.pathName, slug: pathData.pathSlug, missionId: pathData.missionId });
      }

      for (let i = 0; i < pathData.slugs.length; i++) {
        tutorialMappings.push({
          slug: pathData.slugs[i],
          missionId: pathData.missionId,
          missionTitle: mission.title,
          missionSlug: mission.slug,
          groupId: isFlat ? undefined : pathData.pathId,
          groupTitle: isFlat ? undefined : pathData.pathName,
          groupSlug: isFlat ? undefined : pathData.pathSlug,
          prev: i > 0 ? pathData.slugs[i - 1] : null,
          next: i < pathData.slugs.length - 1 ? pathData.slugs[i + 1] : null,
        });
      }
    }

    // Surface standalone published Groups (not nested inside any Mission's CompletionPath)
    const allGroupRows = await SELECT.from(Groups)
      .columns('ID', 'legacyId', 'slug', 'title', 'status')
      .where({ published: true });
    const groupRows = allGroupRows.filter(g => g.status === 'ACTIVE' || g.status === null || g.status === undefined);

    const gpiRows = groupRows.length
      ? await SELECT.from(GroupPathItems)
          .columns('group_ID', 'itemOrder', 'tutorial_ID')
          .where({ group_ID: { in: groupRows.map(g => g.ID) } })
          .orderBy('group_ID', 'itemOrder')
      : [];

    const tutorialIds = [...new Set(gpiRows.map(r => r.tutorial_ID))];
    const tuts = tutorialIds.length
      ? await SELECT.from(Tutorials).columns('ID', 'legacyId', 'slug', 'title').where({ ID: { in: tutorialIds } })
      : [];
    const tutById = new Map(tuts.map(t => [t.ID, t]));

    const nestedGroupRefs = await SELECT.from(CompletionPathItems)
      .columns('group_ID')
      .where({ taskType: 'GROUP', group_ID: { '!=': null } });
    const nestedGroupRefIds = new Set();
    for (const r of nestedGroupRefs) if (r.group_ID) nestedGroupRefIds.add(r.group_ID);

    const standaloneGroups = groupRows.filter(g => !nestedGroupRefIds.has(g.ID));

    for (const g of standaloneGroups) {
      const groupSlug = g.slug || String(g.legacyId);
      groupRefs.push({ id: g.legacyId, title: g.title, slug: groupSlug });

      const items = gpiRows.filter(r => r.group_ID === g.ID);
      const slugs = items
        .map(r => tutById.get(r.tutorial_ID)?.slug)
        .filter(Boolean);

      for (let i = 0; i < slugs.length; i++) {
        tutorialMappings.push({
          slug: slugs[i],
          groupId: g.legacyId,
          groupTitle: g.title,
          groupSlug,
          prev: i > 0 ? slugs[i - 1] : null,
          next: i < slugs.length - 1 ? slugs[i + 1] : null,
        });
      }
    }

    // Nested Groups: a Mission's CompletionPath can contain a CompletionPathItem with
    // taskType='GROUP'. The NavigatorCatalog view filters those out (taskType='TUTORIAL'
    // only), so tutorials reachable through such a Group never receive a groupId tag.
    // We re-query the GROUP items, resolve their Mission, and emit one tutorialMapping
    // per (mission, group, tutorial) tuple plus a single groupRefs entry per group.
    //
    // Disjointness invariant with standaloneGroups (Task 2): a Group ID appears EITHER
    // in standaloneGroups (filtered above by `g => !nestedGroupRefIds.has(g.ID)`) OR is
    // reached via this nested loop — never both. Removing that filter would silently
    // produce duplicate groups[] entries.
    const nestedGroupItems = await SELECT.from(CompletionPathItems)
      .columns('ID', 'path_ID', 'group_ID', 'itemOrder', 'taskType')
      .where({ taskType: 'GROUP', group_ID: { '!=': null } })
      .orderBy('path_ID', 'itemOrder');

    // Also query checkpoint items: they're not surfaced in the response (AppSpace
    // renders checkpoints via getEventProgress), but their path_IDs still need to
    // be resolved into pathById/missionById so the nested-group loop below can
    // resolve any nested Groups that share a path with a checkpoint.
    const checkpointItems = await SELECT.from(CompletionPathItems)
      .columns('path_ID', 'itemOrder')
      .where({ taskType: 'CHECKPOINT' })
      .orderBy('path_ID', 'itemOrder');

    const pathIds = [
      ...new Set([
        ...nestedGroupItems.map(i => i.path_ID),
        ...checkpointItems.map(i => i.path_ID),
      ]),
    ];
    const paths = pathIds.length
      ? await SELECT.from(CompletionPaths).columns('ID', 'legacyId', 'name', 'slug', 'mission_ID').where({ ID: { in: pathIds } })
      : [];
    const pathById = new Map(paths.map(p => [p.ID, p]));

    const missionIds = [...new Set(paths.map(p => p.mission_ID).filter(Boolean))];
    const missions = missionIds.length
      ? await SELECT.from(Missions).columns('ID', 'legacyId', 'title', 'slug', 'published').where({ ID: { in: missionIds }, published: true })
      : [];
    const missionById = new Map(missions.map(m => [m.ID, m]));

    // Issue #1639: track which missions already have a missions[] ref (the main
    // NavigatorCatalog loop above emits refs only for missions with direct
    // TUTORIAL rows). Missions reached ONLY through a nested GROUP item produce
    // no NavigatorCatalog rows, so without this their ref is never emitted — and
    // the navigator's mission card, built from tutorialMappings, then can't
    // resolve its slug (missionsMeta.find(...) === undefined) and links to the
    // first tutorial instead of /tutorials/mission-<slug>.
    const missionRefIds = new Set(missionRefs.map(m => m.id));

    for (const item of nestedGroupItems) {
      const path = pathById.get(item.path_ID);
      if (!path) continue;
      const mission = missionById.get(path.mission_ID);
      if (!mission) continue;
      const group = groupRows.find(g => g.ID === item.group_ID);
      if (!group) continue;

      // Emit the mission ref unconditionally (NOT gated by
      // NAV_INCLUDE_NESTED_GROUPS): the mission card and its href resolution
      // are independent of whether the nested-group *card* is surfaced. #1639.
      if (!missionRefIds.has(mission.legacyId)) {
        missionRefIds.add(mission.legacyId);
        missionRefs.push({
          id: mission.legacyId,
          title: mission.title,
          slug: mission.slug || String(mission.legacyId),
        });
      }

      const groupSlug = group.slug || String(group.legacyId);
      // Dedup: same Group nested under multiple Missions — first Mission wins.
      // Issue #364: only emit the navigator card when the operator opts in via
      // NAV_INCLUDE_NESTED_GROUPS. Tutorial mappings below still emit so
      // tutorials inside nested groups remain routable regardless of the flag.
      if ((await shouldIncludeNestedGroups()) && !groupRefs.find(g => g.id === group.legacyId)) {
        groupRefs.push({
          id: group.legacyId,
          title: group.title,
          slug: groupSlug,
          missionId: mission.legacyId,
        });
      }

      const groupItems = gpiRows.filter(r => r.group_ID === group.ID);
      const slugs = groupItems
        .map(r => tutById.get(r.tutorial_ID)?.slug)
        .filter(Boolean);

      for (let i = 0; i < slugs.length; i++) {
        tutorialMappings.push({
          slug: slugs[i],
          missionId: mission.legacyId,
          missionTitle: mission.title,
          missionSlug: mission.slug || String(mission.legacyId),
          groupId: group.legacyId,
          groupTitle: group.title,
          groupSlug,
          prev: i > 0 ? slugs[i - 1] : null,
          next: i < slugs.length - 1 ? slugs[i + 1] : null,
        });
      }
    }

    const result = { missions: missionRefs, groups: groupRefs, tutorialMappings };
    cachedResponse = result;
    cacheTimestamp = now;
    res.setHeader('X-Cache', 'MISS');
    // Shared, non-personalized feed — 60s edge cache like the other /build/* feeds.
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.json(result);
  } catch (err) {
    console.error('[build/navigator]', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Navigator catalog query failed' });
  }
}
