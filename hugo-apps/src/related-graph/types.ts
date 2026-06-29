// hugo-apps/src/related-graph/types.ts
//
// Wire types for the Knowledge Graph sidebar island. Mirrors the
// shape of `KnowledgeGraphService.neighborhood` in
// srv/knowledge-graph-service.cds. Keep these in sync when the CDS
// service shape changes.

// Phase 4 (#447): widened from the original tutorial-OP sidebar set to
// include 'learning-journey'. Phase 4.2 (#447 §9) adds 'blog-post'.
// Phase 4.3 (#447 §8) adds 'discovery-mission'. Phase 4.4 (#447 §9) adds
// 'video'. Phase 4.5 (#746) adds 'api-doc'. Phase 4.6 (#747) adds
// 'sample'.
export type NodeType =
  | 'tutorial'
  | 'concept'
  | 'mission'
  | 'group'
  | 'product'
  | 'category'
  | 'tag'
  | 'learning-journey'
  | 'blog-post'
  | 'discovery-mission'
  | 'video'
  | 'api-doc'
  | 'sample'

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
// journeys) populated it. Phase 4.2 (#447 §9) widens the discriminant to
// include 'blog-post' rows; Phase 4.3 (#447 §8) adds 'discovery-mission';
// Phase 4.4 (#447 §9) adds 'video'; Phase 4.5 (#746) adds 'api-doc';
// Phase 4.6 (#747) adds 'sample'.
// Mirrors the OtherResource type in srv/knowledge-graph-service.cds.
export type OtherResource = {
  type: 'learning-journey' | 'blog-post' | 'discovery-mission' | 'video' | 'api-doc' | 'sample'   // widens per sub-phase
  slug: string
  title: string
  url: string
  // learning-journey only:
  level?: string | null
  durationHours?: number | null
  // blog-post only (Phase 4.2):
  authorName?: string | null
  postedAt?: string | null    // ISO timestamp
  // discovery-mission only (Phase 4.3):
  effortLevel?: number | null
  categoryLabel?: string | null
  // video only (Phase 4.4): channelTitle + publishedAt drive the
  // sidebar's "· by Channel · Date" meta row. `thumbnailUrl` is carried
  // on the wire (it ships with the same payload that feeds the concept
  // page) but is intentionally NOT rendered in the sidebar — preserves
  // the existing visual rhythm of title-only sidebar rows. The concept
  // page DOES render the thumbnail inline (120×68).
  channelTitle?: string | null
  publishedAt?: string | null    // ISO timestamp
  thumbnailUrl?: string | null
  // api-doc only (Phase 4.5 #746): the sidebar renders
  // "title · Official reference · Category" (no thumbnail, no ↗ icon).
  // The concept page DOES render the ↗ link-out icon + apiType badge.
  category?: string | null
  apiType?: string | null
  // sample only (Phase 4.6 #747): the sidebar renders
  // "title · Language · N stars · Updated Mon YYYY" (no thumbnail, no
  // ↗ icon). The concept page DOES render the ↗ link-out icon + a
  // .kg-language badge. `lastCommitAt` is an ISO timestamp formatted
  // client-side via formatRelativeMonth (related-graph-helpers.ts).
  language?: string | null
  stars?: number | null
  lastCommitAt?: string | null   // ISO timestamp
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
