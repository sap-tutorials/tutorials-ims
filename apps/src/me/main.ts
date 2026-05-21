import { createApp } from 'vue'
import MyCompletions from './MyCompletions.vue'

const el = document.getElementById('me-completions')
if (el) createApp(MyCompletions).mount(el)
