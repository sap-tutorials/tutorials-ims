<script setup lang="ts">
import { ref, computed, onMounted, reactive } from 'vue';
import { fetchFeed, fetchMyCompletions } from '../devtoberfest-schedule-shared/feed';
import { mergeCompletion } from '../devtoberfest-schedule-shared/completion';
import EditionPicker from '../devtoberfest-schedule-shared/EditionPicker.vue';
import PointsBanner from '../devtoberfest-schedule-shared/PointsBanner.vue';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';
import type { Feed, ScheduleRow } from '../devtoberfest-schedule-shared/types';

const loading = ref(true);
const error = ref('');
const editionId = ref<string | null>(null);
const feed = ref<Feed | null>(null);
const rows = ref<ScheduleRow[]>([]);
const earnedPoints = ref(0);
const maxPoints = ref(0);
const isAuthenticated = ref(false);
const completedActivityIds = ref<Set<string>>(new Set());
const selectedRow = ref<ScheduleRow | null>(null);

// Exposed for tests
const filters = reactive({
  week: '',
  type: '',
  track: '',
  q: '',
});

type SortKey = 'kind' | 'title' | 'trackName' | 'week' | 'scheduledDate' | 'points';
const sortKey = ref<SortKey>('week');
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

const weekOptions = computed(() => {
  const set = new Set<string>();
  rows.value.forEach((r) => { if (r.week) set.add(r.week); });
  return Array.from(set).sort();
});

const trackOptions = computed(() => {
  const set = new Set<string>();
  rows.value.forEach((r) => { if ((r as any).trackName) set.add((r as any).trackName); });
  return Array.from(set).sort();
});

const completeCount = computed(() => rows.value.filter((r) => r.complete).length);

const filtered = computed(() => {
  const q = filters.q.trim().toLowerCase();
  return rows.value.filter((r) => {
    if (filters.week && r.week !== filters.week) return false;
    if (filters.type && r.kind !== filters.type) return false;
    if (filters.track && (r as any).trackName !== filters.track) return false;
    if (q && !r.title.toLowerCase().includes(q)) return false;
    return true;
  });
});

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
    if (k === 'points') return ((av as number) - (bv as number)) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  return list;
});

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
    isAuthenticated.value = myData.authenticated;
    const merged = mergeCompletion(feedData, myData);
    rows.value = merged.rows;
    earnedPoints.value = merged.earnedPoints;
    maxPoints.value = merged.maxPoints;
    completedActivityIds.value = merged.completedActivityIds;
  } catch (e: any) {
    error.value = e?.message ?? 'Failed to load schedule.';
  } finally {
    loading.value = false;
  }
}

async function onEditionChange(id: string) {
  editionId.value = id;
  await loadData(id);
}

function clearFilters() {
  filters.week = '';
  filters.type = '';
  filters.track = '';
  filters.q = '';
}

onMounted(() => loadData());

defineExpose({ filters });
</script>

<template>
  <div class="sched-wrap">
    <!-- header bar -->
    <div class="sched-header">
      <h1 class="sched-title">Devtoberfest Schedule</h1>
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
    <div v-if="loading" class="sched-state">Loading schedule…</div>

    <!-- error -->
    <div v-else-if="error" class="sched-state sched-error">
      <ui5-illustrated-message name="UnableToLoad" size="Scene">
        <div slot="subtitle">{{ error }}</div>
      </ui5-illustrated-message>
    </div>

    <!-- content -->
    <template v-else>
      <!-- filters -->
      <div class="sched-toolbar" role="search">
        <label class="sched-field">
          <span>Search</span>
          <input type="text" v-model="filters.q" placeholder="Title…" />
        </label>
        <label class="sched-field">
          <span>Week</span>
          <select v-model="filters.week">
            <option value="">All weeks</option>
            <option v-for="w in weekOptions" :key="w" :value="w">Week {{ w }}</option>
          </select>
        </label>
        <label class="sched-field">
          <span>Type</span>
          <select v-model="filters.type">
            <option value="">All types</option>
            <option value="session">Session</option>
            <option value="activity">Activity</option>
          </select>
        </label>
        <label class="sched-field">
          <span>Track</span>
          <select v-model="filters.track">
            <option value="">All tracks</option>
            <option v-for="t in trackOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <button
          v-if="filters.week || filters.type || filters.track || filters.q"
          class="sched-btn sched-btn-ghost"
          @click="clearFilters"
        >Clear</button>
        <span class="sched-count">{{ sorted.length }} of {{ rows.length }}</span>
      </div>

      <!-- empty state -->
      <div v-if="sorted.length === 0" class="sched-state sched-state--empty">
        <ui5-illustrated-message name="NoData" size="Scene">
          <div slot="subtitle">No items match your filters.</div>
        </ui5-illustrated-message>
      </div>

      <!-- table -->
      <div v-else class="sched-table-wrap">
        <table class="sched-table">
          <thead>
            <tr>
              <th @click="setSort('kind')"><button>Type{{ sortIcon('kind') }}</button></th>
              <th @click="setSort('title')"><button>Title{{ sortIcon('title') }}</button></th>
              <th @click="setSort('trackName')"><button>Track{{ sortIcon('trackName') }}</button></th>
              <th @click="setSort('week')"><button>Week{{ sortIcon('week') }}</button></th>
              <th @click="setSort('scheduledDate')"><button>Date / Time{{ sortIcon('scheduledDate') }}</button></th>
              <th @click="setSort('points')" class="num"><button>Points{{ sortIcon('points') }}</button></th>
              <th>Links</th>
              <th v-if="isAuthenticated">Status</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="row in sorted"
              :key="`${row.kind}:${row.id}`"
              class="sched-row"
              :class="{ 'sched-row--complete': row.complete, 'sched-row--session': row.kind === 'session', 'sched-row--activity': row.kind === 'activity' }"
              @click="selectedRow = row"
              tabindex="0"
              @keydown.enter="selectedRow = row"
            >
              <td>
                <span class="sched-kind-badge" :class="`sched-kind-badge--${row.kind}`">
                  {{ row.kind === 'session' ? 'Session' : 'Activity' }}
                </span>
              </td>
              <td class="sched-title-cell">{{ row.title }}</td>
              <td>{{ (row as any).trackName ?? '—' }}</td>
              <td>{{ row.week ?? '—' }}</td>
              <td>
                <template v-if="(row as any).scheduledDate">
                  {{ (row as any).scheduledDate }}
                  <span v-if="(row as any).scheduledTime" class="sched-time">{{ (row as any).scheduledTime }}</span>
                </template>
                <template v-else>—</template>
              </td>
              <td class="num">{{ (row as any).points != null ? (row as any).points.toLocaleString() : '—' }}</td>
              <td class="sched-links-cell">
                <a
                  v-if="(row as any).youtubeUrl"
                  :href="(row as any).youtubeUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="sched-link sched-link--yt"
                  @click.stop
                  title="Watch on YouTube"
                >▶</a>
                <a
                  v-if="(row as any).communityEventUrl"
                  :href="(row as any).communityEventUrl"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="sched-link"
                  @click.stop
                  title="Community event"
                >↗</a>
                <a
                  v-if="(row as any).taskSlug"
                  :href="`/${(row as any).taskType === 'puzzle' ? 'puzzles' : 'tutorials'}/${(row as any).taskSlug}`"
                  class="sched-link"
                  @click.stop
                  :title="(row as any).taskType === 'puzzle' ? 'Open puzzle' : 'Open tutorial'"
                >→</a>
              </td>
              <td v-if="isAuthenticated">
                <span v-if="row.complete" class="sched-done" aria-label="Completed">✓</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <!-- detail panel -->
    <DetailPanel :row="selectedRow ?? null" @close="selectedRow = null" />
  </div>
</template>

<style scoped>
.sched-wrap {
  font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif);
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.sched-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.sched-title {
  font-size: var(--sapFontHeader2Size, 1.5rem);
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
  margin: 0;
}

.sched-state {
  padding: 2rem;
  text-align: center;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sched-error {
  color: var(--sapNegativeColor, #b00020);
}

.sched-state--empty {
  background: transparent;
}

.sched-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.sched-field {
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
}

.sched-field span {
  margin-bottom: 0.25rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sched-field input,
.sched-field select {
  min-width: 10rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
}

.sched-btn {
  display: inline-block;
  padding: 0.4rem 0.9rem;
  border-radius: 0.25rem;
  background: var(--sapButton_Emphasized_Background, #0854a0);
  color: #fff;
  border: none;
  cursor: pointer;
  font: inherit;
}

.sched-btn-ghost {
  background: transparent;
  color: var(--sapLinkColor, #0854a0);
  border: 1px solid var(--sapField_BorderColor, #89919a);
}

.sched-count {
  margin-left: auto;
  color: var(--sapContent_LabelColor, #6a6d70);
  font-size: 0.875rem;
  align-self: flex-end;
}

.sched-table-wrap {
  overflow-x: auto;
  border: 1px solid var(--sapList_BorderColor, #e4e5e7);
  border-radius: 0.5rem;
  background: var(--sapList_Background, #fff);
}

.sched-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.875rem;
}

.sched-table th,
.sched-table td {
  text-align: left;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--sapList_BorderColor, #e4e5e7);
}

.sched-table th {
  background: var(--sapList_HeaderBackground, #f5f6f7);
  font-weight: 600;
  user-select: none;
  padding: 0;
  white-space: nowrap;
}

.sched-table th button {
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

.sched-table th button:hover {
  background: var(--sapList_Hover_Background, #eaecee);
}

.sched-table tr:last-child td {
  border-bottom: none;
}

.sched-row {
  cursor: pointer;
  transition: background 0.1s;
}

.sched-row:hover {
  background: var(--sapList_Hover_Background, #eaecee);
}

.sched-row--complete {
  background: var(--sapSuccessBackground, #f1fdf6);
}

.sched-row--complete:hover {
  background: var(--sapSuccessBorderColor, #d4f0e0);
}

.sched-table .num {
  text-align: right;
}

.sched-title-cell {
  font-weight: 500;
  max-width: 28rem;
}

.sched-time {
  color: var(--sapContent_LabelColor, #6a6d70);
  margin-left: 0.25rem;
}

.sched-links-cell {
  white-space: nowrap;
}

.sched-link {
  display: inline-block;
  margin-right: 0.25rem;
  color: var(--sapLinkColor, #0854a0);
  text-decoration: none;
  font-size: 1rem;
}

.sched-link:hover {
  text-decoration: underline;
}

.sched-link--yt {
  color: #c4302b;
}

.sched-kind-badge {
  display: inline-block;
  padding: 0.1rem 0.4rem;
  border-radius: 0.75rem;
  font-size: 0.75rem;
  font-weight: 600;
  white-space: nowrap;
}

.sched-kind-badge--session {
  background: var(--sapInformativeBackground, #e8f3ff);
  color: var(--sapInformativeColor, #0854a0);
}

.sched-kind-badge--activity {
  background: var(--sapSuccessBackground, #f1fdf6);
  color: var(--sapPositiveColor, #107e3e);
}

.sched-done {
  color: var(--sapPositiveColor, #107e3e);
  font-weight: 700;
  font-size: 1rem;
}
</style>
