// Three.js renderer + game loop for the Kasimir Arcade island.
// Fixed-timestep physics with render interpolation, a damped look-ahead camera,
// an atlas-animated Kasimir, DOM labels, particle feedback and goal interaction.

import * as THREE from 'three'
import type { LevelModel, Goal } from './types'
import { zoneColor } from './level-model'
import frameMapJson from './kasimir-frames.json'
import { BODY_HW, BODY_H, FIXED_DT, KASIMIR_H } from './constants'
import { buildWorldLayout, goalAt, zoneIndexAt, LEVEL_PAD } from './layout'
import type { WorldGoal } from './layout'
import { initialState, stepPhysics, respawn, overPit } from './physics'
import type { PhysicsState, PhysicsInput } from './physics'
import { autopilotInput, watchdog } from './autopilot'
import type { ProgressTrack } from './autopilot'
import { selectClip, frameAt, jumpFrame, playbackRate } from './anim'
import type { ClipName, AnimContext, AnimEvent } from './anim'
import { reset as ringsReset, collect as ringsCollect, onHit as ringsOnHit } from './rings'
import type { RingState } from './rings'
import { buildScene } from './scene'
import { Effects } from './fx'
import { LabelLayer } from './label-layer'
import { softDotTexture } from './textures'

const KASIMIR_FALLBACK_TEX = '/images/devtoberfest/selfie/thumbnails/Kasimir_Smiles.png'
const CAM_BASE_Y = 4.2
const CAM_LOOK_DROP = 1.0
const CAM_DIST = 15
const RESPAWN_S = 0.9
const ATTRACT_PAUSE_S = 1.8
const CELEBRATE_S = 1.4
const WRAP_S = 0.8

export type GameEvent = 'hit' | 'pickup' | 'goal' | 'jump' | 'fall'

export interface ZoneInfo {
  index: number
  total: number
  title: string
  color: string
  locked: boolean
}

export interface GoalPrompt {
  trackId: string
  title: string
  label: string
  kind: Goal['kind']
  locked: boolean
}

export interface GameHandle {
  start(): void
  stop(): void
  setPlayerControl(on: boolean): void
  onRingCount(cb: (n: number) => void): void
  onEvent(cb: (e: GameEvent) => void): void
  onZone?(cb: (z: ZoneInfo | null) => void): void
  onGoalPrompt?(cb: (g: GoalPrompt | null) => void): void
  /** Open the goal Kasimir is standing at (player mode). Returns true if it opened. */
  activateGoal?(): boolean
  dispose?(): void
}

export interface GameOptions {
  onPickTrack: (trackId: string) => void
  /** Element that hosts the HTML label overlay (defaults to the canvas' parent). */
  labelRoot?: HTMLElement | null
  reducedMotion?: boolean
}

interface FrameMap {
  image: string
  atlas: { w: number; h: number; cols: number; rows: number }
  cell: { w: number; h: number }
  anchor: { x: number; y: number }
  charH: number
  clips: Record<string, { frames: { x: number; y: number; w: number; h: number }[]; fps: number; loop: boolean }>
}

type Mode = 'play' | 'respawn' | 'pause' | 'celebrate' | 'wrap'

function noopHandle(): GameHandle {
  return {
    start() {}, stop() {}, setPlayerControl() {}, onRingCount() {}, onEvent() {},
    onZone() {}, onGoalPrompt() {}, activateGoal: () => false, dispose() {},
  }
}

/** Critically damped spring toward target (Unity SmoothDamp). */
function smoothDamp(cur: number, target: number, vel: { v: number }, smooth: number, dt: number): number {
  const omega = 2 / smooth
  const x = omega * dt
  const exp = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x)
  const change = cur - target
  const temp = (vel.v + omega * change) * dt
  vel.v = (vel.v - omega * temp) * exp
  return target + (change + temp) * exp
}

export function createGame(canvas: HTMLCanvasElement, model: LevelModel, opts: GameOptions): GameHandle {
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
  } catch {
    return noopHandle()
  }

  const reducedMotion = opts.reducedMotion ?? false
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  if (renderer.shadowMap) {
    renderer.shadowMap.enabled = true
    renderer.shadowMap.type = THREE.PCFSoftShadowMap
  }
  ;(renderer as { toneMapping?: THREE.ToneMapping }).toneMapping = THREE.ACESFilmicToneMapping
  ;(renderer as { toneMappingExposure?: number }).toneMappingExposure = 1.05

  const layout = buildWorldLayout(model)
  const hazards = layout.hazards

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x1a1640, 26, 95)
  const camera = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 400)

  // Lighting: sky/ground fill, warm key with shadows that follows the camera, cool rim.
  scene.add(new THREE.HemisphereLight(0xa9bcff, 0x2a1d10, 0.9))
  scene.add(new THREE.AmbientLight(0x404a80, 0.35))
  const key = new THREE.DirectionalLight(0xfff0dd, 1.7)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  key.shadow.camera.left = -18
  key.shadow.camera.right = 18
  key.shadow.camera.top = 12
  key.shadow.camera.bottom = -6
  key.shadow.camera.near = 1
  key.shadow.camera.far = 60
  key.shadow.bias = -0.0008
  scene.add(key, key.target)
  const rim = new THREE.DirectionalLight(0x7fa8ff, 0.6)
  rim.position.set(6, 8, -12)
  scene.add(rim)

  const world = buildScene(scene, layout)
  const fx = new Effects(scene)
  const labelHost = opts.labelRoot ?? canvas.parentElement
  const labels = labelHost ? new LabelLayer(labelHost, layout) : null

  // ---------- Kasimir ----------
  const fm = frameMapJson as unknown as FrameMap
  const wpp = KASIMIR_H / fm.charH
  const kGeo = new THREE.PlaneGeometry(fm.cell.w * wpp, fm.cell.h * wpp)
  // PlaneGeometry is centred; anchor.y is measured from the cell top — move the feet to the origin.
  kGeo.translate(0, (fm.anchor.y - fm.cell.h / 2) * wpp, 0)
  const kMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.02, depthWrite: false })
  const kMesh = new THREE.Mesh(kGeo, kMat)
  kMesh.renderOrder = 5
  const kas = new THREE.Group()
  kas.add(kMesh)
  scene.add(kas)

  let atlas: THREE.Texture | null = null
  let lastFrameKey = ''
  new THREE.TextureLoader().load(
    fm.image,
    tex => {
      tex.colorSpace = THREE.SRGBColorSpace
      tex.repeat.set(1 / fm.atlas.cols, 1 / fm.atlas.rows)
      tex.anisotropy = 4
      atlas = tex
      kMat.map = tex
      kMat.needsUpdate = true
      lastFrameKey = ''
    },
    undefined,
    () => {
      new THREE.TextureLoader().load(KASIMIR_FALLBACK_TEX, tex => {
        tex.colorSpace = THREE.SRGBColorSpace
        kMat.map = tex
        kMat.needsUpdate = true
      })
    },
  )

  function showFrame(clip: ClipName, index: number, facing: 1 | -1): void {
    if (!atlas) return
    const def = fm.clips[clip] ?? fm.clips.idle
    const f = def.frames[Math.max(0, Math.min(index, def.frames.length - 1))]
    const k = `${f.x},${f.y},${facing}`
    if (k === lastFrameKey) return
    lastFrameKey = k
    const cols = fm.atlas.cols, rows = fm.atlas.rows
    const col = Math.round(f.x / fm.cell.w), row = Math.round(f.y / fm.cell.h)
    atlas.repeat.set(facing === 1 ? 1 / cols : -1 / cols, 1 / rows)
    atlas.offset.set(facing === 1 ? col / cols : (col + 1) / cols, 1 - (row + 1) / rows)
  }

  const shadowTex = softDotTexture('rgba(0,0,0,0.55)', 'rgba(0,0,0,0)')
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 0.8), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }))
  blob.rotation.x = -Math.PI / 2
  scene.add(blob)

  // ---------- State ----------
  let phys: PhysicsState = initialState(layout.spawnX)
  let prevX = phys.x
  let prevY = phys.y
  let rings: RingState = ringsReset()
  let mode: Mode = 'play'
  let modeT = 0
  let pose: AnimContext['pose'] = null
  let pendingTrack: string | null = null
  let animEvent: AnimEvent = 'none'
  let sinceEventMs = 0
  let clip: ClipName = 'idle'
  let clipMs = 0
  let squash = 0
  let shake = 0
  let fade = 1
  let progress: ProgressTrack = { lastX: phys.x, lastAdvanceT: 0, nowT: 0 }
  let simT = 0
  let acc = 0
  const visited = new Set<number>()
  let playerControl = false
  let rafId = 0
  let started = false
  let camX = phys.x
  let camY = CAM_BASE_Y
  const camVX = { v: 0 }
  const camVY = { v: 0 }
  let look = 2.4
  let currentZone = -1
  let currentGoal: WorldGoal | null = null

  let ringCb: ((n: number) => void) | null = null
  let eventCb: ((e: GameEvent) => void) | null = null
  let zoneCb: ((z: ZoneInfo | null) => void) | null = null
  let goalCb: ((g: GoalPrompt | null) => void) | null = null
  const safe = <T>(f: (() => T) | undefined | null) => { try { f?.() } catch { /* never throw into the page */ } }
  const emit = (e: GameEvent) => safe(() => eventCb?.(e))
  const emitRings = () => safe(() => ringCb?.(rings.count))

  function width(): number { return canvas.clientWidth || canvas.width || 800 }
  function height(): number { return canvas.clientHeight || canvas.height || 600 }

  function setAnimEvent(e: AnimEvent): void {
    animEvent = e
    sinceEventMs = 0
  }

  function teleport(next: PhysicsState): void {
    phys = next
    prevX = next.x
    prevY = next.y
  }

  function resetRun(): void {
    teleport(initialState(layout.spawnX))
    rings = ringsReset()
    mode = 'play'
    modeT = 0
    pose = null
    pendingTrack = null
    setAnimEvent('none')
    visited.clear()
    for (const c of world.coins) {
      c.alive = true
      c.mesh.visible = true
    }
    for (const g of world.gates) g.lit = false
    progress = { lastX: phys.x, lastAdvanceT: simT, nowT: simT }
    camX = phys.x + look
    camVX.v = 0
    fade = 0
    emitRings()
  }

  // ---------- Input ----------
  const keys = { left: false, right: false, jump: false }
  const pointers = new Map<number, { zone: 'left' | 'right' | 'jump'; y0: number; t0: number }>()
  let swipeJumpUntil = 0

  function gameKey(k: string): boolean {
    return ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar', 'Enter', 'a', 'A', 'd', 'D', 'w', 'W'].includes(k)
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!playerControl) return
    if (gameKey(e.key)) e.preventDefault()
    switch (e.key) {
      case 'ArrowRight': case 'd': case 'D': keys.right = true; break
      case 'ArrowLeft': case 'a': case 'A': keys.left = true; break
      case ' ': case 'Spacebar': keys.jump = true; break
      case 'ArrowUp': case 'w': case 'W':
        if (!activateGoal()) keys.jump = true
        break
      case 'Enter': activateGoal(); break
    }
  }

  function onKeyUp(e: KeyboardEvent): void {
    switch (e.key) {
      case 'ArrowRight': case 'd': case 'D': keys.right = false; break
      case 'ArrowLeft': case 'a': case 'A': keys.left = false; break
      case ' ': case 'Spacebar': case 'ArrowUp': case 'w': case 'W': keys.jump = false; break
    }
  }

  function onPointerDown(e: PointerEvent): void {
    const rect = canvas.getBoundingClientRect()
    const rel = (e.clientX - rect.left) / (rect.width || 1)
    const zone = rel < 1 / 3 ? 'left' : rel > 2 / 3 ? 'right' : 'jump'
    pointers.set(e.pointerId, { zone, y0: e.clientY, t0: performance.now() })
  }
  function onPointerMove(e: PointerEvent): void {
    const p = pointers.get(e.pointerId)
    if (p && p.y0 - e.clientY > 40 && performance.now() - p.t0 < 400) {
      swipeJumpUntil = simT + 0.3
      p.y0 = -Infinity
    }
  }
  function onPointerUp(e: PointerEvent): void {
    pointers.delete(e.pointerId)
  }

  function playerInput(): PhysicsInput {
    let left = keys.left, right = keys.right, jump = keys.jump || simT < swipeJumpUntil
    for (const p of pointers.values()) {
      if (p.zone === 'left') left = true
      else if (p.zone === 'right') right = true
      else jump = true
    }
    const moveDir: -1 | 0 | 1 = right && !left ? 1 : left && !right ? -1 : 0
    return { moveDir, jump }
  }

  // ---------- Goals ----------
  function promptFor(g: WorldGoal | null): GoalPrompt | null {
    if (!g) return null
    return { trackId: g.trackId ?? g.zoneId, title: g.zoneTitle, label: g.label, kind: g.kind, locked: g.locked }
  }

  function activateGoal(): boolean {
    if (!playerControl || mode !== 'play' || !phys.onGround) return false
    const g = goalAt(layout, phys.x)
    if (!g) return false
    if (g.locked) {
      shake = reducedMotion ? 0 : 0.15
      labels?.floater(g.x, 4.5, 'Locked', 'loss', camera, width(), height())
      return true
    }
    mode = 'celebrate'
    modeT = 0
    pose = 'celebrate'
    pendingTrack = g.trackId ?? g.zoneId
    teleport({ ...phys, vx: 0 })
    fx.confetti(g.x, 4)
    emit('goal')
    return true
  }

  // ---------- Simulation step ----------
  function collectCoins(): void {
    for (let i = 0; i < world.coins.length; i++) {
      const c = world.coins[i]
      if (!c.alive || !c.collectable) continue
      const cx = c.mesh.position.x
      const cy = c.baseY
      if (Math.abs(cx - phys.x) < BODY_HW + 0.42 && cy > phys.y - 0.4 && cy < phys.y + BODY_H + 0.4) {
        c.alive = false
        c.mesh.visible = false
        rings = ringsCollect(rings)
        fx.sparkle(cx, cy)
        labels?.floater(cx, cy + 1.2, '+1', 'gain', camera, width(), height())
        emitRings()
        emit('pickup')
      }
    }
  }

  function loseRings(): void {
    const { next, scattered } = ringsOnHit(rings)
    rings = next
    if (scattered > 0) {
      fx.scatterRings(phys.x, phys.y, scattered)
      labels?.floater(phys.x, phys.y + BODY_H + 0.8, `−${scattered}`, 'loss', camera, width(), height())
    }
  }

  function step(dt: number): void {
    simT += dt
    modeT += dt
    sinceEventMs += dt * 1000
    prevX = phys.x
    prevY = phys.y

    if (mode === 'respawn') {
      if (phys.y > -9) {
        const r = stepPhysics(phys, { moveDir: 0, jump: false }, hazards, dt)
        phys = { ...r.next, y: Math.max(r.next.y, -9) }
      }
      if (modeT >= RESPAWN_S) {
        teleport(respawn(phys))
        mode = 'play'
        modeT = 0
        setAnimEvent('respawn')
        progress = { lastX: phys.x, lastAdvanceT: simT, nowT: simT }
      }
      return
    }
    if (mode === 'pause') {
      phys = { ...phys, vx: 0 }
      if (modeT >= ATTRACT_PAUSE_S) { mode = 'play'; pose = null }
      return
    }
    if (mode === 'celebrate') {
      if (modeT >= CELEBRATE_S && pendingTrack) {
        const id = pendingTrack
        pendingTrack = null
        safe(() => opts.onPickTrack(id))
      }
      return
    }
    if (mode === 'wrap') {
      fade = Math.max(0, 1 - modeT / WRAP_S)
      if (modeT >= WRAP_S) resetRun()
      return
    }

    // --- play ---
    let input: PhysicsInput
    if (playerControl) {
      input = playerInput()
    } else {
      input = autopilotInput(phys, hazards)
      // Attract mode pauses at each goal to show it off.
      const zi = zoneIndexAt(layout, phys.x)
      const g = zi >= 0 ? layout.zones[zi].goal : null
      if (g && !visited.has(zi) && phys.onGround && phys.x >= g.x - 0.2) {
        visited.add(zi)
        mode = 'pause'
        modeT = 0
        pose = g.locked ? null : g.kind === 'track' ? 'reach' : 'celebrate'
        teleport({ ...phys, vx: 0 })
        if (!g.locked) fx.sparkle(g.x, 3)
        return
      }
    }

    const { next, event } = stepPhysics(phys, input, hazards, dt)
    phys = next

    if (event === 'jump') {
      setAnimEvent('jump')
      squash = -0.8
      fx.dust(phys.x, 0, phys.facing)
      emit('jump')
    } else if (event === 'land') {
      setAnimEvent('land')
      squash = 1
      fx.dust(phys.x, phys.y, 0)
    } else if (event === 'hit') {
      setAnimEvent('hit')
      loseRings()
      shake = reducedMotion ? 0 : 0.35
      emit('hit')
      emitRings()
    } else if (event === 'fell') {
      setAnimEvent('fell')
      loseRings()
      mode = 'respawn'
      modeT = 0
      emit('fall')
      emitRings()
      return
    }

    collectCoins()

    if (!playerControl) {
      if (phys.x - progress.lastX > 0.5) progress = { lastX: phys.x, lastAdvanceT: simT, nowT: simT }
      progress = { ...progress, nowT: simT }
      const wd = watchdog(progress, phys, hazards)
      if (wd.forced) {
        teleport(wd.next)
        setAnimEvent('respawn')
        progress = { lastX: phys.x, lastAdvanceT: simT, nowT: simT }
      }
      if (phys.x >= layout.length - LEVEL_PAD - 0.5) {
        mode = 'wrap'
        modeT = 0
      }
    }
  }

  // ---------- Frame ----------
  const clock = new THREE.Clock(false)

  function resize(): void {
    const w = width(), h = height()
    camera.aspect = w / h || 1
    // Pull back on narrow or short screens so the path ahead and the labels still fit.
    const narrow = Math.max(1, 1.78 / camera.aspect)
    const short = Math.max(1, 1 + (600 - h) / 1200)
    camera.position.z = CAM_DIST * Math.min(1.7, narrow * short)
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }

  function frame(): void {
    const dt = Math.min(clock.getDelta(), 0.1)
    acc += dt
    let steps = 0
    while (acc >= FIXED_DT && steps < 24) {
      step(FIXED_DT)
      acc -= FIXED_DT
      steps++
      if (!started) return
    }
    const alpha = acc / FIXED_DT
    const rx = prevX + (phys.x - prevX) * alpha
    const ry = prevY + (phys.y - prevY) * alpha

    // Animation
    const ctx: AnimContext = {
      onGround: phys.onGround, vx: phys.vx, vy: phys.vy,
      lastEvent: animEvent, sinceEventMs, pose,
    }
    const nextClip = selectClip(ctx)
    if (nextClip !== clip) { clip = nextClip; clipMs = 0 } else { clipMs += dt * 1000 * playbackRate(clip, phys.vx) }
    const def = fm.clips[clip]
    const idx = clip === 'jump' ? jumpFrame(ctx, def?.frames.length ?? 1) : frameAt(clip, clipMs, fm.clips as never)
    showFrame(clip, idx, phys.facing)

    squash *= Math.exp(-dt * 10)
    kas.scale.set(1 + 0.08 * squash, 1 - 0.12 * squash, 1)
    kas.position.set(rx, ry, 0.35)
    const blinking = phys.invuln > 0 && mode === 'play'
    kMat.opacity = (blinking ? (Math.floor(simT * 14) % 2 ? 0.35 : 1) : 1) * (mode === 'respawn' ? Math.max(0, 1 - modeT / 0.4) : 1)
    kas.visible = kMat.opacity > 0.01

    // Contact shadow on whatever is under Kasimir
    let floorY = 0
    for (const c of hazards.crates) if (rx > c.x0 && rx < c.x1 && ry >= c.top - 0.05) floorY = c.top
    const overHole = floorY === 0 && overPit(rx, hazards.pits)
    blob.visible = !overHole && ry > -0.2
    const lift = Math.max(0, ry - floorY)
    blob.position.set(rx, floorY + 0.02, 0.35)
    blob.scale.setScalar(Math.max(0.35, 1 - lift * 0.15))
    ;(blob.material as THREE.MeshBasicMaterial).opacity = Math.max(0.2, 1 - lift * 0.18)

    // Camera: critically damped follow with look-ahead in the facing direction
    look += (phys.facing * 2.4 - look) * Math.min(1, dt * 1.8)
    camX = smoothDamp(camX, rx + look, camVX, 0.32, dt)
    const camTargetY = CAM_BASE_Y + Math.max(-2.5, Math.min(2.2, (ry - 0.6) * 0.35))
    camY = smoothDamp(camY, camTargetY, camVY, 0.45, dt)
    shake *= Math.exp(-dt * 7)
    const sx = shake > 0.002 ? (Math.random() - 0.5) * shake : 0
    const sy = shake > 0.002 ? (Math.random() - 0.5) * shake : 0
    camera.position.x = camX + sx
    camera.position.y = camY + sy
    camera.lookAt(camX + sx, camY - CAM_LOOK_DROP + sy, 0)

    key.position.set(camX - 10, 20, 14)
    key.target.position.set(camX, 0, 0)

    // Zone + goal prompt notifications
    const zi = zoneIndexAt(layout, rx)
    if (zi !== currentZone) {
      currentZone = zi
      const z = layout.zones[zi]
      safe(() => zoneCb?.(z ? { index: zi, total: layout.zones.length, title: z.title, color: zoneColor(z.colorIndex), locked: z.locked } : null))
    }
    const g = playerControl && mode === 'play' && phys.onGround ? goalAt(layout, phys.x) : null
    if (g !== currentGoal) {
      currentGoal = g
      safe(() => goalCb?.(promptFor(g)))
    }

    if (mode !== 'wrap') fade = Math.min(1, fade + dt * 2.5)
    canvas.style.opacity = fade.toFixed(3)

    world.update(simT, dt, camX, rx, zi)
    fx.update(dt)
    renderer.render(scene, camera)
    labels?.update(camera, camX, rx, ry, width(), height())

    // stop() may have run inside this frame (e.g. onPickTrack → hide); don't re-arm the loop.
    if (started) rafId = requestAnimationFrame(frame)
  }

  function attach(): void {
    window.addEventListener('resize', resize)
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerUp)
  }

  function detach(): void {
    window.removeEventListener('resize', resize)
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointermove', onPointerMove)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointercancel', onPointerUp)
    canvas.removeEventListener('pointerleave', onPointerUp)
    keys.left = keys.right = keys.jump = false
    pointers.clear()
  }

  return {
    start() {
      if (started) return
      started = true
      resize()
      attach()
      resetRun()
      camX = phys.x + look
      clock.start()
      acc = 0
      rafId = requestAnimationFrame(frame)
    },
    stop() {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = 0
      detach()
      playerControl = false
      started = false
      clock.stop()
      if (currentGoal) {
        currentGoal = null
        safe(() => goalCb?.(null))
      }
    },
    setPlayerControl(on: boolean) {
      playerControl = on
      if (on && mode === 'pause') { mode = 'play'; pose = null }
      if (!on) {
        keys.left = keys.right = keys.jump = false
        // Autopilot resumes from here — don't let stale progress trip the wedge watchdog.
        progress = { lastX: phys.x, lastAdvanceT: simT, nowT: simT }
      }
    },
    onRingCount(cb) { ringCb = cb },
    onEvent(cb) { eventCb = cb },
    onZone(cb) { zoneCb = cb },
    onGoalPrompt(cb) { goalCb = cb },
    activateGoal,
    dispose() {
      try {
        if (rafId) cancelAnimationFrame(rafId)
        detach()
        labels?.dispose()
        fx.dispose()
        scene.traverse(obj => {
          const m = obj as THREE.Mesh
          if (m.geometry) m.geometry.dispose()
          const mat = m.material as THREE.Material | THREE.Material[] | undefined
          if (Array.isArray(mat)) mat.forEach(x => x.dispose())
          else mat?.dispose()
        })
        atlas?.dispose()
        renderer.dispose()
      } catch {
        // best-effort
      }
    },
  }
}
