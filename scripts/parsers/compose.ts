import { extractFrontmatter } from './frontmatter.js'
import { resolveImageURLs } from './images.js'
import { convertOptionBlocks } from './options.js'
import { parseV1Steps } from './v1.js'
import { parseV2Steps } from './v2.js'
import type { TutorialStep } from './types.js'

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
  prerequisites: string[]
  level: string
  frontmatter: Record<string, unknown>
  steps: TutorialStep[]
  body: string
}

export function composeTutorial(rawMd: string, opts: ComposeOpts): ComposeResult {
  const { title, description, youWillLearn, prerequisites, level, frontmatter, body } =
    extractFrontmatter(rawMd)

  const isV2 = frontmatter.parser === 'v2'
  let processedBody = resolveImageURLs(body, {
    repo: opts.repo, branch: opts.branch, slug: opts.slug,
    rewriteImages: opts.rewriteImages,
  })
  processedBody = convertOptionBlocks(processedBody, opts.target)
  processedBody = processedBody.replace(/^<{4,7} .+\n[\s\S]*?^={4,7}\n([\s\S]*?)^>{4,7} .+\n?/gm, '$1')

  const steps = isV2 ? parseV2Steps(processedBody) : parseV1Steps(processedBody)

  return { title, description, youWillLearn, prerequisites, level, frontmatter, steps, body: processedBody }
}
