/**
 * scan-markdown-source — source-markdown scanner + fixer (issue #1963, subsystem B).
 *
 * The AEM→Goldmark migration surfaced malformed-markdown classes that AEM
 * tolerated but strict CommonMark does not. We currently patch each class
 * IN FLIGHT with pure `(md)=>md` pre-processors wired into `composeTutorial`
 * (scripts/parsers/compose.ts). This tool detects those same classes in the
 * SOURCE markdown, fixes them at source, and (behind a flag) opens one PR per
 * `sap-tutorials` source repo — so the pre-processors can eventually be retired.
 *
 * KEY INSIGHT
 * -----------
 * Every pre-processor is a pure, idempotent string transform, so each IS its
 * own fixer: the fix is the transform's output; a finding is "output ≠ input".
 * Because the transforms are idempotent, applying the fix at source and then
 * re-running the (still-present) pre-processor yields byte-identical compose
 * output vs. running the pre-processor on the original. That equality is the
 * GOLDEN-RENDER GATE (below): any file where it does not hold is flagged for
 * manual review and never written/PR'd.
 *
 * CLASSIFICATION
 * --------------
 * Source-fixable (structural, no repo/branch/URL context) — DETECTED + FIXED:
 *   1. list-continuation-fence   (#1931)  normalizeListContinuationFences
 *   2. list-continuation-prose   (#1931f) dedentListContinuationProse
 *   3. blockquote-fence                    normalizeBlockquotedFences
 *   4. blockquote-notes          (#1741)  mergeBlockquoteNoteDividers
 *   5. image-directive-comment   (#1137)  stripImageDirectiveComments
 * Render-time (Hugo/URL concerns) — DETECTED (report-only), NEVER fixed here:
 *   6. hugo-delimiters                     escapeHugoDelimiters
 * (image URL rewrite and prerequisites-markup are render-time and intentionally
 *  not source-fixable; the relative→raw URL is correct at source.)
 *
 * USAGE
 *   tsx scripts/scan-markdown-source.ts                 # dry-run report (default)
 *   tsx scripts/scan-markdown-source.ts --fix           # + write staged fixes (no network)
 *   tsx scripts/scan-markdown-source.ts --open-prs      # + one PR per source repo (live)
 *   tsx scripts/scan-markdown-source.ts --retirement-status
 *   filters: --class <id>  --repo <name>  --slug <slug>  --limit <N>
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

import { normalizeLineEndings, composeTutorial } from './parsers/compose.ts'
import type { ComposeResult } from './parsers/compose.ts'
import { normalizeBlockquotedFences } from './parsers/blockquote-fence.ts'
import { normalizeListContinuationFences } from './parsers/list-continuation-fence.ts'
import { dedentListContinuationProse } from './parsers/list-continuation-prose.ts'
import { mergeBlockquoteNoteDividers } from './parsers/blockquote-notes.ts'
import { stripImageDirectiveComments } from './parsers/images.ts'
import { escapeHugoDelimiters } from './parsers/hugo-delimiters.ts'
import { discoverAllTutorials } from './parsers/github.ts'
import type { DiscoveredTutorial } from './parsers/github.ts'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const CACHE_DIR = join(ROOT, '.tutorial-cache')
const STAGING_DIR = join(CACHE_DIR, '_source-fixes')
const REPORT_PATH = join(CACHE_DIR, 'markdown-source-report.json')
const ORG = 'sap-tutorials'

// ── Fixer registry ───────────────────────────────────────────────────────────
// Body transforms are listed in the SAME order compose.ts threads them, so the
// chained fix matches in-flight behavior exactly.

type Classification = 'source-fixable' | 'render-time'

interface Fixer {
  id: string
  issue: string
  classification: Classification
  /** Reused pre-processor. Body-in / body-out. */
  transform: (body: string) => string
}

const SOURCE_FIXABLE: Fixer[] = [
  { id: 'blockquote-fence', issue: '', classification: 'source-fixable', transform: normalizeBlockquotedFences },
  { id: 'list-continuation-fence', issue: '#1931', classification: 'source-fixable', transform: normalizeListContinuationFences },
  { id: 'list-continuation-prose', issue: '#1931', classification: 'source-fixable', transform: dedentListContinuationProse },
  { id: 'blockquote-notes', issue: '#1741', classification: 'source-fixable', transform: mergeBlockquoteNoteDividers },
  { id: 'image-directive-comment', issue: '#1137', classification: 'source-fixable', transform: stripImageDirectiveComments },
]

// Render-time classes: detected for completeness, never written. escapeHugoDelimiters
// operates on the whole (frontmatter-stripped) body the same way.
const RENDER_TIME: Fixer[] = [
  { id: 'hugo-delimiters', issue: '', classification: 'render-time', transform: escapeHugoDelimiters },
]

// ── Frontmatter-verbatim split ────────────────────────────────────────────────
// gray-matter recognises YAML frontmatter fenced by `---` at the very start of
// the file. We split on the same boundary but keep the frontmatter block
// BYTE-FOR-BYTE and transform only the body, so the fix never rewrites YAML.

const FRONTMATTER_RE = /^(---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?)/

function splitFrontmatter(md: string): { fm: string; body: string } {
  const m = md.match(FRONTMATTER_RE)
  if (!m) return { fm: '', body: md }
  return { fm: m[1], body: md.slice(m[1].length) }
}

/** Detect the file's dominant EOL so we can restore it on write. */
function detectEol(raw: string): '\r\n' | '\n' {
  const crlf = (raw.match(/\r\n/g) ?? []).length
  const lf = (raw.match(/(?<!\r)\n/g) ?? []).length
  return crlf > lf ? '\r\n' : '\n'
}

// ── Per-file scan ─────────────────────────────────────────────────────────────

export interface Finding {
  class: string
  issue: string
  classification: Classification
  repo: string
  branch: string
  slug: string
  file: string
  line: number
  excerpt: string
}

export interface FileScan {
  findings: Finding[]
  /** null when nothing changed. */
  fixedBody: string | null
  /** Frontmatter line count, used to offset body line numbers into file space. */
  fmLineCount: number
}

/**
 * LCS line diff → indices in the BEFORE array at which an edit hunk begins.
 * Correct for transforms that add/remove lines (blockquote-notes collapse,
 * image-directive multi-line joins), where a positional compare would cascade.
 * One entry per contiguous change region, so it counts edit regions, not lines.
 */
function diffRegionStarts(before: string[], after: string[]): number[] {
  const n = before.length, m = after.length
  // LCS length table.
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = before[i] === after[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1])
    }
  }
  // Walk the diff; mark BEFORE indices that are deleted or replaced.
  const changed: boolean[] = new Array(n).fill(false)
  let i = 0, j = 0
  while (i < n && j < m) {
    if (before[i] === after[j]) { i++; j++ }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { changed[i] = true; i++ }  // deletion from before
    else { j++ }                                                          // insertion into after
  }
  while (i < n) { changed[i] = true; i++ }
  // Region starts: a changed index whose predecessor was not changed.
  const starts: number[] = []
  for (let k = 0; k < n; k++) if (changed[k] && !changed[k - 1]) starts.push(k)
  return starts
}

/**
 * Scan one tutorial's source markdown. Returns findings (with file-space line
 * numbers) and the fully-fixed body (source-fixable classes chained in compose
 * order), or null fixedBody if no source-fixable class fired.
 *
 * Line-number strategy: blockquote-fence, list-fence and list-prose preserve
 * line COUNT, so their diffs map 1:1 to source body lines. blockquote-notes
 * may remove lines but its changed region STARTS still align (collapse happens
 * at/after the reported line). image-directive-comment is located directly on
 * the source body (its comment survives all prior transforms untouched). The
 * render-time classes are located on the source body too.
 */
export function scanSource(raw: string, meta: DiscoveredTutorial): FileScan {
  const lf = normalizeLineEndings(raw)
  const { fm, body } = splitFrontmatter(lf)
  const fmLineCount = fm ? fm.split('\n').length - 1 : 0
  const file = `tutorials/${meta.slug}/${meta.slug}.md`
  const findings: Finding[] = []

  const push = (fixer: Fixer, bodyLineIdx: number, excerptLine: string) => {
    findings.push({
      class: fixer.id,
      issue: fixer.issue,
      classification: fixer.classification,
      repo: meta.repo,
      branch: meta.branch,
      slug: meta.slug,
      file,
      line: fmLineCount + bodyLineIdx + 1,
      excerpt: excerptLine.slice(0, 120),
    })
  }

  const srcLines = body.split('\n')

  // ── Detection (source-space line numbers) ──
  // Each class is DETECTED on the input it would see in compose, computed
  // independently so line indices map to the SOURCE body. blockquote-fence,
  // list-fence and list-prose preserve line COUNT, so an input built only from
  // those keeps 1:1 index alignment with the source body. A per-class try/catch
  // keeps one class's throw (or a latent pre-processor edge case) from aborting
  // the whole file scan.
  const detect = (fixer: Fixer, input: string) => {
    try {
      const after = fixer.transform(input)
      if (after === input) return
      const inLines = input.split('\n')
      for (const start of diffRegionStarts(inLines, after.split('\n'))) {
        push(fixer, start, srcLines[start] ?? inLines[start] ?? '')
      }
    } catch (err) {
      console.error(`  [${fixer.id}] detect threw on ${meta.slug}:`, err instanceof Error ? err.message : err)
    }
  }

  const bqFenced = normalizeBlockquotedFences(body)               // count-preserving
  const fenceHealed = normalizeListContinuationFences(bqFenced)   // count-preserving
  const proseHealed = dedentListContinuationProse(fenceHealed)    // count-preserving
  detect(SOURCE_FIXABLE[0], body)         // blockquote-fence  ← source body
  detect(SOURCE_FIXABLE[1], bqFenced)     // list-fence        ← after bq-fence
  detect(SOURCE_FIXABLE[2], fenceHealed)  // list-prose        ← after fence heal (required order)
  detect(SOURCE_FIXABLE[3], proseHealed)  // blockquote-notes  ← healed input compose feeds it (raw body crashes it)
  detect(SOURCE_FIXABLE[4], body)         // image-directive   ← source body (comments untouched by prior steps)
  for (const fixer of RENDER_TIME) detect(fixer, body)

  // ── Fix (chained in compose order — matches in-flight behavior) ──
  let cur = body
  for (const fixer of SOURCE_FIXABLE) cur = fixer.transform(cur)
  const anyChange = cur !== body

  return { findings, fixedBody: anyChange ? cur : null, fmLineCount }
}

/**
 * Rejoin frontmatter (verbatim) + fixed body and restore the original EOL.
 * Processing is done on LF; if the source was CRLF-dominant we convert back.
 */
export function rebuildSource(raw: string, fixedBody: string): string {
  const lf = normalizeLineEndings(raw)
  const { fm } = splitFrontmatter(lf)
  const rebuilt = fm + fixedBody
  return detectEol(raw) === '\r\n' ? rebuilt.replace(/\n/g, '\r\n') : rebuilt
}

// ── Golden-render gate ─────────────────────────────────────────────────────────
// composeTutorial applies the pre-processors in flight, so composing the
// ORIGINAL and the FIXED source must yield identical output for the fields the
// pre-processors GOVERN: steps, body, intro. We deliberately do NOT compare
// `prerequisites` / `youWillLearn` — those are extracted from their own `##`
// sections and are never run through the body pre-processors (compose only
// URL-rewrites them). A structural fix landing inside one of those sections
// therefore *legitimately* changes their rendered output (the malformed pattern
// renders broken there today); requiring equality would wrongly quarantine a
// genuine improvement. Body/steps/intro equality is the real idempotency
// invariant and still catches any body corruption.

function composeSig(src: string, meta: DiscoveredTutorial): string | null {
  try {
    const r: ComposeResult = composeTutorial(src, {
      repo: meta.repo, branch: meta.branch, slug: meta.slug,
      target: 'hugo', rewriteImages: true,
    })
    return JSON.stringify({ steps: r.steps, body: r.body, intro: r.intro })
  } catch {
    return null
  }
}

export function goldenRenderEqual(original: string, fixed: string, meta: DiscoveredTutorial): boolean {
  const a = composeSig(original, meta)
  const b = composeSig(fixed, meta)
  return a !== null && b !== null && a === b
}

// ── Discovery + local cache ─────────────────────────────────────────────────────

async function loadTutorials(filters: Filters): Promise<DiscoveredTutorial[]> {
  const { tutorials, source } = await discoverAllTutorials()
  console.log(`Discovered ${tutorials.length} tutorials (source: ${source}).`)
  let list = tutorials
  if (filters.repo) list = list.filter(t => t.repo === filters.repo)
  if (filters.slug) list = list.filter(t => t.slug === filters.slug)
  if (filters.limit) list = list.slice(0, filters.limit)
  return list
}

function readCached(slug: string): string | null {
  const p = join(CACHE_DIR, `${slug}.md`)
  return existsSync(p) ? readFileSync(p, 'utf-8') : null
}

// ── CLI ──────────────────────────────────────────────────────────────────────

interface Filters { repo?: string; slug?: string; class?: string; limit?: number }

function parseArgs(argv: string[]) {
  const has = (f: string) => argv.includes(f)
  const val = (f: string) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined)
  return {
    fix: has('--fix') || has('--open-prs'),
    openPrs: has('--open-prs'),
    retirementStatus: has('--retirement-status'),
    // Clone each fixed repo (+ Contribution pair) and re-scan its LIVE content,
    // read-only — the authoritative post-merge check for the retirement gate
    // (the local cache goes stale the moment source PRs merge).
    verifyRemote: has('--verify-remote'),
    // Contribution repos (<repo>-Contribution) are the upstream where edits are
    // authored before being copied to the published repo, so a fix applied only
    // to the published repo is at risk of being overwritten on the next copy.
    // Default ON: for every published target we also PR its Contribution pair.
    includeContribution: !has('--no-contribution'),
    // Keep PRs reviewable: at most N tutorials per PR (large repos → many PRs).
    batchSize: val('--batch-size') ? Math.max(1, parseInt(val('--batch-size')!, 10)) : 10,
    filters: {
      repo: val('--repo'),
      slug: val('--slug'),
      class: val('--class'),
      limit: val('--limit') ? parseInt(val('--limit')!, 10) : undefined,
    } as Filters,
  }
}

interface Scanned { meta: DiscoveredTutorial; raw: string; scan: FileScan }

async function run() {
  const args = parseArgs(process.argv.slice(2))
  if (!existsSync(CACHE_DIR)) {
    console.error(`Cache dir not found: ${CACHE_DIR}. Run \`npm run fetch-tutorials\` first.`)
    process.exit(2)
  }

  const tutorials = await loadTutorials(args.filters)
  const scanned: Scanned[] = []
  const allFindings: Finding[] = []

  for (const meta of tutorials) {
    const raw = readCached(meta.slug)
    if (raw === null) continue
    let scan: FileScan
    try {
      scan = scanSource(raw, meta)
    } catch (err) {
      console.error(`Failed to scan ${meta.slug}:`, err)
      continue
    }
    let findings = scan.findings
    if (args.filters.class) findings = findings.filter(f => f.class === args.filters.class)
    if (findings.length) {
      scanned.push({ meta, raw, scan })
      allFindings.push(...findings)
    }
  }

  // ── Report ──
  const byClass: Record<string, { count: number; files: number; repos: string[]; sourceFixable: boolean }> = {}
  const filesPerClass: Record<string, Set<string>> = {}
  for (const f of allFindings) {
    const e = byClass[f.class] ??= { count: 0, files: 0, repos: [], sourceFixable: f.classification === 'source-fixable' }
    e.count++
    if (!e.repos.includes(f.repo)) e.repos.push(f.repo)
    ;(filesPerClass[f.class] ??= new Set()).add(f.slug)
  }
  for (const [id, set] of Object.entries(filesPerClass)) byClass[id].files = set.size

  const retirement: Record<string, { remaining: number; readyToRetire: boolean }> = {}
  for (const fixer of SOURCE_FIXABLE) {
    const remaining = byClass[fixer.id]?.count ?? 0
    retirement[fixer.id] = { remaining, readyToRetire: remaining === 0 }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    scannedTutorials: tutorials.length,
    affectedFiles: scanned.length,
    findingCount: allFindings.length,
    byClass,
    retirement,
    findings: allFindings,
  }
  mkdirSync(CACHE_DIR, { recursive: true })
  writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), 'utf-8')

  console.log(`\n${allFindings.length} finding(s) across ${scanned.length} file(s):`)
  for (const [id, e] of Object.entries(byClass).sort((a, b) => b[1].count - a[1].count)) {
    console.log(`  ${e.sourceFixable ? '[fix] ' : '[rt]  '}${id.padEnd(26)} ${String(e.count).padStart(6)} occ  ${String(e.files).padStart(4)} file(s)  (${e.repos.length} repo${e.repos.length === 1 ? '' : 's'})`)
  }
  console.log(`\nReport → ${REPORT_PATH}`)

  if (args.retirementStatus) printRetirement(retirement)

  // Read-only post-merge verification against live GitHub content.
  if (args.verifyRemote) {
    const pt = new Map<string, string>()
    for (const s of scanned) if (s.scan.fixedBody) pt.set(s.meta.repo, s.meta.branch)
    await verifyRemote([...pt].map(([repo, branch]) => ({ repo, branch })),
      { includeContribution: args.includeContribution, slug: args.filters.slug })
    return
  }

  if (!args.fix) {
    console.log('\nDry-run (default). Pass --fix to stage corrected files, --open-prs to open PRs.')
    return
  }

  // ── Fix: golden-gate + stage corrected files ──
  const staged: Scanned[] = []
  const manualReview: string[] = []
  rmSync(STAGING_DIR, { recursive: true, force: true })
  for (const s of scanned) {
    if (!s.scan.fixedBody) continue // only render-time findings; nothing to write
    const fixedSrc = rebuildSource(s.raw, s.scan.fixedBody)
    if (!goldenRenderEqual(s.raw, fixedSrc, s.meta)) {
      manualReview.push(s.meta.slug)
      continue
    }
    const outPath = join(STAGING_DIR, s.meta.repo, 'tutorials', s.meta.slug, `${s.meta.slug}.md`)
    mkdirSync(dirname(outPath), { recursive: true })
    writeFileSync(outPath, fixedSrc, 'utf-8')
    staged.push(s)
  }
  console.log(`\nStaged ${staged.length} fixed file(s) under ${STAGING_DIR}.`)
  if (manualReview.length) {
    console.warn(`⚠ ${manualReview.length} file(s) failed the golden-render gate → NEEDS-MANUAL-REVIEW (not staged/PR'd):`)
    manualReview.forEach(s => console.warn(`    ${s}`))
  }

  if (!args.openPrs) {
    console.log('\nStaged only. Pass --open-prs to open PRs (≤10 tutorials each, incl. each repo\'s -Contribution pair).')
    return
  }

  // Published targets = repos with ≥1 source-fixable finding, keyed to their
  // discovered branch. Contribution pairs are added inside openPullRequests.
  const publishedTargets = new Map<string, string>()
  for (const s of staged) publishedTargets.set(s.meta.repo, s.meta.branch)
  const targets: RepoTarget[] = [...publishedTargets].map(([repo, branch]) => ({ repo, branch }))
  await openPullRequests(targets, {
    batchSize: args.batchSize,
    includeContribution: args.includeContribution,
    slug: args.filters.slug,
  })
}

function printRetirement(retirement: Record<string, { remaining: number; readyToRetire: boolean }>) {
  console.log('\n── Retirement status (per source-fixable class) ──')
  const files: Record<string, string> = {
    'blockquote-fence': 'scripts/parsers/blockquote-fence.ts',
    'list-continuation-fence': 'scripts/parsers/list-continuation-fence.ts',
    'list-continuation-prose': 'scripts/parsers/list-continuation-prose.ts',
    'blockquote-notes': 'scripts/parsers/blockquote-notes.ts',
    'image-directive-comment': 'scripts/parsers/images.ts (stripImageDirectiveComments call)',
  }
  for (const [id, r] of Object.entries(retirement)) {
    if (r.readyToRetire) {
      console.log(`  ✅ ${id}: 0 remaining — READY TO RETIRE`)
      console.log(`       delete/unwire ${files[id]}, remove its compose.ts call + test`)
    } else {
      console.log(`  ⏳ ${id}: ${r.remaining} remaining — keep pre-processor`)
    }
  }
  console.log('  (Deletion is gated on MERGED source PRs; this session does not delete.)')
}

// ── PR delivery (clone-driven, batched, Contribution-aware) ────────────────────

function git(cwd: string, ...cmd: string[]) {
  return execFileSync('git', cmd, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

interface RepoTarget { repo: string; branch?: string }  // branch undefined → detect default
interface RepoFix { slug: string; relPath: string; fixed: string; classes: string[] }

/** Split into fixed-size chunks (one PR per chunk). */
export function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

/** A published target plus its `<repo>-Contribution` upstream pair. */
function expandTargets(publishedTargets: RepoTarget[], includeContribution: boolean): RepoTarget[] {
  const targets: RepoTarget[] = []
  for (const t of publishedTargets) {
    targets.push(t)
    if (includeContribution && !t.repo.endsWith('-Contribution')) targets.push({ repo: `${t.repo}-Contribution` })
  }
  return targets
}

/**
 * Clone `<repo>` (default or discovered branch) into a temp dir and return the
 * base branch, or null if the clone failed. Caller owns cleanup of `tmp`.
 */
function cloneRepo(target: RepoTarget, tmp: string): string | null {
  rmSync(tmp, { recursive: true, force: true })
  const cloneArgs = ['repo', 'clone', `${ORG}/${target.repo}`, tmp, '--']
  if (target.branch) cloneArgs.push('--branch', target.branch)
  cloneArgs.push('--depth', '1')
  try {
    execFileSync('gh', cloneArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
  } catch {
    return null
  }
  return target.branch ?? git(tmp, 'rev-parse', '--abbrev-ref', 'HEAD').trim()
}

/**
 * Read-only post-merge check: clone each fixed repo (+ Contribution pair) and
 * re-scan its LIVE content, tallying remaining source-fixable findings per
 * class. Zero across every repo → that class's pre-processor is safe to retire.
 */
async function verifyRemote(publishedTargets: RepoTarget[], opts: { includeContribution: boolean; slug?: string }) {
  const targets = expandTargets(publishedTargets, opts.includeContribution)
  console.log(`\nVerifying ${targets.length} repo(s) against live GitHub content` +
    `${opts.includeContribution ? ' (incl. Contribution pairs)' : ''}...`)
  const byClass: Record<string, number> = {}
  let cleanRepos = 0
  for (const target of targets) {
    const tmp = join(tmpdir(), `md-src-verify-${target.repo}-${process.pid}`)
    try {
      const base = cloneRepo(target, tmp)
      if (base === null) { console.log(`  ${target.repo}: clone failed — skipped.`); continue }
      const tutDir = join(tmp, 'tutorials')
      if (!existsSync(tutDir)) { console.log(`  ${target.repo}: no tutorials/ — skipped.`); continue }
      let repoRemaining = 0
      for (const slug of readdirSync(tutDir)) {
        if (opts.slug && slug !== opts.slug) continue
        const fp = join(tutDir, slug, `${slug}.md`)
        if (!existsSync(fp)) continue
        const fresh = readFileSync(fp, 'utf-8')
        let scan: FileScan
        try { scan = scanSource(fresh, { slug, repo: target.repo, branch: base }) } catch { continue }
        for (const f of scan.findings) {
          if (f.classification !== 'source-fixable') continue
          byClass[f.class] = (byClass[f.class] ?? 0) + 1
          repoRemaining++
        }
      }
      if (repoRemaining === 0) { cleanRepos++; console.log(`  ✅ ${target.repo}: clean`) }
      else console.log(`  ⚠ ${target.repo}: ${repoRemaining} source-fixable finding(s) remain`)
    } finally {
      rmSync(tmp, { recursive: true, force: true })
    }
  }
  const total = Object.values(byClass).reduce((a, b) => a + b, 0)
  console.log(`\n── Remote verification: ${cleanRepos}/${targets.length} repo(s) clean, ${total} source-fixable finding(s) remain ──`)
  for (const fixer of SOURCE_FIXABLE) {
    const n = byClass[fixer.id] ?? 0
    console.log(n === 0
      ? `  ✅ ${fixer.id}: 0 remaining across all repos — READY TO RETIRE`
      : `  ⏳ ${fixer.id}: ${n} remaining — keep pre-processor`)
  }
  if (total === 0) console.log('\nAll fixed repos are clean at source. Pre-processors listed above can be retired (see --retirement-status).')
}

/**
 * A source PR touches the PUBLISHED repo AND its `<repo>-Contribution` upstream,
 * so a fix cannot be silently reverted the next time Contribution is copied
 * forward. Each repo is CLONED and re-scanned against its own current content
 * (never the possibly-stale local cache), golden-gated, then its fixable
 * tutorials are split into batches of `batchSize` — one branch + PR per batch so
 * large repos (e.g. Tutorials, 375 files) stay reviewable.
 */
async function openPullRequests(
  publishedTargets: RepoTarget[],
  opts: { batchSize: number; includeContribution: boolean; slug?: string },
) {
  // Expand to include each published repo's Contribution pair.
  const targets = expandTargets(publishedTargets, opts.includeContribution)
  console.log(`\nOpening PRs for ${targets.length} repo(s) (batch size ${opts.batchSize}` +
    `${opts.includeContribution ? ', incl. Contribution pairs' : ''})...`)

  for (const t of targets) {
    await prForRepo(t, opts)
  }
}

async function prForRepo(target: RepoTarget, opts: { batchSize: number; slug?: string }) {
  const { repo } = target
  const tmp = join(tmpdir(), `md-src-fix-${repo}-${process.pid}`)
  try {
    const base = cloneRepo(target, tmp)
    if (base === null) { console.log(`  ${repo}: clone failed (repo/branch missing?) — skipped.`); return }

    // Enumerate tutorials/<slug>/<slug>.md in the clone and compute fixes.
    const tutDir = join(tmp, 'tutorials')
    if (!existsSync(tutDir)) { console.log(`  ${repo}: no tutorials/ dir — skipped.`); return }
    const fixes: RepoFix[] = []
    for (const slug of readdirSync(tutDir)) {
      if (opts.slug && slug !== opts.slug) continue
      const filePath = join(tutDir, slug, `${slug}.md`)
      if (!existsSync(filePath)) continue
      const fresh = readFileSync(filePath, 'utf-8')
      const meta = { slug, repo, branch: base }
      let scan: FileScan
      try { scan = scanSource(fresh, meta) } catch { continue }
      if (!scan.fixedBody) continue
      const fixedSrc = rebuildSource(fresh, scan.fixedBody)
      if (!goldenRenderEqual(fresh, fixedSrc, meta)) continue  // NEEDS-MANUAL-REVIEW → skip
      const classes = [...new Set(scan.findings.filter(f => f.classification === 'source-fixable').map(f => f.class))]
      fixes.push({ slug, relPath: `tutorials/${slug}/${slug}.md`, fixed: fixedSrc, classes })
    }
    if (!fixes.length) { console.log(`  ${repo}: nothing to fix at source — no PR.`); return }

    // Split into ≤batchSize-tutorial batches → one branch + PR each.
    const batches = chunk(fixes, opts.batchSize)
    const multi = batches.length > 1
    console.log(`  ${repo}: ${fixes.length} tutorial(s) → ${batches.length} PR(s) (base ${base})`)

    for (let bi = 0; bi < batches.length; bi++) {
      const batch = batches[bi]
      const branch = multi ? `fix/md-source-1963-batch-${bi + 1}` : `fix/md-source-1963`
      // Idempotency: skip if a PR already exists for this head branch.
      try {
        const existing = execFileSync('gh', ['pr', 'list', '--repo', `${ORG}/${repo}`, '--head', branch,
          '--state', 'all', '--json', 'number'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        if (JSON.parse(existing).length) { console.log(`    batch ${bi + 1}/${batches.length}: PR for ${branch} exists — skipped.`); continue }
      } catch { /* gh pr list failure is non-fatal; attempt creation */ }

      git(tmp, 'checkout', '-B', branch, base)  // fresh branch at base (discards prior batch)
      for (const f of batch) writeFileSync(join(tmp, f.relPath), f.fixed, 'utf-8')
      git(tmp, 'add', '-A')
      const classes = [...new Set(batch.flatMap(f => f.classes))]
      const suffix = multi ? ` (batch ${bi + 1}/${batches.length})` : ''
      const title = `Fix malformed markdown at source (#1963)${suffix}`
      const body = [
        'Automated conservative, idempotent fixes for malformed-markdown patterns that the',
        'tutorials-ims render pipeline currently patches in flight (sap-tutorials/tutorials-ims#1963).',
        repo.endsWith('-Contribution')
          ? '\nApplied to the **Contribution** (upstream) repo so the fix survives the next copy-forward to the published repo.'
          : '',
        `\nClasses fixed: ${classes.join(', ')}`,
        `\nTutorials (${batch.length}):`,
        ...batch.map(f => `- \`${f.relPath}\``),
        '',
        'Each change is idempotent and verified by a golden-render gate: composing the original',
        'vs. fixed source through the pipeline yields byte-identical steps/body/intro.',
        '',
        '🤖 Generated with Claude Code',
      ].join('\n')
      try {
        git(tmp, 'commit', '-m', title, '-m', body)
        git(tmp, 'push', '-u', 'origin', branch)
        const pr = execFileSync('gh', ['pr', 'create', '--repo', `${ORG}/${repo}`, '--base', base,
          '--head', branch, '--title', title, '--body', body],
          { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
        console.log(`    ✅ batch ${bi + 1}/${batches.length} (${batch.length} file(s)) → ${pr.trim()}`)
      } catch (err) {
        console.error(`    ❌ batch ${bi + 1}/${batches.length} failed —`, err instanceof Error ? err.message : err)
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const invokedDirectly = process.argv[1] &&
  (import.meta.url === `file://${process.argv[1]}` ||
   import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/')))
if (invokedDirectly) {
  run().catch(err => { console.error(err); process.exit(1) })
}
