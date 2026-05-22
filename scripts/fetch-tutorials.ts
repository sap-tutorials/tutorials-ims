import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, unlinkSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { stringify as yamlStringify } from 'yaml'
import { extractFrontmatter } from './parsers/frontmatter.js'
import { parseV2Steps } from './parsers/v2.js'
import { parseV1Steps } from './parsers/v1.js'
import { resolveImageURLs } from './parsers/images.js'
import { flushDimensionsCache, populateImageDimensions, exportDimensionsForHugo } from './parsers/image-dimensions.js'
import { convertOptionBlocks } from './parsers/options.js'
import { escapeHugoDelimiters } from './parsers/hugo-delimiters.js'
import { stripDangerousHtml } from './parsers/sanitize-html.js'
import { discoverAllTutorials, fetchGitHubMetaBatch, fetchGitHubMeta, fetchRulesVr, fetchWithRetry, uploadDiscoveryToHana, saveDiscoveryBaseline, EXCLUDED_REPOS, type DiscoveredTutorial } from './parsers/github.js'
import { fetchBuildCatalog, fetchCoCompletions, loadCapCache, saveCapCache } from './parsers/cap.js'
import { parseRulesVr } from './parsers/rules.js'
import { computeRecommendations } from './parsers/recommendations.js'
import type { Mission, MissionHierarchy, HierarchyGroup, TutorialStep, TutorialNavEntry, NavData, MissionMeta, GroupRef } from './parsers/types.js'

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

const CACHE_DIR = join(__dirname, '..', '.tutorial-cache')
const CONCURRENCY = 5

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

export function getOutputDir(target: BuildTarget): string {
  if (target === 'hugo') return join(__dirname, '..', 'hugo', 'content', 'tutorials')
  return join(__dirname, '..', 'site', 'tutorials')
}

export function getNavJsonDir(target: BuildTarget): string {
  if (target === 'hugo') return join(__dirname, '..', 'hugo', 'static', 'tutorials')
  return join(__dirname, '..', 'site', 'tutorials')
}

const ACRONYMS = new Set(['SAP', 'HANA', 'CAP', 'BTP', 'CDS', 'UI', 'API', 'MTA', 'XSUAA', 'OData', 'HTML5', 'ABAP'])

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

function humanizeTag(raw: string): string {
  const value = raw.includes('>') ? raw.split('>').pop()! : raw
  return value
    .replace(/\\/g, '')
    .replace(/[-_]/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 0)
    .map(word => {
      const upper = word.toUpperCase()
      if (ACRONYMS.has(upper)) return upper
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function splitPrerequisites(prereqText: string): string[] {
  if (!prereqText) return []
  return prereqText
    .split('\n')
    .map(line => line.replace(/^\s*-\s+/, '').trim())
    .map(line => escapeHtml(line))
    .filter(line => line.length > 0)
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
  const res = await fetchWithRetry(url, { headers: { 'User-Agent': 'tutorials-poc-build' } }, { label: `raw:${slug}` })
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
): void {
  const OUTPUT_DIR = outputDir
  const cleanTags = tags.map(t => t.replace(/\\/g, ''))
  const cleanPrimaryTag = primaryTag.replace(/\\/g, '')

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
    displayTags: [...new Set([cleanPrimaryTag, ...cleanTags])].map(humanizeTag).filter(t => t.length > 0),
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
): void {
  const cleanTags = tags.map(t => t.replace(/\\/g, ''))
  const cleanPrimaryTag = primaryTag.replace(/\\/g, '')

  const fm: Record<string, unknown> = {
    type: 'tutorials',
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
    aliases: [`/tutorials/${slug}.html`],
    displayTags: [...new Set([cleanPrimaryTag, ...cleanTags])].map(humanizeTag).filter(t => t.length > 0),
    youWillLearn,
    prerequisites: splitPrerequisites(prerequisites),
    lastUpdated: lastUpdated || null,
    createdAt: createdAt || null,
    contributors: contributors.slice(0, 10).map(c => ({ login: c.login, name: c.name, email: c.email, avatarUrl: c.avatarUrl })),
    steps: steps.map(s => {
      const entry: Record<string, unknown> = { number: s.number, title: s.title }
      if (s.validation?.length) entry.validation = s.validation
      return entry
    }),
  }

  if (nav.missionId) fm.missionId = nav.missionId
  if (nav.missionTitle) fm.missionTitle = nav.missionTitle
  if (nav.missionSlug) fm.missionSlug = nav.missionSlug
  if (nav.groupId) fm.groupId = nav.groupId
  if (nav.groupTitle) fm.groupTitle = nav.groupTitle
  if (nav.groupSlug) fm.groupSlug = nav.groupSlug

  const frontmatter = `---\n${yamlStringify(fm).trimEnd()}\n---\n\n`

  const stepsMd = steps.map(step =>
    `{{% tutorial-step number="${step.number}" title="${step.title.replace(/"/g, '&quot;')}" %}}\n\n${escapeHugoDelimiters(stripDangerousHtml(step.content))}\n\n{{% /tutorial-step %}}`
  ).join('\n\n')

  const content = `${frontmatter}${stepsMd}\n`

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

function writeMissionPage(
  mission: Mission,
  groups: GroupRef[],
  navBySlug: Map<string, TutorialNavEntry>,
  outputDir: string,
  target: BuildTarget = 'vitepress',
): void {
  const groupsData = groups.map(g => {
    const tutorials = g.tutorials
      .map(slug => navBySlug.get(slug))
      .filter((n): n is TutorialNavEntry => !!n)
      .map(n => ({
        slug: n.slug,
        title: n.title,
        description: n.description,
        time: n.time,
        level: n.level,
        stepCount: n.stepCount,
      }))

    return {
      id: g.id,
      title: g.title,
      slug: g.slug,
      tutorials,
    }
  })

  const allTutorials = groupsData.flatMap(g => g.tutorials)
  const totalTime = allTutorials.reduce((s, t) => s + t.time, 0)
  const levels = allTutorials.map(t => t.level)
  const missionLevel = levels.includes('advanced') ? 'advanced'
    : levels.includes('intermediate') ? 'intermediate'
    : mission.level || 'beginner'

  const displayTags = allTutorials
    .flatMap(t => {
      const nav = navBySlug.get(t.slug)
      return nav?.displayTags ?? []
    })
    .filter((tag, i, arr) => arr.indexOf(tag) === i)
    .slice(0, 6)

  const fm: Record<string, unknown> = {
    ...(target === 'hugo' ? { type: 'missions', url: `/tutorials/mission-${mission.slug}` } : { layout: 'mission' }),
    slug: mission.slug,
    missionId: mission.imsId,
    title: mission.title,
    description: mission.description,
    level: missionLevel,
    totalTime,
    tutorialCount: allTutorials.length,
    groupCount: groupsData.length,
    displayTags,
    groups: groupsData,
  }

  const content = `---\n${yamlStringify(fm).trimEnd()}\n---\n`
  writeFileSync(join(outputDir, `mission-${mission.slug}.md`), content, 'utf-8')
}

function writeGroupPage(
  group: HierarchyGroup,
  mission: Mission,
  tutorials: Array<{
    slug: string
    title: string
    description: string
    time: number
    level: string
    stepCount: number
    primaryTag: string
  }>,
  outputDir: string,
  target: BuildTarget = 'vitepress',
): void {
  const totalTime = tutorials.reduce((s, t) => s + t.time, 0)
  const levels = tutorials.map(t => t.level)
  const groupLevel = levels.includes('advanced') ? 'advanced'
    : levels.includes('intermediate') ? 'intermediate'
    : 'beginner'

  const displayTags = tutorials
    .map(t => t.primaryTag)
    .filter(t => t.length > 0)
    .map(humanizeTag)
    .filter((tag, i, arr) => arr.indexOf(tag) === i)
    .slice(0, 6)

  const fm: Record<string, unknown> = {
    ...(target === 'hugo' ? { type: 'groups', url: `/tutorials/group-${group.slug}` } : { layout: 'group' }),
    slug: group.slug,
    groupId: group.imsId,
    missionId: mission.imsId,
    missionSlug: mission.slug,
    missionTitle: mission.title,
    title: group.title,
    description: group.description,
    level: groupLevel,
    totalTime,
    tutorialCount: tutorials.length,
    displayTags,
    tutorials,
  }

  const content = `---\n${yamlStringify(fm).trimEnd()}\n---\n`
  writeFileSync(join(outputDir, `group-${group.slug}.md`), content, 'utf-8')
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const mins = Math.floor(ms / 60_000)
  const secs = ((ms % 60_000) / 1000).toFixed(1)
  return `${mins}m ${secs}s`
}

async function main() {
  const totalStart = performance.now()
  const regenerateMode = process.argv.includes('--regenerate')
  const discoverOnly = process.argv.includes('--discover-only')
  const tutorialSlugFilter = (process.env.TUTORIAL_SLUG ?? '').trim() || null
  const target = parseTarget(process.argv)
  const OUTPUT_DIR = getOutputDir(target)
  const NAV_JSON_DIR = getNavJsonDir(target)

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
    // covers all tutorials. Uploading disk/HANA fallback data would advance
    // lastSyncedAt and falsely signal freshness during a prolonged GitHub outage.
    // Slug-filtered runs are partial by design — never overwrite the catalog.
    if (discovery.source === 'github' && !tutorialSlugFilter) {
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

      const { title, description, youWillLearn, prerequisites, level, frontmatter, body } = extractFrontmatter(rawMd)

      const isV2 = frontmatter.parser === 'v2'
      let processedBody = resolveImageURLs(body, { repo: t.repo, branch: t.branch, slug: t.slug })
      processedBody = convertOptionBlocks(processedBody, target)
      processedBody = processedBody.replace(/^<{4,7} .+\n[\s\S]*?^={4,7}\n([\s\S]*?)^>{4,7} .+\n?/gm, '$1')

      // Populate intrinsic-dimension cache for the Hugo render-image hook.
      // The hook reads site.Data.image_dimensions to emit width/height attrs;
      // markdown attribute syntax can't be used because goldmark renders it
      // as literal text for inline images.
      if (target === 'hugo') {
        await populateImageDimensions(processedBody)
      }

      const steps = isV2 ? parseV2Steps(processedBody) : parseV1Steps(processedBody)

      // Fetch and attach validation questions from rules.vr
      const rulesContent = await fetchRulesVr(t.slug, t.repo, t.branch)
      if (rulesContent) {
        const validationMap = parseRulesVr(rulesContent)
        const testSteps = steps.filter(s => /^test yourself$/i.test(s.title))
        for (const [validateNum, questions] of validationMap) {
          // Find the first "Test yourself" step at or after position N
          const target = testSteps.find(s => s.number >= validateNum) ?? testSteps[testSteps.length - 1]
          if (target && questions.length) {
            target.validation = [...(target.validation ?? []), ...questions]
          }
        }
      }

      const nav: TutorialNavEntry = {
        slug: t.slug,
        title,
        description,
        time: frontmatter.time ?? 15,
        level,
        stepCount: steps.length,
        primaryTag: humanizeTag(frontmatter.primary_tag ?? ''),
        displayTags: [...new Set([frontmatter.primary_tag ?? '', ...(frontmatter.tags ?? [])])]
          .map(t => t.replace(/\\/g, ''))
          .map(humanizeTag).filter(tag => tag.length > 0),
        repo: t.repo,
        branch: t.branch,
        prev: null,
        next: null,
      }

      const writePage = target === 'hugo' ? writeHugoPage : writeVitePressPage
      writePage(
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
      )

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
  let capCacheUsed = false
  let coCompletions: Map<string, Map<string, number>> = new Map()

  const forceRefresh = process.argv.includes('--force-cap')
  const cached = forceRefresh ? null : loadCapCache()

  if (cached) {
    missions = cached.missions
    hierarchies = cached.hierarchies
    capCacheUsed = true
    console.log(`  [cap] Using cached data (${missions.length} missions)`)
  } else {
    try {
      const capBaseUrl = process.env.CAP_BASE_URL || 'http://localhost:4004'
      const catalog = await fetchBuildCatalog(capBaseUrl)
      missions = catalog.missions
      hierarchies = catalog.hierarchies
      saveCapCache(missions, hierarchies)
      console.log(`  [cap] Fetched ${missions.length} missions with hierarchies`)
      coCompletions = await fetchCoCompletions(capBaseUrl)
      console.log(`  [cap] co-completion map: ${coCompletions.size} source slugs`)
    } catch (err) {
      console.warn(`  [cap-warn] CAP fetch failed: ${err instanceof Error ? err.message : err}`)
      console.warn('  [cap-warn] Continuing without missions/groups')
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

      const groupTutorialEntries: Array<{
        slug: string
        title: string
        description: string
        time: number
        level: string
        stepCount: number
        primaryTag: string
      }> = []

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

        groupTutorialEntries.push({
          slug: nav.slug,
          title: nav.title,
          description: nav.description,
          time: nav.time,
          level: nav.level,
          stepCount: nav.stepCount,
          primaryTag: nav.primaryTag,
        })
      }

      missionGroups.push(groupRef)
      if (!isFlat) {
        allGroupRefs.push(groupRef)
        writeGroupPage(group, mission, groupTutorialEntries, OUTPUT_DIR, target)
      }
    }

    missionsMeta.push({
      id: mission.imsId,
      title: mission.title,
      slug: mission.slug,
      groups: missionGroups,
    })

    writeMissionPage(mission, missionGroups, navBySlug, OUTPUT_DIR, target)
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

  console.log('═'.repeat(60))
}

// Only run main() when this file is executed directly (not when imported)
const isMainModule = process.argv[1] && (
  process.argv[1].endsWith('fetch-tutorials.ts') ||
  process.argv[1].endsWith('fetch-tutorials.js')
)
if (isMainModule) {
  main()
    .then(() => {
      flushDimensionsCache()
      exportDimensionsForHugo('hugo/data/image_dimensions.json')
    })
    .catch(err => {
      console.error(err)
      flushDimensionsCache()
      process.exit(1)
    })
}
