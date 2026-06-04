// hugo-apps/src/browse/main.ts
//
// Entry point for the /browse/ Vue island. Hydrates over Hugo-SSR'd DOM
// using createSSRApp. Mount target is #browse-root — the inner card-list
// container. The rest of the page (filter rail, sort dropdown, search,
// pagination) is SSR'd by Hugo and wired via plain DOM event listeners
// in controller.ts (Path C). See BrowsePage.vue for architecture notes.

import { createSSRApp } from 'vue'
import BrowsePage from './BrowsePage.vue'

const el = document.getElementById('browse-root')
if (el) {
  createSSRApp(BrowsePage).mount(el)
}
