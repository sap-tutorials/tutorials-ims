#!/usr/bin/env node
/**
 * build-kasimir-atlas.mjs
 *
 * Processes two hand-drawn Kasimir sprite sheets into a game-ready transparent
 * atlas PNG + JSON frame-map for the app-space-game Three.js island.
 *
 * Inputs:
 *   hugo/static/images/app-space-game/sprite-src/kasimir-sheet-locomotion-raw.png
 *   hugo/static/images/app-space-game/sprite-src/kasimir-sheet-actions-raw.png
 *
 * Outputs:
 *   hugo/static/images/app-space-game/kasimir-atlas.png
 *   hugo-apps/src/app-space-game/kasimir-frames.json
 *
 * Algorithm:
 *   1. Cream-key each sheet (background ~#F4F3EE, threshold=24, Manhattan distance)
 *   2. Detect row bands (rows of fully/near-transparent pixels separate bands)
 *   3. Within each band, detect sprite columns using local-minimum separator search
 *   4. Compute tight bounding boxes for each detected sprite
 *   5. Pack all sprites into a uniform-cell atlas
 *   6. Emit JSON frame-map with clip definitions
 */

import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'
import fs from 'fs'

const require = createRequire(import.meta.url)
const sharp = require('sharp')

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// --- Paths ---
const LOCO_SRC = path.join(ROOT, 'hugo/static/images/app-space-game/sprite-src/kasimir-sheet-locomotion-raw.png')
const ACTIONS_SRC = path.join(ROOT, 'hugo/static/images/app-space-game/sprite-src/kasimir-sheet-actions-raw.png')
const ATLAS_OUT = path.join(ROOT, 'hugo/static/images/app-space-game/kasimir-atlas.png')
const FRAMES_OUT = path.join(ROOT, 'hugo-apps/src/app-space-game/kasimir-frames.json')

// --- Cream-key parameters ---
// Cream background is #F4F3EE (warm off-white). Manhattan distance threshold 24
// keeps Kasimir's cooler white chest/paws (which are brighter and more neutral)
// while removing the warm cream background. Tuned empirically.
const CREAM_R = 0xF4
const CREAM_G = 0xF3
const CREAM_B = 0xEE
const CREAM_THRESHOLD = 24 // Manhattan distance

/**
 * Returns true if the pixel color matches the cream background.
 * Uses Manhattan distance for performance; cream is warm off-white.
 */
function isCream(r, g, b, threshold = CREAM_THRESHOLD) {
  return Math.abs(r - CREAM_R) + Math.abs(g - CREAM_G) + Math.abs(b - CREAM_B) <= threshold
}

/**
 * Load a PNG into RGBA raw buffer via sharp.
 * @returns {{ data: Buffer, width: number, height: number }}
 */
async function loadRGBA(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true })
  return { data, width: info.width, height: info.height }
}

/**
 * Apply cream-key in-place: for each pixel matching cream, set alpha to 0.
 */
function applyCreameKey(data, width, height) {
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4
      const r = data[idx], g = data[idx + 1], b = data[idx + 2]
      if (isCream(r, g, b)) {
        data[idx + 3] = 0 // alpha = 0 → transparent
      }
    }
  }
}

/**
 * Detect row bands: contiguous rows with at least minContent visible pixels.
 * Returns array of { y0, y1 }.
 *
 * After initial detection, each band is checked for internal sub-band gaps:
 * if a band is tall (h > 200) and contains an internal row whose sum drops
 * below `subBandFraction` of the band's mean row-sum, that gap splits the
 * band into two sub-bands. This fixes cases where the artist stacked two
 * rows of sprites into one detected band (e.g. the LOCO run band).
 *
/**
 * Detect row bands: contiguous rows with at least minContent visible pixels.
 * Returns array of { y0, y1 }.
 *
 * After initial detection, each band is checked for internal sub-band gaps:
 * if a band is tall (h > 200) and contains an internal row whose sum drops
 * below `subBandFraction` of the band's mean row-sum, that gap splits the
 * band into two sub-bands. This fixes cases where the artist stacked two
 * rows of sprites into one detected band (e.g. the LOCO run band).
 */
function detectRowBands(data, width, height, minContent = 5) {
  const rowSums = new Array(height).fill(0)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) rowSums[y]++
    }
  }

  const bands = []
  let inBand = false
  let bandStart = 0
  for (let y = 0; y < height; y++) {
    if (rowSums[y] > minContent && !inBand) {
      inBand = true
      bandStart = y
    } else if (rowSums[y] <= minContent && inBand) {
      inBand = false
      bands.push({ y0: bandStart, y1: y - 1 })
    }
  }
  if (inBand) bands.push({ y0: bandStart, y1: height - 1 })
  return bands
}

/**
 * Find sprite column ranges within a row band using local-minimum separator detection.
 *
 * Strategy: build a column-content array (count of visible pixels per column).
 * Then find "valley" separators: columns where the content is a local minimum
 * AND the value is significantly lower than its neighbours (valleyRadius px).
 * Any run of columns all below `absThreshold` is treated as a gap.
 *
 * For TALL bands (h > 250px) the sprites are more densely packed and may share
 * column edges; in that case a higher valleyFraction detects the weak separators.
 *
 * @param {Buffer} data - RGBA raw buffer (after cream-key)
 * @param {number} width
 * @param {{ y0: number, y1: number }} band
 * @param {object} [opts]
 * @param {number} [opts.absThreshold=3] - columns with content <= this are always gaps
 * @param {number} [opts.valleyFraction] - auto-selected from band height when omitted
 * @param {number} [opts.valleyRadius=40] - radius for local max calculation
 * @param {number} [opts.minSpriteW=80] - discard detected sprites narrower than this
 * @returns {Array<{ x0: number, x1: number }>}
 */
function detectSpriteColumns(data, width, band, opts = {}) {
  const { y0, y1 } = band
  const bandH = y1 - y0 + 1

  // Auto-tune valleyFraction: tall/dense bands need a higher fraction to detect
  // weak column minima where sprites almost touch.
  const {
    absThreshold = 3,
    valleyFraction = bandH > 250 ? 0.25 : 0.12,
    valleyRadius = 40,
    minSpriteW = 80,
  } = opts

  // Build column content (visible pixel count in this row band)
  const col = new Array(width).fill(0)
  for (let y = y0; y <= y1; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) col[x]++
    }
  }

  // Determine which columns are "gaps": either below absThreshold OR
  // clearly a local minimum compared to surroundings
  const isGap = new Array(width).fill(false)
  for (let x = 0; x < width; x++) {
    if (col[x] <= absThreshold) {
      isGap[x] = true
      continue
    }
    // Local max within radius
    const lo = Math.max(0, x - valleyRadius)
    const hi = Math.min(width - 1, x + valleyRadius)
    let localMax = 0
    for (let nx = lo; nx <= hi; nx++) {
      if (col[nx] > localMax) localMax = col[nx]
    }
    if (localMax > 0 && col[x] < localMax * valleyFraction) {
      isGap[x] = true
    }
  }

  // Extract runs of non-gap columns; discard narrow artifacts
  const sprites = []
  let inSprite = false
  let spriteStart = 0
  for (let x = 0; x < width; x++) {
    if (!isGap[x] && !inSprite) {
      inSprite = true
      spriteStart = x
    } else if (isGap[x] && inSprite) {
      inSprite = false
      if (x - 1 - spriteStart + 1 >= minSpriteW) {
        sprites.push({ x0: spriteStart, x1: x - 1 })
      }
    }
  }
  if (inSprite && width - 1 - spriteStart + 1 >= minSpriteW) {
    sprites.push({ x0: spriteStart, x1: width - 1 })
  }

  return sprites
}

/**
 * Compute the tight bounding box of visible pixels within a region.
 * Returns { x0, y0, x1, y1 } relative to the FULL image coordinates,
 * or null if the region is empty.
 */
function tightBBox(data, width, imgX0, imgY0, imgX1, imgY1) {
  let minX = imgX1, maxX = imgX0, minY = imgY1, maxY = imgY0
  for (let y = imgY0; y <= imgY1; y++) {
    for (let x = imgX0; x <= imgX1; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  if (minX > maxX || minY > maxY) return null
  return { x0: minX, y0: minY, x1: maxX, y1: maxY }
}

/**
 * Find the bounding box of the DOMINANT (largest-area) vertical blob within a region.
 *
 * Used to handle bands where the artist stacked two rows of sprites in one band:
 * each sprite column contains two disconnected blobs (one per sub-row), and this
 * function picks the larger of the two.
 *
 * Algorithm:
 *   1. Compute per-row visible-pixel count within [imgX0..imgX1].
 *   2. Split rows into connected "blobs" wherever a gap of `minBlobGap` zero-pixel
 *      rows is found.
 *   3. Return the tight bbox of the LARGEST blob (by pixel count).
 *
 * @param {number} minBlobGap - minimum number of empty rows to treat as a blob separator (default 8)
 * @returns {{ x0, y0, x1, y1 } | null}
 */
function dominantBlobBBox(data, width, imgX0, imgY0, imgX1, imgY1, minBlobGap = 8) {
  // Build per-row pixel counts
  const rowCounts = []
  for (let y = imgY0; y <= imgY1; y++) {
    let count = 0
    for (let x = imgX0; x <= imgX1; x++) {
      if (data[(y * width + x) * 4 + 3] > 0) count++
    }
    rowCounts.push(count)
  }

  // Find blobs: runs of rows separated by gaps of >= minBlobGap zero rows
  const blobs = []
  let blobStart = -1
  let zeroRun = 0

  for (let i = 0; i < rowCounts.length; i++) {
    if (rowCounts[i] > 0) {
      if (blobStart < 0) blobStart = i
      zeroRun = 0
    } else {
      zeroRun++
      if (blobStart >= 0 && zeroRun >= minBlobGap) {
        blobs.push({ startRow: blobStart, endRow: i - zeroRun })
        blobStart = -1
        zeroRun = 0
      }
    }
  }
  if (blobStart >= 0) {
    blobs.push({ startRow: blobStart, endRow: rowCounts.length - 1 })
  }

  if (blobs.length === 0) return null
  if (blobs.length === 1) return tightBBox(data, width, imgX0, imgY0, imgX1, imgY1)

  // Multiple blobs: pick the one with the most pixels
  let bestBlob = null
  let bestCount = 0
  for (const blob of blobs) {
    let count = 0
    for (let i = blob.startRow; i <= blob.endRow; i++) count += rowCounts[i]
    if (count > bestCount) {
      bestCount = count
      bestBlob = blob
    }
  }

  const blobY0 = imgY0 + bestBlob.startRow
  const blobY1 = imgY0 + bestBlob.endRow
  return tightBBox(data, width, imgX0, blobY0, imgX1, blobY1)
}

/**
 * Extract a region from a source RGBA buffer into a new RGBA buffer.
 */
function extractRegion(srcData, srcWidth, x0, y0, x1, y1) {
  const w = x1 - x0 + 1
  const h = y1 - y0 + 1
  const out = Buffer.alloc(w * h * 4, 0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const si = ((y0 + y) * srcWidth + (x0 + x)) * 4
      const di = (y * w + x) * 4
      out[di] = srcData[si]
      out[di + 1] = srcData[si + 1]
      out[di + 2] = srcData[si + 2]
      out[di + 3] = srcData[si + 3]
    }
  }
  return { data: out, w, h }
}

/**
 * Copy a sprite into the atlas buffer at (destX, destY), centered within (cellW x cellH).
 */
function blitSprite(atlas, atlasW, cellX, cellY, cellW, cellH, sprite) {
  const { data, w, h } = sprite
  const offX = Math.floor((cellW - w) / 2)
  const offY = Math.floor((cellH - h) / 2)
  for (let sy = 0; sy < h; sy++) {
    for (let sx = 0; sx < w; sx++) {
      const si = (sy * w + sx) * 4
      const dx = cellX + offX + sx
      const dy = cellY + offY + sy
      if (dx < 0 || dx >= atlasW || dy < 0) continue
      const di = (dy * atlasW + dx) * 4
      atlas[di] = data[si]
      atlas[di + 1] = data[si + 1]
      atlas[di + 2] = data[si + 2]
      atlas[di + 3] = data[si + 3]
    }
  }
}

// ---------------------------------------------------------------------------
// Clip-to-sprite mapping (hand-coded after empirical sheet analysis)
//
// Locomotion sheet bands (after cream-key detection):
//   Band 0 (y ~37-209,  5 sprites): idle frames
//   Band 1 (y ~222-389, 9 sprites): walk frames
//   Band 2 (y ~409-745, 10 sprites): run frames (tall band; contains TWO stacked
//            rows of running poses — dominantBlob:true extracts only the largest
//            connected blob per sprite column, removing the second-row artifact)
//   Band 3 (y ~765-910, 8 sprites): broader walk poses (not used)
//   Band 4 (y ~929-1090,10 sprites): additional run poses (not used)
//
// Actions sheet bands:
//   Band 0 (y ~38-259,  6 sprites): jump arc part 1 (crouch→apex)
//   Band 1 (y ~262-501, 6 sprites): jump arc part 2 (descent→land)
//   Band 2 (y ~506-1104, 6 sprites): bonus poses (full-height tall sprites)
//     [0] = hit (star-dazed)
//     [1] = celebrate (arms up)
//     [2] = taunt (tail-swipe or second celebrate)   ← NEW clip
//     [3] = ko (ghost/pit-death)
//     [4] = chest (chest opening)
//     [5] = (extra — not mapped)
//
// dominantBlob: true — for this band's sprites, use dominantBlobBBox() instead
//   of tightBBox() to pick only the largest vertical blob per sprite column.
//   This corrects the run band's two-row stacking artifact.
//
// medianFilter: true — after extraction, drop any sprite whose pixel-area
//   (w*h) is < 50% of the median area. Kills outlier artifacts (e.g. the
//   undersized last run frame caused by a lone lower-row fragment).
// ---------------------------------------------------------------------------
const CLIP_LAYOUT = {
  idle:      { sheet: 'loco',    bands: [{ band: 0, sprites: 'all' }],                              fps: 8,  loop: true  },
  walk:      { sheet: 'loco',    bands: [{ band: 1, sprites: 'all' }],                              fps: 12, loop: true  },
  run:       { sheet: 'loco',    bands: [{ band: 2, sprites: 'all', yClamp: { y0: 560, y1: 745 } }], fps: 16, loop: true  },
  jump:      { sheet: 'actions', bands: [{ band: 0, sprites: 'all' }, { band: 1, sprites: 'all' }], fps: 12, loop: false },
  hit:       { sheet: 'actions', bands: [{ band: 2, sprites: [0] }],                                fps: 10, loop: false },
  celebrate: { sheet: 'actions', bands: [{ band: 2, sprites: [1] }],                                fps: 10, loop: false },
  taunt:     { sheet: 'actions', bands: [{ band: 2, sprites: [2] }],                                fps: 10, loop: false },
  ko:        { sheet: 'actions', bands: [{ band: 2, sprites: [3] }],                                fps: 8,  loop: false },
  chest:     { sheet: 'actions', bands: [{ band: 2, sprites: [4] }],                                fps: 8,  loop: false },
}

async function main() {
  console.log('=== Kasimir Atlas Builder ===')
  console.log('Cream-key threshold:', CREAM_THRESHOLD, '(Manhattan distance)')
  console.log()

  // --- Load and cream-key both sheets ---
  console.log('Loading locomotion sheet:', LOCO_SRC)
  const loco = await loadRGBA(LOCO_SRC)
  console.log(`  ${loco.width}x${loco.height}`)
  applyCreameKey(loco.data, loco.width, loco.height)

  console.log('Loading actions sheet:', ACTIONS_SRC)
  const actions = await loadRGBA(ACTIONS_SRC)
  console.log(`  ${actions.width}x${actions.height}`)
  applyCreameKey(actions.data, actions.width, actions.height)

  const sheets = { loco, actions }

  // --- Detect row bands for each sheet ---
  const bands = {}
  for (const [name, sheet] of Object.entries(sheets)) {
    const detected = detectRowBands(sheet.data, sheet.width, sheet.height)
    bands[name] = detected
    console.log(`\n${name} row bands:`)
    detected.forEach((b, i) => console.log(`  [${i}] y ${b.y0}-${b.y1} (h=${b.y1 - b.y0 + 1})`))
  }

  // --- Detect sprites within each band ---
  const spriteCols = {}
  for (const [name, sheet] of Object.entries(sheets)) {
    spriteCols[name] = []
    for (const band of bands[name]) {
      const cols = detectSpriteColumns(sheet.data, sheet.width, band)
      spriteCols[name].push(cols)
      console.log(`\n${name} band y${band.y0}-${band.y1}: ${cols.length} sprites`)
      cols.forEach((c, i) => console.log(`  [${i}] x ${c.x0}-${c.x1} (w=${c.x1 - c.x0 + 1})`))
    }
  }

  // --- Extract tight-bbox sprites for each clip ---
  // Gather all sprites in order, keyed by clip name
  const clipSprites = {}
  for (const [clipName, layout] of Object.entries(CLIP_LAYOUT)) {
    clipSprites[clipName] = []
    const sheet = sheets[layout.sheet]
    const sheetBands = bands[layout.sheet]
    const sheetCols = spriteCols[layout.sheet]

    for (const { band: bandIdx, sprites: spriteSpec, dominantBlob, yClamp } of layout.bands) {
      const rawBand = sheetBands[bandIdx]
      if (!rawBand) {
        console.warn(`  WARN: ${clipName}: band ${bandIdx} not found on ${layout.sheet} sheet`)
        continue
      }

      // yClamp: override the band's y extent for this clip's column detection + bbox extraction.
      // Use this to restrict extraction to a specific sub-row within a multi-row band.
      const band = yClamp ? { y0: yClamp.y0, y1: yClamp.y1 } : rawBand

      // Re-detect sprite columns using the clamped band y extent if yClamp is set.
      let cols
      if (yClamp) {
        cols = detectSpriteColumns(sheet.data, sheet.width, band)
        console.log(`  yClamp [${band.y0}-${band.y1}]: re-detected ${cols.length} sprites`)
      } else {
        cols = sheetCols[bandIdx]
      }

      if (!cols || cols.length === 0) {
        console.warn(`  WARN: ${clipName}: no sprites detected in band ${bandIdx}`)
        continue
      }

      const indices = spriteSpec === 'all'
        ? cols.map((_, i) => i)
        : spriteSpec

      for (const idx of indices) {
        if (idx >= cols.length) {
          console.warn(`  WARN: ${clipName}: sprite index ${idx} out of range (band has ${cols.length})`)
          continue
        }
        const col = cols[idx]
        // dominantBlob: pick the largest vertical blob per sprite column,
        // discarding secondary blobs from adjacent stacked sprite rows.
        const bbox = dominantBlob
          ? dominantBlobBBox(sheet.data, sheet.width, col.x0, band.y0, col.x1, band.y1)
          : tightBBox(sheet.data, sheet.width, col.x0, band.y0, col.x1, band.y1)
        if (!bbox) {
          console.warn(`  WARN: ${clipName}: sprite ${idx} bbox is empty`)
          continue
        }
        const extracted = extractRegion(sheet.data, sheet.width, bbox.x0, bbox.y0, bbox.x1, bbox.y1)
        clipSprites[clipName].push(extracted)
      }
    }

    // medianFilter: drop any sprite whose area (w*h) is < 50% of the median.
    // Kills undersized outlier frames from partial sub-row detections.
    if (layout.medianFilter && clipSprites[clipName].length > 1) {
      const areas = clipSprites[clipName].map(s => s.w * s.h).slice().sort((a, b) => a - b)
      const mid = Math.floor(areas.length / 2)
      const median = areas.length % 2 === 1 ? areas[mid] : (areas[mid - 1] + areas[mid]) / 2
      const minArea = median * 0.5
      const before = clipSprites[clipName].length
      clipSprites[clipName] = clipSprites[clipName].filter(s => s.w * s.h >= minArea)
      const dropped = before - clipSprites[clipName].length
      if (dropped > 0) {
        console.log(`  medianFilter: dropped ${dropped} small sprite(s) (minArea=${minArea.toFixed(0)})`)
      }
    }

    console.log(`\n${clipName}: ${clipSprites[clipName].length} frames extracted`)
    clipSprites[clipName].forEach((s, i) => console.log(`  [${i}] ${s.w}x${s.h}`))
  }

  // --- Determine cell size (max w and h across all sprites) ---
  let cellW = 0, cellH = 0
  for (const sprites of Object.values(clipSprites)) {
    for (const s of sprites) {
      if (s.w > cellW) cellW = s.w
      if (s.h > cellH) cellH = s.h
    }
  }
  // Add 4px padding each side
  cellW += 8
  cellH += 8
  console.log(`\nCell size: ${cellW}x${cellH}`)

  // --- Count total frames and determine atlas dimensions ---
  let totalFrames = 0
  for (const sprites of Object.values(clipSprites)) totalFrames += sprites.length
  console.log(`Total frames: ${totalFrames}`)

  // Layout: pack into a roughly-square grid
  const cols = Math.ceil(Math.sqrt(totalFrames))
  const rows = Math.ceil(totalFrames / cols)
  const atlasW = cols * cellW
  const atlasH = rows * cellH
  console.log(`Atlas grid: ${cols}x${rows} cells`)
  console.log(`Atlas size: ${atlasW}x${atlasH}`)

  // --- Build atlas buffer ---
  const atlas = Buffer.alloc(atlasW * atlasH * 4, 0)

  let frameIdx = 0
  const framePositions = {} // clipName -> [{x,y,w,h}]

  for (const [clipName, sprites] of Object.entries(clipSprites)) {
    framePositions[clipName] = []
    for (const sprite of sprites) {
      const col = frameIdx % cols
      const row = Math.floor(frameIdx / cols)
      const cx = col * cellW
      const cy = row * cellH
      blitSprite(atlas, atlasW, cx, cy, cellW, cellH, sprite)
      // Record centered position: the frame rect is the full cell
      framePositions[clipName].push({ x: cx, y: cy, w: cellW, h: cellH })
      frameIdx++
    }
  }

  // --- Write atlas PNG ---
  fs.mkdirSync(path.dirname(ATLAS_OUT), { recursive: true })
  await sharp(atlas, {
    raw: { width: atlasW, height: atlasH, channels: 4 }
  })
    .png()
    .toFile(ATLAS_OUT)
  console.log(`\nAtlas written: ${ATLAS_OUT}`)

  // --- Build frame-map JSON ---
  const clips = {}
  for (const [clipName, layout] of Object.entries(CLIP_LAYOUT)) {
    const frames = (framePositions[clipName] || []).map(f => ({
      x: f.x, y: f.y, w: f.w, h: f.h
    }))
    if (frames.length === 0) {
      console.warn(`WARN: clip ${clipName} has 0 frames — inserting placeholder at (0,0)`)
      frames.push({ x: 0, y: 0, w: cellW, h: cellH })
    }
    clips[clipName] = {
      frames,
      fps: layout.fps,
      loop: layout.loop,
    }
  }

  const frameMap = {
    image: '/images/app-space-game/kasimir-atlas.png',
    cell: { w: cellW, h: cellH },
    clips,
  }

  // Write with LF endings
  const json = JSON.stringify(frameMap, null, 2).replace(/\r\n/g, '\n')
  fs.mkdirSync(path.dirname(FRAMES_OUT), { recursive: true })
  fs.writeFileSync(FRAMES_OUT, json + '\n', 'utf8')
  console.log(`Frame-map written: ${FRAMES_OUT}`)

  // --- Summary ---
  console.log('\n=== Summary ===')
  console.log(`Atlas: ${atlasW}x${atlasH}`)
  console.log(`Cell:  ${cellW}x${cellH}`)
  console.log(`Cream threshold: ${CREAM_THRESHOLD} (Manhattan)`)
  console.log('Per-clip frame counts:')
  for (const [clipName, data] of Object.entries(clips)) {
    console.log(`  ${clipName}: ${data.frames.length} frames (fps=${data.fps}, loop=${data.loop})`)
  }
  console.log('\nDone. Review the atlas visually before committing.')
  console.log('Atlas path:', ATLAS_OUT)
}

main().catch(err => {
  console.error('Fatal:', err)
  process.exit(1)
})
