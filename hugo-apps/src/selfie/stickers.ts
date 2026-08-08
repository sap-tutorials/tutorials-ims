export interface StickerDef {
  name: string
  file: string // basename under `${imgBase}/stickers/`; URL is `${imgBase}/stickers/${file}.png`
}

/** Split a comma-separated sticker list (from `data-stickers`), trim, drop blanks. */
export function parseStickerList(csv: string): StickerDef[] {
  return csv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((name) => ({ name, file: name }))
}

/** A fixed, fun emoji set rendered as Konva.Text glyphs (predictable across OSes). */
export const EMOJI: readonly string[] = [
  '🎃', '🎉', '⭐', '🧡', '💻', '🚀', '👋', '🙌', '🔥', '❤️', '✨', '🏆',
]

/** Generic caption seed text — no advocate-name guessing. */
export const CAPTION_PLACEHOLDER = '#Devtoberfest'
