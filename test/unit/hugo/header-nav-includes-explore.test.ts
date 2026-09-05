// test/unit/hugo/header-nav-includes-explore.test.ts
//
// The nav popover (hugo/layouts/partials/header.html) and the ⌘K palette are
// both now rendered from a single source — hugo/data/navigation.yaml. header.html
// ranges over that data to emit the <ui5-li> rows, so the literal /explore link
// no longer lives in the partial; it lives in the data file. This pins the
// Knowledge Graph → /explore entry against that source of truth so a future edit
// can't silently drop it. (header.html still ranges the data — guarded below.)

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { parse as parseYaml } from 'yaml'

const repoRoot = path.resolve(import.meta.dirname, '../../..')
const navData = parseYaml(
  readFileSync(path.resolve(repoRoot, 'hugo/data/navigation.yaml'), 'utf8'),
) as { groups: { items: { id: string; label: string; href: string }[] }[] }
const header = readFileSync(
  path.resolve(repoRoot, 'hugo/layouts/partials/header.html'),
  'utf8',
)

const allItems = navData.groups.flatMap((g) => g.items)

describe('navigation.yaml — Knowledge Graph nav entry', () => {
  it('has a Knowledge Graph item pointing under /explore', () => {
    const kg = allItems.find((i) => /^\/explore(\/|$)/.test(i.href))
    expect(kg, '/explore item in nav data').toBeTruthy()
    expect(kg!.label.toLowerCase()).toMatch(/knowledge graph/)
  })
})

describe('header.html — still renders the nav from data', () => {
  it('ranges over site.Data.navigation and emits data-href rows', () => {
    // The partial must keep driving the popover from the shared data file and
    // emit each item's href as data-href (the click handler reads data-href).
    expect(header).toMatch(/site\.Data\.navigation/)
    expect(header).toMatch(/data-href="\{\{\s*\.href\s*\}\}"/)
  })
})
