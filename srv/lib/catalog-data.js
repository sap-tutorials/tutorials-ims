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

export async function loadGroupContext(slug) {
  const { Groups, GroupPathItems, Tutorials } = cds.entities(NAMESPACE);

  const [group] = await SELECT.from(Groups)
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

export async function loadMissionContext(slug) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials,
          Groups, GroupPathItems } = cds.entities(NAMESPACE);

  const [mission] = await SELECT.from(Missions)
    .where({ slug })
    .columns('ID', 'legacyId', 'slug', 'title', 'description', 'published', 'status');
  if (!mission) return null;
  if (mission.published === false) return null;
  if (mission.status && mission.status !== 'ACTIVE') return null;

  const paths = await SELECT.from(CompletionPaths)
    .where({ mission_ID: mission.ID })
    .columns('ID', 'name', 'slug')
    .orderBy('legacyId');

  const pathIds = paths.map(p => p.ID);
  const items = pathIds.length
    ? await SELECT.from(CompletionPathItems)
        .where({ path_ID: { in: pathIds }, taskType: 'GROUP', group_ID: { '!=': null } })
        .columns('group_ID', 'itemOrder', 'path_ID')
        .orderBy('path_ID', 'itemOrder')
    : [];

  const groupIds = [...new Set(items.map(i => i.group_ID))];
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
  const tutorialIds = [...new Set(gpiRows.map(r => r.tutorial_ID).filter(Boolean))];
  const tutorials = tutorialIds.length
    ? await SELECT.from(Tutorials)
        .where({ ID: { in: tutorialIds }, status: { '!=': 'INACTIVE' } })
        .columns('ID', 'slug', 'title', 'description', 'experienceTag',
                 'averageTimeToComplete', 'stepCount', 'primaryTag', 'createdAt')
    : [];
  const tutById = new Map(tutorials.map(t => [t.ID, t]));

  const groupCards = items.map(item => {
    const g = groupById.get(item.group_ID);
    if (!g) return null;
    const groupTuts = gpiRows
      .filter(r => r.group_ID === g.ID)
      .map(r => tutById.get(r.tutorial_ID))
      .filter(Boolean)
      .map(projectTutorial);
    return { ...g, tutorials: groupTuts };
  }).filter(Boolean);

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
