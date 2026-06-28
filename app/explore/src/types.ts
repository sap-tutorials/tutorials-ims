// Phase 4 (#447): widened to include 'learning-journey'. Mirror of
// hugo-apps/src/related-graph/types.ts. Sub-phases 4.2-4.6 will add more
// values; keep these two NodeType unions in sync.
export type NodeType =
  | 'tutorial'
  | 'concept'
  | 'mission'
  | 'product'
  | 'group'
  | 'category'
  | 'tag'
  | 'learning-journey'
export type PredicateType =
  | 'teaches' | 'requires' | 'relatedTo' | 'extends'
  | 'partOf' | 'taggedWith' | 'aboutProduct' | 'inCategory' | 'coCompletedWith'

export interface ExploreNode {
  id: string
  type: NodeType
  label: string
  slug: string
}

export interface ExploreEdge {
  s: string
  p: PredicateType
  o: string
  count?: number  // present on coCompletedWith edges (FLOOR-by-10)
}

export interface ExplorePayload {
  nodes: ExploreNode[]
  edges: ExploreEdge[]
  generatedAt: string
  droppedBindings?: number  // observability counter from Task 1's buildExplorePayload
}

declare global {
  interface Window {
    __INITIAL_GRAPH__?: ExplorePayload
  }
}
