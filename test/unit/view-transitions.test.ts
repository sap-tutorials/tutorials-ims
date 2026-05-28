// @vitest-environment happy-dom
// test/unit/view-transitions.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

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

describe('view-transitions: bindCardClick', () => {
  beforeEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
  })

  it('sets view-transition-name on .nav-card__title when the nav-card link is clicked', async () => {
    const { bindCardClick } = await import('../../hugo/assets/js/view-transitions')
    document.body.appendChild(buildNavCard())
    bindCardClick(document)

    const title = document.querySelector('.nav-card__title') as HTMLElement
    title.click()

    expect(title.style.viewTransitionName).toBe('hero-title')
  })

  it('is a no-op when the click target is outside any [data-vt-card]', async () => {
    const { bindCardClick } = await import('../../hugo/assets/js/view-transitions')
    document.body.appendChild(buildOtherLink())
    bindCardClick(document)

    const title = document.querySelector('.other-title') as HTMLElement
    title.click()

    expect(title.style.viewTransitionName).toBe('')
  })
})

describe('view-transitions: morphTheme', () => {
  it('calls applyFn directly when document.startViewTransition is missing', async () => {
    const original = (document as unknown as { startViewTransition?: unknown }).startViewTransition
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
    const { morphTheme } = await import('../../hugo/assets/js/view-transitions')

    const applyFn = vi.fn()
    morphTheme(applyFn)

    expect(applyFn).toHaveBeenCalledOnce()
    if (original) (document as unknown as { startViewTransition?: unknown }).startViewTransition = original
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
    delete (document as unknown as { startViewTransition?: unknown }).startViewTransition
  })
})
