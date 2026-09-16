<!-- hugo-apps/src/teched-calendar/App.vue
     TechEd calendar island — Week + Day views only (no Month).
     Reuses WeekAgenda / DayAgenda / calendar-core / track-colors from
     devtoberfest-sessions-calendar via relative imports (no modification to
     those components). Feed loaded from the embedded #teched-data blob baked
     by hugo/layouts/teched/calendar.html (falls back to /build/teched). -->
<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue';
import { addWeeks, addDays, startOfWeek, groupByDate, unscheduled, iso, parseISO } from '../devtoberfest-sessions-calendar/calendar-core';
import { buildTrackColorMap, legendFor } from '../devtoberfest-sessions-calendar/track-colors';
import WeekAgenda from '../devtoberfest-sessions-calendar/WeekAgenda.vue';
import DayAgenda from '../devtoberfest-sessions-calendar/DayAgenda.vue';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';
import type { Session } from '../devtoberfest-schedule-shared/types';
import { viewerDayKey } from '../devtoberfest-schedule-shared/format-session-time';
import type { TechEdSession } from '../teched-sessions-grid/filter';
import { parseTechEdCalUrl, toTechEdCalQuery, type TechEdCalViewMode } from './url-state';

// --- Feed shapes -----------------------------------------------------------
interface RawSpeaker { slug: string; name: string; title?: string | null; company?: string | null; bio?: string | null; photoUrl?: string | null; }
interface RawTrack { slug: string; name: string; venue?: string | null; description?: string | null; }
interface TechEdFeed { sessions: TechEdSession[]; speakers: RawSpeaker[]; tracks: RawTrack[]; }

/**
 * Map a TechEd session (flat slug-based shape) into the Session interface
 * that WeekAgenda/DayAgenda consume. The key fields are:
 *   id, kind, title, scheduledStart, trackName, trackColor (optional)
 * plus speaker names as a flat string on `speakers` (the panel reads `.name`).
 */
function toCalendarSession(s: TechEdSession, speakerNameBySlug: Map<string, string>, trackColor?: string): Session {
  const speakerObjects = (s.speakers || [])
    .map((slug) => ({ id: slug, name: speakerNameBySlug.get(slug) ?? slug, role: undefined, company: undefined }));
  return {
    id: s.slug,
    kind: 'session',
    title: s.title,
    abstract: s.abstract ?? undefined,
    scheduledStart: s.scheduledStart ?? undefined,
    trackName: s.trackName ?? undefined,
    trackColor: trackColor ?? undefined,
    youtubeUrl: s.youtubeUrl ?? undefined,
    speakers: speakerObjects,
    // TechEd-specific extras passed through for DetailPanel (via `as any`)
    ...(s.sessionCode ? { sessionCode: s.sessionCode } : {}),
    ...(s.url ? { communityEventUrl: s.url } : {}),
    ...(s.room ? {} : {}),       // room not on Session type; silently omitted from panel
  } as Session & { sessionCode?: string };
}

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

const loading = ref(true);
const error = ref('');
const sessions = ref<Session[]>([]);
const selectedRow = ref<Session | null>(null);
const filterTrack = ref('');    // track slug
const filterVenue = ref('');    // '' | 'BERLIN' | 'VIRTUAL'
const filterQuery = ref('');    // free text
const viewMode = ref<TechEdCalViewMode>('week');
const cursor = ref<Date>(new Date());
// Cache raw TechEd sessions for filter options
const rawSessions = ref<TechEdSession[]>([]);
const rawTracks = ref<RawTrack[]>([]);
// O(1) slug lookup into raw sessions and pre-built search haystacks
const rawBySlug = ref<Map<string, TechEdSession>>(new Map());
const haystackBySlug = ref<Map<string, string>>(new Map());

// --- Deep-linking -----------------------------------------------------------
const initialUrl = parseTechEdCalUrl(typeof window !== 'undefined' ? window.location.search : '');
let pendingDate: string | null = initialUrl.date;
let pendingSession: string | null = initialUrl.session;
let applied = false;
const initialCursorIso = ref<string | null>(null);

if (initialUrl.view) viewMode.value = initialUrl.view;
if (initialUrl.track) filterTrack.value = initialUrl.track;
if (initialUrl.venue) filterVenue.value = initialUrl.venue;

// --- Feed loading -----------------------------------------------------------
async function loadFeed(): Promise<TechEdFeed> {
  const el = typeof document !== 'undefined' ? document.getElementById('teched-data') : null;
  if (el?.textContent && el.textContent.trim()) {
    return JSON.parse(el.textContent) as TechEdFeed;
  }
  const r = await fetch('/build/teched', { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`teched ${r.status}`);
  return r.json();
}

function initialCursor(): Date {
  const dated = rawSessions.value.map((s) => s.scheduledStart).filter(Boolean).sort() as string[];
  if (dated.length) {
    const earliest = new Date(dated[0]);
    if (!isNaN(earliest.getTime())) return earliest;
  }
  return new Date();
}

async function loadData() {
  loading.value = true;
  error.value = '';
  try {
    const feed = await loadFeed();
    const rawSpk = feed.speakers || [];
    const rawTrk = feed.tracks || [];
    rawTracks.value = rawTrk;

    const speakerNameBySlug = new Map(rawSpk.map((s) => [s.slug, s.name]));
    const trackBySlug = new Map(rawTrk.map((t) => [t.slug, t]));

    rawSessions.value = (feed.sessions || []).map((s) => ({
      ...s,
      trackName: s.track ? (trackBySlug.get(s.track)?.name ?? null) : null,
      speakerNames: (s.speakers || []).map((slug) => speakerNameBySlug.get(slug)).filter(Boolean) as string[],
    }));

    // Build O(1) slug → raw session map and pre-computed haystacks
    rawBySlug.value = new Map(rawSessions.value.map((s) => [s.slug, s]));
    haystackBySlug.value = new Map(rawSessions.value.map((s) => [
      s.slug,
      [
        s.title || '',
        s.abstract || '',
        (s.speakerNames || []).join(' '),
        (s.speakers || []).join(' '),
        s.trackName || '',
        s.sessionCode || '',
      ].join(' ').toLowerCase(),
    ]));

    // Build track color map from enriched sessions (track name → color)
    const trackEntries = rawTrk.map((t) => ({ name: t.name, color: undefined }));
    const tcMap = buildTrackColorMap(trackEntries);

    sessions.value = rawSessions.value.map((s) => {
      const tColor = s.trackName ? (tcMap.get(s.trackName)?.border) : undefined;
      return toCalendarSession(s, speakerNameBySlug, tColor);
    });

    const ic = initialCursor();
    initialCursorIso.value = iso(ic);

    // Apply pending deep-link
    if (pendingDate) {
      cursor.value = parseISO(pendingDate) ?? ic;
    } else {
      cursor.value = ic;
    }

    if (pendingSession) {
      const row = sessions.value.find((r) => r.id === pendingSession);
      if (row) {
        selectedRow.value = row;
        if (!pendingDate) {
          const key = viewerDayKey(row.scheduledStart ?? '');
          if (key) cursor.value = parseISO(key) ?? cursor.value;
        }
      }
    }
    pendingDate = null;
    pendingSession = null;
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load TechEd sessions.';
  } finally {
    loading.value = false;
  }
}

// --- Filtering / derived data -----------------------------------------------
const trackOptions = computed(() => {
  const used = new Set<string>();
  rawSessions.value.forEach((s) => { if (s.track) used.add(s.track); });
  return rawTracks.value.filter((t) => used.has(t.slug)).sort((a, b) => a.name.localeCompare(b.name));
});

const colorMap = computed(() => {
  const entries = rawTracks.value.map((t) => ({ name: t.name, color: undefined as string | undefined }));
  return buildTrackColorMap(entries);
});
const legend = computed(() => legendFor(colorMap.value));

const filteredSessions = computed<Session[]>(() => {
  const q = filterQuery.value.trim().toLowerCase();
  return sessions.value.filter((s) => {
    const raw = rawBySlug.value.get(s.id);
    if (filterTrack.value && raw?.track !== filterTrack.value) return false;
    if (filterVenue.value && raw?.venue !== filterVenue.value) return false;
    if (q && !(haystackBySlug.value.get(s.id) ?? '').includes(q)) return false;
    return true;
  });
});

const byDate = computed(() => groupByDate(filteredSessions.value));
const unscheduledSessions = computed(() => unscheduled(filteredSessions.value));
const todayIso = viewerDayKey(new Date().toISOString());

// --- Title ------------------------------------------------------------------
const title = computed(() => {
  const c = cursor.value;
  if (viewMode.value === 'week') {
    const start = startOfWeek(c);
    const end = addDays(start, 6);
    return `${MONTHS[start.getUTCMonth()].slice(0,3)} ${start.getUTCDate()} – ${MONTHS[end.getUTCMonth()].slice(0,3)} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  return `${MONTHS[c.getUTCMonth()]} ${c.getUTCDate()}, ${c.getUTCFullYear()}`;
});

// --- Navigation -------------------------------------------------------------
function prev() {
  cursor.value = viewMode.value === 'week' ? addWeeks(cursor.value, -1) : addDays(cursor.value, -1);
}
function next() {
  cursor.value = viewMode.value === 'week' ? addWeeks(cursor.value, 1) : addDays(cursor.value, 1);
}
function goToday() { cursor.value = new Date(); }

// --- URL sync ---------------------------------------------------------------
function writeUrl() {
  if (!applied || typeof window === 'undefined') return;
  const cur = iso(cursor.value);
  const state = {
    view: viewMode.value,
    date: cur !== initialCursorIso.value ? cur : null,
    session: selectedRow.value?.id ?? null,
    track: filterTrack.value || null,
    venue: filterVenue.value || null,
  };
  const qs = toTechEdCalQuery(state);
  window.history.replaceState({}, '', `${window.location.pathname}${qs}${window.location.hash}`);
}

function applyFromUrl() {
  const st = parseTechEdCalUrl(window.location.search);
  viewMode.value = st.view ?? 'week';
  filterTrack.value = st.track ?? '';
  filterVenue.value = st.venue ?? '';
  if (st.session) {
    const row = sessions.value.find((r) => r.id === st.session);
    selectedRow.value = row ?? null;
    if (row && !st.date) {
      const key = viewerDayKey(row.scheduledStart ?? '');
      if (key) cursor.value = parseISO(key) ?? cursor.value;
    }
  } else {
    selectedRow.value = null;
  }
  if (st.date) cursor.value = parseISO(st.date) ?? cursor.value;
}

function onPopState() { applyFromUrl(); }

onMounted(async () => {
  window.addEventListener('popstate', onPopState);
  await loadData();
  applied = true;
  writeUrl();
});

onBeforeUnmount(() => window.removeEventListener('popstate', onPopState));

watch([viewMode, cursor, filterTrack, filterVenue, filterQuery, selectedRow], writeUrl);
</script>

<template>
  <div class="tc-wrap">
    <div class="tc-header">
      <h1 class="tc-title">SAP TechEd 2026 Calendar</h1>
      <a href="/teched/" class="tc-sessions-link">← All Sessions</a>
    </div>

    <div v-if="loading" class="tc-state">Loading TechEd sessions…</div>
    <div v-else-if="error" class="tc-state tc-state--error" role="alert">{{ error }}</div>

    <template v-else>
      <!-- toolbar -->
      <div class="cal-toolbar">
        <div class="cal-nav">
          <button class="cal-navbtn" @click="prev" aria-label="Previous">‹</button>
          <button class="cal-navbtn" @click="next" aria-label="Next">›</button>
        </div>
        <span class="cal-title">{{ title }}</span>
        <button class="cal-today" @click="goToday">Today</button>

        <!-- Track filter (by slug, displayed as name) -->
        <label class="tc-field cal-filter">
          <span class="sr-only">Track</span>
          <select v-model="filterTrack" aria-label="Filter by track">
            <option value="">All tracks</option>
            <option v-for="t in trackOptions" :key="t.slug" :value="t.slug">{{ t.name }}</option>
          </select>
        </label>

        <!-- Venue filter -->
        <label class="tc-field cal-filter">
          <span class="sr-only">Venue</span>
          <select v-model="filterVenue" aria-label="Filter by venue">
            <option value="">All venues</option>
            <option value="BERLIN">Berlin</option>
            <option value="VIRTUAL">Virtual</option>
          </select>
        </label>

        <!-- Free-text search -->
        <label class="tc-field tc-field--search">
          <span class="sr-only">Search</span>
          <input type="search" v-model="filterQuery" placeholder="Search sessions…" aria-label="Search TechEd sessions" />
        </label>

        <!-- View toggle: Week / Day ONLY (no Month) -->
        <div class="cal-switch" role="tablist" aria-label="Calendar view">
          <button
            role="tab"
            :aria-selected="viewMode === 'week'"
            :class="{ active: viewMode === 'week' }"
            @click="viewMode = 'week'"
          >Week</button>
          <button
            role="tab"
            :aria-selected="viewMode === 'day'"
            :class="{ active: viewMode === 'day' }"
            @click="viewMode = 'day'"
          >Day</button>
        </div>
      </div>

      <!-- track color legend -->
      <div v-if="legend.length" class="cal-legend">
        <span v-for="l in legend" :key="l.trackName" class="cal-legend-item">
          <span class="cal-legend-dot" :style="{ background: l.color.border }"></span>{{ l.trackName }}
        </span>
      </div>

      <WeekAgenda
        v-if="viewMode === 'week'"
        :cursor="cursor"
        :by-date="byDate"
        :colors="colorMap"
        :today="todayIso"
        :is-authenticated="false"
        @select="selectedRow = $event"
      />
      <DayAgenda
        v-else
        :cursor="cursor"
        :by-date="byDate"
        :colors="colorMap"
        :is-authenticated="false"
        @select="selectedRow = $event"
      />

      <!-- unscheduled bucket -->
      <div v-if="unscheduledSessions.length" class="cal-unscheduled">
        <h2 class="cal-unscheduled-title">Unscheduled</h2>
        <div class="cal-unscheduled-list">
          <button
            v-for="s in unscheduledSessions"
            :key="s.id"
            class="cal-unscheduled-card"
            :style="{ borderLeftColor: (s.trackName && colorMap.get(s.trackName)?.border) || 'var(--sapContent_ForegroundBorderColor, #e4e7ed)' }"
            @click="selectedRow = s"
          >
            <span class="cal-unscheduled-name">{{ s.title }}</span>
            <span v-if="s.trackName" class="cal-unscheduled-track">{{ s.trackName }}</span>
          </button>
        </div>
      </div>
    </template>

    <!-- Detail panel — row cast via `as any` since TechEd session extends Session
         with extras (sessionCode, venue) that DetailPanel accesses via (row as any). -->
    <DetailPanel :row="(selectedRow as any)" :edition-id="null" @close="selectedRow = null" />
  </div>
</template>

<style scoped>
.tc-wrap { font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif); font-size: var(--sapFontSize, 0.875rem); color: var(--sapTextColor, #32363a); padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.tc-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; }
.tc-title { font-size: var(--sapFontHeader2Size, 1.5rem); font-weight: 700; margin: 0; }
.tc-sessions-link { font-size: 0.875rem; color: var(--sapLinkColor, #0854a0); text-decoration: none; }
.tc-sessions-link:hover { text-decoration: underline; }
.tc-state { padding: 2rem; text-align: center; color: var(--sapContent_LabelColor, #6a6d70); }
.tc-state--error { color: var(--sapNegativeColor, #b00020); }
.cal-toolbar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.cal-nav { display: flex; gap: 0.25rem; }
.cal-navbtn { width: 2rem; height: 2rem; border: 1px solid var(--sapField_BorderColor, #89919a); background: var(--sapField_Background, #fff); border-radius: 0.25rem; cursor: pointer; font-size: 1.1rem; line-height: 1; }
.cal-title { font-weight: 700; font-size: 1rem; min-width: 10rem; }
.cal-today { border: 1px solid var(--sapButton_Emphasized_Background, #0a6ed1); color: var(--sapButton_Emphasized_Background, #0a6ed1); background: transparent; border-radius: 0.25rem; padding: 0.35rem 0.9rem; cursor: pointer; font: inherit; }
.tc-field { display: flex; flex-direction: column; }
.tc-field select, .tc-field input[type="search"] { min-width: 9rem; padding: 0.35rem 0.5rem; border: 1px solid var(--sapField_BorderColor, #89919a); border-radius: 0.25rem; background: var(--sapField_Background, #fff); color: inherit; font: inherit; }
.tc-field--search { flex: 1 1 12rem; }
.tc-field--search input[type="search"] { width: 100%; }
.cal-filter select { min-width: 9rem; }
.cal-switch { display: inline-flex; margin-left: auto; border: 1px solid var(--sapField_BorderColor, #89919a); border-radius: 0.25rem; overflow: hidden; }
.cal-switch button { border: none; background: var(--sapField_Background, #fff); padding: 0.35rem 0.9rem; cursor: pointer; font: inherit; border-left: 1px solid var(--sapList_BorderColor, #e4e7ed); }
.cal-switch button:first-child { border-left: none; }
.cal-switch button.active { background: var(--sapButton_Emphasized_Background, #0a6ed1); color: #fff; }
.cal-legend { display: flex; flex-wrap: wrap; gap: 0.9rem; font-size: 0.75rem; color: var(--sapContent_LabelColor, #6a6d70); }
.cal-legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
.cal-legend-dot { width: 0.7rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.cal-unscheduled { display: flex; flex-direction: column; gap: 0.5rem; }
.cal-unscheduled-title { font-size: var(--sapFontHeader5Size, 1rem); font-weight: 700; margin: 0.5rem 0 0; color: var(--sapContent_LabelColor, #6a6d70); }
.cal-unscheduled-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.cal-unscheduled-card { display: inline-flex; align-items: center; gap: 0.4rem; border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-left: 4px solid transparent; border-radius: 6px; padding: 0.4rem 0.6rem; cursor: pointer; font: inherit; text-align: left; background: var(--sapBaseColor, #fff); }
.cal-unscheduled-name { font-size: 0.8rem; font-weight: 600; }
.cal-unscheduled-track { font-size: 0.7rem; color: var(--sapContent_LabelColor, #6a6d70); }
</style>
