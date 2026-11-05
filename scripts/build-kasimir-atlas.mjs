#!/usr/bin/env node
/**
 * build-kasimir-atlas.mjs
 *
 * Turns the two hand-drawn Kasimir sprite sheets into a game-ready atlas PNG +
 * JSON frame-map for the app-space-game Three.js island.
 *
 * Inputs (raw art, not committed — ask the DevRel team for the source sheets):
 *   hugo/static/images/app-space-game/sprite-src/kasimir-sheet-locomotion-raw.png
 *   hugo/static/images/app-space-game/sprite-src/kasimir-sheet-actions-raw.png
 *
 * Outputs:
 *   hugo/static/images/app-space-game/kasimir-atlas.png
 *   hugo-apps/src/app-space-game/kasimir-frames.json
 *
 * Algorithm:
 *   1. Key out the cream paper background (distance from the sampled paper colour).
 *   2. Label 8-connected ink components; attach small effect blobs (sparkles,
 *      motion lines) to the nearest sprite; split sprites that touch a neighbour.
 *   3. Cluster sprites into sheet rows by vertical centre, sort each row by x.
 *   4. Fill enclosed holes (Kasimir's white chest is close to the paper colour).
 *   5. Normalise scale: the actions sheet is drawn larger than the locomotion
 *      sheet, so it is rescaled so a standing Kasimir has the same height in both.
 *   6. Anchor every frame at its feet (bottom of ink, body centroid) and pack
 *      into uniform cells whose anchor sits at the same point in every cell, so
 *      switching clips never makes Kasimir jump, shrink or slide.
 *
 * Usage: node scripts/build-kasimir-atlas.mjs
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const SRC_DIR = path.join(ROOT, 'hugo/static/images/app-space-game/sprite-src')
const SHEETS = {
  loco: path.join(SRC_DIR, 'kasimir-sheet-locomotion-raw.png'),
  actions: path.join(SRC_DIR, 'kasimir-sheet-actions-raw.png'),
}
const ATLAS_OUT = path.join(ROOT, 'hugo/static/images/app-space-game/kasimir-atlas.png')
const FRAMES_OUT = path.join(ROOT, 'hugo-apps/src/app-space-game/kasimir-frames.json')
const ATLAS_URL = '/images/app-space-game/kasimir-atlas.png'

const INK_THRESHOLD = 30 // Manhattan distance from paper colour that counts as ink
const SOFT_LO = 8 // edge feather: below this distance → fully transparent
const MIN_SPRITE_AREA = 2500
const EFFECT_ATTACH_PX = 30
const ROW_GAP = 55 // min vertical-centre gap between sheet rows
const MAX_ATLAS_DIM = 2048
const CELL_PAD = 4

// Expected sprite count per sheet row — the build fails loudly if the art changes.
const EXPECTED_ROWS = {
  loco: [5, 9, 9, 10, 8, 10],
  actions: [6, 6, 6, 6, 6],
}

// Clip → source frames. Row/frame indices are into EXPECTED_ROWS.
// Locomotion: 0 idle · 1 walk · 2 trot · 3 jump (crouch→rise→apex→fall→land) · 4 gallop · 5 alt walk
// Actions:    0 swipe · 1 dizzy/flail/pounce/lie/sneak/dizzy-stand · 2 back-view reach (x5) + stand
//             3 stretch/crawl/sleepy/KO/sleep/ghost · 4 chest push (x2) + stand + celebrate (x2) + stand
const CLIPS = {
  idle: { sheet: 'loco', row: 0, fps: 6, loop: true },
  walk: { sheet: 'loco', row: 1, fps: 12, loop: true },
  trot: { sheet: 'loco', row: 2, fps: 14, loop: true },
  jump: { sheet: 'loco', row: 3, fps: 12, loop: false },
  run: { sheet: 'loco', row: 4, fps: 14, loop: true },
  taunt: { sheet: 'actions', row: 0, frames: [0, 1, 2, 3, 4, 5], fps: 10, loop: false },
  hit: { sheet: 'actions', row: 1, frames: [0, 5], fps: 4, loop: false },
  fall: { sheet: 'actions', row: 1, frames: [1], fps: 1, loop: false },
  reach: { sheet: 'actions', row: 2, frames: [0, 1, 2, 3, 4], fps: 8, loop: true },
  ko: { sheet: 'actions', row: 3, frames: [3], fps: 1, loop: false },
  chest: { sheet: 'actions', row: 4, frames: [0, 1], fps: 4, loop: true },
  celebrate: { sheet: 'actions', row: 4, frames: [3, 4], fps: 5, loop: true },
}
// Standing poses used to measure each sheet's drawing scale.
const SCALE_REFS = {
  loco: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]],
  actions: [[2, 5], [4, 2], [4, 5]],
}

async function loadRGBA(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

function median(arr) {
  const s = [...arr].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

function paperColour({ data, width }) {
  const rs = [], gs = [], bs = []
  for (let y = 0; y < 10; y++) {
    for (let x = 0; x < width; x += 7) {
      const i = (y * width + x) * 4
      rs.push(data[i]); gs.push(data[i + 1]); bs.push(data[i + 2])
    }
  }
  return [median(rs), median(gs), median(bs)]
}

function distanceMap({ data, width, height }, bg) {
  const d = new Float32Array(width * height)
  for (let p = 0; p < width * height; p++) {
    const i = p * 4
    d[p] = Math.abs(data[i] - bg[0]) + Math.abs(data[i + 1] - bg[1]) + Math.abs(data[i + 2] - bg[2])
  }
  return d
}

function labelComponents(ink, width, height) {
  const labels = new Int32Array(width * height)
  const comps = []
  const stack = new Int32Array(width * height)
  let next = 0
  for (let p = 0; p < width * height; p++) {
    if (!ink[p] || labels[p]) continue
    next++
    const c = { id: next, x0: width, y0: height, x1: 0, y1: 0, area: 0, sx: 0, sy: 0 }
    let sp = 0
    stack[sp++] = p
    labels[p] = next
    while (sp) {
      const q = stack[--sp]
      const x = q % width, y = (q / width) | 0
      c.area++; c.sx += x; c.sy += y
      if (x < c.x0) c.x0 = x
      if (y < c.y0) c.y0 = y
      if (x + 1 > c.x1) c.x1 = x + 1
      if (y + 1 > c.y1) c.y1 = y + 1
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy
        if (ny < 0 || ny >= height) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx
          if (nx < 0 || nx >= width) continue
          const n = ny * width + nx
          if (ink[n] && !labels[n]) { labels[n] = next; stack[sp++] = n }
        }
      }
    }
    comps.push(c)
  }
  return { labels, comps }
}

/** Group components into sprites: big ones seed sprites, small effects attach to the nearest. */
function buildSprites(comps) {
  const big = comps.filter(c => c.area >= MIN_SPRITE_AREA)
  const sprites = big.map(c => ({
    ids: new Set([c.id]), x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1,
    xMin: -Infinity, xMax: Infinity, area: c.area, sx: c.sx, sy: c.sy,
  }))
  for (const c of comps) {
    if (c.area >= MIN_SPRITE_AREA || c.area < 20) continue
    const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2
    let best = null, bestD = Infinity
    for (const s of sprites) {
      const dx = Math.max(s.x0 - cx, 0, cx - s.x1)
      const dy = Math.max(s.y0 - cy, 0, cy - s.y1)
      const d = Math.hypot(dx, dy)
      if (d < bestD) { bestD = d; best = s }
    }
    if (best && bestD <= EFFECT_ATTACH_PX) {
      best.ids.add(c.id)
      best.x0 = Math.min(best.x0, c.x0); best.y0 = Math.min(best.y0, c.y0)
      best.x1 = Math.max(best.x1, c.x1); best.y1 = Math.max(best.y1, c.y1)
    }
  }
  return sprites
}

function clusterRows(sprites) {
  const sorted = [...sprites].sort((a, b) => (a.sy / a.area) - (b.sy / b.area))
  const rows = []
  for (const s of sorted) {
    const cy = s.sy / s.area
    const last = rows[rows.length - 1]
    if (last && cy - last.cy <= ROW_GAP) {
      last.items.push(s)
      last.cy = last.items.reduce((acc, it) => acc + it.sy / it.area, 0) / last.items.length
    } else {
      rows.push({ cy, items: [s] })
    }
  }
  return rows.map(r => r.items.sort((a, b) => a.x0 - b.x0))
}

/** Split sprites that are much wider than their row-mates at the emptiest ink column. */
function splitMerged(row, ink, labels, width) {
  const widths = row.map(s => s.x1 - s.x0)
  const typical = median(widths)
  const out = []
  for (const s of row) {
    const w = s.x1 - s.x0
    if (w < typical * 1.6) { out.push(s); continue }
    let bestX = -1, bestInk = Infinity
    for (let x = s.x0 + Math.floor(w * 0.3); x < s.x0 + Math.ceil(w * 0.7); x++) {
      let n = 0
      for (let y = s.y0; y < s.y1; y++) {
        const p = y * width + x
        if (ink[p] && s.ids.has(labels[p])) n++
      }
      if (n < bestInk) { bestInk = n; bestX = x }
    }
    const left = { ...s, ids: s.ids, x1: bestX, xMax: bestX }
    const right = { ...s, ids: s.ids, x0: bestX, xMin: bestX }
    out.push(tighten(left, ink, labels, width), tighten(right, ink, labels, width))
  }
  return out
}

function tighten(s, ink, labels, width) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, area = 0, sx = 0, sy = 0
  for (let y = s.y0; y < s.y1; y++) {
    for (let x = Math.max(s.x0, s.xMin); x < Math.min(s.x1, s.xMax); x++) {
      const p = y * width + x
      if (!ink[p] || !s.ids.has(labels[p])) continue
      area++; sx += x; sy += y
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
    }
  }
  return { ...s, x0, y0, x1, y1, area, sx, sy }
}

/**
 * Cut one sprite out of its sheet as RGBA with transparent background.
 * Enclosed paper-coloured regions (white chest, paws) are filled opaque.
 */
function extractSprite(sheet, dist, ink, labels, s) {
  const pad = 2
  const x0 = Math.max(0, s.x0 - pad), y0 = Math.max(0, s.y0 - pad)
  const x1 = Math.min(sheet.width, s.x1 + pad), y1 = Math.min(sheet.height, s.y1 + pad)
  const w = x1 - x0, h = y1 - y0
  const member = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = x0 + x, gy = y0 + y
      if (gx < s.xMin || gx >= s.xMax) continue
      const p = gy * sheet.width + gx
      if (ink[p] && s.ids.has(labels[p])) member[y * w + x] = 1
    }
  }
  // Flood the outside from the crop border; anything unreached and not ink is an enclosed hole.
  const outside = new Uint8Array(w * h)
  const stack = []
  const push = (x, y) => {
    const q = y * w + x
    if (!member[q] && !outside[q]) { outside[q] = 1; stack.push(q) }
  }
  for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1) }
  for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y) }
  while (stack.length) {
    const q = stack.pop()
    const x = q % w, y = (q / w) | 0
    if (x > 0) push(x - 1, y)
    if (x < w - 1) push(x + 1, y)
    if (y > 0) push(x, y - 1)
    if (y < h - 1) push(x, y + 1)
  }
  const rgba = Buffer.alloc(w * h * 4)
  let ax = 0, an = 0, footY = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = y * w + x
      const p = (y0 + y) * sheet.width + (x0 + x)
      const si = p * 4, di = q * 4
      let a
      if (!outside[q]) {
        a = 255
      } else {
        // Feather the outer edge only next to the sprite, so stray paper texture stays clear.
        let near = false
        for (let dy = -1; dy <= 1 && !near; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx, ny = y + dy
            if (nx >= 0 && ny >= 0 && nx < w && ny < h && !outside[ny * w + nx]) { near = true; break }
          }
        }
        a = near ? Math.round(Math.max(0, Math.min(1, (dist[p] - SOFT_LO) / (INK_THRESHOLD - SOFT_LO))) * 255) : 0
      }
      rgba[di] = sheet.data[si]; rgba[di + 1] = sheet.data[si + 1]; rgba[di + 2] = sheet.data[si + 2]; rgba[di + 3] = a
      if (a === 255) {
        ax += x; an++
        if (y > footY) footY = y
      }
    }
  }
  return { rgba, w, h, anchorX: ax / an, anchorY: footY + 1 }
}

async function scaleSprite(sp, k) {
  if (Math.abs(k - 1) < 1e-3) return sp
  const w = Math.max(1, Math.round(sp.w * k)), h = Math.max(1, Math.round(sp.h * k))
  const rgba = await sharp(sp.rgba, { raw: { width: sp.w, height: sp.h, channels: 4 } })
    .resize(w, h, { kernel: 'lanczos3' })
    .raw()
    .toBuffer()
  return { rgba, w, h, anchorX: sp.anchorX * k, anchorY: sp.anchorY * k }
}

async function processSheet(name) {
  const sheet = await loadRGBA(SHEETS[name])
  const bg = paperColour(sheet)
  const dist = distanceMap(sheet, bg)
  const ink = new Uint8Array(dist.length)
  for (let p = 0; p < dist.length; p++) ink[p] = dist[p] > INK_THRESHOLD ? 1 : 0
  const { labels, comps } = labelComponents(ink, sheet.width, sheet.height)
  const rows = clusterRows(buildSprites(comps)).map(r => splitMerged(r, ink, labels, sheet.width))
  const counts = rows.map(r => r.length)
  console.log(`${name}: paper rgb(${bg.join(',')}), rows ${JSON.stringify(counts)}`)
  if (JSON.stringify(counts) !== JSON.stringify(EXPECTED_ROWS[name])) {
    throw new Error(`${name}: expected rows ${JSON.stringify(EXPECTED_ROWS[name])}, got ${JSON.stringify(counts)}`)
  }
  return rows.map(r => r.map(s => extractSprite(sheet, dist, ink, labels, s)))
}

async function main() {
  for (const f of Object.values(SHEETS)) {
    if (!fs.existsSync(f)) throw new Error(`missing source sheet: ${f}`)
  }
  const sheets = { loco: await processSheet('loco'), actions: await processSheet('actions') }

  const refH = {}
  for (const [name, refs] of Object.entries(SCALE_REFS)) {
    refH[name] = median(refs.map(([r, i]) => sheets[name][r][i].anchorY))
  }
  const sheetScale = { loco: 1, actions: refH.loco / refH.actions }
  console.log(`standing height: loco ${refH.loco.toFixed(0)}px, actions ${refH.actions.toFixed(0)}px → actions ×${sheetScale.actions.toFixed(3)}`)

  // Gather clip frames at sheet-normalised scale.
  const clipFrames = {}
  for (const [clip, def] of Object.entries(CLIPS)) {
    const row = sheets[def.sheet][def.row]
    const idx = def.frames ?? row.map((_, i) => i)
    clipFrames[clip] = await Promise.all(idx.map(i => scaleSprite(row[i], sheetScale[def.sheet])))
  }

  // Uniform cell: symmetric around the anchor horizontally (so a UV mirror keeps the
  // feet in place), feet on a shared baseline vertically.
  const measure = () => {
    let half = 0, up = 0
    for (const frames of Object.values(clipFrames)) {
      for (const f of frames) {
        half = Math.max(half, f.anchorX, f.w - f.anchorX)
        up = Math.max(up, f.anchorY)
      }
    }
    return { cellW: Math.ceil(half * 2) + CELL_PAD * 2, cellH: Math.ceil(up) + CELL_PAD * 2 }
  }
  const total = Object.values(clipFrames).reduce((n, f) => n + f.length, 0)
  let { cellW, cellH } = measure()
  let cols = Math.max(1, Math.round(Math.sqrt((total * cellH) / cellW)))
  let rowsN = Math.ceil(total / cols)
  const fit = Math.min(1, MAX_ATLAS_DIM / (cols * cellW), MAX_ATLAS_DIM / (rowsN * cellH))
  if (fit < 1) {
    console.log(`downscaling all frames ×${fit.toFixed(3)} to fit ${MAX_ATLAS_DIM}px`)
    for (const clip of Object.keys(clipFrames)) {
      clipFrames[clip] = await Promise.all(clipFrames[clip].map(f => scaleSprite(f, fit)))
    }
    ;({ cellW, cellH } = measure())
    cols = Math.max(1, Math.floor(MAX_ATLAS_DIM / cellW))
    rowsN = Math.ceil(total / cols)
  }
  const atlasW = cols * cellW, atlasH = rowsN * cellH
  const anchor = { x: cellW / 2, y: cellH - CELL_PAD }
  console.log(`cell ${cellW}x${cellH}, grid ${cols}x${rowsN}, atlas ${atlasW}x${atlasH}, ${total} frames`)

  const composites = []
  const clipsOut = {}
  let n = 0
  for (const [clip, frames] of Object.entries(clipFrames)) {
    clipsOut[clip] = { frames: [], fps: CLIPS[clip].fps, loop: CLIPS[clip].loop }
    for (const f of frames) {
      const cx = (n % cols) * cellW, cy = Math.floor(n / cols) * cellH
      const left = Math.round(cx + anchor.x - f.anchorX)
      const top = Math.round(cy + anchor.y - f.anchorY)
      composites.push({ input: f.rgba, raw: { width: f.w, height: f.h, channels: 4 }, left, top })
      clipsOut[clip].frames.push({ x: cx, y: cy, w: cellW, h: cellH })
      n++
    }
  }

  fs.mkdirSync(path.dirname(ATLAS_OUT), { recursive: true })
  await sharp({ create: { width: atlasW, height: atlasH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite(composites)
    .png({ compressionLevel: 9, palette: true, quality: 95, effort: 10 })
    .toFile(ATLAS_OUT)

  const charH = Math.round(refH.loco * fit)
  const frameMap = {
    image: ATLAS_URL,
    atlas: { w: atlasW, h: atlasH, cols, rows: rowsN },
    cell: { w: cellW, h: cellH },
    anchor,
    charH,
    clips: clipsOut,
  }
  fs.writeFileSync(FRAMES_OUT, JSON.stringify(frameMap, null, 2) + '\n')
  const kb = (fs.statSync(ATLAS_OUT).size / 1024).toFixed(0)
  console.log(`wrote ${path.relative(ROOT, ATLAS_OUT)} (${kb} KB) and ${path.relative(ROOT, FRAMES_OUT)}`)
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
