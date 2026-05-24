import { createApp } from 'vue'
import CommandPalette from './CommandPalette.vue'

const el = document.getElementById('cmd-palette')
if (el) createApp(CommandPalette).mount(el)
