<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount, computed } from 'vue'
import { useQuerySpec } from '../../composables/useQuerySpec'
import { useEntityGraph } from '../../composables/useEntityGraph'
import { useTheme } from '../../composables/useTheme'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'
import { validateQuerySpec } from '@srv-lib/query-spec-validator.mjs'

const { spec } = useQuerySpec()
const entityGraph = useEntityGraph()
const { isDark } = useTheme()

const editorEl = ref<HTMLElement | null>(null)
let editor: any = null
let monacoNs: any = null
let resizeObserver: ResizeObserver | null = null
let destroyed = false

const generated = computed<string>(() => {
  if (!spec.value) return '-- (empty — add chips to build a query)'
  if (entityGraph.entityMap.value.size === 0) return '-- (loading entity metadata...)'
  const v = validateQuerySpec(spec.value, entityGraph.entityMap.value as any)
  if (v.errors.length) {
    return `-- (${v.errors.length} validation error${v.errors.length === 1 ? '' : 's'} — see chip highlights)`
  }
  try {
    return specToSql(spec.value, entityGraph.sqlNames.value)
  } catch (e: any) {
    return `-- spec-to-sql error: ${e.message}`
  }
})

onMounted(async () => {
  const monaco = await import('monaco-editor')
  if (destroyed || !editorEl.value) return
  monacoNs = monaco
  editor = monaco.editor.create(editorEl.value, {
    value: generated.value,
    language: 'sql',
    theme: isDark.value ? 'vs-dark' : 'vs',
    readOnly: true,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    fontSize: 13,
    lineNumbers: 'on',
    automaticLayout: false,
  })
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(editorEl.value)
})

onBeforeUnmount(() => {
  destroyed = true
  resizeObserver?.disconnect()
  editor?.dispose()
})

watch(generated, (s) => {
  if (editor && !destroyed) editor.setValue(s)
})

watch(isDark, (dark) => {
  if (monacoNs && !destroyed) monacoNs.editor.setTheme(dark ? 'vs-dark' : 'vs')
})
</script>

<template>
  <div class="sql-preview">
    <div class="sql-preview-header">
      <span class="label">SQL Preview</span>
      <span v-if="spec" class="hint">read-only — edit chips above to change</span>
    </div>
    <div ref="editorEl" class="sql-preview-editor" />
  </div>
</template>

<style scoped>
.sql-preview { border-bottom: 1px solid var(--sapList_BorderColor); }
.sql-preview-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.25rem 1rem; background: var(--sapList_HeaderBackground);
  font-size: 0.75rem;
}
.label { font-weight: bold; color: var(--sapContent_LabelColor); }
.hint { color: var(--sapContent_LabelColor); font-style: italic; }
.sql-preview-editor { height: 8rem; }
</style>
