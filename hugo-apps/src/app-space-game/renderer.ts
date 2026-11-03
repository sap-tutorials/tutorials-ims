// Three.js renderer for the app-space-game island.
// Builds a 2.5D attract-loop scene from a LevelModel and runs the game loop.
// Spike reference: .superpowers/sdd/2026-11-03-kasimir-arcade-app-space/spike-reference.html

import * as THREE from 'three'
import type { LevelModel, Zone, Coin, Gate, Goal } from './types'
import { zoneColor } from './level-model'

const ZONE_W = 26
const GY = 0
const KASIMIR_TEX = '/images/devtoberfest/selfie/thumbnails/Kasimir_Smiles.png'

// --- helpers ---

/** Build a canvas-texture sprite for floating text labels. */
function makeLabel(text: string, color: string = '#ffffff'): THREE.Sprite {
  const cv = document.createElement('canvas')
  cv.width = 512
  cv.height = 96
  const g = cv.getContext('2d')!
  g.font = 'bold 40px system-ui'
  g.textAlign = 'center'
  g.textBaseline = 'middle'
  g.lineWidth = 8
  g.strokeStyle = 'rgba(0,0,0,.75)'
  g.strokeText(text, 256, 48)
  g.fillStyle = color
  g.fillText(text, 256, 48)
  const tex = new THREE.CanvasTexture(cv)
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true })
  const sprite = new THREE.Sprite(mat)
  sprite.scale.set(6, 1.1, 1)
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
}

// --- scene builder ---

function buildScene(
  scene: THREE.Scene,
  model: LevelModel
): { markers: CoinMesh[]; zoneMeta: ZoneMeta[]; totalLen: number } {
  const markers: CoinMesh[] = []
  const zoneMeta: ZoneMeta[] = []
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
      tag.position.set(runningX, 3.5, 0)
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

    runningX = goalX + 6

    zoneMeta.push({
      name: zone.title,
      locked: isLocked,
      cleared: isCleared,
      goalX,
      start: zStart,
      coinCount: zone.coins.length,
    })
  })

  return { markers, zoneMeta, totalLen: runningX }
}

// --- public API ---

export interface GameHandle {
  start(): void
  stop(): void
  setPlayerControl(on: boolean): void
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
  const { markers, zoneMeta, totalLen } = buildScene(scene, model)

  // Kasimir billboard
  const tex = new THREE.TextureLoader().load(KASIMIR_TEX)
  tex.colorSpace = THREE.SRGBColorSpace
  const kMat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.3 })
  const kasimir = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.6), kMat)
  kasimir.position.set(5, 1.8, 0.3)
  scene.add(kasimir)

  // Kasimir shadow blob
  const blob = new THREE.Mesh(
    new THREE.CircleGeometry(1.1, 24),
    new THREE.MeshBasicMaterial({ color: 0, transparent: true, opacity: 0.4 })
  )
  blob.rotation.x = -Math.PI / 2
  blob.position.set(5, 0.03, 0)
  scene.add(blob)

  // Game state
  let kasX = 5
  let kasY = 1.8
  let vy = 0
  let onGround = true
  let playerControl = false
  let rafId = 0
  let started = false

  // Zone hit tracking for onPickTrack
  const goalHit = new Set<string>()

  const SPEED = 6
  const GRAV = -24
  const JUMP = 10

  const clock = new THREE.Clock()

  function resizeToCanvas() {
    const w = canvas.clientWidth || canvas.width || 800
    const h = canvas.clientHeight || canvas.height || 600
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h, false)
  }
  resizeToCanvas()

  function tick() {
    const dt = Math.min(clock.getDelta(), 0.05)
    const t = clock.elapsedTime

    // Attract auto-run: advance Kasimir forward, loop at end
    if (!playerControl) {
      kasX += SPEED * dt
      if (kasX > totalLen - 4) {
        kasX = 5
        kasY = 1.8
        vy = 0
        onGround = true
        goalHit.clear()
        // Reset coin visibility for attract loop
        markers.forEach(m => {
          m.userData.alive = true
          m.visible = true
        })
      }
      // Auto-jump
      if (onGround && Math.sin(t * 2.1) > 0.8) {
        vy = JUMP
        onGround = false
      }
    }

    // Physics
    vy += GRAV * dt
    let newY = kasY + vy * dt
    if (newY <= 1.8) {
      newY = 1.8
      vy = 0
      onGround = true
    }
    kasY = newY

    // Update Kasimir position
    kasimir.position.set(kasX, kasY, 0.3)
    kasimir.rotation.z = Math.sin(t * 11) * 0.04
    blob.position.set(kasX, 0.03, 0)
    blob.scale.setScalar(1 - (kasY - 1.8) * 0.12)
    kLight.position.set(kasX, kasY + 1, 3)

    // Camera follow
    camera.position.x += (kasX - camera.position.x) * Math.min(1, dt * 4)
    camera.position.y = 3.4 + Math.sin(t * 1.2) * 0.15
    camera.position.z = 13
    camera.lookAt(camera.position.x, 2.4, 0)

    // Coin collection
    markers.forEach(coin => {
      if (!coin.userData.alive) return
      coin.rotation.y += dt * 3
      if (Math.abs(coin.position.x - kasX) < 1.2 && Math.abs(coin.position.y - kasY) < 1.6) {
        coin.userData.alive = false
        coin.visible = false
      }
    })

    // Goal reach check (player-control mode only, for onPickTrack)
    if (playerControl) {
      zoneMeta.forEach((zm, zi) => {
        const zoneId = model.zones[zi]?.id
        if (zoneId && !goalHit.has(zoneId) && !zm.locked && Math.abs(kasX - zm.goalX) < 1.3) {
          goalHit.add(zoneId)
          opts.onPickTrack(zoneId)
        }
      })
    }

    renderer.render(scene, camera)
    rafId = requestAnimationFrame(tick)
  }

  return {
    start() {
      if (started) return
      started = true
      resizeToCanvas()
      clock.start()
      rafId = requestAnimationFrame(tick)
    },
    stop() {
      if (rafId) {
        cancelAnimationFrame(rafId)
        rafId = 0
      }
      started = false
    },
    setPlayerControl(on: boolean) {
      playerControl = on
    },
  }
}
