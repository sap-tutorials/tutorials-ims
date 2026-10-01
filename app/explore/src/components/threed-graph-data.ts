import type { ExploreNode, ExploreEdge } from '../types'
import { colorForNodeType, edgeColorForPredicate } from '../node-colors'

export interface GraphNode {
  id: string
  label: string
  type: string
  slug: string
  color: string
  val: number
  __node: ExploreNode
}

export interface GraphLink {
  source: string
  target: string
  color: string
  predicate: string
}

export interface GraphData {
  nodes: GraphNode[]
  links: GraphLink[]
}

/**
 * Maps ExploreNode[]/ExploreEdge[] into the { nodes, links } shape consumed by
 * 3d-force-graph. Pure function — no WebGL dependencies, unit-testable in jsdom.
 *
 * Node sizing:
 *   - rank present  → val = 1 + rank * 10
 *   - rank absent   → val = 1 + degree  (count of edge endpoints referencing this node)
 *
 * Dangling edges (either endpoint not in the node set) are dropped.
 */
export function toGraphData(nodes: ExploreNode[], edges: ExploreEdge[]): GraphData {
  const nodeIds = new Set(nodes.map(n => n.id))

  // Compute degree: count how many times each node id appears as s or o
  const degree = new Map<string, number>()
  for (const e of edges) {
    if (nodeIds.has(e.s) && nodeIds.has(e.o)) {
      degree.set(e.s, (degree.get(e.s) ?? 0) + 1)
      degree.set(e.o, (degree.get(e.o) ?? 0) + 1)
    }
  }

  const graphNodes: GraphNode[] = nodes.map(n => {
    const deg = degree.get(n.id) ?? 0
    const val = n.rank != null ? 1 + n.rank * 10 : 1 + deg
    return {
      id: n.id,
      label: n.label,
      type: n.type,
      slug: n.slug,
      color: colorForNodeType(n.type),
      val,
      __node: n,
    }
  })

  const graphLinks: GraphLink[] = edges
    .filter(e => nodeIds.has(e.s) && nodeIds.has(e.o))
    .map(e => ({
      source: e.s,
      target: e.o,
      color: edgeColorForPredicate(e.p),
      predicate: e.p,
    }))

  return { nodes: graphNodes, links: graphLinks }
}
