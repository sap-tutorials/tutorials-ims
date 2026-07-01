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
// 'sample'. Phase 4.7 (#748) adds 'help-doc'.
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
  | 'help-doc'

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
// Phase 4.6 (#747) adds 'sample'; Phase 4.7 (#748) adds 'help-doc'.
// Mirrors the OtherResource type in srv/knowledge-graph-service.cds.
export type OtherResource = {
  type: 'learning-journey' | 'blog-post' | 'discovery-mission' | 'video' | 'api-doc' | 'sample' | 'help-doc'   // widens per sub-phase
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
  // help-doc only (Phase 4.7 #748 §4.8.2): sidebar renders
  // "<badge> Title ↗" (one line, tight — per §3 Q10). Concept page
  // (more real estate) uses the same source + anchor + snippet fields
  // but adds anchorLabel and snippet. `sourceLabel` is derived at
  // payload time (`published-concepts-query.js` in Task 2's extension);
  // rendering side reads it verbatim. Same rule for `anchorLabel`.
  source?: 'help-sap-com' | 'cap-cloud-sap' | 'ui5-sap-com' | null
  sourceLabel?: string | null
  anchor?: string | null
  anchorLabel?: string | null
  snippet?: string | null
  product?: string | null
  overlapCount?: number | null
  // Phase 5 (#850): server-rendered meta string, e.g. " · by Alice · Jun 3, 2026".
  // Consumers (ResourceRow / SidebarPanel / ExpandedPanel) should render this
  // verbatim instead of computing meta client-side from per-type fields.
  metaText?: string | null
}

// Phase 5 (#850): TypeConfigEntry mirrors the server's kg-resource-type-config.js
// (minus renderMeta, which is server-only). Received on the wire as the
// `typeConfig` field on NeighborhoodResult / NeighborhoodFullResult.
export type TypeConfigEntry = {
  type: string
  icon: string
  singular: string
  plural: string
  priority: number
  metaTemplate: string
}

// Phase 5 (#850): per-type buckets for the expanded panel dialog. One entry
// per external type with ≥1 result, sorted by config.priority ascending.
// Empty types omitted entirely.
export type OtherResourcesByTypeEntry = {
  type: string
  config: TypeConfigEntry
  items: OtherResource[]
}

// Phase 5 (#850): response type for GET /graph/neighborhoodFull. Does NOT
// carry `teaches` (that section removed from the redesign).
export type NeighborhoodFullResult = {
  tutorial: TutorialInfo
  graphVersion: string | null
  prerequisitesOf: TutorialRef[]
  sharedConcepts: TutorialRef[]
  whatToLearnNext: TutorialRef[]
  otherResourcesByType: OtherResourcesByTypeEntry[]
  typeConfig: TypeConfigEntry[]
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
  // Phase 5 (#850): additive typeConfig array on the sidebar wire shape.
  // Optional because older cached responses may lack it.
  typeConfig?: TypeConfigEntry[]
}

export type SidebarState = 'loading' | 'empty' | 'disabled' | 'error' | 'ready'
