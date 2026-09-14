<script setup lang="ts">
import { computed } from 'vue';
import { levelForXp, type KttProgress } from '../lib/progress';

// Persistent XP / level / streak surface. Before this, XP was earned per correct
// drill but shown only transiently (Lesson badge + Results card) and drove
// nothing — Tom asked "where is this XP shown? What does it mean really?".
const props = defineProps<{ progress: KttProgress }>();

const level = computed(() => levelForXp(props.progress.xp));
const toNext = computed(() => {
  const at = level.value.nextAt;
  return at === null ? null : Math.max(0, at - props.progress.xp);
});
</script>

<template>
  <div class="ktt-stats" data-testid="ktt-stats">
    <span class="ktt-stats__item" data-testid="ktt-stats-xp">
      <span class="ktt-stats__icon" aria-hidden="true">⭐</span>
      {{ progress.xp }} XP
    </span>
    <span class="ktt-stats__item" data-testid="ktt-stats-level">
      <span class="ktt-stats__icon" aria-hidden="true">🎓</span>
      Level {{ level.level }} · {{ level.name }}
      <span v-if="toNext !== null" class="ktt-stats__hint">({{ toNext }} XP to next)</span>
    </span>
    <span class="ktt-stats__item" data-testid="ktt-stats-streak">
      <span class="ktt-stats__icon" aria-hidden="true">🔥</span>
      {{ progress.streak }} streak
    </span>
  </div>
</template>

<style scoped>
.ktt-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 1.25rem;
  align-items: center;
  padding: 0.6rem 0.9rem;
  margin-bottom: 1.25rem;
  border: 1px solid #d5dbe0;
  border-radius: 8px;
  background: #f6f8fa;
  font-size: 0.9rem;
}

.ktt-stats__item {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  font-weight: 600;
  color: #33414d;
}

.ktt-stats__icon {
  font-size: 1rem;
}

.ktt-stats__hint {
  font-weight: 400;
  color: #6a7681;
}

/* Dark mode — site toggles `html.dark`. */
html.dark .ktt-stats {
  background: #141b22;
  border-color: #2a3542;
}

html.dark .ktt-stats__item {
  color: #e6edf3;
}

html.dark .ktt-stats__hint {
  color: #8a97a5;
}
</style>
