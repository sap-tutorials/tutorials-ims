import { ref } from 'vue'

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

function getThemeColors(): string[] {
  const el = document.documentElement
  const style = getComputedStyle(el)
  return [
    style.getPropertyValue('--d-confetti-1').trim() || '#0070f2',
    style.getPropertyValue('--d-confetti-2').trim() || '#0064d9',
    style.getPropertyValue('--d-confetti-3').trim() || '#107e3e',
  ]
}

export function useConfetti() {
  const particles = ref<ConfettiParticle[]>([])
  const active = ref(false)
  let idCounter = 0

  function burst() {
    const colors = getThemeColors()
    const shapes: ConfettiParticle['shape'][] = ['square', 'circle', 'strip']
    const count = 70 + Math.floor(Math.random() * 30)
    const newParticles: ConfettiParticle[] = []

    for (let i = 0; i < count; i++) {
      newParticles.push({
        id: ++idCounter,
        x: 10 + Math.random() * 80,
        y: -10 - Math.random() * 20,
        color: colors[Math.floor(Math.random() * colors.length)],
        size: 6 + Math.random() * 12,
        rotation: Math.random() * 360,
        delay: Math.random() * 0.8,
        shape: shapes[Math.floor(Math.random() * shapes.length)],
      })
    }

    particles.value = newParticles
    active.value = true

    setTimeout(() => {
      particles.value = []
      active.value = false
    }, 4000)
  }

  return { particles, active, burst }
}
