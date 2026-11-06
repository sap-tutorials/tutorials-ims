## 1. Registration

- [ ] 1.1 Create `scripts/parsers/directives/ui.ts` registering `menu`, `kbd`, `icon`, `ui`, `ask` with schemas and `toText`
- [ ] 1.2 Key-token grammar and validator for `:kbd` (Mod/Alt/Shift/Ctrl/named keys/F-keys/chars)
- [ ] 1.3 Build-time SAP icon allowlist generator + "did you mean" suggestions

## 2. Shortcodes and styling

- [ ] 2.1 `tut-menu.html` with accessible name and `aria-hidden` separators
- [ ] 2.2 `tut-kbd.html` emitting `data-win`/`data-mac`/`data-linux` and Windows default
- [ ] 2.3 `tut-icon.html` using `ui5-icon` with SVG fallback for print/no-JS
- [ ] 2.4 `tut-ui.html` with `data-ui-type`
- [ ] 2.5 `tut-ask.html` (hidden by default; omitted when `site.Params.qa` or `previewMode`)
- [ ] 2.6 CSS (Horizon tokens, dark mode, print)

## 3. Client behaviour

- [ ] 3.1 `hugo/assets/js/kbd-os.ts`: resolve active OS (reuse os-toggle preference/detection), listen to `osprefchange`
- [ ] 3.2 Extend `window.joule.openWithStepContext` with optional `prompt` (prefill, no auto-send); wire `tut-ask` click in `joule.js`
- [ ] 3.3 Analytics event for Ask-Joule clicks

## 4. Lint, docs, tests

- [ ] 4.1 Advisory lint suggestions for `click **X**` and literal `Ctrl+`/`Cmd+` patterns
- [ ] 4.2 Author docs section "UI instructions" + cookbook examples
- [ ] 4.3 Unit tests for registration/validation/fallbacks; e2e spec for kbd OS switching and Ask-Joule visibility
