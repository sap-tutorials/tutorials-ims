<!-- hugo-apps/src/devtoberfest-sessions-calendar/WeekAgenda.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { weekDays, iso } from './calendar-core';
import type { TrackColor } from './track-colors';
import type { Session } from '../devtoberfest-schedule-shared/types';

const props = defineProps<{
  cursor: Date;
  byDate: Map<string, Session[]>;
  colors: Map<string, TrackColor>;
  today: string;
  isAuthenticated: boolean;
}>();
const emit = defineEmits<{ (e: 'select', s: Session): void }>();

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const days = computed(() => weekDays(props.cursor));
function sessionsFor(d: Date): Session[] { return props.byDate.get(iso(d)) ?? []; }
function borderColor(s: Session): string {
  const c = s.trackName ? props.colors.get(s.trackName) : null;
  return c ? c.border : 'var(--sapContent_ForegroundBorderColor, #e4e7ed)';
}
</script>

<template>
  <div class="wk">
    <div v-for="(d, i) in days" :key="iso(d)" class="wk-col">
      <div class="wk-head" :class="{ 'wk-head--today': iso(d) === today }">
        <span class="wk-dow">{{ DOW[i] }}</span>
        <span class="wk-dnum">{{ d.getUTCDate() }}</span>
      </div>
      <div class="wk-body">
        <button
          v-for="s in sessionsFor(d)"
          :key="s.id"
          class="wk-card"
          :class="{ 'wk-card--complete': isAuthenticated && (s as any).complete }"
          :style="{ borderLeftColor: borderColor(s) }"
          @click="emit('select', s)"
        >
          <span v-if="s.scheduledTime" class="wk-t">{{ s.scheduledTime }}</span>
          <span class="wk-n">{{ s.title }}</span>
          <span v-if="isAuthenticated && (s as any).complete" class="wk-done" aria-label="Completed">✓</span>
        </button>
        <div v-if="sessionsFor(d).length === 0" class="wk-empty" aria-label="No sessions">—</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wk { display: grid; grid-template-columns: repeat(7, 1fr); border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-radius: 6px; overflow: hidden; }
.wk-col { border-left: 1px solid var(--sapList_BorderColor, #e4e7ed); min-height: 12rem; }
.wk-col:first-child { border-left: none; }
.wk-head { padding: 0.35rem; text-align: center; border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed); background: var(--sapList_HeaderBackground, #f5f6f7); }
.wk-head--today .wk-dnum { color: var(--sapButton_Emphasized_Background, #0a6ed1); }
.wk-dow { display: block; font-size: 0.65rem; text-transform: uppercase; color: var(--sapContent_LabelColor, #6a6d70); }
.wk-dnum { font-size: 1rem; font-weight: 700; }
.wk-body { padding: 0.35rem; display: flex; flex-direction: column; gap: 0.35rem; }
.wk-card {
  border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-left: 4px solid transparent; border-radius: 6px;
  padding: 0.35rem 0.4rem; cursor: pointer; font: inherit; text-align: left; background: var(--sapBaseColor, #fff);
}
.wk-card--complete { background: var(--sapSuccessBackground, #f1fdf6); }
.wk-t { display: block; font-size: 0.65rem; color: var(--sapContent_LabelColor, #6a6d70); font-variant-numeric: tabular-nums; }
.wk-n { display: block; font-size: 0.75rem; font-weight: 600; line-height: 1.25; }
.wk-done { color: var(--sapPositiveColor, #107e3e); font-size: 0.7rem; font-weight: 700; }
.wk-empty { color: var(--sapContent_DisabledTextColor, #b0b0b0); font-size: 0.75rem; text-align: center; padding: 0.75rem 0; }
</style>
