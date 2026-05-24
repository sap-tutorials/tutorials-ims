import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import { setTheme } from '@ui5/webcomponents-base/dist/config/Theme.js'
import '@ui5/webcomponents/dist/Assets.js'
import '@ui5/webcomponents-fiori/dist/Assets.js'
import '@ui5/webcomponents-icons/dist/AllIcons.js'
import './styles.css'

// Tab/button icons (chart-table-view, syntax, business-objects-experience, etc.)
// require the icon collection to be loaded explicitly. Assets.js only registers
// theme/i18n metadata. Without AllIcons.js the tabs render as blank squares.
setTheme('sap_horizon')

createApp(App).use(router).mount('#app')
