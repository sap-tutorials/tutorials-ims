import { onMounted } from 'vue';

export interface SlideData {
  conceptSlug: string;
  displayTitle: string;
  missionsHtml: string;
}

export interface UseHydrateOptions {
  etag: string;
  onFresh: (slides: SlideData[]) => void;
}

/** Formats minutes into a label like "30 min." or "1 hr. 30 min." */
function formatTime(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m} min.`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem > 0 ? `${h} hr. ${rem} min.` : `${h} hr.`;
}

/** Capitalises first character of a string. */
function capFirst(s: string): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

const FOLDER_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"></path></svg>`;
const CLOCK_SVG  = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 4.5V8l2.5 1.5"></path></svg>`;
const TAG_SVG    = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"></path></svg>`;

function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Build card-mission HTML mirroring card-mission.html partial. */
function buildMissionHtml(m: Record<string, any>): string {
  const levelLabel = capFirst(m.level || '');
  const timeLabel  = formatTime(Number(m.time) || 0);
  const tutCount   = m.tutorialCount ? `<span class="nav-card__meta-sep">&middot;</span><span class="nav-card__meta-item">${m.tutorialCount} Tutorials</span>` : '';
  return `<a href="${esc(m.href || (m.slug ? `/tutorials/${encodeURIComponent(m.slug)}/` : '#'))}" class="nav-card" data-vt-card="navigator">
<div class="nav-card__type nav-card__type--mission">MISSION</div>
<h3 class="nav-card__title">${esc(m.title || '')}</h3>
<p class="nav-card__desc">${esc(m.description || '')}</p>
<div class="nav-card__meta">
<span class="nav-card__meta-item">${FOLDER_SVG} ${esc(levelLabel)}</span>
<span class="nav-card__meta-sep">&middot;</span>
<span class="nav-card__meta-item">${CLOCK_SVG} ${esc(timeLabel)}</span>
${tutCount}
</div>
<div class="nav-card__tag">${TAG_SVG} ${esc(m.primaryTag || '')}</div>
</a>`;
}

/** Build card-tutorial HTML mirroring card-tutorial.html partial. */
function buildTutorialHtml(m: Record<string, any>): string {
  const levelLabel  = capFirst(m.level || '');
  const timeLabel   = formatTime(Number(m.time) || 0);
  const newBadge    = m.isNew ? `<span class="nav-card__new-badge" aria-label="New tutorial">NEW</span>` : '';
  const newClass    = m.isNew ? ' nav-card--new' : '';
  return `<a href="${esc(m.href || (m.slug ? `/tutorials/${encodeURIComponent(m.slug)}/` : '#'))}" class="nav-card${newClass}" data-vt-card="navigator">
${newBadge}<div class="nav-card__type nav-card__type--tutorial">TUTORIAL</div>
<h3 class="nav-card__title">${esc(m.title || '')}</h3>
<p class="nav-card__desc">${esc(m.description || '')}</p>
<div class="nav-card__meta">
<span class="nav-card__meta-item">${FOLDER_SVG} ${esc(levelLabel)}</span>
<span class="nav-card__meta-sep">&middot;</span>
<span class="nav-card__meta-item">${CLOCK_SVG} ${esc(timeLabel)}</span>
</div>
<div class="nav-card__tag">${TAG_SVG} ${esc(m.primaryTag || '')}</div>
</a>`;
}

function buildCardHtml(m: Record<string, any>): string {
  if (m.kind === 'tutorial') return buildTutorialHtml(m);
  return buildMissionHtml(m);
}

export function useHydrate(opts: UseHydrateOptions): void {
  onMounted(async () => {
    try {
      const headers: Record<string, string> = { Accept: 'application/json' };
      if (opts.etag) headers['If-None-Match'] = opts.etag;
      const res = await fetch('/api/homepage/featuredTopics()', { headers });
      if (res.status === 304) return;
      if (!res.ok) return;
      const body = await res.json();
      // Accept both OData wrapper and raw snapshot shapes.
      const raw: any[] = body.snapshot ?? body.value?.[0]?.snapshot ?? [];
      const slides: SlideData[] = raw
        .filter((s) => s && s.conceptSlug)
        .map((s) => ({
          conceptSlug: s.conceptSlug,
          displayTitle: s.displayTitle || '',
          missionsHtml: (s.missions || []).map(buildCardHtml).join(''),
        }));
      if (slides.length) opts.onFresh(slides);
    } catch {
      // Silently keep SSR content on any fetch/parse error.
    }
  });
}
