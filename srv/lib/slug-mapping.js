import cds from '@sap/cds';

export async function buildSlugMapping() {
  const { Tutorials, Missions, CompletionPaths } = cds.entities('com.sap.developers.ims');

  const [tutorials, missions, paths] = await Promise.all([
    SELECT.from(Tutorials).columns('legacyId', 'slug', 'title')
      .where('legacyId is not null and slug is not null'),
    SELECT.from(Missions).columns('legacyId', 'slug', 'title')
      .where('legacyId is not null and slug is not null'),
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
