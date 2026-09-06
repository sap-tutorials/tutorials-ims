// app/channel-atlas/src/composables/useOwnerTypeFilter.ts
import { ref } from 'vue'
import type { OwnerType } from '../types.js'

// All 9 values from ChannelOwnerType enum in db/channels.cds.
export const ALL_OWNER_TYPES: OwnerType[] = [
  'SAP_Official',
  'SAP_Developer_Advocate',
  'SAP_Executive',
  'Community_Member',
  'Community_Organization',
  'User_Group',
  'Third_party_Training',
  'Third_party_Media',
  'Third_party_Platform',
]

// Module-scoped singleton — all consumers share the same filter state.
// Mirrors the useFilters() pattern in app/explore/src/composables/useFilters.ts.
// Exported so tests can inspect/manipulate singleton state directly.
export const enabledTypes = ref<Set<OwnerType>>(new Set(ALL_OWNER_TYPES))

function toggleType(t: OwnerType) {
  const next = new Set(enabledTypes.value)
  if (next.has(t)) next.delete(t)
  else next.add(t)
  enabledTypes.value = next
}

export function useOwnerTypeFilter() {
  return { enabledTypes, toggleType, ALL_OWNER_TYPES }
}

/** Test hook — reset filter state between tests. */
export function _resetOwnerTypeFilter() {
  enabledTypes.value = new Set(ALL_OWNER_TYPES)
}
