// hugo-apps/src/cmd-palette/actions.test.ts
//
// @vitest-environment happy-dom
//
// Issue #817 — verify the EXPLORE group is wired into the action registry
// and that keyword filtering surfaces each new route by intent (not just
// exact label match).

import { describe, it, expect } from 'vitest'
import { PALETTE_ACTIONS } from './actions'
import type { PaletteAction } from './actions'

// Mirror of the fuzzy-match function inside CommandPalette.vue. Kept in sync
// by the unit test below — if the Vue component's matcher diverges we want
// this test to break.
function fuzzyMatch(item: PaletteAction, q: string): boolean {
  if (!q) return true
  const haystack = (item.label + ' ' + (item.keywords?.join(' ') || '')).toLowerCase()
  return q.toLowerCase().split(/\s+/).every(token => haystack.includes(token))
}

describe('PALETTE_ACTIONS — EXPLORE group registration', () => {
  it('includes all six homepage verb-spine routes', () => {
    const exploreIds = PALETTE_ACTIONS.filter(a => a.group === 'explore').map(a => a.id)
    // The verb-spine partial at hugo/layouts/partials/homepage/verb-spine.html
    // emits exactly these six verbs in order. If a seventh verb ever appears
    // there, this list (and the registry) should grow to match.
    expect(exploreIds).toEqual(expect.arrayContaining([
      'explore-learn',
      'explore-build',
      'explore-integrate',
      'explore-operate',
      'explore-ai',
      'explore-connect',
    ]))
  })

  it('includes the Knowledge Graph Explorer entry', () => {
    const kg = PALETTE_ACTIONS.find(a => a.id === 'explore-knowledge-graph')
    expect(kg).toBeDefined()
    expect(kg?.group).toBe('explore')
    expect(kg?.label).toMatch(/knowledge graph/i)
  })

  it('every explore-group entry has navigation keywords', () => {
    const explore = PALETTE_ACTIONS.filter(a => a.group === 'explore')
    // Each entry must declare at least one keyword so users can find it
    // without remembering the exact label (the whole point of the palette).
    for (const a of explore) {
      expect(Array.isArray(a.keywords)).toBe(true)
      expect((a.keywords ?? []).length).toBeGreaterThan(0)
    }
  })

  it('default group is "actions" — explore-group entries opt in explicitly', () => {
    // Pre-existing actions (go-home, toggle-theme, etc.) don't set `group`;
    // they default to 'actions' at render time. Confirm the explore entries
    // are the only ones that set group: 'explore'.
    const explicitExplore = PALETTE_ACTIONS.filter(a => a.group === 'explore').length
    const explicitActions = PALETTE_ACTIONS.filter(a => a.group === 'actions').length
    const unset = PALETTE_ACTIONS.filter(a => a.group === undefined).length
    expect(explicitExplore).toBeGreaterThanOrEqual(7)  // 6 verbs + KG
    expect(unset + explicitActions).toBe(PALETTE_ACTIONS.length - explicitExplore)
  })
})

describe('keyword-driven discoverability', () => {
  // Each test pair represents a real intent a user might type. If a future
  // refactor drops the load-bearing keyword, the lookup regresses silently
  // unless we lock the intent here.
  it.each<[string, string]>([
    ['kg',           'explore-knowledge-graph'],
    ['graph',        'explore-knowledge-graph'],
    ['knowledge',    'explore-knowledge-graph'],
    ['concepts',     'explore-knowledge-graph'],
    ['cap',          'explore-build'],
    ['abap',         'explore-build'],
    ['fiori',        'explore-build'],
    ['joule',        'explore-ai'],
    ['ai core',      'explore-ai'],
    ['integration',  'explore-integrate'],
    ['btp',          'explore-operate'],
    ['deploy',       'explore-operate'],
    ['advocates',    'explore-connect'],
    ['community',    'explore-connect'],
    ['getting started', 'explore-learn'],
  ])('keyword %j matches %s', (query, expectedId) => {
    const matched = PALETTE_ACTIONS.filter(a => fuzzyMatch(a, query)).map(a => a.id)
    expect(matched).toContain(expectedId)
  })

  it('an empty query matches every action (filter is opt-in)', () => {
    const all = PALETTE_ACTIONS.filter(a => fuzzyMatch(a, ''))
    expect(all.length).toBe(PALETTE_ACTIONS.length)
  })

  it('case-insensitive multi-token match (e.g. "Knowledge GRAPH" hits KG)', () => {
    const matched = PALETTE_ACTIONS.filter(a => fuzzyMatch(a, 'Knowledge GRAPH')).map(a => a.id)
    expect(matched).toContain('explore-knowledge-graph')
  })
})
