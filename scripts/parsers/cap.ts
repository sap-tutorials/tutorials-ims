import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CatalogTutorialMeta, CategoryMeta, Mission, MissionHierarchy, StandaloneGroup } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '..', '..', '.tutorial-cache', 'cap-catalog.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface CapCacheData {
  timestamp: number
  missions: Mission[]
  hierarchies: MissionHierarchy[]
  standaloneGroups?: StandaloneGroup[]     // optional — older caches won't have it
  categories?: CategoryMeta[]              // optional — older caches won't have it
  tutorialMetas?: CatalogTutorialMeta[]    // optional — older caches won't have it
}

export function loadCapCache(): CapCacheData | null {
  if (!existsSync(CACHE_FILE)) return null
  try {
    const data: CapCacheData = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null
    // Treat caches missing the new field as stale to force refetch.
    if (!Array.isArray(data.standaloneGroups)) return null
    return data
  } catch {
    return null
  }
}

export function saveCapCache(
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
  categories: CategoryMeta[] = [],
  tutorialMetas: CatalogTutorialMeta[] = [],
): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true })
  const data: CapCacheData = { timestamp: Date.now(), missions, hierarchies, standaloneGroups, categories, tutorialMetas }
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export async function fetchBuildCatalog(baseUrl: string): Promise<{
  missions: Mission[]
  hierarchies: MissionHierarchy[]
  standaloneGroups: StandaloneGroup[]
  categories: CategoryMeta[]
  tutorialMetas: CatalogTutorialMeta[]
}> {
  const url = `${baseUrl}/build/catalog`
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  })

  if (!res.ok) {
    throw new Error(`CAP build catalog failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as {
    missions: Mission[]
    hierarchies: MissionHierarchy[]
    standaloneGroups?: StandaloneGroup[]
    categories?: CategoryMeta[]
    tutorials?: Array<{ slug: string; categorySlugs?: string[] }>
  }
  const tutorialMetas: CatalogTutorialMeta[] = (data.tutorials ?? []).map(t => ({
    slug: t.slug,
    categorySlugs: t.categorySlugs ?? [],
  }))
  return {
    missions: data.missions,
    hierarchies: data.hierarchies,
    standaloneGroups: data.standaloneGroups ?? [],
    categories: data.categories ?? [],
    tutorialMetas,
  }
}

export async function fetchCoCompletions(
  baseUrl: string,
): Promise<Map<string, Map<string, number>>> {
  const url = `${baseUrl.replace(/\/$/, '')}/build/co-completions`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[cap.fetchCoCompletions] ${res.status} ${res.statusText} — falling back to empty`)
      return new Map()
    }
    const json = await res.json() as Record<string, Array<{ slug: string; score: number }>>
    const result = new Map<string, Map<string, number>>()
    for (const [slug, peers] of Object.entries(json)) {
      const inner = new Map<string, number>()
      for (const p of peers) inner.set(p.slug, p.score)
      result.set(slug, inner)
    }
    return result
  } catch (err) {
    console.warn(`[cap.fetchCoCompletions] failed: ${err instanceof Error ? err.message : err} — using empty map`)
    return new Map()
  }
}
