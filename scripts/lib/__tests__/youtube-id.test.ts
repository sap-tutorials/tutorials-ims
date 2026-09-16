import { describe, it, expect } from 'vitest'
import { youtubeId } from '../youtube-id.js'

describe('youtubeId', () => {
  it('extracts id from watch?v= URL', () => {
    expect(youtubeId('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extracts id from watch URL with extra query params', () => {
    expect(youtubeId('https://youtube.com/watch?list=abc&v=dQw4w9WgXcQ&t=30')).toBe('dQw4w9WgXcQ')
  })

  it('extracts id from youtu.be short link', () => {
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extracts id from youtu.be link with query', () => {
    expect(youtubeId('https://youtu.be/dQw4w9WgXcQ?t=42')).toBe('dQw4w9WgXcQ')
  })

  it('extracts id from /embed/ URL', () => {
    expect(youtubeId('https://www.youtube.com/embed/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extracts id from /live/ URL (Devtoberfest session recordings)', () => {
    expect(youtubeId('https://www.youtube.com/live/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('extracts id from /shorts/ URL', () => {
    expect(youtubeId('https://www.youtube.com/shorts/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ')
  })

  it('returns null for empty string', () => {
    expect(youtubeId('')).toBeNull()
  })

  it('returns null for a non-YouTube URL', () => {
    expect(youtubeId('https://example.com/watch?foo=bar')).toBeNull()
  })

  it('returns null when the id is too short', () => {
    expect(youtubeId('https://youtu.be/abc')).toBeNull()
  })
})
