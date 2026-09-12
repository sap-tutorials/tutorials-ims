import { createApp } from 'vue'
import LearningPath from './LearningPath.vue'

const target = document.querySelector<HTMLElement>('[data-vue-island="learning-path"]')
if (target) {
  const goalType = (target.getAttribute('data-goal-type') || 'tutorial') as any
  createApp(LearningPath, { goalType }).mount(target)
}
