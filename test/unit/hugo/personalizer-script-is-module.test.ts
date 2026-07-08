// test/unit/hugo/personalizer-script-is-module.test.ts
//
// (#763 hotfix) The `/js/homepage-personalizer.js` bundle is a native ES
// module — its Vite output begins with `import ...`. If baseof.html loads it
// as a classic script (no `type="module"`), the browser throws
// "Cannot use import statement outside a module" at parse time, boot() never
// runs, and the "Personalized for you" badge + For-You row silently do
// nothing — HomepageConfig.personalizationEnabled=true has no visible effect.
//
// Regression guard against exactly the shape that shipped in the initial
// #763 template edit (no `type="module"` attribute).

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const baseof = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/layouts/_default/baseof.html'),
  'utf8',
)

describe('baseof.html — homepage-personalizer <script> tag', () => {
  it('loads /js/homepage-personalizer.js with type="module"', () => {
    // Find the exact <script> tag that references the personalizer bundle.
    const re = /<script\b[^>]*\bsrc="\/js\/homepage-personalizer\.js"[^>]*>/
    const m = baseof.match(re)
    expect(m, 'homepage-personalizer <script> tag in baseof.html').toBeTruthy()
    // Attribute order is irrelevant — assert `type="module"` is present.
    expect(m![0]).toMatch(/\btype="module"/)
  })
})
