import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { Advocate, AdvocateFilterState } from '../shared/advocate-types';
import { readHash, writeHash } from './urlSync';

export function useAdvocateFilter(advocates: { value: Advocate[] }) {
  const state = ref<AdvocateFilterState>({ region: 'ALL', topic: 'ALL', q: '' });

  onMounted(async () => {
    const h = readHash();
    state.value = { ...state.value, ...h } as AdvocateFilterState;
    await nextTick();
    watch(state, (v) => writeHash(v), { deep: true, flush: 'pre' });
  });

  const filtered = computed(() => {
    const q = state.value.q.trim().toLowerCase();
    return advocates.value.filter((a) => {
      if (state.value.region !== 'ALL' && a.region !== state.value.region) return false;
      if (state.value.topic  !== 'ALL' && !a.topics.some(t => t.slug === state.value.topic)) return false;
      if (q) {
        const hay = [a.firstName, a.lastName, a.title, a.location, ...(a.topics.map(t => t.label))]
          .join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  function setRegion(r: AdvocateFilterState['region']) { state.value.region = r; }
  function setTopic(t: string)                          { state.value.topic = t; }
  function setQ(q: string)                              { state.value.q = q; }
  function reset()                                       { state.value = { region: 'ALL', topic: 'ALL', q: '' }; }

  return { state, filtered, setRegion, setTopic, setQ, reset };
}
