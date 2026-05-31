<script setup lang="ts">
import { computed, defineExpose } from 'vue'
import { RecycleScroller } from 'vue-virtual-scroller'

interface RowContextMenuPayload {
  row: Record<string, unknown>
  x: number
  y: number
  rowIndex: number
}

const props = defineProps<{
  columns: string[]
  rows: Array<Array<string | number | null>>
}>()

const emit = defineEmits<{
  (e: 'row-context-menu', payload: RowContextMenuPayload): void
}>()

// vue-virtual-scroller wants stable keys; use the array index as a key
// (rows are immutable for the lifetime of a query result).
const items = computed(() =>
  props.rows.map((cells, i) => ({ id: i, cells }))
)

const gridStyle = computed(() => ({
  gridTemplateColumns: `repeat(${props.columns.length}, minmax(8rem, 1fr))`,
}))

function onRowContextMenu(
  cells: Array<string | number | null>,
  event: MouseEvent | { clientX: number; clientY: number; preventDefault: () => void },
  rowIndex = 0,
) {
  event.preventDefault()
  // Convert array-of-arrays to column-keyed object so the drilldown
  // derivation can read row[col] / row[alias] directly.
  const row: Record<string, unknown> = {}
  props.columns.forEach((c, i) => { row[c] = cells[i] })
  emit('row-context-menu', {
    row,
    x: (event as MouseEvent).clientX,
    y: (event as MouseEvent).clientY,
    rowIndex,
  })
}

function fmt(cell: string | number | null): string {
  if (cell === null || cell === undefined) return '∅'
  return String(cell)
}

defineExpose({ onRowContextMenu, fmt })
</script>

<template>
  <div class="results-table" v-if="rows.length > 0">
    <div class="header-row" :style="gridStyle">
      <div v-for="c in columns" :key="c" class="header-cell">{{ c }}</div>
    </div>
    <RecycleScroller
      class="scroller"
      :items="items"
      :item-size="32"
      key-field="id"
      v-slot="{ item, index }"
    >
      <div
        class="data-row"
        :style="gridStyle"
        @contextmenu.prevent="onRowContextMenu(item.cells, $event, index)"
      >
        <div
          v-for="(cell, j) in item.cells"
          :key="j"
          class="data-cell"
          :class="{ 'is-null': cell === null }"
        >{{ fmt(cell) }}</div>
      </div>
    </RecycleScroller>
  </div>
  <div v-else class="empty-state">No rows.</div>
</template>

<style scoped>
.results-table {
  display: flex;
  flex-direction: column;
  height: 100%;
  border: 1px solid var(--sapField_BorderColor);
  border-radius: 4px;
  overflow: hidden;
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.8rem;
}
.header-row, .data-row {
  display: grid;
}
.header-row {
  background: var(--sapList_HeaderBackground);
  font-weight: bold;
  border-bottom: 1px solid var(--sapField_BorderColor);
  padding: 0.4rem 0;
}
.header-cell, .data-cell {
  padding: 0.4rem 0.6rem;
  border-right: 1px solid var(--sapField_BorderColor);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.header-cell:last-child, .data-cell:last-child { border-right: none; }
.scroller {
  flex: 1;
  min-height: 0;
}
.data-row {
  height: 32px;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.data-row:hover { background: var(--sapList_Hover_Background); }
.data-cell.is-null {
  color: var(--sapNeutralTextColor);
  font-style: italic;
}
.empty-state {
  padding: 2rem;
  text-align: center;
  color: var(--sapNeutralTextColor);
}
</style>
