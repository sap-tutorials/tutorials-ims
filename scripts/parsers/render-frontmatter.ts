import { stringify as yamlStringify } from 'yaml'
import { humanizeTag, splitPrerequisites } from './frontmatter-utils.js'
import type { TagLabelRegistry } from './frontmatter-utils.js'
import { escapeHugoDelimiters } from './hugo-delimiters.js'
import { stripDangerousHtml } from './sanitize-html.js'
import type { TutorialStep, TutorialNavEntry } from './types.js'

export interface RenderHugoFrontmatterArgs {
  slug: string
  title: string
  description: string
  time: number
  level: string
  tags: string[]
  primaryTag: string
  author: string
  authorProfile: string
  youWillLearn: string[]
  prerequisites: string
  steps: TutorialStep[]
  nav: TutorialNavEntry
  lastUpdated: string
  createdAt: string
  contributors: Array<{ name: string; login: string; email: string; avatarUrl: string }>
  registry?: TagLabelRegistry
}

export function renderHugoFrontmatter(args: RenderHugoFrontmatterArgs): string {
  const {
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
  } = args

  const cleanTags = tags.map(t => t.replace(/\\/g, ''))
  const cleanPrimaryTag = primaryTag.replace(/\\/g, '')

  const dedupedRawSlugs = [...new Set([cleanPrimaryTag, ...cleanTags])].filter(s => s.length > 0)

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
    displayTags: dedupedRawSlugs.map(s => humanizeTag(s, registry)).filter(t => t.length > 0),
    displayTagSlugs: dedupedRawSlugs,
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

  return content
}
