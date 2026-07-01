# KG Widget Redesign — fullscreen expand + resource-first sidebar

**Date:** 2026-07-01
**Issue:** [#850](https://github.com/sap-tutorials/tutorials-ims/issues/850) (expanded scope)
**Author:** Thomas Jung + Claude
**Status:** Design

---

## Problem

The Knowledge-Graph "Related learning" widget on tutorial Object Pages
([hugo-apps/src/related-graph/RelatedGraph.vue](../../../hugo-apps/src/related-graph/RelatedGraph.vue))
is compressed into a sidebar aside. Two shortcomings:

1. **Reading order is wrong.** The first section is "This tutorial teaches" —
   a list of concepts the reader is already looking at. Prerequisites (arguably
   the highest-value item for a struggling reader) sit below the fold.
2. **Other resources is severely capped.** Six external corpora
   (learning-journey, blog-post, discovery-mission, video, api-doc, sample —
   with more coming) merge into a single top-5 list via
   [srv/lib/kg-neighborhood-merge.js:22](../../../srv/lib/kg-neighborhood-merge.js#L22).
   A tutorial with 20+ overlapping resources still surfaces only 5, and a whole
   type (e.g. videos) can be silently squeezed out if journeys and blogs
   dominate the ranking. Nothing signals to the reader that more exists.

Issue #850 identifies the cap; the redesign widens the scope to reorder the
widget, give readers a way to focus on the recommendations, and make future
external corpora cheap to add.

## Goals

- **Prerequisites first.** Highest-value section anchors the widget.
- **Focus mode.** A Joule-style expand-in-place opens a right-side dialog with
  more breathing room, per-type sections, and a much larger set of external
  resources.
- **Every populated external type surfaces.** No type is silently zero-slotted
  when others dominate.
- **Type identity is server-defined.** Adding a 7th external corpus in the
  future requires only server changes — no hugo-apps redeploy.
- **Kill-switch preserved.** `KNOWLEDGE_GRAPH_ENABLED=false` still hides the
  entire surface silently.

## Non-goals

- Redesigning the concept-page rail (out of scope; different surface).
- Changing the ranking algorithm inside a corpus (`overlapCount` desc is
  unchanged).
- Filtering, sorting UI in the expanded view (users get the server's ranked set).
- Persisting expanded-view state across sessions (each open re-fetches once
  per page load; refetch on next page load is expected).

---

## User-visible changes

### Sidebar (default view on every tutorial page)

- **Section order:** Prerequisites, Other resources (top-5 flat, with type
  icons), Shared concepts, What to learn next.
- **Removed:** "This tutorial teaches" — redundant with the tutorial itself.
- **Icon per row in Other resources:** each row shows an inline icon
  identifying its type (🎓 journey, 📝 blog, 🔍 discovery, ▶️ video, 📖 api-doc,
  🧪 sample). The icon+label combo is the reader's first hint that Other
  resources contains heterogeneous content.
- **New "Explore all connections" affordance in the panel header:** the ⤢
  icon opens the expanded panel. Placed in the widget header next to the
  existing intro text.

### Expanded panel (opens on ⤢ click)

- **Container:** Joule-style right-side dialog. Reuses Joule's `.joule-panel`
  chrome (aurora header, close button, expand-wider button). Teleported to
  `document.body` so it overlays the whole viewport. `role="dialog"` +
  focus-trap; ESC closes.
- **Header:** "Related learning — deep dive" with a subtitle naming the source
  tutorial. Same ⤢ (widen further) and ✕ (close) buttons as Joule.
- **Layout (option B from brainstorming):** two-column grid inside the dialog.
  - **Top strip, full-width:** Prerequisites section.
  - **Grid, 2 columns at ≥720px dialog width; 1 column below that:** per-type
    sections for every external type with ≥1 result, in the server-declared
    priority order.
  - **Bottom:** Shared concepts (full-width), What to learn next (full-width).
- **Item counts per section:** each type gets up to 15 items (server cap;
  configurable via `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT` env var, default 15).
  Sections shorter than that render fewer rows without empty placeholders.
- **Per-type section header:** icon + plural label + count badge
  (e.g. "🎓 Learning journeys · 6"). Section collapses/expands independently
  (`<details>` + `<summary>`). All open by default.
- **Empty types:** hidden entirely — no "0 videos" placeholders.

### Off-scope kill paths (already working, preserved)

- QA channel (`site.Params.qa`) and preview mode
  (`site.Params.previewMode`) still strip the entire island via the existing
  gates in [hugo/layouts/tutorials/u1-object-page.html:369](../../../hugo/layouts/tutorials/u1-object-page.html#L369).
- Feature flag `KNOWLEDGE_GRAPH_ENABLED=false` still returns 503 from
  `/graph/*` and the client renders no chrome.

---

## Data flow

Two endpoints, one shared type-config module.

### `GET /graph/neighborhood(slug='…')` (existing — unchanged wire shape)

- Same response as today (`NeighborhoodResult`), same top-5 flat
  `otherResources`, same `graphVersion` header for cache validation.
- **One additive change:** the response gains a `typeConfig` field (see
  below). Older cached client bundles that don't know about `typeConfig`
  simply ignore it — no breaking change.
- **Per-row change:** each `OtherResource` row still carries the six per-type
  metadata fields (`level`, `authorName`, `channelTitle`, …). New behavior:
  the server also stamps each row with the rendered `metaText` string that
  today's Vue template computes client-side (`" · by Alice · Jun 3, 2026"`).
  This lets the client render any row uniformly as `title` + `metaText`
  without a `v-if` chain on `r.type`. The per-field payload stays for
  backward compat + for tests that assert individual fields.

### `GET /graph/neighborhoodFull(slug='…')` (NEW)

- Same input shape (`slug`), same feature-flag gating (503 when
  `KNOWLEDGE_GRAPH_ENABLED=false`), same feature-level auth (public via
  `@requires: 'any'` on the service after PR #857).
- **Response type `NeighborhoodFullResult`:**
  - `tutorial: TutorialInfo` (as today)
  - `graphVersion: String` (as today)
  - `prerequisitesOf: array of TutorialRef` (up to 30 — was capped at 10 in
    sidebar path via the ranker's `maxResults`; expanded path uses a raised
    per-section limit)
  - `sharedConcepts: array of TutorialRef` (up to 30)
  - `whatToLearnNext: array of TutorialRef` (up to 30)
  - `otherResourcesByType: array of { type: String, config: TypeConfigEntry,
    items: array of OtherResource }` — one entry per external type with ≥1
    result, ordered by `config.priority` ascending. Each `items` list carries
    up to `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT` rows (default 15), ranked by
    `overlapCount` desc.
  - `typeConfig: array of TypeConfigEntry` (same as the additive field on
    `neighborhood`)
- No `teaches` (we removed that section entirely).
- **Caching:** same LRU cache module as `neighborhood`
  ([srv/lib/kg-neighborhood-cache.js](../../../srv/lib/kg-neighborhood-cache.js)) — but the
  module today has a fixed two-arg signature:
  `getCachedNeighborhood(slug, graphVersion)` /
  `setCachedNeighborhood(slug, graphVersion, value)` with `makeKey(slug,
  graphVersion)` at line 26. **Required change:** extend to three-arg
  `getCachedNeighborhood(slug, graphVersion, bucket = 'default')` /
  `setCachedNeighborhood(slug, graphVersion, value, bucket = 'default')` so
  the existing sidebar path is untouched (default bucket) and
  `neighborhoodFull` uses `bucket = 'full'`. `makeKey` becomes
  `` `${bucket}:${slug}:${graphVersion}` ``. `bustNeighborhoodCache()` stays
  a global wipe (correct for graph rebuild — both buckets are invalidated
  together). Add a unit test asserting bucket isolation: writing under
  `'full'` must not be readable under `'default'`. Extension is trivial
  (~10 LoC change).

### `TypeConfigEntry` (new CDS type, shared by both responses)

```cds
type TypeConfigEntry {
  type          : String(30);   // 'learning-journey', 'blog-post', …
  icon          : String(8);    // '🎓', '📝', … (emoji; single logical char)
  singular      : String(40);   // 'Learning journey'
  plural        : String(40);   // 'Learning journeys'
  priority      : Integer;      // 1-based ordering; lower = higher up
  metaTemplate  : String(120);  // human-readable template describing meta
                                //   shape ("Level · Duration"); for docs +
                                //   OpenAPI; not rendered by the client
}
```

### `srv/lib/kg-resource-type-config.js` (new module)

Single source of truth. Exports:

```js
export const RESOURCE_TYPE_CONFIG = [
  { type: 'learning-journey', icon: '🎓', singular: 'Learning journey',
    plural: 'Learning journeys', priority: 10,
    renderMeta(r) { /* '· Advanced · 12h' */ } },
  { type: 'blog-post', icon: '📝', singular: 'Blog post',
    plural: 'Blog posts', priority: 20,
    renderMeta(r) { /* '· by Alice · Jun 3, 2026' */ } },
  { type: 'discovery-mission', icon: '🔍', singular: 'Discovery mission',
    plural: 'Discovery missions', priority: 30,
    renderMeta(r) { /* '· effort 3 · Integration' */ } },
  { type: 'video', icon: '▶️', singular: 'Video',
    plural: 'Videos', priority: 40,
    renderMeta(r) { /* '· by SAP Tech Bytes · Jun 3, 2026' */ } },
  { type: 'api-doc', icon: '📖', singular: 'API reference',
    plural: 'API references', priority: 50,
    renderMeta(r) { /* '· Official reference · Business Objects' */ } },
  { type: 'sample', icon: '🧪', singular: 'Sample',
    plural: 'Samples', priority: 60,
    renderMeta(r) { /* '· TypeScript · 84 stars · Updated Jun 2026' */ } },
];
```

- Priority values are **sparse** (10, 20, 30, …) so a future type can slot in
  between without a mass renumber.
- `renderMeta(r)` centralizes what today lives in RelatedGraph.vue's
  `v-else-if` chain. Both handlers call it once per row before shipping.
- Icons are emoji, not @sap-icons — matches the tutorial-facing surface's
  content voice and avoids adding icon-font dependencies to the sidebar.
  Icon strings are wire-transported, so a future switch to SVG or icon-font
  is a server-side edit (no client change).

### Adding a 7th type (worked example — "podcast")

1. Add `Podcasts` + `PodcastConceptLinks` entities to `db/external-content.cds`
   (out of scope for THIS design, but shape is set).
2. Add `Podcasts` corpus loader alongside the six existing ones in the
   `neighborhood` / `neighborhoodFull` handlers.
3. Add one entry to `RESOURCE_TYPE_CONFIG` with `priority: 70`.
4. Done. Sidebar + expanded panel render the new type automatically.

**No hugo-apps changes.** No Vue component edits. No CSS edits.

---

## Component structure (client)

Current: [hugo-apps/src/related-graph/RelatedGraph.vue](../../../hugo-apps/src/related-graph/RelatedGraph.vue)
is one 800-line file doing state, fetching, sidebar rendering, and all
per-type meta formatting via the `v-else-if` chain at lines 145–197.

New (breaking the file up along the boundaries the redesign creates):

```
hugo-apps/src/related-graph/
├─ main.ts                        (unchanged — mount point)
├─ RelatedGraph.vue               (orchestrator — state, IntersectionObserver,
│                                  fetch, expand-toggle; renders <SidebarPanel>
│                                  and optionally <ExpandedPanel>)
├─ SidebarPanel.vue               (compact sidebar; four sections; renders
│                                  <ResourceRow> for each Other-resources row)
├─ ExpandedPanel.vue               (Vue teleport to body; the dialog chrome;
│                                  lazy fetches /graph/neighborhoodFull once
│                                  per page load; renders per-type sections)
├─ ResourceRow.vue                 (presentational — receives typeConfigEntry
│                                  + row data; renders icon + link + metaText.
│                                  Zero v-if on r.type.)
├─ KgReasonPopover.vue             (unchanged)
├─ types.ts                        (extended with NeighborhoodFullResult +
│                                  TypeConfigEntry)
├─ related-graph-helpers.ts        (unchanged; formatRelativeMonth etc. still
│                                  used by server-side renderMeta indirectly
│                                  via a shared helper — see below)
```

**Shared date/format helpers.** `formatRelativeMonth`, `formatDate`, and
`formatLevel` from `related-graph-helpers.ts` move to a shared module
`srv/lib/kg-meta-formatters.js` (server) with a corresponding client re-export
in `related-graph-helpers.ts`. Server's `renderMeta` uses the shared module
so client-computed and server-computed meta strings match byte-for-byte.
This is the one server ↔ hugo-apps coupling the design introduces; it's
deliberate — otherwise the "server ships pre-rendered metaText" idea can't
survive a client-side date-format tweak. Tests pin the exact string shapes.

**Timezone discipline for the shared formatters.** `related-graph-helpers.ts`
today uses `Intl.DateTimeFormat` and `Date` methods that respect the browser's
local timezone. On the server, Node's timezone is whatever
`process.env.TZ` says (in Cloud Foundry: UTC). So a reader in
Australia/Sydney could see a `"Jun 3"` on the client where the server
already stamped `"Jun 4"` for the same ISO timestamp — the "byte-for-byte
match" promise breaks silently at day boundaries. The shared module
**pins itself to UTC** on both surfaces:

```js
// srv/lib/kg-meta-formatters.js
export function formatDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
```

Client re-exports the same function verbatim so it sees the same UTC-anchored
result regardless of the reader's timezone. Vitest snapshot pins fixture
timestamps (e.g. `2026-06-03T00:00:00Z`) so the day-boundary case is a
regression test, not a hope.

**Why teleport for the expanded panel.** The tutorial page uses a right-column
aside inside a stacking context with the sticky step-TOC + `z-index` on
various sub-elements. If the expanded panel mounts inside that aside, it
inherits the stacking context and can't overlay the whole viewport. Vue 3's
`<Teleport to="body">` moves the DOM to a top-level position at render time
without changing component ownership. This is the **first** Vue 3
`<Teleport>` in `hugo-apps/` (verified: `grep -r "<Teleport"
hugo-apps/src/` returns zero hits at spec time — earlier drafts of this
design claimed CodeCheck.vue used the pattern; that was wrong). SSR-safety:
`data-vue-island="related-graph"` hydrates client-only via the island
runtime, so Teleport has no SSR concerns here. The dialog root that
Teleport targets (`<div id="kg-expanded-root">`) is added to
[hugo/layouts/_default/baseof.html](../../../hugo/layouts/_default/baseof.html) as an empty
mount point below `<body>`.

---

## Interaction & motion

- **Sidebar → expanded transition:** no fancy animation. Fade the sidebar to
  40% opacity + open the dialog with a 200ms slide-in-from-right (Joule's
  existing motion; reuse the `@keyframes joule-panel-in` if it exists,
  otherwise a plain `transform: translateX(100%) → translateX(0)`). No
  page-content shift.
- **ESC closes the dialog.** Sidebar returns to full opacity.
- **Click outside dialog does NOT close** (matches Joule's semi-modal
  posture; readers may be selecting text in the sidebar).
- **Focus trap** while dialog is open (standard `role="dialog"` +
  `aria-modal="false"` since we're not a hard modal — matches Joule's
  `aria-modal="false"` at [hugo/layouts/partials/joule-panel.html:2](../../../hugo/layouts/partials/joule-panel.html#L2)).
- **Widen-further ⤢ button in dialog header** (Joule already has one at
  [hugo/layouts/partials/joule-panel.html:12](../../../hugo/layouts/partials/joule-panel.html#L12)): first
  click expands the dialog from the default ~480px width to ~800px; second
  click restores. Not full-viewport-width — the reader still sees the
  tutorial content on the left, which is the point of "focus without leaving
  the page."
- **`prefers-reduced-motion`:** motion honored — slide-in becomes instant,
  cross-fade only.

---

## Telemetry (extends the existing event bridge)

New events (fired via `window.dispatchEvent(new CustomEvent(…))`):

- `kg.expanded.opened` — `{ slug }` on click of the ⤢ icon.
- `kg.expanded.closed` — `{ slug, dwellMs }` on ESC or ✕.
- `kg.expanded.widened` — `{ slug, wider: true|false }` on second ⤢ click.
- `kg.expanded.click` — `{ slug, resourceType, targetSlug, source: 'expanded' }`
  on any row click. Distinguished from the existing `kg.sidebar.click` (which
  is tutorial→tutorial only) so dashboards can measure fullscreen dwell +
  CTR separately.
- `kg.expanded.section_toggled` — `{ slug, resourceType, open }` on
  `<details>` toggle.

Existing sidebar events (`kg.sidebar.shown`, `kg.sidebar.click`, etc.) fire
unchanged. Nothing that watches those today breaks.

---

## Error handling & edge cases

| Case | Behavior |
|------|----------|
| `/graph/neighborhood` returns 503 (feature flag off) | Nothing renders. Same as today. |
| `/graph/neighborhood` returns 200 with empty `prerequisitesOf` AND empty `otherResources` AND empty `sharedConcepts` AND empty `whatToLearnNext` | Nothing renders. Same as today (hide-on-empty). |
| Sidebar renders but `/graph/neighborhoodFull` fails when user clicks ⤢ | Dialog opens showing a compact error state: "Couldn't load the deep dive — try again?" with a retry button. Sidebar stays intact. |
| User rapidly toggles the ⤢ button (double-click) | State machine: `sidebar → opening → open → closing → sidebar`. Extra clicks during transitions are ignored. Debounced by a 250 ms lock. |
| `neighborhoodFull` returns `otherResourcesByType: []` (no external content at all) | Dialog renders only Prerequisites + Shared concepts + What to learn next. The two-column grid area shows a subdued "No external resources are linked to this tutorial's concepts yet" line — the ONE placeholder we ship (readers who opened the dialog specifically to see resources deserve an explanation of the empty state). |
| Focus is on a sidebar link when user hits ⤢ via keyboard | Focus moves to the dialog's close button. On close, focus returns to the ⤢ trigger. |
| Screen reader on the sidebar row's icon | `aria-hidden="true"` on the icon; the visible label + link text carries the semantics. |
| QA channel | Existing gates in Hugo strip the whole island; expanded view never renders. Same as today. |
| CAP 10 auth flip | Service already `@requires: 'any'` (post-PR #857); no CAP 10 protocol change affects this design. |
| First-time render before typeConfig lands (old cached bundle + new server) | Client falls back to the current per-type `v-else-if` chain wrapped in a legacy adapter for one release cycle. Deleted after one deploy cycle when we're confident all CDN-cached bundles are refreshed. |

---

## Testing

### Unit tests (Vitest, `test/unit/`)

- `related-graph-neighborhood-full.test.ts` — server-side handler shape test:
  given fixture links, assert `otherResourcesByType` groups by type, orders
  by `config.priority`, caps at `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT`, and
  ranks within each group by `overlapCount` desc.
- `related-graph-type-config.test.ts` — every entry in `RESOURCE_TYPE_CONFIG`
  has all required fields; priorities are unique; no duplicate `type` keys.
- `related-graph-resource-row.test.ts` — component: given a typeConfigEntry
  + row data, renders icon + link + metaText. No `v-if` on `r.type` in the
  compiled template — CI grep guard `!/r\.type\s*===/` on `ResourceRow.vue`.
- `related-graph-expanded-panel.test.ts` — component: given a mocked
  `NeighborhoodFullResult`, mounts a `<div>` with `teleportTo`, asserts:
  Prerequisites at top, per-type sections in priority order, empty types
  hidden, section counts render, `<details>` toggles emit the telemetry
  event.
- `related-graph-sidebar-order.test.ts` — new component: given fixture,
  asserts section order is Prereq → Other → Shared → Next; no "teaches"
  section renders even if the wire still carries `teaches: [...]`.
- Extends existing `test/unit/hugo-apps/related-graph-*.test.ts` suite.

### Hybrid tests (`test/hybrid/`, real HANA via `cds bind --exec`)

- `test/hybrid/kg-neighborhood-full.test.js` — end-to-end against a seeded
  fixture tutorial with known overlap counts across all six external types.
  Asserts:
  - Each external type appears exactly once in `otherResourcesByType`
    when it has ≥1 overlap.
  - Per-type limit is honored (seed >15 rows in one type; assert length=15).
  - Empty types absent from the array (not present with `items: []`).
  - `typeConfig` matches `RESOURCE_TYPE_CONFIG` byte-for-byte.
- Extends the existing `test/hybrid/kg-named-queries.test.js`.

### Smoke tests (`test/smoke/`, HTTP against deployed URL)

- Extend `test/smoke/kg-endpoints.test.js` (already checks anonymous
  `/graph/neighborhood`) with an anonymous GET for
  `/graph/neighborhoodFull(slug='<known-published>')`. Asserts 200 + shape.
- Extend the `it.each` block from PR #857 with `PublishedConcepts`,
  `Concepts`, `ConceptEdges`, `TutorialConceptLinks` — already covered.

### Manual QA

- Playwright walk-through: land on `/tutorials/<known-good-slug>/`, wait
  for sidebar, verify section order, click ⤢, verify dialog opens, verify
  per-type sections in priority order, ESC closes.
- Reduced-motion: OS setting → verify no slide-in animation on open.
- Keyboard: Tab to ⤢ button, Enter, verify focus lands in dialog, Shift+Tab
  cycles inside dialog only, ESC closes and focus returns.

---

## Migration & rollout

- **No DB schema change.** The design is entirely on top of the existing
  `db/external-content.cds` entities.
- **No new build step.** `RESOURCE_TYPE_CONFIG` is a plain JS module bundled
  by esbuild/vite as usual.
- **Feature flag:** none needed. The redesigned sidebar and the expanded
  panel ship together. The `KNOWLEDGE_GRAPH_ENABLED` env var kill still hides
  both.
- **Content rebuild:** none needed. Wire-shape additions are additive; a
  slug's HTML in HANA doesn't change.
- **Approuter routes:** `/graph/neighborhoodFull(…)` does **not** match the
  existing allowlist regex at [approuter/xs-app.json:146](../../../approuter/xs-app.json#L146)
  (verified: `/graph/neighborhoodFull(slug='x')` returns `false` against
  `^/graph/(neighborhood|Concepts|…)…`). Without a regex update it falls
  through to the next `/graph/` route (line 153), which is xsuaa-protected —
  anonymous callers would 401. **Required change:** update the allowlist to
  `neighborhood(Full)?|Concepts|ConceptEdges|TutorialConceptLinks|pathBetween|conceptsForUser|explore-data|path`.
  Smoke test in `test/smoke/kg-endpoints.test.js` gets a new case asserting
  anonymous 200 on `/graph/neighborhoodFull(...)`.
- **Deployment sequence:** srv change deploys first (adds
  `/graph/neighborhoodFull`; sidebar unchanged wire-side except for additive
  `typeConfig`); approuter change deploys with the same MTA; hugo-apps
  bundle change ships with the same deploy. Because the sidebar wire shape
  is a strict superset, an old client hitting a new server is fine (unknown
  fields ignored). A new client hitting an old server is what to guard: the
  client feature-detects `typeConfig` presence in the response and falls
  back to the legacy `v-else-if` renderer if missing. Fallback removed in a
  follow-up deploy cycle. The fallback is genuinely needed here because
  vite entry filenames are unhashed (`entryFileNames: '[name].js'` at
  [hugo-apps/vite.config.ts:233](../../../hugo-apps/vite.config.ts#L233)), so
  the CDN + browser cache can serve stale `related-graph.js` for up to the
  approuter's max-age window after a deploy. Removal criterion: 24 h after
  deploy, or when Cache-Control inspection shows the new bundle is being
  served ≥99% of the time.

- **`srv-qa` cp list.** The `tutorials-srv-qa` module in
  [.deploy/mta.yaml:107](../../../.deploy/mta.yaml#L107) hand-curates every
  `srv/lib/` file it needs (the whole `bash -c "…cp…"` block). Today's list
  is **missing** `kg-neighborhood-cache.js` and `kg-neighborhood-merge.js`
  even though `knowledge-graph-service.js` imports them — meaning the QA
  channel already can't serve `/graph/neighborhood`. This is a pre-existing
  bug, tracked under [[feedback_srv_qa_cp_list]] in Tom's memory. This
  design closes that gap **at the same time it lands** so we don't inherit
  the bug: append to the srv-qa cp list —
    * `kg-neighborhood-cache.js` (pre-existing dep)
    * `kg-neighborhood-merge.js` (pre-existing dep)
    * `kg-resource-type-config.js` (new)
    * `kg-meta-formatters.js` (new)
  Verify after implementation by re-walking transitive `./` imports from
  `srv/knowledge-graph-service.js` and confirming every hop is in the
  cp list. Do this **before** the QA deploy step of the same MTA, otherwise
  QA boot crashes on first `/graph/*` hit ([[feedback_srv_qa_cp_list]] and
  [[feedback_srv_qa_route_drift_not_caught_by_lint]] both describe this
  failure mode).

---

## Open questions

- **Do we cache the `neighborhoodFull` response in HTTP layers?** The
  existing `neighborhood` sets `ETag: "<slug>:<graphVersion>"` at
  [srv/knowledge-graph-service.js:492](../../../srv/knowledge-graph-service.js#L492).
  The design plans to do the same for `neighborhoodFull` (different bucket,
  same key format). Recommend keep it — clients that revisit the dialog on
  reload get a 304.
- **Priority values in `RESOURCE_TYPE_CONFIG`.** The design proposes
  10/20/30/40/50/60. Tom's discretion on final ordering — the concrete
  values in the spec are placeholders that reflect a plausible "most-useful-
  first" ranking (journeys before blogs before missions before videos before
  api-docs before samples). Ordering can be adjusted without any test churn.
- **Emoji vs SVG icons.** The design picks emoji. If SAP visual identity
  requires @sap-icons, the swap is server-side only (`icon` becomes
  `"course-book"` etc. and `ResourceRow.vue` reads them via `data-icon`
  matching the existing pattern in [hugo/static/js/cmd-palette.js](../../../hugo/static/js/cmd-palette.js)).

---

## Risks

- **Second fetch cost.** Every dialog open costs one `neighborhoodFull` call.
  Mitigated by the LRU cache on the server (same TTL as `neighborhood`) and
  by not fetching until the ⤢ click. Expected wall-clock: sub-500ms on warm
  cache, comparable to `neighborhood` on cold.
- **Bundle size.** Splitting into 4 components adds ~2KB gzipped. The dialog
  and expanded-panel code path is unused until the user clicks — vite-code-
  split it lazily. If it doesn't split cleanly, accept the ~2KB one-time cost.
- **The `metaText` server/client format sync.** Because the server pre-renders
  the meta string, a hugo-apps date-format tweak in one place and a server
  tweak in another can drift silently until a user notices. Mitigated by the
  shared `srv/lib/kg-meta-formatters.js` module (server IS the canonical
  formatter; client imports the same source for any client-side computed
  strings) and by the UTC-pinning + snapshot fixture in the Data-flow
  section above.
- **DB query fanout at cold cache for `neighborhoodFull`.** The expanded
  path can materialise up to 6 × `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT`
  = 6 × 15 = 90 rows across 6 corpora, versus 5 in the sidebar. On cold
  cache the 12 parallel queries (6 link-tables + 6 metadata SELECTs) are
  the same order-of-magnitude wall-clock as `neighborhood` today (~500ms
  per the KG-widget-perf PR #854) but with a bigger metadata payload.
  Not a scaling concern at DEV load; may need a
  `KG_NEIGHBORHOOD_FULL_PER_TYPE_LIMIT` bump-down if PROD reveals a
  hot-tutorial bottleneck. The `mergeOtherResources` helper in
  [srv/lib/kg-neighborhood-merge.js](../../../srv/lib/kg-neighborhood-merge.js)
  is NOT reused by the expanded path — the expanded path returns per-type
  buckets un-merged. No signature change needed on the merge helper; the
  sidebar continues to call it with the same variadic shape.

---

## Concrete files touched

**New:**
- `srv/lib/kg-resource-type-config.js`
- `srv/lib/kg-meta-formatters.js`
- `hugo-apps/src/related-graph/SidebarPanel.vue`
- `hugo-apps/src/related-graph/ExpandedPanel.vue`
- `hugo-apps/src/related-graph/ResourceRow.vue`
- `hugo/assets/css/kg-expanded-panel.css` (or appended to existing kg-sidebar CSS)
- Tests listed above.

**Modified:**
- `srv/knowledge-graph-service.cds` — new `neighborhoodFull` function,
  new `NeighborhoodFullResult` + `TypeConfigEntry` types.
- `srv/knowledge-graph-service.js` — new handler for `neighborhoodFull`;
  existing `neighborhood` handler grows a `typeConfig` field on the response
  and stamps `metaText` on each Other-resources row.
- `srv/lib/kg-neighborhood-cache.js` — three-arg signature extension
  (`bucket = 'default'`) so `neighborhood` and `neighborhoodFull` cache
  independently. Details in the Data-flow section above.
- `hugo-apps/src/related-graph/RelatedGraph.vue` — becomes the thin
  orchestrator; most rendering moves to child components.
- `hugo-apps/src/related-graph/types.ts` — new types.
- `hugo-apps/src/related-graph/related-graph-helpers.ts` — re-exports the
  shared formatter module.
- `hugo/layouts/_default/baseof.html` — add empty
  `<div id="kg-expanded-root"></div>` below `<body>` as the Teleport target.
- `approuter/xs-app.json` — regex change from `neighborhood|Concepts|…`
  to `neighborhood(Full)?|Concepts|…` on line 146 so `neighborhoodFull`
  matches the anonymous allowlist branch.
- `.deploy/mta.yaml` — append `kg-neighborhood-cache.js`,
  `kg-neighborhood-merge.js`, `kg-resource-type-config.js`,
  `kg-meta-formatters.js` to the `tutorials-srv-qa` cp list (line 125).
  First two are pre-existing bugs fixed here; last two are new to this
  design.
- Extended existing tests as listed.

Nothing else.
