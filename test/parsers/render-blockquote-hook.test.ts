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

  it('delegates alert blockquotes to the tut-alert partial, which emits a semantic alert class', () => {
    // #2595/#71a8d70bc: the alert branch no longer emits the class inline; it
    // delegates to partials/tut-alert.html, passing .AlertType as `type`. The
    // semantic `alert alert-<type>` class is emitted by the partial.
    const t = readFileSync(p, 'utf8')
    expect(t).toMatch(/partial\s+"tut-alert\.html"/)
    expect(t).toContain('"type" .AlertType')

    const partial = readFileSync('hugo/layouts/partials/tut-alert.html', 'utf8')
    expect(partial).toContain('class="alert alert-{{ $type }}"')
  })
})
