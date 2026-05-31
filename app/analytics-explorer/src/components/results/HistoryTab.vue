<script setup lang="ts">
import { onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import { useHistory, type HistoryRow } from '../../composables/useHistory'

const emit = defineEmits<{
  (e: 'load', row: HistoryRow): void
}>()

const { rows, isLoading, lastError, loadRows } = useHistory()

onMounted(() => {
  loadRows().catch(() => { /* error surfaced via lastError ref */ })
})

function shortSql(sql: string): string {
  if (sql.length <= 80) return sql
  return sql.slice(0, 77) + '…'
}

function fmtDate(iso: string): string {
  try {
    const d = new Date(iso)
    return d.toLocaleString()
  } catch {
    return iso
  }
}
</script>

<template>
  <div class="history-tab">
    <div v-if="lastError" class="error">⚠ {{ lastError }}</div>

    <div v-if="isLoading" class="empty">Loading…</div>
    <div v-else-if="rows.length === 0" class="empty">No history yet. Run a query to see it appear here.</div>
    <ul v-else class="rows">
      <li v-for="row in rows" :key="row.ID" class="row">
        <div class="row-main">
          <code class="sql-preview" :title="row.sql">{{ shortSql(row.sql) }}</code>
          <div class="row-meta">
            <span class="ts">{{ fmtDate(row.createdAt) }}</span>
            <span class="source-badge" :class="`source-${row.source}`">{{ row.source }}</span>
            <span class="rows-count">{{ row.rowCount ?? 0 }} rows · {{ row.durationMs ?? 0 }}ms</span>
          </div>
        </div>
        <ui5-button
          data-test="history-load"
          design="Transparent"
          icon="navigation-right-arrow"
          @click="emit('load', row)"
        >Load</ui5-button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.history-tab {
  display: flex; flex-direction: column;
  height: 100%; padding: 0.5rem; overflow-y: auto;
}
.error { color: var(--sapErrorColor); padding: 0.5rem; }
.empty { padding: 2rem; text-align: center; color: var(--sapNeutralTextColor); }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
  display: flex; align-items: center; gap: 0.75rem;
  padding: 0.5rem 0.75rem;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.row:hover { background: var(--sapList_Hover_Background); }
.row-main { flex: 1; min-width: 0; }
.sql-preview {
  display: block;
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-meta {
  display: flex; gap: 0.75rem; align-items: center;
  margin-top: 0.2rem; font-size: 0.7rem; color: var(--sapNeutralTextColor);
}
.source-badge {
  padding: 0.05rem 0.3rem; border-radius: 3px;
  background: var(--sapList_HeaderBackground);
  font-weight: 500;
}
.source-builder { color: var(--sapInformationTextColor, #0a6ed1); }
.source-editor  { color: var(--sapNeutralTextColor); }
.source-joule   { color: var(--sapPositiveTextColor, #2b7d2b); }
.source-replay  { color: var(--sapWarningTextColor, #b06000); }
</style>
