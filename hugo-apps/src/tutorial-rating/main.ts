import { createApp } from 'vue'
import TutorialRating from './TutorialRating.vue'

const el = document.getElementById('tutorial-rating-mount')
if (el) {
  const slug = el.dataset.slug || ''
  if (slug) createApp(TutorialRating, { slug }).mount(el)
}
