<script setup lang="ts">
import { onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import { useSavedQueries, type SavedRow } from '../../composables/useSavedQueries'

const emit = defineEmits<{
  (e: 'load', row: SavedRow): void
}>()

const sq = useSavedQueries()
const { rows, isLoading, lastError, loadRows, setVisibility, duplicate, remove } = sq

onMounted(() => {
  loadRows().catch(() => { /* surfaced via lastError */ })
})

async function toggleVisibility(row: SavedRow) {
  const next = row.visibility === 'private' ? 'shared-admins' : 'private'
  try {
    await setVisibility(row.ID, next)
    await loadRows()
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SavedTab] setVisibility failed:', e.message)
  }
}

async function onDuplicate(row: SavedRow) {
  try {
    await duplicate(row.ID)
    await loadRows()
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SavedTab] duplicate failed:', e.message)
  }
}

async function onDelete(row: SavedRow) {
  if (!window.confirm(`Delete saved query "${row.name}"? This cannot be undone.`)) return
  try {
    await remove(row.ID)
    await loadRows()
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SavedTab] delete failed:', e.message)
  }
}

function shortSql(sql: string): string {
  if (sql.length <= 80) return sql
  return sql.slice(0, 77) + '…'
}
</script>

<template>
  <div class="saved-tab">
    <div v-if="lastError" class="error">⚠ {{ lastError }}</div>

    <div v-if="isLoading" class="empty">Loading…</div>
    <div v-else-if="rows.length === 0" class="empty">
      No saved queries yet. Click "Save" in the chip-bar header to save the current query.
    </div>
    <ul v-else class="rows">
      <li v-for="row in rows" :key="row.ID" class="row">
        <div class="row-main">
          <div class="row-title">
            <strong class="name">{{ row.name }}</strong>
            <span class="vis-badge" :class="`vis-${row.visibility}`">
              {{ row.visibility === 'shared-admins' ? '🔓 shared-admins' : '🔒 private' }}
            </span>
          </div>
          <div v-if="row.description" class="desc">{{ row.description }}</div>
          <code class="sql-preview" :title="row.sql">{{ shortSql(row.sql) }}</code>
        </div>
        <div class="row-actions">
          <ui5-button
            data-test="saved-load"
            design="Emphasized"
            icon="navigation-right-arrow"
            @click="emit('load', row)"
          >Load</ui5-button>
          <ui5-button
            data-test="saved-toggle-visibility"
            design="Transparent"
            :icon="row.visibility === 'private' ? 'unlocked' : 'private'"
            :title="row.visibility === 'private' ? 'Share with all admins' : 'Make private'"
            @click="toggleVisibility(row)"
          />
          <ui5-button
            data-test="saved-duplicate"
            design="Transparent"
            icon="copy"
            title="Duplicate"
            @click="onDuplicate(row)"
          />
          <ui5-button
            data-test="saved-delete"
            design="Negative"
            icon="delete"
            title="Delete"
            @click="onDelete(row)"
          />
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.saved-tab {
  display: flex; flex-direction: column;
  height: 100%; padding: 0.5rem; overflow-y: auto;
}
.error { color: var(--sapErrorColor); padding: 0.5rem; }
.empty { padding: 2rem; text-align: center; color: var(--sapNeutralTextColor); }
.rows { list-style: none; margin: 0; padding: 0; }
.row {
  display: flex; align-items: flex-start; gap: 0.75rem;
  padding: 0.6rem 0.75rem;
  border-bottom: 1px solid var(--sapField_BorderColor);
}
.row:hover { background: var(--sapList_Hover_Background); }
.row-main { flex: 1; min-width: 0; }
.row-title { display: flex; align-items: center; gap: 0.5rem; }
.name { font-size: 0.95rem; }
.vis-badge {
  font-size: 0.7rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
}
.vis-private      { background: var(--sapList_HeaderBackground); color: var(--sapNeutralTextColor); }
.vis-shared-admins { background: var(--sapPositiveBackground, #ebf5e0); color: var(--sapPositiveTextColor, #2b7d2b); }
.desc { font-size: 0.78rem; color: var(--sapNeutralTextColor); margin-top: 0.2rem; }
.sql-preview {
  display: block;
  font-family: var(--sapContent_MonospaceFontFamily, monospace);
  font-size: 0.75rem;
  margin-top: 0.3rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.row-actions { display: flex; gap: 0.25rem; align-items: center; flex-shrink: 0; }
</style>
