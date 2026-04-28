import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AemMission, AemHierarchy } from './aem.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '..', '..', '.tutorial-cache', 'cap-catalog.json')
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface CapCacheData {
  timestamp: number
  missions: AemMission[]
  hierarchies: AemHierarchy[]
}

export function loadCapCache(): CapCacheData | null {
  if (!existsSync(CACHE_FILE)) return null
  try {
    const data: CapCacheData = JSON.parse(readFileSync(CACHE_FILE, 'utf-8'))
    if (Date.now() - data.timestamp > CACHE_TTL_MS) return null
    return data
  } catch {
    return null
  }
}

export function saveCapCache(missions: AemMission[], hierarchies: AemHierarchy[]): void {
  mkdirSync(dirname(CACHE_FILE), { recursive: true })
  const data: CapCacheData = { timestamp: Date.now(), missions, hierarchies }
  writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf-8')
}

export async function fetchBuildCatalog(baseUrl: string): Promise<{ missions: AemMission[]; hierarchies: AemHierarchy[] }> {
  const url = `${baseUrl}/build/catalog`
  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' },
  })

  if (!res.ok) {
    throw new Error(`CAP build catalog failed: ${res.status} ${res.statusText}`)
  }

  const data = await res.json() as { missions: AemMission[]; hierarchies: AemHierarchy[] }
  return data
}
