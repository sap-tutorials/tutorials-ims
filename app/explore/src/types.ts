// Phase 4 (#447): widened to include 'learning-journey'. Phase 4.2 (#447 §9)
// adds 'blog-post'. Phase 4.3 (#447 §8) adds 'discovery-mission'.
// Phase 4.4 (#447 §9) adds 'video'. Phase 4.5 (#746) adds 'api-doc'.
// Phase 4.6 (#747) adds 'sample'. Phase 4.7 (#748) adds 'help-doc'.
// Mirror of hugo-apps/src/related-graph/types.ts. Keep these two NodeType
// unions in sync.
export type NodeType =
  | 'tutorial'
  | 'concept'
  | 'mission'
  | 'product'
  | 'group'
  | 'category'
  | 'tag'
  | 'learning-journey'
  | 'blog-post'
  | 'discovery-mission'
  | 'video'
  | 'api-doc'
  | 'sample'
  | 'help-doc'
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
