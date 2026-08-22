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

  it('renders item links with href="{{ .href }}" and a title-or-slug label (#1794, #KG)', () => {
    // #KG: items[] use .href (unified field). Back-compat fallback maps .url→.href
    // when building items from legacy .tutorials. The anchor uses .href throughout.
    expect(tpl).toContain('href="{{ .href }}"')
    // #1794: link text is a computed $label that prefers .title but falls back
    // to .slug for items with an empty title.
    expect(tpl).toContain('{{ $label }}')
    expect(tpl).toMatch(/\$label\s*:=\s*or\s+\(trim\s+\(\.title/)
    expect(tpl).toMatch(/\.slug\s*\|\s*default/)
  })

  it('reads from .Site.Data.topic_clusters', () => {
    expect(tpl).toContain('.Site.Data.topic_clusters')
  })

  it('links to the full /topics/ front door', () => {
    expect(tpl).toContain('/topics/')
    expect(tpl).toMatch(/See all topics|Explore all topics|View all/i)
  })

  // --- #KG multi-source expansion (Task 6) ---

  it('emits data-app="topic-clusters-band" and data-etag on the section for island hydration (#KG)', () => {
    expect(tpl).toContain('data-app="topic-clusters-band"')
    expect(tpl).toContain('data-etag=')
  })

  it('renders per-kind badge chips with hp-tc-badge class on each item (#KG)', () => {
    // Template emits `hp-tc-badge hp-tc-badge--{{ .kind }}` — the literal prefix
    // is static; the kind suffix is injected at render time.
    expect(tpl).toContain('hp-tc-badge hp-tc-badge--')
  })

  it('emits data-kind and data-slug attributes on each <li> for island targeting (#KG)', () => {
    expect(tpl).toContain('data-kind="{{ .kind }}"')
    expect(tpl).toContain('data-slug="{{ .slug }}"')
  })

  it('emits data-fp on each cluster card for island targeting (#KG)', () => {
    expect(tpl).toContain('data-fp="{{ .communityFingerprint }}"')
  })

  it('still emits zero DOM when clusters is empty — guard preserved with no items fallback (#KG)', () => {
    // Back-compat: when items[] is absent, fall back to .tutorials list.
    // Verify the guard is still present (all content inside it) and items fallback exists.
    expect(tpl).toMatch(/\{\{-?\s*if\s+gt\s+\(len\s+\$clusters\)\s+0\s*-?\}\}/)
    expect(tpl).toContain('.tutorials')
    // items fallback uses .items | default slice
    expect(tpl).toContain('.items | default slice')
  })
})
