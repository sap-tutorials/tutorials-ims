<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { filterSessions, type TechEdSession } from './filter';
import { parseTechEdUrl, toTechEdQuery, type TechEdUrlState } from './url-state';

// --- Feed shapes (see GET /build/teched in srv/server.js) ------------------
interface RawSpeaker { slug: string; name: string; title?: string | null; company?: string | null; bio?: string | null; photoUrl?: string | null; }
interface RawTrack { slug: string; name: string; venue?: string | null; description?: string | null; }
interface TechEdFeed { sessions: TechEdSession[]; speakers: RawSpeaker[]; tracks: RawTrack[]; }

const loading = ref(true);
const error = ref('');
const speakers = ref<RawSpeaker[]>([]);
const tracks = ref<RawTrack[]>([]);
const sessions = ref<TechEdSession[]>([]);

const filterQuery = ref('');
const filterVenue = ref('');   // '' | 'BERLIN' | 'VIRTUAL'
const filterTrack = ref('');   // track slug
const filterSpeaker = ref(''); // speaker slug

// --- Deep-linking ----------------------------------------------------------
// The page URL is the source of truth on first load. Parse it once and apply
// synchronously (all facets are feed-independent). Suppress URL writes until
// the incoming link has been applied.
const initialUrl = parseTechEdUrl(typeof window !== 'undefined' ? window.location.search : '');
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
  if (el?.textContent && el.textContent.trim()) {
    return JSON.parse(el.textContent) as TechEdFeed;
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
    const trackNameBySlug = new Map(rawTracks.map((t) => [t.slug, t.name]));

    // Enrich each session with resolved speaker names + track name so the pure
    // filter can search over them without re-plumbing the lookup maps.
    sessions.value = (feed.sessions || []).map((s) => ({
      ...s,
      trackName: s.track ? trackNameBySlug.get(s.track) ?? null : null,
      speakerNames: (s.speakers || []).map((slug) => speakerNameBySlug.get(slug)).filter(Boolean) as string[],
    }));
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

// Speaker dropdown: only speakers that appear on a session, name-sorted.
const speakerOptions = computed(() => {
  const used = new Set<string>();
  sessions.value.forEach((s) => (s.speakers || []).forEach((slug) => used.add(slug)));
  return speakers.value
    .filter((s) => used.has(s.slug))
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
});

// All facets (venue, track, speaker, query) applied in one pass to produce
// the unified session list rendered in a single grid.
const filtered = computed(() => filterSessions(sessions.value, {
  venue: filterVenue.value,
  track: filterTrack.value,
  speaker: filterSpeaker.value,
  query: filterQuery.value,
}));

const visibleCount = computed(() => filtered.value.length);

const hasActiveFilters = computed(() =>
  !!(filterQuery.value || filterVenue.value || filterTrack.value || filterSpeaker.value),
);

function speakerNamesFor(s: TechEdSession): string {
  return (s.speakerNames && s.speakerNames.length ? s.speakerNames : (s.speakers || [])).join(', ');
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
}

function onPopState() { applyFromUrl(parseTechEdUrl(window.location.search)); }

onMounted(async () => {
  window.addEventListener('popstate', onPopState);
  await loadData();
  applied = true;
  writeUrl();
});

onBeforeUnmount(() => window.removeEventListener('popstate', onPopState));

watch([filterQuery, filterVenue, filterTrack, filterSpeaker], writeUrl);
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
          :aria-pressed="filterTrack === t.slug"
          @click="toggleTrack(t.slug)"
        >{{ t.name }}</button>
      </div>

      <!-- empty -->
      <div v-if="visibleCount === 0" class="tsg-state tsg-state--empty">
        No sessions match your filters.
      </div>

      <!-- unified sessions grid -->
      <section v-if="filtered.length" class="tsg-section" aria-label="TechEd Sessions">
        <div class="tsg-grid">
          <article v-for="s in filtered" :key="s.slug" class="tsg-card">
            <div class="tsg-card-body">
              <div class="tsg-badges">
                <span v-if="s.venue === 'BERLIN'" class="tsg-badge tsg-badge--berlin">Berlin</span>
                <span v-else-if="s.venue === 'VIRTUAL'" class="tsg-badge tsg-badge--virtual">Virtual</span>
                <span v-if="s.trackName" class="tsg-badge tsg-badge--track">{{ s.trackName }}</span>
                <span v-if="s.sessionCode" class="tsg-badge tsg-badge--code">{{ s.sessionCode }}</span>
              </div>
              <h3 class="tsg-card-title">{{ s.title }}</h3>
              <p v-if="formatStart(s.scheduledStart)" class="tsg-meta">
                {{ formatStart(s.scheduledStart) }}<template v-if="s.room"> · {{ s.room }}</template>
              </p>
              <p v-if="speakerNamesFor(s)" class="tsg-speakers">{{ speakerNamesFor(s) }}</p>
              <p v-if="s.abstract" class="tsg-abstract">{{ s.abstract }}</p>
              <div class="tsg-links">
                <a v-if="s.url" :href="safeHref(s.url)" target="_blank" rel="noopener noreferrer" class="tsg-link">↗ Session page</a>
                <a v-if="s.youtubeUrl" :href="safeHref(s.youtubeUrl)" target="_blank" rel="noopener noreferrer" class="tsg-link tsg-link--yt">▶ Watch</a>
              </div>
            </div>
          </article>
        </div>
      </section>
    </template>
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
.tsg-badge--track { background: var(--sapNeutralBackground, #f5f6f7); color: var(--sapContent_LabelColor, #6a6d70); }
.tsg-badge--code { background: transparent; color: var(--sapContent_LabelColor, #6a6d70); border: 1px solid var(--sapField_BorderColor, #89919a); }

.tsg-card-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  line-height: 1.35;
}

.tsg-meta, .tsg-speakers { font-size: 0.8rem; color: var(--sapContent_LabelColor, #6a6d70); margin: 0; }
.tsg-speakers { font-weight: 600; }

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
</style>
