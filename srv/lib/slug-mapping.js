import cds from '@sap/cds';

export async function buildSlugMapping() {
  const { Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

  const [tutorials, missions, paths] = await Promise.all([
    SELECT.from(Tutorials).columns('legacyId', 'slug', 'title')
      .where(`legacyId is not null and slug is not null and (status is null or status != 'INACTIVE')`),
    SELECT.from(Missions).columns('legacyId', 'slug', 'title')
      .where(`legacyId is not null and slug is not null and (status is null or status != 'INACTIVE')`),
    SELECT.from(CompletionPaths).columns('legacyId', 'slug', 'name')
      .where('legacyId is not null and slug is not null'),
  ]);

  const flat = [
    ...tutorials.map(t => ({ legacyId: t.legacyId, slug: t.slug, entityType: 'TUTORIAL', title: t.title })),
    ...missions.map(m => ({ legacyId: m.legacyId, slug: m.slug, entityType: 'MISSION', title: m.title })),
    ...paths.map(p => ({ legacyId: p.legacyId, slug: p.slug, entityType: 'PATH', title: p.name })),
  ];

  const grouped = {
    tutorials: tutorials.map(t => ({ legacyId: t.legacyId, slug: t.slug, title: t.title })),
    missions: missions.map(m => ({ legacyId: m.legacyId, slug: m.slug, title: m.title })),
    paths: paths.map(p => ({ legacyId: p.legacyId, slug: p.slug, title: p.name })),
  };

  const keyed = [
    ...tutorials.map(t => ({ compositeKey: `TUTORIAL:${t.legacyId}`, slug: t.slug, title: t.title })),
    ...missions.map(m => ({ compositeKey: `MISSION:${m.legacyId}`, slug: m.slug, title: m.title })),
    ...paths.map(p => ({ compositeKey: `PATH:${p.legacyId}`, slug: p.slug, title: p.name })),
  ];

  return { flat, grouped, keyed };
}

export async function findMissingSlugs() {
  const { CompletionPathItems, CompletionPaths, Missions, Tutorials } = cds.entities('com.sap.developers.ims');

  const items = await SELECT.from(CompletionPathItems)
    .where({ taskType: 'TUTORIAL' });

  if (items.length === 0) return [];

  const taskLegacyIds = items.map(i => i.taskLegacyId);
  const tutorials = await SELECT.from(Tutorials)
    .columns('legacyId', 'slug')
    .where({ legacyId: { in: taskLegacyIds } });

  const missingSlugs = new Set(
    tutorials.filter(t => !t.slug).map(t => t.legacyId)
  );

  if (missingSlugs.size === 0) return [];

  const pathIds = [...new Set(items.filter(i => missingSlugs.has(i.taskLegacyId)).map(i => i.path_ID))];
  const paths = await SELECT.from(CompletionPaths).where({ ID: { in: pathIds } });
  const pathMap = new Map(paths.map(p => [p.ID, p]));

  const missionIds = [...new Set(paths.map(p => p.mission_ID).filter(Boolean))];
  const missions = missionIds.length > 0
    ? await SELECT.from(Missions).where({ ID: { in: missionIds } })
    : [];
  const missionMap = new Map(missions.map(m => [m.ID, m]));

  return items
    .filter(i => missingSlugs.has(i.taskLegacyId))
    .map(i => {
      const path = pathMap.get(i.path_ID);
      const mission = path ? missionMap.get(path.mission_ID) : null;
      return {
        taskLegacyId: i.taskLegacyId,
        taskType: i.taskType,
        pathName: path?.name || '',
        missionTitle: mission?.title || '',
      };
    });
}
