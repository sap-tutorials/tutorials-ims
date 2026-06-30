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

function fmFrom(content: string): Record<string, unknown> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) throw new Error('no frontmatter')
  return parseYaml(m[1]) as Record<string, unknown>
}

describe('renderHugoFrontmatter — githubLogin', () => {
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

  it('emits githubLogin when provided', () => {
    const content = renderHugoFrontmatter({ ...baseArgs, githubLogin: 'jung-thomas' })
    const fm = fmFrom(content)
    expect(fm.githubLogin).toBe('jung-thomas')
  })

  it('omits githubLogin key when null', () => {
    const content = renderHugoFrontmatter({ ...baseArgs, githubLogin: null })
    const fm = fmFrom(content)
    expect('githubLogin' in fm).toBe(false)
  })

  it('omits githubLogin key when undefined / unset', () => {
    const content = renderHugoFrontmatter(baseArgs)
    const fm = fmFrom(content)
    expect('githubLogin' in fm).toBe(false)
  })

  it('omits githubLogin key when empty string', () => {
    const content = renderHugoFrontmatter({ ...baseArgs, githubLogin: '' })
    const fm = fmFrom(content)
    expect('githubLogin' in fm).toBe(false)
  })
})
