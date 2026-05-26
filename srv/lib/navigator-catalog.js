import cds from '@sap/cds';

let cachedResponse = null;
let cacheTimestamp = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export async function navigatorCatalogHandler(req, res) {
  const now = Date.now();
  const bypassCache = req.query.nocache === '1';
  if (!bypassCache && cachedResponse && (now - cacheTimestamp) < CACHE_TTL_MS) {
    res.setHeader('X-Cache', 'HIT');
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
      const isFlat = [...pathsMap.values()].filter(p => p.missionId === pathData.missionId).length === 1
        && pathData.pathName === mission.title;

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
      .columns('ID', 'legacyId', 'title', 'status')
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
      const groupSlug = String(g.legacyId);
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

    const pathIds = [...new Set(nestedGroupItems.map(i => i.path_ID))];
    const paths = pathIds.length
      ? await SELECT.from(CompletionPaths).columns('ID', 'legacyId', 'name', 'slug', 'mission_ID').where({ ID: { in: pathIds } })
      : [];
    const pathById = new Map(paths.map(p => [p.ID, p]));

    const missionIds = [...new Set(paths.map(p => p.mission_ID).filter(Boolean))];
    const missions = missionIds.length
      ? await SELECT.from(Missions).columns('ID', 'legacyId', 'title', 'slug', 'published').where({ ID: { in: missionIds }, published: true })
      : [];
    const missionById = new Map(missions.map(m => [m.ID, m]));

    for (const item of nestedGroupItems) {
      const path = pathById.get(item.path_ID);
      if (!path) continue;
      const mission = missionById.get(path.mission_ID);
      if (!mission) continue;
      const group = groupRows.find(g => g.ID === item.group_ID);
      if (!group) continue;

      const groupSlug = String(group.legacyId);
      // Dedup: same Group nested under multiple Missions — first Mission wins.
      if (!groupRefs.find(g => g.id === group.legacyId)) {
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
    res.json(result);
  } catch (err) {
    console.error('[build/navigator]', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Navigator catalog query failed' });
  }
}
