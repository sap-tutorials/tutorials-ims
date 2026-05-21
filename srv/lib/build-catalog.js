import cds from '@sap/cds';

const FEATURED_LIMIT = 6;

export async function buildCatalogHandler(req, res) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials, FeaturedTasks } =
    cds.entities('com.sap.developers.ims');

  try {
    const missions = await SELECT.from(Missions).where({ published: true });
    const paths = await SELECT.from(CompletionPaths).orderBy('legacyId');
    const items = await SELECT.from(CompletionPathItems).orderBy('itemOrder');
    const tutorials = await SELECT.from(Tutorials)
      .columns('legacyId', 'slug', 'title', 'description')
      .where(`status = 'ACTIVE' or status is null`);
    const featuredRows = await SELECT.from(FeaturedTasks)
      .orderBy('featuredOrder')
      .limit(FEATURED_LIMIT);

    const slugByLegacyId = new Map(tutorials.map(t => [t.legacyId, t.slug]));
    const tutorialByLegacyId = new Map(tutorials.map(t => [t.legacyId, t]));
    const missionByLegacyId = new Map(missions.map(m => [m.legacyId, m]));
    const pathByLegacyId = new Map(paths.map(p => [p.legacyId, p]));

    const missionList = missions.map(m => ({
      imsId: m.legacyId,
      title: m.title || '',
      slug: m.slug || String(m.legacyId),
      description: m.description || '',
      level: m.experienceTag || 'beginner',
      time: Math.round((m.averageTimeToComplete || 0) / 60),
      icon: '',
      tasksCount: 0,
    }));

    const hierarchies = missions.map(m => {
      const missionPaths = paths.filter(p => p.mission_ID === m.ID);
      const groups = missionPaths.map(p => {
        const pathItems = items.filter(i => i.path_ID === p.ID);
        const tutorialSlugs = pathItems
          .filter(i => i.taskType === 'TUTORIAL')
          .map(i => slugByLegacyId.get(i.taskLegacyId))
          .filter(Boolean);

        return {
          imsId: p.legacyId,
          title: p.name || '',
          slug: p.slug || String(p.legacyId),
          description: '',
          tutorialSlugs,
        };
      });

      const isFlat = missionPaths.length === 1 && missionPaths[0].name === m.title;

      return {
        missionImsId: m.legacyId,
        groups: isFlat ? [] : groups,
        tutorialSlugs: isFlat ? (groups[0]?.tutorialSlugs || []) : [],
      };
    });

    for (const m of missionList) {
      const h = hierarchies.find(h => h.missionImsId === m.imsId);
      if (h) {
        m.tasksCount = h.tutorialSlugs.length
          + h.groups.reduce((sum, g) => sum + g.tutorialSlugs.length, 0);
      }
    }

    const featured = featuredRows
      .map(f => resolveFeatured(f, { missionByLegacyId, pathByLegacyId, tutorialByLegacyId }))
      .filter(Boolean);

    res.json({ missions: missionList, hierarchies, featured });
  } catch (err) {
    console.error('[build/catalog]', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Build catalog query failed' });
  }
}

function resolveFeatured(f, { missionByLegacyId, pathByLegacyId, tutorialByLegacyId }) {
  if (f.taskType === 'MISSION') {
    const m = missionByLegacyId.get(f.taskLegacyId);
    if (!m) return null;
    return {
      type: 'mission',
      slug: m.slug || String(m.legacyId),
      title: m.title || '',
      description: m.description || '',
    };
  }
  if (f.taskType === 'GROUP') {
    const p = pathByLegacyId.get(f.taskLegacyId);
    if (!p) return null;
    return {
      type: 'group',
      slug: p.slug || String(p.legacyId),
      title: p.name || '',
      description: '',
    };
  }
  if (f.taskType === 'TUTORIAL') {
    const t = tutorialByLegacyId.get(f.taskLegacyId);
    if (!t || !t.slug) return null;
    return {
      type: 'tutorial',
      slug: t.slug,
      title: t.title || '',
      description: t.description || '',
    };
  }
  return null;
}
