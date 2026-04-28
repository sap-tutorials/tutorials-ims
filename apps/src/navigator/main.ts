import { createApp } from 'vue'
import TutorialNavigator from './TutorialNavigator.vue'

const el = document.getElementById('tutorial-navigator')
if (el) createApp(TutorialNavigator).mount(el)
