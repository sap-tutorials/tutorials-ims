import { describe, it, expect } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { renderHugoFrontmatter } from '../render-frontmatter.js'
import type { RenderHugoFrontmatterArgs } from '../render-frontmatter.js'
import type { TutorialNavEntry } from '../types.js'

// #directive-demos: testedWith + requires were parsed, composed, and accepted by
// renderHugoFrontmatter — but writeHugoPage (fetch-tutorials.ts) never forwarded
// them, so .Params.testedWith was always empty and the "Tested with" panel never
// rendered. The only prior testedWith test covered checkTestedWithFreshness, not
// the generated frontmatter — which is why the drop went unnoticed. These lock
// the rendered-frontmatter contract the u1 layout + prereq card depend on.

const minimalNav: TutorialNavEntry = {
  slug: 'demo', title: 'Demo', description: '', time: 5, level: 'beginner',
  stepCount: 1, primaryTag: '', displayTags: [], displayTagSlugs: [],
  repo: 'sap-tutorials/demo', branch: 'main', prev: null, next: null,
}

function fmFrom(content: string): Record<string, unknown> {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) throw new Error('no frontmatter')
  return parseYaml(m[1]) as Record<string, unknown>
}

describe('renderHugoFrontmatter — testedWith + requires', () => {
  const baseArgs: RenderHugoFrontmatterArgs = {
    slug: 'demo', title: 'Demo', description: '', time: 5, level: 'beginner',
    tags: [], primaryTag: '', author: 'Thomas Jung',
    authorProfile: 'https://github.com/jung-thomas', youWillLearn: [],
    prerequisites: '', steps: [{ number: 1, title: 'Step 1', content: '' }],
    nav: minimalNav, lastUpdated: '', createdAt: '', contributors: [],
  }

  it('emits testedWith map into the frontmatter (→ .Params.testedWith)', () => {
    const content = renderHugoFrontmatter({
      ...baseArgs,
      testedWith: { '@sap/cds': '10.x', node: '22' },
    })
    expect(content).toContain('testedWith:')
    const fm = fmFrom(content)
    expect(fm.testedWith).toEqual({ '@sap/cds': '10.x', node: '22' })
  })

  it('emits requires list into the frontmatter (→ .Params.requires)', () => {
    const content = renderHugoFrontmatter({
      ...baseArgs,
      requires: ['hana-cloud-mission-trial-1'],
    })
    const fm = fmFrom(content)
    expect(fm.requires).toEqual(['hana-cloud-mission-trial-1'])
  })

  it('omits testedWith when empty/unset', () => {
    expect('testedWith' in fmFrom(renderHugoFrontmatter(baseArgs))).toBe(false)
    expect('testedWith' in fmFrom(renderHugoFrontmatter({ ...baseArgs, testedWith: {} }))).toBe(false)
  })

  it('omits requires when empty/unset', () => {
    expect('requires' in fmFrom(renderHugoFrontmatter(baseArgs))).toBe(false)
    expect('requires' in fmFrom(renderHugoFrontmatter({ ...baseArgs, requires: [] }))).toBe(false)
  })
})
