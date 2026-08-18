# Persist Tutorial Images (durable Object Store, GitHub decoupled) — Design

- **Date:** 2026-08-17
- **Status:** Approved design (pending spec review) → to be turned into an implementation plan
- **Tracking issue:** [#1869](https://github.com/sap-tutorials/tutorials-ims/issues/1869)
- **Interim mitigation (ships first):** PR [#1868](https://github.com/sap-tutorials/tutorials-ims/pull/1868) — anonymous-first token, retry-on-429, ephemeral in-process cache

## 1. Problem & Goal

Tutorial images are fetched **live from GitHub on every CDN cache-miss**. The
parser rewrites each image `src` to `/img-cdn/?u=<raw.githubusercontent.com URL>`,
and the approuter proxy fetches that URL from `raw.githubusercontent.com` at
request time, resizes/re-encodes via `sharp`, and streams it back. There is **no
durable copy** and **no fallback** — so when GitHub degrades (as in the
2026-08-17 major outage, "raw repository content ~50% error rates"), tutorial
**pages still load (served from HANA BLOBs) but images break site-wide**, on
desktop and mobile alike.

**Goal (agreed):** *fully decouple image serving from GitHub at request time.*
GitHub becomes a **publish-time source only**; the serving path never depends on
it. A GitHub outage must be a non-event for images, exactly as it already is for
HTML.

### Non-goals

- Changing the on-the-fly resize/WebP model (we keep it — see §3).
- Re-baking tutorial HTML (the `/img-cdn` URL shape is preserved).
- Multi-tenant Object Store (this is a single-tenant deployment).

## 2. Overview

Store **original** image bytes in **BTP Object Store**, linked to their tutorial
in the DB via the **`@cap-js/attachments`** plugin (metadata + association in
HANA, content bytes in Object Store). Serving keeps today's shape: the approuter
proxy resizes on the fly, but sources the original from CAP/Object Store instead
of GitHub. GitHub is hit only at **publish time** or on a **first-view self-heal
miss**, never per viewer.

```text
INGEST (publish-time warm, or self-heal on serve miss)
  source list (parser) ─▶ ingest(sourceUrl)
     ├─ safeFetch original from GitHub (anon-first; token on 404 for QA -Contribution)
     ├─ hash bytes; if changed → @cap-js/attachments write (Object Store) + upsert TutorialImages row
     └─ (dedup: matching hash = no-op)

SERVE
  browser ─▶ Akamai (7d cache of resized output, Vary: Accept)
     └─ approuter /img-cdn?u=&w=  ──(cold miss)──▶  sharp resize
            └─ origin = CAP GET /content/image-source?u=  (streams stored ORIGINAL)
                   └─ store miss → ingest() self-heal (fetch GitHub once, store, stream)
```

## 3. Serving Path (S2b — approuter resizes, CAP stores)

- **URL unchanged:** baked HTML keeps `/img-cdn?u=<source-url>&w=<width>`; **no
  HTML re-bake**. The approuter keeps `/img-cdn` and keeps the `sharp`
  resize/WebP transform it does today.
- **Only the origin changes:** instead of fetching the original from GitHub, the
  proxy fetches it from an internal CAP endpoint (working name
  `GET /content/image-source?u=<source-url>`) that streams the stored original
  out of Object Store via `@cap-js/attachments`.
- **Resize-on-serve is unchanged from today:** we already resize the original per
  request and let Akamai cache the output (`s-maxage=604800`, `Vary: Accept`).
  Storing originals therefore preserves the exact current behavior — same
  transform, same edge caching, same per-request CPU — while swapping a fragile
  origin (GitHub, request-time) for a durable one (Object Store).
- **Akamai** still absorbs virtually all traffic; the approuter→CAP hop occurs
  only on a genuine cold miss.
- **Auth:** `/img-cdn` runs pre-auth in the approuter today → **prod images stay
  anonymous** (preserved). **QA preview** images (private `-Contribution`
  sources) resolve the same way; additionally, the QA image path is gated behind
  the same XSUAA the `/tutorials-qa/` pages already use, so unpublished author
  screenshots are not anonymously reachable (a small tightening over today).
- **Fail-open:** if the CAP endpoint / store is unavailable, the proxy falls back
  to PR #1868's direct-GitHub fetch-with-retry. The durable path is an upgrade,
  never a new single point of failure. Gated by a per-env feature flag.
- **Heal-on-request (#1882):** the fetch-based self-heal drawn in the diagram
  above (`store miss → ingest()` inside CAP) is **dead in practice** — the
  tutorials-srv CF egress IP is anon-404'd by GitHub's raw CDN and no runtime
  token is provisioned, so the srv can never fetch the bytes itself. The heal
  therefore runs **approuter-side**: on a store-miss fail-open the approuter
  already holds the original bytes it just fetched from GitHub (its egress is not
  flagged → anon 200), and it **fire-and-forgets** them back to the srv's
  bytes-in `POST /content/image` (`CONTENT_API_KEY`, credstore) so the store
  self-populates on first view. Non-blocking (never awaited, never throws — the
  image response is already sent), deduped by a small in-memory TTL map keyed on
  the source url (one heal attempt per url per window, success or fail), and
  self-disabling when `IMG_CDN_SOURCE=github`, `IMG_CDN_HEAL=0`, or the API key
  can't be resolved. Backfill (publish-step, `scripts/backfill-images.ts`) still
  covers the bulk; this closes the gap between full backfills. Impl:
  `approuter/lib/img-cdn-heal.js`, wired in `approuter/server.js`
  `loadOriginalBytes`.

**Rejected alternative (S2a):** approuter routes `/img-cdn` to CAP and CAP does
resolve + resize + stream (moves `sharp` into `srv`). Cleaner single-owner and
removes the internal hop, but adds `sharp`'s native binary to the `srv` deploy
and is a larger change. Chose S2b for the smaller blast radius and to keep
#1868's proxy essentially intact.

## 4. Data Model & Storage

- New **non-draft** entity `TutorialImages`, keyed by the **stable source
  identity** — the `raw.githubusercontent.com` `sourceUrl` (one row per source
  path; a changed image updates that row in place rather than creating a new one):
  - `sourceUrl : String` (**key**) — the upstream raw URL
  - association to `Tutorials` (by slug) — images are DB-linked to their tutorial
  - `channel : String` — `prod` | `qa` (for GC/reporting)
  - `contentHash : String` — sha of the stored original (dedup + invalidation)
  - `mimeType : String`
  - `content : Composition of one Attachments` — original bytes in Object Store
- **What we store:** the **original** image only, **not** the resized variants.
  `@cap-js/attachments` models one file per row, and originals keep the
  `w=480/960/1440` + WebP variants flexible (resize-on-serve). Storing every
  variant would multiply rows/storage for no durability gain.
- **Object Store binding:** `cds.requires.attachments.kind: "standard"`
  (auto-detect the bound hyperscaler) or explicit `s3`. Storage defaults to HANA
  when no store is bound; we bind Object Store so bytes live there, not in HANA.

## 5. Ingestion

One shared `ingest(sourceUrl)` routine, two triggers:

1. **Publish-time warm (primary):** during `rebuild-content` /
   `publish-content.ts`, the per-tutorial image list (from the parser, which
   already produces the `/img-cdn?u=` rewrites) is passed to `ingest()`. Fetch
   original → hash → upsert row + store bytes **only if hash changed**. Store is
   warm ahead of traffic; re-publishes are cheap no-ops for unchanged images.
2. **Self-heal write-through (safety net + migration):** on a serve miss, the CAP
   endpoint runs the same `ingest()` once, stores, then streams. Covers new
   tutorials / partial publishes and **auto-migrates the existing catalog** as
   pages are viewed. Concurrent misses for the same image **coalesce**
   (single-flight, per PR #1868): a burst = one GitHub fetch + one store write.

**Source & token logic (handles prod AND QA in one path):** reuse #1868's
**anonymous-first → token-on-404**. Prod public-repo images fetch anonymously; a
QA `-Contribution` private repo 404s anonymously and is retried with the
credstore token (`TUTORIALS_GITHUB_TOKEN`). The shared-IP rate-limit that caused
the original incident is largely moot here — ingestion hits GitHub **once per
image**, not once per viewer.

**Safety & integrity:** all ingestion fetches go through `safeFetch` (host
allowlist + private-IP block, unchanged). Dedup/invalidation is by content hash.

**Open item:** confirm the parser cleanly exposes the per-tutorial image list to
the publish payload; else scan published HTML for `/img-cdn?u=` URLs. (Parser
hook preferred.)

## 6. Lifecycle: Migration, Invalidation, GC

- **Migration:** self-heal migrates lazily as pages are viewed; additionally run
  a **one-time bulk-warm job** at rollout (iterate every published tutorial's
  image list through `ingest()`) so not-yet-viewed images are covered before the
  next GitHub incident.
- **Invalidation:** the `sourceUrl` row is updated in place — a changed source
  screenshot yields a new `contentHash`, so `ingest()` replaces the stored object
  and updates the row. No manual cache-bust, no orphaned row for the same path.
- **GC:** a periodic (or at-publish) sweep removes `TutorialImages` rows + their
  Object Store objects for sources no longer referenced by any published tutorial
  (orphans — e.g. an image deleted from source) — mirroring the existing
  `purge-orphans` concept. Deleting the row cascades the object delete via the
  attachments composition. (Same-path image *changes* are handled in place by
  §6 invalidation, not GC.)

## 7. Spikes To Close Before/During Implementation

- **A — programmatic content write:** confirm the `@cap-js/attachments`
  server-side write path from a buffer/stream (no Fiori UI upload): create an
  `Attachments` row and store content programmatically. Ingestion depends on it.
- **B — anonymous read / serving fit:** confirm the S2b internal-endpoint
  approach (approuter fronts CAP) cleanly serves prod images to anonymous users;
  validate the plugin's media serving vs. a thin custom stream handler.
- **C — Object Store provisioning:** entitlement/quota + service binding in the
  shared subaccount; Node "single-tenant" caveat; production maturity of the Node
  Object Store `kind`.
- **D — volume sizing:** measure total original-image bytes across the catalog
  (originals only) to confirm Object Store cost.

## 8. Testing

- **Unit:** `ingest()` dedup/hash behavior; reuse #1868's anon-first/token tests.
- **Hybrid:** real HANA + Object Store binding — round-trip an image through
  `ingest()` and the serve endpoint.
- **Smoke (the actual outage scenario):** **block GitHub egress** and assert
  images still serve from the store; assert fail-open path when the store is
  disabled.
- **e2e:** a tutorial page renders its images with GitHub unreachable.

## 9. Rollout

1. Land PR #1868 first (immediate mitigation).
2. Build this on **DEV**; add Object Store service + `srv` binding to
   `mta.yaml`/mtaext; re-walk the `srv-qa` `cp` list if `srv/lib` gains modules
   (repo rule).
3. **Bulk-warm** the DEV store; verify serving with **GitHub egress blocked**.
4. Promote to **QA**, then **PROD** (feature-flag the store path per env;
   fail-open to #1868 behavior).

## 10. Component Boundaries (for the implementation plan)

- `TutorialImages` CDS entity + `@cap-js/attachments` composition (model).
- `ingest(sourceUrl)` module — fetch (safeFetch, anon-first/token), hash, store,
  dedup. Pure-ish, unit-testable (inject fetch/store like #1868's `img-cdn-fetch`).
- CAP `GET /content/image-source` handler — resolve → stream original → self-heal
  on miss.
- Approuter `/img-cdn` change — swap GitHub origin for the CAP endpoint; keep
  resize; fail-open to #1868 behavior behind a flag.
- Publish-pipeline hook — feed per-tutorial image list to `ingest()`.
- Bulk-warm job + GC job.
