// @vitest-environment node
import { describe, it, expect } from 'vitest'
import {
  sizeChannel, FLOOR_SIZE, MAX_SIZE,
  ownerTypeColor, OWNER_TYPE_PALETTE, FALLBACK_COLOR,
  buildFocusEdges, buildTopicEdges,
} from '../graph.js'

describe('sizeChannel', () => {
  it('returns FLOOR_SIZE when both subscribers and githubStars are null', () => {
    expect(sizeChannel(null, null)).toBe(FLOOR_SIZE)
  })

  it('returns FLOOR_SIZE when both are zero (data-absent channels show as minimum dot)', () => {
    expect(sizeChannel(0, null)).toBeCloseTo(FLOOR_SIZE, 5)
  })

  it('returns MAX_SIZE for exactly 1 million subscribers', () => {
    expect(sizeChannel(1_000_000, null)).toBeCloseTo(MAX_SIZE, 1)
  })

  it('uses subscribers when both are non-null (subscribers wins)', () => {
    // subscribers=1000 should give the same result regardless of githubStars value
    expect(sizeChannel(1000, 50000)).toBeCloseTo(sizeChannel(1000, null), 8)
  })

  it('falls back to githubStars when subscribers is null', () => {
    expect(sizeChannel(null, 5000)).toBeCloseTo(sizeChannel(5000, null), 8)
  })

  it('returns a value strictly between FLOOR_SIZE and MAX_SIZE for mid-range channels', () => {
    const s = sizeChannel(10000, null)
    expect(s).toBeGreaterThan(FLOOR_SIZE)
    expect(s).toBeLessThan(MAX_SIZE)
  })

  it('is monotonically increasing (bigger subscriber count → bigger node)', () => {
    expect(sizeChannel(100, null)).toBeLessThan(sizeChannel(10000, null))
  })
})

describe('ownerTypeColor', () => {
  it('returns the correct hex color for every ownerType enum value', () => {
    for (const [ownerType, color] of Object.entries(OWNER_TYPE_PALETTE)) {
      expect(ownerTypeColor(ownerType)).toBe(color)
    }
  })

  it('covers all 9 enum values from db/channels.cds', () => {
    const expected = [
      'SAP_Official', 'SAP_Developer_Advocate', 'SAP_Executive',
      'Community_Member', 'Community_Organization', 'User_Group',
      'Third_party_Training', 'Third_party_Media', 'Third_party_Platform',
    ]
    expect(Object.keys(OWNER_TYPE_PALETTE)).toHaveLength(9)
    for (const t of expected) expect(OWNER_TYPE_PALETTE).toHaveProperty(t)
  })

  it('returns FALLBACK_COLOR for null', () => {
    expect(ownerTypeColor(null)).toBe(FALLBACK_COLOR)
  })

  it('returns FALLBACK_COLOR for undefined', () => {
    expect(ownerTypeColor(undefined)).toBe(FALLBACK_COLOR)
  })

  it('returns FALLBACK_COLOR for an unrecognised string', () => {
    expect(ownerTypeColor('NOT_A_TYPE')).toBe(FALLBACK_COLOR)
  })
})

describe('buildFocusEdges', () => {
  it('returns an edge when two channels share exactly one focus area', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: ['CAP', 'BTP'] },
      { id: 'ch-2', focusAreas: ['BTP', 'ABAP'] },
    ]
    const edges = buildFocusEdges(nodes)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'ch-1', target: 'ch-2', weight: 1, kind: 'focus' })
  })

  it('sets weight equal to the number of shared focus areas', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: ['CAP', 'BTP', 'HANA'] },
      { id: 'ch-2', focusAreas: ['CAP', 'BTP', 'Python'] },
    ]
    expect(buildFocusEdges(nodes)[0].weight).toBe(2)
  })

  it('returns no edges when channels share no focus areas', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: ['CAP'] },
      { id: 'ch-2', focusAreas: ['ABAP'] },
    ]
    expect(buildFocusEdges(nodes)).toHaveLength(0)
  })

  it('skips channels with empty focusAreas without producing edges', () => {
    const nodes = [
      { id: 'ch-1', focusAreas: [] },
      { id: 'ch-2', focusAreas: [] },
    ]
    expect(buildFocusEdges(nodes)).toHaveLength(0)
  })

  it('produces at most n*(n-1)/2 edges for n channels', () => {
    // 3 channels all sharing 'CAP' → 3 edges
    const nodes = [
      { id: 'a', focusAreas: ['CAP'] },
      { id: 'b', focusAreas: ['CAP'] },
      { id: 'c', focusAreas: ['CAP'] },
    ]
    expect(buildFocusEdges(nodes)).toHaveLength(3)
  })
})

describe('buildTopicEdges', () => {
  it('returns an edge for channels sharing a reviewed topicTag', () => {
    const nodes = [
      { id: 'ch-1', topicTags: ['software-product>sap-cap', 'topic>btp'] },
      { id: 'ch-2', topicTags: ['topic>btp'] },
    ]
    const edges = buildTopicEdges(nodes)
    expect(edges).toHaveLength(1)
    expect(edges[0]).toMatchObject({ source: 'ch-1', target: 'ch-2', weight: 1, kind: 'topic' })
  })

  it('returns no edges when all topicTag arrays are empty (pre-seed state)', () => {
    const nodes = [
      { id: 'ch-1', topicTags: [] },
      { id: 'ch-2', topicTags: [] },
    ]
    expect(buildTopicEdges(nodes)).toHaveLength(0)
  })

  it('does not produce duplicate edges when called alongside buildFocusEdges', () => {
    // Verify kind='topic' is distinct from kind='focus' so App.vue can render
    // topic edges in a different color.
    const nodes = [
      { id: 'ch-1', topicTags: ['t>cap'] },
      { id: 'ch-2', topicTags: ['t>cap'] },
    ]
    const edges = buildTopicEdges(nodes)
    expect(edges.every((e) => e.kind === 'topic')).toBe(true)
  })
})
