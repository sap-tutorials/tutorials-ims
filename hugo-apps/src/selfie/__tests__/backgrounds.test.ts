import { describe, it, expect } from 'vitest'
import { BACKGROUNDS, BACKGROUND_IDS, backgroundUrl, type BackgroundDef } from '../backgrounds'

describe('backgrounds module', () => {
  it('lists none first in the picker order, then every scene', () => {
    expect(BACKGROUND_IDS[0]).toBe('none')
    expect(BACKGROUND_IDS.slice(1)).toEqual(BACKGROUNDS.map((b) => b.id))
  })

  it('every scene has a non-empty id, label and file', () => {
    for (const b of BACKGROUNDS as BackgroundDef[]) {
      expect(b.id).toBeTruthy()
      expect(b.label).toBeTruthy()
      expect(b.file).toBeTruthy()
    }
  })

  it('ships the five themed scenes', () => {
    expect(BACKGROUNDS.map((b) => b.id)).toEqual([
      'key-visual-josh', 'key-visual-nora', 'terminal', 'speaker-backdrop-1', 'speaker-backdrop-2',
    ])
  })

  it('builds a per-scene PNG url under the backgrounds/ folder', () => {
    expect(backgroundUrl('/images/devtoberfest/selfie', 'key-visual-option-josh-16-9'))
      .toBe('/images/devtoberfest/selfie/backgrounds/key-visual-option-josh-16-9.png')
  })
})
