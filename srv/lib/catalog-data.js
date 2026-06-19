// srv/lib/catalog-data.js
//
// Pure DB access for /tutorials/group-* and /tutorials/mission-* server-side
// rendering. Returns shaped contexts the catalog-renderer can consume without
// any further DB awareness. No HTML, no HTTP, no caching.
//
// Field mapping mirrors what scripts/fetch-tutorials.ts (Phase 4, pre-cutover)
// passed into Hugo frontmatter, so the rendered output stays parity-equivalent
// to hugo/layouts/groups/single.html and hugo/layouts/missions/single.html.

import cds from '@sap/cds';

const NAMESPACE = 'com.sap.developers.ims';

// Mirrors fetch-tutorials.ts level-aggregation: any 'advanced' wins, else any
// 'intermediate', else 'beginner'. Keeps the displayed level bound to the
// hardest tutorial in the set, not the average.
function aggregateLevel(levels) {
  if (levels.includes('advanced')) return 'advanced';
  if (levels.includes('intermediate')) return 'intermediate';
  return 'beginner';
}

// Humanize a primary tag for the timeline-card-tag chip. Matches what
// fetch-tutorials.ts > humanizeTag does at build time, simplified to the
// shapes the data actually has after the tag importer runs.
function humanizeTag(raw) {
  if (!raw) return '';
  const last = raw.split('>').pop();
  return last.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function projectTutorial(t) {
  return {
    ID: t.ID,
    slug: t.slug,
    title: t.title,
    description: t.description ?? '',
    level: t.experienceTag ?? 'beginner',
    time: t.averageTimeToComplete ?? 0,
    stepCount: t.stepCount ?? 0,
    primaryTag: humanizeTag(t.primaryTag ?? ''),
    createdAt: t.createdAt ?? null,
  };
}

/**
 * Load full group context for SSR.
 * @param {string} slug - Group slug (without `group-` prefix). MUST be
 *   lowercase (caller-canonicalizes — serveHandler in content-store.js
 *   lowercases inbound paths before reaching this function).
 */
export async function loadGroupContext(slug) {
  const { Groups, GroupPathItems, Tutorials } = cds.entities(NAMESPACE);

  const [group] = await SELECT.from(Groups)
    // slug-canonical: caller-canonicalizes
    .where({ slug })
    .columns('ID', 'legacyId', 'slug', 'title', 'description', 'published', 'status');
  if (!group) return null;
  if (group.published === false) return null;
  if (group.status && group.status !== 'ACTIVE') return null;

  const items = await SELECT.from(GroupPathItems)
    .where({ group_ID: group.ID })
    .columns('tutorial_ID', 'itemOrder')
    .orderBy('itemOrder');

  const tutorialIds = items.map(i => i.tutorial_ID).filter(Boolean);
  const tutorials = tutorialIds.length
    ? await SELECT.from(Tutorials)
        .where({ ID: { in: tutorialIds }, status: { '!=': 'INACTIVE' } })
        .columns('ID', 'slug', 'title', 'description', 'experienceTag',
                 'averageTimeToComplete', 'stepCount', 'primaryTag', 'createdAt')
    : [];
  const tutById = new Map(tutorials.map(t => [t.ID, t]));

  const orderedTutorials = items
    .map(i => tutById.get(i.tutorial_ID))
    .filter(Boolean)
    .map(projectTutorial);

  const totalTime = orderedTutorials.reduce((s, t) => s + (t.time || 0), 0);
  const level = aggregateLevel(orderedTutorials.map(t => t.level));

  return {
    group,
    tutorials: orderedTutorials,
    tutorialCount: orderedTutorials.length,
    totalTime,
    level,
  };
}

/**
 * Load full mission context for SSR.
 * @param {string} slug - Mission slug (without `mission-` prefix). MUST be
 *   lowercase (caller-canonicalizes — serveHandler in content-store.js
 *   lowercases inbound paths before reaching this function).
 */
export async function loadMissionContext(slug) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials,
          Groups, GroupPathItems } = cds.entities(NAMESPACE);

  const [mission] = await SELECT.from(Missions)
    // slug-canonical: caller-canonicalizes
    .where({ slug })
    .columns('ID', 'legacyId', 'slug', 'title', 'description', 'published', 'status');
  if (!mission) return null;
  if (mission.published === false) return null;
  if (mission.status && mission.status !== 'ACTIVE') return null;

  const paths = await SELECT.from(CompletionPaths)
    .where({ mission_ID: mission.ID })
    .columns('ID', 'name', 'slug', 'legacyId')
    .orderBy('legacyId');

  const pathIds = paths.map(p => p.ID);
  // [#382 phase F1] Fetch BOTH taskType variants. Direct TUTORIAL items
  // become synthetic path-as-group cards; nested GROUP items resolve through
  // the Groups table. Mirrors srv/lib/build-catalog.js:91-117 exactly.
  const items = pathIds.length
    ? await SELECT.from(CompletionPathItems)
        .where({ path_ID: { in: pathIds } })
        .columns('group_ID', 'tutorial_ID', 'taskType', 'itemOrder', 'path_ID')
        .orderBy('path_ID', 'itemOrder')
    : [];

  // Direct TUTORIAL items per path (taskType='TUTORIAL').
  const directItems = items.filter(i => i.taskType === 'TUTORIAL' && i.tutorial_ID);
  // Nested GROUP items per path (taskType='GROUP', existing behavior).
  const groupItems = items.filter(i => i.taskType === 'GROUP' && i.group_ID);

  const groupIds = [...new Set(groupItems.map(i => i.group_ID))];
  const groups = groupIds.length
    ? await SELECT.from(Groups)
        .where({ ID: { in: groupIds }, published: true, status: 'ACTIVE' })
        .columns('ID', 'slug', 'title', 'description')
    : [];
  const groupById = new Map(groups.map(g => [g.ID, g]));

  const gpiRows = groupIds.length
    ? await SELECT.from(GroupPathItems)
        .where({ group_ID: { in: groupIds } })
        .columns('group_ID', 'tutorial_ID', 'itemOrder')
        .orderBy('group_ID', 'itemOrder')
    : [];

  // Combine tutorial UUIDs from BOTH paths (direct + nested) into one
  // SELECT to minimize round-trips.
  const directTutorialIds = directItems.map(i => i.tutorial_ID);
  const nestedTutorialIds = gpiRows.map(r => r.tutorial_ID).filter(Boolean);
  const tutorialIds = [...new Set([...directTutorialIds, ...nestedTutorialIds])];
  const tutorials = tutorialIds.length
    ? await SELECT.from(Tutorials)
        .where({ ID: { in: tutorialIds }, status: { '!=': 'INACTIVE' } })
        .columns('ID', 'slug', 'title', 'description', 'experienceTag',
                 'averageTimeToComplete', 'stepCount', 'primaryTag', 'createdAt')
    : [];
  const tutById = new Map(tutorials.map(t => [t.ID, t]));

  // Build cards in the same order build-catalog.js:117 emits — for each path,
  // synthetic-group first (if any direct TUTORIAL items exist), then nested
  // groups. Across paths, paths are already ordered by legacyId.
  const groupCards = paths.flatMap(p => {
    const cards = [];

    // Synthetic group from direct-TUTORIAL items.
    const pathDirect = directItems
      .filter(i => i.path_ID === p.ID)
      .map(i => tutById.get(i.tutorial_ID))
      .filter(Boolean)
      .map(projectTutorial);
    if (pathDirect.length > 0) {
      cards.push({
        ID: p.ID,
        slug: p.slug || String(p.legacyId ?? ''),
        title: p.name || '',
        description: '',
        tutorials: pathDirect,
        isSynthetic: true,
      });
    }

    // Nested-Group cards from taskType='GROUP' items (existing behavior).
    const pathGroups = groupItems
      .filter(i => i.path_ID === p.ID)
      .map(item => {
        const g = groupById.get(item.group_ID);
        if (!g) return null;
        const groupTuts = gpiRows
          .filter(r => r.group_ID === g.ID)
          .map(r => tutById.get(r.tutorial_ID))
          .filter(Boolean)
          .map(projectTutorial);
        return { ...g, tutorials: groupTuts };
      })
      .filter(Boolean);
    cards.push(...pathGroups);

    return cards;
  });

  const allTutorials = groupCards.flatMap(g => g.tutorials);
  const totalTime = allTutorials.reduce((s, t) => s + (t.time || 0), 0);
  const level = aggregateLevel(allTutorials.map(t => t.level));

  return {
    mission,
    groups: groupCards,
    groupCount: groupCards.length,
    tutorialCount: allTutorials.length,
    totalTime,
    level,
  };
}
