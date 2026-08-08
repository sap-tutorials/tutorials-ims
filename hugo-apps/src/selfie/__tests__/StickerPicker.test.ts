// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import StickerPicker from '../StickerPicker.vue'
import { EMOJI } from '../stickers'

const stickers = [{ name: 'pumpkin', file: 'pumpkin' }, { name: 'star', file: 'star' }]
const base = { stickers, imgBase: '/images/devtoberfest/selfie' }

describe('StickerPicker', () => {
  it('renders a brand thumbnail per sticker and emits add-sticker with the resolved src', async () => {
    const w = mount(StickerPicker, { props: base })
    const thumbs = w.findAll('.sticker-thumb')
    expect(thumbs).toHaveLength(2)
    expect(w.findAll('.sticker-thumb img')[0].attributes('src'))
      .toBe('/images/devtoberfest/selfie/stickers/pumpkin.png')
    await thumbs[0].trigger('click')
    expect(w.emitted('add-sticker')![0]).toEqual(['/images/devtoberfest/selfie/stickers/pumpkin.png'])
  })

  it('switches to the Emoji tab and emits add-emoji with the glyph', async () => {
    const w = mount(StickerPicker, { props: base })
    await w.find('[data-testid="tab-emoji"]').trigger('click')
    const emoji = w.findAll('.emoji-btn')
    expect(emoji).toHaveLength(EMOJI.length)
    await emoji[0].trigger('click')
    expect(w.emitted('add-emoji')![0]).toEqual([EMOJI[0]])
  })

  it('shows a fallback message when there are no stickers', () => {
    const w = mount(StickerPicker, { props: { stickers: [], imgBase: base.imgBase } })
    expect(w.text()).toContain('No stickers')
  })
})
