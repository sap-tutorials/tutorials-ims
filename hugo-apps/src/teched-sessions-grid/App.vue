<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { filterSessions, type TechEdSession } from './filter';
import { parseTechEdUrl, toTechEdQuery, type TechEdUrlState } from './url-state';
import { buildTrackColorMap, type TrackColor } from '../devtoberfest-sessions-calendar/track-colors';
import RelatedSessions from './RelatedSessions.vue';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';

// --- Feed shapes (see GET /build/teched in srv/server.js) ------------------
interface RawSpeaker { slug: string; name: string; title?: string | null; company?: string | null; bio?: string | null; photoUrl?: string | null; authorLogin?: string | null; }
interface RawTrack { slug: string; name: string; venue?: string | null; description?: string | null; }
interface TechEdFeed { sessions: TechEdSession[]; speakers: RawSpeaker[]; tracks: RawTrack[]; }
/** Per-session speaker link, pre-computed once in loadData so the template avoids double calls. */
interface SpeakerLink { slug: string; name: string; authorLogin?: string | null; }
/** Speaker card shape used by DetailPanel (Unit 2). */
interface EnrichedSpeaker { id: string; name: string; role?: string; company?: string; photoUrl?: string; authorLogin?: string; bio?: string; }
/** Enriched session carrying pre-resolved display fields. */
interface EnrichedSession extends TechEdSession { speakerLinks?: SpeakerLink[]; speakersEnriched?: EnrichedSpeaker[]; }

const loading = ref(true);
const error = ref('');
const speakers = ref<RawSpeaker[]>([]);
const tracks = ref<RawTrack[]>([]);
const sessions = ref<EnrichedSession[]>([]);

const filterQuery = ref('');
const filterVenue = ref('');   // '' | 'BERLIN' | 'VIRTUAL'
const filterTrack = ref('');   // track slug
const filterSpeaker = ref(''); // speaker slug
const selectedRow = ref<TechEdSession | null>(null);

// --- Deep-linking ----------------------------------------------------------
// The page URL is the source of truth on first load. Parse it once and apply
// synchronously (all facets are feed-independent). Suppress URL writes until
// the incoming link has been applied.
const initialUrl = parseTechEdUrl(typeof window !== 'undefined' ? window.location.search : '');
// One-shot session deep-link: consumed on first load after feed is available.
let pendingSession: string | null = initialUrl.session;
let applied = false;
if (initialUrl.q) filterQuery.value = initialUrl.q;
if (initialUrl.venue) filterVenue.value = initialUrl.venue;
if (initialUrl.track) filterTrack.value = initialUrl.track;
if (initialUrl.speaker) filterSpeaker.value = initialUrl.speaker;

/**
 * Load the TechEd feed. Prefers an embedded `<script id="teched-data">` JSON
 * blob (baked by the /teched/ Hugo page, Unit 7) — same pattern as
 * channels-directory — and falls back to fetching the public /build/teched
 * endpoint so the island works standalone.
 */
async function loadFeed(): Promise<TechEdFeed> {
  const el = typeof document !== 'undefined' ? document.getElementById('teched-data') : null;
  // Hugo's jsonify of a nil .Site.Data.teched emits the literal string "null" —
  // truthy and non-empty, but JSON.parse("null") returns null, which then throws
  // on feed.speakers below. Treat "null" as absent and fall through to /build/teched.
  const text = el?.textContent?.trim();
  if (text && text !== 'null') {
    return JSON.parse(text) as TechEdFeed;
  }
  const r = await fetch('/build/teched', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`teched ${r.status}`);
  return r.json();
}

async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    const feed = await loadFeed();
    const rawSpeakers = feed.speakers || [];
    const rawTracks = feed.tracks || [];
    speakers.value = rawSpeakers;
    tracks.value = rawTracks;

    const speakerNameBySlug = new Map(rawSpeakers.map((s) => [s.slug, s.name]));
    const speakerBySlug = new Map(rawSpeakers.map((s) => [s.slug, s]));
    const trackNameBySlug = new Map(rawTracks.map((t) => [t.slug, t.name]));

    // Enrich each session with resolved speaker names + track name so the pure
    // filter can search over them without re-plumbing the lookup maps.
    // Also build a speakersEnriched array (objects with name/role/company/photoUrl)
    // so the DetailPanel can render speaker cards.
    // speakerLinks is pre-computed here so the template never calls speakerLinksFor twice.
    sessions.value = (feed.sessions || []).map((s) => {
      const enrichedSpeakers = (s.speakers || [])
        .map((slug) => {
          const sp = speakerBySlug.get(slug);
          if (!sp) return null;
          return { id: sp.slug, name: sp.name, role: sp.title ?? undefined, company: sp.company ?? undefined, photoUrl: sp.photoUrl ?? undefined, authorLogin: sp.authorLogin ?? undefined, bio: sp.bio ?? undefined };
        })
        .filter(Boolean);
      return {
        ...s,
        trackName: s.track ? trackNameBySlug.get(s.track) ?? null : null,
        speakerNames: (s.speakers || []).map((slug) => speakerNameBySlug.get(slug)).filter(Boolean) as string[],
        speakersEnriched: enrichedSpeakers,
        speakerLinks: (s.speakers || []).map((slug) => {
          const sp = speakerBySlug.get(slug);
          return { slug, name: sp?.name ?? slug, authorLogin: sp?.authorLogin ?? null };
        }),
      };
    });

    // Session deep-link: open its detail panel (first load only).
    if (pendingSession) {
      const row = sessions.value.find((r) => r.slug === pendingSession);
      if (row) selectedRow.value = row;
      pendingSession = null;
    }
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load TechEd sessions.';
  } finally {
    loading.value = false;
  }
}

// Track chips: only tracks that actually appear on a session, name-sorted.
const trackOptions = computed(() => {
  const used = new Set<string>();
  sessions.value.forEach((s) => { if (s.track) used.add(s.track); });
  return tracks.value
    .filter((t) => used.has(t.slug))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
});

// Color map over tracks that actually appear on sessions (same set as trackOptions).
// Colors are stable across filter changes because they're built from the full used-track set.
const colorMap = computed(() =>
  buildTrackColorMap(trackOptions.value.map((t) => ({ name: t.name }))),
);

// Returns inline style for the track badge given a track name. Falls back to
// undefined (CSS class handles neutral styling) when the name is absent.
function trackBadgeStyle(trackName: string | null | undefined): Record<string, string> | undefined {
  if (!trackName) return undefined;
  const c: TrackColor | undefined = colorMap.value.get(trackName);
  if (!c) return undefined;
  return { background: c.bg, borderColor: c.border, color: c.text };
}

// Speaker dropdown: only speakers that appear on a session, name-sorted.
const speakerOptions = computed(() => {
  const used = new Set<string>();
  sessions.value.forEach((s) => (s.speakers || []).forEach((slug) => used.add(slug)));
  return speakers.value
    .filter((s) => used.has(s.slug))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
});

// All facets (venue, track, speaker, query) applied in one pass. Split into
// all-day activities (e.g. the Developer Garage — issue #2392) and timed
// sessions so they render in distinct sections. Both honor the active filters.
const filtered = computed(() => filterSessions(sessions.value, {
  venue: filterVenue.value,
  track: filterTrack.value,
  speaker: filterSpeaker.value,
  query: filterQuery.value,
}));

const filteredAllDay = computed(() => filtered.value.filter((s) => s.allDay === true));
const filteredTimed = computed(() => filtered.value.filter((s) => s.allDay !== true));

const visibleCount = computed(() => filtered.value.length);

const hasActiveFilters = computed(() =>
  !!(filterQuery.value || filterVenue.value || filterTrack.value || filterSpeaker.value),
);

function speakerNamesFor(s: TechEdSession): string {
  return (s.speakerNames && s.speakerNames.length ? s.speakerNames : (s.speakers || [])).join(', ');
}

function openCard(s: TechEdSession) {
  selectedRow.value = s;
}

function onCardKeydown(e: KeyboardEvent, s: TechEdSession) {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    openCard(s);
  }
}

function onDocKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape' && selectedRow.value) {
    selectedRow.value = null;
  }
}


function formatStart(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  try {
    return d.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return d.toISOString(); }
}

function safeHref(url: string | null | undefined): string {
  if (!url) return '#';
  return /^https?:\/\//i.test(url) ? url : '#';
}

function toggleTrack(slug: string) {
  filterTrack.value = filterTrack.value === slug ? '' : slug;
}

function clearFilters() {
  filterQuery.value = '';
  filterVenue.value = '';
  filterTrack.value = '';
  filterSpeaker.value = '';
}

// --- URL sync --------------------------------------------------------------
function currentUrlState(): TechEdUrlState {
  return {
    q: filterQuery.value || null,
    venue: filterVenue.value || null,
    track: filterTrack.value || null,
    speaker: filterSpeaker.value || null,
    session: selectedRow.value?.slug ?? null,
  };
}

function writeUrl() {
  if (!applied || typeof window === 'undefined') return;
  const qs = toTechEdQuery(currentUrlState());
  window.history.replaceState({}, '', `${window.location.pathname}${qs}${window.location.hash}`);
}

function applyFromUrl(st: TechEdUrlState) {
  filterQuery.value = st.q ?? '';
  filterVenue.value = st.venue ?? '';
  filterTrack.value = st.track ?? '';
  filterSpeaker.value = st.speaker ?? '';
  if (st.session) {
    const row = sessions.value.find((r) => r.slug === st.session);
    selectedRow.value = row ?? null;
  } else {
    selectedRow.value = null;
  }
}

function onPopState() {
  // A popstate event overrides any pending deep-link session so back/forward
  // navigation always wins over the original URL's session param.
  pendingSession = null;
  applyFromUrl(parseTechEdUrl(window.location.search));
}

onMounted(async () => {
  window.addEventListener('popstate', onPopState);
  window.addEventListener('keydown', onDocKeydown);
  await loadData();
  applied = true;
  writeUrl();
});

onBeforeUnmount(() => {
  window.removeEventListener('popstate', onPopState);
  window.removeEventListener('keydown', onDocKeydown);
});

watch([filterQuery, filterVenue, filterTrack, filterSpeaker, selectedRow], writeUrl);
</script>

<template>
  <div class="tsg-wrap">
    <div v-if="loading" class="tsg-state">Loading TechEd sessions…</div>

    <div v-else-if="error" class="tsg-state tsg-state--error" role="alert">
      Could not load TechEd sessions: {{ error }}
    </div>

    <template v-else>
      <!-- filters -->
      <div class="tsg-toolbar" role="search">
        <label class="tsg-field tsg-field--search">
          <span>Search</span>
          <input
            type="search"
            v-model="filterQuery"
            placeholder="Title, abstract, speaker, track…"
            aria-label="Search TechEd sessions by keyword"
          />
        </label>

        <div class="tsg-field">
          <span id="tsg-venue-label">Venue</span>
          <div class="tsg-venue-toggle" role="group" aria-labelledby="tsg-venue-label">
            <button
              type="button"
              class="tsg-toggle-btn"
              :class="{ 'tsg-toggle-btn--active': filterVenue === '' }"
              :aria-pressed="filterVenue === ''"
              @click="filterVenue = ''"
            >All</button>
            <button
              type="button"
              class="tsg-toggle-btn"
              :class="{ 'tsg-toggle-btn--active': filterVenue === 'BERLIN' }"
              :aria-pressed="filterVenue === 'BERLIN'"
              @click="filterVenue = 'BERLIN'"
            >Berlin</button>
            <button
              type="button"
              class="tsg-toggle-btn"
              :class="{ 'tsg-toggle-btn--active': filterVenue === 'VIRTUAL' }"
              :aria-pressed="filterVenue === 'VIRTUAL'"
              @click="filterVenue = 'VIRTUAL'"
            >Virtual</button>
          </div>
        </div>

        <label v-if="speakerOptions.length" class="tsg-field">
          <span>Speaker</span>
          <select v-model="filterSpeaker" aria-label="Filter by speaker">
            <option value="">All speakers</option>
            <option v-for="sp in speakerOptions" :key="sp.slug" :value="sp.slug">{{ sp.name }}</option>
          </select>
        </label>

        <button
          v-if="hasActiveFilters"
          type="button"
          class="tsg-btn-ghost"
          @click="clearFilters"
        >Clear</button>

        <span class="tsg-count">{{ visibleCount }} session{{ visibleCount === 1 ? '' : 's' }}</span>
      </div>

      <!-- track facet chips -->
      <div v-if="trackOptions.length" class="tsg-chips" role="group" aria-label="Filter by track">
        <button
          v-for="t in trackOptions"
          :key="t.slug"
          type="button"
          class="tsg-chip"
          :class="{ 'tsg-chip--active': filterTrack === t.slug }"
          :style="filterTrack === t.slug ? trackBadgeStyle(t.name) : undefined"
          :aria-pressed="filterTrack === t.slug"
          @click="toggleTrack(t.slug)"
        ><span class="tsg-chip-dot" :style="{ background: colorMap.get(t.name)?.border }" aria-hidden="true"></span>{{ t.name }}</button>
      </div>

      <!-- empty -->
      <div v-if="visibleCount === 0" class="tsg-state tsg-state--empty">
        No sessions match your filters.
      </div>

      <!-- all-day activities (e.g. the Developer Garage) — a distinct section
           above the timed grid (issue #2392). Same card, no scheduled time. -->
      <section v-if="filteredAllDay.length" class="tsg-section tsg-section--allday" aria-label="All-day activities">
        <h2 class="tsg-section-title">All-day activities</h2>
        <div class="tsg-grid">
          <article
            v-for="s in filteredAllDay"
            :key="s.slug"
            class="tsg-card tsg-card--clickable tsg-card--allday"
            role="button"
            tabindex="0"
            :aria-label="`Open details for ${s.title}`"
            @click="openCard(s)"
            @keydown="onCardKeydown($event, s)"
          >
            <div class="tsg-card-body">
              <div class="tsg-badges">
                <span class="tsg-badge tsg-badge--allday">All-day</span>
                <span v-if="s.venue === 'BERLIN'" class="tsg-badge tsg-badge--berlin">Berlin</span>
                <span v-else-if="s.venue === 'VIRTUAL'" class="tsg-badge tsg-badge--virtual">Virtual</span>
                <span
                  v-if="s.trackName"
                  class="tsg-badge tsg-badge--track"
                  :style="trackBadgeStyle(s.trackName)"
                >{{ s.trackName }}</span>
              </div>
              <h3 class="tsg-card-title">{{ s.title }}</h3>
              <p v-if="s.room" class="tsg-meta">{{ s.room }}</p>
              <p v-if="s.speakerLinks?.length" class="tsg-speakers">
                <template v-for="(sp, i) in s.speakerLinks" :key="sp.slug">
                  <template v-if="i > 0">, </template>
                  <a v-if="sp.authorLogin" :href="`/authors/${sp.authorLogin}/`" class="tsg-speaker-link">{{ sp.name }}</a>
                  <span v-else>{{ sp.name }}</span>
                </template>
              </p>
              <p v-if="s.abstract" class="tsg-abstract">{{ s.abstract }}</p>
              <div class="tsg-links" @click.stop>
                <a v-if="s.url" :href="safeHref(s.url)" target="_blank" rel="noopener noreferrer" class="tsg-link">↗ Activity page</a>
              </div>
            </div>
          </article>
        </div>
      </section>

      <!-- timed sessions grid -->
      <section v-if="filteredTimed.length" class="tsg-section" aria-label="TechEd Sessions">
        <h2 v-if="filteredAllDay.length" class="tsg-section-title">Sessions</h2>
        <div class="tsg-grid">
          <article
            v-for="s in filteredTimed"
            :key="s.slug"
            class="tsg-card tsg-card--clickable"
            role="button"
            tabindex="0"
            :aria-label="`Open details for ${s.title}`"
            @click="openCard(s)"
            @keydown="onCardKeydown($event, s)"
          >
            <div class="tsg-card-body">
              <div class="tsg-badges">
                <span v-if="s.venue === 'BERLIN'" class="tsg-badge tsg-badge--berlin">Berlin</span>
                <span v-else-if="s.venue === 'VIRTUAL'" class="tsg-badge tsg-badge--virtual">Virtual</span>
                <span
                  v-if="s.trackName"
                  class="tsg-badge tsg-badge--track"
                  :style="trackBadgeStyle(s.trackName)"
                >{{ s.trackName }}</span>
                <span v-if="s.sessionCode" class="tsg-badge tsg-badge--code">{{ s.sessionCode }}</span>
              </div>
              <h3 class="tsg-card-title">{{ s.title }}</h3>
              <p v-if="formatStart(s.scheduledStart)" class="tsg-meta">
                {{ formatStart(s.scheduledStart) }}<template v-if="s.room"> · {{ s.room }}</template>
              </p>
              <p v-if="s.speakerLinks?.length" class="tsg-speakers">
                <template v-for="(sp, i) in s.speakerLinks" :key="sp.slug">
                  <template v-if="i > 0">, </template>
                  <a v-if="sp.authorLogin" :href="`/authors/${sp.authorLogin}/`" class="tsg-speaker-link">{{ sp.name }}</a>
                  <span v-else>{{ sp.name }}</span>
                </template>
              </p>
              <p v-if="s.abstract" class="tsg-abstract">{{ s.abstract }}</p>
              <div class="tsg-links" @click.stop>
                <a v-if="s.url" :href="safeHref(s.url)" target="_blank" rel="noopener noreferrer" class="tsg-link">↗ Session page</a>
                <a v-if="s.youtubeUrl" :href="safeHref(s.youtubeUrl)" target="_blank" rel="noopener noreferrer" class="tsg-link tsg-link--yt">▶ Watch</a>
              </div>
              <RelatedSessions v-if="s.relatedDevtoberfestSessions?.length" :sessions="s.relatedDevtoberfestSessions" />
            </div>
          </article>
        </div>
      </section>
    </template>

    <!-- Detail panel — renders as a fixed overlay when a card is selected -->
    <DetailPanel :row="(selectedRow as any)" source="teched" @close="selectedRow = null" />
  </div>
</template>
<style scoped>
.tsg-wrap {
  font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif);
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.tsg-state {
  padding: 2rem;
  text-align: center;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.tsg-state--error { color: var(--sapNegativeColor, #b00020); }

.tsg-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.tsg-field {
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
}

.tsg-field span {
  margin-bottom: 0.25rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.tsg-field select,
.tsg-field input[type="search"] {
  min-width: 12rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
}

.tsg-field--search { flex: 1 1 16rem; }
.tsg-field--search input[type="search"] { width: 100%; min-width: 16rem; }

.tsg-venue-toggle { display: inline-flex; }

.tsg-toggle-btn {
  padding: 0.35rem 0.85rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.tsg-toggle-btn:first-child { border-radius: 0.25rem 0 0 0.25rem; }
.tsg-toggle-btn:last-child { border-radius: 0 0.25rem 0.25rem 0; }
.tsg-toggle-btn:not(:first-child) { border-left: none; }
.tsg-toggle-btn--active {
  background: var(--sapButton_Emphasized_Background, #0854a0);
  color: #fff;
  border-color: var(--sapButton_Emphasized_Background, #0854a0);
}

.tsg-btn-ghost {
  padding: 0.4rem 0.9rem;
  border-radius: 0.25rem;
  background: transparent;
  color: var(--sapLinkColor, #0854a0);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  cursor: pointer;
  font: inherit;
}

.tsg-count {
  margin-left: auto;
  align-self: flex-end;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.tsg-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.tsg-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.2rem 0.7rem;
  border-radius: 20px;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
  font-size: 0.8rem;
  cursor: pointer;
}
.tsg-chip--active {
  background: var(--sapInformativeBackground, #e8f3ff);
  color: var(--sapInformativeColor, #0854a0);
  border-color: var(--sapInformativeColor, #0854a0);
}
.tsg-chip-dot {
  width: 0.55rem;
  height: 0.55rem;
  border-radius: 50%;
  display: inline-block;
  flex-shrink: 0;
  vertical-align: middle;
}

.tsg-section { display: flex; flex-direction: column; gap: 0.75rem; }

.tsg-section-title {
  font-size: var(--sapFontHeader3Size, 1.25rem);
  font-weight: 700;
  margin: 0;
  color: var(--sapTextColor, #32363a);
}

.tsg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: var(--sapContent_Gap, 1rem);
}

.tsg-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
  border-radius: 8px;
  background: var(--sapBaseColor, #fff);
  overflow: hidden;
}

.tsg-card-body {
  padding: 0.85rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  flex: 1;
}

.tsg-badges { display: flex; flex-wrap: wrap; gap: 0.35rem; align-items: center; }

.tsg-badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}
.tsg-badge--berlin { background: var(--sapInformativeBackground, #e8f3ff); color: var(--sapInformativeColor, #0854a0); }
.tsg-badge--virtual { background: var(--sapNeutralBackground, #f5f6f7); color: var(--sapContent_LabelColor, #6a6d70); }
.tsg-badge--allday { background: var(--sapSuccessBackground, #e5f2d7); color: var(--sapPositiveColor, #256f3a); }
/* border-color is overridden inline per-track via trackBadgeStyle(); needs border-width to render */
.tsg-badge--track { background: var(--sapNeutralBackground, #f5f6f7); color: var(--sapContent_LabelColor, #6a6d70); border: 1px solid transparent; }
.tsg-badge--code { background: transparent; color: var(--sapContent_LabelColor, #6a6d70); border: 1px solid var(--sapField_BorderColor, #89919a); }

.tsg-card-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  line-height: 1.35;
}

.tsg-meta, .tsg-speakers { font-size: 0.8rem; color: var(--sapContent_LabelColor, #6a6d70); margin: 0; }
.tsg-speakers { font-weight: 600; }
.tsg-speaker-link { color: inherit; text-decoration: underline; text-decoration-color: var(--sapLinkColor, #0854a0); }
.tsg-speaker-link:hover { color: var(--sapLinkColor, #0854a0); }

.tsg-abstract {
  font-size: 0.85rem;
  margin: 0;
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tsg-links { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: auto; padding-top: 0.5rem; }

.tsg-link {
  display: inline-block;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--sapLinkColor, #0854a0);
  border: 1px solid currentColor;
  background: transparent;
}
.tsg-link:hover { background: var(--sapHighlightColor, #0854a0); color: #fff; }
.tsg-link--yt { color: #c4302b; border-color: #c4302b; }
.tsg-link--yt:hover { background: #c4302b; color: #fff; }

.tsg-card--clickable {
  cursor: pointer;
}
.tsg-card--clickable:hover {
  border-color: var(--sapButton_Emphasized_Background, #0854a0);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}
.tsg-card--clickable:focus-visible {
  outline: 2px solid var(--sapContent_FocusColor, #0854a0);
  outline-offset: 2px;
}
</style>
