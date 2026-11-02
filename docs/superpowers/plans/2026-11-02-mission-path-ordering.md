# Mission Completion-Path Ordering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give admins an editable "Order" field on a Mission's Completion Paths, and make every learner-facing surface render paths in that order.

**Architecture:** Add `CompletionPaths.pathOrder : Integer`, surfaced in the Fiori admin UI exactly like the existing `CompletionPathItems.itemOrder` (editable Order column + SortOrder). Auto-number new paths via a before-handler (max+10 gap numbering). Add `.orderBy('pathOrder','name')` at the four path read sites that drive rendering. Backfill existing HANA rows alphabetically by name per mission.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), CDS, Fiori Elements annotations, in-memory SQLite (unit tests) / HANA (hybrid), Vitest-style `cds.test`.

**Spec:** `docs/superpowers/specs/2026-11-02-mission-path-ordering-design.md`

## Global Constraints

- New field name is exactly `pathOrder : Integer` on `CompletionPaths` (analogue of `CompletionPathItems.itemOrder`).
- Read-site ordering is exactly `.orderBy('pathOrder', 'name')` (and `'mission_ID','pathOrder','name'` for the cross-mission catalog query). Tiebreaker is `name`, NOT `legacyId`.
- Never write raw SQL in CAP runtime code — use `cds.ql` / CQL. (The backfill script may use `cds.ql` via `cds bind --exec`; follow the `repair-mission-completion-path-data.cjs` precedent.)
- Do NOT hand-edit generated bundles (`srv/lib/_shared/content.bundle.mjs`, `channels.bundle.mjs`) — edit source, rebuild.
- Do NOT touch `srv/lib/event-path-buckets.js` — its count-sort is intentional and a different surface.
- PR targets `DEV`; never direct-merge to `main`. Admin-UI changes require a full `mbt build` deploy.
- Gap numbering increment is `+10`, first value `10` (match `setGroupItemOrder`).

## Review Focus

- **Mission with zero completion paths** — `getAppSpaceProgress` / `mission-detail` must still return (empty paths), not throw on the new orderBy. (Covered: Task 5 keeps the existing empty-paths guard; add an assertion.)
- **Paths with NULL pathOrder after deploy but before backfill** — `.orderBy('pathOrder','name')` must not crash and must fall back to `name` order on both SQLite and HANA. (Covered: Task 5 unit test includes a NULL-pathOrder row; Task 7 hybrid test asserts post-deploy-pre-backfill ordering.)
- **Two paths with identical name under one mission** — slug uniqueness is per-mission scoped but names can collide; `name` tiebreaker leaves order undefined between them, which is acceptable (admin sets explicit pathOrder to disambiguate). No crash. (Covered: Task 3 `setPathOrder` still assigns distinct gap numbers.)
- **New path created inline in admin draft** — must get a non-null `pathOrder` without the admin typing one, and must not collide-overwrite an existing order. (Covered: Task 3.)
- **copyMission / promoteCommunityToMission producing paths with no order** — cloned/seeded paths must carry a defined `pathOrder` so the copied mission renders deterministically. (Covered: Task 4.)

---

### Task 1: Add `pathOrder` to the CompletionPaths schema

**Files:**
- Modify: `db/schema.cds` (CompletionPaths entity, ~:461-467)
- Test: `test/unit/completion-path-order.test.js` (create)

**Interfaces:**
- Produces: `CompletionPaths.pathOrder : Integer` — consumed by every later task.

- [ ] **Step 1: Write the failing test** — in `test/unit/completion-path-order.test.js`, bootstrap `cds.test` against the in-memory model and assert the field exists:

```js
const cds = require('@sap/cds');
const { expect } = cds.test(__dirname + '/../..');
test('CompletionPaths has an Integer pathOrder element', () => {
  const { CompletionPaths } = cds.model.definitions['com.sap.developers.ims'] ? cds.entities('com.sap.developers.ims') : {};
  const def = cds.model.definitions['com.sap.developers.ims.CompletionPaths'];
  expect(def.elements.pathOrder).toBeDefined();
  expect(def.elements.pathOrder.type).toBe('cds.Integer');
});
```

- [ ] **Step 2: Run test, verify it FAILS** — Run: `npx cds compile db/schema.cds` then the test. Expected: `pathOrder` undefined.

- [ ] **Step 3: Add the field** — in `db/schema.cds` `entity CompletionPaths`, add `pathOrder : Integer;` after `slug` (mirror placement of `CompletionPathItems.itemOrder`).

- [ ] **Step 4: Run test, verify it PASSES.**

- [ ] **Step 5: Commit** — `git add db/schema.cds test/unit/completion-path-order.test.js && git commit -m "feat(#2990): add pathOrder to CompletionPaths schema"`

---

### Task 2: Surface the editable Order column in the admin UI

**Files:**
- Modify: `app/admin-annotations.cds` (CompletionPaths annotate blocks, :214-240)

**Interfaces:**
- Consumes: `CompletionPaths.pathOrder` (Task 1).

- [ ] **Step 1: Add the label** — in the first `annotate AdminService.CompletionPaths with { … }` block (:215-219), add `pathOrder @Common.Label: 'Order';`.

- [ ] **Step 2: Add SortOrder + LineItem column** — in the `@UI` block (:221-240): add `PresentationVariant: { SortOrder: [ { Property: pathOrder } ] },` and make `pathOrder` the first `LineItem` entry: `{ Value: pathOrder, Label: 'Order' },` ahead of `{ Value: name }`.

- [ ] **Step 3: Verify the model still compiles** — Run: `npx cds compile srv/ 2>&1 | head -5`. Expected: no error referencing CompletionPaths/pathOrder. (NB: the pre-existing `developer-service-mcp.cds` duplicate-definition error on `main` is unrelated; confirm no *new* error.)

- [ ] **Step 4: Commit** — `git add app/admin-annotations.cds && git commit -m "feat(#2990): editable Order column + SortOrder on CompletionPaths admin UI"`

---

### Task 3: Auto-number new paths (`setPathOrder` before-handler)

**Files:**
- Modify: `srv/admin-service.js` (add handler near `setGroupItemOrder`, :1129-1140; register near :1139)
- Test: `test/admin-service.test.js` (add cases) OR `test/unit/completion-path-order.test.js`

**Interfaces:**
- Consumes: `CompletionPaths.pathOrder` (Task 1).
- Produces: a `before('NEW','CompletionPaths.drafts')` + `before('CREATE','CompletionPaths')` handler that sets `pathOrder = max(pathOrder for mission)+10` when null.

- [ ] **Step 1: Write the failing test** — assert that creating a CompletionPath under a mission with an existing path (pathOrder 10) yields pathOrder 20, and that an explicit pathOrder is preserved. Use the service API (`POST` to CompletionPaths or draft NEW), mirroring existing GroupPathItems order tests in `test/admin-service.test.js` (search `setGroupItemOrder`/`itemOrder` for the pattern).

```js
test('new CompletionPath gets max(pathOrder)+10 for its mission', async () => {
  // seed mission M with one path pathOrder=10, create a second → expect 20
});
test('explicit pathOrder on create is preserved', async () => { /* pass 55 → stays 55 */ });
```

- [ ] **Step 2: Run tests, verify they FAIL** — Run: `npm test -- admin-service` (new path gets null/undefined order).

- [ ] **Step 3: Implement `setPathOrder`** — mirror `setGroupItemOrder` (:1129-1140) exactly: if `req.data.pathOrder != null` return; resolve `mission_ID` from `req.data.mission_ID` or `req.params`; `SELECT.one.from(req.target).columns('max(pathOrder) as maxOrder').where({ mission_ID })`; set `req.data.pathOrder = (maxOrder ?? 0) + 10`. Register with `this.before('NEW','CompletionPaths.drafts', setPathOrder)` and `this.before('CREATE','CompletionPaths', setPathOrder)`.

- [ ] **Step 4: Run tests, verify they PASS.**

- [ ] **Step 5: Commit** — `git add srv/admin-service.js test/… && git commit -m "feat(#2990): auto gap-number pathOrder on new CompletionPaths"`

---

### Task 4: Carry `pathOrder` through copyMission + promoteCommunityToMission

**Files:**
- Modify: `srv/admin-service.js` — `copyMission` INSERT (:4038), `promoteCommunityToMission` INSERT (:3928)
- Test: `test/admin-service.test.js` (copyMission case)

**Interfaces:**
- Consumes: `CompletionPaths.pathOrder` (Task 1).

- [ ] **Step 1: Write the failing test** — seed a mission with two paths (pathOrder 10, 20), call `copyMission`, assert the copied mission's paths preserve pathOrder 10 and 20. (Extend an existing copyMission test if present.)

- [ ] **Step 2: Run test, verify it FAILS** — copied paths have null pathOrder.

- [ ] **Step 3: Implement** — in `copyMission`'s `INSERT.into(CompletionPaths).entries({...})` (:4038) add `pathOrder: p.pathOrder,`. In `promoteCommunityToMission`'s single-path INSERT (:3928) add `pathOrder: 10,`.

- [ ] **Step 4: Run test, verify it PASSES.**

- [ ] **Step 5: Commit** — `git add srv/admin-service.js test/… && git commit -m "feat(#2990): preserve pathOrder in copyMission and seed it in promoteCommunityToMission"`

---

### Task 5: Order paths by pathOrder at all render read sites

**Files:**
- Modify: `packages/content/catalog-data.js:182-185` (add `pathOrder` to `.columns(...)`, change orderBy)
- Modify: `srv/lib/build-catalog.js:22`
- Modify: `srv/developer-service.js:673-675` (`getAppSpaceProgress`) and `:562-564` (`getEventProgress`)
- Modify: `srv/lib/branch/mission-detail.js:40`
- Modify: `packages/content/catalog-mission-hierarchy.js` JSDoc comment (:92-94) — comment only
- Test: `test/catalog-data.test.js`, `test/build-catalog-mission-detail.test.js`, `test/app-space-segments-resolver.test.js` (or a new `test/app-space-path-order.test.js`), `test/build-catalog-mission-detail.test.js` for mission-detail

**Interfaces:**
- Consumes: `CompletionPaths.pathOrder` (Task 1).

- [ ] **Step 1: Write failing tests** — one assertion per rendering surface, each seeding a mission with paths whose `name` A→Z order differs from their `pathOrder`, plus one NULL-pathOrder path, and asserting emitted path order is `pathOrder` asc then `name`:
  - `getAppSpaceProgress(eventLegacyId=…)` → `response.paths[*].name` in pathOrder order (reuse the app-space test harness in `test/app-space-segments-resolver.test.js`).
  - `catalog-data` `loadMissionContext` → SSR hierarchy path order.
  - `mission-detail` handler → `paths[0]` is the pathOrder-first path.
  - (build-catalog: assert cross-mission catalog emits each mission's paths in pathOrder.)

- [ ] **Step 2: Run tests, verify they FAIL** (paths come back in legacyId/DB order).

- [ ] **Step 3: Implement the orderBy changes:**
  - `catalog-data.js:182-185`: add `'pathOrder'` to `.columns('ID','name','slug','legacyId')` → `.columns('ID','name','slug','legacyId','pathOrder')`; change `.orderBy('legacyId')` → `.orderBy('pathOrder','name')`.
  - `build-catalog.js:22`: `.orderBy('legacyId')` → `.orderBy('mission_ID','pathOrder','name')`.
  - `developer-service.js:564` and `:675`: `.orderBy('legacyId')` → `.orderBy('pathOrder','name')`.
  - `mission-detail.js:40`: append `.orderBy('pathOrder','name')` to the SELECT.
  - `catalog-mission-hierarchy.js` JSDoc (:92-94): update "legacyId" → "pathOrder, then name".

- [ ] **Step 4: Run tests, verify they PASS.**

- [ ] **Step 5: Rebuild generated bundles** — Run the project's bundle build (the `build:*` step that regenerates `srv/lib/_shared/content.bundle.mjs`; check `jq '.scripts' package.json` for the island/bundle script). Confirm the regenerated bundle contains `orderBy("pathOrder","name")` (grep it) — do NOT hand-edit. If the bundle is only regenerated by `build:all`, note that for the deploy step and skip here if it can't run in the worktree; flag to the executor.

- [ ] **Step 6: Commit** — `git add packages/ srv/ && git commit -m "feat(#2990): order mission completion paths by pathOrder at all render sites"`

---

### Task 6: Backfill existing HANA rows alphabetically by name

**Files:**
- Create: `scripts/backfill-completion-path-order.cjs` (follow `scripts/repair-mission-completion-path-data.cjs`)
- Modify: `package.json` scripts (add a `backfill-completion-path-order` entry next to existing repair scripts)
- Test: `test/hybrid/backfill-completion-path-order.test.js` (follow `test/hybrid/repair-mission-completion-path-data.test.js`)

**Interfaces:**
- Consumes: `CompletionPaths.pathOrder` (Task 1).

- [ ] **Step 1: Write the failing hybrid test** — seed (in the hybrid DB) a mission with 3 paths named "C","A","B" all with NULL pathOrder; run the backfill in commit mode; assert pathOrder is A=10, B=20, C=30 (per-mission, alphabetical by name); assert a second run is idempotent (NULL-only guard leaves them unchanged).

- [ ] **Step 2: Run test, verify it FAILS** (script does not exist).

- [ ] **Step 3: Implement the script** — mirror `repair-mission-completion-path-data.cjs`: `--dry-run`/`--commit`/`--verify-only` flags, JSONL `.migration-data` snapshot, `cds.connect`. Logic: for each mission, `SELECT` its paths `where pathOrder IS NULL` ordered by `name`, UPDATE each with gap-numbered pathOrder (10,20,30…) **scoped per mission** and continuing past any already-set rows (use `max(pathOrder for mission)` as the starting base so a partial prior run extends cleanly). Use `cds.ql`, not raw SQL.

- [ ] **Step 4: Run test, verify it PASSES** — Run: `npm run test:hybrid -- backfill-completion-path-order` (requires `cf login` + `cds bind`). If hybrid can't run in this environment, run the unit-level equivalent against in-memory SQLite and flag the hybrid run for the deploy step.

- [ ] **Step 5: Commit** — `git add scripts/ package.json test/hybrid/ && git commit -m "feat(#2990): backfill CompletionPaths.pathOrder alphabetically per mission"`

---

### Task 7: Full suite green + PR

**Files:** none (verification + PR)

- [ ] **Step 1: Run the full unit suite** — Run: `npm test`. Expected: PASS (wrap in `scripts/quiet-run.sh` per CLAUDE.md). The pre-existing `developer-service-mcp.cds` compile error, if it blocks, is a `main` issue — confirm whether it reproduces on untouched `main`; if so it is out of scope, note it, do not "fix" it here.

- [ ] **Step 2: Push branch + open PR to DEV** — `gh pr create --base DEV --title "feat(#2990): mission completion-path ordering" --body "<summary + Closes #2990>"`. Never target `main`.

- [ ] **Step 3: Record deploy/backfill/rebuild steps in the PR body** — full `npm run deploy -- --env dev` (no `--skip-build`), then run the Task 6 backfill against DEV HANA, then `gh workflow run rebuild-content.yml -f mode=full`, then in-browser verify admin Order column + `/app-space/?eventId=…` order.

---

## Self-Review notes

- **Spec coverage:** schema (T1), admin UI (T2), auto-number (T3), write-path carry (T4), 4 read sites + hierarchy comment (T5), backfill (T6), rollout/PR (T7). All Decisions 1-7 mapped.
- **Review Focus:** zero-paths, NULL-pathOrder-pre-backfill, duplicate names, inline-create, copy/promote — each pinned to T3/T4/T5/T6 tests.
- **Type consistency:** field is `pathOrder` everywhere; orderBy string is `'pathOrder','name'` everywhere (cross-mission adds `'mission_ID'` first).
- **Proportion:** plan carries the decisions (exact lines, exact orderBy, exact handler shape); bodies left to the implementer except where the signature is fixed.
