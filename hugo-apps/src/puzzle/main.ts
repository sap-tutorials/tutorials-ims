// hugo-apps/src/puzzle/main.ts
// Island entry: mounts on #puzzle-mount, reads data-slug + data-api.
import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('puzzle-mount') as HTMLElement | null;
if (mount) {
  createApp(App, {
    slug:   mount.dataset.slug   || '',
    apiUrl: mount.dataset.api    || '/api/puzzles',
  }).mount(mount);
}
