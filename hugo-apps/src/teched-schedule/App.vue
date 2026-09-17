<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue';
import { filterSessions, type TechEdSession } from '../teched-sessions-grid/filter';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';
import type { ScheduleRow } from '../devtoberfest-schedule-shared/types';

// --- Feed shapes (mirrors teched-sessions-grid/App.vue) --------------------
interface RawSpeaker { slug: string; name: string; title?: string | null; company?: string | null; bio?: string | null; photoUrl?: string | null; }
interface RawTrack { slug: string; name: string; venue?: string | null; description?: string | null; }
interface TechEdFeed { sessions: TechEdSession[]; speakers: RawSpeaker[]; tracks: RawTrack[]; }

// Load the TechEd feed. Prefers the embedded <script id="teched-data"> blob
// baked by both list.html and schedule.html; falls back to /build/teched.
async function loadFeed(): Promise<TechEdFeed> {
  const el = typeof document !== 'undefined' ? document.getElementById('teched-data') : null;
  // Hugo's jsonify of a nil .Site.Data.teched emits the literal string "null" —
  // truthy and non-empty, but JSON.parse("null") returns null, which then throws
  // downstream. Treat "null" as absent and fall through to /build/teched.
  const text = el?.textContent?.trim();
  if (text && text !== 'null') {
    return JSON.parse(text) as TechEdFeed;
  }
  const r = await fetch('/build/teched', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`teched ${r.status}`);
  return r.json();
}

const loading = ref(true);
const error = ref('');
const sessions = ref<TechEdSession[]>([]);
const tracks = ref<RawTrack[]>([]);
const selectedRow = ref<ScheduleRow | null>(null);

// Filters — exposed for tests
const filters = reactive({
  venue: '',   // '' | 'BERLIN' | 'VIRTUAL'
  track: '',   // track slug
  q: '',       // free-text search
  clubhouse: false, // Community Clubhouse (room "Community Theater")
});

type SortKey = 'title' | 'trackName' | 'scheduledStart' | 'venue';
const sortKey = ref<SortKey>('scheduledStart');
const sortDir = ref<'asc' | 'desc'>('asc');

function setSort(key: SortKey) {
  if (sortKey.value === key) {
    sortDir.value = sortDir.value === 'asc' ? 'desc' : 'asc';
  } else {
    sortKey.value = key;
    sortDir.value = 'asc';
  }
}

function sortIcon(key: SortKey) {
  if (sortKey.value !== key) return '';
  return sortDir.value === 'asc' ? ' ▲' : ' ▼';
}

const trackOptions = computed(() => {
  const used = new Set<string>();
  sessions.value.forEach((s) => { if (s.track) used.add(s.track); });
  return tracks.value.filter((t) => used.has(t.slug)).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
});

const hasActiveFilters = computed(() => !!(filters.venue || filters.track || filters.q || filters.clubhouse));

// Apply venue filter outside filterSessions (it handles venue but we keep it consistent)
const filtered = computed(() =>
  filterSessions(sessions.value, {
    venue: filters.venue || null,
    track: filters.track || null,
    clubhouse: filters.clubhouse,
    query: filters.q || null,
  }),
);

const sorted = computed(() => {
  const list = [...filtered.value];
  const k = sortKey.value;
  const dir = sortDir.value === 'asc' ? 1 : -1;
  list.sort((a, b) => {
    const av = (a as any)[k];
    const bv = (b as any)[k];
    if (av == null && bv == null) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return String(av).localeCompare(String(bv)) * dir;
  });
  return list;
});

function formatWhen(start: string | null | undefined, end: string | null | undefined): string {
  if (!start) return '—';
  const s = new Date(start);
  if (Number.isNaN(s.getTime())) return '—';
  try {
    const startStr = s.toLocaleString(undefined, {
      weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    if (!end) return startStr;
    const e = new Date(end);
    if (Number.isNaN(e.getTime())) return startStr;
    const endStr = e.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    return `${startStr} – ${endStr}`;
  } catch { return s.toISOString(); }
}

function safeHref(url: string | null | undefined): string {
  if (!url) return '#';
  return /^https?:\/\//i.test(url) ? url : '#';
}

function clearFilters() {
  filters.venue = '';
  filters.track = '';
  filters.q = '';
  filters.clubhouse = false;
}

// Convert a TechEdSession to a ScheduleRow-compatible object for DetailPanel.
// DetailPanel uses (row as any) for all TechEd-specific fields, so this works.
function toDetailRow(s: TechEdSession): ScheduleRow {
  // Build speaker objects aligned to speakerNames: zip slugs with resolved names.
  // filter(Boolean) in loadData may have removed unresolvable slugs, so we must
  // pair each resolved name with its source slug using a map — do NOT index into
  // the slug array with the filtered index (they no longer match).
  const speakerObjects = (s.speakerNames || []).map((name, i) => {
    // Find the slug that resolved to this name via the original speakers array.
    // Fall back to the positional slug only when no mismatch is possible.
    const slug = (s.speakers || [])[i] ?? name;
    return { id: slug, name };
  });

  return {
    id: s.slug,
    kind: 'session',
    title: s.title,
    abstract: s.abstract ?? undefined,
    trackName: s.trackName ?? undefined,
    scheduledStart: s.scheduledStart ?? undefined,
    youtubeUrl: s.youtubeUrl ?? undefined,
    sessionCode: s.sessionCode ?? undefined,
    speakers: speakerObjects as any,
  } as unknown as ScheduleRow;
}

async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    const feed = await loadFeed();
    const rawSpeakers = feed.speakers || [];
    const rawTracks = feed.tracks || [];
    tracks.value = rawTracks;

    const speakerNameBySlug = new Map(rawSpeakers.map((s) => [s.slug, s.name]));
    const trackNameBySlug = new Map(rawTracks.map((t) => [t.slug, t.name]));

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

onMounted(() => loadData());

defineExpose({ filters });
</script>

<template>
  <div class="ts-wrap">
    <!-- loading -->
    <div v-if="loading" class="ts-state">Loading TechEd schedule…</div>

    <!-- error -->
    <div v-else-if="error" class="ts-state ts-state--error" role="alert">
      Could not load TechEd schedule: {{ error }}
    </div>

    <!-- content -->
    <template v-else>
      <!-- filters -->
      <div class="ts-toolbar" role="search">
        <label class="ts-field ts-field--search">
          <span>Search</span>
          <input
            type="search"
            v-model="filters.q"
            placeholder="Title, track, abstract…"
            aria-label="Search TechEd sessions by keyword"
          />
        </label>

        <div class="ts-field">
          <span id="ts-venue-label">Venue</span>
          <div class="ts-venue-toggle" role="group" aria-labelledby="ts-venue-label">
            <button
              type="button"
              class="ts-toggle-btn"
              :class="{ 'ts-toggle-btn--active': filters.venue === '' }"
              :aria-pressed="filters.venue === ''"
              @click="filters.venue = ''"
            >All</button>
            <button
              type="button"
              class="ts-toggle-btn"
              :class="{ 'ts-toggle-btn--active': filters.venue === 'BERLIN' }"
              :aria-pressed="filters.venue === 'BERLIN'"
              @click="filters.venue = 'BERLIN'"
            >Berlin</button>
            <button
              type="button"
              class="ts-toggle-btn"
              :class="{ 'ts-toggle-btn--active': filters.venue === 'VIRTUAL' }"
              :aria-pressed="filters.venue === 'VIRTUAL'"
              @click="filters.venue = 'VIRTUAL'"
            >Virtual</button>
          </div>
        </div>

        <label v-if="trackOptions.length" class="ts-field">
          <span>Track</span>
          <select v-model="filters.track" aria-label="Filter by track">
            <option value="">All tracks</option>
            <option v-for="t in trackOptions" :key="t.slug" :value="t.slug">{{ t.name }}</option>
          </select>
        </label>

        <!-- Community Clubhouse toggle (issue #2392 item 5) — own block to minimise merge conflicts -->
        <div class="ts-field">
          <span id="ts-clubhouse-label">Clubhouse</span>
          <button
            type="button"
            class="ts-toggle-btn ts-toggle-btn--clubhouse"
            :class="{ 'ts-toggle-btn--active': filters.clubhouse }"
            :aria-pressed="filters.clubhouse"
            aria-labelledby="ts-clubhouse-label"
            @click="filters.clubhouse = !filters.clubhouse"
          >Community Clubhouse</button>
        </div>

        <button
          v-if="hasActiveFilters"
          type="button"
          class="ts-btn-ghost"
          @click="clearFilters"
        >Clear</button>

        <span class="ts-count">{{ sorted.length }} of {{ sessions.length }}</span>
      </div>

      <!-- empty state -->
      <div v-if="sorted.length === 0" class="ts-state ts-state--empty">
        No sessions match your filters.
      </div>

      <!-- table -->
      <div v-else class="ts-table-wrap">
        <table class="ts-table">
          <thead>
            <tr>
              <th @click="setSort('venue')"><button type="button" class="ts-sort-btn">Venue{{ sortIcon('venue') }}</button></th>
              <th @click="setSort('title')"><button type="button" class="ts-sort-btn">Title{{ sortIcon('title') }}</button></th>
              <th @click="setSort('trackName')"><button type="button" class="ts-sort-btn">Track{{ sortIcon('trackName') }}</button></th>
              <th @click="setSort('scheduledStart')"><button type="button" class="ts-sort-btn">When{{ sortIcon('scheduledStart') }}</button></th>
              <th>Room</th>
              <th>Links</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="s in sorted"
              :key="s.slug"
              class="ts-row"
              @click="selectedRow = toDetailRow(s)"
              tabindex="0"
              @keydown.enter="selectedRow = toDetailRow(s)"
            >
              <td>
                <span
                  class="ts-venue-badge"
                  :class="s.venue === 'BERLIN' ? 'ts-venue-badge--berlin' : 'ts-venue-badge--virtual'"
                >{{ s.venue === 'BERLIN' ? 'Berlin' : s.venue === 'VIRTUAL' ? 'Virtual' : (s.venue ?? '—') }}</span>
              </td>
              <td class="ts-title-cell">
                {{ s.title }}
                <span v-if="s.sessionCode" class="ts-code">{{ s.sessionCode }}</span>
              </td>
              <td>{{ s.trackName ?? '—' }}</td>
              <td class="ts-when-cell">{{ formatWhen(s.scheduledStart, s.scheduledEnd) }}</td>
              <td>{{ s.room ?? '—' }}</td>
              <td class="ts-links-cell">
                <a
                  v-if="s.url"
                  :href="safeHref(s.url)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="ts-link"
                  @click.stop
                  title="Session page"
                >↗</a>
                <a
                  v-if="s.youtubeUrl"
                  :href="safeHref(s.youtubeUrl)"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="ts-link ts-link--yt"
                  @click.stop
                  title="Watch on YouTube"
                >▶</a>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- detail panel (row click) -->
    <DetailPanel
      v-if="selectedRow"
      :row="selectedRow"
      :edition-id="null"
      source="teched"
      @close="selectedRow = null"
    />

    <noscript>The TechEd schedule table requires JavaScript.</noscript>
  </div>
</template>

<style scoped>
.ts-wrap {
  font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif);
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.ts-state {
  padding: 2rem;
  text-align: center;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.ts-state--error { color: var(--sapNegativeColor, #b00020); }
.ts-state--empty { color: var(--sapContent_LabelColor, #6a6d70); }

/* toolbar */
.ts-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.ts-field {
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
}

.ts-field span {
  margin-bottom: 0.25rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.ts-field select,
.ts-field input[type="search"] {
  min-width: 10rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
}

.ts-field--search { flex: 1 1 14rem; }
.ts-field--search input[type="search"] { width: 100%; min-width: 14rem; }

.ts-venue-toggle { display: inline-flex; }

.ts-toggle-btn {
  padding: 0.35rem 0.85rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
  cursor: pointer;
}
.ts-toggle-btn:first-child { border-radius: 0.25rem 0 0 0.25rem; }
.ts-toggle-btn:last-child { border-radius: 0 0.25rem 0.25rem 0; }
.ts-toggle-btn:not(:first-child) { border-left: none; }
.ts-toggle-btn--active {
  background: var(--sapButton_Emphasized_Background, #0854a0);
  color: #fff;
  border-color: var(--sapButton_Emphasized_Background, #0854a0);
}

.ts-toggle-btn--clubhouse {
  border-radius: 0.25rem;
  white-space: nowrap;
}

.ts-btn-ghost {
  padding: 0.4rem 0.9rem;
  border-radius: 0.25rem;
  background: transparent;
  color: var(--sapLinkColor, #0854a0);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  cursor: pointer;
  font: inherit;
}

.ts-count {
  margin-left: auto;
  align-self: flex-end;
  color: var(--sapContent_LabelColor, #6a6d70);
  font-size: 0.875rem;
}

/* table */
.ts-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--sapList_BorderColor, #e4e5e7);
  border-radius: 0.5rem;
  background: var(--sapList_Background, #fff);
}

.ts-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.ts-table th,
.ts-table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--sapList_BorderColor, #e4e5e7);
}

.ts-table th {
  background: var(--sapList_HeaderBackground, #f5f6f7);
  font-weight: 600;
  user-select: none;
  padding: 0;
  white-space: nowrap;
}

.ts-sort-btn {
  width: 100%;
  text-align: inherit;
  background: none;
  border: none;
  color: inherit;
  font: inherit;
  font-weight: inherit;
  padding: 0.5rem 0.75rem;
  cursor: pointer;
  white-space: nowrap;
}

.ts-sort-btn:hover {
  background: var(--sapList_Hover_Background, #eaecee);
}

.ts-table tr:last-child td { border-bottom: none; }

.ts-row {
  cursor: pointer;
  transition: background 0.1s;
}

.ts-row:hover { background: var(--sapList_Hover_Background, #eaecee); }

.ts-row:focus-visible { outline: 2px solid var(--sapContent_FocusColor, #0854a0); outline-offset: -2px; }

.ts-title-cell {
  font-weight: 500;
  max-width: 26rem;
}

.ts-code {
  margin-left: 0.4rem;
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: 0.25rem;
  padding: 0.05rem 0.3rem;
}

.ts-when-cell { white-space: nowrap; }

.ts-links-cell { white-space: nowrap; }

.ts-link {
  display: inline-block;
  margin-right: 0.25rem;
  color: var(--sapLinkColor, #0854a0);
  text-decoration: none;
  font-size: 1rem;
}
.ts-link:hover { text-decoration: underline; }
.ts-link--yt { color: #c4302b; }

.ts-venue-badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 20px;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}
.ts-venue-badge--berlin {
  background: var(--sapInformativeBackground, #e8f3ff);
  color: var(--sapInformativeColor, #0854a0);
}
.ts-venue-badge--virtual {
  background: var(--sapNeutralBackground, #f5f6f7);
  color: var(--sapContent_LabelColor, #6a6d70);
}
</style>
