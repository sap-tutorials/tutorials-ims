import { describe, it, expect, beforeAll } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../../..')
const FRAMES_PATH = path.resolve(__dirname, '../kasimir-frames.json')
const ATLAS_PATH = path.join(ROOT, 'hugo/static/images/app-space-game/kasimir-atlas.png')

interface FrameMap {
  image: string
  atlas: { w: number; h: number; cols: number; rows: number }
  cell: { w: number; h: number }
  anchor: { x: number; y: number }
  charH: number
  clips: Record<string, { frames: { x: number; y: number; w: number; h: number }[]; fps: number; loop: boolean }>
}

const fm = JSON.parse(readFileSync(FRAMES_PATH, 'utf8')) as FrameMap
const REQUIRED = ['idle', 'walk', 'trot', 'run', 'jump', 'hit', 'fall', 'ko', 'reach', 'chest', 'celebrate', 'taunt']

describe('kasimir-frames.json', () => {
  it('has every clip the game uses, with frames, fps and loop', () => {
    for (const k of REQUIRED) {
      const c = fm.clips[k]
      expect(c, k).toBeTruthy()
      expect(c.frames.length, k).toBeGreaterThan(0)
      expect(c.fps, k).toBeGreaterThan(0)
      expect(typeof c.loop, k).toBe('boolean')
    }
    expect(fm.clips.jump.frames).toHaveLength(10)
    expect(fm.clips.run.frames.length).toBeGreaterThanOrEqual(8)
  })

  it('uses a uniform grid inside the atlas, no larger than 2048px', () => {
    expect(fm.atlas.w).toBe(fm.atlas.cols * fm.cell.w)
    expect(fm.atlas.h).toBe(fm.atlas.rows * fm.cell.h)
    expect(Math.max(fm.atlas.w, fm.atlas.h)).toBeLessThanOrEqual(2048)
    for (const [name, c] of Object.entries(fm.clips)) {
      for (const f of c.frames) {
        expect(f.w, name).toBe(fm.cell.w)
        expect(f.h, name).toBe(fm.cell.h)
        expect(f.x % fm.cell.w, name).toBe(0)
        expect(f.y % fm.cell.h, name).toBe(0)
        expect(f.x + f.w).toBeLessThanOrEqual(fm.atlas.w)
        expect(f.y + f.h).toBeLessThanOrEqual(fm.atlas.h)
      }
    }
  })

  it('anchors feet at the same point of every cell, horizontally centred (mirror-safe)', () => {
    expect(fm.anchor.x).toBe(fm.cell.w / 2)
    expect(fm.anchor.y).toBeGreaterThan(fm.cell.h * 0.9)
    expect(fm.charH).toBeGreaterThan(100)
  })
})

describe('kasimir-atlas.png pixels', () => {
  type Img = { data: Buffer; width: number }
  let img: Img

  beforeAll(async () => {
    const sharp = createRequire(import.meta.url)('sharp')
    const { data, info } = await sharp(ATLAS_PATH).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    img = { data, width: info.width }
  })

  function bbox(f: { x: number; y: number; w: number; h: number }) {
    let top = Infinity, bottom = -1
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) {
        if (img.data[(y * img.width + x) * 4 + 3] > 128) {
          if (y < top) top = y
          bottom = y
        }
      }
    }
    return { top: top - f.y, bottom: bottom - f.y }
  }

  it('every frame stands on the shared baseline (no floating or sinking between clips)', () => {
    for (const [name, c] of Object.entries(fm.clips)) {
      c.frames.forEach((f, i) => {
        const { bottom } = bbox(f)
        expect(Math.abs(bottom + 1 - fm.anchor.y), `${name}[${i}]`).toBeLessThanOrEqual(3)
      })
    }
  })

  it('standing poses from both source sheets render at the same character height', () => {
    const standing = [...fm.clips.idle.frames, fm.clips.celebrate.frames[0], fm.clips.chest.frames[0]]
    const heights = standing.map(f => { const b = bbox(f); return b.bottom - b.top })
    const min = Math.min(...heights), max = Math.max(...heights)
    expect(max / min).toBeLessThan(1.3)
    for (const h of fm.clips.idle.frames.map(f => { const b = bbox(f); return b.bottom - b.top })) {
      expect(Math.abs(h - fm.charH) / fm.charH).toBeLessThan(0.05)
    }
  })
})
