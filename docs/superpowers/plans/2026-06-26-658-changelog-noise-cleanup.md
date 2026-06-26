# Changelog Noise Cleanup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the @cap-js/change-tracking plugin from logging phantom rows on @odata.singleton admin tiles and on the KG / AI extraction cron, and purge the historical noise already accumulated in `sap.changelog.Changes`.

**Architecture:** Three small surgical pieces. (1) Remove `@changelog` from nine entities that aren't real audit material — seven configuration singletons + two AI-generated KG tables. (2) Add a tiny `purgeStaleChangelog` helper that deletes `sap.changelog.Changes` rows by `entity` list, wrapped in an idempotent one-shot called from `cds.on('served')` via the existing `JobLocks`-based `runWithLock` pattern. (3) Expose the same helper as a new `purgeNoiseChangeLog` OData action on AdminService so support can re-run it ad-hoc.

**Tech Stack:** CAP Node.js, `@cap-js/change-tracking@2.0.0-beta.11`, HANA Cloud, Vitest (unit + hybrid workspaces), existing `srv/jobs/job-lock.js` distributed lock primitive.

**Spec:** [docs/superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md](../specs/2026-06-26-658-changelog-noise-cleanup-design.md)

**Branch:** `feat/658-changelog-noise-cleanup` (already created)

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| [db/change-tracking.cds](../../../db/change-tracking.cds) | Modify | Remove `@changelog` from the nine offending entities; leave a rationale comment block. |
| [srv/lib/purge-stale-changelog.js](../../../srv/lib/purge-stale-changelog.js) | Create | Exports `NOISE_ENTITIES` constant and `purgeStaleChangelog({ entities, db })` helper. Returns `{ deleted, alreadyRan? }`. |
| [srv/server.js](../../../srv/server.js) | Modify | Inside the existing `cds.on('served', …)` handler, call `runWithLock('changelog-noise-purge-v1', …, purgeStaleChangelog)` once per deploy. |
| [srv/jobs/scheduler.js](../../../srv/jobs/scheduler.js) | Reference only | `runWithLock` lives here; it's a module-scope function used inside the file. We will lift the pattern (NOT the function) into a small reusable export, OR call the equivalent `acquireLock`/`releaseLock` primitives directly from `srv/lib/purge-stale-changelog.js`. Decision below. |
| [srv/admin-service.cds](../../../srv/admin-service.cds) | Modify | Add `action purgeNoiseChangeLog(entities : array of String) returns { deleted : Integer; };` |
| [srv/admin-service.js](../../../srv/admin-service.js) | Modify | Bind a handler for the new action that delegates to `purgeStaleChangelog`. |
| [srv/__tests__/purge-stale-changelog.test.js](../../../srv/__tests__/purge-stale-changelog.test.js) | Create | Vitest unit suite (unit workspace, in-memory SQLite) covering: entity-list filtering, default list, sentinel idempotency. |
| [test/hybrid/changelog-noise.test.js](../../../test/hybrid/changelog-noise.test.js) | Create | Vitest hybrid suite (real HANA) covering: trigger drop after annotation removal, auto-purge sentinel behavior, control-entity isolation. |
| [docs/developers/operations/migration-from-ims.md](../../../docs/developers/operations/migration-from-ims.md) | Modify | Add cross-link to new spec + admin action in the existing "changelog triggers mitigation" section. |
| [C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_changelog_curation_singletons_and_ai_tables.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_changelog_curation_singletons_and_ai_tables.md) | Create | Memory file locking in the curation rule. |
| [C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md) | Modify | One-line index entry pointing at the new memory file. |

### Decision: `runWithLock` reuse strategy

`runWithLock` in `srv/jobs/scheduler.js` is a module-scope private function that wraps `acquireLock`/`releaseLock` from `srv/jobs/job-lock.js` AND records PipelineLog entries. The PipelineLog wrapper is irrelevant for our one-shot purge (a single boot-time housekeeping task is not a pipeline). **We call `acquireLock` / `releaseLock` directly from inside `purgeStaleChangelog`'s auto-purge wrapper.** That keeps `purge-stale-changelog.js` standalone, importable, and unit-testable without dragging the scheduler.

---

## Task 1: Remove `@changelog` from the nine entities

**Files:**
- Modify: [db/change-tracking.cds](../../../db/change-tracking.cds)

- [ ] **Step 1.1: Read the current file**

Run: `cat db/change-tracking.cds`
Expected: The annotations listed in the spec exist on lines 17, 18, 19–21, 25–26, 30, 34–38.

- [ ] **Step 1.2: Replace the annotation block**

Edit [db/change-tracking.cds](../../../db/change-tracking.cds). Replace lines 17–38 with:

```cds
// =========================================================================
// Audit-material entities — keep tracked.
// =========================================================================
// Human-edited content where edit history adds real audit value.
annotate ims.Advocates       with @changelog;
annotate ims.AdvocateTopics  with @changelog;
annotate ims.AdvocateLinks   with @changelog;

// Phase 2-B (#464): track admin edits to tracked-secret metadata
// (description, expiresAt, rotationOwner). Surfaces in /admin-ui/#changelog-display.
annotate ims.Secrets with @changelog;

// =========================================================================
// Intentionally NOT @changelog-tracked — see issue #658.
// =========================================================================
// Two categories of entities are excluded from change-tracking:
//
//   1. Configuration singletons (@odata.singleton-projected). Each has a
//      lazy `before('READ')` auto-init handler in srv/admin-service.js
//      that idempotently INSERTs a default row when its backing table is
//      empty (to avoid 404 on first read on a fresh subaccount). With
//      @changelog active the INSERT trips the HANA AFTER trigger and
//      writes a no-delta "Create" row attributed to whoever did the read.
//      These entities are feature-flag / runtime-config shaped; pages of
//      synthetic "Create" rows on first read are pure noise.
//
//      ChatSettings, KnowledgeGraphSettings, UiEventsSettings,
//      TenantSettings, SearchSettings, NavigatorSettings, DisplaySettings.
//
//   2. AI-generated knowledge-graph tables (Concepts, ConceptEdges).
//      The extract-concepts cron deletes-and-reinserts ConceptEdges and
//      bumps Concepts.lastSeenAt/extractionCount on every run. With
//      @changelog active the triggers fire thousands of empty-attribute
//      rows per cron tick. Admin curation (rename/describe/veto) on
//      Concepts is rare enough that the trade-off isn't worth it.
//
// Spec: docs/superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md
```

(Delete the Concepts/ConceptEdges annotations on lines 25-26 and the Phase-3 block on lines 34-38; keep the `using` statements at the top of the file unchanged.)

- [ ] **Step 1.3: Verify the file compiles**

Run: `npx cds compile db/change-tracking.cds --to csn 2>&1 | tail -5`
Expected: No errors. Output is JSON-ish CSN.

- [ ] **Step 1.4: Verify the four kept entities still have @changelog**

Run: `grep -n "@changelog" db/change-tracking.cds`
Expected: 4 lines — Advocates, AdvocateTopics, AdvocateLinks, Secrets.

- [ ] **Step 1.5: Verify the nine removed entities no longer have @changelog**

Run: `grep -E "ChatSettings|KnowledgeGraphSettings|UiEventsSettings|TenantSettings|DisplaySettings|SearchSettings|NavigatorSettings|Concepts|ConceptEdges" db/change-tracking.cds`
Expected: zero `@changelog` matches. (Comment-block prose mentioning them is fine.)

- [ ] **Step 1.6: Re-stage `db/last-dev/csn.json`**

Run: `npx cds build --production 2>&1 | tail -10`
Expected: Build succeeds; `db/last-dev/csn.json` and any `db/src/sap.changelog.*` files are regenerated. `git status` shows `db/last-dev/csn.json` modified.

- [ ] **Step 1.7: Commit**

```bash
git add db/change-tracking.cds db/last-dev/
git commit -m "feat(#658): drop @changelog from configuration singletons and KG tables

@cap-js/change-tracking AFTER triggers fire on the lazy auto-init INSERTs
that the @odata.singleton tiles do in before('READ'), and on every
cron-driven delete/insert of ConceptEdges. The resulting no-delta
'Create' and empty-attribute 'Update' rows flood the admin Change
History tile. None of these entities carry audit-material content
(feature flags / AI-generated graph), so the structurally honest fix
is to remove @changelog from them.

Entities un-tracked:
  ChatSettings, KnowledgeGraphSettings, UiEventsSettings,
  TenantSettings, SearchSettings, NavigatorSettings, DisplaySettings,
  Concepts, ConceptEdges

Entities still tracked (real audit material):
  Advocates, AdvocateTopics, AdvocateLinks, Secrets

Spec: docs/superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md"
```

---

## Task 2: Create `purgeStaleChangelog` helper (unit-tested)

**Files:**
- Create: [srv/lib/purge-stale-changelog.js](../../../srv/lib/purge-stale-changelog.js)
- Create: [srv/__tests__/purge-stale-changelog.test.js](../../../srv/__tests__/purge-stale-changelog.test.js)

- [ ] **Step 2.1: Write the failing test (entity-list filter)**

Create [srv/__tests__/purge-stale-changelog.test.js](../../../srv/__tests__/purge-stale-changelog.test.js):

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { purgeStaleChangelog, NOISE_ENTITIES } from '../lib/purge-stale-changelog.js';

const { GET, POST } = cds.test().in(import.meta.dirname, '..', '..');

async function seedChange(entity, attribute = 'test', createdBy = 'system') {
  const { Changes } = cds.entities('sap.changelog');
  await INSERT.into(Changes).entries({
    ID: cds.utils.uuid(),
    entity,
    entityKey: 'k1',
    attribute,
    valueDataType: 'cds.String',
    valueChangedFrom: 'a',
    valueChangedTo: 'b',
    modification: 'update',
    createdAt: new Date().toISOString(),
    createdBy,
  });
}

async function countChanges(entity) {
  const { Changes } = cds.entities('sap.changelog');
  const rows = await SELECT.from(Changes).where({ entity });
  return rows.length;
}

describe('purgeStaleChangelog', () => {
  beforeEach(async () => {
    const { Changes } = cds.entities('sap.changelog');
    await DELETE.from(Changes);
  });

  it('deletes rows only for the supplied entity list', async () => {
    await seedChange('com.sap.developers.ims.Concepts');
    await seedChange('com.sap.developers.ims.Advocates');

    const { deleted } = await purgeStaleChangelog({
      entities: ['com.sap.developers.ims.Concepts'],
    });

    expect(deleted).toBe(1);
    expect(await countChanges('com.sap.developers.ims.Concepts')).toBe(0);
    expect(await countChanges('com.sap.developers.ims.Advocates')).toBe(1);
  });
});
```

- [ ] **Step 2.2: Run the test, see it fail**

Run: `npx vitest run srv/__tests__/purge-stale-changelog.test.js`
Expected: FAIL with `Cannot find module '.../srv/lib/purge-stale-changelog.js'` (or similar).

- [ ] **Step 2.3: Write minimal helper**

Create [srv/lib/purge-stale-changelog.js](../../../srv/lib/purge-stale-changelog.js):

```js
import cds from '@sap/cds';
import { acquireLock } from '../jobs/job-lock.js';

const LOG = cds.log('purge-stale-changelog');

/**
 * Entities whose `@changelog` was removed in #658. The auto-purge helper
 * defaults to this list when called without an explicit `entities` argument.
 *
 * If a future PR drops @changelog from another entity, add it here AND bump
 * the sentinel version in srv/server.js so the auto-purge re-runs to clean
 * up the legacy rows.
 */
export const NOISE_ENTITIES = Object.freeze([
  'com.sap.developers.ims.ChatSettings',
  'com.sap.developers.ims.KnowledgeGraphSettings',
  'com.sap.developers.ims.UiEventsSettings',
  'com.sap.developers.ims.TenantSettings',
  'com.sap.developers.ims.DisplaySettings',
  'com.sap.developers.ims.SearchSettings',
  'com.sap.developers.ims.NavigatorSettings',
  'com.sap.developers.ims.Concepts',
  'com.sap.developers.ims.ConceptEdges',
]);

/**
 * Bulk-delete `sap.changelog.Changes` rows by `entity`. Returns the number of
 * rows removed. When `entities` is empty / nullish / not an array, the
 * NOISE_ENTITIES default list is used.
 *
 * @param {Object}   [opts]
 * @param {string[]} [opts.entities] Explicit entity allowlist.
 * @returns {Promise<{deleted: number}>}
 */
export async function purgeStaleChangelog({ entities } = {}) {
  const list =
    Array.isArray(entities) && entities.length > 0 ? entities : NOISE_ENTITIES;
  const Changes = cds.entities('sap.changelog').Changes;
  const deleted = await DELETE.from(Changes).where({ entity: { in: list } });
  LOG.info(`Deleted ${deleted} changelog rows across ${list.length} entities`);
  return { deleted };
}

/**
 * One-shot wrapper called from cds.on('served'). Uses the JobLocks-based
 * lock primitive so exactly one CF instance runs the purge on each deploy.
 * The `version` string is part of the lock name; bump it (`-v2`, `-v3`, …)
 * when a future PR adds new entities to NOISE_ENTITIES and the legacy rows
 * need a fresh sweep.
 *
 * Returns `{ deleted, alreadyRan }`. `alreadyRan: true` means the sentinel
 * row was already present in `JobLocks` and this caller did not delete
 * anything.
 *
 * The lock is held for 10 minutes (deliberately generous — the actual
 * DELETE runs in seconds, but we never release the lock so the row acts
 * as a permanent sentinel). When the lock expires after 10 minutes,
 * `acquireLock` will let a future deploy take it over. That's intentional
 * — if NOISE_ENTITIES is bumped without changing the version suffix,
 * the next deploy MORE-THAN-10-minutes later will re-sweep, which is a
 * harmless idempotent DELETE.
 */
export async function autoPurgeOnce({ version = 'v1' } = {}) {
  const jobName = `changelog-noise-purge-${version}`;
  const instanceId = process.env.CF_INSTANCE_INDEX || '0';
  const TEN_MINUTES = 10 * 60 * 1000;

  const acquired = await acquireLock(jobName, instanceId, TEN_MINUTES);
  if (!acquired) {
    LOG.info(`Sentinel ${jobName} already held; skipping auto-purge`);
    return { deleted: 0, alreadyRan: true };
  }

  // Intentionally do NOT release the lock — the JobLocks row is the sentinel.
  // The 10-minute expiry is the recovery valve in case a future entity-list
  // bump needs to re-sweep without writing a one-off migration.
  const result = await purgeStaleChangelog();
  return { ...result, alreadyRan: false };
}
```

- [ ] **Step 2.4: Run the test, see it pass**

Run: `npx vitest run srv/__tests__/purge-stale-changelog.test.js`
Expected: 1 passed.

- [ ] **Step 2.5: Add the "default list" test**

Append to [srv/__tests__/purge-stale-changelog.test.js](../../../srv/__tests__/purge-stale-changelog.test.js) inside the `describe`:

```js
  it('uses NOISE_ENTITIES when entities arg is empty', async () => {
    for (const ent of NOISE_ENTITIES) await seedChange(ent);
    await seedChange('com.sap.developers.ims.Advocates'); // control

    const { deleted } = await purgeStaleChangelog({ entities: [] });

    expect(deleted).toBe(NOISE_ENTITIES.length);
    expect(await countChanges('com.sap.developers.ims.Advocates')).toBe(1);
  });

  it('uses NOISE_ENTITIES when entities arg is undefined', async () => {
    await seedChange('com.sap.developers.ims.Concepts');
    await seedChange('com.sap.developers.ims.Advocates'); // control

    const { deleted } = await purgeStaleChangelog();

    expect(deleted).toBe(1);
    expect(await countChanges('com.sap.developers.ims.Advocates')).toBe(1);
  });
```

- [ ] **Step 2.6: Run all three tests**

Run: `npx vitest run srv/__tests__/purge-stale-changelog.test.js`
Expected: 3 passed.

- [ ] **Step 2.7: Add the sentinel-idempotency test**

Append to the same file:

```js
import { autoPurgeOnce } from '../lib/purge-stale-changelog.js';

describe('autoPurgeOnce', () => {
  beforeEach(async () => {
    const { Changes } = cds.entities('sap.changelog');
    const { JobLocks } = cds.entities('com.sap.developers.ims');
    await DELETE.from(Changes);
    await DELETE.from(JobLocks).where({
      jobName: { like: 'changelog-noise-purge-%' },
    });
  });

  it('runs the purge on first call, no-ops on the second', async () => {
    // Seed one noise row so the first call has something to delete.
    const { Changes } = cds.entities('sap.changelog');
    await INSERT.into(Changes).entries({
      ID: cds.utils.uuid(),
      entity: 'com.sap.developers.ims.Concepts',
      entityKey: 'k1',
      attribute: 'x',
      valueDataType: 'cds.String',
      modification: 'update',
      createdAt: new Date().toISOString(),
      createdBy: 'system',
    });

    const first = await autoPurgeOnce({ version: 'test-v1' });
    expect(first).toMatchObject({ deleted: 1, alreadyRan: false });

    const second = await autoPurgeOnce({ version: 'test-v1' });
    expect(second).toMatchObject({ deleted: 0, alreadyRan: true });
  });
});
```

- [ ] **Step 2.8: Run all tests**

Run: `npx vitest run srv/__tests__/purge-stale-changelog.test.js`
Expected: 4 passed.

- [ ] **Step 2.9: Commit**

```bash
git add srv/lib/purge-stale-changelog.js srv/__tests__/purge-stale-changelog.test.js
git commit -m "feat(#658): purge-stale-changelog helper + autoPurgeOnce sentinel

Standalone, importable, unit-tested. NOISE_ENTITIES list mirrors the
nine entities un-tracked in db/change-tracking.cds. autoPurgeOnce
holds a JobLocks row as a sentinel so exactly one CF instance runs
the sweep per deploy; the 10-minute lock expiry is the recovery
valve for future entity-list bumps."
```

---

## Task 3: Wire `autoPurgeOnce` into server bootstrap

**Files:**
- Modify: [srv/server.js](../../../srv/server.js) (inside existing `cds.on('served', …)` at line 490)

- [ ] **Step 3.1: Add the import**

Edit [srv/server.js](../../../srv/server.js). Near the other `import` lines at the top of the file (the existing scheduler import is on line 4), add:

```js
import { autoPurgeOnce } from './lib/purge-stale-changelog.js';
```

- [ ] **Step 3.2: Call it from the first `served` handler**

Locate the existing `cds.on('served', async () => {` at line 490. Inside that handler, after the existing `globalThis.__feedbackBeforeHookRegistered` block, add:

```js
  // #658 — one-shot purge of accumulated noise rows in sap.changelog.Changes
  // for entities whose @changelog annotation was retroactively dropped. Held
  // behind a JobLocks sentinel so it runs exactly once per CF deploy across
  // all instances. Failure here MUST NOT crash boot — it's a housekeeping
  // task, not a startup requirement.
  if (!globalThis.__changelogNoisePurgeAttempted) {
    globalThis.__changelogNoisePurgeAttempted = true;
    autoPurgeOnce({ version: 'v1' })
      .then((res) => {
        if (res.alreadyRan) {
          cds.log('purge-stale-changelog').debug('Purge sentinel already held');
        } else {
          cds.log('purge-stale-changelog').info(
            `Auto-purged ${res.deleted} stale changelog rows on first boot`,
          );
        }
      })
      .catch((err) => {
        cds.log('purge-stale-changelog').warn(
          'Auto-purge failed (non-fatal):',
          err.message,
        );
      });
  }
```

- [ ] **Step 3.3: Sanity-check `cds watch` boots clean**

Run: `npx cds watch --in-memory 2>&1 | head -40`
Expected: No errors on boot. The `Auto-purged 0 stale changelog rows on first boot` log line should appear (in-memory DB has no noise rows, so deleted=0). Kill with Ctrl-C.

- [ ] **Step 3.4: Commit**

```bash
git add srv/server.js
git commit -m "feat(#658): wire autoPurgeOnce into cds.on('served')

Held behind a per-process idempotency flag (defends against cds.test()
re-firing 'served' across test files) AND a JobLocks sentinel (defends
against multiple CF instances). Errors are logged at warn and swallowed
— housekeeping must never crash boot."
```

---

## Task 4: Expose `purgeNoiseChangeLog` admin action

**Files:**
- Modify: [srv/admin-service.cds](../../../srv/admin-service.cds)
- Modify: [srv/admin-service.js](../../../srv/admin-service.js)
- Create: [srv/__tests__/admin-service-purge-noise.test.js](../../../srv/__tests__/admin-service-purge-noise.test.js)

- [ ] **Step 4.1: Write the failing admin-action test**

Create [srv/__tests__/admin-service-purge-noise.test.js](../../../srv/__tests__/admin-service-purge-noise.test.js):

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';

const { POST } = cds.test().in(import.meta.dirname, '..', '..');

async function seed(entity) {
  const { Changes } = cds.entities('sap.changelog');
  await INSERT.into(Changes).entries({
    ID: cds.utils.uuid(),
    entity,
    entityKey: 'k1',
    attribute: 'x',
    valueDataType: 'cds.String',
    modification: 'update',
    createdAt: new Date().toISOString(),
    createdBy: 'system',
  });
}

describe('AdminService.purgeNoiseChangeLog', () => {
  beforeEach(async () => {
    const { Changes } = cds.entities('sap.changelog');
    await DELETE.from(Changes);
  });

  it('purges only the supplied entity list', async () => {
    await seed('com.sap.developers.ims.Concepts');
    await seed('com.sap.developers.ims.Advocates'); // control

    const res = await POST(
      '/admin/purgeNoiseChangeLog',
      { entities: ['com.sap.developers.ims.Concepts'] },
      { auth: { username: 'admin', password: 'admin' } },
    );

    expect(res.data.deleted).toBe(1);
  });

  it('falls back to NOISE_ENTITIES when entities is empty', async () => {
    await seed('com.sap.developers.ims.Concepts');
    await seed('com.sap.developers.ims.ChatSettings');
    await seed('com.sap.developers.ims.Advocates'); // control

    const res = await POST(
      '/admin/purgeNoiseChangeLog',
      { entities: [] },
      { auth: { username: 'admin', password: 'admin' } },
    );

    expect(res.data.deleted).toBe(2);
  });
});
```

- [ ] **Step 4.2: Run the test, see it fail**

Run: `npx vitest run srv/__tests__/admin-service-purge-noise.test.js`
Expected: FAIL with a 404 / "action not found" from the OData server.

- [ ] **Step 4.3: Add the action to the CDS**

Edit [srv/admin-service.cds](../../../srv/admin-service.cds) at the same group of admin actions where `clearChangeLog` lives (the action block around line 224). After the closing `};` of `clearChangeLog`, add:

```cds
  // Bulk-purge sap.changelog.Changes rows for entities whose @changelog
  // tracking was retroactively dropped (configuration singletons +
  // AI-generated KG tables — see #658). Pass an empty array (or omit) to
  // use the NOISE_ENTITIES default list. Idempotent.
  action purgeNoiseChangeLog(entities : array of String) returns {
    deleted : Integer;
  };
```

- [ ] **Step 4.4: Bind the handler**

Edit [srv/admin-service.js](../../../srv/admin-service.js). Near the existing `clearChangeLog` handler at line 802, add:

```js
    // purgeNoiseChangeLog — sibling of clearChangeLog. Deletes
    // sap.changelog.Changes rows by `entity` allowlist. Empty / missing
    // list ⇒ use NOISE_ENTITIES default. See srv/lib/purge-stale-changelog.js.
    this.on('purgeNoiseChangeLog', async (req) => {
      const { purgeStaleChangelog } = await import(
        './lib/purge-stale-changelog.js'
      );
      const entities = Array.isArray(req.data.entities)
        ? req.data.entities
        : [];
      return await purgeStaleChangelog({ entities });
    });
```

(Dynamic import keeps the bootstrap cost off the cold path; the helper is small but the pattern is consistent with how other admin handlers lazy-load heavy logic.)

- [ ] **Step 4.5: Run the test, see it pass**

Run: `npx vitest run srv/__tests__/admin-service-purge-noise.test.js`
Expected: 2 passed.

- [ ] **Step 4.6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js srv/__tests__/admin-service-purge-noise.test.js
git commit -m "feat(#658): purgeNoiseChangeLog admin action

OData action sibling of clearChangeLog. Deletes sap.changelog.Changes
rows by entity allowlist; empty/omitted list falls back to the canonical
NOISE_ENTITIES default. Idempotent — safe to invoke repeatedly. No
admin-UI button in this PR (action is reachable via the OData endpoint
or a future operations-app button)."
```

---

## Task 5: Hybrid test — verify HANA trigger drop + auto-purge against real DB

**Files:**
- Create: [test/hybrid/changelog-noise.test.js](../../../test/hybrid/changelog-noise.test.js)

**Prerequisite:** `cf login` to the DEV space. The hybrid workspace requires `cds bind --exec`. See [test/hybrid/_guard.js](../../../test/hybrid/_guard.js) for the write-safety contract — set `ALLOW_HYBRID_WRITES=true` before running.

- [ ] **Step 5.1: Scaffold the test file**

Create [test/hybrid/changelog-noise.test.js](../../../test/hybrid/changelog-noise.test.js):

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import './_guard.js';
import {
  NOISE_ENTITIES,
  autoPurgeOnce,
  purgeStaleChangelog,
} from '../../srv/lib/purge-stale-changelog.js';

const TEST_PREFIX = '__TEST__658__';

describe('changelog noise cleanup (#658)', () => {
  let db;
  beforeAll(async () => {
    db = await cds.connect.to('db');
  });

  it('drops HANA AFTER triggers for un-tracked entities', async () => {
    // After the PR ships, no AFTER INSERT/UPDATE/DELETE trigger should exist
    // on the SQL tables backing the nine un-tracked entities. The plugin
    // names triggers <table>_AFTER_<op>_CHANGELOG (verified at
    // node_modules/@cap-js/change-tracking/lib/hana/triggers.js).
    const noiseTables = NOISE_ENTITIES.map((e) =>
      e.replace(/\./g, '_').toUpperCase(),
    );
    const rows = await db.run(
      `SELECT TRIGGER_NAME, SUBJECT_TABLE_NAME FROM SYS.TRIGGERS
       WHERE SUBJECT_TABLE_NAME IN (${noiseTables.map(() => '?').join(',')})`,
      noiseTables,
    );
    expect(rows).toEqual([]);
  });

  it('control: trigger still exists on a kept entity (Advocates)', async () => {
    const rows = await db.run(
      `SELECT COUNT(*) AS C FROM SYS.TRIGGERS
       WHERE SUBJECT_TABLE_NAME = 'COM_SAP_DEVELOPERS_IMS_ADVOCATES'`,
    );
    // Defensive — at least one (CREATE/UPDATE/DELETE) trigger must exist.
    expect(rows[0].C).toBeGreaterThan(0);
  });

  it('autoPurgeOnce is idempotent across calls', async () => {
    // Use a one-off sentinel version so this test never collides with the
    // production v1 sentinel.
    const version = `${TEST_PREFIX}${Date.now()}`;
    try {
      const a = await autoPurgeOnce({ version });
      expect(a.alreadyRan).toBe(false);
      const b = await autoPurgeOnce({ version });
      expect(b).toMatchObject({ deleted: 0, alreadyRan: true });
    } finally {
      const { JobLocks } = cds.entities('com.sap.developers.ims');
      await DELETE.from(JobLocks).where({ jobName: { like: `%${version}%` } });
    }
  });

  it('purgeStaleChangelog scopes to the entity list only', async () => {
    // Seed two rows — one noise, one control — under a TEST prefix so the
    // write guard is happy. The DELETE filter is by `entity` (not by ID),
    // so other Concepts rows on shared DEV DB will also be swept; the
    // load-bearing assertion is "control survives, noise row gone".
    const { Changes } = cds.entities('sap.changelog');
    const noiseId = cds.utils.uuid();
    const ctrlId = cds.utils.uuid();
    await INSERT.into(Changes).entries([
      {
        ID: noiseId,
        entity: 'com.sap.developers.ims.Concepts',
        entityKey: `${TEST_PREFIX}k1`,
        attribute: 'x',
        valueDataType: 'cds.String',
        modification: 'update',
        createdAt: new Date().toISOString(),
        createdBy: TEST_PREFIX,
      },
      {
        ID: ctrlId,
        entity: 'com.sap.developers.ims.Advocates',
        entityKey: `${TEST_PREFIX}k2`,
        attribute: 'x',
        valueDataType: 'cds.String',
        modification: 'update',
        createdAt: new Date().toISOString(),
        createdBy: TEST_PREFIX,
      },
    ]);

    try {
      await purgeStaleChangelog({
        entities: ['com.sap.developers.ims.Concepts'],
      });
      // Load-bearing: control row (Advocates) survives, noise row (Concepts) gone.
      // Other Concepts rows on shared DEV DB will also be deleted — that's
      // intentional and matches production semantics.
      const survived = await SELECT.one.from(Changes).where({ ID: ctrlId });
      expect(survived).toBeDefined();
      const gone = await SELECT.one.from(Changes).where({ ID: noiseId });
      expect(gone).toBeFalsy();
    } finally {
      await DELETE.from(Changes).where({ ID: { in: [noiseId, ctrlId] } });
    }
  });
});
```

- [ ] **Step 5.2: Run the hybrid suite**

Run: `ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/changelog-noise.test.js`
Expected: 4 passed. Note: the first test (trigger drop) only passes against a HANA database that has already received the new HDI deploy. If you're running this against DEV before the PR is merged + deployed, the assertion will fail because the old triggers are still there. That's expected — flag as "post-deploy verification" in the PR description.

- [ ] **Step 5.3: Commit**

```bash
git add test/hybrid/changelog-noise.test.js
git commit -m "test(#658): hybrid verification of trigger drop + auto-purge

Four assertions against real HANA via cds bind:
  1. AFTER triggers gone on the nine un-tracked entities
  2. Control: triggers still present on Advocates (kept @changelog)
  3. autoPurgeOnce sentinel is idempotent
  4. purgeStaleChangelog respects the entity allowlist (control row survives)

Test 1 only passes against a freshly-deployed DB. Pre-merge, it WILL
fail locally — that's expected and the PR description should call it
out as a post-deploy verification step."
```

---

## Task 6: Documentation + memory

**Files:**
- Modify: [docs/developers/operations/migration-from-ims.md](../../../docs/developers/operations/migration-from-ims.md)
- Create: [C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_changelog_curation_singletons_and_ai_tables.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_changelog_curation_singletons_and_ai_tables.md)
- Modify: [C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md)

- [ ] **Step 6.1: Update the migration-from-ims doc**

Find the existing `> ⚠️ **Known gap.**` block around line 48 in [docs/developers/operations/migration-from-ims.md](../../../docs/developers/operations/migration-from-ims.md). After that block, append:

```markdown

#### Noise cleanup for un-tracked entities (#658)

Nine entities had their `@changelog` annotation dropped after the admin
Change History tile was flooded with no-delta entries:

- Configuration singletons: `ChatSettings`, `KnowledgeGraphSettings`,
  `UiEventsSettings`, `TenantSettings`, `DisplaySettings`,
  `SearchSettings`, `NavigatorSettings` — each had a `before('READ')`
  auto-init handler that INSERTed a default row on first read, tripping
  the AFTER INSERT trigger.
- AI-generated KG tables: `Concepts`, `ConceptEdges` — the
  extract-concepts cron does delete-then-insert on every run, producing
  thousands of trigger-fired rows per tick.

Historical noise is purged automatically once per deploy via
`autoPurgeOnce` in [srv/lib/purge-stale-changelog.js](../../../srv/lib/purge-stale-changelog.js),
held behind a `JobLocks` sentinel. To re-run the purge ad-hoc (e.g. if
the entity list grows in a future PR), call the
`AdminService.purgeNoiseChangeLog(entities)` OData action.

Spec: [2026-06-26-658-changelog-noise-cleanup-design.md](../../superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md).
```

- [ ] **Step 6.2: Write the memory file**

Create [C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_changelog_curation_singletons_and_ai_tables.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\feedback_changelog_curation_singletons_and_ai_tables.md):

```markdown
---
name: feedback_changelog_curation_singletons_and_ai_tables
description: Don't add @changelog to @odata.singleton config tiles or AI-generated tables; they produce no-delta phantom rows and cron churn that buries real audit signal.
metadata:
  type: feedback
---

When adding `@changelog` to an entity in `db/change-tracking.cds`, ask two
questions:

1. **Does this entity have a `before('READ')` auto-init handler in
   `srv/admin-service.js`?** (Typical for `@odata.singleton`-projected
   configuration tiles.) If yes, the auto-init INSERT fires the AFTER
   trigger and writes a no-delta "Create" row attributed to the first
   reader. Don't track it.
2. **Is this entity written-to by a scheduled job that doesn't compare
   old vs new before writing?** (Typical for AI-generated tables like
   `Concepts` / `ConceptEdges` where the cron deletes-and-reinserts on
   every run.) If yes, the cron fires the trigger thousands of times per
   tick. Don't track it.

**Why:** Both patterns flood `sap.changelog.Changes` with rows that have
no audit value, burying the real admin-edit signal in the
`/admin-ui/#changelog-display` tile. Issue #658 dropped `@changelog`
from nine entities for this reason.

**How to apply:** Configuration singletons and machine-generated tables
are categorically out. Human-edited content where edit history adds
audit value (Advocates, Secrets, Missions, Events, etc.) is in. When in
doubt, prefer NOT tracking — adding `@changelog` later is a one-line
schema change; un-tracking after the table has filled with noise needs
a purge migration ([[purge-stale-changelog]]).

Spec: `docs/superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md`.
```

- [ ] **Step 6.3: Add the memory index entry**

Edit [C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md](C:\Users\I809764\.claude\projects\d--projects-tutorials-poc\memory\MEMORY.md). Find the `## CAP / CDS` section (or similar). Add this line under it (alphabetically reasonable):

```markdown
- [Changelog curation](feedback_changelog_curation_singletons_and_ai_tables.md) — Don't @changelog @odata.singleton config tiles or AI-generated tables; they produce no-delta phantom rows and cron churn (#658)
```

- [ ] **Step 6.4: Commit**

```bash
git add docs/developers/operations/migration-from-ims.md
git commit -m "docs(#658): document noise cleanup in migration-from-ims.md"
```

(Memory files don't need commits — they live outside the repo, but the write happens during this task.)

---

## Task 7: Pre-PR verification

- [ ] **Step 7.1: Run the full unit suite**

Run: `npm test 2>&1 | tail -30`
Expected: All unit tests pass. The new `purge-stale-changelog.test.js` and `admin-service-purge-noise.test.js` are included automatically by the unit workspace's pattern.

- [ ] **Step 7.2: Lint the CDS files**

Run: `npx cds lint db/change-tracking.cds srv/admin-service.cds 2>&1`
Expected: No errors. Warnings about unrelated entities can be ignored.

- [ ] **Step 7.3: Confirm no stale `@changelog` reference survives**

Run: `grep -rE "@changelog" db/ srv/ | grep -vE "^(db/change-tracking.cds|db/audit-logging.cds|db/analytics-builder.cds|.*\.json):" | head`
Expected: empty output. (audit-logging.cds, analytics-builder.cds, and generated CSN may legitimately mention `changelog` — the grep filters those.)

- [ ] **Step 7.4: Sanity-check the published action**

Run: `npx cds compile srv/admin-service.cds --to edmx 2>&1 | grep -i "purgeNoiseChangeLog"`
Expected: Two matches — the `<Action Name="purgeNoiseChangeLog">` declaration and the `<FunctionImport Name=…>` / `<ActionImport Name=…>` entry. Confirms the action made it into the published OData metadata.

- [ ] **Step 7.5: Push the branch and open the PR**

Run: `git push -u origin feat/658-changelog-noise-cleanup`

Then: `gh pr create --title "feat(#658): drop @changelog noise on config singletons + KG tables" --body "$(cat <<'EOF'
Closes #658.

Three pieces:

1. Remove `@changelog` from nine entities in `db/change-tracking.cds`:
   ChatSettings, KnowledgeGraphSettings, UiEventsSettings, TenantSettings,
   DisplaySettings, SearchSettings, NavigatorSettings, Concepts,
   ConceptEdges. These produce no-delta phantom Creates (the singleton
   auto-init handlers in srv/admin-service.js trip the AFTER trigger on
   first read) or cron-driven empty-attribute Updates (the
   extract-concepts cron does delete-then-insert on every run).

2. New helper `srv/lib/purge-stale-changelog.js` + `autoPurgeOnce`
   wrapper held behind a JobLocks sentinel — runs exactly once per
   deploy from `cds.on('served')` to clear historical noise rows.

3. New OData action `AdminService.purgeNoiseChangeLog(entities)` for
   ad-hoc re-runs.

### Post-deploy verification

`test/hybrid/changelog-noise.test.js` asserts that the AFTER triggers
were dropped by HDI for the nine un-tracked entities. Run **after**
this PR is deployed to DEV:

\`\`\`
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- \\
  npx vitest run test/hybrid/changelog-noise.test.js
\`\`\`

Spec: docs/superpowers/specs/2026-06-26-658-changelog-noise-cleanup-design.md
EOF
)"`

Expected: PR opened.

---

## Notes for the implementer

- **DRY:** `purgeStaleChangelog` is the only function that does the DELETE; both the auto-purge wrapper and the admin action call it. Don't duplicate the DELETE logic.
- **TDD:** Each helper test is written-and-run before the implementation. The admin-action test uses CAP's HTTP-style POST (via `cds.test()`) rather than calling the handler directly, so it exercises the OData layer end-to-end.
- **YAGNI:** No admin-UI button in this PR (clearChangeLog doesn't have one either — both are reachable via the OData endpoint). No CSV-seeded default row replacement for the singletons (the existing `before('READ')` auto-init handlers are fine and stay).
- **Commits:** Six commits, one per task that produces working code. The doc/memory commit (Task 6) is the smallest — keep it that way; resist the temptation to roll it into earlier task commits.
- **CAP gotcha:** `@cap-js/change-tracking@2.0.0-beta.11` reconciles trigger state every time `cds build --production` runs. Removing an `@changelog` annotation from `db/change-tracking.cds` is sufficient to drop the trigger from the next HDI deploy — no explicit `db/migrations/drop-changelog-triggers.hdbprocedure` is needed. The hybrid test in Task 5 verifies this empirically.
- **Branch:** Already on `feat/658-changelog-noise-cleanup` — don't switch back to main mid-flight. (See [[feedback_subagent_branch_switching_during_session]] / [[feedback_branch_slip_after_long_session]].)
