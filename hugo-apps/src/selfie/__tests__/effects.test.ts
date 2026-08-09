// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EFFECTS, EFFECT_IDS, applyEffect, applyEffectAsync, type EffectId } from '../effects'

vi.mock('../stylize', () => ({ cartoonify: vi.fn(async (c: HTMLCanvasElement) => ({ ...c, _cartooned: true } as unknown as HTMLCanvasElement)) }))

// Spy 2D context capturing the calls each effect's apply() makes.
function makeCtx() {
  const linGrad = { addColorStop: vi.fn() }
  const radGrad = { addColorStop: vi.fn() }
  return {
    fillStyle: '' as string | CanvasGradient,
    filter: 'none',
    globalCompositeOperation: 'source-over' as GlobalCompositeOperation,
    globalAlpha: 1,
    fillRect: vi.fn(),
    drawImage: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    createLinearGradient: vi.fn(() => linGrad),
    createRadialGradient: vi.fn(() => radGrad),
    _lin: linGrad,
    _rad: radGrad,
  }
}

let ctx: ReturnType<typeof makeCtx>
let ctxIsNull = false

// A composite "canvas": width/height + a getContext returning our spy.
function composite(w = 1000, h = 1000): HTMLCanvasElement {
  return { width: w, height: h, getContext: vi.fn(() => (ctxIsNull ? null : ctx)) } as unknown as HTMLCanvasElement
}

beforeEach(() => { ctx = makeCtx(); ctxIsNull = false })

describe('effects table', () => {
  it('lists none first and exposes every preset in order', () => {
    expect(EFFECT_IDS).toEqual(['none', 'duotone', 'warm', 'mono', 'vignette', 'joule', 'cartoon'])
    expect(EFFECT_IDS[0]).toBe('none')
    for (const id of EFFECT_IDS) {
      expect(typeof EFFECTS[id].label).toBe('string')
      expect(typeof EFFECTS[id].apply).toBe('function')
    }
  })

  it('none has an empty preview and returns the input untouched', () => {
    expect(EFFECTS.none.preview).toEqual({})
    const c = composite()
    expect(EFFECTS.none.apply(c)).toBe(c)
  })
})

describe('duotone bake', () => {
  it('grayscales via a self-composite filter then color-blends an orange→dark gradient', () => {
    const c = composite()
    EFFECTS.duotone.apply(c)
    expect(ctx.drawImage).toHaveBeenCalledWith(c, 0, 0) // self-composite through the filter
    expect(ctx.createLinearGradient).toHaveBeenCalled()
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(0, '#e8791a')
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(1, '#2b1a0f')
    // color-blend used, and reset afterwards (save/restore brackets it)
    expect(ctx.save).toHaveBeenCalled()
    expect(ctx.restore).toHaveBeenCalled()
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1000, 1000)
    // filter reset so the gradient fill is not itself filtered
    expect(ctx.filter).toBe('none')
  })
})

describe('warm + mono bakes', () => {
  it('warm draws the canvas onto itself through a sepia/saturate/contrast filter, then resets', () => {
    const c = composite()
    EFFECTS.warm.apply(c)
    expect(ctx.drawImage).toHaveBeenCalledWith(c, 0, 0)
    expect(ctx.createLinearGradient).not.toHaveBeenCalled() // no overlay
    expect(ctx.filter).toBe('none')
  })

  it('mono draws the canvas onto itself through grayscale(1), then resets', () => {
    const c = composite()
    EFFECTS.mono.apply(c)
    expect(ctx.drawImage).toHaveBeenCalledWith(c, 0, 0)
    expect(ctx.filter).toBe('none')
  })
})

describe('vignette + joule bakes', () => {
  it('vignette fills a transparent→dark radial gradient over the frame', () => {
    EFFECTS.vignette.apply(composite())
    expect(ctx.createRadialGradient).toHaveBeenCalled()
    expect(ctx._rad.addColorStop).toHaveBeenCalledWith(0, 'rgba(0,0,0,0)')
    expect(ctx._rad.addColorStop).toHaveBeenCalledWith(1, 'rgba(0,0,0,0.55)')
    expect(ctx.fillRect).toHaveBeenCalledWith(0, 0, 1000, 1000)
  })

  it('joule fills a low-alpha pink→purple linear gradient (soft wash)', () => {
    EFFECTS.joule.apply(composite())
    expect(ctx.createLinearGradient).toHaveBeenCalled()
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(0, '#e2337f')
    expect(ctx._lin.addColorStop).toHaveBeenCalledWith(1, '#7d4bd6')
    expect(ctx.globalAlpha).toBe(0.35) // low-alpha soft wash, bracketed by save/restore
    expect(ctx.save).toHaveBeenCalled()
    expect(ctx.restore).toHaveBeenCalled()
  })
})

describe('applyEffect fail-soft', () => {
  it('returns the input for none', () => {
    const c = composite()
    expect(applyEffect(c, 'none')).toBe(c)
  })

  it('returns the input for an unknown id', () => {
    const c = composite()
    expect(applyEffect(c, 'bogus' as EffectId)).toBe(c)
  })

  it('returns the input when the 2D context is null (no throw)', () => {
    ctxIsNull = true
    const c = composite()
    expect(applyEffect(c, 'mono')).toBe(c)
  })

  it('catches a thrown apply() and returns the input canvas', () => {
    const c = composite()
    const spy = vi.spyOn(EFFECTS.duotone, 'apply').mockImplementation(() => { throw new Error('boom') })
    expect(applyEffect(c, 'duotone')).toBe(c)
    spy.mockRestore()
  })
})

describe('applyEffectAsync', () => {
  it('routes cartoon through cartoonify', async () => {
    const { cartoonify } = await import('../stylize')
    const c = composite()
    await applyEffectAsync(c, 'cartoon')
    expect(cartoonify).toHaveBeenCalledWith(c)
  })

  it('delegates non-cartoon ids to the sync applyEffect (none returns the input unchanged)', async () => {
    const c = composite()
    const out = await applyEffectAsync(c, 'none')
    expect(out).toBe(c) // none is a no-op in both paths
  })

  it('fail-soft: returns the input canvas when cartoonify throws', async () => {
    const { cartoonify } = await import('../stylize')
    ;(cartoonify as unknown as { mockRejectedValueOnce: (e: Error) => void }).mockRejectedValueOnce(new Error('boom'))
    const c = composite()
    expect(await applyEffectAsync(c, 'cartoon')).toBe(c)
  })
})
