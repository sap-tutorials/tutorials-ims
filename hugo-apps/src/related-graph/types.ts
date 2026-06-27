// hugo-apps/src/related-graph/types.ts
//
// Wire types for the Knowledge Graph sidebar island. Mirrors the
// shape of `KnowledgeGraphService.neighborhood` in
// srv/knowledge-graph-service.cds. Keep these in sync when the CDS
// service shape changes.

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

export type NeighborhoodResult = {
  tutorial: TutorialInfo
  graphVersion: string | null
  teaches: ConceptRef[]
  prerequisitesOf: TutorialRef[]
  sharedConcepts: TutorialRef[]
  whatToLearnNext: TutorialRef[]
}

export type SidebarState = 'loading' | 'empty' | 'disabled' | 'error' | 'ready'
