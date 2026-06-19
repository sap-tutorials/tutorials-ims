// hugo-apps/src/related-graph/main.ts
//
// Mount-on-discovery for the Knowledge Graph sidebar island.
// Vite emits this file as hugo/static/js/related-graph.js (configured
// in the next dispatch via hugo-apps/vite.config.ts), and the tutorial
// Object Page partial (also next dispatch) drops a placeholder:
//   <div data-vue-island="related-graph"></div>
// Multiple placeholders are supported, though only one is expected
// per page.
//
// The slug for the fetch is read from <html data-page-slug="…"> by
// the component itself ([[feedback_island_slug_source]]) — no need
// to thread it through props.

import { createApp } from 'vue'
import RelatedGraph from './RelatedGraph.vue'

const placeholders = document.querySelectorAll<HTMLElement>(
  '[data-vue-island="related-graph"]',
)
for (const placeholder of placeholders) {
  createApp(RelatedGraph).mount(placeholder)
}
