# App Space Checkpoint Prize Barcode — Design

**Date:** 2026-10-20
**Author:** Claude (with Tom)
**Status:** Awaiting approval
**Repo:** tutorials-ims (`sap-tutorials/tutorials-ims`)

## Intent & Why

At in-person events (e.g. SAP TechEd Berlin), visitors work through tutorial
**tracks** on a bank of shared machines in the "App Space" (`/app-space/?eventId=N`).
When a visitor finishes a track they want their prize (a shirt or a hat). They
call over an **instructor**, who scans a **barcode on the visitor's screen** with
the scanner phone app. The scanner tells the instructor **how many prizes that
person has already claimed**, and lets the instructor **record handing one over**.

Today this does not work:

1. The App Space renders a scannable QR only for an item of `type:'PRIZE'` with
   `status:'EARNED'` — but `PRIZE` is not a valid `taskType`, the backend never
   emits `type:'PRIZE'` or `EARNED`, and nothing creates the `PrizeRecords` the
   scanner needs. So **no track ever shows a barcode**.
2. The `CHECKPOINT` item that *does* render (the trophy step at the end of a
   track) comes back blank (`imsId:null`, empty title) because the resolver looks
   a checkpoint up in the empty `Checkpoints` entity by `taskLegacyId` instead of
   reading the authored `CompletionPathItems.checkpointTitle`.

This design makes the checkpoint barcode appear when a track is complete, encode
the **visitor's stable identity**, and gives the instructor's scanner a
**claimed-count (capped at 2)** plus a **record-handover** action.

## The Real-World Flow (ground truth from Tom)

1. Visitor logs in with SAP ID at a shared machine, opens the App Space for the event.
2. Visitor completes every tutorial in a track (a track may have one or more tutorials).
3. The track's **Checkpoint** step (end of track) now shows a **barcode** encoding
   the visitor's identity.
4. Visitor calls an instructor; instructor scans the barcode with the scanner app.
5. Scanner shows the instructor **how many prizes this visitor has claimed (0, 1, or 2)**.
6. Instructor hands over a shirt or hat and taps to **record the claim** →
   count increments, **hard-capped at 2**.
7. The **cap is per-visitor, per-event, event-wide** — finishing more tracks does
   NOT grant more than 2 prizes total. We do **not** track *which* prize (shirt vs
   hat), only the count.

## Decisions (made by Tom)

- **Barcode shows per track, when that track is complete.** Each track's checkpoint
  gates independently; an incomplete track's checkpoint stays locked. The barcode
  content is the same personal identity code on every completed track.
- **Scanner increments on handover.** Scanner displays the count AND has an action to
  record a prize handover (increment, capped at 2). Full claimable flow.
- **Reuse `PrizeRecords`.** The count = this user+event's `PrizeRecords` rows with
  `status:'CLAIMED'`. A handover creates/flips a `PrizeRecords` row to `CLAIMED`,
  capped at 2. No per-prize-type tracking.
- **Barcode encodes the visitor's most-robust stable identity — the DB user UUID**
  (`Users.ID`/`uuid`), which is always present for any authenticated user regardless
  of login provider. NOT `sapId` (nullable for social/GitHub/IAS logins) and NOT the
  numeric `legacyId`. The scanner resolves that UUID to the user.
- **Barcode is generated server-side from the authenticated session.** The App Space
  page requests its QR from an **authenticated** endpoint that reads the logged-in
  user from the session — the identity is NEVER placed in a client-visible query
  string or sent to the anonymous `/api/qrcode` route. This keeps the visitor's
  identity out of cacheable/loggable anonymous URLs.
- **Cap-of-2 enforced with a DB-level atomic guard**, not a bare handler
  read-then-write — simultaneous double-scans by two instructors must not be able to
  create a 3rd CLAIMED row.

## Goals

- A completed track's checkpoint renders a scannable barcode on the App Space screen.
- The barcode encodes the logged-in visitor's stable identity (DB user UUID) + the event.
- The scanner, when it scans the barcode, resolves the visitor and shows a prize
  **count out of 2**.
- The instructor can record a handover from the scanner; the count increments and
  is hard-capped at 2 (**server-side, DB-atomic** — not just UI, not a bare
  read-then-write).
- The checkpoint title renders (fix the resolver to read `checkpointTitle`).

## Non-Goals

- No tracking of *which* prize (shirt vs hat) — count only.
- No per-track or per-checkpoint prize allocation — the cap is a flat 2 per
  visitor per event.
- No change to how tutorials/tracks/checkpoints are **authored** in the admin UI
  beyond what already exists (author a CHECKPOINT item with a `checkpointTitle` at
  the end of each track). No new `PRIZE` item type is introduced.
- Not touching the anonymous kiosk/QR landing behavior of `getAppSpaceProgress`
  beyond adding the current user's identity for barcode rendering.

## Anti-Goals (would make this a failure even if it "works")

- A visitor being able to claim a 3rd prize by finishing a 3rd track, by having the
  instructor scan twice, or by **two instructors scanning simultaneously**. The cap
  must hold at the DB level, atomically.
- The barcode appearing for a track that is **not** complete.
- The barcode encoding something that lets a MobileApp-scoped device enumerate or
  claim prizes for an arbitrary visitor. The scan must resolve a real, specific
  visitor; the claim must be for that scanned visitor only. **The visitor's identity
  must not be exposed in a cacheable/loggable anonymous URL** (hence server-side,
  session-based QR generation).
- Breaking the existing scanner for any already-deployed event that relies on the
  current `accountNumber`→`legacyId` + per-prize-title behavior.

## Constraints

- **Scanner auth:** `ScannerService` requires the XSUAA `MobileApp` scope. Unchanged.
- **App Space auth:** `getAppSpaceProgress` is `@(requires:'any')` (anonymous kiosk
  landing allowed). The barcode only has meaning for an authenticated visitor —
  render it only when `authenticated` is true and an identity is present.
- **CAP rules (CLAUDE.md):** no raw SQL — use `cds.ql`/CQL. No `req.user` without a
  `@requires`. Cap enforcement is a server-side check in the `claimPrize` handler.
- **HANA BLOB rule** is not relevant here (no BLOBs touched).
- **`sapId` nullability is not a problem** — identity is the DB user UUID (`Users.ID`),
  always present for any authenticated user, so the barcode works regardless of login
  provider. No sapId-null fallback path is needed for identity.

## The How (decided)

### 1. Fix checkpoint title resolution (bug fix, independent of the rest)
`srv/lib/path-item-task-resolver.js` + `srv/developer-service.js`
(`getAppSpaceProgress` and `getEventProgress`, item build ~`:717-731` / `:600-626`):
for a `CHECKPOINT` item, the output `title` must fall back to
`item.checkpointTitle` when no `Checkpoints` entity row resolves. A checkpoint
having null `imsId`/`recordId` is otherwise expected (checkpoints aren't TaskRecords).

### 2. App Space signals barcode availability per track
`getAppSpaceProgress` keeps returning the `authenticated` flag. It does **not** need
to place any identity in the payload (the QR is fetched from a session-authenticated
endpoint — §3). It may optionally return a boolean the client already derives from
`isItemUnlocked`; no identity fields are added to the anonymous payload.

### 3. Server-side, session-authenticated barcode generation
The visitor's identity is the **DB user UUID** (`Users.ID`). The App Space page
requests its barcode from an **authenticated** endpoint (session-based), e.g.
`GET /api/my-prize-barcode?eventId=N` served behind auth — NOT the anonymous
`/api/qrcode` route. The handler reads the logged-in user from the session,
resolves their UUID, and returns a QR PNG encoding `{ uid: <user UUID>, eventId }`.
The identity never appears in a client-supplied query string. Cache headers must be
private/no-store (identity-bearing). The old anonymous `/api/qrcode?imsId=...` path
is not used for this feature (leave it for any other caller, or retire if unused).

### 4. App Space renders the checkpoint barcode on per-track completion
`hugo-apps/src/app-space/AppSpace.vue`: when a track is complete and the item is a
`CHECKPOINT` (reuse `isItemUnlocked` checkpoint branch, `:242-245`), render the QR
`<img>` pointing at the **authenticated** barcode endpoint (§3). Retire the dead
`PRIZE`/`EARNED` rendering path (no backend ever feeds it). Show the barcode only
when `authenticated`; otherwise show a "sign in to get your prize code" hint.

### 5. Scanner resolves by user UUID and reports a count
`srv/scanner-service.js`:
- `getContestant` accepts the scanned **user UUID** (from the QR's `uid`), resolves
  `Users` by `ID`, and returns a **claimed-prize count** (`claimedCount`, 0–2)
  scoped to the scanned `eventId`, plus the existing completion counts. The
  per-prize-title enumeration is replaced by the count (Tom: don't track which prize).
- The scanner now also receives `eventId` (from the QR) so the count can be
  **event-scoped** (`PrizeRecords.user_ID = X AND event = <Events.ID> AND
  status='CLAIMED'`). Resolve `eventId`(legacyId)→`Events.ID`.
- **No backward-compat burden:** the current end-to-end flow does not work (the QR
  carries no `uid`, nothing creates the `PrizeRecords` row `claimPrize` needs), so
  there is no live "legacy legacyId/per-prize-title" behavior to preserve. Build the
  UUID + count flow cleanly; the numeric-legacyId path may be removed.

### 6. Scanner records a capped, DB-atomic handover
`srv/scanner-service.js` (new action, e.g. `claimPrizeForContestant(uid, eventId)`):
- Resolve the scanned visitor (by UUID) and the event (by legacyId).
- **Atomically** ensure the visitor has `< 2` CLAIMED `PrizeRecords` for this event
  and insert a new CLAIMED row in the same transaction, so two simultaneous scans
  cannot both succeed past the cap. Realistic form: a guarded insert / serialized
  count-check-insert in one CAP transaction (e.g. conditional insert whose effect is
  nil when the count is already 2), returning the resulting count. A plain unique
  index cannot express "max 2", so the atomic guard lives in the handler transaction
  — **builder's call** on the exact CAP/HANA mechanism, but it MUST be atomic.
- If already at 2, return "cap reached (2 of 2)" without inserting.
- The handover **INSERTs** a new CLAIMED `PrizeRecords` row (nothing pre-exists to
  flip); the scanner sends no `recordId`. Set `PrizeRecords.user` + `event`; `prize`
  and `completionPathItem` may be left null (count-only — Tom doesn't track which prize).
- Claim is for the specific scanned visitor only (preserve the #889 ownership posture).

### 7. Scanner UI
`hugo-apps/src/scanner-vue/` (`ScannerApp.vue`, `useScannerApi.ts`, `types.ts`,
`useBarcodeScanner.ts`): parse the QR's `{uid, eventId}`; after a scan, show the
visitor's name + **"Prizes claimed: N of 2"** and a **"Record prize handover"**
button (disabled at 2). On tap, call the capped claim endpoint and refresh the count.

## Left to the Builder

- The authenticated barcode endpoint's exact path/shape and the QR JSON shape
  (`{uid, eventId}`, whether to version it).
- The exact CAP/HANA mechanism for the atomic cap-of-2 guarded insert (it MUST be
  atomic; a plain unique index cannot express "max 2").
- Whether to write a fresh checkpoint-barcode block in the Vue template and delete
  the dead PRIZE path, vs. repurposing it.
- Scanner API shape: new `claimPrizeForContestant` action vs. refitting
  `getContestant`/`claimPrize`; parameter naming. (No legacy burden — see §5.)
- Exact UI copy for: barcode-when-not-signed-in, "cap reached", the handover button.
- Whether a count-only `PrizeRecords` row leaves `prize`/`completionPathItem` null
  (acceptable — only the CLAIMED count matters) and how it resolves `event`.
- Tests: **cap-at-2 enforcement incl. a concurrent/double-scan test**, UUID
  resolution, event-scoped count, checkpoint-title fallback, barcode-only-when-complete.

## Open Risks

- **Authored data (verify after deploy):** The CX track's CHECKPOINT item renders
  blank in the live `getAppSpaceProgress` payload (`title:""`, `imsId:null`). Per the
  resolver logic this is exactly the state when the item's `taskLegacyId` is null AND
  no `Checkpoints` entity row matches — the authored label lives in
  `CompletionPathItems.checkpointTitle`, which the resolver never reads (bug §1). The
  code fix (read `checkpointTitle`) addresses the blank title directly. Whether the
  checkpoint also needs `checkpointTitle` populated in the admin UI will be confirmed
  **end-to-end after deploy on the real event** (Tom's call — direct DB verification
  was blocked, see note below).
- **Local `cds bind` could not reach the app's HDI container.** During investigation,
  every `cds bind` path resolved to a **stale, empty HDI container** (schema
  `2FEC6DAB…`), while the deployed `tutorials-srv` reads a **different** container
  (schema `AC9753…`) from the same `tutorials-hana` instance — so the event (and its
  checkpoint rows) could not be inspected directly from the workstation. This is a
  local-binding staleness issue, NOT evidence the event is missing: the deployed app
  returns event `10000015` with full CX track data. Verification of this feature must
  run against the **deployed** DEV app, not a local `cds bind`. (Rebinding the DEV
  `db` credential to the app's actual container is a separate housekeeping task.)
- **"Track = one path" confirmed** from code: the App Space renders `paths[]`, a
  track's tutorials are that path's items, and the CHECKPOINT is the terminal item;
  completion gates on `isItemUnlocked` (all prior TUTORIAL items COMPLETED).

## Builder calls settled during review (for Tom to sanity-check)

- Dropped the "don't break legacy scanner" requirement — the current flow doesn't
  work end-to-end (QR carries no `uid`; nothing creates the `PrizeRecords` row the
  old `claimPrize` needs), so there's no live behavior to preserve.
- Handover **INSERTs** a new CLAIMED `PrizeRecords` row; the scanner no longer passes
  a `recordId`.
- Count is **event-scoped** (`event = <resolved Events.ID>`), matching "per-event" cap.
