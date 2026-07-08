// test/unit/hugo/featured-topics-empty-snapshot-shell.test.ts
//
// (#1032 followup) The Row-5 "Featured missions" carousel was silently
// missing from the deployed homepage after 03d42355 committed
// hugo/data/featured_topics.json with `snapshot: []` (nightly job hadn't
// yet materialized rows, or /build/featured-topics returned empty at
// build time). The old partial wrapped everything in
// `{{ if gt (len $slides) 0 }}` — an empty snapshot produced zero HTML,
// so there was no <section data-app="featured-topics-carousel"> for the
// Vue island to hydrate against. Result: no Row 5 until the next
// approuter deploy.
//
// This test guards the fix: the partial MUST always emit the shell —
// section with the data-app hook and viewport/controls markers — so
// useHydrate can populate the row from /homepage/featuredTopics() at
// runtime even when the baked snapshot is empty.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const tpl = readFileSync(
  path.resolve(
    import.meta.dirname,
    '../../../hugo/layouts/partials/homepage/featured-topics-carousel.html',
  ),
  'utf8',
)

describe('featured-topics-carousel partial — empty-snapshot shell', () => {
  it('does NOT wrap the shell in `{{ if gt (len $slides) 0 }}` (regression #1032 followup)', () => {
    // Guard against the pre-fix shape. Hugo whitespace-trim variants
    // (`{{-`) count too. Whitespace inside the tag is tolerated.
    expect(tpl).not.toMatch(/\{\{-?\s*if\s+gt\s+\(len\s+\$slides\)\s+0\s*-?\}\}/)
  })

  it('always emits <section data-app="featured-topics-carousel">', () => {
    // The section opens unconditionally at the top of the template, not
    // gated behind any conditional. Match against the raw literal that
    // useHydrate's `document.querySelectorAll('[data-app="featured-topics-carousel"]')`
    // depends on.
    expect(tpl).toMatch(/<section\b[^>]*\bdata-app="featured-topics-carousel"/)
  })

  it('flags the shell with a --pending modifier when snapshot is empty', () => {
    // The `.hp-featured-carousel--pending` class hides the empty shell
    // via CSS until Vue populates it. Without this, users would see a
    // lonely "Featured missions" header with no cards when hydration
    // is disabled or fails.
    expect(tpl).toMatch(/hp-featured-carousel--pending/)
  })

  it('carries the etag attribute so useHydrate can send If-None-Match', () => {
    // On the empty-snapshot path we still emit `data-etag=""` so useHydrate's
    // conditional-request branch (skip when etag matches) reads a well-defined
    // value. Even with a defaulted empty featured_topics data, `$ft.etag`
    // must resolve without a template error.
    expect(tpl).toMatch(/data-etag="\{\{\s*\$ft\.etag\s*\}\}"/)
  })
})
