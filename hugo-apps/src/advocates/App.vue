<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Advocate, Region } from './shared/advocate-types';
import AdvocateCard  from './components/AdvocateCard.vue';
import HeaderBand    from './components/HeaderBand.vue';
import StickyMini    from './components/StickyMini.vue';
import EmptyState    from './components/EmptyState.vue';
import { useAdvocateFilter } from './composables/useAdvocateFilter';
import './styles/advocates.css';

const props = defineProps<{ apiUrl: string; photoBase: string }>();
const advocates = ref<Advocate[]>([]);
const loading   = ref(true);
const error     = ref<string | null>(null);

const { state, filtered, setRegion, setTopic, setQ, reset } = useAdvocateFilter(advocates);

const regionCounts = computed(() => {
  const counts = { ALL: advocates.value.length, AMERICAS: 0, EMEA: 0, APJ: 0 } as Record<Region | 'ALL', number>;
  for (const a of advocates.value) counts[a.region] += 1;
  return counts;
});

const topics = computed(() => {
  const seen = new Map<string, string>();
  for (const a of advocates.value) {
    for (const t of a.topics) {
      // Defensive: skip topics with empty/null slug or label so we never
      // render a blank-text chip even if the API hands us malformed data.
      const slug  = (t.slug  || '').trim();
      const label = (t.label || '').trim();
      if (!slug || !label) continue;
      if (!seen.has(slug)) seen.set(slug, label);
    }
  }
  return [...seen].map(([slug, label]) => ({ slug, label })).sort((a, b) => a.label.localeCompare(b.label));
});

const filtersActive = computed(() => state.value.region !== 'ALL' || state.value.topic !== 'ALL' || !!state.value.q);

// Joule handoff: synchronous default so window.__JOULE_ADVOCATES is
// never `undefined` when joule.js's readPageContext fires, even before
// the /api/advocates fetch resolves. The load() function below then
// overwrites this with the real roster (or [] on error). See spec
// docs/superpowers/specs/2026-06-23-joule-advocates-page-design.md.
if (typeof window !== 'undefined') {
  (window as unknown as { __JOULE_ADVOCATES: unknown[] }).__JOULE_ADVOCATES =
    (window as unknown as { __JOULE_ADVOCATES?: unknown[] }).__JOULE_ADVOCATES || [];
}

async function load() {
  loading.value = true; error.value = null;
  try {
    const res = await fetch(props.apiUrl, { headers: { Accept: 'application/json' }});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    advocates.value = Array.isArray(body.advocates) ? body.advocates : [];
    // Joule handoff (issue #564): stash for joule.js readPageContext.
    if (typeof window !== 'undefined') {
      (window as unknown as { __JOULE_ADVOCATES: unknown }).__JOULE_ADVOCATES = advocates.value;
    }
  } catch (e) {
    error.value = (e as Error).message;
    if (typeof window !== 'undefined') {
      (window as unknown as { __JOULE_ADVOCATES: unknown }).__JOULE_ADVOCATES = [];
    }
  } finally {
    loading.value = false;
  }
}
load();
</script>

<template>
  <StickyMini :state="state" />
  <HeaderBand
    :total="advocates.length"
    :region-counts="regionCounts"
    :topics="topics"
    :state="state"
    @set-region="setRegion"
    @set-topic="setTopic"
    @set-q="setQ"
  />

  <div v-if="loading" class="adv-skel-grid" aria-hidden="true">
    <div v-for="i in 8" :key="i" class="adv-skel-card"></div>
  </div>
  <div v-else-if="error" class="adv-error">
    <p>Couldn't load advocates: {{ error }}</p>
    <button class="adv-pill" @click="load">Retry</button>
  </div>
  <div v-else-if="filtered.length" class="adv-grid">
    <AdvocateCard v-for="a in filtered" :key="a.ID" :advocate="a" :photo-base="photoBase" />
  </div>
  <EmptyState v-else :filters-active="filtersActive" @reset="reset" />
</template>

<style>
.adv-skel-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 22px; padding: 24px; }
.adv-skel-card { aspect-ratio: 4/5; border-radius: 20px;
  background: linear-gradient(90deg, #f1f4f9 0%, #e6effa 50%, #f1f4f9 100%);
  background-size: 200% 100%;
  animation: adv-shimmer 1.4s linear infinite;
}
.adv-error { padding: 40px 24px; text-align: center; }
@keyframes adv-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .adv-skel-card { animation: none; }
}
</style>
