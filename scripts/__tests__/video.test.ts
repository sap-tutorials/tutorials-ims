import { describe, it, expect, vi } from 'vitest'
import { normalizeVideo } from '../parsers/video.js'

describe('normalizeVideo', () => {
  it('normalizes a YouTube watch URL', () => {
    expect(normalizeVideo({ url: 'https://www.youtube.com/watch?v=6WY70LyLS1c' }, 's')).toEqual({
      embedUrl: 'https://www.youtube.com/embed/6WY70LyLS1c',
      title: 'Video tutorial',
      provider: 'youtube',
    })
  })
  it('normalizes a youtu.be short URL and keeps a title', () => {
    expect(normalizeVideo({ url: 'https://youtu.be/6WY70LyLS1c', title: 'Intro' }, 's')).toEqual({
      embedUrl: 'https://www.youtube.com/embed/6WY70LyLS1c', title: 'Intro', provider: 'youtube',
    })
  })
  it('accepts a bare 11-char YouTube id', () => {
    expect(normalizeVideo('6WY70LyLS1c', 's')?.embedUrl).toBe('https://www.youtube.com/embed/6WY70LyLS1c')
  })
  it('normalizes a Vimeo URL', () => {
    expect(normalizeVideo({ url: 'https://vimeo.com/123456789' }, 's')).toEqual({
      embedUrl: 'https://player.vimeo.com/video/123456789', title: 'Video tutorial', provider: 'vimeo',
    })
  })
  it('passes through an openSAP microlearning URL', () => {
    const r = normalizeVideo({ url: 'https://microlearning.opensap.com/media/x/1_abc' }, 's')
    expect(r?.provider).toBe('opensap')
    expect(r?.embedUrl).toContain('microlearning.opensap.com')
  })
  it('returns null and warns for an unknown host', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(normalizeVideo({ url: 'https://evil.example/x' }, 'my-slug')).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('my-slug'))
    warn.mockRestore()
  })
  it('returns null for empty/missing input', () => {
    expect(normalizeVideo(undefined, 's')).toBeNull()
    expect(normalizeVideo({}, 's')).toBeNull()
  })
})
