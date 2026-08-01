<script setup lang="ts">
import { computed } from 'vue'
import type { GameboardConfig, WeekTrackTotal, WeekTrackBreakdown } from './types'

const props = defineProps<{ board: GameboardConfig; imgBase: string }>()

const personalized = computed(() => props.board.personalized)

// avatarIndex (0..37) → Group-<n>.png. Clamp defensively to the shipped range.
const avatarSrc = computed(() => {
  const idx = Math.min(37, Math.max(0, personalized.value?.avatarIndex ?? 0))
  return `${props.imgBase}/avatars/Group-${idx}.png`
})

// trackId → title lookup from board.tracks (fail-soft []). Falls back to the raw
// id only when the track isn't found (defensive; keeps meters labelled).
const trackTitles = computed<Map<string, string>>(() => {
  const m = new Map<string, string>()
  for (const t of props.board.tracks ?? []) m.set(t.trackId, t.title)
  return m
})
function trackTitle(trackId: string): string {
  return trackTitles.value.get(trackId) ?? trackId
}

// Group the flat totals by week for display: Map<week, WeekTrackTotal[]>.
const weeks = computed<Array<{ week: string; tracks: WeekTrackTotal[] }>>(() => {
  const byWeek = new Map<string, WeekTrackTotal[]>()
  for (const t of props.board.totals) {
    const arr = byWeek.get(t.week) ?? []
    arr.push(t)
    byWeek.set(t.week, arr)
  }
  return [...byWeek.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .map(([week, tracks]) => ({ week, tracks }))
})

// Personalized earned/total per week+track, keyed for O(1) lookup.
const earnedByKey = computed<Map<string, WeekTrackBreakdown>>(() => {
  const m = new Map<string, WeekTrackBreakdown>()
  for (const b of personalized.value?.breakdown ?? []) m.set(`${b.week}|${b.trackId}`, b)
  return m
})

// Progress % for a track cell: earnedPoints / totalPoints (0 when no personal data).
function pct(week: string, t: WeekTrackTotal): number {
  if (!t.totalPoints) return 0
  const earned = earnedByKey.value.get(`${week}|${t.trackId}`)?.earnedPoints ?? 0
  return Math.min(100, Math.round((earned / t.totalPoints) * 100))
}
function earnedPoints(week: string, t: WeekTrackTotal): number {
  return earnedByKey.value.get(`${week}|${t.trackId}`)?.earnedPoints ?? 0
}
</script>

<template>
  <section class="cabinet" aria-label="Devtoberfest arcade cabinet">
    <div class="cabinet-screen">
      <p class="cabinet-title">DEVTOBERFEST</p>

      <div v-if="personalized" class="cabinet-player">
        <img :src="avatarSrc" :alt="`Your avatar, level ${personalized.level}`" class="cabinet-avatar" width="96" height="96" />
        <p class="cabinet-level">Level {{ personalized.level }} · {{ personalized.score }} pts</p>
      </div>
      <p v-else class="cabinet-anon">Log in via the user menu (top-right) to see your level and progress.</p>

      <div class="cabinet-progress">
        <div v-for="wk in weeks" :key="wk.week" class="cabinet-week">
          <h2 class="cabinet-sub">Week {{ wk.week }}</h2>
          <ul class="cabinet-meters">
            <li v-for="t in wk.tracks" :key="t.trackId">
              <!-- Label by resolved track TITLE (falls back to trackId only if unknown). -->
              <span class="cabinet-meter-label">{{ trackTitle(t.trackId) }}</span>
              <span class="cabinet-meter" role="progressbar"
                    :aria-valuenow="earnedPoints(wk.week, t)" :aria-valuemin="0" :aria-valuemax="t.totalPoints"
                    :aria-label="`Week ${wk.week}, ${trackTitle(t.trackId)}: ${earnedPoints(wk.week, t)} of ${t.totalPoints} points`">
                <span class="cabinet-meter-fill" :style="{ width: pct(wk.week, t) + '%' }"></span>
              </span>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </section>
</template>
