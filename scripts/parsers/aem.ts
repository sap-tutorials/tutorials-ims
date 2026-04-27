import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '..', '..', '.tutorial-cache', 'aem-missions.json')
const AEM_BASE = 'https://developers.sap.com'
const CONCURRENCY = 5
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

export interface AemMission {
  imsId: number
  title: string
  slug: string
  description: string
  level: string
  time: number
  icon: string
  tasksCount: number
}

export interface AemHierarchyGroup {
  imsId: number
  title: string
  slug: string
  description: string
  tutorialSlugs: string[]
}

export interface AemHierarchy {
  missionImsId: number
  groups: AemHierarchyGroup[]
  tutorialSlugs: string[]
}

interface AemCacheData {
  timestamp: number
  missions: AemMission[]
  hierarchies: AemHierarchy[]
}

function extractMissionSlug(publicUrl: string): string {
  const match = publicUrl?.match(/\/mission\.([^/.]+)/)
  return match?.[1] ?? ''
}

function extractGroupSlug(url: string): string {
  const match = url?.match(/\/group\.([^/.]+)/)
  return match?.[1] ?? ''
}

function extractTutorialSlug(url: string): string {
  const match = url?.match(/\/tutorials\/([^/.]+)/)
  return match?.[1] ?? ''
}

function buildExperienceMap(tags: Record<string, { title: string; tagTitle: string }>): Map<string, string> {
  const map = new Map<string, string>()
  for (const [key, value] of Object.entries(tags)) {
    if (value.tagTitle?.includes('experience/')) {
      map.set(key, value.title.toLowerCase())
    }
  }
  return map
}

async function aemFetch(path: string): Promise<Response> {
  const url = `${AEM_BASE}${path}`
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'tutorials-poc-build',
      'Accept': 'application/json',
    },
  })
  return res
}

export async function fetchAllMissions(): Promise<AemMission[]> {
  const missions: AemMission[] = []
  let experienceMap: Map<string, string> | null = null

  const query = JSON.stringify({
    rows: '300',
    start: 0,
    searchField: '',
    pagePath: '/content/developers/website/languages/en/tutorial-navigator',
    language: 'en_us',
    addDefaultLanguage: true,
    filters: [],
  })

  const res = await aemFetch(`/bin/sapdx/v3/solr/search?json=${encodeURIComponent(query)}`)
  if (!res.ok) throw new Error(`AEM search failed: ${res.status}`)

  const data = await res.json()

  if (data.tags) {
    experienceMap = buildExperienceMap(data.tags)
  }

  for (const item of data.result ?? []) {
    const slug = extractMissionSlug(item.publicUrl)
    if (!slug) continue

    missions.push({
      imsId: item.imsId,
      title: item.title?.trim(),
      slug,
      description: item.description ?? '',
      level: experienceMap?.get(item.experience) ?? 'beginner',
      time: Math.round(parseInt(item.time ?? '0', 10) / 60),
      icon: item.icon ?? '',
      tasksCount: item.tasksCount ?? 0,
    })
  }

  return missions
}

export async function fetchMissionHierarchy(imsId: number): Promise<AemHierarchy> {
  const res = await aemFetch(`/bin/sapdx/v2/tutorial/miniNavigator.${imsId}.json`)
  if (!res.ok) {
    console.warn(`  [aem-warn] miniNavigator failed for ${imsId}: ${res.status}`)
    return { missionImsId: imsId, groups: [], tutorialSlugs: [] }
  }

  const data = await res.json()
  const mission = data.context?.[0]
  if (!mission?.includes) {
    return { missionImsId: imsId, groups: [], tutorialSlugs: [] }
  }

  const groups: AemHierarchyGroup[] = []
  const directTutorials: string[] = []

  for (const item of mission.includes) {
    if (item.taskType === 'Group') {
      const groupSlug = extractGroupSlug(item.url)
      const tutorialSlugs: string[] = []

      for (const tut of item.includes ?? []) {
        if (tut.taskType === 'Tutorial') {
          const slug = extractTutorialSlug(tut.url)
          if (slug) tutorialSlugs.push(slug)
        }
      }

      groups.push({
        imsId: item.imsId,
        title: item.title?.trim(),
        slug: groupSlug,
        description: item.description ?? '',
        tutorialSlugs,
      })
    } else if (item.taskType === 'Tutorial') {
      const slug = extractTutorialSlug(item.url)
      if (slug) directTutorials.push(slug)
    }
  }

  return { missionImsId: imsId, groups, tutorialSlugs: directTutorials }
}

async function runWithConcurrency<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results: T[] = []
  let idx = 0

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++
      results[i] = await tasks[i]()
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, () => worker()))
  return results
}

export async function fetchAllMissionHierarchies(missions: AemMission[]): Promise<AemHierarchy[]> {
  const tasks = missions.map((m, idx) => async () => {
    if (idx > 0 && idx % 20 === 0) {
      console.log(`  [aem] Fetched hierarchies ${idx}/${missions.length}...`)
    }
    return fetchMissionHierarchy(m.imsId)
  })

  return runWithConcurrency(tasks, CONCURRENCY)
}

export function loadAemCache(): AemCacheData | null {
  if (!existsSync(CACHE_FILE)) return null
  try {
    const data: AemCacheData = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

export function saveAemCache(missions: AemMission[], hierarchies: AemHierarchy[]): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true })
  const data: AemCacheData = { timestamp: Date.now(), missions, hierarchies }
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}
