<script setup lang="ts">
import { ref, computed } from 'vue';

interface Channel {
  name: string;
  url: string;
  purpose?: string;
  focusAreas?: string[];
}

const props = defineProps<{ channels: Channel[] }>();

const MAX_SELECTED = 6;
const MAX_RESULTS = 12;

// Derive unique, sorted focus areas from the channels array.
const focusAreas = computed(() => {
  const set = new Set<string>();
  for (const ch of props.channels) {
    for (const f of ch.focusAreas ?? []) set.add(f);
  }
  return [...set].sort();
});

const selected = ref<Set<string>>(new Set());

function toggle(area: string) {
  const next = new Set(selected.value);
  if (next.has(area)) {
    next.delete(area);
  } else if (next.size < MAX_SELECTED) {
    next.add(area);
  }
  selected.value = next;
}

// All channels matching at least one selected area (pre-cap), ranked by match count.
const ranked = computed(() => {
  if (selected.value.size === 0) return [];
  return props.channels
    .map((ch) => {
      const matchCount = (ch.focusAreas ?? []).filter((f) => selected.value.has(f)).length;
      return { ch, matchCount };
    })
    .filter(({ matchCount }) => matchCount > 0)
    .sort((a, b) => b.matchCount - a.matchCount);
});

// Displayed results, capped at MAX_RESULTS.
const results = computed(() => ranked.value.slice(0, MAX_RESULTS).map(({ ch }) => ch));

// Total matches before the display cap, for the "N channels match" count.
const matchedTotal = computed(() => ranked.value.length);
</script>

<template>
  <div class="media-diet">
    <p class="media-diet__instruction">
      Pick up to {{ MAX_SELECTED }} focus areas to get a personalized channel bundle.
    </p>
    <div class="media-diet__body">
      <div class="media-diet__picker">
        <ul class="media-diet__areas">
          <li v-for="area in focusAreas" :key="area">
            <button
              class="focus-area-btn"
              :class="{ 'focus-area-btn--selected': selected.has(area) }"
              :aria-pressed="selected.has(area)"
              :disabled="!selected.has(area) && selected.size >= MAX_SELECTED"
              data-focus-area
              @click="toggle(area)"
            >{{ area }}</button>
          </li>
        </ul>
      </div>

      <div class="media-diet__output">
        <p v-if="selected.size === 0" class="media-diet__prompt">
          Select at least one focus area to see recommended channels.
        </p>

        <template v-else>
          <p class="media-diet__count" data-testid="result-count" aria-live="polite">
            <template v-if="matchedTotal === 0">No channels match the selected focus areas yet.</template>
            <template v-else-if="matchedTotal > results.length">
              {{ matchedTotal }} channels match — showing top {{ results.length }}.
            </template>
            <template v-else>
              {{ matchedTotal }} {{ matchedTotal === 1 ? 'channel matches' : 'channels match' }} your diet.
            </template>
          </p>

          <ul v-if="results.length" class="media-diet__results" data-testid="results">
            <li v-for="ch in results" :key="ch.url" class="media-diet-result" data-testid="result-item">
              <a :href="ch.url" target="_blank" rel="noopener" class="media-diet-result__name">{{ ch.name }}</a>
              <p v-if="ch.purpose" class="media-diet-result__purpose">{{ ch.purpose }}</p>
            </li>
          </ul>

          <p v-else class="media-diet__empty">
            No published channels match the selected focus areas yet.
          </p>
        </template>
      </div>
    </div>

    <!-- PHASE 2 SEAM: export button (bookmarks + OPML) and signed-in inferred picks go here -->
  </div>
</template>

<style scoped>
.media-diet {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}
.media-diet__instruction {
  margin: 0;
  color: var(--sapNeutralTextColor, #556b82);
}
.media-diet__body {
  display: grid;
  grid-template-columns: minmax(12rem, 16rem) 1fr;
  gap: 1.5rem;
  align-items: start;
}
@media (max-width: 40rem) {
  .media-diet__body {
    grid-template-columns: 1fr;
  }
}
.media-diet__picker {
  position: sticky;
  top: 1rem;
}
.media-diet__output {
  min-width: 0;
}
.media-diet__count {
  margin: 0 0 0.75rem;
  font-weight: 600;
  color: var(--sapTextColor, #1d2d3e);
}
.media-diet__areas {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.focus-area-btn {
  padding: 0.375rem 0.875rem;
  border: 1px solid var(--sapButton_BorderColor, #0070f2);
  border-radius: 1rem;
  background: transparent;
  color: var(--sapButton_TextColor, #0070f2);
  font: inherit;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.1s;
}
.focus-area-btn:hover:not(:disabled) {
  background: var(--sapButton_Hover_Background, #ebf3ff);
}
.focus-area-btn--selected {
  background: var(--sapButton_Active_Background, #0070f2);
  color: var(--sapButton_Active_TextColor, #fff);
}
.focus-area-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.media-diet__prompt,
.media-diet__empty {
  margin: 0;
  color: var(--sapNeutralTextColor, #556b82);
}
.media-diet__results {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr));
  gap: 0.75rem;
}
.media-diet-result {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  padding: 0.875rem 1rem;
  border: 1px solid var(--sapList_BorderColor, #d9d9d9);
  border-radius: var(--sapElement_BorderCornerRadius, 0.75rem);
  background: var(--sapGroup_ContentBackground, #fff);
}
.media-diet-result__name {
  font-weight: 600;
  color: var(--sapLinkColor, #0070f2);
  text-decoration: none;
}
.media-diet-result__name:hover {
  text-decoration: underline;
}
.media-diet-result__purpose {
  margin: 0;
  font-size: 0.875rem;
  color: var(--sapTextColor, #1d2d3e);
}
</style>
