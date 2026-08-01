# Puzzle Reset → Tutorial Parity — Design

**Date:** 2026-08-01
**Status:** Approved (design), pending spec review
**Related:** #1412 (original `resetPuzzleProgress`), #600 (tutorial reset origin), #1105 (`tokenSource`)

## Problem

Users can already reset a Puzzle and complete it again (`PuzzleService.resetPuzzleProgress`,
shipped for #1412). The core supersede-not-delete mechanism exists, so history is *retained* in
the sense that old `PUZZLE` `TaskRecords` are flipped to `SUPERSEDED` rather than deleted.

However, puzzle reset diverges from the tutorial reset it was modeled on, and one divergence is a
real correctness bug that defeats the product goal ("complete them again, but **keep completion
history**"):

1. **Re-completion always records `attemptNumber: 1`.** `srv/puzzle-service.js:199` hardcodes
   `attemptNumber: 1` on the completion `TaskRecord`. After a reset bumps
   `PuzzleProgress.attemptNumber` to 2, a subsequent completion still stamps the `TaskRecord` as
   attempt 1 — so two history rows both claim attempt 1 and cannot be distinguished. This is the
   bug that makes "keep completion history" untrue in practice.
2. **No rate limiting.** Tutorial reset caps at 5/hour per user; puzzle reset is uncapped.
3. **No audit event.** Tutorial reset emits `TutorialProgressReset` (with a `cds.on` listener in
   `admin-service.js`); puzzle reset emits nothing.
4. **No `tokenSource`.** Tutorial reset records `req.user?.tokenSource` so admins can tell
   browser- from MCP/PAT-driven resets.
5. **No `previousAttemptCompletedAt` in the return shape.** Tutorial reset returns it.

## Goal

Bring `resetPuzzleProgress` to parity with `resetTutorialProgress`, and fix the attempt-number bug
so completion history correctly distinguishes attempt 1, 2, 3, ….

**Out of scope (explicit):** MCP tooling for puzzles. Puzzles have no MCP surface today; adding a
lone `reset_puzzle_progress` MCP tool would be orphaned. Deferred to a separate effort.

**No schema/table change.** `PuzzleProgress.attemptNumber`, `TaskRecords.attemptNumber`, and the
`TaskRecords` status/taskType model already support everything below.

## Changes

### 1. Fix `attemptNumber` on re-completion (`srv/puzzle-service.js`, `complete` handler)

The `complete` handler already re-reads the `PuzzleProgress` row (`prog`) to re-grade the stored
grid. Reuse it: stamp the inserted `TaskRecord` with `attemptNumber: prog?.attemptNumber ?? 1`
instead of the hardcoded `1`.

- `PuzzleProgress.attemptNumber` is the source of truth for the current attempt (reset bumps it).
- Fallback `1` covers the direct-complete-without-a-saved-progress-row edge (unlikely, but keeps
  the insert well-defined).

### 2. Rate limiting (`srv/puzzle-service.js`, `resetPuzzleProgress` handler)

Reuse the shared `checkRateLimit` helper (`srv/lib/per-user-rate-limit.js`) — the same helper the
tutorial reset uses.

- Bucket key: `puzzle-reset:${sapId}` (distinct prefix → independent quota from tutorial reset).
- Limit: 5 per hour (`60 * 60 * 1000` ms) — module-level constants mirroring
  `RESET_LIMIT_PER_HOUR` / `RESET_WINDOW_MS` in `developer-service.js`.
- Checked **before any DB work**, after resolving `sapId`.
- On exceed: `req.reject(429, ...)` with a message in the same style as the tutorial handler.

Requires resolving `sapId` (via `resolveUserSapId(req.user)`) up front for the bucket key, in
addition to the existing `resolveOrCreateUser` call.

### 3. Audit event `PuzzleProgressReset`

**CDS** (`srv/puzzle-service.cds`) — declare the event mirroring `TutorialProgressReset`:

```cds
event PuzzleProgressReset : {
  user                       : String;   // dbUser.ID, NOT email
  puzzleSlug                 : String;
  attemptNumber              : Integer;
  supersededRecordCount      : Integer;
  previousAttemptCompletedAt : DateTime;
  tokenSource                : String;   // null | 'jwt' | 'pat'
};
```

**Emit** (`srv/puzzle-service.js`, `resetPuzzleProgress`) — `cds.emit('PuzzleProgressReset', {...})`
after the supersede + progress-reset writes, payload matching the declared shape.

**Listener** (`srv/admin-service.js`) — add a `cds.on('PuzzleProgressReset', ...)` next to the
existing `TutorialProgressReset` listener: same defensive try/catch, same
`cds.log('audit').info('PuzzleProgressReset', msg.data ?? msg)`. Never throws — the reset must
succeed regardless of observability outcome.

### 4. `previousAttemptCompletedAt` + `tokenSource`

**Return shape** (`srv/puzzle-service.cds`) — add `previousAttemptCompletedAt : DateTime` to the
`resetPuzzleProgress` return:

```cds
action resetPuzzleProgress(slug : String) returns {
  newAttemptNumber           : Integer;
  previousAttemptCompletedAt : DateTime;
  supersededRecordCount      : Integer;
};
```

**Handler** (`srv/puzzle-service.js`) — before superseding, capture the prior COMPLETED `PUZZLE`
`TaskRecord`'s `completionDate` from the `live` rows already fetched:

```js
const priorCompleted = live.find(r => r.status === 'COMPLETED');
const previousAttemptCompletedAt = priorCompleted?.completionDate ?? null;
```

Return it alongside `newAttemptNumber` / `supersededRecordCount`, and include it + `tokenSource`
in the emitted event. `tokenSource` = `req.user?.tokenSource ?? null` (matches tutorial handler).

## Data flow (after change)

```
User solves puzzle → complete → TaskRecord{PUZZLE, COMPLETED, attemptNumber: N}
User resets       → resetPuzzleProgress:
                      - rate-limit check (puzzle-reset:sapId, 5/hr)
                      - capture prior COMPLETED completionDate
                      - UPDATE live PUZZLE TaskRecords → SUPERSEDED   (history kept)
                      - PuzzleProgress.attemptNumber → N+1, filledGrid → '{}'
                      - emit PuzzleProgressReset (audited)
                      - return {newAttemptNumber: N+1, previousAttemptCompletedAt, supersededRecordCount}
User solves again → complete → TaskRecord{PUZZLE, COMPLETED, attemptNumber: N+1}   ← bug fix
```

History now holds one `TaskRecord` per attempt, each with a correct, distinct `attemptNumber`.

## Testing

New/extended unit tests modeled on `test/unit/reset-tutorial-progress.test.js`:

- Reset **supersedes** (does not delete) the live `PUZZLE` `TaskRecord`.
- Re-completion after reset records `attemptNumber: 2` (regression guard for the core bug).
- Rate limit: 6th reset within the window returns 429.
- `PuzzleProgressReset` event fires with the expected payload (incl. `previousAttemptCompletedAt`,
  `tokenSource`).
- `previousAttemptCompletedAt` is populated from the prior completion and `null` when there was no
  prior completion.

Manual verification through the real user-facing flow (the Reset button in the puzzle Vue island,
`hugo-apps/src/puzzle/App.vue`, shown when solved + authenticated) before calling it done — no UI
change is required, but the end-to-end reset → re-solve → re-complete path must be exercised in a
browser, not just via unit tests.

## Risk / rollback

- Behavior-additive on the write path; the only changed existing behavior is the corrected
  `attemptNumber` stamp (previously always 1). No migration.
- Rollback = revert the PR; no data cleanup required (superseded rows and attempt numbers remain
  valid under the old read paths).
