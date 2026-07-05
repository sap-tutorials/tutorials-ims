---
title: Homepage adjusts and shifts based upon user learning configuration
issue: https://github.com/sap-tutorials/tutorials-ims/issues/763
status: draft
---

# Homepage personalization from user learning configuration

## 1. Problem

Today `developers.sap.com/` (the homepage delivered by issue #639) ships the same static Hugo page to every visitor. Signed-in users already tell us three things about themselves via `/me/` → **Learning preferences** — `deployment` (cloud/onprem), `role` (developer/architect/sysadmin/student), `cloud` (btp/aws/azure/gcp/…). Those signals drive tutorial branching today; they do not touch the homepage.

Issue #763 asks that the homepage **adjust and shift** based on that learning configuration — verb spine reorders, tutorial teaser re-ranks, verb sub-pages surface the right shelf entries first, and a new "For you" row appears with tutorials/missions/videos matched to the user's profile.

## 2. Non-goals

- No new user-preferences model. `UserLearningPreferences` is the single source of truth.
- No approuter hot-path SSR of `/`. Static Hugo + client hydration only.
- No pre-baked per-persona static variants (combinatorial, stale, unmanageable).
- No AI relevance scoring, no click-through learner, no referrer/geo inference for anon users, no cross-language personalization. All deferred behind explicit follow-ups.
- No personalization for anonymous visitors. Signed-out users see the current default homepage unchanged. SEO / crawler behaviour is unchanged; canonical URL is always `/`.

## 3. Scope (v1-maximal)

All of P1–P9 as agreed in the brainstorm:

| Piece | Surface |
|---|---|
| P1 | Verb-spine reorder (Row 2 tiles) |
| P2 | Row-5 tutorial teaser re-ranking |
| P3 | New "For you" row (Row 2b, between verb spine and events band) |
| P4 | Verb sub-page shelf reordering (`/learn/`, `/build/`, `/integrate/`, `/operate/`, `/ai/`, `/connect/`) |
| P5 | Admin `personaTags` / `personaWeight` / `personaHidden` on `HomepageShelves` and new `HomepageForYouCandidates` |
| P6 | "Personalized · Adjust · See default" badge |
| P7 | Live cross-tab re-render via `BroadcastChannel` (with `storage` event fallback) |
| P8 | Row 6 community-lane RSS soft filter by persona tags |
| P9 | Row 4 video-band soft filter by persona tags |

## 4. Architecture

Static Hugo shell + Vue-island hydration for the personalizable slots only. Everything else is unchanged.

```text
┌─────────────────────────────────────────────────────────────────────┐
│ Static Hugo pages (unchanged shell)                                 │
│   /, /learn/, /build/, /integrate/, /operate/, /ai/, /connect/     │
│                                                                     │
│   Personalizable slots marked with data-personalize="..." skeleton: │
│     · Row-2 verb spine          (data-personalize="verb-order")    │
│     · Row-2b "For you" row      (data-personalize="for-you")       │
│     · Row-4 video band          (data-personalize="video-filter")  │
│     · Row-5 tutorial teaser     (data-personalize="teaser-rerank") │
│     · Row-6 community lane      (data-personalize="rss-filter")    │
│     · Verb sub-page shelves     (data-personalize="shelf-rerank")  │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ Vue island: homepage-personalizer
                              │  · reads auth cookie → skips if anon
                              │  · reads sessionStorage cache first
                              │  · else GET /api/homepage/personalized
                              │  · listens on BroadcastChannel
                              │  · listens on ?default=1 (session bypass)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ CAP endpoint (new)                                                  │
│   GET /api/homepage/personalized                                    │
│     · @requires 'authenticated-user'                               │
│     · reads UserLearningPreferences for req.user.id                │
│     · returns { hash, verbOrder[], forYou[], teaserOrder[],        │
│                 shelfOverrides{}, videoFilterTags[], rssFilterTags[] }│
│     · Cache-Control: private, no-store                             │
└─────────────────────────────────────────────────────────────────────┘
                              │
              Two-layer personalization
                              ▼
┌────────────────────────────────────┬────────────────────────────────┐
│ Layer 1 — Static persona→verb map  │ Layer 2 — Admin persona tags    │
│                                    │                                 │
│ srv/lib/homepage/persona-map.js    │ HomepageShelves.personaTags     │
│  · role × deployment lookup        │  HomepageShelves.personaWeight  │
│  · deterministic, unit-testable    │  HomepageShelves.personaHidden  │
│                                    │ HomepageForYouCandidates.*      │
│                                    │  · admin-editable via existing  │
│                                    │    /admin-ui/#homepage          │
└────────────────────────────────────┴────────────────────────────────┘
```

## 5. Data model

### 5.1 Extensions to `HomepageShelves` (`db/homepage.cds`)

```cds
entity HomepageShelves : managed {
  // ... existing fields (verb, shelf, title, url, description, badge,
  //     sortOrder, linkStatus, lastChecked, explainer fields from #759)
  personaTags   : array of String(40);   // e.g. ['role:developer','cloud:aws']
  personaWeight : Integer default 0;      // -10..+10; ties broken by sortOrder
  personaHidden : array of String(40);    // hard-hide when any tag matches
}
```

Rationale: array columns on the parent entity (not a `HomepageShelfPersonas` join table) — small tag lists (≤10 per row in practice), one admin object page holds every personalization knob, minimal admin clicks per curation task.

### 5.2 New entity `HomepageForYouCandidates` (`db/homepage.cds`)

```cds
entity HomepageForYouCandidates : managed {
  key ID          : UUID;
  kind            : String(20) enum { tutorial; mission; video; blog; shelf; };
  targetSlug      : String(200);
  title           : String(255);
  description     : String(500);
  imageUrl        : String(500);
  personaTags     : array of String(40);
  personaWeight   : Integer default 0;
  personaHidden   : array of String(40);
  sortOrder       : Integer default 0;
  active          : Boolean default true;
}
```

Same tag semantics as `HomepageShelves`. Distinct entity because the "For you" row is a distinct curated surface — being featured in "For you" is orthogonal to being in the directory footer.

### 5.3 Persona-tag vocabulary

Strict `<field>:<value>` grammar drawn from `PROFILE_VOCAB` (`srv/lib/branch/profile-fields.js`):

- `role:developer | role:architect | role:sysadmin | role:student`
- `deployment:cloud | deployment:onprem`
- `cloud:btp | cloud:aws | cloud:azure | cloud:gcp | cloud:alibaba | cloud:oracle | cloud:ibm`

Save-time validator (`srv/lib/homepage/persona-tag-validator.js`) rejects unknown tags with a field-level 400. Drift guard test (`test/unit/homepage/persona-fields-sync.test.js`, mirroring the existing `profile-fields-sync.test.ts`) asserts the validator's allowlist matches `PROFILE_VOCAB`.

### 5.4 `HomepageConfig.personalizationEnabled`

Boolean kill switch on the existing `HomepageConfig` singleton. Default `false` at first migration (surprise-free deploy; admin flips it on after DEV smoke). Surfaces in the existing `HomepageConfig` object page in `/admin-ui/#homepage`. When `false`, the personalized endpoint responds 204 and the coordinator early-exits.

## 6. Endpoint contract

```
GET /api/homepage/personalized

  Auth        : @requires 'authenticated-user' (401 otherwise)
  Cache       : Cache-Control: private, no-store
  ETag        : "<hash>"  (SHA-1 of the response body, quoted)
                — client sends If-None-Match; server returns 304 on match
  Kill switch : 204 (no body) when HomepageConfig.personalizationEnabled = false
  CDN marker  : X-Personalization: 1 (approuter must never cache)

Response body (200):
{
  "hash": "a1b2c3d4",
  "profile": { "role": "developer", "deployment": "cloud", "cloud": "aws" },
  "verbOrder":     ["build","learn","integrate","ai","operate","connect"],
  "forYou":        [ { kind, slug, title, description, imageUrl }, ... ],
  "teaserOrder":   ["<tutorial-slug>", ...],
  "shelfOverrides":{
    "learn":   { "reorder": [<shelfEntryID>, ...], "hidden": [<id>, ...] },
    "build":   { ... },
    ...
  },
  "videoFilterTags": ["aws","btp"],
  "rssFilterTags":   ["btp-development","architecture"]
}
```

Server-side in-memory cache per `(userId, hash of {role, deployment, cloud, max(HomepageShelves.updatedAt), max(HomepageForYouCandidates.updatedAt)})` for 5 min. Cache invalidates when any input changes. Endpoint enforces `@requires 'authenticated-user'` — no anon path — so the anon early-exit in the coordinator is defense-in-depth, not the security boundary.

## 7. Personalization algorithm

### 7.1 Layer 1 — Static persona → verb-order map

`srv/lib/homepage/persona-map.js`:

```js
const BASE_ORDER = ['learn', 'build', 'integrate', 'operate', 'ai', 'connect'];

const ROLE_TILT = {
  developer: ['build', 'learn', 'integrate', 'ai', 'operate', 'connect'],
  architect: ['integrate', 'build', 'operate', 'learn', 'ai', 'connect'],
  sysadmin:  ['operate', 'integrate', 'build', 'connect', 'learn', 'ai'],
  student:   ['learn', 'build', 'ai', 'integrate', 'connect', 'operate'],
};
```

Not admin-editable in v1 — verb order is a strong design choice and admin fine-tuning belongs on shelves, not the spine. If we later need admin control, we surface it in `HomepageConfig`.

### 7.2 Layer 2 — Persona-weight scoring

For any shelf entry or "For you" candidate:

```
if any(tag in entry.personaHidden matches user profile):
    excluded

matched = any(tag in entry.personaTags matches user profile)
score(entry, profile) = entry.personaWeight if matched else 0
```

Ranking for shelves and Row-5 teaser: `(-score, sortOrder, title)` — stable, deterministic. Entries with no matched tag rank by `sortOrder` as they do today.

"For you" additionally requires `matched == true` to include the candidate at all — an unpersona'd candidate never appears in "For you". This distinguishes "admin tagged it, weight happens to be 0" (kept, ranked at 0) from "admin didn't persona-tag it" (dropped from For-you). Shelves and teaser still show untagged entries; only the For-you row is strict.

For verb order specifically: start from `ROLE_TILT[profile.role]` (or `BASE_ORDER` when role is null), then apply a small ±1-slot tilt toward whichever verb has the most persona-tag-matched shelf entries. Tilt is capped at 1 slot to keep behaviour understandable ("architect got Integrate first, that makes sense" beats a fully reshuffled spine).

### 7.3 Video / RSS filters (soft)

`videoFilterTags` and `rssFilterTags` are derived from the profile: `cloud=aws` → `["aws","btp"]` (always include BTP), `role=architect` → RSS gets `"architecture"`, etc. Filter modules float matches to the top; non-matches still render below. Never hide the whole band.

## 8. Client hydration

### 8.1 Island layout

```text
hugo-apps/src/homepage-personalizer/           ← NEW
├── coordinator.ts                              ← main entry, fetches once
├── verb-order.vue                              ← Row 2
├── for-you-row.vue                             ← Row 2b (new)
├── teaser-rerank.vue                           ← Row 5
├── shelf-rerank.vue                            ← verb sub-pages
├── video-filter.ts                             ← Row 4, imported by existing island
├── rss-filter.ts                               ← Row 6, imported by existing island
├── personalized-badge.vue                      ← badge strip
└── prefs-broadcast.ts                          ← BroadcastChannel + storage fallback
```

Rows 4 and 6 already have Vue islands (video-band, community-lane). They import a small filter module and call it after their existing fetch; we do not rebuild those islands.

### 8.2 Coordinator flow

```ts
async function boot() {
  if (!isSignedIn()) return;                        // anon → static page, done
  if (isDefaultViewActive()) return renderBadge();  // "See default view" bypass
                                                    // (URL ?default=1 OR sessionStorage flag)
  const cached = readSessionCache();
  const etag = cached?.hash ? `"${cached.hash}"` : undefined;
  const resp = await fetch('/api/homepage/personalized', {
    credentials: 'include',
    headers: etag ? { 'If-None-Match': etag } : {},
  });
  if (resp.status === 204) return;                  // kill switch off
  const payload = resp.status === 304 ? cached.payload : await resp.json();
  writeSessionCache(payload);
  applyToDom(payload);
  renderBadge(payload.profile);
  subscribeBroadcast(payload.hash);
}
```

- Session cache = `sessionStorage['sap-devs-homepage-personalized']`. TTL 5 min or until hash changes.
- Skeleton state is CSS-only: each `data-personalize` slot ships with a `data-skeleton` attribute rendering a neutral loading state at the final content's height — prevents CLS.
- Fetch errors (5xx, network, mid-session 401) are swallowed to `console.debug`; static content stays in place. The default homepage is a valid fallback.

### 8.3 Surface application

- **`verb-order.vue`** — reorders the six verb-tile `<li>` elements in place (DOM reorder, no re-render — preserves hover/focus).
- **`for-you-row.vue`** — Hugo ships `<section data-personalize="for-you" hidden>`; island unhides + populates when `forYou.length >= 3`. Fewer than 3 candidates = the row stays hidden (sparse row reads worse than no row).
- **`teaser-rerank.vue`** — reorders Row-5 cards. If a persona-specific slug isn't in the static top-8, fetches missing cards from `GET /api/homepage/tutorial-cards?slugs=<csv>` (new endpoint, 60s cache).
- **`shelf-rerank.vue`** — mounts only on `/learn/` etc. Reorders shelf entries within each of the 4 shelves; hides IDs listed in `shelfOverrides[verb].hidden`.
- **Video/RSS filters** — imported by the existing islands, applied after their fetch.

### 8.4 BroadcastChannel + storage fallback

```ts
const CH = new BroadcastChannel('sap-devs-prefs');
export function subscribeBroadcast(currentHash: string) {
  CH.addEventListener('message', async (ev) => {
    if (ev.data?.type !== 'preferences-changed') return;
    const resp = await fetch('/api/homepage/personalized', { credentials: 'include' });
    if (!resp.ok) return;
    const next = await resp.json();
    if (next.hash === currentHash) return;          // payload-hash guard
    writeSessionCache(next);
    applyToDom(next);
    currentHash = next.hash;
  });
}
```

`LearningPreferences.vue.onSave` posts `{ type: 'preferences-changed' }` after a successful save and also writes a timestamp to `localStorage['sap-devs-prefs-touched']` for the `storage`-event fallback on browsers without `BroadcastChannel`.

### 8.5 Session bypass (`?default=1`)

Two entry points, one persistent state:

1. Badge "See default" — link with `?default=1`. Coordinator on next load sees the URL flag, writes `sessionStorage['sap-devs-homepage-default']=1`, then early-exits.
2. Direct URL with `?default=1` — same path.

`isDefaultViewActive()` returns true if EITHER `?default=1` is in the URL OR `sessionStorage['sap-devs-homepage-default']` is set. This means once the user has clicked "See default" once, navigating away and back to `/` still shows the default view for the rest of the session — without ugly `?default=1` clinging to every URL.

Badge in bypass mode: "Viewing the default homepage · Personalize again" — clicking clears `sessionStorage['sap-devs-homepage-default']`, strips `?default=1` from the URL if present, then reloads. Closing the tab clears the flag (sessionStorage, not cookie).

### 8.6 Hugo attachment points

Existing partials get `data-personalize` attributes on the outer element; no structural changes.

```html
<!-- hugo/layouts/partials/homepage/verb-spine.html -->
<section class="verb-spine" data-personalize="verb-order" data-skeleton="verb-spine">
  <!-- existing static tiles, unchanged -->
</section>

<!-- new: hugo/layouts/partials/homepage/for-you.html -->
<section class="for-you-row" data-personalize="for-you" hidden></section>

<!-- hugo/layouts/index.html — inserts for-you.html between verb-spine and events-band -->
```

Verb sub-pages get one `data-personalize="shelf-rerank"` per shelf container in `hugo/layouts/verb/list.html`.

## 9. Badge

Small strip between hero (Row 1) and verb spine (Row 2). Only rendered when personalization is active.

```
┌────────────────────────────────────────────────────────────────────┐
│  ✨ Personalized for you · developer, AWS · Adjust · See default   │
└────────────────────────────────────────────────────────────────────┘
```

- `✨` decorative, `aria-hidden="true"`.
- Profile echo (`developer, AWS`) drops null fields. All-nulls: badge shows "Personalized for you · Adjust · See default" (no profile clause).
- **Adjust** → `<a href="/me/#learning-preferences">`.
- **See default** → `<a href="?default=1">`.
- In `?default=1` mode: "Viewing the default homepage · Personalize again".

Real `<a>` tags (not JS-only). Announced once per session via a `role=status` live region: "Homepage personalized for your role."

## 10. Admin workflow

### 10.1 Persona tags on `HomepageShelves`

New "Personalization" facet on the existing `HomepageShelves` object page in `/admin-ui/#homepage`, between "Explainer" and "Link health":

```
┌─ Personalization ────────────────────────────────────────────────┐
│ Persona tags (positive)                                          │
│ [ role:developer × ]  [ cloud:aws × ]  [ + Add tag ]             │
│                                                                  │
│ Persona weight  [ -10 ────●──── +10 ]  (0 = neutral)             │
│                                                                  │
│ Persona hidden (exclude)                                         │
│ [ role:student × ]  [ + Add tag ]                                │
└──────────────────────────────────────────────────────────────────┘
```

`<ui5-multi-combobox>` with fixed suggestions from `PROFILE_VOCAB`. Weight is a slider (prevents "let me set it to 999"). Save-time validator rejects unknown tags with a field-level 400.

### 10.2 `HomepageForYouCandidates` admin

New surface `/admin-ui/#for-you`. Standard Fiori Elements list report + object page, patterned on `HomepageShelves`.

- List columns: Title · Kind · Target · Persona tags · Weight · Active · Sort · Updated.
- Object page: all fields from §5.2 + the same Personalization facet.
- Curation runbook: `docs/authors/homepage-for-you-runbook.md` (new file). Healthy pool: 15-30 active candidates. Every candidate should carry ≥1 persona tag.

### 10.3 Link-health job extension

Extend `srv/jobs/homepage-link-health.js` to also HEAD `HomepageForYouCandidates.targetSlug`-resolved URLs and mark `linkStatus`. Broken candidates hide from the API response but stay in the admin list with a red dot (same pattern as broken shelf entries).

## 11. Observability

Two new metrics via the existing `metrics` module (`srv/lib/observability.js`):

- `homepage.personalized.requests{result}` where `result ∈ {200, 304, 401, 204-disabled, 5xx}`. Watches ETag efficiency (target > 60% 304s after warmup) and endpoint health.
- `homepage.personalized.applied{surface}` where `surface ∈ {verb-order, for-you, teaser, shelf, video-filter, rss-filter}`. Coordinator emits via `navigator.sendBeacon` on first successful hydration per session.

No PII logging. Profile hash is fine; profile values are the user's private data and never enter analytics.

## 12. Rollout

- Ships DEV-first with `HomepageConfig.personalizationEnabled = false`.
- Admin flips the flag on, watches §11 metrics.
- Promotes to STAGE, then PROD (aligned with the end-July 2026 cutover; feature is available but off by default at cutover).
- No gradual percentage rollout — audience size doesn't warrant it. Full on/off via the config flag; roll back by flipping to `false`.

## 13. Testing

| Layer | Test type | Coverage |
|---|---|---|
| `persona-map.js` | Unit | Base order, each role tilt, null-role, all-nulls |
| `persona-tag-validator.js` | Unit | Every `PROFILE_VOCAB` tag; rejects `role:manager`, `user:admin`, duplicates |
| Scoring algorithm | Unit | Weight application, `personaHidden` terminal, tie-break stability, determinism |
| `GET /api/homepage/personalized` | Integration | 401 anon, 204 kill-switch off, 200 payload for signed-in, 304 with `If-None-Match`, `Cache-Control` header, `X-Personalization` marker, hash stability |
| `persona-fields-sync.test.js` | Drift guard | Validator allowlist matches `PROFILE_VOCAB` |
| `schema-drift.test.js` | Migration guard | New fields present in generated `db/last-dev/hana-schema.sql` |
| Coordinator island | Vitest + happy-dom | Anon early-exit, `?default=1` early-exit, cache hit, cache miss + 200, cache miss + 304 uses cache, BroadcastChannel re-hydrate, hash-guard no-op, fetch-error preserves static |
| Surface islands | Vitest + happy-dom | Verb reorder preserves DOM identity, teaser fetches missing cards, For-you hides when < 3, shelf-rerank scoped to sub-page |
| `for-you-row.vue` | Vue Test Utils | 0/1/2/3/8 candidate rendering, keyboard tab order, empty-state hidden |
| Video/RSS filter modules | Unit | Empty tags = passthrough, matches float up, non-matches still render |
| Personalized badge | Vitest | Copy variants, "See default" link, "Personalize again" in bypass, hidden when kill-switch off |
| Live round-trip | Smoke | Real approuter + real CAP + fixture user: set prefs → `/` reflects, `?default=1` shows base, no prefs = base |
| CI Node 22 vs local Node 24 | Guard | `cds.entities(NS)` refs for the new entities; `x.context = x` self-reference on any `EventContext` mocks (per MEMORY.md) |

No E2E browser test for BroadcastChannel — happy-dom lacks a real implementation; coverage via hand-rolled MessageEvent in the coordinator unit. Real cross-tab behaviour lives in the manual test plan.

### 13.1 Manual test plan

`docs/authors/homepage-personalization-manual-tests.md`:

1. Anon → visit `/` → base order, no badge, no personalized fetch.
2. Signed-in, no prefs → visit `/` → base order, badge says "Personalized for you · Adjust · See default".
3. Signed-in, role=developer → Build tile leads, badge says "developer".
4. Click "See default" → static page, badge shows "Viewing the default homepage · Personalize again", session flag set, refresh preserves default view.
5. `/` in tab A, `/me/` in tab B → change prefs in B, save → tab A hydrates in-place within 2s.
6. Admin sets `personaHidden: role:student` on a shelf entry → student user doesn't see it in the sub-page footer; architect still does.
7. Kill switch off → all signed-in users see base order + no badge.
8. Slow network / offline → static content still renders; no badge; no errors above `debug`.

## 14. Risks

- **R1 — "No observable change"** for profiles close to base order. Silent is correct; the `applied` metric surfaces it at the population level. No user-facing "nothing changed" message (noisy for the majority for whom something *does* shift).
- **R2 — Contradictory admin tags** (`personaTags` and `personaHidden` overlapping). Validator rejects at save; scoring treats hide as terminal.
- **R3 — Persona-tag drift.** `PROFILE_VOCAB` is the source of truth; validator imports it directly. Drift guard test enforces.
- **R4 — CDN caching the personalized payload.** `Cache-Control: private, no-store` + `X-Personalization: 1` marker; smoke test asserts the header. Documented in the architecture doc so approuter changes don't silently drop it.
- **R5 — Session-flag pollution.** Badge in bypass mode is always visible with "Personalize again". Session storage, not cookie — tab close clears.
- **R6 — SEO / OG.** Personalization is client-only + auth-required; canonical URL is `/`. No regression. Documented explicitly.
- **R7 — Payload size.** Envelope caps: 12 teaser slugs, 8 for-you, ≤ 30 entries × 6 verbs for shelf overrides. Test asserts < 10KB.
- **R8 — Endpoint load.** In-memory cache per user + ETag 304s. Anon and kill-switch-off never hit the code path.
- **R9 — DEV-only content, end-July 2026 PROD cutover.** Feature ships DEV-first with `personalizationEnabled: false`. Admin flips it on, promotes.

## 15. Deferred / out-of-scope

- AI-generated relevance scoring.
- Referrer / geo inference for anon users.
- Learning from click-through or dwell time.
- Locale as a personalization signal (site is English-only through cutover).
- Persona-aware Joule starters (noted, not built here).

## 16. Docs written alongside the code

- `docs/developers/architecture/homepage-personalization.md` — this design condensed for the platform-engineering audience. Cross-linked from `docs/developers/architecture/homepage.md`.
- `docs/authors/homepage-for-you-runbook.md` — curator guide for `HomepageForYouCandidates`.
- Updates to `docs/developers/architecture/homepage.md` — new "Personalization" section pointing to the above.
- Update `docs/developers/reference/tutorials-ims-gotchas.md` — one line on the ETag/304 path and one on the `X-Personalization: 1` header.
