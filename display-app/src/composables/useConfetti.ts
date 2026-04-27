import { ref, watch, type Ref } from 'vue'

export interface ConfettiParticle {
  id: number
  x: number
  y: number
  color: string
  size: number
  rotation: number
  delay: number
  shape: 'square' | 'circle' | 'strip'
}

const MILESTONES = [100, 250, 500, 1000, 1500, 2000, 2500, 3000, 4000, 5000,
  6000, 7000, 8000, 9000, 10000, 12000, 15000, 20000]

function getNextMilestone(count: number): number {
  for (const m of MILESTONES) {
    if (m > count) return m
  }
  return Math.ceil(count / 500) * 500 + 500
}

export function useConfetti(totalCount: Ref<number>, isDemo: Ref<boolean>) {
  const particles = ref<ConfettiParticle[]>([])
  const active = ref(false)
  let nextMilestone = 0
  let idCounter = 0
  let demoTimer: ReturnType<typeof setTimeout> | null = null

  function getThemeColors(): string[] {
    const el = document.documentElement
    const style = getComputedStyle(el)
    return [
      style.getPropertyValue('--d-confetti-1').trim() || '#0070f2',
      style.getPropertyValue('--d-confetti-2').trim() || '#0064d9',
      style.getPropertyValue('--d-confetti-3').trim() || '#107e3e',
    ]
  }

  function burst() {
    const colors = getThemeColors()
    const shapes: ConfettiParticle['shape'][] = ['square', 'circle', 'strip']
    const count = 50 + Math.floor(Math.random() * 20)
    const newParticles: ConfettiParticle[] = []

    for (let i = 0; i < count; i++) {
      newParticles.push({
        id: ++idCounter,
        x: 20 + Math.random() * 60,
        y: -10 - Math.random() * 20,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 6 + Math.random() * 10,
        rotation: Math.random() * 360,
        delay: Math.random() * 0.6,
        shape: shapes[Math.floor(Math.random() * shapes.length)],
      })
    }

    particles.value = newParticles
    active.value = true

    setTimeout(() => {
      particles.value = []
      active.value = false
    }, 3500)
  }

  watch(totalCount, (val) => {
    if (nextMilestone === 0) {
      nextMilestone = getNextMilestone(val)
      return
    }
    if (val >= nextMilestone) {
      burst()
      nextMilestone = getNextMilestone(val)
    }
  })

  watch(isDemo, (demo) => {
    if (demo) {
      demoTimer = setTimeout(() => {
        burst()
        const loop = () => {
          demoTimer = setTimeout(() => {
            burst()
            loop()
          }, 25000 + Math.random() * 15000)
        }
        loop()
      }, 8000)
    } else if (demoTimer) {
      clearTimeout(demoTimer)
      demoTimer = null
    }
  }, { immediate: true })

  return { particles, active }
}
