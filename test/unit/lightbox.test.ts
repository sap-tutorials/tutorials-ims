// @vitest-environment happy-dom
// test/unit/lightbox.test.ts
//
// #1785: unit coverage for the lightbox polish — keyboard open, caption/counter,
// double-click zoom toggle, swipe decision, thumbnails, loading spinner.
//
// The module self-bootstraps (`initLightbox()`) at import, binding listeners to
// the dialog + document. We build the dialog DOM and stub the ui5 custom
// elements ONCE (beforeAll) so `customElements.whenDefined` resolves and the
// dialog persists for the whole file; per test we rebuild the page images and
// reset module state via the exported `__test__.reset()`.
import { describe, it, expect, beforeAll, beforeEach } from 'vitest'

type Lightbox = typeof import('../../hugo/assets/js/lightbox')
let lb: Lightbox

function defineStub(name: string) {
  if (!customElements.get(name)) {
    customElements.define(name, class extends HTMLElement {})
  }
}

function buildDialog() {
  document.body.innerHTML = `
    <ui5-dialog id="image-lightbox" class="lightbox-dialog">
      <div slot="header" class="lightbox-header">
        <span class="lightbox-counter" hidden></span>
        <ui5-title class="lightbox-title"></ui5-title>
        <ui5-button class="lightbox-close"></ui5-button>
      </div>
      <div class="lightbox-viewport" data-lightbox-viewport>
        <div class="lightbox-rail">
          <img class="lightbox-img lightbox-img--current" alt="">
          <img class="lightbox-img lightbox-img--incoming" alt="" hidden>
        </div>
        <ui5-busy-indicator class="lightbox-spinner" hidden></ui5-busy-indicator>
      </div>
      <div class="lightbox-thumbs" hidden></div>
      <div slot="footer" class="lightbox-footer">
        <ui5-button class="lightbox-prev"></ui5-button>
        <ui5-button class="lightbox-zoom-out"></ui5-button>
        <span class="lightbox-zoom-level" aria-live="polite">100%</span>
        <ui5-button class="lightbox-zoom-in"></ui5-button>
        <ui5-button class="lightbox-reset"></ui5-button>
        <ui5-button class="lightbox-download"></ui5-button>
        <ui5-button class="lightbox-next"></ui5-button>
      </div>
    </ui5-dialog>
    <main class="tutorial-main"></main>`
}

/** Build N zoomable images into .tutorial-main. Each entry: {alt, caption?}. */
function buildImages(specs: Array<{ alt?: string; caption?: string; src?: string }>): HTMLImageElement[] {
  const main = document.querySelector('.tutorial-main')!
  const out: HTMLImageElement[] = []
  specs.forEach((spec, i) => {
    const img = document.createElement('img')
    img.setAttribute('data-zoomable', 'true')
    img.alt = spec.alt ?? ''
    img.src = spec.src ?? `https://img.example/${i}.png`
    if (spec.caption) {
      const fig = document.createElement('figure')
      fig.className = 'tutorial-figure'
      const cap = document.createElement('figcaption')
      cap.className = 'tutorial-figcaption'
      cap.textContent = spec.caption
      fig.appendChild(img)
      fig.appendChild(cap)
      main.appendChild(fig)
    } else {
      main.appendChild(img)
    }
    out.push(img)
  })
  return out
}

beforeAll(async () => {
  // matchMedia is used by open() (mobile stretch) and reducedMotion().
  window.matchMedia = ((q: string) => ({
    matches: false,
    media: q,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    onchange: null,
    dispatchEvent() { return false },
  })) as unknown as typeof window.matchMedia
  ;['ui5-dialog', 'ui5-button', 'ui5-title', 'ui5-busy-indicator'].forEach(defineStub)
  buildDialog()
  lb = await import('../../hugo/assets/js/lightbox')
})

beforeEach(() => {
  // Fresh page images + zeroed state each test. The dialog itself persists.
  const main = document.querySelector('.tutorial-main')!
  main.innerHTML = ''
  lb.__test__.reset()
})

describe('formatCounter', () => {
  it('renders a 1-based "index / total" label', () => {
    expect(lb.__test__.formatCounter(0, 12)).toBe('1 / 12')
    expect(lb.__test__.formatCounter(2, 12)).toBe('3 / 12')
  })
})

describe('resolveSwipe', () => {
  const T = 50
  it('returns +1 (next) for a leftward swipe at scale 1', () => {
    expect(lb.__test__.resolveSwipe(-80, 5, 1, T)).toBe(1)
  })
  it('returns -1 (prev) for a rightward swipe at scale 1', () => {
    expect(lb.__test__.resolveSwipe(80, 5, 1, T)).toBe(-1)
  })
  it('ignores swipes when zoomed in (scale > 1) — that gesture pans', () => {
    expect(lb.__test__.resolveSwipe(-80, 5, 2, T)).toBe(0)
  })
  it('ignores movement below the threshold', () => {
    expect(lb.__test__.resolveSwipe(-30, 5, 1, T)).toBe(0)
  })
  it('ignores a vertically-dominant drag', () => {
    expect(lb.__test__.resolveSwipe(-80, 120, 1, T)).toBe(0)
  })
})

describe('nextZoomToggleScale', () => {
  it('toggles 1x -> 2x and anything else -> 1x', () => {
    expect(lb.__test__.nextZoomToggleScale(1)).toBe(2)
    expect(lb.__test__.nextZoomToggleScale(2)).toBe(1)
    expect(lb.__test__.nextZoomToggleScale(3.5)).toBe(1)
  })
})

describe('deriveCaption', () => {
  it('prefers the figcaption text', () => {
    const [img] = buildImages([{ alt: 'alt text', caption: 'A rich caption' }])
    expect(lb.__test__.deriveCaption(img)).toBe('A rich caption')
  })
  it('falls back to alt when there is no figcaption', () => {
    const [img] = buildImages([{ alt: 'just alt' }])
    expect(lb.__test__.deriveCaption(img)).toBe('just alt')
  })
  it('returns empty string for the placeholder alt "image"', () => {
    const [img] = buildImages([{ alt: 'image' }])
    expect(lb.__test__.deriveCaption(img)).toBe('')
  })
})

describe('open(): counter + caption', () => {
  it('shows "N / total" and reveals the counter for multi-image pages', () => {
    const imgs = buildImages([{ alt: 'a' }, { alt: 'b' }, { alt: 'c' }])
    lb.__test__.open(imgs[1])
    const counter = document.querySelector('.lightbox-counter') as HTMLElement
    expect(counter.textContent).toBe('2 / 3')
    expect(counter.hasAttribute('hidden')).toBe(false)
  })
  it('hides the counter when the page has a single image', () => {
    const imgs = buildImages([{ alt: 'solo' }])
    lb.__test__.open(imgs[0])
    const counter = document.querySelector('.lightbox-counter') as HTMLElement
    expect(counter.hasAttribute('hidden')).toBe(true)
  })
  it('uses the figcaption as the lightbox title when present', () => {
    const imgs = buildImages([{ alt: 'alt only' }, { alt: 'x', caption: 'The Caption' }])
    lb.__test__.open(imgs[1])
    const title = document.querySelector('.lightbox-title') as HTMLElement
    expect(title.textContent).toBe('The Caption')
  })
})

describe('buildThumbs', () => {
  it('creates one thumbnail per image and marks the active one', () => {
    const imgs = buildImages([{ alt: 'a' }, { alt: 'b' }, { alt: 'c' }])
    const container = document.querySelector('.lightbox-thumbs') as HTMLElement
    lb.__test__.buildThumbs(container, imgs, 1, () => {})
    const thumbs = container.querySelectorAll('.lightbox-thumb')
    expect(thumbs.length).toBe(3)
    expect(thumbs[1].classList.contains('is-active')).toBe(true)
    expect(thumbs[0].classList.contains('is-active')).toBe(false)
  })
  it('invokes onSelect with the clicked index', () => {
    const imgs = buildImages([{ alt: 'a' }, { alt: 'b' }, { alt: 'c' }])
    const container = document.querySelector('.lightbox-thumbs') as HTMLElement
    let picked = -1
    lb.__test__.buildThumbs(container, imgs, 0, (i: number) => { picked = i })
    ;(container.querySelectorAll('.lightbox-thumb')[2] as HTMLElement).click()
    expect(picked).toBe(2)
  })
})

describe('keyboard open', () => {
  it('opens the lightbox when Enter is pressed on a focused zoomable image', () => {
    const imgs = buildImages([{ alt: 'first', src: 'https://img.example/first.png' }])
    imgs[0].focus()
    imgs[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    const cur = document.querySelector('.lightbox-img--current') as HTMLImageElement
    expect(cur.src).toContain('first.png')
  })
})

describe('double-click zoom toggle', () => {
  it('toggles between 100% and 200% on the viewport', () => {
    const imgs = buildImages([{ alt: 'a' }])
    lb.__test__.open(imgs[0])
    const vp = document.querySelector('[data-lightbox-viewport]') as HTMLElement
    const label = document.querySelector('.lightbox-zoom-level') as HTMLElement
    vp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }))
    expect(label.textContent).toBe('200%')
    vp.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, clientX: 0, clientY: 0 }))
    expect(label.textContent).toBe('100%')
  })
})

describe('loading spinner', () => {
  it('shows while the image loads and hides once it fires load', () => {
    const imgs = buildImages([{ alt: 'a' }])
    lb.__test__.open(imgs[0])
    const spinner = document.querySelector('.lightbox-spinner') as HTMLElement
    expect(spinner.hasAttribute('hidden')).toBe(false)
    const cur = document.querySelector('.lightbox-img--current') as HTMLImageElement
    cur.dispatchEvent(new Event('load'))
    expect(spinner.hasAttribute('hidden')).toBe(true)
  })
})
