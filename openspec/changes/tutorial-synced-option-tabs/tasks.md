## 1. Unified runtime

- [x] 1.1 Create `hugo/assets/js/sync-groups.ts` (get/set/onChange, unified storage, cross-tab sync, URL param resolution)
- [x] 1.2 Migrate `os-toggle.ts` onto it as an adapter (keep `osprefchange`), read-fallback for `os-preference`
- [x] 1.3 Migrate `codetabs.ts` onto it, read-fallback for `codetabs-preference`
- [x] 1.4 e2e: OS picker and codetabs behaviour unchanged

## 2. Parser

- [x] 2.1 Extend OPTION opener regex in `options.ts` for `sync=<key>`; group key consistency validation
- [x] 2.2 `scripts/parsers/sync-presets.ts` alias tables + canonicalisation; unit tests
- [x] 2.3 Frontmatter `syncTabs`, `syncOverrides`, `syncGroups` validation; `syncTabs: auto` classification
- [x] 2.4 Emit `sync` + canonical values on `option-tabs`/`tab` shortcodes and `syncKeysUsed` page param
- [x] 2.5 Corpus regression: no change for tutorials without `sync=`/`syncTabs`

## 3. Rendering

- [x] 3.1 WAI-ARIA tabs upgrade for `option-tabs.html`/`tab.html` (roving tabindex, arrow keys)
- [x] 3.2 `data-sync-key`/`data-sync-value` binding in client; missing-variant placeholder strip
- [x] 3.3 Picker bar in tutorial layout next to `[data-os-picker]`; aria-live announcements

## 4. Consumers, docs, tests

- [x] 4.1 MCP `get_tutorial_step` `variants` argument
- [x] 4.2 Anonymous aggregate analytics of chosen values per key
- [x] 4.3 Author docs §3.5.4 "Synced tabs" + presets table; lint suggestion for `syncTabs: auto`
- [x] 4.4 Pilot on a CAP Node/Java tutorial series; e2e for sync, deep link, persistence, missing variant
