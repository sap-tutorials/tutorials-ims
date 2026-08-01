<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { fetchFeed, fetchMyCompletions } from '../devtoberfest-schedule-shared/feed';
import { mergeCompletion, youtubeThumb } from '../devtoberfest-schedule-shared/completion';
import { useAuth } from '../devtoberfest-schedule-shared/useAuth';
import EditionPicker from '../devtoberfest-schedule-shared/EditionPicker.vue';
import PointsBanner from '../devtoberfest-schedule-shared/PointsBanner.vue';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';
import type { Feed, ScheduleRow, Session } from '../devtoberfest-schedule-shared/types';
import { buildCalendar } from './calendar-grid';

const { isAuthenticated } = useAuth();

const loading = ref(true);
const error = ref('');
const editionId = ref<string | null>(null);
const feed = ref<Feed | null>(null);
const sessions = ref<ScheduleRow[]>([]);
const earnedPoints = ref(0);
const maxPoints = ref(0);
const selectedRow = ref<ScheduleRow | null>(null);
const filterTrack = ref('');

async function loadData(edition?: string) {
  loading.value = true;
  error.value = '';
  try {
    const [feedData, myData] = await Promise.all([
      fetchFeed(edition),
      fetchMyCompletions(edition),
    ]);
    feed.value = feedData;
    editionId.value = edition ?? feedData.activeEditionId;
    const merged = mergeCompletion(feedData, myData);
    sessions.value = merged.rows.filter((r) => r.kind === 'session');
    earnedPoints.value = merged.earnedPoints;
    maxPoints.value = merged.maxPoints;
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load sessions.';
  } finally {
    loading.value = false;
  }
}

async function onEditionChange(id: string) {
  editionId.value = id;
  await loadData(id);
}

const trackOptions = computed(() => {
  const set = new Set<string>();
  sessions.value.forEach((r) => { if ((r as any).trackName) set.add((r as any).trackName); });
  return Array.from(set).sort();
});

const completeCount = computed(() => sessions.value.filter((r) => r.complete).length);

const filteredSessions = computed(() => {
  if (!filterTrack.value) return sessions.value as Session[];
  return sessions.value.filter((r) => (r as any).trackName === filterTrack.value) as Session[];
});

const calendar = computed(() => buildCalendar(filteredSessions.value));

function onThumbError(ev: Event) {
  const img = ev.target as HTMLImageElement;
  img.style.display = 'none';
  const placeholder = img.nextElementSibling as HTMLElement | null;
  if (placeholder) placeholder.style.display = 'flex';
}

onMounted(() => loadData());
</script>

<template>
  <div class="sc-wrap">
    <!-- header -->
    <div class="sc-header">
      <h1 class="sc-title">Devtoberfest Calendar</h1>
      <EditionPicker
        v-if="feed"
        :editions="feed.editions"
        :model-value="editionId"
        @update:model-value="onEditionChange"
      />
    </div>

    <PointsBanner
      v-if="!loading && !error"
      :earned-points="earnedPoints"
      :max-points="maxPoints"
      :complete-count="completeCount"
      :is-authenticated="isAuthenticated"
    />

    <!-- loading -->
    <div v-if="loading" class="sc-state">Loading sessions…</div>

    <!-- error -->
    <div v-else-if="error" class="sc-state sc-state--error">
      <ui5-illustrated-message name="UnableToLoad" size="Scene">
        <div slot="subtitle">{{ error }}</div>
      </ui5-illustrated-message>
    </div>

    <template v-else>
      <!-- track filter -->
      <div class="sc-toolbar" role="search">
        <label class="sc-field">
          <span>Track</span>
          <select v-model="filterTrack">
            <option value="">All tracks</option>
            <option v-for="t in trackOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <button
          v-if="filterTrack"
          class="sc-btn sc-btn-ghost"
          @click="filterTrack = ''"
        >Clear</button>
      </div>

      <!-- empty state -->
      <div v-if="calendar.weeks.length === 0" class="sc-state sc-state--empty">
        <ui5-illustrated-message name="NoData" size="Scene">
          <div slot="subtitle">No sessions match your filters.</div>
        </ui5-illustrated-message>
      </div>

      <!-- calendar table -->
      <div v-else class="sc-table-wrap">
        <table class="sc-table" role="grid">
          <thead>
            <tr>
              <th class="sc-th sc-th--week" scope="col">Week</th>
              <th
                v-for="day in calendar.weekdays"
                :key="day"
                class="sc-th"
                scope="col"
              >{{ day }}</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="week in calendar.weeks" :key="week">
              <th class="sc-td sc-td--week" scope="row">Week {{ week }}</th>
              <td
                v-for="day in calendar.weekdays"
                :key="day"
                class="sc-td"
              >
                <template v-if="calendar.cells[week]?.[day]?.length">
                  <button
                    v-for="session in calendar.cells[week][day]"
                    :key="session.id"
                    class="sc-card"
                    :class="{ 'sc-card--complete': isAuthenticated && session.complete }"
                    @click="selectedRow = session as any"
                  >
                    <!-- thumbnail -->
                    <div class="sc-thumb-wrap">
                      <template v-if="youtubeThumb((session as any).youtubeUrl)">
                        <img
                          :src="youtubeThumb((session as any).youtubeUrl)!"
                          :alt="session.title"
                          class="sc-thumb"
                          loading="lazy"
                          @error="onThumbError"
                        />
                        <div class="sc-thumb-placeholder" style="display:none" aria-hidden="true"></div>
                      </template>
                      <div v-else class="sc-thumb-placeholder" aria-hidden="true"></div>
                    </div>
                    <!-- card body -->
                    <div class="sc-card-body">
                      <span class="sc-card-title">{{ session.title }}</span>
                      <span v-if="(session as any).scheduledTime" class="sc-card-time">
                        {{ (session as any).scheduledTime }}
                      </span>
                      <span v-if="isAuthenticated && session.complete" class="sc-done" aria-label="Completed">✓</span>
                    </div>
                  </button>
                </template>
                <span v-else class="sc-empty-cell" aria-label="No sessions"></span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <DetailPanel :row="selectedRow ?? null" @close="selectedRow = null" />
  </div>
</template>

<style scoped>
.sc-wrap {
  font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif);
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.sc-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.sc-title {
  font-size: var(--sapFontHeader2Size, 1.5rem);
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
  margin: 0;
}

.sc-state {
  padding: 2rem;
  text-align: center;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sc-state--error {
  color: var(--sapNegativeColor, #b00020);
}

.sc-state--empty {
  background: transparent;
}

.sc-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.sc-field {
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
}

.sc-field span {
  margin-bottom: 0.25rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sc-field select {
  min-width: 10rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
}

.sc-btn {
  display: inline-block;
  padding: 0.4rem 0.9rem;
  border-radius: 0.25rem;
  background: var(--sapButton_Emphasized_Background, #0854a0);
  color: #fff;
  border: none;
  cursor: pointer;
  font: inherit;
}

.sc-btn-ghost {
  background: transparent;
  color: var(--sapLinkColor, #0854a0);
  border: 1px solid var(--sapField_BorderColor, #89919a);
}

/* table */
.sc-table-wrap {
  overflow-x: auto;
}

.sc-table {
  border-collapse: collapse;
  width: 100%;
  min-width: 40rem;
}

.sc-th {
  padding: 0.5rem 0.75rem;
  background: var(--sapList_HeaderBackground, #f5f6f7);
  color: var(--sapList_HeaderTextColor, #32363a);
  font-weight: 700;
  font-size: 0.875rem;
  text-align: left;
  border: 1px solid var(--sapList_BorderColor, #e4e7ed);
  white-space: nowrap;
}

.sc-th--week {
  min-width: 5rem;
}

.sc-td {
  padding: 0.35rem;
  border: 1px solid var(--sapList_BorderColor, #e4e7ed);
  vertical-align: top;
  min-width: 10rem;
  max-width: 16rem;
}

.sc-td--week {
  font-weight: 600;
  font-size: 0.8rem;
  background: var(--sapList_HeaderBackground, #f5f6f7);
  white-space: nowrap;
  min-width: 5rem;
  padding: 0.5rem 0.75rem;
}

.sc-empty-cell {
  display: block;
  min-height: 2rem;
}

/* session card inside a cell */
.sc-card {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
  border-radius: 6px;
  background: var(--sapBaseColor, #fff);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  margin-bottom: 0.35rem;
  transition: box-shadow 0.15s;
}

.sc-card:last-child {
  margin-bottom: 0;
}

.sc-card:hover {
  box-shadow: 0 2px 8px rgba(0,0,0,0.12);
  border-color: var(--sapHighlightColor, #0854a0);
}

.sc-card--complete {
  border-color: var(--sapSuccessBorderColor, #5cb85c);
  background: var(--sapSuccessBackground, #f1fdf6);
}

.sc-thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--sapShellColor, #354a5e);
  overflow: hidden;
}

.sc-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.sc-thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--sapShellColor, #354a5e) 0%, #1a2e3e 100%);
  color: rgba(255,255,255,0.4);
  font-size: 1.25rem;
}

.sc-thumb-placeholder::after {
  content: '▶';
}

.sc-card-body {
  padding: 0.4rem 0.5rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.sc-card-title {
  font-size: 0.8rem;
  font-weight: 600;
  line-height: 1.3;
  color: var(--sapTextColor, #32363a);
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}

.sc-card-time {
  font-size: 0.72rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sc-done {
  font-size: 0.75rem;
  font-weight: 700;
  color: var(--sapPositiveColor, #107e3e);
}
</style>
