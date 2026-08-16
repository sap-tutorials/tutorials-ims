import { createApp, ref, h } from 'vue'
import TutorialNavigatorDropdown from './TutorialNavigatorDropdown.vue'
import { readFromParam } from '@shared/group-nav-context'

const el = document.getElementById('nav-dropdown-mount')
const toggle = document.getElementById('nav-dropdown-toggle')

if (el) {
  const slug = el.dataset.slug || ''
  // #1836: honour the entry group so the dropdown shows in-group siblings.
  const fromGroupSlug = readFromParam(location.search)

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
        fromGroupSlug,
        isOpen: isOpen.value,
        toggleElement: toggle,
        onClose: handleClose,
      })
    },
  })
  app.mount(el)
}
