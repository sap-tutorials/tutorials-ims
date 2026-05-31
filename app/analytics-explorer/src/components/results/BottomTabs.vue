<script setup lang="ts">
import { ref } from 'vue'
import ResultsTab from './ResultsTab.vue'
import HistoryTab from './HistoryTab.vue'
import SavedTab from './SavedTab.vue'
import type { HistoryRow } from '../../composables/useHistory'
import type { SavedRow } from '../../composables/useSavedQueries'

interface SqlResult {
  columns: string[]
  rows: Array<Array<string | number | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells?: number }
  historyId?: string
}

defineProps<{
  results: SqlResult | null
  generatedSql: string
  canDrillDown: (row: Record<string, unknown>) => boolean
}>()

const emit = defineEmits<{
  (e: 'drilldown', row: Record<string, unknown>): void
  (e: 'load-row', payload: { source: 'history' | 'saved'; row: HistoryRow | SavedRow }): void
}>()

const activeTab = ref<'results' | 'history' | 'saved'>('results')

function onHistoryLoad(row: HistoryRow) {
  emit('load-row', { source: 'history', row })
}
function onSavedLoad(row: SavedRow) {
  emit('load-row', { source: 'saved', row })
}
</script>

<template>
  <div class="bottom-tabs">
    <div class="tab-strip" role="tablist">
      <button
        data-test="bottom-tab-results"
        :class="{ active: activeTab === 'results' }"
        role="tab"
        @click="activeTab = 'results'"
      >Results</button>
      <button
        data-test="bottom-tab-history"
        :class="{ active: activeTab === 'history' }"
        role="tab"
        @click="activeTab = 'history'"
      >History</button>
      <button
        data-test="bottom-tab-saved"
        :class="{ active: activeTab === 'saved' }"
        role="tab"
        @click="activeTab = 'saved'"
      >Saved</button>
    </div>
    <div class="tab-content">
      <ResultsTab
        v-if="activeTab === 'results'"
        :results="results"
        :generated-sql="generatedSql"
        :can-drill-down="canDrillDown"
        @drilldown="(row: Record<string, unknown>) => emit('drilldown', row)"
      />
      <HistoryTab
        v-else-if="activeTab === 'history'"
        @load="onHistoryLoad"
      />
      <SavedTab
        v-else-if="activeTab === 'saved'"
        @load="onSavedLoad"
      />
    </div>
  </div>
</template>

<style scoped>
.bottom-tabs {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.tab-strip {
  display: flex;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
}
.tab-strip button {
  padding: 0.4rem 0.9rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
  border-bottom: 2px solid transparent;
}
.tab-strip button.active {
  border-bottom-color: var(--sapButton_Selected_Background, #0070f3);
  color: var(--sapButton_Selected_Background, #0070f3);
  font-weight: 600;
}
.tab-content {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
