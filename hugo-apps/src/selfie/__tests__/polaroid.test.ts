// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  paintPolaroid,
  POLAROID_STYLES,
  POLAROID_STYLE_IDS,
  POLAROID_INSET_FRACTION,
  POLAROID_STRIP_FRACTION,
} from '../polaroid'

// A spy 2D context capturing the calls paintPolaroid makes.
function makeCtx() {
  const grad = { addColorStop: vi.fn() }
  return {
    fillStyle: '' as string | CanvasGradient,
    font: '',
    textAlign: '' as CanvasTextAlign,
    textBaseline: '' as CanvasTextBaseline,
    fillRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    createLinearGradient: vi.fn(() => grad),
    measureText: vi.fn((t: string) => ({ width: t.length * 10 })),
    _grad: grad,
  }
}

// Build a composite "canvas": a plain object with width/height and a
// getContext returning our spy. paintPolaroid allocates its OUTPUT canvas via
// document.createElement('canvas'); we stub that to return a controllable node.
let outCtx: ReturnType<typeof makeCtx>
let outCanvas: any
let ctxIsNull = false

beforeEach(() => {
  outCtx = makeCtx()
  ctxIsNull = false
  outCanvas = { width: 0, height: 0, getContext: vi.fn(() => (ctxIsNull ? null : outCtx)) }
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    if (tag === 'canvas') return outCanvas as unknown as HTMLElement
    return {} as HTMLElement
  })
})

function composite(w: number, h: number): HTMLCanvasElement {
  return { width: w, height: h } as unknown as HTMLCanvasElement
}

describe('polaroid style table', () => {
  it('exposes exactly the three styles in order', () => {
    expect(POLAROID_STYLE_IDS).toEqual(['classic', 'devtoberfest', 'joule'])
    expect(POLAROID_STYLES.classic.matte).toEqual({ kind: 'solid', color: '#ffffff' })
    expect(POLAROID_STYLES.devtoberfest.matte).toEqual({ kind: 'solid', color: '#2b1a0f' })
    expect(POLAROID_STYLES.joule.matte).toEqual({ kind: 'gradient', from: '#e2337f', to: '#7d4bd6' })
    expect(POLAROID_INSET_FRACTION).toBe(0.05)
    expect(POLAROID_STRIP_FRACTION).toBe(0.22)
  })
})

describe('paintPolaroid geometry', () => {
  it('grows the canvas: W = cw + 2*inset, H = ch + inset + strip', () => {
    // cw=ch=1000 → m=1000, inset=round(50)=50, strip=round(220)=220
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: '' })
    expect(outCanvas.width).toBe(1100)  // 1000 + 2*50
    expect(outCanvas.height).toBe(1270) // 1000 + 50 + 220
  })

  it('draws the composite 1:1 at (inset, inset) with no scale args', () => {
    const c = composite(1000, 1000)
    paintPolaroid(c, { style: 'classic', name: '' })
    expect(outCtx.drawImage).toHaveBeenCalledWith(c, 50, 50)
  })

  it('uses the shorter edge for proportions on a non-square composite', () => {
    // cw=800, ch=1200 → m=800, inset=40, strip=176
    paintPolaroid(composite(800, 1200), { style: 'classic', name: '' })
    expect(outCanvas.width).toBe(880)   // 800 + 2*40
    expect(outCanvas.height).toBe(1416) // 1200 + 40 + 176
    expect(outCtx.drawImage).toHaveBeenCalledWith(expect.anything(), 40, 40)
  })
})

describe('paintPolaroid matte', () => {
  it('solid style fills a solid rect (no gradient)', () => {
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: '' })
    expect(outCtx.createLinearGradient).not.toHaveBeenCalled()
    expect(outCtx.fillRect).toHaveBeenCalledWith(0, 0, 1100, 1270)
  })

  it('gradient style builds a vertical top→bottom gradient with both stops', () => {
    paintPolaroid(composite(1000, 1000), { style: 'joule', name: '' })
    expect(outCtx.createLinearGradient).toHaveBeenCalledWith(0, 0, 0, 1270)
    expect(outCtx._grad.addColorStop).toHaveBeenCalledWith(0, '#e2337f')
    expect(outCtx._grad.addColorStop).toHaveBeenCalledWith(1, '#7d4bd6')
  })
})

describe('paintPolaroid text', () => {
  it('draws the name, hashtag and lockup when a name is given', () => {
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: 'Tom' })
    const texts = outCtx.fillText.mock.calls.map((c) => c[0])
    expect(texts).toContain('Tom')
    expect(texts).toContain('#Devtoberfest')
    expect(texts).toContain('SAP Developers')
  })

  it('omits the name line when the name is blank, but still draws hashtag + lockup', () => {
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: '   ' })
    const texts = outCtx.fillText.mock.calls.map((c) => c[0])
    expect(texts).not.toContain('   ')
    expect(texts).toContain('#Devtoberfest')
    expect(texts).toContain('SAP Developers')
  })

  it('truncates a long name with an ellipsis so it fits the strip', () => {
    const long = 'X'.repeat(500)
    paintPolaroid(composite(1000, 1000), { style: 'classic', name: long })
    const drawn = outCtx.fillText.mock.calls.map((c) => c[0] as string).find((t) => t.startsWith('X'))
    expect(drawn).toBeDefined()
    expect(drawn!.length).toBeLessThan(long.length)
    expect(drawn!.endsWith('…')).toBe(true)
  })
})

describe('paintPolaroid fail-soft', () => {
  it('returns the original composite unchanged when the 2D context is null', () => {
    ctxIsNull = true
    const c = composite(1000, 1000)
    const out = paintPolaroid(c, { style: 'classic', name: 'Tom' })
    expect(out).toBe(c)
  })
})
