import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import { useData } from 'vitepress'
import './styles/sap-fundamental.css'
import TutorialLayout from './components/TutorialLayout.vue'
import MissionLayout from './components/MissionLayout.vue'
import GroupLayout from './components/GroupLayout.vue'
import TutorialStep from './components/TutorialStep.vue'
import OptionTabs from './components/OptionTabs.vue'
import TutorialList from './components/TutorialList.vue'
import TutorialNavigator from './components/TutorialNavigator.vue'
import AppSpace from './components/AppSpace.vue'

function Layout() {
  const { frontmatter } = useData()
  if (frontmatter.value.layout === 'tutorial') return h(TutorialLayout)
  if (frontmatter.value.layout === 'mission') return h(MissionLayout)
  if (frontmatter.value.layout === 'group') return h(GroupLayout)
  return h(DefaultTheme.Layout)
}

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }: { app: any }) {
    app.component('TutorialStep', TutorialStep)
    app.component('OptionTabs', OptionTabs)
    app.component('TutorialList', TutorialList)
    app.component('TutorialNavigator', TutorialNavigator)
    app.component('AppSpace', AppSpace)
  },
}
