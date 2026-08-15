# Homepage CLS — eliminate island-band hydration reflow

**Issue:** _(to file)_
**Date:** 2026-08-15
**Status:** Scoping / design — pending review → implementation plan

## Problem

Lighthouse (desktop, DEV **and** PROD) reports the developer homepage at
**CLS ≈ 0.86** (PROD 1.03), which drags the Performance score to **~61**. CLS
> 0.1 is "poor". Tutorial and tag pages are fine (CLS 0.05–0.08, perf 81–90),
so this is homepage-specific. It is **pre-existing** (identical on PROD — not a
regression from any recent deploy) and was surfaced by the 2026-08-15 DEV
Lighthouse rerun.

## Root cause (instrumented)

The homepage `article.developer-homepage` is composed of Hugo partials
(`hugo/layouts/partials/homepage/*.html`), several of which are **Vue-island
bands** that ship a **skeleton sized for maximum content** and then fetch their
real content **client-side** on hydration. Because the real content is
**variable**, the skeleton→content swap changes each band's height and shoves
every sibling below it — the whole article shifts as a block (~0.79 of the
0.86 total).

Measured SSR-skeleton vs hydrated height per band (DEV, viewport 1280×900,
island JS blocked = SSR state, `homepage.css` present at first paint in both):

| Band (partial) | SSR skeleton | Hydrated | Δ |
|---|---|---|---|
| `events-band.html` | **495px** (6 skeleton cards / 2 rows) | **276px** (2 real events / 1 row) | **−219px** |
| `featured-topics-carousel.html` | 505px | 563px | +58px |
| `directory-footer.html` | 780px | 802px | +22px |
| hero / verb-spine / video-band / community-lane / topic-clusters | stable | stable | 0 |

The dominant driver is **events-band**: its skeleton renders 6 cards (desktop
3×2 grid) but DEV currently has only **2 events** → 1 row → the band collapses
**219px** on hydration, pulling `#hp-videos` and the entire lower page up.

Confirmed this is **not** a stale/late-CSS problem: `homepage.css` is linked in
`hugo/layouts/index.html:20-21` (fingerprinted, present at first paint), so the
skeleton is correctly styled — it is simply the wrong *size* for the actual
data. (Distinct from the 2026-08-15 `ui5-overrides.css` stale-hash incident and
the lightbox CSS-injection bug, both already fixed.)

## Why a CSS `min-height` tweak is the wrong fix

The mismatch is **data-dependent**, so no fixed reservation works for all
inputs:

- Shrinking the events skeleton to 1 row fixes DEV (2 events) but **creates** a
  grow-shift on PROD when there are 4–6 events (2 rows) → +~200px shift there.
- A fixed `min-height` on the band either wastes space (short content) or is
  overrun (tall content) → still shifts.

This is exactly why PROD is *also* 0.86 — the same class hits its bands with its
own data shape. A guessed reservation would help one environment and mildly hurt
the other. **The layout must match the data at first paint**, which means the
data has to be known server-side.

## Proposed fix: server-render band content (first paint = final layout)

Render each variable band's **real content** into the initial HTML so there is
no skeleton→content swap. Options, in preference order:

1. **Serve the homepage bands from CAP live** (preferred, aligns with the
   existing `/content/pages/*` pattern that already moved `/browse/`,
   `/concepts/`, `/topics/` off Hugo). The band HTML is rendered with current
   data at request time. **Dependency:** the homepage `/` CAP flip is currently
   *deferred* (see `CLAUDE.md` → "Homepage `/` flip is deferred"). This work
   should ride on / unblock that flip, or ship as a CAP-rendered fragment the
   static homepage includes.
2. **Bake real content at Hugo build time** from the same feeds the islands
   fetch (`/build/homepage-shelves`, events, topic clusters). Simpler, but the
   events band goes **stale between content rebuilds** (events are time-
   sensitive) — acceptable only for low-churn bands (featured-topics,
   topic-clusters), not events.
3. **Deterministic skeleton from a known count** — if a band's item count is
   available at build (e.g., via `/build/catalog`), render exactly that many
   skeleton cards so the skeleton height == hydrated height. Narrower fix; still
   needs the count server-side.

Recommendation: **(1)** for `events-band` and `community-lane` (dynamic), **(2)**
acceptable for `featured-topics-carousel` / `topic-clusters-band` (near-static),
verified per-band with the harness below.

## Affected bands + data sources

| Band | Island | Data source (client) | SSR path |
|---|---|---|---|
| events-band | `homepage-events-band` | `/api/homepage/events` | CAP fragment (opt 1) |
| featured-topics-carousel | `featured-topics-carousel` | featured-topics data | build-time (opt 2) |
| community-lane | (blog list populate) | blog feed | CAP fragment (opt 1) |
| topic-clusters-band | `topics-map`/clusters | topic clusters data | build-time (opt 2) |

## Implementation steps (high level)

1. For each dynamic band, add a CAP-rendered HTML fragment endpoint (or extend
   the homepage CAP renderer once the `/` flip lands) that emits the band's real
   markup with current data.
2. Replace the SSR skeleton in the partial with the server-rendered content;
   keep the Vue island for interactivity (chip filters, etc.) but hydrate
   **in place** without changing height.
3. For near-static bands, bake real content at Hugo build from existing feeds.
4. Keep skeletons only where content is genuinely unknown at request time, and
   size them to the **minimum** stable height (accept a small grow, never a
   large shrink).

## Verification + regression guard

- **Harness (reproducible):** the SSR-vs-hydrated probe used here — load the
  homepage twice (island JS blocked vs allowed), diff each `article.developer-
  homepage > *` child's height. Target: every band Δ ≤ ~8px.
- **CLS assertion:** a post-deploy check (Playwright + buffered `layout-shift`
  PerformanceObserver, or the Lighthouse `cumulative-layout-shift` audit from
  the existing `test:a11y:lighthouse` job) asserting homepage **CLS < 0.1**.
  Note CLS is run-to-run variable (observed 0.21–0.86); take the median of ≥3
  runs. Wire it as a **warn-only** gate initially (matches
  `test/a11y/lighthouserc.json`), promote to blocking once green.

## Risks / notes

- Homepage is currently **Hugo static** on the approuter; the `/` CAP flip is
  deferred — option 1 depends on that flip or a CAP-included fragment.
- Content staleness for baked bands (option 2) — only for low-churn bands.
- DEV vs PROD data shape differs (DEV: 2 events; PROD: more) — verify the fix on
  both, not just DEV.
- Keep the `feedback_ui5_duplicate_bundle_kills_settheme` constraint in mind if
  any band work touches UI5 loading.

## Out of scope

- Tutorial-page CLS (already resolved — was the stale `ui5-overrides.css`
  hash on the DEV approuter, cleared via `cf restart`).
- The homepage `a11y` (0.84) and uniform SEO (0.85) sub-threshold scores —
  separate follow-ups.
