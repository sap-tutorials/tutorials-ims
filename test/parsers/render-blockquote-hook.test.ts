import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const p = 'hugo/layouts/_default/_markup/render-blockquote.html'

describe('render-blockquote hook', () => {
  it('exists', () => {
    expect(existsSync(p)).toBe(true)
  })

  it('has a plain-`>` passthrough branch (no class) preserving today\'s default', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('.AlertType')
    expect(t).toMatch(/eq \.AlertType ""/)
    expect(t).toMatch(/<blockquote>\s*\{\{[-\s]*\.Text/)
  })

  it('emits a semantic alert class for alert blockquotes', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('class="alert alert-{{ .AlertType }}"')
  })
})
