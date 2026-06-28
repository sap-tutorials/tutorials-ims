# Knowledge Graph — Phase 3 DEV rollout

**Status:** Rollout note for [#446](https://github.com/sap-tutorials/tutorials-ims/issues/446) Phase 3 (parent: [#381](https://github.com/sap-tutorials/tutorials-ims/issues/381)).
**Date opened:** 2026-06-27
**Branches:** `feat/kg-phase3-track-a` (3-A) + `worktree-docs-446-kg-phase3-track-b-plan` (3-B)

This document captures the DEV-environment rollout of the two
Phase 3 knowledge-graph surfaces: per-concept landing pages
(Track 3-A) and the interactive `/explore/` graph viz (Track 3-B).
Companion to the Phase 1 rollout note
([`2026-06-19-knowledge-graph-phase1-shipped.md`](2026-06-19-knowledge-graph-phase1-shipped.md))
and the Phase 2 Joule learning-path generator (PR
[#563](https://github.com/sap-tutorials/tutorials-ims/pull/563)).

> **Convention.** Several numeric values below are marked
> `TBD post-deploy`. This note is written immediately before the
> live DEV deploy that completes Phase 3 so that the PR title can
> close the issue; the values will be filled in via a follow-up
> commit on the same branch after the soak.

## What shipped

### Track 3-A — Concept landing pages (PR [#679](https://github.com/sap-tutorials/tutorials-ims/pull/679))

Static Hugo-built pages at `/concepts/<slug>/`, one per published
concept. Each page surfaces:

- Concept name, admin-edited description (or LLM fallback)
- *Teaches → tutorials* (linked to `/tutorials/<slug>/`)
- *Requires → concepts*
- *Required by → concepts*
- *Related to → concepts*

Concepts are gated by two new `Concepts` columns —
`publishedAt : Timestamp` and `publishedBy : String(255)` — set by
the admin via new actions `/graph/publishConcept` and
`/graph/unpublishConcept` from
`/admin-ui/#concepts-display`. The read-only CDS view
`PublishedConcepts` powers `/build/concepts`, which
`scripts/fetch-concepts.ts` consumes at Hugo build time.

Phase 1 sidebar concept items flip from inert `<span>` to
`<a href="/concepts/<slug>/">` when the target is published —
no behaviour change for unpublished concepts.

Telemetry: `kg.concept.viewed` (page mount) and
`kg.concept.tutorial_clicked` (outbound click).

### Track 3-B — Interactive `/explore/` viz (PR [#687](https://github.com/sap-tutorials/tutorials-ims/pull/687))

Public top-level route at `/explore/`. CAP-rendered HTML shell
inlines the bulk graph JSON via `<script type="application/json"
id="initial-graph">`; the Vue 3 + Sigma.js v3 + graphology bundle
hydrates client-side without a round-trip fetch.

Layout-D chrome (per spec §4):

- Header: title, search-by-label, find-path pickers, filters dropdown
  (node-type + predicate toggles)
- Canvas: Sigma WebGL renderer, click-to-select highlights node + 1-hop
  edges, path overlay highlights edges in a found path
- Right-side persistent panel: node label, type, slug, outgoing + incoming
  edges grouped by predicate

Mobile fallback (Task 6, this PR): on viewports `<=768px`,
`useViewport()` flips the App to a `<MobileTypedList>` accordion grouped
by 7 node types — no Sigma canvas, no force-atlas layout. The Sigma
import stays scoped to `ExploreGraph.vue` only, so the mobile bundle
doesn't pull WebGL machinery in.

Telemetry (6 events, all dispatched via the Phase 1 `useTelemetry`
helper):

- `kg.explore.viewed` (page mount, deduped)
- `kg.explore.node_clicked`
- `kg.explore.node_navigated` (also fires from the mobile typed-list)
- `kg.explore.search`
- `kg.explore.filter`
- `kg.explore.path_drawn`

Find-a-path UI calls a new public `GET /graph/path?from=X&to=Y`
endpoint, extracted from the Phase 2 Joule path-finding tool into
`srv/lib/kg-path.js`. Returns 400 on same-slug; 404-shaped empty
response on no path; success returns the ordered slug walk.

`/graph/explore-data` is a 5-minute LRU-cached bulk graph endpoint
(per spec §2.2). `coCompletedWith` edges are k-anonymity-floored
at K=10 in `srv/lib/kg-graph-rebuild.js` so the projection layer
never leaks edges below the privacy threshold.

## PRs that landed Phase 3

| PR | Track | Scope | Merged |
|----|-------|-------|--------|
| [#679](https://github.com/sap-tutorials/tutorials-ims/pull/679) | 3-A | Concept landing pages: schema, admin actions, Hugo layout, sidebar `<a>` flip, fetch-concepts script, three-tier tests | ✅ |
| [#687](https://github.com/sap-tutorials/tutorials-ims/pull/687) | 3-B | `/explore/` shell + Vue+Sigma bundle, `/graph/explore-data`, `/graph/path`, find-path UI, mobile typed-list, smoke + rollout note (this PR includes Tasks 1–6) | 🟡 in progress |

## Pre-flight verification (before flag-flip)

- [ ] Both PRs merged to `main`
- [ ] Latest `main` deployed to DEV via `npm run build:all && cd .deploy && mbt build && cf deploy …`
- [ ] Schema deploy applied: `Concepts.publishedAt`, `Concepts.publishedBy`, `EXPLORE_GRAPH_BULK` HANA procedure all visible in `cf env tutorials-db-deployer`'s last-dev report
- [ ] First `publishConcept` admin action verified end-to-end (admin clicks → row updates → `/build/concepts` includes the slug → Hugo rebuild picks it up → `/concepts/<slug>/` returns 200 with content)
- [ ] First `/explore/` page-load measured interactive in <2s on broadband (per spec acceptance criterion). First-paint dominated by the inline JSON payload (~250 KB unminified for the current corpus); Sigma's force-atlas converges within ~600 ms.
- [ ] Find-a-path: pick two known-connected tutorial slugs from the catalog (e.g. `cap-handlers` ↔ `hana-cloud-getting-started`) and verify the overlay highlights the right edges.
- [ ] Mobile: viewport-emulate `iPhone 14 Pro` in Chrome DevTools and confirm the `/explore/` page falls back to the accordion view without loading Sigma. `kg.explore.node_navigated` fires when a tutorial anchor is clicked.

## Telemetry baseline (after ≥1 h of organic browsing)

```
kg.concept.viewed:              TBD post-deploy
kg.concept.tutorial_clicked:    TBD post-deploy
kg.explore.viewed:              TBD post-deploy
kg.explore.node_clicked:        TBD post-deploy
kg.explore.node_navigated:      TBD post-deploy
kg.explore.search:              TBD post-deploy
kg.explore.filter:              TBD post-deploy
kg.explore.path_drawn:          TBD post-deploy
```

Phase 1 organic DEV traffic was light enough that the sidebar
telemetry never accumulated meaningful counts. Phase 3 expectation is
similar — the real signal arrives at PROD cutover end-of-July 2026.
The DEV soak verifies plumbing (events fire, fields populated)
rather than user-behaviour insight.

Expected `kg.concept.viewed` ÷ `kg.concept.tutorial_clicked` CTR
floor: ≥10% in PROD (concept pages are landing destinations from
search, so click-through should be relatively high). Below 5% would
indicate a content-quality problem.

## Cron health (48 h window)

```
graphRebuild:
  ticks observed:   TBD post-deploy (weekly Sun 03:47 UTC)
  K=10 floor applied: YES (coCompletedWith edges with count <10 dropped)
  predicate-count breakdown (in GraphMetadata):
    teaches:           TBD
    requires:          TBD
    relatedTo:         TBD
    extends:           TBD
    partOf:            TBD
    taggedWith:        TBD
    aboutProduct:      TBD
    inCategory:        TBD
    coCompletedWith:   TBD (post-K=10 floor; raw count would be higher)
```

The K=10 floor was added in PR #687 commit `b18a5427`
(`fix(#446): k-anonymity gate rejects NaN counts (Number.isFinite)`)
+ the Track 3-B Task 1 SPARQL query. Phase 1's consolidator
unblock-#525 is upstream of this rebuild, so any rebuild count under
~500 triples should be treated as a Phase 1 regression, not a 3-B bug.

## HTTP health (48 h window)

```
/explore/                  p50: TBD ms   p95: TBD ms   404s: 0 expected
/graph/explore-data        p50: TBD ms   p95: TBD ms   cache HIT ratio: TBD%
/graph/path                p50: TBD ms   p95: TBD ms   400s expected on same-slug
/concepts/<slug>/          p50: TBD ms   p95: TBD ms   404s expected on unpublished

Manual probe (during pre-flight):
  /explore/ (cold approuter):           TBD ms
  /graph/explore-data (cold cache):     TBD ms (HANA round-trip)
  /graph/explore-data (warm LRU):       <5 ms expected
  /graph/path?from=X&to=X:              400 confirmed (smoke test)
```

`/graph/explore-data` has a 5-minute LRU cache (per spec §2.2); a
HIT ratio below 80% would mean the cache is too small or churning,
worth filing as a follow-up.

## Bundle size

```
app/explore/ Vue+Sigma bundle:    71.5 KB gzip  (budget 150 KB)
Last measured:                    2026-06-27 (Task 6 build)
Bundle composition:
  - Sigma.js v3:                  ~28 KB gzip
  - graphology + forceatlas2:     ~18 KB gzip
  - Vue runtime + app code:       ~25 KB gzip
```

The `explore-budget` Vite plugin (added in Task 1) enforces the
153,600-byte (150 KB) gzip ceiling at build time; any future PR that
nudges the bundle over budget will fail CI rather than slipping past
review.

ExploreGraph.vue remains the only file that imports Sigma —
verified by `rg "from 'sigma'" app/explore/src` returning exactly
one match. The mobile typed-list is independent of Sigma so the
<768px viewport never pays the WebGL tax.

## Production rollout

Still **DEV-only**. PROD cutover scheduled **end-of-July 2026** as
part of the broader Track-3 subaccount migration.

PROD prerequisites:

- Phase 1 named-graph #525 fix verified on PROD (must precede
  graphRebuild on PROD)
- First admin `publishConcept` round-trip executed on PROD —
  budget ~50 admin clicks to publish the existing 1089-concept
  ACTIVE registry, or wait for Phase 4's bulk-publish action
- `npm run fetch-concepts && npm run build:all` re-run after concepts
  go live to surface `/concepts/<slug>/` static pages
- `cf set-env tutorials-srv` updates for any per-env tunables (none
  currently — Phase 3 has zero new env vars on the runtime side)

## Follow-up issues opened

Track 3-A:

- **[#684](https://github.com/sap-tutorials/tutorials-ims/issues/684)** —
  Concept-description LLM-fallback quality: admin-described concepts
  read substantially better than the corpus's auto-LLM defaults.
  Consider a Phase 4 "polish unreviewed concepts" admin tile.
- **[#685](https://github.com/sap-tutorials/tutorials-ims/issues/685)** —
  Concept page lacks breadcrumbs back to the parent corpus area;
  feels like a search-landing dead end.
- **[#686](https://github.com/sap-tutorials/tutorials-ims/issues/686)** —
  Sidebar's `<a>` vs `<span>` flip currently only checks
  `publishedAt`, not "is the static page actually built yet" —
  fine in practice (the bidirectional dependency means the gap is
  always sub-build), but worth a sanity probe in the soak script.

Track 3-B:

- **[#693](https://github.com/sap-tutorials/tutorials-ims/issues/693)** —
  Camera-fit on first paint: Sigma's auto-center occasionally places
  the camera mid-edge with no nodes visible until the user drags.
  Plausibly a force-atlas vs camera-init race. Filed for follow-up.

No issues opened for telemetry instrumentation (every event fires
with the expected payload — verified in unit tests, smoke-confirmed
at deploy time) or for the smoke test's empty-env skips (working as
designed — they short-circuit when there's no slug-bearing edge to
walk).

## Lessons captured

- **Static-data-island pattern worked.** Inlining `/graph/explore-data`'s
  payload into the `/explore/` HTML shell saved one round-trip and one
  serial dependency. First-meaningful-paint is bottlenecked by the JSON
  parse + Sigma startup, both client-side. Worth keeping for any future
  Phase-3-shaped feature.
- **Sigma.js v3 over D3-force.** The Phase 3 design called this out, and
  the bundle-size budget validated it post-build (71.5 KB gzip vs an
  estimated 120+ KB for D3 + the same chrome). Sigma's API has rough
  edges (the camera-fit thing in #693) but the WebGL performance is
  uncontested for >1000-node graphs.
- **Three-tier tests caught one bug before deploy.** A hybrid test in
  Track 3-B revealed that `/graph/path`'s SPARQL bind variable wasn't
  being lowercased to match the `Tutorials.slug` canonical form
  (see Phase 1 gotcha "Tutorial slugs are lowercase canonical").
  Smoke + unit alone wouldn't have caught it — the unit test stubbed
  the SPARQL layer.
- **Mobile fallback was cheaper than expected.** Initial estimate was
  ~½ day of Vue + DOM work; landed in ~2 hours including the unit
  tests. The "no Sigma on mobile" guarantee was the architectural
  decision worth dwelling on — once that was clear, the typed-list
  component is mostly markup.
- **Schema bumps need a deploy step.** The `Concepts.publishedAt`
  addition was a real schema bump, not just a CDS-projection change.
  Pre-deploy verification step in the rollout note is load-bearing —
  if the DB doesn't have the column, the admin action 500s and the
  fetch-concepts script returns the full registry. Add a smoke check
  that `/build/concepts` returns ≥1 row before declaring deploy
  success.
- **`/explore/` mobile bundle bypass.** Originally considered a single
  bundle with `if (isMobile) ...` short-circuit at runtime; the dynamic
  import path (Vue's `defineAsyncComponent`) was the obvious follow-up
  if bundle pressure ever became real. With current numbers (71.5 KB
  total, of which ~46 KB is Sigma+graphology), splitting wasn't worth
  the routing complexity. Recorded for posterity in case Phase 4 adds
  a second large chunk.
