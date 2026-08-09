# Topics Discovery Front Door — Design

**Date:** 2026-08-09
**Status:** Approved (design), pending implementation plan
**Author:** Tom + Claude (brainstorming session)
**Related:** #1327 (concepts moved to CAP), #917/#1126 (Louvain communities + labels), #916 (PageRank), #918 (WCC isolation), #985 (community fingerprint), `/explore/` graph app

---

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

**Rendering strategy — match the existing split:**
- **Gallery + cluster detail pages** → pre-rendered into HANA `ContentFiles` as `topic-<slug>` BLOBs by a **publish step**, served by the same `serveHandler` plumbing that serves `/tutorials/` and `/concepts/<slug>`. SSR/SEO/no-JS for free; consistent with how the platform already works.
- **Cluster map + expand-in-place** → the two new JSON endpoints (`/graph/clusters-data`, per-cluster subgraph) consumed by a Vue island. Progressive enhancement.

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
- **Unit** — reconciliation Jaccard matching; topo-sort + fallback ordering; gallery model build; cluster-card selection (top concepts by PageRank).
- **Hybrid** (real HANA via `cds bind`) — publish `topic-<slug>` BLOBs; `/graph/clusters-data` endpoint shape; reconciliation against real community data.
- **Smoke** — `/topics/` returns 200 with SSR content; a `/topics/<slug>/` returns 200.
- **E2E** (committed spec, per Tom's #1 rule + the e2e-nudge convention) — drive the real gallery → cluster detail → map → `/explore/` handoff in a browser.

---

## Reused vs. New

**Reused (no changes or additive only):**
- `KgCommunity`, `KgCommunitySummaryV`, `KgCommunityLabel` (Louvain output).
- `ConceptRank` / `TutorialRank` (PageRank sidecars).
- `ConceptEdges`, `TutorialConceptLinks` (graph edges).
- `PublishedConceptsWithAliases` (`$search` for fast-jump).
- `ContentFiles` + `serveHandler` publish/serve plumbing.
- `/explore/` Vue app + its viz library + `/graph/explore-data` / `/graph/path`.
- `concepts-filter.js` island pattern.
- `#kgCommunities` FE app pattern (for the new admin view).
- Existing `/concepts/<slug>` pages (drill-down target, unchanged).

**New:**
- `/topics/` front door (gallery + map) — SSR pages + Vue island.
- `/topics/<cluster>/` cluster detail pages — SSR.
- `TopicClusters` entity + nightly reconciliation job.
- `GET /graph/clusters-data` (super-nodes + inter-cluster edges) + per-cluster subgraph endpoint.
- `/explore/` deep-link/pre-focus parameter.
- Publish step for `topic-<slug>` BLOBs.
- Admin cluster view (label override, hide, reconciliation history).

---

## Open Item

**Naming.** Working name is `/topics/`. Alternatives: `/learn/`, `/discover/`, `/explore-topics/`. To be decided before implementation (the route string threads through publish slugs, AppRouter config, and internal links, so pick once).
