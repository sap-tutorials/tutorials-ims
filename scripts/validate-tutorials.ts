import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TUTORIALS_DIR = join(ROOT, 'hugo', 'content', 'tutorials')
const QUARANTINE_DIR = join(ROOT, '.tutorial-cache', 'quarantine')

const REQUIRED_FIELDS = ['type', 'slug', 'title', 'time', 'stepCount'] as const

/**
 * Source repos permitted to publish step-less tutorials (issue #2127).
 *
 * Devtoberfest "validation" tutorials are published with zero steps on purpose:
 * authors want the page live (so it appears in the mission) but *not* completable
 * — no Done button, no completion, no Devtoberfest points — until real questions
 * are added. That render-without-completion behaviour already falls out of the
 * Hugo layout when `stepCount === 0` (no step shortcodes → no Done buttons; the
 * `total > 0` guards in tutorial.ts short-circuit). The only thing blocking it is
 * this pre-validation gate, so the exception is scoped narrowly to the
 * developer-advocates repo family. Every other repo still requires ≥1 step.
 */
export const NO_STEP_ALLOWED_REPOS = new Set([
  'developer-advocates',
  'developer-advocates-Contribution',
])

/**
 * Validate a tutorial's `stepCount`. Returns a quarantine reason, or `null` if OK.
 *
 * Normal tutorials require a positive integer step count. A tutorial sourced from
 * a {@link NO_STEP_ALLOWED_REPOS} repo may also have exactly 0 steps (see #2127) —
 * but a missing/NaN/negative count is still invalid everywhere.
 *
 * @param stepCount the frontmatter `stepCount` value (untrusted)
 * @param repo the tutorial's source repo (from the discovery map), or undefined
 */
export function stepCountReason(stepCount: unknown, repo: string | undefined): string | null {
  if (Number.isInteger(stepCount) && (stepCount as number) > 0) return null
  if (stepCount === 0 && repo !== undefined && NO_STEP_ALLOWED_REPOS.has(repo)) return null
  return `Invalid 'stepCount' value: ${stepCount}`
}

/**
 * Build a `slug → source repo` map from the fetch discovery cache
 * (`.tutorial-cache/_discovery.json`, written by fetch-tutorials.ts). Used to
 * scope the no-step exception to specific source repos. Missing/corrupt cache
 * degrades safely to an empty map (→ every tutorial still requires a step).
 */
function loadRepoBySlug(): Record<string, string> {
  const path = join(ROOT, '.tutorial-cache', '_discovery.json')
  if (!existsSync(path)) return {}
  try {
    const map = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { repo?: string }>
    const out: Record<string, string> = {}
    for (const [slug, entry] of Object.entries(map)) {
      if (entry?.repo) out[slug] = entry.repo
    }
    return out
  } catch {
    return {}
  }
}

/**
 * Counts Hugo shortcode opens vs closes in a tutorial body.
 *
 * Hugo allows whitespace between `{{<` and `/` for close tags (e.g.
 * `{{< /os-panel >}}`), and the project's parser at `scripts/parsers/options.ts`
 * always emits the spaced form. The original regex for closes was `\{\{<\/`
 * (no space), which silently classified spaced closes as opens — false-positive
 * quarantining ~21 tutorials per publish (their continued availability has been
 * masked by carry-forward of prior versions; new tutorials with spaced closes
 * just go missing — see #382 phase E cookbook).
 *
 * Both opens and closes patterns now allow optional whitespace around `/`. They
 * are mutually exclusive: the open pattern requires the next non-whitespace
 * char to be a letter (NOT `/`), and the close pattern requires a `/` between
 * `{{<` and the letter.
 *
 * @returns `null` if balanced, otherwise a reason string for quarantine.
 */
export function shortcodeBalanceCheck(body: string): string | null {
  // Open: `{{<` + optional whitespace + a letter (excluding `/`).
  const opens = (body.match(/\{\{<\s*[A-Za-z]/g) || []).length
  // Close: `{{<` + optional whitespace + `/` + optional whitespace + a letter.
  const closes = (body.match(/\{\{<\s*\/\s*[A-Za-z]/g) || []).length
  if (opens !== closes) {
    return `Possible unclosed Hugo shortcode (${opens} opens, ${closes} closes)`
  }
  return null
}

/**
 * Returns a quarantine reason for a tutorial whose source is empty or
 * whitespace-only — typically an empty stub committed to the upstream
 * repo (e.g. `abap-environment-create-tile.md` has been 0 bytes for
 * months as of 2026-06-19).
 *
 * Without this short-circuit, the validator quarantines the file with
 * `Missing required frontmatter field: type` — accurate but unhelpful
 * because the frontmatter is empty as a consequence of the file being
 * empty. Surfaced by #432.
 *
 * @returns reason string for quarantine, or `null` if content is non-empty.
 */
export function emptyContentCheck(content: string): string | null {
  if (content.trim().length === 0) {
    return 'Tutorial source is empty or whitespace-only — likely an empty stub in the upstream repo'
  }
  return null
}

/**
 * Best-effort POST of the full-rebuild quarantine snapshot to the CAP backend
 * (#2585). FAIL-OPEN by contract: a missing config, a rejected fetch, or a
 * non-ok response is logged and swallowed — this must NEVER throw or make the
 * validator exit non-zero, and must NOT fire from the mta.yaml before-all build
 * or local runs (no backend), which is why it no-ops unless report === 'full'
 * AND both base + key are present.
 */
export async function postQuarantineSnapshot(
  events: Array<{ slug: string; sourceFile: string; sourceRepo?: string; reason: string; sourceUrl?: string }>,
  env: { base?: string; key?: string; runId?: string; workflowUrl?: string; report?: string },
): Promise<void> {
  if (env.report !== 'full' || !env.base || !env.key) return
  const url = `${env.base.replace(/\/$/, '')}/content/quarantine-events`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.key}`,
        'Content-Type': 'application/json',
        'x-initiator': env.runId ? `ci/${env.runId}` : 'ci',
      },
      body: JSON.stringify({
        runId: env.runId,
        workflowUrl: env.workflowUrl,
        buildMode: 'full',
        events,
      }),
    })
    if (!resp.ok) {
      console.warn(`  ⚠ quarantine snapshot POST returned ${resp.status} — continuing (fail-open)`)
    } else {
      console.log(`  → quarantine snapshot posted (${events.length} events)`)
    }
  } catch (e: any) {
    console.warn(`  ⚠ quarantine snapshot POST failed: ${e?.message ?? e} — continuing (fail-open)`)
  }
}

async function main() {
  const files = readdirSync(TUTORIALS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'))

  console.log(`Pre-validating ${files.length} tutorials (Hugo frontmatter)...\n`)

  const quarantined: Array<{ file: string; slug: string; sourceRepo?: string; reason: string }> = []
  const repoBySlug = loadRepoBySlug()

  for (const file of files) {
    const content = readFileSync(join(TUTORIALS_DIR, file), 'utf-8')
    let reason: string | null = emptyContentCheck(content)
    let fm: any

    if (!reason) {
      try {
        fm = matter(content).data

        // Check required frontmatter fields
        for (const field of REQUIRED_FIELDS) {
          if (fm[field] === undefined || fm[field] === null) {
            reason = `Missing required frontmatter field: ${field}`
            break
          }
        }

        // Validate time is a positive number
        if (!reason && (typeof fm.time !== 'number' || fm.time <= 0)) {
          reason = `Invalid 'time' value: ${fm.time}`
        }

        // Validate stepCount. Normal tutorials require ≥1 step; the
        // developer-advocates repo family may publish 0-step tutorials (#2127).
        if (!reason) {
          reason = stepCountReason(fm.stepCount, repoBySlug[fm.slug])
        }

        // Check for unclosed shortcode blocks (Hugo-specific). Helper is exported
        // for unit testing — see test/validate-tutorials-shortcode.test.ts.
        if (!reason) {
          const body = content.replace(/^---[\s\S]*?---\n?/, '')
          reason = shortcodeBalanceCheck(body)
        }
      } catch (e: any) {
        reason = e.message?.slice(0, 200) ?? 'Unknown parse error'
      }
    }

    if (reason) {
      // slug: prefer frontmatter when parseable, else derive from filename
      // (empty-content / parse-error paths leave fm undefined). Lowercase
      // canonical to match the publish payload and repoBySlug keys.
      const slug = String((fm && fm.slug) ? fm.slug : file.replace(/\.md$/, '')).toLowerCase()
      quarantined.push({ file, slug, sourceRepo: repoBySlug[slug], reason })
      mkdirSync(QUARANTINE_DIR, { recursive: true })
      renameSync(join(TUTORIALS_DIR, file), join(QUARANTINE_DIR, file))
      console.log(`  ✗ ${file}: ${reason}`)
    }
  }

  if (quarantined.length > 0) {
    console.log(`\n${quarantined.length} tutorials quarantined`)
    const logPath = join(QUARANTINE_DIR, 'errors.json')
    writeFileSync(logPath, JSON.stringify(quarantined, null, 2), 'utf-8')
  } else {
    console.log('All tutorials passed pre-validation')
  }

  console.log(`${files.length - quarantined.length} tutorials ready for build`)

  // #2585 — best-effort snapshot post. No-ops unless this is a full rebuild with
  // a reachable backend (guarded inside postQuarantineSnapshot). An empty
  // quarantine set on a full build still posts → writes an empty current
  // snapshot → the Admin view auto-clears.
  await postQuarantineSnapshot(
    quarantined.map(q => ({ slug: q.slug, sourceFile: q.file, sourceRepo: q.sourceRepo, reason: q.reason })),
    {
      base: process.env.CAP_BASE_URL,
      key: process.env.CONTENT_API_KEY,
      runId: process.env.RUN_ID,
      workflowUrl: process.env.WORKFLOW_URL,
      report: process.env.QUARANTINE_REPORT,
    },
  )
}

// Run only as the script entrypoint, not when imported (e.g. by unit tests),
// so importing `postQuarantineSnapshot` doesn't execute the validation + file
// moves as an import side effect.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main()
}
