<script setup lang="ts">
import { computed } from 'vue'
import type { LeaderboardRow } from './types'

const props = defineProps<{ rows: LeaderboardRow[] }>()
const maxScore = computed(() => Math.max(1, ...props.rows.map(r => r.score)))
function barWidth(score: number): string {
  return `${Math.round((score / maxScore.value) * 100)}%`
}

// communityUrl derives from user-controlled Users.khorosId/khorosLogin. Vue does NOT
// sanitize :href, so a `javascript:`/`data:` URI would execute on click. Only render
// the anchor for an http(s) scheme; otherwise fall back to a plain span.
function safeHref(u: string | null): string | null {
  if (!u) return null
  try {
    const parsed = new URL(u, window.location.origin)
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') ? u : null
  } catch {
    return null
  }
}
</script>

<template>
  <div class="gb-leaderboard">
    <table class="fd-table gb-lb-table" aria-describedby="gb-lb-cap">
      <caption id="gb-lb-cap" class="gb-lb-caption">Devtoberfest leaderboard — live</caption>
      <thead>
        <tr>
          <th scope="col" class="gb-lb-rank">Rank</th>
          <th scope="col">Player</th>
          <th scope="col">Score</th>
          <th scope="col">Level</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.rank">
          <td class="gb-lb-rank">{{ r.rank }}</td>
          <td>
            <a v-if="safeHref(r.communityUrl)" :href="safeHref(r.communityUrl)!" rel="noopener noreferrer" target="_blank">{{ r.displayName }}</a>
            <span v-else>{{ r.displayName }}</span>
          </td>
          <td>
            <span class="gb-score-num">{{ r.score }}</span>
            <span class="gb-score-track" aria-hidden="true">
              <span class="gb-score-bar" data-testid="score-bar" :style="{ width: barWidth(r.score) }"></span>
            </span>
          </td>
          <td>{{ r.level }}</td>
        </tr>
      </tbody>
    </table>
    <p v-if="!rows.length" class="gb-lb-empty" role="status">No scores yet — be the first to complete a tutorial!</p>
  </div>
</template>
