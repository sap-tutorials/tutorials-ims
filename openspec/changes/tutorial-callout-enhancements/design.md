## Context

`render-blockquote.html` (#2595) renders plain `>` byte-identically to Hugo's default and maps Goldmark's `.AlertType` (note, tip, important, warning, caution) to `alert alert-<type>` classes; CSS maps them to SAP MessageStrip colors, color-only, no icon or title. Hugo ≥0.134 exposes `.AlertTitle` and `.AlertSign` (`+`/`-` for foldable) on blockquote render hooks; unknown designators resolve to `AlertType ""`. Legacy note patterns are normalised by `blockquote-notes.ts` and `blockquote-fence.ts`.

## Goals / Non-Goals

**Goals:** keep the `> [!TYPE]` syntax authors already know from GitHub; non-color signalling (icon + hidden label); collapsible content without JavaScript (`<details>`); zero change for plain `>` blockquotes.

**Non-Goals:** custom author-defined callout types/colours; changing legacy note normalisation.

## Decisions

### D1 — Use Hugo's native alert title/sign support
Rely on Hugo's `.AlertTitle` and `.AlertSign` (available since Hugo 0.132; the pipeline pins 0.147.7 in `rebuild-content.yml`, so no bump needed). For the five GitHub types, Goldmark already parses them. For new types (`DETAILS`, `TROUBLESHOOT`, `RESULT`, `HINT`, `SOLUTION`), Hugo's alert extension accepts any `[!WORD]` designator in recent versions (`.AlertType` = lowercased word). If the pinned version rejects unknown types, a fence-aware pre-pass `blockquote-alerts.ts` rewrites `> [!DETAILS]` into `> [!NOTE]` plus a first-line marker comment `<!-- tut-alert:details -->` that the render hook detects. Decision: prefer native; the pre-pass is the fallback path, picked in task 1.1.

### D2 — Rendering
- Common: `<aside class="alert alert-<type>" role="note" aria-labelledby=…>` with `<span class="alert__icon" aria-hidden="true">` (SAP icon: information, lightbulb, alert, error, message-success, question-mark) and `<span class="sr-only">Warning:</span>`. **Plain `>` remains a bare `<blockquote>`** for byte-identity with existing pages. Alerts (not plain blockquotes) switch to `<aside role="note">` with the same `alert alert-<type>` classes so existing class-based CSS keeps matching; a CSS/e2e audit task covers any `blockquote.alert` element selectors.
- Collapsible types (`details`, `troubleshoot`, `hint`, `solution`, or any type with `+`/`-` sign): `<details class="alert alert-<type>"><summary>icon + title</summary>body</details>`; `+` opens by default. Works without JS, printable (print CSS forces open).
- `RESULT`: success styling + "You should see" default title; if the step has ASSERT specs, append "Verify automatically" anchor to the step's assert UI.
- `HINT`: consecutive hint blockquotes in the same step are grouped; later hints are disabled until the previous is opened (progressive reveal, JS enhancement; without JS all are independently openable). `SOLUTION` adds a one-time "Try it yourself first?" confirm (no blocking modal — inline second click).

### D3 — Troubleshooting index
At parse time, collect `[!TROUBLESHOOT]` titles per step into step metadata (`troubleshoot: [{title, anchor}]`). The tutorial layout renders a "Troubleshooting" section after the last step listing them with links. Also exposed to Joule step context and MCP (`get_tutorial_step` includes troubleshooting entries) — high-value grounding for AI help.

### D4 — Directive equivalents
`:::details[Title]{open}`, `:::troubleshoot[Title]`, `:::result`, `:::hint`, `:::solution` render through the same partial (`partials/tut-alert.html`) as the blockquote forms, so styling and behaviour are identical. `:spoiler[text]` renders `<span class="tut-spoiler" tabindex="0" role="button" aria-pressed="false">`, blurred via CSS, revealed on click/Enter/Space; print shows it.

### D5 — Plain-text fallback
`> **Warning — Costs money:** …`, details/hints as `**Hint:** …`, spoiler as `||text||`, so MCP/AI consumers get full content with type labels.

## Risks / Trade-offs

- [Changing `<blockquote>` to `<aside>` for alerts breaks existing CSS/e2e selectors] → audit task; keep class names; e2e update.
- [Hugo version may lack alert title/sign] → pre-pass fallback designed in D1.
- [Authors hide essential steps in DETAILS] → docs guidance + lint warning when a collapsed callout contains a fenced command block in a step without any visible command.
- [Troubleshooting index noise] → only rendered when ≥1 entry.

## Migration Plan

Additive; existing alerts gain icons (visual change, intended). Plain `>` unchanged. Rollback by reverting the render hook.

## Open Questions

- Should RESULT boxes count toward step completion hints (e.g. "Did you see this? Yes/No" feedback)? Deferred to a feedback-focused change.
