// #1782 — fetch the Top Tutorials payload and build source-labelled carousel
// slides. Card markup mirrors card-tutorial.html / useHydrate.buildTutorialHtml
// but adds a "Top Tutorial" source label + a localized completions count.
import type { SlideData } from './useHydrate';

export interface TopTutorialItem {
  rank: number; slug: string; completions: number;
  card: { slug: string; title: string; description: string; level: string | null; time: number | null; primaryTag: string | null; href: string; isNew: boolean };
}
export interface TopTutorialWindow { windowDays: number; items: TopTutorialItem[]; }

const FOLDER_SVG = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 13V3h4l2 2h6v8H2z"></path></svg>`;
const CLOCK_SVG  = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6.5"></circle><path d="M8 4.5V8l2.5 1.5"></path></svg>`;
const TAG_SVG    = `<svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h5l7 7-5 5-7-7V3zm3 2a1 1 0 100 2 1 1 0 000-2z"></path></svg>`;

function esc(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function capFirst(s: string): string { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function formatTime(mins: number): string {
  const m = Math.round(mins);
  if (m < 60) return `${m} min.`;
  const h = Math.floor(m / 60); const rem = m % 60;
  return rem > 0 ? `${h} hr. ${rem} min.` : `${h} hr.`;
}

/** Card markup for a Top Tutorial: source label + completions count. */
function buildTopTutorialCardHtml(it: TopTutorialItem): string {
  const c = it.card;
  const levelLabel = capFirst(c.level || '');
  const timeLabel  = formatTime(Number(c.time) || 0);
  const count      = Number(it.completions || 0).toLocaleString('en-US');
  return `<a href="${esc(c.href || (c.slug ? `/tutorials/${encodeURIComponent(c.slug)}/` : '#'))}" class="nav-card" data-vt-card="navigator">
<div class="nav-card__type nav-card__type--tutorial">Top Tutorial</div>
<h3 class="nav-card__title">${esc(c.title || '')}</h3>
<p class="nav-card__desc">${esc(c.description || '')}</p>
<div class="nav-card__meta">
<span class="nav-card__meta-item">${FOLDER_SVG} ${esc(levelLabel)}</span>
<span class="nav-card__meta-sep">&middot;</span>
<span class="nav-card__meta-item">${CLOCK_SVG} ${esc(timeLabel)}</span>
<span class="nav-card__meta-sep">&middot;</span>
<span class="nav-card__meta-item">${esc(count)} completed</span>
</div>
<div class="nav-card__tag">${TAG_SVG} ${esc(c.primaryTag || '')}</div>
</a>`;
}

/** Pure — build carousel slides for one window from the fetched payload. */
export function buildTopTutorialSlides(windows: TopTutorialWindow[], windowDays: number, chunkSize = 4): SlideData[] {
  const win = (windows || []).find(w => w.windowDays === windowDays);
  const items = win?.items ?? [];
  const slides: SlideData[] = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    slides.push({
      conceptSlug: `top-${windowDays}-${i / chunkSize}`,
      displayTitle: `Top Tutorials · Last ${windowDays} days`,
      missionsHtml: items.slice(i, i + chunkSize).map(buildTopTutorialCardHtml).join(''),
    });
  }
  return slides;
}

/** Fetch all three windows once. Returns [] on any error/304 (fail-open). */
export async function fetchTopTutorials(): Promise<TopTutorialWindow[]> {
  try {
    const res = await fetch('/homepage/topTutorials()', { headers: { Accept: 'application/json' }, credentials: 'include' });
    if (!res.ok) return [];
    const body = await res.json();
    return body.windows ?? body.value?.[0]?.windows ?? [];
  } catch {
    return [];
  }
}
