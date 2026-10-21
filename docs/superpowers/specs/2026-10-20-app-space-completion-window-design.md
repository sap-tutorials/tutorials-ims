# App Space completion time window — design

**Issue:** sap-tutorials/tutorials-ims#2866
**Date:** 2026-10-20

## Intent & why

App Space is an event-attached mission shown on a public kiosk/QR page: an attendee
picks a track (a `CompletionPath` of tutorials), completes the tutorials, and unlocks a
prize collected via a scanned QR barcode. Today, completion is **time-agnostic** — a
tutorial counts as done if the attendee has *any* `COMPLETED` TaskRecord for it,
regardless of when it was completed.

That lets someone who finished a tutorial months before TechEd walk up and immediately
collect a prize without doing anything at the event. Prize credit should reflect work done
**during the event**. If an attendee completed a tutorial before the event, it must not
count; they re-complete it during the event (using the **existing** reset feature) to earn
credit.

## Goals

- App Space counts a tutorial toward track/prize completion **only if** its completion
  happened within the event's time window `[startDate, endDate]`.
- A tutorial that was completed **outside** the window shows a distinct "redo" state in the
  App Space UI, pointing the attendee at the existing reset feature.
- Out-of-window completions do **not** advance the track or unlock the prize barcode.

## Non-goals

- No new reset mechanism. Attendees use the **existing** reset feature to clear a
  completion and redo it during the event.
- No change to the authenticated `getEventProgress` path — it keeps current time-agnostic
  behavior. This change is **App Space only** (`getAppSpaceProgress`).
- No change to `createTaskRecord`, `completionDate` preservation (#600), the scanner/claim
  path, or `PrizeRecords`.
- No new entity, field, or DB migration — the data needed already exists.

## Anti-goals (would make this a failure even if it technically works)

- Breaking credit for events that have **no** time window configured (null
  `startDate`/`endDate`). Such events must behave exactly as they do today (fail-open). A
  change that silently zeroes out every un-dated event's completions is a failure.
- Gating the authenticated `getEventProgress` path or any non-App-Space completion surface.

## Current state (verified in code)

- **Handler:** `srv/developer-service.js` → `getAppSpaceProgress` (line ~642). It loads
  Event → Mission → Paths → PathItems, resolves each item's tutorial FK-first (#1866 via
  `srv/lib/path-item-task-resolver.js`), loads the caller's `TaskRecords`, and shapes each
  item. The per-item status is set at **line ~724**: `status: record?.status || ''`.
- **Event window:** `Events.startDate` / `Events.endDate` (Timestamps) exist on
  `db/schema.cds:349-350`. The handler already loads the full `event` row, so both dates
  are in scope at the shaping point — no extra query.
- **Completion timestamp:** `TaskRecords.completionDate` (Timestamp, `db/schema.cds:238`)
  is stamped by `createTaskRecord` on completion and preserved across resets/SUPERSEDED
  (#600). The user's `TaskRecords` are already loaded into `recordMap` in the handler.
- **Precedent for window comparison:** `srv/lib/cat-game-award.js:24` — "True when `now`
  falls within the event's `[startDate,endDate]`" (the Devtoberfest gameboard). Same shape
  of check; reuse its inclusive-bounds logic.
- **UI:** `hugo-apps/src/app-space/AppSpace.vue`. Track completion is computed
  **client-side** from the per-item `status` the server returns:
  - `completedCount()` (~216): counts `status === 'COMPLETED'`.
  - `isTrackComplete()` (~224): `tuts.length > 0 && tuts.every(i => i.status === 'COMPLETED')`.
  - `isItemUnlocked()` (~235): sequential gating; a PRIZE unlocks when
    `allTuts.every(COMPLETED)`.
  - `itemStatusClass()` (~253) and the step template (~505) drive per-item styling.

## The decided design

### Server — `srv/developer-service.js`, `getAppSpaceProgress` only

At the item-shaping point (line ~724), replace the straight `record?.status || ''` with a
window-aware status:

- If `record.status === 'COMPLETED'` **and** the event has a usable window **and**
  `startDate <= record.completionDate <= endDate` (inclusive both ends) → status is
  `COMPLETED`.
- If `record.status === 'COMPLETED'` but `completionDate` is **outside** that window →
  status is **`COMPLETED_OUT_OF_WINDOW`**.
- If `record.status === 'COMPLETED'` but `completionDate` is **missing/null** → treat as
  out of window → `COMPLETED_OUT_OF_WINDOW`. (Decided call: a COMPLETED record with no
  timestamp can't be proven in-window.)
- **Fail-open:** if the event has **no** usable window (either `startDate` or `endDate` is
  null/absent) → **no gating**: COMPLETED stays COMPLETED exactly as today.
- Any non-COMPLETED status passes through unchanged.

Window comparison mirrors `srv/lib/cat-game-award.js` (inclusive `[start, end]`) **for the
both-dates-present case only**. Dates are ISO Timestamp strings; compare as `Date` / epoch
ms. Apply the gate **only to `taskType === 'TUTORIAL'` items** (the only type the
track-completion logic counts); other item types (CHECKPOINT/PRIZE) are unaffected.

> **Do NOT copy `eventIsLive` verbatim.** `cat-game-award.js`'s `eventIsLive` tolerates
> *open bounds* — a null `startDate` or null `endDate` still passes on that side. Our
> fail-open rule is **stricter**: gate **only when both `startDate` and `endDate` are
> present**; if **either** is null/absent → **no gating at all**. Copying `eventIsLive`
> directly would gate half-dated events and could zero out their completions — the explicit
> anti-goal above. Reuse only its inclusive both-bounds comparison, not its null handling.

Keep the change surgical — a small helper (local to the handler or a tiny function) that
takes `(record, event)` and returns the effective status is fine; do not add a shared
module unless it reads better.

### UI — `hugo-apps/src/app-space/AppSpace.vue`

- Track/unlock logic already keys off `=== 'COMPLETED'`, so `COMPLETED_OUT_OF_WINDOW`
  **automatically** fails to advance the track or unlock the prize barcode. Verify each of
  `completedCount()`, `isTrackComplete()`, `isItemUnlocked()`, `progressPercent()` treats a
  non-`COMPLETED` status as not-done — add no new "counts as complete" path for the new
  token.
- Add a **distinct "redo" visual state** for items with `status === 'COMPLETED_OUT_OF_WINDOW'`:
  - A new branch in `itemStatusClass()` returning a dedicated class (e.g. `step--redo`),
    visually distinct from both not-started and completed.
  - A short inline hint on that item, e.g. *"Completed before the event — reset your
    progress and redo it during the event to earn your prize."* Point at the existing reset
    feature (do not build a new one).
  - Matching CSS near the existing `step--earned` / completed styling (~505, ~1063).

## What's left to the builder

- Exact helper placement/signature for the window check (inline vs tiny function).
- Precise CSS/wording for the redo state, consistent with existing App Space styles.
- Whether to add a terse code comment citing #2866 + the fail-open rule at the gate.

## Testing

- Follow TDD. Unit tests against `getAppSpaceProgress` (in-memory SQLite, `npm test`):
  1. Tutorial completed **inside** window → `COMPLETED`, track completes, prize unlocks.
  2. Tutorial completed **before** `startDate` → `COMPLETED_OUT_OF_WINDOW`, track **not**
     complete, prize **not** unlocked.
  3. Tutorial completed **after** `endDate` → `COMPLETED_OUT_OF_WINDOW`.
  4. Boundary: `completionDate === startDate` and `=== endDate` both count (inclusive).
  5. COMPLETED record with **null** completionDate → `COMPLETED_OUT_OF_WINDOW`.
  6. Event with **null** start/end → **no gating**, COMPLETED stays COMPLETED (fail-open).
  7. Non-tutorial items and in-progress records unaffected.
- A committed UI assertion for the redo state is advisory per the repo e2e-coverage nudge;
  the post-deploy `e2e` job is the real gate.

## Decided calls (for your review)

- Status token name: **`COMPLETED_OUT_OF_WINDOW`**.
- Missing `completionDate` on a COMPLETED record → out-of-window.
- Null event window → fail-open (no gating).
- Window bounds: inclusive `[startDate, endDate]`.
