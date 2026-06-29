import { describe, it, expect } from 'vitest'
import { frontmatter, type ConceptPayload } from '../../../scripts/fetch-concepts.ts'

// Phase 4.4 (#447 §9) — frontmatter() videos emission.
//
// The Hugo template at hugo/layouts/concepts/single.html reads
// `.Params.videos` to render the "Videos teaching this" section.
// Without this pipeline step the section would never render — the
// `/build/concepts` payload carries videos[] (added in Task 2 via
// srv/lib/published-concepts-query.js) but it has to be emitted into
// the per-concept Hugo frontmatter for the template to see it.
//
// Unlike discoveryMissions there is no helper transformation —
// `thumbnailUrl` is already a CDN URL (i.ytimg.com), `channelTitle`
// and `publishedAt` are pass-through.

describe('frontmatter — videos', () => {
  const baseConcept: ConceptPayload = {
    slug: 'cap-handlers',
    name: 'CAP handlers',
    description: 'd',
    teaches: [],
    requires: [],
    requiredBy: [],
    relatedTo: [],
  }

  it('omits the videos key entirely when the array is empty', () => {
    const out = frontmatter({ ...baseConcept, videos: [] })
    expect(out).not.toContain('videos:')
  })

  it('omits the videos key entirely when undefined', () => {
    const out = frontmatter(baseConcept)
    expect(out).not.toContain('videos:')
  })

  it('emits one video with all fields (thumbnailUrl + channelTitle + publishedAt) pass-through', () => {
    const out = frontmatter({
      ...baseConcept,
      videos: [{
        slug: 'vid-abc123',
        title: 'CAP Service Handlers — Deep Dive',
        url: 'https://www.youtube.com/watch?v=abc123',
        thumbnailUrl: 'https://i.ytimg.com/vi/abc123/hqdefault.jpg',
        channelTitle: 'SAP Developers',
        publishedAt: '2026-05-10T14:00:00Z',
      }],
    })
    expect(out).toContain('videos:')
    expect(out).toContain('- slug: "vid-abc123"')
    expect(out).toContain('    title: "CAP Service Handlers — Deep Dive"')
    expect(out).toContain('    url: "https://www.youtube.com/watch?v=abc123"')
    // Thumbnail URL passes through verbatim (no helper, no resolution).
    expect(out).toContain('    thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg"')
    expect(out).toContain('    channelTitle: "SAP Developers"')
    expect(out).toContain('    publishedAt: "2026-05-10T14:00:00Z"')
  })

  it('omits optional fields when null/undefined and keeps required fields', () => {
    const out = frontmatter({
      ...baseConcept,
      videos: [{
        slug: 'vid-bare',
        title: 'Bare Video',
        url: 'https://www.youtube.com/watch?v=bare',
        // no thumbnailUrl, no channelTitle, no publishedAt
      }],
    })
    expect(out).toContain('videos:')
    expect(out).toContain('- slug: "vid-bare"')
    expect(out).toContain('    title: "Bare Video"')
    expect(out).toContain('    url: "https://www.youtube.com/watch?v=bare"')
    expect(out).not.toContain('thumbnailUrl:')
    expect(out).not.toContain('channelTitle:')
    expect(out).not.toContain('publishedAt:')
  })

  it('emits multiple videos preserving order', () => {
    const out = frontmatter({
      ...baseConcept,
      videos: [
        {
          slug: 'vid-aaa',
          title: 'A',
          url: 'https://www.youtube.com/watch?v=aaa',
          thumbnailUrl: 'https://i.ytimg.com/vi/aaa/hqdefault.jpg',
          channelTitle: 'SAP Developers',
          publishedAt: '2026-01-01T00:00:00Z',
        },
        {
          slug: 'vid-bbb',
          title: 'B',
          url: 'https://www.youtube.com/watch?v=bbb',
          thumbnailUrl: 'https://i.ytimg.com/vi/bbb/hqdefault.jpg',
          channelTitle: 'SAP Developers',
          publishedAt: '2026-02-01T00:00:00Z',
        },
      ],
    })
    const aIdx = out.indexOf('"vid-aaa"')
    const bIdx = out.indexOf('"vid-bbb"')
    expect(aIdx).toBeGreaterThan(-1)
    expect(bIdx).toBeGreaterThan(aIdx)
  })

  it('escapes title for YAML safety', () => {
    const out = frontmatter({
      ...baseConcept,
      videos: [{
        slug: 'vid-tricky',
        title: 'Video with "quotes" and \\backslash',
        url: 'https://www.youtube.com/watch?v=tricky',
      }],
    })
    expect(out).toContain('Video with \\"quotes\\" and \\\\backslash')
  })
})
