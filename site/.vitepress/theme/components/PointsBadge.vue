<script setup lang="ts">
defineProps<{
  points: number
  badges: Array<{ name: string; icon: string }>
}>()
</script>

<template>
  <div class="points-badge">
    <span class="fd-badge">{{ points }} pts</span>
    <span
      v-for="badge in badges"
      :key="badge.name"
      class="fd-badge fd-badge--accent-color-1"
      :title="badge.name"
    >
      {{ badge.name }}
    </span>
  </div>
</template>

<style scoped>
.points-badge {
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
  align-items: center;
}
</style>
