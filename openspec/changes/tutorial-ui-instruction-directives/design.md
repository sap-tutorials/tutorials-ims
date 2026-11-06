## Context

The OS picker (`hugo/assets/js/os-toggle.ts`) persists `localStorage["os-preference"]` (Windows/macOS/Linux/BAS), auto-detects (BAS referrer → client hints → UA) and dispatches `osprefchange`. UI5 web components (`ui5-icon`, SAP icon collection) are bootstrapped via `ui5-bootstrap.ts`. Joule is exposed on `window.joule` with `open()` and `openWithStepContext({slug, n, heading})`, hidden on QA/preview. The directive grammar change supplies parsing, validation, `tut-<name>` shortcodes and plain-text fallback.

## Goals / Non-Goals

**Goals:** short, memorable syntax; build-time HTML with progressive enhancement; correct for every OS; accessible.

**Non-Goals:** UI screenshots annotation (rich-media change), deep links into SAP BTP cockpit, localisation of UI labels.

## Decisions

### D1 — `:menu` separator
Split the label on ` > ` (space-gt-space) or `→` only — not `/`, so paths like `srv/service.cds` inside a segment stay intact. Each segment renders as `<span class="tut-menu__item">` inside `<span class="tut-menu" role="text" aria-label="Connectivity, then Destinations">`; separators are `aria-hidden` chevrons. Segments may contain inline markdown/variables. Fallback text: `Connectivity → Destinations → New Destination` in bold.

### D2 — `:kbd` OS resolution
Grammar: keys joined by `+`; tokens `Mod`, `Alt`, `Shift`, `Ctrl`, `Enter`, `Esc`, `Tab`, `Space`, arrows, `F1`-`F24`, single characters. Build time renders both variants: `<kbd class="tut-kbd" data-win="Ctrl+S" data-mac="⌘S">` with the server-rendered default being the Windows/Linux form (no-JS / MCP). `kbd-os.ts` swaps to the active OS on load and on `osprefchange`; BAS uses the underlying host OS detection (BAS keybindings follow the browser host). Mac rendering uses symbols (⌘ ⌥ ⇧ ⌃ ↩) with `aria-label` spelled out ("Command S"). Explicit `win/mac/linux` attrs override. A tutorial without OS-conditional content still gets the swap via detection (no picker shown). Fallback: `Ctrl+S (macOS: Cmd+S)`.

### D3 — `:icon` allowlist
Name must exist in the SAP icon set (allowlist JSON generated at build from `@ui5/webcomponents-icons`); unknown names fail validation with a "did you mean" suggestion. Render `<ui5-icon name="add" accessible-name="Add" class="tut-icon">` with an inline SVG fallback for no-JS/print. Fallback text: `[add icon]` or the label.

### D4 — `:ui` semantics
Renders `<span class="tut-ui" data-ui-type="button">Save</span>` (bold, subtle outline like a UI control). It does not imply interactivity. Fallback: `**Save**`. A lint rule suggests `:ui[...]` when a step contains `click **X**` patterns (advisory).

### D5 — `:ask` Joule integration
Renders a `<button class="tut-ask" data-prompt="…" hidden>` that `joule.js` reveals when `ChatConfig.enabled`. Click calls `window.joule.openWithStepContext({slug, n, heading, prompt})` with a new optional `prompt` param that pre-fills the input only; the reader presses send. This avoids surprise token usage and lets readers edit the prompt. Never rendered on QA or preview, same rules as the step FAB. Prompt length ≤ 300 chars (validation). Fallback text: `Ask Joule: "<prompt>"`. Analytics: count clicks per tutorial/step (existing event pipeline).

## Risks / Trade-offs

- [Mac symbols unfamiliar to some readers] → `title` tooltip spelled out; symbols match macOS menus.
- [Icon set version drift] → allowlist regenerated at build from the installed package; validation error is actionable.
- [Joule unavailable] → button hidden, text fallback not shown inline (no dead UI).
- [Overuse of `:ui` cluttering prose] → style is subtle; docs give guidance.

## Migration Plan

Additive. Optional codemod suggestions via lint (`click **Save**` → `:ui[Save]`, `Ctrl+S` patterns → `:kbd`). No automatic rewrite of source repos.

## Open Questions

- Should `:menu` support linking the first segment to a cockpit URL (`{href=…}`)? Deferred.
