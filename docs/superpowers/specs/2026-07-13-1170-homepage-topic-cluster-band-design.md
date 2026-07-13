# Design: Homepage "topic cluster" band (#1170, #1126 follow-on 1/4)

**Issue:** [#1170](https://github.com/sap-tutorials/tutorials-ims/issues/1170) — Surface Louvain topic clusters as a learner-facing homepage band
**Epic:** [#1126](https://github.com/sap-tutorials/tutorials-ims/issues/1126) — "put KG communities to work" (PR-scope item 1 of 4)
**Date:** 2026-07-13
**Status:** Approved — ready for implementation plan

## Context

KG **community detection** (Louvain, #917) clusters related tutorials nightly,
fingerprints each cluster (#985), and materializes membership into the
`KgCommunity` sidecar. #1126 PR 1 (#1163) added the **nightly labeling job**
that names each cluster with an LLM and stores the result in
`KgCommunityLabel`. Today those labels have exactly one learner-facing
consumer (the Joule `findCommunityPeers` tool). This issue adds a second: a
**homepage "topic cluster" band** — a nightly-refreshed row of themed tutorial
groupings, each headed by its LLM-generated label.

### Prerequisite state (confirmed 2026-07-13)

- `KgCommunity` — 29 communities / 2,854 tutorial members in DEV
  (`db/knowledge-graph-communities.cds`), keyed on stable `communityFingerprint`.
- `KgCommunityLabel` — 18 labeled communities in DEV
  `{ communityFingerprint, label, rationale, memberSlugsHash, labeledAt, model }`.
  Nightly `kg-community-labels` job at 04:12 UTC.
- `KgCommunitySummaryV` — per-community aggregate view exposing `communityId`,
  `memberCount`, `tutorialCount`, `communityFingerprint`, `alreadyPromoted`.
- **DEV-only** in v1 — PROD Louvain rollout is folded into #1126's PR chain, not
  this issue. This band ships behind the same DEV-only data posture; empty-safe
  behavior (below) means it simply renders nothing until PROD data lands.

### The template this PR follows

The **featured-topics carousel** (#1032) is the exact precedent: a CAP-computed
dataset exposed at a `/build/*` Express route, fetched into `hugo/data/*.json`
by a `scripts/fetch-*.ts` script wired into `build:all`, and rendered by a Hugo
partial placed in the homepage band order. This PR mirrors that pipeline but is
**simpler**: SSR-only (no Vue island, no OData snapshot function, no ETag
hydration), because the acceptance criteria require only a static, empty-safe,
SEO-visible band.

The **`promoteCommunityToMission` handler** (`srv/admin-service.js:2768`) is the
exact query precedent for "community members → live tutorials sorted by title,
skipping members whose slug no longer resolves."

## Goal

On the developer-portal homepage, render a band of up to 6 themed tutorial
clusters. Each cluster shows its LLM label as the heading and links to up to 4
of its member tutorials. The band is baked at Hugo build time from the deployed
CAP backend and refreshes on the nightly full rebuild.

## Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| Rendering | **SSR shelf** — static Hugo partial, no JS/hydration |
| Selection | Top **6** clusters by `tutorialCount` desc; **min 3** tutorials to qualify; **4** member tutorials shown per card |
| Ordering within card | Member tutorials sorted `title ASC` (no PageRank dependency — deferred to a later epic PR) |
| Placement | Just before `directory-footer` (after `community-lane`) |
| Refresh | Nightly via `build:all` — no new cron job |

## Architecture — three pieces

```
KgCommunityLabel (fingerprint → label, rationale)
  ⋈ KgCommunitySummaryV (fingerprint → tutorialCount)      [rank + gate]
    → KgCommunity members (fingerprint, vertexType='tutorial') [member slugs]
      → live Tutorials (status ACTIVE/null, title)             [resolve + filter]
        → srv/lib/build-topic-clusters.js → GET /build/topic-clusters (Express)
          → scripts/fetch-topic-clusters.ts → hugo/data/topic_clusters.json
            → hugo/layouts/partials/homepage/topic-clusters-band.html (SSR)
```

### 1. Read model — `srv/lib/build-topic-clusters.js` + `/build/topic-clusters`

New Express handler registered in `srv/server.js` alongside the sibling
`/build/homepage-shelves`, `/build/featured-topics` routes — **public,
unauthenticated, `Cache-Control: public, max-age=60`** (Hugo fetches once per
build). Reads direct from raw entities via `cds.connect.to('db')` — NOT through
a `@requires`-gated service (matches the `/build/*` precedent).

Query logic:

1. `SELECT communityFingerprint, label, rationale FROM KgCommunityLabel`
   (all labeled communities — small table, ≤ tens of rows).
2. `SELECT communityFingerprint, tutorialCount FROM KgCommunitySummaryV`
   — build a `fingerprint → tutorialCount` map to rank and gate.
3. Keep only labeled fingerprints with `tutorialCount >= 3`; sort by
   `tutorialCount` desc; take top **6**.
4. For each surviving cluster, fetch its tutorial-typed members:
   `SELECT slug FROM KgCommunity WHERE communityFingerprint = ? AND vertexType='tutorial'`.
   Lowercase every slug (**canonical-slug gotcha** — slugs are lowercase
   canonical; never compare a raw slug to a Tutorials row without
   `.toLowerCase()`).
5. Resolve to live tutorials:
   `SELECT slug, title FROM Tutorials WHERE slug IN (<lowercased>) AND (status='ACTIVE' OR status IS NULL) ORDER BY title ASC`.
   Members whose slug no longer resolves (deleted / never-published) are
   silently dropped, exactly like `promoteCommunityToMission`.
6. **Re-gate after resolution:** if the *resolved live* tutorial count for a
   cluster drops below 3, drop the cluster (the label promised ≥3, so honor it
   against reachable tutorials, not raw membership). Cap the shown members at 4
   per card.
7. Return `{ clusters: [{ label, rationale, communityFingerprint, tutorialCount, tutorials: [{ slug, title, url }] }], buildAt }`
   where `url = /tutorials/${slug}` (matches `featured-topics-snapshot.js:198`).

**BLOB note:** every selected column is scalar (no LargeString/BLOB in this
path), so plain CDS QL is safe — no HANA LOB-locator gotcha.

**Packet-size note:** communities are small (≤ tens of tutorial members), so
`WHERE slug IN (…)` per cluster is well under HANA's bound-param limit. No
unbounded-fetch-and-filter-in-Node needed here.

**Fail-open / empty-safe:** any throw → the handler returns
`{ clusters: [], buildAt, error }` with HTTP 200 (never 500 into a build).
Zero labeled communities → `clusters: []`. This is what makes the band hide
itself (below) rather than 500 a build.

### 2. Fetch script — `scripts/fetch-topic-clusters.ts`

Byte-for-byte the shape of `scripts/fetch-featured-topics.ts`:

- Reads `CAP_BASE_URL` (default `http://localhost:4004`).
- `GET ${CAP_BASE}/build/topic-clusters`; on any error, warn and write an empty
  payload (`{ clusters: [], error }`) so the build never fails on a backend
  hiccup.
- Writes `hugo/data/topic_clusters.json`.
- Logs the cluster count written.

Wire into `package.json`:
- New script: `"fetch-topic-clusters": "tsx scripts/fetch-topic-clusters.ts"`.
- Insert into `build:all` right after `fetch-featured-topics`.

**`CAP_BASE_URL`-at-build contract:** the canonical local deploy already exports
`CAP_BASE_URL` at the deployed backend and `build:deploy` fails fast if it is
unset/localhost — this band inherits that guard automatically because it fetches
from the same base. No new guard code needed; the empty-payload-on-error path
degrades to a hidden band rather than an empty box.

### 3. SSR partial — `hugo/layouts/partials/homepage/topic-clusters-band.html`

- Reads `.Site.Data.topic_clusters` (Hugo auto-loads `hugo/data/*.json`).
- **Empty-safe by omission:** if `clusters` is empty or absent, the partial
  renders **nothing** (no `<section>`, no empty header) — distinct from
  featured-topics, which always emits a shell for its island to hydrate. There
  is no island here, so an empty band must produce zero DOM. This satisfies the
  "band hidden, never a 500 or empty box" criterion.
- When non-empty: one `<section class="hp-band hp-topic-clusters">` with a band
  title ("Explore topic clusters"), then one sub-group per cluster: an `<h3>`
  with the cluster `label`, optional `rationale` as sub-text, and up to 4
  tutorial links (`<a href="{{ .url }}">{{ .title }}</a>`) rendered with the
  existing card/list markup used by sibling bands.
- Added to `hugo/layouts/index.html` between `community-lane.html` and
  `directory-footer.html`.

CSS: add a `hp-topic-clusters` block to the homepage band stylesheet mirroring
the existing `hp-band` conventions (reuse shared `.hp-band` / `.hp-band__title`
tokens; minimal new rules).

## Data flow (refresh cadence)

The band refreshes whenever `build:all` runs — the nightly full rebuild picks
up fresh `KgCommunityLabel` rows (labeling job 04:12 UTC) and `KgCommunity`
memberships (Louvain 03:57 UTC). No new cron job. A slug-targeted hotfix
rebuild does NOT touch this band (it re-runs only the affected tutorial),
matching how featured-topics behaves.

## Testing

- **Unit** (`test/unit/build-topic-clusters.test.js`, in-memory SQLite): seed
  `KgCommunityLabel` + `KgCommunity` + `Tutorials`; assert:
  - top-6 cap + `tutorialCount >= 3` gate,
  - unlabeled communities excluded,
  - `INACTIVE` / missing tutorials excluded, `status IS NULL` included,
  - post-resolution re-gate drops a cluster that falls below 3 live tutorials,
  - members capped at 4 per card, sorted `title ASC`,
  - slug join is case-insensitive (seed a mixed-case member slug),
  - empty-safe: zero labels → `{ clusters: [] }`, handler never throws.
- **Hybrid** (`--project hybrid`, real HANA via `cds bind --exec`): hit
  `/build/topic-clusters` against real `KgCommunity`/`KgCommunityLabel` and
  assert the join returns real labeled clusters with resolved tutorial titles
  (guards the HANA-specific join + the ACTIVE filter).
- **Hugo render smoke:** with a seeded `topic_clusters.json`, `npm run
  build:hugo` and grep the homepage output for the band title + a cluster label;
  with an empty payload, assert the band `<section>` is absent.

## Rollout / deploy notes

- No schema change → **no `.hdbmigrationtable` bump, no `cds build --production`
  requirement.** This is read-only over existing entities.
- New `srv/lib/build-topic-clusters.js` is imported by `srv/server.js` (not by
  `content-store.js`), so the **`srv-qa` cp-list audit** applies only if a new
  transitive `srv/lib/` dep is introduced — this module has none beyond
  `@sap/cds`, so no `.deploy/mta.yaml` `srv-qa` cp entry is needed. Confirm at
  implementation time.
- Local deploy: `npm run build:all` (which now runs `fetch-topic-clusters`) MUST
  finish before `mbt build` — same rule as every other baked band.

## Key files

| File | Change |
|---|---|
| `srv/lib/build-topic-clusters.js` | **new** read-model handler |
| `srv/server.js` | + `app.get('/build/topic-clusters', …)` route registration |
| `scripts/fetch-topic-clusters.ts` | **new** build-time fetcher → `hugo/data/topic_clusters.json` |
| `package.json` | + `fetch-topic-clusters` script; insert into `build:all` after `fetch-featured-topics` |
| `hugo/layouts/partials/homepage/topic-clusters-band.html` | **new** SSR partial |
| `hugo/layouts/index.html` | + partial call between `community-lane` and `directory-footer` |
| homepage band CSS | + `hp-topic-clusters` block |
| `test/unit/build-topic-clusters.test.js` | **new** unit coverage |
| `test/hybrid/*` | + hybrid join coverage |

## Acceptance criteria mapping

- **Band renders ≥3 labeled clusters, each linking to member tutorials** →
  §3 SSR partial + §1 read model (top-6, min-3 gate).
- **Empty-safe (band hidden, never 500 or empty box)** → §1 fail-open 200 +
  §3 render-nothing-when-empty.
- **Slug joins `.toLowerCase()`, only ACTIVE/published tutorials** → §1 steps 4–5.
- **`CAP_BASE_URL`-at-build contract respected** → §2 (inherits `build:deploy`
  guard; empty-on-error degrades to hidden band).
- **Unit + hybrid coverage** → Testing section.

## Non-goals (per issue)

- Search-rank blending (separate epic PR).
- Personalization / per-user cluster ranking.
- Editing/curating clusters from this surface (curator-assist PR).
- PageRank lead-item ordering (#916) — deferred; `title ASC` for v1.

## Related

- #1126 (epic), #1163 (PR 1 — data foundation: `KgCommunityLabel` + labeling job)
- #917 (community detection), #985 (fingerprint), #916 (PageRank — later lead-item ranking)
- #1032 (featured-topics carousel — the pipeline template)
