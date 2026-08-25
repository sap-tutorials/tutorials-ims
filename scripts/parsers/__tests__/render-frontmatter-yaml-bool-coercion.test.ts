import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { renderHugoFrontmatter } from '../render-frontmatter.js'
import type { RenderHugoFrontmatterArgs } from '../render-frontmatter.js'
import type { TutorialNavEntry } from '../types.js'
import { QUESTION_TYPE_MCQ, QUESTION_TYPE_TEXT } from '../types.js'

const minimalNav: TutorialNavEntry = {
  slug: 'demo',
  title: 'Demo',
  description: '',
  time: 5,
  level: 'beginner',
  stepCount: 1,
  primaryTag: '',
  displayTags: [],
  displayTagSlugs: [],
  repo: 'sap-tutorials/demo',
  branch: 'main',
  prev: null,
  next: null,
}

const baseArgs: RenderHugoFrontmatterArgs = {
  slug: 'demo',
  title: 'Demo',
  description: '',
  time: 5,
  level: 'beginner',
  tags: [],
  primaryTag: '',
  author: 'Thomas Jung',
  authorProfile: 'https://github.com/jung-thomas',
  youWillLearn: [],
  prerequisites: '',
  steps: [{ number: 1, title: 'Step 1', content: '' }],
  nav: minimalNav,
  lastUpdated: '',
  createdAt: '',
  contributors: [],
}

/**
 * Parse the frontmatter block with YAML **1.1** semantics — the same schema
 * Hugo's Go parser uses. This is what turns unquoted `yes`/`no` into booleans;
 * the assertions below prove the emitted frontmatter survives that read as
 * strings. Reading with the `yaml` lib default (1.2) would hide the bug.
 */
function fmAsHugoReads(content: string): Record<string, unknown> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) throw new Error('no frontmatter')
  return parseYaml(m[1], { version: '1.1' }) as Record<string, unknown>
}

// [#2023] rules.vr `[ ] no` / `[x] yes` was rendering as "false"/"true" because
// the frontmatter serializer emitted the bare tokens and Hugo's YAML 1.1 parser
// coerced them to booleans. These guard the round-trip through a 1.1 read.
describe('renderHugoFrontmatter — YAML 1.1 boolean-token coercion (#2023)', () => {
  it('keeps yes/no MCQ options as strings, not booleans', () => {
    const args: RenderHugoFrontmatterArgs = {
      ...baseArgs,
      steps: [{
        number: 9,
        title: 'Step 9',
        content: '',
        validation: [{
          id: 'validate-9',
          question: 'Would we have got the same result?',
          type: QUESTION_TYPE_MCQ,
          options: ['no', 'yes'],
          choiceMode: 'single',
          correctAnswer: 'yes',
        }],
      }],
    }
    const fm = fmAsHugoReads(renderHugoFrontmatter(args))
    const steps = fm.steps as Array<{ validation: Array<{ options: unknown[]; correctAnswer: unknown }> }>
    const q = steps[0].validation[0]
    expect(q.options).toEqual(['no', 'yes'])
    expect(q.options.every(o => typeof o === 'string')).toBe(true)
    expect(q.correctAnswer).toBe('yes')
  })

  it('keeps on/off and other 1.1 boolean-ish option tokens as strings', () => {
    const args: RenderHugoFrontmatterArgs = {
      ...baseArgs,
      steps: [{
        number: 2,
        title: 'Step 2',
        content: '',
        validation: [{
          id: 'validate-2',
          question: 'Pick one',
          type: QUESTION_TYPE_MCQ,
          options: ['on', 'off', 'y', 'n'],
          choiceMode: 'single',
          correctAnswer: 'off',
        }],
      }],
    }
    const fm = fmAsHugoReads(renderHugoFrontmatter(args))
    const steps = fm.steps as Array<{ validation: Array<{ options: unknown[]; correctAnswer: unknown }> }>
    const q = steps[0].validation[0]
    expect(q.options).toEqual(['on', 'off', 'y', 'n'])
    expect(q.options.every(o => typeof o === 'string')).toBe(true)
    expect(q.correctAnswer).toBe('off')
  })

  it('keeps a yes/no text correctAnswer as a string', () => {
    const args: RenderHugoFrontmatterArgs = {
      ...baseArgs,
      steps: [{
        number: 3,
        title: 'Step 3',
        content: '',
        validation: [{
          id: 'validate-3',
          question: 'yes or no?',
          type: QUESTION_TYPE_TEXT,
          correctAnswer: 'yes',
        }],
      }],
    }
    const fm = fmAsHugoReads(renderHugoFrontmatter(args))
    const steps = fm.steps as Array<{ validation: Array<{ correctAnswer: unknown }> }>
    expect(steps[0].validation[0].correctAnswer).toBe('yes')
  })
})
