// hugo/assets/js/view-transitions.ts
//
// Progressive-enhancement view-transition layer.
//
// - bindCardClick(root): attaches a delegated click listener so clicking
//   inside a [data-vt-card] sets `view-transition-name: hero-title` on the
//   nav-card title. The matching name on the destination page's <h1> (set
//   declaratively in view-transitions.css) lets the browser morph between
//   them across the navigation.
//
// - morphTheme(applyFn): wraps a same-document state change in
//   document.startViewTransition() when available; passthrough otherwise.
//
// Self-bootstraps on import: binds the document and exposes morphTheme as
// window.__morphTheme so inline theme-toggle scripts in Hugo partials can
// call it without a module import.

import '../css/view-transitions.css'
import '../css/scroll-animations.css'

const HERO_NAME = 'hero-title'
const TITLE_SELECTOR = '.nav-card__title'

export function bindCardClick(root: ParentNode): void {
  root.addEventListener('click', (event) => {
    const target = event.target as Element | null
    if (!target) return
    const card = target.closest('[data-vt-card]') as HTMLElement | null
    if (!card) return
    const title = card.querySelector(TITLE_SELECTOR) as HTMLElement | null
    if (!title) return
    title.style.viewTransitionName = HERO_NAME
  })
}

type StartViewTransition = (cb: () => void) => unknown

export function morphTheme(applyFn: () => void): void {
  const start = (document as unknown as { startViewTransition?: StartViewTransition }).startViewTransition
  if (typeof start !== 'function') {
    applyFn()
    return
  }
  start.call(document, applyFn)
}

bindCardClick(document)
;(window as unknown as { __morphTheme?: typeof morphTheme }).__morphTheme = morphTheme
