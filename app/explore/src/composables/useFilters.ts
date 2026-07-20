import { ref } from 'vue'
import type { NodeType, PredicateType } from '../types'

// MUST list every NodeType variant in types.ts. Filters initialise to
// `new Set(ALL_NODE_TYPES)`, so any type omitted here is filtered OUT of the
// graph on first render AND has no checkbox in FilterDropdown — the user can
// never enable it. This drifted to 7 of 15 once and silently hid
// discovery-mission/video nodes present in live data (#1130 follow-up).
export const ALL_NODE_TYPES: NodeType[] = [
  'tutorial', 'concept', 'mission', 'product', 'group', 'category', 'tag',
  'learning-journey', 'blog-post', 'discovery-mission', 'video',
  'api-doc', 'sample', 'help-doc', 'community-event',
]
export const ALL_PREDICATES: PredicateType[] = [
  'teaches', 'requires', 'relatedTo', 'extends',
  'partOf', 'taggedWith', 'aboutProduct', 'inCategory', 'coCompletedWith',
]

// Module-scoped singleton state — all consumers share the same filter state.
// This matches the Pinia/useState pattern and prevents disconnected filter
// behavior if multiple components ever call useFilters().
const enabledNodeTypes = ref<Set<NodeType>>(new Set(ALL_NODE_TYPES))
const enabledPredicates = ref<Set<PredicateType>>(new Set(ALL_PREDICATES))

function dispatchTelemetry(detail: Record<string, unknown>) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('kg.explore.filter', { detail }))
}

function toggleNodeType(t: NodeType) {
  const next = new Set(enabledNodeTypes.value)
  if (next.has(t)) next.delete(t)
  else next.add(t)
  enabledNodeTypes.value = next
  dispatchTelemetry({ filter: t, kind: 'nodeType', enabled: next.has(t) })
}

function togglePredicate(p: PredicateType) {
  const next = new Set(enabledPredicates.value)
  if (next.has(p)) next.delete(p)
  else next.add(p)
  enabledPredicates.value = next
  dispatchTelemetry({ filter: p, kind: 'predicate', enabled: next.has(p) })
}

export function useFilters() {
  return {
    enabledNodeTypes,
    enabledPredicates,
    toggleNodeType,
    togglePredicate,
    ALL_NODE_TYPES,
    ALL_PREDICATES,
  }
}

/** Test hook to reset filter state between tests. */
export function _resetFilters() {
  enabledNodeTypes.value = new Set(ALL_NODE_TYPES)
  enabledPredicates.value = new Set(ALL_PREDICATES)
}
