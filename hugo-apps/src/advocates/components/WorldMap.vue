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
  <div class="adv-map-frame">
    <div class="adv-map" :class="{ paused }" aria-label="Filter advocates by region">
      <button class="adv-dot adv-dot-am"  :class="{ active: active === 'AMERICAS' }"
              :aria-label="`Americas (${regionCounts.AMERICAS} advocates)`"
              :title="`Americas — ${regionCounts.AMERICAS} advocates`"
              @click="emit('pick', active === 'AMERICAS' ? 'ALL' : 'AMERICAS')"></button>
      <button class="adv-dot adv-dot-eu"  :class="{ active: active === 'EMEA' }"
              :aria-label="`EMEA (${regionCounts.EMEA} advocates)`"
              :title="`EMEA — ${regionCounts.EMEA} advocates`"
              @click="emit('pick', active === 'EMEA' ? 'ALL' : 'EMEA')"></button>
      <button class="adv-dot adv-dot-ap"  :class="{ active: active === 'APJ' }"
              :aria-label="`APJ (${regionCounts.APJ} advocates)`"
              :title="`APJ — ${regionCounts.APJ} advocates`"
              @click="emit('pick', active === 'APJ' ? 'ALL' : 'APJ')"></button>
    </div>
  </div>
</template>

<style>
.adv-map-frame {
  margin-top: 14px;
  border-radius: 12px;
  overflow: hidden;
  position: relative;
  z-index: 1;
}
.adv-map {
  position: relative;
  width: 100%;
  /* Image is 1024x721 — preserve that aspect ratio. min/max-height clamp the */
  /* visual size so the header doesn't dominate the page on tall screens. */
  aspect-ratio: 1024 / 721;
  max-height: 360px;
  min-height: 200px;
  background-image: url('/img/advocates-world-map.png');
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
}
.adv-dot {
  position: absolute;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  transform: translate(-50%, -50%);
  cursor: pointer;
  padding: 0;
  border: 2px solid #fff;
  background: #fff;
  box-shadow: 0 2px 6px rgba(0,0,0,.3);
}
.adv-dot::before {
  content: '';
  position: absolute;
  inset: -6px;
  border-radius: 50%;
  background: inherit;
  opacity: .5;
  animation: adv-pulse 2.4s ease-out infinite;
}
.adv-map.paused .adv-dot::before { animation: none; opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .adv-dot::before { animation: none; opacity: 0; }
}
/* Region dot positions are tuned to the dotted-globe artwork. Coordinates */
/* are percentages relative to the .adv-map container — adjust if the */
/* artwork is replaced. Americas roughly over the central US, EMEA over */
/* central Europe, APJ over Singapore/SE Asia. */
.adv-dot-am { left: 22%; top: 42%; background: #ff6db5; }
.adv-dot-eu { left: 50%; top: 38%; background: #b056d1; }
.adv-dot-ap { left: 75%; top: 58%; background: #2b9fd8; }
.adv-dot.active {
  box-shadow: 0 0 0 4px #fff, 0 2px 8px rgba(0,0,0,.4);
  transform: translate(-50%, -50%) scale(1.2);
}
.adv-dot:hover {
  transform: translate(-50%, -50%) scale(1.15);
}
@keyframes adv-pulse {
  0% { transform: scale(1); opacity: .55; }
  100% { transform: scale(2.6); opacity: 0; }
}
</style>
