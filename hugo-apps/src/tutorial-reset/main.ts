// hugo-apps/src/tutorial-reset/main.ts
//
// Mount script for the TutorialReset Vue island (Task 20 of issue #600).
// Task 21 wires the .tutorial-reset-mount node into the Hugo layout and
// the localStorage cleanup listener in head.html.
import { createApp } from 'vue';
import TutorialReset from './TutorialReset.vue';

const mountEl = document.querySelector('.tutorial-reset-mount') as HTMLElement | null;
if (mountEl) {
  const slug = mountEl.dataset.slug ?? '';
  if (slug) {
    createApp(TutorialReset, { slug }).mount(mountEl);
  }
}
