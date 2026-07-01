// hugo-apps/src/concepts-filter/main.ts
//
// Mount point for the concepts filter island (#859). The island targets
// the empty container Hugo emits in layouts/concepts/list.html —
// `<div id="concepts-filter-controls" hidden>` — fills it in, and reveals
// it. The rest of the page (grid, count, empty-state) is untouched by
// this bootstrap and manipulated directly by App.vue's watcher.

import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('concepts-filter-controls');
if (mount) {
  mount.removeAttribute('hidden');
  createApp(App).mount(mount);
}
