<script setup lang="ts">
import { ref, computed, onMounted } from 'vue';
import { fetchFeed, fetchMyCompletions } from '../devtoberfest-schedule-shared/feed';
import { mergeCompletion, youtubeThumb, safeHref } from '../devtoberfest-schedule-shared/completion';
import EditionPicker from '../devtoberfest-schedule-shared/EditionPicker.vue';
import PointsBanner from '../devtoberfest-schedule-shared/PointsBanner.vue';
import DetailPanel from '../devtoberfest-schedule-shared/DetailPanel.vue';
import type { Feed, ScheduleRow } from '../devtoberfest-schedule-shared/types';

const loading = ref(true);
const error = ref('');
const editionId = ref<string | null>(null);
const feed = ref<Feed | null>(null);
const sessions = ref<ScheduleRow[]>([]);
const earnedPoints = ref(0);
const maxPoints = ref(0);
const isAuthenticated = ref(false);
const selectedRow = ref<ScheduleRow | null>(null);

const filterWeek = ref('');
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
    isAuthenticated.value = myData.authenticated;
    const merged = mergeCompletion(feedData, myData);
    // Sessions grid: only session rows
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

const weekOptions = computed(() => {
  const set = new Set<string>();
  sessions.value.forEach((r) => { if (r.week) set.add(r.week); });
  return Array.from(set).sort();
});

const trackOptions = computed(() => {
  const set = new Set<string>();
  sessions.value.forEach((r) => { if ((r as any).trackName) set.add((r as any).trackName); });
  return Array.from(set).sort();
});

const completeCount = computed(() => sessions.value.filter((r) => r.complete).length);

const filtered = computed(() => {
  return sessions.value.filter((r) => {
    if (filterWeek.value && r.week !== filterWeek.value) return false;
    if (filterTrack.value && (r as any).trackName !== filterTrack.value) return false;
    return true;
  });
});

function clearFilters() {
  filterWeek.value = '';
  filterTrack.value = '';
}

function onThumbError(ev: Event) {
  const img = ev.target as HTMLImageElement;
  img.style.display = 'none';
  const placeholder = img.nextElementSibling as HTMLElement | null;
  if (placeholder) placeholder.style.display = 'flex';
}

onMounted(() => loadData());
</script>

<template>
  <div class="sg-wrap">
    <!-- header -->
    <div class="sg-header">
      <h1 class="sg-title">Devtoberfest Sessions</h1>
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
    <div v-if="loading" class="sg-state">Loading sessions…</div>

    <!-- error -->
    <div v-else-if="error" class="sg-state sg-state--error">
      <ui5-illustrated-message name="UnableToLoad" size="Scene">
        <div slot="subtitle">{{ error }}</div>
      </ui5-illustrated-message>
    </div>

    <template v-else>
      <!-- filters -->
      <div class="sg-toolbar" role="search">
        <label class="sg-field">
          <span>Week</span>
          <select v-model="filterWeek">
            <option value="">All weeks</option>
            <option v-for="w in weekOptions" :key="w" :value="w">Week {{ w }}</option>
          </select>
        </label>
        <label class="sg-field">
          <span>Track</span>
          <select v-model="filterTrack">
            <option value="">All tracks</option>
            <option v-for="t in trackOptions" :key="t" :value="t">{{ t }}</option>
          </select>
        </label>
        <button
          v-if="filterWeek || filterTrack"
          class="sg-btn sg-btn-ghost"
          @click="clearFilters"
        >Clear</button>
        <span class="sg-count">{{ filtered.length }} session{{ filtered.length === 1 ? '' : 's' }}</span>
      </div>

      <!-- empty -->
      <div v-if="filtered.length === 0" class="sg-state sg-state--empty">
        <ui5-illustrated-message name="NoData" size="Scene">
          <div slot="subtitle">No sessions match your filters.</div>
        </ui5-illustrated-message>
      </div>

      <!-- grid -->
      <div v-else class="sg-grid">
        <article
          v-for="session in filtered"
          :key="session.id"
          class="sg-card"
          :class="{ 'sg-card--complete': session.complete && isAuthenticated }"
        >
          <!-- thumbnail -->
          <div class="sg-thumb-wrap">
            <template v-if="youtubeThumb((session as any).youtubeUrl)">
              <img
                :src="youtubeThumb((session as any).youtubeUrl)!"
                :alt="`${session.title} thumbnail`"
                class="sg-thumb"
                loading="lazy"
                @error="onThumbError"
              />
              <div class="sg-thumb-placeholder" style="display:none" aria-hidden="true"></div>
            </template>
            <div v-else class="sg-thumb-placeholder" aria-hidden="true"></div>
          </div>

          <!-- card body -->
          <div class="sg-card-body">
            <!-- badges row -->
            <div class="sg-badges">
              <span v-if="(session as any).trackName" class="sg-badge sg-badge--track">
                {{ (session as any).trackName }}
              </span>
              <span v-if="session.week" class="sg-badge sg-badge--week">Week {{ session.week }}</span>
              <span v-if="isAuthenticated && session.complete" class="sg-done" aria-label="Completed">✓ Done</span>
            </div>

            <h3 class="sg-card-title">{{ session.title }}</h3>

            <!-- date/time -->
            <p v-if="(session as any).scheduledDate" class="sg-datetime">
              {{ (session as any).scheduledDate }}
              <span v-if="(session as any).scheduledTime" class="sg-time">{{ (session as any).scheduledTime }}</span>
            </p>

            <!-- links -->
            <div class="sg-links">
              <a
                v-if="(session as any).youtubeUrl"
                :href="safeHref((session as any).youtubeUrl)"
                target="_blank"
                rel="noopener noreferrer"
                class="sg-link sg-link--yt"
                title="Watch on YouTube"
              >▶ YouTube</a>
              <a
                v-if="(session as any).communityEventUrl"
                :href="safeHref((session as any).communityEventUrl)"
                target="_blank"
                rel="noopener noreferrer"
                class="sg-link"
                title="Community event"
              >↗ Community</a>
              <button
                v-if="(session as any).activityId"
                class="sg-link sg-link--activity"
                @click="selectedRow = session"
                title="View linked activity"
              >→ Activity</button>
            </div>
          </div>
        </article>
      </div>
    </template>

    <DetailPanel :row="selectedRow ?? null" @close="selectedRow = null" />
  </div>
</template>

<style scoped>
.sg-wrap {
  font-family: var(--sapFontFamily, '72', 'Helvetica Neue', Arial, sans-serif);
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.sg-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.75rem;
}

.sg-title {
  font-size: var(--sapFontHeader2Size, 1.5rem);
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
  margin: 0;
}

.sg-state {
  padding: 2rem;
  text-align: center;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sg-state--error {
  color: var(--sapNegativeColor, #b00020);
}

.sg-state--empty {
  background: transparent;
}

.sg-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: flex-end;
}

.sg-field {
  display: flex;
  flex-direction: column;
  font-size: 0.875rem;
}

.sg-field span {
  margin-bottom: 0.25rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sg-field select {
  min-width: 10rem;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
  background: var(--sapField_Background, #fff);
  color: inherit;
  font: inherit;
}

.sg-btn {
  display: inline-block;
  padding: 0.4rem 0.9rem;
  border-radius: 0.25rem;
  background: var(--sapButton_Emphasized_Background, #0854a0);
  color: #fff;
  border: none;
  cursor: pointer;
  font: inherit;
}

.sg-btn-ghost {
  background: transparent;
  color: var(--sapLinkColor, #0854a0);
  border: 1px solid var(--sapField_BorderColor, #89919a);
}

.sg-count {
  margin-left: auto;
  color: var(--sapContent_LabelColor, #6a6d70);
  font-size: 0.875rem;
  align-self: flex-end;
}

/* grid */
.sg-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: var(--sapContent_Gap, 1rem);
}

.sg-card {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
  border-radius: 8px;
  background: var(--sapBaseColor, #fff);
  overflow: hidden;
}

.sg-card--complete {
  border-color: var(--sapSuccessBorderColor, #5cb85c);
  background: var(--sapSuccessBackground, #f1fdf6);
}

/* thumbnail */
.sg-thumb-wrap {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
  background: var(--sapShellColor, #354a5e);
  overflow: hidden;
}

.sg-thumb {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.sg-thumb-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--sapShellColor, #354a5e) 0%, #1a2e3e 100%);
  color: rgba(255,255,255,0.4);
  font-size: 2rem;
}

.sg-thumb-placeholder::after {
  content: '▶';
}

/* card body */
.sg-card-body {
  padding: 0.75rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  flex: 1;
}

.sg-badges {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}

.sg-badge {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 20px;
  font-size: 0.72rem;
  font-weight: 600;
  white-space: nowrap;
}

.sg-badge--track {
  background: var(--sapInformativeBackground, #e8f3ff);
  color: var(--sapInformativeColor, #0854a0);
}

.sg-badge--week {
  background: var(--sapNeutralBackground, #f5f6f7);
  color: var(--sapContent_LabelColor, #6a6d70);
}

.sg-done {
  color: var(--sapPositiveColor, #107e3e);
  font-weight: 700;
  font-size: 0.8rem;
  margin-left: auto;
}

.sg-card-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  line-height: 1.35;
  color: var(--sapTextColor, #32363a);
}

.sg-datetime {
  font-size: 0.8rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0;
}

.sg-time {
  margin-left: 0.25rem;
}

.sg-links {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  margin-top: auto;
  padding-top: 0.5rem;
}

.sg-link {
  display: inline-block;
  padding: 0.25rem 0.6rem;
  border-radius: 4px;
  font-size: 0.8rem;
  font-weight: 600;
  text-decoration: none;
  color: var(--sapLinkColor, #0854a0);
  border: 1px solid currentColor;
  background: transparent;
  cursor: pointer;
  font-family: inherit;
}

.sg-link:hover {
  background: var(--sapHighlightColor, #0854a0);
  color: #fff;
}

.sg-link--yt {
  color: #c4302b;
  border-color: #c4302b;
}

.sg-link--yt:hover {
  background: #c4302b;
  color: #fff;
}

.sg-link--activity {
  color: var(--sapPositiveColor, #107e3e);
  border-color: currentColor;
}
</style>
