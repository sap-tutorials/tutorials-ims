import { createApp } from 'vue'
import Selfie from './Selfie.vue'
import type { MountConfig } from './types'
import './styles.css'
const el = document.getElementById('selfie-mount')
if (el) {
  const d = el.dataset
  const config: MountConfig = {
    imgBase: d.imgBase || '/images/devtoberfest/selfie',
    frames: (d.frames || '').split(',').map(s => s.trim()).filter(Boolean),
    stickers: (d.stickers || '').split(',').map(s => s.trim()).filter(Boolean),
  }
  createApp(Selfie, { config }).mount(el)
}
