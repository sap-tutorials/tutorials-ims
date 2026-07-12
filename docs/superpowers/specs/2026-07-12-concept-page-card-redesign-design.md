# Concept landing pages: related-content link lists → cards

**Issue:** [sap-tutorials/tutorials-ims#1127](https://github.com/sap-tutorials/tutorials-ims/issues/1127)
**Date:** 2026-07-12
**Status:** Design approved; ready for implementation plan

## Summary

Upgrade the ~6k concept landing pages from plain `<ul>`/`<li>` related-content
link lists to a richer **card** layout. Concept pages are not 6k stored
artifacts — they are one Hugo template (`hugo/layouts/concepts/single.html`)
filled with per-concept frontmatter, built to `hugo/public/concepts/<slug>/`,
then published as gzip BLOBs to HANA and served dynamically. A redesign is
therefore "edit template + CSS (+ a small backend/fetcher enrichment),
rebuild, republish."

All **12** related-content sections get the card treatment:

- **8 external-content sections** (already carry card-ready fields): videos,
  code samples, help docs, API docs, learning journeys, blog posts, discovery
  missions, community events.
- **4 internal cross-link sections** (currently `{slug,title}` only, enriched
  in this change): `teaches` (tutorials), `requires` / `requiredBy` /
  `relatedTo` (concepts).

## Decisions (resolved during brainstorming)

| Decision | Choice |
|---|---|
| Scope | All 12 sections → cards. |
| Cross-link enrichment | Concept cards (`requires`/`requiredBy`/`relatedTo`) show **name + description** (`Concepts.description`, `String(500)`, LOB-safe). Tutorial cards (`teaches`) show **title + difficulty badge + step count** (`Tutorials.experienceTag` + `Tutorials.stepCount`, both plain columns). **No NCLOB reads.** |
| Card layout | Responsive CSS grid, `auto-fill` columns (`minmax(280px, 1fr)`), aligned with the existing `.nav-card` system. |

Tutorial `description` is `LargeString` (NCLOB) and is **deliberately not read**
— the whole concepts query path already avoids pulling NCLOB columns alongside
metadata (LOB-locator safety). Tutorial cards use difficulty + step count for
their value signal instead.

## Architecture & data flow

The change touches three layers, in dependency order:

### 1. Backend query — `srv/lib/published-concepts-query.js`

Enrich the four cross-link arrays with additional plain columns:

- **`teaches`** (from `TutorialConceptLinks`, predicate `teaches`): add
  `tutorial.experienceTag` and `tutorial.stepCount` to `.columns()` and the
  row mapper. Existing mapper emits `{slug, title}`; extend to
  `{slug, title, experienceTag, stepCount}`.
- **`requires` / `relatedTo`** (outgoing `ConceptEdges`, joined on `target`):
  add `target.description as target_description`. Mapper emits
  `{slug, name, description}`.
- **`requiredBy`** (incoming `ConceptEdges`, joined on `source`): add
  `source.description as source_description`. Mapper emits
  `{slug, name, description}`.

All added columns are plain (`String(255)` / `Integer` / `String(500)`). No
NCLOB, no new LOB-locator hazard. No new queries — only extra columns on the
three existing `ConceptEdges` / `TutorialConceptLinks` selects.

### 2. Fetcher — `scripts/fetch-concepts.ts`

Emit the new fields into per-concept frontmatter:

- Extend the `ConceptPayload` TypeScript interface: `teaches` gains
  `experienceTag?: string` + `stepCount?: number`; `requires`/`requiredBy`/
  `relatedTo` gain `description?: string`.
- The `refs()` helper currently serializes only `slug` + `title`. Replace the
  single shared `refs()` with per-shape emitters (or extend `refs()` to accept
  optional extra fields) that conditionally emit `experienceTag`/`stepCount`
  (tutorials) and `description` (concepts) with the same per-field `if` guards
  used by the other sections. Preserve the empty-array ` []` (leading-space)
  behavior — the existing YAML-validity guard.

### 3. Template + CSS — primary change

- **`hugo/layouts/concepts/single.html`**: for each of the 12 sections,
  convert the `<ul>` into `<div class="concept-card-grid">` (or a `<ul>` styled
  as a grid) and each `<li>` into an `<a class="concept-card" …>` (with the
  `<span>` fallback when `$isSafe` is false). Reuse the existing inline-element
  classes inside cards where they fit.
- **`hugo/assets/css/sap-fundamental.css`** (the postcss *source*): append a
  `.concept-card*` class family. `npm run build:css` compiles the source →
  `hugo/static/css/sap-fundamental.css`, which `head.html` links. **Edit the
  `assets/` source, never the `static/` output directly.**

## Card anatomy

Each section retains its `<section data-kg-section=… data-concept-slug=…>`
wrapper and `<h2>`. The list becomes a card grid; each item becomes a
whole-card `<a>` (the click target).

```
┌──────────────────────────┐
│ [TYPE LABEL]      [badge] │  ← e.g. "VIDEO" / "SAMPLE" micro-label; link-out ↗
│ [optional thumbnail]      │  ← videos only (width:100%, scales to column)
│ Title (bold, 2-line clamp)│
│ Body (optional, clamped)  │  ← help-docs snippet; concept description
│ ───────────────────       │
│ meta · meta · meta        │  ← footer: channel·date / lang·stars·updated / …
└──────────────────────────┘
```

The whole card `<a>` carries the same `data-*-slug` attribute the telemetry
listeners query for (`a[data-video-slug]`, `a[data-sample-slug]`, …), so the
delegated click JS at the bottom of the template is **unchanged**.

### Per-section content mapping (all fields already available post-enrichment)

| Section | Type label | Thumb | Title | Body | Footer meta |
|---|---|---|---|---|---|
| Videos | VIDEO | ✓ `thumbnailUrl` | title | — | `channelTitle` · date |
| Code samples | SAMPLE | — | title ↗ | — | `language` · N stars · Updated Mon YYYY |
| Help docs | source badge (CAP / UI5 / SAP Help) | — | title ↗ | `snippet` | `anchorLabel` |
| API docs | API DOC | — | title ↗ | — | `category` · `apiType` |
| Learning journeys | JOURNEY | — | title ↗ | — | level · `durationHours`h |
| Blog posts | BLOG | — | title ↗ | — | by `authorName` · date |
| Discovery missions | MISSION | — | title ↗ | — | effort N · `categoryLabel` |
| Community events | EVENT | — | title ↗ | — | `location` · `startDate` · 🌐 |
| Teaches (tutorials) | TUTORIAL | — | title | — | difficulty badge · N steps |
| Requires / RequiredBy / RelatedTo (concepts) | CONCEPT | — | name | description (clamped) | — |

Reused existing classes: `.kg-help-source--*` (source badge), `.kg-api-type`,
`.kg-language`, `.kg-link-out` (↗), `.kg-video-thumb` (adapted to scale within
the card).

## CSS design (`.concept-card*` family, Horizon-aligned)

Namespaced `concept-card` (self-contained; no dependency on the Vue-owned
`hugo-apps/src/shared/cards/card.css`), but visually matching `.nav-card`:
same radius, subtle shadow, hover lift, and `--sap*` theme vars throughout.

```css
.concept-card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
}
.concept-card {
  display: flex; flex-direction: column;
  background: var(--sapBaseColor, #fff);
  border: 1px solid var(--sapGroup_ContentBorderColor, #e5e5e5);
  border-radius: 0.75rem;
  padding: 1rem;
  text-decoration: none; color: inherit;
  transition: box-shadow .15s ease, transform .15s ease;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
}
.concept-card:hover {
  box-shadow: 0 4px 20px rgba(0,0,0,.1);
  transform: translateY(-1px);
}
a.concept-card:hover .concept-card__title { color: var(--sapBrandColor, #0070f2); }
```

Plus:

- `.concept-card__type` — uppercase micro-label with a colored dot
  (`::before`), matching `.nav-card__type`. Per-section accent color via a
  modifier class.
- `.concept-card__title` — bold, `--sapTextColor`, 2-line clamp.
- `.concept-card__body` — muted (`--sapContent_LabelColor`), 2–3-line clamp
  (snippet / concept description).
- `.concept-card__meta` — footer row, top border
  (`--sapGroup_ContentBorderColor`), `·`-separated, small + muted.
- `.concept-card__thumb` — reuse the 120×68 aspect, but `width:100%; height:auto`
  so it scales to the column width.

**Theme safety:** every color is a `--sap*` var with a light fallback. Dark
mode already sets those vars via `sap-horizon-dark.css` + `html.dark`, so cards
adapt automatically. Add explicit `html.dark .concept-card` border/shadow
overrides only if the fallbacks look off during verification.

**Accessibility:**
- Whole-card `<a>` = one focusable target per item.
- Type label + badges are text, not color-only.
- `↗` stays `aria-hidden="true"` with adjacent visible text.
- Thumbnails keep `alt=""` (decorative; title conveys meaning) + `loading="lazy"`.

**Mobile:** `minmax(280px, 1fr)` auto-collapses to a single column below ~296px
effective content width. Add a `@media (max-width: 640px)` padding tighten only
if needed during verification.

## Invariants preserved (verified against smoke tests)

The following must not change — only the wrapping markup (`<ul><li>` → card
grid) does:

- `data-kg-section="…"` attributes on each `<section>`
  (`test/smoke/concept-page-help-docs.test.js`,
  `concept-page-community-events.test.js` assert these).
- H2 section titles verbatim ("Docs explaining this concept", etc.).
- Section ordering (smoke tests compare `indexOf` positions).
- `/concepts/<slug>/` and `/tutorials/<slug>/` internal hrefs
  (`concepts-route.smoke.test.js`).
- `data-*-slug` telemetry hooks → delegated click JS at page bottom unchanged.
- `{{ with }}` hide-when-empty guards on every section.
- `$isSafe` URL-scheme guard + `target="_blank" rel="noopener"` link hardening;
  `<span>` fallback for non-http(s) URLs.
- The page-load `kg.concept.viewed` telemetry + hidden `#concept-telemetry` div.

## Testing & verification

1. `npm run build:css` — compile the postcss source to the static output.
2. `cds watch` (local, in-memory SQLite) → `CAP_BASE_URL` fetcher run
   (`npm run fetch-tutorials` path / `scripts/fetch-concepts.ts`) → `npm run dev`.
3. Visually verify a concept page with populated sections in **light and dark**
   themes; check grid wrap at desktop/tablet/mobile widths.
4. Run the concept smoke tests (`test/smoke/concept-page-*.test.js`,
   `concepts-route.smoke.test.js`) — they must stay green (assert attributes,
   titles, ordering, hrefs, all preserved).
5. Existing `fetch-concepts` / `build-concepts` tests
   (`test/hybrid/build-concepts.test.js`) — extend if they snapshot the
   enriched frontmatter shape.

## Deployment note (out of band from code change)

Applying this to production requires the standard local-deploy chain
(`npm run build:all` → `mbt build` → `cf deploy`) for the approuter/CSS, **plus**
a full content republish so all ~6k concept pages re-render with the new
markup: `gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims
--ref main -f mode=full` (~10 min). **Never** publish concept content from a
workstation. Storage impact: a small single-digit-% bump in per-page gzip size
(card wrapper divs + classes are exactly the repetitive boilerplate gzip
crushes) × 6k pages — not a concern. Rendering and serving costs are unchanged.

## Key files

- `hugo/layouts/concepts/single.html` — the single template for all ~6k pages (primary change)
- `hugo/assets/css/sap-fundamental.css` — postcss source; append `.concept-card*` family
- `scripts/fetch-concepts.ts` — emit enriched cross-link fields into frontmatter
- `srv/lib/published-concepts-query.js` — enrich `teaches`/`requires`/`requiredBy`/`relatedTo` with extra columns
- `hugo-apps/src/shared/cards/card.css` — reference only (`.nav-card` visual language to align with)
- `test/smoke/concept-page-*.test.js`, `test/hybrid/build-concepts.test.js` — regression coverage
