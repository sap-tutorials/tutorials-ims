# Topics Discovery Front Door — Design

**Date:** 2026-08-09
**Status:** Approved (design), pending implementation plan
**Author:** Tom + Claude (brainstorming session)
**Related:** #1327 (concepts moved to CAP), #917/#1126 (Louvain communities + labels), #916 (PageRank), #918 (WCC isolation), #985 (community fingerprint), #1170 (homepage "Explore topic clusters" band), #1032 (featured-topics carousel), `/explore/` graph app

---

## Decisions locked after codebase recon (2026-08-09)

- **Route:** `/topics/` (front door) + `/topics/<cluster>/` (cluster detail). Confirmed free — no existing route, Hugo content dir, or CAP entity collides. Caveat: a legacy redirect `^/topics/([^/]+)\.html$` → `/tags/$1/` exists, so cluster slugs must not collide with a bare `<name>.html` shape (they won't — detail pages are `/topics/<slug>/`, not `.html`).
- **Rendering model = Hugo-bake (Model B), NOT CAP/HANA.** This *reverses* the original brainstorm assumption that `/topics/` would mirror `/concepts/`'s `ContentFiles` publish/serve model. Rationale: the data is ~18–60 clusters updated at most nightly (vs 5,946 per-request-fresh concepts), and the sibling #1170 band + `/explore/` already use the build-time-baked model. So: nightly job → `/build/*` JSON feed → `scripts/fetch-*.ts` → `hugo/data/*.json` → Hugo layouts bake the gallery + all cluster-detail pages statically; Vue islands (Sigma map, filter) hydrate. `/topics/` falls through the approuter catch-all to Hugo static — **no approuter route change needed.**
- **Relationship to #1170:** the existing homepage "Explore topic clusters" band (6-cluster teaser, `build-topic-clusters.js`) stays. It gains a "See all topics →" link into the new `/topics/` front door. The new gallery uses a **new builder** (`build-topics-gallery.js`) reusing #1170's KG read patterns (`KgCommunityLabel` → `KgCommunitySummaryV` → `KgCommunity` → `Tutorials`) but without the 6-cluster cap. `build-topic-clusters.js` is left untouched so its #1170 hybrid-test contract is preserved.
- **Naming caution:** "topic clusters" / "featured topics" strings are already in active use (homepage band, `/build/topic-clusters`, `/build/featured-topics`, `fetch-topic-clusters`, CSS `hp-topic-clusters`, #1032 carousel). New files/CSS/scripts use distinct names (`topics-gallery`, `topics-map`, `.topics-*`) to avoid confusion.

## Problem

`https://…/concepts/` today is a **flat, filterable list of ~5,946 concepts**. Only the top-100 by PageRank render as real HTML; the rest are embedded as JSON for a client-side text filter with an A-Z jump. There is no grouping, no topic-level structure, no guided path, and no use of the rich graph signals the platform already computes. Individual concept pages (`/concepts/<slug>`) show prerequisites / builds-on / related as plain hyperlink lists — functional, but not a discovery experience.

Meanwhile the platform **already computes** the raw material for something far better, but does not surface most of it to end users:

- **Labeled Louvain communities** (`KgCommunityLabel`: LLM label + rationale + member concepts/tutorials) — currently admin-only, used to promote Missions.
- **PageRank** scores (`ConceptRank` / `TutorialRank`) — deliberately off every OData surface.
- **Concept↔concept edges** (`ConceptEdges`: `requires` / `relatedTo`).
- **HANA-native vector embeddings** (`Concepts.embeddingVec`, 1536-dim) — used for merge/dedup, not discovery.
- **Aliases** (`ConceptAliases` / `aliasSearchBlob`) — powers the ⌘K palette.
- A **public interactive graph explorer already exists** at `/explore/` (Vue app on `/graph/explore-data` + `/graph/path`).

**The gap is presentation, not computation.** The signals exist; the flat list does nothing with them, and `/explore/` and `/concepts/` don't reinforce each other.

## Goals & Priority

Serve all three audiences, in this priority order:

1. **A — Goal-driven learner** ("I want to learn SAP HANA"): needs the right entry point and a path through related concepts. **Highest value; leads the design.**
2. **B — Serendipitous browser** (no fixed goal): wants to see how topics connect and stumble onto adjacent areas.
3. **C — Returning developer** (knows what they want, needs to jump fast): search over 5.4k items currently fails them. **Table stakes, not the hero.**

The landing experience orients visitors around **topics and paths**, not a search box. The organizing unit throughout is the **labeled topic cluster** (Louvain community) — the one "topic-sized" grouping already computed over the graph.

## Non-Goals (YAGNI for v1)

- Personalized / "resume where you left off" paths.
- Cross-cluster guided journeys spanning multiple topics.
- A dedicated "orphan / isolated concepts" browse (isolation flags stay a per-row badge).
- Replacing or deleting `/concepts/` or `/explore/` — both are reused as drill-downs.
- A second graph rendering engine — the map reuses `/explore/`'s viz library.

---

## Information Architecture

A **new front door at `/topics/`** (working name — see Naming). Three layers of increasing depth:

```
/topics/                         ← NEW front door
├─ Hero: Topic Cluster Gallery   (labeled Louvain communities as cards)
└─ Below: Cluster Map            (super-nodes, expand-in-place)
                                   └─ "See full graph →" → /explore/ (deep-linked, pre-focused)

/topics/<cluster>/               ← cluster detail (concepts in cluster + suggested path)
                                   └─ each concept → /concepts/<slug>  (existing page, unchanged)

/concepts/                       ← DEMOTED to the exhaustive A-Z index (SEO/power fallback)
/explore/                        ← unchanged; the deepest zoom (full interactive graph)
```

**Key move:** `/topics/` becomes the thing we link to and land on. `/concepts/` demotes from "the concepts experience" to "the exhaustive alphabetical index" — still useful, still SEO-valuable, no longer the front door. Nothing existing is deleted.

**Continuous zoom mental model:** gallery → map → full graph.

---

## Component 1 — Topic Cluster Gallery (hero)

Responsive grid of cluster cards, one per **shown** labeled Louvain community.

Each card shows:
- **Label** (`KgCommunityLabel.label`, or `curatedLabel` override) — e.g. "RAP & Clean Core Development".
- **One-line rationale** (`KgCommunityLabel.rationale`, truncated).
- **Size signal** — "34 concepts · 120 tutorials" (`memberCount` / `tutorialCount` from `KgCommunitySummaryV`).
- **3-4 representative concept chips** — top concepts in the cluster by PageRank (concrete peek, not just an abstract label).

**Ordering:** clusters sorted by a blend of size × aggregate PageRank so the meatiest, most-connected topics lead. Small/weak clusters sink.

**Filtering out noise:** clusters below a size threshold (e.g. ≤2 members) or with no label are **hidden** from the gallery.

**Interactions:**
- Click card → `/topics/<cluster>/`.
- Lightweight filter/sort bar (size / alphabetical / newest) — reuses the `concepts-filter.js` island pattern.
- Alias-aware search box present but **understated** (small, top-right) — priority C, table stakes.

**Honesty:** the gallery is the SSR/SEO/no-JS floor of the whole surface.

---

## Component 2 — Cluster Map (below the hero)

A compact force-directed graph — the spatial view of the same clusters.

**Default — cluster super-nodes:**
- One node per shown cluster (~30-60 nodes), **sized by member count**, **colored consistently with its gallery card**.
- **Inter-cluster edges** (in scope for v1): weighted by the count of concept↔concept `ConceptEdges` (or shared tutorials) crossing the two clusters; thickness = weight. Shows which topics bridge into each other.
- Node label = cluster label.

**Expand-in-place:**
- Click a super-node → expands to reveal its **top concepts by PageRank** as child nodes; edges among them from `ConceptEdges`; other clusters dim.
- **"See full graph →"** hands off to `/explore/` **deep-linked / pre-focused** on that cluster's region (in scope for v1).

**Build approach — reuse, don't reinvent:**
- New lightweight aggregation endpoint `GET /graph/clusters-data` → cluster super-nodes + inter-cluster edges (precomputed).
- Per-cluster concept subgraph fetched on demand for expand-in-place.
- Rendered with the **same viz library `/explore/` already uses** — no second graph engine.

**Honesty:** progressive enhancement only. Needs JS + modern browser. If the map fails, the gallery above is fully functional.

---

## Component 3 — Cluster Detail — `/topics/<cluster>/`

The goal-driven-learner payoff (priority A).

**Sections:**
- **Header** — cluster label + full rationale + size.
- **Suggested order (the "path")** — cluster concepts arranged into a rough learning sequence via a **topological-ish sort over the `requires` edges** in `ConceptEdges` (prerequisites before dependents), with **PageRank breaking ties/cycles**. Presented as a numbered vertical list. Honest framing: *"A suggested order through this topic"*, not "THE course."
- **All concepts in this cluster** — full member list (chips/cards), each → existing `/concepts/<slug>`. Sortable (suggested order / alphabetical / most tutorials).
- **Peer clusters** — "Topics that connect to this one" — inter-cluster edges rendered as links to sibling `/topics/<cluster>/`. This is where serendipity (priority B) lives.
- **Mini-map** (optional) — the single-cluster expanded graph from Component 2, embedded.

**Honesty / graceful degradation:**
- The path is **best-effort**: `requires` edges are LLM-extracted and incomplete; cycles and orphans exist. If `requires` data is too thin, **fall back to PageRank order and drop the "suggested order" framing** to just "concepts in this topic." No fake precision.
- **No multi-cluster membership problem:** Louvain assigns each vertex to exactly one community per pass. Clean — no dedup.

---

## Component 4 — Cluster Identity & Data Pipeline (load-bearing)

**The problem:** Louvain runs nightly; communities are keyed by `communityFingerprint` (SHA-256 of sorted member slugs). Add/remove one member → fingerprint changes → `/topics/<cluster>/` URL breaks, links rot, SEO resets nightly. Unacceptable for a linkable front door.

**The fix — stable `TopicClusters` slug that survives membership drift.**

A new lightweight entity mapping a stable human slug → the current fingerprint:

```cds
entity TopicClusters {
  key slug                 : String(80);   // stable, e.g. "rap-clean-core" — derived from label, never changes
      label                : String(120);  // current label (from KgCommunityLabel)
      curatedLabel         : String(120);  // optional admin override of the LLM label (v1)
      fingerprint          : String(64);   // CURRENT Louvain fingerprint this slug points to
      previousFingerprints : ...        ;   // history, for reconciliation / audit
      status               : String(20);   // ACTIVE | RETIRED
      // + managed timestamps
}
```

**Nightly reconciliation job** (runs after Louvain + community labeling):
- For each new community, match to an existing `TopicCluster` by **member overlap — Jaccard over member slugs**. If a new community shares ≥ threshold of members with an existing cluster → "same topic, drifted": update `fingerprint`, keep `slug`, append old fingerprint to history.
- Genuinely new communities → mint a new slug from the label.
- Clusters with no good match → `status = RETIRED` (slug 301s to the gallery, or shows a "this topic was reorganized" notice).
- **Fail-open:** a failed nightly run leaves yesterday's `TopicClusters` mapping intact — never wipes it.

This mirrors the KG's existing *identity-across-recompute* patterns (concept merge-on-write cosine matching; community label `memberSlugsHash` skip-keys).

**Rendering strategy — Hugo-bake (Model B), matching #1170 + `/explore/`:**
- **Nightly job** writes the `TopicClusters` sidecar (stable slug ↔ current fingerprint) → the gallery/detail data is exposed via a **`/build/topics-gallery` JSON feed** (new builder `build-topics-gallery.js`, reusing #1170's KG read patterns) → **`scripts/fetch-topics-gallery.ts`** writes `hugo/data/topics_gallery.json` at build time → **Hugo layouts** bake the gallery page (`/topics/`) and every cluster-detail page (`/topics/<slug>/`) as static HTML. SSR/SEO/no-JS for free.
- **Cluster map + expand-in-place** → new JSON endpoint(s) (`/graph/clusters-data` for super-nodes + inter-cluster edges; per-cluster subgraph) consumed by a new Sigma-based Vue island (`hugo-apps/src/topics-map/`), reusing `/explore/`'s graphology + Sigma + ForceAtlas2 stack. Progressive enhancement — if the island fails, the baked gallery is fully functional.
- **No approuter route change** — `/topics/` and `/topics/<slug>/` fall through the approuter catch-all (`^(.*)$` → static) to Hugo-generated pages, exactly like `/explore/`.

**Admin surface:** a cluster admin view to override labels (`curatedLabel`), hide junk clusters, and inspect reconciliation history — reusing the existing `#kgCommunities` FE app pattern.

---

## Cross-Cutting Concerns

**Fast-jump search (priority C, table stakes):** reuse the existing alias-aware `PublishedConceptsWithAliases` `$search` (already powers ⌘K). Understated search box on `/topics/`; results jump to `/concepts/<slug>`. No new search infrastructure.

**Error / empty handling:**
- Gallery is the SSR floor — map/island failures never break the page.
- Reconciliation job fail-opens (yesterday's mapping preserved).
- Thin `requires` data → path falls back to PageRank order, drops "suggested order" framing.
- Retired cluster slug → 301 to gallery or "this topic was reorganized" notice.

**Testing:**
- **Unit** — reconciliation Jaccard matching; topo-sort + fallback ordering; gallery builder model build; cluster-card selection (top concepts by PageRank); `build-topics-gallery.js` payload shape; Hugo layout template assertions (like `topic-clusters-band.test.ts`).
- **Hybrid** (real HANA via `cds bind`) — `/build/topics-gallery` feed against real community data; `/graph/clusters-data` endpoint shape; reconciliation against real KgCommunity data.
- **Smoke** — `/topics/` returns 200 with baked gallery content; a `/topics/<slug>/` returns 200.
- **E2E** (committed spec, per Tom's #1 rule + the e2e-nudge convention) — drive the real gallery → cluster detail → map → `/explore/` handoff in a browser.

---

## Reused vs. New

**Reused (no changes or additive only):**
- `KgCommunity`, `KgCommunitySummaryV`, `KgCommunityLabel` (Louvain output).
- `ConceptRank` / `TutorialRank` (PageRank sidecars).
- `ConceptEdges`, `TutorialConceptLinks` (graph edges).
- KG read patterns from `build-topic-clusters.js` (#1170) — reused, file untouched.
- `PublishedConceptsWithAliases` (`$search` for fast-jump).
- `/explore/` Vue app + its Sigma/graphology/ForceAtlas2 stack + `/graph/explore-data` / `/graph/path`.
- Build-time fetch → `hugo/data/*.json` → Hugo-bake pipeline (like #1170 / #1032 / `/explore/`).
- `concepts-filter.js` island pattern + `hugo-apps/` island build config.
- `#kgCommunities` FE app pattern (for the new admin view).
- Existing `/concepts/<slug>` pages (drill-down target, unchanged).
- Nightly job chassis (`scheduler.js` + `cron-service.js`), metrics helper.

**New:**
- Hugo layouts for `/topics/` gallery + `/topics/<slug>/` cluster detail (baked static).
- `TopicClusters` entity + nightly reconciliation job (`kg-topic-clusters-job.js`).
- `build-topics-gallery.js` + `/build/topics-gallery` feed + `scripts/fetch-topics-gallery.ts` → `hugo/data/topics_gallery.json`.
- `GET /graph/clusters-data` (super-nodes + inter-cluster edges) + per-cluster subgraph endpoint.
- `hugo-apps/src/topics-map/` Sigma island (cluster map, expand-in-place).
- `/explore/` deep-link/pre-focus parameter.
- "See all topics →" link added to the #1170 homepage band.
- Admin cluster view (label override, hide, reconciliation history).

---

## Open Item

_None._ Route name (`/topics/`) and rendering model (Hugo-bake) locked after recon — see "Decisions locked" at top.
