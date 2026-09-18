<script setup lang="ts">
import { ref, computed } from 'vue';
import './styles.css';
import SessionCard, { type SessionCard as SessionCardData } from './SessionCard.vue';

interface TutorialLink { slug: string; title: string }
interface AdvocateSessions { teched: SessionCardData[]; devtoberfest: SessionCardData[] }
interface SingleAdvocate {
  slug: string;
  firstName: string;
  lastName: string;
  authoredTutorials?: TutorialLink[];
  contributedTutorials?: TutorialLink[];
  sessions?: AdvocateSessions;
}

const props = defineProps<{ apiUrl: string }>();
const data = ref<SingleAdvocate | null>(null);
const status = ref<'loading' | 'ok' | 'notFound' | 'error'>('loading');

const authored = computed(() => data.value?.authoredTutorials || []);
const contributed = computed(() => data.value?.contributedTutorials || []);
// TechEd + Devtoberfest cards in one list (each card carries its own event badge).
const sessions = computed<SessionCardData[]>(() => {
  const s = data.value?.sessions;
  if (!s) return [];
  return [...(s.teched || []), ...(s.devtoberfest || [])];
});

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
  <div v-if="status === 'notFound'" class="dev-advocate-profile-island-banner" role="status">
    This advocate is no longer listed.
  </div>
  <template v-else-if="status === 'ok'">
    <section v-if="sessions.length" class="dev-advocate-profile-sessions" aria-labelledby="dev-advocate-prof-sessions-h">
      <h2 id="dev-advocate-prof-sessions-h">Sessions ({{ sessions.length }})</h2>
      <div class="next-steps-rail">
        <div class="next-steps-grid">
          <SessionCard
            v-for="(s, i) in sessions"
            :key="`${s.event}-${i}-${s.title}`"
            :card="s"
          />
        </div>
      </div>
    </section>
    <section v-if="authored.length" class="dev-advocate-profile-tutorials" aria-labelledby="dev-advocate-prof-authored-h">
      <h2 id="dev-advocate-prof-authored-h">Tutorials authored ({{ authored.length }})</h2>
      <div class="next-steps-rail">
        <div class="next-steps-grid">
          <a
            v-for="t in authored"
            :key="t.slug"
            :href="`/tutorials/${t.slug}/`"
            class="next-steps-rail-card"
          >
            <span class="next-steps-label">TUTORIAL</span>
            <span class="next-steps-title">{{ t.title }}</span>
          </a>
        </div>
      </div>
    </section>
    <section v-if="contributed.length" class="dev-advocate-profile-tutorials" aria-labelledby="dev-advocate-prof-contrib-h">
      <h2 id="dev-advocate-prof-contrib-h">Tutorials contributed to ({{ contributed.length }})</h2>
      <div class="next-steps-rail">
        <div class="next-steps-grid">
          <a
            v-for="t in contributed"
            :key="t.slug"
            :href="`/tutorials/${t.slug}/`"
            class="next-steps-rail-card"
          >
            <span class="next-steps-label">TUTORIAL</span>
            <span class="next-steps-title">{{ t.title }}</span>
          </a>
        </div>
      </div>
    </section>
  </template>
</template>
