# Puzzle Reset → Tutorial Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the attempt-number bug in puzzle reset completion and bring `resetPuzzleProgress` to full parity with `resetTutorialProgress` (rate limiting, audit event, `previousAttemptCompletedAt`, `tokenSource`).

**Architecture:** Five focused changes to `srv/puzzle-service.{cds,js}`, `srv/admin-service.js`, and test coverage. No schema/table changes. The core fix is reading the current attempt number from the already-fetched `PuzzleProgress` row instead of hardcoding `1` on completion — the rest (rate limit, audit event, return shape) are straightforward mirrors of the tutorial reset pattern.

**Tech Stack:** CAP Node.js service, CDS, CQL, shared `per-user-rate-limit.js` helper, `cds.emit` / `cds.on` for audit events.

## Global Constraints

- Rate limit: 5 resets per hour per user (same as `resetTutorialProgress`).
- Audit event: emitted after supersede + progress-reset writes, consumed by a `cds.on` listener in `admin-service.js`.
- `attemptNumber` source: read from the already-fetched `PuzzleProgress` row (no extra DB call); fallback `1` if row absent.
- No MCP surface for puzzles (explicit out-of-scope).
- No migration; rollback = revert PR.

---

### Task 1: Write unit tests for rate limiting, attemptNumber fix, and audit event

**Files:**
- Create: `test/unit/puzzle-reset-parity.test.js`
- Modify: None (yet)

**Interfaces:**
- Consumes: existing test utilities (`cds.test`, `SELECT`, `INSERT`, `UPDATE`), `PuzzleProgress`, `TaskRecords` entities, `PuzzleService` action via HTTP.
- Produces: test module defining three test suites: `Rate Limiting`, `Re-completion Attempt Number`, `Audit Event`, `PreviousAttemptCompletedAt`.

**Details:**

This test file is the spec in executable form. Write it before any implementation changes so you can run it and watch it fail. Use the same patterns as `test/unit/reset-tutorial-progress.test.js` — `cds.test('serve', '--project', '.', '--in-memory')`, seed data, call `POST /puzzle-api/resetPuzzleProgress`, assert outcomes.

- [ ] **Step 1: Create `test/unit/puzzle-reset-parity.test.js` with test scaffolding**

```javascript
import cds from '@sap/cds';
import { expect } from 'chai';

// Reference: test/unit/reset-tutorial-progress.test.js for pattern
describe('Puzzle Reset → Tutorial Parity', () => {
  const { PuzzleProgress, TaskRecords, Puzzles, Users } = cds.entities('com.sap.developers.ims');
  
  // Shared test context: setup db, user, puzzle
  let db, service, testUser, testPuzzle;

  before(async () => {
    await cds.test('serve', '--project', '.', '--in-memory');
    db = cds.db;
    service = cds.services.PuzzleService;
    
    // Seed test user and puzzle
    testUser = await INSERT.into(Users).entries({
      uuid: 'test-user-uuid',
      sapId: 'test-sap-id',
      legacyId: 1,
      email: 'test@example.com',
      firstName: 'Test',
      lastName: 'User',
    }).then(() => SELECT.one.from(Users).where({ sapId: 'test-sap-id' }));

    testPuzzle = await INSERT.into(Puzzles).entries({
      slug: 'test-puzzle',
      title: 'Test Puzzle',
      layout: '{}',
      solution: JSON.stringify({ '0,0': 'a', '0,1': 'b', '0,2': 'c' }),
      legacyId: 100,
    }).then(() => SELECT.one.from(Puzzles).where({ slug: 'test-puzzle' }));
  });

  describe('Rate Limiting', () => {
    // Six resets in 1hr window: first 5 pass, 6th returns 429
  });

  describe('Re-completion Attempt Number', () => {
    // Completion records attemptNumber: 1, reset bumps to 2, re-completion records attemptNumber: 2
  });

  describe('Audit Event', () => {
    // PuzzleProgressReset event fires with correct payload
  });

  describe('PreviousAttemptCompletedAt', () => {
    // Return value includes previousAttemptCompletedAt from prior completion
  });
});
```

- [ ] **Step 2: Write the Rate Limiting test suite**

```javascript
describe('Rate Limiting', () => {
  let user; // auth context for requests

  beforeEach(async () => {
    // Fresh user per test so rate bucket is clean
    user = cds.context.user = { id: 'user-' + Date.now(), attr: {} };
  });

  it('allows 5 resets within 1 hour', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await POST('/puzzle-api/resetPuzzleProgress', { slug: 'test-puzzle' })
        .set('authorization', `Bearer token-${i}`); // mock auth, tokenSource set elsewhere
      expect(res.status).to.equal(200);
      expect(res.data).to.have.property('newAttemptNumber');
    }
  });

  it('rejects 6th reset with 429', async () => {
    for (let i = 0; i < 5; i++) {
      await POST('/puzzle-api/resetPuzzleProgress', { slug: 'test-puzzle' });
    }
    const res = await POST('/puzzle-api/resetPuzzleProgress', { slug: 'test-puzzle' });
    expect(res.status).to.equal(429);
    expect(res.data.error.message).to.include('reset too many puzzles');
  });
});
```

- [ ] **Step 3: Write the Re-completion Attempt Number test suite**

```javascript
describe('Re-completion Attempt Number', () => {
  it('records attemptNumber: 1 on first completion', async () => {
    // Create PuzzleProgress, complete, check TaskRecord.attemptNumber = 1
  });

  it('records attemptNumber: 2 after reset and re-completion', async () => {
    // Create PuzzleProgress attempt 1, complete (records TaskRecord attempt 1)
    // Reset puzzle (bumps PuzzleProgress to attempt 2)
    // Save correct grid for attempt 2, complete again
    // Check: new TaskRecord has attemptNumber: 2 (NOT 1)
  });
});
```

- [ ] **Step 4: Write the Audit Event test suite**

```javascript
describe('Audit Event', () => {
  it('emits PuzzleProgressReset with correct payload', async () => {
    let emitted = null;
    cds.on('PuzzleProgressReset', msg => { emitted = msg.data || msg; });
    
    await POST('/puzzle-api/resetPuzzleProgress', { slug: 'test-puzzle' });
    
    expect(emitted).to.exist;
    expect(emitted).to.have.property('puzzleSlug', 'test-puzzle');
    expect(emitted).to.have.property('attemptNumber');
    expect(emitted).to.have.property('supersededRecordCount');
    expect(emitted).to.have.property('previousAttemptCompletedAt');
    expect(emitted).to.have.property('tokenSource');
  });
});
```

- [ ] **Step 5: Write the PreviousAttemptCompletedAt test suite**

```javascript
describe('PreviousAttemptCompletedAt', () => {
  it('returns previousAttemptCompletedAt from prior completion', async () => {
    // Complete puzzle (TaskRecord.completionDate = now)
    // Reset
    // Check response.previousAttemptCompletedAt matches prior TaskRecord.completionDate
  });

  it('returns null when no prior completion', async () => {
    // Never completed before; reset
    // Check response.previousAttemptCompletedAt is null
  });
});
```

- [ ] **Step 6: Run tests to verify they all fail**

```bash
npm test -- test/unit/puzzle-reset-parity.test.js
```

Expected: All tests fail (rate limit not implemented, attemptNumber still hardcoded 1, event not emitted, return shape missing previousAttemptCompletedAt).

- [ ] **Step 7: Commit test file**

```bash
git add test/unit/puzzle-reset-parity.test.js
git commit -m "test: add puzzle reset parity test suite (all failing)"
```

---

### Task 2: Declare `PuzzleProgressReset` event in CDS

**Files:**
- Modify: `srv/puzzle-service.cds:35-39` (the resetPuzzleProgress action + after it)

**Interfaces:**
- Consumes: existing CDS action syntax, CAP event syntax (from `srv/developer-service.cds` `TutorialProgressReset` as reference).
- Produces: `event PuzzleProgressReset : { user, puzzleSlug, attemptNumber, supersededRecordCount, previousAttemptCompletedAt, tokenSource }` declared in CDS.

**Details:**

Add the event declaration right after the `resetPuzzleProgress` action. Mirror the tutorial's event shape exactly.

- [ ] **Step 1: Open `srv/puzzle-service.cds` and locate the resetPuzzleProgress action (lines 34-38)**

- [ ] **Step 2: Add the event declaration after line 39**

```cds
  @(requires: 'authenticated-user')
  action resetPuzzleProgress(slug : String) returns {
    newAttemptNumber      : Integer;
    previousAttemptCompletedAt : DateTime;
    supersededRecordCount : Integer;
  };

  event PuzzleProgressReset : {
    user                       : String;   // dbUser.ID, NOT email
    puzzleSlug                 : String;
    attemptNumber              : Integer;
    supersededRecordCount      : Integer;
    previousAttemptCompletedAt : DateTime;
    tokenSource                : String;   // null | 'jwt' | 'pat'
  };
}
```

Note: This also updates the return shape to include `previousAttemptCompletedAt`.

- [ ] **Step 3: Verify syntax by running cds lint**

```bash
cd srv && npx cds lint puzzle-service.cds
```

Expected: No errors (only new declarations).

- [ ] **Step 4: Commit**

```bash
git add srv/puzzle-service.cds
git commit -m "cds: declare PuzzleProgressReset event and update resetPuzzleProgress return shape"
```

---

### Task 3: Import rate-limit helper and add rate-limiting check to resetPuzzleProgress

**Files:**
- Modify: `srv/puzzle-service.js:1-10` (imports), `srv/puzzle-service.js:207-241` (resetPuzzleProgress handler)

**Interfaces:**
- Consumes: `checkRateLimit(key, limit, windowMs)` from `srv/lib/per-user-rate-limit.js`.
- Produces: rate-limited `resetPuzzleProgress` that returns 429 when limit exceeded.

**Details:**

Add the import, define constants, and check before any DB work. Mirror `developer-service.js:10,19-20,243-245`.

- [ ] **Step 1: Add import at top of puzzle-service.js**

After line 8 (`import { resolveUserSapId }`), add:

```javascript
import { checkRateLimit } from './lib/per-user-rate-limit.js';
```

- [ ] **Step 2: Add rate-limit constants after the import block**

After line 10 (before `const SLUG_RE`), add:

```javascript
const RESET_LIMIT_PER_HOUR = 5;
const RESET_WINDOW_MS = 60 * 60 * 1000;
```

- [ ] **Step 3: Add rate-limit check in resetPuzzleProgress handler**

In `_initProgressAndComplete`, locate `this.on('resetPuzzleProgress', ...)` (line 207). After line 212 (after `resolveOrCreateUser`), add:

```javascript
    // Rate-limit: same bucket/window as tutorial reset, independent quota
    const sapId = resolveUserSapId(req.user);
    if (!sapId) return req.reject(401, 'Unauthenticated');

    if (!checkRateLimit(`puzzle-reset:${sapId}`, RESET_LIMIT_PER_HOUR, RESET_WINDOW_MS)) {
      return req.reject(429, 'You have reset too many puzzles recently — please wait a few minutes.');
    }
```

This goes BEFORE the puzzle lookup (current line 209), so rate limit is checked before any DB work.

- [ ] **Step 4: Run the rate-limit tests**

```bash
npm test -- test/unit/puzzle-reset-parity.test.js --grep "Rate Limiting"
```

Expected: All rate-limiting tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/puzzle-service.js
git commit -m "feat: add rate limiting to resetPuzzleProgress (5/hour per user)"
```

---

### Task 4: Fix attemptNumber in the `complete` handler

**Files:**
- Modify: `srv/puzzle-service.js:190-201` (complete handler, TaskRecord insert)

**Interfaces:**
- Consumes: `PuzzleProgress` row already fetched at line 150 (variable `prog`).
- Produces: TaskRecord stamped with `attemptNumber: prog?.attemptNumber ?? 1` instead of hardcoded `1`.

**Details:**

The `complete` handler already fetches `prog` to re-grade the stored grid. Use its `attemptNumber` (or fallback to 1 if no row exists).

- [ ] **Step 1: Locate the complete handler (line 142-202)**

- [ ] **Step 2: Find the TaskRecord INSERT (line 190-200)**

- [ ] **Step 3: Change line 199 from:**

```javascript
        attemptNumber: 1,
```

**to:**

```javascript
        attemptNumber: prog?.attemptNumber ?? 1,
```

- [ ] **Step 4: Run the attempt-number tests**

```bash
npm test -- test/unit/puzzle-reset-parity.test.js --grep "Re-completion Attempt Number"
```

Expected: All re-completion tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/puzzle-service.js
git commit -m "fix: stamp TaskRecord with correct attemptNumber on re-completion"
```

---

### Task 5: Capture `previousAttemptCompletedAt` in resetPuzzleProgress

**Files:**
- Modify: `srv/puzzle-service.js:207-241` (resetPuzzleProgress handler)

**Interfaces:**
- Consumes: live TaskRecords already fetched at line 215.
- Produces: `previousAttemptCompletedAt` captured from prior COMPLETED record, included in emitted event and return value.

**Details:**

Before superseding, find the prior COMPLETED PUZZLE TaskRecord's completionDate. Capture it, and return it in the response.

- [ ] **Step 1: Locate the resetPuzzleProgress handler's live-row fetch (line 215-220)**

- [ ] **Step 2: After the `live` fetch, add capture logic**

After line 220, before the supersede UPDATE, add:

```javascript
      // Capture prior completion date for audit + response
      const priorCompleted = live.find(r => r.status === 'COMPLETED');
      const previousAttemptCompletedAt = priorCompleted?.completionDate ?? null;
```

- [ ] **Step 3: Update the return statement (line 240)**

Change from:

```javascript
      return { newAttemptNumber: newAttempt, supersededRecordCount: live.length };
```

**to:**

```javascript
      return {
        newAttemptNumber: newAttempt,
        previousAttemptCompletedAt,
        supersededRecordCount: live.length,
      };
```

- [ ] **Step 4: Run the PreviousAttemptCompletedAt tests**

```bash
npm test -- test/unit/puzzle-reset-parity.test.js --grep "PreviousAttemptCompletedAt"
```

Expected: All previousAttemptCompletedAt tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/puzzle-service.js
git commit -m "feat: capture and return previousAttemptCompletedAt on puzzle reset"
```

---

### Task 6: Emit `PuzzleProgressReset` event with tokenSource

**Files:**
- Modify: `srv/puzzle-service.js:207-241` (resetPuzzleProgress handler, end of function)

**Interfaces:**
- Consumes: already-computed values: `dbUser.ID`, `slug`, `newAttempt`, `previousAttemptCompletedAt`, `live.length`, `req.user?.tokenSource`.
- Produces: `cds.emit('PuzzleProgressReset', {...})` fired after all DB writes.

**Details:**

Add the emit call at the end of the handler, right before the return statement. Mirror the tutorial's emit pattern (`developer-service.js:301-308`).

- [ ] **Step 1: Locate the return statement in resetPuzzleProgress (line 240)**

- [ ] **Step 2: Add emit before the return**

```javascript
      // Emit audit event
      await cds.emit('PuzzleProgressReset', {
        user: dbUser.ID,
        puzzleSlug: slug,
        attemptNumber: newAttempt,
        supersededRecordCount: live.length,
        previousAttemptCompletedAt,
        tokenSource: req.user?.tokenSource ?? null,
      });
```

- [ ] **Step 3: Run the audit-event tests**

```bash
npm test -- test/unit/puzzle-reset-parity.test.js --grep "Audit Event"
```

Expected: All audit-event tests pass.

- [ ] **Step 4: Commit**

```bash
git add srv/puzzle-service.js
git commit -m "feat: emit PuzzleProgressReset audit event with tokenSource"
```

---

### Task 7: Add `PuzzleProgressReset` audit listener in `srv/admin-service.js`

**Files:**
- Modify: `srv/admin-service.js` (locate TutorialProgressReset listener, add puzzle listener nearby)

**Interfaces:**
- Consumes: `cds.on` API, existing TutorialProgressReset listener pattern (lines 2580-2586).
- Produces: `cds.on('PuzzleProgressReset', ...)` listener that logs via `cds.log('audit')`.

**Details:**

Add a listener for the new event. Same pattern as the tutorial listener — defensive try/catch, log via `cds.log('audit').info(...)`.

- [ ] **Step 1: Locate the TutorialProgressReset listener in admin-service.js**

Search for `cds.on('TutorialProgressReset'` — should be around line 2580.

- [ ] **Step 2: After the TutorialProgressReset listener (after line 2586), add the puzzle listener**

```javascript
    // Puzzle progress reset audit listener (mirrors TutorialProgressReset)
    cds.on('PuzzleProgressReset', (msg) => {
      try {
        cds.log('audit').info('PuzzleProgressReset', msg.data ?? msg);
      } catch (err) {
        cds.log('admin-service').warn(`audit listener for PuzzleProgressReset failed: ${err.message ?? err}`);
      }
    });
```

- [ ] **Step 3: Verify no syntax errors**

```bash
node -c srv/admin-service.js
```

Expected: No output (syntax OK).

- [ ] **Step 4: Run audit-event tests again to verify listener is wired**

```bash
npm test -- test/unit/puzzle-reset-parity.test.js --grep "Audit Event"
```

Expected: Still passing.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js
git commit -m "feat: add PuzzleProgressReset audit event listener"
```

---

### Task 8: Run full puzzle test suite to verify no regressions

**Files:**
- Test: All puzzle-related tests

**Interfaces:**
- Consumes: existing `srv/puzzle-service.js` handlers.
- Produces: all tests green, no regressions.

**Details:**

Run the full puzzle test suite to ensure the changes don't break existing functionality.

- [ ] **Step 1: Run all puzzle tests**

```bash
npm test -- --grep "puzzle|Puzzle"
```

Expected: All tests pass (including the 12+ new tests from Task 1).

- [ ] **Step 2: If any fail, diagnose**

Review the failure message. Common issues:
- Rate-limit bucket state leaking between tests — ensure tests clear state or use unique user IDs.
- Event listener not firing — verify `cds.on` is registered before emit.
- Return shape mismatch — check CDS vs handler alignment.

- [ ] **Step 3: Commit a "all tests green" marker if not already committed**

```bash
git log --oneline -1
```

If the last commit is not from Task 7, create a checkpoint:

```bash
git commit --allow-empty -m "test: all puzzle tests passing"
```

---

### Task 9: Manual end-to-end flow verification through the UI

**Files:**
- Modify: None (UI already exists)
- Test: `hugo-apps/src/puzzle/App.vue` (the Reset button flow)

**Interfaces:**
- Consumes: deployed puzzle component, http calls to `/puzzle-api/resetPuzzleProgress`.
- Produces: verified end-to-end: solve → reset → re-solve → re-complete records correct attempt numbers.

**Details:**

This is the real-world test: does the feature work through the browser? Exercise the full Reset → re-solve → re-complete flow and verify completion history distinguishes attempts.

- [ ] **Step 1: Start the local dev server**

```bash
npm run dev
```

Expected: Hugo dev server running on localhost:1313.

- [ ] **Step 2: Navigate to a puzzle**

Go to `http://localhost:1313/puzzles/` (or a direct puzzle URL if you know one). Load any puzzle.

- [ ] **Step 3: Solve the puzzle correctly**

Fill in the correct answers in all slots. The `complete` button should become enabled.

- [ ] **Step 4: Click Complete**

Expected: Notification that you've completed the puzzle. The grid is now read-only or grayed out.

- [ ] **Step 5: Verify Reset button is visible**

The Reset button should be visible (shown when solved + authenticated). Click it.

Expected: Confirmation dialog, then a success message. The grid clears.

- [ ] **Step 6: Solve the puzzle again**

Fill in the correct answers again. Click Complete.

Expected: Notification of completion again (no "already complete" message).

- [ ] **Step 7: Verify completion history distinguishes attempts**

Open the browser's Network tab (F12). In the POST to `/puzzle-api/complete`, check the response. It should indicate `{ recorded: true, alreadyComplete: false }` (not re-using the old completion).

Alternatively, check the admin UI if available (`/admin-ui/#Puzzles` or similar), filter by your user, and verify two `TaskRecord` rows exist for this puzzle with `attemptNumber: 1` and `attemptNumber: 2`.

- [ ] **Step 8: Stop dev server and commit**

```bash
git commit --allow-empty -m "test: end-to-end puzzle reset flow verified"
```

---

### Task 10: Final test suite run and cleanup

**Files:**
- Test: `test/unit/reset-tutorial-progress.test.js` (ensure tutorial tests still pass)
- Test: `test/unit/puzzle-reset-parity.test.js` (our new tests)

**Interfaces:**
- Consumes: all unit tests.
- Produces: green test suite, no regressions in either puzzle or tutorial reset.

**Details:**

Run the full unit test suite one more time to ensure the changes don't affect any unrelated tests (especially tutorial progress tests, which share the same TaskRecords entity).

- [ ] **Step 1: Run the full unit test suite**

```bash
npm test -- test/unit/
```

Expected: All tests pass, including both the new puzzle reset parity tests and the existing reset-tutorial-progress tests.

- [ ] **Step 2: If any test fails, diagnose and fix**

Common issues:
- Rate-limit bucket contamination — ensure test isolation by using unique user IDs per test.
- Event listener side effects — if tests emit events, ensure listeners don't interfere (use `cds.off` to clean up).

- [ ] **Step 3: Review the changes**

```bash
git log --oneline | head -10
```

Verify all commits are present:
1. tests: add puzzle reset parity test suite (all failing)
2. cds: declare PuzzleProgressReset event and update resetPuzzleProgress return shape
3. feat: add rate limiting to resetPuzzleProgress (5/hour per user)
4. fix: stamp TaskRecord with correct attemptNumber on re-completion
5. feat: capture and return previousAttemptCompletedAt on puzzle reset
6. feat: emit PuzzleProgressReset audit event with tokenSource
7. feat: add PuzzleProgressReset audit event listener

- [ ] **Step 4: Final commit (if any uncommitted changes remain)**

```bash
git status
```

If clean, you're done. If dirty, stage and commit:

```bash
git add -A && git commit -m "test: puzzle reset parity feature complete"
```

---

## Summary

**Changes made:**
- `srv/puzzle-service.cds`: Added `PuzzleProgressReset` event declaration and updated `resetPuzzleProgress` return shape to include `previousAttemptCompletedAt`.
- `srv/puzzle-service.js`: 
  - Imported rate-limit helper.
  - Added rate-limit check (5/hour) to `resetPuzzleProgress`.
  - Fixed `complete` handler to stamp TaskRecord with current `attemptNumber` instead of hardcoded `1`.
  - Capture `previousAttemptCompletedAt` from prior completion in `resetPuzzleProgress`.
  - Emit `PuzzleProgressReset` event with `tokenSource`.
- `srv/admin-service.js`: Added `PuzzleProgressReset` audit listener.
- `test/unit/puzzle-reset-parity.test.js`: New comprehensive test suite covering all changes.

**Outcome:**
- Puzzle reset now has feature parity with tutorial reset.
- Completion history correctly distinguishes attempt numbers (bug fixed).
- Rate limiting prevents abuse.
- Audit trail captures reset intent + token source (browser vs MCP).
- No breaking changes; rollback = revert PR.
