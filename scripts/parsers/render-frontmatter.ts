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
  /** [#173] When true, page body contains at least one os-options shortcode. */
  hasOsOptions?: boolean
  /**
   * [#655] Verbatim rules.vr source. When set + non-empty, emitted as a top-level
   * frontmatter field so Hugo's baseof.html can render
   * `<script id="rules-vr-source" type="application/x-rules-vr">…</script>`
   * for PreviewAINotice components. Preview path only — fetch-tutorials.ts
   * doesn't set this.
   */
  rulesVrSource?: string
  /**
   * [#655] Precomputed flag: true when ANY step has aiInvolved set. Hugo uses
   * this for `<body data-has-ai="…">` so the chrome layer can render a static
   * "AI features previewable after publish" notice without re-walking steps.
   */
  hasAi?: boolean
  /**
   * GitHub login extracted from authorProfile by extractGithubLoginFromProfile().
   * When set, becomes the canonical owner signal that drives Tutorials.author_ID
   * at publish time. Null/undefined/empty → omitted from frontmatter so non-GitHub
   * author_profile values don't produce stray keys in built Hugo pages.
   */
  githubLogin?: string | null
  /**
   * When true, `<img src="data:image/...;base64,...">` references pass
   * through sanitization for the raster MIME allowlist in sanitize-html.ts.
   * Preview-only opt-in (srv-qa/preview-renderer.js); published content
   * stays on the default HTTPS-scheme allowlist.
   */
  allowDataUrls?: boolean
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
    hasOsOptions,
    rulesVrSource,
    hasAi,
    githubLogin,
    allowDataUrls,
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
      if (s.codeCheck) entry.codeCheck = s.codeCheck
      // [#172] PR 3 — step-level branch + skip metadata. Optional; only emit
      // when populated. branches.ts pre-pass attaches branchGroup/branchPointId/
      // branches; authors hand-write skipIf/skipLabel/skipReason in YAML.
      if (s.branchGroup)         entry.branchGroup   = s.branchGroup
      if (s.branchPointId)       entry.branchPointId = s.branchPointId
      if (s.branches?.length)    entry.branches      = s.branches
      if (s.skipIf)              entry.skipIf        = s.skipIf
      if (s.skipLabel)           entry.skipLabel     = s.skipLabel
      if (s.skipReason)          entry.skipReason    = s.skipReason
      return entry
    }),
  }

  if (nav.missionId) fm.missionId = nav.missionId
  if (nav.missionTitle) fm.missionTitle = nav.missionTitle
  if (nav.missionSlug) fm.missionSlug = nav.missionSlug
  if (nav.groupId) fm.groupId = nav.groupId
  if (nav.groupTitle) fm.groupTitle = nav.groupTitle
  if (nav.groupSlug) fm.groupSlug = nav.groupSlug
  // [#172] Task 7: mirror missionAltGroups so the mission-side-nav partial can
  // render branch chips. Normally populated only by patchTutorialFrontmatter
  // (CAP phase runs after the first page write), but emit here too if the
  // navEntry already has them — defensive against future call-order changes.
  if (nav.missionAltGroups?.length) fm.missionAltGroups = nav.missionAltGroups

  if (hasOsOptions) fm.hasOsOptions = true

  // [#655] Preview path: pass through verbatim rules.vr source + precomputed
  // AI-involved flag so Hugo's baseof.html can emit a <script id="rules-vr-source">
  // and <body data-has-ai="…"> without re-parsing in the template.
  if (rulesVrSource && rulesVrSource.length > 0) fm.rulesVrSource = rulesVrSource
  if (hasAi) fm.hasAi = true

  if (typeof githubLogin === 'string' && githubLogin.length > 0) {
    fm.githubLogin = githubLogin
  }

  const frontmatter = `---\n${yamlStringify(fm).trimEnd()}\n---\n\n`

  const stepsMd = steps.map(step =>
    `{{% tutorial-step number="${step.number}" title="${step.title.replace(/"/g, '&quot;')}" %}}\n\n${escapeHugoDelimiters(stripDangerousHtml(step.content, { allowDataUrls }))}\n\n{{% /tutorial-step %}}`
  ).join('\n\n')

  const content = `${frontmatter}${stepsMd}\n`

  return content
}
