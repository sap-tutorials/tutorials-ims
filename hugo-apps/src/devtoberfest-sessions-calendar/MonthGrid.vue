<!-- hugo-apps/src/devtoberfest-sessions-calendar/MonthGrid.vue -->
<script setup lang="ts">
import { computed, ref, onMounted, onBeforeUnmount } from 'vue';
import { monthGridCells, iso } from './calendar-core';
import type { TrackColor } from './track-colors';
import type { Session } from '../devtoberfest-schedule-shared/types';
import { formatViewerTimeShort } from '../devtoberfest-schedule-shared/format-session-time';
import { speakerNames } from '../devtoberfest-schedule-shared/completion';
import { broadcastingTag } from '../devtoberfest-schedule-shared/broadcasting';

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
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const cells = computed(() => monthGridCells(props.cursor));
const cursorMonth = computed(() => props.cursor.getUTCMonth());

// Key (YYYY-MM-DD) of the day whose overflow popover is open, or null. Only one
// popover is open at a time — clicking "+N more" on another day switches focus.
const openKey = ref<string | null>(null);

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
/** Full title incl. speakers — surfaced only in the hover tooltip; the visible
 *  chip is deliberately terse (time + truncated title) so the month grid fits. */
function chipTitle(s: Session): string {
  const sp = speakerNames(s);
  return sp ? `${s.title} — ${sp}` : s.title;
}
function dayLabel(d: Date): string {
  return `${DOW[(d.getUTCDay() + 6) % 7]} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}
function toggleDay(d: Date) {
  const k = iso(d);
  openKey.value = openKey.value === k ? null : k;
}
function pick(s: Session) {
  emit('select', s);
  openKey.value = null;
}
function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') openKey.value = null;
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown));
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
            :title="chipTitle(s)"
          >
            <span v-if="s.scheduledStart" class="mg-chip-t">{{ formatViewerTimeShort(s.scheduledStart) }}</span>
            <span
              v-if="broadcastingTag((s as any).broadcastingPreference)"
              class="mg-chip-fmt"
              :class="`mg-chip-fmt--${broadcastingTag((s as any).broadcastingPreference)!.modifier}`"
              :aria-label="broadcastingTag((s as any).broadcastingPreference)!.label"
              :title="broadcastingTag((s as any).broadcastingPreference)!.label"
            >{{ broadcastingTag((s as any).broadcastingPreference)!.icon }}</span>
            <span class="mg-chip-n">{{ s.title }}</span>
          </button>
        </template>
        <button
          v-if="sessionsFor(cell).length > maxChips"
          class="mg-more"
          :aria-expanded="openKey === iso(cell)"
          @click="toggleDay(cell)"
        >+{{ sessionsFor(cell).length - maxChips }} more</button>

        <!-- Per-day overflow popover: lists ALL sessions for this day in place,
             so a busy day is browsable without leaving the month view (#2046). -->
        <div
          v-if="openKey === iso(cell)"
          class="mg-pop"
          role="dialog"
          :aria-label="'Sessions on ' + dayLabel(cell)"
        >
          <div class="mg-pop-head">
            <span class="mg-pop-title">{{ dayLabel(cell) }}</span>
            <button class="mg-pop-close" aria-label="Close" @click="openKey = null">✕</button>
          </div>
          <div class="mg-pop-list">
            <button
              v-for="s in sessionsFor(cell)"
              :key="s.id"
              class="mg-chip mg-pop-chip"
              :class="{ 'mg-chip--complete': isAuthenticated && (s as any).complete }"
              :style="chipStyle(s)"
              @click="pick(s)"
              :title="chipTitle(s)"
            >
              <span v-if="s.scheduledStart" class="mg-chip-t">{{ formatViewerTimeShort(s.scheduledStart) }}</span>
              <span
                v-if="broadcastingTag((s as any).broadcastingPreference)"
                class="mg-chip-fmt"
                :class="`mg-chip-fmt--${broadcastingTag((s as any).broadcastingPreference)!.modifier}`"
                :aria-label="broadcastingTag((s as any).broadcastingPreference)!.label"
                :title="broadcastingTag((s as any).broadcastingPreference)!.label"
              >{{ broadcastingTag((s as any).broadcastingPreference)!.icon }}</span>
              <span class="mg-chip-n">{{ s.title }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
    <!-- Full-bleed backdrop closes the popover on any outside click. -->
    <button v-if="openKey" class="mg-backdrop" aria-hidden="true" tabindex="-1" @click="openKey = null"></button>
  </div>
</template>

<style scoped>
.mg { position: relative; border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-radius: 6px; overflow: hidden; }
/* minmax(0, 1fr) — NOT bare 1fr — so the seven columns stay equal and the grid
   never exceeds its container. Bare 1fr resolves to minmax(auto, 1fr), whose
   `auto` min-track is the widest nowrap chip, which blew each weekday column
   past the viewport and clipped Sat/Sun off-screen (#2046). */
.mg-head, .mg-body { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); }
.mg-dow {
  padding: 0.4rem; text-align: center; font-size: 0.72rem; text-transform: uppercase;
  letter-spacing: 0.04em; font-weight: 700; color: var(--sapContent_LabelColor, #6a6d70);
  background: var(--sapList_HeaderBackground, #f5f6f7); border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed);
}
.mg-cell {
  position: relative; min-width: 0; min-height: 6rem; padding: 0.25rem;
  border-right: 1px solid var(--sapList_BorderColor, #e4e7ed);
  border-bottom: 1px solid var(--sapList_BorderColor, #e4e7ed); display: flex; flex-direction: column; gap: 0.15rem;
}
.mg-cell--other { background: var(--sapList_HeaderBackground, #fafafa); }
.mg-daynum {
  align-self: flex-start; border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 0.75rem; font-weight: 600; color: var(--sapContent_LabelColor, #6a6d70); padding: 0.1rem 0.25rem; border-radius: 4px;
}
.mg-cell--today .mg-daynum { background: var(--sapButton_Emphasized_Background, #0a6ed1); color: #fff; }
.mg-chip {
  display: flex; align-items: baseline; gap: 0.3rem; min-width: 0; width: 100%; text-align: left;
  border: none; border-left: 3px solid transparent; border-radius: 4px; padding: 0.1rem 0.35rem;
  cursor: pointer; font: inherit; font-size: 0.72rem; background: var(--sapList_Background, #f5f6f7);
}
.mg-chip--complete { outline: 1px solid var(--sapSuccessBorderColor, #107e3e); }
.mg-chip-t { flex: 0 0 auto; font-variant-numeric: tabular-nums; opacity: 0.75; }
.mg-chip-fmt { flex: 0 0 auto; font-size: 0.7rem; line-height: 1; }
.mg-chip-fmt--live { color: var(--sapNegativeColor, #b00020); }
.mg-chip-fmt--prerecorded { opacity: 0.6; }
.mg-chip-n { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mg-more { align-self: flex-start; border: none; background: transparent; cursor: pointer; font: inherit;
  font-size: 0.72rem; font-weight: 600; color: var(--sapLinkColor, #0a6ed1); padding: 0.1rem 0.25rem; }

/* Overflow popover */
.mg-backdrop { position: absolute; inset: 0; z-index: 5; border: none; background: transparent; cursor: default; padding: 0; }
.mg-pop {
  position: absolute; z-index: 6; top: 1.6rem; left: 0.25rem; right: 0.25rem; min-width: 12rem; max-width: 20rem;
  max-height: 16rem; overflow-y: auto; padding: 0.4rem; background: var(--sapGroup_ContentBackground, #fff);
  border: 1px solid var(--sapList_BorderColor, #e4e7ed); border-radius: 6px;
  box-shadow: 0 0.25rem 1rem rgba(0,0,0,0.18); display: flex; flex-direction: column; gap: 0.25rem;
}
.mg-pop-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0 0.1rem 0.25rem; }
.mg-pop-title { font-size: 0.75rem; font-weight: 700; color: var(--sapContent_LabelColor, #6a6d70); }
.mg-pop-close { border: none; background: transparent; cursor: pointer; font: inherit; font-size: 0.85rem; line-height: 1; color: var(--sapContent_LabelColor, #6a6d70); padding: 0.1rem 0.25rem; border-radius: 4px; }
.mg-pop-list { display: flex; flex-direction: column; gap: 0.2rem; }
.mg-pop-chip { font-size: 0.75rem; padding: 0.25rem 0.4rem; }
.mg-pop-chip .mg-chip-n { white-space: normal; }
</style>
