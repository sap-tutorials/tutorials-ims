// hugo-apps/src/related-graph/types.ts
//
// Wire types for the Knowledge Graph sidebar island. Mirrors the
// shape of `KnowledgeGraphService.neighborhood` in
// srv/knowledge-graph-service.cds. Keep these in sync when the CDS
// service shape changes.

// Phase 4 (#447): widened from the original tutorial-OP sidebar set to
// include 'learning-journey'. Sub-phases 4.2-4.6 will add more values
// ('news', 'video', 'sample', 'discovery', 'resource').
export type NodeType =
  | 'tutorial'
  | 'concept'
  | 'mission'
  | 'group'
  | 'product'
  | 'category'
  | 'tag'
  | 'learning-journey'

export type ConceptRef = {
  slug: string
  name: string
  description?: string | null
  // Phase 3 (#446): true when a public /concepts/<slug>/ landing page
  // exists for this concept. The neighborhood handler sets it from the
  // PublishedConcepts view; the sidebar uses it to flip the rendering
  // from <span> to <a>.
  published?: boolean
}

export type TutorialRef = {
  slug: string
  title: string
  weight?: number | null
  reason?: string | null
}

export type TutorialInfo = {
  slug: string
  title: string
}

// Phase 4 chassis (#447): wire shape for the cross-corpus "Other
// resources" sidebar rail. PR-1 wired the empty contract; PR-2 (learning
// journeys) populates it. 4.3-4.6 will widen the `type` discriminant.
// Mirrors the OtherResource type in srv/knowledge-graph-service.cds.
export type OtherResource = {
  type: 'learning-journey'  // widens per sub-phase
  slug: string
  title: string
  url: string
  level?: string | null
  durationHours?: number | null
  overlapCount?: number | null
}

export type NeighborhoodResult = {
  tutorial: TutorialInfo
  graphVersion: string | null
  teaches: ConceptRef[]
  prerequisitesOf: TutorialRef[]
  sharedConcepts: TutorialRef[]
  whatToLearnNext: TutorialRef[]
  // Phase 4.1 (#447 §2.6): cross-corpus rail. Optional on the wire so
  // older cached responses without it still parse cleanly.
  otherResources?: OtherResource[]
}

export type SidebarState = 'loading' | 'empty' | 'disabled' | 'error' | 'ready'
