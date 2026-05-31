<script setup lang="ts">
import { computed, onMounted } from 'vue'
import '@ui5/webcomponents/dist/Button.js'
import { useQuerySpec } from '../../composables/useQuerySpec'
import { useEntityGraph } from '../../composables/useEntityGraph'
import FromChip from './chips/FromChip.vue'
import JoinChip from './chips/JoinChip.vue'
import FilterGroupChip from './chips/FilterGroupChip.vue'
import GroupByChip from './chips/GroupByChip.vue'
import SelectChip from './chips/SelectChip.vue'
import OrderByChip from './chips/OrderByChip.vue'
import LimitChip from './chips/LimitChip.vue'
import type {
  QuerySpec,
  TableRef,
  Join,
  FilterGroup,
  GroupKey,
  SelectItem,
  OrderClause,
  ColumnRef,
} from '../../types/query-spec'

const querySpec = useQuerySpec()
const entityGraph = useEntityGraph()

onMounted(async () => {
  try {
    await entityGraph.load()
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('[ClauseChipBar] entity metadata load failed:', e)
  }
})

const spec = computed<QuerySpec | null>(() => querySpec.spec.value)

// All aliases currently in scope (FROM + each JOIN's target alias)
const aliasesInSpec = computed<string[]>(() => {
  if (!spec.value) return []
  return [spec.value.from.alias, ...spec.value.joins.map(j => j.target.alias)]
})

// Auto-derived GROUP BY chips (matches deriveAutoGroupBy in spec-to-sql.mjs)
const allGroupByChips = computed<Array<GroupKey & { auto: boolean }>>(() => {
  if (!spec.value) return []
  const hasAgg = spec.value.select.some(s => s.kind === 'aggregation')
  const auto: Array<GroupKey & { auto: boolean }> = []
  if (hasAgg) {
    for (const s of spec.value.select) {
      if (s.kind === 'aggregation') continue
      if (s.kind === 'column') {
        auto.push({
          id: `g-auto-${s.id}`,
          ref: { ...s.ref },
          auto: true,
        })
      }
      // expression chips don't auto-derive a group ref (spec-to-sql groups by the
      // expression text which we can't render as a ColumnRef; skipping is fine).
    }
  }
  const explicit = (spec.value.groupBy || []).map(g => ({ ...g, auto: false }))
  return [...auto, ...explicit]
})

// availableEntities feeds FromChip + JoinChip
const availableEntities = computed(() =>
  entityGraph.entities.value.map((e: any) => ({ name: e.name, label: e.label }))
)

// Mutation helpers — every callback ends in a setSpec
function setFrom(next: TableRef) {
  if (!spec.value) return
  querySpec.setSpec({ ...spec.value, from: next })
}

function addJoin() {
  if (!spec.value || aliasesInSpec.value.length === 0) return
  // Heuristic: pick the first joinable suggestion if available; else
  // create a placeholder JOIN against the first available entity.
  const fromAlias = aliasesInSpec.value[0]
  const fromEntity = spec.value.from.entity
  const suggestions = entityGraph.joinableTo(fromEntity)
  let joined: Join
  if (suggestions.length > 0) {
    const s = suggestions[0]
    joined = {
      id: `j${spec.value.joins.length + 1}`,
      kind: 'inner',
      target: { entity: s.targetEntity, alias: aliasFromName(s.targetEntity) },
      on: {
        leftRef: { alias: fromAlias, column: s.onLocal[0] || 'ID' },
        rightRef: { alias: aliasFromName(s.targetEntity), column: s.onTarget[0] || 'ID' },
      },
    }
  } else {
    // Fallback — pick the second exposed entity if available; user edits via popover.
    const target = availableEntities.value.find(e => e.name !== fromEntity)
    if (!target) return
    joined = {
      id: `j${spec.value.joins.length + 1}`,
      kind: 'inner',
      target: { entity: target.name, alias: aliasFromName(target.name) },
      on: {
        leftRef: { alias: fromAlias, column: 'ID' },
        rightRef: { alias: aliasFromName(target.name), column: 'ID' },
      },
    }
  }
  querySpec.setSpec({ ...spec.value, joins: [...spec.value.joins, joined] })
}

function changeJoin(idx: number, next: Join) {
  if (!spec.value) return
  const joins = [...spec.value.joins]
  joins[idx] = next
  querySpec.setSpec({ ...spec.value, joins })
}

function removeJoin(idx: number) {
  if (!spec.value) return
  const joins = spec.value.joins.filter((_, i) => i !== idx)
  querySpec.setSpec({ ...spec.value, joins })
}

function addFilter() {
  if (!spec.value || aliasesInSpec.value.length === 0) return
  // Add a default leaf filter: `<first alias>.<first column> = ''`
  const alias = aliasesInSpec.value[0]
  const ent = entityGraph.entityMap.value.get(spec.value.from.entity)
  if (!ent) return
  const firstCol = Array.from(ent.columns.keys())[0]
  if (!firstCol) return
  const newLeaf = {
    id: `f${Date.now()}`,
    ref: { alias, column: firstCol } as ColumnRef,
    op: 'eq' as const,
    value: { kind: 'literal' as const, value: '' },
  }
  if (!spec.value.filterTree) {
    querySpec.setSpec({
      ...spec.value,
      filterTree: { id: 'fg0', kind: 'group', conjunction: 'and', children: [newLeaf] },
    })
  } else if (spec.value.filterTree.kind === 'group') {
    querySpec.setSpec({
      ...spec.value,
      filterTree: {
        ...spec.value.filterTree,
        children: [...spec.value.filterTree.children, newLeaf],
      },
    })
  } else {
    // top-level was a leaf — wrap it.
    querySpec.setSpec({
      ...spec.value,
      filterTree: {
        id: 'fg0', kind: 'group', conjunction: 'and',
        children: [spec.value.filterTree, newLeaf],
      },
    })
  }
}

function changeFilterTree(next: FilterGroup) {
  if (!spec.value) return
  querySpec.setSpec({ ...spec.value, filterTree: next })
}

function removeFilterTree() {
  if (!spec.value) return
  querySpec.setSpec({ ...spec.value, filterTree: null })
}

function addGroupBy() {
  if (!spec.value || aliasesInSpec.value.length === 0) return
  const alias = aliasesInSpec.value[0]
  const ent = entityGraph.entityMap.value.get(spec.value.from.entity)
  if (!ent) return
  const firstCol = Array.from(ent.columns.keys())[0]
  if (!firstCol) return
  const next: GroupKey = { id: `g${Date.now()}`, ref: { alias, column: firstCol } }
  querySpec.setSpec({ ...spec.value, groupBy: [...(spec.value.groupBy || []), next] })
}

function changeGroupByAt(idx: number, next: GroupKey) {
  if (!spec.value) return
  const groupBy = [...(spec.value.groupBy || [])]
  groupBy[idx] = next
  querySpec.setSpec({ ...spec.value, groupBy })
}

function removeGroupByAt(idx: number) {
  if (!spec.value) return
  const groupBy = (spec.value.groupBy || []).filter((_, i) => i !== idx)
  querySpec.setSpec({ ...spec.value, groupBy })
}

function addSelectColumn() {
  if (!spec.value || aliasesInSpec.value.length === 0) return
  const alias = aliasesInSpec.value[0]
  const ent = entityGraph.entityMap.value.get(spec.value.from.entity)
  if (!ent) return
  const firstCol = Array.from(ent.columns.keys())[0]
  if (!firstCol) return
  const next: SelectItem = {
    kind: 'column',
    id: `s${Date.now()}`,
    ref: { alias, column: firstCol },
  }
  querySpec.setSpec({ ...spec.value, select: [...spec.value.select, next] })
}

function changeSelectAt(idx: number, next: SelectItem) {
  if (!spec.value) return
  const select = [...spec.value.select]
  select[idx] = next
  querySpec.setSpec({ ...spec.value, select })
}

function removeSelectAt(idx: number) {
  if (!spec.value) return
  if (spec.value.select.length <= 1) return  // SELECT must have at least 1 chip
  const select = spec.value.select.filter((_, i) => i !== idx)
  querySpec.setSpec({ ...spec.value, select })
}

function addOrderBy() {
  if (!spec.value) return
  const firstSelect = spec.value.select[0]
  if (!firstSelect) return
  const next: OrderClause = {
    id: `o${Date.now()}`,
    by: { kind: 'selectId', id: firstSelect.id },
    direction: 'asc',
  }
  querySpec.setSpec({ ...spec.value, orderBy: [...spec.value.orderBy, next] })
}

function changeOrderByAt(idx: number, next: OrderClause) {
  if (!spec.value) return
  const orderBy = [...spec.value.orderBy]
  orderBy[idx] = next
  querySpec.setSpec({ ...spec.value, orderBy })
}

function removeOrderByAt(idx: number) {
  if (!spec.value) return
  const orderBy = spec.value.orderBy.filter((_, i) => i !== idx)
  querySpec.setSpec({ ...spec.value, orderBy })
}

function changeLimit(next: number | null) {
  if (!spec.value) return
  querySpec.setSpec({ ...spec.value, limit: next })
}

function aliasFromName(name: string): string {
  const first = (name[0] || 't').toLowerCase()
  if (!aliasesInSpec.value.includes(first)) return first
  // Avoid collision: append next available number.
  for (let n = 2; n < 100; n++) {
    const candidate = `${first}${n}`
    if (!aliasesInSpec.value.includes(candidate)) return candidate
  }
  return first
}

// Suggestions for the JoinChip popover — passed per-chip
function suggestionsForJoin(join: Join) {
  // Suggestions are joinable-to entries from the FROM entity that aren't
  // already aliased.
  const fromEntity = spec.value?.from.entity || ''
  const suggested = entityGraph.joinableTo(fromEntity)
  return suggested.filter(s => s.targetEntity !== fromEntity)
}
</script>

<template>
  <div class="clause-chip-bar" role="toolbar" aria-label="Query builder">
    <div v-if="!spec" class="empty-hint">
      Click an entity in the sidebar to start building a query, or switch to the SQL Editor tab.
    </div>
    <div v-else class="chips-row">
      <FromChip
        :from="spec.from"
        :available-entities="availableEntities"
        @change="setFrom"
      />

      <FromChip
        v-for="(join, idx) in spec.joins"
        :key="join.id"
        v-show="false"
      />
      <JoinChip
        v-for="(join, idx) in spec.joins"
        :key="`jc-${join.id}`"
        :join="join"
        :available-entities="availableEntities"
        :suggestions="suggestionsForJoin(join)"
        :existing-aliases="aliasesInSpec.slice(0, idx + 1)"
        @change="(next) => changeJoin(idx, next)"
        @remove="removeJoin(idx)"
      />
      <button class="add-chip" @click="addJoin" title="Add JOIN">⊕ JOIN</button>

      <FilterGroupChip
        v-if="spec.filterTree && spec.filterTree.kind === 'group'"
        :group="spec.filterTree"
        :alias-map="entityGraph.entityMap.value as any"
        :sample-distinct-cached="entityGraph.sampleDistinctCached"
        :depth="1"
        @change="changeFilterTree"
        @remove="removeFilterTree"
      />
      <button class="add-chip" @click="addFilter" title="Add WHERE filter">⊕ WHERE</button>

      <GroupByChip
        v-for="(g, idx) in allGroupByChips"
        :key="g.id"
        :chip-key="g"
        :alias-map="entityGraph.entityMap.value as any"
        @change="(next) => changeGroupByAt(idx - allGroupByChips.filter(x => x.auto).length, next)"
        @remove="removeGroupByAt(idx - allGroupByChips.filter(x => x.auto).length)"
      />
      <button class="add-chip" @click="addGroupBy" title="Add GROUP BY">⊕ GROUP BY</button>

      <SelectChip
        v-for="(s, idx) in spec.select"
        :key="s.id"
        :item="s"
        :alias-map="entityGraph.entityMap.value as any"
        @change="(next) => changeSelectAt(idx, next)"
        @remove="removeSelectAt(idx)"
      />
      <button class="add-chip" @click="addSelectColumn" title="Add SELECT column">⊕ SELECT</button>

      <OrderByChip
        v-for="(o, idx) in spec.orderBy"
        :key="o.id"
        :order="o"
        :select-items="spec.select"
        :alias-map="entityGraph.entityMap.value as any"
        @change="(next) => changeOrderByAt(idx, next)"
        @remove="removeOrderByAt(idx)"
      />
      <button class="add-chip" @click="addOrderBy" title="Add ORDER BY">⊕ ORDER BY</button>

      <LimitChip
        :limit="spec.limit"
        @change="changeLimit"
      />
    </div>
  </div>
</template>

<style scoped>
.clause-chip-bar {
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--sapList_BorderColor);
  background: var(--sapList_HeaderBackground);
  min-height: 3rem;
  display: flex;
  align-items: center;
}

.empty-hint {
  color: var(--sapContent_LabelColor);
  font-size: 0.875rem;
}

.chips-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
}

.add-chip {
  display: inline-flex;
  align-items: center;
  padding: 0.2rem 0.5rem;
  border: 1px dashed var(--sapField_BorderColor);
  border-radius: 4px;
  background: transparent;
  color: var(--sapContent_LabelColor);
  cursor: pointer;
  font-family: inherit;
  font-size: 0.75rem;
}
.add-chip:hover {
  background: var(--sapList_Hover_Background);
  color: var(--sapContent_Selected_TextColor);
  border-style: solid;
}
</style>
