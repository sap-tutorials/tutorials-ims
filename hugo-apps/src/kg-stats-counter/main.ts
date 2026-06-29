// hugo-apps/src/kg-stats-counter/main.ts
import { createApp } from 'vue';
import App from './App.vue';

const el = document.getElementById('kg-stats-counter');
if (el) {
  createApp(App).mount(el);
}
