# Devtoberfest Gameboard & Community Utilities Migration — Design

**Date:** 2026-07-31
**Status:** Approved (design), pending spec review → implementation plan
**Source project:** `D:\projects\sap-community-activity-badges` (live at `https://devrel-tools-prod-scn-badges-srv.cfapps.eu10.hana.ondemand.com/`)
**Target project:** `D:\projects\tutorials-poc` (= GitHub `sap-tutorials/tutorials-ims`)

## 1. Summary

Migrate the SAP Community Activity Badges app — a standalone Express service with no
CAP, no approuter, no database — into the tutorial system's BTP architecture. The
headline feature is the **Devtoberfest gameboard**, redesigned to read **live data from
HANA** (participants + task completions) and the **Devtoberfest Planner** (activity points),
replacing the old approach of matching SAP Community (Khoros) badges against static
`badges.json`/`members.json`/`points.json` files.

The remaining community utilities (showcase badge cards, signature-builder SPA, SAP Managed
Tags browser, selfie compositor, event RSVP tooling) are ported in the **same effort**.
These are inherently SAP Community-sourced, so they continue to call Khoros — but only
through a single **community-data facade** module, giving one seam to swap or cache later.

## 2. Goals & non-goals

**Goals**
- Realtime, HANA-native Devtoberfest gameboard (no Khoros dependency for scoring).
- Scoring driven by the Planner's `Activity.points`, earned via tutorial-system task completions.
- Participants sourced from `EventRegistrations` (who joined the active event), not Khoros.
- Modernized arcade aesthetic on the target stack (SAP Horizon + Fundamental Styles).
- Independent deploy & scaling: a separate MTA / CAP instance, so gameboard changes don't
  require redeploying the whole tutorial site.
- Unified HTTP surface + authentication preserved via the single tutorial approuter and a
  shared XSUAA instance.
- All Khoros access consolidated behind one facade module.

**Non-goals**
- No new "points" model invented in the tutorial system — points come from the Planner.
- No changes to the Devtoberfest Planner project (its `DTF_ACTIVITY_V1` view + reader role
  already deliver everything needed).
- Not re-sourcing badge-card / signature / tags data from HANA — that data lives in SAP
  Community and stays there.
- No new WebSocket infrastructure — reuse the tutorial system's existing socket.

## 3. Key decisions (locked with stakeholder)

| Decision | Choice | Rationale |
|---|---|---|
| Deploy shape | Separate MTA + separate CAP instance, shared XSUAA, routed via the tutorial approuter | Independent deploy/scaling; keeps unified URL + auth; scalable growth pattern |
| Scope | All-in-one: gameboard + badge cards + signature builder + community utilities | Stakeholder wants the whole suite migrated together |
| Scoring | Σ `Activity.points` for activities whose linked tutorial the participant completed | Points are the Planner's; completions are the tutorial system's |
| Gameboard visual | Modernized arcade aesthetic on Horizon/Fundamental Styles | Keep Devtoberfest personality; shed the hand-built SVG string engine |
| Khoros utilities | Ported behind a `community-data` facade, still calling Khoros | Community data isn't in HANA; one seam to swap/cache later |
| Realtime | Reuse tutorials-srv's existing `/ws/event-stream` socket | No new socket infra, no cross-service messaging |
| Event date cutoff | Use the active event's own `startDate`/`endDate` window | Replaces the old hardcoded `2025-11-24` cutoff |

## 4. Architecture

New repo/MTA **`sap-community-gameboard`** (working name), deployed independently of the
tutorial system, fronted by the tutorial system's existing approuter.

```
                    ┌─────────────── tutorial approuter (single front door) ───────────────┐
   browser ────────▶│ /tutorials/* /admin/* /devtoberfest/*  →  tutorials-srv               │
                    │ /gameboard/* /community/* /js/gameboard.js  →  gameboard-srv (NEW)     │
                    └───────────────────────────────┬──────────────────────────────────────┘
                                                     │ binds shared tutorials-xsuaa
   tutorials MTA                                     │                         gameboard MTA (NEW)
   ┌───────────────────────────┐                    │        ┌──────────────────────────────────┐
   │ tutorials-srv             │                    └───────▶│ gameboard-srv                      │
   │  publishes GAMEBOARD_*_V1 │◀───cross-container────────  │  /gameboard (HANA-native)          │
   │ tutorials-hana            │   reads participants +      │  /community (Khoros facade)         │
   │  EventRegistrations       │   completions               │ gameboard-db (consumer only)       │
   │  TaskRecords              │                             └──────┬─────────────────────────────┘
   └───────────────────────────┘                                    │ reads DTF_ACTIVITY_V1 (points)
   planner: devtoberfest-planner-db  ◀──────cross-container─────────┘ (existing devtoberfest_reader)
```

### 4.1 Components of the new MTA

- **`gameboard-srv`** — CAP Node.js service, two `@path` surfaces:
  - `/gameboard` — HANA-native gameboard logic (`@requires: 'any'`, personalized slices
    gated `authenticated-user`).
  - `/community` — the ported Khoros utilities, all reading through the facade.
- **`gameboard-db`** — its own HDI container, used purely as a **cross-container consumer**
  (synonyms + `@cds.persistence.exists` facades). No business base tables; optional
  cache/config only.
- **No approuter of its own** — the tutorial approuter gains route blocks proxying to
  `gameboard-srv-api`.

### 4.2 Shared XSUAA

The gameboard MTA declares `tutorials-xsuaa` as an `org.cloudfoundry.existing-service`
resource and binds it. The approuter (in the tutorial MTA) is the OAuth client and performs
login; `gameboard-srv` binds the **same** instance as a resource server and validates the
JWT. Same `xsappname` → same audience → the token issued by the approuter is accepted by
`gameboard-srv` with no extra config. Scopes (`Tutorial.Author`, etc.) are shared because
they are defined on the shared xsappname.

### 4.3 Cross-container reads — two providers

1. **Planner container `devtoberfest-planner-db`** (existing-service): request the
   already-granted `devtoberfest_reader` / `devtoberfest_reader#` roles; synonym + facade
   over **`DTF_ACTIVITY_V1`** and `DTF_TRACK_V1`. **No planner-side changes.**
2. **Tutorial container `tutorials-hana`** (existing-service): the new provider work.
   `tutorials-srv` publishes two new versioned views and a reader role (§5.2). The gameboard
   container binds it, requests `gameboard_reader`, and consumes both views.

Follows the repo's documented cross-container playbook
(`docs/developers/architecture/cross-container-integration.md`): versioned `_V1` views,
UPPERCASE column aliases, least-privilege reader role, synonym + `@cds.persistence.exists`
facade, base-then-enable bootstrap ordering. Mirror every `mta.yaml` change into
`.deploy/mta.yaml` (dual-mta caveat).

### 4.4 Realtime

The gameboard island connects to tutorials-srv's **existing** `/ws/event-stream` Socket.IO
namespace (the anonymous `/ws/*` and `/socket.io/*` approuter routes already exist). On a
`tutorialCompleted` event it refetches the TTL-cached leaderboard slice. No new socket
service, no cross-service signal.

## 5. Data model & scoring

**No new business entities.** The gameboard is a read-only aggregator over three sources.
The only new persisted artifacts are HANA *views* (contracts), not tables.

### 5.1 Inputs

| Source | Container | Carries |
|---|---|---|
| `DTF_ACTIVITY_V1` (exists, granted) | planner | `POINTS`, `TUTORIALSLUG`, `TUTORIAL_ID`, `WEEK`, `TRACK_ID`, `STATUS` |
| `GAMEBOARD_PARTICIPANT_V1` (**new**) | tutorials-hana | one row per `EventRegistrations` entry for the active DEVTOBERFEST event: `USER_ID`, `DISPLAY_NAME`, `JOINED_AT`, `EVENT_ID` |
| `GAMEBOARD_COMPLETION_V1` (**new**) | tutorials-hana | one row per completed task: `USER_ID`, `TUTORIAL_SLUG` (resolved, lowercased), `COMPLETION_DATE`, `EVENT_ID` — filtered `status='COMPLETED'` |

### 5.2 New views published by `tutorials-srv`

- `GAMEBOARD_PARTICIPANT_V1` — over `EventRegistrations` joined to `Events` where
  `eventType='DEVTOBERFEST'` and the event is active.
- `GAMEBOARD_COMPLETION_V1` — over `TaskRecords` where `status='COMPLETED'`, joined within
  the tutorial container to the local `Tutorials`/slug mapping so the view exposes an
  already-resolved `TUTORIAL_SLUG`. Constrained to the active event's date window.
- New `gameboard_reader` (+ grantable `gameboard_reader#`) `.hdbrole` granting SELECT on both.
- Artifacts live in `db/src/` alongside the existing `TUTORIAL_VALUE_HELP_V1` (the reciprocal
  view the tutorial system already publishes to the planner).

### 5.3 Scoring

```
score(user) = Σ  DTF_ACTIVITY_V1.POINTS
              for each Activity A where
                A.STATUS is published/active
                AND EXISTS completion C in GAMEBOARD_COMPLETION_V1
                    where C.USER_ID = user
                      AND C.TUTORIAL_SLUG = lower(A.TUTORIALSLUG)   ← join key
              and user ∈ GAMEBOARD_PARTICIPANT_V1
```

Computed live in `gameboard-srv` (`srv/lib/scoring.js`, pure/unit-testable), TTL-cached.

**Join-key resolution (the one real modeling risk):** Activities link by `TUTORIALSLUG`;
`TaskRecords` store `taskLegacyId` + `titleSnapshot`, not a slug. `GAMEBOARD_COMPLETION_V1`
therefore resolves the slug **on the tutorials-srv side** (it owns the slug mapping) and
exposes `TUTORIAL_SLUG` already resolved, so the gameboard matches slug-to-slug and never
touches the tutorial system's internal ID scheme. Slugs are lowercase-canonical (documented
invariant); the view lowercases on both sides.

### 5.4 Derived (not stored)

- **Levels** — thresholds over summed points; config in `gameboard-srv`, tunable per
  edition. Replaces the old `points.json`.
- **Leaderboard** — ranked participants by score; `getLeaderboard(top)`, TTL-cached,
  modeled on the existing `DisplayService.getLeaderboard`.
- **Per-user breakdown** — activities earned/remaining by week/track (personal view,
  `authenticated-user`).

### 5.5 Retired from the old model

- `badges.json` (113 badge-title→points rows) → replaced by `DTF_ACTIVITY_V1`.
- `members.json` (679 KB participant list) → replaced by `GAMEBOARD_PARTICIPANT_V1`.
- The Khoros badge-title-matching loop in old `routes/devtoberfest.js` → gone entirely.
- Hardcoded `endDate = 2025-11-24` cutoff → replaced by the active event's date window.

## 6. Services, endpoints & the community-data facade

### 6.1 `/gameboard` — HANA-native (`@requires: 'any'`)

- `getLeaderboard(top)` → ranked participants (score, level, rank). Public, TTL-cached.
- `getGameboard(scnId?)` → board payload: level thresholds, per-week/track activity totals;
  if authenticated, the caller's earned/remaining breakdown + avatar/level. Personalized
  slice `@requires: 'authenticated-user'`.
- `Activities` (`@readonly`) → projection over the `DTF_ACTIVITY_V1` facade.
- Reads the three facades; computes score/level in `srv/lib/scoring.js`.

### 6.2 `/community` — Khoros behind a facade

- `srv/lib/community/khoros.js` — the **single** home for all LiQL/search calls, the
  `callUserAPI(scnId)` `{ data: {...} }` envelope, and TTL caching. Ported and consolidated
  from the old `util/khoros.js`; nothing else calls Khoros directly.
- Consuming routes (SVG/PNG via `sharp`, ported):
  - `/community/showcaseBadges/:scnId`, `/showcaseBadgesGroups`, `/showcaseSingleBadge`
  - `/community/activity/:scnId`
  - `/community/khoros/*` (boards/topics/threads/events/RSVP proxy + RSVP admin export)
  - `/community/user/:scnId` (JSON, feeds the signature-builder SPA)
  - `POST /community/upload_selfie` (multer + sharp compositor)
  - `/community/tags` (SAP Managed Tags A-Z)

### 6.3 Approuter routes (tutorial system `xs-app.json`)

Proxy `/gameboard/*` and `/community/*` to `gameboard-srv-api`. Public reads anonymous;
personalized + RSVP-admin routes carry the appropriate auth type/scope, mirroring the
existing devtoberfest `status` (anon) vs `join`/`me` (xsuaa) split. Realtime uses the
existing `/ws/*` + `/socket.io/*` routes — no change. Mirror into `.deploy` if applicable.

### 6.4 Error handling

Cross-container reads and Khoros calls **fail soft**: a planner-view hiccup or Khoros
timeout degrades to cached/last-known data or an empty-but-valid board, never a 500.
Matches the repo's fail-open convention.

## 7. UI

### 7.1 Gameboard — Hugo page + Vue island

Reuses the existing `/devtoberfest` island pattern (mount node with `data-api-*` attrs,
`hugo-apps/vite.config.ts` entry, served by the static catch-all — no approuter/MTA change
for the frontend itself).

- `hugo/content/devtoberfest/gameboard/_index.md` + `hugo/layouts/.../gameboard.html`.
- `hugo-apps/src/gameboard/` → builds to `hugo/static/js/gameboard.js`.

**Modernized arcade aesthetic:** layout/containers/typography on SAP Horizon + Fundamental
Styles (on-brand, accessible, responsive). The arcade personality lives in a contained
"cabinet" region: pixel font for headings, CRT-frame border, level/avatar art, subtle
scanline/glow via CSS (reusing the `cta-glow` precedent), respecting
`prefers-reduced-motion`, audio muted by default. Avatar/level art carried over as static
assets; positioning driven by live score→level, not sprite-string math. Leaderboard +
progress render as real accessible components (semantic tables/cards), not baked into an
image. Realtime: subscribe to `/ws/event-stream`, refetch affected slice on
`tutorialCompleted`. Use the `dataviz` skill for leaderboard/progress visuals.

### 7.2 Signature-builder SPA — standalone `app/` Vue app

Ported as a client-routed SPA (not a page island) served at `/community-profile-ui/`,
mirroring the old `/profile/` app. Reads `/community/user/:scnId`.

### 7.3 Image-based cards stay images

Showcase badge cards + activity cards remain SVG/PNG (their purpose is embedding in READMEs
and forum signatures).

## 8. Testing

- **Unit** — `srv/lib/scoring.js` pure functions (score sum, level thresholds, slug-match,
  event-window cutoff) with in-memory fixtures. Khoros facade tested against recorded
  fixtures (no live calls in CI).
- **Cross-container (hybrid)** — assert the two new `_V1` views resolve and the facades read
  (guards UPPERCASE-alias + slug-resolution contract). Runs via `cds bind --exec`.
- **Boot/deploy guards** — smoke test that `gameboard-srv` boots with the shared-XSUAA
  binding and both cross-container synonyms resolve; verify the new views deploy from
  `tutorials-srv` before the gameboard consumes them.
- **E2e** — committed Playwright spec (per the repo's e2e-coverage convention) against the
  deployed gameboard page: board renders, leaderboard populates, personalized view after
  auth.
- **Verification-before-done** — exercise the real gameboard page in a browser against real
  data before calling it done.

## 9. Rollout / bootstrap ordering

Base-then-enable, because of the new cross-container leg:

1. `tutorials-srv` deploys `GAMEBOARD_*_V1` views + `gameboard_reader` role **first**.
2. Gameboard MTA deploys, binds shared XSUAA + both provider containers, requests roles,
   resolves synonyms.
3. Approuter route blocks added.

## 10. Open questions / risks

- **Slug resolution fidelity** — `GAMEBOARD_COMPLETION_V1` must resolve `taskLegacyId` →
  slug correctly for all Devtoberfest task types (TUTORIAL, and whether MISSION/GROUP/STEP
  activities exist in a given edition). Validate against real DEV data during implementation.
- **Display name / privacy** — `GAMEBOARD_PARTICIPANT_V1.DISPLAY_NAME` must respect the
  tutorial system's data-privacy rules for a public leaderboard (opt-in vs anonymized rank).
  Confirm the privacy posture before exposing names publicly.
- **New-repo bootstrap** — a brand-new MTA/repo needs XSUAA existing-service naming, CI, and
  deploy wiring set up; scope this as part of the implementation plan.
- **QA channel** — decide whether the gameboard participates in the tutorial system's QA
  channel or is DEV/PROD only.
