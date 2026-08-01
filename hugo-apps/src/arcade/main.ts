import { createApp } from 'vue'
import Arcade from './Arcade.vue'
import type { MountConfig } from './types'
import './styles.css'
const el = document.getElementById('arcade-mount')
if (el) {
  const d = el.dataset
  const config: MountConfig = {
    apiMyGameboard: d.apiMyGameboard || '/gameboard/getMyGameboard',
    joinUrl: d.joinUrl || '/devtoberfest/#join',
    imgBase: d.imgBase || '/images/devtoberfest',
    demoAvatar: Number(d.demoAvatar ?? 7)
  }
  createApp(Arcade, { config }).mount(el)
}
