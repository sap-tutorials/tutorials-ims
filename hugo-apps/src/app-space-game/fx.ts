// Lightweight pooled particle effects: pickup sparkles, scattered rings, dust, confetti.

import * as THREE from 'three'
import { sparkleTexture, softDotTexture } from './textures'

interface Particle {
  obj: THREE.Object3D
  mat: THREE.Material & { opacity: number }
  vx: number
  vy: number
  vz: number
  life: number
  max: number
  gravity: number
  spin: number
  bounce: boolean
  grow: number
  active: boolean
}

const CONFETTI = [0xff5a5f, 0xffc23a, 0x4cd97b, 0x3fa9ff, 0xb276ff, 0xffffff]

export class Effects {
  private pool: Particle[] = []
  private sparkleTex = sparkleTexture()
  private dustTex = softDotTexture('rgba(230,220,200,0.8)', 'rgba(230,220,200,0)')
  private ringGeo = new THREE.TorusGeometry(0.32, 0.1, 8, 20)
  private confettiGeo = new THREE.PlaneGeometry(0.16, 0.26)

  constructor(private scene: THREE.Scene) {}

  private spawn(kind: 'sprite' | 'ring' | 'confetti', make: () => Particle): Particle {
    const free = this.pool.find(p => !p.active && p.obj.userData.kind === kind)
    if (free) {
      free.active = true
      free.obj.visible = true
      return free
    }
    const p = make()
    p.obj.userData.kind = kind
    this.scene.add(p.obj)
    this.pool.push(p)
    return p
  }

  private sprite(tex: THREE.Texture, additive: boolean): Particle {
    const p = this.spawn('sprite', () => {
      const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
      return this.blank(new THREE.Sprite(mat), mat)
    })
    const m = p.mat as THREE.SpriteMaterial
    const blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending
    if (m.map !== tex || m.blending !== blending) {
      m.map = tex
      m.blending = blending
      m.needsUpdate = true
    }
    return p
  }

  private blank(obj: THREE.Object3D, mat: THREE.Material & { opacity: number }): Particle {
    return { obj, mat, vx: 0, vy: 0, vz: 0, life: 0, max: 1, gravity: 0, spin: 0, bounce: false, grow: 0, active: true }
  }

  sparkle(x: number, y: number): void {
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2
      const p = this.sprite(this.sparkleTex, true)
      p.obj.position.set(x, y, 0.4)
      const s = 0.5 + Math.random() * 0.4
      p.obj.scale.set(s, s, 1)
      Object.assign(p, { vx: Math.cos(a) * 4, vy: Math.sin(a) * 4 + 1, vz: 0, life: 0, max: 0.45, gravity: -6, spin: 0, bounce: false, grow: -1 })
      p.mat.opacity = 1
    }
  }

  dust(x: number, y: number, dir: number): void {
    for (let i = 0; i < 6; i++) {
      const p = this.sprite(this.dustTex, false)
      p.obj.position.set(x + (Math.random() - 0.5) * 0.6, y + 0.1, 0.5)
      p.obj.scale.set(0.5, 0.5, 1)
      Object.assign(p, { vx: (Math.random() - 0.5) * 3 - dir * 1.2, vy: 0.6 + Math.random(), vz: 0, life: 0, max: 0.5, gravity: 0, spin: 0, bounce: false, grow: 1.6 })
      p.mat.opacity = 0.7
    }
  }

  scatterRings(x: number, y: number, count: number): void {
    const n = Math.min(count, 16)
    for (let i = 0; i < n; i++) {
      const p = this.spawn('ring', () => {
        const mat = new THREE.MeshStandardMaterial({ color: 0xffc23a, metalness: 0.9, roughness: 0.2, emissive: 0x8a5a00, emissiveIntensity: 0.6, transparent: true })
        return this.blank(new THREE.Mesh(this.ringGeo, mat), mat)
      })
      const a = Math.PI * (0.15 + 0.7 * (i / Math.max(1, n - 1)))
      p.obj.position.set(x, y + 1, 0.3)
      Object.assign(p, { vx: Math.cos(a) * 6, vy: Math.sin(a) * 8, vz: (Math.random() - 0.5) * 2, life: 0, max: 1.3, gravity: -22, spin: 8, bounce: true, grow: 0 })
      p.obj.scale.setScalar(1)
      p.mat.opacity = 1
    }
  }

  confetti(x: number, y: number): void {
    for (let i = 0; i < 60; i++) {
      const p = this.spawn('confetti', () => {
        const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true })
        return this.blank(new THREE.Mesh(this.confettiGeo, mat), mat)
      })
      ;(p.mat as THREE.MeshBasicMaterial).color.setHex(CONFETTI[i % CONFETTI.length])
      p.obj.position.set(x + (Math.random() - 0.5) * 1.5, y, 0.6)
      p.obj.rotation.set(Math.random() * 3, Math.random() * 3, 0)
      Object.assign(p, {
        vx: (Math.random() - 0.5) * 9, vy: 7 + Math.random() * 7, vz: (Math.random() - 0.5) * 3,
        life: 0, max: 2.2, gravity: -12, spin: 6 + Math.random() * 6, bounce: false, grow: 0,
      })
      p.mat.opacity = 1
    }
  }

  update(dt: number): void {
    for (const p of this.pool) {
      if (!p.active) continue
      p.life += dt
      if (p.life >= p.max) {
        p.active = false
        p.obj.visible = false
        continue
      }
      p.vy += p.gravity * dt
      p.obj.position.x += p.vx * dt
      p.obj.position.y += p.vy * dt
      p.obj.position.z += p.vz * dt
      if (p.bounce && p.obj.position.y < 0.35 && p.vy < 0) {
        p.obj.position.y = 0.35
        p.vy *= -0.55
        p.vx *= 0.8
      }
      if (p.spin) {
        p.obj.rotation.x += p.spin * dt
        p.obj.rotation.y += p.spin * 0.7 * dt
      }
      if (p.grow) p.obj.scale.multiplyScalar(1 + p.grow * dt)
      const k = p.life / p.max
      p.mat.opacity = k < 0.6 ? p.mat.opacity : Math.max(0, (1 - k) / 0.4)
    }
  }

  dispose(): void {
    for (const p of this.pool) {
      this.scene.remove(p.obj)
      p.mat.dispose()
    }
    this.pool = []
    this.sparkleTex.dispose()
    this.dustTex.dispose()
    this.ringGeo.dispose()
    this.confettiGeo.dispose()
  }
}
