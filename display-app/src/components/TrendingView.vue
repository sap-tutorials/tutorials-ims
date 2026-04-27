<script setup lang="ts">
import { computed } from 'vue'

interface BucketData {
  name: string
  count: number
  justUpdated: boolean
}

const props = defineProps<{
  buckets: readonly BucketData[]
  velocity: ReadonlyMap<string, number>
  rankCount: number
}>()

interface TrendItem {
  name: string
  count: number
  velocity: number
  pct: number
  hot: boolean
}

const trending = computed<TrendItem[]>(() => {
  const items = props.buckets.map(b => ({
    name: b.name,
    count: b.count,
    velocity: props.velocity.get(b.name) ?? 0,
  }))
  items.sort((a, b) => b.velocity - a.velocity)
  const top = items.slice(0, props.rankCount)
  const maxVel = top[0]?.velocity || 1
  return top.map((item, i) => ({
    ...item,
    pct: (item.velocity / maxVel) * 100,
    hot: i === 0 && item.velocity > 0,
  }))
})

function fmtVel(v: number): string {
  return v < 1 ? v.toFixed(1) : Math.round(v).toString()
}

function fmt(n: number): string { return n.toLocaleString() }
</script>

<template>
  <div class="trending-view">
    <div v-for="(item, i) in trending" :key="item.name" class="trend-row" :class="{ hot: item.hot, cold: item.velocity === 0 }">
      <div class="trend-icon">
        <svg v-if="item.velocity > 0" viewBox="0 0 24 24" fill="currentColor" width="28" height="28" :class="{ 'flame-icon': item.hot }">
          <path d="M12 23c-4.97 0-9-3.58-9-8 0-3.07 2.17-5.84 3.5-7.2.38-.39 1.01-.1 1.04.42.12 2.02.82 3.6 2.12 4.74.13.11.32.06.37-.1.43-1.38.95-3.5 1-6.1.01-.42.5-.65.82-.38C15.3 9.25 19 13.05 19 17c0 3.31-2.69 6-7 6z"/>
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="currentColor" width="28" height="28" class="ice-icon">
          <path d="M12 2L9.5 6.5 5 5.5l1 4.5L2 12l4 2 -1 4.5 4.5-1L12 22l2.5-4.5 4.5 1-1-4.5 4-2-4-2 1-4.5-4.5 1z"/>
        </svg>
      </div>
      <div class="trend-info">
        <div class="trend-name">{{ item.name }}</div>
        <div class="trend-bar-track">
          <div class="trend-bar-fill" :style="{ width: item.pct + '%' }"></div>
        </div>
      </div>
      <div class="trend-stats">
        <div class="trend-vel">+{{ fmtVel(item.velocity) }}<span class="trend-vel-unit">/min</span></div>
        <div class="trend-total">{{ fmt(item.count) }} total</div>
      </div>
    </div>
  </div>
</template>

<style>
.trending-view {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.trend-row {
  display: flex;
  align-items: center;
  gap: 1.25rem;
  padding: 0.75rem 1rem;
  border-radius: var(--sapButton_BorderCornerRadius);
  transition: background-color 0.3s ease;
}

.trend-row.hot {
  background: var(--d-gold-bg);
}

.trend-icon {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.trend-row.hot .trend-icon { color: var(--d-gold); }
.trend-row:not(.hot):not(.cold) .trend-icon { color: var(--d-accent); }
.trend-row.cold .trend-icon { color: var(--d-text-dim); }

.flame-icon {
  animation: flame-flicker 0.8s ease-in-out infinite alternate;
}

.ice-icon {
  opacity: 0.4;
}

.trend-info {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.trend-name {
  font-size: clamp(1rem, 1.8vw, 1.4rem);
  font-weight: 600;
  color: var(--d-text);
}

.trend-bar-track {
  height: 8px;
  background: var(--d-bar-track);
  border-radius: 4px;
  overflow: hidden;
}

.trend-bar-fill {
  height: 100%;
  background: var(--d-bar-fill);
  border-radius: 4px;
  transition: width 1s ease;
  min-width: 4px;
}

.trend-stats {
  text-align: right;
  flex-shrink: 0;
  min-width: 100px;
}

.trend-vel {
  font-size: clamp(1.1rem, 2vw, 1.6rem);
  font-weight: 700;
  color: var(--d-accent);
  font-variant-numeric: tabular-nums;
}

.trend-vel-unit {
  font-size: 0.65em;
  color: var(--d-text-dim);
  font-weight: 600;
}

.trend-total {
  font-size: 0.8rem;
  color: var(--d-text-dim);
  font-weight: 500;
}

@keyframes flame-flicker {
  0% { transform: scale(1) rotate(-3deg); }
  100% { transform: scale(1.1) rotate(3deg); }
}
</style>
