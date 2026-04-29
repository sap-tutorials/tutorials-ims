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

  const { NavigatorCatalog } = cds.entities('com.sap.developers.ims');

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

    const result = { missions: missionRefs, groups: groupRefs, tutorialMappings };
    cachedResponse = result;
    cacheTimestamp = now;
    res.setHeader('X-Cache', 'MISS');
    res.json(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Navigator catalog query failed', detail: msg });
  }
}
