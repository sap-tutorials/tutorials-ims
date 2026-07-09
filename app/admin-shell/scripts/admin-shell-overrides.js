/**
 * Per-component overrides for `generate-manifest.js`.
 *
 * The goal is a single source of truth (the `app/admin/<folder>/` scan), but a
 * handful of components have shell wiring that predates this generator:
 *
 *   - Non-default `componentUsages` key (e.g. `jouleSettingsComponent`).
 *     The manifest works either way, but keeping the historical key means the
 *     generator's first pass produces a byte-equivalent manifest.
 *
 *   - Non-default routes. `feedback` and `homepage` each ship several routes
 *     into the same target (e.g. `homepageShelves` / `homepageRedirects` /
 *     `homepageConfig` all render `homepageTarget`). Some route names are
 *     referenced from `Shell.controller.js`'s `NAV_KEY_TO_ROUTE`.
 *
 *   - Two-letter (or occasionally three-letter) `prefix`. UI5's router uses
 *     this to namespace hash segments. `generate-manifest.js` validates
 *     collision-freeness at build time — if you add a component without a
 *     prefix, the generator will pick the first free two-letter combo from
 *     the camelName and fail the build if none is available.
 *
 * If you add a new admin app and don't need any of the above,
 * this file does not need to change.
 */

module.exports = {
  //
  // Emission order (matches shell navigation). Anything discovered but not
  // listed here is appended in alphabetical order after these entries, so a
  // new admin app just needs to slot into the folder scan and the nav model;
  // if you want it in a specific position in the manifest, add its folder
  // name here.
  //
  // Ordering here is the discovery output's emission order. The generator
  // emits resourceRoots / componentUsages / routes / targets in this order —
  // the current hand-authored manifest has three subtly-different orderings
  // for those four blocks (e.g. contentModeration lives at position 8 in
  // resourceRoots but LAST in componentUsages), and unifying is one of the
  // side benefits of this generator.
  order: [
    'events',
    'missions',
    'groups',
    'tutorials',
    'tags',
    'categories',
    'concepts',
    'content-moderation',
    'advocates',
    'alerts',
    'accomplishments',
    'prizes',
    'operations',
    'accounts',
    'changelog',
    'privacy-audit',
    'devtoberfest',
    'analytics',
    'joule',
    'knowledgeGraph',
    'kgCommunities',
    'kgOnDemand',
    'feedback',
    'secrets',
    'uiEvents',
    'search',
    'navigator',
    'display',
    'tenant',
    'homepage',
    'shelf-definitions',
    'verb-definitions',
    'for-you',
    'featured-topics',
    'videos',
    'video-rotation',
    'pats'
  ],

  //
  // Non-default `componentUsages` key names (default is `<camelName>Component`).
  //
  usageName: {
    devtoberfest: 'devtoberfest',
    joule: 'jouleSettingsComponent',
    knowledgeGraph: 'knowledgeGraphSettingsComponent',
    uiEvents: 'uiEventsSettingsComponent',
    search: 'searchSettingsComponent',
    navigator: 'navigatorSettingsComponent',
    display: 'displaySettingsComponent',
    tenant: 'tenantSettingsComponent'
  },

  //
  // Non-default target id (default is `<camelName>Target`).
  //
  targetName: {
    joule: 'jouleSettingsTarget',
    knowledgeGraph: 'knowledgeGraphSettingsTarget',
    uiEvents: 'uiEventsSettingsTarget',
    search: 'searchSettingsTarget',
    navigator: 'navigatorSettingsTarget',
    display: 'displaySettingsTarget',
    tenant: 'tenantSettingsTarget'
  },

  //
  // Route hand-picked prefix (UI5 router hash segment).
  // 2-3 characters, must be unique across all component AND view targets.
  // If a component isn't listed here the generator will auto-pick the first
  // two-letter combo derived from the camelName; auto-picked prefixes are
  // discouraged for stable URL bookmarks, but the collision check will fail
  // the build rather than let two components share a prefix.
  //
  prefix: {
    events: 'ev',
    missions: 'mi',
    groups: 'gr',
    tutorials: 'tu',
    tags: 'ta',
    categories: 'ca',
    concepts: 'co',
    advocates: 'av',
    alerts: 'al',
    accomplishments: 'ac',
    prizes: 'pr',
    operations: 'op',
    accounts: 'au',
    changelog: 'cl',
    'privacy-audit': 'pa',
    devtoberfest: 'dt',
    analytics: 'an',
    joule: 'jo',
    knowledgeGraph: 'kg',
    kgCommunities: 'kc',
    kgOnDemand: 'kod',
    feedback: 'fb',
    secrets: 'se',
    uiEvents: 'ue',
    search: 'sr',
    navigator: 'nv',
    display: 'dp',
    tenant: 'tn',
    homepage: 'hp',
    'verb-definitions': 'vd',
    'shelf-definitions': 'sd',
    'for-you': 'fy',
    'featured-topics': 'ft',
    videos: 'vi',
    'video-rotation': 'vr',
    'content-moderation': 'cm',
    pats: 'pt'
  },

  //
  // Route mappings.
  //
  // Default: one route per component with `name = camelName` and
  // `pattern = folderName`. Anything more elaborate goes here — additional
  // routes into the same target, or a name that must not change because
  // it is referenced from `Shell.controller.js` NAV_KEY_TO_ROUTE.
  //
  // Each entry replaces the default single-route emission for that folder.
  //
  routes: {
    operations: [
      { name: 'operations', pattern: 'operations' },
      { name: 'pipelinelog', pattern: 'pipelinelog' },
      { name: 'joblog', pattern: 'joblog' }
    ],
    feedback: [
      // The dashboard variant renders a plain view (feedbackDashboardTarget)
      // which lives in the template — this generator only emits the list route.
      { name: 'feedbackList', pattern: 'feedback/list' }
    ],
    homepage: [
      { name: 'homepageShelves', pattern: 'homepage' },
      { name: 'homepageRedirects', pattern: 'homepageRedirects' },
      { name: 'homepageConfig', pattern: 'homepageConfig' }
    ]
  }
}
