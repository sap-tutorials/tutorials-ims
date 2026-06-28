import { ref } from 'vue'
import type { ExploreNode } from '../types'

/**
 * Reactive ref tracking the currently-selected explore-graph node. Dispatches
 * the kg.explore.node_clicked event whenever the selection changes.
 *
 * Module-scoped singleton state — all consumers share the same selected-node
 * ref. Prevents disconnected selection state if multiple components ever
 * call useSelectedNode().
 */
const selectedNode = ref<ExploreNode | null>(null)

function selectNode(node: ExploreNode | null) {
  selectedNode.value = node
  if (typeof window === 'undefined' || !node) return
  window.dispatchEvent(new CustomEvent('kg.explore.node_clicked', {
    detail: { nodeId: node.id, nodeType: node.type },
  }))
}

export function useSelectedNode() {
  return { selectedNode, selectNode }
}

/** Test hook to reset selection state between tests. */
export function _resetSelectedNode() {
  selectedNode.value = null
}
