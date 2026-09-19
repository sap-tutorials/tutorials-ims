import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { renderHugoFrontmatter } from '../render-frontmatter.js'
import type { RenderHugoFrontmatterArgs } from '../render-frontmatter.js'
import type { TutorialNavEntry } from '../types.js'

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

function fmSteps(content: string): Array<Record<string, unknown>> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) throw new Error('no frontmatter')
  const fm = parseYaml(m[1], { version: '1.1' }) as Record<string, unknown>
  return fm.steps as Array<Record<string, unknown>>
}

// [#2362] Regression: renderHugoFrontmatter builds each step from an allow-list,
// so a new step field is silently dropped unless explicitly serialized. The
// challenge widget's whole render chain (shortcode mount → island script →
// tutorial-data payload) keys off .Params.steps[].challenge, so if this field
// doesn't survive frontmatter serialization the widget cannot render from any
// real build. (Caught in code review — the original wireup omitted this.)
describe('renderHugoFrontmatter — challenge spec serialization (#2362)', () => {
  it('serializes step.challenge into the frontmatter step', () => {
    const challenge = {
      nodes: [
        { id: 'challenge-1-1', type: 'heading', text: 'Check your understanding' },
        { id: 'challenge-1-2', type: 'mcq', prompt: 'Which?', options: ['a', 'b', 'c', 'd'], answerIndex: 0 },
        { id: 'challenge-1-3', type: 'freeText', prompt: 'Explain.', aiGraded: true },
      ],
    }
    const args: RenderHugoFrontmatterArgs = {
      ...baseArgs,
      steps: [{ number: 1, title: 'Step 1', content: 'body', challenge }],
    }
    const steps = fmSteps(renderHugoFrontmatter(args))
    expect(steps[0].challenge).toEqual(challenge)
  })

  it('omits the challenge key when the step has none', () => {
    const steps = fmSteps(renderHugoFrontmatter(baseArgs))
    expect(steps[0]).not.toHaveProperty('challenge')
  })

  it('omits the challenge key when nodes is empty', () => {
    const args: RenderHugoFrontmatterArgs = {
      ...baseArgs,
      steps: [{ number: 1, title: 'Step 1', content: '', challenge: { nodes: [] } }],
    }
    const steps = fmSteps(renderHugoFrontmatter(args))
    expect(steps[0]).not.toHaveProperty('challenge')
  })
})
