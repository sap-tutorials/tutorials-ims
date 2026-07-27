<!-- hugo-apps/src/concepts-filter/ConceptCard.vue -->
<!--
  One concept card in the virtualized /concepts/ list (#1327 Task 4).

  Emits the SAME anchor/classes as the Hugo-rendered <li> in
  layouts/concepts/list.html (concepts-index__item / __link / __name /
  __description / __meta) so the existing CSS applies unchanged — the
  RecycleScroller just swaps which cards are live in the DOM.
-->
<script setup lang="ts">
import { computed } from 'vue';
import type { ConceptCard } from './filter-logic';

const props = defineProps<{ card: ConceptCard }>();

// Parity with the Hugo template's `truncate 140` on the description.
const shortDesc = computed(() => {
  const d = props.card.description || '';
  return d.length > 140 ? d.slice(0, 140).trimEnd() + '…' : d;
});
</script>

<template>
  <li
    class="concepts-index__item"
    :data-slug="card.slug"
    :data-name="card.name"
    :data-first-letter="card.firstLetter"
    :data-tutorial-count="card.tutorialCount"
  >
    <a class="concepts-index__link" :href="`/concepts/${card.slug}/`">
      <span class="concepts-index__name">{{ card.name }}</span>
      <span v-if="shortDesc" class="concepts-index__description">{{ shortDesc }}</span>
      <span v-if="card.tutorialCount > 0" class="concepts-index__meta">
        {{ card.tutorialCount }} tutorial{{ card.tutorialCount === 1 ? '' : 's' }}
      </span>
    </a>
  </li>
</template>
