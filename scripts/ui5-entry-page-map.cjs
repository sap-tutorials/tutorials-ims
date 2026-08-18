// scripts/ui5-entry-page-map.cjs
//
// Single source of truth for page-type → UI5 entries (#1777 Task 6).
//
// Task 7 (Hugo baseof) will mirror these conditions — when `.Type` is "tutorials",
// baseof loads ui5-core + ui5-tutorial. When `.Type` is "me", it loads ui5-core +
// ui5-me. Error/browse pages load ui5-core + ui5-illustrations.
//
// The coverage guard (check-ui5-entry-coverage.ts) enforces correctness: every
// <ui5-*> element rendered by a layout file or a Vue island must be registered
// by at least one entry that that page type loads.
//
// Keep in sync with Hugo baseof.html when Task 7 lands.

module.exports = {
  // entryLayoutGlobs: entry -> predicate over a repo-relative (forward-slash) file path.
  // Each predicate returns true when the layout, shortcode, partial, OR island source
  // file is rendered on a page that loads that entry.
  //
  // Page-type mapping (Hugo .Type / section):
  //   ui5-core      → every page (loaded via <head> on all types)
  //   ui5-tutorial  → .Type "tutorials" (single.html, u1-object-page.html, list.html;
  //                   codetabs shortcode; mission-side-nav partial; Vue islands mounted
  //                   exclusively on tutorial pages: validation, code-check,
  //                   tutorial-branches, tutorial-pip, tutorial-pip-launcher,
  //                   tutorial-rating, related-graph)
  //   ui5-me        → .Type "me" (/me page; Vue islands in hugo-apps/src/me/)
  //   ui5-illustrations → error templates (403, 404, 502) + browse list; also the
  //                       browse Vue island under hugo-apps/src/browse/
  entryLayoutGlobs: {
    'ui5-core': () => true,   // loaded on every page

    // .Type "tutorials" pages: tutorial single/object-page/list layouts, codetabs
    // shortcode (used on some non-tutorial pages too but explicitly ruled as tutorial
    // by Ruling 2 — moved TabContainer to core instead), mission-side-nav partial,
    // and all Vue islands mounted exclusively on tutorial pages.
    'ui5-tutorial': (p) =>
      p.includes('/layouts/tutorials/') ||
      p.includes('/shortcodes/codetabs.html') ||
      p.includes('/partials/mission-side-nav.html') ||
      // Vue islands mounted exclusively on tutorial pages (u1-object-page.html):
      p.includes('hugo-apps/src/validation/') ||
      p.includes('hugo-apps/src/code-check/') ||
      p.includes('hugo-apps/src/tutorial-branches/') ||
      p.includes('hugo-apps/src/tutorial-pip/') ||
      p.includes('hugo-apps/src/tutorial-pip-launcher/') ||
      p.includes('hugo-apps/src/tutorial-rating/') ||
      p.includes('hugo-apps/src/related-graph/') ||
      // tutorial-reset and tutorial-prefs mount on tutorial pages; map by intent,
      // not transitive luck (ui5-dialog is in core but these are tutorial-only islands).
      p.includes('hugo-apps/src/tutorial-reset/') ||
      p.includes('hugo-apps/src/tutorial-prefs/'),

    // .Type "me" page (/me/): me layout + me Vue islands.
    // The /me/tokens PAT page (#1897) is part of the "me" area but its island
    // lives in hugo-apps/src/tokens/; map it here so ui5-me (which registers
    // Text.js) covers its <ui5-text> usage.
    'ui5-me': (p) =>
      p.includes('/layouts/me/') ||
      p.includes('hugo-apps/src/me/') ||
      p.includes('hugo-apps/src/tokens/'),

    // Error templates (403/404/502) + browse list (.Type "browse"):
    // also the browse Vue island
    'ui5-illustrations': (p) =>
      /\/layouts\/(403|404|502)\.html$/.test(p) ||
      p.includes('/layouts/browse/') ||
      p.includes('hugo-apps/src/browse/'),
  },

  // Source file paths for each entry (relative to repo root)
  entrySrcFiles: {
    'ui5-core': 'hugo-apps/src/ui5/ui5-core.ts',
    'ui5-tutorial': 'hugo-apps/src/ui5/ui5-tutorial.ts',
    'ui5-me': 'hugo-apps/src/ui5/ui5-me.ts',
    'ui5-illustrations': 'hugo-apps/src/ui5/ui5-illustrations.ts',
  },
};
