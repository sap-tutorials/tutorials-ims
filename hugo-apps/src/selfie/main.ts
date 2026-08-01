import { createApp } from 'vue'
import Selfie from './Selfie.vue'
import type { MountConfig } from './types'
import './styles.css'
const el = document.getElementById('selfie-mount')
if (el) {
  const d = el.dataset
  const config: MountConfig = {
    apiUpload: d.apiUpload || '/community/upload_selfie',
    imgBase: d.imgBase || '/images/devtoberfest/selfie',
    frames: (d.frames || '').split(',').map(s => s.trim()).filter(Boolean)
  }
  createApp(Selfie, { config }).mount(el)
}
