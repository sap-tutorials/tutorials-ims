// hugo-apps/src/browse/main.ts
//
// Entry point for the /browse/ Vue island. Mounts on #browse-root — the
// inner card-list container. The rest of the page (filter rail, sort
// dropdown, search, pagination) is SSR'd by Hugo and wired via plain DOM
// event listeners in controller.ts (Path C).
//
// We use createApp (NOT createSSRApp) — see BrowsePage.vue for the
// architectural rationale. tl;dr: BrowseGrid.vue uses <template v-for>
// as its root (a Vue fragment), and Hugo's flat partial output doesn't
// emit the fragment markers (<!--[-->/<!--]-->) that SSR hydration
// requires. createApp side-steps the mismatch by rendering fresh on
// mount, replacing #browse-root's contents with the same data the SSR
// pass already painted.

import { createApp } from 'vue'
import BrowsePage from './BrowsePage.vue'

const el = document.getElementById('browse-root')
if (el) {
  createApp(BrowsePage).mount(el)
}
