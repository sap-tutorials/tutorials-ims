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

export function useConfetti() {
  const particles = ref<ConfettiParticle[]>([])
  const active = ref(false)
  let idCounter = 0

  function getThemeColors(): string[] {
    const el = document.documentElement
    const style = getComputedStyle(el)
    return [
      style.getPropertyValue('--d-confetti-1').trim() || '#0070f2',
      style.getPropertyValue('--d-confetti-2').trim() || '#0064d9',
      style.getPropertyValue('--d-confetti-3').trim() || '#107e3e',
    ]
  }

  function fireConfetti(intensity: 'normal' | 'large' = 'normal') {
    const colors = getThemeColors()
    const shapes: ConfettiParticle['shape'][] = ['square', 'circle', 'strip']
    const count = intensity === 'large' ? 80 : 50

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

  return { particles, active, fireConfetti }
}
