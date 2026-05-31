<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import QueryEditor from './QueryEditor.vue'
import ChartRenderer from './ChartRenderer.vue'
import ChartTypeSwitcher from './ChartTypeSwitcher.vue'
import ClauseChipBar from './builder/ClauseChipBar.vue'
import SqlPreview from './builder/SqlPreview.vue'
import { useChartConfig } from '../composables/useChartConfig'
import { useQuerySpec } from '../composables/useQuerySpec'
import { useEntityGraph } from '../composables/useEntityGraph'
import { runSelectQuery } from '../api/sql'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'
import { validateQuerySpec } from '@srv-lib/query-spec-validator.mjs'
import { getCachedEntityMetadata, type ExposedEntity } from '../api/entities'
import type { ChartData } from '../composables/useChartEngine'

const chartConfig = useChartConfig()
const chartData = ref<ChartData | null>(null)
const showChart = ref(false)
const lastResults = ref<{ columns: string[]; rows: any[] } | null>(null)
const entities = ref<ExposedEntity[]>([])
const entitiesError = ref<string | null>(null)
const editorRef = ref<InstanceType<typeof QueryEditor> | null>(null)

const { spec, mode } = useQuerySpec()
const entityGraph = useEntityGraph()

// Run-from-chips: enabled only when a spec is loaded and the validator finds
// no errors. The Run button below routes between editor and chip-built SQL
// based on `mode` from useQuerySpec.
const canRunFromChips = computed(() => {
  if (!spec.value) return false
  const v = validateQuerySpec(spec.value, entityGraph.entityMap.value as any)
  return v.errors.length === 0
})

onMounted(async () => {
  try { entities.value = await getCachedEntityMetadata() }
  catch (e: any) { entitiesError.value = e.message }
})

function onResults(data: { columns: string[]; rows: any[] }) {
  lastResults.value = data
  showChart.value = false
}

function insertEntity(e: ExposedEntity) {
  // sqlName is the runtime-correct identifier (HANA physical name on prod,
  // mixed-case physical name in unit tests). Fall back to the short projection
  // name if the server didn't populate sqlName for some reason.
  editorRef.value?.insertText(e.sqlName || e.name)
}

async function runFromChips() {
  if (!spec.value) return
  try {
    const sql = specToSql(spec.value, entityGraph.sqlNames.value)
    const r = await runSelectQuery(sql, 'builder')
    // Convert array-of-arrays envelope to objects for the chart-config path,
    // matching how QueryEditor.run already projects.
    const rowsObj = r.rows.map(row => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])))
    lastResults.value = { columns: r.columns, rows: rowsObj }
    showChart.value = false
  } catch (e: any) {
    // Surface as a temporary lastResults shape; Phase 2 Part B Task 18 adds
    // a structured error card.
    // eslint-disable-next-line no-console
    console.warn('[SqlTab] runFromChips failed:', e.message)
  }
}

function visualize() {
  if (!lastResults.value) return
  showChart.value = true
  const cols = lastResults.value.columns
  chartData.value = {
    columns: cols,
    data: lastResults.value.rows.map(row => cols.map(c => row[c]))
  }
  if (cols.length >= 2) {
    chartConfig.clearAll()
    chartConfig.addDimension({ column: cols[0], dataType: 'NVARCHAR' })
    chartConfig.addMeasure({ column: cols[1], aggregation: 'SUM', alias: `sum_${cols[1]}` })
  }
}
</script>

<template>
  <div class="sql-tab">
    <ClauseChipBar />
    <SqlPreview />
    <div v-if="spec" class="builder-run-row">
      <ui5-button
        design="Emphasized"
        icon="play"
        :disabled="!canRunFromChips"
        @click="runFromChips"
      >Run from chips</ui5-button>
      <span v-if="!canRunFromChips" class="run-hint">Validation errors — see chip highlights</span>
    </div>
    <div class="main-row">
      <aside class="entity-list" aria-label="Exposed entities">
        <div class="entity-list-header">
          <strong>Exposed entities</strong>
          <span class="hint">Click to insert</span>
        </div>
        <div v-if="entitiesError" class="entity-error">{{ entitiesError }}</div>
        <ul v-else class="entity-items">
          <li v-for="e in entities" :key="e.name">
            <button
              type="button"
              class="entity-row"
              :title="e.columns.map(c => `${c.name}: ${c.type}`).join('\n')"
              @click="insertEntity(e)"
            >
              <span class="entity-label">{{ e.label }}</span>
              <code class="entity-sqlname">{{ e.sqlName || e.name }}</code>
              <span class="entity-cols">{{ e.columns.length }} cols</span>
            </button>
          </li>
        </ul>
      </aside>
      <div class="editor-section" :class="{ 'with-chart': showChart }">
        <QueryEditor ref="editorRef" @results="onResults" />
        <ui5-button
          v-if="lastResults"
          class="visualize-btn"
          design="Emphasized"
          icon="chart-table-view"
          @click="visualize"
        >
          Visualize
        </ui5-button>
      </div>
    </div>
    <div v-if="showChart" class="chart-section">
      <ChartTypeSwitcher v-model="chartConfig.chartType.value" :suggested="chartConfig.suggestedChartType.value" />
      <ChartRenderer
        :chart-type="chartConfig.chartType.value"
        :data="chartData"
        :dimensions="chartConfig.dimensions.value.map(d => d.column)"
        :measures="chartConfig.measures.value.map(m => m.column)"
      />
    </div>
  </div>
</template>

<style scoped>
.sql-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.builder-run-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.5rem 1rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
}
.run-hint {
  font-size: 0.75rem;
  color: var(--sapErrorColor);
}
.main-row {
  flex: 1;
  display: flex;
  min-height: 0;
}
.entity-list {
  width: 18rem;
  flex-shrink: 0;
  border-right: 1px solid var(--sapField_BorderColor);
  overflow-y: auto;
  padding: 0.5rem;
  background: var(--sapList_Background);
}
.entity-list-header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 0.25rem 0.25rem 0.5rem;
  border-bottom: 1px solid var(--sapField_BorderColor);
  margin-bottom: 0.25rem;
}
.entity-list-header .hint {
  color: var(--sapNeutralTextColor);
  font-size: 0.75rem;
}
.entity-items {
  list-style: none;
  padding: 0;
  margin: 0;
}
.entity-row {
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  padding: 0.4rem 0.5rem;
  cursor: pointer;
  border-radius: 4px;
  color: inherit;
  font-family: inherit;
}
.entity-row:hover {
  background: var(--sapList_Hover_Background);
  border-color: var(--sapField_BorderColor);
}
.entity-label {
  font-weight: 600;
  font-size: 0.85rem;
}
.entity-sqlname {
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.72rem;
  color: var(--sapNeutralTextColor);
  word-break: break-all;
  margin-top: 0.1rem;
}
.entity-cols {
  font-size: 0.7rem;
  color: var(--sapNeutralTextColor);
  margin-top: 0.1rem;
}
.entity-error {
  color: var(--sapErrorColor);
  font-size: 0.8rem;
  padding: 0.5rem 0.25rem;
}
.editor-section {
  flex: 1;
  position: relative;
  min-height: 0;
  overflow: hidden;
}
.editor-section.with-chart {
  flex: 0.6;
}
.chart-section {
  flex: 0.4;
  border-top: 1px solid var(--sapField_BorderColor);
  padding-top: 0.5rem;
}
.visualize-btn {
  position: absolute;
  bottom: 0.5rem;
  right: 0.5rem;
}
</style>
