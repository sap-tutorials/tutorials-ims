<script setup lang="ts">
import { ref, computed } from 'vue';
import './styles.css';

interface TutorialLink { slug: string; title: string }
interface SingleAdvocate {
  slug: string;
  firstName: string;
  lastName: string;
  authoredTutorials?: TutorialLink[];
  contributedTutorials?: TutorialLink[];
}

const props = defineProps<{ apiUrl: string }>();
const data = ref<SingleAdvocate | null>(null);
const status = ref<'loading' | 'ok' | 'notFound' | 'error'>('loading');

const authored = computed(() => data.value?.authoredTutorials || []);
const contributed = computed(() => data.value?.contributedTutorials || []);

async function load() {
  try {
    const res = await fetch(props.apiUrl, { headers: { Accept: 'application/json' } });
    if (res.status === 404) { status.value = 'notFound'; return; }
    if (!res.ok) { status.value = 'error'; return; }
    data.value = await res.json();
    status.value = 'ok';
  } catch {
    status.value = 'error';
  }
}
load();
</script>

<template>
  <div v-if="status === 'notFound'" class="adv-profile-island-banner" role="status">
    This advocate is no longer listed.
  </div>
  <template v-else-if="status === 'ok'">
    <section v-if="authored.length" class="adv-profile-tutorials" aria-labelledby="adv-prof-authored-h">
      <h2 id="adv-prof-authored-h">Tutorials authored ({{ authored.length }})</h2>
      <ul>
        <li v-for="t in authored" :key="t.slug">
          <a :href="`/tutorials/${t.slug}/`">{{ t.title }}</a>
        </li>
      </ul>
    </section>
    <section v-if="contributed.length" class="adv-profile-tutorials" aria-labelledby="adv-prof-contrib-h">
      <h2 id="adv-prof-contrib-h">Tutorials contributed to ({{ contributed.length }})</h2>
      <ul>
        <li v-for="t in contributed" :key="t.slug">
          <a :href="`/tutorials/${t.slug}/`">{{ t.title }}</a>
        </li>
      </ul>
    </section>
  </template>
</template>
