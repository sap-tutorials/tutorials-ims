// Branded polaroid matte for the Devtoberfest selfie composer (#1518).
// Pure Canvas-2D: draws a matte border + the inset composite + a text strip
// onto a larger offscreen canvas. The Konva stage is never touched.

export type PolaroidStyleId = 'classic' | 'devtoberfest' | 'joule'

export interface PolaroidStyle {
  id: PolaroidStyleId
  label: string
  matte:
    | { kind: 'solid'; color: string }
    | { kind: 'gradient'; from: string; to: string }
  textColor: string
  hashtagColor: string
}

export interface PaintPolaroidOpts {
  style: PolaroidStyleId
  name: string
}

// Side + top inset and bottom-strip height, as fractions of the composite's
// shorter edge. Shared verbatim with the CSS preview matte (styles.css).
export const POLAROID_INSET_FRACTION = 0.05
export const POLAROID_STRIP_FRACTION = 0.22

// The hashtag + lockup copy, drawn into every matte.
const HASHTAG = '#Devtoberfest'
const LOCKUP = 'SAP Developers'

export const POLAROID_STYLES: Record<PolaroidStyleId, PolaroidStyle> = {
  classic: {
    id: 'classic', label: 'Classic White',
    matte: { kind: 'solid', color: '#ffffff' },
    textColor: '#1d2d3e', hashtagColor: '#0070f2',
  },
  devtoberfest: {
    id: 'devtoberfest', label: 'Devtoberfest',
    matte: { kind: 'solid', color: '#2b1a0f' },
    textColor: '#f5e6d3', hashtagColor: '#e8791a',
  },
  joule: {
    id: 'joule', label: 'Joule',
    matte: { kind: 'gradient', from: '#e2337f', to: '#7d4bd6' },
    textColor: '#ffffff', hashtagColor: '#ffffff',
  },
}

// Picker order — the control renders styles in this sequence.
export const POLAROID_STYLE_IDS: PolaroidStyleId[] = ['classic', 'devtoberfest', 'joule']

// Shrink text to fit maxWidth, appending an ellipsis. Returns '' for blank
// input. Uses ctx.measureText so it respects the actual font metrics.
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  const t = text.trim()
  if (!t) return ''
  if (ctx.measureText(t).width <= maxWidth) return t
  let s = t
  while (s.length > 0 && ctx.measureText(s + '…').width > maxWidth) {
    s = s.slice(0, -1)
  }
  return s.length > 0 ? s + '…' : '…'
}

export function paintPolaroid(composite: HTMLCanvasElement, opts: PaintPolaroidOpts): HTMLCanvasElement {
  const cw = composite.width
  const ch = composite.height
  const m = Math.min(cw, ch)
  const inset = Math.round(POLAROID_INSET_FRACTION * m)
  const strip = Math.round(POLAROID_STRIP_FRACTION * m)
  const W = cw + 2 * inset
  const H = ch + inset + strip

  const out = document.createElement('canvas')
  out.width = W
  out.height = H
  const ctx = out.getContext('2d')
  // Fail-soft: no 2D context → hand back the untouched composite (border skipped).
  if (!ctx) return composite

  const style = POLAROID_STYLES[opts.style] ?? POLAROID_STYLES.classic

  // 1. Matte fill over the whole output.
  if (style.matte.kind === 'gradient') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, style.matte.from)
    g.addColorStop(1, style.matte.to)
    ctx.fillStyle = g
  } else {
    ctx.fillStyle = style.matte.color
  }
  ctx.fillRect(0, 0, W, H)

  // 2. Composite drawn 1:1 (no scale args) — photo pixels preserved (AC #6).
  ctx.drawImage(composite, inset, inset)

  // 3. Bottom strip text. Sizes are fractions of the strip height.
  const stripTop = ch + inset
  const nameSize = Math.round(strip * 0.30)
  const metaSize = Math.round(strip * 0.24)
  const avail = W - 2 * inset

  // Name (bold) in the upper third of the strip — omitted if blank.
  ctx.textBaseline = 'alphabetic'
  ctx.font = `bold ${nameSize}px sans-serif`
  const name = fitText(ctx, opts.name, avail)
  if (name) {
    ctx.fillStyle = style.textColor
    ctx.textAlign = 'left'
    ctx.fillText(name, inset, stripTop + nameSize + Math.round(strip * 0.06))
  }

  // Hashtag (accent) on the lower baseline, left. Lockup (bold) right-aligned.
  const metaBaseline = stripTop + strip - Math.round(strip * 0.22)
  ctx.font = `bold ${metaSize}px sans-serif`
  ctx.fillStyle = style.hashtagColor
  ctx.textAlign = 'left'
  ctx.fillText(HASHTAG, inset, metaBaseline)

  ctx.fillStyle = style.textColor
  ctx.textAlign = 'right'
  ctx.fillText(LOCKUP, W - inset, metaBaseline)

  return out
}
