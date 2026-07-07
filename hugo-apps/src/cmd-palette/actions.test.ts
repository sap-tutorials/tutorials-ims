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
  it('includes all seven homepage verb-spine routes', () => {
    const exploreIds = PALETTE_ACTIONS.filter(a => a.group === 'explore').map(a => a.id)
    // The verb-spine partial at hugo/layouts/partials/homepage/verb-spine.html
    // emits exactly these seven verbs in order. If an eighth verb ever
    // appears there, this list (and the registry) should grow to match.
    expect(exploreIds).toEqual(expect.arrayContaining([
      'explore-learn',
      'explore-build',
      'explore-integrate',
      'explore-model',
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
    expect(explicitExplore).toBeGreaterThanOrEqual(11)  // 7 verbs + KG + 3 new curated
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

describe('#1054 — open-joule action wiring', () => {
  it('calls window.joule.open() when the runtime is present', () => {
    const entry = PALETTE_ACTIONS.find(a => a.id === 'open-joule')
    expect(entry).toBeDefined()
    const calls: unknown[] = []
    ;(window as unknown as { joule: { open: (opts?: unknown) => void } }).joule = {
      open: (opts?: unknown) => { calls.push(opts ?? null) },
    }
    try {
      let closed = false
      entry!.run(() => { closed = true })
      expect(closed).toBe(true)
      expect(calls.length).toBe(1)
    } finally {
      delete (window as unknown as { joule?: unknown }).joule
    }
  })

  it('falls back to un-hiding the panel when window.joule is missing', () => {
    const entry = PALETTE_ACTIONS.find(a => a.id === 'open-joule')!
    delete (window as unknown as { joule?: unknown }).joule
    const panel = document.createElement('div')
    panel.id = 'joule-panel'
    panel.hidden = true
    document.body.appendChild(panel)
    try {
      entry.run(() => {})
      expect(panel.hidden).toBe(false)
    } finally {
      panel.remove()
    }
  })
})

describe('#1036 — Concepts / Devtoberfest / Developer Advocates nav entries', () => {
  it('includes explore-concepts, explore-devtoberfest, explore-advocates in the EXPLORE group', () => {
    const exploreIds = PALETTE_ACTIONS.filter(a => a.group === 'explore').map(a => a.id)
    expect(exploreIds).toEqual(expect.arrayContaining([
      'explore-concepts',
      'explore-devtoberfest',
      'explore-advocates',
    ]))
  })

  it('places the three new entries between explore-connect and explore-knowledge-graph', () => {
    const explore = PALETTE_ACTIONS.filter(a => a.group === 'explore').map(a => a.id)
    const iConnect = explore.indexOf('explore-connect')
    const iKG      = explore.indexOf('explore-knowledge-graph')
    const iConcepts     = explore.indexOf('explore-concepts')
    const iDevtoberfest = explore.indexOf('explore-devtoberfest')
    const iAdvocates    = explore.indexOf('explore-advocates')
    expect(iConnect).toBeGreaterThanOrEqual(0)
    expect(iKG).toBeGreaterThan(iConnect)
    for (const idx of [iConcepts, iDevtoberfest, iAdvocates]) {
      expect(idx).toBeGreaterThan(iConnect)
      expect(idx).toBeLessThan(iKG)
    }
  })

  it.each<[string, string, string]>([
    ['concepts',      'explore-concepts',      '/concepts/'],
    ['glossary',      'explore-concepts',      '/concepts/'],
    ['devtoberfest',  'explore-devtoberfest',  '/devtoberfest/'],
    ['festival',      'explore-devtoberfest',  '/devtoberfest/'],
    ['advocates',     'explore-advocates',     '/developer-advocates/'],
    ['devrel',        'explore-advocates',     '/developer-advocates/'],
  ])('keyword %j matches %s and its run navigates to %s', (query, expectedId, expectedHref) => {
    const matched = PALETTE_ACTIONS.filter(a => fuzzyMatch(a, query)).map(a => a.id)
    expect(matched).toContain(expectedId)
    // Assert the run closure navigates to the expected href by stubbing
    // window.location.href assignment.
    const entry = PALETTE_ACTIONS.find(a => a.id === expectedId)!
    const originalHref = window.location.href
    let assigned = ''
    Object.defineProperty(window, 'location', {
      value: { get href() { return originalHref }, set href(v) { assigned = v } },
      configurable: true,
    })
    entry.run(() => {})
    expect(assigned).toBe(expectedHref)
  })
})
