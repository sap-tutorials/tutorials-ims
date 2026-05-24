<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { runSelectQuery, type SqlResult } from '../api/sql'
import '@ui5/webcomponents/dist/Button.js'

const emit = defineEmits<{ (e: 'results', r: { columns: string[]; rows: any[] }): void }>()

const editorEl = ref<HTMLDivElement>()
const status = ref<string>('Ready.')
const lastResult = ref<SqlResult | null>(null)
let editor: any = null
let destroyed = false

onMounted(async () => {
  const monaco = await import('monaco-editor')
  await import('monaco-sql-languages/esm/all.contributions')
  if (destroyed) return
  editor = monaco.editor.create(editorEl.value!, {
    value: 'SELECT id, status FROM TaskRecords LIMIT 100',
    language: 'sql', theme: 'vs', fontSize: 13, minimap: { enabled: false },
  })
})

onBeforeUnmount(() => {
  destroyed = true
  editor?.dispose()
})

async function run() {
  if (!editor) return
  status.value = 'Running…'
  try {
    const res = await runSelectQuery(editor.getValue())
    lastResult.value = res
    const rowsObj = res.rows.map(r => Object.fromEntries(res.columns.map((c, i) => [c, r[i]])))
    emit('results', { columns: res.columns, rows: rowsObj })
    status.value = `${res.metadata.rowCount} rows in ${res.metadata.durationMs}ms${res.metadata.truncated ? ' (truncated)' : ''}`
  } catch (e: any) { status.value = e.message }
}
</script>

<template>
  <div class="qe">
    <div class="toolbar">
      <ui5-button design="Emphasized" @click="run">Run</ui5-button>
      <span class="status">{{ status }}</span>
    </div>
    <div class="editor" ref="editorEl"></div>
    <div v-if="lastResult" class="results">
      <table>
        <thead><tr><th v-for="c in lastResult.columns" :key="c">{{ c }}</th></tr></thead>
        <tbody>
          <tr v-for="(row, i) in lastResult.rows.slice(0, 200)" :key="i">
            <td v-for="(cell, j) in row" :key="j">{{ cell }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.qe { display: flex; flex-direction: column; height: 100%; }
.toolbar { display: flex; align-items: center; gap: 0.5rem; padding: 0.5rem; }
.editor { flex: 1; min-height: 200px; border: 1px solid var(--sapField_BorderColor); }
.results { max-height: 40%; overflow: auto; padding: 0.5rem; }
.results table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.results th, .results td { border-bottom: 1px solid var(--sapField_BorderColor); padding: 0.25rem 0.5rem; text-align: left; }
.status { color: var(--sapNeutralTextColor); font-size: 0.85rem; }
</style>
