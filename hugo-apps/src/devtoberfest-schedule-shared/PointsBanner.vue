<script setup lang="ts">
defineProps<{
  earnedPoints: number;
  maxPoints: number;
  completeCount: number;
  isAuthenticated: boolean;
}>();
</script>

<template>
  <div class="points-banner">
    <template v-if="isAuthenticated">
      <div class="points-banner__score">
        <span class="points-banner__earned">{{ earnedPoints.toLocaleString() }}</span>
        <span class="points-banner__sep"> / </span>
        <span class="points-banner__max">{{ maxPoints.toLocaleString() }} pts</span>
      </div>
      <div class="points-banner__activities">
        <span class="points-banner__count">{{ completeCount }}</span>
        <span class="points-banner__label"> activities completed</span>
      </div>
    </template>
    <template v-else>
      <div class="points-banner__signin">
        <span class="points-banner__signin-text">Sign in to track your progress and earn points.</span>
        <a href="/login" class="points-banner__signin-link">Sign in</a>
      </div>
    </template>
  </div>
</template>

<style scoped>
.points-banner {
  display: flex;
  align-items: center;
  gap: 1.5rem;
  padding: 0.75rem 1rem;
  background-color: var(--sapList_HeaderBackground, #f5f6f7);
  border: 1px solid var(--sapList_BorderColor, #e4e5e7);
  border-radius: var(--sapPopover_BorderCornerRadius, 0.5rem);
}

.points-banner__score {
  display: flex;
  align-items: baseline;
  gap: 0.125rem;
}

.points-banner__earned {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--sapInformativeColor, #0854a0);
}

.points-banner__sep,
.points-banner__max {
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.points-banner__activities {
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.points-banner__count {
  font-weight: 600;
  color: var(--sapTextColor, #32363a);
}

.points-banner__signin {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.875rem;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.points-banner__signin-link {
  color: var(--sapLinkColor, #0854a0);
  text-decoration: none;
  font-weight: 600;
}

.points-banner__signin-link:hover {
  text-decoration: underline;
}
</style>
