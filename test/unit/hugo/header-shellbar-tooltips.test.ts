// test/unit/hugo/header-shellbar-tooltips.test.ts
//
// Issue #1858: half of the top-right shellbar actions had no hover tooltip.
// A <ui5-shellbar-item> derives its tooltip solely from the icon's registered
// accessible name (getIconAccessibleName). Only 2 of the 7 icons ship one
// (search, action-settings); the other 5 (da/Joule, menu2/Navigate,
// share-2/Share, question-mark/Help, dark-mode/Toggle theme) have accData=null,
// so they rendered no title and no tooltip. The fix is an explicit `title` on
// every item host — for the accData-less icons it surfaces as the tooltip
// (the inner button renders no title, so the browser walks up to the host);
// the others keep their icon-default tooltip. Pin it so a future edit can't
// silently drop a tooltip again.

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const header = readFileSync(
  path.resolve(import.meta.dirname, '../../../hugo/layouts/partials/header.html'),
  'utf8',
)

describe('header.html — shellbar item tooltips (#1858)', () => {
  const items = header.match(/<ui5-shellbar-item\b[^>]*>/g) || []

  it('renders the top-right shellbar items', () => {
    // Sanity: the fix targets these items; make sure the markup still has them.
    expect(items.length, 'expected ui5-shellbar-item elements in header').toBeGreaterThanOrEqual(6)
  })

  it('every ui5-shellbar-item carries a non-empty title tooltip', () => {
    const missing = items.filter((tag) => !/\btitle="[^"]+"/.test(tag))
    expect(
      missing,
      `every shellbar item must have a non-empty title=; missing on:\n${missing.join('\n')}`,
    ).toEqual([])
  })
})
