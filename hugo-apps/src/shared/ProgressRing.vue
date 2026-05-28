<!-- hugo-apps/src/shared/ProgressRing.vue -->
<script setup lang="ts">
const props = defineProps<{
  percent: number
  complete?: boolean
}>()

const safePercent = () => Math.max(0, Math.min(100, Math.round(props.percent ?? 0)))
const ariaLabel = () => props.complete ? 'Completed' : `${safePercent()}% complete`
</script>

<template>
  <div
    class="progress-ring"
    :class="{ 'progress-ring--complete': complete }"
    :aria-label="ariaLabel()"
    role="img"
  >
    <svg viewBox="0 0 36 36" class="progress-ring__svg" aria-hidden="true">
      <path class="progress-ring__bg"
        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        fill="none" stroke-width="3" />
      <path class="progress-ring__fill"
        d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
        fill="none" stroke-width="3" stroke-linecap="round"
        :stroke-dasharray="`${safePercent()}, 100`" />
    </svg>
    <span class="progress-ring__text" aria-hidden="true">
      <template v-if="complete">&#10003;</template>
      <template v-else>{{ safePercent() }}%</template>
    </span>
  </div>
</template>

<style scoped>
.progress-ring {
  position: relative;
  width: 2.5rem;
  height: 2.5rem;
  flex-shrink: 0;
}
.progress-ring__svg {
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.progress-ring__bg {
  stroke: var(--sapNeutralBorderColor, #d9d9d9);
}
.progress-ring__fill {
  stroke: var(--sapBrandColor, #0070f2);
  transition: stroke-dasharray 0.4s ease;
}
.progress-ring--complete .progress-ring__fill {
  stroke: var(--sapPositiveColor, #107e3e);
}
.progress-ring__text {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 0.625rem;
  font-weight: 700;
  color: var(--sapTextColor, #32363a);
}
.progress-ring--complete .progress-ring__text {
  color: var(--sapPositiveColor, #107e3e);
  font-size: 0.875rem;
}
</style>
