import { createApp } from 'vue';
import App from './App.vue';

function boot() {
  document.querySelectorAll('[data-island="channel-submit"]').forEach((el) => {
    createApp(App).mount(el);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
