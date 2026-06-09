import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { stringify as yamlStringify } from 'yaml'
import { flushDimensionsCache, populateImageDimensions, exportDimensionsForHugo } from './parsers/image-dimensions.js'
import { composeTutorial } from './parsers/compose.js'
import { discoverAllTutorials, fetchGitHubMetaBatch, fetchGitHubMeta, fetchRulesVr, fetchWithRetry, uploadDiscoveryToHana, saveDiscoveryBaseline, EXCLUDED_REPOS, type DiscoveredTutorial } from './parsers/github.js'
import { fetchBuildCatalog, fetchCoCompletions, loadCapCache, saveCapCache } from './parsers/cap.js'
import { parseRulesVrEnriched, collectAiGradedSpecs } from './parsers/rules.js'
import { expandAiAuthoredQuestions, populateAiAuthoredSiblingMaps, type ExpandStats } from './lib/expand-ai-authored.js'
import { loadAiQuizCache, saveAiQuizCache } from './lib/ai-quiz-cache.js'
import { callQuizModel } from '../srv/lib/ai-quiz-llm.js'
import { parseCodeCheckBlocks, attachCodeCheckSpecs } from './parsers/codecheck.js'
import { computeRecommendations } from './parsers/recommendations.js'
import { humanizeTag, splitPrerequisites } from './parsers/frontmatter-utils.js'
import type { TagLabelRegistry } from './parsers/frontmatter-utils.js'
import { renderHugoFrontmatter } from './parsers/render-frontmatter.js'
import type { CatalogTutorialMeta, CategoryMeta, Mission, MissionHierarchy, HierarchyGroup, StandaloneGroup, TutorialStep, TutorialNavEntry, NavData, MissionMeta, GroupRef } from './parsers/types.js'
import { QUESTION_TYPE_TEXT } from './parsers/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env file for local development (TUTORIALS_GITHUB_TOKEN, etc.)
const envPath = join(__dirname, '..', '.env')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq)
    const val = trimmed.slice(eq + 1)
    if (!process.env[key]) process.env[key] = val
  }
}

let CACHE_DIR = join(__dirname, '..', '.tutorial-cache')
const CONCURRENCY = 5

// [#208] Build-wide AI quiz generation stats. Accumulates across all
// tutorials in one fetch run; logged at the end as a one-line summary.
const globalCallStats: ExpandStats = { calls: 0, hits: 0, errors: 0 }

export type Channel = 'prod' | 'qa'

export function parseChannel(argv: string[] = process.argv): Channel {
  const idx = argv.indexOf('--channel')
  if (idx === -1) return 'prod'
  const v = argv[idx + 1]
  if (v !== 'prod' && v !== 'qa') throw new Error(`Unknown channel: ${v}`)
  return v
}

export function getQaCacheDir(channel: Channel): string {
  return channel === 'qa'
    ? join(__dirname, '..', '.tutorial-cache-qa')
    : join(__dirname, '..', '.tutorial-cache')
}

export function getHugoContentDir(channel: Channel): string {
  return channel === 'qa'
    ? join(__dirname, '..', 'hugo', 'content-qa')
    : join(__dirname, '..', 'hugo', 'content')
}

export type BuildTarget = 'vitepress' | 'hugo'

export function parseTarget(argv: string[]): BuildTarget {
  const idx = argv.indexOf('--target')
  if (idx !== -1 && idx + 1 < argv.length) {
    const val = argv[idx + 1]
    if (val === 'hugo') return 'hugo'
    if (val === 'vitepress') return 'vitepress'
    throw new Error(`Unknown target: ${val}. Must be 'vitepress' or 'hugo'.`)
  }
  return 'vitepress'
}

export function getOutputDir(target: BuildTarget, channel: Channel = 'prod'): string {
  if (target === 'hugo') return join(getHugoContentDir(channel), 'tutorials')
  return join(__dirname, '..', 'site', 'tutorials')
}

export function getNavJsonDir(target: BuildTarget, channel: Channel = 'prod'): string {
  if (target === 'hugo') {
    const staticDir = channel === 'qa' ? 'static-qa' : 'static'
    return join(__dirname, '..', 'hugo', staticDir, 'tutorials')
  }
  return join(__dirname, '..', 'site', 'tutorials')
}

interface ErrorEntry {
  slug: string
  repo: string
  error: string
  timestamp: string
}

interface TutorialTiming {
  slug: string
  repo: string
  durationMs: number
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

type CacheStatus = 'cached' | 'refreshed' | 'fetched'

async function fetchMarkdown(slug: string, repo: string, branch: string, currentSha: string): Promise<{ content: string; cacheStatus: CacheStatus }> {
  const cacheFile = join(CACHE_DIR, `${slug}.md`)
  const shaFile = join(CACHE_DIR, `${slug}.sha`)

  if (existsSync(cacheFile) && currentSha) {
    const storedSha = existsSync(shaFile) ? readFileSync(shaFile, 'utf-8').trim() : ''
    if (storedSha === currentSha) {
      return { content: readFileSync(cacheFile, 'utf-8'), cacheStatus: 'cached' }
    }
  }

  const hadCache = existsSync(cacheFile)
  const url = `https://raw.githubusercontent.com/sap-tutorials/${repo}/${branch}/tutorials/${slug}/${slug}.md`
  // raw.githubusercontent.com returns 404 (not 401) for unauthenticated reads of
  // private repos. The QA channel only fetches from -Contribution repos, all of
  // which are private — so QA fetches without GITHUB_TOKEN look like missing
  // tutorials. Pass the token through when present; public repos work either way.
  const token = process.env.GITHUB_TOKEN ?? process.env.TUTORIALS_GITHUB_TOKEN
  const headers: Record<string, string> = { 'User-Agent': 'tutorials-poc-build' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetchWithRetry(url, { headers }, { label: `raw:${slug}` })
  if (!res.ok) throw new Error(`Failed to fetch ${slug}: ${res.status}`)
  const content = await res.text()

  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cacheFile, content, 'utf-8')
  if (currentSha) writeFileSync(shaFile, currentSha, 'utf-8')

  return { content, cacheStatus: hadCache ? 'refreshed' : 'fetched' }
}

function writeVitePressPage(
  slug: string,
  title: string,
  description: string,
  time: number,
  level: string,
  tags: string[],
  primaryTag: string,
  author: string,
  authorProfile: string,
  youWillLearn: string[],
  prerequisites: string,
  steps: TutorialStep[],
  nav: TutorialNavEntry,
  lastUpdated: string,
  createdAt: string,
  contributors: Array<{ name: string; login: string; email: string; avatarUrl: string }>,
  outputDir: string,
  registry: TagLabelRegistry = {},
): void {
  const OUTPUT_DIR = outputDir
  const cleanTags = tags.map(t => t.replace(/\\/g, ''))
  const cleanPrimaryTag = primaryTag.replace(/\\/g, '')

  const dedupedRawSlugs = [...new Set([cleanPrimaryTag, ...cleanTags])].filter(s => s.length > 0)

  const fm: Record<string, unknown> = {
    layout: 'tutorial',
    slug,
    title,
    description,
    time,
    level,
    tags: cleanTags,
    primaryTag: cleanPrimaryTag,
    author,
    authorProfile,
    stepCount: steps.length,
    prev: nav.prev,
    next: nav.next,
    displayTags: dedupedRawSlugs.map(s => humanizeTag(s, registry)).filter(t => t.length > 0),
    displayTagSlugs: dedupedRawSlugs,
    youWillLearn,
    prerequisites: splitPrerequisites(prerequisites),
    lastUpdated: lastUpdated || null,
    createdAt: createdAt || null,
    contributors: contributors.slice(0, 10).map(c => ({ login: c.login, name: c.name, email: c.email, avatarUrl: c.avatarUrl })),
    steps: steps.map(s => ({ number: s.number, title: s.title })),
  }

  if (nav.missionId) fm.missionId = nav.missionId
  if (nav.missionTitle) fm.missionTitle = nav.missionTitle
  if (nav.missionSlug) fm.missionSlug = nav.missionSlug
  if (nav.groupId) fm.groupId = nav.groupId
  if (nav.groupTitle) fm.groupTitle = nav.groupTitle
  if (nav.groupSlug) fm.groupSlug = nav.groupSlug

  const frontmatter = `---\n${yamlStringify(fm).trimEnd()}\n---\n\n`

const ALLOWED_TAGS = new Set(['TutorialStep', 'OptionTabs', 'template'])

function escapeHtmlTags(text: string): string {
  return text
    .replace(/<(\/?)\s*([a-zA-Z][a-zA-Z0-9:._-]*)[^>]*\/?>/g, (match, _slash: string, tagName: string) => {
      if (ALLOWED_TAGS.has(tagName)) return match
      return match.replace(/</g, '&lt;').replace(/>/g, '&gt;')
    })
    .replace(/<\?[^>]*\?>/g, (match) => match.replace(/</g, '&lt;').replace(/>/g, '&gt;'))
    .replace(/\{\{/g, '&#123;&#123;')
    .replace(/\}\}/g, '&#125;&#125;')
}

function sanitizeStepContent(content: string): string {
  const lines = content.split('\n')
  let inCodeFence = false
  let fenceChar = ''
  let fenceLen = 0
  let fenceIndent = 0

  const result = lines.map(line => {
    if (inCodeFence) {
      const closeMatch = line.match(/^(\s*)(```+|~~~+)\s*$/)
      if (closeMatch && closeMatch[2].charAt(0) === fenceChar && closeMatch[2].length >= fenceLen) {
        inCodeFence = false
        return closeMatch[2]
      }
      if (fenceIndent > 0 && line.length > 0) {
        const stripped = line.replace(new RegExp(`^ {0,${fenceIndent}}`), '')
        return stripped
      }
      return line
    }

    const openMatch = line.match(/^(\s*)(```+|~~~+)(.*)$/)
    if (openMatch) {
      inCodeFence = true
      fenceChar = openMatch[2].charAt(0)
      fenceLen = openMatch[2].length
      fenceIndent = openMatch[1].length
      return openMatch[2] + openMatch[3]
    }

    return escapeHtmlTags(line)
  })

  return result.join('\n')
}

function balanceComponentTags(content: string): string {
  const tagStack: string[] = []
  const opens: Array<{ tag: string; idx: number }> = []
  const closes: Array<{ tag: string; idx: number; len: number }> = []

  const openRe = /<(OptionTabs|template)[\s>]/g
  const closeRe = /<\/(OptionTabs|template)\s*>/g

  let m
  while ((m = openRe.exec(content)) !== null) {
    opens.push({ tag: m[1], idx: m.index })
  }
  while ((m = closeRe.exec(content)) !== null) {
    closes.push({ tag: m[1], idx: m.index, len: m[0].length })
  }

  const openStack: string[] = []
  const orphanCloses: Array<{ idx: number; len: number }> = []

  const all = [
    ...opens.map(o => ({ ...o, type: 'open' as const, len: 0 })),
    ...closes.map(c => ({ ...c, type: 'close' as const })),
  ].sort((a, b) => a.idx - b.idx)

  for (const item of all) {
    if (item.type === 'open') {
      openStack.push(item.tag)
    } else {
      const lastIdx = openStack.lastIndexOf(item.tag)
      if (lastIdx !== -1) {
        openStack.splice(lastIdx, 1)
      } else {
        orphanCloses.push({ idx: item.idx, len: item.len })
      }
    }
  }

  let result = content
  for (const orphan of orphanCloses.reverse()) {
    result = result.slice(0, orphan.idx) + result.slice(orphan.idx + orphan.len)
  }

  let suffix = ''
  for (let i = openStack.length - 1; i >= 0; i--) {
    suffix += `\n</${openStack[i]}>`
  }
  return suffix ? result + suffix : result
}

  const stepsMd = steps.map(step =>
    `<TutorialStep :number="${step.number}" title="${step.title.replace(/"/g, '&quot;')}" slug="${slug}">\n\n${balanceComponentTags(sanitizeStepContent(step.content))}\n\n</TutorialStep>`
  ).join('\n\n')

  const content = `${frontmatter}${stepsMd}\n`

  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(join(OUTPUT_DIR, `${slug}.md`), content, 'utf-8')
}

export function writeHugoPage(
  slug: string,
  title: string,
  description: string,
  time: number,
  level: string,
  tags: string[],
  primaryTag: string,
  author: string,
  authorProfile: string,
  youWillLearn: string[],
  prerequisites: string,
  steps: TutorialStep[],
  nav: TutorialNavEntry,
  lastUpdated: string,
  createdAt: string,
  contributors: Array<{ name: string; login: string; email: string; avatarUrl: string }>,
  outputDir: string,
  registry: TagLabelRegistry = {},
  hasOsOptions: boolean = false,
): void {
  const content = renderHugoFrontmatter({
    slug,
    title,
    description,
    time,
    level,
    tags,
    primaryTag,
    author,
    authorProfile,
    youWillLearn,
    prerequisites,
    steps,
    nav,
    lastUpdated,
    createdAt,
    contributors,
    registry,
    hasOsOptions,
  })

  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, `${slug}.md`), content, 'utf-8')
}

function serializeYamlValue(val: string | number | string[] | null): string {
  if (val === null) return 'null'
  if (Array.isArray(val)) return `\n${val.map(s => `  - ${JSON.stringify(s)}`).join('\n')}`
  if (typeof val === 'string') return JSON.stringify(val)
  return String(val)
}

function patchTutorialFrontmatter(slug: string, nav: TutorialNavEntry, outputDir: string, target: BuildTarget = 'vitepress'): void {
  const filePath = join(outputDir, `${slug}.md`)
  if (!existsSync(filePath)) return

  const raw = readFileSync(filePath, 'utf-8')
  const endOfFm = raw.indexOf('\n---\n\n', 4)
  if (endOfFm === -1) return

  const body = raw.slice(endOfFm + 6)
  const fmBlock = raw.slice(4, endOfFm)
  const lines = fmBlock.split('\n')

  const patchFields: Record<string, string | number | string[] | null> = {
    prev: nav.prev,
    next: nav.next,
  }
  if (nav.missionId) patchFields.missionId = nav.missionId
  if (nav.missionTitle) patchFields.missionTitle = nav.missionTitle
  if (nav.missionSlug) patchFields.missionSlug = nav.missionSlug
  if (nav.groupId) patchFields.groupId = nav.groupId
  if (nav.groupTitle) patchFields.groupTitle = nav.groupTitle
  if (nav.groupSlug) patchFields.groupSlug = nav.groupSlug
  if (nav.recommendations && nav.recommendations.length > 0) {
    patchFields.recommendations = nav.recommendations
  }

  const existingKeys = new Set(lines.map(l => l.match(/^(\w+):/)?.[1]).filter(Boolean))
  const updatedLines = lines.map(line => {
    const keyMatch = line.match(/^(\w+):/)
    if (keyMatch && keyMatch[1] in patchFields) {
      const val = patchFields[keyMatch[1]]
      return `${keyMatch[1]}: ${serializeYamlValue(val)}`
    }
    return line
  })

  for (const [key, val] of Object.entries(patchFields)) {
    if (!existingKeys.has(key)) {
      updatedLines.push(`${key}: ${serializeYamlValue(val)}`)
    }
  }

  const content = `---\n${updatedLines.join('\n')}\n---\n\n${body}`
  writeFileSync(filePath, content, 'utf-8')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = ((ms % 60_000) / 1000).toFixed(1)
  return `${mins}m ${secs}s`
}

async function fetchTagLabelRegistry(): Promise<TagLabelRegistry> {
  const capBaseUrl = process.env.CAP_BASE_URL ?? 'http://localhost:4004'
  const url = `${capBaseUrl}/build/tag-labels`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.warn(`[tag-labels] ${url} returned ${res.status} — falling back to heuristic for all tags`)
      return {}
    }
    const map = await res.json() as TagLabelRegistry
    console.log(`[tag-labels] loaded ${Object.keys(map).length} (slug, label) pairs from ${url}`)
    return map
  } catch (e) {
    console.warn(`[tag-labels] fetch failed (${(e as Error).message}) — falling back to heuristic for all tags`)
    return {}
  }
}

async function main() {
  const totalStart = performance.now()
  const regenerateMode = process.argv.includes('--regenerate')
  const discoverOnly = process.argv.includes('--discover-only')
  const tutorialSlugFilter = (process.env.TUTORIAL_SLUG ?? '').trim() || null
  const target = parseTarget(process.argv)
  const channel = parseChannel(process.argv)
  // QA channel: discover only -Contribution repos via inverse filter in github.ts.
  // Set BEFORE discoverAllTutorials() runs so the filter sees the env var.
  if (channel === 'qa') process.env.ONLY_CONTRIBUTION_REPOS = 'true'
  // Reassign module-level CACHE_DIR so fetchMarkdown() and helper functions
  // referencing it transparently use the channel-specific cache.
  CACHE_DIR = getQaCacheDir(channel)
  const OUTPUT_DIR = getOutputDir(target, channel)
  const NAV_JSON_DIR = getNavJsonDir(target, channel)

  // Defense-in-depth: write a .channel marker into the cache dir so an accidental
  // cross-channel run is detectable post-hoc.
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(join(CACHE_DIR, '.channel'), channel, 'utf-8')

  console.log(`[channel] ${channel} (cache: ${CACHE_DIR}, content: ${OUTPUT_DIR})\n`)

  let allTutorials: DiscoveredTutorial[]
  let discoveryMs = 0
  let metaMs = 0

  const DISCOVERY_CACHE = join(CACHE_DIR, '_discovery.json')

  if (discoverOnly) {
    if (!process.env.GITHUB_TOKEN && !process.env.TUTORIALS_GITHUB_TOKEN) {
      console.error('ERROR: GITHUB_TOKEN or TUTORIALS_GITHUB_TOKEN is required for --discover-only.')
      process.exit(1)
    }
    console.log('Running DISCOVERY ONLY mode (builds repo mapping for image URLs)\n')
    const discoveryStart = performance.now()
    const { tutorials: discovered } = await discoverAllTutorials()
    const discoveryMap: Record<string, { slug: string; repo: string; branch: string }> = {}
    for (const t of discovered) discoveryMap[t.slug] = t
    mkdirSync(dirname(DISCOVERY_CACHE), { recursive: true })
    writeFileSync(DISCOVERY_CACHE, JSON.stringify(discoveryMap, null, 2), 'utf-8')
    console.log(`\nSaved discovery map for ${discovered.length} tutorials to ${DISCOVERY_CACHE}`)
    console.log(`Done in ${formatDuration(performance.now() - discoveryStart)}`)
    return
  }

  if (regenerateMode) {
    console.log('Running in REGENERATE mode (from cache only, no GitHub API calls)\n')
    const cachedFiles = existsSync(CACHE_DIR)
      ? readdirSync(CACHE_DIR).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''))
      : []
    if (cachedFiles.length === 0) {
      console.error('ERROR: No cached tutorials found. Run without --regenerate first.')
      process.exit(1)
    }
    const discoveryMap: Record<string, { slug: string; repo: string; branch: string }> = existsSync(DISCOVERY_CACHE)
      ? JSON.parse(readFileSync(DISCOVERY_CACHE, 'utf-8'))
      : {}
    allTutorials = cachedFiles.map(slug => discoveryMap[slug] || { slug, repo: 'unknown', branch: 'main' })
    const unknownCount = allTutorials.filter(t => t.repo === 'unknown').length
    if (unknownCount > 0) {
      console.warn(`WARNING: ${unknownCount}/${allTutorials.length} tutorials have unknown repo (images will break).`)
      console.warn(`  Run with --discover-only first to build the repo mapping.\n`)
    }
    console.log(`Found ${allTutorials.length} cached tutorials\n`)
  } else {
    if (!process.env.GITHUB_TOKEN && !process.env.TUTORIALS_GITHUB_TOKEN) {
      console.error('ERROR: GITHUB_TOKEN or TUTORIALS_GITHUB_TOKEN is required for the GraphQL API.')
      console.error('  Set the token in .env or as an environment variable.')
      console.error('  Or use --regenerate to rebuild from cache.\n')
      process.exit(1)
    }

    // ── Phase 1: Discovery via GraphQL ──
    console.log('Phase 1: Discovering tutorials via GraphQL...\n')
    const discoveryStart = performance.now()

    const discovery = await discoverAllTutorials()
    allTutorials = discovery.tutorials
    discoveryMs = performance.now() - discoveryStart

    // Persist discovery mapping so --regenerate can resolve image URLs
    const discoveryMap: Record<string, { slug: string; repo: string; branch: string }> = {}
    for (const t of allTutorials) discoveryMap[t.slug] = t
    mkdirSync(dirname(DISCOVERY_CACHE), { recursive: true })
    writeFileSync(DISCOVERY_CACHE, JSON.stringify(discoveryMap, null, 2), 'utf-8')

    // Only refresh HANA RepoCatalog when discovery came from GitHub AND the run
    // covers all tutorials AND we're on the prod channel. The discovery baseline
    // (disk + HANA RepoCatalog) is a prod artifact: QA's Contribution-only repo
    // set must never poison the prod fallback list. Uploading disk/HANA fallback
    // data would also advance lastSyncedAt and falsely signal freshness during a
    // prolonged GitHub outage. Slug-filtered runs are partial by design.
    if (channel !== 'prod') {
      console.log(`[fetch-tutorials] channel=${channel} — skipping discovery baseline + HANA RepoCatalog upload (prod-only artifact)`)
    } else if (discovery.source === 'github' && !tutorialSlugFilter) {
      await uploadDiscoveryToHana(allTutorials)
      // Same staleness reasoning applies to the committed baseline snapshot:
      // only refresh from authoritative GraphQL data, never from fallback paths.
      saveDiscoveryBaseline(allTutorials)
    } else if (tutorialSlugFilter) {
      console.log(`  [repo-catalog] skipping HANA upload — single-slug refresh is a partial run`)
    } else {
      console.log(`  [repo-catalog] skipping HANA upload — discovery came from ${discovery.source} fallback`)
    }

    console.log(`\nDiscovered ${allTutorials.length} tutorials (${formatDuration(discoveryMs)})\n`)

    // Validate slug filter and bust its markdown cache so it gets re-fetched.
    // Other tutorials will be regenerated from cached markdown (see Phase 3).
    if (tutorialSlugFilter) {
      const match = allTutorials.find(t => t.slug === tutorialSlugFilter)
      if (!match) {
        console.error(`ERROR: TUTORIAL_SLUG="${tutorialSlugFilter}" not found in discovered tutorials.`)
        console.error(`  Discovery returned ${allTutorials.length} slugs from source: ${discovery.source}`)
        process.exit(1)
      }
      const targetCacheFile = join(CACHE_DIR, `${tutorialSlugFilter}.md`)
      if (existsSync(targetCacheFile)) {
        unlinkSync(targetCacheFile)
        console.log(`[slug-filter] busted cache for ${tutorialSlugFilter} (${match.repo}@${match.branch}) — will be re-fetched`)
      } else {
        console.log(`[slug-filter] no cache to bust for ${tutorialSlugFilter} — fresh fetch will run`)
      }
      console.log(`[slug-filter] ${allTutorials.length - 1} other tutorials will be regenerated from cache\n`)
    }

    // ── Phase 2: Batch prefetch GitHub metadata via GraphQL ──
    console.log('Phase 2: Prefetching GitHub metadata (batched GraphQL)...\n')
    const metaStart = performance.now()

    const byRepo = new Map<string, DiscoveredTutorial[]>()
    for (const t of allTutorials) {
      const list = byRepo.get(t.repo) ?? []
      list.push(t)
      byRepo.set(t.repo, list)
    }

    const metaTasks = Array.from(byRepo.entries()).map(([repo, tuts]) => async () => {
      const branch = tuts[0].branch
      const slugs = tuts.map(t => t.slug)
      console.log(`  ${repo}: ${slugs.length} tutorials...`)
      await fetchGitHubMetaBatch(repo, branch, slugs)
    })

    await runWithConcurrency(metaTasks, 3)

    metaMs = performance.now() - metaStart
    console.log(`\nMetadata prefetch complete (${formatDuration(metaMs)})\n`)
  }

  // ── Phase 3: Process tutorials (fetch markdown, parse, generate pages) ──
  console.log('Phase 3: Processing tutorials...\n')
  const processStart = performance.now()

  // Fetch tag label registry once before the tutorial loop.
  // An empty map is returned on failure; all tags fall back to the heuristic.
  const tagRegistry = await fetchTagLabelRegistry()

  mkdirSync(OUTPUT_DIR, { recursive: true })

  const navEntries: TutorialNavEntry[] = []
  const errors: ErrorEntry[] = []
  const timings: TutorialTiming[] = []
  let successCount = 0
  let cacheHits = 0
  let cacheRefreshes = 0
  let cacheFetches = 0

  const tasks = allTutorials.map((t, idx) => async () => {
    const tutStart = performance.now()
    const label = `[${idx + 1}/${allTutorials.length}] ${t.repo}/${t.slug}`
    try {
      let rawMd: string
      let lastUpdated = ''
      let createdAt = ''
      let contributors: Array<{ name: string; login: string; email: string; avatarUrl: string }> = []

      if (regenerateMode || (tutorialSlugFilter && t.slug !== tutorialSlugFilter)) {
        const cacheFile = join(CACHE_DIR, `${t.slug}.md`)
        if (!existsSync(cacheFile)) throw new Error(`Cache file not found: ${cacheFile}`)
        rawMd = readFileSync(cacheFile, 'utf-8')
        const ghMeta = await fetchGitHubMeta(t.slug, t.repo, t.branch)
        lastUpdated = ghMeta.lastUpdated
        createdAt = ghMeta.createdAt
        contributors = ghMeta.contributors
        cacheHits++
        console.log(`${label} [cached]`)
      } else {
        const ghMeta = await fetchGitHubMeta(t.slug, t.repo, t.branch)
        const { content, cacheStatus } = await fetchMarkdown(t.slug, t.repo, t.branch, ghMeta.lastCommitSha)
        rawMd = content
        lastUpdated = ghMeta.lastUpdated
        createdAt = ghMeta.createdAt
        contributors = ghMeta.contributors

        if (cacheStatus === 'cached') cacheHits++
        else if (cacheStatus === 'refreshed') cacheRefreshes++
        else cacheFetches++

        console.log(`${label} [${cacheStatus}]`)
      }

      const composed = composeTutorial(rawMd, {
        repo: t.repo, branch: t.branch, slug: t.slug, target, rewriteImages: true,
      })
      const { title, description, youWillLearn, prerequisites, level, frontmatter } = composed

      // Populate intrinsic-dimension cache for the Hugo render-image hook.
      // The hook reads site.Data.image_dimensions to emit width/height attrs;
      // markdown attribute syntax can't be used because goldmark renders it
      // as literal text for inline images.
      if (target === 'hugo') {
        await populateImageDimensions(composed.body)
      }

      const steps = composed.steps

      // Fetch and attach validation questions from rules.vr
      const rulesContent = await fetchRulesVr(t.slug, t.repo, t.branch)
      if (rulesContent) {
        const { map: validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId, allDirective, handAuthoredSteps } = parseRulesVrEnriched(rulesContent)

        // [#208] AI-authored quiz expansion. Behind AI_AUTHOR_ENABLED env flag;
        // hard-capped at AI_AUTHOR_BUILD_CAP per build. Cache lives at
        // .tutorial-cache/<slug>.ai-quiz-cache.json. See:
        // docs/superpowers/specs/2026-06-05-208-ai-authored-quizzes-design.md
        if (process.env.AI_AUTHOR_ENABLED === 'true') {
          // TutorialStep type has `.number` + `.content` fields (per
          // scripts/parsers/types.ts — verified during plan review). Use
          // `s.content`, NOT `s.body`.
          const stepBodies = new Map<number, string>(
            steps.map(s => [s.number, s.content ?? '']),
          )
          const aiCache = loadAiQuizCache(t.slug)
          await expandAiAuthoredQuestions(validationMap, stepBodies, {
            cache: aiCache,
            callModel: callQuizModel,
            onCallStats: globalCallStats,
            allDirective,
            // [#208 precedence-fix] forward the set of hand-authored steps
            // so AI never fires on top of regex-substring or other [VALIDATE_N]
            // blocks where parseBlock returned [].
            handAuthoredSteps,
          })
          saveAiQuizCache(t.slug, aiCache)
        }

        // [#208] Populate sibling maps for AI-authored text questions so
        // collectAiGradedSpecs (below) emits the validate-answer-spec
        // sidecar. parseBlock populates these for hand-authored questions;
        // AI-authored ones arrive after parseRulesVrEnriched returns.
        // No-op when no AI-authored questions exist (flag off, or no
        // [AUTOAUTHOR_*] directives in rules.vr).
        populateAiAuthoredSiblingMaps(validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId)

        const testSteps = steps.filter(s => /^test yourself$/i.test(s.title))
        for (const [validateNum, questions] of validationMap) {
          if (!questions.length) continue
          // Prefer a dedicated "Test yourself" step at or after position N (legacy / aggregated style).
          // If none exists, attach inline to the step whose number matches validateNum
          // (V2 sources with auto_validation: false use [VALIDATE_N] markers per step).
          const target = testSteps.find(s => s.number >= validateNum)
            ?? testSteps[testSteps.length - 1]
            ?? steps.find(s => s.number === validateNum)
          if (target) {
            target.validation = [...(target.validation ?? []), ...questions]
          }
        }

        // Collect AI-graded specs (issue #209) and write sibling sidecar.
        // The sidecar carries the reference answer + ruleType server-side
        // (publish pipeline, Task 8); the public Hugo frontmatter never
        // includes correctAnswer for AI-graded questions (anti-leak).
        const aiGradedSpecs = collectAiGradedSpecs(validationMap, ruleTypeByStepAndId, correctAnswerByStepAndId)
        if (aiGradedSpecs.length > 0) {
          const validateSidecarPath = join(CACHE_DIR, `${t.slug.toLowerCase()}.validate-answer.json`)
          // Lowercase the slug in the JSON payload + filename: Tutorials.slug
          // in HANA is lowercase canonical. Source directories like extend-RAP-App
          // produce mixed-case t.slug; the publish path matches against the
          // lowercase HANA row.
          writeFileSync(validateSidecarPath, JSON.stringify({ slug: t.slug.toLowerCase(), specs: aiGradedSpecs }, null, 2))
        }

        // [#208] Anti-leak strip: AI-authored text questions had correctAnswer
        // restored on validationMap so populateAiAuthoredSiblingMaps (above)
        // could mirror it into correctAnswerByStepAndId, which collectAiGradedSpecs
        // reads. The reference is now in HANA via the validate-answer sidecar;
        // the public Hugo frontmatter must NOT carry it. Strip correctAnswer
        // from any text question with aiAuthored: true.
        //
        // (Hand-authored aiGrading: true text questions are already stripped
        // upstream by parseRulesVrEnriched per #209's existing anti-leak path —
        // only the AI-authored ones need this extra strip because they took the
        // scenic route to support both consumers.)
        for (const [, questions] of validationMap) {
          for (const q of questions) {
            if (q.aiAuthored && q.type === QUESTION_TYPE_TEXT) {
              delete q.correctAnswer
            }
          }
        }

        const codeCheckMap = parseCodeCheckBlocks(rulesContent)
        if (codeCheckMap.size) {
          const sidecar = attachCodeCheckSpecs(steps, codeCheckMap)
          if (sidecar.length) {
            const sidecarPath = join(CACHE_DIR, `${t.slug.toLowerCase()}.codecheck.json`)
            // Lowercase the slug in the JSON payload: Tutorials.slug in HANA is lowercase
            // canonical (see CLAUDE.md gotcha "Tutorial slugs are lowercase canonical").
            // Source directories like extend-RAP-App produce mixed-case t.slug; the
            // Task 2.1 publish path matches against the lowercase HANA row, so a
            // mixed-case slug here would cause spec_missing at runtime.
            writeFileSync(sidecarPath, JSON.stringify({ slug: t.slug.toLowerCase(), specs: sidecar }, null, 2))
          }
        }
      }

      const rawNavSlugs = [...new Set([frontmatter.primary_tag ?? '', ...(frontmatter.tags ?? [])])]
        .map(s => s.replace(/\\/g, '')).filter(s => s.length > 0)

      const nav: TutorialNavEntry = {
        slug: t.slug,
        title,
        description,
        time: frontmatter.time ?? 15,
        level,
        stepCount: steps.length,
        primaryTag: humanizeTag(frontmatter.primary_tag ?? '', tagRegistry),
        displayTags: rawNavSlugs.map(s => humanizeTag(s, tagRegistry)).filter(tag => tag.length > 0),
        displayTagSlugs: rawNavSlugs,
        repo: t.repo,
        branch: t.branch,
        prev: null,
        next: null,
        createdAt: createdAt || undefined,
      }

      if (target === 'hugo') {
        writeHugoPage(
          t.slug,
          title,
          description,
          frontmatter.time ?? 15,
          level,
          frontmatter.tags ?? [],
          frontmatter.primary_tag ?? '',
          frontmatter.author_name ?? 'Unknown',
          frontmatter.author_profile ?? '',
          youWillLearn,
          prerequisites,
          steps,
          nav,
          lastUpdated,
          createdAt,
          contributors,
          OUTPUT_DIR,
          tagRegistry,
          composed.hasOsOptions,
        )
      } else {
        writeVitePressPage(
          t.slug,
          title,
          description,
          frontmatter.time ?? 15,
          level,
          frontmatter.tags ?? [],
          frontmatter.primary_tag ?? '',
          frontmatter.author_name ?? 'Unknown',
          frontmatter.author_profile ?? '',
          youWillLearn,
          prerequisites,
          steps,
          nav,
          lastUpdated,
          createdAt,
          contributors,
          OUTPUT_DIR,
          tagRegistry,
        )
      }

      navEntries.push(nav)
      successCount++

      const tutMs = performance.now() - tutStart
      timings.push({ slug: t.slug, repo: t.repo, durationMs: tutMs })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push({ slug: t.slug, repo: t.repo, error: message, timestamp: new Date().toISOString() })
      console.error(`  ✗ ${label}: ${message}`)

      const tutMs = performance.now() - tutStart
      timings.push({ slug: t.slug, repo: t.repo, durationMs: tutMs })
    }
  })

  await runWithConcurrency(tasks, CONCURRENCY)
  const processMs = performance.now() - processStart

  // ── Phase 4: Missions & Groups from CAP ──
  console.log('\nPhase 4: Fetching missions & groups from CAP...\n')
  const capStart = performance.now()

  let missions: Mission[] = []
  let hierarchies: MissionHierarchy[] = []
  let standaloneGroups: StandaloneGroup[] = []
  let categories: CategoryMeta[] = []
  let tutorialMetas: CatalogTutorialMeta[] = []
  let capCacheUsed = false
  let coCompletions: Map<string, Map<string, number>> = new Map()

  const forceRefresh = process.argv.includes('--force-cap')
  const cached = forceRefresh ? null : loadCapCache()

  if (cached) {
    missions = cached.missions
    hierarchies = cached.hierarchies
    standaloneGroups = cached.standaloneGroups ?? []
    categories = cached.categories ?? []
    tutorialMetas = cached.tutorialMetas ?? []
    capCacheUsed = true
    console.log(`  [cap] Using cached data (${missions.length} missions, ${standaloneGroups.length} standalone groups)`)
  } else {
    try {
      const capBaseUrl = process.env.CAP_BASE_URL || 'http://localhost:4004'
      const catalog = await fetchBuildCatalog(capBaseUrl)
      missions = catalog.missions
      hierarchies = catalog.hierarchies
      standaloneGroups = catalog.standaloneGroups
      categories = catalog.categories
      tutorialMetas = catalog.tutorialMetas
      saveCapCache(missions, hierarchies, standaloneGroups, categories, tutorialMetas)
      console.log(`  [cap] Fetched ${missions.length} missions, ${standaloneGroups.length} standalone groups`)
      coCompletions = await fetchCoCompletions(capBaseUrl)
      console.log(`  [cap] co-completion map: ${coCompletions.size} source slugs`)
    } catch (err) {
      // Fail loudly. A silent fall-through to "0 missions" produced builds
      // where every Group/Mission page was missing — every navigator link
      // then hit the runtime DB-render fallback (issue #77). The script must
      // fail so CI doesn't ship a half-built site. Set ALLOW_EMPTY_CAP=1
      // only for the rare smoke test that genuinely wants no mission/group
      // pages.
      const msg = err instanceof Error ? err.message : String(err)
      if (process.env.ALLOW_EMPTY_CAP === '1') {
        console.warn(`  [cap-warn] CAP fetch failed: ${msg}`)
        console.warn('  [cap-warn] ALLOW_EMPTY_CAP=1 — continuing without missions/groups')
      } else {
        console.error(`\n  [cap-error] CAP fetch failed: ${msg}`)
        console.error(`  [cap-error] CAP_BASE_URL=${process.env.CAP_BASE_URL || 'http://localhost:4004'}`)
        console.error('  [cap-error] Hugo build would emit 0 mission/group pages — refusing to continue.')
        console.error('  [cap-error] Set CAP_BASE_URL to a reachable srv, or pass ALLOW_EMPTY_CAP=1 to opt out.\n')
        throw err
      }
    }
  }

  const navBySlug = new Map(navEntries.map(n => [n.slug, n]))
  const missionsMeta: MissionMeta[] = []
  const allGroupRefs: GroupRef[] = []
  let matchedTutorials = 0
  let unmatchedTutorials = 0

  for (const mission of missions) {
    const hierarchy = hierarchies.find(h => h.missionImsId === mission.imsId)
    if (!hierarchy) continue

    const missionGroups: GroupRef[] = []
    const isFlat = hierarchy.groups.length === 0 && hierarchy.tutorialSlugs.length > 0

    const groupsToProcess: HierarchyGroup[] = isFlat
      ? [{
          imsId: mission.imsId,
          title: mission.title,
          slug: mission.slug,
          description: mission.description,
          tutorialSlugs: hierarchy.tutorialSlugs,
        }]
      : hierarchy.groups

    for (const group of groupsToProcess) {
      const groupRef: GroupRef = {
        id: group.imsId,
        title: group.title,
        slug: group.slug,
        missionId: mission.imsId,
        tutorials: [],
      }

      for (let i = 0; i < group.tutorialSlugs.length; i++) {
        const tSlug = group.tutorialSlugs[i]
        const nav = navBySlug.get(tSlug)
        if (!nav) {
          unmatchedTutorials++
          continue
        }

        matchedTutorials++
        groupRef.tutorials.push(tSlug)

        nav.missionId = mission.imsId
        nav.missionTitle = mission.title
        nav.missionSlug = mission.slug
        if (!isFlat) {
          nav.groupId = group.imsId
          nav.groupTitle = group.title
          nav.groupSlug = group.slug
        }

        const prevSlug = i > 0 ? group.tutorialSlugs[i - 1] : null
        const nextSlug = i < group.tutorialSlugs.length - 1 ? group.tutorialSlugs[i + 1] : null
        if (prevSlug && navBySlug.has(prevSlug)) nav.prev = prevSlug
        if (nextSlug && navBySlug.has(nextSlug)) nav.next = nextSlug
      }

      missionGroups.push(groupRef)
      if (!isFlat) {
        allGroupRefs.push(groupRef)
      }
    }

    // [#172] Surface alt-groups so PR 3's hydration island and Task 7's
    // mission-side-nav partial can read them from `_nav.json`. isFlat
    // missions carry altGroups on the hierarchy itself; non-flat missions
    // carry them on inner HierarchyGroup entries.
    const collectedAltGroups = hierarchy.altGroups?.length
      ? hierarchy.altGroups
      : hierarchy.groups.flatMap(g => g.altGroups ?? [])

    missionsMeta.push({
      id: mission.imsId,
      title: mission.title,
      slug: mission.slug,
      groups: missionGroups,
      ...(collectedAltGroups.length ? { altGroups: collectedAltGroups } : {}),
    })
  }

  for (const sg of standaloneGroups) {
    const groupRef: GroupRef = {
      id: sg.imsId,
      title: sg.title,
      slug: sg.slug,
      missionId: 0,  // sentinel: standalone group, no parent mission
      tutorials: [],
    }

    for (let i = 0; i < sg.tutorialSlugs.length; i++) {
      const tSlug = sg.tutorialSlugs[i]
      const nav = navBySlug.get(tSlug)
      if (!nav) {
        unmatchedTutorials++
        continue
      }
      matchedTutorials++
      groupRef.tutorials.push(tSlug)

      nav.groupId = sg.imsId
      nav.groupTitle = sg.title
      nav.groupSlug = sg.slug

      const prevSlug = i > 0 ? sg.tutorialSlugs[i - 1] : null
      const nextSlug = i < sg.tutorialSlugs.length - 1 ? sg.tutorialSlugs[i + 1] : null
      if (prevSlug && navBySlug.has(prevSlug)) nav.prev = prevSlug
      if (nextSlug && navBySlug.has(nextSlug)) nav.next = nextSlug
    }

    allGroupRefs.push(groupRef)
  }

  const recommendations = computeRecommendations(navEntries, { coCompletions })
  for (const nav of navEntries) {
    const recs = recommendations.get(nav.slug) ?? []
    if (recs.length > 0) nav.recommendations = recs
  }

  let patchedCount = 0
  for (const nav of navEntries) {
    if (nav.missionId || nav.prev || nav.next || nav.recommendations) {
      patchTutorialFrontmatter(nav.slug, nav, OUTPUT_DIR, target)
      patchedCount++
    }
  }

  const capMs = performance.now() - capStart
  console.log(`\nCAP phase complete: ${missions.length} missions, ${allGroupRefs.length} groups, ${matchedTutorials} tutorials matched, ${unmatchedTutorials} unmatched, ${patchedCount} pages patched (${formatDuration(capMs)})`)

  // Task 2.1: emit hugo/data/browse.json for /browse/ SSR (issue #174 PR 2).
  // Skip when catalog data is empty (ALLOW_EMPTY_CAP=1 path) — /browse/
  // degrades gracefully if browse.json is missing, and we don't want to
  // ship an empty rail file from a deliberately-degraded build.
  if (missions.length > 0) {
    try {
      writeBrowseData(navEntries, missions, hierarchies, standaloneGroups, categories, tutorialMetas)
    } catch (err) {
      // Non-fatal — don't block the existing build pipeline on this.
      console.warn(`  [browse] writeBrowseData failed: ${err instanceof Error ? err.message : err}`)
    }
  } else {
    console.log('  [browse] skipped (no missions loaded — ALLOW_EMPTY_CAP path)')
  }

  // ── Phase 5: Write outputs ──
  navEntries.sort((a, b) => a.slug.localeCompare(b.slug))

  const navData: NavData = {
    tutorials: navEntries,
    missions: missionsMeta,
    groups: allGroupRefs,
  }

  const navJsonDir = NAV_JSON_DIR
  mkdirSync(navJsonDir, { recursive: true })
  const navPath = join(navJsonDir, '_nav.json')
  writeFileSync(navPath, JSON.stringify(navData, null, 2), 'utf-8')

  if (target === 'vitepress') {
    // Also write to public/ so VitePress copies it to dist as a static asset
    const publicNavDir = join(__dirname, '..', 'site', 'public', 'tutorials')
    mkdirSync(publicNavDir, { recursive: true })
    writeFileSync(join(publicNavDir, '_nav.json'), JSON.stringify(navData, null, 2), 'utf-8')
  }

  // Write error log
  if (errors.length > 0) {
    mkdirSync(CACHE_DIR, { recursive: true })
    const errorPath = join(CACHE_DIR, 'errors.json')
    writeFileSync(errorPath, JSON.stringify(errors, null, 2), 'utf-8')
    console.log(`\nError log written to ${errorPath}`)
  }

  // ── Timing Summary ──
  const totalMs = performance.now() - totalStart
  const sortedTimings = [...timings].sort((a, b) => b.durationMs - a.durationMs)
  const avgMs = timings.length > 0 ? timings.reduce((s, t) => s + t.durationMs, 0) / timings.length : 0

  console.log('\n' + '═'.repeat(60))
  console.log('  BUILD SUMMARY')
  console.log('═'.repeat(60))
  console.log(`  Tutorials:  ${successCount} succeeded, ${errors.length} failed`)
  console.log(`  Cache:      ${cacheHits} cached, ${cacheRefreshes} refreshed, ${cacheFetches} fetched`)
  console.log(`  Missions:   ${missionsMeta.length} missions, ${allGroupRefs.length} groups`)
  console.log(`  Mapping:    ${matchedTutorials} tutorials mapped, ${unmatchedTutorials} unmatched`)
  console.log('─'.repeat(60))
  console.log('  PHASE TIMING')
  console.log(`    Discovery (GraphQL):     ${formatDuration(discoveryMs)}`)
  console.log(`    Metadata prefetch:       ${formatDuration(metaMs)}`)
  console.log(`    Tutorial processing:     ${formatDuration(processMs)}`)
  console.log(`    CAP missions/groups:     ${formatDuration(capMs)}${capCacheUsed ? ' (cached)' : ''}`)
  console.log(`    Total:                   ${formatDuration(totalMs)}`)
  console.log('─'.repeat(60))
  console.log('  PER-TUTORIAL STATS')
  console.log(`    Average:   ${formatDuration(avgMs)}`)
  if (sortedTimings.length > 0) {
    console.log(`    Slowest:   ${formatDuration(sortedTimings[0].durationMs)} (${sortedTimings[0].repo}/${sortedTimings[0].slug})`)
    console.log(`    Fastest:   ${formatDuration(sortedTimings[sortedTimings.length - 1].durationMs)} (${sortedTimings[sortedTimings.length - 1].repo}/${sortedTimings[sortedTimings.length - 1].slug})`)
  }
  console.log(`    Throughput: ${(timings.length / (totalMs / 1000)).toFixed(1)} tutorials/sec`)
  console.log('─'.repeat(60))

  if (errors.length > 0) {
    console.log('  ERRORS')
    for (const e of errors) {
      console.log(`    ✗ ${e.repo}/${e.slug}: ${e.error}`)
    }
    console.log('─'.repeat(60))
  }

  if (process.env.AI_AUTHOR_ENABLED === 'true') {
    console.log(
      `[ai-author] expanded directives across all tutorials: ` +
      `${globalCallStats.calls} cache miss (LLM call), ` +
      `${globalCallStats.hits} cache hit, ` +
      `${globalCallStats.errors} errors. ` +
      `Build cap: ${process.env.AI_AUTHOR_BUILD_CAP ?? '200'}.`,
    )
  }

  console.log('═'.repeat(60))
}

// ──────────────────────────────────────────────────────────────────────────
//  /browse/ SSR data dump (issue #174 PR 2 — Task 2.1)
//
//  writeBrowseData() emits hugo/data/browse.json so Hugo's /browse/ template
//  can render rails + grid statically at build time. The data shape mirrors
//  what TutorialNavigator.vue's allCards computed produces at runtime, so the
//  same MissionCard/GroupCard/TutorialCard SFCs render byte-identically in
//  both contexts (verified by the card-template-parity test in Task 2.5).
// ──────────────────────────────────────────────────────────────────────────

const HUGO_DATA_DIR = join(__dirname, '..', 'hugo', 'data')
const BROWSE_DATA_FILE = join(HUGO_DATA_DIR, 'browse.json')

const FEATURED_MAX = 10
const RECENT_MAX = 10
const BROWSE_NEW_WINDOW_MS = 31 * 24 * 60 * 60 * 1000
const BROWSE_LEVEL_ORDER: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 }

interface BrowseCardItem {
  type: 'mission' | 'group' | 'tutorial'
  id: string
  title: string
  description: string
  time: number
  level: string
  tutorialCount: number
  primaryTag: string
  displayTags: string[]
  displayTagSlugs: string[]
  href: string
  stepCount: number
  categorySlugs: string[]
  isNew?: boolean
  createdAt?: string
  updatedAt?: string
}

interface BrowseData {
  all: BrowseCardItem[]
  featured: string[]
  recent: string[]
  categories: CategoryMeta[]
  buildAt: string
}

function browseLowestLevel(levels: string[]): string {
  return levels.sort((a, b) => (BROWSE_LEVEL_ORDER[a] ?? 9) - (BROWSE_LEVEL_ORDER[b] ?? 9))[0] || 'beginner'
}

function browseIsWithinNewWindow(createdAt: string | undefined): boolean {
  if (!createdAt) return false
  const t = Date.parse(createdAt)
  if (!Number.isFinite(t)) return false
  return Date.now() - t <= BROWSE_NEW_WINDOW_MS
}

function browseMissionGroupCount(missionId: number, tuts: TutorialNavEntry[]): number {
  const groupIds = new Set<number>()
  for (const t of tuts) {
    if (t.missionId === missionId && t.groupId != null) {
      groupIds.add(t.groupId)
    }
  }
  return groupIds.size
}

/**
 * Build-time mirror of TutorialNavigator.vue's allCards computed. MUST stay
 * in sync with that computed — the card-template-parity test in Task 2.5
 * verifies byte-equivalence of the rendered output.
 */
function buildAllCards(
  tuts: TutorialNavEntry[],
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
  tutorialMetaMap: Map<string, CatalogTutorialMeta>,
): BrowseCardItem[] {
  if (!tuts.length) return []

  const items: BrowseCardItem[] = []

  // Build mission/group → MissionRef/GroupRef lookups so we can resolve href slugs
  // (matches missionsMeta.value / groupsMeta.value lookups in the Vue computed).
  const missionsByIdLookup = new Map<number, Mission>()
  for (const m of missions) {
    missionsByIdLookup.set(m.imsId, m)
  }

  const groupsByIdLookup = new Map<number, HierarchyGroup | StandaloneGroup>()
  for (const h of hierarchies) {
    for (const g of h.groups) {
      groupsByIdLookup.set(g.imsId, g)
    }
  }
  for (const sg of standaloneGroups) {
    groupsByIdLookup.set(sg.imsId, sg)
  }

  // Phase 1: bucket tutorials by missionId / groupId.
  const missionGroups = new Map<number, TutorialNavEntry[]>()
  const groupMap = new Map<number, TutorialNavEntry[]>()

  for (const t of tuts) {
    if (t.missionId) {
      const mList = missionGroups.get(t.missionId) ?? []
      mList.push(t)
      missionGroups.set(t.missionId, mList)
    }

    if (t.groupId) {
      const gList = groupMap.get(t.groupId) ?? []
      gList.push(t)
      groupMap.set(t.groupId, gList)
    }
  }

  // Phase 2: mission cards.
  for (const [missionId, mTuts] of missionGroups) {
    const allTags = [...new Set(mTuts.flatMap(t => t.displayTags))]
    const allTagSlugs = [...new Set(mTuts.flatMap(t => t.displayTagSlugs))]
    const mMeta = missionsByIdLookup.get(missionId)
    const groupCount = browseMissionGroupCount(missionId, tuts)
    items.push({
      type: 'mission',
      id: `mission-${missionId}`,
      title: mTuts[0].missionTitle ?? '',
      // Topic-neutral description — the runtime allCards in TutorialNavigator.vue
      // hard-codes a CAP-specific string that mis-texts non-CAP missions on /;
      // the build-time mirror here intentionally diverges with a generic
      // template until that bug is fixed at the runtime callsite too.
      // See follow-up tracked in the PR description.
      description: `${mTuts.length} tutorials across ${groupCount} ${groupCount === 1 ? 'group' : 'groups'}.`,
      time: mTuts.reduce((sum, t) => sum + t.time, 0),
      level: browseLowestLevel(mTuts.map(t => t.level)),
      tutorialCount: mTuts.length,
      primaryTag: mTuts[0].primaryTag,
      displayTags: allTags,
      displayTagSlugs: allTagSlugs,
      href: mMeta ? `/tutorials/mission-${mMeta.slug}` : `/tutorials/${mTuts[0].slug}`,
      stepCount: mTuts.reduce((sum, t) => sum + t.stepCount, 0),
      categorySlugs: mMeta?.categorySlugs ?? [],
    })
  }

  // Phase 3: group cards.
  for (const [groupId, gTuts] of groupMap) {
    const allTags = [...new Set(gTuts.flatMap(t => t.displayTags))]
    const allTagSlugs = [...new Set(gTuts.flatMap(t => t.displayTagSlugs))]
    const gMeta = groupsByIdLookup.get(groupId)
    items.push({
      type: 'group',
      id: `group-${groupId}`,
      title: gTuts[0].groupTitle ?? '',
      description: `${gTuts.length} tutorials covering ${gTuts.map(t => t.title).join(', ')}.`,
      time: gTuts.reduce((sum, t) => sum + t.time, 0),
      level: browseLowestLevel(gTuts.map(t => t.level)),
      tutorialCount: gTuts.length,
      primaryTag: gTuts[0].primaryTag,
      displayTags: allTags,
      displayTagSlugs: allTagSlugs,
      href: gMeta ? `/tutorials/group-${gMeta.slug}` : `/tutorials/${gTuts[0].slug}`,
      stepCount: gTuts.reduce((sum, t) => sum + t.stepCount, 0),
      categorySlugs: gMeta?.categorySlugs ?? [],
    })
  }

  // Phase 4: tutorial cards.
  for (const t of tuts) {
    items.push({
      type: 'tutorial',
      id: t.slug,
      title: t.title,
      description: t.description,
      time: t.time,
      level: t.level,
      tutorialCount: 1,
      primaryTag: t.primaryTag,
      displayTags: t.displayTags,
      displayTagSlugs: t.displayTagSlugs,
      href: `/tutorials/${t.slug}`,
      stepCount: t.stepCount,
      categorySlugs: tutorialMetaMap.get(t.slug)?.categorySlugs ?? [],
      isNew: browseIsWithinNewWindow(t.createdAt),
      createdAt: t.createdAt,
    })
  }

  return items
}

function writeBrowseData(
  tuts: TutorialNavEntry[],
  missions: Mission[],
  hierarchies: MissionHierarchy[],
  standaloneGroups: StandaloneGroup[],
  categories: CategoryMeta[],
  tutorialMetas: CatalogTutorialMeta[],
): void {
  const tutorialMetaMap = new Map<string, CatalogTutorialMeta>(
    tutorialMetas.map(m => [m.slug, m]),
  )
  const all: BrowseCardItem[] = buildAllCards(tuts, missions, hierarchies, standaloneGroups, tutorialMetaMap)

  // Featured: first FEATURED_MAX mission cards, in catalog order.
  const featured = all
    .filter(c => c.type === 'mission')
    .slice(0, FEATURED_MAX)
    .map(c => c.id)

  // Recent: top RECENT_MAX tutorial cards by createdAt desc.
  const recent = all
    .filter(c => c.type === 'tutorial' && c.createdAt)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, RECENT_MAX)
    .map(c => c.id)

  const data: BrowseData = {
    all,
    featured,
    recent,
    categories,
    buildAt: new Date().toISOString(),
  }

  mkdirSync(HUGO_DATA_DIR, { recursive: true })
  writeFileSync(BROWSE_DATA_FILE, JSON.stringify(data, null, 2), 'utf-8')
  console.log(`  [browse] wrote ${all.length} cards (${featured.length} featured, ${recent.length} recent) → hugo/data/browse.json`)
}

// Only run main() when this file is executed directly (not when imported)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('fetch-tutorials.ts') ||
  process.argv[1].endsWith('fetch-tutorials.js')
)
if (isMainModule) {
  const channelForExport = parseChannel(process.argv)
  const dimensionsPath = channelForExport === 'qa'
    ? join(__dirname, '..', 'hugo', 'data-qa', 'image_dimensions.json')
    : join(__dirname, '..', 'hugo', 'data', 'image_dimensions.json')
  main()
    .then(() => {
      flushDimensionsCache()
      exportDimensionsForHugo(dimensionsPath)
    })
    .catch(err => {
      console.error(err)
      flushDimensionsCache()
      process.exit(1)
    })
}
