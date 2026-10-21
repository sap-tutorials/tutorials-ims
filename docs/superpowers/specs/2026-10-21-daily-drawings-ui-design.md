# Daily Drawings UI — Design

**Issue:** [sap-tutorials/tutorials-ims#2865](https://github.com/sap-tutorials/tutorials-ims/issues/2865)
**Date:** 2026-10-21
**Status:** Awaiting approval

## Intent & Why

At in-person events (Devtoberfest, TechEd, etc.) the team runs **daily prize drawings**. Today there is no dedicated tool to do this — the operator has to pull data by hand. This adds a purpose-built, projector-friendly screen that an event host drives live on stage: pick the event, hit a button, and a randomly-chosen winner's name and email appear big enough to read from the room.

The winning experience is theatrical: the host presses **Draw**, there's a brief suspense beat, and the winner is revealed with the event mascot (Kasimir, in his tuxedo) presenting the prize. It should feel like a game-show reveal, not an admin report.

## Who's in the drawing pool (decided)

A person is eligible if they were **scanned as claiming a prize for the selected event** — i.e. they have a `PrizeRecords` row with `status = 'CLAIMED'` and `event_ID = <event>`. A CLAIMED prize record can only exist for someone who completed an activity at the event (the scanner flow requires it), so this single condition already satisfies the issue's "had a completion AND was scanned claiming a prize." We do **not** separately re-check `TaskRecords`.

Pool = **distinct `user_ID`** across CLAIMED `PrizeRecords` for the event. (A user capped at 2 claims still counts once — we draw people, not claims.)

## Behaviour (decided)

- **Event selection:** operator picks the event from a dropdown. The list comes from events that have ≥1 CLAIMED prize claim (see "Dropdown = events that have a pool" below), keyed by `legacyId`. Default selection: most recent such event by `startDate`.
- **Draw:** one button draws **one** winner, chosen uniformly at random from the current pool.
- **Re-draw:** each draw is independent over the **full pool** — a previously-drawn person can be drawn again. (Operator's choice; no exclusion bookkeeping.)
- **Display:** winner's **name** (displayName, else firstName+lastName) and **email** shown large. If email is missing (common — it backfills lazily on login), show name only and a muted "no email on file" note; still a valid winner.
- **Empty pool:** if nobody has a CLAIMED claim for the event, the Draw button is disabled and the screen says "No prize claims scanned yet for this event."

## How it's made (my calls unless marked decided)

- **UI: standalone display app (decided).** A new Vue 3 + Vite app under `app/display-app-drawings/` (mirrors `app/display-app/`). **My call: a new sibling app rather than a second route inside the existing `app/display-app/`** — the existing display-app is a continuously-updating event-monitor dashboard with its own socket lifecycle; bolting a modal drawing flow onto it muddies both. A clean sibling keeps each app single-purpose and is the smaller diff to reason about. Served at `/drawings-ui/`.
- **Framework:** Vue 3 `<script setup>` + Vite, matching `app/display-app/` conventions (confetti composable reused via copy or shared import). `qrcode.vue` not needed.
- **Backend endpoint (my call — corrected after builder-check):** a new **CAP service** (`srv/drawing-service.cds` + `.js`) at `@path:'/drawings'` with a `@requires` scope annotation, **not** raw Express routes. This matters: the sibling `/display` route is a CAP service (`srv/display-service.cds`: `@requires:'DisplayApp'`) and CAP enforces the scope **server-side**; the `/api/*` Express routes in `srv/server.js` have **no** server-side scope check and rely entirely on the approuter. For a PII-returning endpoint the server itself must refuse an un-scoped caller, so CAP-service-with-`@requires` is the correct shape (approuter-only gating is not acceptable here). Functions, not OData entities — this is operational RPC:
  - `function listEvents() returns many { legacyId; name; startDate }` — dropdown source (see event-filtering decision below).
  - `function pool(eventId: Integer) returns { eventId; eligibleCount }` — count only, no PII; UI shows pool size / enables Draw.
  - `function draw(eventId: Integer) returns { winner { displayName; email }; eligibleCount }` — **randomness and PII resolution happen server-side**; the browser only ever receives the one chosen winner, never the full roster.
  - Query shape reuses the established pattern: `SELECT.from(PrizeRecords).where({ event_ID, status:'CLAIMED' })` → distinct `user_ID` → `SELECT.from(Users).where({ ID: { in: ids } })` → map to PII (per `srv/admin-service.js:1681-1753`). Uses `cds.ql`, never raw SQL.
- **Eligibility — exclude anonymized users (my call):** the repo has a GDPR anonymization flow and account-merge reassignment of `PrizeRecords`, so a CLAIMED row can point at a tombstoned/blanked identity. The pool query filters those out (exclude users whose identity has been anonymized) so a draw never reveals a blanked "winner." `status` is treated as the single literal `'CLAIMED'` (the column is free-form `String(50)`; the scanner only ever writes `'CLAIMED'`). Migrated historical-IMS events are not a target use case; past-event draws are explicitly untested.
- **Auth (decided: `Admin`):** the page returns PII, so it's gated on the **`Admin`** scope — the scope all other PII endpoints use — baked into the CAP service's `@requires` AND the `/drawings-ui/` approuter route. See "Auth scope" below.
- **Mascot (decided):** the tuxedo-Kasimir image the user supplied is saved to `app/display-app-drawings/public/kasimir-tuxedo.png` and shown on the reveal (he "presents" the winner). Existing Kasimir art lives under `hugo/static/images/devtoberfest/`; this new pose is drawing-specific so it ships with the app.
- **Deploy wiring:** add a builder block to `.deploy/mta.yaml` (install + `vite build` + `cp` into `static/drawings-ui/`, mirroring the display-app block at `.deploy/mta.yaml:278-285`) and a `/drawings-ui/` route to `approuter/xs-app.json` with the chosen scope. The CAP service inherits approuter→`srv-api` routing like `/display` does.
- **Dropdown = events that have a pool (my call):** `listEvents()` returns only events with ≥1 CLAIMED prize claim, newest-first, and the default selection is the most recent such event. Listing every `Event` would usually default the on-stage screen to an empty pool (Draw disabled) — a bad live default. Filtering to events with claims makes the default immediately drawable.

## Goals

- Operator picks an event and draws a random winner in under 5 seconds, readable from across a room.
- Winner PII never leaves the server except the single drawn winner.
- Zero new persistent data model; reuses existing entities and query patterns.

## Non-goals

- No persistence of who won (no audit trail of draws). If we later want "don't draw the same person twice across the day" or a winners log, that's a follow-up (would need a new entity).
- No prize inventory management, no multi-winner batch draw, no exclusion of prior winners (all explicitly deferred per operator's "full pool every time").
- Not part of the admin Fiori shell.

## Anti-goals (would make this a failure even if it "works")

- Shipping the full eligible roster to the browser (PII leak / someone could skip the random draw).
- A draw that isn't actually uniform-random (e.g. always the first/last row).
- A screen too cluttered or small-texted to read on a projector.

## Constraints

- `cds.ql` only, no raw SQL. PII endpoint must be scope-gated. No secrets in source.
- Email is frequently NULL on PROD user rows — must render a winner with no email gracefully.
- Follows existing display-app build/deploy/approuter conventions exactly.

## Left to the builder

- Exact reveal animation / suspense timing and confetti trigger.
- Dropdown styling and whether to show pool size prominently.
- Whether `/drawings/events` and `/drawings/pool` are folded into one call.
- Test shape: unit-test the pool/draw query logic against in-memory SQLite (seed CLAIMED PrizeRecords + Users, assert distinct-user pool and that draw returns a pool member); the Vue reveal is visual and covered by a post-deploy smoke check if at all.

## Auth scope (decided: Admin)

The drawing service (`@requires`) and the `/drawings-ui/` approuter route are both gated on the **`Admin`** XSUAA scope — the same scope every other PII-returning endpoint in the codebase uses (all the `AdminService` export functions). The page reveals user contact details (name + email), so it is kept strictly admin-only rather than broadening `DisplayApp` to convey PII. Consequence: the on-stage operator must hold the Admin role (the same role used to reach `/admin-ui/`) to run a drawing.

## Changes from first draft (after builder-check review)

- Backend is a **CAP service with server-enforced `@requires`**, not raw Express — the original "mirror the Express routes" plan would have left a PII endpoint gated only at the approuter.
- Pool **excludes anonymized/merged-away users** so a draw can't reveal a blanked identity.
- Dropdown lists **only events with a non-empty pool**, so the on-stage default is immediately drawable.
