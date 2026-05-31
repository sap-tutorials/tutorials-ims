import { ref, computed, toRaw } from 'vue'
import type { QuerySpec } from '../types/query-spec'

// Single mutation surface for analytics builder state. ALL paths that
// change the spec (chip add/remove/edit, drilldown, replay, Joule
// "View in builder", history-tab click) go through setSpec or one of
// its convenience methods.
//
// The composable is a SINGLETON shared across the app — chip components
// import it independently and see the same reactive refs. We keep the
// state at module scope to make this explicit.

const _spec = ref<QuerySpec | null>(null)
const _mode = ref<'builder' | 'editor'>('builder')

// Drilldown stack: when a user right-clicks a result row → "Drill into
// this row", the current spec is pushed onto this stack and a derived
// drilldown spec replaces it. Pop returns to the original.
// Depth-1 cap: drilling from a drilldown REPLACES rather than nesting.
const _drillStack = ref<QuerySpec[]>([])

// Deep-clone helper. structuredClone() chokes on Vue's reactive Proxy
// wrappers (DataCloneError) and toRaw alone is shallow — we want a fresh
// object tree so callers can mutate without leaking into stored state.
// QuerySpec is JSON-safe (no Date/Map/Set/Buffer), so JSON round-trip is fine.
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(toRaw(v)))
}

export function useQuerySpec() {
  function setSpec(next: QuerySpec | null) {
    _spec.value = next ? deepClone(next) : null
  }

  function clearSpec() {
    _spec.value = null
    _drillStack.value = []
    _mode.value = 'builder'
  }

  function pushDrilldown(drillSpec: QuerySpec) {
    if (_drillStack.value.length === 0 && _spec.value) {
      _drillStack.value = [deepClone(_spec.value)]
    }
    // Always replace the visible spec — depth-1 stack means a second
    // pushDrilldown overwrites the drill, never the original.
    _spec.value = deepClone(drillSpec)
  }

  function popDrilldown() {
    const prev = _drillStack.value.pop()
    if (prev) {
      _spec.value = prev
      _drillStack.value = []
    }
  }

  const isDrilldown = computed(() => _drillStack.value.length > 0)

  function takeOverFromBuilder() { _mode.value = 'editor' }
  function returnToBuilder()     { _mode.value = 'builder' }

  return {
    spec: _spec,
    mode: _mode,
    isDrilldown,
    setSpec,
    clearSpec,
    pushDrilldown,
    popDrilldown,
    takeOverFromBuilder,
    returnToBuilder,
  }
}

