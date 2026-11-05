// [tutorial-step-pacing] Corpus regression: parsing every cached real tutorial's
// `### ` step headings through the new heading-attribute stripper must be a
// no-op for existing content — no real tutorial (pre-dating this feature) is
// expected to end its heading in a step-pacing-shaped `{...}` block, so every
// title must come back byte-identical and slugs must be unchanged.
//
// Self-skips when `.tutorial-cache/` is absent or empty (it is gitignored and
// only populated by `npm run fetch-tutorials`, which requires network access)
// — mirrors the e2e suite's `hasBaseUrl()` self-skip pattern.

import { describe, it, expect } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseStepHeadingAttrs } from '../step-attrs.js'
import { slugify } from '../../../srv/lib/slug-utils.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_DIR = join(__dirname, '..', '..', '..', '.tutorial-cache')

function cachedMarkdownFiles(): string[] {
  if (!existsSync(CACHE_DIR)) return []
  return readdirSync(CACHE_DIR).filter((f) => f.endsWith('.md'))
}

const files = cachedMarkdownFiles()

describe.skipIf(files.length === 0)('step-attrs corpus regression (.tutorial-cache)', () => {
  it('leaves every real ### step heading title/slug unchanged', () => {
    let checked = 0
    for (const file of files) {
      const raw = readFileSync(join(CACHE_DIR, file), 'utf-8')
      const lines = raw.split(/\r\n?|\n/)
      for (const line of lines) {
        const m = line.match(/^###\s+(.+)$/)
        if (!m) continue
        const rawTitle = m[1].trim()
        const { title, warnings } = parseStepHeadingAttrs(rawTitle)
        checked++
        expect(title, `${file}: "${rawTitle}"`).toBe(rawTitle)
        expect(slugify(title), `${file}: "${rawTitle}"`).toBe(slugify(rawTitle))
        expect(warnings, `${file}: "${rawTitle}"`).toEqual([])
      }
    }
    // Sanity: the corpus actually exercised the assertions above.
    expect(checked).toBeGreaterThan(0)
  })
})
