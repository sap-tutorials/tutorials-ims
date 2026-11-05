## Context

`render-codeblock.html` already supports a language alias map, `{filename= title= hl_lines= linenos=}` attributes, a copy button (`copyCodeBlock`, `code-copy.ts`/`copy-clean.ts`), auto-collapse over 25 lines, CDS highlighting and the `TUTVARx<name>x` variable sentinel. Chroma does the highlighting at Hugo build time. Variables (`{{var:x}}`, #2811) already provide a live, persisted, client-side substitution runtime (`span.tut-var[data-tut-var]`).

## Goals / Non-Goals

**Goals:** fence-level conventions that are valid markdown and readable on GitHub; correct copy semantics; no change to existing fences unless the new language tag/marker is used; build-time rendering (no client highlighter).

**Non-Goals:** in-browser execution, editable code (CODECHECK covers that), switching from Chroma to Shiki.

## Decisions

### D1 — Console split at build time
`console` / `shell-session` / `terminal-session` fences (and any fence with `{prompt}`) are pre-split in the render hook: each line becomes `<span class="cl-cmd" data-prompt="$ ">…</span>` or `<span class="cl-out">…</span>`. Prompt regex (configurable via `{prompt="regex"}`): `^(\$|>|PS [^>]*>|#|❯) `. Continuation lines (previous command ends with `\`, `` ` `` or `^`) are part of the command. Commands are highlighted as `bash` (or `powershell` when the prompt is `PS>`); output as plain text. The copy button reads only `.cl-cmd` text, without prompts, joined by `\n`. *Alternative*: keep `bash` and teach authors to omit output — rejected, output is useful context. **Existing `bash`/`shell` fences are not reinterpreted** (many legitimately start with `#` comments).

### D2 — Diff markers follow the Shiki/VitePress convention
Markers `// [!code ++]`, `# [!code --]`, `<!-- [!code focus] -->`, `-- [!code highlight]` — the marker must be the trailing comment of the line, in any comment syntax. The render hook strips the marker and adds a line class (Chroma `hl_lines` mechanism extended: we post-process the Chroma line spans by index). `{diff}` attribute on a fence with `+`/`-` leading columns (unified diff) is converted to the same classes, and the language highlighting still applies. Copy behaviour: removed lines and markers are excluded; `{copy=raw}` opts out. A legend ("+ added  − removed") is shown in the header when markers are present. *Alternative*: `diff` language only — rejected, loses syntax highlighting.

### D3 — Placeholders as implicit variables
Opt-in (avoid false positives in XML/HTML/generics): frontmatter `placeholders: auto` enables detection of `<UPPER_SNAKE>` and `<lower-kebab-with-your|my-prefix>` tokens inside code fences and inline code; or `placeholders:` list declares exact tokens with labels. Detected tokens are converted at parse time into the existing variable sentinel with an auto-generated variable (`name` derived from token, `label` from humanised token, `placeholder` = the original token text, `display: true`). The variable panel lists them, and clicking a chip in code focuses the corresponding input. Unfilled chips keep the original `<TOKEN>` text so copy without filling is unchanged. Lint warns when `auto` finds zero tokens or a token appears only once.

### D4 — Tree fence
````tree```` fence parsed in the render hook (Hugo template) or a small parser helper: indentation (2+ spaces or tree-drawing characters `├── └── │`) builds the hierarchy; trailing `/` = folder; prefixes `+ ~ -` set state; `# text` = annotation. Rendered as nested `<ul role="tree">` with `aria-expanded` folders (collapsible), SAP icons for folder/file types. Copy button copies a plain ASCII tree.

### D5 — Walkthrough container (directive)
`:::walkthrough` registered on `tutorial-directive-grammar`. Body must be exactly one code fence followed by an ordered list; each item begins with `{N}` or `{N-M}` (or `{N,M-K}`). Rendered as `tut-walkthrough` shortcode: code left, notes right (≥1024px), sticky; selecting a note applies the highlight class to the line range and scrolls the code; keyboard accessible (notes are buttons, `aria-controls` the code). Plain-text fallback: the code followed by the list with `(lines 3–5)` prefixes. Validation errors: no fence, line range out of bounds.

## Risks / Trade-offs

- [Chroma line-span post-processing is brittle] → unit fixtures per supported language; fallback to un-highlighted lines rather than broken markup.
- [Placeholder false positives (`<String>`, `<div>`)] → opt-in only + strict regex requiring `YOUR`/`MY` prefix or ALL_CAPS ≥ 3 chars + lint preview.
- [Copy semantics surprise] → visible "Copies commands only" tooltip on console blocks; `{copy=raw}` escape hatch.
- [Long walkthrough code on mobile] → stacked layout; notes collapse.

## Migration Plan

Additive; existing fences unchanged. Ship console + diff first (render hook only), then tree, placeholders, walkthrough. Rollback per feature by reverting the render hook branch.

## Open Questions

- Should `bash` fences whose every non-empty line starts with `$ ` be auto-treated as console? Proposed: lint suggestion only.
