// hugo-apps/src/homepage-events-band/main.ts
// #1030 — mount the events band on [data-app="homepage-events-band"].

import { createApp } from 'vue';
import EventsBand from './EventsBand.vue';

document.querySelectorAll<HTMLElement>('[data-app="homepage-events-band"]').forEach((el) => {
  createApp(EventsBand).mount(el);
});
