import { createApp } from 'vue'
import TutorialNavigator from './TutorialNavigator.vue'

// The navigator page already emits an SSR preview (first 24 cards) in static
// HTML so users see real content immediately. Deferring the Vue mount to an
// idle frame breaks the single long JS task that was causing TBT ~2.1s
// (navigator page, Lighthouse median-of-3). The `timeout: 200` ensures mount
// happens within 200ms even on a saturated main thread.
const el = document.getElementById('tutorial-navigator')
if (el) {
  const mount = () => createApp(TutorialNavigator).mount(el)
  if (typeof requestIdleCallback !== 'undefined') {
    requestIdleCallback(mount, { timeout: 200 })
  } else {
    setTimeout(mount, 0)
  }
}
