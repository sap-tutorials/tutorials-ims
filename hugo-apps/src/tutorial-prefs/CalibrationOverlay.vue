<template>
  <div class="cal-overlay" role="dialog" aria-modal="true" :aria-label="`Calibrate ${featureName}`">
    <div class="cal-overlay__panel">
      <template v-if="phase === 'intro'">
        <h2 class="cal-overlay__title">Calibrate {{ featureName }}</h2>
        <p class="cal-overlay__body">{{ introText }}</p>
        <div class="cal-overlay__actions">
          <ui5-button design="Emphasized" @click="$emit('start')">Begin</ui5-button>
          <ui5-button design="Transparent" @click="$emit('cancel')">Cancel</ui5-button>
        </div>
      </template>

      <template v-else-if="phase === 'capturing'">
        <h2 class="cal-overlay__title">{{ captureText }}</h2>
        <div class="cal-overlay__bar"><div class="cal-overlay__bar-fill" :style="{ width: pct }"></div></div>
        <ui5-button design="Transparent" @click="$emit('cancel')">Cancel</ui5-button>
      </template>

      <template v-else>
        <h2 class="cal-overlay__title">Couldn't calibrate</h2>
        <p class="cal-overlay__body">We couldn't read enough movement — please try again.</p>
        <div class="cal-overlay__actions">
          <ui5-button design="Emphasized" @click="$emit('retry')">Try again</ui5-button>
          <ui5-button design="Transparent" @click="$emit('cancel')">Cancel</ui5-button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { FeatureId } from './constants';

const props = defineProps<{ feature: FeatureId; phase: 'intro' | 'capturing' | 'invalid'; progress: number }>();
defineEmits<{ (e: 'start'): void; (e: 'cancel'): void; (e: 'retry'): void }>();

const featureName = computed(() => (props.feature === 'eye' ? 'eye-tracking' : 'hand gestures'));
const introText = computed(() =>
  props.feature === 'eye'
    ? 'When you press Begin, slowly scan your eyes over the whole page — top to bottom — for about five seconds.'
    : 'When you press Begin, hold an open palm up and sweep it left and right a few times for about five seconds.'
);
const captureText = computed(() =>
  props.feature === 'eye' ? 'Scan the whole page…' : 'Sweep left and right…'
);
const pct = computed(() => `${Math.round(Math.min(1, Math.max(0, props.progress)) * 100)}%`);
</script>

<style>
.cal-overlay { position: fixed; inset: 0; z-index: 2147483646; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.55); }
.cal-overlay__panel { background: var(--sapGroup_ContentBackground, #fff); color: var(--sapTextColor, #222); border-radius: 12px; padding: 1.5rem 1.75rem; max-width: 26rem; text-align: center; box-shadow: 0 8px 32px rgba(0,0,0,0.35); }
.cal-overlay__title { font-size: 1.15rem; margin: 0 0 0.5rem; }
.cal-overlay__body { margin: 0 0 1rem; opacity: 0.85; }
.cal-overlay__actions { display: flex; gap: 0.5rem; justify-content: center; }
.cal-overlay__bar { height: 8px; border-radius: 4px; background: var(--sapList_BorderColor, #e0e0e0); overflow: hidden; margin: 0.75rem 0 1rem; }
.cal-overlay__bar-fill { height: 100%; background: var(--sapButton_Emphasized_Background, #0070f2); transition: width 0.1s linear; }
</style>
