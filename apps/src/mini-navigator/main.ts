import { createApp } from 'vue'
import MiniNavigator from './MiniNavigator.vue'

const el = document.getElementById('mini-navigator-mount')
if (el) {
  const app = createApp(MiniNavigator, {
    currentSlug: el.dataset.slug || '',
    missionId: el.dataset.missionId ? parseInt(el.dataset.missionId, 10) : null,
  })
  app.mount(el)
}
