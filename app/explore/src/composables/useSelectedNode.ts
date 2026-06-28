import { ref } from 'vue'
import type { ExploreNode } from '../types'

/**
 * Reactive ref tracking the currently-selected explore-graph node. Dispatches
 * the kg.explore.node_clicked event whenever the selection changes.
 */
export function useSelectedNode() {
  const selectedNode = ref<ExploreNode | null>(null)

  function selectNode(node: ExploreNode | null) {
    selectedNode.value = node
    if (typeof window === 'undefined' || !node) return
    window.dispatchEvent(new CustomEvent('kg.explore.node_clicked', {
      detail: { nodeId: node.id, nodeType: node.type },
    }))
  }

  return { selectedNode, selectNode }
}
