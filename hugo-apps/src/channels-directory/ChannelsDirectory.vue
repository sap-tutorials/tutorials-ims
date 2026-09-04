<script setup lang="ts">
import { ref, computed } from 'vue';
import { filterChannels, type Channel } from './filter';

const props = defineProps<{ channels: Channel[] }>();
const query = ref('');
const category = ref('');
const platform = ref('');
const ownerScope = ref<'all' | 'sap' | 'community'>('all');

const categories = computed(() => [...new Set(props.channels.map((c) => c.category).filter(Boolean))].sort());
const platforms = computed(() => [...new Set(props.channels.map((c) => c.platform).filter(Boolean))].sort());
const results = computed(() =>
  filterChannels(props.channels, { query: query.value, category: category.value, platform: platform.value, ownerScope: ownerScope.value }));
</script>

<template>
  <div class="channels-directory">
    <div class="channels-directory__controls">
      <input v-model="query" type="search" placeholder="Search channels…" aria-label="Search channels" />
      <select v-model="ownerScope" aria-label="Ownership">
        <option value="all">All owners</option><option value="sap">SAP</option><option value="community">Community</option>
      </select>
      <select v-model="category" aria-label="Category">
        <option value="">All categories</option><option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="platform" aria-label="Platform">
        <option value="">All platforms</option><option v-for="p in platforms" :key="p" :value="p">{{ p }}</option>
      </select>
      <span class="channels-directory__count">{{ results.length }} channels</span>
    </div>
    <ul class="channels-directory__list">
      <li v-for="c in results" :key="c.url || c.name" class="channel-card">
        <a :href="c.url" target="_blank" rel="noopener">{{ c.name }}</a>
        <span v-if="!c.isSapOwned" class="badge badge--community">Community</span>
        <p>{{ c.purpose }}</p>
      </li>
    </ul>
  </div>
</template>
