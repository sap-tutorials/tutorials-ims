import cds from '@sap/cds';

export async function buildCatalogHandler(req, res) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials } =
    cds.entities('com.sap.developers.ims');

  try {
    const missions = await SELECT.from(Missions);
    const paths = await SELECT.from(CompletionPaths).orderBy('legacyId');
    const items = await SELECT.from(CompletionPathItems).orderBy('itemOrder');
    const tutorials = await SELECT.from(Tutorials).columns('legacyId', 'slug');

    const slugByLegacyId = new Map(tutorials.map(t => [t.legacyId, t.slug]));

    const missionList = missions.map(m => ({
      imsId: m.legacyId,
      title: m.title || '',
      slug: m.slug || '',
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
          slug: p.slug || '',
          description: '',
          tutorialSlugs,
        };
      });

      const directSlugs = missionPaths.length === 0
        ? []
        : [];

      return {
        missionImsId: m.legacyId,
        groups,
        tutorialSlugs: directSlugs,
      };
    });

    for (const m of missionList) {
      const h = hierarchies.find(h => h.missionImsId === m.imsId);
      if (h) {
        m.tasksCount = h.groups.reduce((sum, g) => sum + g.tutorialSlugs.length, 0);
      }
    }

    res.json({ missions: missionList, hierarchies });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ error: 'Build catalog query failed', detail: msg });
  }
}
