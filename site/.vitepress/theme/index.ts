import DefaultTheme from 'vitepress/theme'
import { h } from 'vue'
import { useData } from 'vitepress'
import './styles/sap-fundamental.css'
import TutorialLayout from './components/TutorialLayout.vue'
import TutorialStep from './components/TutorialStep.vue'
import OptionTabs from './components/OptionTabs.vue'

function Layout() {
  const { frontmatter } = useData()
  if (frontmatter.value.layout === 'tutorial') {
    return h(TutorialLayout)
  }
  return h(DefaultTheme.Layout)
}

export default {
  extends: DefaultTheme,
  Layout,
  enhanceApp({ app }: { app: any }) {
    app.component('TutorialStep', TutorialStep)
    app.component('OptionTabs', OptionTabs)
  },
}
