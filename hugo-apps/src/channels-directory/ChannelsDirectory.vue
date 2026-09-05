<script setup lang="ts">
import { ref, computed } from 'vue';
import { filterChannels, ownerBadge, type Channel } from './filter';
import { visibleCollections, type Collection } from './collections';

const props = defineProps<{ channels: Channel[]; collections?: Collection[] }>();
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
const cols = computed(() => visibleCollections(props.collections));
</script>

<template>
  <div class="channels-directory">
    <section v-if="cols.length" class="channel-collections">
      <article v-for="col in cols" :key="col.slug" class="collection">
        <h2>{{ col.title }}</h2>
        <p v-if="col.intro" class="collection-intro">{{ col.intro }}</p>
        <ul>
          <li v-for="it in col.items" :key="it.url">
            <a :href="it.url">{{ it.name }}</a>
            <span v-if="it.blurb" class="blurb">— {{ it.blurb }}</span>
          </li>
        </ul>
      </article>
    </section>
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

<style scoped>
.channels-directory {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* --- Editorial collections --- */
.channel-collections {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
  gap: 1rem;
}
.collection {
  padding: 1rem 1.25rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.collection h2 {
  margin: 0 0 0.5rem;
  font-size: 1.125rem;
  color: var(--sapGroup_TitleTextColor, #1d2d3e);
}
.collection-intro {
  margin: 0 0 0.75rem;
  color: var(--sapNeutralTextColor, #556b82);
}
.collection ul {
  margin: 0;
  padding-left: 1.1rem;
}
.collection .blurb {
  color: var(--sapNeutralTextColor, #556b82);
}

/* --- Filter toolbar --- */
.channels-directory__controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  padding: 0.875rem 1rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.channels-directory__controls input,
.channels-directory__controls select {
  padding: 0.4rem 0.6rem;
  font: inherit;
  color: var(--sapField_TextColor, #1d2d3e);
  background: var(--sapField_Background, #fff);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: var(--sapField_BorderCornerRadius, 0.25rem);
}
.channels-directory__controls input[type='search'] {
  flex: 1 1 14rem;
  min-width: 12rem;
}
.channels-directory__controls select {
  flex: 0 1 auto;
}
.channels-directory__count {
  margin-left: auto;
  font-weight: 600;
  color: var(--sapNeutralTextColor, #556b82);
  white-space: nowrap;
}

/* --- Channel cards --- */
.channels-directory__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(19rem, 1fr));
  gap: 1rem;
}
.channel-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem 1.125rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
  box-shadow: var(--sapContent_Shadow0, 0 0 0.25rem rgba(0, 0, 0, 0.08));
}
.channel-card > a {
  font-weight: 600;
  font-size: 1.0625rem;
  color: var(--sapLinkColor, #0070f2);
  text-decoration: none;
}
.channel-card > a:hover {
  text-decoration: underline;
}
.channel-card > p {
  margin: 0;
  color: var(--sapTextColor, #1d2d3e);
}
.channel-card__related {
  list-style: none;
  margin: 0.25rem 0 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  font-size: 0.8125rem;
}
.badge {
  align-self: flex-start;
  padding: 0.1rem 0.5rem;
  font-size: 0.75rem;
  font-weight: 600;
  border-radius: 1rem;
}
.badge--sap {
  color: var(--sapInformativeTextColor, #0070f2);
  background: var(--sapInformationBackground, #e5f0fa);
}
.badge--community {
  color: var(--sapPositiveTextColor, #256f3a);
  background: var(--sapSuccessBackground, #e5f6e6);
}

@media (max-width: 640px) {
  .channels-directory__count {
    margin-left: 0;
  }
}
</style>
