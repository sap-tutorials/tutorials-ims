// hugo-apps/src/browse/__tests__/card-template-parity.test.ts
//
// Verifies that Vue card SSR output matches captured Hugo partial output
// (post-canonicalization). This is the load-bearing test against the
// dual-edit tax: when card markup changes, the Vue SFC and the Hugo
// partial must update in lockstep — otherwise this test fails.
//
// Coverage extends to BOTH /browse/ AND / (#200). Both surfaces use the
// same Hugo partials (hugo/layouts/partials/browse/_partials/card-*.html)
// and the same Vue components (hugo-apps/src/shared/cards/*.vue), so a
// single parity test covers both. The fixtures here are the canonical
// shape; if either surface drifts the partial or the SFC, this test
// catches it for both.
//
// Why post-canonicalization rather than byte-strict: Vue SSR and Hugo
// emit different rendering artefacts that aren't content drift —
// scoped-CSS data-v-* attributes (Vue), HTML comments, &middot; vs
// the Unicode middle-dot character, inter-element whitespace. We strip
// those before the comparison and assert byte-equality on the rest.
//
// Fixture regeneration: tools/regen-card-parity-fixtures.sh

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import TutorialCard from '@shared/cards/TutorialCard.vue'
import MissionCard from '@shared/cards/MissionCard.vue'
import GroupCard from '@shared/cards/GroupCard.vue'
import { emptyProgress } from '../../navigator/cardProgress'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')
const fixtures = JSON.parse(
  readFileSync(join(FIXTURES, 'cards.fixtures.json'), 'utf-8')
)

/**
 * Canonicalize HTML for byte-comparison between Vue SSR and Hugo.
 *
 * Vue SSR emits artefacts that Hugo doesn't (and vice versa) — none are
 * content drift, just rendering-engine differences:
 *
 * - Vue: `data-v-<hash>` attributes from <style scoped> components
 *   (e.g. LicenseIcon).
 * - Vue: `<!---->` placeholder comments for empty components/slots.
 * - Vue: `data-server-rendered="true"` (legacy SSR marker; harmless if
 *   absent).
 * - Vue: HTML comments inside SVGs (source comments preserved).
 * - Vue: Unicode `·` (U+00B7) for `&middot;` (compiled to character).
 * - Hugo: `&middot;` HTML entity (passed through literally).
 * - Hugo: literal whitespace + newlines between elements (Vue strips).
 *
 * After canonicalization, the two render strategies should produce
 * byte-equivalent output for the same input data.
 */
function canonicalize(html: string): string {
  return html
    // Strip Vue scoped-CSS attributes
    .replace(/\s+data-v-[a-f0-9]+(?:="[^"]*")?/g, '')
    // Strip Vue legacy SSR marker
    .replace(/\s+data-server-rendered="[a-z]+"/g, '')
    // Strip ALL HTML comments (source comments AND Vue's <!---->)
    .replace(/<!--[\s\S]*?-->/g, '')
    // Normalize the meta separator: Hugo's &middot; → Unicode ·
    .replace(/&middot;/g, '·')
    // Collapse any run of whitespace (incl. newlines) to a single space
    .replace(/\s+/g, ' ')
    // Tighten inter-element spacing (Hugo emits "</span>\n<span>" → "</span> <span>" → "</span><span>")
    .replace(/>\s+</g, '><')
    .trim()
}

describe('card-template parity (Vue SSR ⇄ Hugo partial)', () => {
  it('TutorialCard matches card-tutorial.html', async () => {
    const vueHtml = await renderToString(
      createSSRApp({
        render: () =>
          h(TutorialCard, { item: fixtures.tutorial, progress: emptyProgress() }),
      })
    )
    const hugoHtml = readFileSync(
      join(FIXTURES, 'card-tutorial.expected.html'),
      'utf-8'
    )
    expect(canonicalize(vueHtml)).toBe(canonicalize(hugoHtml))
  })

  it('MissionCard matches card-mission.html', async () => {
    const vueHtml = await renderToString(
      createSSRApp({
        render: () =>
          h(MissionCard, { item: fixtures.mission, progress: emptyProgress() }),
      })
    )
    const hugoHtml = readFileSync(
      join(FIXTURES, 'card-mission.expected.html'),
      'utf-8'
    )
    expect(canonicalize(vueHtml)).toBe(canonicalize(hugoHtml))
  })

  it('GroupCard matches card-group.html', async () => {
    const vueHtml = await renderToString(
      createSSRApp({
        render: () =>
          h(GroupCard, { item: fixtures.group, progress: emptyProgress() }),
      })
    )
    const hugoHtml = readFileSync(
      join(FIXTURES, 'card-group.expected.html'),
      'utf-8'
    )
    expect(canonicalize(vueHtml)).toBe(canonicalize(hugoHtml))
  })
})
