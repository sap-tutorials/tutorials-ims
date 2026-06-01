// test/smoke/navigator-no-results.smoke.test.ts
//
// Issue #159: verify the deployed navigator JS chunk contains the new
// result-region markup. The visible attributes (aria-busy,
// data-region-busy) only appear after Vue hydrates in a real browser, so
// for a smoke check we string-match the compiled JS bundle: it MUST
// reference the new contract markers.
//
// If the bundle is stale, this test fails — typically because Hugo
// wasn't rebuilt after a hugo-apps change (see CLAUDE.md "Hugo must
// finish before mbt").

import { describe, it, expect } from 'vitest'

const BASE = process.env.SMOKE_BASE_URL
if (!BASE) throw new Error('SMOKE_BASE_URL must be set')

async function fetchText(path: string): Promise<string> {
  const res = await fetch(new URL(path, BASE))
  expect(res.ok, `${path} returned ${res.status}`).toBe(true)
  return res.text()
}

describe('navigator no-results stability smoke (#159)', () => {
  it('homepage loads and references the navigator JS chunk', async () => {
    const html = await fetchText('/')
    // The Vue mount point is <div id="tutorial-navigator">.
    // Hugo's production minifier strips quotes from safe attribute values,
    // so accept both quoted and unquoted forms.
    expect(html).toMatch(/id=["']?tutorial-navigator["']?/)
    // The page must reference the navigator chunk under /js/.
    expect(html).toMatch(/\/js\/navigator(\.[a-z0-9]+)?\.js/)
  })

  it('navigator JS chunk contains the new result-region contract', async () => {
    // Find the navigator chunk URL from the HTML, then fetch and inspect it.
    const html = await fetchText('/')
    const chunkMatch = html.match(/(\/js\/navigator(?:\.[a-z0-9]+)?\.js(?:\?[^"'\s]*)?)/)
    expect(chunkMatch, 'navigator JS chunk URL not found in HTML').toBeTruthy()
    const chunkUrl = chunkMatch![1]

    const js = await fetchText(chunkUrl)
    // The new template emits these literal strings into the compiled
    // render function.
    expect(js).toMatch(/data-region-busy/)
    expect(js).toMatch(/navigator-empty/)
    expect(js).toMatch(/aria-busy/)
    // Sub-threshold hint and busy-indicator class names from the new
    // template — both must be present.
    expect(js).toMatch(/navigator-hint/)
  })
})
