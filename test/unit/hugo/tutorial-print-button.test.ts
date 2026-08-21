// Static source guards for the tutorial Print / Save-as-PDF feature (#1943).
// No Hugo/browser runtime needed — we assert the three source artifacts that
// make the feature work stay wired together:
//   1. the layout renders a delegated print button,
//   2. print.css hides that button from the printed page,
//   3. tutorial.ts handles the click AND the ?print=1 deep link.
// Behavior (that window.print actually fires) is covered by the e2e spec
// test/e2e/tutorial-print.test.js; this tier is the cheap regression net that
// runs in `npm test`.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '../../..')
// u1-object-page.html is the DEFAULT tutorial layout (hugo.toml: layout =
// 'u1-object-page'); tutorials/single.html is legacy and not rendered.
const layout = readFileSync(path.join(root, 'hugo/layouts/tutorials/u1-object-page.html'), 'utf8')
const printCss = readFileSync(path.join(root, 'hugo/assets/css/print.css'), 'utf8')
const tutorialJs = readFileSync(path.join(root, 'hugo/assets/js/tutorial.ts'), 'utf8')

describe('tutorial Print / Save-as-PDF button (#1943)', () => {
  it('layout renders a print button with data-action="print-tutorial"', () => {
    expect(layout).toMatch(/<button[^>]*data-action="print-tutorial"/)
  })

  it('print button is accessibly labelled', () => {
    // aria-label so the icon+text control is announced even if the SVG/text is
    // hidden or unstyled.
    expect(layout).toMatch(/data-action="print-tutorial"[^>]*aria-label=/)
  })

  it('print.css hides the button from the printed page', () => {
    // Must be in the display:none hide-list block, not merely mentioned.
    expect(printCss).toMatch(/\.tutorial-print-btn/)
    const hideBlock = printCss.slice(0, printCss.indexOf('display: none'))
    expect(hideBlock, '.tutorial-print-btn is not in the print hide list').toContain('.tutorial-print-btn')
  })

  it('tutorial.ts dispatches the print action to window.print()', () => {
    expect(tutorialJs).toMatch(/data-action="print-tutorial"/)
    expect(tutorialJs).toMatch(/window\.print\(\)/)
  })

  it('tutorial.ts wires the ?print=1 deep link and calls it on init', () => {
    expect(tutorialJs).toMatch(/URLSearchParams\(location\.search\)\.has\('print'\)/)
    expect(tutorialJs).toMatch(/initPrintDeepLink\(\)/)
  })

  it('print force-loads lazy images before printing (#1943 blank-image fix)', () => {
    // Images render loading="lazy" (render-image.html); printing directly leaves
    // off-screen step images blank. Both print entry points must route through
    // printTutorial(), which flips lazy → eager and awaits the images.
    expect(tutorialJs).toMatch(/function preparePrintImages/)
    expect(tutorialJs).toMatch(/async function printTutorial/)
    // lazy → eager flip is the mechanism that triggers the fetch.
    expect(tutorialJs).toMatch(/img\.loading = 'eager'/)
    // Neither entry point may call window.print() without preparing images.
    expect(tutorialJs, 'click handler must route through printTutorial()')
      .toMatch(/print-tutorial"[\s\S]*?void printTutorial\(\)/)
    // window.print() should only be *called* from inside printTutorial()
    // (match statement lines, not the comment that mentions it).
    const printCalls = tutorialJs.match(/^\s*window\.print\(\)/gm) || []
    expect(printCalls.length, 'window.print() should be called exactly once (inside printTutorial)').toBe(1)
  })
})
