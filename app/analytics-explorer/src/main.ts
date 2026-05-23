import { createApp } from 'vue'
import App from './App.vue'
import { router } from './router'
import '@ui5/webcomponents/dist/Assets.js'
import '@ui5/webcomponents-fiori/dist/Assets.js'
import './styles.css'

createApp(App).use(router).mount('#app')
