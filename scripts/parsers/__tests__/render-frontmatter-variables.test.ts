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

describe('renderHugoFrontmatter — variables value/display [#2852]', () => {
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

  it('emits value and display for a hidden author-fixed variable', () => {
    const content = renderHugoFrontmatter({
      ...baseArgs,
      variables: [{ name: 'prod', type: 'string', value: 'MyApp 2.0', display: false }],
    })
    const fm = fmFrom(content)
    const vars = fm.variables as Array<Record<string, unknown>>
    expect(vars[0].name).toBe('prod')
    expect(vars[0].value).toBe('MyApp 2.0')
    expect(vars[0].display).toBe(false)
  })

  it('omits the variables key when none are declared', () => {
    const content = renderHugoFrontmatter(baseArgs)
    const fm = fmFrom(content)
    expect('variables' in fm).toBe(false)
  })
})
