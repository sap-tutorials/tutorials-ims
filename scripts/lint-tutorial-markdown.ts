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

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

export type LintFinding = {
  rule: string
  slug: string
  file: string
  line: number
  message: string
  excerpt: string
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

export function lintTutorial(slug: string, source: string): LintFinding[] {
  const rawLines = source.split('\n')
  const lines = redactCodeFences(rawLines)
  const findings: LintFinding[] = []
  for (const rule of RULES) {
    findings.push(...rule.scan(slug, lines, rawLines))
  }
  return findings
}

function main() {
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

  const allFindings: LintFinding[] = []
  for (const file of files) {
    const slug = file.replace(/\.md$/, '')
    const source = readFileSync(join(cacheDir, file), 'utf-8')
    allFindings.push(...lintTutorial(slug, source))
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

  if (strict && allFindings.length > 0) {
    console.error(`\n--strict: exiting non-zero because ${allFindings.length} finding(s) detected`)
    process.exit(1)
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}`
if (isMain || import.meta.url.endsWith(process.argv[1]?.replace(/\\/g, '/'))) {
  main()
}
