import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { stringify as yamlStringify } from 'yaml'
import { extractFrontmatter } from './parsers/frontmatter.js'
import { parseV2Steps } from './parsers/v2.js'
import { parseV1Steps } from './parsers/v1.js'
import { resolveImageURLs } from './parsers/images.js'
import { convertOptionBlocks } from './parsers/options.js'
import { escapeHugoDelimiters } from './parsers/hugo-delimiters.js'
import { discoverAllTutorials, fetchGitHubMetaBatch, fetchGitHubMeta, type DiscoveredTutorial } from './parsers/github.js'
import { fetchAllMissions, fetchAllMissionHierarchies, loadAemCache, saveAemCache, type AemMission, type AemHierarchy, type AemHierarchyGroup } from './parsers/aem.js'
import type { TutorialStep, TutorialNavEntry, NavData, MissionMeta, GroupRef } from './parsers/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

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
  const res = await fetch(url)
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
  contributors: Array<{ name: string; login: string; avatarUrl: string }>,
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
    contributors: contributors.slice(0, 10).map(c => ({ login: c.login, name: c.name, avatarUrl: c.avatarUrl })),
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
  contributors: Array<{ name: string; login: string; avatarUrl: string }>,
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
    displayTags: [...new Set([cleanPrimaryTag, ...cleanTags])].map(humanizeTag).filter(t => t.length > 0),
    youWillLearn,
    prerequisites: splitPrerequisites(prerequisites),
    lastUpdated: lastUpdated || null,
    contributors: contributors.slice(0, 10).map(c => ({ login: c.login, name: c.name, avatarUrl: c.avatarUrl })),
    steps: steps.map(s => ({ number: s.number, title: s.title })),
  }

  if (nav.missionId) fm.missionId = nav.missionId
  if (nav.missionTitle) fm.missionTitle = nav.missionTitle
  if (nav.missionSlug) fm.missionSlug = nav.missionSlug
  if (nav.groupId) fm.groupId = nav.groupId
  if (nav.groupTitle) fm.groupTitle = nav.groupTitle
  if (nav.groupSlug) fm.groupSlug = nav.groupSlug

  const frontmatter = `---\n${yamlStringify(fm).trimEnd()}\n---\n\n`

  const stepsMd = steps.map(step =>
    `{{% tutorial-step number="${step.number}" title="${step.title.replace(/"/g, '&quot;')}" %}}\n\n${escapeHugoDelimiters(step.content)}\n\n{{% /tutorial-step %}}`
  ).join('\n\n')

  const content = `${frontmatter}${stepsMd}\n`

  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, `${slug}.md`), content, 'utf-8')
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

  const patchFields: Record<string, string | number | null> = {
    prev: nav.prev,
    next: nav.next,
  }
  if (nav.missionId) patchFields.missionId = nav.missionId
  if (nav.missionTitle) patchFields.missionTitle = nav.missionTitle
  if (nav.missionSlug) patchFields.missionSlug = nav.missionSlug
  if (nav.groupId) patchFields.groupId = nav.groupId
  if (nav.groupTitle) patchFields.groupTitle = nav.groupTitle
  if (nav.groupSlug) patchFields.groupSlug = nav.groupSlug

  const existingKeys = new Set(lines.map(l => l.match(/^(\w+):/)?.[1]).filter(Boolean))
  const updatedLines = lines.map(line => {
    const keyMatch = line.match(/^(\w+):/)
    if (keyMatch && keyMatch[1] in patchFields) {
      const val = patchFields[keyMatch[1]]
      return `${keyMatch[1]}: ${val === null ? 'null' : typeof val === 'string' ? JSON.stringify(val) : val}`
    }
    return line
  })

  for (const [key, val] of Object.entries(patchFields)) {
    if (!existingKeys.has(key)) {
      const yamlVal = val === null ? 'null' : typeof val === 'string' ? JSON.stringify(val) : val
      updatedLines.push(`${key}: ${yamlVal}`)
    }
  }

  const content = `---\n${updatedLines.join('\n')}\n---\n\n${body}`
  writeFileSync(filePath, content, 'utf-8')
}

function writeMissionPage(
  mission: AemMission,
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
  group: AemHierarchyGroup,
  mission: AemMission,
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
  const target = parseTarget(process.argv)
  const OUTPUT_DIR = getOutputDir(target)
  const NAV_JSON_DIR = getNavJsonDir(target)

  let allTutorials: DiscoveredTutorial[]
  let discoveryMs = 0
  let metaMs = 0

  if (regenerateMode) {
    console.log('Running in REGENERATE mode (from cache only, no GitHub API calls)\n')
    const cachedFiles = existsSync(CACHE_DIR)
      ? readdirSync(CACHE_DIR).filter(f => f.endsWith('.md')).map(f => f.replace('.md', ''))
      : []
    if (cachedFiles.length === 0) {
      console.error('ERROR: No cached tutorials found. Run without --regenerate first.')
      process.exit(1)
    }
    allTutorials = cachedFiles.map(slug => ({ slug, repo: 'unknown', branch: 'main' }))
    console.log(`Found ${allTutorials.length} cached tutorials\n`)
  } else {
    if (!process.env.GITHUB_TOKEN) {
      console.error('ERROR: GITHUB_TOKEN is required for the GraphQL API.')
      console.error('  Set GITHUB_TOKEN before running this script.')
      console.error('  Or use --regenerate to rebuild from cache.\n')
      process.exit(1)
    }

    // ── Phase 1: Discovery via GraphQL ──
    console.log('Phase 1: Discovering tutorials via GraphQL...\n')
    const discoveryStart = performance.now()

    allTutorials = await discoverAllTutorials()
    discoveryMs = performance.now() - discoveryStart

    console.log(`\nDiscovered ${allTutorials.length} tutorials (${formatDuration(discoveryMs)})\n`)

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
      let contributors: Array<{ name: string; login: string; avatarUrl: string }> = []

      if (regenerateMode) {
        const cacheFile = join(CACHE_DIR, `${t.slug}.md`)
        if (!existsSync(cacheFile)) throw new Error(`Cache file not found: ${cacheFile}`)
        rawMd = readFileSync(cacheFile, 'utf-8')
        cacheHits++
        console.log(`${label} [cached]`)
      } else {
        const ghMeta = await fetchGitHubMeta(t.slug, t.repo, t.branch)
        const { content, cacheStatus } = await fetchMarkdown(t.slug, t.repo, t.branch, ghMeta.lastCommitSha)
        rawMd = content
        lastUpdated = ghMeta.lastUpdated
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

      const steps = isV2 ? parseV2Steps(processedBody) : parseV1Steps(processedBody)

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

  // ── Phase 4: AEM Missions & Groups ──
  console.log('\nPhase 4: Fetching missions & groups from AEM...\n')
  const aemStart = performance.now()

  let missions: AemMission[] = []
  let hierarchies: AemHierarchy[] = []
  let aemCacheUsed = false

  const forceAem = process.argv.includes('--force-aem')
  const cached = forceAem ? null : loadAemCache()

  if (cached) {
    missions = cached.missions
    hierarchies = cached.hierarchies
    aemCacheUsed = true
    console.log(`  [aem] Using cached data (${missions.length} missions)`)
  } else {
    try {
      missions = await fetchAllMissions()
      console.log(`  [aem] Discovered ${missions.length} missions`)

      hierarchies = await fetchAllMissionHierarchies(missions)
      saveAemCache(missions, hierarchies)
      console.log(`  [aem] Fetched all hierarchies`)
    } catch (err) {
      console.warn(`  [aem-warn] AEM fetch failed: ${err instanceof Error ? err.message : err}`)
      console.warn('  [aem-warn] Continuing without missions/groups')
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

    const groupsToProcess: AemHierarchyGroup[] = isFlat
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

  let patchedCount = 0
  for (const nav of navEntries) {
    if (nav.missionId || nav.prev || nav.next) {
      patchTutorialFrontmatter(nav.slug, nav, OUTPUT_DIR, target)
      patchedCount++
    }
  }

  const aemMs = performance.now() - aemStart
  console.log(`\nAEM phase complete: ${missions.length} missions, ${allGroupRefs.length} groups, ${matchedTutorials} tutorials matched, ${unmatchedTutorials} unmatched, ${patchedCount} pages patched (${formatDuration(aemMs)})`)

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
  console.log(`    AEM missions/groups:     ${formatDuration(aemMs)}${aemCacheUsed ? ' (cached)' : ''}`)
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
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
