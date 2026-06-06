// hugo-apps/src/browse/__tests__/foryou.test.ts
//
// @vitest-environment happy-dom
//
// Unit tests for the "Recommended for you" rail orchestration (issue #202).
// We exercise activateForYouRail() against stubbed fetch deps and a hand-built
// DOM fragment, asserting on:
//
//   - bail-out paths (anonymous, no completions, no recommendations, missing
//     placeholder, fetch errors) leave the rail [hidden]
//   - happy path renders cards, removes [hidden], fires onImpression
//   - cards are cloned from #browse-root when present (byte-parity with
//     SSR'd grid markup)
//   - cards fall back to a minimal hand-built node when the slug is past
//     the first SSR'd page

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { activateForYouRail } from '../foryou'
import type { CardItem } from '@shared/types'

function clearBody() {
  while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
}

function setupDom() {
  clearBody()
  const rail = document.createElement('section')
  rail.setAttribute('data-rail-for-you', '')
  rail.setAttribute('hidden', '')
  const cards = document.createElement('div')
  cards.setAttribute('data-rail-for-you-cards', '')
  rail.appendChild(cards)
  document.body.appendChild(rail)
  return { rail, cards }
}

function makeCatalog(slugs: string[]): CardItem[] {
  return slugs.map((slug, i) => ({
    type: 'tutorial',
    id: `t-${i}`,
    title: `Tutorial ${slug}`,
    description: `Desc for ${slug}`,
    time: 30,
    level: 'beginner',
    tutorialCount: 0,
    primaryTag: 'sap-cap',
    displayTags: [],
    displayTagSlugs: [],
    href: `/tutorials/${slug}`,
    stepCount: 5,
  } as CardItem))
}

function buildSsrCard(slug: string): HTMLElement {
  const a = document.createElement('a')
  a.href = `/tutorials/${slug}`
  a.className = 'nav-card'
  a.setAttribute('data-vt-card', 'navigator')
  a.setAttribute('data-test-ssr-origin', '1') // marker so we can verify clone
  const title = document.createElement('h3')
  title.className = 'nav-card__title'
  title.textContent = `SSR Tutorial ${slug}`
  a.appendChild(title)
  return a
}

function setupBrowseRoot(slugs: string[]) {
  const root = document.createElement('div')
  root.id = 'browse-root'
  for (const slug of slugs) root.appendChild(buildSsrCard(slug))
  document.body.appendChild(root)
  return root
}

describe('activateForYouRail', () => {
  beforeEach(() => {
    clearBody()
  })

  it('is a no-op when placeholder elements are missing', async () => {
    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { lastCompletedSlug: 'foo', completedSlugs: ['foo'] },
    })
    const fetchRecommendations = vi.fn()

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: [],
      railEl: null,
      cardsEl: null,
    })

    expect(fetchProgress).not.toHaveBeenCalled()
    expect(fetchRecommendations).not.toHaveBeenCalled()
  })

  it('stays hidden for anonymous users', async () => {
    const { rail, cards } = setupDom()
    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: false,
      tutorials: { completedSlugs: [], lastCompletedSlug: null },
    })
    const fetchRecommendations = vi.fn()

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['a']),
      railEl: rail,
      cardsEl: cards,
    })

    expect(rail.hasAttribute('hidden')).toBe(true)
    expect(fetchRecommendations).not.toHaveBeenCalled()
    expect(cards.children).toHaveLength(0)
  })

  it('stays hidden when authenticated user has no completions', async () => {
    const { rail, cards } = setupDom()
    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { completedSlugs: [], lastCompletedSlug: null },
    })
    const fetchRecommendations = vi.fn()

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['a']),
      railEl: rail,
      cardsEl: cards,
    })

    expect(rail.hasAttribute('hidden')).toBe(true)
    expect(fetchRecommendations).not.toHaveBeenCalled()
  })

  it('stays hidden when recommendations endpoint returns no candidates', async () => {
    const { rail, cards } = setupDom()
    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { completedSlugs: ['anchor'], lastCompletedSlug: 'anchor' },
    })
    const fetchRecommendations = vi.fn().mockResolvedValue({
      currentSlug: 'anchor',
      recommendations: [],
    })

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['a', 'b']),
      railEl: rail,
      cardsEl: cards,
    })

    expect(rail.hasAttribute('hidden')).toBe(true)
    expect(fetchRecommendations).toHaveBeenCalledTimes(1)
    expect(fetchRecommendations).toHaveBeenCalledWith('anchor', 6)
  })

  it('stays hidden when fetchProgress throws', async () => {
    const { rail, cards } = setupDom()
    const fetchProgress = vi.fn().mockRejectedValue(new Error('network'))
    const fetchRecommendations = vi.fn()

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['a']),
      railEl: rail,
      cardsEl: cards,
    })

    expect(rail.hasAttribute('hidden')).toBe(true)
    expect(fetchRecommendations).not.toHaveBeenCalled()
  })

  it('stays hidden when recommended slugs are not in catalog', async () => {
    const { rail, cards } = setupDom()
    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { completedSlugs: ['anchor'], lastCompletedSlug: 'anchor' },
    })
    const fetchRecommendations = vi.fn().mockResolvedValue({
      currentSlug: 'anchor',
      recommendations: [{ slug: 'unknown-slug' }],
    })

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['a', 'b']),
      railEl: rail,
      cardsEl: cards,
    })

    expect(rail.hasAttribute('hidden')).toBe(true)
    expect(cards.children).toHaveLength(0)
  })

  it('renders cards by cloning SSR cards from #browse-root when available', async () => {
    setupBrowseRoot(['rec-1', 'rec-2'])
    const { rail, cards } = setupDom()
    // setupDom clears body so re-add the browse-root
    setupBrowseRoot(['rec-1', 'rec-2'])

    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { completedSlugs: ['anchor'], lastCompletedSlug: 'anchor' },
    })
    const fetchRecommendations = vi.fn().mockResolvedValue({
      currentSlug: 'anchor',
      recommendations: [{ slug: 'rec-1' }, { slug: 'rec-2' }],
    })

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['rec-1', 'rec-2']),
      railEl: rail,
      cardsEl: cards,
    })

    expect(rail.hasAttribute('hidden')).toBe(false)
    expect(cards.children).toHaveLength(2)
    const rendered = Array.from(cards.children) as HTMLElement[]
    expect(rendered.every(el => el.getAttribute('data-test-ssr-origin') === '1')).toBe(true)
    const titles = rendered.map(el => el.querySelector('.nav-card__title')?.textContent)
    expect(titles).toEqual(['SSR Tutorial rec-1', 'SSR Tutorial rec-2'])
  })

  it('falls back to a minimal hand-built card when slug is not in the SSR grid', async () => {
    const { rail, cards } = setupDom()
    setupBrowseRoot(['only-on-page-1'])

    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { completedSlugs: ['anchor'], lastCompletedSlug: 'anchor' },
    })
    const fetchRecommendations = vi.fn().mockResolvedValue({
      currentSlug: 'anchor',
      recommendations: [{ slug: 'page-2-slug' }],
    })

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['only-on-page-1', 'page-2-slug']),
      railEl: rail,
      cardsEl: cards,
    })

    expect(rail.hasAttribute('hidden')).toBe(false)
    expect(cards.children).toHaveLength(1)
    const card = cards.firstElementChild as HTMLAnchorElement
    expect(card.tagName).toBe('A')
    expect(card.getAttribute('href')).toBe('/tutorials/page-2-slug')
    expect(card.classList.contains('nav-card')).toBe(true)
    // Marker is absent — confirms we built it ourselves rather than cloning.
    expect(card.getAttribute('data-test-ssr-origin')).toBeNull()
  })

  it('fires onImpression with the rendered slug list', async () => {
    const { rail, cards } = setupDom()
    setupBrowseRoot(['rec-1'])
    const onImpression = vi.fn()

    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { completedSlugs: ['anchor'], lastCompletedSlug: 'anchor' },
    })
    const fetchRecommendations = vi.fn().mockResolvedValue({
      currentSlug: 'anchor',
      recommendations: [{ slug: 'rec-1' }, { slug: 'unknown-not-in-catalog' }],
    })

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: makeCatalog(['rec-1']),
      railEl: rail,
      cardsEl: cards,
      onImpression,
    })

    expect(onImpression).toHaveBeenCalledTimes(1)
    expect(onImpression).toHaveBeenCalledWith(['rec-1'])
  })

  it('requests up to 6 recommendations from the API', async () => {
    const { rail, cards } = setupDom()
    const fetchProgress = vi.fn().mockResolvedValue({
      authenticated: true,
      tutorials: { completedSlugs: ['anchor'], lastCompletedSlug: 'anchor' },
    })
    const fetchRecommendations = vi.fn().mockResolvedValue({
      currentSlug: 'anchor',
      recommendations: [],
    })

    await activateForYouRail({
      fetchProgress,
      fetchRecommendations,
      catalog: [],
      railEl: rail,
      cardsEl: cards,
    })

    expect(fetchRecommendations).toHaveBeenCalledWith('anchor', 6)
  })
})
