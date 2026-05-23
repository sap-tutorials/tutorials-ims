import { createRouter, createWebHashHistory } from 'vue-router'
import Analytics from './views/Analytics.vue'

export const router = createRouter({
  history: createWebHashHistory('/analytics-ui/'),
  routes: [
    { path: '/', component: Analytics },
  ],
})
