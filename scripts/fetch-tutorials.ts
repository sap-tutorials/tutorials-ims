import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stringify as yamlStringify } from 'yaml'
import { extractFrontmatter } from './parsers/frontmatter.js'
import { parseV2Steps } from './parsers/v2.js'
import { parseV1Steps } from './parsers/v1.js'
import { resolveImageURLs } from './parsers/images.js'
import { convertOptionBlocks } from './parsers/options.js'
import { fetchGitHubMeta } from './parsers/github.js'
import type { TutorialStep, TutorialNavEntry, ValidationQuestion, GitHubContributor, MissionMeta, GroupRef, NavData } from './parsers/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const MISSION_TITLE = 'Combine CAP with SAP HANA Cloud to Create Full-Stack Applications'
const MISSION_SLUG = 'hana-cloud-cap'
const MISSION_ID = 14094

const GROUP_META: Record<number, { title: string; slug: string }> = {
  14091: { title: 'Set Up SAP HANA Cloud and CAP Project', slug: 'hana-cloud-cap-setup' },
  14092: { title: 'Build a Full-Stack Application', slug: 'hana-cloud-cap-build-full-stack' },
}

const POC_TUTORIALS: Array<{
  slug: string
  repo: string
  missionId: number
  groupId: number
  groupTitle: string
}> = [
  { slug: 'hana-cloud-deploying', repo: 'Tutorials', missionId: MISSION_ID, groupId: 14091, groupTitle: 'Set Up SAP HANA Cloud and CAP Project' },
  { slug: 'hana-cloud-cap-create-project', repo: 'Tutorials', missionId: MISSION_ID, groupId: 14091, groupTitle: 'Set Up SAP HANA Cloud and CAP Project' },
  { slug: 'hana-cloud-cap-create-database-cds', repo: 'Tutorials', missionId: MISSION_ID, groupId: 14091, groupTitle: 'Set Up SAP HANA Cloud and CAP Project' },
  { slug: 'hana-cloud-cap-create-ui', repo: 'Tutorials', missionId: MISSION_ID, groupId: 14092, groupTitle: 'Build a Full-Stack Application' },
  { slug: 'hana-cloud-cap-add-authentication', repo: 'Tutorials', missionId: MISSION_ID, groupId: 14092, groupTitle: 'Build a Full-Stack Application' },
]

const CACHE_DIR = join(__dirname, '..', '.tutorial-cache')
const OUTPUT_DIR = join(__dirname, '..', 'site', 'tutorials')

const ACRONYMS = new Set(['SAP', 'HANA', 'CAP', 'BTP', 'CDS', 'UI', 'API', 'MTA', 'XSUAA', 'OData', 'HTML5', 'ABAP'])

const VALIDATION_DATA: Record<string, Record<number, ValidationQuestion[]>> = {
  'hana-cloud-cap-create-project': {
    3: [{
      id: 'q1',
      question: 'What name should you use for the CAP project as recommended in this tutorial?',
      type: 'multiple-choice',
      options: ['MyHANAApp', 'MyCloudApp', 'HanaProject', 'CAPDemo'],
      correctAnswer: 'MyHANAApp',
    }],
    7: [{
      id: 'q1',
      question: 'Why is it recommended to perform a commit at the end of each tutorial?',
      type: 'multiple-choice',
      options: [
        'To create a version that allows you to revert and compare changes',
        'To automatically deploy changes to the cloud',
        'To share code with other developers',
        'To trigger CI/CD pipelines',
      ],
      correctAnswer: 'To create a version that allows you to revert and compare changes',
    }],
  },
  'hana-cloud-deploying': {
    1: [{
      id: 'q1',
      question: 'What is the minimum memory required for an SAP HANA Cloud instance?',
      type: 'multiple-choice',
      options: ['16 GB', '30 GB', '32 GB', '64 GB'],
      correctAnswer: '30 GB',
    }],
  },
}

function humanizeTag(raw: string): string {
  const value = raw.includes('>') ? raw.split('>').pop()! : raw
  return value
    .replace(/[-_]/g, ' ')
    .split(' ')
    .map(word => {
      const upper = word.toUpperCase()
      if (ACRONYMS.has(upper)) return upper
      return word.charAt(0).toUpperCase() + word.slice(1)
    })
    .join(' ')
}

function splitPrerequisites(prereqText: string): string[] {
  if (!prereqText) return []
  return prereqText
    .split('\n')
    .map(line => line.replace(/^\s*-\s+/, '').trim())
    .filter(line => line.length > 0)
}

async function fetchMarkdown(slug: string, repo: string): Promise<{ content: string; branch: string }> {
  const cacheFile = join(CACHE_DIR, `${slug}.md`)
  if (existsSync(cacheFile)) {
    console.log(`  [cache] ${slug}`)
    return { content: readFileSync(cacheFile, 'utf-8'), branch: 'master' }
  }

  const branch = repo === 'Tutorials' ? 'master' : 'main'
  const url = `https://raw.githubusercontent.com/sap-tutorials/${repo}/${branch}/tutorials/${slug}/${slug}.md`
  console.log(`  [fetch] ${url}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to fetch ${slug}: ${res.status}`)
  const content = await res.text()

  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(cacheFile, content, 'utf-8')
  return { content, branch }
}

function buildNavEntries(): TutorialNavEntry[] {
  return POC_TUTORIALS.map((t, i) => ({
    slug: t.slug,
    title: '',
    description: '',
    time: 15,
    level: 'beginner',
    stepCount: 0,
    primaryTag: '',
    displayTags: [],
    missionId: t.missionId,
    missionTitle: MISSION_TITLE,
    missionSlug: MISSION_SLUG,
    groupId: t.groupId,
    groupTitle: t.groupTitle,
    groupSlug: GROUP_META[t.groupId]?.slug ?? '',
    prev: i > 0 ? POC_TUTORIALS[i - 1].slug : null,
    next: i < POC_TUTORIALS.length - 1 ? POC_TUTORIALS[i + 1].slug : null,
  }))
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
  contributors: GitHubContributor[],
): void {
  const fm: Record<string, unknown> = {
    layout: 'tutorial',
    slug,
    title,
    description,
    time,
    level,
    tags,
    primaryTag,
    author,
    authorProfile,
    stepCount: steps.length,
    missionId: nav.missionId,
    missionTitle: MISSION_TITLE,
    missionSlug: MISSION_SLUG,
    groupId: nav.groupId,
    groupTitle: nav.groupTitle,
    groupSlug: GROUP_META[nav.groupId]?.slug ?? '',
    prev: nav.prev,
    next: nav.next,
    displayTags: [...new Set([primaryTag, ...tags])].map(humanizeTag).filter(t => t.length > 0),
    youWillLearn,
    prerequisites: splitPrerequisites(prerequisites),
    lastUpdated: lastUpdated || null,
    contributors: contributors.slice(0, 10).map(c => ({ login: c.login, name: c.name, avatarUrl: c.avatarUrl })),
    steps: steps.map(s => {
      const v = VALIDATION_DATA[slug]?.[s.number]
      const entry: Record<string, unknown> = { number: s.number, title: s.title }
      if (v) entry.validation = v
      return entry
    }),
  }

  const frontmatter = `---\n${yamlStringify(fm).trimEnd()}\n---\n\n`

  const stepsMd = steps.map(step =>
    `<TutorialStep :number="${step.number}" title="${step.title.replace(/"/g, '&quot;')}" slug="${slug}">\n\n${step.content}\n\n</TutorialStep>`
  ).join('\n\n')

  const content = `${frontmatter}${stepsMd}\n`

  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(join(OUTPUT_DIR, `${slug}.md`), content, 'utf-8')
}

const LEVEL_ORDER: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 }

function lowestLevel(levels: string[]): string {
  return levels.sort((a, b) => (LEVEL_ORDER[a] ?? 9) - (LEVEL_ORDER[b] ?? 9))[0] || 'beginner'
}

function writeMissionPage(navEntries: TutorialNavEntry[]): void {
  const groupMap = new Map<number, TutorialNavEntry[]>()
  for (const t of navEntries) {
    const list = groupMap.get(t.groupId) ?? []
    list.push(t)
    groupMap.set(t.groupId, list)
  }

  const groups = Array.from(groupMap.entries()).map(([groupId, tuts]) => ({
    id: groupId,
    slug: GROUP_META[groupId]?.slug ?? '',
    title: GROUP_META[groupId]?.title ?? tuts[0].groupTitle,
    tutorials: tuts.map(t => ({
      slug: t.slug, title: t.title, description: t.description,
      time: t.time, level: t.level, stepCount: t.stepCount, primaryTag: t.primaryTag,
    })),
  }))

  const allTags = [...new Set(navEntries.flatMap(t => t.displayTags))]
  const totalTime = navEntries.reduce((sum, t) => sum + t.time, 0)

  const fm: Record<string, unknown> = {
    layout: 'mission',
    slug: MISSION_SLUG,
    missionId: MISSION_ID,
    title: MISSION_TITLE,
    tutorialCount: navEntries.length,
    groupCount: groups.length,
    totalTime,
    level: lowestLevel(navEntries.map(t => t.level)),
    displayTags: allTags,
    groups,
  }

  const content = `---\n${yamlStringify(fm).trimEnd()}\n---\n`
  writeFileSync(join(OUTPUT_DIR, `mission-${MISSION_SLUG}.md`), content, 'utf-8')
}

function writeGroupPage(groupId: number, navEntries: TutorialNavEntry[]): void {
  const groupTuts = navEntries.filter(t => t.groupId === groupId)
  const meta = GROUP_META[groupId]
  if (!meta || !groupTuts.length) return

  const allTags = [...new Set(groupTuts.flatMap(t => t.displayTags))]
  const totalTime = groupTuts.reduce((sum, t) => sum + t.time, 0)

  const fm: Record<string, unknown> = {
    layout: 'group',
    slug: meta.slug,
    groupId,
    title: meta.title,
    missionId: MISSION_ID,
    missionTitle: MISSION_TITLE,
    missionSlug: MISSION_SLUG,
    tutorialCount: groupTuts.length,
    totalTime,
    level: lowestLevel(groupTuts.map(t => t.level)),
    displayTags: allTags,
    tutorials: groupTuts.map(t => ({
      slug: t.slug, title: t.title, description: t.description,
      time: t.time, level: t.level, stepCount: t.stepCount, primaryTag: t.primaryTag,
    })),
  }

  const content = `---\n${yamlStringify(fm).trimEnd()}\n---\n`
  writeFileSync(join(OUTPUT_DIR, `group-${meta.slug}.md`), content, 'utf-8')
}

async function main() {
  console.log('Fetching POC tutorials...\n')

  const navEntries = buildNavEntries()
  mkdirSync(OUTPUT_DIR, { recursive: true })

  for (let i = 0; i < POC_TUTORIALS.length; i++) {
    const t = POC_TUTORIALS[i]
    console.log(`[${i + 1}/${POC_TUTORIALS.length}] ${t.slug}`)

    const { content: rawMd, branch } = await fetchMarkdown(t.slug, t.repo)
    const { title, description, youWillLearn, prerequisites, level, frontmatter, body } = extractFrontmatter(rawMd)

    const isV2 = frontmatter.parser === 'v2'
    let processedBody = resolveImageURLs(body, { repo: t.repo, branch, slug: t.slug })
    processedBody = convertOptionBlocks(processedBody)

    const steps = isV2 ? parseV2Steps(processedBody) : parseV1Steps(processedBody)

    const ghMeta = await fetchGitHubMeta(t.slug, t.repo)

    navEntries[i].title = title
    navEntries[i].description = description
    navEntries[i].time = frontmatter.time ?? 15
    navEntries[i].level = level
    navEntries[i].stepCount = steps.length
    navEntries[i].primaryTag = humanizeTag(frontmatter.primary_tag ?? '')
    navEntries[i].displayTags = [...new Set([frontmatter.primary_tag ?? '', ...(frontmatter.tags ?? [])])]
      .map(humanizeTag).filter(t => t.length > 0)

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
      navEntries[i],
      ghMeta.lastUpdated,
      ghMeta.contributors,
    )

    console.log(`  → ${steps.length} steps, level: ${level}, time: ${frontmatter.time}min`)
  }

  writeMissionPage(navEntries)
  const groupIds = [...new Set(POC_TUTORIALS.map(t => t.groupId))]
  for (const gid of groupIds) {
    writeGroupPage(gid, navEntries)
  }

  const groupMap = new Map<number, string[]>()
  for (const t of navEntries) {
    const list = groupMap.get(t.groupId) ?? []
    list.push(t.slug)
    groupMap.set(t.groupId, list)
  }

  const navData: NavData = {
    tutorials: navEntries,
    missions: [{
      id: MISSION_ID,
      title: MISSION_TITLE,
      slug: MISSION_SLUG,
      groups: groupIds.map(gid => ({
        id: gid,
        title: GROUP_META[gid]?.title ?? '',
        slug: GROUP_META[gid]?.slug ?? '',
        missionId: MISSION_ID,
        tutorials: groupMap.get(gid) ?? [],
      })),
    }],
    groups: groupIds.map(gid => ({
      id: gid,
      title: GROUP_META[gid]?.title ?? '',
      slug: GROUP_META[gid]?.slug ?? '',
      missionId: MISSION_ID,
      tutorials: groupMap.get(gid) ?? [],
    })),
  }

  const navPath = join(OUTPUT_DIR, '_nav.json')
  writeFileSync(navPath, JSON.stringify(navData, null, 2), 'utf-8')
  console.log(`\nWrote ${POC_TUTORIALS.length} tutorials + ${groupIds.length} groups + 1 mission + nav to ${OUTPUT_DIR}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
