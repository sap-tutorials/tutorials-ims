# Disable change tracking during migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suppress `@cap-js/change-tracking` plugin output during admin-authenticated bulk-migration POSTs/PATCHes via the two REST migrators, so a migration run no longer floods `sap.changelog.Changes` with thousands of bogus rows.

**Architecture:** A small DB-level handler (`cds.db.before(['INSERT','UPDATE','DELETE'])`) reads HTTP header `x-migration-mode: true` from `cds.context.http?.req?.headers`. When present AND the user has the `Admin` role, it sets the same `ct.skip` session variable on `req._tx` that the change-tracking plugin already checks (and resets it in a paired `after` handler). The two REST migrators send the header. Self-cleaning per request — no global toggle.

**Tech Stack:** ESM Node.js (CAP `srv/`), `@cap-js/change-tracking` v2.0.0-beta.11, vitest (unit + hybrid), VitePress for docs.

**Spec:** [docs/superpowers/specs/2026-06-18-394-disable-change-tracking-during-migration-design.md](../specs/2026-06-18-394-disable-change-tracking-during-migration-design.md)

**Issue:** [#394](https://github.com/sap-tutorials/tutorials-ims/issues/394)

---

## File map

| Path | Action | Responsibility |
| --- | --- | --- |
| `srv/lib/migration-mode.js` | **Create** | ESM module exporting `registerMigrationModeHandler()`. Pure handler registration; no I/O. |
| `srv/server.js` | **Modify** | Wire the registration into the existing `cds.on('served')` hook at line 325 with an idempotency guard (matches existing pattern — `__feedbackBeforeHookRegistered`, `__navigatorCacheInvalidatorRegistered`). |
| `scripts/migrate-reference-data.js` | **Modify** | Add `'x-migration-mode': 'true'` header in `importData()` (line 105 region) AND `populateSlugs()` (line 147 region — the shared `headers` object covers both Missions PATCH and CompletionPaths PATCH loops). |
| `scripts/migrate-user-progress.js` | **Modify** | Add `'x-migration-mode': 'true'` header in `importUsers()` (line 102 region). Defense-in-depth — entities not `@changelog`-tracked today. |
| `test/unit/migration-mode.test.js` | **Create** | Two tests: (1) plugin-contract pin — `tx.set({'ct.skip':'true'})` directly, verify zero Changes rows on a `@changelog` entity; (2) handler behavior — verify `req._tx.set` called with the right args under each (header, role) combination. |
| `test/hybrid/migration-mode.test.js` | **Create** | One small hybrid test: POST `/admin/Missions` with header → 0 Changes rows on real HANA; same POST without header → ≥1 Changes row. Cleans up `__TEST__`-prefixed data. |
| `db/change-tracking.cds` | **Modify** | Amend the file-header comment to reflect HANA-trigger reality (the existing comment is aspirational). |
| `docs/developers/operations/migration-from-ims.md` | **Create** | New runbook (~80 lines) covering steps 1/2/3 + audit-logging note + verification SQL + cross-link. |
| `docs/.vitepress/config.ts` | **Modify** | Register the new runbook under `themeConfig.sidebar` Operations group (neighbor: `btp-role-migration`). Required for `predocs:build`. |
| `CLAUDE.md` | **Modify** | One-line addition to the existing `### Data Migration` section. |

Total: 2 new srv files, 1 new test, 1 new hybrid test, 1 new doc, 5 modified files.

---

## Pre-flight (do once before Task 1)

- [ ] **Step 0.1: Confirm worktree**

Run: `git branch --show-current && pwd`
Expected: branch is `worktree-issue-394-disable-change-tracking-during-migration`, cwd ends in `.claude/worktrees/issue-394-disable-change-tracking-during-migration`. If not on the worktree, `EnterWorktree path: <existing>` or create one.

- [ ] **Step 0.2: Read the spec**

Read [docs/superpowers/specs/2026-06-18-394-disable-change-tracking-during-migration-design.md](../specs/2026-06-18-394-disable-change-tracking-during-migration-design.md) end-to-end before starting. Pay attention to: role name is `'Admin'` (capital A), handler runs at `cds.db.before(['INSERT','UPDATE','DELETE'])` (NOT on AdminService), `populateSlugs()` is a separate header site, audit-logging is out of scope.

- [ ] **Step 0.3: Verify dev environment**

Run: `node --version && npm --version`
Expected: Node 20+, npm 10+.

Run: `cf target` (only if you'll execute the hybrid test in Task 6)
Expected: org/space points at the DEV space. If not, `cf login`.

---

## Task 1: Plugin-contract pin test (unit)

**Goal:** Lock in the contract that `ct.skip` on a CAP tx makes the plugin no-op. If a future plugin upgrade renames the variable, this test fails first — and that diagnostic value justifies writing the test before the handler.

**Files:**
- Create: `test/unit/migration-mode.test.js`

- [ ] **Step 1.1: Inspect a similar existing unit test for style**

Run: `ls test/unit/ | head` then read one or two existing CAP-using unit tests to match patterns (vitest globals, `cds.test`, `await cds.connect.to('db')`, etc.).

Expected: tests use `import { describe, it, expect, beforeAll } from 'vitest'`; `cds.test()` is invoked at file top; some use `cds.tx({ user: ... })`.

- [ ] **Step 1.2: Write the contract-pin test (RED)**

Create `test/unit/migration-mode.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll } from 'vitest';

cds.test(import.meta.dirname + '/../..');

describe('change-tracking ct.skip session variable contract', () => {
  let db, AdminMissions, Changes;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const admin = await cds.connect.to('AdminService');
    AdminMissions = admin.entities.Missions;
    // The plugin auto-deploys the changelog entity; canonical name:
    Changes = cds.entities['sap.changelog.Changes'];
  });

  it('sets ct.skip="true" via tx.set → no Changes row inserted on @changelog entity', async () => {
    const before = await SELECT.one`count(*) as n`.from(Changes);
    const beforeN = Number(before?.n ?? 0);

    await cds.tx({ user: new cds.User.Privileged() }, async (tx) => {
      tx.set({ 'ct.skip': 'true' });
      await tx.run(INSERT.into(AdminMissions).entries({
        ID: cds.utils.uuid(),
        title: '__TEST__ ct-skip pin',
        slug: '__test__-ct-skip-pin-' + Date.now(),
      }));
    });

    const after = await SELECT.one`count(*) as n`.from(Changes);
    const afterN = Number(after?.n ?? 0);

    expect(afterN - beforeN).toBe(0);
  });

  it('without ct.skip → at least one Changes row appears (control)', async () => {
    const before = await SELECT.one`count(*) as n`.from(Changes);
    const beforeN = Number(before?.n ?? 0);

    await cds.tx({ user: new cds.User.Privileged() }, async (tx) => {
      await tx.run(INSERT.into(AdminMissions).entries({
        ID: cds.utils.uuid(),
        title: '__TEST__ ct control',
        slug: '__test__-ct-control-' + Date.now(),
      }));
    });

    const after = await SELECT.one`count(*) as n`.from(Changes);
    const afterN = Number(after?.n ?? 0);

    expect(afterN).toBeGreaterThan(beforeN);
  });
});
```

- [ ] **Step 1.3: Run the test — verify RED**

Run: `npx vitest run test/unit/migration-mode.test.js`
Expected: BOTH tests run. The contract pin SHOULD pass (the plugin already supports `ct.skip`). The control SHOULD pass too. If either fails, STOP — investigate first; the contract may differ from what the spec assumes.

(Note: this is "RED" only in the sense of "runs first to confirm baseline." There's no failing assertion to fix — these tests pin existing behavior. If they pass, move on.)

- [ ] **Step 1.4: Commit**

```bash
git add test/unit/migration-mode.test.js
git commit -m "test: pin @cap-js/change-tracking ct.skip session-variable contract (#394)"
```

---

## Task 2: Migration-mode handler module

**Goal:** Implement the handler. Two registrations: `before(['INSERT','UPDATE','DELETE'])` to set `ct.skip='true'` when (header + Admin); paired `after(...)` to reset.

**Files:**
- Create: `srv/lib/migration-mode.js`
- Modify (test): `test/unit/migration-mode.test.js`

- [ ] **Step 2.1: Add handler-behavior test cases (RED)**

Append to `test/unit/migration-mode.test.js` a new `describe` block. The handler is registered globally by `srv/server.js` `served` hook — `cds.test()` already invokes the served lifecycle, so by the time these tests run the handler is wired.

```js
import express from 'express';
// ... add to imports at top of file

describe('migration-mode handler — header gate', () => {
  let admin, srvUrl, Changes;

  beforeAll(async () => {
    Changes = cds.entities['sap.changelog.Changes'];
    // cds.test exposes the running srv URL via `cds.test().port` after start
    srvUrl = `http://localhost:${cds.test.port || 4004}`;
  });

  async function postMission({ headers = {}, slugSuffix }) {
    return fetch(`${srvUrl}/admin/Missions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Privileged auth: cds.test mock-auths if no XSUAA bound
        Authorization: 'Basic ' + Buffer.from('admin:').toString('base64'),
        ...headers,
      },
      body: JSON.stringify({
        title: '__TEST__ handler ' + slugSuffix,
        slug: '__test__-handler-' + slugSuffix,
      }),
    });
  }

  it('header present + Admin role → 0 Changes rows', async () => {
    const before = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    const r = await postMission({ headers: { 'x-migration-mode': 'true' }, slugSuffix: 'admin-' + Date.now() });
    expect(r.ok).toBe(true);
    const after = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    expect(after - before).toBe(0);
  });

  it('header absent → Changes rows recorded (control)', async () => {
    const before = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    const r = await postMission({ slugSuffix: 'noheader-' + Date.now() });
    expect(r.ok).toBe(true);
    const after = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    expect(after).toBeGreaterThan(before);
  });

  it('header value other than "true" → ignored (changes recorded)', async () => {
    const before = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    const r = await postMission({ headers: { 'x-migration-mode': 'false' }, slugSuffix: 'false-' + Date.now() });
    expect(r.ok).toBe(true);
    const after = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    expect(after).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 2.2: Run — verify RED**

Run: `npx vitest run test/unit/migration-mode.test.js -t "migration-mode handler"`
Expected: the first test ("0 Changes rows") FAILS — the handler doesn't exist yet, so the header is ignored and Changes rows ARE recorded. The "control" tests pass.

- [ ] **Step 2.3: Implement `srv/lib/migration-mode.js` (GREEN)**

Create the file:

```js
import cds from '@sap/cds';

const MIGRATION_HEADER = 'x-migration-mode';
const SKIP_VAR = 'ct.skip';
const log = cds.log('migration-mode');

/**
 * Returns true iff the current cds.context represents an HTTP request
 * that carried `x-migration-mode: true` AND was authenticated as Admin.
 *
 * Reading from cds.context (AsyncLocalStorage) keeps the handler
 * inbound-protocol-agnostic: non-HTTP calls (jobs, internal CAP→CAP)
 * have no `cds.context.http`, so the gate fails closed.
 */
function migrationModeRequested() {
  const headers = cds.context?.http?.req?.headers;
  if (!headers) return false;

  const raw = headers[MIGRATION_HEADER];
  if (!raw || String(raw).toLowerCase() !== 'true') return false;

  const user = cds.context?.user;
  if (typeof user?.is !== 'function' || !user.is('Admin')) {
    log.debug?.('x-migration-mode header ignored: user not Admin');
    return false;
  }
  return true;
}

/**
 * Registers DB-level before/after handlers that set `ct.skip='true'`
 * for the duration of an admin migration request. Idempotent guard
 * against double-registration during cds.test() reloads is the
 * caller's responsibility (see srv/server.js).
 */
export function registerMigrationModeHandler() {
  if (!cds.db) {
    log.warn?.('cds.db unavailable; migration-mode handler not registered');
    return;
  }

  cds.db.before(['INSERT', 'UPDATE', 'DELETE'], async (req) => {
    if (!migrationModeRequested()) return;
    if (typeof req._tx?.set !== 'function') {
      log.warn?.('migration mode requested but req._tx.set unavailable');
      return;
    }
    req._tx.set({ [SKIP_VAR]: 'true' });
    req._migrationModeSkipSet = true;
    log.debug?.(`change tracking skipped for ${req.event} ${req.target?.name}`);
  });

  cds.db.after(['INSERT', 'UPDATE', 'DELETE'], async (_, req) => {
    if (!req?._migrationModeSkipSet) return;
    try {
      req._tx?.set?.({ [SKIP_VAR]: 'false' });
    } finally {
      delete req._migrationModeSkipSet;
    }
  });

  log.info?.('migration-mode handler registered on cds.db');
}
```

- [ ] **Step 2.4: Wire into `srv/server.js` (GREEN cont'd)**

Read `srv/server.js` lines 320–360 to confirm the existing `cds.on('served')` hook structure. Add a new idempotency-guarded block inside the same hook, alongside `__feedbackBeforeHookRegistered` / `__navigatorCacheInvalidatorRegistered`:

Add to imports (top of file):
```js
import { registerMigrationModeHandler } from './lib/migration-mode.js';
```

Add inside `cds.on('served', async () => { ... })` (after the navigator-cache block, before the next existing block):
```js
  // Skip @cap-js/change-tracking output for admin-authenticated bulk-migration
  // requests that send `x-migration-mode: true`. Sets `ct.skip` session var on
  // the DB tx; reset in paired after-handler. See spec #394.
  if (!globalThis.__migrationModeRegistered) {
    registerMigrationModeHandler();
    globalThis.__migrationModeRegistered = true;
  }
```

- [ ] **Step 2.5: Run — verify GREEN**

Run: `npx vitest run test/unit/migration-mode.test.js`
Expected: ALL tests pass (contract pins + handler-gate tests).

If "header present + Admin → 0 Changes rows" still fails: the auth-mock pattern in `cds.test()` may not assign the `Admin` role. Check by adding a temporary `console.log(cds.context?.user)` inside `migrationModeRequested()`. The fix is usually to use `Authorization: 'Basic ' + Buffer.from('alice:').toString('base64')` where `alice` is in the project's `.cdsrc.json` mocked-users with the `Admin` role — read `.cdsrc.json` / `package.json` `cds.requires.auth.users` to confirm the right username. Adjust the test accordingly.

- [ ] **Step 2.6: Commit**

```bash
git add srv/lib/migration-mode.js srv/server.js test/unit/migration-mode.test.js
git commit -m "feat(srv): add migration-mode handler that suppresses change tracking

When an admin-authenticated request carries x-migration-mode: true,
sets the @cap-js/change-tracking plugin's ct.skip session variable on
the DB tx so changelog triggers no-op. Paired after-handler resets.

Closes #394 (in part — REST migrators still need the header sent;
followup commits update migrate-reference-data.js and
migrate-user-progress.js)."
```

---

## Task 3: Update REST migrators

**Goal:** Send the header from both REST migrators. Three header sites: `importData()` POSTs, `populateSlugs()` PATCHes (covers both Missions + CompletionPaths via shared `headers` object), and `importUsers()` POSTs.

**Files:**
- Modify: `scripts/migrate-reference-data.js`
- Modify: `scripts/migrate-user-progress.js`

- [ ] **Step 3.1: Patch `migrate-reference-data.js` `importData()`**

Read `scripts/migrate-reference-data.js` lines 99–115. Find the `headers:` object inside the `fetch(...)` call (around line 102–110) and add the migration-mode header.

Before:
```js
headers: {
  'Content-Type': 'application/json',
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
},
```

After:
```js
headers: {
  'Content-Type': 'application/json',
  'x-migration-mode': 'true',
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
},
```

- [ ] **Step 3.2: Patch `migrate-reference-data.js` `populateSlugs()`**

Read lines 139–200. The shared `headers` object near line 147 covers BOTH the Missions PATCH loop AND the CompletionPaths PATCH loop — one edit, both paths fixed.

Before (around line 147):
```js
const headers = {
  'Content-Type': 'application/json',
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
};
```

After:
```js
const headers = {
  'Content-Type': 'application/json',
  'x-migration-mode': 'true',
  ...(AUTH_TOKEN ? { Authorization: `Bearer ${AUTH_TOKEN}` } : {})
};
```

- [ ] **Step 3.3: Patch `migrate-user-progress.js` `importUsers()`**

Read `scripts/migrate-user-progress.js` lines 95–115. Find the `headers:` object in the POST loop (around line 102) and add the migration-mode header. Same edit shape as Step 3.1.

(Note: per spec, the user-progress entities are NOT `@changelog`-tracked today, so this header is defense-in-depth. Still costs one line.)

- [ ] **Step 3.4: Verify — quick smoke compile**

Run: `node --check scripts/migrate-reference-data.js && node --check scripts/migrate-user-progress.js`
Expected: no syntax errors, exit 0.

- [ ] **Step 3.5: Commit**

```bash
git add scripts/migrate-reference-data.js scripts/migrate-user-progress.js
git commit -m "feat(scripts): send x-migration-mode header from REST migrators (#394)

Three header sites:
- migrate-reference-data.js importData() POSTs
- migrate-reference-data.js populateSlugs() PATCHes (covers both
  Missions + CompletionPaths via shared headers object)
- migrate-user-progress.js importUsers() POSTs (defense-in-depth;
  current user-progress entities are not @changelog-tracked)"
```

---

## Task 4: Hybrid test (real HANA)

**Goal:** Pin HANA-specific `SESSION_CONTEXT` semantics. SQLite session-variable behavior may diverge from HANA; the unit test alone can't catch that.

**Files:**
- Create: `test/hybrid/migration-mode.test.js`

- [ ] **Step 4.1: Inspect existing hybrid test scaffolding**

Read `test/hybrid/_guard.js` and one short existing hybrid test (e.g. `test/hybrid/duplicate-slugs.test.js`) to match the pattern: `ALLOW_HYBRID_WRITES` env gate, `__TEST__` prefix on test data, `afterAll` cleanup.

- [ ] **Step 4.2: Write the hybrid test**

Create `test/hybrid/migration-mode.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import './_guard.js';

cds.test(import.meta.dirname + '/../..');

const TEST_PREFIX = '__TEST__ migration-mode ';

describe('migration-mode handler — HANA session-context contract', () => {
  let srvUrl, headers, createdIds = [];

  beforeAll(() => {
    srvUrl = `http://localhost:${cds.test.port || 4004}`;
    headers = (extra = {}) => ({
      'Content-Type': 'application/json',
      // Replace with the project's hybrid-admin auth pattern; use
      // `cf bind --exec` mocked tokens or basic-auth as configured.
      Authorization: 'Basic ' + Buffer.from('admin:').toString('base64'),
      ...extra,
    });
  });

  afterAll(async () => {
    if (!createdIds.length) return;
    const db = await cds.connect.to('db');
    const Missions = cds.entities['com.sap.developers.ims'].Missions;
    await db.run(DELETE.from(Missions).where({ ID: { in: createdIds } }));
  });

  it('with x-migration-mode header → 0 Changes rows on HANA', async () => {
    const Changes = cds.entities['sap.changelog.Changes'];
    const before = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);

    const slug = '__test__-mig-' + Date.now();
    const r = await fetch(`${srvUrl}/admin/Missions`, {
      method: 'POST',
      headers: headers({ 'x-migration-mode': 'true' }),
      body: JSON.stringify({ title: TEST_PREFIX + 'with-header', slug }),
    });
    expect(r.ok).toBe(true);
    const created = await r.json();
    if (created?.ID) createdIds.push(created.ID);

    const after = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    expect(after - before).toBe(0);
  });

  it('without header → at least one Changes row (control)', async () => {
    const Changes = cds.entities['sap.changelog.Changes'];
    const before = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);

    const slug = '__test__-mig-control-' + Date.now();
    const r = await fetch(`${srvUrl}/admin/Missions`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ title: TEST_PREFIX + 'no-header', slug }),
    });
    expect(r.ok).toBe(true);
    const created = await r.json();
    if (created?.ID) createdIds.push(created.ID);

    const after = Number((await SELECT.one`count(*) as n`.from(Changes))?.n ?? 0);
    expect(after).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 4.3: Run the hybrid test**

Run: `cf target` to confirm DEV space, then:
```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/migration-mode.test.js
```
Expected: both tests pass against real HANA. If the auth header form differs from what hybrid tests use, replace the `Authorization` value with whatever pattern the existing hybrid tests use.

- [ ] **Step 4.4: Commit**

```bash
git add test/hybrid/migration-mode.test.js
git commit -m "test(hybrid): pin HANA SESSION_CONTEXT('ct.skip') behavior (#394)

Verifies the migration-mode handler's session-variable contract on
real HANA — SQLite in-memory may not exercise the same trigger path."
```

---

## Task 5: Documentation

**Goal:** A discoverable runbook + the comment correction in `db/change-tracking.cds` + sidebar registration + CLAUDE.md hook.

**Files:**
- Create: `docs/developers/operations/migration-from-ims.md`
- Modify: `docs/.vitepress/config.ts`
- Modify: `db/change-tracking.cds`
- Modify: `CLAUDE.md`

- [ ] **Step 5.1: Inspect a peer runbook for tone**

Read `docs/developers/operations/btp-role-migration.md` to match heading style, prerequisites format, and code-block conventions.

- [ ] **Step 5.2: Write `docs/developers/operations/migration-from-ims.md`**

Create the file with these sections (heading template; flesh out from the spec's "Documentation" section):

```markdown
# Migrating from the legacy Java IMS

Step-by-step runbook for moving reference data + user progress out of the
legacy `imsprod` system into the CAP backend without polluting
`sap.changelog.Changes`.

## Prerequisites

- `cf login` to the **target** subaccount (DEV / TEST / PROD).
- `IMS_BASE_URL` — usually the production IMS approuter URL.
- `CAP_BASE_URL` — the target CAP srv URL.
- `IMS_AUTH_TOKEN` — bearer token for the source IMS.
- An admin-role XSUAA token for the target CAP srv (`cf curl /v3/...` or
  the bound migration tech user).

## Step 1 — Reference data

Export from IMS, import to CAP. Both calls go through `/admin/<Entity>`
on the target srv. The importer sends `x-migration-mode: true` so
change tracking is automatically suppressed.

\`\`\`bash
npm run migrate:reference -- export
npm run migrate:reference -- import
node scripts/migrate-reference-data.js populate-slugs
\`\`\`

Slug population PATCHes `Missions.slug` and `CompletionPaths.slug` —
also covered by the same header.

## Step 2 — User progress

\`\`\`bash
npm run migrate:users -- export
npm run migrate:users -- import
\`\`\`

Paged + resumable. The header is sent here too as defense-in-depth —
none of the user-progress entities are `@changelog`-tracked today.

## Step 3 — Direct HANA-to-HANA (alternate to step 1)

\`\`\`bash
npm run migrate:hana
\`\`\`

> ⚠️  **Known gap.** On HANA, `@cap-js/change-tracking` deploys
> `AFTER INSERT/UPDATE/DELETE` triggers at the DB level. Direct
> `hdb`-driver writes (which is what `migrate-from-hana.js` does) DO
> fire those triggers — the per-request `x-migration-mode` header
> only protects the REST migrators (Steps 1+2). Until the script is
> updated to set `SESSION_CONTEXT('ct.skip') = 'true'` on its target
> session, prefer Steps 1+2 OR truncate `sap.changelog.Changes`
> after the run with a one-shot SQL `DELETE` scoped by `createdAt` /
> `createdBy`. Followup ticket: #394 explicitly out-of-scope.

## Audit logging

`Users` is `@PersonalData`-annotated (`db/audit-logging.cds`). The
`@cap-js/audit-logging` plugin still emits read/write events on personal
data during migration — this runbook does NOT suppress those. Expected
volume is small (one event per user-create); if that becomes a problem,
file a follow-up.

## Verification

After the migration completes, count `sap.changelog.Changes` rows
created during the migration window. The expected delta for the
migrated entities is **zero**.

\`\`\`bash
cds bind --exec -- node -e "
  const cds = require('@sap/cds');
  cds.connect().then(async () => {
    const C = cds.entities['sap.changelog.Changes'];
    const since = process.argv[1] || '2026-06-18T00:00:00Z';
    const rows = await SELECT.from(C).where({ createdAt: { '>=': since } });
    console.log(rows.length + ' changelog rows created since ' + since);
  });
" -- "2026-06-18T00:00:00Z"
\`\`\`

## See also

- [BTP role migration](btp-role-migration.md)
- Spec: `docs/superpowers/specs/2026-06-18-394-disable-change-tracking-during-migration-design.md`
```

(The example SQL at the bottom is illustrative; the implementer should test the actual cds-bind one-liner before committing the doc.)

- [ ] **Step 5.3: Register the new page in VitePress sidebar**

Read `docs/.vitepress/config.ts` and find the Operations sidebar group (search for `'btp-role-migration'`). Add the new entry adjacent — same depth, same shape:

```ts
{ text: 'Migration from IMS', link: '/developers/operations/migration-from-ims' },
```

- [ ] **Step 5.4: Verify docs build**

Run: `npm run docs:build`
Expected: build completes; no "unregistered page" or "dead link" errors. If the predocs sidebar guard fires, fix the link/path before continuing.

- [ ] **Step 5.5: Amend `db/change-tracking.cds` comment header**

Read the existing comment (lines 1–6). Replace with the corrected text from the spec's §Documentation:

```cds
// Change tracking is configured via @changelog annotations at the service level
// in srv/change-tracking.cds. The @cap-js/change-tracking plugin automatically
// adds the 'changes' association and UI facet to annotated entities at runtime.
//
// Annotating at AdminService means only admin UI changes are tracked
// FOR NON-DB-LEVEL WRITE PATHS. On HANA the plugin generates AFTER
// INSERT/UPDATE/DELETE triggers at the DB level, so direct hdb-driver
// writes (e.g. scripts/migrate-from-hana.js, raw SQL maintenance) DO
// fire the triggers unless the connection sets
// SESSION_CONTEXT('ct.skip') = 'true'. The REST migrators set this via
// the `x-migration-mode` HTTP header — see
// docs/developers/operations/migration-from-ims.md.
```

- [ ] **Step 5.6: Add the one-line CLAUDE.md hook**

Read CLAUDE.md and find the `### Data Migration` section. Append (or insert at the bottom of that section) one line:

```markdown
- **Change tracking is suppressed for REST migrators** via the `x-migration-mode: true` header sent by `migrate-reference-data.js` and `migrate-user-progress.js`. The HANA-to-HANA path (`migrate-from-hana.js`) still fires DB-level changelog triggers — see [migration-from-ims.md](docs/developers/operations/migration-from-ims.md).
```

- [ ] **Step 5.7: Commit**

```bash
git add docs/developers/operations/migration-from-ims.md docs/.vitepress/config.ts db/change-tracking.cds CLAUDE.md
git commit -m "docs(migration): runbook + corrected change-tracking comment (#394)

- New /developers/operations/migration-from-ims.md runbook
- Sidebar registration in docs/.vitepress/config.ts
- db/change-tracking.cds header comment corrected (the original
  claim that DB-level writes are excluded was wrong on HANA — the
  plugin's HANA implementation deploys AFTER triggers that fire on
  every write regardless of layer)
- CLAUDE.md Data Migration section gains a one-line pointer"
```

---

## Task 6: Manual verification on DEV

**Goal:** End-to-end confirmation against a real HANA HDI before opening the PR. Captures the snapshot evidence the PR description needs.

**Files:** none (operational task)

- [ ] **Step 6.1: Confirm CF target**

Run: `cf target`
Expected: org `tutorial-system`, space `dev`. If wrong: `cf login` and re-target.

- [ ] **Step 6.2: Bind to the dev HDI**

Run: `cds bind -2 tutorials-srv:tutorials-db --kind hana`
Expected: profile is created/updated; `cds bind --resolve hybrid` lists `db: hana`.

- [ ] **Step 6.3: Snapshot pre-migration row count**

Run:
```bash
cds bind --exec --profile hybrid -- node -e "
  const cds = require('@sap/cds');
  cds.connect.to('db').then(async (db) => {
    const Changes = cds.entities['sap.changelog.Changes'];
    const n = (await SELECT.one\`count(*) as n\`.from(Changes))?.n ?? 0;
    console.log('PRE-MIGRATION Changes count:', n);
    process.exit(0);
  }).catch(e => { console.error(e); process.exit(1); });
"
```
Expected: a single integer printed. Record it.

- [ ] **Step 6.4: Run a small reference-data import against DEV**

Set `CAP_BASE_URL` to the DEV srv URL. Run:
```bash
CAP_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
  npm run migrate:reference -- import
```
(Pre-existing `.migration-data/` from a prior export is required. If empty, run `... -- export` against IMS first or skip this step and use a smaller test fixture.)

Expected: import completes; per-entity row counts logged.

- [ ] **Step 6.5: Snapshot post-migration row count**

Re-run the snapshot command from Step 6.3.
Expected: post − pre = 0 (or very small if concurrent admin UI activity is happening).

- [ ] **Step 6.6: If the delta is non-zero — diagnose**

Likely causes:
1. Header isn't reaching the srv — check the migrator logs / inspect the running srv with `cf logs --recent tutorials-srv | grep migration-mode`.
2. The user role isn't `Admin` — temporarily flip `cds.log('migration-mode')` to `debug` and re-run.
3. The handler didn't register — search the server logs for `migration-mode handler registered on cds.db` at boot.

If diagnosis reveals a real bug, return to the failing task, fix, retry from Step 6.3.

- [ ] **Step 6.7: Capture the snapshot output for the PR description**

Save the pre/post snapshot output to a scratch file or paste into the PR description as the verification log.

---

## Task 7: PR

**Goal:** Open the PR with a clean description, snapshot evidence, and `Closes #394`.

- [ ] **Step 7.1: Push the branch**

Run:
```bash
git branch --show-current
git push -u origin worktree-issue-394-disable-change-tracking-during-migration
```

- [ ] **Step 7.2: Open the PR**

Run:
```bash
gh pr create --base main \
  --title "feat: suppress change tracking during REST data migration (#394)" \
  --body "$(cat <<'EOF'
Closes #394.

## Why

REST migrators (`migrate-reference-data.js`, `migrate-user-progress.js`) POST/PATCH through `/admin/<Entity>`, which fires `@cap-js/change-tracking` triggers — every record migrated produces a row in `sap.changelog.Changes`. A full reference-data run currently dumps thousands of rows that record "migration imported X" rather than a real admin action.

## What

- New DB-level handler at `srv/lib/migration-mode.js`, wired in `srv/server.js` on `cds.on('served')`. Sets `ct.skip` session variable on the DB tx when the request carries `x-migration-mode: true` AND `req.user.is('Admin')`. Paired `after` resets so pooled connections don't carry the flag forward.
- Both REST migrators send the header from three sites: `importData()` POSTs, `populateSlugs()` PATCHes (Missions + CompletionPaths via shared `headers` object), `importUsers()` POSTs.
- Tests: 1 unit file (plugin-contract pin + 3 handler-gate cases) + 1 hybrid file (HANA SESSION_CONTEXT pin).
- Runbook: `docs/developers/operations/migration-from-ims.md`. Registered in vitepress sidebar.
- Comment correction: `db/change-tracking.cds`'s file header was misleading on HANA (DB-level triggers fire regardless of write path); rewritten.

## Out of scope

- `migrate-from-hana.js` raw-SQL writes still fire HANA triggers. Documented as a known gap with a runbook mitigation (truncate Changes after the run, or set `SESSION_CONTEXT('ct.skip')` on the hdb session). Followup ticket recommended.
- `@cap-js/audit-logging` events for `Users` writes are not suppressed (different plugin, different API).

## Manual verification on DEV

\`\`\`
PRE-MIGRATION Changes count:  <pre>
... migrate:reference -- import
POST-MIGRATION Changes count: <post>

delta: 0
\`\`\`

Spec: docs/superpowers/specs/2026-06-18-394-disable-change-tracking-during-migration-design.md
EOF
)"
```

(Replace `<pre>` and `<post>` with the captured values from Task 6.7 before submitting.)

- [ ] **Step 7.3: Wait for CI**

Watch the smoke + unit + hybrid jobs. The hybrid job runs against the project's bound HANA (per `vitest.config.ts` projects). If hybrid CI fails on auth, the test's `Authorization` header may need adjusting to the project's CI hybrid pattern (check existing hybrid tests like `test/hybrid/duplicate-slugs.test.js`).

---

## Notes / decisions captured during the spec round

- **Role name is `Admin`**, capital A. `'admin'` would silently fail the gate (no XSUAA scope by that name).
- **Handler runs at `cds.db.before(['INSERT','UPDATE','DELETE'])`**, not on AdminService. Mirrors the plugin's own `lib/skipHandlers.js:10` location, where `req._tx` is reliably the DB tx.
- **Header is read from `cds.context.http?.req?.headers`**, the documented stable API for Express headers in CAP. `req.http?.headers || req._?.req?.headers` would be brittle.
- **Population step (`populateSlugs()`) is a third header site** that the original spec missed. Confirmed by reading lines 139–200 of `migrate-reference-data.js`; the shared `headers` object on line ~147 covers both the Missions PATCH loop and the CompletionPaths PATCH loop.
- **`migrate-from-hana.js` is intentionally out of scope.** Documented in the runbook as a known gap.
- **Audit logging is intentionally out of scope.** Different plugin (`@cap-js/audit-logging`), separate suppression API.
- **No global `MIGRATION_MODE` env var.** Header-per-request avoids the "forgot to turn it back off" failure mode.

## What success looks like

1. `npx vitest run test/unit/migration-mode.test.js` — all green.
2. `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/migration-mode.test.js` — green against DEV HANA.
3. `npm run docs:build` — green.
4. Manual snapshot delta on DEV: 0.
5. PR open, CI green, Closes #394.
