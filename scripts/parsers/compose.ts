import { extractFrontmatter } from './frontmatter.js'
import { resolveImageURLs } from './images.js'
import { convertOptionBlocks } from './options.js'
import { parseV1Steps } from './v1.js'
import { parseV2Steps } from './v2.js'
import { extractBranchGroups, BranchParseError } from './branches.js'
import type { BranchGroup } from './branches.js'
import { parseRulesVrEnriched } from './rules.js'
import { parseCodeCheckBlocks, attachCodeCheckSpecs } from './codecheck.js'
import type { TutorialStep, TutorialFrontmatter } from './types.js'

/**
 * Normalize line endings to LF. Catches CRLF (Windows / GitHub-via-Windows-
 * clients) and CR-only (legacy Mac) input so downstream regexes that anchor
 * on `$` see consistent line terminators.
 *
 * Why this matters: JS regex `$` (without the `m` flag) only matches before
 * `\n` or end-of-string, NOT before `\r`. The metacharacter `.` excludes
 * `\r` (and `\n`), so `/^### (.+)$/` against `### foo\r` returns null —
 * `(.+)` cannot consume the `\r`, and `$` cannot match before it. Result:
 * tutorials with CRLF source produce 0 steps from parseV2Steps even when
 * they have valid `### ` H3 step headings. Surfaced by #432 (~30 tutorials
 * quarantined per publish).
 *
 * Spec: docs/superpowers/specs/2026-06-19-validate-tutorials-stepcount-crlf-design.md
 */
export function normalizeLineEndings(s: string): string {
  return s.replace(/\r\n?/g, '\n')
}

export interface ComposeOpts {
  repo: string
  branch: string
  slug: string
  target: 'hugo' | 'vitepress'
  rewriteImages: boolean
  /**
   * [#655] Optional rules.vr companion content. When provided, this function
   * parses it and merges validation + codecheck + AI flags into `steps`.
   * The standard fetch-tutorials path does NOT use this — it merges separately
   * because it also writes sidecar JSON files. Preview is the only consumer.
   */
  rulesVr?: string
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
  // [#432] Normalize CRLF/CR-only to LF so every downstream parser sees
  // consistent line terminators. parseV2Steps's /^### (.+)$/ would otherwise
  // return 0 steps for CRLF tutorials.
  const normalized = normalizeLineEndings(rawMd)
  const { title, description, youWillLearn, prerequisites, level, frontmatter, body } =
    extractFrontmatter(normalized)

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

  // [#655] Preview-mode rules.vr merge. Only runs when rulesVr is supplied
  // (preview path). Fetch-tutorials.ts has its own merge that also writes
  // sidecar JSON files; this stays a separate code path.
  if (opts.rulesVr && opts.rulesVr.trim()) {
    const enriched = parseRulesVrEnriched(opts.rulesVr)
    for (const [validateNum, questions] of enriched.map) {
      if (!questions.length) continue
      const target = steps.find(s => s.number === validateNum)
      if (target) {
        target.validation = [...(target.validation ?? []), ...questions]
        if (questions.some(q => q.aiGrading)) target.aiInvolved = true
      }
    }
    // AUTOAUTHOR_ALL marks every step AI-involved (we never expand the
    // questions themselves in preview — the directive itself is shown via
    // the AI notice).
    if (enriched.allDirective) {
      for (const step of steps) step.aiInvolved = true
    }
    const codeCheckMap = parseCodeCheckBlocks(opts.rulesVr)
    if (codeCheckMap.size) {
      attachCodeCheckSpecs(steps, codeCheckMap)
      for (const step of steps) {
        if (step.codeCheck) step.aiInvolved = true
      }
    }
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
