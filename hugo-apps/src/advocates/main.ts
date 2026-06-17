import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('advocates-mount') as HTMLElement | null;
if (mount) {
  createApp(App, {
    apiUrl:    mount.dataset.api       || '/api/advocates',
    photoBase: mount.dataset.photoBase || '/api/advocates',
  }).mount(mount);
}
