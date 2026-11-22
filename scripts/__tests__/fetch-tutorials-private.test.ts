import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isPrivateVisibility } from '../parsers/render-frontmatter.js'
import { writeHugoPage } from '../fetch-tutorials.js'
import type { TutorialStep, TutorialNavEntry } from '../parsers/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR = join(__dirname, '..', '..', '.test-tmp-private')

// ── isPrivateVisibility unit tests ─────────────────────────────────────────

describe('isPrivateVisibility', () => {
  it('returns true for UNLISTED', () => {
    expect(isPrivateVisibility('UNLISTED')).toBe(true)
  })

  it('returns true for ROLE_GATED', () => {
    expect(isPrivateVisibility('ROLE_GATED')).toBe(true)
  })

  it('returns false for LISTED', () => {
    expect(isPrivateVisibility('LISTED')).toBe(false)
  })

  it('returns false for null', () => {
    expect(isPrivateVisibility(null)).toBe(false)
  })

  it('returns false for undefined', () => {
    expect(isPrivateVisibility(undefined)).toBe(false)
  })
})

// ── writeHugoPage integration: private front-matter ────────────────────────

const makeSteps = (): TutorialStep[] => [
  { number: 1, title: 'Step One', content: 'Some content' },
]

const makeNav = (): TutorialNavEntry => ({
  slug: 'my-tutorial',
  title: 'My Tutorial',
  description: 'desc',
  time: 5,
  level: 'beginner',
  stepCount: 1,
  primaryTag: 'sap',
  displayTags: ['SAP'],
  prev: null,
  next: null,
})

/** Minimal writeHugoPage call up to outputDir (no optional args) */
const writeMinimal = (outputDir: string, visibility?: string) =>
  writeHugoPage(
    'my-tutorial', 'My Tutorial', 'desc', 5, 'beginner',
    ['sap'], 'sap', 'Author', 'profile', [], '',
    makeSteps(), makeNav(), '2025-01-01', '2024-12-01',
    /* contributors */ [],
    /* githubLogin */ null,
    outputDir,
    /* registry */ {},
    /* hasOsOptions */ false,
    /* intro */ '',
    /* video */ null,
    /* semaphoreMap */ {},
    /* osList */ [],
    /* variables */ undefined,
    /* syncKeysUsed */ undefined,
    /* syncGroups */ undefined,
    /* testedWith */ undefined,
    /* requires */ undefined,
    visibility,
  )

describe('writeHugoPage private front-matter', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true })
    }
  })

  it('emits private: true in front-matter for UNLISTED visibility', () => {
    writeMinimal(TMP_DIR, 'UNLISTED')
    const output = readFileSync(join(TMP_DIR, 'my-tutorial.md'), 'utf-8')
    expect(output).toContain('private: true')
  })

  it('emits private: true in front-matter for ROLE_GATED visibility', () => {
    writeMinimal(TMP_DIR, 'ROLE_GATED')
    const output = readFileSync(join(TMP_DIR, 'my-tutorial.md'), 'utf-8')
    expect(output).toContain('private: true')
  })

  it('does not emit private for LISTED visibility', () => {
    writeMinimal(TMP_DIR, 'LISTED')
    const output = readFileSync(join(TMP_DIR, 'my-tutorial.md'), 'utf-8')
    expect(output).not.toContain('private: true')
  })

  it('does not emit private when visibility is omitted', () => {
    writeMinimal(TMP_DIR)
    const output = readFileSync(join(TMP_DIR, 'my-tutorial.md'), 'utf-8')
    expect(output).not.toContain('private: true')
  })
})
