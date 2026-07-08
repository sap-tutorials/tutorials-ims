// hugo-apps/src/homepage-explainers/index.ts
//
// Mounts the homepage-explainer Vue islands (#759 PR 2, #1020):
//   <div data-island="verb-flip-tile" ...>          on verb-spine tiles (homepage)
//   <div data-island="shelf-header-popover" ...>    on verb-page shelf headers
//   <li  data-island="link-explainer-popover" ...>  on directory-footer + verb-shelf items
//
// Per the homepage-bands precedent, every `data-island` element is mounted as
// its own Vue app instance. Multiple matches per page = multiple mounts.
//
// Spec: docs/superpowers/specs/2026-06-29-759-homepage-explainers-design.md §4.1
// #1020: shelf headers switched from `verb-flip-tile` (flip card) to
//   `shelf-header-popover` (inline ⓘ) so the section titles no longer
//   reserve the flip-card's 96 px of vertical space.

import { createApp } from 'vue';
import VerbFlipTile from './VerbFlipTile.vue';
import LinkExplainerPopover from './LinkExplainerPopover.vue';
import ShelfHeaderPopover from './ShelfHeaderPopover.vue';

function mountAll(selector: string, component: any) {
  const nodes = document.querySelectorAll(selector);
  nodes.forEach((el) => {
    const node = el as HTMLElement;
    // Convert data-* attributes to props (kebab-case → camelCase).
    const props: Record<string, string> = {};
    for (const key of Object.keys(node.dataset)) {
      if (key === 'island') continue; // skip the marker itself
      props[key] = node.dataset[key]!;
    }
    createApp(component, props).mount(node);
  });
}

// Run once when DOM is ready (or immediately if it already is).
function boot() {
  mountAll('[data-island="verb-flip-tile"]', VerbFlipTile);
  mountAll('[data-island="shelf-header-popover"]', ShelfHeaderPopover);
  mountAll('[data-island="link-explainer-popover"]', LinkExplainerPopover);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
