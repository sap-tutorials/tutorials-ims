<script setup lang="ts">
// hugo-apps/src/devtoberfest-schedule-shared/RelatedSessions.vue
//
// Self-contained presentational block that renders a "Related Devtoberfest
// sessions" list for a TechEd session context. Shared between the teched grid
// cards (App.vue) and the shared DetailPanel, so it lives in the shared dir.
//
// Fails open: renders nothing when relatedDevtoberfestSessions is empty or
// absent (i.e. when TECHED_DEVTOBERFEST_CROSSLINK_ENABLED DB flag is OFF).
import type { RelatedDevtoberfestSession } from '../teched-sessions-grid/filter';

defineProps<{
  sessions: RelatedDevtoberfestSession[] | undefined | null;
}>();
</script>

<template>
  <div v-if="sessions && sessions.length" class="tsg-related">
    <h4 class="tsg-related-heading">Related Devtoberfest Sessions</h4>
    <ul class="tsg-related-list">
      <li v-for="item in sessions" :key="item.sessionId" class="tsg-related-item">
        <a
          v-if="item.sessionId"
          :href="`/devtoberfest/sessions/?session=${encodeURIComponent(item.sessionId)}`"
          target="_self"
          class="tsg-related-link"
        >
          <span class="tsg-related-title">{{ item.title }}</span>
          <span v-if="item.sessionCode" class="tsg-related-code">{{ item.sessionCode }}</span>
        </a>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tsg-related {
  margin-top: 0.75rem;
  padding-top: 0.75rem;
  border-top: 1px solid var(--sapContent_ForegroundBorderColor, #e4e7ed);
}

.tsg-related-heading {
  font-size: 0.8rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.03em;
  color: var(--sapContent_LabelColor, #6a6d70);
  margin: 0 0 0.4rem;
}

.tsg-related-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}

.tsg-related-item {
  display: flex;
}

.tsg-related-link {
  display: inline-flex;
  align-items: baseline;
  gap: 0.4rem;
  font-size: 0.8rem;
  color: var(--sapLinkColor, #0854a0);
  text-decoration: none;
}
.tsg-related-link:hover {
  text-decoration: underline;
}

.tsg-related-title {
  flex: 1;
}

.tsg-related-code {
  flex-shrink: 0;
  font-size: 0.72rem;
  color: var(--sapContent_LabelColor, #6a6d70);
  border: 1px solid var(--sapField_BorderColor, #89919a);
  border-radius: 20px;
  padding: 0.05rem 0.4rem;
  white-space: nowrap;
}
</style>
