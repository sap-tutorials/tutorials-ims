<script setup lang="ts">
import { computed, ref, watch } from 'vue'

interface BucketData {
  name: string
  count: number
  justUpdated: boolean
}

const props = defineProps<{
  buckets: readonly BucketData[]
  chartCount: number
  totalCount: number
  isActive: boolean
}>()

const COLORS = [
  'var(--d-chart-1)',
  'var(--d-chart-2)',
  'var(--d-chart-3)',
  'var(--d-chart-4)',
  'var(--d-chart-5)',
  'var(--d-chart-6)',
]

const RADIUS = 70
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const animated = ref(false)

interface Segment {
  name: string
  count: number
  pct: number
  dashArray: string
  dashOffset: number
  color: string
  rotation: number
}

const segments = computed<Segment[]>(() => {
  const sorted = [...props.buckets].sort((a, b) => b.count - a.count)
  const top = sorted.length <= props.chartCount
    ? sorted
    : [
        ...sorted.slice(0, props.chartCount - 1),
        {
          name: 'Others',
          count: sorted.slice(props.chartCount - 1).reduce((s, b) => s + b.count, 0),
          justUpdated: false,
        },
      ]

  const total = top.reduce((s, b) => s + b.count, 0) || 1
  let offset = 0
  return top.map((b, i) => {
    const pct = b.count / total
    const len = pct * CIRCUMFERENCE
    const gap = CIRCUMFERENCE - len
    const rotation = offset * 360 - 90
    offset += pct
    return {
      name: b.name,
      count: b.count,
      pct,
      dashArray: `${animated.value ? len : 0} ${animated.value ? gap : CIRCUMFERENCE}`,
      dashOffset: 0,
      color: COLORS[i % COLORS.length],
      rotation,
    }
  })
})

watch(() => props.isActive, (active) => {
  if (active) {
    animated.value = false
    requestAnimationFrame(() => {
      requestAnimationFrame(() => { animated.value = true })
    })
  }
}, { immediate: true })

function fmt(n: number): string { return n.toLocaleString() }
</script>

<template>
  <div class="donut-chart">
    <div class="donut-svg-wrap">
      <svg viewBox="0 0 200 200" class="donut-svg">
        <circle cx="100" cy="100" :r="RADIUS" fill="none" stroke="var(--d-bar-track)" stroke-width="28" />
        <circle
          v-for="(seg, i) in segments"
          :key="seg.name"
          cx="100" cy="100" :r="RADIUS"
          fill="none"
          :stroke="seg.color"
          stroke-width="28"
          stroke-linecap="butt"
          :stroke-dasharray="seg.dashArray"
          :transform="`rotate(${seg.rotation} 100 100)`"
          class="donut-segment"
          :style="{ transitionDelay: (i * 0.15) + 's' }"
        />
      </svg>
      <div class="donut-center">
        <div class="donut-center-count">{{ fmt(totalCount) }}</div>
        <div class="donut-center-label">tutorials</div>
      </div>
    </div>
    <div class="donut-legend">
      <div v-for="(seg, i) in segments" :key="seg.name" class="legend-item">
        <span class="legend-dot" :style="{ background: seg.color }"></span>
        <span class="legend-name">{{ seg.name }}</span>
        <span class="legend-count">{{ fmt(seg.count) }}</span>
        <span class="legend-pct">{{ Math.round(seg.pct * 100) }}%</span>
      </div>
    </div>
  </div>
</template>

<style>
.donut-chart {
  display: flex;
  align-items: center;
  gap: 3rem;
  width: 100%;
}

.donut-svg-wrap {
  position: relative;
  width: clamp(260px, 35vw, 400px);
  height: clamp(260px, 35vw, 400px);
  flex-shrink: 0;
}

.donut-svg {
  width: 100%;
  height: 100%;
}

.donut-segment {
  transition: stroke-dasharray 1.5s cubic-bezier(0.22, 1, 0.36, 1);
}

.donut-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.donut-center-count {
  font-size: clamp(2rem, 4vw, 3.5rem);
  font-weight: 700;
  color: var(--d-accent);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.donut-center-label {
  font-size: clamp(0.75rem, 1.2vw, 1rem);
  color: var(--d-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
  margin-top: 0.25rem;
}

.donut-legend {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  flex: 1;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  font-size: clamp(0.9rem, 1.3vw, 1.1rem);
}

.legend-dot {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  flex-shrink: 0;
}

.legend-name {
  flex: 1;
  font-weight: 500;
  color: var(--d-text);
}

.legend-count {
  font-weight: 700;
  color: var(--d-text);
  font-variant-numeric: tabular-nums;
}

.legend-pct {
  font-weight: 600;
  color: var(--d-text-dim);
  font-size: 0.875em;
  min-width: 3rem;
  text-align: right;
}
</style>
