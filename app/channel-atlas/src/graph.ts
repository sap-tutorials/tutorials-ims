/**
 * Pure graph-building functions for the Channel Atlas SPA.
 * No Vue/DOM/CDS dependencies — fully unit-testable.
 */

import type { AtlasEdge } from './types.js'

// ── Node sizing ────────────────────────────────────────────────────────────────
// log1p scale: log1p(0)=0 → FLOOR_SIZE; log1p(1e6)=~13.8 → MAX_SIZE.
// FLOOR_SIZE (1.5 px) ensures every channel is a visible dot even when
// subscriber data is absent (many channels have null subscribers + null
// githubStars today — sparse data must not produce invisible nodes).
export const FLOOR_SIZE = 1.5
export const MAX_SIZE   = 20
const SIZE_NORM = Math.log1p(1_000_000)  // normalisation denominator

/**
 * Compute a display-size for a channel node.
 * Preference order: subscribers → githubStars → 0 (floor).
 */
export function sizeChannel(
  subscribers: number | null,
  githubStars: number | null,
): number {
  const n = subscribers ?? githubStars ?? 0
  return FLOOR_SIZE + (Math.log1p(n) / SIZE_NORM) * (MAX_SIZE - FLOOR_SIZE)
}

// ── Node colouring ─────────────────────────────────────────────────────────────
// 9-value palette matching the ChannelOwnerType enum in db/channels.cds.
// SAP tiers: blue family.  Community/User Group: green/amber/red.
// Third-party: purple/orange/teal for visual separation.
export const OWNER_TYPE_PALETTE: Record<string, string> = {
  SAP_Official:             '#0a6ed1',  // SAP Brand Blue
  SAP_Developer_Advocate:   '#1a8cff',  // lighter SAP blue
  SAP_Executive:            '#074888',  // deep SAP navy
  Community_Member:         '#5dc122',  // leaf green
  Community_Organization:   '#f58b00',  // amber
  User_Group:               '#bb0000',  // red
  Third_party_Training:     '#6600cc',  // purple
  Third_party_Media:        '#cc3300',  // burnt orange
  Third_party_Platform:     '#007c7c',  // teal
}
export const FALLBACK_COLOR = '#888888'  // grey for null/unknown ownerType

export function ownerTypeColor(ownerType: string | null | undefined): string {
  return OWNER_TYPE_PALETTE[ownerType ?? ''] ?? FALLBACK_COLOR
}

// ── Edge derivation ─────────────────────────────────────────────────────────────
// Both functions are O(n²) pairwise — correct at current channel counts (<1000).

/**
 * Phase-1 edges: two channels are connected when they share at least one
 * focusArea string.  weight = intersection size.
 */
export function buildFocusEdges(
  nodes: { id: string; focusAreas: string[] }[],
): AtlasEdge[] {
  const edges: AtlasEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    const a = new Set(nodes[i].focusAreas)
    if (a.size === 0) continue
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[j].focusAreas.filter((f) => a.has(f))
      if (shared.length > 0) {
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: shared.length, kind: 'focus' })
      }
    }
  }
  return edges
}

/**
 * Phase-2 edges: two channels are connected when they share at least one
 * REVIEWED ChannelTopicMap topicTag.  weight = intersection size.
 * Returns an empty array while ChannelTopicMap is unseeded (pre-Phase-0).
 */
export function buildTopicEdges(
  nodes: { id: string; topicTags: string[] }[],
): AtlasEdge[] {
  const edges: AtlasEdge[] = []
  for (let i = 0; i < nodes.length; i++) {
    const a = new Set(nodes[i].topicTags)
    if (a.size === 0) continue
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[j].topicTags.filter((t) => a.has(t))
      if (shared.length > 0) {
        edges.push({ source: nodes[i].id, target: nodes[j].id, weight: shared.length, kind: 'topic' })
      }
    }
  }
  return edges
}
