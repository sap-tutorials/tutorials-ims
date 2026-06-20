# Mission form silent partial-state save — design

**Issue:** [#436](https://github.com/sap-tutorials/tutorials-ims/issues/436) — Admin UI Missions form: silently allows incomplete CompletionPaths to be saved + published

**Date:** 2026-06-19

## Problem

When creating a Mission via `/admin-ui/#missions-display`, the form lets a SuperAdmin save and even publish a Mission whose dependent rows have critical fields NULL. Surfaced 2026-06-19 during #382 phase F1: a hand-created mission shipped with `Missions.LEGACYID NULL`, `CompletionPaths.LEGACYID NULL`, `CompletionPaths.SLUG NULL`, all 4 path items had `ITEMORDER NULL` + `TUTORIAL_ID NULL` + `TASKLEGACYID NULL`. The mission saved as `PUBLISHED=1` with no validation error and renders empty on the public navigator/SSR because no downstream consumer can resolve the items.

## Scope

Issue #436 names 5 contributing root causes. **This PR addresses three of them — the backend safeguards in `srv/admin-service.js`. The two admin-UI form fixes (#3 broken value-help, #4 silent fallback to `checkpointTitle`) stay with Tom's existing separate UI issue.**

| # | Root cause | This PR? |
|---|---|---|
| 1 | Missing legacyId backfill for new `Missions` and `CompletionPaths` rows | **Yes** (Tutorials portion shipped in PR #452; this PR also defensively adds `Groups`) |
| 2 | Missing slug auto-derivation on new `CompletionPaths` | **Yes** |
| 5 | No save-time validation that a published Mission has resolvable path items | **Yes** |
| 3 | Broken value-help on the CompletionPathItems Task field | No (separate UI issue) |
| 4 | Silent fallback to `CHECKPOINTTITLE` when value-help fails | No (separate UI issue) |

The publish-time guard added here means a SuperAdmin who hits the broken UI path can't publish the resulting incomplete mission — the visible failure replaces the silent one until the UI fixes land.

## Goal

Three backend-side guarantees:

1. **Every new `Missions`, `Groups`, and `CompletionPaths` row has a non-null `legacyId`** — auto-assigned via `getNextLegacyId(entityName, db)` in a `before('CREATE')` hook. UPDATE branch self-heals NULL rows on next save (mirror PR #452's `Tutorials` pattern).
2. **Every new `CompletionPaths` row also has a non-null `slug`** — kebab-derived from `name`, scoped-unique within the parent mission.
3. **Publishing a Mission refuses if any `CompletionPathItems` row is unresolvable** — `before('SAVE', 'Missions')` walks `path.items[]` and rejects when `published` is being set true while at least one item lacks the FK its `taskType` requires.

Plus: a one-shot repair script for the partial-NULL rows that already exist (the F1 mission and any siblings).

## Approach

### 1. `legacyId` auto-init for `Missions`, `Groups`, and `CompletionPaths`

Add a new `before('CREATE')` handler in `srv/admin-service.js`, mirroring the existing `deriveSlugForEntity` pattern. It fires on the full draft lifecycle (`NEW`, `PATCH`, `CREATE`, `SAVE`):

```js
const initLegacyIdForEntity = (entityName) => async (req) => {
  // Skip if the row already has a legacyId (UPDATE/PATCH on existing row).
  if (req.data.legacyId != null) return;
  // For PATCH/SAVE on existing row: read current state, only fill if NULL.
  if (req.data.ID && (req.event === 'PATCH' || req.event === 'SAVE' || req.event === 'UPDATE')) {
    const [prior] = await SELECT.from(req.target).where({ ID: req.data.ID }).columns('legacyId');
    if (prior?.legacyId != null) return;
  }
  const db = await cds.connect.to('db');
  req.data.legacyId = await getNextLegacyId(entityName, db);
};
```

The helper is registered for `Missions`, `Groups`, and `CompletionPaths` (and their drafts). The `getNextLegacyId` allowlist at [srv/lib/legacy-id.js:5](../../../srv/lib/legacy-id.js#L5) already includes all three. Including `Groups` is a defensive add — #436 only surfaced under Missions, but the schema and code paths are identical so the cost-of-prevention is two lines of registration.

> **Why a `before('CREATE')` hook on the AdminService rather than the publish path?** Missions, Groups, and CompletionPaths get created via the admin UI (Fiori draft activation), not the publish session. They have no equivalent of `upsertTutorialMetadata`. The CDS handler is the right altitude.

### 2. Slug auto-derivation for `CompletionPaths`

Mirror `deriveSlugForEntity('Missions')` but with two adaptations:

- The source field is `name`, not `title` (CompletionPaths uses `name` per [db/schema.cds:266](../../../db/schema.cds#L266)).
- Uniqueness is **scoped to the parent mission**, not the entity table. CompletionPaths is a Composition of Missions; two missions can each have a path named "Path A" without colliding. The `taken` set is built from siblings under the same `mission_ID`.

```js
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

  // Scope-unique: only collide against siblings under the same mission.
  const siblings = await SELECT.from(CompletionPaths)
    .columns('ID', 'slug')
    .where({ mission_ID: effectiveMission, slug: { '!=': null } });
  const taken = new Set(siblings.filter(r => r.ID !== ID).map(r => r.slug).filter(Boolean));

  req.data.slug = ensureUniqueSlug(base, taken, prior?.slug ?? null);
};

this.before(['CREATE', 'NEW', 'PATCH', 'SAVE'], ['CompletionPaths', 'CompletionPaths.drafts'], deriveCompletionPathSlug);
```

The `slugify` and `ensureUniqueSlug` helpers are already imported in `admin-service.js` for the existing Missions/Groups slug handler.

> **Why scope-unique-per-mission, not globally unique?** Two missions can legitimately each have a "linear path" or "advanced path." Globally-unique would force a SuperAdmin to type unique names per path across ALL missions, which is unergonomic and not how the schema models the relationship.

### 3. Save-time publish-validation guard

Add a new `before('SAVE', 'Missions')` handler **after** the existing tag-required check, mirroring its pattern:

```js
this.before('SAVE', 'Missions', async (req) => {
  // Only refuse when publishing — drafts and unpublished saves still allow
  // partial state (authors compose missions incrementally).
  // The transition is detected via the existing _guardPublished pattern:
  // req.data.published === true on either CREATE or PATCH-of-active.
  if (req.data.published !== true) return;

  // Re-check current persisted state in case the UPDATE payload echoes
  // published=true unchanged (legitimate save of an already-published mission
  // shouldn't fail just because its data was previously broken — but a fresh
  // publish transition definitely should).
  const ID = req.data.ID;
  if (!ID) return;
  const [prior] = await SELECT.from(Missions).where({ ID }).columns('published');
  const wasPublished = prior?.published === true;
  if (wasPublished && req.data.published === true) {
    // Already-published save: no transition. Skip the guard.
    return;
  }

  // Walk every path's items. Any unresolvable item refuses the save.
  const paths = await SELECT.from(CompletionPaths).where({ mission_ID: ID }).columns('ID', 'name');
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

> **Why only on publish-transition?** Authors compose missions incrementally. Refusing every partial-state save would be hostile to authoring. The transition `false → true` is the right gate — it's exactly when correctness matters because publish goes live.

### 4. Backward repair script: `scripts/repair-mission-completion-path-data.cjs`

New one-shot script following the [scripts/repair-tutorial-legacyid.cjs](../../../scripts/repair-tutorial-legacyid.cjs) pattern (shipped with PR #452):

**Modes:**
- `--dry-run` (default): print plan, no writes.
- `--commit`: execute, snapshot first.
- `--verify-only`: count remaining defects, exit 0 (clean) / 2 (work remains).

**What it repairs (per row, per-tutorial-style transactions, fail-soft):**

```
For each Missions row where legacyId IS NULL:
  open tx, SELECT FOR UPDATE, re-check, snapshot, set legacyId from sequence, commit.

For each CompletionPaths row where legacyId IS NULL OR slug IS NULL:
  open tx, SELECT FOR UPDATE, re-check, snapshot.
  If legacyId NULL: assign sequence value.
  If slug NULL: derive from name via slugify(); ensure unique per mission.
  commit.

Report (no auto-repair) any CompletionPathItems row that is unresolvable
(itemOrder NULL, or taskType+FK mismatch). Print one line per defect with
the path name, item ID, and the failure mode. SuperAdmin handles these
manually via admin UI now that the publish-guard is in place.
```

Snapshot file: `.migration-data/mission-cp-repair-backup-<ISO>.jsonl`. Same JSONL format as #452.

> **Why doesn't the script auto-repair CompletionPathItems?** Items with NULL `tutorial_ID` need the SuperAdmin to know which tutorial they meant — there's no slug-or-fingerprint signal in the row to recover from. The script's job is to surface the work-list; the human does the linking.

## Why this approach

| Approach | Pros | Cons | Decision |
|---|---|---|---|
| **CDS handlers + repair script** (this design) | Mirrors existing `deriveSlugForEntity` and PR #452 patterns. Defends every write path through the AdminService. Scope-tight: one file (admin-service.js) + one script. | Doesn't fix the UI form's silent fallback (deferred to Tom's separate UI issue). | **Chosen** |
| Bundle backend + admin UI fixes in one PR | Single PR closes #436 entirely. | Doubles review surface, depends on a separate UI investigation, mixes Vitest + FE V4 annotation testing. | Rejected |
| Just publish-time validation | Minimal diff; one handler. | Leaves the underlying NULL-creation paths open. Drafts can still be saved with NULL legacyId; only the publish step fails. Repeats Tom's frustration the next time he creates a mission. | Rejected |
| Database-layer constraints (`@mandatory legacyId`) | DB-enforced; no application logic to maintain. | Requires CSN migration + HDI deploy. Existing legacy data has NULL legacyId on `test-tutorial`-style rows; constraint would break boot. Out of pattern (the codebase uses application-layer sequence assignment everywhere). | Rejected |

## Failure modes

| Mode | Symptom | Action |
|---|---|---|
| HANA sequence wraps or fails | `getNextLegacyId('Missions'/'CompletionPaths', db)` throws | Both CDS handler and repair script propagate. Existing behavior — no special handling. |
| Missions auto-init fires twice in draft lifecycle (NEW + SAVE) | Second call sees `prior.legacyId` non-null and skips | None — re-entrant by design. |
| Two CompletionPaths drafts under same mission with same `name` | Slug-derive on second draft sees the first's slug in `taken`, appends `-2` | None — same `ensureUniqueSlug` helper as Missions/Groups. |
| Existing published mission re-saved (already published, payload echoes published=true) | `wasPublished && req.data.published === true` short-circuits, guard skips | None — guard only fires on publish-true transitions. |
| Author saves draft with intentionally-incomplete path items | Draft saves fine; only the publish-true transition refuses | None — design choice (incremental authoring). |
| Repair script on a row whose mission already has a sibling with the same slug | The script's slug derive uses `ensureUniqueSlug` against current siblings, picks the next available `-N` | None. |
| `CompletionPaths` exists with no `mission_ID` (orphan) | Slug-derive returns early (mission scope unknown) | Logged. Repair script reports it as a defect for manual triage. |

## Out of scope

- **Admin UI form fixes** for #436 root causes #3 (broken value-help) and #4 (silent `checkpointTitle` fallback). Tom's existing UI issue tracks those.
- **Adding `@mandatory legacyId` / `@mandatory slug` schema constraints** — risks breaking boot on existing legacy NULL rows; deferred.
- **Backfilling `Tutorials.legacyId`** — already shipped via PR #452.
- **Auto-repairing unresolvable `CompletionPathItems`** — no signal in the row to recover the intended target; SuperAdmin must re-link via UI.
- **Form-side tag-required visual indicator** — server validation already in place; UI label is a separate concern.
- **Backfilling `Groups.legacyId`** — moved INTO scope of this PR per spec review; see Approach §1. Two extra lines of handler registration.

## Verification

1. **Unit tests via `cds.test('serve')` against in-memory SQLite** in `srv/__tests__/admin-service-mission-form.test.js`. The tests invoke the AdminService over **HTTP** (`POST /admin/Missions`, `POST /admin/CompletionPaths`, `PATCH /admin/Missions(<id>)`) — exercises the full Express pipeline + auth bypass that `cds.test('serve')` provides:
   - Creating a Mission via `POST /admin/Missions` with no `legacyId` in the payload → resulting row has `legacyId > 0`.
   - Creating a CompletionPath via `POST /admin/CompletionPaths` with `name='My Path'` and no `slug` → resulting row has `slug='my-path'` and `legacyId > 0`.
   - Two CompletionPaths with `name='My Path'` under the same mission → second one gets `slug='my-path-2'`.
   - Two CompletionPaths with `name='My Path'` under DIFFERENT missions → both get `slug='my-path'` (scope-unique-per-mission).
   - Saving a Mission with `published=true` while a path item has `taskType=TUTORIAL` and `tutorial_ID=null` → 400 with the descriptive error message.
   - Saving the same Mission with `published=false` → succeeds (drafts allowed).
   - Saving an already-published Mission whose data is broken (legacy data) with `published=true` echo → succeeds (no transition; not the guard's job).
2. **One hybrid test** in `test/hybrid/repair-mission-completion-path-data.test.js` against real HANA: seed a Missions row with NULL legacyId + a CompletionPath with NULL legacyId + NULL slug, run the repair logic inline (mirror `repair-tutorial-legacyid.test.js`'s pattern), assert both heal correctly.
3. **Manual run on DEV** (post-merge, post-deploy): `npx cds bind --exec -- node scripts/repair-mission-completion-path-data.cjs --dry-run` lists the F1 mission's defects. `--commit` heals legacyId/slug. `--verify-only` exits 0 for the legacy/slug fields. The unresolvable `CompletionPathItems` are reported separately for SuperAdmin triage via the admin UI (now safer with the publish guard).

## References

- Issue: [#436](https://github.com/sap-tutorials/tutorials-ims/issues/436)
- Surfacing event: [#382](https://github.com/sap-tutorials/tutorials-ims/issues/382) phase F1 manual mission registration
- Sibling fix (Tutorials.legacyId): [#431 / PR #452](https://github.com/sap-tutorials/tutorials-ims/pull/452)
- Companion fix (mission renderer that surfaced the symptom): [#428](https://github.com/sap-tutorials/tutorials-ims/issues/428)
- Existing pattern (slug derive): [srv/admin-service.js:150-220](../../../srv/admin-service.js#L150)
- Existing pattern (publish guard): [srv/admin-service.js:805-813](../../../srv/admin-service.js#L805)
- Repair-script pattern: [scripts/repair-tutorial-legacyid.cjs](../../../scripts/repair-tutorial-legacyid.cjs)
- Schema entities: [db/schema.cds:48-62 (Missions), 264-286 (CompletionPaths/CompletionPathItems)](../../../db/schema.cds#L48)
