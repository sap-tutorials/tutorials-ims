<script setup lang="ts">
import { computed } from 'vue'
import type { LeaderboardRow, MyGameboard } from './types'

const props = defineProps<{
  rows: LeaderboardRow[]
  total?: number
  page?: number
  pageCount?: number
  mine?: MyGameboard | null
}>()
const emit = defineEmits<{ (e: 'prev'): void; (e: 'next'): void }>()

const maxScore = computed(() => Math.max(1, ...props.rows.map(r => r.score)))
function barWidth(score: number): string {
  return `${Math.round((score / maxScore.value) * 100)}%`
}

const total = computed(() => props.total ?? props.rows.length)
const page = computed(() => props.page ?? 1)
const pageCount = computed(() => props.pageCount ?? 1)
const hasPrev = computed(() => page.value > 1)
const hasNext = computed(() => page.value < pageCount.value)

// The caller's own standing (issue #2510 "where am I"). Only a joined caller
// with a resolved rank counts; anonymous / not-joined has no rank.
const myRank = computed<number | null>(() =>
  props.mine && props.mine.status === 'joined' && props.mine.rank != null ? props.mine.rank : null,
)
// The caller's own community profile URL — the unique, already-public key that
// identifies the caller's row. Matching by rank is WRONG under ties (all tied
// rows share one rank, so every tied row would be tagged "(you)" — #2510). Null
// when the caller isn't a joined participant or has no community profile → we
// then tag no row rather than risk a false match.
const myCommunityUrl = computed<string | null>(() =>
  props.mine && props.mine.status === 'joined' ? (props.mine.communityUrl ?? null) : null,
)
// Is the caller's row on the CURRENTLY VISIBLE page? Match by communityUrl.
const myRankOnPage = computed(() =>
  myCommunityUrl.value != null && props.rows.some(r => r.communityUrl === myCommunityUrl.value),
)
// Show a pinned "You" row beneath the table only when the caller is ranked but
// NOT on the visible page (so they always see where they stand — Strava-style).
const showStickyMe = computed(() => myRank.value != null && !myRankOnPage.value)
function isMe(row: LeaderboardRow): boolean {
  return myCommunityUrl.value != null && row.communityUrl === myCommunityUrl.value
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
      <caption id="gb-lb-cap" class="gb-lb-caption">
        Devtoberfest leaderboard — live
        <span v-if="total" class="gb-lb-count" data-testid="participant-count">· {{ total }} participant{{ total === 1 ? '' : 's' }}</span>
      </caption>
      <thead>
        <tr>
          <th scope="col" class="gb-lb-rank">Rank</th>
          <th scope="col">Player</th>
          <th scope="col">Score</th>
          <th scope="col">Level</th>
        </tr>
      </thead>
      <tbody>
        <tr
          v-for="r in rows"
          :key="r.rank + ':' + r.displayName"
          :class="{ 'gb-lb-me': isMe(r) }"
          :aria-current="isMe(r) ? 'true' : undefined"
          :data-testid="isMe(r) ? 'lb-row-me' : undefined"
        >
          <td class="gb-lb-rank">{{ r.rank }}</td>
          <td>
            <a v-if="safeHref(r.communityUrl)" :href="safeHref(r.communityUrl)!" rel="noopener noreferrer" target="_blank">{{ r.displayName }}</a>
            <span v-else>{{ r.displayName }}</span>
            <span v-if="isMe(r)" class="gb-lb-you-tag"> (you)</span>
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
      <!-- Sticky "You" row: the caller's standing when they're ranked but not on
           this page. Rendered in a tfoot so it reads as a table row. -->
      <tfoot v-if="showStickyMe">
        <tr class="gb-lb-me gb-lb-me-sticky" aria-current="true" data-testid="lb-row-me-sticky">
          <td class="gb-lb-rank">{{ myRank }}</td>
          <td>You<span class="gb-lb-you-tag"> (you)</span></td>
          <td><span class="gb-score-num">{{ mine!.score }}</span></td>
          <td>{{ mine!.level }}</td>
        </tr>
      </tfoot>
    </table>

    <p v-if="!rows.length" class="gb-lb-empty" role="status">No scores yet — be the first to complete a tutorial!</p>

    <!-- Pager (issue #2510): prev/next with "Page X of Y". Hidden when a single page. -->
    <nav v-if="pageCount > 1" class="gb-lb-pager" aria-label="Leaderboard pages">
      <button
        type="button"
        class="fd-button fd-button--transparent gb-lb-pager-prev"
        data-testid="lb-prev"
        :disabled="!hasPrev"
        @click="emit('prev')"
      >‹ Prev</button>
      <span class="gb-lb-pager-status" aria-live="polite" data-testid="lb-page-status">Page {{ page }} of {{ pageCount }}</span>
      <button
        type="button"
        class="fd-button fd-button--transparent gb-lb-pager-next"
        data-testid="lb-next"
        :disabled="!hasNext"
        @click="emit('next')"
      >Next ›</button>
    </nav>
  </div>
</template>
