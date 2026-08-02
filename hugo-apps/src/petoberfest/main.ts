// hugo-apps/src/petoberfest/main.ts
import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('petoberfest-mount');
if (mount) {
  const dataSlug = mount.dataset.slug || '';
  const pathSlug = window.location.pathname.replace(/\/$/, '').split('/').pop() || '';
  createApp(App, { slug: dataSlug || pathSlug }).mount(mount);
}
