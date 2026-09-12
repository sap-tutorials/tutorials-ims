import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('ktt-mount') as HTMLElement | null;
if (mount) {
  let lessons = {};
  try { lessons = JSON.parse(mount.dataset.lessons || '{}'); } catch { lessons = {}; }
  createApp(App, { apiUrl: mount.dataset.api || '/ktt', lessons }).mount(mount);
}
