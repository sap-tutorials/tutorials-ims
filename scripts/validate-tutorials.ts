import { readdirSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const TUTORIALS_DIR = join(ROOT, 'hugo', 'content', 'tutorials')
const QUARANTINE_DIR = join(ROOT, '.tutorial-cache', 'quarantine')

const REQUIRED_FIELDS = ['type', 'slug', 'title', 'time', 'stepCount'] as const

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

const files = readdirSync(TUTORIALS_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_'))

console.log(`Pre-validating ${files.length} tutorials (Hugo frontmatter)...\n`)

const quarantined: Array<{ file: string; reason: string }> = []

for (const file of files) {
  const content = readFileSync(join(TUTORIALS_DIR, file), 'utf-8')
  let reason: string | null = null

  try {
    const { data: fm } = matter(content)

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

    // Validate stepCount is a positive integer
    if (!reason && (!Number.isInteger(fm.stepCount) || fm.stepCount <= 0)) {
      reason = `Invalid 'stepCount' value: ${fm.stepCount}`
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

  if (reason) {
    quarantined.push({ file, reason })
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
