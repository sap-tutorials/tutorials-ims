import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const FRAMES_PATH = path.resolve(__dirname, '../kasimir-frames.json')

interface FrameRect {
  x: number
  y: number
  w: number
  h: number
}

interface ClipDef {
  frames: FrameRect[]
  fps: number
  loop: boolean
}

interface FrameMap {
  image: string
  cell: { w: number; h: number }
  clips: Record<string, ClipDef>
}

const REQUIRED_CLIPS = ['idle', 'walk', 'run', 'jump', 'hit', 'ko', 'celebrate', 'chest', 'taunt'] as const

describe('kasimir-frames.json', () => {
  let frameMap: FrameMap
  let atlasW: number
  let atlasH: number

  it('parses without error', () => {
    const raw = readFileSync(FRAMES_PATH, 'utf8')
    frameMap = JSON.parse(raw) as FrameMap
    expect(frameMap).toBeTruthy()
    expect(frameMap.image).toBeTruthy()
    expect(frameMap.cell).toBeTruthy()
    expect(frameMap.clips).toBeTruthy()
  })

  it('has required top-level fields', () => {
    expect(typeof frameMap.image).toBe('string')
    expect(frameMap.image.length).toBeGreaterThan(0)
    expect(typeof frameMap.cell.w).toBe('number')
    expect(typeof frameMap.cell.h).toBe('number')
    expect(frameMap.cell.w).toBeGreaterThan(0)
    expect(frameMap.cell.h).toBeGreaterThan(0)
  })

  it('contains all required clip keys', () => {
    for (const key of REQUIRED_CLIPS) {
      expect(frameMap.clips, `clip "${key}" must exist`).toHaveProperty(key)
    }
  })

  it('each clip has at least 1 frame', () => {
    for (const key of REQUIRED_CLIPS) {
      const clip = frameMap.clips[key]
      expect(clip.frames.length, `clip "${key}" must have ≥1 frame`).toBeGreaterThanOrEqual(1)
    }
  })

  it('each clip has fps > 0', () => {
    for (const key of REQUIRED_CLIPS) {
      const clip = frameMap.clips[key]
      expect(clip.fps, `clip "${key}" fps must be > 0`).toBeGreaterThan(0)
    }
  })

  it('each clip has a boolean loop field', () => {
    for (const key of REQUIRED_CLIPS) {
      const clip = frameMap.clips[key]
      expect(typeof clip.loop, `clip "${key}" loop must be boolean`).toBe('boolean')
    }
  })

  it('atlas dimensions can be computed from clip frame positions', () => {
    // Compute atlas bounds from frame positions + cell dimensions
    let maxX = 0
    let maxY = 0
    for (const clip of Object.values(frameMap.clips)) {
      for (const f of clip.frames) {
        const right = f.x + f.w
        const bottom = f.y + f.h
        if (right > maxX) maxX = right
        if (bottom > maxY) maxY = bottom
      }
    }
    atlasW = maxX
    atlasH = maxY
    expect(atlasW).toBeGreaterThan(0)
    expect(atlasH).toBeGreaterThan(0)
  })

  it('all frame boxes lie within atlas bounds', () => {
    for (const [name, clip] of Object.entries(frameMap.clips)) {
      for (let i = 0; i < clip.frames.length; i++) {
        const f = clip.frames[i]
        const msg = `clip "${name}" frame ${i}`
        expect(f.x, `${msg}: x >= 0`).toBeGreaterThanOrEqual(0)
        expect(f.y, `${msg}: y >= 0`).toBeGreaterThanOrEqual(0)
        expect(f.w, `${msg}: w > 0`).toBeGreaterThan(0)
        expect(f.h, `${msg}: h > 0`).toBeGreaterThan(0)
        expect(f.x + f.w, `${msg}: right edge <= atlasW`).toBeLessThanOrEqual(atlasW)
        expect(f.y + f.h, `${msg}: bottom edge <= atlasH`).toBeLessThanOrEqual(atlasH)
      }
    }
  })

  it('frame boxes are consistent with cell dimensions', () => {
    const { w: cw, h: ch } = frameMap.cell
    for (const [name, clip] of Object.entries(frameMap.clips)) {
      for (let i = 0; i < clip.frames.length; i++) {
        const f = clip.frames[i]
        const msg = `clip "${name}" frame ${i}`
        expect(f.w, `${msg}: w matches cell.w`).toBe(cw)
        expect(f.h, `${msg}: h matches cell.h`).toBe(ch)
      }
    }
  })

  it('frame x coordinates align to cell grid', () => {
    const { w: cw } = frameMap.cell
    for (const [name, clip] of Object.entries(frameMap.clips)) {
      for (let i = 0; i < clip.frames.length; i++) {
        const f = clip.frames[i]
        expect(f.x % cw, `clip "${name}" frame ${i}: x must be multiple of cell.w`).toBe(0)
      }
    }
  })

  it('frame y coordinates align to cell grid', () => {
    const { h: ch } = frameMap.cell
    for (const [name, clip] of Object.entries(frameMap.clips)) {
      for (let i = 0; i < clip.frames.length; i++) {
        const f = clip.frames[i]
        expect(f.y % ch, `clip "${name}" frame ${i}: y must be multiple of cell.h`).toBe(0)
      }
    }
  })
})
