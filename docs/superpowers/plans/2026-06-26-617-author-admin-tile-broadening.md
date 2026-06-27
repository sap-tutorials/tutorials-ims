# Issue #617 — Broaden Tutorial.Author access to admin tiles — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let `Tutorial.Author` scope holders use a curated 6-tile subset of `/admin-ui/` (Tutorial Health, Tutorials read+rebuild, Tags read, Feedback read, Tutorials-only Changelog, Analytics with no SQL tab).

**Architecture:** Shared admin-shell bundle with scope-gated tiles (single source of truth). New AuthorService projections re-project the entities authors need on top of the same `db/schema.cds` views. Approuter relaxes scope on `/admin-ui/` and `/analytics-ui/`; OData backends remain the trust boundary. Authorization is scope-based, not row-based — any `Tutorial.Author` sees the whole catalog.

**Tech Stack:** CAP Node.js (CDS service projections, action handlers), UI5 (admin-shell), Vue 3 (analytics-explorer), XSUAA, HANA. Test stack: Vitest 3 workspaces (unit / hybrid / smoke).

**Spec:** [docs/superpowers/specs/2026-06-26-617-author-admin-tile-broadening-design.md](../specs/2026-06-26-617-author-admin-tile-broadening-design.md)

---

## Pre-flight findings (read before starting)

Two facts discovered while mapping files; both shape the task order:

1. **`/auth/user` does NOT return a `scopes` array today.** It returns `{ authenticated, id, email, givenName, familyName, isAdmin, khorosId, khorosLogin, khorosAvatarUrl }` ([srv/server.js:747-757](../../../srv/server.js#L747)). The spec's boot pseudocode assumed `scopes: [...]`. **Resolution:** add `isAuthor: user.is?.('Tutorial.Author') === true` as a sibling of `isAdmin` (Task 1). One-line server change, backward-compatible.

2. **`navigation.json` is loaded into a `nav` JSON model but the actual nav tree is hardcoded in [Shell.view.xml](../../../app/admin-shell/webapp/view/Shell.view.xml) (49 static `<tnt:NavigationListItem>` entries).** Filtering `navigation.json` alone wouldn't hide tiles. **Resolution:** convert the nav tree to data-bind from `nav>/groups` first (Task 2 — refactor, no behavior change), THEN add `requiredScope` (Task 12).

3. **`auditEvent` is a closure inside [srv/admin-service.js:1405-1412](../../../srv/admin-service.js#L1405).** Not exported. **Resolution:** extract to `srv/lib/audit-event.js` so AuthorService can reuse it without duplication (Task 16).

4. **Admin rebuild handler uses `source: 'admin-ui:tutorial-detail'`** ([srv/admin-service.js:1599](../../../srv/admin-service.js#L1599)), not `'admin-ui:rebuild-button:<user>'` as the spec implied. **Resolution:** use the actual convention. Author handler uses `source: 'author-ui:tutorial-detail'` for symmetry.

---

## File structure

### Backend (CAP)

| File | Action | Responsibility |
|---|---|---|
| [srv/server.js](../../../srv/server.js) | Modify | Add `isAuthor` to `/auth/user` response. |
| [srv/lib/audit-event.js](../../../srv/lib/audit-event.js) | Create | Extracted audit-event helper, importable from any service. |
| [srv/admin-service.js](../../../srv/admin-service.js) | Modify | Replace local `auditEvent` closure with import from `srv/lib/audit-event.js`. No behavior change. |
| [srv/author-service.cds](../../../srv/author-service.cds) | Modify | Widen `Tutorials` projection to full row; add `TutorialFeedback`, `TutorialFeedbackAggregate`, `TutorialChanges`, 8 Analytics projections, `listExposedEntities` function, `rebuildContent` bound action. |
| [srv/author-service.js](../../../srv/author-service.js) | Modify | Implement `rebuildContent` handler + `listExposedEntities` handler. |
| [db/views.cds](../../../db/views.cds) | Modify | Add `AuthorTutorialChanges` view (Tutorials-only filter on `sap.changelog.Changes`). |

### Frontend (UI shells)

| File | Action | Responsibility |
|---|---|---|
| [app/admin-shell/webapp/manifest.json](../../../app/admin-shell/webapp/manifest.json) | Modify | Add `authorService` dataSource + `author` model. |
| [app/admin-shell/webapp/Component.js](../../../app/admin-shell/webapp/Component.js) | Modify | Boot-time role detection; bind correct model to author-visible tiles. |
| [app/admin-shell/webapp/controller/Shell.controller.js](../../../app/admin-shell/webapp/controller/Shell.controller.js) | Modify | Extend `_loadUserProfile` to capture role + filter nav. |
| [app/admin-shell/webapp/view/Shell.view.xml](../../../app/admin-shell/webapp/view/Shell.view.xml) | Modify | Convert hardcoded nav tree to data-binding from `nav>/groups`; bind title to viewModel; gate NoAccess. |
| [app/admin-shell/webapp/model/navigation.json](../../../app/admin-shell/webapp/model/navigation.json) | Modify | Add Feedback group; add `requiredScope` + `adminPath`/`authorPath` per entry. |
| [app/admin-shell/webapp/view/NoAccess.view.xml](../../../app/admin-shell/webapp/view/NoAccess.view.xml) | Create | 403 interstitial when caller holds neither scope. |
| [app/admin-shell/webapp/controller/NoAccess.controller.js](../../../app/admin-shell/webapp/controller/NoAccess.controller.js) | Create | Minimal controller for NoAccess view. |
| [app/admin-shell/webapp/i18n/i18n.properties](../../../app/admin-shell/webapp/i18n/i18n.properties) | Modify | Add `consoleTitle.admin/author`, `documentTitle.*`, NoAccess strings. |
| [app/analytics-explorer/src/App.vue](../../../app/analytics-explorer/src/App.vue) | Modify | Role-aware boot; conditional SQL tab; banner for authors. |
| [app/analytics-explorer/src/composables/useAuth.ts](../../../app/analytics-explorer/src/composables/useAuth.ts) | Create | `/auth/user` fetch + role derivation composable. |

### Deploy

| File | Action | Responsibility |
|---|---|---|
| [approuter/xs-app.json](../../../approuter/xs-app.json) | Modify | Drop `scope: '$XSAPPNAME.Admin'` from `/admin-ui/` and `/analytics-ui/` routes. |

### Tests

| File | Action | Responsibility |
|---|---|---|
| `test/unit/auth-user-endpoint.test.js` | Create | `/auth/user` includes `isAuthor`. |
| `test/unit/author-service-tutorials.test.js` | Create | Full-row projection; scope enforcement. |
| `test/unit/author-service-feedback.test.js` | Create | Feedback read-only. |
| `test/unit/author-service-changelog.test.js` | Create | TutorialChanges filters non-Tutorials rows. |
| `test/unit/author-service-rebuild.test.js` | Create | `rebuildContent` calls `scheduleRebuild` + audits. |
| `test/unit/author-service-analytics.test.js` | Create | 8 projections read; no `runSelectQuery`. |
| `test/unit/audit-event-lib.test.js` | Create | Extracted helper works with/without audit binding. |
| `test/hybrid/617-author-tutorials.test.js` | Create | HANA round-trip. |
| `test/hybrid/617-author-rebuild.test.js` | Create | Dispatch-gated by `HYBRID_DISPATCH_TESTS=true`. |
| `test/hybrid/617-author-changelog-filter.test.js` | Create | Seeded changes filter to Tutorials only. |
| `test/hybrid/617-author-analytics-surface.test.js` | Create | Analytics projections + `runSelectQuery` not exposed. |
| `test/smoke/author-scope-routes.smoke.test.js` | Create | Deployed-route surface as a `Tutorial.Author`. |

### Spec

| File | Action | Responsibility |
|---|---|---|
| [docs/superpowers/specs/2026-06-26-617-author-admin-tile-broadening-design.md](../specs/2026-06-26-617-author-admin-tile-broadening-design.md) | Already exists | Reference only. |

---

## Conventions every task follows

- **Always work from this worktree** (`D:\projects\tutorials-poc\.claude\worktrees\spec-617-author-tiles`). Never `cd` to the primary tree.
- **Tests first.** Each backend task writes the failing test, runs it (expect FAIL), implements minimal code, runs it (expect PASS), then commits. UI tasks fall back to manual verification where unit testing is infeasible.
- **Commit messages** start with the conventional-commits prefix and the issue number, e.g. `feat(#617): expose isAuthor on /auth/user`.
- **Run from worktree root.** All commands assume `cd D:/projects/tutorials-poc/.claude/worktrees/spec-617-author-tiles`. Use Git Bash.
- **Vitest globs:** `npm test -- <path>` for a single file, `npm test` for the unit suite, `npm run test:hybrid` for HANA-bound, `npm run test:smoke` for HTTP-bound.
- **Skill references:** See @superpowers:test-driven-development, @superpowers:verification-before-completion.

---

## Task 1: Expose `isAuthor` on `/auth/user`

**Files:**
- Modify: [srv/server.js:747-757](../../../srv/server.js#L747)
- Test: `test/unit/auth-user-endpoint.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/auth-user-endpoint.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

describe('/auth/user', () => {
  let server;
  beforeAll(async () => { server = await cds.test(__dirname + '/../../').server; });
  afterAll(async () => { await server?.close?.(); });

  it('includes isAuthor:false for a non-author mock user', async () => {
    const res = await fetch('http://localhost:4004/auth/user', {
      headers: { authorization: 'Basic ' + Buffer.from('alice:').toString('base64') }
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('isAuthor');
    expect(typeof body.isAuthor).toBe('boolean');
  });

  it('includes isAuthor:true for a Tutorial.Author mock user', async () => {
    // mocked-auth seeds users from .cdsrc.json `requires.auth.users`
    // (see srv/lib/_mock-users.js for seeded names)
    const res = await fetch('http://localhost:4004/auth/user', {
      headers: { authorization: 'Basic ' + Buffer.from('author:').toString('base64') }
    });
    const body = await res.json();
    expect(body.isAuthor).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/auth-user-endpoint.test.js
```

Expected: FAIL (`isAuthor` undefined or missing user fixture).

- [ ] **Step 3: Add the field to the handler**

In [srv/server.js](../../../srv/server.js) at the `res.json({...})` block at lines 747-757, add `isAuthor` next to `isAdmin`:

```javascript
res.json({
  authenticated: true,
  id: user.id,
  email: user.attr?.email || '',
  givenName: user.attr?.given_name || user.attr?.givenName || '',
  familyName: user.attr?.family_name || user.attr?.familyName || '',
  isAdmin: user.is?.('Admin') === true,
  isAuthor: user.is?.('Tutorial.Author') === true,   // ← NEW (#617)
  khorosId,
  khorosLogin,
  khorosAvatarUrl,
});
```

- [ ] **Step 4: Confirm the `author` mock user exists**

```bash
grep -A 8 '"users"' .cdsrc.json | head -30
```

If `author` (or any user with the `Tutorial.Author` role) isn't seeded, add to `.cdsrc.json`:

```jsonc
"users": {
  "author": { "roles": ["Tutorial.Author"] }
}
```

Note: existing seeded users may already cover this — verify with the grep first. Do NOT clobber existing seeded users.

- [ ] **Step 5: Run test to verify it passes**

```bash
npm test -- test/unit/auth-user-endpoint.test.js
```

Expected: PASS both cases.

- [ ] **Step 6: Commit**

```bash
git add srv/server.js test/unit/auth-user-endpoint.test.js .cdsrc.json
git commit -m "feat(#617): expose isAuthor flag on /auth/user

Adds isAuthor:boolean next to isAdmin so the admin-shell can derive
the caller's role at boot. One-line addition; backward compatible
with existing callers (Shell.controller._loadUserProfile only reads
the user-profile fields)."
```

---

## Task 2: Extract `auditEvent` helper to `srv/lib/audit-event.js`

**Files:**
- Create: `srv/lib/audit-event.js`
- Modify: [srv/admin-service.js:1395-1412](../../../srv/admin-service.js#L1395) — replace closure with import.
- Test: `test/unit/audit-event-lib.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/unit/audit-event-lib.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { createAuditEmitter } from '../../srv/lib/audit-event.js';

describe('createAuditEmitter', () => {
  it('returns a noop when audit-log binding is null', async () => {
    const emit = createAuditEmitter(null, console);
    await expect(emit('TestAction', { foo: 'bar' })).resolves.toBeUndefined();
  });

  it('forwards to the bound log with merged data shape', async () => {
    const log = vi.fn().mockResolvedValue();
    const fakeBinding = { log };
    const emit = createAuditEmitter(fakeBinding, console);
    await emit('SecretValueRead', { user: 'alice', key: 'X' });
    expect(log).toHaveBeenCalledWith('SecurityEvent', {
      data: { action: 'SecretValueRead', user: 'alice', key: 'X' }
    });
  });

  it('warns but does not throw if the log call rejects', async () => {
    const log = vi.fn().mockRejectedValue(new Error('boom'));
    const warn = vi.fn();
    const emit = createAuditEmitter({ log }, { warn });
    await expect(emit('X', { y: 1 })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('audit'));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/audit-event-lib.test.js
```

Expected: FAIL (`createAuditEmitter` not defined).

- [ ] **Step 3: Implement the helper**

Create `srv/lib/audit-event.js`:

```javascript
// Extracted from srv/admin-service.js:1405-1412 so any CAP service can emit
// SecurityEvent audit records without re-rolling the closure (#617).
//
// Usage:
//   const audit = createAuditEmitter(await cds.connect.to('audit-log'), LOG);
//   await audit('TutorialRebuildTriggered', { user, slug, source });
//
// The audit-log binding is optional — in dev/mock-auth environments it may be
// missing. We swallow that case so handlers never block on telemetry.

export function createAuditEmitter(binding, logger) {
  return async function emitAudit(action, data) {
    if (!binding) return;
    try {
      await binding.log('SecurityEvent', { data: { action, ...data } });
    } catch (err) {
      logger?.warn?.(
        `audit-event: emit failed for ${action} (${err?.message ?? err})`
      );
    }
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/unit/audit-event-lib.test.js
```

Expected: PASS all three cases.

- [ ] **Step 5: Replace the closure in admin-service.js**

In [srv/admin-service.js](../../../srv/admin-service.js):

Add import near the top of the file (with the other imports):

```javascript
import { createAuditEmitter } from './lib/audit-event.js';
```

Replace the closure block at lines 1399-1412:

```javascript
// OLD:
// let _auditLog;
// try { _auditLog = await cds.connect.to('audit-log'); } catch (err) { LOG.warn(...); }
// const auditEvent = async (action, data) => { ... };

// NEW:
let _auditLog;
try {
  _auditLog = await cds.connect.to('audit-log');
} catch (err) {
  LOG.warn(`admin-service: audit-log binding unavailable (${err.message ?? err}); Secrets value ops will not be audited`);
}
const auditEvent = createAuditEmitter(_auditLog, LOG);
```

- [ ] **Step 6: Run the full admin-service unit suite to confirm no regression**

```bash
npm test -- srv/admin-service
```

Expected: PASS (no regression — all existing audit calls still work because the helper preserves the `SecurityEvent` shape).

- [ ] **Step 7: Commit**

```bash
git add srv/lib/audit-event.js srv/admin-service.js test/unit/audit-event-lib.test.js
git commit -m "refactor(#617): extract audit-event helper to srv/lib/

Lifts the SecurityEvent emitter closure out of admin-service.js so
AuthorService can reuse it for TutorialRebuildTriggered events.
Behavior unchanged; helper preserves the existing { action, ...data }
shape under the SecurityEvent event name."
```

---

## Task 3: Extract the rebuild-action handler to a shared helper

**Files:**
- Create: `srv/lib/rebuild-action-handler.js`
- Modify: [srv/admin-service.js:1580-1612](../../../srv/admin-service.js#L1580) — replace inline handler with the helper.
- Test: `test/unit/rebuild-action-handler.test.js`

**Why now:** The admin rebuild handler at `srv/admin-service.js:1580` and the upcoming author rebuild handler differ only by the `source` string. Lifting the shared body avoids drift.

- [ ] **Step 1: Write the failing test**

Create `test/unit/rebuild-action-handler.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';
import { handleRebuildAction } from '../../srv/lib/rebuild-action-handler.js';

describe('handleRebuildAction', () => {
  const tutorialId = '00000000-0000-0000-0000-000000000001';

  function makeReq({ slug = 'my-tutorial', userId = 'alice' } = {}) {
    return {
      params: [{ ID: tutorialId }],
      user: { id: userId },
      reject: vi.fn((code, msg) => ({ rejected: { code, msg } })),
    };
  }

  it('rejects when the tutorial has no slug', async () => {
    const req = makeReq();
    const selectOne = vi.fn().mockResolvedValue({ slug: null, title: 'X' });
    const audit = vi.fn();
    const schedule = vi.fn();
    await handleRebuildAction(req, {
      source: 'admin-ui:tutorial-detail',
      selectOne, audit, schedule,
    });
    expect(req.reject).toHaveBeenCalledWith(400, expect.stringMatching(/slug/));
    expect(schedule).not.toHaveBeenCalled();
  });

  it('emits audit + dispatches with slug-targeted mode', async () => {
    const req = makeReq();
    const selectOne = vi.fn().mockResolvedValue({ slug: 'hello', title: 'Hello' });
    const audit = vi.fn().mockResolvedValue();
    const schedule = vi.fn().mockResolvedValue({ workflowUrl: 'https://gh/...' });

    const result = await handleRebuildAction(req, {
      source: 'author-ui:tutorial-detail',
      selectOne, audit, schedule,
    });

    expect(audit).toHaveBeenCalledWith('TutorialRebuildTriggered', {
      user: 'alice',
      tutorialId,
      slug: 'hello',
      source: 'author-ui:tutorial-detail',
    });
    expect(schedule).toHaveBeenCalledWith(
      'author-ui:rebuild-button:alice',
      { mode: 'slug-targeted', slug: 'hello' }
    );
    expect(result).toEqual({
      dispatched: true,
      slug: 'hello',
      debounced: expect.any(Boolean),
      workflowUrl: expect.any(String),
    });
  });

  it('defaults userId to "anonymous" when req.user is missing', async () => {
    const req = makeReq({ userId: undefined });
    const selectOne = vi.fn().mockResolvedValue({ slug: 'x', title: 'X' });
    const audit = vi.fn().mockResolvedValue();
    const schedule = vi.fn().mockResolvedValue({});
    await handleRebuildAction(req, {
      source: 'admin-ui:tutorial-detail',
      selectOne, audit, schedule,
    });
    expect(audit).toHaveBeenCalledWith(
      'TutorialRebuildTriggered',
      expect.objectContaining({ user: 'anonymous' })
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/rebuild-action-handler.test.js
```

Expected: FAIL (`handleRebuildAction` not defined).

- [ ] **Step 3: Implement the helper**

Create `srv/lib/rebuild-action-handler.js`:

```javascript
// Shared body for the rebuildContent bound action on AdminService.Tutorials and
// AuthorService.Tutorials (#617). Surfaces differ only by the `source` string;
// slug resolution, debounce, dispatch, and response shape are identical.

export async function handleRebuildAction(req, deps) {
  const { source, selectOne, audit, schedule } = deps;
  const tutorialId = req.params[0].ID;

  const row = await selectOne(tutorialId);
  if (!row?.slug) {
    return req.reject(400, 'Tutorial has no slug; cannot rebuild');
  }

  const userId = req.user?.id ?? 'anonymous';

  await audit('TutorialRebuildTriggered', {
    user: userId,
    tutorialId,
    slug: row.slug,
    source,
  });

  const dispatch = await schedule(
    `${source.split(':')[0]}:rebuild-button:${userId}`,
    { mode: 'slug-targeted', slug: row.slug }
  );

  return {
    dispatched: true,
    slug: row.slug,
    debounced: Boolean(dispatch?.debounced),
    workflowUrl: dispatch?.workflowUrl ?? '',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
npm test -- test/unit/rebuild-action-handler.test.js
```

Expected: PASS all three cases.

- [ ] **Step 5: Wire admin-service.js to use the helper**

In [srv/admin-service.js](../../../srv/admin-service.js):

Add `import { handleRebuildAction } from './lib/rebuild-action-handler.js';` near the existing imports.

Replace the body of `this.on('rebuildContent', 'Tutorials', ...)` (lines 1580-1612) with:

```javascript
this.on('rebuildContent', 'Tutorials', async (req) => {
  return handleRebuildAction(req, {
    source: 'admin-ui:tutorial-detail',
    selectOne: (id) => SELECT.one.from(Tutorials).columns('slug', 'title').where({ ID: id }),
    audit: auditEvent,
    schedule: scheduleRebuild,
  });
});
```

- [ ] **Step 6: Run the admin-service test suite to confirm no regression**

```bash
npm test -- srv/admin-service
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/rebuild-action-handler.js srv/admin-service.js test/unit/rebuild-action-handler.test.js
git commit -m "refactor(#617): extract shared rebuild-action handler"
```

---

## Task 4: Add `AuthorTutorialChanges` view

**Files:**
- Modify: [db/views.cds](../../../db/views.cds) — append the new view.

- [ ] **Step 1: Confirm the change-tracking entity name**

```bash
grep -rn "entity Changes\|namespace sap.changelog" node_modules/@cap-js/change-tracking/db 2>/dev/null | head -5
```

Verify `sap.changelog.Changes` is the canonical entity name. If different, adjust the view below.

- [ ] **Step 2: Append the view definition**

At the bottom of [db/views.cds](../../../db/views.cds):

```cds
using { sap.changelog.Changes } from '@cap-js/change-tracking';

// Tutorials-only slice of the change-tracking log for AuthorService (#617).
// Filters by the literal projection name 'AdminService.Tutorials' because
// @cap-js/change-tracking records the source service projection name on each
// row. If AdminService.Tutorials is ever renamed, this filter goes blank —
// caught via test/hybrid/617-author-changelog-filter.test.js.
view AuthorTutorialChanges as
  select from Changes
  where entity = 'AdminService.Tutorials';
```

- [ ] **Step 3: Compile the model to confirm no CDS errors**

```bash
npx cds compile srv/ --to json > /dev/null
```

Expected: no errors. On error, re-check the namespace import.

- [ ] **Step 4: Commit**

```bash
git add db/views.cds
git commit -m "feat(#617): add AuthorTutorialChanges view"
```

---

## Task 5: Widen AuthorService.cds with new projections + bound action

**Files:**
- Modify: [srv/author-service.cds](../../../srv/author-service.cds)
- Test: covered by Tasks 7-11 (one test per surface).

This task is CDS-only — adds the OData surface but no handlers yet. Handlers come in Task 6.

- [ ] **Step 1: Widen the `Tutorials` projection to full row**

In [srv/author-service.cds](../../../srv/author-service.cds), replace the existing 5-column `Tutorials` projection (around line 9):

Current:
```cds
@readonly entity Tutorials as projection on ims.Tutorials {
  ID, slug, title, primaryTag, status
};
```

New:
```cds
@Capabilities.ChangeTracking : { Supported: true }
@readonly entity Tutorials as projection on ims.Tutorials {
  *,
  cast(legacyId as String) as legacyIdStr : String
};
```

The wildcard `*` brings in all columns the admin Tutorials OP consumes. Existing consumers (lint rule, VS Code plugin) only read `ID`/`slug`/`title`/`primaryTag`/`status` — widening is backward compatible.

- [ ] **Step 2: Add Feedback projections**

Add to the same service body:

```cds
@readonly entity TutorialFeedback          as projection on ims.TutorialFeedback;
@readonly entity TutorialFeedbackAggregate as projection on ims.TutorialFeedbackAggregate;
```

- [ ] **Step 3: Add the Tutorials-only Changelog projection**

```cds
@readonly entity TutorialChanges as projection on ims.AuthorTutorialChanges;
```

Note: relies on the `AuthorTutorialChanges` view added in Task 4. Without that view this CDS won't compile.

- [ ] **Step 4: Add the curated Analytics projections (7 new entities)**

Adds **7 NEW projections** below (Tasks, CompletionAnalytics, ActiveLearnersDaily, TaskRecords, CodeCheckSubmissions, ValidateAnswerSubmissions, UIEvents). The Analytics surface ALSO includes **2 EXISTING** projections already on AuthorService (`AnalyticsBranchPerformance`, `AnalyticsBranchTopPick`) — do NOT re-add. The author Analytics tile reads from 9 entities total.

```cds
@readonly entity Tasks                  as projection on ims.Tasks;
@readonly entity CompletionAnalytics    as projection on ims.CompletionAnalytics;
@readonly entity ActiveLearnersDaily    as projection on ims.ActiveLearnersDaily;
@readonly entity TaskRecords            as projection on ims.TaskRecords;

@readonly entity CodeCheckSubmissions   as projection on ims.CodeCheckSubmissions {
  ID, tutorialSlug, stepNumber, language, verdict, modelName,
  promptTokens, completionTokens, latencyMs, errorReason,
  createdAt, modifiedAt, user
};

@readonly entity ValidateAnswerSubmissions as projection on ims.ValidateAnswerSubmissions {
  ID, tutorialSlug, stepNumber, questionId, verdict, modelName,
  promptVersion, promptTokens, completionTokens, latencyMs,
  errorReason, createdAt, modifiedAt, user
};

@readonly entity UIEvents as projection on ims.UIEvent;
```

The `AnalyticsBranchPerformance` and `AnalyticsBranchTopPick` projections already exist on AuthorService — don't re-add.

Add a cross-reference comment at the top of the analytics block:

```cds
// Curated analytics surface for the author Analytics tile (#617). Mirrors
// the corresponding AnalyticsService projections (srv/analytics-service.cds)
// minus the SQL ad-hoc playground (runSelectQuery is admin-only). The
// duplication is the unavoidable consequence of CAP's service-scoped
// @requires — same underlying ims.* views, two projections.
```

- [ ] **Step 5: Add `listExposedEntities` function**

Add to the same service body:

```cds
function listExposedEntities() returns array of {
  name    : String;
  sqlName : String;
  label   : String;
};
```

- [ ] **Step 6: Add the `rebuildContent` bound action**

At the END of the file (outside the `service AuthorService { ... }` block), add:

```cds
extend entity AuthorService.Tutorials with actions {
  @Core.OperationAvailable: true
  @Common.IsActionCritical : true
  action rebuildContent() returns AdminService.RebuildContentResult;
};
```

This references `AdminService.RebuildContentResult` directly (settled in spec § OData surface additions). Add this near the top of `author-service.cds` to make the cross-service type accessible:

```cds
using { AdminService } from './admin-service';
```

- [ ] **Step 7: Compile to verify**

```bash
npx cds compile srv/ --to json > /dev/null
```

Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add srv/author-service.cds
git commit -m "feat(#617): widen AuthorService with read-only author tiles + rebuild action

Adds projections for full Tutorials row, TutorialFeedback (+ aggregate),
TutorialChanges (Tutorials-only changelog), 7 curated Analytics entities,
listExposedEntities function, and rebuildContent bound action. Tutorials
projection widens from 5 columns to wildcard — backward compatible with
existing slug-driven consumers."
```

---

## Task 6: Implement AuthorService handlers (`rebuildContent` + `listExposedEntities`)

**Files:**
- Modify: [srv/author-service.js](../../../srv/author-service.js)
- Test: `test/unit/author-service-rebuild.test.js`, `test/unit/author-service-analytics.test.js`

- [ ] **Step 1: Write the failing rebuild test**

Create `test/unit/author-service-rebuild.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import cds from '@sap/cds';

vi.mock('../../srv/lib/rebuild-trigger.js', () => ({
  scheduleRebuild: vi.fn().mockResolvedValue({ debounced: false, workflowUrl: 'https://gh/run/1' }),
}));

describe('AuthorService.rebuildContent', () => {
  let POST, GET, server;

  beforeEach(async () => {
    ({ POST, GET, server } = await cds.test(__dirname + '/../../'));
    vi.clearAllMocks();
  });

  it('rejects unauthenticated callers (401)', async () => {
    const res = await fetch('http://localhost:4004/author/Tutorials(...)/AuthorService.rebuildContent', { method: 'POST' });
    expect([401, 403]).toContain(res.status);
  });

  it('dispatches with source=author-ui:tutorial-detail for a Tutorial.Author', async () => {
    // Insert a seeded tutorial; capture its ID
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const [{ ID }] = await INSERT.into(Tutorials).entries({ slug: 'auth-test', title: 'A', status: 'ACTIVE' });

    const res = await POST(`/author/Tutorials(${ID})/AuthorService.rebuildContent`, {}, {
      auth: { username: 'author', password: '' }
    });
    expect(res.status).toBe(200);
    expect(res.data).toMatchObject({ dispatched: true, slug: 'auth-test' });

    const { scheduleRebuild } = await import('../../srv/lib/rebuild-trigger.js');
    expect(scheduleRebuild).toHaveBeenCalledWith(
      'author-ui:rebuild-button:author',
      { mode: 'slug-targeted', slug: 'auth-test' }
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- test/unit/author-service-rebuild.test.js
```

Expected: FAIL (action not implemented).

- [ ] **Step 3: Write the failing listExposedEntities test**

Create `test/unit/author-service-analytics.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AuthorService analytics surface', () => {
  let GET;
  beforeAll(async () => { ({ GET } = await cds.test(__dirname + '/../../')); });

  it('listExposedEntities returns the curated subset', async () => {
    const res = await GET('/author/listExposedEntities()', { auth: { username: 'author', password: '' } });
    expect(res.status).toBe(200);
    const names = res.data.value.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining([
      'CompletionAnalytics', 'CodeCheckSubmissions',
      'ValidateAnswerSubmissions', 'ActiveLearnersDaily',
      'AnalyticsBranchPerformance', 'AnalyticsBranchTopPick',
      'Tasks', 'TaskRecords', 'UIEvents'
    ]));
  });

  it('does NOT expose runSelectQuery', async () => {
    const res = await GET('/author/$metadata', { auth: { username: 'author', password: '' } });
    expect(res.data).not.toMatch(/runSelectQuery/);
  });

  it('CompletionAnalytics is queryable as author', async () => {
    const res = await GET('/author/CompletionAnalytics?$top=1', { auth: { username: 'author', password: '' } });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

```bash
npm test -- test/unit/author-service-analytics.test.js
```

Expected: FAIL (`listExposedEntities` not implemented).

- [ ] **Step 5: Implement both handlers**

In [srv/author-service.js](../../../srv/author-service.js):

Add imports near the top:
```javascript
import { scheduleRebuild } from './lib/rebuild-trigger.js';
import { createAuditEmitter } from './lib/audit-event.js';
import { handleRebuildAction } from './lib/rebuild-action-handler.js';
```

Inside the `cds.service.impl(async function () { ... })` block, after `const { MyTutorials } = this.entities;`, add:

```javascript
const { Tutorials } = this.entities;

// Audit emitter — best-effort; tolerates missing binding in dev/mock-auth
let _auditLog;
try {
  _auditLog = await cds.connect.to('audit-log');
} catch (err) {
  cds.log('author-service').warn(
    `audit-log binding unavailable (${err.message ?? err}); rebuild events will not be audited`
  );
}
const auditEvent = createAuditEmitter(_auditLog, cds.log('author-service'));

// rebuildContent — symmetric with AdminService; differs only by source string
this.on('rebuildContent', 'Tutorials', async (req) => {
  return handleRebuildAction(req, {
    source: 'author-ui:tutorial-detail',
    selectOne: (id) => SELECT.one.from(Tutorials).columns('slug', 'title').where({ ID: id }),
    audit: auditEvent,
    schedule: scheduleRebuild,
  });
});

// listExposedEntities — curated subset for the analytics-explorer entity dropdown
this.on('listExposedEntities', () => [
  { name: 'CompletionAnalytics',      sqlName: 'com_sap_developers_ims_CompletionAnalytics',      label: 'Completion analytics' },
  { name: 'CodeCheckSubmissions',     sqlName: 'com_sap_developers_ims_CodeCheckSubmissions',     label: 'Code check submissions' },
  { name: 'ValidateAnswerSubmissions',sqlName: 'com_sap_developers_ims_ValidateAnswerSubmissions',label: 'Validation submissions' },
  { name: 'ActiveLearnersDaily',      sqlName: 'com_sap_developers_ims_ActiveLearnersDaily',      label: 'Active learners (daily)' },
  { name: 'AnalyticsBranchPerformance', sqlName: 'com_sap_developers_ims_AnalyticsBranchPerformance', label: 'Branch performance' },
  { name: 'AnalyticsBranchTopPick',   sqlName: 'com_sap_developers_ims_AnalyticsBranchTopPick',   label: 'Branch top pick' },
  { name: 'Tasks',                    sqlName: 'com_sap_developers_ims_Tasks',                    label: 'Tasks' },
  { name: 'TaskRecords',              sqlName: 'com_sap_developers_ims_TaskRecords',              label: 'Task records' },
  { name: 'UIEvents',                 sqlName: 'com_sap_developers_ims_UIEvent',                  label: 'UI events' },
]);
```

- [ ] **Step 6: Run both tests to verify they pass**

```bash
npm test -- test/unit/author-service-rebuild.test.js test/unit/author-service-analytics.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/author-service.js test/unit/author-service-rebuild.test.js test/unit/author-service-analytics.test.js
git commit -m "feat(#617): wire AuthorService rebuildContent + listExposedEntities handlers"
```

---

## Task 7: Author Tutorials read test

**Files:**
- Test: `test/unit/author-service-tutorials.test.js`

This task tests the widened Tutorials projection (Task 5) — verifies full-row read works under `Tutorial.Author`.

- [ ] **Step 1: Write the failing test**

Create `test/unit/author-service-tutorials.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AuthorService.Tutorials', () => {
  let GET;
  beforeAll(async () => {
    ({ GET } = await cds.test(__dirname + '/../../'));
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    // Seed one tutorial for the test
    await INSERT.into(Tutorials).entries({
      slug: 'author-read-test',
      title: 'Author Read Test',
      status: 'ACTIVE',
      primaryTag: 'software-product>sap-build',
    });
  });

  it('returns full-row shape for a Tutorial.Author principal', async () => {
    const res = await GET("/author/Tutorials?$filter=slug eq 'author-read-test'",
      { auth: { username: 'author', password: '' } });
    expect(res.status).toBe(200);
    const row = res.data.value[0];
    // Wildcard projection must expose more than the legacy 5 columns:
    expect(row).toHaveProperty('slug', 'author-read-test');
    expect(row).toHaveProperty('title');
    expect(row).toHaveProperty('status');
    expect(row).toHaveProperty('primaryTag');
    // Columns that the slim projection didn't expose:
    expect(row).toHaveProperty('createdAt');
    expect(row).toHaveProperty('modifiedAt');
  });

  it('rejects unauthenticated callers', async () => {
    const res = await fetch('http://localhost:4004/author/Tutorials?$top=1');
    expect([401, 403]).toContain(res.status);
  });

  it('rejects writes (PATCH) on the read-only projection', async () => {
    const { Tutorials } = cds.entities('com.sap.developers.ims');
    const [row] = await SELECT.from(Tutorials).where({ slug: 'author-read-test' });
    const res = await fetch(`http://localhost:4004/author/Tutorials(${row.ID})`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from('author:').toString('base64')
      },
      body: JSON.stringify({ title: 'Mutated' }),
    });
    expect([405, 403]).toContain(res.status);
  });
});
```

- [ ] **Step 2: Run test to verify it passes (Task 5 should have implemented this)**

```bash
npm test -- test/unit/author-service-tutorials.test.js
```

Expected: PASS all three cases. If the widened projection wasn't committed in Task 5, this test catches the regression.

- [ ] **Step 3: Commit**

```bash
git add test/unit/author-service-tutorials.test.js
git commit -m "test(#617): verify AuthorService.Tutorials read-only full-row projection"
```

---

## Task 8: Author Feedback + Changelog read tests

**Files:**
- Test: `test/unit/author-service-feedback.test.js`
- Test: `test/unit/author-service-changelog.test.js`

- [ ] **Step 1: Write the Feedback test**

Create `test/unit/author-service-feedback.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AuthorService.TutorialFeedback', () => {
  let GET;
  beforeAll(async () => {
    ({ GET } = await cds.test(__dirname + '/../../'));
    const { TutorialFeedback } = cds.entities('com.sap.developers.ims');
    await INSERT.into(TutorialFeedback).entries({
      tutorialSlug: 'feedback-test',
      rating: 5,
      comment: 'Great tutorial',
    });
  });

  it('TutorialFeedback is readable by Tutorial.Author', async () => {
    const res = await GET("/author/TutorialFeedback?$filter=tutorialSlug eq 'feedback-test'",
      { auth: { username: 'author', password: '' } });
    expect(res.status).toBe(200);
    expect(res.data.value.length).toBeGreaterThan(0);
  });

  it('TutorialFeedback rejects POST (read-only)', async () => {
    const res = await fetch('http://localhost:4004/author/TutorialFeedback', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Basic ' + Buffer.from('author:').toString('base64'),
      },
      body: JSON.stringify({ tutorialSlug: 'x', rating: 1 }),
    });
    expect([405, 403]).toContain(res.status);
  });

  it('TutorialFeedbackAggregate is readable', async () => {
    const res = await GET('/author/TutorialFeedbackAggregate?$top=1',
      { auth: { username: 'author', password: '' } });
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Write the Changelog test**

Create `test/unit/author-service-changelog.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AuthorService.TutorialChanges', () => {
  let GET;
  beforeAll(async () => {
    ({ GET } = await cds.test(__dirname + '/../../'));
    // Seed both Tutorials and Missions change rows
    const Changes = cds.entities('sap.changelog').Changes;
    await INSERT.into(Changes).entries(
      { entity: 'AdminService.Tutorials', entityKey: 't1', attribute: 'title', valueChangedFrom: 'A', valueChangedTo: 'B' },
      { entity: 'AdminService.Missions',  entityKey: 'm1', attribute: 'title', valueChangedFrom: 'C', valueChangedTo: 'D' },
    );
  });

  it('returns only Tutorials change rows (Missions filtered out)', async () => {
    const res = await GET('/author/TutorialChanges?$top=50',
      { auth: { username: 'author', password: '' } });
    expect(res.status).toBe(200);
    const entities = new Set(res.data.value.map((r) => r.entity));
    expect(entities.has('AdminService.Tutorials')).toBe(true);
    expect(entities.has('AdminService.Missions')).toBe(false);
  });
});
```

- [ ] **Step 3: Run both tests**

```bash
npm test -- test/unit/author-service-feedback.test.js test/unit/author-service-changelog.test.js
```

Expected: PASS all five cases.

- [ ] **Step 4: Commit**

```bash
git add test/unit/author-service-feedback.test.js test/unit/author-service-changelog.test.js
git commit -m "test(#617): cover Feedback read-only + Changelog Tutorials-only filter"
```

---

## Task 9: Hybrid tests (HANA round-trip)

**Files:**
- Test: `test/hybrid/617-author-tutorials.test.js`
- Test: `test/hybrid/617-author-rebuild.test.js` (gated by `HYBRID_DISPATCH_TESTS=true`)
- Test: `test/hybrid/617-author-changelog-filter.test.js`
- Test: `test/hybrid/617-author-analytics-surface.test.js`

These run only when `cf login` to DEV space and `cds bind --exec` are in place. They're the canonical proof points for HANA-specific behavior (LOB locator, raw SQL paths, sequence reset, etc.).

- [ ] **Step 1: Confirm hybrid test infrastructure**

```bash
ls test/hybrid/_guard.js test/hybrid/_helpers/ 2>/dev/null
cat test/hybrid/_guard.js | head -30
```

Note the conventions: every write test prefixes data with `__TEST__`, checks `ALLOW_HYBRID_WRITES=true`, and cleans up in `afterAll`.

- [ ] **Step 2: Write `617-author-tutorials.test.js`**

Mirror the structure of an existing hybrid test (e.g. `test/hybrid/385-pr3-authorservice.test.js`):

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { allowWrites, withTestClient } from './_helpers/index.js';

describe('AuthorService.Tutorials (HANA)', () => {
  let cleanup = [];
  beforeAll(() => allowWrites());

  afterAll(async () => { for (const fn of cleanup) await fn(); });

  it('returns full-row shape over real HANA', async () => {
    const client = await withTestClient({ role: 'Tutorial.Author' });
    const slug = '__TEST__author-617-' + Date.now();
    const ID = await client.insertTutorial({ slug, title: '__TEST__', status: 'ACTIVE' });
    cleanup.push(() => client.deleteTutorial(ID));

    const rows = await client.get(`/author/Tutorials?$filter=slug eq '${slug}'`);
    expect(rows.value[0]).toHaveProperty('createdAt');
    expect(rows.value[0]).toHaveProperty('modifiedAt');
  });
});
```

(The `withTestClient` helper may need to be extended to mint a `Tutorial.Author`-scoped JWT — note in the test file if that's a TODO.)

- [ ] **Step 3: Write `617-author-rebuild.test.js`** (gated)

```javascript
import { describe, it, expect } from 'vitest';
import { withTestClient } from './_helpers/index.js';

const DISPATCH = process.env.HYBRID_DISPATCH_TESTS === 'true';

describe.skipIf(!DISPATCH)('AuthorService.rebuildContent (gated)', () => {
  it('dispatches a slug-targeted rebuild with author-ui source', async () => {
    const client = await withTestClient({ role: 'Tutorial.Author' });
    const tutorial = await client.getOne('/author/Tutorials?$top=1');
    const res = await client.post(`/author/Tutorials(${tutorial.ID})/AuthorService.rebuildContent`, {});
    expect(res.dispatched).toBe(true);
    expect(res.slug).toBe(tutorial.slug);
    // Workflow URL points at GitHub Actions
    expect(res.workflowUrl).toMatch(/github\.com.*\/actions\/runs\//);
  });
});
```

- [ ] **Step 4: Write `617-author-changelog-filter.test.js`**

Insert one Tutorials change and one Missions change via direct SQL; verify the projection returns only the Tutorials one. Pattern:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { allowWrites, withTestClient } from './_helpers/index.js';

describe('AuthorService.TutorialChanges filter (HANA)', () => {
  const marker = '__TEST__617-' + Date.now();
  let client;
  beforeAll(async () => {
    allowWrites();
    client = await withTestClient({ role: 'Tutorial.Author' });
    await client.adminInsert('sap.changelog.Changes', [
      { entity: 'AdminService.Tutorials', entityKey: marker, attribute: 'title' },
      { entity: 'AdminService.Missions',  entityKey: marker, attribute: 'title' },
    ]);
  });
  afterAll(() => client.adminDeleteChangesBy({ entityKey: marker }));

  it('returns only Tutorials change rows', async () => {
    const rows = (await client.get(`/author/TutorialChanges?$filter=entityKey eq '${marker}'`)).value;
    expect(rows.length).toBe(1);
    expect(rows[0].entity).toBe('AdminService.Tutorials');
  });
});
```

- [ ] **Step 5: Write `617-author-analytics-surface.test.js`**

```javascript
import { describe, it, expect } from 'vitest';
import { withTestClient } from './_helpers/index.js';

describe('AuthorService analytics surface (HANA)', () => {
  it('CompletionAnalytics is readable as Tutorial.Author', async () => {
    const client = await withTestClient({ role: 'Tutorial.Author' });
    const res = await client.get('/author/CompletionAnalytics?$top=5');
    expect(Array.isArray(res.value)).toBe(true);
  });

  it('runSelectQuery is NOT exposed', async () => {
    const client = await withTestClient({ role: 'Tutorial.Author' });
    const res = await client.rawGet('/author/$metadata');
    expect(res).not.toMatch(/runSelectQuery/);
  });
});
```

- [ ] **Step 6: Run the hybrid suite**

```bash
cf login   # if not already
npm run test:hybrid -- 617-author
```

Expected: PASS the three non-gated tests. `617-author-rebuild` skipped unless `HYBRID_DISPATCH_TESTS=true`.

- [ ] **Step 7: Commit**

```bash
git add test/hybrid/617-author-*.test.js
git commit -m "test(#617): hybrid coverage for AuthorService read/rebuild surface"
```

---

## Task 10: Refactor admin-shell nav tree to data-bind from `navigation.json`

**Files:**
- Modify: [app/admin-shell/webapp/view/Shell.view.xml](../../../app/admin-shell/webapp/view/Shell.view.xml)
- Modify: [app/admin-shell/webapp/model/navigation.json](../../../app/admin-shell/webapp/model/navigation.json)

**Why now:** Step-by-step de-risk. Today the nav tree is hardcoded XML (49 `<tnt:NavigationListItem>`). To scope-gate it from JS we must first bind it to data. This task is a **pure refactor — zero behavior change**. Verify by visual diff: admin loads same tiles in same order.

- [ ] **Step 1: Capture the current nav tree in `navigation.json`**

Inspect the existing structure in [app/admin-shell/webapp/view/Shell.view.xml](../../../app/admin-shell/webapp/view/Shell.view.xml) (lines 74-110). Translate every `<tnt:NavigationListItem>` to a JSON entry. Update [app/admin-shell/webapp/model/navigation.json](../../../app/admin-shell/webapp/model/navigation.json) to include ALL current tiles. Example shape:

```jsonc
{
  "groups": [
    { "key": "dashboard", "title": "Tutorial Health", "icon": "sap-icon://monitor-payments" },
    {
      "key": "content", "title": "Content", "icon": "sap-icon://folder-blank", "expanded": true,
      "items": [
        { "key": "events",      "title": "Events" },
        { "key": "missions",    "title": "Missions" },
        { "key": "groups",      "title": "Groups" },
        { "key": "tutorials",   "title": "Tutorials" },
        { "key": "tags",        "title": "Tags" },
        { "key": "categories",  "title": "Categories" },
        { "key": "concepts",    "title": "Concepts" },
        { "key": "advocates",   "title": "Advocates" },
        { "key": "alerts",      "title": "Alerts", "icon": "sap-icon://notification-2" }
      ]
    },
    {
      "key": "rewards", "title": "Rewards", "icon": "sap-icon://present", "expanded": true,
      "items": [
        { "key": "accomplishments", "title": "Accomplishments" },
        { "key": "prizes",          "title": "Prizes" }
      ]
    },
    {
      "key": "feedback", "title": "Feedback", "icon": "sap-icon://feedback", "expanded": true,
      "items": [
        { "key": "feedbackList",      "title": "All Submissions" },
        { "key": "feedbackDashboard", "title": "Dashboard" }
      ]
    },
    {
      "key": "reporting", "title": "Reporting", "icon": "sap-icon://line-chart-time-axis", "expanded": true,
      "items": [
        { "key": "analyticsExternal", "title": "Analytics",           "icon": "sap-icon://bar-chart", "href": "/analytics-ui/", "target": "_self" },
        { "key": "analytics",         "title": "Completion analytics","icon": "sap-icon://line-chart" },
        { "key": "statistics",        "title": "Statistics" },
        { "key": "dataExport",        "title": "Data Export",         "icon": "sap-icon://download" }
      ]
    },
    {
      "key": "system", "title": "System", "icon": "sap-icon://action-settings", "expanded": true,
      "items": [
        // ... copy the System group from Shell.view.xml lines 100-119
      ]
    }
  ]
}
```

Cross-reference [Shell.view.xml](../../../app/admin-shell/webapp/view/Shell.view.xml) entries one by one. Don't omit any.

- [ ] **Step 2: Replace hardcoded XML nav with data-bound nav**

In [app/admin-shell/webapp/view/Shell.view.xml](../../../app/admin-shell/webapp/view/Shell.view.xml), replace the hardcoded `<tnt:NavigationList>` content (approximately lines 70-120) with:

```xml
<tnt:NavigationList items="{nav>/groups}">
  <tnt:NavigationListItem
      text="{nav>title}"
      icon="{nav>icon}"
      key="{nav>key}"
      expanded="{viewModel>/groupExpanded/{=${nav>key}}}"
      href="{nav>href}"
      target="{nav>target}"
      items="{nav>items}">
    <tnt:NavigationListItem
        text="{nav>title}"
        key="{nav>key}"
        icon="{nav>icon}"
        href="{nav>href}"
        target="{nav>target}" />
  </tnt:NavigationListItem>
</tnt:NavigationList>
```

Caveats:
- The `expanded` binding uses an expression to look up the right key in `viewModel>/groupExpanded`. If the binding syntax errors, fall back to `expanded="true"` on each group and surface as a follow-up.
- `href`/`target` are only used on the Analytics external link. Empty strings on other items render fine (UI5 falls back to standard navigation).

- [ ] **Step 3: Manually verify locally**

```bash
npm run dev:hybrid
# Open http://localhost:5000/admin-ui/ in browser
# Confirm the side nav shows the same tiles in the same order as before
# Click each top-level group: it should expand/collapse
# Click a tile (e.g. Tutorials): the route should navigate correctly
```

This is a **visual regression test**. If anything is missing or out of order, fix `navigation.json` (the data is the source of truth now).

- [ ] **Step 4: Commit**

```bash
git add app/admin-shell/webapp/view/Shell.view.xml app/admin-shell/webapp/model/navigation.json
git commit -m "refactor(#617): bind admin-shell nav tree to navigation.json

Hardcoded XML NavigationListItem entries replaced with a single
items={nav>/groups} binding. Zero behavior change for admins; sets
up scope-gating in the follow-up task by making the rendered nav
a function of data rather than static XML."
```

---

## Task 11: Add second OData dataSource + model in admin-shell manifest

**Files:**
- Modify: [app/admin-shell/webapp/manifest.json](../../../app/admin-shell/webapp/manifest.json)

- [ ] **Step 1: Add the `authorService` dataSource**

In [app/admin-shell/webapp/manifest.json](../../../app/admin-shell/webapp/manifest.json) under `sap.app.dataSources`:

```jsonc
"dataSources": {
  "adminService": {
    "uri": "/admin/",
    "type": "OData",
    "settings": { "odataVersion": "4.0" }
  },
  "authorService": {
    "uri": "/author/",
    "type": "OData",
    "settings": { "odataVersion": "4.0" }
  }
}
```

- [ ] **Step 2: Add the `author` model**

Under `sap.ui5.models`, after the existing `admin` model:

```jsonc
"author": {
  "dataSource": "authorService",
  "settings": {
    "synchronizationMode": "None",
    "operationMode": "Server",
    "autoExpandSelect": true,
    "earlyRequests": false
  }
}
```

- [ ] **Step 3: Sanity check the manifest parses**

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/manifest.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Commit**

```bash
git add app/admin-shell/webapp/manifest.json
git commit -m "feat(#617): add authorService dataSource + author model in admin-shell manifest"
```

---

## Task 12: Role detection + nav filter in Shell.controller.js

**Files:**
- Modify: [app/admin-shell/webapp/controller/Shell.controller.js](../../../app/admin-shell/webapp/controller/Shell.controller.js)
- Modify: [app/admin-shell/webapp/i18n/i18n.properties](../../../app/admin-shell/webapp/i18n/i18n.properties)
- Modify: [app/admin-shell/webapp/model/navigation.json](../../../app/admin-shell/webapp/model/navigation.json) — add `requiredScope` per entry.

- [ ] **Step 1: Add i18n strings**

In [app/admin-shell/webapp/i18n/i18n.properties](../../../app/admin-shell/webapp/i18n/i18n.properties):

```properties
consoleTitle.admin=Admin Console
consoleTitle.author=Author Console
consoleTitle.anonymous=No Access
documentTitle.admin=Admin Console
documentTitle.author=Author Console
documentTitle.anonymous=No Access
noAccess.heading=You don't have access to this console.
noAccess.body=This console requires the Admin or Tutorial.Author scope.
noAccess.requestAccess=Request access
```

- [ ] **Step 2: Add `requiredScope` to author-visible nav entries**

In [app/admin-shell/webapp/model/navigation.json](../../../app/admin-shell/webapp/model/navigation.json), add `"requiredScope": "Tutorial.Author"` to the 6 author-visible tiles:

- `dashboard` (Tutorial Health) — top-level item
- Inside `content` group: `tutorials`, `tags`
- New top-level group `feedback`: gate the GROUP entry itself with `requiredScope: 'Tutorial.Author'`, since its two children inherit visibility
- `changelog` (currently in `system` group — MOVE it into a new top-level `changelog` entry with `requiredScope` AND keep an admin-only deep copy in `system`? Better: keep it where it is and add `requiredScope` — admins still see it.)
- In `reporting`: `analyticsExternal`

For the simplest mental model: ANY entry without `requiredScope` is admin-only. Admins satisfy everything; authors satisfy only entries with `requiredScope: 'Tutorial.Author'`.

Apply the predicate from the spec:
```javascript
const keep = !entry.requiredScope
          || userRole === 'admin'
          || (userRole === 'author' && entry.requiredScope === 'Tutorial.Author');
```

**Concrete edits:** add `"requiredScope": "Tutorial.Author"` to `dashboard`, the `feedback` group, `tutorials`, `tags`, `changelog`, and `analyticsExternal`. Leave all other entries untouched.

- [ ] **Step 3: Extend `_loadUserProfile` to derive userRole**

In [app/admin-shell/webapp/controller/Shell.controller.js](../../../app/admin-shell/webapp/controller/Shell.controller.js), modify `_loadUserProfile` (line 250):

```javascript
_loadUserProfile: function () {
  var oViewModel = this.getView().getModel("viewModel");
  var that = this;
  fetch("/auth/user", { credentials: "include" })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (user) {
      if (!user || !user.authenticated) {
        oViewModel.setProperty("/userRole", "anonymous");
        that._applyRole("anonymous");
        return;
      }
      var sName = ((user.givenName || "") + " " + (user.familyName || "")).trim() || user.id || "";
      var sInitials = ((user.givenName || "")[0] || "") + ((user.familyName || "")[0] || "");
      if (!sInitials && user.id) sInitials = user.id[0];
      oViewModel.setProperty("/userName", sName);
      oViewModel.setProperty("/userEmail", user.email || "");
      oViewModel.setProperty("/userInitials", sInitials.toUpperCase());
      // #617 — derive role from auth claims
      var role = user.isAdmin  ? "admin"
               : user.isAuthor ? "author"
               : "anonymous";
      oViewModel.setProperty("/userRole", role);
      that._applyRole(role);
    })
    .catch(function () { that._applyRole("anonymous"); });
},

_applyRole: function (role) {
  var oI18n = this.getView().getModel("i18n").getResourceBundle();
  var oViewModel = this.getView().getModel("viewModel");
  oViewModel.setProperty("/consoleTitle", oI18n.getText("consoleTitle." + role));
  document.title = oI18n.getText("documentTitle." + role);

  if (role === "anonymous") {
    this.getOwnerComponent().getRouter().navTo("noAccess");
    return;
  }
  this._filterNavigationByRole(role);
},

_filterNavigationByRole: function (role) {
  var oNavModel = this.getOwnerComponent().getModel("nav");
  var data = oNavModel.getData();
  var keep = function (entry) {
    return !entry.requiredScope
        || role === "admin"
        || (role === "author" && entry.requiredScope === "Tutorial.Author");
  };
  var filtered = (data.groups || []).filter(keep).map(function (g) {
    if (!g.items) return g;
    return Object.assign({}, g, { items: g.items.filter(keep) });
  }).filter(function (g) {
    // Drop empty groups (e.g. an admin-only group whose items all get filtered)
    return !g.items || g.items.length > 0 || g.key === "dashboard";
  });
  oNavModel.setData({ groups: filtered });
},
```

- [ ] **Step 4: Bind the title in Shell.view.xml**

In [Shell.view.xml](../../../app/admin-shell/webapp/view/Shell.view.xml), find the shell title element (the `<f:DynamicPageTitle>` or `<tnt:ToolHeader>` text node) and change it to bind `{viewModel>/consoleTitle}` instead of the hardcoded "Admin Console" string.

```bash
grep -n "Admin Console" app/admin-shell/webapp/view/Shell.view.xml
```

Replace the matching node's text with `text="{viewModel>/consoleTitle}"`.

- [ ] **Step 5: Manual verification (no automated test for the controller)**

```bash
npm run dev:hybrid
# Test as admin:
#   - load /admin-ui/ — header reads "Admin Console", all tiles visible
# Test as author (requires a user with Tutorial.Author scope but NOT Admin):
#   - if no such user in your local mock seed, edit .cdsrc.json to add `"author": { "roles": ["Tutorial.Author"] }`
#   - load /admin-ui/ — header reads "Author Console", 6 tiles visible
# Test as anonymous:
#   - clear cookies; load /admin-ui/ — routes to /noAccess (NoAccess view doesn't exist yet — Task 13)
```

- [ ] **Step 6: Commit**

```bash
git add app/admin-shell/webapp/controller/Shell.controller.js \
        app/admin-shell/webapp/view/Shell.view.xml \
        app/admin-shell/webapp/i18n/i18n.properties \
        app/admin-shell/webapp/model/navigation.json
git commit -m "feat(#617): role-aware boot + nav filtering in admin-shell

Shell.controller.js derives userRole from /auth/user isAdmin/isAuthor
fields and filters navigation.json entries by requiredScope. Author
sees 6 tiles in 2 groups (Content, Reporting). Title binds to i18n
key consoleTitle.{role} so admin/author see distinct branding."
```

---

## Task 13: NoAccess view + route

**Files:**
- Create: `app/admin-shell/webapp/view/NoAccess.view.xml`
- Create: `app/admin-shell/webapp/controller/NoAccess.controller.js`
- Modify: [app/admin-shell/webapp/manifest.json](../../../app/admin-shell/webapp/manifest.json) — add `noAccess` route + target.

- [ ] **Step 1: Create the view**

Create `app/admin-shell/webapp/view/NoAccess.view.xml`:

```xml
<mvc:View
  controllerName="sap.tutorials.admin.shell.controller.NoAccess"
  xmlns="sap.m"
  xmlns:mvc="sap.ui.core.mvc"
  xmlns:layout="sap.ui.layout">
  <Page showHeader="false">
    <layout:VerticalLayout class="sapUiLargeMargin" width="100%">
      <Title text="{i18n>noAccess.heading}" level="H1" />
      <Text text="{i18n>noAccess.body}" class="sapUiMediumMarginTop" />
      <Link text="{i18n>noAccess.requestAccess}"
            href="mailto:tutorials-admin@example.sap?subject=Request%20Tutorial.Author%20access"
            class="sapUiMediumMarginTop" />
    </layout:VerticalLayout>
  </Page>
</mvc:View>
```

(The `mailto:` is a placeholder — Tom can adjust the target in a follow-up.)

- [ ] **Step 2: Create the controller**

Create `app/admin-shell/webapp/controller/NoAccess.controller.js`:

```javascript
sap.ui.define([
  "sap/ui/core/mvc/Controller"
], function (Controller) {
  "use strict";
  return Controller.extend("sap.tutorials.admin.shell.controller.NoAccess", {});
});
```

- [ ] **Step 3: Register the route + target in manifest.json**

In [app/admin-shell/webapp/manifest.json](../../../app/admin-shell/webapp/manifest.json) under `sap.ui5.routing.routes`, add:

```jsonc
{ "name": "noAccess", "pattern": "noAccess", "target": "noAccessTarget" }
```

Under `sap.ui5.routing.targets`, add:

```jsonc
"noAccessTarget": {
  "viewName": "NoAccess",
  "viewLevel": 1
}
```

Parse-check:

```bash
node -e "JSON.parse(require('fs').readFileSync('app/admin-shell/webapp/manifest.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 4: Manual verification**

```bash
npm run dev:hybrid
# Clear cookies / log out, then load /admin-ui/#/noAccess directly:
#   - Page renders the 403 heading + body + Request access link
```

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/view/NoAccess.view.xml \
        app/admin-shell/webapp/controller/NoAccess.controller.js \
        app/admin-shell/webapp/manifest.json
git commit -m "feat(#617): NoAccess interstitial for users without Admin or Tutorial.Author"
```

---

## Task 14: Per-tile OData model binding (author tiles → `author` model)

**Files:**
- Modify: [app/admin-shell/webapp/Component.js](../../../app/admin-shell/webapp/Component.js)
- Modify: per-tile authoritative source in [app/admin/](../../../app/admin/) (each tile lives at `app/admin/<name>/`; the admin-shell's `./components/<name>` resourceRoot is a build-time copy from there per [mta.yaml](../../../mta.yaml). Edit the source.).

**Context:** The shell loads tiles as `componentUsages` (lazy). Each tile component has its own `manifest.json` that may define a `default` OData model. For author-visible tiles, when `userRole === 'author'`, we need to point the component's data calls at `/author/` instead of `/admin/`.

There are two ways to do this cleanly:
1. **Tile-local manifest reads from `componentData`** — the shell passes `{ servicePath: '/author/' }` via `componentData`, the tile's `Component.js` rewrites its `default` model's URL at boot.
2. **Tile-local manifest declares two dataSources** — the shell instantiates the component pointing at the right one.

Approach 1 is simpler. Implement it for the **author-visible tiles only** (tutorials, tags, feedback, changelog).

- [ ] **Step 1: Identify author-visible tile components**

```bash
ls app/admin/{tutorials,tags,feedback,changelog} 2>/dev/null
cat app/admin/tutorials/webapp/manifest.json | head -40
```

Note how each tile's manifest declares its OData service path — that's what we need to make overridable.

- [ ] **Step 2: Extend Shell.controller.js to pass `servicePath` via componentData**

In the existing `_loadComponent` (or equivalent) helper in [Shell.controller.js](../../../app/admin-shell/webapp/controller/Shell.controller.js) — search for where `componentUsages` are instantiated — pass a `componentData` blob:

```bash
grep -n "createComponent\|componentUsages\|createUsage" app/admin-shell/webapp/controller/Shell.controller.js
```

Find the call site that creates the tile's component (likely uses `this.getOwnerComponent().createComponent({usage: ...})`). Add a `componentData` arg derived from the nav entry:

```javascript
var userRole = this.getView().getModel("viewModel").getProperty("/userRole");
var sNavKey  = sNavKeyForThisTile; // resolve from your existing flow
var oEntry   = this._lookupNavEntry(sNavKey);
var sPath    = (userRole === "author" && oEntry.authorPath) ? oEntry.authorPath
             : oEntry.adminPath || "/admin/";

var oUsage = this.getOwnerComponent().createComponent({
  usage: oEntry.usage,
  componentData: { servicePath: sPath, userRole: userRole }
});
```

If `oEntry.adminPath` / `oEntry.authorPath` aren't in `navigation.json` yet, add them — for tutorials, tags, feedback, changelog entries: `"adminPath": "/admin/"`, `"authorPath": "/author/"`. Tiles without these fields default to `/admin/`.

- [ ] **Step 3: Each author-visible tile reads `servicePath` from componentData**

For each of the four tile components (`tutorials`, `tags`, `feedback`, `changelog`), edit its `Component.js` `init` method:

```javascript
init: function () {
  // Allow the shell to override the OData service path for author callers (#617).
  var oData = this.getComponentData() || {};
  var sPath = oData.servicePath;
  if (sPath) {
    var oManifest = this.getManifestEntry("sap.app");
    if (oManifest && oManifest.dataSources && oManifest.dataSources.mainService) {
      oManifest.dataSources.mainService.uri = sPath;
    }
  }
  // ...existing init logic
  sap.ui.core.UIComponent.prototype.init.apply(this, arguments);
}
```

(Adjust `mainService` to whatever the actual dataSource key is in each tile's manifest.)

- [ ] **Step 4: Manual verification**

```bash
npm run dev:hybrid
# As an author (mock user with Tutorial.Author):
#   - Open /admin-ui/#/tutorials → list loads from /author/Tutorials
#   - Open browser DevTools Network: confirm GET /author/Tutorials request, not /admin/Tutorials
# As an admin:
#   - Open /admin-ui/#/tutorials → list loads from /admin/Tutorials (existing behavior)
```

- [ ] **Step 5: Commit**

```bash
git add app/admin-shell/webapp/controller/Shell.controller.js \
        app/admin/tutorials/webapp/Component.js \
        app/admin/tags/webapp/Component.js \
        app/admin/feedback/webapp/Component.js \
        app/admin/changelog/webapp/Component.js \
        app/admin-shell/webapp/model/navigation.json
git commit -m "feat(#617): per-tile OData URL routing based on userRole

Author-visible tile components accept a servicePath via componentData
and rewrite mainService.uri at init. Shell.controller passes
/author/ when userRole=author, /admin/ for admins. Admin behavior
unchanged."
```

---

## Task 15: Analytics-explorer role-awareness

**Files:**
- Create: `app/analytics-explorer/src/composables/useAuth.ts`
- Modify: [app/analytics-explorer/src/App.vue](../../../app/analytics-explorer/src/App.vue) (or the SQL-tab component)

- [ ] **Step 1: Create the auth composable**

Create `app/analytics-explorer/src/composables/useAuth.ts`:

```typescript
import { ref, computed } from 'vue';

type AuthUser = {
  authenticated: boolean;
  id: string;
  isAdmin: boolean;
  isAuthor: boolean;
  email?: string;
};

const user = ref<AuthUser | null>(null);
const loaded = ref(false);

export function useAuth() {
  async function load() {
    if (loaded.value) return;
    try {
      const res = await fetch('/auth/user', { credentials: 'include' });
      user.value = res.ok ? await res.json() : null;
    } catch {
      user.value = null;
    } finally {
      loaded.value = true;
    }
  }

  const userRole = computed<'admin' | 'author' | 'anonymous'>(() => {
    if (!user.value || !user.value.authenticated) return 'anonymous';
    if (user.value.isAdmin)  return 'admin';
    if (user.value.isAuthor) return 'author';
    return 'anonymous';
  });

  const servicePath = computed(() =>
    userRole.value === 'author' ? '/author/' : '/admin/analytics/'
  );

  return { user, userRole, servicePath, loaded, load };
}
```

- [ ] **Step 2: Wire role-awareness into App.vue (or the SQL tab component)**

```bash
grep -rn "SQL\|sql-tab\|runSelectQuery" app/analytics-explorer/src/ 2>/dev/null | head -10
```

Find the component that renders the SQL tab. Wrap it in a `v-if="userRole === 'admin'"` and, when hidden, render a banner:

```vue
<template>
  <!-- existing tabs and content -->
  <div v-if="userRole === 'author'" class="banner banner-info">
    Ad-hoc SQL queries are admin-only. Contact an admin to run a SELECT
    against curated analytics tables.
  </div>
  <SqlTab v-if="userRole === 'admin'" :service-path="servicePath" />
  <EntityBrowser :service-path="servicePath" />
</template>

<script setup lang="ts">
import { onMounted } from 'vue';
import { useAuth } from './composables/useAuth';

const { userRole, servicePath, load } = useAuth();
onMounted(load);
</script>
```

Adjust the EntityBrowser to source its entity list from `${servicePath}listExposedEntities()` rather than hardcoded `/admin/analytics/`.

- [ ] **Step 3: NoAccess gate for anonymous**

In `App.vue`, before rendering anything:

```vue
<div v-if="!loaded">Loading…</div>
<div v-else-if="userRole === 'anonymous'">
  <a href="/admin-ui/#/noAccess">No access — request Tutorial.Author scope.</a>
</div>
<div v-else>
  <!-- tabs / banner / explorer -->
</div>
```

- [ ] **Step 4: Build the analytics-explorer to confirm no compile errors**

```bash
npm run build:analytics-explorer
```

Expected: success.

- [ ] **Step 5: Manual verification**

```bash
npm run dev:hybrid
# As admin: /analytics-ui/ shows both Entity tab and SQL tab — SQL tab works
# As author: /analytics-ui/ shows Entity tab only, banner at top
# As anonymous: /analytics-ui/ shows the NoAccess link
```

- [ ] **Step 6: Commit**

```bash
git add app/analytics-explorer/src/composables/useAuth.ts app/analytics-explorer/src/App.vue
git commit -m "feat(#617): role-aware analytics-explorer

Adds useAuth composable; SQL tab hidden for authors with a banner
explaining why; entity-browser routes to /author/ for authors,
/admin/analytics/ for admins."
```

---

## Task 16: Approuter scope relax for `/admin-ui/` and `/analytics-ui/`

**Files:**
- Modify: [approuter/xs-app.json](../../../approuter/xs-app.json)

- [ ] **Step 1: Drop `scope` field from the two routes**

In [approuter/xs-app.json](../../../approuter/xs-app.json), find:

```jsonc
{
  "source": "^/admin-ui/(.*)$",
  "target": "/admin-ui/$1",
  "localDir": "static",
  "authenticationType": "xsuaa",
  "scope": "$XSAPPNAME.Admin"
}
```

Replace with:

```jsonc
{
  "source": "^/admin-ui/(.*)$",
  "target": "/admin-ui/$1",
  "localDir": "static",
  "authenticationType": "xsuaa"
  // #617 — Tile-level authorization enforced by AdminService (@requires Admin)
  // and AuthorService (@requires Tutorial.Author). The bundle is accepted by
  // any authenticated user; the shell renders NoAccess when the caller holds
  // neither scope. Bundle disclosure (admin-only tile code visible in network
  // traces) is accepted as a non-secret given the SAP-employee threat model.
}
```

Same change for `/analytics-ui/`.

- [ ] **Step 2: JSON parse check**

```bash
node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('ok')"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(#617): relax /admin-ui/ and /analytics-ui/ approuter scope

Drops scope:Admin from both routes so Tutorial.Author callers can
load the shared bundle. OData backends (@requires Admin on AdminService,
@requires Tutorial.Author on AuthorService) remain the trust boundary."
```

---

## Task 17: Smoke tests against deployed environment

**Files:**
- Create: `test/smoke/author-scope-routes.smoke.test.js`

Smoke tests run against deployed URLs. They run automatically after deploy in CI (per `deploy.yml`) and locally with `npm run test:smoke` when `SMOKE_BASE_URL` and `SMOKE_SRV_URL` are set.

- [ ] **Step 1: Inspect the smoke harness conventions**

```bash
ls test/smoke/
head -40 test/smoke/auth-enforcement.smoke.test.js  # or any existing smoke file
```

Note: the harness typically requires `SMOKE_AUTHOR_TOKEN` and `SMOKE_ADMIN_TOKEN` env vars carrying scope-specific JWTs. If those env vars aren't defined yet, this test adds an explicit `describe.skipIf(!process.env.SMOKE_AUTHOR_TOKEN)` guard so it doesn't trip CI for users who haven't configured it.

- [ ] **Step 2: Write the smoke test**

Create `test/smoke/author-scope-routes.smoke.test.js`:

```javascript
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const AUTHOR_TOKEN = process.env.SMOKE_AUTHOR_TOKEN;

describe.skipIf(!BASE || !AUTHOR_TOKEN)('#617 author scope routes (smoke)', () => {
  const headers = { authorization: `Bearer ${AUTHOR_TOKEN}` };

  it('GET /admin-ui/index.html returns 200', async () => {
    const res = await fetch(`${BASE}/admin-ui/index.html`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /admin/Tutorials returns 403', async () => {
    const res = await fetch(`${BASE}/admin/Tutorials?$top=1`, { headers });
    expect(res.status).toBe(403);
  });

  it('GET /author/Tutorials returns 200', async () => {
    const res = await fetch(`${BASE}/author/Tutorials?$top=1`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /admin/Missions returns 403', async () => {
    const res = await fetch(`${BASE}/admin/Missions?$top=1`, { headers });
    expect(res.status).toBe(403);
  });

  it('GET /analytics-ui/ returns 200', async () => {
    const res = await fetch(`${BASE}/analytics-ui/`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /author/CompletionAnalytics returns 200', async () => {
    const res = await fetch(`${BASE}/author/CompletionAnalytics?$top=1`, { headers });
    expect(res.status).toBe(200);
  });

  it('GET /auth/user returns isAuthor:true', async () => {
    const res = await fetch(`${BASE}/auth/user`, { headers });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.isAuthor).toBe(true);
  });
});
```

- [ ] **Step 3: Run smoke tests locally (optional, requires tokens)**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_AUTHOR_TOKEN=<JWT> \
npm run test:smoke -- author-scope-routes
```

Expected: PASS all seven cases (or all SKIPPED if tokens not provided).

- [ ] **Step 4: Commit**

```bash
git add test/smoke/author-scope-routes.smoke.test.js
git commit -m "test(#617): smoke coverage for Tutorial.Author scope routes"
```

---

## Task 18: Open PR

**Files:** None — process step.

**Deploy authorization checkpoint:** Before opening the PR, confirm with Tom whether the smoke tests should run against an existing DEV deploy or whether a fresh deploy needs to be queued. Smoke tests pass-or-fail depends on whether the changes are deployed. Per memory `feedback_confirm_deploy_scope` and `feedback_merge_is_not_deploy`: merging the PR does NOT auto-deploy; the maintainer triggers MTA deploy explicitly. Don't kick off the deploy yourself unless authorized.

- [ ] **Step 1: Confirm everything is committed**

```bash
git status --short
```

Expected: clean working tree.

- [ ] **Step 2: Run the full unit suite one more time**

```bash
npm test
```

Expected: all green. If anything fails, fix before opening the PR.

- [ ] **Step 3: Run the hybrid suite once (with `cf login` to DEV)**

```bash
cf login
npm run test:hybrid -- 617-author
```

Expected: all green (rebuild dispatch test skipped unless `HYBRID_DISPATCH_TESTS=true`).

- [ ] **Step 4: Push the branch and open the PR**

```bash
git push -u origin worktree-spec-617-author-tiles
gh pr create --title "feat(#617): broaden Tutorial.Author access to admin-shell tiles" \
  --body "$(cat <<'EOF'
Closes #617.

## Summary

Lets Tutorial.Author scope holders use a curated 6-tile subset of `/admin-ui/`:
- Tutorial Health (read)
- Tutorials (read + per-tutorial Rebuild action)
- Tags (read)
- Tutorial Feedback (read)
- Tutorials-only Changelog (read)
- Analytics (entity browser; SQL tab admin-only)

Authorization is scope-based, not row-based. Any Tutorial.Author sees the whole catalog (symmetric with /tutorials-qa/*).

## Architecture

- One bundle (`app/admin-shell`), two roles. Shell filters tiles by `requiredScope` from `/auth/user.isAuthor`/`isAdmin`.
- New AuthorService projections re-project the entities authors need. /author/ replaces /admin/ as the data source for author-visible tiles.
- /admin-ui/ and /analytics-ui/ approuter routes accept either scope; OData backends remain the trust boundary.

## Verification

- [ ] Smoke-tested as admin: 26 tiles, "Admin Console" title.
- [ ] Smoke-tested as author: 6 tiles in 2 groups, "Author Console" title.
- [ ] Rebuild from author UI: workflow_dispatch fires with source=author-ui:tutorial-detail.
- [ ] Analytics: entity tab works for authors, SQL tab hidden + banner shown.
- [ ] Anonymous: NoAccess view rendered.

## Spec / plan

- Spec: docs/superpowers/specs/2026-06-26-617-author-admin-tile-broadening-design.md
- Plan: docs/superpowers/plans/2026-06-26-617-author-admin-tile-broadening.md

## Out of scope (deferred)

- Per-row ownership filtering
- "My tutorials" filter UX
- Author write actions beyond rebuild (no Tag edits, no Feedback moderation)
- Separate author-shell bundle
- New XSUAA scope (reuses Tutorial.Author)
EOF
)"
```

- [ ] **Step 5: Tag the PR with the right labels**

```bash
gh pr edit --add-label "enhancement,backend,frontend,security"
```

---

## Post-merge checklist (not in the plan tasks; for the deploy operator)

Once merged and ready to deploy:

1. **Confirm DEV deploy scope with Tom** (memory: feedback_confirm_deploy_scope).
2. **`cf target` first** (memory: feedback_cf_target_before_push).
3. **Build first, then deploy:** `npm run build:all && cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f`
4. **After deploy, hit the smoke test with author + admin tokens.**
5. **Assign Tutorial.Author scope to a test author user in BTP cockpit role-collections** to confirm UX matches expectations.

---

## Final cleanup checklist

Once the PR is merged:

- [ ] Pull main in the primary tree (`cd D:/projects/tutorials-poc && git pull origin main`)
- [ ] Exit + remove this worktree (`ExitWorktree action: 'remove'`)
- [ ] Close issue #617 (or wait for `Closes #617` keyword to auto-close on merge)
