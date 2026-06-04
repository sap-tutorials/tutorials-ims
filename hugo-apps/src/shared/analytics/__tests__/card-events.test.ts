// hugo-apps/src/shared/analytics/__tests__/card-events.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../tracker', () => ({
  track: vi.fn(),
  flush: vi.fn(),
}))

import { track } from '../tracker'
import { wireCardEvents, _resetForTests } from '../card-events'

// Build a sub-tree from a tag spec to avoid the dangerous DOM HTML-write
// property. Spec: { tag, attrs?, classes?, children? }
interface NodeSpec {
  tag: string
  attrs?: Record<string, string>
  classes?: string[]
  text?: string
  children?: NodeSpec[]
}
function buildTree(spec: NodeSpec): HTMLElement {
  const el = document.createElement(spec.tag)
  if (spec.attrs) {
    for (const [k, v] of Object.entries(spec.attrs)) el.setAttribute(k, v)
  }
  if (spec.classes) el.className = spec.classes.join(' ')
  if (spec.text) el.textContent = spec.text
  if (spec.children) {
    for (const c of spec.children) el.appendChild(buildTree(c))
  }
  return el
}
function setBody(spec: NodeSpec) {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  document.body.appendChild(buildTree(spec))
}

describe('card-events', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    _resetForTests()
    sessionStorage.clear()
  })
  afterEach(() => {
    _resetForTests()
    sessionStorage.clear()
  })

  it('fires card_click with source:"featured-rail" when card is in featured rails container', () => {
    setBody({
      tag: 'div',
      attrs: { 'data-rails-container': 'featured' },
      children: [{
        tag: 'a',
        classes: ['nav-card', 'tutorial'],
        attrs: { 'data-vt-card': 'abap-101' },
        text: 'card',
      }],
    })
    wireCardEvents('/')
    const card = document.querySelector('.nav-card') as HTMLElement
    card.click()
    expect(track).toHaveBeenCalledWith('card_click', expect.objectContaining({
      cardType: 'tutorial',
      cardId: 'abap-101',
      source: 'featured-rail',
      position: 0,
    }))
  })

  it('fires card_click with source:"recent-rail" when card is in recent rails container', () => {
    setBody({
      tag: 'div',
      attrs: { 'data-rails-container': 'recent' },
      children: [{
        tag: 'a',
        classes: ['nav-card', 'mission'],
        attrs: { 'data-vt-card': 'abap-mission' },
        text: 'card',
      }],
    })
    wireCardEvents('/')
    const card = document.querySelector('.nav-card') as HTMLElement
    card.click()
    expect(track).toHaveBeenCalledWith('card_click', expect.objectContaining({
      cardType: 'mission',
      cardId: 'abap-mission',
      source: 'recent-rail',
    }))
  })

  it('fires card_click with source:"grid" when card is not in any rail', () => {
    setBody({
      tag: 'div',
      children: [
        { tag: 'a', classes: ['nav-card', 'group'], attrs: { 'data-vt-card': 'g1' }, text: 'card1' },
        { tag: 'a', classes: ['nav-card', 'group'], attrs: { 'data-vt-card': 'g2' }, text: 'card2' },
      ],
    })
    wireCardEvents('/browse/')
    const cards = document.querySelectorAll<HTMLElement>('.nav-card')
    cards[1].click()
    expect(track).toHaveBeenCalledWith('card_click', expect.objectContaining({
      cardType: 'group',
      cardId: 'g2',
      source: 'grid',
      position: 1,
    }))
  })

  it('writes analytics.lastClick to sessionStorage on card_click', () => {
    setBody({
      tag: 'a',
      classes: ['nav-card', 'tutorial'],
      attrs: { 'data-vt-card': 'abc' },
      text: 'card',
    })
    wireCardEvents('/browse/')
    ;(document.querySelector('.nav-card') as HTMLElement).click()
    const stored = sessionStorage.getItem('analytics.lastClick')
    expect(stored).toBeTruthy()
    const parsed = JSON.parse(stored!)
    expect(parsed.fromSurface).toBe('/browse/')
    expect(parsed.fromCardId).toBe('abc')
    expect(typeof parsed.ts).toBe('number')
  })

  it('fires pagination_change with fromPage and toPage on pager click', () => {
    setBody({
      tag: 'nav',
      classes: ['pagination-pager'],
      children: [
        { tag: 'a', attrs: { 'data-page': '1', 'aria-current': 'page' }, text: '1' },
        { tag: 'a', attrs: { 'data-page': '2' }, text: '2' },
        { tag: 'a', attrs: { 'data-page': '3' }, text: '3' },
      ],
    })
    wireCardEvents('/browse/')
    const btn = document.querySelector('[data-page="3"]') as HTMLElement
    btn.click()
    expect(track).toHaveBeenCalledWith('pagination_change', { fromPage: 1, toPage: 3 })
  })

  it('does not fire pagination_change when clicking the current page', () => {
    setBody({
      tag: 'nav',
      classes: ['pagination-pager'],
      children: [{ tag: 'a', attrs: { 'data-page': '2', 'aria-current': 'page' }, text: '2' }],
    })
    wireCardEvents('/browse/')
    ;(document.querySelector('[data-page="2"]') as HTMLElement).click()
    expect(track).not.toHaveBeenCalled()
  })

  it('fires rail_show_all_click with railType and targetPath', () => {
    setBody({
      tag: 'a',
      attrs: { 'data-rail-show-all': 'featured', 'href': '/browse/?featured=1' },
      text: 'See all',
    })
    wireCardEvents('/')
    ;(document.querySelector('[data-rail-show-all]') as HTMLElement).click()
    expect(track).toHaveBeenCalledWith('rail_show_all_click', {
      railType: 'featured',
      targetPath: '/browse/?featured=1',
    })
  })

  it('uses data-card-id when data-vt-card is missing', () => {
    setBody({
      tag: 'a',
      classes: ['nav-card', 'tutorial'],
      attrs: { 'data-card-id': 'legacy-id' },
      text: 'card',
    })
    wireCardEvents('/')
    ;(document.querySelector('.nav-card') as HTMLElement).click()
    expect(track).toHaveBeenCalledWith('card_click', expect.objectContaining({
      cardId: 'legacy-id',
    }))
  })

  it('reads cardType from data-card-type when class doesnt match tutorial/mission/group', () => {
    setBody({
      tag: 'a',
      classes: ['nav-card'],
      attrs: { 'data-vt-card': 'x', 'data-card-type': 'mission' },
      text: 'card',
    })
    wireCardEvents('/')
    ;(document.querySelector('.nav-card') as HTMLElement).click()
    expect(track).toHaveBeenCalledWith('card_click', expect.objectContaining({
      cardType: 'mission',
    }))
  })
})
