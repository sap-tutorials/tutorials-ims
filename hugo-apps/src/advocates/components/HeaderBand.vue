<script setup lang="ts">
import type { Region } from '../shared/advocate-types';
import WorldMap from './WorldMap.vue';

defineProps<{
  total: number;
  regionCounts: Record<Region | 'ALL', number>;
  topics: { slug: string; label: string }[];
  state: { region: Region | 'ALL'; topic: string; q: string };
}>();
defineEmits<{
  (e: 'set-region', r: Region | 'ALL'): void;
  (e: 'set-topic',  t: string): void;
  (e: 'set-q',      q: string): void;
}>();
</script>

<template>
  <header class="adv-header">
    <div class="adv-header-row">
      <div class="adv-header-meta">
        <h1 class="adv-h1">Developer Advocates</h1>
        <span class="adv-count">{{ total }} people · 3 regions · {{ topics.length }} focus areas</span>
      </div>
      <WorldMap :region-counts="regionCounts" :active="state.region" @pick="$emit('set-region', $event)" />
    </div>
    <div class="adv-chips-row">
      <button class="adv-pill" :class="{ active: state.region === 'ALL' }"      @click="$emit('set-region','ALL')">All</button>
      <button class="adv-pill" :class="{ active: state.region === 'AMERICAS' }" @click="$emit('set-region','AMERICAS')">Americas ({{ regionCounts.AMERICAS }})</button>
      <button class="adv-pill" :class="{ active: state.region === 'EMEA' }"     @click="$emit('set-region','EMEA')">EMEA ({{ regionCounts.EMEA }})</button>
      <button class="adv-pill" :class="{ active: state.region === 'APJ' }"      @click="$emit('set-region','APJ')">APJ ({{ regionCounts.APJ }})</button>
      <span class="adv-chip-divider" aria-hidden="true">|</span>
      <button v-for="t in topics" :key="t.slug" class="adv-pill"
              :class="{ active: state.topic === t.slug }"
              @click="$emit('set-topic', state.topic === t.slug ? 'ALL' : t.slug)">
        {{ t.label }}
      </button>
      <input class="adv-search" type="search" placeholder="Search advocates"
             :value="state.q"
             @input="$emit('set-q', ($event.target as HTMLInputElement).value)"
             aria-label="Search advocates" />
    </div>
  </header>
</template>

<style>
.adv-header {
  position: relative; overflow: hidden;
  background: linear-gradient(120deg, #001a4f 0%, #0a3d91 45%, #0070f2 80%, #6c3dff 100%);
  color: #fff; padding: 18px 24px 14px; border-radius: 0;
}
.adv-header::before {
  content: ''; position: absolute; top: -80px; right: -100px; width: 320px; height: 320px;
  border-radius: 50%; background: radial-gradient(circle, rgba(255,109,181,.55), transparent 65%);
}
.adv-header-row { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; position: relative; z-index: 1; }
.adv-header-meta { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.adv-h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
.adv-count { color: rgba(255,255,255,.78); font-size: 13px; }
.adv-chips-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 10px; position: relative; z-index: 1; }
.adv-pill {
  font-size: 11px; padding: 4px 10px; border-radius: 999px;
  background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.25);
  cursor: pointer; transition: background .15s ease;
}
.adv-pill:hover { background: rgba(255,255,255,.22); }
.adv-pill.active { background: #fff; color: #0a3d91; border-color: #fff; font-weight: 600; }
.adv-chip-divider { opacity: .4; padding: 0 4px; }
.adv-search {
  margin-left: auto; height: 26px; min-width: 180px; border-radius: 6px;
  background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.25);
  color: #fff; padding: 0 10px; font-size: 12px;
}
.adv-search::placeholder { color: rgba(255,255,255,.65); }
</style>
