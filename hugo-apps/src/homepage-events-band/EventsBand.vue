<script setup lang="ts">
// #1030 — Row 3 homepage events band.
// Fetches /homepage/events, renders 6 cards, exposes a 5-chip filter.
// Initial region priority: envelope.eventsRegion > localStorage > TZ hint > 'ALL'.

import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { Region } from './tz-to-region';
import { tzToRegion } from './tz-to-region';
import { readLocalStorageRegion, writeLocalStorageRegion } from './region-storage';
import { csrfFetch } from '@shared/csrf-fetch';

type EventCard = {
  title: string;
  startsAt: string | null;
  endsAt: string | null;
  location: string;
  url: string | null;
  eventType: string | null;
  region: string;
  isVirtual: boolean;
};

const CHIPS: Array<{ id: Region; label: string }> = [
  { id: 'ALL',       label: 'All' },
  { id: 'AMERICAS',  label: 'Americas' },
  { id: 'EMEA',      label: 'EMEA' },
  { id: 'APJ',       label: 'APJ' },
  { id: 'VIRTUAL',   label: 'Virtual only' },
];

const region = ref<Region>('ALL');
const rows = ref<EventCard[]>([]);
const loading = ref(true);
const errored = ref(false);
let currentEtag: string | null = null;
let bc: BroadcastChannel | null = null;

function resolveInitialRegion(): Region {
  const envelope = (window as any).__homepagePersonalized?.eventsRegion;
  if (envelope && ['AMERICAS','EMEA','APJ','VIRTUAL','ALL'].includes(envelope)) {
    return envelope as Region;
  }
  return readLocalStorageRegion() ?? tzToRegion();
}

async function refetch(r: Region) {
  loading.value = true;
  errored.value = false;
  const params = new URLSearchParams();
  params.set('region', r);
  // ALL/VIRTUAL don't need includeVirtual (server picks the right semantics).
  if (r !== 'ALL' && r !== 'VIRTUAL') params.set('includeVirtual', 'true');
  try {
    const resp = await fetch(`/homepage/events?${params}`, {
      credentials: 'include',
      headers: currentEtag ? { 'If-None-Match': currentEtag } : {},
    });
    if (resp.status === 304) {
      loading.value = false;
      return;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    currentEtag = resp.headers.get('ETag');
    // CAP OData function-imports envelope arrays as `{value: [...]}`.
    // Bare-array fallback keeps fixtures + non-OData mounts working.
    const body = await resp.json();
    rows.value = Array.isArray(body?.value) ? body.value : Array.isArray(body) ? body : [];
  } catch (err) {
    console.debug('[homepage-events-band] fetch failed', err);
    errored.value = true;
  } finally {
    loading.value = false;
  }
}

function isSignedIn(): boolean {
  return /(?:^|;\s*)JSESSIONID=/.test(document.cookie) || Boolean((window as any).__homepagePersonalized);
}

async function onChipClick(next: Region) {
  region.value = next;
  writeLocalStorageRegion(next);
  if (isSignedIn()) {
    csrfFetch('/api/setPreferredEventRegion', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ region: next }),
    }).catch(() => { /* fire-and-forget */ });
  }
  await refetch(next);
}

onMounted(async () => {
  region.value = resolveInitialRegion();
  await refetch(region.value);

  try {
    bc = new BroadcastChannel('sap-devs-prefs');
    bc.onmessage = (e) => {
      if (e.data?.type === 'preferences-changed' && e.data?.eventsRegion
          && e.data.eventsRegion !== region.value) {
        region.value = e.data.eventsRegion;
        currentEtag = null;
        refetch(region.value);
      }
    };
  } catch { /* older browsers */ }
});

onBeforeUnmount(() => { bc?.close(); });

function formatDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
    });
  } catch {
    return iso;
  }
}
</script>

<template>
  <h2>Upcoming events</h2>

  <div class="events-band__chips">
    <button v-for="chip in CHIPS" :key="chip.id"
            :class="['events-band__chip', { 'events-band__chip--active': region === chip.id }]"
            @click="onChipClick(chip.id)"
            :aria-pressed="region === chip.id">
      {{ chip.label }}
    </button>
  </div>

  <div v-if="loading" class="events-band__loading" aria-live="polite">
    Loading upcoming events…
  </div>

  <div v-else-if="rows.length === 0 && !errored" class="events-band__empty">
    No upcoming events match this filter.
    <a href="/connect/">See the full events calendar →</a>
  </div>

  <div v-else-if="errored" class="events-band__empty">
    Couldn't load events right now.
    <a href="/connect/">See the full events calendar →</a>
  </div>

  <div v-else class="events-band__cards">
    <a v-for="row in rows" :key="row.url || row.title"
       :href="row.url || '/connect/'"
       class="event-card"
       :class="{ 'event-card--virtual': row.isVirtual }">
      <div class="event-card__type">
        {{ row.eventType === 'codejam' ? 'CodeJam' : row.eventType === 'devtoberfest' ? 'Devtoberfest' : 'Event' }}
      </div>
      <div class="event-card__title">{{ row.title }}</div>
      <div class="event-card__meta">
        <span class="event-card__date">{{ formatDate(row.startsAt) }}</span>
        <span class="event-card__location">{{ row.isVirtual ? 'Virtual' : row.location }}</span>
      </div>
    </a>
  </div>
</template>
