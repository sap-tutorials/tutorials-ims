import { createRouter, createWebHashHistory } from 'vue-router'
import Analytics from './views/Analytics.vue'
import SurveyReport from './views/SurveyReport.vue'

export const router = createRouter({
  history: createWebHashHistory('/analytics-ui/'),
  routes: [
    { path: '/', component: Analytics },
    { path: '/reports/survey', component: SurveyReport },
  ],
})
