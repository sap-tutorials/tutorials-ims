// Server-side fallback renderer for /tutorials/group-<slug> and
// /tutorials/mission-<slug> when ContentFiles has no published page.
//
// Why this exists: the Hugo build emits one HTML file per Group/Mission via
// fetch-tutorials.ts → /build/catalog. When an admin creates a new Group or
// Mission in the new system, the navigator immediately surfaces it (issue #74),
// but the static page won't exist until the next `rebuild-content.yml` run.
// This renderer fills the gap — it queries the same data the Hugo template
// would use, emits the same DOM structure (so /css/main.css styles it for
// free), and lets the next CI publish replace it transparently.
//
// We deliberately do NOT reproduce baseof.html in full. The goal is a
// functional page that lets a user reach the tutorials, not a 1:1 visual
// replica of the Hugo output.

import cds from '@sap/cds';

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const NAMESPACE = 'com.sap.developers.ims';

// Minimal HTML shell — references the same /css/ and /js/ assets the Hugo
// build emits, so the AppRouter serves them and the page picks up site
// styling without duplicating the chrome here.
function shell({ title, description, kind, slug, body }) {
  const safeTitle = escapeHtml(title);
  const safeDesc  = escapeHtml(description ?? '');
  return `<!DOCTYPE html>
<html lang="en" data-theme="light"
  data-page-kind="${kind}"
  data-page-slug="${escapeHtml(slug)}"
  data-page-title="${safeTitle}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<meta name="description" content="${safeDesc}">
<link rel="stylesheet" href="/css/main.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>`;
}

async function loadGroupContext(slug) {
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
        .where({ ID: { in: tutorialIds } })
        .columns('ID', 'slug', 'title', 'description', 'experienceTag', 'averageTimeToComplete')
    : [];
  const tutById = new Map(tutorials.map(t => [t.ID, t]));

  const orderedTutorials = items
    .map(i => tutById.get(i.tutorial_ID))
    .filter(Boolean);

  return { group, tutorials: orderedTutorials };
}

async function loadMissionContext(slug) {
  const { Missions, CompletionPaths, CompletionPathItems, Tutorials, Groups, GroupPathItems } =
    cds.entities(NAMESPACE);

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
        .where({ ID: { in: groupIds } })
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
        .where({ ID: { in: tutorialIds } })
        .columns('ID', 'slug', 'title')
    : [];
  const tutById = new Map(tutorials.map(t => [t.ID, t]));

  const groupCards = items.map(item => {
    const g = groupById.get(item.group_ID);
    if (!g) return null;
    const groupTuts = gpiRows
      .filter(r => r.group_ID === g.ID)
      .map(r => tutById.get(r.tutorial_ID))
      .filter(Boolean);
    return { ...g, tutorials: groupTuts };
  }).filter(Boolean);

  return { mission, groups: groupCards };
}

function renderGroupBody({ group, tutorials }) {
  const items = tutorials.map((t, i) => `
      <div class="timeline-item">
        <div class="timeline-connector">
          <span class="timeline-circle">${i + 1}</span>
        </div>
        <div class="timeline-card">
          <div class="timeline-card-header">
            <h3><a href="/tutorials/${escapeHtml(t.slug)}">${escapeHtml(t.title)}</a></h3>
          </div>
          ${t.description ? `<p class="timeline-card-desc">${escapeHtml(t.description)}</p>` : ''}
          <div class="timeline-card-footer">
            <a href="/tutorials/${escapeHtml(t.slug)}" class="start-btn">Start Tutorial &rarr;</a>
          </div>
        </div>
      </div>`).join('\n');

  return `<div class="group-wrapper">
  <section class="group-hero">
    <div class="hero-inner">
      <span class="type-badge type-badge--group">GROUP</span>
      <h1>${escapeHtml(group.title)}</h1>
      ${group.description ? `<p class="group-description">${escapeHtml(group.description)}</p>` : ''}
      <div class="group-meta">
        <span class="meta-item">${tutorials.length} Tutorials</span>
      </div>
    </div>
  </section>
  <div class="group-body">
    <h2>Tutorials</h2>
    <div class="tutorial-timeline">
${items}
    </div>
  </div>
</div>`;
}

function renderMissionBody({ mission, groups }) {
  const cards = groups.map(g => {
    const tuts = g.tutorials.map((t, i) => `
            <li class="tutorial-item">
              <span class="tutorial-number">${i + 1}</span>
              <div class="tutorial-info">
                <a href="/tutorials/${escapeHtml(t.slug)}" class="tutorial-link">${escapeHtml(t.title)}</a>
              </div>
            </li>`).join('\n');
    return `      <div class="group-card expanded">
        <div class="group-card-header">
          <div class="group-header-left">
            <span class="type-badge type-badge--group">GROUP</span>
            <h3><a href="/tutorials/group-${escapeHtml(g.slug)}">${escapeHtml(g.title)}</a></h3>
            <span class="group-meta">${g.tutorials.length} Tutorials</span>
          </div>
        </div>
        <div class="group-card-body">
          <ol class="group-tutorials">
${tuts}
          </ol>
          <a href="/tutorials/group-${escapeHtml(g.slug)}" class="group-start-link">View Group &rarr;</a>
        </div>
      </div>`;
  }).join('\n');

  return `<div class="mission-wrapper">
  <section class="mission-hero">
    <div class="hero-inner">
      <div class="hero-top"><div class="hero-text">
        <span class="type-badge type-badge--mission">MISSION</span>
        <h1>${escapeHtml(mission.title)}</h1>
        ${mission.description ? `<p class="mission-description">${escapeHtml(mission.description)}</p>` : ''}
        <div class="mission-meta">
          <span class="meta-item">${groups.length} Groups</span>
        </div>
      </div></div>
    </div>
  </section>
  <div class="mission-body">
    <div class="groups-section">
      <h2>Groups in this Mission</h2>
${cards}
    </div>
  </div>
</div>`;
}

// Public entry point. Returns { status, contentType, body } or null
// (caller should fall through to the published-content path / 404).
export async function renderCatalogPage(slug) {
  if (slug.startsWith('group-')) {
    const groupSlug = slug.slice('group-'.length);
    const ctx = await loadGroupContext(groupSlug);
    if (!ctx) return null;
    const body = renderGroupBody(ctx);
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: shell({
        title: ctx.group.title,
        description: ctx.group.description,
        kind: 'group',
        slug,
        body,
      }),
    };
  }

  if (slug.startsWith('mission-')) {
    const missionSlug = slug.slice('mission-'.length);
    const ctx = await loadMissionContext(missionSlug);
    if (!ctx) return null;
    const body = renderMissionBody(ctx);
    return {
      status: 200,
      contentType: 'text/html; charset=utf-8',
      body: shell({
        title: ctx.mission.title,
        description: ctx.mission.description,
        kind: 'mission',
        slug,
        body,
      }),
    };
  }

  return null;
}
