<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import QueryEditor from './QueryEditor.vue'
import ClauseChipBar from './builder/ClauseChipBar.vue'
import SqlPreview from './builder/SqlPreview.vue'
import AutoGroupByBanner from './builder/AutoGroupByBanner.vue'
import BuilderHeader from './builder/BuilderHeader.vue'
import BottomTabs from './results/BottomTabs.vue'
import SplitHandle from './common/SplitHandle.vue'
import { useHistory } from '../composables/useHistory'
import type { HistoryRow } from '../composables/useHistory'
import type { SavedRow } from '../composables/useSavedQueries'
import { useQuerySpec } from '../composables/useQuerySpec'
import { useEntityGraph } from '../composables/useEntityGraph'
import { useJouleContext } from '../composables/useJouleContext'
import { runSelectQuery, type SqlResult } from '../api/sql'
import { specToSql } from '@srv-lib/spec-to-sql.mjs'
import { validateQuerySpec } from '@srv-lib/query-spec-validator.mjs'
import { canDrillDown, deriveDrilldownSpec } from '../lib/derive-drilldown'
import { getCachedEntityMetadata, type ExposedEntity } from '../api/entities'

const querySpec = useQuerySpec()
const { spec, mode, isDrilldown } = querySpec
const entityGraph = useEntityGraph()
const jouleCtx = useJouleContext()

const lastResults = ref<SqlResult | null>(null)
const entities = ref<ExposedEntity[]>([])
const entitiesError = ref<string | null>(null)
const editorRef = ref<InstanceType<typeof QueryEditor> | null>(null)

// Vertical split between the editor + sidebar (top) and the results
// tabs (bottom). Persists per-user via localStorage.
const splitRatio = ref(0.5)

// Push the result sample into the Joule page-context store. Capped at 50 rows
// here too; redactPii caps and strips PII columns before send.
function feedJouleContext(r: SqlResult | null) {
  if (!r || !spec.value) { jouleCtx.setLastResult(null); return }
  jouleCtx.setLastResult({
    entityName: spec.value.from.entity,
    columns: r.columns,
    rows: r.rows.slice(0, 50),
    rowCount: r.metadata?.rowCount ?? r.rows.length,
    truncated: r.metadata?.truncated ?? false,
  })
}

// Generated SQL: from chips when builder mode, empty when editor mode
// (the editor's value is the source of truth there).
const generatedSql = computed<string>(() => {
  if (mode.value === 'editor') return ''
  if (!spec.value) return ''
  try { return specToSql(spec.value, entityGraph.sqlNames.value) } catch { return '' }
})

const canRunFromChips = computed(() => {
  if (mode.value === 'editor') return true
  if (!spec.value) return false
  const v = validateQuerySpec(spec.value, entityGraph.entityMap.value as any)
  return v.errors.length === 0
})

onMounted(async () => {
  try { entities.value = await getCachedEntityMetadata() }
  catch (e: any) { entitiesError.value = e.message }
})

async function runFromChips() {
  if (!spec.value) return
  try {
    const sql = specToSql(spec.value, entityGraph.sqlNames.value)
    const r = await runSelectQuery(sql, 'builder', JSON.stringify(spec.value))
    lastResults.value = r
    feedJouleContext(r)
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.warn('[SqlTab] runFromChips failed:', e.message)
  }
}

function onResults(data: { columns: string[]; rows: any[] }) {
  // Editor-side run path: QueryEditor projects rows to objects today.
  // We need the array-of-arrays shape for ResultsTab; convert back if needed.
  const arrayRows = Array.isArray(data.rows[0])
    ? (data.rows as Array<Array<string | number | null>>)
    : (data.rows as Array<Record<string, any>>).map(r => data.columns.map(c => r[c]))
  const r: SqlResult = {
    columns: data.columns,
    rows: arrayRows,
    metadata: { rowCount: arrayRows.length, truncated: false, durationMs: 0 },
  }
  lastResults.value = r
  feedJouleContext(r)
}

function insertEntity(e: ExposedEntity) {
  editorRef.value?.insertText(e.sqlName || e.name)
}

function startBuilderFromEntity(e: ExposedEntity) {
  const firstCol = e.columns?.[0]?.name
  if (!firstCol) return
  const alias = (e.name[0] || 't').toLowerCase()
  querySpec.setSpec({
    version: 1,
    from: { entity: e.name, alias },
    joins: [],
    filterTree: null,
    groupBy: [],
    select: [{ kind: 'column', id: 's1', ref: { alias, column: firstCol } }],
    orderBy: [],
    limit: null,
  })
}

function onTakeOverFromBuilder() {
  if (spec.value) {
    try {
      const sql = specToSql(spec.value, entityGraph.sqlNames.value)
      editorRef.value?.setValue?.(sql)
    } catch { /* no-op */ }
  }
  querySpec.takeOverFromBuilder()
}

function onReturnToBuilder() {
  if (!window.confirm('Any edits to the SQL editor will be discarded. Return to chip-builder mode?')) return
  querySpec.returnToBuilder()
}

// Drilldown wiring
function canDrill(row: Record<string, unknown>): boolean {
  return canDrillDown(spec.value, row)
}

function onDrilldown(row: Record<string, unknown>) {
  const drill = deriveDrilldownSpec(spec.value, row)
  if (!drill) return
  querySpec.pushDrilldown(drill)
  // Re-run automatically so the drill view shows immediately.
  runFromChips()
}

function onBackToGrouped() {
  querySpec.popDrilldown()
  runFromChips()
}

// Phase 4: load-row from History or Saved tab. If the row's spec is non-null
// v1 JSON, restore chip state via setSpec; otherwise paste SQL into Monaco
// and flip to editor mode (Phase 1-3 history rows have spec=null).
const { parseSpec: parseHistorySpec } = useHistory()

function onLoadRow(payload: { source: 'history' | 'saved'; row: HistoryRow | SavedRow }) {
  const row = payload.row
  const parsed = parseHistorySpec(row.spec)
  if (parsed) {
    querySpec.setSpec(parsed)
    if (mode.value === 'editor') querySpec.returnToBuilder()
  } else {
    editorRef.value?.setValue?.(row.sql)
    querySpec.takeOverFromBuilder()
  }
}
</script>

<template>
  <div class="sql-tab" :class="{ 'editor-mode': mode === 'editor' }">
    <AutoGroupByBanner />
    <BuilderHeader />
    <ClauseChipBar />
    <SqlPreview />

    <div v-if="spec" class="builder-run-row">
      <ui5-button
        v-if="mode === 'builder'"
        design="Emphasized"
        icon="play"
        :disabled="!canRunFromChips"
        @click="runFromChips"
      >Run from chips</ui5-button>
      <span v-if="mode === 'builder' && !canRunFromChips" class="run-hint">
        Validation errors — see chip highlights
      </span>

      <ui5-button
        v-if="mode === 'builder'"
        design="Transparent"
        icon="edit"
        @click="onTakeOverFromBuilder"
        title="Switch to SQL Editor mode (chip bar will be greyed out)"
      >Take over from builder</ui5-button>

      <ui5-button
        v-if="mode === 'editor'"
        design="Attention"
        icon="undo"
        @click="onReturnToBuilder"
        title="Return to chip-builder mode (any SQL edits will be discarded)"
      >Return to builder</ui5-button>
      <span v-if="mode === 'editor'" class="editor-mode-hint">
        SQL Editor mode — chip bar disabled. Edit SQL below.
      </span>

      <ui5-button
        v-if="isDrilldown"
        design="Attention"
        icon="undo"
        @click="onBackToGrouped"
      >↩ Back to grouped query</ui5-button>
    </div>

    <div class="split-pane">
      <div
        class="main-row"
        :style="{ flex: `${splitRatio} 1 0`, minHeight: '4rem' }"
      >
        <aside class="entity-list" aria-label="Exposed entities">
          <div class="entity-list-header">
            <strong>Exposed entities</strong>
            <span class="hint">Click to insert</span>
          </div>
          <div v-if="entitiesError" class="entity-error">{{ entitiesError }}</div>
          <ul v-else class="entity-items">
            <li v-for="e in entities" :key="e.name" class="entity-li">
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
              <button
                type="button"
                class="entity-build"
                @click="startBuilderFromEntity(e)"
                title="Build a chip query from this entity"
              >🧱</button>
            </li>
          </ul>
        </aside>
        <div class="editor-section">
          <QueryEditor ref="editorRef" @results="onResults" />
        </div>
      </div>

      <SplitHandle
        :initial="0.5"
        storage-key="analytics.sqltab.split"
        @update:ratio="splitRatio = $event"
      />

      <div
        class="results-section"
        :style="{ flex: `${1 - splitRatio} 1 0`, minHeight: '4rem' }"
      >
        <BottomTabs
          :results="lastResults"
          :generated-sql="generatedSql"
          :can-drill-down="canDrill"
          @drilldown="onDrilldown"
          @load-row="onLoadRow"
        />
      </div>
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
  flex-wrap: wrap;
}
.run-hint {
  font-size: 0.75rem;
  color: var(--sapErrorColor);
}
.editor-mode-hint {
  font-size: 0.75rem;
  color: var(--sapInformationColor);
  font-style: italic;
}
.sql-tab.editor-mode :deep(.clause-chip-bar) {
  opacity: 0.45;
  pointer-events: none;
}
.sql-tab.editor-mode :deep(.sql-preview) {
  opacity: 0.55;
}
.split-pane {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.main-row {
  display: flex;
  min-height: 0;
  overflow: hidden;
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
.entity-li {
  display: flex;
  gap: 0.25rem;
  align-items: stretch;
  margin-bottom: 0.15rem;
}
.entity-build {
  border: 1px solid transparent;
  background: transparent;
  cursor: pointer;
  padding: 0 0.4rem;
  border-radius: 4px;
  font-size: 0.9rem;
}
.entity-build:hover {
  background: var(--sapList_Hover_Background);
  border-color: var(--sapField_BorderColor);
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
.results-section {
  min-height: 0;
  border-top: 1px solid var(--sapField_BorderColor);
  background: var(--sapBaseColor, white);
  overflow: hidden;
}
</style>
