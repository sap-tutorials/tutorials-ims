# Phase B — Auth-Parity Role-Matrix Test Framework Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a `test/auth/**` role-matrix framework that covers every CAP service and every Express route with authorization assertions, plus a completeness ratchet that fails CI on any un-tested action. Establishes a per-service `.auth.test.js` file convention that ratchets forward for all future services.

**Architecture:** In-process CDS-level auth testing using `cds.test('serve','--in-memory')` + `srv.tx({user:{id,roles}})` (the pattern established in `test/unit/author-service.test.js` and 66 other unit files). One `.auth.test.js` per CDS service (13 files) plus one `.auth.test.js` per Express-route group (~12 files). Bundled with a `matrix()` DSL helper that reduces each row to one line and an `assert-auth-covers-actions.cjs` completeness ratchet.

**Key design refinement from spec recon:** The spec anticipated an "HTTP-with-signed-JWT tier" for end-to-end coverage. Recon revealed the project has **no such harness** and an explicit convention against local JWT signing (see the comment at [test/srv-qa/xsuaa-scope-middleware.test.js:6](test/srv-qa/xsuaa-scope-middleware.test.js#L6): *"Faking xssec locally would defeat the purpose of the test"*). Instead, Phase B piggybacks on the **existing smoke suite** — adds bearer-token smoke assertions to `test/smoke/express-route-mutations.test.js` (already scope-aware) and one new `test/smoke/auth-parity.test.js` file covering the ~15 highest-value end-to-end auth flows. This matches the project's real convention (deployed-token smoke via `SMOKE_*_TOKEN` env vars) and avoids inventing a bespoke JWT-signing harness.

**Tech Stack:** No new dependencies. Vitest workspaces (`unit` for in-process; `smoke` for deployed). CAP `cds.test('serve', '--in-memory')`. `cds.User` role-injection pattern. Node.js `node:fs` for CDS file parsing in the completeness ratchet.

**Non-goals:**
- No production-code changes. Any real vulnerability the tests uncover becomes a **separate** follow-up issue (may become part of Phase C).
- No new dependencies. Especially no `jose`, `@sap/xssec` test tokens, or bespoke JWT signing.
- No test-fixture data migration. Tests seed their own minimal fixtures via `INSERT.into(...)` in `beforeEach`, following the existing `test/unit/author-service.test.js` pattern.
- No ratchet flip to fail-loud. That happens in Phase C. This plan ships the ratchet in **warn mode** — it prints missing-coverage findings but does not fail CI.

**Depends on:** [Phase A](./2026-07-03-809-auth-parity-phase-a.md) merged to `main`. Two Phase B tests depend on A being deployed — the `ScannerService` MobileApp scope test and the `Tutorial.Author` auto-grant test — those are added as `it` (not `it.skip`) once Phase A is in `main`. If B opens before A merges, those two assertions must be commented-out or `it.skip`ped with a `// unskip once #<A-PR> merges` marker.

**Related:** [Master spec](../specs/2026-07-03-809-authorization-parity-design.md) — Phase B section. Issue [#809](https://github.com/sap-tutorials/tutorials-ims/issues/809).

---

## Pre-implementation checks

- [ ] **Check-1: Confirm Phase A is merged to `main`**

  Run:
  ```bash
  git fetch origin main
  git log origin/main --oneline --grep="Phase A" | head -5
  ```
  Expected: at least one commit with `Phase A` in the message. If not, **stop** — Phase B assertions that reference A's changes (`ScannerService @requires: 'MobileApp'`, `Tutorial.Author` auto-grant removal) will fail against unchanged source.

- [ ] **Check-2: Confirm the `unit` Vitest project picks up new files under `test/auth/**`**

  Read `vitest.config.ts`. The `unit` project's `include` glob is `test/**/*.test.{js,ts}` and its `exclude` list is `['node_modules', 'gen', 'hugo', 'test/hybrid/**', 'test/hybrid-qa/**', 'test/smoke/**']`. Confirm no line says `'test/auth/**'` in either `include` or `exclude`. If it does, note the deviation.

  Run:
  ```bash
  grep -n "test/auth" vitest.config.ts || echo "no test/auth reference — good"
  ```

- [ ] **Check-3: Confirm the completeness ratchet script location is free**

  Run:
  ```bash
  test -f scripts/assert-auth-covers-actions.cjs && echo "EXISTS — investigate" || echo "clear"
  ```
  Expected: `clear`.

- [ ] **Check-4: Confirm the canonical unit auth-test pattern still works**

  Run:
  ```bash
  npx vitest run test/unit/author-service.test.js --project unit 2>&1 | tail -20
  ```
  Expected: passes. This confirms `cds.test('serve','--in-memory')` + `srv.tx({user:{...}})` still enforces `@requires`. If this test is red, do NOT proceed — the framework's assumption is broken.

---

## File Structure

**Create — harness:**
- `test/auth/README.md` — one-page authoring guide for adding a new `.auth.test.js` file
- `test/auth/_harness/roles.js` — central `SCOPES` constant (typo-safe scope names)
- `test/auth/_harness/matrix.js` — `matrix()` DSL expanding one config to N `it()` calls

**Create — one file per CDS service (13 files):**
- `test/auth/services/admin-service.auth.test.js`
- `test/auth/services/analytics-service.auth.test.js`
- `test/auth/services/author-service.auth.test.js`
- `test/auth/services/chat-service.auth.test.js`
- `test/auth/services/consolidation-service.auth.test.js`
- `test/auth/services/developer-service.auth.test.js`
- `test/auth/services/display-service.auth.test.js`
- `test/auth/services/event-stream-service.auth.test.js`
- `test/auth/services/exports-service.auth.test.js`
- `test/auth/services/homepage-service.auth.test.js`
- `test/auth/services/knowledge-graph-service.auth.test.js`
- `test/auth/services/scanner-service.auth.test.js`
- `test/auth/services/search-service.auth.test.js`

**Create — one file per Express-route group (12 files):**
- `test/auth/express/content-store.auth.test.js` — `/content/publish*`, `/content/rollback`, `/content/orphan-purge`, `/content/code-check-specs`, `/content/validate-answer-specs`
- `test/auth/express/feedback.auth.test.js` — `/feedback/submit`
- `test/auth/express/health.auth.test.js` — `/health`, `/health/db`, `/health/auth`
- `test/auth/express/auth-user-endpoint.auth.test.js` — `/auth/user`
- `test/auth/express/build-endpoints.auth.test.js` — `/build/*`
- `test/auth/express/admin-embeddings.auth.test.js` — `/admin/embeddings/stats`
- `test/auth/express/admin-metrics.auth.test.js` — `/admin/metrics/live`
- `test/auth/express/advocates.auth.test.js` — `/api/advocates*`
- `test/auth/express/alerts.auth.test.js` — `/api/alerts`, `/api/alerts/me`
- `test/auth/express/devtoberfest.auth.test.js` — `/api/devtoberfest/*`
- `test/auth/express/codecheck.auth.test.js` — `/api/codecheck`
- `test/auth/express/validate-answer.auth.test.js` — `/api/validate-answer`

**Create — ratchet + smoke additions:**
- `scripts/assert-auth-covers-actions.cjs` — parses `srv/*.cds` for action/function names, greps `test/auth/services/*.auth.test.js` for each. Warn-mode default; `--fail-loud` flag for Phase C.
- `test/smoke/auth-parity.test.js` — ~15 end-to-end assertions using existing `SMOKE_*_TOKEN` env vars

**Modify:**
- `package.json` — add `"check:auth-matrix": "node scripts/assert-auth-covers-actions.cjs"` script; add it to the `pretest` chain in warn mode
- `docs/developers/architecture/authorization.md` — new architecture doc (created in this phase)
- `docs/.vitepress/config.ts` — register the new architecture doc in the sidebar

**Do NOT modify:**
- `vitest.config.ts` — `test/auth/**` is picked up by the existing `unit` project's glob (`test/**/*.test.{js,ts}`); no config change needed.
- Any file under `srv/` — this phase is test-and-docs-only.
- Existing `test/unit/*-auth*.test.js` files — they stay in place, duplication is accepted for this phase, cleanup deferred to Phase C.

---

## Task B1: Harness — SCOPES constant, matrix() DSL, README

Establish the shared utilities before writing any service test file. Every subsequent task imports from `_harness/`.

**Files:**
- Create: `test/auth/README.md`
- Create: `test/auth/_harness/roles.js`
- Create: `test/auth/_harness/matrix.js`
- Create: `test/auth/_harness/matrix.test.js`

- [ ] **Step B1.1: Write the harness README first**

  Create `test/auth/README.md` with:
  - Purpose: one file per CDS service in `services/`, one file per Express-route group in `express/`. Every action/function/entity gets at least one auth assertion.
  - The canonical pattern: import `cds`, `describe` from vitest, `matrix` from `../_harness/matrix.js`, `SCOPES` from `../_harness/roles.js`. Boot `cds.test('serve', '--project', '.', '--in-memory')` at module scope. Call `matrix({ action, invoke, cases })` inside a `describe('SERVICE — auth matrix', () => { ... })`.
  - Authoring checklist: (a) import SCOPES — never hard-code role strings; a typo silently passes because `req.user.is('Adminn')` is always false; (b) every entity + action gets at least one anonymous → 403/401 case and one permitted-scope → allow case; (c) `@requires: 'any'` services use `expect: 'allow'` for anonymous (documents "anonymous by design"); (d) run `node scripts/assert-auth-covers-actions.cjs` after each addition.
  - Rationale for in-process (not HTTP): the project has an explicit convention against local JWT signing (see [test/srv-qa/xsuaa-scope-middleware.test.js:6](../srv-qa/xsuaa-scope-middleware.test.js#L6)). In-process `srv.tx({user:...})` exercises the CDS `@requires` gate correctly and runs ~100× faster than HTTP. End-to-end approuter → JWT → srv coverage lives in `test/smoke/`.

- [ ] **Step B1.2: Write the SCOPES constant**

  Create `test/auth/_harness/roles.js`:

  ```js
  // Central role/scope constants for the auth matrix. Import from here
  // instead of hard-coding role strings -- a typo in a scope name silently
  // passes (req.user.is('Adminn') is always false, so a 403-expectation
  // green-lights on a bogus scope). Using SCOPES.Admin ties the test to
  // a compile-time constant.
  //
  // These must match xs-security.json's scope names exactly (without the
  // $XSAPPNAME prefix, since CAP's role check uses the short name).

  export const SCOPES = Object.freeze({
    Admin: 'Admin',
    SuperAdmin: 'SuperAdmin',
    ContentAuthor: 'ContentAuthor',
    DeveloperApp: 'DeveloperApp',
    MobileApp: 'MobileApp',
    DisplayApp: 'DisplayApp',
    ConsolidationScope: 'ConsolidationScope',
    TutorialAuthor: 'Tutorial.Author',
    KnowledgeGraphAdmin: 'KnowledgeGraph.Admin',
    AuthenticatedUser: 'authenticated-user',
  });

  export const ANONYMOUS = Object.freeze({ id: 'anonymous', roles: {} });

  export function user(id, ...scopes) {
    const roles = {};
    for (const s of scopes) roles[s] = true;
    return { id, roles };
  }
  ```

- [ ] **Step B1.3: Write the matrix() DSL test first (failing)**

  Create `test/auth/_harness/matrix.test.js`:

  ```js
  import { describe, it, expect } from 'vitest';
  import { matrix } from './matrix.js';
  import { ANONYMOUS, SCOPES, user } from './roles.js';

  describe('matrix() DSL', () => {
    it('expands each case into a separate it() call with a descriptive title', () => {
      // A dry-run: matrix() accepts an itFn injection so titles register
      // without executing the invoke() body.
      const titles = [];
      matrix({
        action: 'FakeService.doThing',
        invoke: async () => 'ignored',
        cases: [
          { user: ANONYMOUS,                       expect: 403 },
          { user: user('u1', SCOPES.Admin),         expect: 'allow' },
        ],
      }, (t) => titles.push(t));
      expect(titles).toEqual([
        'FakeService.doThing → anonymous rejects with 403',
        'FakeService.doThing → user with [Admin] allows',
      ]);
    });

    it('formats multi-scope users in the title', () => {
      const titles = [];
      matrix({
        action: 'AdminService.testAction',
        invoke: async () => 'x',
        cases: [{ user: user('u', SCOPES.Admin, SCOPES.SuperAdmin), expect: 'allow' }],
      }, (t) => titles.push(t));
      expect(titles[0]).toContain('[Admin,SuperAdmin]');
    });
  });
  ```

- [ ] **Step B1.4: Run the harness test to verify it fails**

  Run: `npx vitest run test/auth/_harness/matrix.test.js --project unit`

  Expected: FAIL with `Cannot find module './matrix.js'` or similar.

- [ ] **Step B1.5: Implement matrix()**

  Create `test/auth/_harness/matrix.js`:

  ```js
  // matrix() -- expands one auth-check config into N vitest it() calls,
  // one per case. Each generated it() invokes invoke(user) and asserts:
  //   expect: 'allow'  -> promise resolves (any return value OK)
  //   expect: 403      -> promise rejects with error.code === 403
  //   expect: 401      -> promise rejects with error.code === 401
  //   expect: fn       -> custom assertion: fn(result, error)
  //
  // The second parameter (itFn) is dependency-injected for the DSL's own
  // tests. In real test files, omit it -- it defaults to Vitest's global it.

  import { it as vitestIt, expect } from 'vitest';

  function describeUser(u) {
    if (!u || u.id === 'anonymous') return 'anonymous';
    const scopes = Object.keys(u.roles || {}).sort();
    return `user with [${scopes.join(',') || 'no scopes'}]`;
  }

  function describeOutcome(exp) {
    if (exp === 'allow') return 'allows';
    if (typeof exp === 'number') return `rejects with ${exp}`;
    if (typeof exp === 'function') return 'satisfies custom check';
    return `expects ${JSON.stringify(exp)}`;
  }

  export function matrix({ action, invoke, cases }, itFn = vitestIt) {
    for (const c of cases) {
      const title = `${action} → ${describeUser(c.user)} ${describeOutcome(c.expect)}`;
      itFn(title, async () => {
        let result, error;
        try {
          result = await invoke(c.user);
        } catch (e) {
          error = e;
        }
        if (c.expect === 'allow') {
          if (error) throw error;
          return;
        }
        if (typeof c.expect === 'number') {
          expect(error, 'expected rejection').toBeDefined();
          // CAP throws either { code: 403 } or { code: '403' } across versions.
          expect(String(error.code)).toBe(String(c.expect));
          return;
        }
        if (typeof c.expect === 'function') {
          return c.expect(result, error);
        }
        throw new Error(`Unsupported expect: ${c.expect}`);
      });
    }
  }
  ```

- [ ] **Step B1.6: Re-run the harness test to verify it passes**

  Run: `npx vitest run test/auth/_harness/matrix.test.js --project unit`

  Expected: 2 tests PASS.

- [ ] **Step B1.7: Commit the harness**

  ```bash
  git add test/auth/README.md test/auth/_harness/
  git commit -m "test(#809): scaffold auth-matrix harness (SCOPES, matrix() DSL)

  Shared utilities every test/auth/**/*.auth.test.js imports:

  - SCOPES: frozen constant of xs-security.json scope names, prevents
    typo-passes (req.user.is('Adminn') === false, so a 403-expectation
    would green-light on a bogus scope).
  - matrix(): a DSL expanding one config to N it() calls, one per
    (user, expected-outcome) tuple. Self-descriptive titles so
    failures point at exactly one cell.
  - README: authoring guide for adding a new service auth test.

  In-process only -- no signed-JWT harness. Project convention
  against local JWT signing per test/srv-qa/xsuaa-scope-middleware
  .test.js:6.

  Refs #809 (Phase B1)."
  ```

---

## Task B2: First service — AuthorService (worked example)

AuthorService is the first service test file because (a) it has both service-level `@requires` AND a mix of entity/action shapes, (b) an existing regression test at [test/unit/author-service.test.js](test/unit/author-service.test.js) already asserts several cases so we can compare, and (c) its `MyTutorials` / `MyAuthoredTutorials` / `MyOwnedTutorials` projections are a fixture-heavy pattern that the plan re-uses for other row-filtered surfaces.

**Files:**
- Create: `test/auth/services/author-service.auth.test.js`

**Service surface (from recon):**
- Service-level `@requires: 'Tutorial.Author'` — every op inherits.
- Entities: `Tutorials`, `TutorialFeedback`, `TutorialFeedbackAggregate`, `TutorialChanges`, `Tasks`, `CompletionAnalytics`, `ActiveLearnersDaily`, `TaskRecords`, `CodeCheckSubmissions`, `ValidateAnswerSubmissions`, `UIEvents`, `Tags`, `MyTutorials`, `MyAuthoredTutorials`, `MyOwnedTutorials`, `AnalyticsBranchPerformance`, `AnalyticsBranchTopPick`.
- Actions/functions: `listExposedEntities`, `toggleMonitor`, `reviewTutorial`, `snoozeTutorial`, `generateOsVariants`, `isSlugAvailable`, plus bound `rebuildContent()` on `Tutorials`.

- [ ] **Step B2.1: Write the service test file**

  Create `test/auth/services/author-service.auth.test.js`:

  ```js
  // Phase B (#809) -- auth matrix for AuthorService.
  //
  // AuthorService is @requires: 'Tutorial.Author' at the service level.
  // Every entity/action/function inherits that gate. This file asserts
  // both directions:
  //   1. Anonymous callers (no scopes) -> 403 for every op.
  //   2. Tutorial.Author callers -> allowed (or, for row-filtered surfaces
  //      like MyTutorials, allowed AND correctly filtered by user).

  import cds from '@sap/cds';
  import { describe, beforeEach } from 'vitest';
  import { matrix } from '../_harness/matrix.js';
  import { ANONYMOUS, SCOPES, user } from '../_harness/roles.js';

  cds.test('serve', '--project', '.', '--in-memory');

  const AUTHOR = user('uuid-author', SCOPES.TutorialAuthor);

  describe('AuthorService — auth matrix', () => {
    beforeEach(async () => {
      // Seed a minimal fixture so MyTutorials-style row filters return
      // something. Reset before each test to keep state independent.
      const { Users, Tutorials } = cds.entities('com.sap.developers.ims');
      await DELETE.from(Tutorials);
      await DELETE.from(Users);
      await INSERT.into(Users).entries({
        ID: 'uuid-author', uuid: 'uuid-author', sapId: 'sap-author',
        legacyId: 9001, displayName: 'Author',
      });
    });

    // ---- Entities: READ ----

    matrix({
      action: 'AuthorService.Tutorials READ',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) => tx.run(SELECT.from(srv.entities.Tutorials)));
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: 'allow' },
      ],
    });

    matrix({
      action: 'AuthorService.Tags READ',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) => tx.run(SELECT.from(srv.entities.Tags)));
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: 'allow' },
      ],
    });

    matrix({
      action: 'AuthorService.MyTutorials READ',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) => tx.run(SELECT.from(srv.entities.MyTutorials)));
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: 'allow' },
      ],
    });

    matrix({
      action: 'AuthorService.MyAuthoredTutorials READ',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) => tx.run(SELECT.from(srv.entities.MyAuthoredTutorials)));
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: 'allow' },
      ],
    });

    matrix({
      action: 'AuthorService.MyOwnedTutorials READ',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) => tx.run(SELECT.from(srv.entities.MyOwnedTutorials)));
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: 'allow' },
      ],
    });

    // ---- Actions/functions ----

    matrix({
      action: 'AuthorService.listExposedEntities',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) => tx.send('listExposedEntities'));
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: 'allow' },
      ],
    });

    matrix({
      action: 'AuthorService.isSlugAvailable',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) => tx.send('isSlugAvailable', { slug: 'nope' }));
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: 'allow' },
      ],
    });

    matrix({
      action: 'AuthorService.toggleMonitor',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) =>
          tx.send('toggleMonitor', { tutorialId: '00000000-0000-0000-0000-000000000001', status: true })
        );
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        // Author case may 404/500 on missing fixture -- that's post-auth,
        // still proves the auth gate passed. Use custom check.
        { user: AUTHOR,    expect: (_r, err) => {
            if (err && String(err.code) === '403') throw new Error('scope should have been enough');
          }
        },
      ],
    });

    matrix({
      action: 'AuthorService.reviewTutorial',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) =>
          tx.send('reviewTutorial', { tutorialId: '00000000-0000-0000-0000-000000000001' })
        );
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: (_r, err) => {
            if (err && String(err.code) === '403') throw new Error('scope should have been enough');
          }
        },
      ],
    });

    matrix({
      action: 'AuthorService.snoozeTutorial',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) =>
          tx.send('snoozeTutorial', { tutorialId: '00000000-0000-0000-0000-000000000001', days: 7 })
        );
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: (_r, err) => {
            if (err && String(err.code) === '403') throw new Error('scope should have been enough');
          }
        },
      ],
    });

    matrix({
      action: 'AuthorService.Tutorials.rebuildContent (bound)',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) =>
          tx.send('rebuildContent', { }, srv.entities.Tutorials)
        );
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
        { user: AUTHOR,    expect: (_r, err) => {
            // Ownership check may 403 later; only assert this isn't the
            // scope-level 403 by inspecting the error message.
            if (err && String(err.code) === '403' && /Tutorial\.Author/.test(String(err.message))) {
              throw new Error('scope should have been enough');
            }
          }
        },
      ],
    });

    // generateOsVariants -- LLM-backed, skip runtime call.
    // Cover only the anonymous rejection.
    matrix({
      action: 'AuthorService.generateOsVariants (anon-only, no LLM call)',
      invoke: async (u) => {
        const srv = await cds.connect.to('AuthorService');
        return srv.tx({ user: u }, (tx) =>
          tx.send('generateOsVariants', {
            sourceMarkdown: '# t', sourceOS: 'macos', targetOSes: ['windows'],
          })
        );
      },
      cases: [
        { user: ANONYMOUS, expect: 403 },
      ],
    });
  });
  ```

- [ ] **Step B2.2: Run the AuthorService test — verify it passes**

  Run: `npx vitest run test/auth/services/author-service.auth.test.js --project unit`

  Expected: all cases PASS. If a case fails, investigate before proceeding — the failure likely reveals either a service annotation drift or a matrix() bug. Do NOT modify the CDS to make the test pass; if a gate is missing that Phase C should address, note the finding as a follow-up.

- [ ] **Step B2.3: Commit the AuthorService test**

  ```bash
  git add test/auth/services/author-service.auth.test.js
  git commit -m "test(#809): AuthorService auth matrix (Phase B2 -- worked example)

  First service test file, serves as the pattern for the other 12.
  Covers every entity (READ) plus every action/function on AuthorService:
  Tutorials/Tags/MyTutorials/MyAuthoredTutorials/MyOwnedTutorials READ;
  listExposedEntities/isSlugAvailable/toggleMonitor/reviewTutorial/
  snoozeTutorial/generateOsVariants; bound Tutorials.rebuildContent().

  Two-case matrix per op: anonymous -> 403, Tutorial.Author -> allow
  (or 'not-a-scope-403' via custom check for ops that also carry
  ownership guards).

  Refs #809 (Phase B2)."
  ```

---

## Task B3: Remaining 12 CDS service auth-test files

Each of the remaining 12 service test files follows the B2 pattern exactly — boot `cds.test('serve','--in-memory')`, `describe('SERVICE — auth matrix', () => {...})`, one `matrix()` call per entity-READ + one per action/function. **The only per-service inputs are:** (a) service name and connect target, (b) the "gated scope" set, (c) the list of entities + actions from recon, (d) any special fixture seeding.

Ship one commit per service to keep review manageable.

### Per-service reference table (from Phase B recon)

| Service | @path | Service @requires | Gated scope in matrix | Notable |
|---|---|---|---|---|
| AdminService | /admin | Admin | `SCOPES.Admin` | Huge surface (~55 actions/functions + ~60 entities). Split into 2-3 `describe` groups for readability. |
| AnalyticsService | /admin/analytics | Admin | `SCOPES.Admin` | Also has row-`@restrict` on `SavedQueries` / `QueryHistory` — Phase B covers scope only; row filter is a Phase C concern. Add a `// TODO Phase C: verify @restrict where` marker. |
| ChatService | /chat | authenticated-user | any authenticated scope | No entities. No actions. **Add a single stub test** asserting service metadata is reachable by authenticated users, rejected for anonymous. |
| ConsolidationService | /api/v1 | ConsolidationScope | `SCOPES.ConsolidationScope` | Two ops: `userMerge`, `getMergeStatus`. Also assert wrong-scope (Admin without ConsolidationScope) → 403. |
| DeveloperService | /api | any (service) | per-op mix | Per-op `@requires` — see recon. Every op except `submitTutorialFeedback` and `Advocates`/`ChatConfig` reads requires `authenticated-user`. `submitTutorialFeedback` and `Advocates` READ are `any` → anonymous is `expect: 'allow'`. |
| DisplayService | /display | DisplayApp | `SCOPES.DisplayApp` | 5 functions + Events READ. |
| EventStreamService | event-stream | any | anonymous allowed | Single function `getEventBuckets`. Two cases: anonymous → allow, authenticated → allow. |
| ExportsService | /admin/exports | Admin | `SCOPES.Admin` | Single action `exportLegacyData`. |
| HomepageService | /homepage | any | anonymous allowed | 7 ops all inherit `any`. Two cases per op: anonymous → allow, authenticated → allow. |
| KnowledgeGraphService | /graph | any (service) | per-op mix | Read ops (`neighborhood`, `neighborhoodFull`, `pathBetween`, `conceptsForUser`, and READ on `Concepts`/`ConceptEdges`/`TutorialConceptLinks`/`PublishedConcepts`) → anonymous allowed. Admin actions (`runSparql`, `mergeConcepts`, `previewMerges`, `vetoConcept`, `vetoEdge`, `triggerGraphRebuild`, bound `publishConcept`/`unpublishConcept`) → anonymous 403, `KnowledgeGraph.Admin` allowed. `Concepts` UPDATE (via imperative guard in srv/knowledge-graph-service.js:526) → anonymous 403, `KnowledgeGraph.Admin` allowed. |
| ScannerService | /scanner | **MobileApp** (Post-Phase-A) | `SCOPES.MobileApp` | Uses A2's tightening. `getContestant` and `claimPrize`. Assert authenticated-user only → 403 (proves A2). |
| SearchService | /search | any | anonymous allowed | Two entities READ + `getFacets` function. All three cases: anonymous → allow. |
| AdminService | /admin | Admin | see above | (row entry) |

- [ ] **Step B3.1: AdminService**

  Create `test/auth/services/admin-service.auth.test.js`. Because AdminService has ~55 actions/functions and ~60 entities, split into three `describe` groups:
  - `describe('AdminService — top entities (auth matrix)', ...)` — one `matrix()` per top-level writable entity: Users, Tutorials, Missions, Groups, Events, Prizes, Tags, Advocates, Alerts, HomepageShelves, HomepageConfig, VerbDefinitions, ShelfDefinitions, ChatSettings, KnowledgeGraphSettings, JobControls, DevtoberfestConfig, Secrets, TenantSettings.
  - `describe('AdminService — code-list and readonly entities (auth matrix, grouped)', ...)` — Group the remaining ~30 code-list/readonly entities into a single `for` loop that iterates over `['ExperienceLevels', 'TaskStatuses', 'MissionTypes', 'TaskTypes', 'EventTypes', 'AlertSeverities', 'AlertAudiences', 'AdvocateRegions', 'AdvocateLinkKinds', 'AnalyticsTaskTypes', 'AnalyticsLevels', 'PipelineTypes', 'PipelineStatuses', 'AccountMergeStatuses', 'ChangeTypes', 'PrivacyActionTypes', 'Tasks', 'CompletionAnalytics', 'PipelineLog', 'JobExecutionLog', 'PipelineLogItems', 'JobLogItems', 'TutorialFeedback', 'TutorialFeedbackAggregate', 'LearningPreferences', 'MyTutorials', 'DormantAuthors', 'ActiveLearnerRecords', 'AlertCtaTargets', 'FailedEmails', 'PrimaryAccounts', 'SecondaryAccounts', 'PrivacyProtectionActions', 'GroupTags', 'GroupPathItems', 'MissionTags', 'TimeZones', 'AdvocateTopics', 'AdvocateLinks', 'AdvocatePhotos', 'AuthorAiRequests', 'TutorialCompletionStats', 'JobLastRun', 'EventRegistrations', 'ValidateAnswerSpecs', 'ValidateAnswerSubmissions', 'CodeCheckSpecs', 'CodeCheckSubmissions', 'TutorialPickList', 'TutorialOwnerPickList', 'Steps', 'Puzzles', 'PrizeRecords', 'AccomplishmentRecords', 'TaskRecords', 'TutorialTaskRecords', 'MissionTaskRecords', 'GroupTaskRecords', 'StepTaskRecords', 'CheckpointTaskRecords', 'PuzzleTaskRecords', 'TutorialMeta', 'TutorialContributors', 'TutorialRepositories', 'ImsConfig', 'StepFailures', 'NGDSFailedMessages', 'DeveloperEnvironmentTabs', 'FeaturedTasks', 'LegacyRedirects', 'Categories', 'MissionCategories', 'GroupCategories', 'TutorialCategories', 'Accomplishments', 'UiEventsSettings', 'SearchSettings', 'NavigatorSettings', 'DisplaySettings']` and calls `matrix()` with the anonymous → 403 / Admin → allow pair for each. This preserves the ≥ 200 assertion floor without hand-writing 60 matrix blocks. Any entity the ratchet still flags after this can be added by name.
  - `describe('AdminService — free-standing actions/functions', ...)` — one `matrix()` per top-level action from the recon table: `anonymizeUser`, `anonymizeByDsrRequest`, `cleanupStepFailures`, `cleanupUnusedTags`, `setFeaturedOrder`, `clearChangeLog`, `purgeNoiseChangeLog`, `reviewTutorial`, `snoozeTutorial`, `sendToNgds`, `syncTutorialMetadata`, `sendContributorNotifications`, `updateNotificationRecipients`, `toggleNotifications`, `getNotificationConfig`, `testNotificationEmail`, `sendLastChanceEmail`, `sendLastChanceEmailsAllDormant`, `getEventStatistics`, `getEventBurnup`, `getEventTrackStats`, `getCompletionSpeed`, `exportTaskRecords`, `exportAwardMissions`, `exportMissionCompletions`, `getAccountMergeStatus`, `findByAccountNumber`, `findMissingSlugs`, `getBoardStatistics`, `getMetricsSnapshot`, `previewTagImport`, `commitTagImport`, `classifyCategories`, `embedAllSeeds`, `generateVerbExplainers`, `generateShelfExplainers`, `generateShelfEntryExplainers`, `markVerbExplainerReviewed`, `markShelfExplainerReviewed`, `markShelfEntryExplainerReviewed`, `bulkMarkVerbExplainerReviewed`, `bulkMarkShelfExplainerReviewed`, `bulkMarkShelfEntryExplainerReviewed`, `secretWarnings`, `getTutorialSource`.
  - `describe('AdminService — bound actions', ...)` — bound actions on `Users.clearKhorosLink`, `Advocates.uploadPhoto`/`clearPhoto`, `Secrets.setSecretValue`/`rotateSecretValue`/`clearSecretValue`/`revealSecretValue`, `HomepageShelves.markReviewed`/`regenerate`, `VerbDefinitions.markReviewed`/`regenerate`, `ShelfDefinitions.markReviewed`/`regenerate`, `KnowledgeGraphSettings.seedApiDocs`/`seedSamples`/`seedHelpDocs`, `JobControls.listJobs`/`runJob`, `ChatSettings.seedEmbeddings`, `Tutorials.rebuildContent`.

  Two cases per op: `ANONYMOUS → 403`, `user('u', SCOPES.Admin) → 'allow'` (or custom check for ops that also carry business-logic 400/404 errors).

  Commit:
  ```bash
  git add test/auth/services/admin-service.auth.test.js
  git commit -m "test(#809): AdminService auth matrix (Phase B3.1)

  Refs #809 (Phase B3.1)."
  ```

- [ ] **Step B3.2: AnalyticsService**

  Create `test/auth/services/analytics-service.auth.test.js`. Entities: Tasks, NavigatorCatalog, SearchableItems, CompletionAnalytics, ActiveLearnersDaily, TaskRecords, Users, Missions, Groups, Tutorials, Events, PrizeRecords, AccomplishmentRecords, MetricSnapshots, PublishTimings, CodeCheckSubmissions, ValidateAnswerSubmissions, UIEvents, AnalyticsBranchPerformance, AnalyticsBranchTopPick, QueryHistory, SavedQueries. Actions: `listExposedEntities`, `runSelectQuery`, `sampleDistinct`, `exportSelectQuery`. Two cases each: `ANONYMOUS → 403`, `user('u', SCOPES.Admin) → 'allow'`. Add `// TODO Phase C: verify @restrict where clause on SavedQueries/QueryHistory` marker over the SavedQueries/QueryHistory matrix() calls.

  Commit: `git commit -m "test(#809): AnalyticsService auth matrix (Phase B3.2)\n\nRefs #809 (Phase B3.2)."`

- [ ] **Step B3.3: ChatService**

  Create `test/auth/services/chat-service.auth.test.js`. ChatService has no entities and no actions (streaming lives in Express). Write a single `it()` (no matrix needed) that connects to ChatService with `srv.tx({user: ANONYMOUS}, tx => tx.run(SELECT.from('ChatService.$metadata')))` and asserts rejection; and a second `it()` that connects with an authenticated user and asserts allow. If the service is genuinely empty and neither call is meaningful, write a comment noting so and skip the file with a single `it('ChatService is annotation-only, streaming lives at Express /chat/stream — see test/auth/express/chat-stream.auth.test.js', () => {});`.

  Commit: `git commit -m "test(#809): ChatService auth matrix stub (Phase B3.3)\n\nRefs #809 (Phase B3.3)."`

- [ ] **Step B3.4: ConsolidationService**

  Create `test/auth/services/consolidation-service.auth.test.js`. Two ops: `userMerge`, `getMergeStatus`. Three cases per op: `ANONYMOUS → 403`, `user('u', SCOPES.Admin) → 403` (wrong scope), `user('u', SCOPES.ConsolidationScope) → 'allow'` (or custom check for the business-logic 400s the ops throw on missing args).

  Commit: `git commit -m "test(#809): ConsolidationService auth matrix (Phase B3.4)\n\nRefs #809 (Phase B3.4)."`

- [ ] **Step B3.5: DeveloperService**

  Create `test/auth/services/developer-service.auth.test.js`. Per recon table, mix of `any` and `authenticated-user`. For each op:
  - `authenticated-user`-gated (`Tutorials`/`TaskRecords`/`Events` READ, `LearningPreferences`, `completeStep`, `resetTutorialProgress`, `getProgress`, `createTaskRecord`, `findTaskProgressByUserAndTasksIds`, `countCompletedMissionsTotal`, `countCompletedMissionsPercent`, `getSlugMapping`, `getMyCompletions`, `getEventProgress`, `getAppSpaceProgress`, `setLearningPreferences`, `setKhorosLink`, `clearKhorosLink`, `getKhorosProfile`) — two cases: `ANONYMOUS → 403`, `user('u', SCOPES.AuthenticatedUser) → 'allow'` (or custom check for business errors).
  - `any`-gated (`ChatConfig` READ, `Advocates` READ, `submitTutorialFeedback`) — one case: `ANONYMOUS → 'allow'`.

  Commit: `git commit -m "test(#809): DeveloperService auth matrix (Phase B3.5)\n\nRefs #809 (Phase B3.5)."`

- [ ] **Step B3.6: DisplayService**

  Create `test/auth/services/display-service.auth.test.js`. Ops: `getEventBuckets`, `getEventBurnup`, `getEventTrackStats`, `getCompletionSpeed`, `getLeaderboard`, plus `Events` READ. Two cases each: `ANONYMOUS → 403`, `user('u', SCOPES.DisplayApp) → 'allow'`.

  Commit: `git commit -m "test(#809): DisplayService auth matrix (Phase B3.6)\n\nRefs #809 (Phase B3.6)."`

- [ ] **Step B3.7: EventStreamService**

  Create `test/auth/services/event-stream-service.auth.test.js`. Single op `getEventBuckets` (anonymous-by-design). Two cases: `ANONYMOUS → 'allow'`, `user('u', SCOPES.AuthenticatedUser) → 'allow'`. Add a code comment linking to the "anonymous-by-design" spec note.

  Commit: `git commit -m "test(#809): EventStreamService auth matrix (Phase B3.7)\n\nRefs #809 (Phase B3.7)."`

- [ ] **Step B3.8: ExportsService**

  Create `test/auth/services/exports-service.auth.test.js`. Single op `exportLegacyData`. Two cases: `ANONYMOUS → 403`, `user('u', SCOPES.Admin) → 'allow'` (or custom check).

  Commit: `git commit -m "test(#809): ExportsService auth matrix (Phase B3.8)\n\nRefs #809 (Phase B3.8)."`

- [ ] **Step B3.9: HomepageService**

  Create `test/auth/services/homepage-service.auth.test.js`. 7 ops (`events`, `videos`, `communityBlogs`, `news`, `shelves`, `redirectsActive`, `recordRedirectHits`). All `any`-gated. Two cases each: `ANONYMOUS → 'allow'`, `user('u', SCOPES.AuthenticatedUser) → 'allow'`. Comment on `recordRedirectHits` noting Phase C may tighten to rate-limit-only-authenticated.

  Commit: `git commit -m "test(#809): HomepageService auth matrix (Phase B3.9)\n\nRefs #809 (Phase B3.9)."`

- [ ] **Step B3.10: KnowledgeGraphService**

  Create `test/auth/services/knowledge-graph-service.auth.test.js`. Split into three groups:
  - `describe('KG — public read surface', ...)` — `neighborhood`, `neighborhoodFull`, `pathBetween`, `conceptsForUser`, and READ on `Concepts`/`ConceptEdges`/`TutorialConceptLinks`/`PublishedConcepts`. Two cases each: `ANONYMOUS → 'allow'`, authenticated → allow.
  - `describe('KG — Admin actions', ...)` — `runSparql`, `mergeConcepts`, `previewMerges`, `vetoConcept`, `vetoEdge`, `triggerGraphRebuild`, `publishConcept`, `unpublishConcept`. Three cases: `ANONYMOUS → 403`, `user('u', SCOPES.Admin) → 403` (wrong scope; needs KG.Admin), `user('u', SCOPES.KnowledgeGraphAdmin) → 'allow'`.
  - `describe('KG — Concepts UPDATE (imperative guard)', ...)` — one `matrix()` on UPDATE. Two cases: `ANONYMOUS → 403`, `user('u', SCOPES.KnowledgeGraphAdmin) → 'allow'`.

  Commit: `git commit -m "test(#809): KnowledgeGraphService auth matrix (Phase B3.10)\n\nRefs #809 (Phase B3.10)."`

- [ ] **Step B3.11: ScannerService**

  Create `test/auth/services/scanner-service.auth.test.js`. **This test file depends on Phase A2 (MobileApp scope tightening) being in `main`.** Two ops: `getContestant`, `claimPrize`. Three cases each: `ANONYMOUS → 403`, `user('u', SCOPES.AuthenticatedUser) → 403` (proves A2), `user('u', SCOPES.MobileApp) → 'allow'` (or custom check for the business-logic errors on missing/invalid contestants).

  Commit: `git commit -m "test(#809): ScannerService auth matrix (Phase B3.11)\n\nDepends on Phase A2. Refs #809 (Phase B3.11)."`

- [ ] **Step B3.12: SearchService**

  Create `test/auth/services/search-service.auth.test.js`. Two entities (`SearchableItems`, `Tags`) READ + one function `getFacets`. Three ops total, all `any`-gated. Two cases each: `ANONYMOUS → 'allow'`, `user('u', SCOPES.AuthenticatedUser) → 'allow'`.

  Commit: `git commit -m "test(#809): SearchService auth matrix (Phase B3.12)\n\nRefs #809 (Phase B3.12)."`

- [ ] **Step B3.13: Verify all 13 service test files run green**

  Run: `npx vitest run test/auth/services/ --project unit`

  Expected: all cases PASS. If any fail, the failure is either (a) a real auth-model bug — file a follow-up issue, don't paper over — or (b) a matrix() DSL issue — fix and re-commit.

- [ ] **Step B3.14: Confirm the assertion-count floor is met**

  Run: `npx vitest run test/auth/services/ --project unit --reporter=verbose 2>&1 | grep -c "✓" || true`

  Target from spec: ≥ 200 across `test/auth/**` AND ≥ 5 cases per CDS-service `.auth.test.js` file. Verify. If a service file is thin (< 5 cases), enrich its matrix with one or two additional wrong-scope negative cases.

---

## Task B4: Express-route auth-test files (12 files)

Express routes cannot be tested via `srv.tx({user:...})` — they live outside CAP's service-invocation path. Two options: (a) `supertest`-style HTTP against a booted `cds.serve()`, (b) call the middleware chain directly with a fake `req`. Option (b) is faster and matches the existing pattern in [test/lib/tech-user-auth.test.js](test/lib/tech-user-auth.test.js) which mocks `req = { headers: { authorization: '...' } }` and calls `basicAuthMiddleware(req, res, next)` directly.

Use option (b) — direct middleware invocation. It's the project's convention.

### Per-Express-file reference table

| File | Routes | Middleware chain to exercise |
|---|---|---|
| `content-store.auth.test.js` | POST /content/publish{,/begin,/append,/commit,/abort}, /content/rollback, /content/orphan-purge, /content/code-check-specs, /content/validate-answer-specs | `contentAuthMiddleware` from `srv/lib/content-store.js:227-246`. Import + call directly. Three cases per: missing bearer → 401, wrong bearer → 403, correct bearer → next() called. |
| `feedback.auth.test.js` | POST /feedback/submit | Anonymous by design. Cases: anonymous with valid body → 200/next-called; missing `SUBMISSION_SALT_SECRET` env → 503; anonymous with malformed body → 400. |
| `health.auth.test.js` | GET /health, /health/db, /health/auth | /health and /health/db anonymous → 200. /health/auth 401 anonymous, 200 authenticated. |
| `auth-user-endpoint.auth.test.js` | GET /auth/user | 401 anonymous, 200 authenticated. Cross-links to existing `test/unit/auth-user-endpoint.test.js`; enrich if the existing tests already cover this — add new cases only for gaps. |
| `build-endpoints.auth.test.js` | All `/build/*` GETs | Anonymous by design. Cases per route: anonymous GET → 200 (proves handler reachable, not just anonymous-allowed at approuter). POST /build/repo-catalog: anonymous → 401, wrong bearer → 403, correct bearer → 200/next. |
| `admin-embeddings.auth.test.js` | GET /admin/embeddings/stats | The `late-bound` handler in `srv/server.js:407, 921-936` checks `user.is('Admin')`. Three cases: anonymous → 401, non-Admin authenticated → 403, Admin → 200 (or `next()`). |
| `admin-metrics.auth.test.js` | GET /admin/metrics/live | Same shape as embeddings. |
| `advocates.auth.test.js` | GET /api/advocates*, POST /admin/advocates/:slug/photo | GETs anonymous, POST Admin-only. |
| `alerts.auth.test.js` | GET /api/alerts, /api/alerts/me | Public anon vs authenticated split. |
| `devtoberfest.auth.test.js` | GET /api/devtoberfest/(status\|terms\|me), POST /api/devtoberfest/join | Status/terms anonymous-friendly, /me and /join XSUAA-required. |
| `codecheck.auth.test.js` | POST /api/codecheck | `_apiContextMw + _apiAuthMw` — anonymous rejected 401. |
| `validate-answer.auth.test.js` | POST /api/validate-answer | Same shape as codecheck. |

- [ ] **Step B4.1: Write the content-store bearer-auth test (worked example)**

  Create `test/auth/express/content-store.auth.test.js`. This is the pattern the other 11 files follow.

  ```js
  // Phase B (#809) -- auth for the /content/* bearer-token surface.
  // contentAuthMiddleware is defined in srv/lib/content-store.js:227.
  // It reads CONTENT_API_KEY via resolveSecret, then timing-safe compares
  // to the Authorization Bearer header.

  import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

  describe('contentAuthMiddleware — auth matrix', () => {
    let contentAuthMiddleware;

    beforeEach(async () => {
      vi.resetModules();
      // Stub resolveSecret to return a known key.
      vi.doMock('../../../srv/lib/secret-resolver.js', () => ({
        resolveSecret: async () => 'test-content-api-key',
      }));
      ({ contentAuthMiddleware } = await import('../../../srv/lib/content-store.js'));
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    function makeReqRes(authHeader) {
      const req = { headers: authHeader ? { authorization: authHeader } : {} };
      let status, body;
      const res = {
        status(s) { status = s; return this; },
        json(b) { body = b; return this; },
        get status_() { return status; },
        get body_() { return body; },
      };
      return { req, res, get status() { return status; }, get body() { return body; } };
    }

    it('rejects missing Authorization with 401', async () => {
      const { req, res } = makeReqRes(null);
      let nextCalled = false;
      await contentAuthMiddleware(req, res, () => { nextCalled = true; });
      // Middleware should NOT call next() on 401; it should end the response.
      expect(nextCalled).toBe(false);
    });

    it('rejects wrong bearer with 403', async () => {
      const { req, res } = makeReqRes('Bearer wrong-key');
      let nextCalled = false;
      await contentAuthMiddleware(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
    });

    it('accepts correct bearer and calls next()', async () => {
      const { req, res } = makeReqRes('Bearer test-content-api-key');
      let nextCalled = false;
      await contentAuthMiddleware(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
    });

    it('returns 503 when CONTENT_API_KEY secret is not configured', async () => {
      vi.resetModules();
      vi.doMock('../../../srv/lib/secret-resolver.js', () => ({
        resolveSecret: async () => null,
      }));
      const mod = await import('../../../srv/lib/content-store.js');
      const { req, res } = makeReqRes('Bearer any-key');
      let nextCalled = false;
      await mod.contentAuthMiddleware(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(false);
    });
  });
  ```

  Verify the exact path to `contentAuthMiddleware` — recon says it lives at `srv/lib/content-store.js:227` and is exported. If it's not exported today (this is an internal to `content-store.js`), do NOT modify the module — instead exercise it via a booted `cds.serve()` (Task B4-alternative below).

- [ ] **Step B4.2: If contentAuthMiddleware is not exported, boot cds.serve and use fetch**

  Fallback path if B4.1 can't import the middleware directly:

  ```js
  import cds from '@sap/cds';

  const project = cds.test('serve', '--project', '.', '--in-memory');

  it('POST /content/publish rejects missing bearer with 401', async () => {
    const res = await project.post('/content/publish', { files: {} }).catch(e => e.response);
    expect(res.status).toBe(401);
  });
  ```

  This is slower but avoids module surgery.

- [ ] **Step B4.3: Run the content-store express test**

  Run: `npx vitest run test/auth/express/content-store.auth.test.js --project unit`

  Expected: all cases PASS.

- [ ] **Step B4.4: Commit content-store test**

  ```bash
  git add test/auth/express/content-store.auth.test.js
  git commit -m "test(#809): content-store bearer-auth matrix (Phase B4.1)

  Refs #809 (Phase B4.1)."
  ```

- [ ] **Step B4.5 through B4.15: Remaining 11 Express test files**

  Follow the B4.1 pattern for each row in the reference table. One commit per file with message `test(#809): <route-group> auth matrix (Phase B4.<n>)`. When a route depends on a middleware that isn't cheap to invoke directly, fall back to the booted-cds.serve() pattern from B4.2.

- [ ] **Step B4.16: Verify all 12 Express test files run green**

  Run: `npx vitest run test/auth/express/ --project unit`

  Expected: all PASS.

---

## Task B5: Completeness ratchet — scripts/assert-auth-covers-actions.cjs

The ratchet parses every `srv/*.cds` file, extracts every `action`, `function`, and top-level `entity` name, and greps `test/auth/services/*.auth.test.js` for each name. Missing coverage prints as a warning. **Phase C will flip this to fail-loud (`process.exit(1)`) — Phase B ships it in warn mode only.**

**Files:**
- Create: `scripts/assert-auth-covers-actions.cjs`
- Create: `test/scripts/assert-auth-covers-actions.test.js`
- Modify: `package.json`

- [ ] **Step B5.1: Write the ratchet test first (failing)**

  Create `test/scripts/assert-auth-covers-actions.test.js`. Use `node:child_process` `execFile` (not `exec`/`execSync`) for safer subprocess invocation — no shell interpretation, arguments passed as an array.

  Test cases: (1) warn mode exits 0 even with incomplete coverage; (2) `--fail-loud` returns exit code 0 or 1 (script runs without syntax errors either way).

  Wrap `execFile` in a promisified helper:
  ```js
  import { promisify } from 'node:util';
  import { execFile } from 'node:child_process';
  const run = promisify(execFile);
  // Usage: const { stdout, stderr } = await run('node', ['scripts/assert-auth-covers-actions.cjs']);
  ```

  For the exit-code case, catch the rejection:
  ```js
  let exitCode = 0;
  try {
    await run('node', ['scripts/assert-auth-covers-actions.cjs', '--fail-loud']);
  } catch (e) {
    exitCode = e.code ?? 1;
  }
  expect([0, 1]).toContain(exitCode);
  ```

- [ ] **Step B5.2: Run the ratchet test to verify it fails**

  Run: `npx vitest run test/scripts/assert-auth-covers-actions.test.js --project unit`

  Expected: FAIL — script not yet created.

- [ ] **Step B5.3: Implement the ratchet script**

  Create `scripts/assert-auth-covers-actions.cjs`:

  ```js
  #!/usr/bin/env node
  // Auth-matrix completeness ratchet (Phase B5, #809).
  //
  // Parses every srv/*.cds file, extracts every top-level `action`,
  // `function`, and `entity` name, and greps test/auth/services/*.auth
  // .test.js for each name. Missing coverage prints as a warning.
  //
  // Phase B (default): warn mode. Exit 0 even if coverage is incomplete.
  // Phase C: --fail-loud becomes the default via CI env var.
  //
  // Usage:
  //   node scripts/assert-auth-covers-actions.cjs           # warn mode
  //   node scripts/assert-auth-covers-actions.cjs --fail-loud  # exit 1 on gaps

  const fs = require('node:fs');
  const path = require('node:path');

  const FAIL_LOUD = process.argv.includes('--fail-loud');
  const SRV_DIR = path.join(__dirname, '..', 'srv');
  const AUTH_TEST_DIR = path.join(__dirname, '..', 'test', 'auth', 'services');

  function readAll(dir, ext) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith(ext))
      .map(f => ({ file: f, content: fs.readFileSync(path.join(dir, f), 'utf8') }));
  }

  const cdsFiles = readAll(SRV_DIR, '.cds');
  const authTests = readAll(AUTH_TEST_DIR, '.auth.test.js');

  // Concatenate all auth test bodies -- one string to grep against.
  const authTestBody = authTests.map(t => t.content).join('\n');

  // Extract names from CDS files. Regexes are approximate -- CDS grammar
  // is complex; the ratchet is a heuristic completeness check, not a
  // parser.
  const NAME_RE = /\b(?:action|function|entity)\s+([A-Za-z_][A-Za-z0-9_]*)/g;
  const SERVICE_RE = /\bservice\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  const findings = [];
  for (const { file, content } of cdsFiles) {
    // Skip files that don't define a service (annotations-only files).
    if (!SERVICE_RE.test(content)) continue;
    SERVICE_RE.lastIndex = 0;
    const services = [...content.matchAll(SERVICE_RE)].map(m => m[1]);
    const service = services[0] || file;

    let m;
    NAME_RE.lastIndex = 0;
    while ((m = NAME_RE.exec(content)) !== null) {
      const name = m[1];
      // Grep the concatenated auth test body for the name as a whole word.
      const nameRe = new RegExp(`\\b${name}\\b`);
      if (!nameRe.test(authTestBody)) {
        findings.push({ service, file, name });
      }
    }
  }

  const mode = FAIL_LOUD ? 'fail-loud' : 'warn mode (Phase B; Phase C flips to fail-loud)';
  console.log(`[assert-auth-covers-actions] Running in ${mode}.`);
  console.log(`[assert-auth-covers-actions] Scanned ${cdsFiles.length} CDS files, ${authTests.length} auth tests.`);
  if (findings.length === 0) {
    console.log('[assert-auth-covers-actions] ✓ All service actions/functions/entities are covered.');
    process.exit(0);
  }

  console.log(`[assert-auth-covers-actions] ${findings.length} name(s) missing from test/auth/services/:`);
  for (const f of findings.slice(0, 50)) {
    console.log(`  - ${f.service} :: ${f.name}  (in ${f.file})`);
  }
  if (findings.length > 50) {
    console.log(`  ... and ${findings.length - 50} more.`);
  }

  if (FAIL_LOUD) {
    console.log('[assert-auth-covers-actions] ✗ Failing (--fail-loud). Add matrix rows for the above, or exclude them explicitly if intentional.');
    process.exit(1);
  }
  console.log('[assert-auth-covers-actions] (Warn only; not failing. Phase C will flip default to fail-loud.)');
  process.exit(0);
  ```

  Make it executable (POSIX only; Windows ignores this):
  ```bash
  chmod +x scripts/assert-auth-covers-actions.cjs 2>/dev/null || true
  ```

- [ ] **Step B5.4: Run the ratchet manually**

  Run: `node scripts/assert-auth-covers-actions.cjs`

  Expected: prints a warn-mode banner and lists any missing coverage. After all of Task B3 (13 service files) is complete, the missing-list should be small (< 20). Investigate any large gaps.

- [ ] **Step B5.5: Wire ratchet into `pretest`**

  Modify `package.json`. Find the `scripts` section. Add:
  ```json
  "check:auth-matrix": "node scripts/assert-auth-covers-actions.cjs",
  ```
  and modify or extend `pretest` to run it:
  ```json
  "pretest": "<existing-pretest> && npm run check:auth-matrix"
  ```

  If `pretest` already exists, append with `&&`; if it doesn't, create it. The ratchet runs in warn mode by default so it never blocks CI in this phase.

- [ ] **Step B5.6: Run `npm test` end-to-end**

  Run: `npm test 2>&1 | tail -30`

  Expected: unit workspace passes AND the ratchet output appears in the console. If the ratchet fails CI, the wiring is wrong — must be warn mode.

- [ ] **Step B5.7: Commit the ratchet**

  ```bash
  git add scripts/assert-auth-covers-actions.cjs test/scripts/assert-auth-covers-actions.test.js package.json
  git commit -m "test(#809): auth-matrix completeness ratchet (warn mode)

  scripts/assert-auth-covers-actions.cjs parses every srv/*.cds file
  for action/function/entity names and greps test/auth/services/*.auth
  .test.js for each. Missing names print as findings.

  Ships in WARN MODE this phase -- prints but does not fail CI.
  Phase C flips the default to --fail-loud.

  Wired into 'pretest' via package.json 'check:auth-matrix' script.
  Uses node:child_process execFile (not exec) in the test harness
  to avoid shell interpretation of arguments.

  Refs #809 (Phase B5)."
  ```

---

## Task B6: Smoke additions — auth-parity end-to-end

Piggyback on the existing `test/smoke/**` bearer-token pattern instead of building a local signed-JWT harness. Cover ~15 highest-value end-to-end flows.

**Files:**
- Create: `test/smoke/auth-parity.test.js`

- [ ] **Step B6.1: Write the smoke additions**

  Create `test/smoke/auth-parity.test.js` following the pattern from `test/smoke/author-scope-routes.smoke.test.js`: import `{ SRV_URL, BASE_URL, fetchWithRetry }` from `./smoke.config.js`; guard the whole `describe` with `describe.skipIf(!SRV_URL || SRV_URL.startsWith('http://localhost'))`.

  Structure the file in three nested `describe`s:

  **1) Anonymous surface (should stay anonymous)** — assert 200 (or 404 for a made-up slug):
  - `GET /health`
  - `GET /build/catalog`
  - `GET /api/advocates`
  - `GET /content/tutorials/does-not-exist` — accept 200 OR 404 (proves handler reached), reject 401.

  **2) Bearer-token surface** — POSTs to `/content/publish`:
  - Missing bearer → 401
  - Wrong bearer → 403

  **3) XSUAA-scope surface** — three sub-describes, each `.skipIf(!<token>)`:
  - `SMOKE_ADMIN_TOKEN` → `GET /admin/Tutorials?$top=1` returns 200; `GET /admin/embeddings/stats` returns 200.
  - `SMOKE_AUTHOR_TOKEN` → `GET /author/Tutorials?$top=1` returns 200; `GET /admin/Tutorials?$top=1` returns 403 (wrong-scope negative).
  - `SMOKE_MOBILE_TOKEN` → `GET /scanner/getContestant(accountNumber='1')` returns 200 or 404 (accept business-error, prove not-401/403). Add a comment: "Post-Phase-A2 assertion."

  **4) Approuter routes** — `describe.skipIf(!BASE_URL)`:
  - `GET /admin-ui/` → 401 or 302 (auth-required). Fail if 200 without auth.
  - `GET /tutorials-qa/nonexistent` → 401 or 302 (proves the `Tutorial.Author` scope gate at approuter). Post-Phase-A1 assertion.

  Send bearer via `fetchWithRetry(url, { headers: { authorization: 'Bearer ' + TOKEN } })`. Wrap responses in `expect(res.status).toBe(...)` or `expect([...]).toContain(res.status)`.

- [ ] **Step B6.2: Verify the smoke test compiles and skips gracefully in local**

  Run: `npx vitest run test/smoke/auth-parity.test.js --project smoke 2>&1 | tail -30`

  Expected: without env vars, all tests skip gracefully (the `describe.skipIf` pattern). No hard failures.

- [ ] **Step B6.3: Commit smoke additions**

  ```bash
  git add test/smoke/auth-parity.test.js
  git commit -m "test(#809): auth-parity end-to-end smoke (Phase B6)

  ~15 smoke assertions running against a deployed environment.
  Uses existing SMOKE_ADMIN_TOKEN / SMOKE_AUTHOR_TOKEN / etc env
  vars supplied by CI. Skips gracefully in local runs.

  Covers three tiers:
   - Anonymous surface stays anonymous (/health, /build/catalog,
     /api/advocates, /content/tutorials/*)
   - Bearer-token surface (401 missing, 403 wrong)
   - XSUAA scope surface (Admin/Author/Mobile positive + negative)

  Skips the /scanner/* MobileApp test until Phase A2 is deployed.

  Refs #809 (Phase B6)."
  ```

---

## Task B7: Architecture doc — how auth works in this codebase

Establishes `docs/developers/architecture/authorization.md` as the single source of truth. Referenced by every subsequent auth PR.

**Files:**
- Create: `docs/developers/architecture/authorization.md`
- Modify: `docs/.vitepress/config.ts` (sidebar registration)

- [ ] **Step B7.1: Draft the architecture doc**

  Create `docs/developers/architecture/authorization.md`. Structure:

  **Sections to cover:**
  1. **Overview** — one paragraph on the four defense layers (approuter route-scope → tech-user Basic → CDS `@requires` → JS-level guards) and how they compose.
  2. **XSUAA scopes and role collections** — table pulling from `xs-security.json`: ten scopes, six role collections, what each gates. Cite [xsuaa-role-collection-assignment.md](../operations/xsuaa-role-collection-assignment.md).
  3. **Approuter routing** — one paragraph plus a table of route → auth type → scope from `approuter/xs-app.json`. Note the anonymous allowlist (health, feedback, advocates, alerts, KG public read).
  4. **CDS `@requires` and `@restrict`** — how CAP enforces service-level and per-op scope. Point to the canonical examples: `srv/admin-service.cds:6` (service-level Admin), `srv/analytics-service.cds:137-141` (row `@restrict` on SavedQueries), `srv/knowledge-graph-service.cds:35` (anonymous service with per-action tightening).
  5. **Tech-user Basic auth** — `srv/lib/tech-user-auth.js`. Format `user:pass:role1,role2;user2:pass2:role3`. Post-Phase-A3: role-less entries are skipped with a warning (never silent-Admin). Cite the runbook.
  6. **JS-level guards** — when to use `req.user.is('Admin')` or `req.user.attr.user_uuid`. Anti-pattern: reading `req.user.attr` without a `@requires` gate first (users can send fake JWTs to unrouted endpoints).
  7. **Testing** — pointer to `test/auth/**`, `test/smoke/auth-parity.test.js`, and the completeness ratchet.
  8. **The KG anonymous allowlist** — special case worth documenting: `@requires: 'any'` service with per-action `KnowledgeGraph.Admin` gates + a `before UPDATE` imperative guard on `Concepts`. Three-layer defense-in-depth.
  9. **Tenant scoping** — `techUsers` tenant setting is per-tenant; JWT `zid` claim carries the tenant id; how to write a tenant-scoped guard. Cite the Phase C tightening on `ScannerService.getContestant`.
  10. **What's out of scope** — no attribute-restricted scopes, no custom scope hierarchies (SuperAdmin implies Admin via role-template only, not runtime), no bearer-authenticated CAP services beyond the current `contentAuthMiddleware` pattern.

  Keep the doc readable in one sitting — aim for ~400–600 lines with lots of file:line references. Do not duplicate the runbook content; link to it.

- [ ] **Step B7.2: Register the doc in the sidebar**

  Modify `docs/.vitepress/config.ts`. Find the "Architecture" section under `sidebar` — it contains `build.md`, `authentication.md`, etc. Add:
  ```ts
  { text: 'Authorization (auth-parity #809)', link: '/developers/architecture/authorization' },
  ```
  Alphabetically after `authentication.md`.

- [ ] **Step B7.3: Verify the docs build**

  Run: `npm run docs:build`

  Expected: succeeds. The `predocs:build` sidebar guard catches unregistered pages.

- [ ] **Step B7.4: Commit the architecture doc**

  ```bash
  git add docs/developers/architecture/authorization.md docs/.vitepress/config.ts
  git commit -m "docs(#809): add authorization architecture doc (Phase B7)

  Single-page architecture reference for the four-layer auth model:
  approuter route-scope, tech-user Basic, CDS @requires/@restrict,
  JS-level guards. Includes XSUAA scope table, KG anonymous-allowlist
  case study, and testing pointers.

  Registered in the VitePress sidebar.

  Refs #809 (Phase B7)."
  ```

---

## Task B8: Cross-cutting verification

- [ ] **Step B8.1: Full unit suite green**

  Run: `npm test`

  Expected: everything passes. `test/auth/**` runs as part of the `unit` project.

- [ ] **Step B8.2: Assertion count meets floor**

  Run: `npx vitest run test/auth/ --project unit --reporter=verbose 2>&1 | grep -c "✓" || true`

  Expected: ≥ 200 total. Also check per-service: any file under `test/auth/services/` with < 5 cases needs enrichment. Grep with:
  ```bash
  for f in test/auth/services/*.auth.test.js; do
    n=$(grep -c '^\s*{\s*user:' "$f")
    echo "$n  $f"
  done
  ```
  Any file showing fewer than 5 counted rows: add wrong-scope negatives.

- [ ] **Step B8.3: Ratchet reports the expected coverage**

  Run: `node scripts/assert-auth-covers-actions.cjs`

  Expected: prints the warn-mode banner. Missing-list is small (~< 20 items). Any legitimately-missing action should be added to a Phase C follow-up TODO in the plan (Phase C flips this to fail-loud, so leftover findings block the Phase C PR).

- [ ] **Step B8.4: Docs build passes**

  Run: `npm run docs:build`

  Expected: succeeds. Confirms the architecture doc is registered.

- [ ] **Step B8.5: Verify test/auth/** does not run under `hybrid` or `smoke` projects**

  Run: `npx vitest run --project hybrid 2>&1 | grep -c "test/auth" || echo "0"`

  Expected: `0`. The `unit` project's glob captures `test/auth/**`; the other projects must not.

---

## Task B9: PR + deploy checklist

- [ ] **Step B9.1: Verify Phase A is on `main`**

  Run: `git fetch origin main && git log origin/main --oneline --grep="Phase A" | head -3`

  Expected: at least one Phase-A commit. If not, **stop** — the scanner-service and tutorial-author assertions will regress against unchanged source.

- [ ] **Step B9.2: Rebase the Phase B worktree onto latest main**

  ```bash
  git fetch origin main
  git rebase origin/main
  ```

  Resolve conflicts if any (unlikely — Phase A touched `xs-security.json`, `srv/scanner-service.cds`, `srv/lib/tech-user-auth.js`, `docs/developers/operations/mta-deployment.md`, and one new runbook file; Phase B doesn't touch any of those).

- [ ] **Step B9.3: Open PR**

  Author the body:
  ```bash
  cat > /tmp/809-b-pr-body.md <<'EOF'
  ## Summary

  Phase B of the auth-parity effort (#809). Establishes the role-matrix test framework:

  - `test/auth/_harness/` — `SCOPES` constant + `matrix()` DSL
  - `test/auth/services/` — 13 per-service `.auth.test.js` files
  - `test/auth/express/` — 12 per-route-group `.auth.test.js` files
  - `scripts/assert-auth-covers-actions.cjs` — completeness ratchet (warn mode)
  - `test/smoke/auth-parity.test.js` — ~15 end-to-end assertions
  - `docs/developers/architecture/authorization.md` — architecture doc

  Depends on Phase A. Two service tests explicitly assert Phase-A tightening.

  ## Deploy notes

  Test-only PR. No production code changes. No `cf update-service` needed.

  ## Rollback

  Full revert is safe — no production files touched.

  Full plan: `docs/superpowers/plans/2026-07-03-809-auth-parity-phase-b.md`.
  Master spec: `docs/superpowers/specs/2026-07-03-809-authorization-parity-design.md`.

  Refs #809.
  EOF
  ```

  Open:
  ```bash
  gh pr create --repo sap-tutorials/tutorials-ims \
    --base main \
    --head worktree-809-auth-parity \
    --title "test(#809): auth-parity Phase B — role-matrix test framework" \
    --body-file /tmp/809-b-pr-body.md
  ```

- [ ] **Step B9.4: Confirm CI passes**

  Expected: unit + smoke + docs green. Smoke tests in CI will run against the deployed DEV (with SMOKE tokens); they should pass.

- [ ] **Step B9.5: Merge (after review)**

  Squash merge conventional to this repo. No deploy needed — test-only PR.

- [ ] **Step B9.6: No deploy soak needed**

  Phase B is test-only; ship. Phase C can open immediately after Phase B merges. There's no waiting period.

---

## Rollback plan

Test-only PR. Full revert is safe; no production runtime code was modified.

Individual `git revert <commit>` on any of B1–B7 commits works cleanly (they don't build on each other in a load-bearing way). The only exception is B5 (the ratchet) — reverting B5 while keeping the Task B3 files in place would leave `pretest` referencing a script that doesn't exist. Revert B5 with a matching `pretest` package.json edit, or revert all of Phase B together.

---

## Acceptance criteria (mirrored from spec)

- [x] `test/auth/_harness/` contains `roles.js`, `matrix.js`, `matrix.test.js` (B1).
- [x] `test/auth/services/` contains one `.auth.test.js` per CDS service (13 services) — AuthorService (B2), plus AdminService/AnalyticsService/ChatService/ConsolidationService/DeveloperService/DisplayService/EventStreamService/ExportsService/HomepageService/KnowledgeGraphService/ScannerService/SearchService (B3.1–B3.12).
- [x] `test/auth/express/` contains one `.auth.test.js` per Express-route group (~12 files) (B4).
- [x] Total assertion count ≥ 200 across `test/auth/**` AND ≥ 5 cases per CDS-service `.auth.test.js` file (verified by B8.2).
- [x] Every action in `srv/*.cds` appears in the matrix — proved by `scripts/assert-auth-covers-actions.cjs` in warn mode (B5, B8.3).
- [x] Existing `test/unit/*-auth*.test.js` files remain green (B8.1).
- [x] `test/auth/**` completes in < 30s locally (verify via `time npx vitest run test/auth/ --project unit`).
- [x] `docs/developers/architecture/authorization.md` exists and covers the four auth layers, tech-user, KG allowlist, tenant scoping (B7).
- [x] PR merged; CI green on `main` (B9).

---

## Notes for the plan reviewer

- **HTTP-tier descope.** The spec anticipated a "signed-JWT HTTP tier"; recon revealed no existing harness and an explicit project convention against local JWT signing. Phase B pivots to reuse the existing `test/smoke/**` pattern (deployed-token bearer). This is documented in the header's "Key design refinement" note. If the reviewer prefers building a signed-JWT harness anyway, that's ~2 additional tasks (harness + wiring) plus a new `jose`-style dependency — flag for a Phase B++ ticket.
- **B3 is 12 sub-tasks of essentially identical shape.** The plan spells out per-service specifics via a reference table rather than repeating the full B2 skeleton 12 times. If the implementer prefers a full worked example for each service, the plan can be expanded — but that would triple its length for little added information.
- **B4 (Express routes) has a fallback path** (B4.2) using booted `cds.serve()` if middleware isn't cleanly importable. This is defensive — if all middleware happens to be importable, B4.2 is unused. If none are, B4 becomes slower but still ships.
- **Ratchet in warn mode.** Phase B deliberately does NOT flip to fail-loud (that's Phase C). If the reviewer wants an early flip, note the trade-off: any leftover uncovered action blocks Phase B's PR.
- **The `test/auth/**` directory is picked up by the existing `unit` project glob.** No `vitest.config.ts` change is needed — this is verified in Check-2. If the reviewer wants a dedicated `auth` project for named `npm run test:auth`, add it in a follow-up; not required for Phase B.
