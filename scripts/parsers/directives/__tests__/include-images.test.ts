import { describe, it, expect, beforeEach } from 'vitest'
import { resetRegistry, registerDirective } from '../../directive-registry.js'
import { INCLUDE_DEF } from '../include.js'
import { expandDirectives } from '../../directives.js'
import type { ExpandDirectivesContext } from '../../directives.js'

describe('::include image URL rewriting', () => {
  beforeEach(() => {
    resetRegistry()
    registerDirective(INCLUDE_DEF)
  })

  it('rewrites relative image in snippet to snippet repo base URL', () => {
    const snippetMap = new Map([['myrepo/_snippets/step.md', '![screen](cockpit.png)']])
    const ctx: ExpandDirectivesContext = { slug: 'test', snippetMap }
    const result = expandDirectives('::include[step.md]', ctx)
    expect(result).toContain('raw.githubusercontent.com/sap-tutorials/myrepo')
    expect(result).toContain('cockpit.png')
    expect(result).not.toContain('(cockpit.png)')
  })

  it('leaves absolute URLs in snippets untouched', () => {
    const snippetMap = new Map([['myrepo/_snippets/step.md', '![screen](https://example.com/img.png)']])
    const ctx: ExpandDirectivesContext = { slug: 'test', snippetMap }
    const result = expandDirectives('::include[step.md]', ctx)
    expect(result).toContain('https://example.com/img.png')
  })

  it('rewrites shared snippet image to tutorial-snippets repo base URL', () => {
    const snippetMap = new Map([['shared/setup.md', '![logo](logo.png)']])
    const ctx: ExpandDirectivesContext = { slug: 'test', snippetMap }
    const result = expandDirectives('::include[shared:setup.md]', ctx)
    expect(result).toContain('tutorial-snippets')
    expect(result).toContain('logo.png')
  })
})
