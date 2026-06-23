# Step-Navigation Indicators — Codecheck + Branch (riding the quiz-dot skeleton)

**Status:** Approved (Tom, 2026-06-23). Ready for implementation plan.
**Tracks:** Follow-up to PR #568/#569 — adds two new indicator slots and upgrades the existing quiz dot to share the same visual treatment.

## Goal

Steps in the tutorial right-column TOC (desktop) and bottom-sheet step list (mobile) should surface, at a glance, *what kind of work* the step demands:

- A **question** to answer (existing `[VALIDATE_N]` quiz — shipped as a bare green dot in PR #568)
- An **AI code-check** to submit (new — `[CODECHECK_N]` blocks, behind `ChatSettings.codeCheckEnabled`)
- A **branch decision** to make (new — `[BRANCH_N]` blocks from #172 PR 3)

The shipped quiz dot proved the skeleton: per-step frontmatter already carries the signal, Hugo emits a small DOM hook inside `.step-toc-circle`, CSS paints it. This change extends the skeleton from one indicator slot to three, gives each slot a distinct glyph for color-blind accessibility, and applies the same visual on mobile.

## Non-goals

- No parser changes. `validation`, `codeCheck`, `branchGroup`, and `branches[]` are already in per-step Hugo frontmatter ([scripts/parsers/render-frontmatter.ts:79-89](../../../scripts/parsers/render-frontmatter.ts#L79-L89)).
- No new runtime detection. Badges are baked at Hugo build, served as plain HTML in the gzipped tutorial BLOB.
- No counts. "≥1 present" is the only state. A step with 5 `[CODECHECK_N]` blocks shows the same single codecheck badge as a step with 1. Symmetric with the shipped quiz behavior (`validation.length` is irrelevant — presence is the test).
- No retroactive treatment of unrelated step metadata (`skipIf`, `branchPointId`, OS variants, etc.). Out of scope.

## Architecture

Build-time-static. Zero runtime JS. The three frontmatter fields drive three Hugo `{{ with }}` guards which emit zero, one, two, or three `<span class="step-badge step-badge--*">` elements inside a shared `.step-badge-row` wrapper. CSS paints each badge as a small (14px outer) tinted circle with an inline-SVG-mask glyph centered in it.

### Files touched

| File | Change |
|---|---|
| [hugo/assets/css/sap-fundamental.css](../../../hugo/assets/css/sap-fundamental.css) | Replace `.step-toc-quiz-dot` (8px bare dot, from PR #568) with a generic `.step-badge` + three modifiers (`--quiz`, `--codecheck`, `--branch`). Add `.step-badge-row` wrapper with two positioning variants (desktop-absolute, mobile-inline). |
| [hugo/layouts/partials/tutorial-sidebar.html](../../../hugo/layouts/partials/tutorial-sidebar.html) | Replace the single `{{ with .validation }}…{{ end }}` block from PR #568 with a 3-condition badge row inside `.step-toc-circle`. |
| [hugo/layouts/tutorials/u1-object-page.html](../../../hugo/layouts/tutorials/u1-object-page.html#L408) | Drop the `additional-text="Question"` + `additional-text-state="Positive"` attrs from PR #568. Prepend `<span class="step-badge-row">…</span>` into the `ui5-li` default slot. |
| [scripts/parsers/__tests__/render-frontmatter.test.ts](../../../scripts/parsers/__tests__/) (extend if present; new if not) | Verify `codeCheck` and `branchGroup` make it into emitted step frontmatter when source has `[CODECHECK_N]` / `[BRANCH_N]`. (Likely already covered for codecheck and branches separately by their own parser tests — confirm during implementation, add only gaps.) |
| `test/hugo/step-badges.test.ts` (new) | Render a synthetic tutorial fixture, assert the rendered sidebar HTML contains the expected badges per step in the expected DOM order. Source-string assert against `sap-fundamental.css` that the three modifier classes exist. |

### Frontmatter contract (already present — documented for clarity)

```yaml
steps:
  - number: 3
    title: "Submit your handler"
    validation:                                # → step-badge--quiz
      - kind: mcq
        prompt: …
    codeCheck:                                 # → step-badge--codecheck
      slug: handler-1
      languages: [javascript]
    branchGroup: auth-flow                     # → step-badge--branch
    branches:
      - id: oauth
        label: OAuth flow
      - id: basic
        label: Basic auth
```

Detection per badge:

- **Quiz**: `{{ with .validation }}` (truthy when array non-empty)
- **Codecheck**: `{{ with .codeCheck }}` (truthy when object set)
- **Branch**: `{{ with .branchGroup }}` (truthy when string set — single source of truth; do NOT also test `.branches` because a branch *target* step may legitimately lack a `branches[]` array)

## Visual design

### Badge specification

Each badge is a 14px-outer circle (11px inner color + 1.5px border in the surrounding background color, the same border trick PR #568 used so the badge stays legible when it overlaps an `.active` blue-filled or `.completed` green-filled circle).

| Slot | Horizon token | Hex (light) | Glyph (from `@ui5/webcomponents-icons/dist/v5/`) |
|---|---|---|---|
| Quiz | `--sapPositiveColor` | `#30914c` | `question-mark` |
| Codecheck | `--sapInformativeColor` | `#0070f2` | `source-code` |
| Branch | `--sapAccentColor6` | `#df9941` | `decision` |

Glyphs are rendered via CSS `mask-image: url("data:image/svg+xml;utf8,…")` with `background-color: currentColor`. The `<svg viewBox="0 0 16 16">` wrapper around each pathData (extracted verbatim from the v5/Horizon SAP-icons asset bundle at design time) is embedded inline in the CSS — three small data-URIs, ~250-700 bytes each, no font dependency, no Web Component upgrade, no extra HTTP request.

Why CSS mask + `currentColor` instead of `<ui5-icon>`: avoids upgrading ~50 custom elements per long tutorial in the right-column TOC; keeps the TOC zero-JS. Why CSS mask + `currentColor` instead of inline `<svg fill="…">`: the glyph path lives in one place (the CSS rule) and the color comes from a single `color:` declaration per modifier — easier theming, half the DOM.

### Stacking (when a step has multiple)

`.step-badge-row` is `display: inline-flex; flex-direction: row-reverse`. With `row-reverse`, the rightmost slot fills first — a step with only `branch` puts the branch badge at `right: -4px`; a step with quiz+branch shows them at `right: -4px` and ~`right: 4px` (overlapping by 3px); a step with all three occupies a ~36px cluster anchored to `right: -4px`.

Order of slots (left-to-right when all three present): **quiz, codecheck, branch**.

DOM order in the Hugo template matches the slot order. `flex-direction: row-reverse` is what makes the visual order be quiz-leftmost when all three are rendered.

### Desktop vs mobile positioning

```css
/* Desktop right-column TOC: badges float over the bubble's top-right corner */
.step-toc-circle .step-badge-row {
  position: absolute;
  top: -4px;
  right: -4px;
}

/* Mobile step-sheet: badges sit inline, before the step number text */
ui5-li .step-badge-row {
  display: inline-flex;
  vertical-align: middle;
  margin-right: 6px;
}
```

The `.step-badge` rules themselves are surface-agnostic — same color, same glyph, same overlap.

## Edge cases

| # | Case | Behavior |
|---|---|---|
| 1 | Step with all three indicators | All three badges render in a 36px cluster anchored to `right: -4px` of the `.step-toc-circle`. Verified math: 14px × 3 − (3px overlap × 2) = 36px. Fits within sidebar padding. |
| 2 | Step with zero indicators | The outer `{{ if or .validation .codeCheck .branchGroup }}…{{ end }}` guard prevents `.step-badge-row` from rendering. No empty span ships. |
| 3 | Multiple `[CODECHECK_N]` or `[BRANCH_N]` blocks in one step | Single badge — "≥1 present" semantics. Same as quiz. |
| 4 | Dark mode | `currentColor` reads from CSS variables (`--sapInformativeColor`, etc.) which flip in Horizon dark palette. Border uses `--sapList_Background` / `--sapBackgroundColor` which also flip. No dark-mode-specific rule needed. |
| 5 | Browser missing CSS `mask-image` support | Pre-Safari-15.4 / very old engines: badges show as solid colored circles with no glyph (still semantic via color + `title` attribute). Acceptable degradation. Project browserslist target already permits CSS masks (existing usage in `hugo/assets/css/` confirms). |
| 6 | Codecheck behind `ChatSettings.codeCheckEnabled` flag — feature off | Frontmatter `codeCheck` is **still emitted** at build time regardless of the runtime flag (the flag gates the UI's submit affordance, not the metadata). Per CLAUDE.md gotcha "AI code-check (issue #171)": the field is in frontmatter; the inline UI checks the flag at render time. The badge therefore shows even when codecheck is disabled. This is intentional — the badge advertises that the step has a codecheck *opportunity*; the runtime gate decides whether to render the submit UI. If we ever want to gate the badge on the flag too, that's a separate change in the layout (the flag isn't available in Hugo's build context). |
| 7 | `branchGroup` set but `branches[]` empty | The guard tests `branchGroup` only, so the badge still renders. This is correct: a branch *target* step legitimately has `branchGroup` without re-declaring branches. |

## Accessibility

- Each badge has a `title="…"` attribute (Quiz: "This step has a question"; Codecheck: "This step has a code check"; Branch: "This step has a branch point"). Visible on hover; read by screen readers as the accessible name.
- The `.step-badge-row` wrapper is `aria-hidden="true"` on mobile because the `ui5-li` already announces its visible text content (`{{ .number }}. {{ .title }}`). On desktop the `<a>` ancestor announces the step title via its `.step-toc-text`, and the badges' individual `title`s are decorative-supplementary.
- **Color is not the only signal**: each badge has a distinct glyph. A red-green color-blind user can still distinguish all three by shape alone (`?` vs `</>` vs fork).
- Contrast ratio of the white border against the colored fill is intentionally low because the border's job is to separate the badge from the bubble *behind* it, not to be a foreground element.

## Data flow

```
GitHub markdown (sap-tutorials/*)
    [VALIDATE_N] [CODECHECK_N] [BRANCH_N] blocks in step bodies
        │
        ▼  npm run fetch-tutorials  →  scripts/fetch-tutorials.ts
        │
        ▼  parser pipeline (per tutorial)
            • rules.ts        → step.validation[]   (existing)
            • codecheck.ts    → step.codeCheck      (existing)
            • branches.ts     → step.branchGroup + step.branches[]  (existing)
        │
        ▼  render-frontmatter.ts (no change — already emits all 3 fields)
        │
        ▼  Hugo build  →  hugo/public/tutorials/<slug>/index.html
            • tutorial-sidebar.html iterates .Params.steps, emits .step-toc-circle with 0-3 .step-badge children
            • u1-object-page.html iterates .Params.steps, emits ui5-li with 0-3 .step-badge children
        │
        ▼  publish-content.ts  →  HANA ContentFiles (gzip BLOB)
        │
        ▼  /content/tutorials/<slug> serves HTML; browser hits sap-fundamental.css
        │
        ▼  Static render — no JS, no hydration, no Web Component upgrade for badges
```

## Testing

| # | Layer | Location | Assertion |
|---|---|---|---|
| 1 | Parser unit (frontmatter emission) | Extend existing `scripts/parsers/__tests__/` tests if a gap exists | Steps containing `[CODECHECK_N]` → emitted step has `codeCheck`. Steps containing `[BRANCH_N]` → emitted step has `branchGroup` + `branches[]`. (Both likely already covered by codecheck.ts / branches.ts unit tests — confirm during implementation; add only the gap.) |
| 2 | Sidebar render (snapshot) | `test/hugo/step-badges.test.ts` (new) | Feed a synthetic tutorial fixture into Hugo via `npx hugo --renderToMemory` (or build a fixture and read `public/tutorials/<slug>/index.html`); assert `.step-toc-circle` of each step contains exactly the expected `.step-badge--*` children in DOM order quiz → codecheck → branch. |
| 3 | Mobile `ui5-li` slot | same file | Same fixture; assert the `ui5-li` slot HTML — `.step-badge-row` precedes `{{ .number }}. {{ .title }}`; **no `additional-text` attribute remains**. (Regression test against the PR #568 mobile path.) |
| 4 | CSS rule presence | same file (source-string assert) | `fs.readFileSync('hugo/assets/css/sap-fundamental.css')` includes `.step-badge--quiz`, `.step-badge--codecheck`, `.step-badge--branch`. Defends against accidental rule deletion. **Reads as source string, not via DOM** — Vitest stubs imported CSS in jsdom (see [feedback_vitest_skips_imported_css](../../../C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_vitest_skips_imported_css.md)). |
| 5 | Manual visual smoke | Local `npm run dev` against a real tutorial with all three blocks present | Eyeball check that the cluster reads cleanly in light + dark mode, on desktop sidebar + mobile bottom-sheet. Pick (or author) a fixture tutorial with the full matrix and document the slug in the PR. |

**No hybrid test.** No DB write path.
**No smoke test.** Build-time HTML/CSS only; nothing to verify against deployed CAP.
**No publish-content change.** Tutorials republish on the next `rebuild-content` run with the updated Hugo templates baked in.

## Risks & rollback

- **Visual regression on the quiz indicator** — PR #568 just shipped. This change upgrades the quiz dot to a 14px badge with a `?` glyph. Tom approved the upgrade in brainstorming (consistency win > visual continuity with #568's bare dot). Rollback is a one-line CSS revert of `.step-badge--quiz` back to a `width: 8px; height: 8px; mask: none` rule plus removing the badge-row Hugo wrapper — but the simpler rollback is `git revert` the whole PR.
- **CSS mask data-URI parse errors** — if the embedded SVG path has a stray `"` or `#` that breaks the URL parser, the mask silently fails and the badge renders as a solid circle. Mitigated by: (a) extracting paths verbatim from `@ui5/webcomponents-icons/dist/v5/*.js` (known-good source), (b) keeping the SVG wrapping minimal (`<svg viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'><path d='…'/></svg>` with single-quoted attrs to avoid escaping), (c) a manual smoke check in test #5.
- **Mobile `ui5-li` slot quirks** — the default slot is plain text in PR #568; this change introduces inline HTML. `ui5-li` reflows around the leading span; verified mentally but a manual check on the mobile sheet is in test #5.

Rollback path is a single `git revert` of the PR. No data migration, no schema change, no API change.

## Open questions

None. All five brainstorming questions resolved with Tom on 2026-06-23.
