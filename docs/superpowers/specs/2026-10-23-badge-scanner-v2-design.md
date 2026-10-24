# Badge Scanner v2 — Design

**Date:** 2026-10-23
**Branch:** `worktree-scanner-badge-v2` (off `origin/DEV`) → PR targets **DEV**
**Status:** Awaiting approval

## DEV data ground-truth (probed 2026-10-23, read-only against DEV HANA)

Settles the builder-check's data questions with real numbers, not assumptions:

| Metric | DEV value |
|---|---|
| `PrizeRecords` total | 41,633 |
| Distinct `status` values | `CLAIMED` (14,686), `EARNED` (26,947) — only these two |
| CLAIMED rows with a populated `prize` (named) | **14,686 — i.e. ALL of them** |
| CLAIMED rows with null `prize` | **0** |
| `Prizes` catalog rows | 16 |

**Implications (these override the earlier null-prize caveats below):**
- **G4 is the common path, not an edge case.** Every CLAIMED record resolves to a
  real prize name. The "generic row for null-prize handovers" becomes a cheap
  defensive guard (the v2 `claimPrizeForContestant` null-`prize` flow has
  evidently not written rows on DEV), not a primary code path. `claimedPrizeNames`
  will populate for real.
- **`EARNED` is a real, high-volume status** (26,947 rows). `getEventStats` must
  count ONLY `CLAIMED` as "claimed." Additionally surface `EARNED` as
  **"earned, awaiting handover"** per event — it's the operationally useful
  "ready to collect" signal and nearly 2× the CLAIMED volume.
- **"Claimed vs available" is meaningful**: a 16-row catalog, event-scoped
  CLAIMED slice. Label honestly (handovers recorded vs catalog size); do not
  imply the two are a strict fraction.

## Builder-check resolutions (my calls, folded in)

1. **Badge `eventId` is a legacyId**, resolved via `Events.legacyId == eventId`
   (the existing handler already does this). **Fail-soft:** if `eventId` is
   absent/`0`/unresolvable, the contestant card still renders; the event-stats
   panel is simply hidden (no error). Builder implements the hidden-panel path.
2. **Statuses are `CLAIMED` / `EARNED` only** (probed). `getEventStats` counts
   CLAIMED for "claimed"; adds an `earnedAwaitingHandover` count. No other
   statuses to worry about.
3. **`claimedPrizeNames` resolves real names** (probed: 100% of CLAIMED have a
   prize). Null-`prize` handling stays as a guard, not a main path.
4. **Vue test = a light unit test** of (a) `nextTick`-before-`scan` ordering and
   (b) null→`0 of 2` coercion — NOT a full component-mount harness (none exists
   under `hugo-apps/` today; standing one up is out of scope for this change).

## Intent & Why

The Badge Scanner is the operator-facing tool used at an event prize table.
An operator scans a contestant's badge QR to (1) confirm they are looking at
the right person, (2) see that person's progress and which prizes they have
already claimed, (3) record a capped prize handover, and (4) glance at how the
event is going overall. Today the tool is not usable: the Vue version's camera
never opens, and even via the manual path the contestant card shows
`null of 2` prizes claimed with blank completion counts. It also does not show
*which* prizes were claimed, nor any event-level picture.

This redesign makes the tool do the operator's real job at the table.

## Goals

- **G1 — Camera works** in the Vue "Badge Scanner" (`/scanner-vue/`).
- **G2 — Real prize count**: contestant card shows an accurate `N of 2`, never
  `null`.
- **G3 — Identity line** for eyeball verification against the physical badge:
  `LastName, F.` (last name in full, first name as a single initial). **No
  email, ever** — nothing more than last name + first initial crosses the wire.
- **G4 — Claimed prize names**: list the names of prizes this contestant has
  already claimed (claimed-only; not the full catalog).
- **G5 — Event stats panel** under the contestant card, refreshed once per
  scan (no polling, no toggle), scoped to the event tied to the scanned badge:
  - **Prize totals** — total CLAIMED prize records across all contestants vs.
    total prizes available for the event.
  - **Participation** — number of distinct contestants with ≥1 completion for
    the event, and how many of those have claimed ≥1 prize.
  - **Completion totals** — sum of tutorials / groups / missions completed
    across the event's participants.

## Non-Goals

- **Not** touching the UI5 scanner (`app/scanner/`, `/scanner-ui/`). It stays
  as-is; the Vue `/scanner-vue/` "Badge Scanner" is the one being fixed. (The
  user confirmed the Vue one is the target; the UI5 one is the older
  `sap.ndc.BarcodeScanner` app.)
- **No** always-on / live-refreshing event dashboard. Stats are a per-scan
  snapshot. A standing dashboard is a separate idea if ever wanted.
- **No** full prize catalog with per-prize claimed/unclaimed flags per
  contestant — user chose "claimed prize names only."
- **No** change to the capped-handover flow (max 2 CLAIMED per user+event) or
  its atomicity guarantees.
- **No** new auth scope — stays `@requires: 'MobileApp'`.

## Anti-Goals (what makes this a failure even if it "works")

- Leaking PII onto a shared operator device — specifically, surfacing email or
  a full first name. If the identity line shows more than `LastName, F.`, that
  is a failure.
- A prize count that is ever `null`, `undefined`, or `NaN` on screen — the bug
  we are fixing must not reappear in a new field.
- Event stats that silently use the wrong event-scoping signal and so report
  numbers that don't match reality (see Constraint C2).

## Constraints

- **C1 — CAP/CQL only.** No raw SQL. Use `cds.ql`/CQL. (`claimPrizeForContestant`
  uses `forUpdate()` for the cap; that atomicity stays untouched.) Project rule.
- **C2 — Event scoping = `TaskRecords.event_ID == event.ID`.** This scanner is
  the badge / App-Space path, where `TaskRecords.event` carries the event
  association. This is distinct from Devtoberfest gameboard scoring, which
  scopes by date window `[startDate,endDate]` and deliberately ignores
  `event_ID`. **Builder must not** swap in the date-window approach here. The
  event is resolved by `Events.legacyId == eventId` (as the current handler
  already does), then its UUID used for `event_ID` filters.
- **C3 — Completion semantic matches today's.** "Has-ever-completed" DISTINCT by
  `(user_ID, taskLegacyId)`, counting `COMPLETED` + `SUPERSEDED`, as the current
  `getContestant` does. Event completion totals reuse the exact same semantic so
  the per-contestant numbers and the aggregate are consistent.
- **C4 — `@requires: 'MobileApp'`** unchanged; identity response carries only
  `lastName` + a derived `firstInitial` (single char), computed server-side so
  the full first name never leaves the server.
- **C5 — Branch/deploy hygiene.** Work on `worktree-scanner-badge-v2` off
  `origin/DEV`; PR → **DEV** (`main` is protected, no hotfix path). Never deploy
  a feature branch.

## The How (decided)

### Service — `srv/scanner-service.cds` + `srv/scanner-service.js`

**Extend `getContestant`** return shape with identity + claimed prize names:

```cds
function getContestant(accountNumber : String, eventId : Integer) returns {
  lastName           : String;   // full last name (badge match)
  firstInitial       : String;   // single char, derived server-side
  tutorialsCompleted : Integer;
  groupsCompleted    : Integer;
  missionsCompleted  : Integer;
  claimedCount       : Integer;
  claimedPrizeNames  : array of String;   // names of CLAIMED prizes (this user+event)
  prizeRecords       : String;            // kept: "N of 2 prizes claimed" (back-compat)
};
```

Handler changes:
- Select `firstName`, `lastName` off the user; return `lastName` and
  `firstInitial = (firstName || '').trim().charAt(0).toUpperCase()`.
- When resolving CLAIMED `PrizeRecords` for the (user, event), expand the
  `prize` association (or follow-up SELECT on `Prizes`) to collect
  `claimedPrizeNames` (drop nulls — new-flow handovers have a null `prize`;
  show those as a count only, not a named line — builder's call on label).

**New `getEventStats` function:**

```cds
function getEventStats(eventId : Integer) returns {
  eventName         : String;
  prizesClaimed     : Integer;   // count of CLAIMED PrizeRecords for the event
  prizesAvailable   : Integer;   // count of Prizes rows for the event
  earnedAwaitingHandover : Integer; // count of EARNED (not-yet-CLAIMED) for the event
  participants      : Integer;   // distinct users with >=1 completion for the event
  participantsClaimed : Integer; // distinct users with >=1 CLAIMED prize for the event
  tutorialsCompleted : Integer;  // sum across event participants (DISTINCT semantic)
  groupsCompleted    : Integer;
  missionsCompleted  : Integer;
};
```

Handler: resolve event by `legacyId`; `prizesAvailable` = `Prizes` count where
`event_ID`; `prizesClaimed` = CLAIMED `PrizeRecords` where `event_ID`;
`participantsClaimed` = distinct `user_ID` in those CLAIMED records;
participants + completion totals from `TaskRecords` where `event_ID` and
`status in (COMPLETED, SUPERSEDED)`, applying the C3 DISTINCT-by-
`(user_ID, taskLegacyId)` semantic before counting/summing.

### Vue — `hugo-apps/src/scanner-vue/`

- **`useBarcodeScanner.ts` / `ScannerApp.vue` (G1):** `onScan()` sets
  `state.value = 'scanning'` then `await nextTick()` **before** calling
  `scan()`, so the `<video ref="videoRef">` in the `scanning` branch is mounted
  when `scan()` reads `videoRef.value`. (Root cause: today it reads the ref in
  the same tick, before Vue renders that branch, so it throws "Video element
  not available" and tears the camera down.)
- **`types.ts`:** add `lastName`, `firstInitial`, `claimedPrizeNames: string[]`
  to `ContestantData`; add an `EventStats` interface.
- **`useScannerApi.ts`:** add `getEventStats(eventId)`; keep the `json.value ??
  json` unwrap (CAP function results wrap in `{value}`); ensure numeric fields
  coerce with `?? 0` so a missing key renders `0`, never `null` (G2 defense in
  depth).
- **`ScannerApp.vue`:** identity header → `{{ lastName }}, {{ firstInitial }}.`;
  render `claimedPrizeNames` as a small list (empty → "None yet"); add an
  event-stats section below the card populated from `getEventStats`, fetched in
  `loadContestant` alongside the contestant.

### Tests (TDD)

- Extend `test/unit/scanner-contestant-count.test.js`: asserts `claimedCount` is
  a number, `lastName`/`firstInitial` correct, `claimedPrizeNames` resolves prize
  names and omits nulls.
- New `test/unit/scanner-event-stats.test.js`: seed users/taskrecords/prizes/
  prizerecords for an event; assert each aggregate, including DISTINCT semantics
  and event scoping (a record on a *different* event must not leak in).
- Vue: a `scanner-vue` test covering `nextTick`-before-`scan` ordering and that
  a `null` claimedCount from the API renders `0 of 2`, not `null of 2`.

## Left to the builder

- Exact Fundamental-Styles markup for the identity line, claimed-prize list, and
  event-stats section (match existing `.scanner-card` styling).
- Label wording for null-`prize` new-flow handovers in the claimed list
  (count-only vs. a generic "Prize" label).
- Whether `getEventStats` is a second fetch or folded into one round-trip — a
  separate function is specified for testability; builder may combine if cheaper.
- Precise CQL for the DISTINCT aggregates (set-based vs. in-memory dedupe) as
  long as C2/C3 hold and no raw SQL is used.

## Rollout

- PR → **DEV**. Verify on the DEV approuter
  (`https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/scanner-vue/`)
  with a real badge before claiming done (Tom's #1 rule). `/scanner-ui/` and
  `/scanner-vue/` are both `MobileApp`-gated.
