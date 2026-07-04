---
title: Homepage Personalization Architecture
description: Platform-engineering summary of issue #763 — per-user homepage reordering, the For-you row, and the signed-in content filters.
---

# Homepage Personalization Architecture

Issue #763 extends the homepage delivered by issue #639 with per-user adjustments based on the signed-in user's `UserLearningPreferences` (`role`, `deployment`, `cloud`). Signed-out users see no change. Canonical URL `/` is unchanged for SEO/crawlers.

**Spec:** [docs/superpowers/specs/2026-07-04-763-homepage-personalization-design.md](../../superpowers/specs/2026-07-04-763-homepage-personalization-design.md)
**Plan:** [docs/superpowers/plans/2026-07-04-763-homepage-personalization.md](../../superpowers/plans/2026-07-04-763-homepage-personalization.md)
**Base homepage:** [homepage.md](homepage.md)

---

## What ships in v1

| Piece | Surface |
|-------|---------|
| P1 | Verb-spine reorder (Row 2 tiles) |
| P2 | Row-5 tutorial teaser re-ranking |
| P3 | New "For you" row (between verb spine and events band) |
| P4 | Verb sub-page shelf reordering |
| P5 | Admin `personaTags` / `personaWeight` / `personaHidden` fields on `HomepageShelves`; new `HomepageForYouCandidates` entity |
| P6 | "Personalized · Adjust · See default" badge strip |
| P7 | Live cross-tab re-render via `BroadcastChannel` (with `storage`-event fallback) |
| P8 | Row-6 community-lane RSS soft filter by persona tags |
| P9 | Row-4 video-band soft filter by persona tags |

---

## Architecture overview

Static Hugo shell + Vue-island hydration for the personalizable slots. No approuter-side SSR, no pre-baked per-persona variants.

```text
GET /
  Static Hugo page
  Skeleton placeholders on data-personalize slots

  homepage-personalizer (Vue island, hugo-apps/src/homepage-personalizer/)
    ├─ coordinator.ts       ← reads auth cookie; skips if anon
    │                         checks sessionStorage cache
    │                         GET /api/homepage/personalized (If-None-Match ETag)
    │                         applies payload to DOM
    │                         subscribes to BroadcastChannel
    ├─ verb-order.vue       ← Row 2 reorder
    ├─ for-you-row.vue      ← Row 2b (hidden until ≥3 candidates)
    ├─ teaser-rerank.vue    ← Row 5 reorder
    ├─ shelf-rerank.vue     ← verb sub-pages (/learn/, /build/, ...)
    ├─ video-filter.ts      ← imported by video-band island
    ├─ rss-filter.ts        ← imported by community-lane island
    ├─ personalized-badge.vue
    └─ prefs-broadcast.ts   ← BroadcastChannel + storage fallback

GET /api/homepage/personalized
  CAP HomepageService, @requires 'authenticated-user'
  Reads UserLearningPreferences for req.user.id
  Builds envelope (buildEnvelope in srv/lib/homepage/envelope.js)
  In-memory cache per (userId, preferences hash, content hash), 5 min
  Returns JSON envelope
```

---

## Endpoint contract

```
GET /api/homepage/personalized

Auth:         @requires 'authenticated-user' — 401 for anonymous requests
Kill switch:  204 (no body) when HomepageConfig.personalizationEnabled = false
Cache-Control: private, no-store
X-Personalization: 1          ← CDN marker; approuter must never cache this combination
ETag: "<hash>"                ← SHA-1 of response body, quoted
If-None-Match: "<hash>"       ← client sends on repeat requests; server returns 304 on match
```

Response body on 200:

```json
{
  "hash": "a1b2c3d4",
  "profile": { "role": "developer", "deployment": "cloud", "cloud": "aws" },
  "verbOrder":     ["build","learn","integrate","ai","operate","connect"],
  "forYou":        [{ "kind": "tutorial", "slug": "...", "title": "...", "description": "...", "imageUrl": "..." }],
  "teaserOrder":   ["<tutorial-slug>"],
  "shelfOverrides": {
    "learn": { "reorder": ["<id>"], "hidden": ["<id>"] }
  },
  "videoFilterTags": ["aws","btp"],
  "rssFilterTags":   ["btp-development","architecture"]
}
```

Envelope caps (R7): 12 teaser slugs, 8 for-you entries, ≤30 shelf entries × 6 verbs. Integration test asserts < 10 KB.

### Invariants

Two headers are security- and cache-critical and must never be dropped:

- `Cache-Control: private, no-store` — prevents shared-cache storage of per-user data.
- `X-Personalization: 1` — CDN/approuter marker. The approuter is documented to never cache responses carrying this header. Removing it silently enables shared caching of personalized payloads.

The smoke test (`test/smoke/homepage-personalized.test.js`) asserts both on every deployed environment.

---

## Kill switch

`HomepageConfig.personalizationEnabled` (Boolean, default `false`) is the single on/off control. When `false`:

- The endpoint returns 204 (no body).
- The client coordinator exits immediately on 204 — no DOM changes, no badge.
- All signed-in users see the same default homepage as anonymous users.

Toggle location: `/admin-ui/#homepage`, Config tab. No redeploy needed. Rolling back: flip to `false`.

---

## Data model

### Extensions to `HomepageShelves`

Three new columns on the existing entity (`db/homepage.cds`):

| Column | Type | Meaning |
|--------|------|---------|
| `personaTags` | `array of String(40)` | Tags that boost this entry for matching profiles |
| `personaWeight` | `Integer` (default 0) | Boost magnitude; range −10..+10 |
| `personaHidden` | `array of String(40)` | Tags that suppress this entry entirely |

### New entity `HomepageForYouCandidates`

Curated "For you" pool. Distinct from `HomepageShelves` — being featured in "For you" is orthogonal to being in the directory footer.

Key fields: `kind` (tutorial/mission/video/blog/shelf), `targetSlug`, `title`, `description`, `imageUrl`, `personaTags`, `personaWeight`, `personaHidden`, `sortOrder`, `active`.

Admin surface: `/admin-ui/#for-you`. Curator runbook: [docs/authors/homepage-for-you-runbook.md](../../authors/homepage-for-you-runbook.md).

---

## Persona-tag vocabulary

Tags follow strict `<field>:<value>` grammar. The source of truth is `PROFILE_VOCAB` in `srv/lib/branch/profile-fields.js`.

Current vocabulary:

```
role:developer | role:architect | role:sysadmin | role:student
deployment:cloud | deployment:onprem
cloud:btp | cloud:aws | cloud:azure | cloud:gcp | cloud:alibaba | cloud:oracle | cloud:ibm
```

A save-time validator (`srv/lib/homepage/persona-tag-validator.js`) rejects unknown tags with a field-level 400. A drift-guard unit test (`test/unit/homepage/persona-fields-sync.test.js`) asserts the validator's allowlist matches `PROFILE_VOCAB`. Extending the vocabulary means updating `PROFILE_VOCAB`; the validator and test follow automatically.

---

## Personalization algorithm

### Layer 1 — Static persona → verb order map

`srv/lib/homepage/persona-map.js` maps `role` to a deterministic verb order:

```js
const BASE_ORDER = ['learn', 'build', 'integrate', 'operate', 'ai', 'connect'];

const ROLE_TILT = {
  developer: ['build', 'learn', 'integrate', 'ai', 'operate', 'connect'],
  architect: ['integrate', 'build', 'operate', 'learn', 'ai', 'connect'],
  sysadmin:  ['operate', 'integrate', 'build', 'connect', 'learn', 'ai'],
  student:   ['learn', 'build', 'ai', 'integrate', 'connect', 'operate'],
};
```

Not admin-editable in v1. A small ±1-slot tilt toward the verb with the most persona-matched shelf entries is applied on top; tilt is capped at 1 slot.

### Layer 2 — Persona-weight scoring

For shelf entries and "For you" candidates:

```
if any(tag in entry.personaHidden matches user profile):
    excluded (terminal)

matched = any(tag in entry.personaTags matches user profile)
score = entry.personaWeight if matched else 0
```

Ranking: `(-score, sortOrder, title)` — stable, deterministic.

The "For you" row additionally requires `matched == true` — an untagged candidate never appears in "For you". Shelves and teaser still show untagged entries at their default sort position.

---

## Client hydration

### Coordinator flow

```ts
async function boot() {
  if (!isSignedIn()) return;                          // anon → static page
  if (isDefaultViewActive()) return renderBadge();    // ?default=1 or sessionStorage flag
  const cached = readSessionCache();
  const etag = cached?.hash ? `"${cached.hash}"` : undefined;
  const resp = await fetch('/api/homepage/personalized', {
    credentials: 'include',
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (resp.status === 204) return;                    // kill switch off
  const payload = resp.status === 304 ? cached.payload : await resp.json();
  writeSessionCache(payload);
  applyToDom(payload);
  renderBadge(payload.profile);
  subscribeBroadcast(payload.hash);
}
```

Fetch errors (5xx, network, mid-session 401) are logged at `console.debug` only; static content remains in place.

### Session cache

`sessionStorage['sap-devs-homepage-personalized']` stores the last payload and its hash. On repeat navigations within the same tab the coordinator sends `If-None-Match` — a 304 uses the cached payload without re-parsing. Clearing `sessionStorage` forces a full fresh fetch.

### BroadcastChannel + storage fallback

`prefs-broadcast.ts` opens `BroadcastChannel('sap-devs-prefs')`. When the user saves learning preferences on `/me/`, the preferences page posts `{ type: 'preferences-changed' }` on the channel and also writes `localStorage['sap-devs-prefs-touched']` for browsers without `BroadcastChannel` support. The coordinator re-fetches and re-applies if the new hash differs from the current one.

### `?default=1` bypass

Clicking "See default" in the badge navigates to `?default=1`. The coordinator writes `sessionStorage['sap-devs-homepage-default']=1` and early-exits — the flag persists for the rest of the session without the query string staying in the URL. Clearing the sessionStorage or closing the tab resets it.

Badge in bypass mode: "Viewing the default homepage · Personalize again". Clicking "Personalize again" clears the sessionStorage flag and reloads.

---

## Observability

Two new metrics via `srv/lib/observability.js`:

- `homepage.personalized.requests{result}` — result ∈ `{200, 304, 401, 204-disabled, 5xx}`. Monitors ETag efficiency (target > 60% 304s after warmup) and endpoint health.
- `homepage.personalized.applied{surface}` — surface ∈ `{verb-order, for-you, teaser, shelf, video-filter, rss-filter}`. Emitted from the coordinator via `navigator.sendBeacon` on first successful hydration per session. No PII — profile values never enter analytics.

---

## Rollout

Ships DEV-first with `HomepageConfig.personalizationEnabled = false`. Admin flips the flag on after DEV smoke. Promotes to STAGE then PROD (aligned with end-July 2026 cutover). Full on/off via the config flag; roll back by flipping to `false`. No percentage rollout — audience size doesn't warrant it.

---

## Failure modes added by personalization

| Failure | Behaviour |
|---------|-----------|
| Endpoint 5xx or network error | Coordinator swallows to `console.debug`; static page renders unchanged. No badge. |
| Kill switch off (204) | Coordinator early-exits; signed-in users see the same page as anonymous users. |
| `UserLearningPreferences` missing | Envelope builder returns `BASE_ORDER` and an empty "For you" row. |
| `HomepageForYouCandidates` all-empty or < 3 matched | "For you" row stays `hidden`; no visible gap. |
| Broken `HomepageForYouCandidates` link (link-health job) | Candidate hidden from API response; red dot in admin `/admin-ui/#for-you`. |
