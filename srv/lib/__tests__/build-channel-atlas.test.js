import { describe, it, expect } from 'vitest'
import { buildAtlasChannels } from '../build-channel-atlas.js'

describe('buildAtlasChannels', () => {
  it('maps all expected fields onto the public DTO shape', () => {
    const rows = [{
      ID: 'ch-1', name: 'SAP CAP Channel', url: 'https://cap.cloud.sap',
      purpose: 'CAP tutorials', ownerType: 'SAP_Official',
      subscribers: 1000, githubStars: null,
      focusAreas: '["CAP","BTP"]',
    }]
    const topics = new Map([['ch-1', ['software-product>sap-cap']]])
    const [ch] = buildAtlasChannels(rows, topics)
    expect(ch).toMatchObject({
      id: 'ch-1', name: 'SAP CAP Channel', url: 'https://cap.cloud.sap',
      purpose: 'CAP tutorials', ownerType: 'SAP_Official',
      subscribers: 1000, githubStars: null,
      focusAreas: ['CAP', 'BTP'],
      topicTags: ['software-product>sap-cap'],
    })
  })

  it('parses HANA NCLOB JSON string focusAreas', () => {
    const rows = [{ ID: 'ch-2', name: 'X', url: 'https://x', focusAreas: '["Go","Python"]' }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.focusAreas).toEqual(['Go', 'Python'])
  })

  it('passes through already-parsed focusAreas arrays (SQLite in-memory tests)', () => {
    const rows = [{ ID: 'ch-3', name: 'Y', url: 'https://y', focusAreas: ['Go'] }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.focusAreas).toEqual(['Go'])
  })

  it('yields empty topicTags for channels absent from topicsByChannel', () => {
    const rows = [{ ID: 'ch-4', name: 'Z', url: 'https://z', focusAreas: [] }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.topicTags).toEqual([])
  })

  it('handles null focusAreas without throwing', () => {
    const rows = [{ ID: 'ch-5', name: 'A', url: 'https://a', focusAreas: null }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.focusAreas).toEqual([])
  })

  it('coerces null/undefined purpose to null', () => {
    const rows = [{ ID: 'ch-6', name: 'B', url: 'https://b', purpose: undefined, focusAreas: [] }]
    const [ch] = buildAtlasChannels(rows, new Map())
    expect(ch.purpose).toBeNull()
  })
})
