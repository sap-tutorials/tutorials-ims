## Why

SAP tutorials are dominated by UI navigation: "In the SAP BTP cockpit choose **Connectivity** → **Destinations** → **New Destination**, then press Ctrl+S (Cmd+S on Mac) and click the ➕ icon". Authors improvise this with bold text, arrows, screenshots and OS-specific prose, which is inconsistent, inaccessible and wrong for half of readers (keyboard shortcuts). Readers who get stuck have no one-click way to ask for help about a specific concept.

## What Changes

Register five inline directives on `tutorial-directive-grammar`:
- `:menu[Connectivity > Destinations > New Destination]` — renders a breadcrumb of UI chips with separators; accessible as a single phrase ("Connectivity, then Destinations, then New Destination").
- `:kbd[Mod+Shift+P]` — renders `<kbd>` keys; `Mod` resolves to `Ctrl` or `⌘` (and `Alt`↔`⌥`) from the reader's selected OS in the existing OS picker (falls back to detected OS). Explicit `{win="Ctrl+Alt+T" mac="Ctrl+Option+T" linux="…"}` overrides.
- `:icon[add]` — renders an inline SAP icon (SAP icon font / `ui5-icon`) with accessible name; optional label `:icon[add]{label="Create"}`.
- `:ui[Save]` — marks a UI element name (button, field, tab) with consistent styling; `{type=button|field|tab|link}` for a11y hints.
- `:ask[Explain the difference between a CDS view and a projection]` — renders a small "Ask Joule" button that opens Joule prefilled with the prompt plus current step context; hidden when Joule is disabled, QA channel, or preview mode.

## Capabilities

### New Capabilities
- `tutorial-ui-instruction-directives`: menu paths, OS-aware keyboard shortcuts, SAP icons, UI element labels, and Ask-Joule prompts in tutorial prose.

### Modified Capabilities
<!-- none -->

## Impact

- `scripts/parsers/directives/ui.ts` (registration), `hugo/layouts/shortcodes/tut-menu.html`, `tut-kbd.html`, `tut-icon.html`, `tut-ui.html`, `tut-ask.html`.
- `hugo/assets/js/os-toggle.ts` emits its existing change event; new `hugo/assets/js/kbd-os.ts` listens and swaps key labels.
- Joule integration reuses `window.joule.openWithStepContext` (see `hugo/layouts/partials/joule-step-help.html`) extended with an initial prompt.
- Icon name allowlist generated from the SAP icon set used by `ui5-icon`.
- Depends on `tutorial-directive-grammar`.
