import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractFrontmatter } from './parsers/frontmatter.js'
import { parseV2Steps } from './parsers/v2.js'
import { parseV1Steps } from './parsers/v1.js'
import { resolveImageURLs } from './parsers/images.js'
import { convertOptionBlocks } from './parsers/options.js'
import type { TutorialStep, TutorialNavEntry } from './parsers/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const POC_TUTORIALS: Array<{
  slug: string
  repo: string
  missionId: number
  groupId: number
  groupTitle: string
}> = [
  { slug: 'hana-cloud-deploying', repo: 'Tutorials', missionId: 14094, groupId: 14091, groupTitle: 'Set Up SAP HANA Cloud and CAP Project' },
  { slug: 'hana-cloud-cap-create-project', repo: 'Tutorials', missionId: 14094, groupId: 14091, groupTitle: 'Set Up SAP HANA Cloud and CAP Project' },
  { slug: 'hana-cloud-cap-create-database-cds', repo: 'Tutorials', missionId: 14094, groupId: 14091, groupTitle: 'Set Up SAP HANA Cloud and CAP Project' },
  { slug: 'hana-cloud-cap-create-ui', repo: 'Tutorials', missionId: 14094, groupId: 14092, groupTitle: 'Build a Full-Stack Application' },
  { slug: 'hana-cloud-cap-add-authentication', repo: 'Tutorials', missionId: 14094, groupId: 14092, groupTitle: 'Build a Full-Stack Application' },
]

const CACHE_DIR = join(__dirname, '..', '.tutorial-cache')
const OUTPUT_DIR = join(__dirname, '..', 'site', 'tutorials')

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
    missionId: t.missionId,
    groupId: t.groupId,
    groupTitle: t.groupTitle,
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
  youWillLearn: string[],
  prerequisites: string,
  steps: TutorialStep[],
  nav: TutorialNavEntry,
): void {
  const frontmatter = [
    '---',
    'layout: tutorial',
    `slug: ${slug}`,
    `title: "${title.replace(/"/g, '\\"')}"`,
    `description: "${description.replace(/"/g, '\\"')}"`,
    `time: ${time}`,
    `level: ${level}`,
    `tags: [${tags.map(t => `"${t}"`).join(', ')}]`,
    `primaryTag: "${primaryTag}"`,
    `author: "${author}"`,
    `stepCount: ${steps.length}`,
    `missionId: ${nav.missionId}`,
    `groupId: ${nav.groupId}`,
    `groupTitle: "${nav.groupTitle}"`,
    nav.prev ? `prev: "${nav.prev}"` : 'prev: null',
    nav.next ? `next: "${nav.next}"` : 'next: null',
    '---',
    '',
  ].join('\n')

  const youWillLearnMd = youWillLearn.length > 0
    ? `## You will learn\n\n${youWillLearn.map(item => `- ${item}`).join('\n')}\n\n`
    : ''

  const prereqMd = prerequisites
    ? `## Prerequisites\n\n${prerequisites}\n\n`
    : ''

  const stepsMd = steps.map(step =>
    `<TutorialStep :number="${step.number}" title="${step.title.replace(/"/g, '&quot;')}" slug="${slug}">\n\n${step.content}\n\n</TutorialStep>`
  ).join('\n\n')

  const content = `${frontmatter}# ${title}\n\n${youWillLearnMd}${prereqMd}${stepsMd}\n`

  mkdirSync(OUTPUT_DIR, { recursive: true })
  writeFileSync(join(OUTPUT_DIR, `${slug}.md`), content, 'utf-8')
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

    navEntries[i].title = title

    writeVitePressPage(
      t.slug,
      title,
      description,
      frontmatter.time ?? 15,
      level,
      frontmatter.tags ?? [],
      frontmatter.primary_tag ?? '',
      frontmatter.author_name ?? 'Unknown',
      youWillLearn,
      prerequisites,
      steps,
      navEntries[i],
    )

    console.log(`  → ${steps.length} steps, level: ${level}, time: ${frontmatter.time}min`)
  }

  const navPath = join(OUTPUT_DIR, '_nav.json')
  writeFileSync(navPath, JSON.stringify(navEntries, null, 2), 'utf-8')
  console.log(`\nWrote ${POC_TUTORIALS.length} tutorials + nav to ${OUTPUT_DIR}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
