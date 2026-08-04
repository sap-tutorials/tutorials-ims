import type { NormalizedVideo } from './types.js'

const YT_ID = /^[A-Za-z0-9_-]{11}$/

function extractYouTubeId(u: URL | null, raw: string): string | null {
  if (YT_ID.test(raw)) return raw
  if (!u) return null
  const host = u.hostname.replace(/^www\./, '')
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0]
    return YT_ID.test(id) ? id : null
  }
  if (host === 'youtube.com') {
    if (u.pathname === '/watch') { const v = u.searchParams.get('v'); return v && YT_ID.test(v) ? v : null }
    const m = u.pathname.match(/^\/embed\/([A-Za-z0-9_-]{11})/)
    if (m) return m[1]
  }
  return null
}

export function normalizeVideo(input: unknown, slug: string): NormalizedVideo | null {
  let url = ''
  let title = ''
  if (typeof input === 'string') url = input.trim()
  else if (input && typeof input === 'object') {
    const o = input as Record<string, unknown>
    url = typeof o.url === 'string' ? o.url.trim() : ''
    title = typeof o.title === 'string' ? o.title.trim() : ''
  }
  if (!url) return null
  if (!title) title = 'Video tutorial'

  let parsed: URL | null = null
  try { parsed = new URL(url) } catch { parsed = null }

  const ytId = extractYouTubeId(parsed, url)
  if (ytId) return { embedUrl: `https://www.youtube.com/embed/${ytId}`, title, provider: 'youtube' }

  if (parsed) {
    const host = parsed.hostname.replace(/^www\./, '')
    if (host === 'vimeo.com') {
      const m = parsed.pathname.match(/^\/(\d+)$/)
      if (m) return { embedUrl: `https://player.vimeo.com/video/${m[1]}`, title, provider: 'vimeo' }
    }
    if (host === 'player.vimeo.com') {
      const m = parsed.pathname.match(/^\/video\/(\d+)$/)
      if (m) return { embedUrl: `https://player.vimeo.com/video/${m[1]}`, title, provider: 'vimeo' }
    }
    if (parsed.hostname === 'microlearning.opensap.com') {
      return { embedUrl: url, title, provider: 'opensap' }
    }
    if (parsed.hostname === 'sapvideo.cfapps.eu10-004.hana.ondemand.com') {
      return { embedUrl: url, title, provider: 'sapvideo' }
    }
  }

  console.warn(`[video] ${slug}: unrecognized video url/host: ${url}`)
  return null
}
