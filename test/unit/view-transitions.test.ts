// @vitest-environment happy-dom
// test/unit/view-transitions.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function buildNavCard(): HTMLAnchorElement {
  const link = document.createElement('a')
  link.className = 'nav-card'
  link.href = '/tutorials/foo'
  link.setAttribute('data-vt-card', 'navigator')

  const title = document.createElement('h3')
  title.className = 'nav-card__title'
  title.textContent = 'Foo Tutorial'
  link.appendChild(title)
  return link
}

function buildOtherLink(): HTMLAnchorElement {
  const link = document.createElement('a')
  link.className = 'other-link'
  link.href = '/x'

  const span = document.createElement('span')
  span.className = 'other-title'
  span.textContent = 'Foo'
  link.appendChild(span)
  return link
}

// bindCardClick listens on whatever ParentNode is passed in. Tests use a fresh
// detached <div> per test so each run gets a clean listener — avoids stacking
// listeners on document across tests (the module also self-bootstraps on
// document at import time, which is fine since setting viewTransitionName is
// idempotent, but tests should not contribute extra listeners).
describe('view-transitions: bindCardClick', () => {
  let root: HTMLDivElement

  beforeEach(() => {
    root = document.createElement('div')
    document.body.appendChild(root)
  })

  afterEach(() => {
    root.remove()
  })

  it('sets view-transition-name on .nav-card__title when the nav-card link is clicked', async () => {
    const { bindCardClick } = await import('../../hugo/assets/js/view-transitions')
    root.appendChild(buildNavCard())
    bindCardClick(root)

    const title = root.querySelector('.nav-card__title') as HTMLElement
    title.click()

    expect(title.style.viewTransitionName).toBe('hero-title')
  })

  it('is a no-op when the click target is outside any [data-vt-card]', async () => {
    const { bindCardClick } = await import('../../hugo/assets/js/view-transitions')
    root.appendChild(buildOtherLink())
    bindCardClick(root)

    const title = root.querySelector('.other-title') as HTMLElement
    title.click()

    expect(title.style.viewTransitionName || '').toBe('')
  })
})

// morphTheme reads document.startViewTransition at call time. Each test sets
// up its own state and tears it down in afterEach so test order doesn't
// matter and concurrent runs (if pool: 'threads' is ever enabled) don't race.
describe('view-transitions: morphTheme', () => {
  let original: unknown

  beforeEach(() => {
    original = (document as unknown as { startViewTransition?: unknown }).startViewTransition
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
  })

  afterEach(() => {
    if (original !== undefined) {
      ;(document as unknown as { startViewTransition?: unknown }).startViewTransition = original
    } else {
      delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
    }
  })

  it('calls applyFn directly when document.startViewTransition is missing', async () => {
    const { morphTheme } = await import('../../hugo/assets/js/view-transitions')

    const applyFn = vi.fn()
    morphTheme(applyFn)

    expect(applyFn).toHaveBeenCalledOnce()
  })

  it('wraps applyFn in document.startViewTransition when available', async () => {
    const startSpy = vi.fn((cb: () => void) => {
      cb()
      return { finished: Promise.resolve(), ready: Promise.resolve(), updateCallbackDone: Promise.resolve() }
    })
    ;(document as unknown as { startViewTransition: (cb: () => void) => unknown }).startViewTransition = startSpy
    const { morphTheme } = await import('../../hugo/assets/js/view-transitions')

    const applyFn = vi.fn()
    morphTheme(applyFn)

    expect(startSpy).toHaveBeenCalledOnce()
    expect(applyFn).toHaveBeenCalledOnce()
  })
})
