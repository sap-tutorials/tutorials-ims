# Tag-Tree Topics — Design

**Date:** 2026-09-01
**Status:** Draft for review
**Issue/context:** `/topics/` is broken in production: every topic detail URL 404s, detail pages that render show no concepts, and the topics search box submits to a dead endpoint. This design rebuilds `/topics/` as a first-class subsystem with the same technical quality as `/concepts/`.

---

## 1. Problem statement (why topics is broken today)

Three independent defects, all confirmed against the live site and the repo:

1. **Every topic detail page 404s.** The approuter has a full dynamic per-slug serve path for concepts (`^/concepts/(.*)$` → `/content/concepts/$1`, served from HANA and rendered by `srv/lib/concept-detail-render.js`), but for topics **only the index route exists** (`^/topics/?$` → `/content/pages/topics/`). There is **no `/topics/(.*)` route**, so `/topics/<slug>/` — for any slug — falls through to a bare 404 (verified: the 404 carries no `x-content-source` header, i.e. it never reaches CAP). The Hugo-baked topic stubs are neither in the content-publish scope (`srv/lib/page-key-map.js` `IN_SCOPE_PAGES` lists only `page-topics`, the index) nor routed.

2. **Detail pages show no concepts.** Topic detail (`hugo/layouts/topics/single.html`) reads `concepts[]` from the `/build/topics-gallery` payload (`srv/lib/build-topics-gallery.js`). That array is a `KgCommunity` (concept-vertex membership) → `Concepts.name` join. When the join returns nothing (empty/stale `KgCommunity` rows or slug-case mismatch), `concepts[]` is `[]` and the `{{ with $c.concepts }}` guard omits the whole section — while `memberCount`/`tutorialCount`, read straight off the `TopicClusters` row, still claim "N concepts". Counts and content come from different sources and disagree.

3. **`/search/?q=` does nothing.** There is no `/search/` HTML page. `/search/` is the CAP `SearchService` **OData** endpoint. The topics search form (`hugo/layouts/topics/list.html:23`) does a full-page GET to `/search/?q=…`, landing on the OData service root, which ignores `?q=` (OData uses `$search=`) and renders no UI. The working search UI is the navigator island at `/tutorial-navigator/` (reads `?q=` via `hugo-apps/src/navigator/urlSync.ts`).

Additional structural cause of link rot: the `/topics/` index currently links to ~501 slugs derived from **KG Louvain community labels**, which are **LLM-generated and non-deterministic** — they change on every KG rebuild, so previously valid `/topics/<slug>/` links stop existing. This is orthogonal to the routing gap but compounds it.

---

## 2. Goals & non-goals

**Goals**
- Topic detail pages resolve (200) with the same dynamic-slug serve architecture as concepts.
- Topics are keyed by **stable, source-of-truth slugs** (SAP's central software tag hierarchy), so links do not rot.
- Detail pages show **real, deterministically-populated concepts** plus the topic's tutorials.
- `/topics/` presents a **tree navigation experience** over the tag hierarchy (facet → product → sub-product).
- The topics search box reaches the working search UI.
- Legacy AEM tag URLs resurrect **where the tag still has tutorials**; otherwise they redirect gracefully.

**Non-goals (YAGNI / deferred)**
- Curated editorial "learning-path" topics with hand-ordered concepts (`orderConcepts`, `orderMode: path`). The existing `TopicClusters`/`topics_gallery` learning-path UX can layer on top later; it is not required for parity and is not carried forward as the primary model.
- KG Louvain communities as a public URL key (retained only for the homepage band, unchanged).
- Resurrecting legacy URLs for retired products that have no current tutorials (impossible from a current-catalog source of truth).
- A client-side-only tree (rejected for SEO/parity — see §5).

---

## 3. Topic model

A **topic = a live SAP tag** (a tag currently applied to ≥1 tutorial). Tags come from SAP's central software hierarchy and are the source of truth already consumed by this platform, so slugs are stable and externally meaningful.

Tag data (`/build/tags`, cached to `hugo/data/tags.json`) is `group>value`, 8 facet groups, 143 live tags, with a deeper `--` sub-level:

- Facets: `software-product` (90), `software-product-function` (16), `programming-tool` (12), `topic` (11), `tutorial` (8), `deprecated-concepts` (3), `operating-system` (2), `type` (1).
- Deep example: `software-product-function>sap-hana-cloud--data-lake` → `sap-hana-cloud` → `data-lake`.

**Natural tree:** `facet → product → sub-product`. The hierarchy *is* the clustering — deterministic, no LLM.

### Slug scheme
- Topic slug = the flattened leaf value: `sap-hana-cloud--data-lake` → `sap-hana-cloud-data-lake`; `>` and `--` both collapse to `-`.
- Matches the legacy AEM leaf-slug shape (`sap-hana-smart-data-streaming-development`), which is what enables legacy-URL resurrection.
- **Collision handling:** build-time check across all leaves. On collision, facet-qualify the loser (`<facet>-<value>`). Expected rare; asserted in a unit test so a future tag import that introduces a collision fails loudly.

---

## 4. Data model — CAP builders

Two new builder endpoints, both fed by existing sources; both fail-open (return empty payload + `error` field, matching the `build-topics-gallery.js` posture).

### 4.1 `/build/topics-tree` (index payload)
Builds the navigation tree:
```
{ tree: [ { facet, label, children: [ { slug, label, tutorialCount, conceptCount,
                                        children: [ …sub-product leaves… ] } ] } ],
  buildAt, error }
```
- Nodes/leaves from `/build/tags` (live tags only → every node has content).
- Human labels from `/build/tag-labels`.
- `tutorialCount` per tag from the existing tag→tutorial index.
- `conceptCount` per tag from the concept-enrichment join (§4.2), so the tree can show concept density.

### 4.2 `/build/topics/:slug` (detail payload)
```
{ slug, label, facet, rationale?,
  tutorials: [ { slug, title, level, time, href, isNew } ],
  concepts:  [ { slug, name, rank } ],   // deterministic — see below
  relatedTags: [ { slug, label } ],       // siblings + children in the tree
  buildAt, error }
```
- **Concepts populate deterministically** as: concepts linked (via existing `TutorialConceptLinks`) to the set of tutorials carrying this tag, deduped, ranked by `loadRankMaps()` conceptRank. This replaces the empty `KgCommunity` membership join that causes defect #2. Concepts link out to the existing `/concepts/<slug>/` pages.
- `tutorials` from the tag→tutorial index (same source the navigator/facets use), lowercased slugs (`tutorialsTableInfo` helper) to avoid the known slug-case pitfall.
- `relatedTags` = tree siblings + children, for cross-navigation.

### 4.3 Reuse note
`build-topics-gallery.js`, `TopicClusters`, and `topics_gallery.json` are **retired from the `/topics/` path** (the homepage `topic_clusters.json` band is untouched). We delete the two committed stub pages (`hugo/content/topics/btp-basics.md`, `cap-fundamentals.md`) and the `fetch-topics-gallery.ts` stub-generation. Any code deletion sweeps orphaned tests in the same commit.

---

## 5. Tree navigation UI — server-rendered + progressive island

Matches the concepts-page pattern (server-rendered HTML + a small enhancing island), for SEO and no-JS resilience. **Critically, the index is CAP-rendered, not Hugo-static** — the original topics breakage came from Hugo-baked pages that no route served. `/concepts/` is fully CAP-rendered (`srv/lib/concept-list-page.js` behind `/content/concepts-index`); topics matches that exactly.

- A new **`srv/lib/topic-list-page.js`** (mirroring `concept-list-page.js`), served at `/content/topics-index`, renders the full `facet → product → sub-product` tree from the `/build/topics-tree` payload as **semantic nested `<ul>`** with native `<details>/<summary>` disclosure — fully functional without JS, crawlable — wrapped in the shared chrome (`srv/lib/chrome-shell.js`). Published as a HANA content blob like the concepts index.
- A **small Vue island** (`hugo-apps/src/topics-tree/`) progressively enhances: type-ahead filter, expand/collapse-all, deep-link to an expanded node. Mount is inert until JS loads (same posture as `concepts-filter.js`). Built into the island manifest; the CAP-rendered HTML embeds the hashed island `<script>` via the published island manifest (same mechanism concept pages use to embed islands).
- Each leaf links to `/topics/<slug>/`.
- The Hugo `topics` content section (`hugo/content/topics/`, `hugo/layouts/topics/`) and `hugo/data/topics_gallery.json` are retired; the index and detail are both CAP-rendered from `/build/*` payloads. `scripts/fetch-topics-tree.ts` still writes `hugo/data/topics_tree.json` only if we want the tree available to local Hugo dev preview — otherwise it is unnecessary (CAP is the single source). Design assumes **CAP-only** (no Hugo topics data file) for parity and simplicity; noted as open question 4.

### 5.1 Topic detail page
- Detail HTML is **generated by CAP at serve time** from the `/build/topics/:slug` payload, rendered by a new `srv/lib/topic-detail-render.js` (mirroring `concept-detail-render.js`), wrapped in the shared chrome (`srv/lib/chrome-shell.js`). It shows: title + facet breadcrumb, tutorials list, concepts list (linking to `/concepts/`), related tags, and the enhancing tree as context. This keeps topics on the identical serve mechanism as concepts rather than Hugo-static.

---

## 6. Serve / publish backbone — mirror concepts exactly

- **Approuter** (`approuter/xs-app.json`): add
  - `^/topics/?(\?.*)?$` → `/content/topics-index` (replaces the current `page-topics` route)
  - `^/topics/(.*)$` → `/content/topics/$1`
  - `^/build/(…|topics-tree)…` — add `topics-tree` to the existing `/build/*` allow-list regex.
  - both `authenticationType: none` (public), like concepts.
- **CAP** (`srv/server.js`): register `GET /content/topics-index` (index handler) and `GET /content/topics/:slug` (detail handler), mirroring the `/content/concepts-index` and `/content/concepts/:slug` registrations.
- **Publish**: topic detail pages become **dynamic-slug content blobs in HANA**, published via the same path concepts use (`build-concepts.js` equivalent → a new `srv/lib/build-topics.js` producing per-slug blobs; a `topic-` key prefix + `discoverTopicPages`-style walker in `page-key-map.js`, analogous to the author/advocate dynamic-slug precedent already in that file). LOB reads use raw `db.run()` per the BLOB-locator rule.
- **`srv-qa` cp-list audit**: any new `srv/lib/*` reachable from `content-store.js` must be added to `.deploy/mta.yaml`'s `srv-qa` `cp` list, and transitive `./` imports re-walked.

### 6.1 Legacy / retired slug handling
- Legacy `-N` numeric disambiguators (`…-development-2`) → strip suffix; if the base slug is a live topic, **301** to it.
- Retired-product slugs with no live tag → **301 to `/topics/`** (or nearest live parent facet if resolvable). Implemented as a small slug-normalization step in the detail handler before 404.

---

## 7. Search fix (independent, small)

- Repoint the topics search form action and empty-state link (`hugo/layouts/topics/list.html`) from `/search/` to **`/tutorial-navigator/`** (keeps `name="q"`; navigator reads `?q=` via `urlSync.ts`).
- Add an approuter **301 `^/search/(\?.*)?$` → `/tutorial-navigator/$1`** so any external `/search/?q=` links (and the OData collision) resolve to the real UI. Verify this does not shadow the OData `SearchService` data routes (`^/search/(.*)$` → `/search/$1`): scope the redirect to the bare `/search/` + query only, leaving `/search/SearchableItems` etc. intact.

---

## 8. Testing

- **Unit:** tree builder (facet grouping, `--` sub-nesting, counts), slug flattening + collision assertion, concept-enrichment join (tag→tutorials→concepts dedup/rank), legacy-slug normalization/redirect logic. Use `cds.test('serve', …, '--in-memory')` bootstrap (not `cds.deploy(cds.model)`).
- **Hybrid** (`--project hybrid`, real HANA via `cds bind --exec`): `/build/topics-tree` and `/build/topics/:slug` return non-empty against real tag + KG data; publish→serve round-trip for a sample topic blob; slug-case correctness.
- **e2e** (committed spec in `test/e2e/`, post-deploy, self-skipping): `/topics/` renders the tree; a leaf navigates to a `/topics/<slug>/` detail page that shows tutorials + concepts; search box lands on `/tutorial-navigator/?q=`. (User-facing UI change → repo convention wants a committed e2e spec.)
- **Smoke:** new `/topics/<slug>/` and `/topics/` routes return 200 with expected `x-content-source`.
- Pre-commit for any `db/**/*.cds` change: `npx cds deploy --to sqlite::memory:`; `cds build --production` after schema changes (never hand-author migration tables).

---

## 9. Rollout & risk

- **Branch/PR:** implement on a branch off **`origin/DEV`** (this repo's PRs target DEV; `main` is protected — no direct-to-main path). Rebase this worktree onto `origin/DEV` before implementation.
- **Data dependency:** concept enrichment needs `TutorialConceptLinks` populated in the target env; if empty, concepts render empty but tutorials + tree still work (fail-open, no 500).
- **Deploy:** admin/serve changes need a full MTA deploy; content (topic blobs) published via `gh workflow run rebuild-content.yml`, not a workstation. Confirm deploy scope with maintainer.
- **Reversibility:** the old `page-topics` index route can be restored by reverting the approuter diff; topic blobs are additive in HANA.

---

## 10. Open questions for reviewer

1. Slug scheme: bare leaf (`sap-hana-cloud-data-lake`) vs facet-qualified always (`software-product-function-sap-hana-cloud-data-lake`)? Design assumes bare-leaf + qualify-on-collision (best legacy-URL match).
2. Should retired-product legacy URLs 301 to the facet parent, or always to `/topics/`? Design assumes `/topics/` unless a live parent is trivially resolvable.
3. Is a persistent left-rail tree on detail pages wanted later, or is index-tree + related-tags sufficient? Design ships the latter (YAGNI); left-rail is a clean follow-up.
4. CAP-only rendering (no Hugo topics data file) vs also writing `hugo/data/topics_tree.json` for local Hugo dev preview? Design assumes CAP-only for parity/simplicity.
