/**
 * Channel Atlas SPA — domain types.
 *
 * AtlasChannelDTO: raw shape from GET /build/channel-atlas.
 * AtlasNode:       enriched with size + color computed client-side.
 * AtlasEdge:       derived client-side from shared focusAreas or topicTags.
 * AtlasPayload:    full endpoint response shape (also written to hugo/data/channel_atlas.json).
 */

// Mirrors ChannelOwnerType enum in db/channels.cds (9 values).
export type OwnerType =
  | 'SAP_Official'
  | 'SAP_Developer_Advocate'
  | 'SAP_Executive'
  | 'Community_Member'
  | 'Community_Organization'
  | 'User_Group'
  | 'Third_party_Training'
  | 'Third_party_Media'
  | 'Third_party_Platform'

/** Raw channel record as returned by GET /build/channel-atlas. */
export interface AtlasChannelDTO {
  id: string
  name: string
  url: string
  purpose: string | null
  ownerType: OwnerType | null
  subscribers: number | null
  githubStars: number | null
  focusAreas: string[]
  topicTags: string[]   // REVIEWED ChannelTopicMap rows; empty pre-seed (phase-2)
}

/** Graph node: AtlasChannelDTO enriched with display size + color. */
export interface AtlasNode extends AtlasChannelDTO {
  size: number   // computed by sizeChannel() in graph.ts
  color: string  // computed by ownerTypeColor() in graph.ts
}

/**
 * Graph edge derived client-side.
 * kind='focus'  — shared focusAreas (phase-1, works pre-seed)
 * kind='topic'  — shared REVIEWED ChannelTopicMap topicTags (phase-2)
 */
export interface AtlasEdge {
  source: string
  target: string
  weight: number
  kind: 'focus' | 'topic'
}

/** Shape of GET /build/channel-atlas and hugo/data/channel_atlas.json. */
export interface AtlasPayload {
  channels: AtlasChannelDTO[]
  buildAt: string
  /**
   * Set by scripts/fetch-channel-atlas.ts when the build-time fetch of
   * /build/channel-atlas fails — the SPA surfaces it as a load error rather
   * than an empty-filter state. Absent/null on a healthy build.
   */
  error?: string | null
}
