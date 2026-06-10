import cds from '@sap/cds';
import { categorySlugsFor, buildCategoriesPayload } from './build-catalog-categories.js';
import { slugifyKey } from './branch/slug-key.js';

const FEATURED_LIMIT = 6;

export async function buildCatalogHandler(req, res) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials, FeaturedTasks, Groups, GroupPathItems,
          Categories, MissionCategories, GroupCategories, TutorialCategories } =
    cds.entities('com.sap.developers.ims');

  try {
    const missions = await SELECT.from(Missions).where({ published: true });
    const paths = await SELECT.from(CompletionPaths).orderBy('legacyId');
    const items = await SELECT.from(CompletionPathItems).orderBy('itemOrder');
    const tutorials = await SELECT.from(Tutorials)
      .columns('ID', 'legacyId', 'slug', 'title', 'description')
      .where(`status = 'ACTIVE' or status is null`);
    const featuredRows = await SELECT.from(FeaturedTasks)
      .orderBy('featuredOrder')
      .limit(FEATURED_LIMIT);

    const groups = await SELECT.from(Groups)
      .columns('ID', 'legacyId', 'slug', 'title', 'description', 'published', 'status');
    const groupById = new Map(groups.map(g => [g.ID, g]));

    const groupPathItems = await SELECT.from(GroupPathItems)
      .columns('group_ID', 'tutorial_ID', 'itemOrder');

    const categories    = await SELECT.from(Categories).columns('ID', 'slug', 'label', 'sortOrder');
    const missionAssign = await SELECT.from(MissionCategories).columns('mission_ID', 'category_ID', 'score');
    const groupAssign   = await SELECT.from(GroupCategories).columns('group_ID', 'category_ID', 'score');
    const tutorialAssign = await SELECT.from(TutorialCategories).columns('tutorial_ID', 'category_ID', 'score');

    const catByID = new Map(categories.map(c => [c.ID, c]));

    const tutorialByUuid = new Map(tutorials.map(t => [t.ID, t.slug]));

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
      categorySlugs: categorySlugsFor(m.ID, missionAssign, 'mission_ID', catByID),
    }));

    const hierarchies = missions.map(m => {
      const missionPaths = paths.filter(p => p.mission_ID === m.ID);
      const groupHierarchies = missionPaths.flatMap(p => {
        const pathItems = items.filter(i => i.path_ID === p.ID);

        // TUTORIAL items in this path → the path's own slug list
        const pathTutorialSlugs = pathItems
          .filter(i => i.taskType === 'TUTORIAL')
          .sort((a, b) => a.itemOrder - b.itemOrder)
          .map(i => slugByLegacyId.get(i.taskLegacyId))
          .filter(Boolean);

        // Collect alt-group branches on the path-level group. Items sharing
        // (itemOrder, altGroupKey) are branches of the same fork. Linear
        // backbone items (no altGroupKey) are unaffected.
        const altGroups = [];
        const seenAltKeys = new Map();
        for (const it of pathItems) {
          if (it.taskType !== 'TUTORIAL' || !it.altGroupKey) continue;
          const k = `${it.itemOrder}:${it.altGroupKey}`;
          const branch = {
            key: slugifyKey(it.altGroupLabel || ''),
            label: it.altGroupLabel || '',
            tutorialSlug: slugByLegacyId.get(it.taskLegacyId) || '',
            condition: it.altCondition || null,
          };
          if (seenAltKeys.has(k)) {
            altGroups[seenAltKeys.get(k)].branches.push(branch);
          } else {
            seenAltKeys.set(k, altGroups.length);
            altGroups.push({ groupKey: it.altGroupKey, branches: [branch] });
          }
        }

        // Emit one HierarchyGroup for the path itself (existing behavior)
        const pathGroup = {
          imsId: p.legacyId,
          title: p.name || '',
          slug: p.slug || String(p.legacyId),
          description: '',
          tutorialSlugs: pathTutorialSlugs,
          ...(altGroups.length ? { altGroups } : {}),
        };

        // Plus one HierarchyGroup per nested GROUP item in this path
        const nestedGroups = pathItems
          .filter(i => i.taskType === 'GROUP' && i.group_ID)
          .sort((a, b) => a.itemOrder - b.itemOrder)
          .map(i => {
            const g = groupById.get(i.group_ID);
            if (!g) return null;
            const gpItems = groupPathItems
              .filter(gpi => gpi.group_ID === g.ID)
              .sort((a, b) => a.itemOrder - b.itemOrder);
            const tutorialSlugs = gpItems
              .map(gpi => tutorialByUuid.get(gpi.tutorial_ID))
              .filter(Boolean);
            return {
              imsId: g.legacyId,
              title: g.title || '',
              slug: g.slug || String(g.legacyId),
              description: g.description || '',
              tutorialSlugs,
            };
          })
          .filter(Boolean);

        return [pathGroup, ...nestedGroups];
      });

      // isFlat must remain true for single-path no-nested-group missions (existing
      // behavior). groupHierarchies.length === 1 means: one path AND no nested
      // groups under it (path → 1 entry; each nested group → +1 entry).
      const isFlat = missionPaths.length === 1
        && missionPaths[0].name === m.title
        && groupHierarchies.length === 1;

      // When isFlat we hide the synthetic single-path group and lift its
      // tutorialSlugs to the hierarchy itself. Lift altGroups too so consumers
      // (PR 3 hydration island, Task 7 mission-side-nav) can find them
      // regardless of mission shape.
      const flatAltGroups = isFlat ? (groupHierarchies[0]?.altGroups || []) : [];

      return {
        missionImsId: m.legacyId,
        groups: isFlat ? [] : groupHierarchies,
        tutorialSlugs: isFlat ? (groupHierarchies[0]?.tutorialSlugs || []) : [],
        ...(flatAltGroups.length ? { altGroups: flatAltGroups } : {}),
      };
    });

    for (const m of missionList) {
      const h = hierarchies.find(h => h.missionImsId === m.imsId);
      if (h) {
        m.tasksCount = h.tutorialSlugs.length
          + h.groups.reduce((sum, g) => sum + g.tutorialSlugs.length, 0);
      }
    }

    // Standalone groups: published Groups whose ID never appears as group_ID on any
    // taskType='GROUP' CompletionPathItem. Disjointness invariant matches navigator-catalog.js.
    const nestedGroupIds = new Set(
      items
        .filter(i => i.taskType === 'GROUP' && i.group_ID)
        .map(i => i.group_ID)
    );

    const standaloneGroups = groups
      .filter(g => g.published)
      .filter(g => g.status === 'ACTIVE' || g.status === null || g.status === undefined)
      .filter(g => !nestedGroupIds.has(g.ID))
      .map(g => {
        const gpItems = groupPathItems
          .filter(gpi => gpi.group_ID === g.ID)
          .sort((a, b) => a.itemOrder - b.itemOrder);
        const tutorialSlugs = gpItems
          .map(gpi => tutorialByUuid.get(gpi.tutorial_ID))
          .filter(Boolean);
        return {
          imsId: g.legacyId,
          title: g.title || '',
          slug: g.slug || String(g.legacyId),
          description: g.description || '',
          tutorialSlugs,
          categorySlugs: categorySlugsFor(g.ID, groupAssign, 'group_ID', catByID),
        };
      });

    const featured = featuredRows
      .map(f => resolveFeatured(f, { missionByLegacyId, pathByLegacyId, tutorialByLegacyId }))
      .filter(Boolean);

    const tutorialList = tutorials.map(t => ({
      slug: t.slug,
      title: t.title || '',
      description: t.description || '',
      categorySlugs: categorySlugsFor(t.ID, tutorialAssign, 'tutorial_ID', catByID),
    }));

    const categoriesPayload = buildCategoriesPayload(categories, missionAssign, groupAssign, tutorialAssign);

    res.json({ missions: missionList, hierarchies, featured, standaloneGroups, tutorials: tutorialList, categories: categoriesPayload });
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
