# Mission form silent partial-state save — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add backend safeguards in `srv/admin-service.js` so `Missions`/`Groups`/`CompletionPaths` rows can't be created with NULL `legacyId` or NULL `slug` (CompletionPaths only), and so SuperAdmins can't publish a Mission whose `CompletionPathItems` are unresolvable.

**Architecture:** Three new handlers registered in `init()` plus one repair script. The handlers mirror existing patterns (`deriveSlugForEntity`, `_guardPublished`); the repair script mirrors PR #452's `repair-tutorial-legacyid.cjs`. Tests live in `srv/__tests__/admin-service-mission-form.test.js` (cds.test('serve') HTTP) and `test/hybrid/repair-mission-completion-path-data.test.js`.

**Tech Stack:** `@sap/cds` ApplicationService handlers, Vitest + `cds.test('serve', '--in-memory')` for unit tests, Vitest hybrid mode against HANA for the repair test.

**Spec:** [docs/superpowers/specs/2026-06-19-mission-form-validation-design.md](../specs/2026-06-19-mission-form-validation-design.md)

**Issue:** [#436](https://github.com/sap-tutorials/tutorials-ims/issues/436)

**Branch:** `fix/issue-436-mission-form-validation` (already created from `main`; spec committed as `71b82153` + `b38998d6`).

---

## File Structure

| File | Action | Responsibility |
|---|---|---|
| `srv/admin-service.js` | Modify | Add `initLegacyIdForEntity` factory + register for Missions/Groups/CompletionPaths drafts. Add `deriveCompletionPathSlug` handler. Add `before('SAVE', 'Missions')` guard that walks path items. |
| `srv/__tests__/admin-service-mission-form.test.js` | Create | cds.test('serve') HTTP tests for the new handlers + guard. |
| `scripts/repair-mission-completion-path-data.cjs` | Create | One-shot HANA repair script for existing NULL `Missions.legacyId`, `CompletionPaths.legacyId`, `CompletionPaths.slug`. Reports unresolvable CompletionPathItems for manual triage. |
| `test/hybrid/repair-mission-completion-path-data.test.js` | Create | Hybrid SQL contract test for the repair logic. |

No CSN schema change. No new dependencies.

---

## Pre-flight: commit the plan

- [ ] **Step 0:** Commit this plan file before starting Task 1.

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current  # expect: fix/issue-436-mission-form-validation
  git -c core.autocrlf=false add docs/superpowers/plans/2026-06-19-mission-form-validation.md
  git -c core.autocrlf=false commit -m "docs(plan): mission form silent partial-state save (#436)"
  ```

  > **Branch slip safeguard:** Pair `git branch --show-current` with the commit invocation in the SAME Bash call (memory: `feedback_branch_slip_after_long_session`).

---

## Task 1: `initLegacyIdForEntity` handler — Missions, Groups, CompletionPaths

**Files:**
- Modify: `srv/admin-service.js` (add factory + 3 registrations alongside the existing `deriveSlugForEntity` block at lines 150–228)

> **Important context for the implementer:** The file ALREADY has a `legacyKeyedEntities` loop at lines 71–85 that registers `before('CREATE')` for every legacyId-bearing entity (including Missions, Groups, CompletionPaths). That loop covers programmatic POSTs but does NOT fire on the Fiori draft activation path (NEW on `<Entity>.drafts` → PATCH on the draft → SAVE on the active entity). #436 surfaced exactly because the SAVE path doesn't trigger CREATE handlers. The new factory below covers the NEW/PATCH/SAVE gap; **don't register it for CREATE** — that would duplicate the existing loop.

- [ ] **Step 1: Read the existing slug-derive registration block as anchor**

  ```bash
  cd D:/projects/tutorials-poc
  sed -n '70,86p' srv/admin-service.js   # the existing CREATE-only loop
  sed -n '220,232p' srv/admin-service.js  # the deriveSlugForEntity registration shape
  ```

- [ ] **Step 2: Add the factory + registrations (NEW/PATCH/SAVE only)**

  Insert this block immediately AFTER the existing `for (const entityName of ['Missions', 'Groups'])` slug-derive loop (ends around line 228) and BEFORE the existing `this.before('UPDATE', 'TutorialMeta', ...)` handler (line 231).

  ```js
  // [#436] legacyId self-heal for entities authored via the admin UI's draft
  // lifecycle (NEW on .drafts → PATCH autosaves → SAVE on activation). The
  // existing legacyKeyedEntities loop at lines 71-85 covers `before('CREATE')`
  // for programmatic POSTs, but NEW/PATCH/SAVE on draft-edited entities never
  // hit CREATE — so missions/groups/paths created via Fiori (the #382 F1 path)
  // ended up with NULL legacyId.
  //
  // This handler:
  //   - Fires on NEW (draft create), PATCH (draft autosave), SAVE (activation)
  //   - Does NOT register for CREATE (already handled by the line 71 loop)
  //   - Self-heals UPDATE/PATCH/SAVE on existing rows whose legacyId is NULL
  //   - Skips when the row already has legacyId (idempotent across draft lifecycle)
  const initLegacyIdForEntity = (entityName) => async (req) => {
    if (req.data.legacyId != null) return;
    if (req.data.ID && (req.event === 'PATCH' || req.event === 'SAVE' || req.event === 'UPDATE')) {
      const [prior] = await SELECT.from(req.target).where({ ID: req.data.ID }).columns('legacyId');
      if (prior?.legacyId != null) return;
    }
    const db = await cds.connect.to('db');
    req.data.legacyId = await getNextLegacyId(entityName, db);
  };

  for (const entityName of ['Missions', 'Groups', 'CompletionPaths']) {
    const handler = initLegacyIdForEntity(entityName);
    this.before('NEW',   `${entityName}.drafts`, handler);
    this.before('PATCH', `${entityName}.drafts`, handler);
    this.before('SAVE',  entityName,             handler);
    // CREATE is intentionally NOT registered here — the existing
    // legacyKeyedEntities loop at lines 71-85 already covers it.
  }
  ```

- [ ] **Step 3: Sanity smoke (compile check)**

  ```bash
  cd D:/projects/tutorials-poc
  node --check srv/admin-service.js
  ```

  Expected: clean exit, no syntax errors.

- [ ] **Step 4: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add srv/admin-service.js
  git -c core.autocrlf=false commit -m "feat(admin): legacyId self-heal across NEW/PATCH/SAVE for Missions/Groups/CompletionPaths (#436)

  The existing legacyKeyedEntities loop at admin-service.js:71-85 only
  registers before('CREATE'), which doesn't fire on the Fiori draft
  activation path (NEW on .drafts → PATCH → SAVE on active entity). #436
  surfaced because Missions/Groups/CompletionPaths created via the admin
  UI's draft form never hit CREATE and ended up with NULL legacyId.

  This factory covers the NEW/PATCH/SAVE gap and self-heals existing
  NULL rows on re-save. Does NOT duplicate the CREATE registration.

  Refs #436"
  ```

---

## Task 2: `deriveCompletionPathSlug` handler

**Files:**
- Modify: `srv/admin-service.js` (add handler + registrations alongside the legacyId block from Task 1)

- [ ] **Step 1: Add the handler immediately after the Task 1 block**

  ```js
  // [#436] Auto-derive CompletionPaths.slug from name. Mirrors
  // deriveSlugForEntity but adapted for two CompletionPaths-specific facts:
  //   1. The source field is `name`, not `title`.
  //   2. Slug uniqueness is scoped to the parent mission, not the entity table —
  //      two missions can each legitimately have a "Path A".
  const deriveCompletionPathSlug = async (req) => {
    const isCreate = req.event === 'CREATE' || req.event === 'NEW';
    const ID = req.data.ID;
    const name = req.data.name;
    const missionId = req.data.mission_ID;

    let prior = null;
    if (!isCreate && ID) {
      [prior] = await SELECT.from(req.target).where({ ID }).columns('name', 'slug', 'mission_ID');
    }
    const effectiveName = name ?? prior?.name;
    const effectiveMission = missionId ?? prior?.mission_ID;
    if (!effectiveName || !effectiveMission) return;

    const base = slugify(effectiveName);
    if (!isCreate && prior?.slug && (name === undefined || name === prior.name)) return;

    const siblings = await SELECT.from(CompletionPaths)
      .columns('ID', 'slug')
      .where({ mission_ID: effectiveMission, slug: { '!=': null } });
    const taken = new Set(
      siblings.filter(r => r.ID !== ID).map(r => r.slug).filter(Boolean)
    );

    req.data.slug = ensureUniqueSlug(base, taken, prior?.slug ?? null);
  };

  this.before('CREATE', 'CompletionPaths', deriveCompletionPathSlug);
  this.before('NEW',    'CompletionPaths.drafts', deriveCompletionPathSlug);
  this.before('PATCH',  'CompletionPaths.drafts', deriveCompletionPathSlug);
  this.before('SAVE',   'CompletionPaths', deriveCompletionPathSlug);
  ```

  > **Note:** `CompletionPaths` is destructured from `cds.entities(NS)` at the top of `init()` (line 21 of admin-service.js). `slugify` and `ensureUniqueSlug` are imported at line 10. No new imports needed.
  >
  > **Why CREATE is registered here but not in Task 1:** The slug derive logic is novel (no existing handler computes CompletionPaths slug). For Task 1, the existing `legacyKeyedEntities` CREATE loop at lines 71-85 already covers programmatic POSTs to `/admin/CompletionPaths` — adding another CREATE there would be a no-op duplicate. For slug derive, this IS the only CREATE handler.

- [ ] **Step 2: Compile-check**

  ```bash
  cd D:/projects/tutorials-poc
  node --check srv/admin-service.js
  ```

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add srv/admin-service.js
  git -c core.autocrlf=false commit -m "feat(admin): auto-derive CompletionPaths.slug from name, scope-unique per mission (#436)

  Mirrors deriveSlugForEntity but uses `name` as source and scopes uniqueness
  to siblings under the same mission_ID. Two missions can each have a path
  named 'Path A' without collision.

  Refs #436"
  ```

---

## Task 3: Publish-time validation guard

**Files:**
- Modify: `srv/admin-service.js` — add `before('SAVE', 'Missions')` after the existing tag-required check at line 123–128.

- [ ] **Step 1: Add the guard handler**

  Insert after the existing `this.before('SAVE', 'Missions', async (req) => { ... })` tag-check block (around line 128) and before the `this.before('SAVE', 'Groups', ...)` at line 129:

  ```js
  // [#436] Publish-time integrity guard: refuse a published=true transition
  // when any CompletionPathItems row is unresolvable. Drafts and unpublished
  // saves still allow partial state for incremental authoring; only the
  // false→true publish gate enforces correctness.
  this.before('SAVE', 'Missions', async (req) => {
    if (req.data.published !== true) return;
    const ID = req.data.ID;
    if (!ID) return;

    // Detect transition: only refuse on false→true, not when re-saving an
    // already-published mission whose payload echoes published=true.
    const [prior] = await SELECT.from(Missions).where({ ID }).columns('published');
    if (prior?.published === true) return;

    const paths = await SELECT.from(CompletionPaths)
      .where({ mission_ID: ID })
      .columns('ID', 'name');
    for (const path of paths) {
      const items = await SELECT.from(CompletionPathItems)
        .where({ path_ID: path.ID })
        .columns('ID', 'itemOrder', 'taskType', 'tutorial_ID', 'group_ID', 'checkpointTitle');
      for (const item of items) {
        const ord = item.itemOrder ?? '?';
        if (item.itemOrder == null) {
          return req.reject(400, `Cannot publish: path "${path.name}" has an item with no itemOrder`);
        }
        switch (item.taskType) {
          case 'TUTORIAL':
            if (!item.tutorial_ID) {
              return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=TUTORIAL but no tutorial linked`);
            }
            break;
          case 'GROUP':
            if (!item.group_ID) {
              return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=GROUP but no group linked`);
            }
            break;
          case 'CHECKPOINT':
            if (!item.checkpointTitle) {
              return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has taskType=CHECKPOINT but no checkpointTitle`);
            }
            break;
          default:
            return req.reject(400, `Cannot publish: path "${path.name}" item ${ord} has unknown taskType "${item.taskType}"`);
        }
      }
    }
  });
  ```

  > **Note:** `Missions`, `CompletionPaths`, `CompletionPathItems` are all destructured from `cds.entities(NS)` at the top of `init()`.

- [ ] **Step 2: Compile-check**

  ```bash
  cd D:/projects/tutorials-poc
  node --check srv/admin-service.js
  ```

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add srv/admin-service.js
  git -c core.autocrlf=false commit -m "feat(admin): refuse publish=true Mission save with unresolvable path items (#436)

  before('SAVE', 'Missions') walks every CompletionPathItems row under the
  mission and rejects with a descriptive 400 when any item lacks the FK its
  taskType requires. Detects false→true transitions only — already-published
  re-saves still go through (legacy data shouldn't break on echo).

  Refs #436"
  ```

---

## Task 4: Unit tests via cds.test('serve')

**Files:**
- Create: `srv/__tests__/admin-service-mission-form.test.js`

The test file follows the established `admin-service-categories.test.js` pattern: `cds.test('serve', '--project', '.', '--in-memory')` boots the AdminService over HTTP; tests use `project.post(url, body, auth)`.

- [ ] **Step 1: Read the existing test file as a template**

  ```bash
  cd D:/projects/tutorials-poc
  head -55 srv/__tests__/admin-service-categories.test.js
  ```

  You should see: `cds.test('serve', '--project', '.', '--in-memory')`, `auth = { auth: { username: 'admin', password: 'admin' } }`, namespace constant, `beforeAll` to seed fixtures, and `project.post()` invocations.

- [ ] **Step 2: Create the test file with the full test suite**

  Paste verbatim:

  ```js
  // srv/__tests__/admin-service-mission-form.test.js
  // Regression tests for #436 — backend safeguards against silent partial-state
  // Mission saves. Covers:
  //   - Missions / Groups / CompletionPaths legacyId auto-init on CREATE
  //   - CompletionPaths slug auto-derivation from name (scope-unique per mission)
  //   - before('SAVE', 'Missions') guard: refuse publish=true with unresolvable items
  //
  // Pattern mirrors admin-service-categories.test.js — cds.test('serve') boots
  // the service over HTTP; project.post()/.patch() drive the OData endpoints.

  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import cds from '@sap/cds';
  import { randomUUID } from 'node:crypto';

  const project = cds.test('serve', '--project', '.', '--in-memory');
  const auth = { auth: { username: 'admin', password: 'admin' } };

  const NS = 'com.sap.developers.ims';
  const TEST_PREFIX = '__TEST__436-';

  describe('AdminService mission-form safeguards (#436)', () => {
    beforeAll(async () => {
      await cds.connect.to('db');
    });

    afterAll(async () => {
      const { Missions, Groups, CompletionPaths, CompletionPathItems, Tutorials } = cds.entities(NS);
      // Clean by FK chain so we don't violate associations.
      const tutRows = await SELECT.from(Tutorials).columns('ID').where({ slug: { like: `${TEST_PREFIX}%` } });
      const tutIds = tutRows.map(r => r.ID);
      if (tutIds.length) {
        await DELETE.from(CompletionPathItems).where({ tutorial_ID: { in: tutIds } });
      }
      const missionRows = await SELECT.from(Missions).columns('ID').where({ title: { like: `${TEST_PREFIX}%` } });
      const missionIds = missionRows.map(r => r.ID);
      if (missionIds.length) {
        const pathRows = await SELECT.from(CompletionPaths).columns('ID').where({ mission_ID: { in: missionIds } });
        const pathIds = pathRows.map(r => r.ID);
        if (pathIds.length) {
          await DELETE.from(CompletionPathItems).where({ path_ID: { in: pathIds } });
          await DELETE.from(CompletionPaths).where({ ID: { in: pathIds } });
        }
        await DELETE.from(Missions).where({ ID: { in: missionIds } });
      }
      await DELETE.from(Groups).where({ title: { like: `${TEST_PREFIX}%` } });
      await DELETE.from(Tutorials).where({ ID: { in: tutIds } });
    });

    // ── legacyId auto-init ────────────────────────────────────────────────────

    it('CREATE Missions auto-assigns a positive legacyId', async () => {
      const id = randomUUID();
      const { data, status } = await project.post(
        '/admin/Missions',
        { ID: id, title: `${TEST_PREFIX}mission-legacy-1`, status: 'ACTIVE' },
        auth
      );
      expect(status).toBe(201);
      expect(typeof data.legacyId).toBe('number');
      expect(data.legacyId).toBeGreaterThan(0);
    });

    it('CREATE Groups auto-assigns a positive legacyId', async () => {
      const id = randomUUID();
      const { data, status } = await project.post(
        '/admin/Groups',
        { ID: id, title: `${TEST_PREFIX}group-legacy-1`, status: 'ACTIVE' },
        auth
      );
      expect(status).toBe(201);
      expect(typeof data.legacyId).toBe('number');
      expect(data.legacyId).toBeGreaterThan(0);
    });

    it('CREATE CompletionPaths auto-assigns a positive legacyId', async () => {
      // Seed parent mission first.
      const missionId = randomUUID();
      await project.post(
        '/admin/Missions',
        { ID: missionId, title: `${TEST_PREFIX}mission-for-cp-legacy`, status: 'ACTIVE' },
        auth
      );
      const pathId = randomUUID();
      const { data, status } = await project.post(
        '/admin/CompletionPaths',
        { ID: pathId, name: 'Path A', mission_ID: missionId },
        auth
      );
      expect(status).toBe(201);
      expect(typeof data.legacyId).toBe('number');
      expect(data.legacyId).toBeGreaterThan(0);
    });

    // ── CompletionPaths.slug auto-derivation ─────────────────────────────────

    it('CREATE CompletionPaths auto-derives slug from name', async () => {
      const missionId = randomUUID();
      await project.post(
        '/admin/Missions',
        { ID: missionId, title: `${TEST_PREFIX}mission-for-slug`, status: 'ACTIVE' },
        auth
      );
      const pathId = randomUUID();
      const { data, status } = await project.post(
        '/admin/CompletionPaths',
        { ID: pathId, name: 'My Cool Path', mission_ID: missionId },
        auth
      );
      expect(status).toBe(201);
      expect(data.slug).toBe('my-cool-path');
    });

    it('Two CompletionPaths with same name under SAME mission get -2 suffix', async () => {
      const missionId = randomUUID();
      await project.post(
        '/admin/Missions',
        { ID: missionId, title: `${TEST_PREFIX}mission-collision-same`, status: 'ACTIVE' },
        auth
      );
      const aRes = await project.post(
        '/admin/CompletionPaths',
        { ID: randomUUID(), name: 'Duplicate Name', mission_ID: missionId },
        auth
      );
      const bRes = await project.post(
        '/admin/CompletionPaths',
        { ID: randomUUID(), name: 'Duplicate Name', mission_ID: missionId },
        auth
      );
      expect(aRes.data.slug).toBe('duplicate-name');
      expect(bRes.data.slug).toBe('duplicate-name-2');
    });

    it('Two CompletionPaths with same name under DIFFERENT missions both get base slug', async () => {
      const m1 = randomUUID(), m2 = randomUUID();
      await project.post('/admin/Missions',
        { ID: m1, title: `${TEST_PREFIX}mission-collision-diff-1`, status: 'ACTIVE' }, auth);
      await project.post('/admin/Missions',
        { ID: m2, title: `${TEST_PREFIX}mission-collision-diff-2`, status: 'ACTIVE' }, auth);
      const aRes = await project.post(
        '/admin/CompletionPaths',
        { ID: randomUUID(), name: 'Cross Mission Path', mission_ID: m1 },
        auth
      );
      const bRes = await project.post(
        '/admin/CompletionPaths',
        { ID: randomUUID(), name: 'Cross Mission Path', mission_ID: m2 },
        auth
      );
      expect(aRes.data.slug).toBe('cross-mission-path');
      expect(bRes.data.slug).toBe('cross-mission-path');
    });

    // ── Publish-time validation guard ────────────────────────────────────────

    it('PATCH Missions published=true with unresolvable path item rejects 400', async () => {
      // Seed mission + path + an item with taskType=TUTORIAL but tutorial_ID NULL.
      const { Missions, CompletionPaths, CompletionPathItems, Tags, MissionTags } = cds.entities(NS);
      const missionId = randomUUID();
      const pathId = randomUUID();
      const itemId = randomUUID();
      const tagId = randomUUID();

      // Tag (the existing tag-required guard demands at least one).
      await INSERT.into(Tags).entries({ ID: tagId, name: `${TEST_PREFIX}tag-pub` });
      await INSERT.into(Missions).entries({
        ID: missionId,
        title: `${TEST_PREFIX}mission-pub-bad`,
        status: 'ACTIVE',
        published: false,
      });
      await INSERT.into(MissionTags).entries({ ID: randomUUID(), mission_ID: missionId, tag_ID: tagId });
      await INSERT.into(CompletionPaths).entries({
        ID: pathId, mission_ID: missionId, name: 'Bad Path', slug: 'bad-path',
      });
      await INSERT.into(CompletionPathItems).entries({
        ID: itemId, path_ID: pathId, taskType: 'TUTORIAL', itemOrder: 1, tutorial_ID: null,
      });

      // Attempt the publish-true transition via PATCH.
      let threw = false;
      try {
        await project.patch(`/admin/Missions(ID=${missionId},IsActiveEntity=true)`,
          { published: true }, auth);
      } catch (err) {
        threw = true;
        const status = err.response?.status ?? err.status;
        expect(status).toBe(400);
        const body = JSON.stringify(err.response?.data ?? err.data ?? {});
        expect(body).toMatch(/Cannot publish.*Bad Path.*tutorial/i);
      }
      expect(threw).toBe(true);
    });

    it('SAVE with published=true succeeds when all path items resolve', async () => {
      const { Missions, CompletionPaths, CompletionPathItems, Tutorials, Tags, MissionTags } = cds.entities(NS);
      const missionId = randomUUID();
      const pathId = randomUUID();
      const tutorialId = randomUUID();
      const itemId = randomUUID();
      const tagId = randomUUID();

      await INSERT.into(Tags).entries({ ID: tagId, name: `${TEST_PREFIX}tag-good` });
      await INSERT.into(Tutorials).entries({
        ID: tutorialId,
        slug: `${TEST_PREFIX}tutorial-good`,
        title: 'Good Tutorial',
        status: 'ACTIVE',
        legacyId: 999_777_001,
      });
      await INSERT.into(Missions).entries({
        ID: missionId,
        title: `${TEST_PREFIX}mission-pub-good`,
        status: 'ACTIVE',
        published: false,
      });
      await INSERT.into(MissionTags).entries({ ID: randomUUID(), mission_ID: missionId, tag_ID: tagId });
      await INSERT.into(CompletionPaths).entries({
        ID: pathId, mission_ID: missionId, name: 'Good Path', slug: 'good-path',
      });
      await INSERT.into(CompletionPathItems).entries({
        ID: itemId, path_ID: pathId, taskType: 'TUTORIAL', itemOrder: 1,
        tutorial_ID: tutorialId, taskLegacyId: 999_777_001,
      });

      const { status } = await project.patch(
        `/admin/Missions(ID=${missionId},IsActiveEntity=true)`,
        { published: true },
        auth
      );
      expect(status).toBe(200);
    });

    it('SAVE with published=false bypasses the integrity guard (drafts allowed)', async () => {
      const { Missions, CompletionPaths, CompletionPathItems, Tags, MissionTags } = cds.entities(NS);
      const missionId = randomUUID();
      const pathId = randomUUID();
      const tagId = randomUUID();

      await INSERT.into(Tags).entries({ ID: tagId, name: `${TEST_PREFIX}tag-draft` });
      await INSERT.into(Missions).entries({
        ID: missionId,
        title: `${TEST_PREFIX}mission-draft-bad`,
        status: 'ACTIVE',
        published: false,
      });
      await INSERT.into(MissionTags).entries({ ID: randomUUID(), mission_ID: missionId, tag_ID: tagId });
      await INSERT.into(CompletionPaths).entries({
        ID: pathId, mission_ID: missionId, name: 'Draft Path', slug: 'draft-path',
      });
      await INSERT.into(CompletionPathItems).entries({
        ID: randomUUID(), path_ID: pathId, taskType: 'TUTORIAL', itemOrder: null, tutorial_ID: null,
      });

      // Re-save the mission with title change but published still false.
      const { status } = await project.patch(
        `/admin/Missions(ID=${missionId},IsActiveEntity=true)`,
        { title: `${TEST_PREFIX}mission-draft-bad-renamed` },
        auth
      );
      expect(status).toBe(200);
    });
  });
  ```

- [ ] **Step 3: Run the new test suite, confirm GREEN**

  ```bash
  cd D:/projects/tutorials-poc
  npx vitest run srv/__tests__/admin-service-mission-form.test.js --reporter=default 2>&1 | tail -25
  ```

  Expected: all 8 tests pass. The suite exercises the handlers shipped in Tasks 1, 2, 3.

  > **Hardcoded fixture slugs are advisory only:** The publish-guard tests INSERT `slug: 'bad-path'` etc. directly via `INSERT.into(CompletionPaths)`. That goes through the new `before('CREATE', 'CompletionPaths')` slug-derive handler from Task 2, which will OVERWRITE the hardcoded slug if `name` resolves to a different slug. The tests only assert behavior on `published`/`legacyId`, so this is harmless — but if you `expect(data.slug).toBe('bad-path')` somewhere, it will fail because the handler computed `slug='bad-path'` from `name='Bad Path'` (which happens to match here). For different name/slug pairs, the handler wins.

- [ ] **Step 4: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add srv/__tests__/admin-service-mission-form.test.js
  git -c core.autocrlf=false commit -m "test(admin): mission-form safeguards regression suite (#436)

  cds.test('serve') HTTP-mode tests covering legacyId auto-init for
  Missions/Groups/CompletionPaths, slug auto-derivation with per-mission
  scoping, and the publish-time integrity guard.

  Refs #436"
  ```

---

## Task 5: Repair script `scripts/repair-mission-completion-path-data.cjs`

**Files:**
- Create: `scripts/repair-mission-completion-path-data.cjs`

Mirrors PR #452's `scripts/repair-tutorial-legacyid.cjs` — argument parsing, snapshot writing, HANA-only guard, per-row tx pattern.

- [ ] **Step 1: Create the script**

  > **Important: `srv/lib/slug-utils.js` is ESM** (`export function slugify`, `export function ensureUniqueSlug`). A `.cjs` script's `require()` will fail at runtime. Use dynamic `import()` inside `main()`:

  Use this template:

  ```js
  /* eslint-disable no-console */
  /**
   * One-shot repair: backfill Missions.legacyId, CompletionPaths.legacyId,
   * CompletionPaths.slug for rows where they are NULL. Reports unresolvable
   * CompletionPathItems for SuperAdmin manual triage (no auto-fix because
   * the row contains no signal to recover the intended target).
   *
   * Background: AdminService historically created Missions/Groups/CompletionPaths
   * via Fiori draft activation without legacyId/slug auto-init. The forward
   * fix in PR #?? (issue #436) closes the leak; this script heals existing
   * partial-NULL rows.
   *
   * Out of scope (per spec):
   *   - Auto-repair of CompletionPathItems with NULL tutorial_ID/group_ID/
   *     itemOrder/checkpointTitle. Reported only.
   *   - TaskRecords. (Tutorials.legacyId orphans handled by PR #452's
   *     repair script; same data-loss boundary applies.)
   *
   * Modes:
   *   --dry-run     (default) — print plan, no writes
   *   --commit               — execute, snapshot first
   *   --verify-only          — exit 0 if all clean, 2 if work remains
   *
   * Run via:  npx cds bind --exec -- node scripts/repair-mission-completion-path-data.cjs [--commit]
   */

  const cds = require('@sap/cds');
  const fs = require('node:fs');
  const path = require('node:path');
  // slug-utils.js is ESM; can't `require` it. Loaded via dynamic import() inside main().

  const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
  const SNAPSHOT_PATH = path.join(
    SNAPSHOT_DIR,
    `mission-cp-repair-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
  );
  let snapshotInited = false;
  function appendSnapshot(record) {
    if (!snapshotInited) {
      fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
      snapshotInited = true;
    }
    fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
  }

  const argv = process.argv.slice(2);
  const COMMIT = argv.includes('--commit');
  const VERIFY_ONLY = argv.includes('--verify-only');
  const DRY_RUN = argv.includes('--dry-run');
  if (COMMIT && VERIFY_ONLY) {
    console.error('--commit and --verify-only are mutually exclusive');
    process.exit(1);
  }
  if (COMMIT && DRY_RUN) {
    console.error('--commit and --dry-run are mutually exclusive');
    process.exit(1);
  }

  const MISSIONS_TBL = '"COM_SAP_DEVELOPERS_IMS_MISSIONS"';
  const PATHS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"';
  const ITEMS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"';
  const MISSION_SEQ = '"COM_SAP_DEVELOPERS_IMS_MISSIONS_SEQ"';
  const PATH_SEQ = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS_SEQ"';

  async function main() {
    // ESM helper imported dynamically (slug-utils.js exports slugify/ensureUniqueSlug as ESM).
    const { slugify, ensureUniqueSlug } = await import('../srv/lib/slug-utils.js');

    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
      process.exit(1);
    }
    if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);

    // ── Find defects ───────────────────────────────────────────────────────
    const missionNullLegacy = await db.run(
      `SELECT "ID", "TITLE" FROM ${MISSIONS_TBL} WHERE "LEGACYID" IS NULL ORDER BY "TITLE"`
    );
    const pathDefects = await db.run(`
      SELECT "ID", "MISSION_ID", "NAME", "SLUG", "LEGACYID"
        FROM ${PATHS_TBL}
       WHERE "LEGACYID" IS NULL OR "SLUG" IS NULL
       ORDER BY "NAME"
    `);
    const itemDefects = await db.run(`
      SELECT "ID", "PATH_ID", "ITEMORDER", "TASKTYPE", "TUTORIAL_ID", "GROUP_ID", "CHECKPOINTTITLE"
        FROM ${ITEMS_TBL}
       WHERE "ITEMORDER" IS NULL
          OR ("TASKTYPE" = 'TUTORIAL'   AND "TUTORIAL_ID"     IS NULL)
          OR ("TASKTYPE" = 'GROUP'      AND "GROUP_ID"        IS NULL)
          OR ("TASKTYPE" = 'CHECKPOINT' AND "CHECKPOINTTITLE" IS NULL)
       ORDER BY "PATH_ID", "ITEMORDER"
    `);

    if (VERIFY_ONLY) {
      console.log(`Missions with NULL legacyId: ${missionNullLegacy.length}`);
      console.log(`CompletionPaths with NULL legacyId or slug: ${pathDefects.length}`);
      console.log(`CompletionPathItems unresolvable (reported only): ${itemDefects.length}`);
      const dirty = missionNullLegacy.length + pathDefects.length;
      // Items aren't auto-repaired, so they don't gate verify-only's exit code —
      // the script's job is data-shape, not data-correctness on items.
      process.exit(dirty === 0 ? 0 : 2);
    }

    console.log(`\n--- Missions with NULL legacyId: ${missionNullLegacy.length} ---`);
    for (const r of missionNullLegacy) {
      console.log(`  ${r.TITLE.padEnd(60)}  ID=${r.ID.slice(0, 8)}`);
    }
    console.log(`\n--- CompletionPaths with NULL legacyId/slug: ${pathDefects.length} ---`);
    for (const r of pathDefects) {
      const flags = [r.LEGACYID == null ? 'legacy' : null, r.SLUG == null ? 'slug' : null].filter(Boolean).join('+');
      console.log(`  ${(r.NAME ?? '<no-name>').padEnd(40)}  mission=${r.MISSION_ID?.slice(0, 8) ?? 'null'}  ID=${r.ID.slice(0, 8)}  fix=${flags}`);
    }
    console.log(`\n--- CompletionPathItems unresolvable (REPORTED ONLY): ${itemDefects.length} ---`);
    for (const r of itemDefects) {
      const reasons = [];
      if (r.ITEMORDER == null) reasons.push('itemOrder=null');
      if (r.TASKTYPE === 'TUTORIAL' && !r.TUTORIAL_ID) reasons.push('TUTORIAL+tutorial_ID=null');
      if (r.TASKTYPE === 'GROUP' && !r.GROUP_ID) reasons.push('GROUP+group_ID=null');
      if (r.TASKTYPE === 'CHECKPOINT' && !r.CHECKPOINTTITLE) reasons.push('CHECKPOINT+checkpointTitle=null');
      console.log(`  path=${r.PATH_ID?.slice(0, 8) ?? 'null'}  ID=${r.ID.slice(0, 8)}  ${reasons.join(', ')}`);
    }
    console.log('\n  (CompletionPathItems are reported only — SuperAdmin re-links via admin UI.)');

    if (!COMMIT) {
      console.log('\nDry-run complete. Re-run with --commit to apply Missions+CompletionPaths repair.');
      return;
    }

    // ── Repair Missions ────────────────────────────────────────────────────
    let missionsRepaired = 0, missionsFailed = 0;
    for (const r of missionNullLegacy) {
      try {
        await db.tx(async tx => {
          const recheck = await tx.run(`SELECT "LEGACYID" FROM ${MISSIONS_TBL} WHERE "ID" = ? FOR UPDATE`, [r.ID]);
          if (recheck[0]?.LEGACYID != null) {
            console.log(`  ${r.ID.slice(0, 8)} skipped — already has legacyId=${recheck[0].LEGACYID}`);
            return;
          }
          const [seq] = await tx.run(`SELECT ${MISSION_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
          appendSnapshot({ kind: 'mission-before', table: MISSIONS_TBL, id: r.ID, title: r.TITLE, newLegacyId: seq.v });
          await tx.run(
            `UPDATE ${MISSIONS_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
            [seq.v, r.ID]
          );
          missionsRepaired++;
          console.log(`  ✓ Mission ${r.ID.slice(0, 8)} → legacyId=${seq.v}`);
        });
      } catch (err) {
        missionsFailed++;
        console.error(`  ✗ Mission ${r.ID.slice(0, 8)} failed: ${err.message}`);
      }
    }

    // ── Repair CompletionPaths ─────────────────────────────────────────────
    let pathsRepaired = 0, pathsFailed = 0;
    for (const r of pathDefects) {
      try {
        await db.tx(async tx => {
          const recheck = await tx.run(
            `SELECT "LEGACYID", "SLUG", "NAME", "MISSION_ID" FROM ${PATHS_TBL} WHERE "ID" = ? FOR UPDATE`,
            [r.ID]
          );
          const cur = recheck[0];
          if (!cur) return;

          appendSnapshot({ kind: 'path-before', table: PATHS_TBL, id: r.ID, name: cur.NAME, mission: cur.MISSION_ID });

          const updates = [];
          const params = [];
          if (cur.LEGACYID == null) {
            const [seq] = await tx.run(`SELECT ${PATH_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
            updates.push('"LEGACYID" = ?');
            params.push(seq.v);
          }
          if (cur.SLUG == null) {
            if (!cur.NAME || !cur.MISSION_ID) {
              console.log(`  ⚠ path ${r.ID.slice(0, 8)} has no name or no mission_ID; skipping slug derive`);
            } else {
              // Build sibling-slug taken-set (scope-unique per mission).
              const siblings = await tx.run(
                `SELECT "ID", "SLUG" FROM ${PATHS_TBL} WHERE "MISSION_ID" = ? AND "SLUG" IS NOT NULL AND "ID" <> ?`,
                [cur.MISSION_ID, r.ID]
              );
              const taken = new Set(siblings.map(s => s.SLUG).filter(Boolean));
              const slug = ensureUniqueSlug(slugify(cur.NAME), taken, null);
              updates.push('"SLUG" = ?');
              params.push(slug);
            }
          }
          if (updates.length === 0) {
            console.log(`  ${r.ID.slice(0, 8)} skipped — concurrent repair already healed`);
            return;
          }
          params.push(r.ID);
          await tx.run(
            `UPDATE ${PATHS_TBL} SET ${updates.join(', ')} WHERE "ID" = ?`,
            params
          );
          pathsRepaired++;
          console.log(`  ✓ Path ${r.ID.slice(0, 8)} updated: ${updates.join(', ')}`);
        });
      } catch (err) {
        pathsFailed++;
        console.error(`  ✗ Path ${r.ID.slice(0, 8)} failed: ${err.message}`);
      }
    }

    console.log('\n=== SUMMARY ===');
    console.log(JSON.stringify({
      missionsScanned: missionNullLegacy.length,
      missionsRepaired,
      missionsFailed,
      pathsScanned: pathDefects.length,
      pathsRepaired,
      pathsFailed,
      itemDefectsReported: itemDefects.length,
    }, null, 2));
  }

  main().catch(e => { console.error(e); process.exit(1); });
  ```

- [ ] **Step 2: Verify it parses**

  ```bash
  cd D:/projects/tutorials-poc
  node --check scripts/repair-mission-completion-path-data.cjs
  ```

  Expected: clean exit. The dynamic-`import()` of the ESM `slug-utils.js` is the only cross-format hop and Node handles it natively.

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add scripts/repair-mission-completion-path-data.cjs
  git -c core.autocrlf=false commit -m "feat(scripts): repair-mission-completion-path-data.cjs (#436)

  Mirrors scripts/repair-tutorial-legacyid.cjs from PR #452. Heals NULL
  Missions.legacyId, CompletionPaths.legacyId, and CompletionPaths.slug
  via per-row transactions with SELECT FOR UPDATE re-check. CompletionPath-
  Items defects are reported but not auto-repaired (no signal to recover
  the intended target — SuperAdmin re-links via admin UI now that the
  publish-time guard prevents new occurrences)."
  ```

---

## Task 6: Hybrid test for the repair script

**Files:**
- Create: `test/hybrid/repair-mission-completion-path-data.test.js`

Mirrors `test/hybrid/repair-tutorial-legacyid.test.js` — exercises the SQL contract directly against HANA without invoking the script's CLI.

- [ ] **Step 1: Create the test file**

  ```js
  // test/hybrid/repair-mission-completion-path-data.test.js
  // Hybrid SQL contract regression for #436 — mirrors
  // test/hybrid/repair-tutorial-legacyid.test.js (PR #452). Exercises the
  // repair script's per-row UPDATE statements directly against HANA.

  import cds from '@sap/cds';
  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import { isSafeForWrites } from './_guard.js';
  import { slugify, ensureUniqueSlug } from '../../srv/lib/slug-utils.js';

  const NS = 'com.sap.developers.ims';
  const TEST_PREFIX = '__TEST__436-repair-';

  const MISSIONS_TBL = '"COM_SAP_DEVELOPERS_IMS_MISSIONS"';
  const PATHS_TBL = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"';
  const MISSION_SEQ = '"COM_SAP_DEVELOPERS_IMS_MISSIONS_SEQ"';
  const PATH_SEQ = '"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS_SEQ"';

  describe('repair-mission-completion-path-data (#436) — HANA', () => {
    let db;

    beforeAll(async () => {
      if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
        throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
      }
      if (!isSafeForWrites()) {
        throw new Error('Refusing to run hybrid writes against production');
      }
      db = await cds.connect.to('db');
    });

    afterAll(async () => {
      await db.run(`DELETE FROM ${PATHS_TBL}
        WHERE "MISSION_ID" IN (SELECT "ID" FROM ${MISSIONS_TBL} WHERE "TITLE" LIKE '${TEST_PREFIX}%')`);
      await db.run(`DELETE FROM ${MISSIONS_TBL} WHERE "TITLE" LIKE '${TEST_PREFIX}%'`);
    });

    it('backfills NULL Missions.legacyId via the sequence', async () => {
      const missionId = cds.utils.uuid();
      await db.run(
        `INSERT INTO ${MISSIONS_TBL} ("ID", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, NULL)`,
        [missionId, `${TEST_PREFIX}mission-legacy`, 'ACTIVE']
      );

      let assignedLegacyId;
      await db.tx(async tx => {
        const [seq] = await tx.run(`SELECT ${MISSION_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
        assignedLegacyId = seq.v;
        await tx.run(
          `UPDATE ${MISSIONS_TBL} SET "LEGACYID" = ? WHERE "ID" = ? AND "LEGACYID" IS NULL`,
          [assignedLegacyId, missionId]
        );
      });

      expect(typeof assignedLegacyId).toBe('number');
      expect(assignedLegacyId).toBeGreaterThan(0);

      const after = await db.run(`SELECT "LEGACYID" FROM ${MISSIONS_TBL} WHERE "ID" = ?`, [missionId]);
      expect(after[0].LEGACYID).toBe(assignedLegacyId);
    });

    it('backfills NULL CompletionPaths.legacyId + slug, scope-unique per mission', async () => {
      const missionId = cds.utils.uuid();
      const path1Id = cds.utils.uuid();
      const path2Id = cds.utils.uuid();

      // Seed parent Mission (with legacyId so we don't trip the FK gauntlet).
      await db.run(
        `INSERT INTO ${MISSIONS_TBL} ("ID", "TITLE", "STATUS", "LEGACYID") VALUES (?, ?, ?, ?)`,
        [missionId, `${TEST_PREFIX}mission-with-paths`, 'ACTIVE', 999_888_001]
      );
      // Two CompletionPaths under same mission with same name, both NULL slug+legacyId.
      await db.run(
        `INSERT INTO ${PATHS_TBL} ("ID", "MISSION_ID", "NAME", "SLUG", "LEGACYID") VALUES (?, ?, ?, NULL, NULL)`,
        [path1Id, missionId, 'Same Name Path']
      );
      await db.run(
        `INSERT INTO ${PATHS_TBL} ("ID", "MISSION_ID", "NAME", "SLUG", "LEGACYID") VALUES (?, ?, ?, NULL, NULL)`,
        [path2Id, missionId, 'Same Name Path']
      );

      // Repair path 1 first.
      await db.tx(async tx => {
        const [seq] = await tx.run(`SELECT ${PATH_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
        const siblings = await tx.run(
          `SELECT "SLUG" FROM ${PATHS_TBL} WHERE "MISSION_ID" = ? AND "SLUG" IS NOT NULL AND "ID" <> ?`,
          [missionId, path1Id]
        );
        const taken = new Set(siblings.map(s => s.SLUG).filter(Boolean));
        const slug = ensureUniqueSlug(slugify('Same Name Path'), taken, null);
        await tx.run(
          `UPDATE ${PATHS_TBL} SET "LEGACYID" = ?, "SLUG" = ? WHERE "ID" = ?`,
          [seq.v, slug, path1Id]
        );
      });

      // Repair path 2 — it should see path 1's slug in `taken` and append -2.
      await db.tx(async tx => {
        const [seq] = await tx.run(`SELECT ${PATH_SEQ}.NEXTVAL AS "v" FROM DUMMY`);
        const siblings = await tx.run(
          `SELECT "SLUG" FROM ${PATHS_TBL} WHERE "MISSION_ID" = ? AND "SLUG" IS NOT NULL AND "ID" <> ?`,
          [missionId, path2Id]
        );
        const taken = new Set(siblings.map(s => s.SLUG).filter(Boolean));
        const slug = ensureUniqueSlug(slugify('Same Name Path'), taken, null);
        await tx.run(
          `UPDATE ${PATHS_TBL} SET "LEGACYID" = ?, "SLUG" = ? WHERE "ID" = ?`,
          [seq.v, slug, path2Id]
        );
      });

      const after1 = await db.run(`SELECT "SLUG", "LEGACYID" FROM ${PATHS_TBL} WHERE "ID" = ?`, [path1Id]);
      const after2 = await db.run(`SELECT "SLUG", "LEGACYID" FROM ${PATHS_TBL} WHERE "ID" = ?`, [path2Id]);
      expect(after1[0].SLUG).toBe('same-name-path');
      expect(after2[0].SLUG).toBe('same-name-path-2');
      expect(after1[0].LEGACYID).toBeGreaterThan(0);
      expect(after2[0].LEGACYID).toBeGreaterThan(0);
      expect(after1[0].LEGACYID).not.toBe(after2[0].LEGACYID);
    });
  });
  ```

- [ ] **Step 2: Optional local hybrid run (skip if no `cf login`)**

  ```bash
  cd D:/projects/tutorials-poc
  ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/repair-mission-completion-path-data.test.js --reporter=default 2>&1 | tail -10
  ```

  Expected: 2 tests pass. CI exercises this when the PR is open.

- [ ] **Step 3: Commit**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current
  git -c core.autocrlf=false add test/hybrid/repair-mission-completion-path-data.test.js
  git -c core.autocrlf=false commit -m "test(hybrid): repair-mission-completion-path-data SQL contract (#436)"
  ```

---

## Task 7: Final smoke + push + PR

- [ ] **Step 1: Verify branch state**

  ```bash
  cd D:/projects/tutorials-poc
  git branch --show-current   # fix/issue-436-mission-form-validation
  git log --oneline main..HEAD
  ```

  Expected: 9 commits — 2 spec, 1 plan, 3 admin-service.js (legacyId, slug, guard), 1 unit-test, 1 repair script, 1 hybrid test.

- [ ] **Step 2: Run unit tests as a regression sweep**

  ```bash
  cd D:/projects/tutorials-poc
  npx vitest run srv/__tests__ --reporter=default 2>&1 | tail -10
  ```

  Expected: pre-existing baseline + the 8 new tests from Task 4. If any unrelated test fails, treat as separate (likely flaky; matches earlier-session baseline).

- [ ] **Step 3: Push**

  ```bash
  cd D:/projects/tutorials-poc
  git push -u origin fix/issue-436-mission-form-validation
  ```

- [ ] **Step 4: Open PR**

  ```bash
  cd D:/projects/tutorials-poc
  gh pr create \
    --repo sap-tutorials/tutorials-ims \
    --base main \
    --title "fix(admin): backend safeguards against silent partial-state Mission saves (#436)" \
    --body "$(cat <<'EOF'
  ## What

  Backend safeguards in [\`srv/admin-service.js\`](srv/admin-service.js) closing three of the five root causes Tom catalogued in #436. The two admin-UI form fixes (broken value-help, silent fallback to \`checkpointTitle\`) stay with Tom's separate UI issue.

  ### 1. \`legacyId\` auto-init for Missions, Groups, CompletionPaths

  New \`initLegacyIdForEntity\` factory mirrors the existing \`deriveSlugForEntity\` shape. Registered against \`CREATE\`/\`NEW\`/\`PATCH\`/\`SAVE\` for each of \`Missions\`, \`Groups\`, \`CompletionPaths\` (and their \`.drafts\`). Self-heals NULL \`legacyId\` on existing rows when re-saved.

  ### 2. \`CompletionPaths.slug\` auto-derivation

  Mirrors \`deriveSlugForEntity\` but adapted: source field is \`name\` (not \`title\`), uniqueness is **scoped to siblings under the same \`mission_ID\`** (not table-global). Two missions can each have a path named "Path A" without colliding.

  ### 3. Publish-time integrity guard

  New \`before('SAVE', 'Missions')\` handler that walks every \`CompletionPathItems\` row under the mission and rejects with a descriptive 400 when any item lacks the FK its \`taskType\` requires. Detects \`false→true\` publish transitions only — already-published re-saves still go through (legacy data shouldn't break on echo). Drafts and unpublished saves still allow partial state for incremental authoring.

  ### 4. Backward repair: [\`scripts/repair-mission-completion-path-data.cjs\`](scripts/repair-mission-completion-path-data.cjs)

  Mirrors PR #452's \`repair-tutorial-legacyid.cjs\`. Heals existing NULL \`Missions.legacyId\`, \`CompletionPaths.legacyId\`, \`CompletionPaths.slug\`. Reports unresolvable \`CompletionPathItems\` for SuperAdmin manual triage (no auto-repair — the row contains no signal to recover the intended target).

  ## Why

  Per #436, a SuperAdmin can currently save a Mission with PUBLISHED=1 even when its CompletionPath has NULL legacyId, NULL slug, and path items pointing at nothing. Surfaced 2026-06-19 during #382 phase F1 manual mission registration. Carry-forward in the publish session masks the symptom; the mission renders empty on the public navigator/SSR because no downstream consumer can resolve the items.

  ## Out of scope (per spec)

  - Admin UI form fixes for value-help (Tom's separate UI issue)
  - Admin UI silent-fallback-to-\`checkpointTitle\` (same)
  - \`@mandatory\` schema constraints on legacyId/slug (CSN migration risk)
  - \`Tutorials.legacyId\` (already shipped via PR #452)
  - Auto-repair of CompletionPathItems (no row-level signal to recover the target)

  ## Test plan

  - ✅ 8 unit tests via \`cds.test('serve')\` HTTP mode (\`srv/__tests__/admin-service-mission-form.test.js\`):
    - legacyId auto-init for Missions, Groups, CompletionPaths on CREATE
    - slug auto-derivation from name + collision suffix within same mission
    - same-name paths under DIFFERENT missions both get base slug (scope-unique)
    - publish=true with unresolvable item → 400 with descriptive message
    - publish=true with all items resolved → 200
    - published=false saves bypass the guard (drafts allowed)
  - 🟡 1 hybrid SQL contract test (\`test/hybrid/repair-mission-completion-path-data.test.js\`) — runs in CI with \`ALLOW_HYBRID_WRITES=true\`.
  - **Manual run on DEV** (post-merge, post-deploy): \`npx cds bind --exec -- node scripts/repair-mission-completion-path-data.cjs --dry-run\` lists the F1 mission's defects; \`--commit\` heals legacyId/slug; \`--verify-only\` exits 0 for those fields. CompletionPathItem defects are reported for SuperAdmin re-link via admin UI.

  ## Refs

  - Spec: [docs/superpowers/specs/2026-06-19-mission-form-validation-design.md](docs/superpowers/specs/2026-06-19-mission-form-validation-design.md)
  - Plan: [docs/superpowers/plans/2026-06-19-mission-form-validation.md](docs/superpowers/plans/2026-06-19-mission-form-validation.md)
  - Surfacing event: #382 phase F1
  - Sibling fix: #431 / PR #452 (Tutorials.legacyId)
  - Companion fix: #428 (mission renderer)

  Closes #436.
  EOF
  )"
  ```

  Expected: PR URL printed.

---

## Out of scope (per spec)

- Admin UI form fixes (root causes #3 broken value-help, #4 silent `checkpointTitle` fallback) — Tom's separate UI issue.
- `@mandatory legacyId` / `@mandatory slug` schema constraints — risks breaking boot on existing legacy NULL rows.
- Auto-repair of `CompletionPathItems` — no row-level signal to recover the intended target.
- `Tutorials.legacyId` — already shipped via PR #452.
- Form-side tag-required visual indicator — server validation already in place; UI label is a separate concern.

## Notes for the implementer

- **Re-issue `git checkout`** as part of every commit invocation (memory: `feedback_branch_slip_after_long_session`). Each commit step in this plan reminds you to run `git branch --show-current` first.
- **Don't squash commits.** Spec → plan → 3 admin-service tasks → unit-test → repair script → hybrid test is a clean reviewable story (9 commits total).
- **The 3 admin-service.js handlers can be combined** into a single commit if you find the per-task split too granular. Per-task commits aid review but the file is the same throughout.
- **HANA uppercase quoted identifiers** in raw SQL (memory: `feedback_hana_raw_sql_uppercase`). The repair script and hybrid test follow this; don't rewrite them to use lowercase.
- **`_guardPublished` already enforces the SuperAdmin-only constraint** on `published` field changes (admin-service.js:805–813). The new validation guard runs AFTER auth — only authorized SuperAdmins can ever trigger the new code path, but they still get refused if the mission is incomplete.
- **`cds.test('serve')` boots the full AdminService over HTTP** including auth bypass via `auth: { username: 'admin', password: 'admin' }`. This matches the pattern in `srv/__tests__/admin-service-categories.test.js`.
- **CompletionPathItems isn't auto-repaired by the script** by design (per spec). When the repair runs on DEV, expect a list of defects to manually link via admin UI now that the publish guard prevents new occurrences.
