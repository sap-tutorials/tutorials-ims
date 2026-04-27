<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  current: number
  target: number
}>()

const RADIUS = 120
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

const pct = computed(() => Math.min((props.current / props.target) * 100, 100))
const dashOffset = computed(() => CIRCUMFERENCE - (pct.value / 100) * CIRCUMFERENCE)
const reached = computed(() => props.current >= props.target)
const remaining = computed(() => Math.max(props.target - props.current, 0))

function fmt(n: number): string { return n.toLocaleString() }
</script>

<template>
  <div class="goal-ring" :class="{ reached }">
    <div class="ring-svg-wrap">
      <svg viewBox="0 0 300 300" class="ring-svg">
        <circle cx="150" cy="150" :r="RADIUS" fill="none" stroke="var(--d-ring-track)" stroke-width="16" />
        <circle
          cx="150" cy="150" :r="RADIUS"
          fill="none"
          :stroke="reached ? 'var(--sapPositiveColor)' : 'var(--d-ring-fill)'"
          stroke-width="16"
          stroke-linecap="round"
          :stroke-dasharray="CIRCUMFERENCE"
          :stroke-dashoffset="dashOffset"
          transform="rotate(-90 150 150)"
          class="ring-fill"
          :class="{ glow: reached }"
        />
      </svg>
      <div class="ring-center">
        <div class="ring-pct">{{ Math.round(pct) }}<span class="ring-pct-sym">%</span></div>
        <div class="ring-label">of goal</div>
      </div>
    </div>
    <div class="goal-stats">
      <div class="goal-line">
        <span class="goal-current">{{ fmt(current) }}</span>
        <span class="goal-of"> of </span>
        <span class="goal-target">{{ fmt(target) }}</span>
        <span class="goal-of"> tutorials</span>
      </div>
      <div v-if="!reached" class="goal-remaining">
        <span class="goal-togo">{{ fmt(remaining) }}</span> to go!
      </div>
      <div v-else class="goal-reached-text">
        GOAL REACHED!
      </div>
    </div>
  </div>
</template>

<style>
.goal-ring {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2rem;
}

.ring-svg-wrap {
  position: relative;
  width: clamp(280px, 35vw, 420px);
  height: clamp(280px, 35vw, 420px);
}

.ring-svg {
  width: 100%;
  height: 100%;
}

.ring-fill {
  transition: stroke-dashoffset 1.5s cubic-bezier(0.22, 1, 0.36, 1), stroke 0.5s ease;
}

.ring-fill.glow {
  filter: drop-shadow(0 0 12px var(--sapPositiveColor));
}

.ring-center {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}

.ring-pct {
  font-size: clamp(3.5rem, 7vw, 6rem);
  font-weight: 700;
  color: var(--d-accent);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.ring-pct-sym {
  font-size: 0.5em;
  vertical-align: super;
  color: var(--d-text-dim);
}

.ring-label {
  font-size: clamp(0.875rem, 1.5vw, 1.25rem);
  color: var(--d-text-dim);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
  margin-top: 0.25rem;
}

.goal-stats {
  text-align: center;
}

.goal-line {
  font-size: clamp(1.25rem, 2.5vw, 2rem);
  color: var(--d-text);
  font-weight: 400;
}

.goal-current {
  font-weight: 700;
  color: var(--d-accent);
}

.goal-target {
  font-weight: 700;
}

.goal-of {
  color: var(--d-text-dim);
}

.goal-remaining {
  font-size: clamp(1rem, 2vw, 1.5rem);
  color: var(--d-text-dim);
  margin-top: 0.5rem;
}

.goal-togo {
  font-weight: 700;
  color: var(--d-accent);
}

.goal-reached-text {
  font-size: clamp(1.5rem, 3vw, 2.5rem);
  font-weight: 700;
  color: var(--sapPositiveColor);
  margin-top: 0.5rem;
  animation: goal-pulse 1.5s ease-in-out infinite;
}

.goal-ring.reached .ring-pct {
  color: var(--sapPositiveColor);
}

@keyframes goal-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.8; transform: scale(1.03); }
}
</style>
