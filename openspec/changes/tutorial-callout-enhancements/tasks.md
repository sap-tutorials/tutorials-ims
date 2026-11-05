## 1. Alert foundation

- [ ] 1.1 Prototype `.AlertTitle`/`.AlertSign` and custom `[!DETAILS]` designators on Hugo 0.147.7; choose native vs `blockquote-alerts.ts` pre-pass fallback and record the decision in design.md
- [ ] 1.2 Create `partials/tut-alert.html` (icon, hidden type label, title, collapsible variant) shared by render hook and directives
- [ ] 1.3 Update `render-blockquote.html` to use the partial for alerts; keep plain `>` byte-identical
- [ ] 1.4 Audit CSS/e2e selectors for `blockquote.alert`; update `sap-fundamental.src.css` with icons, titles, light/dark, print-expanded rules

## 2. New types

- [ ] 2.1 DETAILS / TROUBLESHOOT collapsible rendering with `+` open sign and required-title validation
- [ ] 2.2 RESULT rendering with default title and ASSERT link when step has assert specs
- [ ] 2.3 HINT grouping/numbering + progressive reveal script; SOLUTION inline confirm
- [ ] 2.4 Troubleshooting collection into step metadata and end-of-tutorial section; include in Joule step context and MCP step output

## 3. Directives

- [ ] 3.1 Register `details`, `troubleshoot`, `result`, `hint`, `solution` containers and `spoiler` inline on the directive grammar
- [ ] 3.2 `tut-spoiler` shortcode + keyboard/ARIA behaviour
- [ ] 3.3 Plain-text fallbacks for all types

## 4. Docs and tests

- [ ] 4.1 Update "Alert callouts" in `docs/authors/writing-tutorials.md` (types table with icons, titles, collapsible, hints)
- [ ] 4.2 Lint: warning when a collapsed callout holds the step's only command block
- [ ] 4.3 Unit tests + render fixtures; e2e spec for collapse/expand, hints, spoiler; corpus regression for plain blockquotes
