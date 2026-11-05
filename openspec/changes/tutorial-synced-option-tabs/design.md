## Context

`scripts/parsers/options.ts` matches `/\[OPTION BEGIN \[([^\]]+)\]\]\s*\n([\s\S]*?)\[OPTION END\]/g`, groups consecutive blocks, classifies them with `os-classifier.ts` and emits either `{{< os-options >}}`/`os-panel` (global OS picker, `hugo/assets/js/os-toggle.ts`, `localStorage["os-preference"]`, BAS/client-hint/UA detection, `osprefchange` event, #2820 no-substitution placeholder) or `{{% option-tabs tabs="A,B" %}}` + `tab` shortcodes (independent per-step `fd-tabs`). `codetabs.ts` independently syncs `ui5-tabcontainer[data-codetabs]` via `localStorage["codetabs-preference"]`. Frontmatter `osOverrides` keyed by step slug forces `os`/`regular`.

## Goals / Non-Goals

**Goals:** one-click path selection per tutorial and across tutorials; backward compatible syntax and output; one client runtime for OS, codetabs and synced groups; deep-linkable; accessible tabs.

**Non-Goals:** hiding entire steps by variant (that is branching, #172 `[BRANCH_BEGIN]`), server-side personalisation, changing OS picker UX.

## Decisions

### D1 — Syntax
Extend the begin marker: `[OPTION BEGIN [Java] sync=runtime]`. Regex becomes `\[OPTION BEGIN \[([^\]]+)\](?:\s+sync=([a-z][a-z0-9-]*))?\]`. Only the first block of a group needs `sync=`; mismatched keys within one group → build error. *Alternative*: directive `:::option` — rejected for now; authors already know OPTION and the grammar change explicitly keeps legacy markers canonical.

### D2 — Canonical values and presets
`sync-presets.ts` holds alias tables: `runtime` {`Node.js`: [Node, NodeJS, JavaScript, TypeScript, CAP Node.js], `Java`: [CAP Java, Spring, Java], `Python`}, `account` {`Trial`: [BTP Trial, Trial account], `Free Tier`, `Enterprise`: [Enterprise, Pay-As-You-Go, PAYG, CPEA, BTPEA]}, `ide` {`BAS`: [Business Application Studio, SAP BAS, BAS], `VS Code`: [Visual Studio Code, VSCode]}. Tabs carry `data-sync-value=<canonical>` while displaying the author's label. Unknown label within a preset group → lint warning and the label itself becomes the value. Custom `syncGroups` define values (+ optional aliases) and default.

### D3 — Auto-classification opt-in
Unlike OS (default-on heuristic), presets are **opt-in** via `syncTabs: auto` because labels like "Trial" or "Java" can appear in unrelated tab groups and silently syncing them would change reader-visible behaviour of existing tutorials. Rule: a group is assigned a preset if *all* its labels resolve to one preset's aliases. `syncOverrides: { <step-slug>: none | <key> }` overrides. Lint (advisory) suggests `syncTabs: auto` when ≥2 groups would qualify.

### D4 — Unified client runtime
`sync-groups.ts` exports `getChoice(key)`, `setChoice(key, value)`, `onChange(key, cb)`; storage `localStorage["sync-groups"] = {os: "macOS", runtime: "Java", …}` with cross-tab `storage` events. Migration on first read: `os-preference` → `os`, `codetabs-preference` → `codetabs` (kept as its own key because codetab labels are free-form). Resolution order per key: URL query param (`?runtime=java`, case-insensitive canonical match; applied and persisted, since a shared link expresses intent) → stored choice → detection (os: existing; ide: BAS detection) → group default → first tab. `os-toggle.ts` becomes a thin adapter (keeps `osprefchange` event for existing listeners like `:kbd`).

### D5 — Picker bar
Rendered by the tutorial layout from page params `syncKeysUsed` (emitted by the parser like `osList`). Segmented buttons (`ui5-segmented-button`, same as OS picker) per key with the union of canonical values across the page. Changing a value updates all groups, announces via `aria-live` ("Showing Java instructions"). Hidden when only one group of that key exists on the page (tabs alone suffice).

### D6 — Tabs accessibility
Upgrade `option-tabs.html` to proper WAI-ARIA tabs: `aria-selected`, `aria-controls`, roving `tabindex`, arrow-key navigation (applies to unsynced tabs too — markup-level fix, no visual change).

### D7 — MCP / plain text
`get_tutorial_step(slug, step, variants?)` returns only the matching variant when a preference is passed for a synced key, otherwise all variants as `#### Option: Java` sub-sections (current behaviour for OPTION blocks, preserved).

## Risks / Trade-offs

- [Silent behaviour change in existing tutorials] → presets opt-in, explicit `sync=` only.
- [Storage migration bugs lose OS choice] → migration is read-only fallback; old keys kept for one release.
- [Reader confusion when a step lacks the chosen variant] → #2820-style placeholder strip with available options.
- [Too many pickers] → picker bar only for keys used in ≥2 groups.

## Migration Plan

1. Ship `sync-groups.ts` with OS/codetabs adapters (no visible change), verify via e2e.
2. Ship parser `sync=` + picker bar.
3. Enable `syncTabs: auto` on pilot tutorials (CAP Node/Java series), then document.
Rollback: revert parser emission; runtime adapters remain compatible.

## Open Questions

- Should the `account` choice be stored in the signed-in profile for cross-device use? Deferred (privacy review).
