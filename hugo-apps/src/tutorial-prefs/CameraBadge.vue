<template>
  <ui5-message-strip
    v-if="active.length > 0"
    class="tut-prefs-cam-badge"
    design="Information"
    hide-close-button
  >
    Camera active — {{ label }}
    <ui5-button design="Transparent" @click="$emit('stop')">Stop</ui5-button>
    <span v-if="slow" class="tut-prefs-cam-badge__slow">
      Detection is slow on this device — accuracy may suffer.
    </span>
  </ui5-message-strip>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FeatureId } from './constants';

const props = defineProps<{ active: FeatureId[]; slow?: boolean }>();
defineEmits<{ (e: 'stop'): void }>();

const label = computed(() => {
  const parts: string[] = [];
  if (props.active.includes('eye')) parts.push('eye-tracking');
  if (props.active.includes('hand')) parts.push('gestures');
  return parts.join(', ');
});
</script>

<style>
.tut-prefs-cam-badge {
  position: fixed;
  top: var(--tut-prefs-cam-badge-top, 4rem);
  right: 1rem;
  z-index: 9999;
  max-width: 28rem;
}
.tut-prefs-cam-badge__slow { display: block; margin-top: 0.25rem; opacity: 0.85; font-size: 0.85em; }
</style>
