<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{
  completed: number
  total: number
  label?: string
}>()

const percentage = computed(() =>
  props.total > 0 ? Math.round((props.completed / props.total) * 100) : 0
)
</script>

<template>
  <div class="progress-bar">
    <div v-if="label" class="progress-label">{{ label }}</div>
    <div class="fd-progress-indicator" role="progressbar" :aria-valuenow="percentage" aria-valuemin="0" aria-valuemax="100">
      <div class="fd-progress-indicator__container">
        <div class="fd-progress-indicator__progress-bar" :style="{ width: `${percentage}%` }"></div>
      </div>
      <span class="fd-progress-indicator__label">{{ completed }}/{{ total }} ({{ percentage }}%)</span>
    </div>
  </div>
</template>

<style scoped>
.progress-bar {
  margin: 0.5rem 0;
}
.progress-label {
  font-size: 0.875rem;
  margin-bottom: 0.25rem;
  color: var(--sapTextColor, #32363a);
}
</style>
