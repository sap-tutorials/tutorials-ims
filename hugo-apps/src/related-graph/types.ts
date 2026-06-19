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
