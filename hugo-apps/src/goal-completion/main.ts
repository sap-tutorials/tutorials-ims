import { createApp } from 'vue'
import GoalCompletion from './GoalCompletion.vue'

// Mount the per-user Group/Mission completion indicator. The renderer stamps
// the goal's tutorial slugs onto the mount node as a JSON array in
// data-tutorial-slugs; parse defensively and fail-open to an empty list.
const target = document.querySelector<HTMLElement>('[data-vue-island="goal-completion"]')
if (target) {
  let tutorialSlugs: string[] = []
  try {
    const raw = target.getAttribute('data-tutorial-slugs')
    const parsed = raw ? JSON.parse(raw) : []
    if (Array.isArray(parsed)) tutorialSlugs = parsed.filter((s) => typeof s === 'string')
  } catch {
    tutorialSlugs = []
  }
  createApp(GoalCompletion, { tutorialSlugs }).mount(target)
}
