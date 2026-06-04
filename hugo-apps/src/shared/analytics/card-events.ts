// hugo-apps/src/shared/analytics/card-events.ts
//
// Document-level click delegation that fires:
//   - card_click on .nav-card clicks (resolves source from rails container,
//     position from sibling index, cardType from class or data-card-type,
//     cardId from data-vt-card or data-card-id)
//   - pagination_change on [data-page] clicks (when toPage != fromPage)
//   - rail_show_all_click on [data-rail-show-all] anchors
//
// Also writes the "last click" hand-off to sessionStorage so PR 3's
// referred-view.ts can read fromSurface + fromCardId on tutorial-page mount.
//
// Spec: docs/superpowers/specs/2026-06-04-ab-instrumentation-design.md (#204)

import { track } from './tracker'

let wired = false
let clickHandler: ((ev: MouseEvent) => void) | null = null

export function wireCardEvents(surface: string) {
  if (wired) return
  wired = true

  clickHandler = (ev: MouseEvent) => {
    const target = ev.target as HTMLElement | null
    if (!target) return

    // 1. Card click
    const cardEl = target.closest('.nav-card') as HTMLElement | null
    if (cardEl) {
      const railEl = cardEl.closest('[data-rails-container]') as HTMLElement | null
      const source: 'grid' | 'featured-rail' | 'recent-rail' = railEl
        ? (railEl.dataset.railsContainer === 'featured' ? 'featured-rail' : 'recent-rail')
        : 'grid'

      const cardId = cardEl.dataset.vtCard ?? cardEl.dataset.cardId ?? ''

      const cardType: 'mission' | 'group' | 'tutorial' = (cardEl.dataset.cardType as any)
        ?? (cardEl.classList.contains('tutorial') ? 'tutorial'
          : cardEl.classList.contains('mission') ? 'mission'
          : 'group')

      const siblings = cardEl.parentElement?.querySelectorAll('.nav-card')
      const position = siblings ? Array.from(siblings).indexOf(cardEl) : 0

      track('card_click', { cardType, cardId, position, source })

      // Cross-PR hand-off — PR 3's referred-view.ts reads this on tutorial-page mount.
      try {
        sessionStorage.setItem('analytics.lastClick', JSON.stringify({
          fromSurface: surface,
          fromCardId: cardId,
          ts: Date.now(),
        }))
      } catch { /* sessionStorage may be disabled */ }
      return
    }

    // 2. Pagination
    const pageBtn = target.closest('[data-page]') as HTMLElement | null
    if (pageBtn) {
      const toPage = Number(pageBtn.dataset.page)
      const fromPageEl = document.querySelector('.pagination-pager [aria-current="page"]') as HTMLElement | null
      const fromPage = fromPageEl ? Number(fromPageEl.dataset.page) : 1
      if (!Number.isNaN(toPage) && toPage !== fromPage) {
        track('pagination_change', { fromPage, toPage })
      }
      return
    }

    // 3. Rail show-all
    const showAll = target.closest('[data-rail-show-all]') as HTMLAnchorElement | null
    if (showAll) {
      const railType = showAll.dataset.railShowAll === 'featured' ? 'featured' : 'recent'
      track('rail_show_all_click', {
        railType,
        targetPath: showAll.getAttribute('href') ?? '',
      })
      return
    }
  }

  document.addEventListener('click', clickHandler)
}

export function _resetForTests() {
  if (clickHandler) {
    document.removeEventListener('click', clickHandler)
    clickHandler = null
  }
  wired = false
}
