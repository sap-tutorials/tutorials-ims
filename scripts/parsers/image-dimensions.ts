import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'

/**
 * Annotates markdown image syntax with `{width=N height=M}` so the Hugo
 * render-image hook can emit intrinsic dimensions and eliminate CLS.
 * Uses probe-image-size (pure JS) with a per-URL JSON cache.
 */

const CACHE_DIR = '.tutorial-cache'
const CACHE_FILE = join(CACHE_DIR, 'image-dimensions.json')
const FETCH_TIMEOUT_MS = 8000
const MAX_CONCURRENT = 8

interface Cache {
  [url: string]: { w: number; h: number; t: number } | { failed: true; t: number }
}

let cache: Cache | null = null
let cacheDirty = false

function loadCache(): Cache {
  if (cache) return cache
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  if (existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(readFileSync(CACHE_FILE, 'utf-8')) as Cache
    } catch {
      cache = {}
    }
  } else {
    cache = {}
  }
  return cache
}

export function flushDimensionsCache(): void {
  if (!cache || !cacheDirty) return
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
  cacheDirty = false
}

export function exportDimensionsForHugo(targetPath: string): void {
  const c = loadCache()
  const out: Record<string, { w: number; h: number }> = {}
  for (const [url, val] of Object.entries(c)) {
    if (val && !('failed' in val)) out[url] = { w: val.w, h: val.h }
  }
  const dir = targetPath.replace(/[\\/][^\\/]+$/, '')
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(targetPath, JSON.stringify(out))
}

export async function populateImageDimensions(content: string): Promise<void> {
  const urls = new Set<string>()
  const re = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) urls.add(m[1])
  if (urls.size === 0) return
  const list = [...urls]
  for (let i = 0; i < list.length; i += MAX_CONCURRENT) {
    const slice = list.slice(i, i + MAX_CONCURRENT)
    await Promise.all(slice.map(u => getDimensions(u)))
  }
}

async function probe(url: string): Promise<{ w: number; h: number } | null> {
  const mod = await import('probe-image-size')
  const probeImageSize = (mod.default ?? mod) as (
    src: string,
    opts?: { timeout?: number }
  ) => Promise<{ width: number; height: number }>
  try {
    const r = await probeImageSize(url, { timeout: FETCH_TIMEOUT_MS })
    if (r && r.width && r.height) return { w: r.width, h: r.height }
  } catch {
    /* swallow — image renders without dimensions */
  }
  return null
}

async function getDimensions(url: string): Promise<{ w: number; h: number } | null> {
  const c = loadCache()
  const hit = c[url]
  if (hit) {
    if ('failed' in hit) return null
    return { w: hit.w, h: hit.h }
  }
  const dims = await probe(url)
  cacheDirty = true
  if (dims) {
    c[url] = { ...dims, t: Date.now() }
    return dims
  }
  c[url] = { failed: true, t: Date.now() }
  return null
}

export async function annotateImageDimensions(content: string): Promise<string> {
  const matches: Array<{ index: number; match: string; alt: string; url: string }> = []
  const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)(?!\{)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(content)) !== null) {
    matches.push({ index: m.index, match: m[0], alt: m[1], url: m[2] })
  }
  if (matches.length === 0) return content

  const dimsMap = new Map<string, { w: number; h: number } | null>()
  for (let i = 0; i < matches.length; i += MAX_CONCURRENT) {
    const slice = matches.slice(i, i + MAX_CONCURRENT)
    await Promise.all(
      slice.map(async ({ url }) => {
        if (dimsMap.has(url)) return
        dimsMap.set(url, await getDimensions(url))
      })
    )
  }

  let result = ''
  let lastIdx = 0
  for (const { index, match, url } of matches) {
    result += content.slice(lastIdx, index)
    const dims = dimsMap.get(url)
    if (dims) {
      result += `${match}{width="${dims.w}" height="${dims.h}"}`
    } else {
      result += match
    }
    lastIdx = index + match.length
  }
  result += content.slice(lastIdx)
  return result
}
