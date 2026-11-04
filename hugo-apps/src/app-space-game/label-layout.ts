// Label layout and sizing logic for floating text sprites.
// Pure module: string/number math only, NO canvas/DOM access.
// The renderer owns the real THREE.CanvasTexture; it reads these sizes and draws the lines.

const FONT_SIZE = 40
const CHAR_WIDTH_EM = 0.55 // average character width at this font size, in em units
const PADDING_PX = 16 // padding on left/right of the text
const WORLD_W_CAP = 4.2 // just under the 4.5 coin pitch, prevents label overlap

export interface FitLabelResult {
  lines: string[] // 1 or 2 lines
  canvasW: number // px, sized to the longest line at the fixed font + padding
  canvasH: number // px, sized to the line count
  worldW: number // three.js sprite world width, CAPPED so it never exceeds coin pitch + padding
  worldH: number // world height, proportional to canvasH
}

/**
 * Wrap text into at most 2 lines on word boundaries.
 * If still longer than maxChars total, ellipsize with …
 * Size canvasW/canvasH from longest line length and line count at the fixed font.
 * worldW is capped at WORLD_W_CAP so neighbors never overlap horizontally;
 * worldH is scaled proportionally from canvas aspect.
 * Empty string returns a valid non-zero result, never divides by zero.
 */
export function fitLabel(text: string, opts?: { maxChars?: number }): FitLabelResult {
  const maxChars = opts?.maxChars ?? 28

  // Handle empty string
  if (!text || text.trim().length === 0) {
    return {
      lines: [''],
      canvasW: PADDING_PX * 2 + 10, // minimal non-zero width
      canvasH: 60, // one line height
      worldW: 1,
      worldH: 1,
    }
  }

  // Try single line first
  if (text.length <= maxChars) {
    const lineWidth = text.length * FONT_SIZE * CHAR_WIDTH_EM
    const canvasW = Math.ceil(lineWidth + PADDING_PX * 2)
    const canvasH = 60 // single line
    const aspectRatio = canvasW / canvasH
    const worldW = Math.min(aspectRatio * 1, WORLD_W_CAP)

    return {
      lines: [text],
      canvasW,
      canvasH,
      worldW,
      worldH: 1,
    }
  }

  // Need to wrap into 2 lines
  const words = text.split(/\s+/)
  let line1 = ''
  let line2 = ''
  let currentLine = line1
  let isFirstLine = true

  for (const word of words) {
    const testLine = currentLine ? currentLine + ' ' + word : word

    // If adding this word exceeds maxChars for a single line, try moving to line 2
    if (testLine.length > maxChars && currentLine) {
      if (isFirstLine) {
        line1 = currentLine
        currentLine = word
        isFirstLine = false
      } else {
        currentLine += ' ' + word
      }
    } else {
      currentLine += (currentLine ? ' ' : '') + word
    }
  }

  if (isFirstLine) {
    line1 = currentLine
  } else {
    line2 = currentLine
  }

  // Check if we still exceed total maxChars; ellipsize if needed
  const totalLen = line1.length + line2.length
  if (totalLen > maxChars) {
    // Ellipsize the second line
    const availableInLine2 = maxChars - line1.length - 1 // -1 for ellipsis
    if (availableInLine2 > 0) {
      line2 = line2.substring(0, availableInLine2) + '…'
    } else {
      line1 = line1.substring(0, maxChars - 1) + '…'
      line2 = ''
    }
  }

  const lines = line2 ? [line1, line2] : [line1]

  // Size canvas from longest line
  const longestLine = lines.reduce((a, b) => a.length > b.length ? a : b, '')
  const lineWidth = longestLine.length * FONT_SIZE * CHAR_WIDTH_EM
  const canvasW = Math.ceil(lineWidth + PADDING_PX * 2)
  const canvasH = lines.length * 30 + PADDING_PX // ~30px per line + padding

  // Scale world size, capped at WORLD_W_CAP
  const aspectRatio = canvasW / canvasH
  const worldW = Math.min(aspectRatio * 1, WORLD_W_CAP)
  const worldH = (canvasH / canvasW) * worldW

  return {
    lines,
    canvasW,
    canvasH,
    worldW,
    worldH,
  }
}

/**
 * Return Y coordinate for coin labels, staggered by coin index.
 * Even indices: baseY + 0.4
 * Odd indices: baseY - 0.4
 * This gives vertical separation of 0.8 between consecutive coins.
 */
export function coinLabelY(baseY: number, coinIndex: number): number {
  return coinIndex % 2 === 0 ? baseY + 0.4 : baseY - 0.4
}
