// srv/lib/catalog-renderer.js
//
// Pure body-markup renderer for /tutorials/group-* and /tutorials/mission-*.
// No DB access, no HTTP — takes a context (from catalog-data.js) and returns
// a body HTML string that the chrome-shell composer splices into the full page.
//
// Output structure mirrors hugo/layouts/groups/single.html and
// missions/single.html so the existing /css/* sheets style the result without
// any new CSS. Inline behaviors (group-card-header onclick, first-card
// auto-expand) are reproduced verbatim — they are tiny, scoped, and removing
// them would require parallel CSS work outside this change's scope.

const escapeHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;');

const NEW_WINDOW_DAYS = 31;

function isNewTutorial(createdAt, now = new Date()) {
  if (!createdAt) return false;
  const t = new Date(createdAt);
  if (Number.isNaN(t.getTime())) return false;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - NEW_WINDOW_DAYS);
  return t > cutoff;
}

function titleCase(s) {
  return String(s ?? '').replace(/\b\w/g, c => c.toUpperCase());
}

export function renderGroupBody(ctx, opts = {}) {
  const { group, tutorials, tutorialCount, totalTime, level } = ctx;
  const now = opts.now ?? new Date();

  const cards = tutorials.map((t, i) => {
    const isNew = isNewTutorial(t.createdAt, now);
    const newClass = isNew ? ' timeline-card--new' : '';
    const newBadge = isNew
      ? `<span class="timeline-card__new-badge" aria-label="New tutorial">NEW</span>`
      : '';
    const desc = t.description
      ? `<p class="timeline-card-desc">${escapeHtml(t.description)}</p>`
      : '';
    const tagChip = t.primaryTag
      ? `<span class="timeline-card-tag">${escapeHtml(t.primaryTag)}</span>`
      : '';
    const isLast = i === tutorials.length - 1;
    const connectorLine = isLast ? '' : '<div class="timeline-line"></div>';

    return `
      <div class="timeline-item">
        <div class="timeline-connector">
          <span class="timeline-circle">${i + 1}</span>
          ${connectorLine}
        </div>
        <div class="timeline-card${newClass}">
          ${newBadge}
          <div class="timeline-card-header">
            <h3><a href="/tutorials/${escapeHtml(t.slug)}">${escapeHtml(t.title)}</a></h3>
            <div class="timeline-card-meta">
              <span>${escapeHtml(titleCase(t.level))}</span>
              <span class="meta-sep">&middot;</span>
              <span>${t.time | 0} min.</span>
              <span class="meta-sep">&middot;</span>
              <span>${t.stepCount | 0} steps</span>
            </div>
          </div>
          ${desc}
          <div class="timeline-card-footer">
            ${tagChip}
            <a href="/tutorials/${escapeHtml(t.slug)}" class="start-btn">Start Tutorial &rarr;</a>
          </div>
        </div>
      </div>`;
  }).join('\n');

  return `<div class="group-wrapper">
  <section class="group-hero">
    <div class="hero-inner">
      <span class="type-badge type-badge--group">GROUP</span>
      <h1>${escapeHtml(group.title)}</h1>
      ${group.description ? `<p class="group-description">${escapeHtml(group.description)}</p>` : ''}
      <div class="group-meta">
        <span class="meta-item">${escapeHtml(titleCase(level))}</span>
        <span class="meta-sep">&middot;</span>
        <span class="meta-item">${totalTime | 0} min.</span>
        <span class="meta-sep">&middot;</span>
        <span class="meta-item">${tutorialCount | 0} Tutorials</span>
      </div>
    </div>
  </section>
  <div class="group-body">
    <h2>Tutorials</h2>
    <div class="tutorial-timeline">
${cards}
    </div>
  </div>
</div>
<script type="module" src="/js/nav-dropdown.js"></script>`;
}

export function renderMissionBody(ctx) {
  const { mission, groups, groupCount, tutorialCount, totalTime, level } = ctx;

  const cards = groups.map(g => {
    const tuts = g.tutorials.map((t, i) => `
            <li class="tutorial-item">
              <span class="tutorial-number">${i + 1}</span>
              <div class="tutorial-info">
                <a href="/tutorials/${escapeHtml(t.slug)}" class="tutorial-link">${escapeHtml(t.title)}</a>
                <div class="tutorial-meta-row">
                  <span>${escapeHtml(titleCase(t.level || 'beginner'))}</span>
                  <span class="meta-sep">&middot;</span>
                  <span>${t.time | 0} min.</span>
                  <span class="meta-sep">&middot;</span>
                  <span>${t.stepCount | 0} steps</span>
                </div>
              </div>
            </li>`).join('\n');

    return `      <div class="group-card">
        <div class="group-card-header" onclick="this.parentElement.classList.toggle('expanded')">
          <div class="group-header-left">
            <span class="type-badge type-badge--group">GROUP</span>
            <h3><a href="/tutorials/group-${escapeHtml(g.slug)}" onclick="event.stopPropagation()">${escapeHtml(g.title)}</a></h3>
            <span class="group-meta">${g.tutorials.length} Tutorials</span>
          </div>
          <span class="group-chevron">&#9662;</span>
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
        <h1 class="mission-hero-title">${escapeHtml(mission.title)}</h1>
        ${mission.description ? `<p class="mission-description">${escapeHtml(mission.description)}</p>` : ''}
        <div class="mission-meta">
          <span class="meta-item">${escapeHtml(titleCase(level))}</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item">${totalTime | 0} min.</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item">${tutorialCount | 0} Tutorials</span>
          <span class="meta-sep">&middot;</span>
          <span class="meta-item">${groupCount | 0} Groups</span>
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
</div>
<script>
// Auto-expand the first group card (parity with hugo/layouts/missions/single.html)
document.addEventListener('DOMContentLoaded', function() {
  var firstCard = document.querySelector('.group-card');
  if (firstCard) firstCard.classList.add('expanded');
});
</script>
<script type="module" src="/js/nav-dropdown.js"></script>`;
}

// Composes a full page given a slug + chrome shell + already-loaded body data.
// Returns null when the entity isn't found / not published / inactive — caller
// (content-store.serveHandler) maps this to 404 via the existing serveNotFound.
export async function renderCatalogPage(slug, deps) {
  const { loadGroupContext, loadMissionContext, shellLoader } = deps;

  if (slug.startsWith('group-')) {
    const ctx = await loadGroupContext(slug.slice('group-'.length));
    if (!ctx) return null;
    const body = renderGroupBody(ctx);
    return {
      contentType: 'text/html; charset=utf-8',
      body,
      pageMeta: {
        kind: 'group',
        slug,
        title: ctx.group.title,
        description: ctx.group.description ?? '',
      },
    };
  }

  if (slug.startsWith('mission-')) {
    const ctx = await loadMissionContext(slug.slice('mission-'.length));
    if (!ctx) return null;
    const body = renderMissionBody(ctx);
    return {
      contentType: 'text/html; charset=utf-8',
      body,
      pageMeta: {
        kind: 'mission',
        slug,
        title: ctx.mission.title,
        description: ctx.mission.description ?? '',
      },
    };
  }

  return null;
}
