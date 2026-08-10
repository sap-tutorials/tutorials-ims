// test/unit/hugo/topic-clusters-band.test.ts
//
// (#1170) SSR topic-clusters homepage band.
//
// Test strategy: template-source assertions (readFileSync the partial,
// assert on raw Go template text). This matches the repo's established
// pattern in test/unit/hugo/featured-topics-empty-snapshot-shell.test.ts
// and avoids the need to run Hugo or maintain a scratch publishDir.
//
// The featured-topics sibling test asserts that the shell is NOT wrapped
// in an `{{ if gt (len $slides) 0 }}` guard (it must always emit DOM for
// its Vue island to hydrate). This test asserts the INVERSE: the
// topic-clusters partial MUST have that guard, because it has no island —
// an empty band must produce zero DOM.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const tpl = readFileSync(
  path.resolve(
    import.meta.dirname,
    '../../../hugo/layouts/partials/homepage/topic-clusters-band.html',
  ),
  'utf8',
)

describe('topic-clusters-band partial (#1170)', () => {
  it('is wrapped in {{ if gt (len $clusters) 0 }} — empty-safe by omission (no island)', () => {
    // Whitespace-trim variants ({{-) must also match.
    // This is the INVERSE of the featured-topics guard: we require the guard
    // to be present so an empty clusters list produces ZERO DOM.
    expect(tpl).toMatch(/\{\{-?\s*if\s+gt\s+\(len\s+\$clusters\)\s+0\s*-?\}\}/)
  })

  it('contains the exact band title "Explore topic clusters"', () => {
    expect(tpl).toContain('Explore topic clusters')
  })

  it('has hp-topic-clusters CSS class on the section', () => {
    expect(tpl).toMatch(/<section\b[^>]*\bhp-topic-clusters\b/)
  })

  it('renders tutorial links with href="{{ .url }}" and {{ .title }}', () => {
    expect(tpl).toContain('href="{{ .url }}"')
    expect(tpl).toContain('{{ .title }}')
  })

  it('reads from .Site.Data.topic_clusters', () => {
    expect(tpl).toContain('.Site.Data.topic_clusters')
  })

  it('links to the full /topics/ front door', () => {
    expect(tpl).toContain('/topics/')
    expect(tpl).toMatch(/See all topics|Explore all topics|View all/i)
  })
})
