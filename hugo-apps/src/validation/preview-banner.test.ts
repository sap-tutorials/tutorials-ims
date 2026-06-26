// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'

describe('preview-banner.ts', () => {
  let store: Record<string, string>

  beforeEach(() => {
    vi.resetModules()
    store = {}
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
      clear: () => { store = {} },
      get length() { return Object.keys(store).length },
      key: (i: number) => Object.keys(store)[i] ?? null,
    })
    // Build the DOM fixture with createElement (avoid innerHTML per project hook).
    while (document.body.firstChild) document.body.removeChild(document.body.firstChild)
    const banner = document.createElement('aside')
    banner.setAttribute('data-preview-banner', '')
    const resetBtn = document.createElement('ui5-button')
    resetBtn.id = 'preview-banner-reset'
    const revealSwitch = document.createElement('ui5-switch')
    revealSwitch.id = 'preview-banner-reveal-ai'
    revealSwitch.setAttribute('data-reveal-ai', '')
    banner.appendChild(resetBtn)
    banner.appendChild(revealSwitch)
    document.body.appendChild(banner)
  })

  it('Reset button: wipes tutorial-validation-__preview__-* keys + emits event', async () => {
    store['tutorial-validation-__preview__-1'] = '{}'
    store['tutorial-validation-__preview__-2'] = '{}'
    store['unrelated-key'] = 'x'
    const eventFired = new Promise<void>(resolve => {
      window.addEventListener('tutorial-preview:reset-answers', () => resolve(), { once: true })
    })
    await import('./preview-banner')
    document.getElementById('preview-banner-reset')!.dispatchEvent(new MouseEvent('click'))
    await eventFired
    expect(store['tutorial-validation-__preview__-1']).toBeUndefined()
    expect(store['tutorial-validation-__preview__-2']).toBeUndefined()
    expect(store['unrelated-key']).toBe('x')
  })

  it('Reveal toggle: emits tutorial-preview:reveal-ai-rules with on/off', async () => {
    const captured: boolean[] = []
    window.addEventListener('tutorial-preview:reveal-ai-rules', (ev) => {
      captured.push((ev as CustomEvent).detail.on)
    })
    await import('./preview-banner')
    const sw = document.getElementById('preview-banner-reveal-ai')!
    sw.dispatchEvent(new CustomEvent('change', { detail: { checked: true } }))
    sw.dispatchEvent(new CustomEvent('change', { detail: { checked: false } }))
    expect(captured).toEqual([true, false])
  })

  it('auto-reset on load: clears tutorial-validation-__preview__-* keys', async () => {
    store['tutorial-validation-__preview__-stale'] = '{"old": true}'
    await import('./preview-banner')
    expect(store['tutorial-validation-__preview__-stale']).toBeUndefined()
  })
})
