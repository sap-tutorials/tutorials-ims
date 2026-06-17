<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Region } from '../shared/advocate-types';

defineProps<{ state: { region: Region | 'ALL'; topic: string; q: string } }>();
const visible = ref(false);

let observer: IntersectionObserver | null = null;

onMounted(() => {
  const sentinel = document.getElementById('advocates-mount');
  if (!sentinel) return;
  observer = new IntersectionObserver(([entry]) => {
    visible.value = entry.intersectionRatio < 0.05;
  }, { threshold: [0, 0.05, 0.5, 1] });
  observer.observe(sentinel);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div v-if="visible" class="adv-sticky-mini">
    <span class="adv-mini-title">Developer Advocates</span>
    <span v-if="state.region !== 'ALL'" class="adv-mini-chip">{{ state.region }}</span>
    <span v-if="state.topic  !== 'ALL'" class="adv-mini-chip">{{ state.topic }}</span>
    <span v-if="state.q"                  class="adv-mini-chip">"{{ state.q }}"</span>
  </div>
</template>

<style>
.adv-sticky-mini {
  position: fixed; top: 0; left: 0; right: 0; z-index: 50; height: 48px;
  display: flex; align-items: center; gap: 10px; padding: 0 24px;
  background: linear-gradient(120deg, #001a4f, #0a3d91);
  color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.18);
}
.adv-mini-title { font-weight: 600; font-size: 13px; letter-spacing: -.01em; }
.adv-mini-chip {
  font-size: 11px; padding: 3px 9px; border-radius: 999px;
  background: rgba(255,255,255,.18); color: #fff;
}
</style>
