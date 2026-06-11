import { extractFrontmatter } from './frontmatter.js'
import { resolveImageURLs } from './images.js'
import { convertOptionBlocks } from './options.js'
import { parseV1Steps } from './v1.js'
import { parseV2Steps } from './v2.js'
import { extractBranchGroups, BranchParseError } from './branches.js'
import type { BranchGroup } from './branches.js'
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

  // [#172 PR 3] On the v2 path, run the branches pre-pass BEFORE parseV2Steps.
  // Strips [BRANCH_BEGIN]…[BRANCH_END] blocks from the body and extracts
  // structured BranchGroup metadata to attach to parent step entries.
  let v2Body = processedBody
  let branchGroups: BranchGroup[] = []
  if (isV2) {
    try {
      const r = extractBranchGroups(processedBody, opts.slug)
      v2Body = r.rewrittenBody
      branchGroups = r.branchGroups
    } catch (err) {
      if (err instanceof BranchParseError) {
        // Re-throw with file/slug context so fetch-tutorials.ts surfaces it
        // alongside its existing parse errors. The caller (compose.ts's caller)
        // owns the failure UX — we just preserve the BranchParseError shape.
        throw err
      }
      throw err
    }
  }
  const steps = isV2 ? parseV2Steps(v2Body) : parseV1Steps(processedBody)

  // Merge branchGroups onto parent step entries by parentStepNumber.
  for (const g of branchGroups) {
    const parent = steps.find(s => s.number === g.parentStepNumber)
    if (!parent) {
      // Shouldn't happen if the parser counted correctly; defensive log only.
      console.warn(`[branch-parse] ${opts.slug}: branch group ${g.id} references missing parent step ${g.parentStepNumber}`)
      continue
    }
    parent.branchGroup = g.groupKey
    parent.branchPointId = g.id
    parent.branches = g.branches
  }

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
