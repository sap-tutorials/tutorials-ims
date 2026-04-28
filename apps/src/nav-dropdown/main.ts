import { createApp } from 'vue'
import TutorialNavigatorDropdown from './TutorialNavigatorDropdown.vue'

const el = document.getElementById('nav-dropdown-mount')
if (el) {
  const slug = el.dataset.slug || ''
  const app = createApp(TutorialNavigatorDropdown, {
    currentSlug: slug,
    isOpen: false,
    toggleElement: null,
  })
  app.mount(el)
}
