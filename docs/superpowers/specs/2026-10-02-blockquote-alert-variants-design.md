# Semantic alert variants for tutorial blockquotes — Design (#2595)

- **Issue:** [sap-tutorials/tutorials-ims#2595](https://github.com/sap-tutorials/tutorials-ims/issues/2595) — "Blockquote Emphasis"
- **Date:** 2026-10-02
- **Status:** Approved design, pre-implementation
- **Branch:** `feat/2595-blockquote-alert-variants` (off `origin/DEV`)

## Problem

Reviewer feedback (Shadida): some client tutorials read as "too much emphasis."
Every `>` blockquote currently renders as a loud **Information message strip**
(blue left border + blue fill) via the global rule in
`hugo/assets/css/sap-fundamental.src.css:873`. AEM's old renderer used a quiet
grey side bar with no fill, so the new output reads louder than before. There is
also a distinct use case — an *additional note* (e.g.
`hana-clients-install#step-2`) — that authors want to render with a different,
author-chosen emphasis.

The rendering is faithful; the design choice is simply louder than AEM and
offers authors no way to vary it.

## Decision (scope)

**Keep today's blue blockquote as the default.** Plain `>` stays byte-identical
to current output — the maintainer explicitly likes it and it must not change.

**Add 4 SAP-semantic alert variants on top**, which authors opt into with
GitHub-style alert syntax (`> [!NOTE]` etc.), so authors who want a different
emphasis can choose one. **Color-only** (left-border + fill), **no heading row
or icon**.

### 5→4 type mapping (GitHub alert types → SAP MessageStrip states)

| Author writes | SAP state | Border / fill CSS vars | Visual |
|---|---|---|---|
| `> [!NOTE]` | Information | `--sapInformationBorderColor` / `--sapInformationBackground` | blue (= today's default) |
| `> [!IMPORTANT]` | Information | same as NOTE | blue |
| `> [!TIP]` | Success | `--sapSuccessBorderColor` / `--sapSuccessBackground` | green |
| `> [!WARNING]` | Warning | `--sapWarningBorderColor` / `--sapWarningBackground` | amber |
| `> [!CAUTION]` | Error | `--sapErrorBorderColor` / `--sapErrorBackground` | red |

Plain `>` (no designator) → unchanged blue default blockquote.

## How Hugo alerts actually work (corrects the issue comment)

The issue comment proposed enabling `[markup.goldmark.extensions.extras.alert]`.
**That config key does not exist.** Hugo's `extras` extension covers
delete/insert/mark/subscript/superscript only.

GitHub-style alerts are handled by a **blockquote render hook**. Hugo recognizes
the `> [!TYPE]` designator automatically (no `hugo.toml` change needed) and
exposes `.AlertType` (lowercased type, or `""`/`regular` for a plain blockquote)
to a `render-blockquote.html` template. Today the repo has **no** blockquote
render hook, so `> [!NOTE]` falls through to Goldmark's default `<blockquote>`
and picks up the global blue CSS. Adding the hook is what lights up the feature.

Verified: Hugo v0.147.7 (extended) — alerts GA since 0.132. Render-hook docs:
<https://gohugo.io/render-hooks/blockquotes/>.

## Components

### 1. Blockquote render hook — `hugo/layouts/_default/_markup/render-blockquote.html` (NEW)

A blockquote render hook replaces Hugo's built-in rendering for **every** `>`
blockquote across the whole Hugo site, so the plain path must reproduce today's
output exactly.

```go-html-template
{{- if eq .AlertType "" -}}
  <blockquote>{{ .Text }}</blockquote>
{{- else -}}
  <blockquote class="alert alert-{{ .AlertType }}">{{ .Text }}</blockquote>
{{- end -}}
```

- **Plain `>`** (`.AlertType == ""`) → bare `<blockquote>…</blockquote>`, no
  class. This keeps BOTH existing CSS paths matching unchanged:
  - global blue `blockquote` rule (`sap-fundamental.src.css:873`), and
  - the orange `.generic-page__content blockquote` inline style in
    `hugo/layouts/_default/single.html:11` (the api-docs page).
- **Alert** → `<blockquote class="alert alert-<type>">`. `<type>` is one of
  `note|tip|important|warning|caution` (Hugo lowercases; unknown designators
  resolve to `regular`/`""` and take the plain path, so no bad class leaks).
- Idiomatic: the `_markup/` dir already holds `render-codeblock.html`,
  `render-image.html`, `render-link.html`.

### 2. CSS — `hugo/assets/css/sap-fundamental.src.css`

Leave the base `blockquote` rule (line ~873) untouched. Append 4 variant classes
that override border + fill only (color-only, no heading):

```css
/* Semantic alert callouts (#2595) — author opt-in via `> [!TYPE]`.
   Base blockquote (blue Information) stays the default for plain `>`. */
blockquote.alert-note,
blockquote.alert-important {
  border-left-color: var(--sapInformationBorderColor, #0070f2);
  background-color: var(--sapInformationBackground, #e1f4ff);
}
blockquote.alert-tip {
  border-left-color: var(--sapSuccessBorderColor, #30914c);
  background-color: var(--sapSuccessBackground, #f1fdf6);
}
blockquote.alert-warning {
  border-left-color: var(--sapWarningBorderColor, #e76500);
  background-color: var(--sapWarningBackground, #fef7f1);
}
blockquote.alert-caution {
  border-left-color: var(--sapErrorBorderColor, #e90b0b);
  background-color: var(--sapErrorBackground, #ffeaf4);
}
```

(Exact fallback hex values to be read from the active Horizon token set during
implementation; the `var(--sap…)` token is authoritative, the hex is only a
fallback.)

Then `npm run build:css` regenerates `sap-fundamental.css`. The generated file is
committed (repo commits built CSS).

### 3. Authoring docs — `docs/authors/writing-tutorials.md`

Add an "Alert callouts" subsection: the 5 types, the 4-state color mapping table
above, and the explicit note that plain `>` stays blue. The doc already *uses*
`[!NOTE]`/`[!TIP]`/`[!IMPORTANT]` in its own prose (GitHub-rendered), which the
reader will now understand maps to real rendered variants.

### 4. Migration — none in this PR

Authors adopt going forward. Shadida promotes specific notes to variants in the
`sap-tutorials` **source** repos later. No edits to generated
`hugo/content/tutorials/`.

## Data flow

```text
tutorial source markdown (sap-tutorials repos)
  → fetch-tutorials + scripts/parsers/compose.ts
      (blockquote-fence + blockquote-notes normalize `>` structure;
       they do NOT emit [!TYPE] designators)
  → hugo/content/tutorials/*.md  (contains `> [!TYPE]` if author wrote it)
  → Hugo build + render-blockquote.html hook
      → plain `>`  → <blockquote>            (blue default, unchanged)
      → `> [!TIP]` → <blockquote class="alert alert-tip">  (green)
  → sap-fundamental.css variant classes apply color
```

## Testing

- **Unit (vitest):** copy the pattern in `test/parsers/render-link-hook.test.ts`
  — assert `render-blockquote.html` exists, contains a plain-`>` passthrough
  branch (`.AlertType ""` → bare `<blockquote>`), and the alert branch
  (`alert alert-`). No Goldmark render harness exists in-repo, so this is the
  established way to lock the hook's contract.
- **CSS presence:** assert the 4 variant selectors exist in the built
  `sap-fundamental.css` (guards against forgetting `build:css`).
- **Manual visual:** `npm run dev`, render a fixture tutorial with all 5
  designators + a plain `>`; confirm plain = blue (unchanged), TIP = green,
  WARNING = amber, CAUTION = red, NOTE/IMPORTANT = blue.

## Invariants / risks

- **The one hard contract:** plain `>` renders identically to today. Survey
  confirmed only 2 non-tutorial plain blockquotes exist
  (`hugo/content/api-docs/_index.md:9,190`), both simple; they render orange via
  `single.html`'s scoped style and MUST keep matching `.generic-page__content
  blockquote` — the no-class plain path preserves this.
- Raw `<blockquote>` HTML already in two tutorials
  (`application-frontend-cli.md:180`, `application-frontend-mta.md:126`) is
  passed through untouched by Goldmark — a markdown render hook does not touch
  raw HTML, so unaffected.
- No `.alert*` / `.markdown-alert` CSS class collisions (the only `.alert`-ish
  rules are `#sb-alerts-popover`-scoped shellbar UI).
- Purely additive: no `[!TYPE]` syntax exists in rendered content today, so
  nothing is retroactively reinterpreted.

## Out of scope

- Changing the default blockquote look (explicitly rejected — keep blue).
- A quiet grey "additional note" variant (not requested; authors can use plain
  `>` or a semantic type).
- Heading rows / icons (rejected — color-only).
- Editing generated tutorial content or source-repo migration.
