/**
 * Unit tests for hugo-apps/src/related-graph/main.ts
 *
 * The mount-on-discovery logic uses window.matchMedia to pick exactly one
 * placeholder per viewport — desktop (`.kg-sidebar-desktop`, visible >960px)
 * or mobile (`.kg-sidebar-mobile`, visible ≤960px). These tests verify the
 * selection logic without booting the full Vue island.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

function makePlaceholder(cssClass?: string): HTMLElement {
  const el = document.createElement('div')
  el.setAttribute('data-vue-island', 'related-graph')
  if (cssClass) el.className = cssClass
  return el
}

describe('related-graph main.ts (mount-on-discovery)', () => {
  let originalMatchMedia: typeof window.matchMedia

  beforeEach(() => {
    document.documentElement.setAttribute('data-page-slug', 'test-tutorial')
    originalMatchMedia = window.matchMedia
    // Reset module registry between tests so each `await import(...)` re-runs the
    // top-level placeholder lookup against fresh DOM.
    vi.resetModules()
  })

  afterEach(() => {
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
    document.documentElement.removeAttribute('data-page-slug')
    window.matchMedia = originalMatchMedia
  })

  function setMatchMedia(matches: boolean) {
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })) as unknown as typeof window.matchMedia
  }

  it('mounts onto the desktop placeholder when matchMedia matches=false', async () => {
    setMatchMedia(false)
    const desktop = makePlaceholder('kg-sidebar-desktop')
    const mobile = makePlaceholder('kg-sidebar-mobile')
    document.body.appendChild(desktop)
    document.body.appendChild(mobile)

    await import('../../hugo-apps/src/related-graph/main')
    await new Promise((r) => setTimeout(r, 0))

    // Vue mounts add a data-v-app attribute or render children into the target.
    expect(desktop.hasAttribute('data-v-app') || desktop.children.length > 0).toBe(true)
    expect(mobile.hasAttribute('data-v-app')).toBe(false)
  })

  it('mounts onto the mobile placeholder when matchMedia matches=true', async () => {
    setMatchMedia(true)
    const desktop = makePlaceholder('kg-sidebar-desktop')
    const mobile = makePlaceholder('kg-sidebar-mobile')
    document.body.appendChild(desktop)
    document.body.appendChild(mobile)

    await import('../../hugo-apps/src/related-graph/main')
    await new Promise((r) => setTimeout(r, 0))

    expect(mobile.hasAttribute('data-v-app') || mobile.children.length > 0).toBe(true)
    expect(desktop.hasAttribute('data-v-app')).toBe(false)
  })

  it('falls back to a plain placeholder when neither desktop nor mobile class is present', async () => {
    setMatchMedia(false)
    const plain = makePlaceholder()
    document.body.appendChild(plain)

    await import('../../hugo-apps/src/related-graph/main')
    await new Promise((r) => setTimeout(r, 0))

    expect(plain.hasAttribute('data-v-app') || plain.children.length > 0).toBe(true)
  })

  it('mounts nothing when no placeholder exists', async () => {
    setMatchMedia(false)
    const para = document.createElement('p')
    para.textContent = 'no placeholder here'
    document.body.appendChild(para)

    // Module side-effects must not throw.
    await expect(import('../../hugo-apps/src/related-graph/main')).resolves.toBeDefined()
    await new Promise((r) => setTimeout(r, 0))

    expect(document.querySelectorAll('[data-vue-island="related-graph"]').length).toBe(0)
  })
})
