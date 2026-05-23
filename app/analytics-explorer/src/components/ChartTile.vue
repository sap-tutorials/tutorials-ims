<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import ChartRenderer from './ChartRenderer.vue'
import { useDataSource } from '../composables/useDataSource'
import type { ChartConfig, FilterConfig } from '../composables/useChartConfig'
import type { ChartData } from '../composables/useChartEngine'
import type { ChartConfigInput } from '../api/odata'

const props = defineProps<{
  config: ChartConfig
  crossFilters?: FilterConfig[]
}>()

const emit = defineEmits<{
  chartClick: [params: any]
  remove: []
}>()

const dataSource = useDataSource()
const chartData = ref<ChartData | null>(null)

function toApplyInput(cfg: ChartConfig, extraFilters: FilterConfig[]): ChartConfigInput {
  return {
    entity: cfg.object,
    dimensions: cfg.dimensions,
    measures: cfg.measures,
    filters: [...cfg.filters, ...extraFilters],
    orderBy: cfg.orderBy
      ? { column: cfg.orderBy.column, direction: cfg.orderBy.direction.toLowerCase() as 'asc' | 'desc' }
      : null,
    topN: cfg.limit ?? null,
  }
}

async function loadData() {
  try {
    const result = await dataSource.fetchAggregated(toApplyInput(props.config, props.crossFilters || []))
    chartData.value = { columns: result.columns, data: result.data }
  } catch {
    chartData.value = null
  }
}

onMounted(loadData)
watch(() => props.crossFilters, loadData, { deep: true })
</script>

<template>
  <div class="chart-tile">
    <div class="tile-header">
      <span class="tile-title">{{ config.object }}</span>
      <ui5-button icon="decline" design="Transparent" @click="emit('remove')"></ui5-button>
    </div>
    <ChartRenderer
      :chart-type="config.chartType"
      :data="chartData"
      :dimensions="config.dimensions.map(d => d.column)"
      :measures="config.measures.map(m => `${m.aggregation}_${m.column}`)"
      @chart-click="(p) => emit('chartClick', p)"
    />
  </div>
</template>

<style scoped>
.chart-tile {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 8px;
  overflow: hidden;
}
.tile-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.25rem 0.5rem;
  background: var(--sapTile_Background);
  border-bottom: 1px solid var(--sapField_BorderColor);
  cursor: move;
}
.tile-title {
  font-size: 0.85rem;
  font-weight: 600;
}
</style>
