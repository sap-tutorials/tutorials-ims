<script setup lang="ts">
import { ref, computed } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import ResultsTable from './ResultsTable.vue'
import PrivacyBadge from './PrivacyBadge.vue'
import ChartRenderer from '../ChartRenderer.vue'
import ChartTypeSwitcher from '../ChartTypeSwitcher.vue'
import { useChartConfig } from '../../composables/useChartConfig'
import { useExport } from '../../composables/useExport'
import type { ChartData } from '../../composables/useChartEngine'

interface SqlResult {
  columns: string[]
  rows: Array<Array<string | number | null>>
  metadata: { rowCount: number; truncated: boolean; durationMs: number }
  privacy?: { mode: 'raw' | 'k-anon'; suppressedCells?: number }
  historyId?: string
}

const props = defineProps<{
  results: SqlResult | null
  generatedSql: string
  canDrillDown: (row: Record<string, unknown>) => boolean
}>()

const emit = defineEmits<{
  (e: 'drilldown', row: Record<string, unknown>): void
}>()

const view = ref<'table' | 'chart'>('table')
const chartConfig = useChartConfig()
const { exportCsv, isExporting } = useExport()

// Chart data shape: array-of-arrays. Same as what runSelectQuery returns,
// so no conversion needed.
const chartData = computed<ChartData | null>(() => {
  if (!props.results) return null
  return {
    columns: props.results.columns,
    data: props.results.rows as (string | number)[][],
  }
})

// Spec §4: chart toggle disabled when result rows > 10,000 OR when there's
// no numeric/temporal column to plot. Server caps at 5,000 so the row-cap
// clause is mostly defensive; the no-numeric clause is the real gate
// (e.g. SELECT DISTINCT name FROM Users → no chart-able column).
const chartEnabled = computed<boolean>(() => {
  if (!props.results || props.results.rows.length === 0) return false
  if (props.results.rows.length > 10000) return false
  // Heuristic: a result column is chart-eligible if at least one of its
  // values parses as a number or as a Date. This is best-effort — the
  // backend hands rows back as stringified scalars; we can't see the
  // original CDS type from this end.
  const firstFew = props.results.rows.slice(0, Math.min(20, props.results.rows.length))
  return props.results.columns.some((_, idx) =>
    firstFew.some(row => {
      const v = row[idx]
      if (v === null || v === undefined) return false
      if (typeof v === 'number') return true
      const s = String(v)
      // Numeric (incl. decimals/negatives) OR ISO-ish date.
      return /^-?\d+(\.\d+)?$/.test(s) || /^\d{4}-\d{2}-\d{2}/.test(s)
    })
  )
})

const chartDisabledReason = computed<string>(() => {
  if (!props.results || props.results.rows.length === 0) return 'Run a query first.'
  if (props.results.rows.length > 10000) return 'Charting requires ≤10,000 rows.'
  return 'Charting requires at least one numeric or temporal column.'
})

// Right-click → drilldown menu state
const menuOpen = ref(false)
const menuX = ref(0)
const menuY = ref(0)
const menuRow = ref<Record<string, unknown> | null>(null)

function onRowContextMenu(payload: { row: Record<string, unknown>; x: number; y: number; rowIndex: number }) {
  menuRow.value = payload.row
  menuX.value = payload.x
  menuY.value = payload.y
  menuOpen.value = true
}

function closeMenu() {
  menuOpen.value = false
  menuRow.value = null
}

function confirmDrilldown() {
  if (!menuRow.value) return
  emit('drilldown', menuRow.value)
  closeMenu()
}

const drillEnabled = computed(() => menuRow.value ? props.canDrillDown(menuRow.value) : false)

function toggleView(v: 'table' | 'chart') {
  if (v === 'chart' && !chartEnabled.value) return  // gated; user can't toggle when disabled
  view.value = v
  if (v === 'chart' && chartConfig.dimensions.value.length === 0) {
    // Bootstrap chart config from the result columns the first time the
    // user toggles to chart view (mirrors the old visualize() behavior).
    if (props.results && props.results.columns.length >= 2) {
      const [d, m] = props.results.columns
      chartConfig.clearAll()
      chartConfig.addDimension({ column: d, dataType: 'NVARCHAR' })
      chartConfig.addMeasure({ column: m, aggregation: 'SUM', alias: `sum_${m}` })
    }
  }
}

async function onExportClick() {
  if (!props.generatedSql) return
  try {
    await exportCsv(props.generatedSql)
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[ResultsTab] export failed:', e.message)
  }
}

defineExpose({ onRowContextMenu, confirmDrilldown })
</script>

<template>
  <div class="results-tab">
    <div class="results-toolbar">
      <PrivacyBadge :privacy="results?.privacy" />
      <div class="view-toggle">
        <button
          data-test="results-view-table"
          :class="{ active: view === 'table' }"
          @click="toggleView('table')"
        >Table</button>
        <button
          data-test="results-view-chart"
          :class="{ active: view === 'chart' }"
          :disabled="!chartEnabled"
          :title="chartEnabled ? 'Show as chart' : chartDisabledReason"
          @click="toggleView('chart')"
        >Chart</button>
      </div>
      <span v-if="results" class="meta">
        {{ results.metadata.rowCount }} rows · {{ results.metadata.durationMs }}ms
        <span v-if="results.metadata.truncated" class="truncated">(truncated)</span>
      </span>
      <ui5-button
        data-test="export-csv"
        design="Transparent"
        icon="excel-attachment"
        :disabled="isExporting || !generatedSql"
        @click="onExportClick"
      >
        {{ isExporting ? 'Exporting…' : 'Export CSV' }}
      </ui5-button>
    </div>

    <div class="results-body">
      <ResultsTable
        v-if="view === 'table' && results"
        :columns="results.columns"
        :rows="results.rows"
        @row-context-menu="onRowContextMenu"
      />
      <div v-else-if="view === 'chart' && results" class="chart-wrap">
        <ChartTypeSwitcher
          v-model="chartConfig.chartType.value"
          :suggested="chartConfig.suggestedChartType.value"
        />
        <ChartRenderer
          :chart-type="chartConfig.chartType.value"
          :data="chartData"
          :dimensions="chartConfig.dimensions.value.map(d => d.column)"
          :measures="chartConfig.measures.value.map(m => m.column)"
        />
      </div>
      <div v-else class="empty">Click Run to see results.</div>
    </div>

    <!-- Right-click drilldown menu — positioned absolutely at click coords -->
    <div
      v-if="menuOpen"
      class="context-menu"
      :style="{ top: menuY + 'px', left: menuX + 'px' }"
      @click.stop
    >
      <button :disabled="!drillEnabled" @click="confirmDrilldown">
        Drill into this row
      </button>
      <button @click="closeMenu">Cancel</button>
      <p v-if="!drillEnabled" class="menu-hint">
        Drilldown unavailable: query needs aggregation chips, no expression
        chips, and non-NULL values in projected columns.
      </p>
    </div>
    <div v-if="menuOpen" class="menu-backdrop" @click="closeMenu" />
  </div>
</template>

<style scoped>
.results-tab {
  display: flex;
  flex-direction: column;
  height: 100%;
  position: relative;
}
.results-toolbar {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
  flex-wrap: wrap;
}
.view-toggle {
  display: inline-flex;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  overflow: hidden;
}
.view-toggle button {
  padding: 0.2rem 0.6rem;
  border: none;
  background: var(--sapList_Background);
  cursor: pointer;
  font: inherit;
  font-size: 0.8rem;
}
.view-toggle button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.view-toggle button.active {
  background: var(--sapButton_Selected_Background, #0070f3);
  color: var(--sapButton_Selected_TextColor, white);
}
.meta {
  font-size: 0.75rem;
  color: var(--sapNeutralTextColor);
  margin-left: auto;
}
.truncated { color: var(--sapWarningTextColor); }
.results-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0.5rem;
}
.chart-wrap {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  height: 100%;
}
.empty {
  padding: 2rem;
  text-align: center;
  color: var(--sapNeutralTextColor);
}
.context-menu {
  position: fixed;
  background: var(--sapList_Background);
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
  padding: 0.25rem;
  z-index: 1000;
  min-width: 16rem;
}
.context-menu button {
  display: block;
  width: 100%;
  text-align: left;
  padding: 0.4rem 0.75rem;
  border: none;
  background: transparent;
  cursor: pointer;
  font: inherit;
  font-size: 0.85rem;
}
.context-menu button:disabled {
  color: var(--sapNeutralTextColor);
  cursor: not-allowed;
}
.context-menu button:not(:disabled):hover {
  background: var(--sapList_Hover_Background);
}
.menu-hint {
  padding: 0.4rem 0.75rem;
  font-size: 0.7rem;
  color: var(--sapNeutralTextColor);
  margin: 0;
}
.menu-backdrop {
  position: fixed;
  top: 0; left: 0; right: 0; bottom: 0;
  z-index: 999;
}
</style>
