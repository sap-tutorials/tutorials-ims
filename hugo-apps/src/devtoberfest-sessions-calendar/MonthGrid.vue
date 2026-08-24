<!-- hugo-apps/src/devtoberfest-sessions-calendar/MonthGrid.vue -->
<script setup lang="ts">
import { computed } from 'vue';
import { monthGridCells, iso } from './calendar-core';
import type { TrackColor } from './track-colors';
import type { Session } from '../devtoberfest-schedule-shared/types';
import { formatViewerLocal } from '../devtoberfest-schedule-shared/format-session-time';
import { speakerNames } from '../devtoberfest-schedule-shared/completion';

const props = withDefaults(defineProps<{
  cursor: Date;
  byDate: Map<string, Session[]>;
  colors: Map<string, TrackColor>;
  today: string;
  isAuthenticated: boolean;
  maxChips?: number;
}>(), { maxChips: 3 });

const emit = defineEmits<{
  (e: 'select', s: Session): void;
  (e: 'openDay', d: Date): void;
}>();

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const cells = computed(() => monthGridCells(props.cursor));
const cursorMonth = computed(() => props.cursor.getUTCMonth());

function sessionsFor(d: Date): Session[] {
  return props.byDate.get(iso(d)) ?? [];
}
function chipColor(s: Session): TrackColor | null {
  return s.trackName ? props.colors.get(s.trackName) ?? null : null;
}
function chipStyle(s: Session) {
  const c = chipColor(s);
  return c ? { background: c.bg, borderLeftColor: c.border, color: c.text } : {};
}
</script>

<template>
  <div class="mg" role="grid" aria-label="Month calendar">
    <div class="mg-head" role="row">
      <div v-for="d in DOW" :key="d" class="mg-dow" role="columnheader">{{ d }}</div>
    </div>
    <div class="mg-body">
      <div
        v-for="cell in cells"
        :key="iso(cell)"
        class="mg-cell"
        :class="{ 'mg-cell--other': cell.getUTCMonth() !== cursorMonth, 'mg-cell--today': iso(cell) === today }"
        role="gridcell"
      >
        <button class="mg-daynum" @click="emit('openDay', cell)" :aria-label="'Open ' + iso(cell)">
          {{ cell.getUTCDate() }}
        </button>
        <template v-for="s in sessionsFor(cell).slice(0, maxChips)" :key="s.id">
          <button
            class="mg-chip"
            :class="{ 'mg-chip--complete': isAuthenticated && (s as any).complete }"
            :style="chipStyle(s)"
            @click="emit('select', s)"
            :title="speakerNames(s) ? `${s.title} — ${speakerNames(s)}` : s.title"
          >
            <span v-if="s.scheduledStart" class="mg-chip-t">{{ formatViewerLocal(s.scheduledStart) }}</span>
            <span class="mg-chip-n">{{ s.title }}</span>
            <span v-if="speakerNames(s)" class="mg-chip-sp"> · {{ speakerNames(s) }}</span>
          </button>
        </template>
        <button
          v-if="sessionsFor(cell).length > maxChips"
          class="mg-more"
          @click="emit('openDay', cell)"
        >+{{ sessionsFor(cell).length - maxChips }} more</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mg { border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-radius: 6px; overflow: hidden; }
.mg-head, .mg-body { display: grid; grid-template-columns: repeat(7, 1fr); }
.mg-dow {
  padding: 0.4rem; text-align: center; font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.04em; font-weight: 700; color: var(--sapContent_LabelColor, #6a6d70);
  background: var(--sapList_HeaderBackground, #f5f6f7); border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed);
}
.mg-cell {
  min-height: 6rem; padding: 0.25rem; border-right: 1px solid var(--sapList_BorderColor, #e4e7ed);
  border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed); display: flex; flex-direction: column; gap: 0.15rem;
}
.mg-cell--other { background: var(--sapList_HeaderBackground, #fafafa); }
.mg-daynum {
  align-self: flex-start; border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 0.75rem; font-weight: 600; color: var(--sapContent_LabelColor, #6a6d70); padding: 0.1rem 0.25rem; border-radius: 4px;
}
.mg-cell--today .mg-daynum { background: var(--sapButton_Emphasized_Background, #0a6ed1); color: #fff; }
.mg-chip {
  display: block; width: 100%; text-align: left; border: none; border-left: 3px solid transparent;
  border-radius: 4px; padding: 0.1rem 0.35rem; cursor: pointer; font: inherit; font-size: 0.72rem;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; background: var(--sapList_Background, #f5f6f7);
}
.mg-chip--complete { outline: 1px solid var(--sapSuccessBorderColor, #107e3e); }
.mg-chip-t { font-variant-numeric: tabular-nums; opacity: 0.75; margin-right: 0.25rem; }
.mg-chip-sp { opacity: 0.7; font-weight: 400; }
.mg-more { align-self: flex-start; border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 0.72rem; font-weight: 600; color: var(--sapLinkColor, #0a6ed1); padding: 0.1rem 0.25rem; }
</style>
