import { createApp, ref, h } from 'vue'
import TutorialNavigatorDropdown from './TutorialNavigatorDropdown.vue'

const el = document.getElementById('nav-dropdown-mount')
const toggle = document.getElementById('nav-dropdown-toggle')

if (el) {
  const slug = el.dataset.slug || ''

  const app = createApp({
    setup() {
      const isOpen = ref(false)

      function handleToggle() {
        isOpen.value = !isOpen.value
        toggle?.setAttribute('aria-expanded', String(isOpen.value))
      }

      function handleClose() {
        isOpen.value = false
        toggle?.setAttribute('aria-expanded', 'false')
      }

      if (toggle) {
        toggle.addEventListener('click', handleToggle)
      }

      return () => h(TutorialNavigatorDropdown, {
        currentSlug: slug,
        isOpen: isOpen.value,
        toggleElement: toggle,
        onClose: handleClose,
      })
    },
  })
  app.mount(el)
}
