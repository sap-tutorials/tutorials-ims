# License Key Icon for Tutorials

**Issue:** [sap-tutorials/tutorials-ims#81](https://github.com/sap-tutorials/tutorials-ims/issues/81)
**Status:** Approved design — ready for implementation plan
**Date:** 2026-05-28

## Problem

Tutorials that require an SAP product license currently surface that fact only as the literal text chip "License" — derived from the `tutorial>license` tag in their markdown frontmatter. The legacy AEM frontend at `developers.sap.com` shows a small key icon next to such tutorials' titles and on tutorial cards (see issue screenshots). Our Hugo-based replacement loses that visual cue. Users scanning a list of cards have no quick way to spot license-gated tutorials.

The example flagged in the issue: <https://developers.sap.com/tutorials/joulestudio-agent-create.html> — its source markdown contains `tags: [ tutorial>beginner, software-product>sap-business-technology-platform, tutorial>license]`.

## Goal

Render a key icon on every surface where a license-gated tutorial (or a mission/group containing one) is presented, and remove the redundant "License" text chip so the icon stands alone.

## Non-goals

- No distinction between license types (trial, paid, BYOL, etc.) — single boolean signal.
- No email/download gating, paywall, or auth-aware behavior — purely visual.
- No new admin UI — authors continue to set the tag in markdown.
- No migration of other AEM-era icons (regional flags, "BYOL" badges) — the key icon only.

## Detection signal

A tutorial requires a product license iff its raw `tags` frontmatter array contains the literal string `tutorial>license`. This is the existing source of truth, written by tutorial authors in the markdown header.

The signal flows through the build pipeline as follows:

1. `scripts/parsers/render-frontmatter.ts:64` and `scripts/fetch-tutorials.ts:174` already preserve the raw `tags` array on the generated Hugo frontmatter and pass `displayTags` (humanized form, includes `"License"`) into `_nav.json`.
2. Hugo templates can read `.Params.tags` directly to test for `"tutorial>license"`.
3. The Vue navigator already receives `displayTags` per item — `displayTags.includes("License")` is the lookup.
4. Mission and group cards inherit the signal automatically: their `displayTags` are computed as the deduped union of every child tutorial's `displayTags` (`TutorialNavigator.vue:333-362`), so `"License"` propagates upward with no extra plumbing.

No schema changes. No new derived fields. The check is one Go-template line and one TypeScript expression.

## Visual treatment

A standalone SAP key glyph — no accompanying "License" text. Sourced from the SAP icon set the project already loads (sap-icons font for Hugo templates, `@ui5/webcomponents-icons/dist/key` for the Vue navigator if a UI5 web-component icon is preferred there).

- **Color:** `currentColor` so the icon inherits the surrounding text color and adapts to Horizon light/dark themes via existing CSS variables.
- **Size:** matches the inline icon size used by neighbors (~14–16 px for chip-row contexts; slightly larger when sitting next to the `<h1>` title — to match AEM screenshot 1).
- **Tooltip / `aria-label`:** `"Requires a product license"`.
- **Placement on the Object Page:** directly after the `<h1>` title text (matches AEM screenshot 1) **and** in place of the License chip in the chip strip below the title.

The literal "License" string is filtered out of every visible `displayTags` chip list so the standalone key icon never appears alongside a redundant text chip.

## Surfaces touched

| Surface | File | Treatment |
|---|---|---|
| Tutorial Object Page header — next to H1 title | `hugo/layouts/tutorials/u1-object-page.html:192` | Inline key icon directly after `{{ .Title }}` when `tutorial>license` ∈ `.Params.tags` |
| Tutorial Object Page header — chip strip | `hugo/layouts/tutorials/u1-object-page.html:198-203` | Filter `"License"` out of the rendered chip range |
| Generic tutorial-meta partial | `hugo/layouts/partials/tutorial-meta.html:14-19` | Filter `"License"` out of `.tutorial-tag` chips; emit key icon before the tag block when applicable |
| Mission single page | `hugo/layouts/missions/single.html:22` | Filter `"License"` out of chips; emit key icon if any child tutorial requires license (inherited via `.Params.displayTags`) |
| Group single page | `hugo/layouts/groups/single.html:18` | Same as mission single page |
| Vue navigator card grid | `hugo-apps/src/navigator/TutorialNavigator.vue:715-760` | Render small key icon inside the card; signal from `displayTags.includes("License")`; filter `"License"` out of any rendered tag list inside the card |

For the Vue card, the icon position is the top-right corner of the card (or beside the type pill — final placement chosen during implementation; both are consistent with AEM's screenshot 2).

## Mechanism

Two render-time helpers, no shared abstraction across languages because the check is a one-liner in each.

### Hugo

A small reusable partial:

- `hugo/layouts/partials/license-icon.html` — emits `<span class="license-key" aria-label="Requires a product license" title="Requires a product license"><i class="sap-icon--key"></i></span>` (exact icon-class chosen during implementation, matching the project's icon-font conventions). Includes a visually-hidden `<span class="visually-hidden">Requires a product license</span>` for screen readers.

Detection at each call site: `{{ if in .Params.tags "tutorial>license" }}{{ partial "license-icon.html" . }}{{ end }}`.

Chip-filter at each call site: `{{ range . }}{{ if ne . "License" }}<span class="...">{{ . }}</span>{{ end }}{{ end }}`.

### Vue

A single helper inside `TutorialNavigator.vue`:

```ts
const requiresLicense = (item: NavItem) => item.displayTags.includes('License')
const visibleTags     = (tags: string[]) => tags.filter(t => t !== 'License')
```

Render `<span v-if="requiresLicense(item)" class="nav-card__license" aria-label="Requires a product license" title="Requires a product license">…</span>` inside the card markup, and use `visibleTags(item.displayTags)` anywhere chips are rendered.

## Filter / search behavior

The `"License"` token continues to appear in the navigator's tag-filter facet sidebar. Authors and learners can still filter by "requires license" — only the *card-level visible chip* is hidden. This is the cheaper of two options and preserves a useful capability AEM did not expose.

## Accessibility

- The icon is the sole visual cue; therefore it is **not** decorative. Each rendered icon includes both `aria-label="Requires a product license"` on the wrapping element and a visually-hidden text equivalent.
- `title` attribute provides a native browser tooltip on hover, consistent with how other inline glyphs in the project surface meaning (e.g., the level/time icons in `tutorial-meta.html`).
- No interaction is added — the icon is not focusable on its own. Screen readers announce the label as part of the heading or card content flow.

## Tests

- **Parser unit:** extend `scripts/__tests__/hugo-write.test.ts` to assert that a fixture frontmatter with `tutorial>license` flows that exact string through to the generated Hugo `tags` array. (No new schema field, so no new field assertion.)
- **Vue component:** add a test in `hugo-apps/src/navigator/` that, given a `NavItem` with `displayTags: ['License', 'CAP']`, the rendered card contains the license-icon element and does not render a `"License"` chip.
- **Smoke:** add to `test/smoke/` an assertion that the deployed `/tutorials/joulestudio-agent-create.html` contains the license-icon class and does **not** contain the literal `>License<` text inside its chip strip. Account for HTML minification per the existing convention (regex tolerant to attribute-quote stripping — see [feedback memory: Hugo Minifier Strips Quotes](C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_hugo_minifier_strips_quotes.md)).

## Rollout

- Single PR. No data migration. No env-var or config flag.
- The change is purely cosmetic: builds without `tutorial>license` tags render unchanged; existing tutorials gain the icon on first deploy after the build pipeline runs.
- Reversible by reverting the PR; no DB or HANA-side state involved.

## Open questions

None at design-approval time. Final icon class name (sap-icon font vs UI5 web-component) and exact CSS positioning will be chosen during implementation.

## Implementation pins (locked at planning time, not now)

These were left flexible above so the design wasn't over-specified. The implementation plan must commit to one choice each before coding starts:

- **Icon source per surface.** Pick one consistent class name / element across every surface so the smoke test's selector has a single target. Default leaning: sap-icon font (`<i class="sap-icon--key">`) for Hugo templates, mirrored to a same-class `<i>` inside the Vue card so a single CSS rule covers both. Alternative: `<ui5-icon name="key">` web component — only if the project already loads `@ui5/webcomponents-icons` on every page where the icon must render (it does on the Object Page; verify for navigator and group/mission pages before choosing).
- **Smoke-test selector specificity.** The "no `>License<` chip" assertion must scope to the chip strip's CSS class (e.g., `op-chip--tag` on the Object Page, `tutorial-tag` in the meta partial) — not the whole document — so a step body that legitimately discusses licensing doesn't cause a false negative.

## References

- Issue: <https://github.com/sap-tutorials/tutorials-ims/issues/81>
- Example AEM page: <https://developers.sap.com/tutorials/joulestudio-agent-create.html>
- Source markdown (cached): `.tutorial-cache/joulestudio-agent-create.md`
- Generated Hugo page (cached): `hugo/content/tutorials/joulestudio-agent-create.md`
