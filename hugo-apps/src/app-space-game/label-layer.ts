// DOM overlay for readable labels. World anchors are projected to screen each frame;
// text is real HTML (crisp at any DPR, wraps with CSS) instead of canvas sprites.

import * as THREE from 'three'
import type { WorldLayout } from './layout'
import { zoneColor } from './level-model'
import { labelModes, stackRects, tidyTitle } from './labels'
import type { LabelMode } from './labels'
import { KASIMIR_H } from './constants'

const COIN_LABEL_Y = 3.4  // above Kasimir's head so titles never cover him
const GOAL_LABEL_Y = { track: 6.1, chest: 3.9 }
const TOP_SAFE_PX = 76    // keep clear of the HUD row (zone banner, rings, close)
const EDGE_PX = 8

interface Item {
  el: HTMLDivElement
  x: number
  y: number
  mode: LabelMode | 'goal'
  w: number
  h: number
}

function el(cls: string, text?: string): HTMLDivElement {
  const d = document.createElement('div')
  d.className = cls
  if (text !== undefined) d.textContent = text
  return d
}

export class LabelLayer {
  private root: HTMLDivElement
  private coins: Item[] = []
  private goals: Item[] = []
  private v = new THREE.Vector3()

  constructor(host: HTMLElement, private layout: WorldLayout) {
    this.root = el('asg-labels')
    this.root.setAttribute('aria-hidden', 'true')
    host.appendChild(this.root)

    layout.coins.forEach(c => {
      const item = el('asg-label is-hidden')
      if (!c.available) item.classList.add('is-locked')
      else if (c.done) item.classList.add('is-done')
      const badge = el('asg-label__badge', c.done ? '✓' : String(c.index + 1))
      const title = el('asg-label__title', tidyTitle(c.title))
      item.append(badge, title)
      this.root.appendChild(item)
      this.coins.push({ el: item, x: c.x, y: COIN_LABEL_Y, mode: 'hidden', w: 0, h: 0 })
    })

    layout.zones.forEach((z, i) => {
      const g = z.goal
      const item = el('asg-goal is-hidden')
      item.style.setProperty('--asg-accent', zoneColor(z.colorIndex))
      const icon = g.locked ? '🔒' : g.kind === 'track' ? '🏁' : '🎁'
      const head = el('asg-goal__head', `${icon} ${i + 1}. ${tidyTitle(z.title, 60)}`)
      const sub = el(
        'asg-goal__sub',
        g.locked ? 'Locked — complete the prerequisites first' : g.kind === 'track' ? 'Open this track' : tidyTitle(g.label, 60),
      )
      if (g.locked) item.classList.add('is-locked')
      item.append(head, sub)
      this.root.appendChild(item)
      this.goals.push({ el: item, x: g.x, y: g.kind === 'track' ? GOAL_LABEL_Y.track : GOAL_LABEL_Y.chest, mode: 'hidden', w: 0, h: 0 })
    })
  }

  private toScreen(x: number, y: number, camera: THREE.Camera, w: number, h: number): { sx: number; sy: number; front: boolean } {
    this.v.set(x, y, 0).project(camera)
    return { sx: (this.v.x * 0.5 + 0.5) * w, sy: (-this.v.y * 0.5 + 0.5) * h, front: this.v.z < 1 }
  }

  private setMode(it: Item, mode: Item['mode']): void {
    if (it.mode === mode) return
    it.mode = mode
    it.el.classList.toggle('is-hidden', mode === 'hidden')
    it.el.classList.toggle('is-full', mode === 'full' || mode === 'goal')
    it.el.classList.toggle('is-badge', mode === 'badge')
    it.w = it.el.offsetWidth
    it.h = it.el.offsetHeight
  }

  update(camera: THREE.PerspectiveCamera, camX: number, kasX: number, kasY: number, width: number, height: number): void {
    const viewHalfW = Math.tan((camera.fov * Math.PI) / 360) * camera.position.z * camera.aspect + 2
    const modes = labelModes(this.coins.map(c => c.x), kasX, camX, viewHalfW)
    const visible: Array<{ it: Item; sx: number; sy: number }> = []
    // Keep cards fully on screen and below the HUD row before resolving overlaps.
    const push = (it: Item) => {
      const p = this.toScreen(it.x, it.y, camera, width, height)
      const halfW = it.w / 2
      visible.push({
        it,
        sx: Math.min(width - halfW - EDGE_PX, Math.max(halfW + EDGE_PX, p.sx)),
        sy: Math.max(it.h + TOP_SAFE_PX, p.sy),
      })
    }
    this.coins.forEach((it, i) => {
      this.setMode(it, modes[i])
      if (modes[i] !== 'hidden') push(it)
    })
    for (const it of this.goals) {
      const show = Math.abs(it.x - camX) <= viewHalfW
      this.setMode(it, show ? 'goal' : 'hidden')
      if (show) push(it)
    }
    // Only full titles and goal cards are big enough to collide; badges stay on their coin.
    // Place goal cards first, then coin titles nearest Kasimir. A coin title that would have
    // to climb into the HUD row falls back to its badge instead of overlapping.
    const prio = (v: { it: Item }) => (v.it.mode === 'goal' ? -1 : Math.abs(v.it.x - kasX))
    const rect = (v: { it: Item; sx: number; sy: number }) => ({ x: v.sx, y: v.sy, w: v.it.w || 160, h: v.it.h || 40 })
    let big = visible.filter(v => v.it.mode === 'full' || v.it.mode === 'goal').sort((a, b) => prio(a) - prio(b))
    let lift = stackRects(big.map(rect))
    const demoted = big.filter((v, i) => v.it.mode === 'full' && v.sy - lift[i] - v.it.h < TOP_SAFE_PX)
    if (demoted.length) {
      for (const v of demoted) this.setMode(v.it, 'badge')
      big = big.filter(v => !demoted.includes(v))
      lift = stackRects(big.map(rect))
    }
    const liftOf = new Map(big.map((v, i) => [v.it, lift[i]]))
    // Cards that cover Kasimir (e.g. mid-jump) fade so he always stays visible.
    const a = this.toScreen(kasX - 0.9, kasY, camera, width, height)
    const b = this.toScreen(kasX + 0.9, kasY + KASIMIR_H, camera, width, height)
    const kas = { l: a.sx, r: b.sx, t: b.sy, btm: a.sy }
    for (const v of visible) {
      const dy = liftOf.get(v.it) ?? 0
      const y = v.sy - dy
      const covers = v.sx - v.it.w / 2 < kas.r && v.sx + v.it.w / 2 > kas.l && y - v.it.h < kas.btm && y > kas.t
      v.it.el.classList.toggle('is-dim', covers)
      v.it.el.style.transform = `translate3d(${v.sx.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`
    }
  }

  /** Short-lived text that rises and fades at a world position (e.g. "+1"). */
  floater(x: number, y: number, text: string, kind: 'gain' | 'loss', camera: THREE.Camera, width: number, height: number): void {
    const p = this.toScreen(x, y, camera, width, height)
    const f = el(`asg-floater asg-floater--${kind}`, text)
    f.style.left = `${p.sx}px`
    f.style.top = `${p.sy}px`
    this.root.appendChild(f)
    setTimeout(() => f.remove(), 950)
  }

  dispose(): void {
    this.root.remove()
    this.coins = []
    this.goals = []
  }
}
