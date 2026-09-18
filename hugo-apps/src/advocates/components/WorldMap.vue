<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Region } from '../shared/advocate-types';

defineProps<{ regionCounts: Record<Region | 'ALL', number>; active: Region | 'ALL' }>();
const emit = defineEmits<{ (e: 'pick', region: Region | 'ALL'): void }>();

const paused = ref(false);
function onVis() { paused.value = document.visibilityState !== 'visible'; }

onMounted(() => {
  document.addEventListener('visibilitychange', onVis);
  onVis();
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVis));
</script>

<template>
  <div class="dev-advocate-map" :class="{ paused }" aria-label="Filter advocates by region">
    <span class="dev-advocate-map-label dev-advocate-map-am">AMER</span>
    <span class="dev-advocate-map-label dev-advocate-map-eu">EMEA</span>
    <span class="dev-advocate-map-label dev-advocate-map-ap">APJ</span>
    <button class="dev-advocate-dot dev-advocate-dot-am"  :class="{ active: active === 'AMERICAS' }"
            :aria-label="`Americas (${regionCounts.AMERICAS} advocates)`"
            @click="emit('pick', active === 'AMERICAS' ? 'ALL' : 'AMERICAS')"></button>
    <button class="dev-advocate-dot dev-advocate-dot-eu"  :class="{ active: active === 'EMEA' }"
            :aria-label="`EMEA (${regionCounts.EMEA} advocates)`"
            @click="emit('pick', active === 'EMEA' ? 'ALL' : 'EMEA')"></button>
    <button class="dev-advocate-dot dev-advocate-dot-ap"  :class="{ active: active === 'APJ' }"
            :aria-label="`APJ (${regionCounts.APJ} advocates)`"
            @click="emit('pick', active === 'APJ' ? 'ALL' : 'APJ')"></button>
  </div>
</template>

<style>
.dev-advocate-map {
  width: 220px; height: 86px; position: relative; flex-shrink: 0;
  border-radius: 8px;
  /* Real dotted-globe artwork over the elliptical region halos. The halos */
  /* sit ON TOP of the artwork via the 'after' selectors below — keeps the */
  /* original visual rhythm, just with a richer backdrop. */
  background-image:
    radial-gradient(ellipse at 18% 60%, rgba(255,255,255,.12) 0 28px, transparent 32px),
    radial-gradient(ellipse at 50% 45%, rgba(255,255,255,.12) 0 32px, transparent 36px),
    radial-gradient(ellipse at 80% 55%, rgba(255,255,255,.12) 0 28px, transparent 32px),
    url('/img/advocates-world-map.png');
  background-size: auto, auto, auto, cover;
  background-position: center, center, center, center;
  background-repeat: no-repeat;
}
.dev-advocate-map-label { position: absolute; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.85); }
.dev-advocate-map-am { top: 60%; left: 8%; }
.dev-advocate-map-eu { top: 22%; left: 44%; }
.dev-advocate-map-ap { top: 60%; right: 6%; }
.dev-advocate-dot {
  position: absolute; width: 12px; height: 12px; border-radius: 50%;
  transform: translate(-50%, -50%); cursor: pointer; padding: 0; border: 0;
  background: #fff;
}
.dev-advocate-dot::before {
  content: ''; position: absolute; inset: -4px; border-radius: 50%;
  background: inherit; opacity: .5; animation: dev-advocate-pulse 2.4s ease-out infinite;
}
.dev-advocate-map.paused .dev-advocate-dot::before { animation: none; opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .dev-advocate-dot::before { animation: none; opacity: 0; }
}
.dev-advocate-dot-am { left: 22%; top: 62%; background: #ff6db5; }
.dev-advocate-dot-eu { left: 50%; top: 42%; background: #b056d1; }
.dev-advocate-dot-ap { left: 80%; top: 58%; background: #2b9fd8; }
.dev-advocate-dot.active { box-shadow: 0 0 0 3px #fff; }
@keyframes dev-advocate-pulse {
  0% { transform: scale(1); opacity: .55; }
  100% { transform: scale(2.2); opacity: 0; }
}
</style>
