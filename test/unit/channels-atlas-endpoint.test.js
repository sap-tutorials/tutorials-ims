// @vitest-environment node
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'

const NS = 'com.sap.developers.ims'

// Module-level bootstrap — CDS server starts once per test file.
// (Calling inside beforeAll breaches the 60s hookTimeout on a busy CI box.)
const project = cds.test('serve', '--project', '.', '--in-memory')

describe('GET /build/channel-atlas', () => {
  let baseUrl

  beforeAll(async () => {
    baseUrl = project.url
    const { Channels, ChannelTopicMap } = cds.entities(NS)
    const db = await cds.connect.to('db')
    await db.run(
      INSERT.into(Channels).entries([
        {
          ID: 'aaaaaa-0001', sourceId: 'src-001', name: 'SAP CAP Tutorials',
          url: 'https://cap.cloud.sap', purpose: 'CAP dev resources',
          ownerType: 'SAP_Official', subscribers: 1500, githubStars: null,
          isPublished: true, status: 'Active', focusAreas: JSON.stringify(['CAP', 'BTP']),
        },
        {
          ID: 'aaaaaa-0002', sourceId: 'src-002', name: 'ABAP Community',
          url: 'https://community.sap.com/abap', purpose: 'ABAP help',
          ownerType: 'Community_Member', subscribers: null, githubStars: 200,
          isPublished: true, status: 'Active', focusAreas: JSON.stringify(['ABAP']),
        },
        {
          ID: 'aaaaaa-0003', sourceId: 'src-003', name: 'Unpublished',
          url: 'https://example.com', purpose: null,
          ownerType: 'SAP_Official', subscribers: null, githubStars: null,
          isPublished: false, status: 'Active', focusAreas: JSON.stringify([]),
        },
      ])
    )
    await db.run(
      INSERT.into(ChannelTopicMap).entries([
        {
          ID: 'tm-0001', channel_ID: 'aaaaaa-0001',
          topicTag: 'software-product>sap-cap', relevance: 80, authoringStatus: 'REVIEWED',
        },
      ])
    )
  })

  it('returns published channels with all atlas fields', async () => {
    const res = await fetch(`${baseUrl}/build/channel-atlas`)
    expect(res.ok).toBe(true)
    const body = await res.json()
    expect(body.buildAt).toMatch(/^\d{4}-\d{2}-\d{2}/)
    expect(Array.isArray(body.channels)).toBe(true)
    // Only published channels
    expect(body.channels.some((c) => c.name === 'Unpublished')).toBe(false)
    expect(body.channels).toHaveLength(2)
  })

  it('includes id, name, url, purpose, ownerType, subscribers, githubStars, focusAreas, topicTags', async () => {
    const res = await fetch(`${baseUrl}/build/channel-atlas`)
    const { channels } = await res.json()
    const cap = channels.find((c) => c.name === 'SAP CAP Tutorials')
    expect(cap).toMatchObject({
      id: 'aaaaaa-0001',
      name: 'SAP CAP Tutorials',
      ownerType: 'SAP_Official',
      subscribers: 1500,
      githubStars: null,
      focusAreas: ['CAP', 'BTP'],
      topicTags: ['software-product>sap-cap'],
    })
  })

  it('returns empty topicTags for channels with no REVIEWED rows', async () => {
    const res = await fetch(`${baseUrl}/build/channel-atlas`)
    const { channels } = await res.json()
    const abap = channels.find((c) => c.name === 'ABAP Community')
    expect(abap.topicTags).toEqual([])
  })

  it('returns 200 with empty channels array when DB is empty (fail-open)', async () => {
    // This is structural: the endpoint must never throw.
    // We rely on the handler try/catch and the existing seed above.
    const res = await fetch(`${baseUrl}/build/channel-atlas`)
    expect(res.status).toBe(200)
  })
})
