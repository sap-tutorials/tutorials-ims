<script setup lang="ts">
// Shared session-card for advocate pages (issue #2354). Mirrors the Hugo
// partial hugo/layouts/partials/session-card.html 1:1 (same fields, same
// classes) so TechEd + Devtoberfest cards look identical on author (SSR) and
// advocate (Vue) pages. Renders an external link when sourceUrl is present,
// else a non-link card.
export interface SessionCard {
  event: 'teched' | 'devtoberfest';
  title: string;
  sourceUrl: string;
  track: string;
  venue: string;
  date: string | null;
}

const props = defineProps<{ card: SessionCard }>();

const eventLabel = props.card.event === 'teched' ? 'SAP TechEd' : 'Devtoberfest';

// venue/track → a single meta line; date appended when parseable.
function metaText(c: SessionCard): string {
  const parts: string[] = [];
  if (c.track) parts.push(c.track);
  if (c.venue && c.venue !== 'Devtoberfest') parts.push(c.venue);
  if (c.date) {
    const d = new Date(c.date);
    if (!Number.isNaN(d.getTime())) {
      parts.push(d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }));
    }
  }
  return parts.join(' · ');
}
</script>

<template>
  <a
    v-if="card.sourceUrl"
    :href="card.sourceUrl"
    class="next-steps-rail-card session-card"
    :data-event="card.event"
    target="_blank"
    rel="noopener"
  >
    <span class="next-steps-label session-card-badge">{{ eventLabel }}</span>
    <span class="next-steps-title">{{ card.title }}</span>
    <span v-if="metaText(card)" class="next-steps-meta">{{ metaText(card) }}</span>
  </a>
  <div v-else class="next-steps-rail-card session-card" :data-event="card.event">
    <span class="next-steps-label session-card-badge">{{ eventLabel }}</span>
    <span class="next-steps-title">{{ card.title }}</span>
    <span v-if="metaText(card)" class="next-steps-meta">{{ metaText(card) }}</span>
  </div>
</template>
