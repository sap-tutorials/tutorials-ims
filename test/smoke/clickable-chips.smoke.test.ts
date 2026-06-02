// test/smoke/clickable-chips.smoke.test.ts
//
// Issue #161 — verifies the U1 Object Page renders experience and
// topic/product chips as anchors deep-linking to /tutorials/?level=...
// and /tutorials/?tag=... respectively. Pattern follows
// test/smoke/license-icon.test.js. Quote-stripping tolerant — the Hugo
// minifier removes quotes from safe attribute values, so regexes accept
// both `class="op-chip..."` and `class=op-chip...` forms; see
// [[feedback-hugo-minifier-strips-quotes]].

import { describe, it, expect, beforeAll } from 'vitest'
import { SRV_URL, fetchWithRetry } from './smoke.config.js'

// Stable witness slug — `abap-create-basic-app` exposes a `level`,
// `time`, multiple `displayTags`/`displayTagSlugs`, and a `primaryTag`.
const SLUG = process.env.SMOKE_CLICKABLE_CHIPS_SLUG ?? 'abap-create-basic-app'

describe(`Clickable chips on /tutorials/${SLUG}/ (#161)`, () => {
  // Initialised to '' so a 302 short-circuit in beforeAll produces clean
  // "expected '' to match …" failures rather than TypeErrors on undefined.
  let html = ''

  beforeAll(async () => {
    const res = await fetchWithRetry(`${SRV_URL}/content/tutorials/${SLUG}`)
    if (res.status === 302) return // login redirect — acceptable, content not published
    expect(res.status).toBe(200)
    html = await res.text()
  })

  it('renders the experience chip as an anchor with ?level=', () => {
    // Match the anchor regardless of attribute order or quote stripping.
    const anchor = html.match(
      /<a[^>]*class=["']?op-chip op-chip--link["']?[^>]*>[^<]*<span[^>]*op-chip__icon[^>]*>[^<]*<\/span>[^<]*<\/a>/,
    )
    expect(anchor, 'expected an experience chip anchor').toBeTruthy()
    expect(html).toMatch(/href=["']?[^"' >]*\/tutorials\/\?level=[a-z]+["']?/)
  })

  it('renders at least one topic/product chip as an anchor with ?tag=', () => {
    expect(html).toMatch(
      /<a[^>]*class=["']?op-chip op-chip--tag op-chip--link["']?[^>]*href=["']?[^"' >]*\/tutorials\/\?tag=[^"' >]+["']?/,
    )
  })

  it('URL-encodes the > in topic/product slugs', () => {
    // displayTagSlugs values contain `>`; urlquery emits %3E.
    expect(html).toMatch(/\?tag=[a-z0-9-]+%3E[a-z0-9-]+/i)
  })

  it('still suppresses any chip whose label is "License"', () => {
    // Same scope as license-icon.test.js — only chip-strip spans, ignore
    // step-body prose. Now must include anchors too.
    const linkChipMatches = html.match(
      /<(a|span)[^>]*class=["']?op-chip op-chip--tag(?: op-chip--link)?["']?[^>]*>([^<]*)<\/(?:a|span)>/g,
    ) || []
    const labels = linkChipMatches.map((m) => m.replace(/<[^>]+>/g, '').trim())
    expect(labels).not.toContain('License')
  })

  it('exposes a Filter-tutorials-by aria-label on each chip anchor', () => {
    expect(html).toMatch(/aria-label=["']?Filter tutorials by [^"'<>]+["']?/)
  })
})
