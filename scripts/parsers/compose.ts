import { extractFrontmatter } from './frontmatter.js'
import { resolveImageURLs } from './images.js'
import { convertOptionBlocks } from './options.js'
import { parseV1Steps } from './v1.js'
import { parseV2Steps } from './v2.js'
import type { TutorialStep, TutorialFrontmatter } from './types.js'

export interface ComposeOpts {
  repo: string
  branch: string
  slug: string
  target: 'hugo' | 'vitepress'
  rewriteImages: boolean
}

export interface ComposeResult {
  title: string
  description: string
  youWillLearn: string[]
  prerequisites: string
  level: string
  frontmatter: TutorialFrontmatter
  steps: TutorialStep[]
  body: string
  hasOsOptions: boolean
}

export function composeTutorial(rawMd: string, opts: ComposeOpts): ComposeResult {
  const { title, description, youWillLearn, prerequisites, level, frontmatter, body } =
    extractFrontmatter(rawMd)

  const isV2 = frontmatter.parser === 'v2'
  let processedBody = resolveImageURLs(body, {
    repo: opts.repo, branch: opts.branch, slug: opts.slug,
    rewriteImages: opts.rewriteImages,
  })

  const hasOsOptionsFlag = { value: false }
  const resolvedStepSlugs = new Set<string>()
  processedBody = convertOptionBlocks(processedBody, opts.target, {
    osOverrides: frontmatter.osOverrides,
    hasOsOptionsOut: hasOsOptionsFlag,
    resolvedStepSlugsOut: resolvedStepSlugs,
  })

  // Warn on osOverrides keys that never matched any step heading on the page.
  if (frontmatter.osOverrides && opts.target === 'hugo') {
    const unmatched = Object.keys(frontmatter.osOverrides).filter((k) => !resolvedStepSlugs.has(k))
    if (unmatched.length) {
      console.warn(
        `[compose] osOverrides on tutorial "${opts.slug}" has unmatched step slug(s): ${unmatched.join(', ')}`
      )
    }
  }

  processedBody = processedBody.replace(/^<{4,7} .+\n[\s\S]*?^={4,7}\n([\s\S]*?)^>{4,7} .+\n?/gm, '$1')

  const steps = isV2 ? parseV2Steps(processedBody) : parseV1Steps(processedBody)

  return {
    title,
    description,
    youWillLearn,
    prerequisites,
    level,
    frontmatter,
    steps,
    body: processedBody,
    hasOsOptions: hasOsOptionsFlag.value,
  }
}
