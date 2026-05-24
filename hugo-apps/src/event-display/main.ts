import { createApp } from 'vue'
import EventDisplay from './EventDisplay.vue'

const el = document.getElementById('event-display')
if (el) createApp(EventDisplay).mount(el)
