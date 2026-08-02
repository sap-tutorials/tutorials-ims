<!-- hugo-apps/src/devtoberfest-sessions-calendar/DayAgenda.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { iso } from './calendar-core';
import type { TrackColor } from './track-colors';
import type { Session } from '../devtoberfest-schedule-shared/types';
import { youtubeThumb } from '../devtoberfest-schedule-shared/completion';

const props = defineProps<{
  cursor: Date;
  byDate: Map<string, Session[]>;
  colors: Map<string, TrackColor>;
  isAuthenticated: boolean;
}>();
const emit = defineEmits<{ (e: 'select', s: Session): void }>();

const sessions = computed(() => props.byDate.get(iso(props.cursor)) ?? []);
function borderColor(s: Session): string {
  const c = s.trackName ? props.colors.get(s.trackName) : null;
  return c ? c.border : 'var(--sapContent_ForegroundBorderColor, #e4e7ed)';
}
function onThumbError(ev: Event) {
  const img = ev.target as HTMLImageElement;
  img.style.display = 'none';
  const ph = img.nextElementSibling as HTMLElement | null;
  if (ph) ph.style.display = 'flex';
}
</script>

<template>
  <div class="da">
    <div v-if="sessions.length === 0" class="da-empty" aria-label="No sessions">No sessions this day.</div>
    <button
      v-for="s in sessions"
      :key="s.id"
      class="da-card"
      :class="{ 'da-card--complete': isAuthenticated && (s as any).complete }"
      :style="{ borderLeftColor: borderColor(s) }"
      @click="emit('select', s)"
    >
      <div class="da-thumb-wrap">
        <template v-if="youtubeThumb((s as any).youtubeUrl || '')">
          <img :src="youtubeThumb((s as any).youtubeUrl)!" :alt="s.title" class="da-thumb" loading="lazy" @error="onThumbError" />
          <div class="da-thumb-ph" style="display:none" aria-hidden="true"></div>
        </template>
        <div v-else class="da-thumb-ph" aria-hidden="true"></div>
      </div>
      <div class="da-meta">
        <span v-if="s.scheduledTime" class="da-time">{{ s.scheduledTime }}</span>
        <span class="da-title">{{ s.title }}</span>
        <span v-if="s.trackName" class="da-track">{{ s.trackName }}</span>
        <span v-if="isAuthenticated && (s as any).complete" class="da-done" aria-label="Completed">✓ Completed</span>
      </div>
    </button>
  </div>
</template>

<style scoped>
.da { display: flex; flex-direction: column; gap: 0.6rem; }
.da-empty { padding: 1.5rem; text-align: center; color: var(--sapContent_LabelColor, #6a6d70); }
.da-card {
  display: flex; gap: 0.75rem; align-items: center; border: 1px solid var(--sapList_BorderColor, #e4e7ed);
  border-left: 5px solid transparent; border-radius: 8px; padding: 0.6rem; cursor: pointer; font: inherit;
  text-align: left; background: var(--sapBaseColor, #fff);
}
.da-card--complete { background: var(--sapSuccessBackground, #f1fdf6); }
.da-thumb-wrap { position: relative; width: 7.5rem; aspect-ratio: 16 / 9; flex: 0 0 auto; border-radius: 6px; overflow: hidden; background: var(--sapShellColor, #354a5e); }
.da-thumb { width: 100%; height: 100%; object-fit: cover; display: block; }
.da-thumb-ph { width: 100%; height: 100%; display: flex; align-items: center; justify-content: center; background: linear-gradient(135deg, var(--sapShellColor, #354a5e) 0%, #1a2e3e 100%); color: rgba(255,255,255,0.4); font-size: 1.25rem; }
.da-thumb-ph::after { content: '▶'; }
.da-meta { display: flex; flex-direction: column; gap: 0.15rem; }
.da-time { font-size: 0.72rem; color: var(--sapContent_LabelColor, #6a6d70); font-variant-numeric: tabular-nums; }
.da-title { font-size: 1rem; font-weight: 600; }
.da-track { font-size: 0.72rem; color: var(--sapContent_LabelColor, #6a6d70); }
.da-done { font-size: 0.72rem; color: var(--sapPositiveColor, #107e3e); font-weight: 700; }
</style>
