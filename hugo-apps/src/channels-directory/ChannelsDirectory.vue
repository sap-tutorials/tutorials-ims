<script setup lang="ts">
import { ref, computed } from 'vue';
import { filterChannels, ownerBadge, type Channel } from './filter';

const props = defineProps<{ channels: Channel[] }>();
const query = ref('');
const category = ref('');
const platform = ref('');
const focusArea = ref('');
const status = ref('');
const ownerScope = ref<'all' | 'sap' | 'community'>('all');

const uniqSorted = (vals: (string | undefined)[]) =>
  [...new Set(vals.filter(Boolean) as string[])].sort();
const categories = computed(() => uniqSorted(props.channels.map((c) => c.category)));
const platforms = computed(() => uniqSorted(props.channels.map((c) => c.platform)));
const statuses = computed(() => uniqSorted(props.channels.map((c) => c.status)));
const focusAreas = computed(() => uniqSorted(props.channels.flatMap((c) => c.focusAreas || [])));
const results = computed(() =>
  filterChannels(props.channels, {
    query: query.value, category: category.value, platform: platform.value,
    focusArea: focusArea.value, status: status.value, ownerScope: ownerScope.value,
  }));
const badgeClass = (c: Channel) =>
  c.isSapOwned || ownerBadge(c).startsWith('SAP') ? 'badge--sap' : 'badge--community';
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
      <select v-model="focusArea" aria-label="Focus area">
        <option value="">All focus areas</option><option v-for="f in focusAreas" :key="f" :value="f">{{ f }}</option>
      </select>
      <select v-model="platform" aria-label="Platform">
        <option value="">All platforms</option><option v-for="p in platforms" :key="p" :value="p">{{ p }}</option>
      </select>
      <select v-model="status" aria-label="Status">
        <option value="">All statuses</option><option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
      </select>
      <span class="channels-directory__count">{{ results.length }} channels</span>
    </div>
    <ul class="channels-directory__list">
      <li v-for="c in results" :key="c.url || c.name" class="channel-card">
        <a :href="c.url" target="_blank" rel="noopener">{{ c.name }}</a>
        <span class="badge" :class="badgeClass(c)">{{ ownerBadge(c) }}</span>
        <p>{{ c.editorialNote || c.purpose }}</p>
        <ul v-if="c.relatedUrls && c.relatedUrls.length" class="channel-card__related">
          <li v-for="(u, i) in c.relatedUrls" :key="u">
            <a :href="u" target="_blank" rel="noopener">Related {{ i + 1 }}</a>
          </li>
        </ul>
      </li>
    </ul>
  </div>
</template>
