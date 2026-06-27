<script setup lang="ts">
import { ref, onMounted } from 'vue';

interface EventCard {
  title: string;
  startsAt: string;
  location: string;
  format: string;
  register: string | null;
}

const props = defineProps<{ mode?: string }>();

const events = ref<EventCard[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatChipClass(format: string): string {
  const f = (format || '').toLowerCase();
  if (f === 'in-person' || f === 'in person') return 'hb-chip hb-chip--inperson';
  if (f === 'virtual') return 'hb-chip hb-chip--virtual';
  return 'hb-chip hb-chip--hybrid';
}

onMounted(async () => {
  try {
    const limit = props.mode === 'full-calendar' ? 20 : 4;
    const res = await fetch(`/api/homepage/events?$top=${limit}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    events.value = Array.isArray(body.value) ? body.value : Array.isArray(body) ? body : [];
  } catch (e: any) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="hb-events-band">
    <!-- Loading skeleton -->
    <div v-if="loading" class="hb-events-band__grid" aria-hidden="true">
      <div v-for="i in 4" :key="i" class="hb-events-band__skel"></div>
    </div>

    <!-- Error / empty state -->
    <div v-else-if="error || !events.length" class="hb-events-band__empty">
      <p class="hb-events-band__empty-msg">
        {{ error ? 'Could not load upcoming events.' : 'No upcoming events.' }}
      </p>
      <a
        href="https://community.sap.com/t5/sap-events/ct-p/events"
        target="_blank"
        rel="noopener noreferrer"
        class="hb-events-band__fallback-link"
      >View all SAP events &rarr;</a>
    </div>

    <!-- Cards -->
    <div v-else class="hb-events-band__grid">
      <article v-for="(ev, idx) in events" :key="idx" class="hb-events-band__card">
        <header class="hb-events-band__card-head">
          <span :class="formatChipClass(ev.format)">{{ ev.format || 'Event' }}</span>
          <time class="hb-events-band__date">{{ formatDate(ev.startsAt) }}</time>
        </header>
        <h3 class="hb-events-band__card-title">{{ ev.title }}</h3>
        <p v-if="ev.location" class="hb-events-band__location">{{ ev.location }}</p>
        <footer class="hb-events-band__card-foot">
          <a
            v-if="ev.register"
            :href="ev.register"
            target="_blank"
            rel="noopener noreferrer"
            class="hb-events-band__register"
          >Register</a>
          <span v-else class="hb-events-band__register hb-events-band__register--none">Registration TBD</span>
        </footer>
      </article>
    </div>
  </div>
</template>

<style scoped>
.hb-events-band {
  width: 100%;
}

.hb-events-band__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sapContent_Gap, 1rem);
}

@media (max-width: 900px) {
  .hb-events-band__grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 560px) {
  .hb-events-band__grid {
    grid-template-columns: 1fr;
  }
}

.hb-events-band__skel {
  height: 160px;
  border-radius: 8px;
  background: linear-gradient(90deg, #f1f4f9 0%, #e6effa 50%, #f1f4f9 100%);
  background-size: 200% 100%;
  animation: hb-shimmer 1.4s linear infinite;
}

@keyframes hb-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

@media (prefers-reduced-motion: reduce) {
  .hb-events-band__skel { animation: none; }
}

.hb-events-band__card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 1rem;
  border: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
  border-radius: 8px;
  background: var(--sapBaseColor, #fff);
}

.hb-events-band__card-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}

.hb-events-band__date {
  font-size: 0.8rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin-left: auto;
}

.hb-events-band__card-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: var(--sapTextColor, #32363a);
  line-height: 1.35;
}

.hb-events-band__location {
  font-size: 0.85rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0;
}

.hb-events-band__card-foot {
  margin-top: auto;
  padding-top: 0.5rem;
}

.hb-events-band__register {
  display: inline-block;
  padding: 0.3rem 0.9rem;
  border-radius: 4px;
  background: var(--sapButton_Emphasized_Background, #0070f2);
  color: var(--sapButton_Emphasized_TextColor, #fff);
  font-size: 0.85rem;
  font-weight: 600;
  text-decoration: none;
  border: none;
  cursor: pointer;
}

.hb-events-band__register--none {
  background: transparent;
  color: var(--sapContent_LabelColor, #6a6d70);
  font-weight: 400;
  padding-left: 0;
}

.hb-chip {
  display: inline-block;
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: capitalize;
}

.hb-chip--inperson {
  background: #e8f5e9;
  color: #2e7d32;
}

.hb-chip--virtual {
  background: #e3f2fd;
  color: #1565c0;
}

.hb-chip--hybrid {
  background: #fff3e0;
  color: #e65100;
}

.hb-events-band__empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.75rem;
  padding: 2.5rem 1rem;
  text-align: center;
}

.hb-events-band__empty-msg {
  margin: 0;
  color: var(--sapContent_LabelColor, #6a6d70);
}

.hb-events-band__fallback-link {
  color: var(--sapLinkColor, #0070f2);
  font-weight: 600;
  text-decoration: none;
}

.hb-events-band__fallback-link:hover {
  text-decoration: underline;
}
</style>
