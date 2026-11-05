## Why

Many tutorials offer the same choice in every step — Node.js vs Java, Trial vs Enterprise account, BAS vs VS Code — using `[OPTION BEGIN [x]]` tabs. Today each step's tab strip is independent (`option-tabs` shortcode), so a Java developer clicks "Java" up to 15 times per tutorial and again in the next tutorial. Only OS tabs (global OS picker, `os-preference`) and codetabs (`codetabs-preference`) remember a choice, via two separate mechanisms. Readers who pick the wrong tab in one step silently follow the wrong path.

## What Changes

- **Explicit sync groups**: `[OPTION BEGIN [Java] sync=runtime]` — every OPTION group on the page with the same sync key switches together, and the choice persists across tutorials per key. Syntax is backward compatible: without `sync=`, behaviour is unchanged.
- **Built-in presets** with label aliasing (like the OS classifier): `runtime` (Node.js/JavaScript/TypeScript ↔ Java ↔ Python), `account` (Trial ↔ Free Tier ↔ Enterprise/Pay-As-You-Go), `ide` (SAP Business Application Studio ↔ VS Code, BAS auto-detected using the OS picker's existing BAS detection). Labels are normalised so `Node`, `Node.js` and `CAP Node.js` all map to one preset value.
- **Auto-classification (opt-in)**: frontmatter `syncTabs: auto` lets the build assign preset keys to OPTION groups whose labels all match one preset; `syncOverrides:` (keyed by step slug, like `osOverrides`) forces or disables it per step.
- **Custom groups**: frontmatter `syncGroups: { db: { label: "Database", values: [HANA Cloud, SQLite], default: SQLite } }`.
- **Page-level picker bar**: when a page uses sync groups, a picker bar under the OS picker shows one segmented control per group ("Runtime: Node.js | Java"); deep links via URL query (`?runtime=java`).
- **Missing-variant handling** matches #2820 OS semantics: no substitution, a placeholder strip "This step has no Java variant" plus the available tabs.
- **Unified runtime**: OS picker, codetabs and synced OPTION groups use one sync-group client module and storage format (existing `os-preference` and `codetabs-preference` values migrated on read).

## Capabilities

### New Capabilities
- `tutorial-synced-option-tabs`: page- and cross-tutorial-synchronised OPTION tab groups with presets, custom groups, picker bar, deep links, and unified client runtime.

### Modified Capabilities
<!-- none (OS picker behaviour is preserved, not specified in openspec yet) -->

## Impact

- `scripts/parsers/options.ts` (parse `sync=` after the label, preset classification, emit `sync` param), new `scripts/parsers/sync-presets.ts` (alias tables, mirrors `os-classifier.ts`).
- `hugo/layouts/shortcodes/option-tabs.html` + `tab.html` (`data-sync-key`, canonical values; ARIA tablist fixes), tutorial layout picker bar (`u1-object-page.html` next to `[data-os-picker]`).
- `hugo/assets/js/os-toggle.ts` and `codetabs.ts` refactored onto new `hugo/assets/js/sync-groups.ts`.
- MCP `get_tutorial_step` gains an optional `variants` preference argument (`{runtime: "java"}`) and otherwise returns all variants labelled.
- Analytics: chosen variant per sync key (anonymous aggregate) to inform authors which paths readers take.
- No dependency on `tutorial-directive-grammar`.
