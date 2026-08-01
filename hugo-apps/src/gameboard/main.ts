import { createApp } from 'vue'
import Gameboard from './Gameboard.vue'
import './styles.css'
import type { MountConfig } from './types'

const mount = document.getElementById('gameboard-mount') as HTMLElement | null
if (mount) {
  const config: MountConfig = {
    apiLeaderboard: mount.dataset.apiLeaderboard || '/gameboard/getLeaderboard',
    apiGameboard:   mount.dataset.apiGameboard   || '/gameboard/getGameboard',
    apiMyGameboard: mount.dataset.apiMyGameboard || '/gameboard/getMyGameboard',
    ws:             mount.dataset.ws             || '',
    imgBase:        mount.dataset.imgBase        || '/images/devtoberfest',
    top:            Number(mount.dataset.top) || 25,
  }
  createApp(Gameboard, { config }).mount(mount)
}
