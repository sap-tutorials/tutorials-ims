// hugo-apps/src/browse/foryou.ts
//
// "Recommended for you" rail orchestration (issue #202).
//
// Path: /build/my-progress → /api/recommendations?slug=<lastCompleted>.
// On success, populate the SSR'd-but-hidden rail placeholder with up to 6
// cards drawn from the inlined catalog (via slug lookup) so card markup is
// byte-identical to /browse/'s normal SSR'd cards. Removes the [hidden]
// attribute when ≥1 card renders.
//
// This module is DOM-vanilla on purpose. Mounting a second Vue app inside
// BrowsePage's grid would entangle two reactive trees on the same page; the
// for-you rail's lifecycle is fire-and-forget (no re-renders, no per-user
// state in the store), so straight DOM cloning is the simplest correct path
// AND guarantees byte-parity with the SSR'd cards (because we are literally
// re-using SSR'd cards from #browse-root).

import type { CardItem } from '@shared/types'

export interface MyProgressResponse {
  authenticated?: boolean
  tutorials?: {
    completedSlugs?: string[]
    lastCompletedSlug?: string | null
    inProgress?: Array<{ slug: string; progressPercent: number }>
  }
}

export interface RecommendationsResponse {
  currentSlug?: string
  personalized?: boolean
  recommendations?: Array<{
    slug: string
    title?: string
    primaryTag?: string
    time?: number
    score?: number
  }>
  reason?: string
}

export interface ForYouOrchestratorDeps {
  fetchProgress: () => Promise<MyProgressResponse | null>
  fetchRecommendations: (slug: string, limit: number) => Promise<RecommendationsResponse | null>
  catalog: CardItem[]
  railEl: HTMLElement | null
  cardsEl: HTMLElement | null
  // Optional impression hook — exposed for tests and for a future analytics
  // tie-in (#204). Production wiring currently leaves this unset; the rail's
  // card_click events already flow through wireCardEvents.
  onImpression?: (slugs: string[]) => void
}

const MAX_CARDS = 6

/**
 * Drive the "Recommended for you" rail end to end.
 *
 * - Returns silently (no-op) when:
 *   - placeholder elements absent (defensive)
 *   - user is anonymous OR has zero completions
 *   - the recommendations call returns no candidates
 *   - any network step fails (best-effort; rail just stays hidden)
 *
 * - On success, copies the SSR'd card markup for each recommended slug from
 *   the page's existing grid (#browse-root), or — for slugs not in the first
 *   page — synthesizes a minimal card from the catalog. Removes [hidden] from
 *   the rail.
 */
export async function activateForYouRail(deps: ForYouOrchestratorDeps): Promise<void> {
  const { railEl, cardsEl } = deps
  if (!railEl || !cardsEl) return

  const progress = await safe(() => deps.fetchProgress())
  const lastSlug = progress?.tutorials?.lastCompletedSlug
  if (!progress?.authenticated || !lastSlug) return

  const recs = await safe(() => deps.fetchRecommendations(lastSlug, MAX_CARDS))
  const slugs = (recs?.recommendations || []).map(r => r.slug).filter(Boolean)
  if (slugs.length === 0) return

  const populatedSlugs = renderCards(slugs, deps.catalog, cardsEl)
  if (populatedSlugs.length === 0) return

  railEl.removeAttribute('hidden')

  if (deps.onImpression) {
    try { deps.onImpression(populatedSlugs) } catch { /* tracker errors must never break the page */ }
  }
}

function renderCards(slugs: string[], catalog: CardItem[], target: HTMLElement): string[] {
  // /api/recommendations only returns tutorial slugs (recommend.js iterates
  // Tutorials only). Match against catalog items whose href is /tutorials/<slug>.
  const byTutorialSlug = new Map<string, CardItem>()
  for (const c of catalog) {
    if (c.type !== 'tutorial' || !c.href) continue
    const m = c.href.match(/^\/tutorials\/([^/]+)\/?$/)
    if (m) byTutorialSlug.set(m[1], c)
  }

  const populated: string[] = []

  // Strategy: clone existing SSR'd card from #browse-root when available
  // (guarantees byte-parity); fall back to a minimal hand-built card for
  // catalog items that aren't in the first SSR'd page (page 2+).
  const browseRoot = typeof document !== 'undefined' ? document.getElementById('browse-root') : null

  for (const slug of slugs) {
    const item = byTutorialSlug.get(slug)
    if (!item) continue

    let cardNode: HTMLElement | null = null
    if (browseRoot) {
      const existing = browseRoot.querySelector<HTMLAnchorElement>(`a.nav-card[href$="${cssEscape(item.href)}"]`)
      if (existing) cardNode = existing.cloneNode(true) as HTMLElement
    }
    if (!cardNode) cardNode = buildMinimalCard(item)
    if (!cardNode) continue

    target.appendChild(cardNode)
    populated.push(slug)
  }

  return populated
}

function buildMinimalCard(item: CardItem): HTMLElement | null {
  if (!item.href || !item.title) return null
  const a = document.createElement('a')
  a.href = item.href
  a.className = `nav-card${item.isNew ? ' nav-card--new' : ''}`
  a.setAttribute('data-vt-card', 'navigator')

  const type = document.createElement('div')
  type.className = `nav-card__type nav-card__type--${item.type || 'tutorial'}`
  type.textContent = (item.type || 'tutorial').toUpperCase()
  a.appendChild(type)

  const h3 = document.createElement('h3')
  h3.className = 'nav-card__title'
  h3.textContent = item.title
  a.appendChild(h3)

  if (item.description) {
    const p = document.createElement('p')
    p.className = 'nav-card__desc'
    p.textContent = item.description
    a.appendChild(p)
  }

  if (item.primaryTag) {
    const tag = document.createElement('div')
    tag.className = 'nav-card__tag'
    tag.textContent = item.primaryTag
    a.appendChild(tag)
  }

  return a
}

// Lightweight CSS.escape polyfill scoped to attribute-selector usage above.
// Card hrefs in the catalog are normal URL paths so we mostly need to neutralize
// quote / bracket characters that would break the [href$="..."] selector.
function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') return CSS.escape(value)
  return value.replace(/["\\\]]/g, '\\$&')
}

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try { return await fn() } catch { return null }
}
