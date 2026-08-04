<script setup lang="ts">
import type { ScheduleRow } from './types';
import { youtubeThumb, safeHref } from './completion';
import { formatViewerLocal, formatHomeZone } from './format-session-time';
import { computed } from 'vue';

const props = defineProps<{
  row: ScheduleRow | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const thumb = computed(() => {
  if (!props.row) return null;
  const r = props.row as any;
  return r.youtubeUrl ? youtubeThumb(r.youtubeUrl) : null;
});

const taskUrl = computed(() => {
  const r = props.row as any;
  if (!r?.taskSlug) return null;
  const prefix = String(r.taskType).toLowerCase() === 'puzzle' ? '/puzzles' : '/tutorials';
  return `${prefix}/${r.taskSlug}`;
});

const isSession = computed(() => props.row?.kind === 'session');
const isActivity = computed(() => props.row?.kind === 'activity');
</script>

<template>
  <div v-if="row" class="detail-panel" role="dialog" aria-modal="true" :aria-label="row.title">
    <div class="detail-panel__backdrop" @click="emit('close')" />
    <div class="detail-panel__drawer">
      <div class="detail-panel__header">
        <h2 class="detail-panel__title">{{ row.title }}</h2>
        <button class="detail-panel__close" @click="emit('close')" aria-label="Close">&#x2715;</button>
      </div>

      <div v-if="thumb" class="detail-panel__thumb-wrap">
        <img :src="thumb" :alt="`Thumbnail for ${row.title}`" class="detail-panel__thumb" />
      </div>

      <div class="detail-panel__body">
        <p v-if="(row as any).abstract" class="detail-panel__abstract">{{ (row as any).abstract }}</p>

        <dl class="detail-panel__meta">
          <template v-if="(row as any).trackName">
            <dt>Track</dt>
            <dd>{{ (row as any).trackName }}</dd>
          </template>
          <template v-if="row.week">
            <dt>Week</dt>
            <dd>{{ row.week }}</dd>
          </template>
          <template v-if="(row as any).scheduledStart">
            <dt>When</dt>
            <dd>
              {{ formatViewerLocal((row as any).scheduledStart) }}
              <span v-if="(row as any).scheduledTimeZone" class="detail-panel__homezone">{{ formatHomeZone((row as any).scheduledStart, (row as any).scheduledTimeZone) }} · event time</span>
            </dd>
          </template>
          <template v-if="isActivity && (row as any).points">
            <dt>Points</dt>
            <dd>{{ (row as any).points }}</dd>
          </template>
          <template v-if="isActivity && (row as any).taskType">
            <dt>Type</dt>
            <dd>{{ (row as any).taskType }}</dd>
          </template>
        </dl>

        <div class="detail-panel__links">
          <a
            v-if="(row as any).youtubeUrl"
            :href="safeHref((row as any).youtubeUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="detail-panel__link detail-panel__link--youtube"
          >Watch on YouTube</a>
          <a
            v-if="(row as any).communityEventUrl"
            :href="safeHref((row as any).communityEventUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="detail-panel__link"
          >Community Event</a>
          <a
            v-if="taskUrl"
            :href="taskUrl"
            class="detail-panel__link detail-panel__link--task"
          >{{ String((row as any).taskType).toLowerCase() === 'puzzle' ? 'Open Puzzle' : 'Open Tutorial' }}</a>
        </div>

        <div v-if="row.complete" class="detail-panel__complete-badge">
          <span>&#x2713; Completed</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail-panel {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  justify-content: flex-end;
}

.detail-panel__backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
}

.detail-panel__drawer {
  position: relative;
  z-index: 1;
  width: min(480px, 100vw);
  height: 100%;
  background: var(--sapBackgroundColor, #fff);
  box-shadow: var(--sapContent_Shadow3, -4px 0 16px rgba(0,0,0,0.15));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.detail-panel__header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid var(--sapList_BorderColor, #e4e5e7);
  background: var(--sapList_HeaderBackground, #f5f6f7);
}

.detail-panel__title {
  font-size: var(--sapFontHeader4Size, 1.125rem);
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
  margin: 0;
}

.detail-panel__close {
  background: none;
  border: none;
  cursor: pointer;
  font-size: 1rem;
  color: var(--sapContent_IconColor, #6a6d70);
  padding: 0.25rem;
  flex-shrink: 0;
}

.detail-panel__close:hover {
  color: var(--sapTextColor, #32363a);
}

.detail-panel__thumb-wrap {
  flex-shrink: 0;
}

.detail-panel__thumb {
  width: 100%;
  height: auto;
  display: block;
  object-fit: cover;
  max-height: 200px;
}

.detail-panel__body {
  flex: 1;
  overflow-y: auto;
  padding: 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.detail-panel__abstract {
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapTextColor, #32363a);
  line-height: 1.5;
  margin: 0;
}

.detail-panel__meta {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 1rem;
  font-size: var(--sapFontSize, 0.875rem);
  margin: 0;
}

.detail-panel__meta dt {
  color: var(--sapContent_LabelColor, #6a6d70);
  font-weight: 600;
}

.detail-panel__meta dd {
  color: var(--sapTextColor, #32363a);
  margin: 0;
}

.detail-panel__links {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.detail-panel__link {
  display: inline-block;
  font-size: var(--sapFontSize, 0.875rem);
  color: var(--sapLinkColor, #0854a0);
  text-decoration: none;
}

.detail-panel__link:hover {
  text-decoration: underline;
}

.detail-panel__link--youtube {
  color: #c4302b;
}

.detail-panel__complete-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.25rem 0.75rem;
  background: var(--sapSuccessBackground, #f1fdf6);
  color: var(--sapPositiveColor, #107e3e);
  border: 1px solid var(--sapSuccessBorderColor, #107e3e);
  border-radius: 1rem;
  font-size: 0.8125rem;
  font-weight: 600;
  align-self: flex-start;
}

.detail-panel__homezone {
  display: block;
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin-top: 0.1rem;
}
</style>
