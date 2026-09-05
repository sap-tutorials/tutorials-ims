// hugo-apps/src/cmd-palette/actions.test.ts
//
// @vitest-environment happy-dom
//
// The EXPLORE group is no longer hardcoded in PALETTE_ACTIONS — it is derived
// at runtime from the shared nav tree in hugo/data/navigation.yaml (the same
// source the top-nav popover renders). These tests parse the REAL data file
// and drive it through navActionsFromData(), so they guard both the derivation
// logic AND the actual shipped set of destinations (regression net against
// someone dropping Channels/Topics/Browse/etc. from the nav).

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { describe, it, expect } from 'vitest'
import { PALETTE_ACTIONS, navActionsFromData, readNavData } from './actions'
import type { PaletteAction, NavData } from './actions'

// Mirror of the fuzzy-match function inside CommandPalette.vue. Kept in sync
// by the unit test below — if the Vue component's matcher diverges we want
// this test to break.
function fuzzyMatch(item: PaletteAction, q: string): boolean {
  if (!q) return true
  const haystack = (item.label + ' ' + (item.keywords?.join(' ') || '')).toLowerCase()
  return q.toLowerCase().split(/\s+/).every(token => haystack.includes(token))
}

// Parse the actual shipped nav data and build the explore actions from it.
const navDataPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../hugo/data/navigation.yaml')
const NAV_DATA = parseYaml(readFileSync(navDataPath, 'utf8')) as NavData
const EXPLORE = navActionsFromData(NAV_DATA)

describe('navActionsFromData — EXPLORE group derivation', () => {
  it('every derived action is in the explore group with a run and keywords', () => {
    expect(EXPLORE.length).toBeGreaterThan(0)
    for (const a of EXPLORE) {
      expect(a.group).toBe('explore')
      expect(typeof a.run).toBe('function')
      expect(Array.isArray(a.keywords)).toBe(true)
      expect((a.keywords ?? []).length).toBeGreaterThan(0)
    }
  })

  it('includes all seven homepage verb-spine routes', () => {
    const ids = EXPLORE.map(a => a.id)
    expect(ids).toEqual(expect.arrayContaining([
      'explore-learn', 'explore-build', 'explore-integrate', 'explore-model',
      'explore-operate', 'explore-ai', 'explore-connect',
    ]))
  })

  it('includes the previously-curated destinations (Concepts, KG, Devtoberfest, Advocates, API)', () => {
    const ids = EXPLORE.map(a => a.id)
    expect(ids).toEqual(expect.arrayContaining([
      'explore-concepts', 'explore-knowledge-graph', 'explore-devtoberfest',
      'explore-advocates', 'explore-api-docs',
    ]))
  })

  it('surfaces the destinations that were previously in neither menu (drift fix)', () => {
    // The whole point of the shared source: Channels/Topics/Browse/What's New/
    // App Space/Tutorial Navigator are now reachable from ⌘K, not just the nav.
    const ids = EXPLORE.map(a => a.id)
    expect(ids).toEqual(expect.arrayContaining([
      'nav-browse', 'nav-topics', 'nav-channels', 'nav-whats-new',
      'nav-app-space', 'nav-tutorial-navigator',
    ]))
  })

  it('uses the richer paletteLabel when present, falls back to label otherwise', () => {
    const build = EXPLORE.find(a => a.id === 'explore-build')!
    expect(build.label).toMatch(/CAP/) // paletteLabel wins for verbs
    const channels = EXPLORE.find(a => a.id === 'nav-channels')!
    expect(channels.label).toBe('Channels') // no paletteLabel → plain label
  })

  it('run navigates to the item href', () => {
    const kg = EXPLORE.find(a => a.id === 'explore-knowledge-graph')!
    const originalHref = window.location.href
    let assigned = ''
    Object.defineProperty(window, 'location', {
      value: { get href() { return originalHref }, set href(v) { assigned = v } },
      configurable: true,
    })
    kg.run(() => {})
    expect(assigned).toBe('/explore/')
  })
})

describe('navActionsFromData — resilience', () => {
  it('returns [] for null/empty/malformed input', () => {
    expect(navActionsFromData(null)).toEqual([])
    expect(navActionsFromData(undefined)).toEqual([])
    expect(navActionsFromData({ groups: [] })).toEqual([])
    expect(navActionsFromData({} as NavData)).toEqual([])
  })

  it('skips items missing an id or href', () => {
    const actions = navActionsFromData({
      groups: [{ id: 'g', label: 'G', items: [
        { id: 'ok', label: 'OK', href: '/ok/' },
        { id: '', label: 'No id', href: '/x/' } as never,
        { id: 'no-href', label: 'No href' } as never,
      ] }],
    })
    expect(actions.map(a => a.id)).toEqual(['ok'])
  })
})

describe('readNavData — parses the injected script tag', () => {
  it('reads and parses <script id="nav-data">', () => {
    const el = document.createElement('script')
    el.id = 'nav-data'
    el.type = 'application/json'
    el.textContent = JSON.stringify({ groups: [{ id: 'g', label: 'G', items: [{ id: 'i', label: 'I', href: '/i/' }] }] })
    document.body.appendChild(el)
    try {
      const data = readNavData(document)
      expect(data?.groups[0].items[0].id).toBe('i')
    } finally {
      el.remove()
    }
  })

  it('returns null when the tag is absent or holds bad JSON', () => {
    expect(readNavData(document)).toBeNull()
    const el = document.createElement('script')
    el.id = 'nav-data'
    el.textContent = '{not json'
    document.body.appendChild(el)
    try {
      expect(readNavData(document)).toBeNull()
    } finally {
      el.remove()
    }
  })
})

describe('keyword-driven discoverability (over the derived explore actions)', () => {
  it.each<[string, string]>([
    ['kg',           'explore-knowledge-graph'],
    ['graph',        'explore-knowledge-graph'],
    ['cap',          'explore-build'],
    ['abap',         'explore-build'],
    ['fiori',        'explore-build'],
    ['joule',        'explore-ai'],
    ['ai core',      'explore-ai'],
    ['integration',  'explore-integrate'],
    ['btp',          'explore-operate'],
    ['deploy',       'explore-operate'],
    ['getting started', 'explore-learn'],
    ['channels',     'nav-channels'],
    ['topics',       'nav-topics'],
    ['browse',       'nav-browse'],
    ['whats new',    'nav-whats-new'],
    ['navigator',    'nav-tutorial-navigator'],
  ])('keyword %j matches %s', (query, expectedId) => {
    const matched = EXPLORE.filter(a => fuzzyMatch(a, query)).map(a => a.id)
    expect(matched).toContain(expectedId)
  })
})

describe('PALETTE_ACTIONS — static action group', () => {
  it('holds only non-explore actions now (explore comes from nav data)', () => {
    expect(PALETTE_ACTIONS.some(a => a.group === 'explore')).toBe(false)
    const ids = PALETTE_ACTIONS.map(a => a.id)
    expect(ids).toEqual(expect.arrayContaining([
      'go-home', 'go-progress', 'open-joule', 'toggle-theme', 'copy-url', 'report-issue',
    ]))
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
