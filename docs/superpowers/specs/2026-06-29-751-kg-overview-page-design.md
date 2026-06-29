# Knowledge Graph Overview Page — Design Spec

- **Status:** Draft for review
- **Tracking issue:** [#751](https://github.com/sap-tutorials/tutorials-ims/issues/751)
- **Date:** 2026-06-29
- **Author:** Tom Jung (with Claude)
- **Predecessor specs:**
  - [`2026-06-17-knowledge-graph-design.md`](./2026-06-17-knowledge-graph-design.md) (Phase 1)
  - [`2026-06-27-446-knowledge-graph-phase3-design.md`](./2026-06-27-446-knowledge-graph-phase3-design.md) (Phase 3)
  - [`2026-06-28-447-knowledge-graph-phase4-architecture.md`](./2026-06-28-447-knowledge-graph-phase4-architecture.md) (Phase 4 chassis)
- **Related architecture doc:** [`docs/developers/architecture/hana-kge-access.md`](../../developers/architecture/hana-kge-access.md)

## Summary

A new public Hugo page at `/explore/about/` that serves as the **narrative companion to `/explore/`** — part documentation, part showcase. Tells visitors what the Knowledge Graph is, what's in it, where they see it in action across the product, and the six SAP technologies that make it work. Primary audience is curious public developers visiting developers.sap.com; secondary audience is internal SAP showcasers (developer advocates, sales engineers) who need lift-and-shift screenshots for slides.

The page is **layered** — top sections welcome the casual visitor with a hero, a "wow" architecture diagram, and a corpus breakdown; lower sections give showcasers the tech-stack badge grid and the four product-surface screenshot grid that closes with a primary CTA back to the live viz. A small live-stats counter in the hero (powered by a new `GET /build/kg-stats` endpoint) gives the page a recursive-demo flourish: the page that describes the graph *also reads* the graph.

This spec produces **one new public Hugo page, one new Vue 3 island, one new unauthenticated CAP endpoint, and one bidirectional cross-link from `/explore/`**. No schema changes, no cron-job changes, no changes to the `KnowledgeGraphService` OData surface.

## Goals

1. **Showcase, not documentation.** The page exists to *show off* the Knowledge Graph and the SAP technologies behind it. Reference-grade engineering documentation remains in `docs/developers/architecture/` and the predecessor specs; this page is for visitors who'd never read those.
2. **Layered for two audiences.** Public developers see "what is this thing and how do I try it" up top; internal showcasers find tech-stack screenshots and a badge grid further down the page. One page, both audiences served, no audience hidden from the other.
3. **Bidirectional with `/explore/`.** `/explore/` (the live viz) gets an "About this graph →" link; `/explore/about/` (this page) closes with a primary CTA back to `/explore/`. The two pages are siblings under one IA branch.
4. **Recursive demo.** The hero live-stats counter (`X tutorials · Y concepts · Z relationships`) is fetched from the live graph at page load. The page literally uses the thing it describes.
5. **Forward-compatible with Phase 4.** When Phase 4.x sub-phases (learning journeys, blog posts, videos, API docs, code samples) add content types to the graph, the corpus section grows by one tile per sub-phase. **No page redesign required** — a 1-bullet content-only update PR each time.

## Non-Goals

- **A new top-level navigation entry.** The page is reached via the chrome link on `/explore/`, via slide URLs, README links, tweets, and Google. Adding it to the global header would clutter the nav and isn't worth it — this page is a destination, not a section.
- **A new theme toggle scoped to this page.** The site-wide theme toggle (shellbar `#sb-theme` button) governs this page as it does every other Hugo page; the page does not opt out of either light or dark mode.
- **Visual-regression tests.** Adding screenshot-diff infrastructure for one marketing page is over-engineering. Manual one-time pass at merge is sufficient; we re-test only when the design changes.
- **A dark-mode-specific surface screenshot set.** Surface-card screenshots are single-theme (light) framed by theme-aware containers. This is the standard pattern on developers.sap.com showcase pages and the right cost trade.
- **Mini-viz teaser** (a degraded Sigma.js render of 20 nodes inside the page itself). Considered and rejected — duplicating a degraded version of `/explore/` on the showcase page confuses visitors about which is "real," and the "Open the live graph →" CTA is the cleaner answer.
- **Localization.** Site is English-only per long-standing project decision; page is English-only.
- **Joule deep-link infrastructure.** The Joule card's CTA opens the shellbar with a pre-filled prompt via a query parameter the Joule launcher already accepts. No new wiring; if the query param doesn't exist yet in `joule.js`, ~10 lines of JS land alongside the page in PR 2.
- **A `/build/kg-stats` extension to the existing `KnowledgeGraphService` OData service.** The stats endpoint is a hand-curated JSON shape with no entity behind it; it belongs in the `/build/*` family of unauthenticated public-page endpoints alongside `/build/catalog` and `/build/navigator`, not as an OData function.

## Approach

### Where the page lives

- **URL:** `/explore/about/`.
- **Rationale:** Keeps the KG IA self-contained under one branch — `/explore/` (the live viz), `/explore/about/` (this page), `/concepts/<slug>/` (per-concept landing pages from Phase 3). A top-level slug like `/knowledge-graph/` was considered and rejected in favor of subroute clarity.
- **Hugo route generation:** automatic from a frontmatter stub at `hugo/content/explore/about/_index.md`.
- **AppRouter:** matched by the existing catch-all static-file route in `approuter/xs-app.json` — no new route needed.
- **Sitemap:** automatic; canonical URL `https://developers.sap.com/explore/about/`.

### Audience layering (top to bottom)

Public-developer content above the fold, showcase content below, all on one page. The layering is achieved through section order, not through tabs or toggles.

### Page sections

Top-to-bottom order locked during brainstorming as **"Hero → Diagram → Corpus → Tech → Surfaces → CTA"** (option C from the layout mockups). Diagram is section #2 to land the "wow" while attention is still high; surfaces grid moves to penultimate, acting as a bridge to the closing CTA.

#### Section 1 — Hero

- Full-width SAP-blue gradient band.
- `<h1>` page title: "The SAP Developer Knowledge Graph".
- Subtitle (one sentence): "A live graph of the tutorials, missions, and concepts that make up developers.sap.com, built by AI and powered by SAP HANA Cloud."
- **Live stat counter** — three large numbers (tutorials · concepts · relationships) rendered by a small Vue island, fetched from `GET /build/kg-stats`. Skeleton shimmer until the fetch resolves; gracefully degrades to a static fallback if the endpoint fails. A brief count-up animation (~600 ms, 0 → final) plays on mount; suppressed when `prefers-reduced-motion`.
- **No CTA in the hero** — the CTA lives at the bottom of the page; the hero exists to land the headline.

#### Section 2 — Architecture diagram

- The "wow" piece. Section #2 by design.
- **Style:** SAP product-marketing horizontal flow diagram (option A from the diagram mockups). Boxes-and-arrows, left-to-right, SAP brand blue.
- **Content:** four boxes left-to-right
  1. **Tutorial markdown** (GitHub) →
  2. **Concept extractor** (SAP AI Core) →
  3. **CDS entities** (CAP, canonical state) →
  4. **KG projection** (HANA KGE, SPARQL)

  Below the four-box pipeline, four consumer chips fanned out: **Sidebar · /explore/ · Concept pages · Joule**.
- **Format:** hand-authored SVG, inline in the page template (NOT `<img src>`, so CSS variables apply for theming). Committed verbatim at `hugo/static/img/knowledge-graph/architecture.svg`. Every `fill` and `stroke` is a CSS custom property (e.g. `var(--kg-diagram-box-bg)`); variables defined in `_kg-overview.postcss` under both `[data-theme="light"]` and `[data-theme="dark"]` scopes so the same SVG renders correctly in both themes from day one.
- **Caption:** one-paragraph prose explanation below the diagram, in body type.
- **Accessibility:** SVG `<title>` and `<desc>` elements supply the alt-text equivalent.

#### Section 3 — Corpus breakdown ("What's in the graph")

- Three-column grid, each column = icon + name + 2-line description + count.
- **Tiles (Phase 1+3 set):**
  1. **Tutorials** — every tutorial in `sap-tutorials/*`. Edges: `teaches Concept`, `requires Concept`. Count: `tutorials` from `/build/kg-stats`.
  2. **Concepts** — AI-extracted topics (CAP, SAPUI5, HANA Cloud, …). Edges: `requires Concept`, `relatedTo Concept`. Count: `concepts`.
  3. **Missions & groups** — curated learning paths. Edges: `containsTutorial`. Count: `missionsAndGroups`.
- **Phase 4 forward-compatibility:** the layout accommodates additional cards (learning journeys, blog posts, videos, API docs, code samples) dropping in below as Phase 4 sub-phases ship — no restructuring, just additional tiles.

#### Section 4 — "The tech behind it" (badge grid)

- 3×2 grid of badges. All six SAP technologies present:

  | Tile | One-line role |
  |---|---|
  | **SAP HANA Cloud Knowledge Graph Engine** | RDF triple store; SPARQL via `SYS.SPARQL_EXECUTE` |
  | **SAP HANA Cloud Vector Engine** | Embedding similarity; powers concept consolidation |
  | **SAP HANA Cloud Multi-Model** | Graph + vector + relational in one DB — no ETL |
  | **SAP AI Core / Generative AI Hub** | Extracts concepts from tutorial markdown; weekly consolidator merges duplicates |
  | **SAP Cloud Application Programming Model (CAP)** | Service layer, scheduler, cron jobs that build the graph |
  | **SAP BTP Cloud Foundry** | The runtime |

- Each tile = small SAP logo glyph, technology name, one-line role, link to the official SAP docs page for that capability.
- **Multi-Model callout (visual treatment, not a separate section):** the three HANA tiles share a subtle border / accent so visitors read them as "one HANA Cloud instance, three capabilities." A short caption under the grid says "All three HANA tiles run on the same SAP HANA Cloud instance — that's the multi-model story." This solves the "is HANA Cloud one thing or three" tension without giving Multi-Model its own section and stealing the architecture diagram's thunder.

#### Section 5 — "Where you see it in action" (2×2 surfaces grid)

- 2×2 grid of cards, each = real product screenshot + name + one-sentence description + CTA.
- **Cards (order locked):**
  1. **Live graph at `/explore/`** *(primary, top-left)* — visually elevated (slightly larger image, primary-blue button "Open the live graph →" instead of secondary-text "See it on …" links).
  2. **On every tutorial page** — tutorial-page sidebar with prereq / related / next-step links. CTA → a representative tutorial.
  3. **Concept landing pages** — `/concepts/<slug>/`. CTA → the concepts index.
  4. **Joule learning paths** — "Find me the shortest path between two tutorials." CTA opens the Joule shellbar with a pre-filled prompt via a query parameter. The existing `joule.js` already handles `?joule=open` (see [hugo/static/js/joule.js:742](../../../hugo/static/js/joule.js#L742)); the pre-fill is a small extension next to that block (~5–10 lines) that reads a second query parameter and calls the panel's send path before the hero renders. Lands in PR 2 alongside the page.
- **Surface screenshots are single-theme (light)** framed by theme-aware containers using existing `--sap*` tokens. The same single PNG/WebP is shown in both light and dark mode, with the container's background and shadow adapting. (One-screenshot-per-theme was considered and rejected as 4x the maintenance cost for marginal benefit.)
- **Narrative arc** baked into the card order: **discover** (sidebar) → **explore** (live viz, elevated) → **deepen** (concept page) → **converse** (Joule). Not just four screenshots; the user journey in four boxes.
- The RAG-backed `getRelevantSteps` tool (Joule backstage) is deliberately omitted — invisible to the user, nothing screenshot-worthy. May be added later if the page feels missing-a-piece in practice.

#### Section 6 — CTA strip

- Light-grey full-width band at the bottom of the page.
- **Primary CTA (left):** "Explore the live graph →" → `/explore/`. Big, SAP-blue button.
- **Two small text links (right):**
  - "Read the SAP HANA Cloud Knowledge Graph documentation →" — external SAP Help link.
  - "View the source on GitHub →" — `https://github.com/sap-tutorials/tutorials-ims`.
- Pattern: single primary CTA + small secondary links. Conventional, conversion-optimized; gives showcasers a "go deeper" exit and developers a "see the code" exit without diluting the primary action.

### Site chrome integration

- Page extends `hugo/layouts/_default/baseof.html`, which provides the **standard shellbar header and site footer** every other public Hugo page uses. The page does not opt out of either.
- The shellbar's existing theme-toggle button (`#sb-theme`) governs this page's theme like every other. A user who set the site to dark on `/tutorial-navigator/` arrives at `/explore/about/` already in dark.
- The Joule launcher and navigator dropdown in the shellbar work as on every other page.

### Theme (light & dark) — required from day one

The site already supports both themes via the `data-theme` attribute on `<html>` ([baseof.html:2](hugo/layouts/_default/baseof.html#L2)), driven by OS `prefers-color-scheme` with a localStorage user override toggled via the shellbar ([header.html:11](hugo/layouts/partials/header.html#L11)). The KG overview page **must** support both modes from day one.

- **Hero gradient:** light = `#0a6ed1 → #1c478a`. Dark = `#0a4a8e → #0a1e3c` (deeper to keep white title at AA).
- **Architecture SVG:** theme-aware via CSS custom properties, inline in the template.
- **Cards (corpus, tech, surfaces):** use existing `--sap*` design tokens that are already theme-aware (`--sapTile_Background`, `--sapTextColor`, `--sapList_BorderColor`, `--sapContent_Shadow`).
- **Surface screenshots:** single-theme (light), framed by theme-aware containers.
- **Live counter island:** reads `document.documentElement.dataset.theme` on mount and listens for the existing `theme-changed` custom event (the same pattern other islands already use).

### Responsive behavior

- **Desktop (≥1024px):** full layout as designed.
- **Tablet (768–1023px):** hero counters stay horizontal; corpus grid stays 3-col; tech badges drop to 2×3; surfaces stay 2×2.
- **Mobile (<768px):** hero counters stack vertically; corpus grid 1-col; tech badges 2×3 or 1×6 (chosen at implementation by feel); surfaces stack 1-col. Architecture SVG scales down via `viewBox`.

### Accessibility

- Single `<h1>` (the hero title); `<h2>` for each subsequent section.
- Live counters announced via `aria-live="polite"` on initial render only (not on every count-up frame, which would spam screen readers).
- Architecture SVG has `<title>` + `<desc>` elements that match the page's prose explanation.
- Surface-card screenshots have descriptive `alt` text (e.g. "Tutorial sidebar showing prereqs, related tutorials, and next-step links").
- Color contrast: tested at AA across both themes, including the SAP-blue gradient hero with white text at 18pt+.
- Target Lighthouse a11y score: **≥95**.

## Backend additions

One new endpoint, no schema changes, no service changes.

### `GET /build/kg-stats` — unauthenticated public endpoint

- **Service:** registered as an express bridge route in [srv/server.js](../../../srv/server.js) under the existing `/build/*` family (alongside `/build/catalog`, `/build/navigator`, `/build/slug-mapping`). Handler module at `srv/routes/kg-stats.js`.
- **Auth:** none — same as `/build/catalog`. The values are aggregate counts of public content; no privacy concern.
- **Response shape:**

  ```json
  {
    "tutorials": 1432,
    "concepts": 312,
    "relationships": 2847,
    "missionsAndGroups": 96,
    "lastExtractedAt": "2026-06-28T03:17:42Z",
    "generatedAt": "2026-06-29T18:04:11Z"
  }
  ```

- **Implementation:**
  - Four `COUNT(*)` queries via `cds.ql` against the existing entities — `Tutorials`, `Concepts` (filtered to the published gate, i.e. `where({ status: 'ACTIVE' })` AND `publishedAt IS NOT NULL` — per [db/knowledge-graph.cds](../../../db/knowledge-graph.cds) the `Concepts.status` enum is `ACTIVE | MERGED | VETOED` (no `PUBLISHED`); the public-published gate is the documented `publishedAt IS NOT NULL AND status = 'ACTIVE'`), `ConceptEdges` (filter to `status = 'ACTIVE'`), and `Missions` + `Groups` (summed for the `missionsAndGroups` field; `Groups` is the entity name in [db/schema.cds](../../../db/schema.cds), not `CompletionPaths`).
  - One `MAX(extractedAt)` on `ConceptEdges` for `lastExtractedAt` — `extractedAt` lives on the link/edge entities, **not** on `Concepts` itself. Using `ConceptEdges.extractedAt` gives "when was the graph last rebuilt" which is what visitors care about.
  - No SPARQL — these are projection-input counts; the underlying CDS entities are the truth.
- **Caching:** 60-second in-memory TTL inside the handler + `Cache-Control: public, max-age=60, stale-while-revalidate=300`. Same pattern as `/api/advocates`.
- **Defensive fallback:**
  - If all four queries succeed: return the fresh payload.
  - If any single query throws: return HTTP 503 (don't ship partial counts).
  - If the handler has a previously-returned successful payload cached and is now in an error state: return the last-good payload with HTTP 200 (graceful degradation when the DB hiccups briefly).
  - If never had a successful response and the DB is down: HTTP 503. The Vue island then renders the static fallback ("Live counters momentarily unavailable").

### `KnowledgeGraphService`, `/graph/*`, cron jobs

**No changes.** The page does not call `/graph/*` OData. The static link to "Open the live graph →" goes to `/explore/`, which is its own existing surface.

## Frontend additions

### Hugo content & layout

- **Content stub:** `hugo/content/explore/about/_index.md`. Frontmatter only:

  ```yaml
  ---
  title: The SAP Developer Knowledge Graph
  description: A live graph of the tutorials, missions, and concepts that power developers.sap.com — built by AI, queried by SPARQL, and ready to explore.
  type: explore
  layout: about
  slug: about
  ---
  ```

- **Layout:** `hugo/layouts/explore/about.html` — bespoke single-page template extending `baseof.html`. Six sections per §Page sections above. Hand-authored HTML (no shortcodes); architecture SVG inlined.
- **CSS:** new partial `hugo/assets/css/pages/_kg-overview.postcss`, `@import`-ed by `hugo/assets/css/main.postcss`. All page styles scoped under a `.kg-overview` class on `<main>` to prevent leakage. Reuses existing `--sap*` design tokens / Fundamental Styles where possible; falls back to bespoke CSS only for the hero gradient and the badge-grid layout.
- **Architecture SVG:** committed at `hugo/static/img/knowledge-graph/architecture.svg`; inlined into the layout via Hugo's `readFile` so CSS variables apply.
- **Surface screenshots:** `hugo/static/img/knowledge-graph/surfaces/{sidebar,explore,concepts,joule}.png` (or `.webp`). Captured manually from the deployed app, dimensions normalized.

### Vue 3 island for the live counter

- New island at `hugo-apps/src/kg-stats-counter/` — `App.vue` + `main.ts`. One island, one entry, one bundle.
- Registered as a new Vite entry in `hugo-apps/vite.config.ts`; the post-build collision check ([scripts/check-build-collisions.ts](../../../scripts/check-build-collisions.ts)) will catch any name clash with a Hugo `js.Build` output.
- Mounts onto `<div id="kg-stats-counter">` rendered by the Hugo template; loaded via `<script type="module" src="/js/kg-stats-counter.js" defer>`.
- Fetches `/build/kg-stats`, renders three counters with a brief count-up animation on mount (0 → final, ~600 ms, suppressed when `prefers-reduced-motion: reduce`).
- Mobile (<480 px): stacks counters vertically.
- Reads `document.documentElement.dataset.theme` and listens for the existing `theme-changed` custom event for theme awareness — same pattern as other islands in `hugo-apps/src/`.

### Cross-linking

- **`/explore/` page** gets a small **"About this graph →"** link added to its top-right chrome, pointing to `/explore/about/`. **This is the single change required outside the new files.**
- **`/explore/about/`'s primary CTA** points back to `/explore/`. Bidirectional discoverability.
- **No nav additions in the global header.** Page is reached via `/explore/`'s chrome link, slide URLs, README links, tweets, and Google.

## Testing strategy

### Unit (`npm test`, in-memory SQLite)

- **`test/srv/kg-stats.test.js`:**
  1. Endpoint returns the expected JSON shape (six fields, correct types).
  2. Counts match in-memory DB after fixture seeding.
  3. Caching: second call within 60 s does not hit the DB (assert via spy).
  4. Cache invalidates after 60 s (Vitest fake timers).
  5. Defensive fallback: per the matrix in §Backend additions.
- **`hugo-apps/src/kg-stats-counter/__tests__/`:**
  1. Renders skeleton on mount before fetch resolves.
  2. Renders final counts after fetch resolves.
  3. Renders static fallback on 5xx / network error.
  4. Suppresses count-up animation when `prefers-reduced-motion: reduce`.

### Hybrid (`npm run test:hybrid`, real HANA via `cds bind --exec`)

- **`test/hybrid/kg-stats-endpoint.test.js`** — one test. Calls `/build/kg-stats` against real HANA; asserts the four counts are positive integers, `lastExtractedAt` is a valid ISO timestamp, response is under 200 ms. Catches CAP-vs-SQLite divergence (boolean encoding, NULL semantics in COUNT, type coercion) that unit tests cannot.

### Smoke (`npm run test:smoke`, HTTP against deployed)

- **`test/smoke/kg-stats-endpoint.test.js`:** `GET /build/kg-stats` returns 200, valid JSON, four counts are numbers ≥ 0.
- **`test/smoke/explore-about.test.js`:**
  1. `GET /explore/about/` returns 200 and HTML content-type. (Confirms Hugo built the page and AppRouter serves it.)
  2. HTML body contains the expected hero title text.

### Manual one-time pass at merge

- **Lighthouse a11y audit** locally; target ≥95.
- **Manual dark-mode pass:** toggle via the shellbar, walk every section. The architecture SVG is the highest-risk piece (CSS-variable wiring is new); the surfaces grid is second (light screenshots inside dark frames).
- **Manual mobile pass:** Chrome DevTools at 375 px width.
- **Cross-browser sanity:** Safari + Firefox + Chrome.

**No visual-regression / screenshot-diff tests.** See Non-Goals.

## Build sequence

Two PRs, sequenced.

### PR 1 — `feat(#751): /build/kg-stats endpoint + live counter island`

Ships the live counter independently of the page design so backend changes don't gate design iteration.

- **New files:**
  - `srv/routes/kg-stats.js`
  - `test/srv/kg-stats.test.js`
  - `test/hybrid/kg-stats-endpoint.test.js`
  - `test/smoke/kg-stats-endpoint.test.js`
  - `hugo-apps/src/kg-stats-counter/{App.vue,main.ts}` + `__tests__/`
- **Modified files:**
  - `srv/server.js` — one-line registration of the new route.
  - `hugo-apps/vite.config.ts` — add the `kg-stats-counter` entry.
- **User-visible change:** none. The endpoint is live, the island bundle ships, but nothing references it from any page yet.

### PR 2 — `feat(#751): /explore/about/ knowledge-graph overview page`

Ships the page assembly.

- **New files:**
  - `hugo/content/explore/about/_index.md`
  - `hugo/layouts/explore/about.html`
  - `hugo/assets/css/pages/_kg-overview.postcss`
  - `hugo/static/img/knowledge-graph/architecture.svg`
  - `hugo/static/img/knowledge-graph/surfaces/{sidebar,explore,concepts,joule}.png`
  - `test/smoke/explore-about.test.js`
- **Modified files:**
  - The `/explore/` layout (template containing its top-right chrome) — add "About this graph →" link.
  - `hugo/assets/css/main.postcss` — `@import` the new partial.
- **Verification before merge** per §Testing strategy → "Manual one-time pass at merge".

### Effort estimate

- **PR 1:** ~1 day. Endpoint is mechanical; island is small.
- **PR 2:** ~2-3 days. Page assembly is a few hours; most of the time is **the architecture SVG and the four real product screenshots**.

## Out of scope (deferred or explicit non-goals)

- **Phase 4 corpus types** (learning journeys, blog posts, videos, API docs, code samples) — once Phase 4.x sub-phases ship and the corresponding content types are in the graph, the corpus section grows by one tile per sub-phase. Each is a 1-bullet content-only follow-up PR.
- **Top-level nav entry / new global IA.** Discussed above.
- **Mini-viz teaser inside the page** (a degraded Sigma.js render). Discussed above.
- **Dark-mode-specific surface screenshots.** Discussed above.
- **Visual-regression infrastructure.** Discussed above.
- **Localization.** Site is English-only.
- **The RAG-backed `getRelevantSteps` Joule tool** as a fifth surface card. Invisible to the user, nothing screenshot-worthy. Revisit if the page feels missing-a-piece in practice.

## Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Architecture SVG looks amateur in dark mode | Med | High | CSS-variable approach is well-trodden in the codebase (joule-shellbar uses it). Manual dark-mode pass before merge is the catch. |
| Live counter shows zeros after a fresh `db deploy --with-mock-data=0` | Low | Low | Static fallback already covers the 5xx case; for a "zeros, but valid" response the page degrades gracefully (just shows zeros, no broken UI). Acceptable. |
| 60-second cache feels stale during a freshly-completed extraction run | Low | Low | Documented in the Cache-Control header (`stale-while-revalidate=300`); the visitor sees fresh data within ~60 s of the next page load. Acceptable for a marketing page. |
| Joule pre-fill query parameter doesn't exist in `joule.js` today | None | None | Confirmed during spec review: `joule.js` already wires `?joule=open` via `URLSearchParams` ([hugo/static/js/joule.js:742](../../../hugo/static/js/joule.js#L742)). The pre-fill is a small extension next to that block (~5–10 lines). Risk closed at spec time. |
| Screenshot drift: surface UI changes after the page is built; screenshots get stale | Med | Low | Manual re-capture in a 1-PR follow-up when caught. Surfaces grid is the most-likely section to need maintenance updates over time. |
| Phase 4 sub-phase ships before this page does, adding a content type whose tile isn't on the corpus grid | Low | Low | One-bullet follow-up PR per sub-phase, per §Out of scope. The layout accommodates it. |

## Open questions

None — all conceptual and visual decisions were resolved during the brainstorming session. The implementation plan will surface tactical questions (exact CSS variable names, exact SVG geometry, exact prose copy) but no design-level open questions remain.

## Decisions made during brainstorming

For future reference, the six conceptual + two visual decisions locked during brainstorming:

1. **Audience layering:** developers-primary, showcase visible below the fold (option C from the audience question).
2. **URL:** `/explore/about/` (subroute under the existing `/explore/`).
3. **Content scope:** magazine feature (option B) plus the live stats counter (one C-flavored recursive-demo element).
4. **Tech presentation:** annotated architecture diagram + badge grid below, all six SAP technologies named (option C; "all distinct").
5. **"Where you see it" composition:** 2×2 surfaces grid with `/explore/` elevated; RAG omitted (option B).
6. **CTA pattern:** single primary CTA + two small text links (option C).
7. **Layout ordering:** Hero → Diagram → Corpus → Tech → Surfaces → CTA (option C from the layout mockups).
8. **Diagram style:** SAP product-marketing horizontal flow (option A from the diagram mockups).
