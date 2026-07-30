// hugo-apps/src/puzzle/main.ts
// Island entry: mounts on #puzzle-mount, reads data-slug + data-api.
import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('puzzle-mount') as HTMLElement | null;
if (mount) {
  // Prefer data-slug from the Hugo-rendered element; fall back to the last
  // path segment of window.location.pathname so future puzzles served by
  // any means (rewrite, shell, etc.) still resolve the slug correctly.
  const dataSlug = mount.dataset.slug || '';
  const pathSlug = window.location.pathname.replace(/\/$/, '').split('/').pop() || '';
  const slug = dataSlug || pathSlug;
  createApp(App, {
    slug,
    apiUrl: mount.dataset.api || '/api/puzzles',
  }).mount(mount);
}
