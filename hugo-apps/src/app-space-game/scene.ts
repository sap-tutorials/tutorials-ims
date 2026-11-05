// Builds the static arcade world from a WorldLayout and returns handles for the
// pieces that animate (coins, flags, chests, gate lamps, clouds, sky tint).

import * as THREE from 'three'
import type { WorldLayout } from './layout'
import { zoneColor } from './level-model'
import { COIN_Y } from './layout'
import {
  groundSideTexture, grassTexture, crateTexture, chestTexture, hazardStripeTexture, windowsTexture,
  softDotTexture, cloudTexture, flagTexture, signTexture, seeded,
} from './textures'

const GROUND_DEPTH = 8     // z extent of the play strip (z ∈ [-5, 3])
const GROUND_BACK = -5
const GROUND_FRONT = 3
const GROUND_THICK = 7

export interface CoinView {
  mesh: THREE.Mesh
  baseY: number
  alive: boolean
  collectable: boolean
}
export interface FlagView { cloth: THREE.Mesh; base: Float32Array; x: number; locked: boolean; phase: number }
export interface ChestView { lid: THREE.Group; glow: THREE.Sprite; x: number; locked: boolean; open: number }
export interface GateView { lamp: THREE.Mesh; glow: THREE.Sprite; x: number; lit: boolean }

export interface SceneHandles {
  coins: CoinView[]
  flags: FlagView[]
  chests: ChestView[]
  gates: GateView[]
  update(t: number, dt: number, camX: number, kasX: number, zoneIndex: number): void
}

function scaleUV(geo: THREE.BufferGeometry, sx: number, sy: number): THREE.BufferGeometry {
  const uv = geo.getAttribute('uv') as THREE.BufferAttribute
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy)
  uv.needsUpdate = true
  return geo
}

function solidSpans(layout: WorldLayout, from: number, to: number): Array<[number, number]> {
  const pits = [...layout.hazards.pits].sort((a, b) => a.x0 - b.x0)
  const spans: Array<[number, number]> = []
  let x = from
  for (const p of pits) {
    if (p.x0 > x) spans.push([x, p.x0])
    x = Math.max(x, p.x1)
  }
  if (to > x) spans.push([x, to])
  return spans
}

/** Zone sky palette: deep night top, zone-tinted horizon. */
export function zonePalette(colorIndex: number): { top: THREE.Color; horizon: THREE.Color; fog: THREE.Color } {
  const accent = new THREE.Color(zoneColor(colorIndex))
  const top = new THREE.Color('#070b1f').lerp(accent, 0.12)
  const horizon = new THREE.Color('#2a1f55').lerp(accent, 0.45)
  const fog = horizon.clone().lerp(new THREE.Color('#0d1230'), 0.35)
  return { top, horizon, fog }
}

export function buildScene(scene: THREE.Scene, layout: WorldLayout): SceneHandles {
  const L0 = -40
  const L1 = layout.length + 40
  const rnd = seeded(2026)

  // ---------- Sky (screen-filling gradient that follows the camera) ----------
  const skyUniforms = {
    uTop: { value: new THREE.Color('#070b1f') },
    uHorizon: { value: new THREE.Color('#2a1f55') },
  }
  const sky = new THREE.Mesh(
    new THREE.PlaneGeometry(400, 160),
    new THREE.ShaderMaterial({
      uniforms: skyUniforms,
      depthWrite: false,
      fog: false,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader:
        'uniform vec3 uTop; uniform vec3 uHorizon; varying vec2 vUv;' +
        'void main(){ float t = smoothstep(0.25, 0.85, vUv.y); gl_FragColor = vec4(mix(uHorizon, uTop, t), 1.0); }',
    }),
  )
  sky.position.set(0, 30, -120)
  sky.renderOrder = -10
  scene.add(sky)

  // Stars (far, nearly fixed)
  const starGeo = new THREE.BufferGeometry()
  const starPos = new Float32Array(900 * 3)
  for (let i = 0; i < 900; i++) {
    starPos[i * 3] = (rnd() - 0.5) * 360
    starPos[i * 3 + 1] = 12 + rnd() * 70
    starPos[i * 3 + 2] = -110
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3))
  const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, transparent: true, opacity: 0.85, fog: false })
  const stars = new THREE.Points(starGeo, starMat)
  scene.add(stars)

  // Moon with halo
  const moon = new THREE.Group()
  const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: softDotTexture('rgba(255,240,200,0.55)', 'rgba(255,240,200,0)'), fog: false, depthWrite: false }))
  halo.scale.set(40, 40, 1)
  const disc = new THREE.Mesh(new THREE.CircleGeometry(5, 48), new THREE.MeshBasicMaterial({ color: 0xfff1cc, fog: false }))
  moon.add(halo, disc)
  moon.position.set(40, 48, -105)
  scene.add(moon)

  // Clouds (slow drift)
  const clouds: THREE.Sprite[] = []
  for (let i = 0; i < 26; i++) {
    const m = new THREE.SpriteMaterial({ map: cloudTexture(i + 3), transparent: true, opacity: 0.18 + rnd() * 0.18, depthWrite: false, fog: false })
    const c = new THREE.Sprite(m)
    const s = 14 + rnd() * 18
    c.scale.set(s, s * 0.45, 1)
    c.position.set(L0 + rnd() * (L1 - L0), 22 + rnd() * 22, -70 - rnd() * 15)
    c.userData.speed = 0.4 + rnd() * 0.8
    clouds.push(c)
    scene.add(c)
  }

  // ---------- Far mountains + mid hills (silhouettes) ----------
  const ridge = (z: number, baseY: number, amp: number, color: string, seed: number, step: number) => {
    const r = seeded(seed)
    const shape = new THREE.Shape()
    shape.moveTo(L0 - 60, -20)
    let y = baseY
    for (let x = L0 - 60; x <= L1 + 60; x += step) {
      y = baseY + Math.sin(x * 0.05 + seed) * amp * 0.5 + (r() - 0.5) * amp
      shape.lineTo(x, y)
    }
    shape.lineTo(L1 + 60, -20)
    shape.lineTo(L0 - 60, -20)
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(shape), new THREE.MeshBasicMaterial({ color, fog: false }))
    mesh.position.z = z
    scene.add(mesh)
  }
  ridge(-90, 20, 14, '#1b1f4a', 7, 9)
  ridge(-68, 10, 8, '#22285c', 9, 6)

  // ---------- Skyline (instanced buildings with lit windows) ----------
  const buildingCount = Math.ceil((L1 - L0) / 3.2)
  const bGeo = scaleUV(new THREE.BoxGeometry(1, 1, 1), 1, 2)
  const bMat = new THREE.MeshStandardMaterial({
    color: 0x151a36,
    roughness: 0.9,
    emissive: 0xffffff,
    emissiveMap: windowsTexture(3),
    emissiveIntensity: 0.32,
  })
  const buildings = new THREE.InstancedMesh(bGeo, bMat, buildingCount)
  const m4 = new THREE.Matrix4()
  const q = new THREE.Quaternion()
  for (let i = 0; i < buildingCount; i++) {
    const w = 2.4 + rnd() * 2.6
    const h = 6 + rnd() * 14
    m4.compose(new THREE.Vector3(L0 + i * 3.2 + rnd(), h / 2 - 2, -52 - rnd() * 8), q, new THREE.Vector3(w, h, 2.5))
    buildings.setMatrixAt(i, m4)
  }
  buildings.instanceMatrix.needsUpdate = true
  scene.add(buildings)

  // Neon roof strips in each zone's colour
  for (const z of layout.zones) {
    const col = new THREE.Color(zoneColor(z.colorIndex)).lerp(new THREE.Color('#ffffff'), 0.25)
    for (let k = 0; k < 3; k++) {
      const bar = new THREE.Mesh(
        new THREE.BoxGeometry(3 + rnd() * 3, 0.25, 0.25),
        new THREE.MeshBasicMaterial({ color: col }),
      )
      bar.position.set(z.x0 + 4 + rnd() * Math.max(1, z.x1 - z.x0 - 8), 8 + rnd() * 8, -49)
      scene.add(bar)
    }
  }

  // ---------- Near trees + lamp posts ----------
  const treeCount = Math.ceil((L1 - L0) / 5)
  const trunkGeo = new THREE.CylinderGeometry(0.18, 0.25, 1.6, 6)
  const crownGeo = new THREE.ConeGeometry(1.3, 3.2, 7)
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x4a2f22, roughness: 1 })
  const crownMat = new THREE.MeshStandardMaterial({ color: 0x1f6b48, roughness: 0.8, flatShading: true })
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, treeCount)
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, treeCount * 2)
  for (let i = 0; i < treeCount; i++) {
    const x = L0 + i * 5 + rnd() * 3
    const z = -7.5 - rnd() * 4
    const s = 0.8 + rnd() * 0.7
    m4.compose(new THREE.Vector3(x, 0.8 * s, z), q, new THREE.Vector3(s, s, s))
    trunks.setMatrixAt(i, m4)
    m4.compose(new THREE.Vector3(x, (1.6 + 1.3) * s, z), q, new THREE.Vector3(s, s, s))
    crowns.setMatrixAt(i * 2, m4)
    m4.compose(new THREE.Vector3(x, (1.6 + 2.6) * s, z), q, new THREE.Vector3(s * 0.75, s * 0.75, s * 0.75))
    crowns.setMatrixAt(i * 2 + 1, m4)
    crowns.setColorAt(i * 2, new THREE.Color().setHSL(0.38 + rnd() * 0.06, 0.5, 0.22 + rnd() * 0.08))
    crowns.setColorAt(i * 2 + 1, new THREE.Color().setHSL(0.38 + rnd() * 0.06, 0.5, 0.28 + rnd() * 0.08))
  }
  trunks.instanceMatrix.needsUpdate = true
  crowns.instanceMatrix.needsUpdate = true
  if (crowns.instanceColor) crowns.instanceColor.needsUpdate = true
  scene.add(trunks, crowns)

  const lampGlowTex = softDotTexture('rgba(255,214,140,0.9)', 'rgba(255,214,140,0)')
  const lampPostMat = new THREE.MeshStandardMaterial({ color: 0x2b3245, metalness: 0.6, roughness: 0.4 })
  const lampPostGeo = new THREE.CylinderGeometry(0.08, 0.1, 4.2, 6)
  for (let x = 8; x < layout.length; x += 14) {
    const post = new THREE.Mesh(lampPostGeo, lampPostMat)
    post.position.set(x, 2.1, -4.6)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: lampGlowTex, transparent: true, depthWrite: false }))
    glow.scale.set(2.6, 2.6, 1)
    glow.position.set(x, 4.3, -4.5)
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), new THREE.MeshBasicMaterial({ color: 0xffe2a8 }))
    bulb.position.set(x, 4.3, -4.6)
    scene.add(post, glow, bulb)
  }

  // ---------- Ground with real pits ----------
  const sideTex = groundSideTexture()
  const grassTex = grassTexture()
  const earthMat = new THREE.MeshStandardMaterial({ map: sideTex, roughness: 1 })
  const topMat = new THREE.MeshStandardMaterial({ color: 0x3c9b46, roughness: 0.9 })
  const lipMat = new THREE.MeshStandardMaterial({ map: grassTex, roughness: 0.9 })
  for (const [a, b] of solidSpans(layout, L0, L1)) {
    const w = b - a
    const geo = scaleUV(new THREE.BoxGeometry(w, GROUND_THICK, GROUND_DEPTH), w / 4, GROUND_THICK / 4)
    const block = new THREE.Mesh(geo, [earthMat, earthMat, topMat, earthMat, earthMat, earthMat])
    block.position.set((a + b) / 2, -GROUND_THICK / 2, (GROUND_BACK + GROUND_FRONT) / 2)
    block.receiveShadow = true
    scene.add(block)
    const lip = new THREE.Mesh(scaleUV(new THREE.PlaneGeometry(w + 0.1, 0.5), w / 4, 1), lipMat)
    lip.position.set((a + b) / 2, -0.2, GROUND_FRONT + 0.01)
    scene.add(lip)
  }
  // Pit interiors: dark shaft with a faint glow far below + warning stripes at the rims
  const stripeTex = hazardStripeTexture()
  const pitWallMat = new THREE.MeshBasicMaterial({ color: 0x06040d })
  const pitGlowMat = new THREE.MeshBasicMaterial({ map: softDotTexture('rgba(150,60,255,0.55)', 'rgba(150,60,255,0)'), transparent: true, depthWrite: false })
  for (const p of layout.hazards.pits) {
    const w = p.x1 - p.x0
    const back = new THREE.Mesh(new THREE.PlaneGeometry(w, GROUND_THICK), pitWallMat)
    back.position.set((p.x0 + p.x1) / 2, -GROUND_THICK / 2, GROUND_BACK + 0.02)
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(w * 1.6, 3), pitGlowMat)
    glow.position.set((p.x0 + p.x1) / 2, -GROUND_THICK + 1, GROUND_BACK + 0.05)
    scene.add(back, glow)
    for (const ex of [p.x0, p.x1]) {
      const stripe = new THREE.Mesh(
        scaleUV(new THREE.BoxGeometry(0.22, 0.08, GROUND_DEPTH), 1, 1),
        new THREE.MeshBasicMaterial({ map: stripeTex }),
      )
      stripe.position.set(ex + (ex === p.x0 ? -0.11 : 0.11), 0.04, (GROUND_BACK + GROUND_FRONT) / 2)
      scene.add(stripe)
    }
  }

  // Foreground bushes along the front edge (never overlap Kasimir — they sit low and in front)
  const bushGeo = new THREE.IcosahedronGeometry(0.55, 0)
  const bushMat = new THREE.MeshStandardMaterial({ color: 0x2f8f45, flatShading: true, roughness: 0.8 })
  const flowerMat = new THREE.MeshBasicMaterial({ color: 0xffd34d })
  const bushSpots = solidSpans(layout, L0, L1).flatMap(([a, b]) => {
    const out: number[] = []
    for (let x = a + 1; x < b - 1; x += 3 + rnd() * 4) out.push(x)
    return out
  })
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, Math.max(1, bushSpots.length))
  const flowers = new THREE.InstancedMesh(new THREE.SphereGeometry(0.08, 6, 4), flowerMat, Math.max(1, bushSpots.length))
  bushSpots.forEach((x, i) => {
    const s = 0.6 + rnd() * 0.6
    m4.compose(new THREE.Vector3(x, 0.15 * s, GROUND_FRONT - 0.3), q, new THREE.Vector3(s * 1.4, s * 0.7, s))
    bushes.setMatrixAt(i, m4)
    m4.compose(new THREE.Vector3(x + 0.2, 0.45 * s, GROUND_FRONT - 0.05), q, new THREE.Vector3(1, 1, 1))
    flowers.setMatrixAt(i, m4)
  })
  bushes.count = bushSpots.length
  flowers.count = bushSpots.length
  bushes.instanceMatrix.needsUpdate = true
  flowers.instanceMatrix.needsUpdate = true
  scene.add(bushes, flowers)

  // ---------- Crates ----------
  const crateMat = new THREE.MeshStandardMaterial({ map: crateTexture(), roughness: 0.75 })
  for (const c of layout.hazards.crates) {
    const w = c.x1 - c.x0
    const crate = new THREE.Mesh(new THREE.BoxGeometry(w, c.top, 1.6), crateMat)
    crate.position.set((c.x0 + c.x1) / 2, c.top / 2, 0)
    crate.castShadow = true
    crate.receiveShadow = true
    scene.add(crate)
  }

  // ---------- Spikes ----------
  const spikeCones: THREE.Matrix4[] = []
  const plateMat = new THREE.MeshStandardMaterial({ map: stripeTex, roughness: 0.6 })
  for (const s of layout.hazards.spikes) {
    const w = s.x1 - s.x0
    const plate = new THREE.Mesh(scaleUV(new THREE.BoxGeometry(w, 0.14, 1.5), w / 1.2, 1), plateMat)
    plate.position.set((s.x0 + s.x1) / 2, 0.07, 0)
    plate.receiveShadow = true
    scene.add(plate)
    const n = Math.max(3, Math.round(w / 0.3))
    for (let i = 0; i < n; i++) {
      for (const z of [-0.35, 0.35]) {
        const x = s.x0 + (i + 0.5) * (w / n) + (z > 0 ? 0.06 : -0.06)
        spikeCones.push(new THREE.Matrix4().makeTranslation(x, 0.14 + (s.top - 0.14) / 2, z))
      }
    }
  }
  if (spikeCones.length) {
    const cone = new THREE.InstancedMesh(
      new THREE.ConeGeometry(0.13, 0.42, 6),
      new THREE.MeshStandardMaterial({ color: 0xc9d2de, metalness: 0.85, roughness: 0.25, emissive: 0x551010, emissiveIntensity: 0.4 }),
      spikeCones.length,
    )
    spikeCones.forEach((mm, i) => cone.setMatrixAt(i, mm))
    cone.instanceMatrix.needsUpdate = true
    cone.castShadow = true
    scene.add(cone)
  }

  // ---------- Checkpoint gates (decorative arch behind the path) ----------
  const stoneMat = new THREE.MeshStandardMaterial({ color: 0x8a8fa3, roughness: 0.7 })
  const gates: GateView[] = []
  const amberGlowTex = softDotTexture('rgba(255,190,80,0.9)', 'rgba(255,190,80,0)')
  for (const g of layout.gates) {
    const group = new THREE.Group()
    for (const dx of [-1.7, 1.7]) {
      const p = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 4, 10), stoneMat)
      p.position.set(dx, 2, 0)
      group.add(p)
    }
    const arch = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.2, 8, 28, Math.PI), stoneMat)
    arch.position.set(0, 4, 0)
    group.add(arch)
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xffb02e, emissive: 0xffb02e, emissiveIntensity: 0.15 })
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.35, 16, 12), lampMat)
    lamp.position.set(0, 5.9, 0)
    group.add(lamp)
    const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: amberGlowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }))
    glow.scale.set(3.2, 3.2, 1)
    glow.position.set(0, 5.9, 0.2)
    group.add(glow)
    group.position.set(g.x, 0, -3)
    scene.add(group)
    gates.push({ lamp, glow, x: g.x, lit: false })
  }

  // ---------- Zone signs ----------
  const postMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2c, roughness: 0.9 })
  layout.zones.forEach((z, i) => {
    const color = zoneColor(z.colorIndex)
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 2.6, 8), postMat)
    post.position.set(z.x0 + 2.5, 1.3, -1.8)
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.85, 32), new THREE.MeshStandardMaterial({ map: signTexture(String(i + 1), color), roughness: 0.6 }))
    face.position.set(z.x0 + 2.5, 2.9, -1.7)
    scene.add(post, face)
  })

  // ---------- Goals: flags (track) and chests (prize / checkpoint) ----------
  const flags: FlagView[] = []
  const chests: ChestView[] = []
  const chestTex = chestTexture()
  const poleMat = new THREE.MeshStandardMaterial({ color: 0xd7dde8, metalness: 0.8, roughness: 0.3 })
  const goldMat = new THREE.MeshStandardMaterial({ color: 0xffc94a, metalness: 0.9, roughness: 0.25, emissive: 0x6b4a00, emissiveIntensity: 0.4 })
  layout.zones.forEach((z, i) => {
    const goal = z.goal
    const color = zoneColor(z.colorIndex)
    const gx = goal.x
    if (goal.kind === 'track') {
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.9, 0.5, 16), stoneMat)
      base.position.set(gx, 0.25, -1.2)
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 5, 10), poleMat)
      pole.position.set(gx, 2.5, -1.2)
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.24, 16, 12), goldMat)
      ball.position.set(gx, 5.1, -1.2)
      const clothGeo = new THREE.PlaneGeometry(2.6, 1.6, 16, 4)
      clothGeo.translate(1.3, 0, 0)
      const cloth = new THREE.Mesh(
        clothGeo,
        new THREE.MeshStandardMaterial({ map: flagTexture(color, String(i + 1), goal.locked), side: THREE.DoubleSide, roughness: 0.8 }),
      )
      cloth.position.set(gx + 0.08, goal.locked ? 2.6 : 4.2, -1.2)
      if (goal.locked) cloth.rotation.z = -0.25
      cloth.castShadow = true
      scene.add(base, pole, ball, cloth)
      flags.push({ cloth, base: Float32Array.from(clothGeo.getAttribute('position').array as Float32Array), x: gx, locked: goal.locked, phase: i * 1.7 })
    } else {
      const chest = new THREE.Group()
      const bodyMat = new THREE.MeshStandardMaterial({ map: chestTex, color: goal.locked ? 0x8a8a8a : 0xffffff, roughness: 0.55, metalness: 0.15 })
      const body = new THREE.Mesh(new THREE.BoxGeometry(2, 1.2, 1.3), bodyMat)
      body.position.y = 0.6
      body.castShadow = true
      chest.add(body)
      if (!goal.locked) {
        const treasure = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.2, 1.0), goldMat)
        treasure.position.set(0, 1.47, 0)
        chest.add(treasure)
      }
      for (const dx of [-0.75, 0.75]) {
        const band = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.24, 1.34), goldMat)
        band.position.set(dx, 0.6, 0)
        chest.add(band)
      }
      const lid = new THREE.Group()
      lid.position.set(0, 1.2, -0.65)
      const lidMesh = new THREE.Mesh(new THREE.CylinderGeometry(0.65, 0.65, 2, 16, 1, false, 0, Math.PI), bodyMat)
      lidMesh.rotation.z = Math.PI / 2
      lidMesh.rotation.y = Math.PI / 2
      lidMesh.position.set(0, 0, 0.65)
      lid.add(lidMesh)
      chest.add(lid)
      const glow = new THREE.Sprite(new THREE.SpriteMaterial({ map: amberGlowTex, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }))
      glow.scale.set(4, 4, 1)
      glow.position.set(0, 1.9, 0.3)
      chest.add(glow)
      if (goal.locked) {
        const lock = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.15), goldMat)
        lock.position.set(0, 1.0, 0.7)
        const shackle = new THREE.Mesh(new THREE.TorusGeometry(0.14, 0.04, 6, 16, Math.PI), goldMat)
        shackle.position.set(0, 1.2, 0.7)
        chest.add(lock, shackle)
      }
      const plinth = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.7, 0.3, 20), new THREE.MeshStandardMaterial({ color, roughness: 0.6 }))
      plinth.position.y = -0.15 + 0.15
      chest.add(plinth)
      body.position.y += 0.3
      lid.position.y += 0.3
      chest.position.set(gx, 0, -1.2)
      scene.add(chest)
      chests.push({ lid, glow, x: gx, locked: goal.locked, open: 0 })
    }
  })

  // ---------- Coins ----------
  const coinGeo = new THREE.TorusGeometry(0.42, 0.13, 12, 28)
  const coinMats = {
    open: new THREE.MeshStandardMaterial({ color: 0xffc23a, metalness: 0.9, roughness: 0.2, emissive: 0x8a5a00, emissiveIntensity: 0.55 }),
    done: new THREE.MeshStandardMaterial({ color: 0x5fe07a, metalness: 0.7, roughness: 0.25, emissive: 0x1d6b2d, emissiveIntensity: 0.6 }),
    locked: new THREE.MeshStandardMaterial({ color: 0x777b88, metalness: 0.4, roughness: 0.6, transparent: true, opacity: 0.45 }),
  }
  const coins: CoinView[] = layout.coins.map(c => {
    const mat = !c.available ? coinMats.locked : c.done ? coinMats.done : coinMats.open
    const mesh = new THREE.Mesh(coinGeo, mat)
    mesh.position.set(c.x, COIN_Y, 0)
    mesh.castShadow = c.available
    scene.add(mesh)
    return { mesh, baseY: COIN_Y, alive: true, collectable: c.available }
  })

  // ---------- Per-frame animation ----------
  const fog = scene.fog as THREE.Fog | null
  const target = { top: new THREE.Color(), horizon: new THREE.Color(), fog: new THREE.Color() }
  let lastZone = -2

  function update(t: number, dt: number, camX: number, kasX: number, zoneIndex: number): void {
    sky.position.x = camX
    stars.position.x = camX * 0.92
    moon.position.x = camX * 0.95 + 40
    starMat.opacity = 0.7 + Math.sin(t * 1.3) * 0.15

    for (const c of clouds) {
      c.position.x += c.userData.speed * dt
      if (c.position.x > camX + 160) c.position.x -= 320
    }

    if (zoneIndex !== lastZone && zoneIndex >= 0) {
      const p = zonePalette(layout.zones[zoneIndex].colorIndex)
      target.top.copy(p.top)
      target.horizon.copy(p.horizon)
      target.fog.copy(p.fog)
      if (lastZone === -2) {
        skyUniforms.uTop.value.copy(p.top)
        skyUniforms.uHorizon.value.copy(p.horizon)
        fog?.color.copy(p.fog)
      }
      lastZone = zoneIndex
    }
    const k = Math.min(1, dt * 1.5)
    skyUniforms.uTop.value.lerp(target.top, k)
    skyUniforms.uHorizon.value.lerp(target.horizon, k)
    fog?.color.lerp(target.fog, k)

    for (const c of coins) {
      if (!c.alive) continue
      c.mesh.rotation.y += dt * 2.6
      c.mesh.position.y = c.baseY + Math.sin(t * 2.2 + c.mesh.position.x * 0.7) * 0.1
    }

    for (const f of flags) {
      if (f.locked) continue
      const pos = f.cloth.geometry.getAttribute('position') as THREE.BufferAttribute
      const arr = pos.array as Float32Array
      for (let i = 0; i < pos.count; i++) {
        const bx = f.base[i * 3]
        const amp = bx * 0.12
        arr[i * 3 + 2] = f.base[i * 3 + 2] + Math.sin(t * 4 + bx * 2.2 + f.phase) * amp
        arr[i * 3 + 1] = f.base[i * 3 + 1] + Math.sin(t * 3 + bx * 1.6 + f.phase) * amp * 0.25
      }
      pos.needsUpdate = true
      f.cloth.geometry.computeVertexNormals()
    }

    for (const ch of chests) {
      const near = !ch.locked && Math.abs(kasX - ch.x) < 3.2
      ch.open += ((near ? 1 : 0) - ch.open) * Math.min(1, dt * 5)
      ch.lid.rotation.x = -ch.open * 1.15
      ;(ch.glow.material as THREE.SpriteMaterial).opacity = ch.locked ? 0 : 0.25 + ch.open * 0.6 + Math.sin(t * 3) * 0.05
    }

    for (const g of gates) {
      if (!g.lit && kasX > g.x) g.lit = true
      const mat = g.lamp.material as THREE.MeshStandardMaterial
      const targetI = g.lit ? 1.4 + Math.sin(t * 4) * 0.2 : 0.15
      mat.emissiveIntensity += (targetI - mat.emissiveIntensity) * Math.min(1, dt * 6)
      ;(g.glow.material as THREE.SpriteMaterial).opacity = g.lit ? 0.85 : 0
    }
  }

  return { coins, flags, chests, gates, update }
}
