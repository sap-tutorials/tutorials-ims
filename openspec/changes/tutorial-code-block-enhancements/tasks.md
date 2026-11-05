## 1. Console blocks

- [ ] 1.1 Add `console`/`shell-session`/`terminal-session` aliases and `{prompt}` handling to `render-codeblock.html` (line split, command/output spans)
- [ ] 1.2 Implement continuation grouping and `PS>` → powershell highlighting
- [ ] 1.3 Update `code-copy.ts`/`copy-clean.ts` to copy only `.cl-cmd` text; add "Copies commands only" tooltip
- [ ] 1.4 CSS for output dimming (light/dark, Horizon tokens) and screen-reader labels

## 2. Diff and focus markers

- [ ] 2.1 Marker detection/stripping for all comment syntaxes, applied before Chroma highlighting
- [ ] 2.2 Map markers to Chroma line classes (added/removed/focus/highlight) with per-language fixtures
- [ ] 2.3 `{diff}` attribute: convert unified-diff columns while keeping language highlighting
- [ ] 2.4 Copy final code by default; `{copy=raw}` opt-out; header legend

## 3. Placeholders

- [ ] 3.1 Frontmatter schema: `placeholders: auto | [{token, label}]` with validation in `variables.ts`
- [ ] 3.2 Fence- and inline-code-aware detection pass emitting variable sentinels/spans
- [ ] 3.3 Chip rendering + click-to-focus input in the variables island; persistence parity with variables
- [ ] 3.4 Lint: `auto` with zero matches, single-occurrence tokens

## 4. File tree

- [ ] 4.1 Tree parser (indent + box-drawing) with state prefixes and annotations, unit tests
- [ ] 4.2 `tree` fence rendering as `role="tree"` with collapsible folders and icons
- [ ] 4.3 ASCII copy output

## 5. Walkthrough

- [ ] 5.1 Register `walkthrough` container directive (schema, validation, `toText`)
- [ ] 5.2 `tut-walkthrough` shortcode + `code-walkthrough.ts` (note activation, highlight, scroll, keyboard)
- [ ] 5.3 Responsive layout (side-by-side ≥1024px, stacked below)

## 6. Fallbacks, docs, tests

- [ ] 6.1 Plain-text fallbacks for all features in `renderDirectivesAsText` / MCP step output
- [ ] 6.2 Author docs §3.6 update in `docs/authors/writing-tutorials.md` + feature-cookbook tutorial examples
- [ ] 6.3 Unit tests (`npm test`) and an e2e spec covering copy behaviour on a served tutorial
- [ ] 6.4 Corpus regression: no output change for tutorials not using the new tags/markers
