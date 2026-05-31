import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import '@ui5/webcomponents/dist/Assets.js'
import '@ui5/webcomponents-fiori/dist/Assets.js'
import '@ui5/webcomponents-icons/dist/AllIcons.js'
import { initTheme } from './composables/useTheme'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import './styles.css'

// Tab/button icons (chart-table-view, syntax, business-objects-experience, etc.)
// require the icon collection to be loaded explicitly. Assets.js only registers
// theme/i18n metadata. Without AllIcons.js the tabs render as blank squares.
// initTheme picks up localStorage["sap-tutorials-admin-theme"] (shared with the
// admin-shell so flipping mode there carries over here) and falls back to OS
// prefers-color-scheme when no explicit choice has been made.
initTheme()

createApp(App).use(router).mount('#app')
