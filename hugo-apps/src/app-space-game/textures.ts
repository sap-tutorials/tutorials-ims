// Procedural canvas textures for the arcade scene. Every generator degrades to a
// blank texture when a 2D context is unavailable (tests / exotic browsers).

import * as THREE from 'three'

function canvas(w: number, h: number): { cv: HTMLCanvasElement; g: CanvasRenderingContext2D | null } {
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  let g: CanvasRenderingContext2D | null = null
  try { g = cv.getContext('2d') } catch { g = null }
  return { cv, g }
}

function finish(cv: HTMLCanvasElement, opts: { repeat?: boolean; srgb?: boolean } = {}): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(cv)
  if (opts.srgb !== false) t.colorSpace = THREE.SRGBColorSpace
  if (opts.repeat) {
    t.wrapS = THREE.RepeatWrapping
    t.wrapT = THREE.RepeatWrapping
  }
  t.anisotropy = 4
  return t
}

/** Mulberry32 — deterministic texture noise so scenes look the same every load. */
export function seeded(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Earth/stone side of the ground with layered strata and pebbles. */
export function groundSideTexture(): THREE.CanvasTexture {
  const { cv, g } = canvas(256, 256)
  if (g) {
    const rnd = seeded(11)
    const grad = g.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, '#5b3b2a')
    grad.addColorStop(1, '#2a1a14')
    g.fillStyle = grad
    g.fillRect(0, 0, 256, 256)
    for (let band = 0; band < 5; band++) {
      g.fillStyle = `rgba(0,0,0,${0.08 + band * 0.03})`
      const y = 40 + band * 46
      g.beginPath()
      g.moveTo(0, y)
      for (let x = 0; x <= 256; x += 16) g.lineTo(x, y + Math.sin(x * 0.05 + band) * 5)
      g.lineTo(256, y + 18)
      g.lineTo(0, y + 18)
      g.fill()
    }
    for (let i = 0; i < 70; i++) {
      const x = rnd() * 256, y = 20 + rnd() * 236, r = 2 + rnd() * 6
      g.fillStyle = `rgba(${150 + rnd() * 60},${120 + rnd() * 50},${100 + rnd() * 40},${0.25 + rnd() * 0.3})`
      g.beginPath()
      g.ellipse(x, y, r * 1.3, r, rnd() * 3, 0, Math.PI * 2)
      g.fill()
    }
  }
  return finish(cv, { repeat: true })
}

/** Grass top strip (tileable horizontally). */
export function grassTexture(): THREE.CanvasTexture {
  const { cv, g } = canvas(256, 64)
  if (g) {
    const rnd = seeded(5)
    g.fillStyle = '#3fae4a'
    g.fillRect(0, 0, 256, 64)
    for (let i = 0; i < 260; i++) {
      const x = rnd() * 256
      g.strokeStyle = rnd() > 0.5 ? '#5fd36a' : '#2c8a37'
      g.lineWidth = 2
      g.beginPath()
      g.moveTo(x, 64)
      g.lineTo(x + (rnd() - 0.5) * 8, 64 - 10 - rnd() * 30)
      g.stroke()
    }
  }
  return finish(cv, { repeat: true })
}

/** Wooden crate face with planks, cross brace and metal corners. */
export function crateTexture(): THREE.CanvasTexture {
  const { cv, g } = canvas(256, 256)
  if (g) {
    g.fillStyle = '#b5773b'
    g.fillRect(0, 0, 256, 256)
    for (let i = 0; i < 4; i++) {
      g.fillStyle = i % 2 ? '#a96c33' : '#bf8245'
      g.fillRect(0, i * 64, 256, 62)
      g.fillStyle = 'rgba(60,30,10,0.5)'
      g.fillRect(0, i * 64 + 62, 256, 2)
    }
    g.strokeStyle = '#7a4a1e'
    g.lineWidth = 28
    g.beginPath(); g.moveTo(24, 24); g.lineTo(232, 232); g.stroke()
    g.strokeStyle = '#8f5826'
    g.lineWidth = 18
    g.beginPath(); g.moveTo(24, 24); g.lineTo(232, 232); g.stroke()
    g.strokeStyle = '#6b3f17'
    g.lineWidth = 24
    g.strokeRect(12, 12, 232, 232)
    g.fillStyle = '#9aa6b5'
    for (const [x, y] of [[0, 0], [216, 0], [0, 216], [216, 216]]) {
      g.fillRect(x, y, 40, 40)
      g.fillStyle = '#c9d3df'
      g.fillRect(x + 4, y + 4, 32, 6)
      g.fillStyle = '#5c6572'
      g.beginPath(); g.arc(x + 20, y + 22, 5, 0, Math.PI * 2); g.fill()
      g.fillStyle = '#9aa6b5'
    }
  }
  return finish(cv)
}

/** Treasure chest face: dark red-brown planks with gold trim and studs (distinct from crates). */
export function chestTexture(): THREE.CanvasTexture {
  const { cv, g } = canvas(256, 256)
  if (g) {
    for (let i = 0; i < 6; i++) {
      g.fillStyle = i % 2 ? '#6e2a17' : '#7d321c'
      g.fillRect(i * 43, 0, 43, 256)
      g.fillStyle = 'rgba(0,0,0,0.35)'
      g.fillRect(i * 43 + 41, 0, 2, 256)
    }
    const gold = g.createLinearGradient(0, 0, 0, 256)
    gold.addColorStop(0, '#ffe79a')
    gold.addColorStop(0.5, '#e0a52a')
    gold.addColorStop(1, '#a8701a')
    g.strokeStyle = gold
    g.lineWidth = 22
    g.strokeRect(11, 11, 234, 234)
    g.fillStyle = gold
    g.fillRect(0, 112, 256, 22)
    g.fillStyle = '#fff3c4'
    for (const [x, y] of [[11, 11], [245, 11], [11, 245], [245, 245], [11, 123], [245, 123]]) {
      g.beginPath(); g.arc(x, y, 6, 0, Math.PI * 2); g.fill()
    }
  }
  return finish(cv)
}

/** Yellow/black hazard stripes for spike bases and pit edges. */
export function hazardStripeTexture(): THREE.CanvasTexture {
  const { cv, g } = canvas(128, 32)
  if (g) {
    g.fillStyle = '#ffc61a'
    g.fillRect(0, 0, 128, 32)
    g.fillStyle = '#1a1a1a'
    for (let x = -32; x < 160; x += 32) {
      g.beginPath()
      g.moveTo(x, 32); g.lineTo(x + 16, 0); g.lineTo(x + 32, 0); g.lineTo(x + 16, 32)
      g.fill()
    }
  }
  return finish(cv, { repeat: true })
}

/** Skyline window grid: lit and unlit windows, used as an emissive map on buildings. */
export function windowsTexture(seed: number): THREE.CanvasTexture {
  const { cv, g } = canvas(128, 256)
  if (g) {
    const rnd = seeded(seed)
    g.fillStyle = '#000'
    g.fillRect(0, 0, 128, 256)
    for (let y = 8; y < 248; y += 16) {
      for (let x = 8; x < 120; x += 16) {
        if (rnd() < 0.3) {
          const warm = rnd() < 0.7
          g.fillStyle = warm ? `rgba(255,${200 + rnd() * 40},${120 + rnd() * 60},1)` : 'rgba(140,210,255,1)'
          g.fillRect(x, y, 9, 10)
        }
      }
    }
  }
  return finish(cv, { repeat: true })
}

/** Soft round blob — clouds, glows, sparkles, shadows. */
export function softDotTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)'): THREE.CanvasTexture {
  const { cv, g } = canvas(64, 64)
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
    grad.addColorStop(0, inner)
    grad.addColorStop(1, outer)
    g.fillStyle = grad
    g.fillRect(0, 0, 64, 64)
  }
  return finish(cv)
}

/** Four-point sparkle star. */
export function sparkleTexture(): THREE.CanvasTexture {
  const { cv, g } = canvas(64, 64)
  if (g) {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 30)
    grad.addColorStop(0, 'rgba(255,255,255,1)')
    grad.addColorStop(0.25, 'rgba(255,230,140,0.9)')
    grad.addColorStop(1, 'rgba(255,200,60,0)')
    g.fillStyle = grad
    g.beginPath()
    g.moveTo(32, 0); g.quadraticCurveTo(36, 28, 64, 32); g.quadraticCurveTo(36, 36, 32, 64)
    g.quadraticCurveTo(28, 36, 0, 32); g.quadraticCurveTo(28, 28, 32, 0)
    g.fill()
  }
  return finish(cv)
}

/** Fluffy cloud built from overlapping soft circles. */
export function cloudTexture(seed: number): THREE.CanvasTexture {
  const { cv, g } = canvas(256, 128)
  if (g) {
    const rnd = seeded(seed)
    for (let i = 0; i < 9; i++) {
      const x = 50 + rnd() * 156, y = 60 + (rnd() - 0.5) * 30, r = 26 + rnd() * 30
      const grad = g.createRadialGradient(x, y, 0, x, y, r)
      grad.addColorStop(0, 'rgba(255,255,255,0.85)')
      grad.addColorStop(1, 'rgba(255,255,255,0)')
      g.fillStyle = grad
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill()
    }
  }
  return finish(cv)
}

/** Flag cloth: zone colour with a light border and a big zone number. */
export function flagTexture(color: string, label: string, locked: boolean): THREE.CanvasTexture {
  const { cv, g } = canvas(256, 160)
  if (g) {
    g.fillStyle = locked ? '#5a5f6b' : color
    g.fillRect(0, 0, 256, 160)
    g.fillStyle = 'rgba(255,255,255,0.18)'
    for (let i = 0; i < 256; i += 32) g.fillRect(i, 0, 16, 160)
    g.strokeStyle = 'rgba(255,255,255,0.85)'
    g.lineWidth = 8
    g.strokeRect(6, 6, 244, 148)
    g.fillStyle = '#ffffff'
    g.font = 'bold 92px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(locked ? '🔒' : label, 128, 84)
  }
  return finish(cv)
}

/** Round sign face for the zone number at the start of each zone. */
export function signTexture(text: string, color: string): THREE.CanvasTexture {
  const { cv, g } = canvas(256, 256)
  if (g) {
    g.fillStyle = '#f2e3c4'
    g.beginPath(); g.arc(128, 128, 120, 0, Math.PI * 2); g.fill()
    g.lineWidth = 16
    g.strokeStyle = color
    g.stroke()
    g.fillStyle = color
    g.font = 'bold 130px system-ui, sans-serif'
    g.textAlign = 'center'
    g.textBaseline = 'middle'
    g.fillText(text, 128, 138)
  }
  return finish(cv)
}

/** Vertical sky gradient (top → horizon). */
export function skyTexture(top: string, mid: string, horizon: string): THREE.CanvasTexture {
  const { cv, g } = canvas(4, 256)
  if (g) {
    const grad = g.createLinearGradient(0, 0, 0, 256)
    grad.addColorStop(0, top)
    grad.addColorStop(0.55, mid)
    grad.addColorStop(1, horizon)
    g.fillStyle = grad
    g.fillRect(0, 0, 4, 256)
  }
  return finish(cv)
}
