/**
 * lint-tutorial-markdown — author-side smell detector for tutorial source markdown.
 *
 * Runs against the raw markdown cached in `.tutorial-cache/<slug>.md` (i.e. the
 * unmodified author input), not against parsed Hugo output. The goal is to
 * catch smells that produce malformed DOM downstream — patterns the markdown
 * parser tolerates but renders awkwardly.
 *
 * Each rule is a high-precision detector: it should fire on a specific
 * structural smell, not a stylistic preference. False positives erode trust
 * and the warnings get ignored.
 *
 * Output: a JSON report at `.tutorial-cache/lint-report.json` and a human
 * summary on stdout. Exits 0 by default (warnings only); pass `--strict` to
 * exit non-zero on any finding.
 *
 * Why this exists: see issue #168 + PR #190. Tutorial source for
 * `abap-environment-create-cds-mde.md` had `2.` indented 4 spaces under `1.`,
 * which CommonMark turned into a nested `<ol start="2">`. The new platform
 * surfaces malformed DOM more visibly than legacy AEM did, so author-side
 * smells that were tolerated for years now render as layout glitches.
 */

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { extractBranchGroups, BranchParseError } from './parsers/branches.ts'
import { prefetchBranchStaleness, branchStalenessRule } from './lint-rules/branch-staleness'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

export type LintSeverity = 'error' | 'warning' | 'notice'

export type LintFinding = {
  rule: string
  slug: string
  file: string
  line: number
  message: string
  excerpt: string
  /** Optional. Branch-syntax rule emits 'error'; legacy rules omit (treated as 'warning'). */
  severity?: LintSeverity
}

type Rule = {
  id: string
  describe: string
  /** Returns findings for a single tutorial. Receives the body with code
   *  fences already redacted (replaced with blank lines) so rules don't have
   *  to re-implement that. */
  scan(slug: string, lines: string[], rawLines: string[]): LintFinding[]
}

/**
 * Replace lines inside fenced code blocks (``` ... ```) with empty strings.
 * Preserves line numbers so findings still point at the right line.
 *
 * Doesn't try to handle indented code blocks (4-space indent) — those are
 * legitimate prose-with-indent in many tutorials and conflating them with
 * code fences would suppress real findings.
 */
function redactCodeFences(lines: string[]): string[] {
  const out: string[] = []
  let inFence = false
  for (const line of lines) {
    // Match opening or closing fence: optional leading whitespace, then ``` or ~~~
    const fenceMatch = line.match(/^[ \t]{0,3}(```|~~~)/)
    if (fenceMatch) {
      inFence = !inFence
      out.push('')
      continue
    }
    out.push(inFence ? '' : line)
  }
  return out
}

/**
 * Rule: indented-numbered-list-item.
 *
 * Detects an ordered-list item whose number is > 1 and is indented further
 * than the originating `1.`. CommonMark turns this into a nested
 * `<ol start="N">`, which renders with extra rhythm and misaligned numbering.
 *
 * The detector tracks ordered-list contexts state-machine style: when we see
 * `1.` at column C, we remember C as the base indent for that list. A
 * subsequent `2.`, `3.`, etc. at column > C is the smell. A subsequent
 * sibling at column == C resets `lastNum`. A blank line followed by non-list
 * content terminates the list.
 *
 * Tolerance: only flag items whose indent is at least 2 columns past the base
 * — single-space drift is usually a typo that still renders OK.
 */
const indentedNumberedListItem: Rule = {
  id: 'indented-numbered-list-item',
  describe: 'Numbered list item indented under a sibling — CommonMark nests it as a separate <ol start="N">.',
  scan(slug, lines) {
    const findings: LintFinding[] = []
    // Stack of currently-open ordered-list contexts so nested-but-correct
    // lists don't trigger false positives. Each entry: { baseIndent, lastNum }.
    let stack: Array<{ baseIndent: number; lastNum: number }> = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      const m = line.match(/^([ \t]*)(\d+)\.\s/)
      if (!m) {
        // Blank line doesn't immediately close a list (CommonMark allows
        // a blank line followed by an indented continuation), but a
        // non-blank line with no leading whitespace and no list marker does.
        if (line.length > 0 && !/^[ \t]/.test(line) && !/^#{1,6}\s/.test(line)) {
          stack = []
        }
        continue
      }
      // Treat tabs as 4 spaces for indent comparison
      const indentStr = m[1].replace(/\t/g, '    ')
      const indent = indentStr.length
      const num = parseInt(m[2], 10)

      // Pop list contexts that are at or above this item's indent
      while (stack.length && indent < stack[stack.length - 1].baseIndent) {
        stack.pop()
      }

      const top = stack[stack.length - 1]
      if (num === 1) {
        if (top && top.baseIndent === indent) {
          // Restart of a sibling list at same indent
          stack[stack.length - 1] = { baseIndent: indent, lastNum: 1 }
        } else {
          stack.push({ baseIndent: indent, lastNum: 1 })
        }
        continue
      }
      // num > 1
      if (top && indent === top.baseIndent) {
        top.lastNum = num
        continue
      }
      if (top && indent > top.baseIndent && indent - top.baseIndent >= 2) {
        // The smell. Only flag if this number is the natural continuation
        // (top.lastNum + 1) — that's the strongest signal that the author
        // meant it as a sibling, not a deliberately renumbered nested list.
        if (num === top.lastNum + 1) {
          findings.push({
            rule: indentedNumberedListItem.id,
            slug,
            file: `${slug}.md`,
            line: i + 1,
            message: `Item \`${num}.\` indented ${indent} columns; sibling \`${top.lastNum}.\` is at column ${top.baseIndent}. CommonMark will nest it as a separate <ol start="${num}">.`,
            excerpt: line.slice(0, 100),
          })
          // Treat the malformed item as continuing the parent list so the
          // detector keeps tracking lastNum across the whole run; each
          // subsequent indented sibling will still produce its own finding.
          top.lastNum = num
        }
      }
    }
    return findings
  },
}

const RULES: Rule[] = [indentedNumberedListItem]

/**
 * Rule: branch-syntax (issue #172 PR 3).
 *
 * Runs the strict branch-marker pre-pass parser (`extractBranchGroups`) and
 * surfaces any `BranchParseError` it throws as a single error-severity
 * finding. Catches:
 *   - unbalanced [BRANCH_BEGIN] / [BRANCH_END]
 *   - nested [BRANCH_BEGIN] inside another branch
 *   - duplicate `key=` within the same group
 *   - unparseable `condition=` expressions
 *
 * Operates on the raw markdown (not code-fence-redacted) because the parser
 * has its own opinions about what constitutes a marker. Hard-error severity:
 * downstream tooling (CI) should treat any branch-syntax finding as a build
 * blocker — a malformed branch group corrupts the rest of the parse.
 */
export function branchSyntaxRule(slug: string, source: string): LintFinding[] {
  try {
    extractBranchGroups(source, slug)
    return []
  } catch (err) {
    if (err instanceof BranchParseError) {
      const lineIdx = Math.max(0, err.line - 1)
      const excerpt = source.split('\n')[lineIdx] ?? ''
      return [{
        rule: 'branch-syntax',
        slug,
        file: `${slug}.md`,
        line: err.line,
        message: err.message,
        excerpt: excerpt.slice(0, 100),
        severity: 'error',
      }]
    }
    throw err
  }
}

export function lintTutorial(slug: string, source: string): LintFinding[] {
  const rawLines = source.split('\n')
  const lines = redactCodeFences(rawLines)
  const findings: LintFinding[] = []
  for (const rule of RULES) {
    findings.push(...rule.scan(slug, lines, rawLines))
  }
  findings.push(...branchSyntaxRule(slug, source))
  return findings
}

async function main() {
  const args = process.argv.slice(2)
  const strict = args.includes('--strict')
  const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : 'prod'
  const cacheDir = channel === 'qa'
    ? join(ROOT, '.tutorial-cache-qa')
    : join(ROOT, '.tutorial-cache')

  if (!existsSync(cacheDir)) {
    console.error(`Cache directory not found: ${cacheDir}`)
    console.error('Run `npm run fetch-tutorials` first.')
    process.exit(strict ? 2 : 0)
  }

  const files = readdirSync(cacheDir).filter(f => f.endsWith('.md') && !f.startsWith('_'))
  console.log(`Linting ${files.length} tutorial markdown files in ${cacheDir}...\n`)

  // ── Round-3 sync-runner pivot: ONE async pre-pass before the per-file loop. ──
  // Empty cache on missing token / network error / 401. Per-slug rule invocation
  // returns [] when the cache has no entry for that slug, so missing pre-pass is
  // indistinguishable from missing-data-for-this-slug — both silently skip.
  const allSlugs = files.map(f => f.replace(/\.md$/, ''))
  const stalenessCache = await prefetchBranchStaleness({
    slugs: allSlugs,
    env: {
      TUTORIAL_AUTHOR_TOKEN: process.env.TUTORIAL_AUTHOR_TOKEN,
      ANALYTICS_BASE_URL: process.env.ANALYTICS_BASE_URL,
    },
    fetch: globalThis.fetch,
  })

  const allFindings: LintFinding[] = []
  for (const file of files) {
    const slug = file.replace(/\.md$/, '')
    const source = readFileSync(join(cacheDir, file), 'utf-8')
    try {
      // lintTutorial: completely unchanged signature, sync.
      const findings = lintTutorial(slug, source)

      // branchStalenessRule: sync. Caller (this main loop) parses branches up
      // front via extractBranchGroups and passes them in. Rule is a pure
      // function over (slug, branches, cache). Skips silently when the parser
      // throws (parser-broken tutorials are flagged separately by
      // branchSyntaxRule via lintTutorial; staleness has nothing useful to say
      // without structured groups).
      let branchInputs: { tutorialSlug: string; branchPointId: string; beginLine: number }[] = []
      try {
        const result = extractBranchGroups(source, slug)
        branchInputs = result.branchGroups.map(g => ({
          tutorialSlug: slug,
          branchPointId: g.id,           // ${parentStepNumber}-${groupKey} — see recon §8
          beginLine: g.beginLine,        // promoted in Task 1
        }))
      } catch (err) {
        if (!(err instanceof BranchParseError)) throw err
        // BranchParseError: branchSyntaxRule (called from lintTutorial) already emitted
        // the user-facing finding; staleness has nothing useful to say without
        // structured groups. Fall through with empty branchInputs → rule returns [].
      }
      findings.push(...branchStalenessRule({ slug, branches: branchInputs, cache: stalenessCache }))

      allFindings.push(...findings)
    } catch (err) {
      // Per-file try/catch (round-3 NEW-B7 fix): one bad tutorial must not abort the run.
      // Unhandled rejections in Node 22 default-terminate the process; this guard
      // ensures CI returns a real lint summary even when one slug throws.
      console.error(`Failed to lint ${slug}:`, err)
    }
  }

  // Group by slug for the report
  const bySlug = new Map<string, LintFinding[]>()
  for (const f of allFindings) {
    const list = bySlug.get(f.slug) ?? []
    list.push(f)
    bySlug.set(f.slug, list)
  }

  if (allFindings.length === 0) {
    console.log('No findings.')
  } else {
    console.log(`${allFindings.length} finding(s) across ${bySlug.size} tutorial(s):\n`)
    for (const [slug, findings] of [...bySlug.entries()].sort()) {
      console.log(`  ${slug}.md`)
      for (const f of findings) {
        console.log(`    L${f.line} [${f.rule}] ${f.message}`)
        console.log(`      ${f.excerpt}`)
      }
    }
  }

  // Write JSON report for CI consumption
  mkdirSync(cacheDir, { recursive: true })
  const reportPath = join(cacheDir, 'lint-report.json')
  writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    channel,
    fileCount: files.length,
    findingCount: allFindings.length,
    affectedSlugs: bySlug.size,
    findings: allFindings,
  }, null, 2), 'utf-8')
  console.log(`\nReport written to ${reportPath}`)

  // Strict-mode exit (round-3 I9 fix): notices are non-blocking by design; only
  // count error/warning toward strict-mode failure.
  const blockingCount = allFindings.filter(f => f.severity !== 'notice').length
  if (strict && blockingCount > 0) {
    console.error(`\n--strict: exiting non-zero because ${blockingCount} blocking finding(s) detected (notices excluded)`)
    process.exit(1)
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
if (isMain || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  main().catch(err => { console.error(err); process.exit(1) })
}
