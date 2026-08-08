// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { parseStickerList, EMOJI, CAPTION_PLACEHOLDER } from '../stickers'

describe('stickers data', () => {
  it('parses a CSV frame list, trimming and dropping blanks', () => {
    expect(parseStickerList(' pumpkin , confetti ,, star ')).toEqual([
      { name: 'pumpkin', file: 'pumpkin' },
      { name: 'confetti', file: 'confetti' },
      { name: 'star', file: 'star' },
    ])
  })
  it('returns an empty array for an empty string', () => {
    expect(parseStickerList('')).toEqual([])
  })
  it('ships a non-empty emoji set of single-glyph strings', () => {
    expect(EMOJI.length).toBeGreaterThan(0)
    expect(EMOJI.every((e) => typeof e === 'string' && e.length > 0)).toBe(true)
  })
  it('uses the generic Devtoberfest caption placeholder', () => {
    expect(CAPTION_PLACEHOLDER).toBe('#Devtoberfest')
  })
})
