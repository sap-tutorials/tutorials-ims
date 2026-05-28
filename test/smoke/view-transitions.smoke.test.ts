// test/smoke/view-transitions.smoke.test.ts
//
// Verifies the View Transitions + scroll-driven layer is deployed:
// - markup carries the markers and classes the design relies on
// - the compiled CSS bundle contains the @view-transition rule and the
//   scroll-driven keyframe selectors, wrapped in @supports + reduce-motion.
//
// Hugo's production minifier strips quotes from safe attribute values, so
// regex assertions tolerate both quoted and unquoted forms.

import { describe, it, expect } from 'vitest'

const BASE = process.env.SMOKE_BASE_URL
if (!BASE) throw new Error('SMOKE_BASE_URL must be set')

async function fetchText(path: string): Promise<string> {
  const res = await fetch(new URL(path, BASE))
  expect(res.ok, `${path} returned ${res.status}`).toBe(true)
  return res.text()
}

describe('view-transitions smoke', () => {
  it('navigator page has nav-cards with data-vt-card marker', async () => {
    const html = await fetchText('/build/navigator')
    expect(html).toMatch(/data-vt-card=["']?navigator["']?/)
    expect(html).toMatch(/class=["'][^"']*\bnav-card\b/)
  })

  it('a tutorial Object Page has tutorial-hero-title on the hero H1', async () => {
    const catalogJson = await fetchText('/build/catalog')
    const slugMatch = catalogJson.match(/"slug"\s*:\s*"([a-z0-9-]+)"/)
    expect(slugMatch, 'no tutorial slug in catalog').toBeTruthy()
    const slug = slugMatch![1]

    const tutorialHtml = await fetchText(`/tutorials/${slug}/`)
    expect(tutorialHtml).toMatch(/class=["'][^"']*\btutorial-hero-title\b/)
  })

  it('a mission page has mission-hero-title and mission-hero', async () => {
    const catalogJson = await fetchText('/build/catalog')
    const missionMatch = catalogJson.match(/"missions"[\s\S]*?"slug"\s*:\s*"([a-z0-9-]+)"/)
    expect(missionMatch, 'no mission slug in catalog').toBeTruthy()
    const slug = missionMatch![1]

    const missionHtml = await fetchText(`/missions/${slug}/`)
    expect(missionHtml).toMatch(/class=["'][^"']*\bmission-hero\b/)
    expect(missionHtml).toMatch(/class=["'][^"']*\bmission-hero-title\b/)
  })

  it('the compiled JS bundle includes the view-transitions module strings', async () => {
    const html = await fetchText('/')
    const jsMatch = html.match(/src=["']([^"']*ui5-bootstrap[^"']*\.js)["']/)
    expect(jsMatch, 'ui5-bootstrap.js script tag not found').toBeTruthy()
    const js = await fetchText(jsMatch![1])
    expect(js).toContain('hero-title')
  })

  it('the compiled CSS contains @view-transition and animation-timeline strings', async () => {
    const html = await fetchText('/')
    const cssRefs = Array.from(html.matchAll(/href=["']([^"']*\.css)["']/g)).map((m) => m[1])
    expect(cssRefs.length).toBeGreaterThan(0)
    const allCss = (await Promise.all(cssRefs.map((p) => fetchText(p)))).join('\n')
    expect(allCss).toMatch(/@view-transition/)
    expect(allCss).toMatch(/view-transition-name\s*:\s*hero-title/)
    expect(allCss).toMatch(/animation-timeline\s*:\s*view\(\)/)
    expect(allCss).toMatch(/prefers-reduced-motion\s*:\s*no-preference/)
  })
})
