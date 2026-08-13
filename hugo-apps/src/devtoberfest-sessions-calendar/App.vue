<!-- hugo-apps/src/devtoberfest-sessions-calendar/App.vue -->
<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { fetchFeed, fetchMyCompletions } from '../devtoberfest-schedule-shared/feed';
import { mergeCompletion } from '../devtoberfest-schedule-shared/completion';
import { useAuth } from '../devtoberfest-schedule-shared/useAuth';
import EditionPicker from '../devtoberfest-schedule-shared/EditionPicker.vue';
import PointsBanner from '../devtoberfest-schedule-shared/PointsBanner.vue';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';
import type { Feed, ScheduleRow, Session } from '../devtoberfest-schedule-shared/types';
import {
  addMonths, addWeeks, addDays, startOfWeek, groupByDate, unscheduled,
} from './calendar-core';
import { viewerDayKey } from '../devtoberfest-schedule-shared/format-session-time';
import { feedRssHref, subscribeWebcalHref } from '../devtoberfest-schedule-shared/calendar-links';
import { buildTrackColorMap, legendFor } from './track-colors';
import MonthGrid from './MonthGrid.vue';
import WeekAgenda from './WeekAgenda.vue';
import DayAgenda from './DayAgenda.vue';

type ViewMode = 'month' | 'week' | 'day';

const { isAuthenticated } = useAuth();

const loading = ref(true);
const error = ref('');
const editionId = ref<string | null>(null);
const feed = ref<Feed | null>(null);
const sessions = ref<ScheduleRow[]>([]);
const earnedPoints = ref(0);
const maxPoints = ref(0);
const joined = ref(false);
const selectedRow = ref<ScheduleRow | null>(null);
const filterTrack = ref('');
const viewMode = ref<ViewMode>('month');
const cursor = ref<Date>(new Date());

const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];

async function loadData(edition?: string) {
  loading.value = true;
  error.value = '';
  try {
    const [feedData, myData] = await Promise.all([fetchFeed(edition), fetchMyCompletions(edition)]);
    feed.value = feedData;
    editionId.value = edition ?? feedData.activeEditionId;
    const merged = mergeCompletion(feedData, myData);
    sessions.value = merged.rows.filter((r) => r.kind === 'session');
    joined.value = merged.joined;
    earnedPoints.value = merged.earnedPoints;
    maxPoints.value = merged.maxPoints;
    cursor.value = initialCursor();
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load sessions.';
  } finally {
    loading.value = false;
  }
}

/** Return the UTC month-start Date for any ISO string (date-only or full timestamp). */
function monthStartFromISO(isoString?: string): Date | null {
  if (!isoString) return null;
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return null;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function initialCursor(): Date {
  const active = feed.value?.editions.find((e) => e.id === editionId.value) ?? feed.value?.editions[0];
  const fromEdition = monthStartFromISO(active?.startsAt);
  if (fromEdition) return fromEdition;
  const dated = sessions.value.map((s) => (s as any).scheduledStart).filter(Boolean).sort();
  const earliest = monthStartFromISO(dated[0]);
  if (earliest) return earliest;
  return new Date();
}

async function onEditionChange(id: string) { editionId.value = id; await loadData(id); }

const trackOptions = computed(() => {
  const set = new Set<string>();
  sessions.value.forEach((r) => { if ((r as any).trackName) set.add((r as any).trackName); });
  return Array.from(set).sort();
});

// colours assigned over the FULL track set so they stay stable under filtering
const colorMap = computed(() => {
  const seen = new Map<string, string | undefined>();
  sessions.value.forEach((r) => {
    const s = r as any;
    if (s.trackName && !seen.has(s.trackName)) seen.set(s.trackName, s.trackColor ?? undefined);
  });
  return buildTrackColorMap([...seen.entries()].map(([name, color]) => ({ name, color })));
});
const legend = computed(() => legendFor(colorMap.value));

const completeCount = computed(() => sessions.value.filter((r) => r.complete).length);

const filteredSessions = computed<Session[]>(() => {
  const base = sessions.value as Session[];
  return filterTrack.value ? base.filter((r) => (r as any).trackName === filterTrack.value) : base;
});

const byDate = computed(() => groupByDate(filteredSessions.value));
const unscheduledSessions = computed<Session[]>(() => unscheduled(filteredSessions.value));
const todayIso = viewerDayKey(new Date().toISOString());

const title = computed(() => {
  const c = cursor.value;
  if (viewMode.value === 'month') return `${MONTHS[c.getUTCMonth()]} ${c.getUTCFullYear()}`;
  if (viewMode.value === 'week') {
    const start = startOfWeek(c); const end = addDays(start, 6);
    return `${MONTHS[start.getUTCMonth()].slice(0,3)} ${start.getUTCDate()} – ${MONTHS[end.getUTCMonth()].slice(0,3)} ${end.getUTCDate()}, ${end.getUTCFullYear()}`;
  }
  return `${MONTHS[c.getUTCMonth()]} ${c.getUTCDate()}, ${c.getUTCFullYear()}`;
});

function prev() {
  cursor.value = viewMode.value === 'month' ? addMonths(cursor.value, -1)
    : viewMode.value === 'week' ? addWeeks(cursor.value, -1) : addDays(cursor.value, -1);
}
function next() {
  cursor.value = viewMode.value === 'month' ? addMonths(cursor.value, 1)
    : viewMode.value === 'week' ? addWeeks(cursor.value, 1) : addDays(cursor.value, 1);
}
function goToday() { cursor.value = new Date(); }
function openDay(d: Date) { cursor.value = d; viewMode.value = 'day'; }

// Public feed subscription links, scoped to the active edition. webcal:// makes
// the browser hand the .ics feed to the OS calendar app as a live subscription.
const webcalHref = computed(() => subscribeWebcalHref(window.location.host, editionId.value));
const rssHref = computed(() => feedRssHref(editionId.value));

onMounted(() => loadData());
</script>

<template>
  <div class="sc-wrap">
    <div class="sc-header">
      <h1 class="sc-title">Devtoberfest Calendar</h1>
      <div class="sc-header-actions">
        <EditionPicker v-if="feed" :editions="feed.editions" :model-value="editionId" @update:model-value="onEditionChange" />
        <div v-if="feed" class="sc-subscribe">
          <a :href="webcalHref" class="sc-subscribe-link" title="Subscribe in your calendar app (live-updating)">
            <span aria-hidden="true">📅</span> Subscribe
          </a>
          <a :href="rssHref" class="sc-subscribe-link" target="_blank" rel="noopener noreferrer" title="RSS feed of sessions">
            <span aria-hidden="true">🔗</span> RSS
          </a>
        </div>
      </div>
    </div>

    <PointsBanner v-if="!loading && !error" :earned-points="earnedPoints" :max-points="maxPoints" :complete-count="completeCount" :is-authenticated="isAuthenticated" :joined="joined" />

    <div v-if="loading" class="sc-state">Loading sessions…</div>
    <div v-else-if="error" class="sc-state sc-state--error">
      <ui5-illustrated-message name="UnableToLoad" size="Scene"><div slot="subtitle">{{ error }}</div></ui5-illustrated-message>
    </div>

    <template v-else>
      <!-- toolbar -->
      <div class="cal-toolbar">
        <div class="cal-nav">
          <button class="cal-navbtn" @click="prev" aria-label="Previous">‹</button>
          <button class="cal-navbtn" @click="next" aria-label="Next">›</button>
        </div>
        <span class="cal-title">{{ title }}</span>
        <button class="cal-today" @click="goToday">Today</button>
        <label class="sc-field cal-filter">
          <span class="sr-only">Track</span>
          <select v-model="filterTrack" aria-label="Filter by track">
            <option value="">All tracks</option>
            <option v-for="t in trackOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <div class="cal-switch" role="tablist">
          <button :class="{ active: viewMode === 'month' }" @click="viewMode = 'month'">Month</button>
          <button :class="{ active: viewMode === 'week' }" @click="viewMode = 'week'">Week</button>
          <button :class="{ active: viewMode === 'day' }" @click="viewMode = 'day'">Day</button>
        </div>
      </div>

      <!-- legend -->
      <div v-if="legend.length" class="cal-legend">
        <span v-for="l in legend" :key="l.trackName" class="cal-legend-item">
          <span class="cal-legend-dot" :style="{ background: l.color.border }"></span>{{ l.trackName }}
        </span>
      </div>

      <MonthGrid v-if="viewMode === 'month'" :cursor="cursor" :by-date="byDate" :colors="colorMap" :today="todayIso" :is-authenticated="isAuthenticated" @select="selectedRow = $event as any" @open-day="openDay" />
      <WeekAgenda v-else-if="viewMode === 'week'" :cursor="cursor" :by-date="byDate" :colors="colorMap" :today="todayIso" :is-authenticated="isAuthenticated" @select="selectedRow = $event as any" />
      <DayAgenda v-else :cursor="cursor" :by-date="byDate" :colors="colorMap" :is-authenticated="isAuthenticated" @select="selectedRow = $event as any" />

      <!-- unscheduled bucket: sessions with no scheduledStart, surfaced rather than dropped (spec §7) -->
      <div v-if="unscheduledSessions.length" class="cal-unscheduled">
        <h2 class="cal-unscheduled-title">Unscheduled</h2>
        <div class="cal-unscheduled-list">
          <button
            v-for="s in unscheduledSessions"
            :key="s.id"
            class="cal-unscheduled-card"
            :class="{ 'cal-unscheduled-card--complete': isAuthenticated && (s as any).complete }"
            :style="{ borderLeftColor: (s.trackName && colorMap.get(s.trackName)?.border) || 'var(--sapContent_ForegroundBorderColor, #e4e7ed)' }"
            @click="selectedRow = s as any"
          >
            <span class="cal-unscheduled-name">{{ s.title }}</span>
            <span v-if="s.trackName" class="cal-unscheduled-track">{{ s.trackName }}</span>
            <span v-if="isAuthenticated && (s as any).complete" class="cal-unscheduled-done" aria-label="Completed">✓</span>
          </button>
        </div>
      </div>
    </template>

    <DetailPanel :row="selectedRow ?? null" :edition-id="editionId" @close="selectedRow = null" />
  </div>
</template>

<style scoped>
.sc-wrap { font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif); font-size: var(--sapFontSize, 0.875rem); color: var(--sapTextColor, #32363a); padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.sc-header { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; }
.sc-header-actions { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; }
.sc-subscribe { display: flex; align-items: center; gap: 0.75rem; }
.sc-subscribe-link { display: inline-flex; align-items: center; gap: 0.3rem; font-size: 0.8125rem; color: var(--sapLinkColor, #0854a0); text-decoration: none; }
.sc-subscribe-link:hover { text-decoration: underline; }
.sc-title { font-size: var(--sapFontHeader2Size, 1.5rem); font-weight: 700; margin: 0; }
.sc-state { padding: 2rem; text-align: center; color: var(--sapContent_LabelColor, #6a6d70); }
.sc-state--error { color: var(--sapNegativeColor, #b00020); }
.cal-toolbar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.cal-nav { display: flex; gap: 0.25rem; }
.cal-navbtn { width: 2rem; height: 2rem; border: 1px solid var(--sapField_BorderColor, #89919a); background: var(--sapField_Background, #fff); border-radius: 0.25rem; cursor: pointer; font-size: 1.1rem; line-height: 1; }
.cal-title { font-weight: 700; font-size: 1rem; min-width: 10rem; }
.cal-today { border: 1px solid var(--sapButton_Emphasized_Background, #0a6ed1); color: var(--sapButton_Emphasized_Background, #0a6ed1); background: transparent; border-radius: 0.25rem; padding: 0.35rem 0.9rem; cursor: pointer; font: inherit; }
.cal-filter select { min-width: 9rem; padding: 0.35rem 0.5rem; border: 1px solid var(--sapField_BorderColor, #89919a); border-radius: 0.25rem; background: var(--sapField_Background, #fff); color: inherit; font: inherit; }
.cal-switch { display: inline-flex; margin-left: auto; border: 1px solid var(--sapField_BorderColor, #89919a); border-radius: 0.25rem; overflow: hidden; }
.cal-switch button { border: none; background: var(--sapField_Background, #fff); padding: 0.35rem 0.9rem; cursor: pointer; font: inherit; border-left: 1px solid var(--sapList_BorderColor, #e4e7ed); }
.cal-switch button:first-child { border-left: none; }
.cal-switch button.active { background: var(--sapButton_Emphasized_Background, #0a6ed1); color: #fff; }
.cal-legend { display: flex; flex-wrap: wrap; gap: 0.9rem; font-size: 0.75rem; color: var(--sapContent_LabelColor, #6a6d70); }
.cal-legend-item { display: inline-flex; align-items: center; gap: 0.35rem; }
.cal-legend-dot { width: 0.7rem; height: 0.7rem; border-radius: 3px; display: inline-block; }
.sc-field { display: flex; flex-direction: column; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
.cal-unscheduled { display: flex; flex-direction: column; gap: 0.5rem; }
.cal-unscheduled-title { font-size: var(--sapFontHeader5Size, 1rem); font-weight: 700; margin: 0.5rem 0 0; color: var(--sapContent_LabelColor, #6a6d70); }
.cal-unscheduled-list { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.cal-unscheduled-card { display: inline-flex; align-items: center; gap: 0.4rem; border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-left: 4px solid transparent; border-radius: 6px; padding: 0.4rem 0.6rem; cursor: pointer; font: inherit; text-align: left; background: var(--sapBaseColor, #fff); }
.cal-unscheduled-card--complete { background: var(--sapSuccessBackground, #f1fdf6); }
.cal-unscheduled-name { font-size: 0.8rem; font-weight: 600; }
.cal-unscheduled-track { font-size: 0.7rem; color: var(--sapContent_LabelColor, #6a6d70); }
.cal-unscheduled-done { color: var(--sapPositiveColor, #107e3e); font-size: 0.7rem; font-weight: 700; }
</style>
