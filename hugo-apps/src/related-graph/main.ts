// hugo-apps/src/related-graph/main.ts
//
// Mount-on-discovery for the Knowledge Graph sidebar island.
// Vite emits this file as hugo/static/js/related-graph.js (configured in
// hugo-apps/vite.config.ts). The tutorial Object Page partial drops TWO
// placeholders so the island is visible on every viewport:
//
//   <div data-vue-island="related-graph" class="kg-sidebar-desktop"></div>
//     -- inside <aside class="tutorial-right-col">; visible at >960px
//
//   <div data-vue-island="related-graph" class="kg-sidebar-mobile"></div>
//     -- in the main content column after the Discussion section;
//        visible at ≤960px
//
// CSS in hugo/assets/css/sap-fundamental.css hides whichever placeholder
// is not relevant for the current viewport. To avoid mounting the Vue
// component twice (which would double-fetch /graph/neighborhood and emit
// duplicate kg.sidebar.shown telemetry), main.ts inspects window.matchMedia
// at boot time and mounts onto exactly ONE placeholder. The other stays
// in the DOM but unmounted (CSS still hides it).
//
// The slug for the fetch is read from <html data-page-slug="…"> by the
// component itself ([[feedback_island_slug_source]]) — no need to thread
// it through props.

import { createApp } from 'vue'
import RelatedGraph from './RelatedGraph.vue'

const MOBILE_BREAKPOINT_MAX = '(max-width: 960px)'

function selectPlaceholder(): HTMLElement | null {
  const isMobile =
    typeof window.matchMedia === 'function' &&
    window.matchMedia(MOBILE_BREAKPOINT_MAX).matches

  const selector = isMobile
    ? '[data-vue-island="related-graph"].kg-sidebar-mobile'
    : '[data-vue-island="related-graph"].kg-sidebar-desktop'

  const target = document.querySelector<HTMLElement>(selector)
  if (target) return target

  // Fallback: if the layout doesn't carry the desktop/mobile class
  // (shouldn't happen post-PR-7, but stay resilient against template
  // changes), mount onto the first plain placeholder.
  return document.querySelector<HTMLElement>('[data-vue-island="related-graph"]')
}

const target = selectPlaceholder()
if (target) {
  createApp(RelatedGraph).mount(target)
}
