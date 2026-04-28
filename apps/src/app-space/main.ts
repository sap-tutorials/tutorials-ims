import { createApp } from 'vue'
import AppSpace from './AppSpace.vue'

const el = document.getElementById('app-space')
if (el) createApp(AppSpace).mount(el)
