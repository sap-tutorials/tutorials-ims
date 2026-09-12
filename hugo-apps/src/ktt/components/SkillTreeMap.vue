<script setup lang="ts">
import KasimirStage from './KasimirStage.vue';

// Minimal local types — do NOT import from scripts/; keep the island self-contained.
interface KttLesson {
  id: string;
  legacyId: number;
  title: string;
  acronyms: unknown[];
  beats: unknown[];
}

interface KttUnit {
  id: string;
  title: string;
  icon: string;
  order: number;
  lessons: KttLesson[];
}

interface KttData {
  units: KttUnit[];
}

const props = defineProps<{
  lessons: KttData;
  mastered: string[];
}>();

const emit = defineEmits<{
  (e: 'select', lessonId: string): void;
}>();

function isLocked(unit: KttUnit, idx: number): boolean {
  if (idx === 0) return false;
  const prevLesson = unit.lessons[idx - 1];
  return !props.mastered.includes(prevLesson.id);
}

function isDone(lessonId: string): boolean {
  return props.mastered.includes(lessonId);
}

function handleClick(unit: KttUnit, idx: number, lessonId: string): void {
  if (isLocked(unit, idx)) return;
  emit('select', lessonId);
}
</script>

<template>
  <div class="ktt-skill-tree">
    <div class="ktt-skill-tree__map">
      <div
        v-for="unit in lessons.units"
        :key="unit.id"
        class="ktt-unit"
      >
        <h2 class="ktt-unit__title">{{ unit.icon }} {{ unit.title }}</h2>
        <div class="ktt-unit__lessons">
          <button
            v-for="(lesson, idx) in unit.lessons"
            :key="lesson.id"
            :data-testid="`ktt-node-${lesson.id}`"
            class="ktt-node"
            :class="{
              'is-locked': isLocked(unit, idx),
              'is-done': isDone(lesson.id),
            }"
            :aria-disabled="isLocked(unit, idx) ? 'true' : undefined"
            @click="handleClick(unit, idx, lesson.id)"
          >
            <span class="ktt-node__lock" v-if="isLocked(unit, idx)" aria-hidden="true">🔒</span>
            <span class="ktt-node__done" v-else-if="isDone(lesson.id)" aria-hidden="true">✓</span>
            {{ lesson.title }}
          </button>
        </div>
      </div>
    </div>
    <aside class="ktt-skill-tree__mascot" aria-hidden="true">
      <KasimirStage mood="idle" />
    </aside>
  </div>
</template>

<style scoped>
.ktt-skill-tree {
  display: flex;
  gap: 2rem;
  align-items: flex-start;
}

.ktt-skill-tree__map {
  flex: 1;
}

.ktt-skill-tree__mascot {
  width: 120px;
  flex-shrink: 0;
}

.ktt-unit {
  margin-bottom: 1.5rem;
}

.ktt-unit__title {
  font-size: 1.1rem;
  margin-bottom: 0.75rem;
}

.ktt-unit__lessons {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  align-items: flex-start;
}

.ktt-node {
  padding: 0.75rem 1.25rem;
  border: 2px solid #0070f2;
  border-radius: 8px;
  background: #fff;
  cursor: pointer;
  font-size: 0.95rem;
  text-align: left;
  transition: background 0.15s, opacity 0.15s;
}

.ktt-node:hover:not(.is-locked) {
  background: #e8f2ff;
}

.ktt-node:focus-visible {
  outline: 3px solid #0070f2;
  outline-offset: 2px;
}

.ktt-node.is-locked {
  opacity: 0.45;
  cursor: not-allowed;
  border-color: #bbb;
  color: #888;
}

.ktt-node.is-done {
  background: #e8f7e8;
  border-color: #28a745;
  color: #155724;
}
</style>
