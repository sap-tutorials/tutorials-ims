import { createApp } from 'vue'
import DevtoberfestHome from './DevtoberfestHome.vue'
import './styles.css'
import type { MountConfig } from './types'

const mount = document.getElementById('devtoberfest-mount') as HTMLElement | null
if (mount) {
  const config: MountConfig = {
    apiStatus:        mount.dataset.apiStatus        || '/api/devtoberfest/status',
    apiTerms:         mount.dataset.apiTerms         || '/api/devtoberfest/terms',
    apiJoin:          mount.dataset.apiJoin          || '/api/devtoberfest/join',
    apiMe:            mount.dataset.apiMe            || '/api/devtoberfest/me',
    imgKasimir:       mount.dataset.imgKasimir       || '/images/devtoberfest/kasimir-types.png',
    imgTeched:        mount.dataset.imgTeched        || '/images/devtoberfest/teched-logo.svg',
    imgDevtoberfest:  mount.dataset.imgDevtoberfest  || '/images/devtoberfest/devtoberfest-logo.svg',
    imgCatGame:       mount.dataset.imgCatGame       || '/images/devtoberfest/kasimir-types.png',
    catGameAwardUrl:  mount.dataset.catGameAwardUrl  || '/api/devtoberfest/cat-game/award',
  }
  createApp(DevtoberfestHome, { config }).mount(mount)
}
