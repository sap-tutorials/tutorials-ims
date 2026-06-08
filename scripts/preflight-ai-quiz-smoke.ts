// scripts/preflight-ai-quiz-smoke.ts
//
// Pre-go-live smoke check for the AI-quiz pipeline (#278).
//
// Samples a fraction of the tutorial catalog, spawns
// `cds bind --exec -- npm run fetch-tutorials -- --target hugo` per slug
// with `AI_AUTHOR_ENABLED=true TUTORIAL_SLUG=<slug>`, then runs the five
// invariant helpers from `lib/ai-quiz-invariants` against each tutorial's
// `.tutorial-cache/<slug>.ai-quiz-cache.json`.
//
// Outputs a verdict JSON at `verdicts/preflight-smoke.json` and exits with
// code 0 (safe to graduate), 2 (invariant violations), or 3 (unexpected).
//
// Validation history:
//   - 2026-06-08: initial 5-slug end-to-end run on seed 99 (Task 12).

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import {
  runAllInvariants,
  type InvariantName,
  type InvariantResult,
} from './lib/ai-quiz-invariants'
import { loadAiQuizCache } from './lib/ai-quiz-cache'
import { parseRulesVrEnriched } from './parsers/rules'

// ---------------------------------------------------------------------------
// sampleSlugs — reproducible Fisher-Yates partial shuffle over a sorted catalog
// ---------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function sampleSlugs(catalog: readonly string[], n: number, seed: number): string[] {
  if (n <= 0) return []
  // Sort first so seed → output is stable across catalog orderings (e.g.
  // an operator running this on a freshly-discovered catalog gets the
  // same sample as someone running on a months-old discovery map).
  const sorted = [...catalog].sort()
  if (n >= sorted.length) return sorted
  const rng = mulberry32(seed)
  for (let i = 0; i < n; i++) {
    const j = i + Math.floor(rng() * (sorted.length - i))
    ;[sorted[i], sorted[j]] = [sorted[j], sorted[i]]
  }
  return sorted.slice(0, n)
}

// ---------------------------------------------------------------------------
// extractSummaryLine — find the [ai-author] expanded directives line
// ---------------------------------------------------------------------------

const SUMMARY_LINE_PREFIX = '[ai-author] expanded directives across all tutorials:'

export function extractSummaryLine(stdout: string): string | null {
  const lines = stdout.split('\n')
  // Walk from the end so we capture the last (most recent) occurrence —
  // matters when the subprocess somehow emits the line twice.
  for (let i = lines.length - 1; i >= 0; i--) {
    const trimmed = lines[i].trim()
    if (trimmed.startsWith(SUMMARY_LINE_PREFIX)) return trimmed
  }
  return null
}

// ---------------------------------------------------------------------------
// summarizeVerdict — fold per-tutorial rows into the JSON artifact shape
// ---------------------------------------------------------------------------

export interface PerTutorialRow {
  slug: string
  results: InvariantResult[]
  durationMs: number
  /** Only set when the subprocess crashed before any invariant could run. */
  fatalError?: string
}

export interface Verdict {
  safeToGraduate: boolean
  totals: { passed: number; failed: number; total: number }
  failedSlugs: string[]
  failuresByInvariant: Record<InvariantName, number>
  rows: PerTutorialRow[]
  generatedAt: string
}

export function summarizeVerdict(rows: PerTutorialRow[]): Verdict {
  const failuresByInvariant: Record<InvariantName, number> = {
    'no-upstream-errors': 0,
    precedence: 0,
    'anti-leak': 0,
    'mcq-shape': 0,
    'generator-sanity': 0,
  }
  const failedSlugs: string[] = []
  let passed = 0
  for (const row of rows) {
    const rowFailed = row.fatalError !== undefined || row.results.some(r => !r.passed)
    if (rowFailed) {
      failedSlugs.push(row.slug)
      for (const r of row.results) {
        if (!r.passed) failuresByInvariant[r.name]++
      }
    } else {
      passed++
    }
  }
  return {
    safeToGraduate: failedSlugs.length === 0,
    totals: { passed, failed: failedSlugs.length, total: rows.length },
    failedSlugs,
    failuresByInvariant,
    rows,
    generatedAt: new Date().toISOString(),
  }
}

// ---------------------------------------------------------------------------
// runOneSlug — spawn the pipeline for a single slug and run invariants
//
// The `[ai-author]` summary line emitted by fetch-tutorials is a *global*
// per-build counter, but we set TUTORIAL_SLUG=<one> per subprocess so the
// counter scope happens to match this slug — that's how invariant 1 stays
// per-tutorial despite reading a build-global line. If multi-slug seeding
// ever lands, this assumption breaks and the runner needs its own per-slug
// log scoping.
// ---------------------------------------------------------------------------

export interface RunOptions {
  buildCap: number
  cacheDir: string
  cwd: string
  /** When true, skip the subprocess and read pre-existing cache only (for dry-runs against an already-seeded cache). */
  skipSubprocess?: boolean
}

export async function runOneSlug(slug: string, opts: RunOptions): Promise<PerTutorialRow> {
  const start = Date.now()
  let summaryLine: string | null = null
  let fatalError: string | undefined

  if (!opts.skipSubprocess) {
    const env = {
      ...process.env,
      AI_AUTHOR_ENABLED: 'true',
      TUTORIAL_SLUG: slug,
      AI_AUTHOR_BUILD_CAP: String(opts.buildCap),
    }
    // `cds bind --exec` inherits the bound HANA env into the inner npm run.
    const child = spawnSync(
      'cds',
      ['bind', '--exec', '--', 'npm', 'run', 'fetch-tutorials', '--', '--target', 'hugo'],
      {
        cwd: opts.cwd,
        env,
        encoding: 'utf-8',
        maxBuffer: 32 * 1024 * 1024,
        shell: process.platform === 'win32',
      },
    )
    if (child.status !== 0) {
      fatalError = `subprocess exited ${child.status}: ${(child.stderr ?? '').slice(-500)}`
    }
    summaryLine = extractSummaryLine((child.stdout ?? '') + '\n' + (child.stderr ?? ''))
  }

  // Load cache + rules.vr regardless of subprocess outcome — partial output is useful for triage.
  const cachePath = join(opts.cwd, opts.cacheDir, `${slug.toLowerCase()}.ai-quiz-cache.json`)
  const rulesPath = join(opts.cwd, opts.cacheDir, `${slug}.rules.vr`)
  let handAuthoredSteps = new Set<number>()
  let cache = loadAiQuizCache(slug, { cacheDir: join(opts.cwd, opts.cacheDir) })

  if (!existsSync(cachePath) && !opts.skipSubprocess && fatalError === undefined) {
    // Subprocess succeeded but produced no cache — that's a fatal pipeline bug we want surfaced.
    fatalError = `expected cache file not produced: ${cachePath}`
  }

  if (existsSync(rulesPath)) {
    try {
      const parsed = parseRulesVrEnriched(readFileSync(rulesPath, 'utf-8'))
      handAuthoredSteps = parsed.handAuthoredSteps
    } catch (err) {
      fatalError = fatalError ?? `parseRulesVrEnriched failed: ${(err as Error).message}`
    }
  }

  const results = runAllInvariants({ slug, cache, handAuthoredSteps, summaryLine })
  return { slug, results, durationMs: Date.now() - start, fatalError }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliArgs {
  /** 0 means "10% of catalog". */
  sample: number
  seed: number
  buildCap: number
  output: string
  /** When provided, overrides sampling (use for repro / single-slug debugging). */
  slugs: string[] | null
  dryRun: boolean
}

export function parseCli(argv: readonly string[]): CliArgs {
  const args: CliArgs = {
    sample: 0,
    seed: 42,
    buildCap: 10000,
    output: 'verdicts/preflight-smoke.json',
    slugs: null,
    dryRun: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    switch (a) {
      case '--sample': args.sample = Number(argv[++i]); break
      case '--seed': args.seed = Number(argv[++i]); break
      case '--build-cap': args.buildCap = Number(argv[++i]); break
      case '--output': args.output = argv[++i]; break
      case '--slugs': args.slugs = argv[++i].split(',').map(s => s.trim()).filter(Boolean); break
      case '--dry-run': args.dryRun = true; break
      case '--help':
      case '-h':
        console.log('Usage: preflight-ai-quiz-smoke [--sample N] [--seed N] [--build-cap N] [--output PATH] [--slugs a,b,c] [--dry-run]')
        process.exit(0)
    }
  }
  return args
}

export function loadCatalog(cwd: string): string[] {
  const path = join(cwd, '.tutorial-cache', '_discovery.json')
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
  return Object.keys(raw)
}

async function main(): Promise<void> {
  const args = parseCli(process.argv.slice(2))
  const cwd = process.cwd()
  const catalog = loadCatalog(cwd)

  let chosen: string[]
  if (args.slugs) {
    chosen = args.slugs
    console.log(`[preflight] explicit --slugs: ${chosen.length} tutorials`)
  } else {
    const n = args.sample > 0 ? args.sample : Math.ceil(catalog.length * 0.1)
    chosen = sampleSlugs(catalog, n, args.seed)
    console.log(`[preflight] sampled ${chosen.length} of ${catalog.length} tutorials (seed=${args.seed})`)
  }

  const rows: PerTutorialRow[] = []
  for (let i = 0; i < chosen.length; i++) {
    const slug = chosen[i]
    process.stdout.write(`[preflight] [${i + 1}/${chosen.length}] ${slug} ... `)
    const row = await runOneSlug(slug, {
      buildCap: args.buildCap,
      cacheDir: '.tutorial-cache',
      cwd,
      skipSubprocess: args.dryRun,
    })
    const failed = row.fatalError !== undefined || row.results.some(r => !r.passed)
    process.stdout.write(`${failed ? 'FAIL' : 'pass'} (${row.durationMs}ms)\n`)
    if (failed) {
      for (const r of row.results.filter(x => !x.passed)) console.log(`    - ${r.name}: ${r.reason}`)
      if (row.fatalError) console.log(`    - fatal: ${row.fatalError}`)
    }
    rows.push(row)
  }

  const verdict = summarizeVerdict(rows)
  mkdirSync(dirname(args.output), { recursive: true })
  writeFileSync(args.output, JSON.stringify(verdict, null, 2), 'utf-8')

  console.log('\n=== preflight verdict ===')
  console.log(`  safeToGraduate: ${verdict.safeToGraduate}`)
  console.log(`  ${verdict.totals.passed}/${verdict.totals.total} tutorials passed`)
  if (verdict.failedSlugs.length > 0) {
    console.log(`  failed: ${verdict.failedSlugs.join(', ')}`)
    console.log('  by invariant:')
    for (const [name, count] of Object.entries(verdict.failuresByInvariant)) {
      if (count > 0) console.log(`    ${name}: ${count}`)
    }
  }
  console.log(`  artifact: ${args.output}`)

  process.exit(verdict.safeToGraduate ? 0 : 2)
}

// Run main only when invoked directly, not when imported by tests.
if (process.argv[1] && /preflight-ai-quiz-smoke\.(ts|js)$/.test(process.argv[1])) {
  main().catch(err => {
    console.error(err)
    process.exit(3)
  })
}
