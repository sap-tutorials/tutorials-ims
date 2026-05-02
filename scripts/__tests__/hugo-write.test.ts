import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { writeHugoPage } from '../fetch-tutorials.js'
import type { TutorialStep, TutorialNavEntry } from '../parsers/types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TMP_DIR = join(__dirname, '..', '..', '.test-tmp-hugo')

describe('writeHugoPage', () => {
  beforeEach(() => {
    mkdirSync(TMP_DIR, { recursive: true })
  })

  afterEach(() => {
    if (existsSync(TMP_DIR)) {
      rmSync(TMP_DIR, { recursive: true })
    }
  })

  const makeSteps = (): TutorialStep[] => [
    { number: 1, title: 'First Step', content: 'Step 1 content with <div>html</div>' },
    { number: 2, title: 'Second Step', content: 'Step 2 content' },
  ]

  const makeNav = (): TutorialNavEntry => ({
    slug: 'test-tutorial',
    title: 'Test Tutorial',
    description: 'A test',
    time: 10,
    level: 'beginner',
    stepCount: 2,
    primaryTag: 'SAP',
    displayTags: ['SAP'],
    prev: null,
    next: null,
  })

  it('outputs type: tutorials frontmatter (not layout: tutorial)', () => {
    writeHugoPage(
      'test-tutorial', 'Test Tutorial', 'A test', 10, 'beginner',
      ['sap'], 'sap', 'Author', 'profile', ['Learn X'], 'prereq',
      makeSteps(), makeNav(), '2025-01-01', [], TMP_DIR,
    )

    const output = readFileSync(join(TMP_DIR, 'test-tutorial.md'), 'utf-8')
    expect(output).toContain('type: tutorials')
    expect(output).not.toContain('layout: tutorial')
  })

  it('wraps steps in {{% tutorial-step %}} shortcodes', () => {
    writeHugoPage(
      'test-tutorial', 'Test Tutorial', 'A test', 10, 'beginner',
      ['sap'], 'sap', 'Author', 'profile', ['Learn X'], 'prereq',
      makeSteps(), makeNav(), '2025-01-01', [], TMP_DIR,
    )

    const output = readFileSync(join(TMP_DIR, 'test-tutorial.md'), 'utf-8')
    expect(output).toContain('{{% tutorial-step number="1" title="First Step" %}}')
    expect(output).toContain('{{% /tutorial-step %}}')
    expect(output).toContain('{{% tutorial-step number="2" title="Second Step" %}}')
  })

  it('preserves safe HTML but strips dangerous tags', () => {
    const steps: TutorialStep[] = [
      { number: 1, title: 'First Step', content: 'Step 1 with <div>safe html</div> and <script>alert("xss")</script>' },
      { number: 2, title: 'Second Step', content: 'Step 2 content' },
    ]
    writeHugoPage(
      'test-tutorial', 'Test Tutorial', 'A test', 10, 'beginner',
      ['sap'], 'sap', 'Author', 'profile', ['Learn X'], 'prereq',
      steps, makeNav(), '2025-01-01', [], TMP_DIR,
    )

    const output = readFileSync(join(TMP_DIR, 'test-tutorial.md'), 'utf-8')
    expect(output).toContain('<div>safe html</div>')
    expect(output).not.toContain('<script>')
  })

  it('does not contain Vue component syntax', () => {
    writeHugoPage(
      'test-tutorial', 'Test Tutorial', 'A test', 10, 'beginner',
      ['sap'], 'sap', 'Author', 'profile', ['Learn X'], 'prereq',
      makeSteps(), makeNav(), '2025-01-01', [], TMP_DIR,
    )

    const output = readFileSync(join(TMP_DIR, 'test-tutorial.md'), 'utf-8')
    expect(output).not.toContain('<TutorialStep')
    expect(output).not.toContain('</TutorialStep>')
  })

  it('escapes quotes in step titles', () => {
    const steps: TutorialStep[] = [
      { number: 1, title: 'Say "Hello"', content: 'content' },
    ]
    writeHugoPage(
      'test-tutorial', 'Test Tutorial', 'A test', 10, 'beginner',
      ['sap'], 'sap', 'Author', 'profile', ['Learn X'], 'prereq',
      steps, makeNav(), '2025-01-01', [], TMP_DIR,
    )

    const output = readFileSync(join(TMP_DIR, 'test-tutorial.md'), 'utf-8')
    expect(output).toContain('{{% tutorial-step number="1" title="Say &quot;Hello&quot;" %}}')
  })
})
