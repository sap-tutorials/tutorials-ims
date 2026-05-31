<script setup lang="ts">
import { onMounted } from 'vue'
import { useQuerySpec } from '../../composables/useQuerySpec'
import { useEntityGraph } from '../../composables/useEntityGraph'

const querySpec = useQuerySpec()
const entityGraph = useEntityGraph()

onMounted(async () => {
  // Lazy-load entity metadata when the chip bar mounts. Cheap because
  // getCachedEntityMetadata is already memoized at the API layer.
  try {
    await entityGraph.load()
  } catch (e) {
    // Surface via console; chips will render the "loading" state until
    // a re-load succeeds. Detailed error UX added in Part B Task 18.
    // eslint-disable-next-line no-console
    console.warn('[ClauseChipBar] entity metadata load failed:', e)
  }
})
</script>

<template>
  <div class="clause-chip-bar" role="toolbar" aria-label="Query builder">
    <div v-if="!querySpec.spec.value" class="empty-hint">
      Click an entity in the sidebar to start building a query, or switch to the SQL Editor tab.
    </div>
    <div v-else class="chips-placeholder">
      <!-- Phase 2 Part B fills in: FromChip, JoinChip(s), FilterChip tree,
           GroupByChip(s), SelectChip(s), OrderByChip(s), LimitChip. -->
      <code class="spec-debug">{{ JSON.stringify(querySpec.spec.value, null, 2) }}</code>
    </div>
  </div>
</template>

<style scoped>
.clause-chip-bar {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
  min-height: 3rem;
  display: flex;
  align-items: center;
}

.empty-hint {
  color: var(--sapContent_LabelColor);
  font-size: 0.875rem;
}

.chips-placeholder {
  font-family: var(--sapFontFamily);
  font-size: 0.75rem;
  color: var(--sapContent_LabelColor);
}

.spec-debug {
  font-family: var(--sapFontMonospaceFamily);
  white-space: pre-wrap;
  max-width: 60ch;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
