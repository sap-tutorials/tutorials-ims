<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount, watch } from 'vue'
import { runSelectQuery, type SqlResult } from '../api/sql'
import { useTheme } from '../composables/useTheme'
import '@ui5/webcomponents/dist/Button.js'

const emit = defineEmits<{ (e: 'results', r: { columns: string[]; rows: any[] }): void }>()

const editorEl = ref<HTMLDivElement>()
const status = ref<string>('Ready.')
const lastResult = ref<SqlResult | null>(null)
let editor: any = null
let monacoNs: any = null
let destroyed = false
let resizeObserver: ResizeObserver | null = null
const { isDark } = useTheme()

onMounted(async () => {
  const monaco = await import('monaco-editor')
  await import('monaco-sql-languages/esm/all.contributions')
  if (destroyed) return
  monacoNs = monaco
  editor = monaco.editor.create(editorEl.value!, {
    value: 'SELECT id, status FROM TaskRecords LIMIT 100',
    language: 'sql', theme: isDark.value ? 'vs-dark' : 'vs', fontSize: 13, minimap: { enabled: false },
    automaticLayout: false,
  })
  // The SQL tab mounts inside a v-show=false container on first paint, so the
  // editor host is 0x0 at create() time. Relayout whenever the host actually
  // gains size (tab becomes visible, window resize, split-pane drag).
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(editorEl.value!)
})

// Monaco's theme is process-global (setTheme applies to every editor on the
// page), but we still re-set it on every shellbar toggle so a user opening
// the SQL tab after a theme flip sees the correct palette.
watch(isDark, (dark) => {
  monacoNs?.editor.setTheme(dark ? 'vs-dark' : 'vs')
})

onBeforeUnmount(() => {
  destroyed = true
  resizeObserver?.disconnect()
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

// Imperative insert at the current cursor position. Used by the entity sidebar
// in SqlTab so clicking an entity drops its SQL name into the editor.
function insertText(text: string) {
  if (!editor) return
  const selection = editor.getSelection()
  const range = selection
    ? selection
    : { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  editor.executeEdits('entity-insert', [{ range, text, forceMoveMarkers: true }])
  editor.focus()
}

// Imperative full-buffer replace. Used by SqlTab's "Take over from builder"
// flow so the SQL Editor starts populated with the chip-built SQL.
function setValue(text: string) {
  if (!editor) return
  editor.setValue(text)
}

defineExpose({ insertText, setValue })
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
