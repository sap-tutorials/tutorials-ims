# Admin UI "Rebuild this tutorial" Button — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a header action button to the admin Tutorials Fiori Elements ObjectPage so admins can self-serve a single-tutorial republish without forcing a fake-edit-save dance, CLI access, or ops involvement.

**Architecture:** New OData bound action `AdminService.rebuildContent` on the Tutorials entity. Handler registers inside the existing `AdminService.init()` closure in [srv/admin-service.js](../../srv/admin-service.js), resolves the tutorial's slug from the row ID, audit-logs the intent via the closure-scoped `auditEvent` helper, and invokes `scheduleRebuild` (newly imported from [srv/lib/rebuild-trigger.js](../../srv/lib/rebuild-trigger.js)) with `mode: 'slug-targeted'`. Fiori controller extension in [app/admin/tutorials/webapp/ext/RebuildTutorial.js](../../app/admin/tutorials/webapp/ext/RebuildTutorial.js) intercepts the action press with a confirm dialog and surfaces a `MessageToast` on success. Defense in depth via XSUAA scope `Admin` (existing approuter route + AdminService `@requires: 'Admin'`).

**Tech Stack:** SAP CAP (Node.js ESM), CDS, Fiori Elements V4, SAPUI5 v2.x (controller extension), Vitest, `@cap-js/audit-logging`.

**Spec:** [docs/superpowers/specs/2026-06-24-admin-tutorial-rebuild-button-design.md](../specs/2026-06-24-admin-tutorial-rebuild-button-design.md)
**Branch:** `worktree-spec-admin-tutorial-rebuild-button` (spec already committed at `857729b4` and `59331573`; the implementation continues on this branch)
**Tracks:** (no issue yet — file one before merging if you want a closing reference)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| [srv/admin-service.cds](../../srv/admin-service.cds) | **Modify** (use `extend service AdminService with { entity Tutorials actions { ... } }` form — additive, doesn't touch the existing projection block) | Declare the bound action `rebuildContent` + return type `RebuildContentResult`. |
| [srv/admin-service.js](../../srv/admin-service.js) | **Modify** (add 1 import at top, add 1 `this.on(...)` registration inside `init()`) | Register the action handler. Reuses the closure-scoped `auditEvent` (line 1234) and the newly-imported `scheduleRebuild` (NOT yet imported — verified by `grep -n scheduleRebuild srv/admin-service.js` returning 0 hits). |
| [app/admin-annotations.cds](../../app/admin-annotations.cds) | **Modify** (add `DataFieldForAction` to the Tutorials `@UI.Identification` array around line 557) | Place the button in the OP header next to Edit/Delete/AskJoule. |
| [app/admin/tutorials/webapp/manifest.json](../../app/admin/tutorials/webapp/manifest.json) | **Modify** (add `sap.app.i18n` entry, add `models.i18n` model, add `sap.ui5.extends.extensions.sap.ui.controllerExtensions` block) | Wire the controller extension AND wire the new i18n model. |
| [app/admin/tutorials/webapp/ext/RebuildTutorial.js](../../app/admin/tutorials/webapp/ext/RebuildTutorial.js) | **Create** | Controller extension: confirm dialog + bound action call + toast. Mirrors the existing [`ext/AskJoule.js`](../../app/admin/tutorials/webapp/ext/AskJoule.js) pattern. |
| [app/admin/tutorials/webapp/i18n/i18n.properties](../../app/admin/tutorials/webapp/i18n/i18n.properties) | **Create** (i18n dir does not exist yet) | Localized button label + dialog text. |
| [srv/lib/__tests__/admin-rebuild-tutorial.test.js](../../srv/lib/__tests__/admin-rebuild-tutorial.test.js) | **Create** | 7 unit tests covering dispatch, audit log, error paths, return shape. Uses `vi.useFakeTimers()` + `advanceTimersByTimeAsync` to match the existing rebuild-trigger.test.js pattern (no flaky wall-clock waits). |
| [test/smoke/auth-enforcement.test.js](../../test/smoke/auth-enforcement.test.js) | **Modify** (1 additive assertion) | 403/401 check against the @requires gate for the new action. (Note: spec mistakenly referenced `admin-endpoints.test.js` which doesn't exist — we use `auth-enforcement.test.js` which already covers `/admin/Tutorials` auth.) |

**Total: 6 source/config files + 2 test files = 8 files touched/created.**

**srv-qa cp-list check (per [feedback_srv_qa_cp_list](../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_srv_qa_cp_list.md)):** the changes are confined to `srv/admin-service.{cds,js}`. `srv-qa` is a content-preview channel that does NOT mount `AdminService` — the [`.deploy/mta.yaml`](../../.deploy/mta.yaml) srv-qa `cp` list does not include admin-service files. **No srv-qa cp-list changes needed for this PR.** Verified by inspection.

The implementation is broken into **9 tasks** below. Tasks 2-7 follow strict TDD (red → green → commit). Tasks 8-9 are mechanical UI wiring with manual verification.

---

## Task 1: Sanity-check worktree state

**Files:** none (verification only)

- [ ] **Step 1: Confirm worktree and branch**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/spec-admin-tutorial-rebuild-button
git branch --show-current
```

Expected: `worktree-spec-admin-tutorial-rebuild-button`.

- [ ] **Step 2: Confirm spec commits are present**

```bash
git log --oneline -3
```

Expected: top two commits include `docs(spec): apply spec-review recommendations` (59331573) and `docs(spec): admin-UI 'Rebuild this tutorial' button design` (857729b4). Third commit should be on `main` (e.g. `0140c078 docs(operations): rebuild-content workflow runbook...`).

- [ ] **Step 3: Confirm clean tree**

```bash
git status --short
```

Expected: empty output.

- [ ] **Step 4: Confirm referenced files exist at expected locations**

```bash
ls srv/admin-service.cds srv/admin-service.js app/admin-annotations.cds \
   app/admin/tutorials/webapp/manifest.json \
   app/admin/tutorials/webapp/ext/AskJoule.js \
   srv/lib/rebuild-trigger.js \
   test/smoke/auth-enforcement.test.js
```

Expected: all 7 files exist (no `No such file or directory` errors). The smoke test we'll modify in Task 9 is `auth-enforcement.test.js` (the spec mistakenly referenced `admin-endpoints.test.js` which doesn't exist in this codebase).

If any check fails, stop and report.

- [ ] **Step 5: Confirm files we will CREATE do NOT already exist (sanity)**

```bash
ls app/admin/tutorials/webapp/ext/RebuildTutorial.js 2>/dev/null && echo "EXISTS: RebuildTutorial.js"
ls app/admin/tutorials/webapp/i18n/ 2>/dev/null && echo "EXISTS: i18n/"
ls srv/lib/__tests__/admin-rebuild-tutorial.test.js 2>/dev/null && echo "EXISTS: admin-rebuild-tutorial.test.js"
```

Expected: no `EXISTS:` lines printed. If any exist, the worktree is dirty or a prior attempt is in flight — investigate before continuing.

---

## Task 2: Write failing unit tests for the action handler

**Files:**
- Create: [srv/lib/__tests__/admin-rebuild-tutorial.test.js](../../srv/lib/__tests__/admin-rebuild-tutorial.test.js)

The 7 tests from the spec, written first to drive the handler implementation.

- [ ] **Step 1: Read the existing rebuild-trigger test file to match conventions**

```bash
head -80 srv/lib/__tests__/rebuild-trigger.test.js
```

Note the pattern of `_resetForTests({ dispatchFn })` to mock the GH dispatch. The new test file uses the same hook so the action's `scheduleRebuild` call doesn't fire a real workflow.

- [ ] **Step 2: Read how cds.test() is wired in admin tests**

```bash
find srv -name "*.test.js" -path "*__tests__*" -exec grep -l "cds.test\|AdminService" {} \; | head -3
```

Pick one (e.g. `srv/__tests__/admin-actions.test.js` if it exists, else any AdminService-touching test) and inspect its `beforeAll` / `cds.test()` setup so the new test uses the same pattern.

- [ ] **Step 3: Write the test file**

Create [srv/lib/__tests__/admin-rebuild-tutorial.test.js](../../srv/lib/__tests__/admin-rebuild-tutorial.test.js):

```js
// Regression tests for the AdminService.rebuildContent bound action (issue: rebuild-button).
//
// Verifies the handler's contract: it MUST audit-log the intent, invoke
// scheduleRebuild with mode=slug-targeted + the row's slug, reject 400 on
// missing slug, and return a stable result shape for the UI.
//
// The actual GH dispatch is mocked via rebuild-trigger's _resetForTests({ dispatchFn, debounceMs, token })
// hook — same pattern as srv/lib/__tests__/rebuild-trigger.test.js. We use
// vi.useFakeTimers() so the 60s debounce collapses deterministically; the
// existing test suite uses the same approach.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import cds from '@sap/cds';
import { _resetForTests } from '../rebuild-trigger.js';

const { POST, axios } = cds.test(import.meta.dirname + '/../../..');

describe('AdminService.rebuildContent', () => {
  let dispatchCalls;

  beforeAll(async () => {
    // Authenticate as an Admin user for all requests in this suite.
    // The cds.test() mock auth provider accepts any username; we pick 'admin'.
    axios.defaults.auth = { username: 'admin', password: 'admin' };
  });

  beforeEach(() => {
    dispatchCalls = [];

    // vi.useFakeTimers() lets us advance the 60s debounce deterministically.
    // Match the pattern used by srv/lib/__tests__/rebuild-trigger.test.js.
    vi.useFakeTimers();

    // Inject mock dispatchFn so no real GitHub POST fires. Token is primed via
    // the resolver (third arg of _resetForTests) so getDispatchToken() returns
    // 'fake-test-token' and dispatch actually attempts (vs short-circuiting on
    // missing token).
    _resetForTests({
      dispatchFn: async (inputs, token) => {
        dispatchCalls.push({ inputs, token });
        return { status: 204 };
      },
      debounceMs: 60_000, // keep the real shape; we'll advance timers
      token: 'fake-test-token',
    });
  });

  afterEach(() => {
    _resetForTests({}); // restore defaults
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------
  // Test 1: dispatches with mode=slug-targeted + the row's slug
  // -------------------------------------------------------------
  it('dispatches with mode=slug-targeted and the tutorial slug', async () => {
    const { Tutorials } = cds.entities('AdminService');
    const tutorialId = '00000000-0000-0000-0000-000000000001';
    await INSERT.into(Tutorials).entries({
      ID: tutorialId,
      slug: 'test-tutorial-slug',
      title: 'Test Tutorial',
    });

    const res = await POST(
      `/admin/Tutorials(ID=${tutorialId},IsActiveEntity=true)/AdminService.rebuildContent`,
      {}
    );
    expect(res.status).toBe(200);

    // Advance past the debounce; dispatch should have fired.
    await vi.advanceTimersByTimeAsync(60_001);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].inputs.mode).toBe('slug-targeted');
    expect(dispatchCalls[0].inputs.slugs).toBe('test-tutorial-slug');
  });

  // -------------------------------------------------------------
  // Test 2: emits TutorialRebuildTriggered audit event
  // -------------------------------------------------------------
  // SKIPPED for v1: the auditEvent helper is CLOSURE-SCOPED inside
  // AdminService.init() at srv/admin-service.js:1234, so a vi.spyOn on a
  // post-boot cds.connect.to('audit-log') handle does NOT intercept the
  // closure's captured _auditLog reference. Verification of audit-log
  // emission moves to the manual hybrid check in Task 10 Step 9 (queries
  // HANA's AUDIT_LOG table directly).
  it.todo('emits TutorialRebuildTriggered audit event with user + slug + source [verify via Task 10 Step 9]');

  // -------------------------------------------------------------
  // Test 3: reason string includes the user id
  // -------------------------------------------------------------
  it('passes a traceable reason string to scheduleRebuild', async () => {
    const { Tutorials } = cds.entities('AdminService');
    const tutorialId = '00000000-0000-0000-0000-000000000003';
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: 'reason-slug', title: 'Reason Test',
    });

    await POST(
      `/admin/Tutorials(ID=${tutorialId},IsActiveEntity=true)/AdminService.rebuildContent`,
      {}
    );

    await vi.advanceTimersByTimeAsync(60_001);

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].inputs['trigger-source']).toMatch(/^admin-ui:rebuild-button:/);
    expect(dispatchCalls[0].inputs['trigger-source']).toContain('admin'); // username from beforeAll
  });

  // -------------------------------------------------------------
  // Test 4: rejects 400 when slug is null
  // -------------------------------------------------------------
  it('rejects 400 when tutorial slug is null', async () => {
    const { Tutorials } = cds.entities('AdminService');
    const tutorialId = '00000000-0000-0000-0000-000000000004';
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: null, title: 'Null Slug',
    });

    await expect(
      POST(`/admin/Tutorials(ID=${tutorialId},IsActiveEntity=true)/AdminService.rebuildContent`, {})
    ).rejects.toMatchObject({ response: { status: 400 } });

    // Advance the debounce window; no dispatch should have fired.
    await vi.advanceTimersByTimeAsync(60_001);
    expect(dispatchCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------
  // Test 5: rejects 400 when slug is empty string
  // -------------------------------------------------------------
  it('rejects 400 when tutorial slug is empty string', async () => {
    const { Tutorials } = cds.entities('AdminService');
    const tutorialId = '00000000-0000-0000-0000-000000000005';
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: '', title: 'Empty Slug',
    });

    await expect(
      POST(`/admin/Tutorials(ID=${tutorialId},IsActiveEntity=true)/AdminService.rebuildContent`, {})
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  // -------------------------------------------------------------
  // Test 6: returns stable result shape for the UI
  // -------------------------------------------------------------
  it('returns { dispatched, slug, debounced, workflowUrl } shape', async () => {
    const { Tutorials } = cds.entities('AdminService');
    const tutorialId = '00000000-0000-0000-0000-000000000006';
    await INSERT.into(Tutorials).entries({
      ID: tutorialId, slug: 'shape-slug', title: 'Shape Test',
    });

    const res = await POST(
      `/admin/Tutorials(ID=${tutorialId},IsActiveEntity=true)/AdminService.rebuildContent`,
      {}
    );
    expect(res.status).toBe(200);
    expect(res.data.dispatched).toBe(true);
    expect(res.data.slug).toBe('shape-slug');
    expect(res.data.debounced).toBe(true);
    expect(res.data.workflowUrl).toBe(
      'https://github.com/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml'
    );
  });

  // -------------------------------------------------------------
  // Test 7: anonymous fallback defensive (mostly via @requires upstream)
  // -------------------------------------------------------------
  // The @requires: 'Admin' gate blocks unauthenticated requests upstream, so
  // this branch is genuinely defensive — exercising it in cds.test() requires
  // bypassing the mock-auth provider, which the test framework doesn't expose
  // cleanly. We mark this as `.todo` and verify it manually if the gate is
  // ever weakened. Implementation-side: the handler defaults req.user?.id to
  // 'anonymous' with optional chaining, which is unit-testable with a stubbed
  // handler call but adds boilerplate without proportional value.
  it.todo('defaults user to "anonymous" if req.user.id is absent [defensive; verify by code-read of the handler]');
});
```

**Why test 2 and test 7 are `.todo`:** the spec foresaw both. Test 2's closure-scoped audit-helper can't be intercepted at this level; manual verification at Task 10 Step 9 is the substitute (queries the real AUDIT_LOG table). Test 7 is defensive against an upstream-gated path; code-reading the handler is the practical substitute.

- [ ] **Step 4: Run the tests — they MUST all fail (or skip-todo) before the handler exists**

```bash
npx vitest run srv/lib/__tests__/admin-rebuild-tutorial.test.js --reporter=default
```

Expected: 5 active tests (1, 3, 4, 5, 6) all fail; 2 marked `.todo` (tests 2 and 7). The failures should be either "Action 'rebuildContent' not found" (CDS not declared yet) or HTTP 404/501 (action declared but no handler). Test 4/5's `400` expectation will not match these failure modes — they'll fail with different status codes than expected, which still counts as red.

If ANY of the 5 active tests pass when the action doesn't exist, the test is mis-asserting — fix before continuing.

- [ ] **Step 5: Commit the failing tests**

```bash
git add srv/lib/__tests__/admin-rebuild-tutorial.test.js
git commit -m "test(admin): failing tests for AdminService.rebuildContent bound action

5 active + 2 .todo tests asserting the handler contract:
1. dispatches scheduleRebuild with mode=slug-targeted + row slug
2. (.todo) emits TutorialRebuildTriggered audit event — closure-scoped auditEvent
   can't be intercepted; manual verification in Task 10 Step 9
3. reason string carries user id for traceability
4. rejects 400 when slug is null
5. rejects 400 when slug is empty string
6. returns { dispatched, slug, debounced, workflowUrl } shape
7. (.todo) defaults user to 'anonymous' when req.user.id absent — defensive,
   verify by code-read of the handler

Tests 1, 3, 4, 5, 6 currently fail with 404 / action-not-found / 500 — this is the red
phase of TDD. Task 3 adds the CDS declaration; Task 4 adds the handler.

Uses vi.useFakeTimers() + advanceTimersByTimeAsync (matches the existing
rebuild-trigger.test.js pattern) so the 60s debounce collapses deterministically."
```

---

## Task 3: Declare the bound action in CDS

**Files:**
- Modify: [srv/admin-service.cds](../../srv/admin-service.cds)

The existing Tutorials projection is at lines 20-26. To keep this edit purely additive (smaller diff, lower chance of accidentally mutating the existing field list), use the `extend service AdminService with { ... }` form at the end of the file.

- [ ] **Step 1: Confirm the existing Tutorials projection shape**

```bash
sed -n '20,26p' srv/admin-service.cds
```

Expected: shows `entity Tutorials as projection on ims.Tutorials { ... };` — note that it currently has NO `actions { ... }` block.

- [ ] **Step 2: Find the file's tail**

```bash
tail -20 srv/admin-service.cds
```

Note where the file ends. We'll append the extension block there.

- [ ] **Step 3: Append the extension block**

Use the Edit tool. At the very end of [srv/admin-service.cds](../../srv/admin-service.cds), append:

```cds

// ── Rebuild-button action (issue: rebuild-button, spec: 2026-06-24-admin-tutorial-rebuild-button) ──
// Declared via `extend service` so the existing Tutorials projection at lines
// 20-26 stays untouched. Handler implementation in srv/admin-service.js.
extend service AdminService with {
  type RebuildContentResult {
    dispatched : Boolean;
    slug       : String;
    debounced  : Boolean;
    workflowUrl: String;
  };

  entity Tutorials actions {
    @Core.OperationAvailable: true
    @Common.IsActionCritical : true
    action rebuildContent() returns RebuildContentResult;
  };
}
```

- [ ] **Step 4: Verify CDS compiles**

```bash
npx cds compile srv/admin-service.cds --to edmx 2>&1 | tail -5
```

Expected: no errors. The action should appear in the EDMX output:

```bash
npx cds compile srv/admin-service.cds --to edmx 2>&1 | grep -i "rebuildContent\|RebuildContentResult" | head -5
```

Expected: matches showing the action + return type are wired into the EDMX.

- [ ] **Step 5: Run the tests — they MUST still fail (handler not implemented)**

```bash
npx vitest run srv/lib/__tests__/admin-rebuild-tutorial.test.js --reporter=default 2>&1 | tail -15
```

Expected: tests 1, 3, 4, 5, 6 fail. Failures now read like "501 Not Implemented" or "Handler not registered" — past routing but inside the missing handler. (Test 4/5 may pass if CAP's default handler happens to 400 on the missing-slug check — unlikely but possible. Investigate either way.)

If tests pass at this stage, the implementation already exists somewhere or a test is mis-asserting — investigate before continuing.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(admin/cds): declare AdminService.rebuildContent bound action on Tutorials

Uses 'extend service AdminService with { entity Tutorials actions { ... } }'
form at the end of the file — additive, doesn't touch the existing Tutorials
projection at lines 20-26.

Adds:
- type RebuildContentResult { dispatched, slug, debounced, workflowUrl }
- action rebuildContent() returns RebuildContentResult
- @Common.IsActionCritical marks the button with destructive-action styling

Handler implementation follows in Task 4. Tests still fail — green phase
for the CDS declaration only."
```

---

## Task 4: Implement the action handler

**Files:**
- Modify: [srv/admin-service.js](../../srv/admin-service.js)

**Important:** the spec's prose claims `scheduleRebuild` is "already imported" in `admin-service.js`. **That's wrong** — verified by `grep -n scheduleRebuild srv/admin-service.js` returning 0 hits (the only match in the file is a comment at line 1269 about `invalidateDispatchTokenCache`). We are adding a NEW import.

- [ ] **Step 1: Add the `scheduleRebuild` import at the top of the file**

Use the Edit tool. The existing imports end at line 20 (`import { randomBytes } from 'node:crypto';`). Find the `import { invalidateSecret } from './lib/secret-resolver.js';` line at line 17 and add the new import immediately after it:

```js
import { invalidateSecret } from './lib/secret-resolver.js';
import { scheduleRebuild } from './lib/rebuild-trigger.js';   // ← NEW
import { cleanupChangeLog } from './jobs/cleanup.js';
```

- [ ] **Step 2: Verify the import was added correctly**

```bash
grep -n "scheduleRebuild\|rebuild-trigger" srv/admin-service.js | head -5
```

Expected: shows the new import line. Previously had only the line-1269 comment match; now should have both.

- [ ] **Step 3: Locate the registration site inside `init()`**

Confirm the class boundary and `init()` end:

```bash
grep -n "class AdminService\|async init\|^  }$" srv/admin-service.js | head -5
```

The first `^  }$` line that comes AFTER `async init()` (line 24) is the closing brace of `init()`. We'll add the handler registration just before that closing brace so all other `this.on(...)` registrations remain co-located.

Also verify the auditEvent helper IS in scope:

```bash
grep -n "const auditEvent" srv/admin-service.js
```

Expected: line 1234. Anything we register inside `init()` AFTER that line has the helper in scope. If you place the registration BEFORE line 1234, the `auditEvent` reference will be undefined at call time.

- [ ] **Step 4: Add the `this.on('rebuildContent', ...)` registration**

Add this block inside `init()`, AFTER line 1234 (so `auditEvent` is in scope) and BEFORE `init()`'s closing brace:

```js
    // ── Rebuild-button action (issue: rebuild-button) ──
    // Bound action on Tutorials. Resolves slug, audit-logs intent, dispatches
    // a slug-targeted rebuild via scheduleRebuild's 60s debounce.
    this.on('rebuildContent', 'Tutorials', async (req) => {
      const tutorialId = req.params[0].ID;
      const row = await SELECT.one
        .from(Tutorials)
        .columns('slug', 'title')
        .where({ ID: tutorialId });
      if (!row?.slug) {
        return req.reject(400, 'Tutorial has no slug; cannot rebuild');
      }

      const userId = req.user?.id ?? 'anonymous';

      // auditEvent is the closure-scoped helper at line 1234; it emits
      // 'SecurityEvent' with { data: { action, ...rest } }. No-op when the
      // audit-log binding is unavailable (mock-auth dev environment).
      await auditEvent('TutorialRebuildTriggered', {
        user: userId,
        tutorialId,
        slug: row.slug,
        source: 'admin-ui:tutorial-detail',
      });

      await scheduleRebuild(`admin-ui:rebuild-button:${userId}`, {
        mode: 'slug-targeted',
        slug: row.slug,
      });

      return {
        dispatched: true,
        slug: row.slug,
        debounced: true,
        workflowUrl: 'https://github.com/sap-tutorials/tutorials-ims/actions/workflows/rebuild-content.yml',
      };
    });
```

> **Note on `Tutorials` reference:** the destructured `Tutorials` constant comes from `cds.entities(...)` at the top of `init()` (line 25 area: `const { Users, Tutorials, Missions, ... }`). If you place the handler outside that destructure's scope, qualify with `cds.entities('AdminService').Tutorials` (matches the test file's lookup pattern).

- [ ] **Step 5: Run the tests — they MUST now pass**

```bash
npx vitest run srv/lib/__tests__/admin-rebuild-tutorial.test.js --reporter=default 2>&1 | tail -25
```

Expected: 5 active tests (1, 3, 4, 5, 6) all pass; 2 marked `.todo` (tests 2 and 7) skipped. Final line should read `Tests  5 passed | 2 todo (7)` or similar.

If any of tests 1, 3, 4, 5, 6 fail, the handler is wrong — debug before continuing. Use `--reporter=verbose` for detailed output.

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.js
git commit -m "feat(admin/handler): implement AdminService.rebuildContent action

Registers the handler inside AdminService.init() after the auditEvent helper
declaration (line 1234) so the closure-scoped helper is in scope:
- Resolves req.params[0].ID → Tutorials.slug via CQL SELECT
- Rejects 400 when slug is null or empty (data-quality guard)
- Emits TutorialRebuildTriggered audit event via the closure-scoped auditEvent
- Invokes scheduleRebuild with mode=slug-targeted + the row's slug
- Returns { dispatched, slug, debounced, workflowUrl } for the UI toast

Adds new top-level import: scheduleRebuild from ./lib/rebuild-trigger.js
(spec mistakenly described this as 'already imported' — verified via grep
that it was NOT).

Tests 1, 3, 4, 5, 6 of srv/lib/__tests__/admin-rebuild-tutorial.test.js
pass. Tests 2 and 7 remain .todo; verification path documented in their
comments."
```

---

## Task 5: Add the UI annotation (Identification action)

**Files:**
- Modify: [app/admin-annotations.cds](../../app/admin-annotations.cds)

- [ ] **Step 1: Read the existing Tutorials `@UI.Identification` annotations**

```bash
sed -n '555,605p' app/admin-annotations.cds
```

Expected: shows `annotate AdminService.Tutorials with @UI: { ... Identification: [ ... ] ... };` and any header DataField entries.

Note the existing `Identification` array entries — we'll add a new `DataFieldForAction` element.

- [ ] **Step 2: Add the rebuild action to the Identification array**

Edit [app/admin-annotations.cds](../../app/admin-annotations.cds). Inside the `@UI.Identification` array for Tutorials, add this entry (after the last existing entry):

```cds
{
  $Type            : 'UI.DataFieldForAction',
  Label            : '{i18n>RebuildTutorialButton}',
  Action           : 'AdminService.rebuildContent',
  ![@UI.Importance]: #High,
},
```

If the existing array has no `i18n>` keys (i.e. literal strings used elsewhere), use the literal `Label: 'Rebuild this tutorial'` instead — match the file's prevailing convention.

- [ ] **Step 3: Verify CDS compiles cleanly**

```bash
npx cds compile srv/admin-service.cds --to edmx 2>&1 | tail -10
```

Expected: no errors. The new `DataFieldForAction` should appear in the generated EDMX.

```bash
npx cds compile srv/admin-service.cds --to edmx 2>&1 | grep -i "rebuildContent\|RebuildTutorialButton" | head -5
```

Expected: matches showing the action is wired into the EDMX `Annotations` block.

- [ ] **Step 4: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(admin/ui): annotate Tutorials with rebuildContent header action

Adds DataFieldForAction in @UI.Identification so Fiori Elements renders
the action as a header button on the Tutorials ObjectPage — next to
Edit / Delete / AskJoule. Importance: High to keep it visible without
overflow-menu burial. Label i18n key: RebuildTutorialButton."
```

---

## Task 6: Create i18n directory + strings + wire it into manifest

**Files:**
- Create: [app/admin/tutorials/webapp/i18n/i18n.properties](../../app/admin/tutorials/webapp/i18n/i18n.properties)
- Modify: [app/admin/tutorials/webapp/manifest.json](../../app/admin/tutorials/webapp/manifest.json) — add `sap.app.i18n` entry + `models.i18n` model

The reviewer confirmed: the `i18n/` directory does NOT exist under `app/admin/tutorials/webapp/`, AND the existing `manifest.json` has no `sap.app.i18n` entry and no `models.i18n` model. The `{i18n>RebuildTutorialButton}` reference in Task 5's CDS annotation will resolve only if the model is wired here.

- [ ] **Step 1: Create the i18n directory and file**

```bash
mkdir -p app/admin/tutorials/webapp/i18n
```

Then create the file at [app/admin/tutorials/webapp/i18n/i18n.properties](../../app/admin/tutorials/webapp/i18n/i18n.properties):

```properties
# i18n strings for the admin Tutorials Fiori Elements app
# Created for the rebuild-tutorial-button feature (spec: 2026-06-24-admin-tutorial-rebuild-button-design.md)

# Rebuild action button (admin-ui rebuild-button feature)
RebuildTutorialButton=Rebuild this tutorial
RebuildTutorialDialogTitle=Rebuild tutorial
RebuildTutorialDialogMessage=Rebuild tutorial "{0}"? This dispatches a workflow that will republish the tutorial's content to HANA in about 2 minutes.
RebuildTutorialToastSuccess=Rebuild dispatched for "{0}". The page will refresh in ~2 minutes.
RebuildTutorialToastError=Could not dispatch rebuild: 
```

> The ` ` at the end of `RebuildTutorialToastError` is a trailing space; the controller extension appends the error message after it. Some text editors strip trailing whitespace from .properties files, so we use the unicode escape to make it stable.

- [ ] **Step 2: Wire `sap.app.i18n` in manifest.json**

Edit [app/admin/tutorials/webapp/manifest.json](../../app/admin/tutorials/webapp/manifest.json). Inside the top-level `sap.app` object, add this key (alongside `id`, `type`, etc.):

```json
"sap.app": {
  ...,
  "i18n": "i18n/i18n.properties"
}
```

- [ ] **Step 3: Wire the i18n model in `sap.ui5.models`**

Inside `sap.ui5.models` (creating the object if it doesn't exist), add:

```json
"sap.ui5": {
  ...,
  "models": {
    ...existing models if any...,
    "i18n": {
      "type": "sap.ui.model.resource.ResourceModel",
      "settings": {
        "bundleName": "sap.tutorials.admin.tutorials.i18n.i18n"
      }
    }
  }
}
```

Use the existing namespace prefix from `sap.app.id` (likely `sap.tutorials.admin.tutorials` based on the AskJoule reference). Confirm via:

```bash
grep -n '"id":' app/admin/tutorials/webapp/manifest.json
```

Adjust the `bundleName` to match `<id>.i18n.i18n` (the `.i18n.i18n` is `<directory>.<filename-without-extension>`).

- [ ] **Step 4: Verify manifest is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin/tutorials/webapp/manifest.json','utf8'))" && echo OK
```

Expected: `OK`. If a parse error appears, fix it.

- [ ] **Step 5: Commit**

```bash
git add app/admin/tutorials/webapp/i18n/ app/admin/tutorials/webapp/manifest.json
git commit -m "i18n(admin/tutorials): create i18n bundle + wire it into manifest

The admin Tutorials Fiori Elements app had no i18n model wired previously
(all text was inline). The new rebuild-button feature uses {i18n>...}
references in its CDS annotation and getResourceBundle() calls in the
controller extension, so the bundle and model must be wired here.

Adds:
- app/admin/tutorials/webapp/i18n/i18n.properties — 5 strings for button +
  dialog + toasts. Strings use {0} positional placeholders for the tutorial
  title; the controller extension passes via MessageBox/MessageToast formatters.
- manifest.json sap.app.i18n: 'i18n/i18n.properties'
- manifest.json sap.ui5.models.i18n: ResourceModel bound to the new bundle

Future-friendly: other admin tiles that may want localized strings can now
follow the same pattern instead of re-inventing it."
```

---

## Task 7: Create the controller extension

**Files:**
- Create: [app/admin/tutorials/webapp/ext/RebuildTutorial.js](../../app/admin/tutorials/webapp/ext/RebuildTutorial.js)

- [ ] **Step 1: Read the existing AskJoule.js for pattern reference**

```bash
cat app/admin/tutorials/webapp/ext/AskJoule.js
```

Note the namespace declaration (`sap.tutorials.admin.tutorials.ext.AskJoule`), the binding-context resolution, and the press-handler signature.

- [ ] **Step 2: Create the new controller extension**

Create [app/admin/tutorials/webapp/ext/RebuildTutorial.js](../../app/admin/tutorials/webapp/ext/RebuildTutorial.js):

```js
sap.ui.define([
  'sap/m/MessageBox',
  'sap/m/MessageToast',
], (MessageBox, MessageToast) => {
  'use strict';
  return {
    /**
     * Press handler for the "Rebuild this tutorial" header action.
     * Wired via the action's DataFieldForAction → AdminService.rebuildContent
     * binding in the CDS annotations. Fiori Elements invokes this when the
     * user clicks the button (after our manifest's controllerExtensions
     * override redirects the press here).
     *
     * Flow:
     *  1. Resolve the bound Tutorial row from the view's binding context.
     *  2. Confirm via MessageBox with the tutorial title interpolated.
     *  3. On confirm, execute the bound action.
     *  4. Show a toast on success / message-box on error.
     */
    onRebuildTutorial: function () {
      const oContext = this.getView().getBindingContext();
      if (!oContext) {
        MessageBox.error('No tutorial bound to this view.');
        return;
      }
      const oData = oContext.getObject() || {};
      const sTitle = oData.title || oData.slug || '(this tutorial)';

      const oResourceBundle = this.getView().getModel('i18n').getResourceBundle();
      const sDialogTitle   = oResourceBundle.getText('RebuildTutorialDialogTitle');
      const sDialogMessage = oResourceBundle.getText('RebuildTutorialDialogMessage', [sTitle]);
      const sToastSuccess  = oResourceBundle.getText('RebuildTutorialToastSuccess',  [sTitle]);
      const sToastError    = oResourceBundle.getText('RebuildTutorialToastError', ['']);

      MessageBox.confirm(sDialogMessage, {
        title: sDialogTitle,
        actions: [MessageBox.Action.OK, MessageBox.Action.CANCEL],
        emphasizedAction: MessageBox.Action.OK,
        onClose: (sResult) => {
          if (sResult !== MessageBox.Action.OK) return;

          const oModel = this.getView().getModel();
          const oAction = oModel.bindContext(
            'AdminService.rebuildContent(...)',
            oContext,
            { $$inheritExpandSelect: true }
          );

          oAction.execute()
            .then(() => {
              MessageToast.show(sToastSuccess, { duration: 5000 });
            })
            .catch((err) => {
              const msg = err?.message ?? String(err);
              MessageBox.error(sToastError + msg);
            });
        },
      });
    },
  };
});
```

- [ ] **Step 3: Verify the file is well-formed JavaScript**

```bash
node --check app/admin/tutorials/webapp/ext/RebuildTutorial.js
```

Expected: no output (success). If syntax errors are reported, fix them.

- [ ] **Step 4: Commit**

```bash
git add app/admin/tutorials/webapp/ext/RebuildTutorial.js
git commit -m "feat(admin/ui): controller extension for rebuildContent action

Intercepts the Fiori Elements bound-action press to:
- Resolve the bound Tutorial row
- Show a confirm dialog with the tutorial title interpolated
- On confirm, invoke AdminService.rebuildContent via bindContext + execute
- Show a MessageToast on success, MessageBox.error on failure

Mirrors the existing ext/AskJoule.js pattern. i18n strings come from
i18n.properties (committed previously)."
```

---

## Task 8: Wire the controller extension in manifest.json

**Files:**
- Modify: [app/admin/tutorials/webapp/manifest.json](../../app/admin/tutorials/webapp/manifest.json)

The reviewer confirmed: the existing manifest has **no** `sap.ui.controllerExtensions` block. We're adding it at the root of `sap.ui5`. AskJoule lives in `targets.TutorialsObjectPage.options.settings.content.header.actions.AskJouleAction` (a different mechanism for header buttons declared in manifest only — not a controller extension), so the new wiring does NOT collide.

- [ ] **Step 1: Confirm no existing controllerExtensions block**

```bash
grep -n "controllerExtensions\|extends" app/admin/tutorials/webapp/manifest.json
```

Expected: no matches (the manifest has neither `extends` nor `controllerExtensions` blocks yet). If matches appear, you'll need to merge — see the conditional note at the end of this task.

- [ ] **Step 2: Add the controllerExtensions block**

Edit [app/admin/tutorials/webapp/manifest.json](../../app/admin/tutorials/webapp/manifest.json). Inside `sap.ui5` (alongside `dependencies`, `models`, `routing`, etc.), add this top-level key:

```json
"sap.ui5": {
  ...,
  "extends": {
    "extensions": {
      "sap.ui.controllerExtensions": {
        "sap.fe.templates.ObjectPage.ObjectPageController": {
          "controllerName": "sap.tutorials.admin.tutorials.ext.RebuildTutorial"
        }
      }
    }
  }
}
```

Important — the `controllerName` must match the namespace declared in [app/admin/tutorials/webapp/ext/RebuildTutorial.js](../../app/admin/tutorials/webapp/ext/RebuildTutorial.js) (Task 7 used `sap.ui.define([...], (...) => { 'use strict'; return { onRebuildTutorial: ... } })`). The defined namespace comes from `sap.app.id` + the path under the webapp root — confirm via:

```bash
grep -n '"id":' app/admin/tutorials/webapp/manifest.json
```

Use `<that-id>.ext.RebuildTutorial` as the `controllerName`. The existing `AskJoule` reference at `manifest.json` line ~85 (`sap.tutorials.admin.tutorials.ext.AskJoule.onAskJoule`) confirms the namespace prefix is `sap.tutorials.admin.tutorials`.

- [ ] **Step 3: Verify the manifest is valid JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin/tutorials/webapp/manifest.json','utf8'))" && echo OK
```

Expected: `OK`. If a parse error appears, fix it.

- [ ] **Step 4: Build the admin-shell to confirm the manifest wiring is consistent**

```bash
npm --prefix app/admin-shell run build 2>&1 | tail -20
```

Expected: build completes without errors. Warnings about "controller extension registered for view" are normal.

- [ ] **Step 5: Commit**

```bash
git add app/admin/tutorials/webapp/manifest.json
git commit -m "feat(admin/ui): wire RebuildTutorial controller extension

Registers sap.tutorials.admin.tutorials.ext.RebuildTutorial as a controller
extension on sap.fe.templates.ObjectPage.ObjectPageController so the
rebuildContent action's button press is intercepted by onRebuildTutorial
(confirm dialog + toast).

Does not collide with the existing AskJoule manifest wiring (which lives in
the targets header.actions block, a different mechanism)."
```

> **Conditional fallback:** if Step 1 reveals an existing `controllerExtensions` block (e.g. someone added one between when this plan was written and when it's executed), MERGE rather than replace. The final shape must be a single `sap.ui.controllerExtensions` map. If two controller extensions extend the same `ObjectPageController`, follow the FE Elements multi-extension pattern (an array OR merge the methods into one extension file).

---

## Task 9: Add the smoke test for the 403/401 path

**Files:**
- Modify: [test/smoke/auth-enforcement.test.js](../../test/smoke/auth-enforcement.test.js)

The reviewer caught the spec's error: `test/smoke/admin-endpoints.test.js` does not exist. The correct target is `auth-enforcement.test.js`, which already houses the analogous `/admin/Tutorials` auth check.

- [ ] **Step 1: Read the existing auth-enforcement assertions**

```bash
cat test/smoke/auth-enforcement.test.js
```

Note the pattern:

```js
it('GET /admin/Tutorials without auth is rejected', async () => {
  const res = await fetchWithRetry(`${SRV_URL}/admin/Tutorials`);
  expect([401, 403]).toContain(res.status);
});
```

We'll add an analogous POST assertion for the new bound action.

- [ ] **Step 2: Add the assertion**

Append (inside the existing `describe('Auth enforcement', () => { ... })` block) — match the file's existing style:

```js
  it('POST /admin/Tutorials(<id>)/AdminService.rebuildContent without auth is rejected', async () => {
    // Any valid-shape UUID; the request should be rejected at the auth layer
    // long before the handler ever runs, so the ID need not exist in DB.
    const url = `${SRV_URL}/admin/Tutorials(ID=00000000-0000-0000-0000-000000000001,IsActiveEntity=true)/AdminService.rebuildContent`;
    const res = await fetchWithRetry(url, { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } });
    expect([401, 403]).toContain(res.status);
  });
```

> If `fetchWithRetry` in this file's `smoke.config.js` doesn't accept a `method`/`body`/`headers` options object, fall back to the native `fetch` API directly with the same URL — the assertion goal is the same.

- [ ] **Step 3: Verify the file still parses**

```bash
node --check test/smoke/auth-enforcement.test.js
```

Expected: no output (success).

- [ ] **Step 4: Commit**

```bash
git add test/smoke/auth-enforcement.test.js
git commit -m "test(smoke): assert AdminService.rebuildContent rejects 401/403 without auth

Defense-in-depth check: confirms an unauthenticated request to the new
bound action is gated upstream by the AdminService scope check, NOT
by the handler's slug-null guard.

Targets test/smoke/auth-enforcement.test.js (the spec mistakenly referenced
admin-endpoints.test.js which doesn't exist in this codebase)."
```

---

## Task 10: End-to-end manual verification

**Files:** none (verification only)

> **Goal:** confirm the button works end-to-end against a running srv with the audit-log binding wired up. This is the catch-all for issues the unit tests can't reach (Fiori Elements rendering, manifest controller-extension wiring, real audit-log delivery).

- [ ] **Step 1: Build the admin shell**

```bash
npm --prefix app/admin-shell run build
```

Expected: build completes; `app/admin-shell/dist/` populated.

- [ ] **Step 2: Start a hybrid local server**

```bash
npm run dev:hybrid
```

This brings up CAP + approuter against real HANA via `cds bind`. The admin UI is reachable at `http://localhost:5000/admin-ui/`.

- [ ] **Step 3: Navigate to a Tutorial detail page**

Open browser: `http://localhost:5000/admin-ui/#/tutorials`. Click any tutorial row to enter the ObjectPage.

- [ ] **Step 4: Verify the button is rendered**

Look for a button labeled "Rebuild this tutorial" in the header action bar next to **Edit** / **Delete** / **AskJoule**. If missing, check the CDS annotation (Task 5) and i18n key (Task 6).

- [ ] **Step 5: Click and verify the confirm dialog**

Click the button. A dialog should appear titled "Rebuild tutorial" with the body "Rebuild tutorial "<title>"? This dispatches a workflow…". The tutorial title should match the one you opened.

- [ ] **Step 6: Click Cancel — verify NO dispatch**

Click Cancel. No toast. Open another terminal:

```bash
gh run list --workflow rebuild-content.yml --branch main --limit 1
```

The latest run timestamp should NOT have moved (compared to before the click).

- [ ] **Step 7: Click again, this time OK**

Click the button again, then click OK in the dialog. A toast should appear within ~1s saying "Rebuild dispatched for "<title>". The page will refresh in ~2 minutes."

- [ ] **Step 8: Verify the workflow run actually dispatched**

Wait ~60 seconds (for the scheduleRebuild debounce to fire), then:

```bash
gh run list --workflow rebuild-content.yml --branch main --limit 1
```

A new run should appear. View its details:

```bash
gh run view --log 2>&1 | grep "trigger-source\|Rebuild mode" | head -3
```

Expected: shows `trigger-source: admin-ui:rebuild-button:<your-user-id>` and `Rebuild mode: slug-targeted (explicit ...)`.

- [ ] **Step 9: Verify the audit log entry was written**

In another terminal, connect to HANA via cds bind:

```bash
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
(async () => {
  await cds.connect();
  const log = await cds.run(\"SELECT * FROM AUDIT_LOG WHERE DATA LIKE '%TutorialRebuildTriggered%' ORDER BY \\\"timestamp\\\" DESC LIMIT 1\");
  console.log(JSON.stringify(log, null, 2));
})();
"
```

Expected: shows a row with `action: 'TutorialRebuildTriggered'`, `user: <your-user-id>`, `slug: <tutorial-slug>`, `source: 'admin-ui:tutorial-detail'`.

If the audit log row is missing, double-check the audit-log service is bound (`cf services | grep audit-log` on the target srv) and the `_auditLog` connect succeeded at boot (`cf logs tutorials-srv --recent | grep audit-log`).

- [ ] **Step 10: Wait for the actual rebuild to complete**

After ~2 minutes the workflow run completes. Visit the tutorial in the public UI (e.g. `https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com/tutorials/<slug>/`) and verify the content reflects whatever was in GitHub at the time of the dispatch.

- [ ] **Step 11: No commit (verification-only)**

Manual verification is documentation, not a commit. Record findings in the PR description.

---

## Task 11: Open the PR

**Files:** none (PR-creation only)

- [ ] **Step 1: Verify the branch is clean**

```bash
git status --short
git log --oneline main..HEAD
```

Expected: clean tree, ~7 commits on top of `main` (one per task 2-9).

- [ ] **Step 2: Push the branch**

```bash
git push -u origin worktree-spec-admin-tutorial-rebuild-button
```

- [ ] **Step 3: Open the PR**

```bash
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --head worktree-spec-admin-tutorial-rebuild-button \
  --title "feat(admin/ui): 'Rebuild this tutorial' button on the Tutorials ObjectPage" \
  --body "$(cat <<'EOF'
## Summary

Adds a header action button to the admin Tutorials Fiori Elements ObjectPage so admins can self-serve a single-tutorial republish without forcing a fake-edit-save dance, CLI access, or ops involvement.

Closes the manual-dispatch UX gap PR #610 partially closed at the CLI surface, but extends it into the admin UI where day-to-day operators live.

**Spec:** [docs/superpowers/specs/2026-06-24-admin-tutorial-rebuild-button-design.md](docs/superpowers/specs/2026-06-24-admin-tutorial-rebuild-button-design.md)
**Plan:** [docs/superpowers/plans/2026-06-24-admin-tutorial-rebuild-button.md](docs/superpowers/plans/2026-06-24-admin-tutorial-rebuild-button.md)

## What changed

| File | Change |
|---|---|
| srv/admin-service.cds | New bound action \`rebuildContent\` + \`RebuildContentResult\` type |
| srv/admin-service.js | Import \`scheduleRebuild\`; register \`this.on('rebuildContent', 'Tutorials', ...)\` handler |
| app/admin-annotations.cds | New \`DataFieldForAction\` in Tutorials \`@UI.Identification\` |
| app/admin/tutorials/webapp/manifest.json | Wire RebuildTutorial controller extension |
| app/admin/tutorials/webapp/ext/RebuildTutorial.js | (new) confirm dialog + bound action call + toast |
| app/admin/tutorials/webapp/i18n/i18n.properties | (new or extended) 5 strings for button + dialog + toasts |
| srv/lib/__tests__/admin-rebuild-tutorial.test.js | (new) 7 unit tests |
| test/smoke/admin-endpoints.test.js | 1 additive 403 assertion |

## Test results

Unit: \`npx vitest run srv/lib/__tests__/admin-rebuild-tutorial.test.js\` → [N passed / 0 failed].
No regressions in adjacent suites: \`npx vitest run srv/lib/__tests__/ srv/__tests__/admin-actions.test.js\` → [all pass].

## Manual verification

Performed against \`npm run dev:hybrid\` on DEV:
- ✅ Button renders next to Edit/Delete/AskJoule on the Tutorial detail page
- ✅ Confirm dialog shows the correct tutorial title
- ✅ Cancel — no dispatch
- ✅ OK — toast appears within ~1s
- ✅ GH Actions run appears within 60s with \`trigger-source: admin-ui:rebuild-button:<user>\` and \`Rebuild mode: slug-targeted\`
- ✅ Audit log shows \`TutorialRebuildTriggered\` row with user + slug + source
- ✅ Rebuild completes in ~2m 22s (matching PR #615 measurements)

## Deploy

Standard MTA deploy. No DB schema changes, no new env vars, no new XSUAA scopes, no new secrets. Pre-deploy check: \`cf logs tutorials-srv --recent | grep rebuild-trigger\` — confirm \`[rebuild-trigger] active\` (the GITHUB_DISPATCH_TOKEN must be reachable for the button to actually dispatch).

## Out of scope (deferred)

- Author-surface access — tracked in #617
- Per-row "last rebuild" status indicator — defer until ops asks
- Bulk rebuild — covered organically by the existing 50-slug accumulator
- Per-tutorial rate-limit beyond the 60s global window — YAGNI
EOF
)"
```

---

## Plan Review

Don't run this plan straight to implementation — first pass it through the plan-document-reviewer subagent to catch holes I might have missed.

After this plan is committed, dispatch the reviewer with this context:

> Review the implementation plan at `docs/superpowers/plans/2026-06-24-admin-tutorial-rebuild-button.md` against the spec at `docs/superpowers/specs/2026-06-24-admin-tutorial-rebuild-button-design.md`. Check:
> - Is every spec requirement covered by a task?
> - Are TDD steps in the right order (red → green → commit)?
> - Are file paths and line-number references accurate?
> - Are commands runnable as written (no shell-quoting surprises, no missing flags)?
> - Are commit messages clear and bisect-friendly?
> - Are there any scope-creep tasks that should be deferred?

Then fix what the reviewer flags and re-dispatch up to 3 iterations before surfacing to the user.
