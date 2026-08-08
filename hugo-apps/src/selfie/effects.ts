// Branded one-tap effect presets for the Devtoberfest selfie composer (#1516).
// Two representations per preset: a CSS approximation for the live UI preview,
// and an authoritative Canvas-2D bake applied to the export composite. The Konva
// stage is never mutated — switching or clearing an effect just resets a ref.

export type EffectId = 'none' | 'duotone' | 'warm' | 'mono' | 'vignette' | 'joule'

export interface Effect {
  label: string
  // CSS live-preview approximation. `filter` binds to the stage element; `overlay`
  // renders as an absolutely-positioned blend layer over the photo.
  preview: {
    filter?: string
    overlay?: { background: string; blend: string; opacity: number }
  }
  // Authoritative Canvas-2D bake. Mutates and returns the SAME canvas. Individually
  // defensive (returns the input on no-context) — applyEffect adds the outer guard.
  apply: (canvas: HTMLCanvasElement) => HTMLCanvasElement
}

// Brand colors reused from the polaroid/sticker branding.
const DEVTOBERFEST_ORANGE = '#e8791a'
const DEVTOBERFEST_DARK = '#2b1a0f'
const JOULE_PINK = '#e2337f'
const JOULE_PURPLE = '#7d4bd6'

// Redraw the canvas onto itself through a CSS filter string, then reset the filter
// so any later overlay fill is not itself filtered. Standard self-composite trick.
function filterSelf(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D, filter: string): void {
  ctx.filter = filter
  ctx.drawImage(canvas, 0, 0)
  ctx.filter = 'none'
}

export const EFFECTS: Record<EffectId, Effect> = {
  none: {
    label: 'None',
    preview: {},
    apply: (canvas) => canvas,
  },
  duotone: {
    label: 'Devtoberfest',
    preview: {
      filter: 'grayscale(1)',
      overlay: { background: `linear-gradient(${DEVTOBERFEST_ORANGE}, ${DEVTOBERFEST_DARK})`, blend: 'color', opacity: 1 },
    },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      filterSelf(canvas, ctx, 'grayscale(1)')
      const g = ctx.createLinearGradient(0, 0, 0, canvas.height)
      g.addColorStop(0, DEVTOBERFEST_ORANGE)
      g.addColorStop(1, DEVTOBERFEST_DARK)
      ctx.save()
      ctx.globalCompositeOperation = 'color'
      ctx.fillStyle = g
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
      return canvas
    },
  },
  warm: {
    label: 'Warm',
    preview: { filter: 'sepia(0.35) saturate(1.4) contrast(1.05)' },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      filterSelf(canvas, ctx, 'sepia(0.35) saturate(1.4) contrast(1.05)')
      return canvas
    },
  },
  mono: {
    label: 'B&W',
    preview: { filter: 'grayscale(1)' },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      filterSelf(canvas, ctx, 'grayscale(1)')
      return canvas
    },
  },
  vignette: {
    label: 'Vignette',
    preview: { overlay: { background: 'radial-gradient(circle, transparent 55%, rgba(0,0,0,0.55) 100%)', blend: 'normal', opacity: 1 } },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      const w = canvas.width
      const h = canvas.height
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.max(w, h) * 0.75)
      g.addColorStop(0, 'rgba(0,0,0,0)')
      g.addColorStop(1, 'rgba(0,0,0,0.55)')
      ctx.fillStyle = g
      ctx.fillRect(0, 0, w, h)
      return canvas
    },
  },
  joule: {
    label: 'Joule',
    preview: { overlay: { background: `linear-gradient(135deg, ${JOULE_PINK}, ${JOULE_PURPLE})`, blend: 'soft-light', opacity: 0.5 } },
    apply: (canvas) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return canvas
      const g = ctx.createLinearGradient(0, 0, canvas.width, canvas.height)
      g.addColorStop(0, JOULE_PINK)
      g.addColorStop(1, JOULE_PURPLE)
      ctx.save()
      ctx.globalAlpha = 0.35
      ctx.fillStyle = g
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.restore()
      return canvas
    },
  },
}

// Picker order — the control renders effects in this sequence; 'none' is first.
export const EFFECT_IDS: EffectId[] = ['none', 'duotone', 'warm', 'mono', 'vignette', 'joule']

// Pure dispatcher. Returns the input canvas unchanged for 'none', an unknown id, a
// missing 2D context, or ANY thrown error inside apply(). Fail-soft.
export function applyEffect(canvas: HTMLCanvasElement, id: EffectId): HTMLCanvasElement {
  const effect = EFFECTS[id]
  if (!effect || id === 'none') return canvas
  try {
    return effect.apply(canvas)
  } catch (e) {
    console.warn('[selfie] effect failed', id, e)
    return canvas
  }
}
