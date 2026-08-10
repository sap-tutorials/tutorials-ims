// hugo-apps/src/topics-map/main.ts
//
// Mount-on-discovery for the Topics Cluster Map island.
// Vite emits this file as hugo/static/js/topics-map.js (configured in
// hugo-apps/vite.config.ts). The topics layouts emit mount points:
//
//   <section data-vue-island="topics-map">  (list.html — full gallery map)
//   <div data-vue-island="topics-map" data-focus-cluster="<slug>">  (single.html — mini-map)
//
// Optional data-focus-cluster attribute causes the island to auto-expand
// the named cluster on mount (used by the cluster-detail mini-map).

import { createApp } from 'vue';
import App from './App.vue';

document.querySelectorAll<HTMLElement>('[data-vue-island="topics-map"]').forEach((el) => {
  createApp(App, { focusCluster: el.getAttribute('data-focus-cluster') || '' }).mount(el);
});
