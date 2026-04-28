import { createApp, ref } from 'vue'
import TutorialNavigatorDropdown from './TutorialNavigatorDropdown.vue'

const el = document.getElementById('nav-dropdown-mount')
const toggle = document.getElementById('nav-dropdown-toggle')
if (el) {
  const slug = el.dataset.slug || ''
  const isOpen = ref(false)

  if (toggle) {
    toggle.addEventListener('click', () => {
      isOpen.value = !isOpen.value
      toggle.setAttribute('aria-expanded', String(isOpen.value))
    })
  }

  const app = createApp(TutorialNavigatorDropdown, {
    currentSlug: slug,
    isOpen,
    toggleElement: toggle,
  })
  app.mount(el)
}
