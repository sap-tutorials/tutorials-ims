import cds from '@sap/cds';
import { categorySlugsFor, buildCategoriesPayload } from './build-catalog-categories.js';
import { assembleMissionHierarchy, collectAltGroups } from './catalog-mission-hierarchy.js';

const FEATURED_LIMIT = 6;

// NOTE: collectAltGroups + the inline hierarchy walk that lived here
// previously have moved to srv/lib/catalog-mission-hierarchy.js so this
// file and srv/lib/catalog-data.js share one canonical implementation.
// See issue #437 + memory feedback_two_source_of_truth_drift_in_catalog
// (PR #428 fixed the symptom of drift on 2026-06-19; this refactor closes
// the door on the pattern that allowed it).

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
      .columns('group_ID', 'tutorial_ID', 'itemOrder',
               'altGroupKey', 'altGroupLabel', 'altCondition');

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

      // Delegate the walk to the shared helper. Returns a canonical
      // hierarchy whose tutorial-identity strings are already slugs (we
      // pass `slugByLegacyId.get(taskLegacyId)` as the resolver). The
      // helper is identity-agnostic; catalog-data.js calls it with a
      // tutorial_ID UUID resolver. See srv/lib/catalog-mission-hierarchy.js
      // for the contract.
      const canonical = assembleMissionHierarchy({
        mission: m,
        paths: missionPaths,
        items,
        groupById,
        groupPathItems,
        resolveTutorialIdentity: i => slugByLegacyId.get(i.taskLegacyId),
      });

      // Project canonical hierarchy → build-catalog.js's external shape
      // (slug-based, with isFlat collapse). The helper deliberately doesn't
      // know about this shape — it's how the navigator JSON contract has
      // looked since pre-#382, and catalog-data.js projects to a DIFFERENT
      // shape (full tutorial objects, no isFlat collapse).
      const groupHierarchies = canonical.paths.flatMap(({ path: p, directTutorialIdentities, altGroups, nestedGroups }) => {
        // Emit one HierarchyGroup for the path itself (existing behavior)
        const pathGroup = {
          imsId: p.legacyId,
          title: p.name || '',
          slug: p.slug || String(p.legacyId),
          description: '',
          tutorialSlugs: directTutorialIdentities,  // already slugs (resolver above)
          ...(altGroups.length ? { altGroups } : {}),
        };

        // Plus one HierarchyGroup per nested GROUP item in this path
        const nestedHierarchyGroups = nestedGroups.map(({ group: g, tutorialIds, altGroups: gAltGroups }) => {
          // GroupPathItems always carry tutorial_ID (UUID), so project
          // through tutorialByUuid to slugs for both the linear list and
          // the alt-group branches.
          const tutorialSlugs = tutorialIds
            .map(id => tutorialByUuid.get(id))
            .filter(Boolean);
          const projectedAltGroups = gAltGroups.map(ag => ({
            groupKey: ag.groupKey,
            branches: ag.branches.map(b => ({
              ...b,
              tutorialSlug: tutorialByUuid.get(b.tutorialSlug) || b.tutorialSlug,
            })),
          }));
          return {
            imsId: g.legacyId,
            title: g.title || '',
            slug: g.slug || String(g.legacyId),
            description: g.description || '',
            tutorialSlugs,
            ...(projectedAltGroups.length ? { altGroups: projectedAltGroups } : {}),
          };
        });

        return [pathGroup, ...nestedHierarchyGroups];
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
        const groupAltGroups = collectAltGroups(
          gpItems,
          gpi => tutorialByUuid.get(gpi.tutorial_ID),
        );
        return {
          imsId: g.legacyId,
          title: g.title || '',
          slug: g.slug || String(g.legacyId),
          description: g.description || '',
          tutorialSlugs,
          ...(groupAltGroups.length ? { altGroups: groupAltGroups } : {}),
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
