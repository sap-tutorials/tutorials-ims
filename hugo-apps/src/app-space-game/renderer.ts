// Three.js renderer for the app-space-game island.
// Builds a 2.5D attract-loop scene from a LevelModel and runs the game loop.
// Spike reference: .superpowers/sdd/2026-11-03-kasimir-arcade-app-space/spike-reference.html

import * as THREE from 'three'
import type { LevelModel, Zone, Coin, Gate, Goal } from './types'
import { zoneColor } from './level-model'
import { fitLabel, coinLabelY } from './label-layout'
import { SPEED, GRAV, JUMP } from './constants'
import { selectClip, frameAt } from './anim'
import type { ClipName, AnimContext } from './anim'
import { GROUND_Y, stepPhysics, respawn } from './physics'
import type { PhysicsState, WorldHazards } from './physics'
import { autopilotInput, watchdog } from './autopilot'
import type { ProgressTrack } from './autopilot'
import { reset as ringsReset, collect as ringsCollect, onHit as ringsOnHit } from './rings'
import type { RingState } from './rings'
import { COIN_SPACING } from './obstacles'

const ZONE_W = 26
const GY = 0
const KASIMIR_TEX = '/images/devtoberfest/selfie/thumbnails/Kasimir_Smiles.png'
const KASIMIR_ATLAS = '/images/app-space-game/kasimir-atlas.png'

// --- helpers ---

/** Build a canvas-texture sprite for floating text labels. */
function makeLabel(text: string, color: string = '#ffffff'): THREE.Sprite {
  const layout = fitLabel(text)
  const cv = document.createElement('canvas')
  cv.width = layout.canvasW
  cv.height = layout.canvasH
  const g = cv.getContext('2d')!
  g.font = 'bold 40px system-ui'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 8
  g.strokeStyle = 'rgba(0,0,0,.75)'
  g.fillStyle = color

  // Draw each wrapped line
  const lineHeight = 30
  const verticalOffset = (layout.canvasH - layout.lines.length * lineHeight) / 2 + lineHeight / 2
  layout.lines.forEach((line, index) => {
    const y = verticalOffset + index * lineHeight
    g.strokeText(line, layout.canvasW / 2, y)
    g.fillText(line, layout.canvasW / 2, y)
  })

  const tex = new THREE.CanvasTexture(cv)
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(layout.worldW, layout.worldH, 1)
  return sprite
}

/** Parse a CSS hex color string to a THREE.Color-compatible integer. */
function hexToInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16)
}

interface CoinMesh extends THREE.Mesh {
  userData: { alive: boolean; title: string }
}

interface ZoneMeta {
  name: string
  locked: boolean
  cleared: boolean
  goalX: number
  start: number
  coinCount: number
  hazards: WorldHazards
}

// --- scene builder ---

function buildScene(
  scene: THREE.Scene,
  model: LevelModel
): { markers: CoinMesh[]; zoneMeta: ZoneMeta[]; totalLen: number; obstacleMeshes: THREE.Mesh[] } {
  const markers: CoinMesh[] = []
  const zoneMeta: ZoneMeta[] = []
  const obstacleMeshes: THREE.Mesh[] = []
  let runningX = 5

  model.zones.forEach((zone: Zone) => {
    const accentInt = hexToInt(zoneColor(zone.colorIndex))
    const isLocked = zone.locked
    const isCleared = zone.cleared
    const x0 = runningX - 3

    // Ground slab
    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(ZONE_W, 1, 10),
      new THREE.MeshStandardMaterial({
        color: isLocked ? 0x161a28 : 0x10203a,
        roughness: 0.9,
      })
    )
    ground.position.set(x0 + ZONE_W / 2, GY - 0.5, 0)
    ground.receiveShadow = true
    scene.add(ground)

    // Accent seam at ground level
    const seam = new THREE.Mesh(
      new THREE.BoxGeometry(ZONE_W, 0.08, 10.05),
      new THREE.MeshBasicMaterial({ color: isLocked ? 0x333848 : accentInt })
    )
    seam.position.set(x0 + ZONE_W / 2, GY + 0.02, 0)
    scene.add(seam)

    // Sky backdrop wall
    // Derive a darker sky tint from the accent color
    const accentColor = new THREE.Color(accentInt)
    const skyColor = new THREE.Color(
      accentColor.r * 0.12,
      accentColor.g * 0.12,
      accentColor.b * 0.18
    )
    const wall = new THREE.Mesh(
      new THREE.PlaneGeometry(ZONE_W, 24),
      new THREE.MeshBasicMaterial({ color: skyColor })
    )
    wall.position.set(x0 + ZONE_W / 2, 9, -10)
    scene.add(wall)

    // Parallax pillars
    for (let p = 0; p < 3; p++) {
      const pil = new THREE.Mesh(
        new THREE.BoxGeometry(1.2, 11, 1.2),
        new THREE.MeshStandardMaterial({
          color: accentInt,
          roughness: 0.5,
          emissive: accentInt,
          emissiveIntensity: isLocked ? 0.03 : 0.18,
          transparent: isLocked,
          opacity: isLocked ? 0.4 : 1,
        })
      )
      pil.position.set(x0 + 5 + p * 8, 5.5, -6)
      pil.castShadow = !isLocked
      scene.add(pil)
    }

    // Zone name banner
    const banner = makeLabel(zone.title.toUpperCase(), '#ffffff')
    banner.scale.set(10, 1.8, 1)
    banner.position.set(x0 + ZONE_W / 2, 11, -5)
    scene.add(banner)

    const zStart = runningX

    // Coins - one per zone.coins entry
    zone.coins.forEach((coin: Coin, k: number) => {
      const isAvailable = coin.available
      const isDone = coin.done
      const coinMesh = new THREE.Mesh(
        new THREE.TorusGeometry(0.5, 0.18, 10, 24),
        new THREE.MeshStandardMaterial({
          color: isDone ? 0x49b35a : isAvailable ? 0xf0b42a : 0x555555,
          metalness: 0.9,
          roughness: 0.25,
          emissive: isDone ? 0x1f5e2a : isAvailable ? 0x7a5200 : 0x111111,
          emissiveIntensity: 0.5,
          transparent: !isAvailable,
          opacity: !isAvailable ? 0.45 : 1,
        })
      ) as CoinMesh
      coinMesh.position.set(runningX, 2.1 + Math.sin(k) * 0.6, 0)
      coinMesh.castShadow = !isLocked
      coinMesh.userData = { alive: !isDone && isAvailable, title: coin.title }
      scene.add(coinMesh)

      const coinColor = isDone ? '#9fe7a8' : isAvailable ? '#ffe9a3' : '#888888'
      const tag = makeLabel(coin.title, coinColor)
      const tagY = coinLabelY(3.5, k)
      tag.position.set(runningX, tagY, 0)
      scene.add(tag)

      if (!isLocked && !isDone) markers.push(coinMesh)
      runningX += 4.5
    })

    // Checkpoint gates - one per zone.gates entry
    zone.gates.forEach((gate: Gate) => {
      // Position gate after the coin at gate.afterCoinIndex
      // Each coin is 4.5 units wide; offset from zStart
      const gateX = zStart + (gate.afterCoinIndex + 1) * 4.5 + 0.5
      const gateMat = new THREE.MeshStandardMaterial({
        color: 0xffb02e,
        emissive: 0xffb02e,
        emissiveIntensity: 0.4,
        metalness: 0.4,
      })
      const lPost = new THREE.Mesh(new THREE.BoxGeometry(0.4, 5, 0.4), gateMat)
      lPost.position.set(gateX, 2.5, 0)
      lPost.castShadow = true
      scene.add(lPost)
      const rPost = lPost.clone()
      rPost.position.set(gateX + 2.4, 2.5, 0)
      scene.add(rPost)
      const top = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.5, 0.5), gateMat)
      top.position.set(gateX + 1.2, 4.8, 0)
      scene.add(top)
      const ct = makeLabel('CHECKPOINT', '#ffd27a')
      ct.position.set(gateX + 1.2, 5.7, 0)
      scene.add(ct)
      runningX = Math.max(runningX, gateX + 5)
    })

    // Goal object at zone end
    const goalX = runningX + 1.5
    const goal: Goal = zone.goal
    const isTrack = goal.kind === 'track'

    if (isTrack) {
      // Flag pole for track-select goal
      const pole = new THREE.Mesh(
        new THREE.BoxGeometry(0.2, 5, 0.2),
        new THREE.MeshStandardMaterial({
          color: isLocked ? 0x444444 : 0xc0c0c0,
          metalness: 0.7,
        })
      )
      pole.position.set(goalX, 2.5, 0)
      pole.castShadow = true
      scene.add(pole)
      const flag = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 1.2),
        new THREE.MeshBasicMaterial({
          color: isLocked ? 0x444444 : accentInt,
          side: THREE.DoubleSide,
        })
      )
      flag.position.set(goalX + 1, 4.5, 0)
      scene.add(flag)
      const glow = new THREE.PointLight(
        isLocked ? 0x333333 : accentInt,
        isLocked ? 0 : 2.5,
        10
      )
      glow.position.set(goalX, 4, 1)
      scene.add(glow)
      const pt = makeLabel(
        (isLocked ? 'LOCKED ' : '') + goal.label,
        isLocked ? '#ffb02e' : '#ffe9a3'
      )
      pt.position.set(goalX, 5.2, 0)
      scene.add(pt)
    } else {
      // Chest for prize / checkpoint goal
      const chestMat = new THREE.MeshStandardMaterial({
        color: isLocked ? 0x444444 : 0xc98b3a,
        metalness: 0.5,
        roughness: 0.4,
        emissive: isLocked ? 0 : 0x3a2608,
        emissiveIntensity: 0.3,
      })
      const chest = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2), chestMat)
      chest.position.set(goalX, 1.4, 0)
      chest.castShadow = true
      scene.add(chest)
      const lid = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.7, 2.1), chestMat)
      lid.position.set(goalX, 2.5, 0)
      lid.castShadow = true
      scene.add(lid)
      const glow = new THREE.PointLight(
        isLocked ? 0x333333 : 0xffcf6b,
        isLocked ? 0 : 3,
        10
      )
      glow.position.set(goalX, 3, 1)
      scene.add(glow)
      const prizeLabel = (isLocked ? '[locked] ' : '') + goal.label
      const pt = makeLabel(prizeLabel, isLocked ? '#ffb02e' : '#ffe9a3')
      pt.position.set(goalX, 4, 0)
      scene.add(pt)
      if (isLocked) {
        const lk = makeLabel('LOCKED - complete prerequisites', '#ffb02e')
        lk.scale.set(7, 1.3, 1)
        lk.position.set(goalX, 4.9, 0)
        scene.add(lk)
      }
    }

    // Build WorldHazards for this zone (coin-index → world units)
    const worldHazards: WorldHazards = {
      obstacles: zone.obstacles.map(o => ({
        x: zStart + o.x * COIN_SPACING,
        w: o.w * COIN_SPACING,
        h: o.h,
      })),
      pits: zone.pits.map(p => ({
        x: zStart + p.x * COIN_SPACING,
        w: p.w,
      })),
    }

    // Render obstacle meshes (boxes sitting on the ground)
    for (const obs of worldHazards.obstacles) {
      const obsMesh = new THREE.Mesh(
        new THREE.BoxGeometry(obs.w, obs.h, 1.5),
        new THREE.MeshStandardMaterial({
          color: 0xff4444,
          roughness: 0.6,
          emissive: 0x330000,
          emissiveIntensity: 0.4,
        })
      )
      obsMesh.position.set(obs.x, GROUND_Y + obs.h / 2, 0.1)
      obsMesh.castShadow = true
      scene.add(obsMesh)
      obstacleMeshes.push(obsMesh)
    }

    // Render pit markers (visible hazard indicator at pit edges — no ground segment)
    for (const pit of worldHazards.pits) {
      // Pit marker: a darker strip below the ground to signal the gap
      const pitMark = new THREE.Mesh(
        new THREE.BoxGeometry(pit.w, 0.3, 1.5),
        new THREE.MeshBasicMaterial({ color: 0x110011 })
      )
      pitMark.position.set(pit.x, GROUND_Y - 0.6, 0.1)
      scene.add(pitMark)
      obstacleMeshes.push(pitMark)
    }

    runningX = goalX + 6

    zoneMeta.push({
      name: zone.title,
      locked: isLocked,
      cleared: isCleared,
      goalX,
      start: zStart,
      coinCount: zone.coins.length,
      hazards: worldHazards,
    })
  })

  return { markers, zoneMeta, totalLen: runningX, obstacleMeshes }
}

/** Merge all zone WorldHazards into a single flat WorldHazards for physics queries. */
function mergeHazards(zoneMeta: ZoneMeta[]): WorldHazards {
  const obstacles: WorldHazards['obstacles'] = []
  const pits: WorldHazards['pits'] = []
  for (const zm of zoneMeta) {
    obstacles.push(...zm.hazards.obstacles)
    pits.push(...zm.hazards.pits)
  }
  return { obstacles, pits }
}

// --- public API ---

export interface GameHandle {
  start(): void
  stop(): void
  setPlayerControl(on: boolean): void
  onRingCount(cb: (n: number) => void): void
  onEvent(cb: (e: 'hit' | 'pickup' | 'goal') => void): void
  dispose?(): void
}

export function createGame(
  canvas: HTMLCanvasElement,
  model: LevelModel,
  opts: { onPickTrack: (trackId: string) => void }
): GameHandle {
  // Defensive: if WebGL fails, return safe no-ops
  let renderer: THREE.WebGLRenderer
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true })
  } catch (_e) {
    return {
      start() {},
      stop() {},
      setPlayerControl(_on: boolean) {},
      onRingCount(_cb: (n: number) => void) {},
      onEvent(_cb: (e: 'hit' | 'pickup' | 'goal') => void) {},
      dispose() {},
    }
  }

  renderer.setPixelRatio(Math.min(devicePixelRatio, 2))
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x06080f, 20, 52)

  const camera = new THREE.PerspectiveCamera(42, canvas.clientWidth / canvas.clientHeight || 1, 0.1, 200)

  // Lighting
  scene.add(new THREE.AmbientLight(0x5566aa, 1.1))
  const key = new THREE.DirectionalLight(0xffffff, 1.5)
  key.position.set(-6, 14, 9)
  key.castShadow = true
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.camera.near = 1
  key.shadow.camera.far = 70
  key.shadow.camera.left = -40
  key.shadow.camera.right = 40
  key.shadow.camera.top = 24
  key.shadow.camera.bottom = -12
  scene.add(key)

  const kLight = new THREE.PointLight(0x9ab8ff, 2, 16)
  scene.add(kLight)

  // Build scene from model
  const { markers, zoneMeta, totalLen, obstacleMeshes } = buildScene(scene, model)

  // Merged hazards for physics (all zones combined)
  const allHazards = mergeHazards(zoneMeta)

  // Kasimir billboard — atlas-animated with static fallback
  const kMat = new THREE.MeshBasicMaterial({ transparent: true, alphaTest: 0.3 })
  const kasimir = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.6), kMat)
  kasimir.position.set(5, GROUND_Y, 0.3)
  scene.add(kasimir)

  // Atlas animation state
  type FrameRect = { x: number; y: number; w: number; h: number }
  type ClipDef = { frames: FrameRect[]; fps: number; loop: boolean }
  type FrameMap = { image: string; cell: { w: number; h: number }; clips: Record<ClipName, ClipDef> }

  let atlasLoaded = false
  let frameMap: FrameMap | null = null
  let atlasTex: THREE.Texture | null = null
  let totalCols = 1
  let totalRows = 1
  let animElapsedMs = 0
  let currentClip: ClipName = 'idle'

  // Load atlas texture, then fetch the frame-map JSON
  const atlasLoader = new THREE.TextureLoader()
  atlasLoader.load(
    KASIMIR_ATLAS,
    (loadedTex) => {
      // Atlas texture loaded — now import the frame map
      import('./kasimir-frames.json').then((mod) => {
        try {
          const fm = mod.default as FrameMap
          // Compute atlas grid dimensions from cell size + max frame bounds
          let maxX = 0
          let maxY = 0
          for (const clip of Object.values(fm.clips)) {
            for (const f of (clip as ClipDef).frames) {
              if (f.x + f.w > maxX) maxX = f.x + f.w
              if (f.y + f.h > maxY) maxY = f.y + f.h
            }
          }
          totalCols = Math.round(maxX / fm.cell.w)
          totalRows = Math.round(maxY / fm.cell.h)
          loadedTex.colorSpace = THREE.SRGBColorSpace
          // UV wrapping: clamp so we never bleed between cells
          loadedTex.wrapS = THREE.ClampToEdgeWrapping
          loadedTex.wrapT = THREE.ClampToEdgeWrapping
          // Enable UV offset/repeat sub-region selection
          loadedTex.repeat.set(1 / totalCols, 1 / totalRows)
          loadedTex.offset.set(0, 0)
          frameMap = fm
          atlasTex = loadedTex
          kMat.map = loadedTex
          kMat.needsUpdate = true
          atlasLoaded = true
        } catch (_e) {
          // JSON parse or structure error — fall through to static sprite
          try { console.warn('[app-space-game] kasimir-frames.json failed to parse') } catch { /* silent */ }
          loadFallbackSprite()
        }
      }).catch((_e) => {
        // Dynamic import failed — fall through to static sprite
        try { console.warn('[app-space-game] kasimir-frames.json failed to import') } catch { /* silent */ }
        loadFallbackSprite()
      })
    },
    undefined,
    (_err) => {
      // Atlas texture load failed — fall through to static sprite
      try { console.warn('[app-space-game] Kasimir atlas failed to load') } catch { /* silent */ }
      loadFallbackSprite()
    }
  )

  function loadFallbackSprite(): void {
    const fallbackTex = new THREE.TextureLoader().load(
      KASIMIR_TEX,
      undefined,
      undefined,
      (_err) => {
        try { console.warn('[app-space-game] Kasimir fallback texture also failed to load') } catch { /* silent */ }
      }
    )
    fallbackTex.colorSpace = THREE.SRGBColorSpace
    kMat.map = fallbackTex
    kMat.needsUpdate = true
  }

  /** Update the atlas UV offset/repeat for the current frame, and facing flip. */
  function updateKasimirUV(facing: 1 | -1): void {
    if (!atlasLoaded || !frameMap || !atlasTex) return

    const clip = frameMap.clips[currentClip]
    if (!clip) return

    const clips = frameMap.clips as Record<ClipName, { frames: unknown[]; fps: number; loop: boolean }>
    const frameIdx = frameAt(currentClip, animElapsedMs, clips)
    const frame = clip.frames[frameIdx]
    if (!frame) return

    const col = Math.round(frame.x / frameMap.cell.w)
    const row = Math.round(frame.y / frameMap.cell.h)

    atlasTex.repeat.set(1 / totalCols, 1 / totalRows)
    // Three.js UV origin is bottom-left; row 0 in the atlas is the top.
    atlasTex.offset.set(col / totalCols, 1 - (row + 1) / totalRows)
    atlasTex.needsUpdate = true

    // Flip scale.x for facing direction
    const absScaleX = Math.abs(kasimir.scale.x)
    kasimir.scale.x = facing === -1 ? -absScaleX : absScaleX
  }

  // Kasimir shadow blob
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.4 })
  )
  blob.rotation.x = -Math.PI / 2
  blob.position.set(5, 0.03, 0)
  scene.add(blob)

  // --- Physics + ring state ---
  let physState: PhysicsState = {
    x: 5,
    y: GROUND_Y,
    vy: 0,
    onGround: true,
    facing: 1,
    lastSafeX: 5,
  }
  let ringState: RingState = ringsReset()

  // Progress tracking for autopilot watchdog
  let progress: ProgressTrack = {
    lastX: 5,
    lastAdvanceT: 0,
    nowT: 0,
  }

  // Animation event tracking for AnimContext
  let lastEvent: AnimContext['lastEvent'] = 'none'
  let sinceEventMs = 0

  let playerControl = false
  let rafId = 0
  let started = false

  // --- Callbacks ---
  let ringCountCb: ((n: number) => void) | null = null
  let eventCb: ((e: 'hit' | 'pickup' | 'goal') => void) | null = null

  function fireRingCount(n: number): void {
    try { ringCountCb?.(n) } catch { /* never throw into the page */ }
  }

  function fireEvent(e: 'hit' | 'pickup' | 'goal'): void {
    try { eventCb?.(e) } catch { /* never throw into the page */ }
  }

  // Zone hit tracking for onPickTrack
  const goalHit = new Set<string>()

  const clock = new THREE.Clock()

  // --- Player input state ---
  // Renderer owns the listeners when player-control is on.
  const keys = { right: false, left: false, jump: false }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') keys.right = true
    if (e.key === 'ArrowLeft') keys.left = true
    if (e.key === 'ArrowUp' || e.key === ' ') keys.jump = true
  }

  function onKeyUp(e: KeyboardEvent): void {
    if (e.key === 'ArrowRight') keys.right = false
    if (e.key === 'ArrowLeft') keys.left = false
    if (e.key === 'ArrowUp' || e.key === ' ') keys.jump = false
  }

  // Pointer/touch: tap anywhere on the canvas = jump; hold right half = run right; hold left = run left
  let pointerDown = false
  let pointerHalf: 'left' | 'right' | null = null

  function onPointerDown(e: PointerEvent): void {
    pointerDown = true
    const rect = canvas.getBoundingClientRect()
    const relX = e.clientX - rect.left
    const third = canvas.clientWidth / 3
    if (relX < third) {
      pointerHalf = 'left'
    } else if (relX > canvas.clientWidth - third) {
      pointerHalf = 'right'
    } else {
      pointerHalf = null // center tap = jump
    }
  }

  function onPointerUp(): void {
    pointerDown = false
    pointerHalf = null
  }

  /** Derive moveDir and jump from current input state in player mode. */
  function playerInput(): { moveDir: -1 | 0 | 1; jump: boolean } {
    let moveDir: -1 | 0 | 1 = 0
    if (keys.right || (pointerDown && pointerHalf === 'right')) moveDir = 1
    else if (keys.left || (pointerDown && pointerHalf === 'left')) moveDir = -1
    const jump = keys.jump || (pointerDown && pointerHalf === null)
    return { moveDir, jump }
  }

  function resizeToCanvas() {
    const w = canvas.clientWidth || canvas.width || 800
    const h = canvas.clientHeight || canvas.height || 600
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  resizeToCanvas()

  // Keep camera aspect + drawing buffer in sync when the window resizes mid-attract
  const onResize = () => resizeToCanvas()

  /** Reset all run state (called at start + on wrap). */
  function resetRunState(): void {
    physState = {
      x: 5,
      y: GROUND_Y,
      vy: 0,
      onGround: true,
      facing: 1,
      lastSafeX: 5,
    }
    ringState = ringsReset()
    progress = { lastX: 5, lastAdvanceT: 0, nowT: clock.elapsedTime }
    lastEvent = 'none'
    sinceEventMs = 0
    animElapsedMs = 0
    currentClip = 'idle'
    goalHit.clear()
    markers.forEach(m => {
      m.userData.alive = true
      m.visible = true
    })
    fireRingCount(0)
  }

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    // Update progress time
    progress = { ...progress, nowT: t }

    // Derive input
    let input: { moveDir: -1 | 0 | 1; jump: boolean }

    if (!playerControl) {
      // Attract mode: autopilot
      input = autopilotInput(physState, allHazards)

      // Update progress tracking (x advance > 0.5 units resets wedge timer)
      if (physState.x - progress.lastX > 0.5) {
        progress = { ...progress, lastX: physState.x, lastAdvanceT: t }
      }

      // Watchdog: if stalled, forced-teleport
      const wd = watchdog(progress, physState, allHazards)
      if (wd.forced) {
        physState = wd.next
        // Resync progress after watchdog teleport
        progress = { lastX: physState.x, lastAdvanceT: t, nowT: t }
      }
    } else {
      // Player mode
      input = playerInput()
      // Consume jump so holding doesn't re-trigger
      if (input.jump && physState.onGround) {
        keys.jump = false
      }
    }

    // --- Physics step ---
    const { next: nextState, event: physEvent } = stepPhysics(physState, input, allHazards, dt)
    physState = nextState

    // --- Handle physics events ---
    if (physEvent === 'hit' || physEvent === 'fell') {
      const { next: nextRings } = ringsOnHit(ringState)
      ringState = nextRings
      fireRingCount(ringState.count)
      fireEvent('hit')
      lastEvent = physEvent === 'fell' ? 'fell' : 'hit'
      sinceEventMs = 0
      physState = respawn(physState)
    }

    // --- Wrap at end of level (attract mode loops; player mode resets) ---
    if (physState.x > totalLen - 4) {
      resetRunState()
      return
    }

    // --- Coin collection ---
    markers.forEach(coin => {
      if (!coin.userData.alive) return
      coin.rotation.y += dt * 3
      if (Math.abs(coin.position.x - physState.x) < 1.2 && Math.abs(coin.position.y - physState.y) < 1.6) {
        coin.userData.alive = false
        coin.visible = false
        ringState = ringsCollect(ringState)
        fireRingCount(ringState.count)
        fireEvent('pickup')
        lastEvent = 'pickup'
        sinceEventMs = 0
      }
    })

    // --- Goal reach check ---
    if (playerControl) {
      zoneMeta.forEach((zm, zi) => {
        const zone = model.zones[zi]
        const zoneId = zone?.id
        if (zoneId && !goalHit.has(zoneId) && !zm.locked && Math.abs(physState.x - zm.goalX) < 1.3) {
          goalHit.add(zoneId)
          const trackId = zone.goal.trackId ?? zoneId
          fireEvent('goal')
          lastEvent = 'goal'
          sinceEventMs = 0
          opts.onPickTrack(trackId)
        }
      })
    }

    // --- Animation ---
    sinceEventMs += dt * 1000

    const animCtx: AnimContext = {
      onGround: physState.onGround,
      moveDir: (input.moveDir as -1 | 0 | 1),
      vy: physState.vy,
      lastEvent,
      sinceEventMs,
    }
    const nextClip = selectClip(animCtx)
    if (nextClip !== currentClip) {
      currentClip = nextClip
      animElapsedMs = 0
    } else {
      animElapsedMs += dt * 1000
    }

    // --- Update Kasimir mesh ---
    kasimir.position.set(physState.x, physState.y, 0.3)
    blob.position.set(physState.x, 0.03, 0)
    blob.scale.setScalar(1 - (physState.y - GROUND_Y) * 0.12)
    kLight.position.set(physState.x, physState.y + 1, 3)

    // Update atlas UV for current animation frame + facing
    updateKasimirUV(physState.facing)

    // Camera follow
    camera.position.x += (physState.x - camera.position.x) * Math.min(1, dt * 4)
    camera.position.y = 3.4 + Math.sin(t * 1.2) * 0.15
    camera.position.z = 13
    camera.lookAt(camera.position.x, 2.4, 0)

    renderer.render(scene, camera)
    rafId = requestAnimationFrame(tick)
  }

  function attachPlayerInput(): void {
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointerleave', onPointerUp)
  }

  function detachPlayerInput(): void {
    window.removeEventListener('keydown', onKeyDown)
    window.removeEventListener('keyup', onKeyUp)
    canvas.removeEventListener('pointerdown', onPointerDown)
    canvas.removeEventListener('pointerup', onPointerUp)
    canvas.removeEventListener('pointerleave', onPointerUp)
    keys.right = false
    keys.left = false
    keys.jump = false
    pointerDown = false
    pointerHalf = null
  }

  return {
    start() {
      if (started) return
      started = true
      resizeToCanvas()
      window.addEventListener('resize', onResize)
      clock.start()
      resetRunState()
      rafId = requestAnimationFrame(tick)
    },
    stop() {
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      window.removeEventListener('resize', onResize)
      detachPlayerInput()
      playerControl = false
      started = false
    },
    setPlayerControl(on: boolean) {
      playerControl = on
      if (on) {
        attachPlayerInput()
      } else {
        detachPlayerInput()
      }
    },
    onRingCount(cb: (n: number) => void) {
      ringCountCb = cb
    },
    onEvent(cb: (e: 'hit' | 'pickup' | 'goal') => void) {
      eventCb = cb
    },
    dispose() {
      // Dispose renderer and GPU resources
      window.removeEventListener('resize', onResize)
      try {
        renderer.dispose()
        scene.traverse(obj => {
          if (obj instanceof THREE.Mesh) {
            obj.geometry?.dispose()
            if (Array.isArray(obj.material)) {
              obj.material.forEach(m => m.dispose())
            } else {
              (obj.material as THREE.Material)?.dispose()
            }
          }
        })
        kMat.dispose()
        atlasTex?.dispose()
        obstacleMeshes.length = 0
      } catch {
        // Best-effort - never throw on dispose
      }
    },
  }
}
