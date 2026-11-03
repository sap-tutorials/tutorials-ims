import { createApp } from 'vue'
import AppSpaceGame from './AppSpaceGame.vue'

const el = document.getElementById('app-space-game')
if (el) createApp(AppSpaceGame).mount(el)
