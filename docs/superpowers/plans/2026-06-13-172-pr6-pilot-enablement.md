# 172 PR 6 — Pilot Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist a fixed-vocabulary user profile (`deployment`/`role`/`cloud`) so the branching engine's condition expressions actually evaluate against real data, plus a `?profile.X` debug override for authors/admins, plus runbook + cookbook docs for pilot rollout.

**Architecture:** New `UserLearningPreferences` typed entity (one row per user, composition-keyed on `key user : Association to Users`); self-service edit via a new `/me/` Vue island posting to a `setLearningPreferences` action on DeveloperService; AdminService gets a `@readonly` projection for support; the engine's existing `loadProfile` placeholder gets a typed swap; `buildUserState` gains an `opts.override` param fed from a new `extractProfileOverride` parser invoked at the two express callsites (`decideHandler` + `missionDetailHandler`). Vocab strings live in a shared ESM constants module imported by both server and Vue. Write path is the codebase-canonical SELECT-then-INSERT-or-UPDATE (zero `UPSERT` precedent in `srv/`); cache invalidation is TTL-only (no `bustForUser` hook added in v1).

**Tech Stack:** CDS + CAP Node.js (ESM), vitest unit + hybrid + smoke, Vue 3 SFC + UI5 webcomponents, Hugo + VitePress for docs, no new npm dependencies.

**Spec section refs:** §1 (Problem), §3 (Architecture), §4.1 (entity), §4.2 (projections), §4.3 (constants), §5.1 (read path), §5.2 (write path), §5.3 (override URL), §6 (edge cases), §7.1 (file table), §7.2 (action handler + before-READ), §7.3 (override parser + callsite integration §7.3.1), §7.4 (loaders rewrite), §7.5 (buildUserState merge), §7.6 (Vue island), §7.7 (admin Fiori), §7.8 (runbook), §7.9 (cookbook), §8 (tests), §9 (risks), §10 (DoD).

**Depends on:** PRs 1-5 all merged. Reuses substrates: `srv/lib/branch/user-state.js` (`buildUserState`, `fingerprintUserState`, `PROFILE_FIELDS`), `srv/lib/branch/loaders.js` (`loadProfile` placeholder), `srv/developer-service.js` `completeStep` auto-provision pattern, `srv/lib/anonymization-cascade.js` (annotation-driven cascade walker), `db/audit-logging.cds` (`@PersonalData` annotations), `app/admin-annotations.cds` (Fiori Elements LineItem template).

## Spec deviations from the master spec

These intentional divergences from the original master-spec direction (issue #172 v1 design, §9.1 row 6) are baked into this plan. All other behaviour matches the PR 6 spec verbatim.

- **Storage shape:** Master spec said "three new optional `String` columns on the existing `UserMetaData` entity"; PR 1's reviewer mandated a separate typed entity. Plan uses **`UserLearningPreferences`** (typed, enum-constrained, composition-keyed on `user`). Per-recon: zero existing rows in `UserMetaData`, no migration needed.
- **Override gate:** Master spec gated the `?profile.X` override on `Tutorial.Author` only. Spec round-1 pivot 2 widened to **`Tutorial.Author` OR `Admin`** so Tom (Admin in DEV) can test the override on his existing admin login without role-collection grant. Both author and admin are trusted-internal scopes.
- **Save UX:** Master spec was silent on save semantics. Spec round-1 pivot 1 chose **explicit "Save preferences" button** (with dirty state) over debounced auto-save — matches every other user-form Vue island in the codebase (validation, code-check, tutorial-feedback, tutorial-rating).
- **Write idiom:** Spec round-3 BLOCKING DB1 — switched from `UPSERT.into()` (zero precedent in `srv/`) to **SELECT-then-INSERT-or-UPDATE** (codebase-wide canonical pattern; see `developer-service.js#completeStep:122-135` for Users auto-provision and `#createTaskRecord:167-209` for the same shape on `TaskRecords`).
- **Cache invalidation:** Spec round-2 BLOCKING B1 — neither `mission-detail.js` nor `decide.js` exports a `bustForUser` hook (recon: only `__resetCacheForTest`). Plan accepts the existing **5-minute TTL** stale-after-write window for v1; explicit invalidator deferred to v2.
- **AdminService projection:** Spec round-2 BLOCKING CB5 — projection is `@readonly` in v1. Edit-on-behalf is out of scope. The user-facing `/me/` panel is the only edit path. Reopen for v2 if support actually needs admin edit.
- **`@assert.range` scope (DM6):** kept on the schema as model-level documentation / future-proofing only. CAP's `@assert.range` fires only at the OData protocol layer, not on programmatic CQL writes from action handlers — the action handler's enum-validation loop is the actual runtime gate. Hybrid test 1 verifies the JS-layer gate explicitly.
- **Joule narration override:** Spec round-2 BLOCKING B8 — narration runs through CAP `chat-orchestrator` and never sees the express `req.query`, so `?profile.*` overrides do NOT flow through. Documented as out-of-scope for v1; cookbook/runbook tell authors to clear the override before testing narration.

---

## File Structure

**Create (~9 new files):**

- `srv/lib/branch/profile-fields.js` — vocab constants (ESM)
- `srv/lib/branch/profile-override.js` — express request override parser (Tutorial.Author OR Admin gate)
- `app/admin-annotations.cds` — extended (NOT new): admin Fiori Elements list view for LearningPreferences
- `hugo-apps/src/me/LearningPreferences.vue` — new Vue island
- `docs/authors/pilot-runbook.md` — new runbook
- `test/unit/learning-preferences.test.js` — action-handler unit tests (6 cases)
- `srv/lib/branch/__tests__/profile-override.test.js` — override-parser unit tests (6 cases)
- `scripts/__tests__/profile-fields-sync.test.ts` — schema/vocab sync test (1 case)
- `scripts/__tests__/anonymization-cascade-pr6.test.ts` — cascade-walker pickup test (1 case)
- `hugo-apps/src/me/__tests__/LearningPreferences.test.ts` — Vue island tests (5 cases)
- `test/hybrid/learning-preferences.test.js` — HANA hybrid tests (3 cases, opt-in)
- `test/smoke/learning-preferences.smoke.test.js` — smoke tests (2 cases)

**Modify (~10 existing files):**

- `db/schema.cds` — append entity (~12 LoC)
- `db/audit-logging.cds` — annotate (~5 LoC)
- `srv/developer-service.cds` — append projection + action; extend `ChatConfig` projection to expose `branchingEnabled` (~11 LoC)
- `srv/developer-service.js` — new `setLearningPreferences` handler + before-READ row filter (~40 LoC)
- `srv/admin-service.cds` — append projection (~3 LoC)
- `srv/lib/branch/loaders.js` — rewrite `loadProfile` body (~15 LoC replace, keep try/catch)
- `srv/lib/branch/user-state.js` — add override param + merge; remove inline `PROFILE_FIELDS` const, import from new module (~5 LoC delta)
- `srv/lib/branch/decide.js` — extract + pass override at express callsite (~3 LoC)
- `srv/lib/branch/mission-detail.js` — extract + pass override INSIDE existing `if (flagOn)` block (~3 LoC)
- `srv/lib/branch/__tests__/loaders.test.js` — extend with 2 cases
- `srv/lib/branch/__tests__/user-state.test.js` — extend with 3 cases (incl. fingerprint-divergence)
- `hugo-apps/src/me/main.ts` — mount the new island + 7 UI5 imports (~10 LoC)
- `hugo/layouts/me/list.html` — append mount-point div inside existing `{{ if not site.Params.qa }}` block (~1 LoC)
- `docs/authors/branching-cookbook.md` — append `#debug-override` section (~30 LoC)
- `docs/.vitepress/config.ts` — sidebar entry under "Branching paths" (~1 LoC)

**No new npm dependencies.** Total: ~22 new/modified files.

**Test summary:** 29 new test cases (19 unit + 5 Vue + 3 hybrid + 2 smoke).

**Manual checklist (PR body):** 9 manual verifications covering save, override (author + admin), anonymization, branching-disabled UX, a11y screen-reader.

---

## Task 0: Branch sanity & worktree confirmation

**Files:** none (verification only)

- [ ] **Step 1: Confirm branch + worktree + clean tree**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current && pwd && git status -sb
```

Expected: `feat/172-pr6-pilot-enablement` and `.../feat-172-pr6` and clean. Abort if branch shows `main`.

- [ ] **Step 2: Verify spec exists**

```bash
ls D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6/docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md
```

Expected: file exists.

- [ ] **Step 3: Verify PR 1+5 substrate is in place**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && grep -nE "loadProfile|PROFILE_FIELDS" srv/lib/branch/user-state.js srv/lib/branch/loaders.js | head -10
```

Expected: hits on `loadProfile` (placeholder with TODO comment in `loaders.js:38-63`) and `PROFILE_FIELDS` (line 9 in `user-state.js`).

```bash
grep -n "branchingEnabled" db/schema.cds | head -3
```

Expected: hit (PR 1 added the field on `ChatSettings` at line 460).

```bash
grep -n "@odata.singleton\|ChatConfig" srv/developer-service.cds | head -5
```

Expected: `@odata.singleton` + `entity ChatConfig as projection on ims.ChatSettings { ID, enabled, bannerText };`.

---

## Task 1: Vocab constants module — `profile-fields.js`

**Files:**
- Create: `srv/lib/branch/profile-fields.js`

The shared single-source-of-truth for the v1 profile vocabulary (deployment / role / cloud) — imported by override parser, action handler, Vue island. ESM (matches PR 1's `user-state.js` precedent).

- [ ] **Step 1: Write the file**

Create `srv/lib/branch/profile-fields.js`:

```js
// srv/lib/branch/profile-fields.js
//
// Single source of truth for the v1 profile vocabulary. Imported by:
//   - srv/lib/branch/profile-override.js  (allowlist check)
//   - srv/developer-service.js            (action-handler enum validation)
//   - hugo-apps/src/me/LearningPreferences.vue  (Select option lists)
//
// Spec: docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md §4.3
// Drift guard: scripts/__tests__/profile-fields-sync.test.ts asserts these
// values match the CDS enum strings on UserLearningPreferences (Task 11).

export const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];

export const PROFILE_VOCAB = {
  deployment: ['cloud', 'onprem'],
  role: ['developer', 'architect', 'sysadmin', 'student'],
  cloud: ['btp', 'aws', 'gcp'],
};
```

- [ ] **Step 2: Smoke-import**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && node --input-type=module -e "import('./srv/lib/branch/profile-fields.js').then(m => console.log(JSON.stringify({fields: m.PROFILE_FIELDS, vocab: m.PROFILE_VOCAB})))"
```

Expected: JSON output with all three fields + vocab arrays.

- [ ] **Step 3: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
# Must be: feat/172-pr6-pilot-enablement
git add srv/lib/branch/profile-fields.js
git commit -m "feat(172): profile-fields constants module (single source of truth for vocab)"
```

---

## Task 2: Schema — `UserLearningPreferences` entity

**Files:**
- Modify: `db/schema.cds`
- Modify: `db/audit-logging.cds`

The typed entity that replaces the master spec's "three String columns on UserMetaData" direction. Composition-keyed on `key user : Association to Users` — one row per user, no separate `cuid` UUID. `@assert.range` is BEFORE the inline `enum {}` block (canonical CAP order verified via cds-mcp). `@PersonalData` annotation lives in `db/audit-logging.cds`, mirroring the `UserMetaData` pattern verbatim.

- [ ] **Step 1: Inspect insertion point in schema.cds**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && grep -n "entity UserMetaData" db/schema.cds
```

Expected: hit at ~line 127. Append the new entity AFTER the closing `}` of `UserMetaData` (around line 131).

- [ ] **Step 2: Append `UserLearningPreferences` entity to `db/schema.cds`**

Append to `db/schema.cds` after the `UserMetaData` block (around line 131):

```cds

// Issue #172 PR 6 — Pilot enablement.
// Typed user profile for branching-condition evaluation. Replaces the master
// spec's "three String columns on UserMetaData" direction (PR 1 reviewer
// mandated a separate entity to avoid overloading the key/value store).
//
// `key user : Association to Users` — one row per user; HANA table PK is
// USER_ID only (no ID column). Canonical lookup:
//   SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID })
//
// `@assert.range` is kept as model-level documentation / future-proofing if the
// entity is ever exposed for direct OData write. CAP's @assert.range fires only
// at the OData protocol layer, NOT on programmatic CQL writes from action
// handlers — the action handler's enum-validation loop is the actual runtime
// gate (see srv/developer-service.js setLearningPreferences).
//
// Spec: docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md §4.1
entity UserLearningPreferences : managed {
  key user       : Association to Users;
  deployment     : String(20) @assert.range enum { cloud; onprem; };
  role           : String(20) @assert.range enum { developer; architect; sysadmin; student; };
  cloud          : String(20) @assert.range enum { btp; aws; gcp; };
}
```

- [ ] **Step 3: Append `@PersonalData` annotation to `db/audit-logging.cds`**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && grep -n "annotate ims.UserMetaData with @PersonalData" db/audit-logging.cds
```

Expected: hit at ~line 18.

Append to `db/audit-logging.cds` (the position doesn't matter much; conventional location is alongside the `UserMetaData` block):

```cds

// Issue #172 PR 6 — Pilot enablement.
// Mirrors the UserMetaData pattern verbatim. The cascade walker
// (srv/lib/anonymization-cascade.js) is annotation-driven and walks every
// entity with @PersonalData; no allowlist update needed. Hybrid test 3
// verifies cascade-delete in real HANA.
annotate ims.UserLearningPreferences with @PersonalData : {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};
```

- [ ] **Step 4: Compile-check**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 npx cds compile db/schema.cds db/audit-logging.cds --to sql 2>&1 | grep -E "USER_LEARNING_PREFERENCES|ERROR" | head -10
```

Expected: `CREATE TABLE COM_SAP_DEVELOPERS_IMS_USER_LEARNING_PREFERENCES ... USER_ID NVARCHAR(36) NOT NULL ... PRIMARY KEY (USER_ID)`. No ERROR output.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add db/schema.cds db/audit-logging.cds
git commit -m "feat(172): UserLearningPreferences entity + @PersonalData annotation"
```

---

## Task 3: Service projections — DeveloperService + AdminService + ChatConfig widening

**Files:**
- Modify: `srv/developer-service.cds`
- Modify: `srv/admin-service.cds`

Expose `UserLearningPreferences` on:

- `DeveloperService` (`/api`, `@requires: 'authenticated-user'` per-entity) — `@readonly` projection for self-service GET + an action `setLearningPreferences` for self-service write.
- `AdminService` (`/admin`, `@requires: 'Admin'` service-level) — `@readonly` projection for support read-only.

Plus extend the existing `ChatConfig` projection on DeveloperService to expose `branchingEnabled` (already on `ChatSettings` since PR 1; just unhide it in the projection so the Vue island can read it).

- [ ] **Step 1: Inspect existing surfaces**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && grep -n "@readonly entity\|@requires\|ChatConfig\|action " srv/developer-service.cds | head -20
```

Confirm: `@odata.singleton @(requires: 'any') @readonly entity ChatConfig as projection on ims.ChatSettings { ID, enabled, bannerText };`. The action declarations are inside the service block.

```bash
grep -n "@readonly entity\|@requires" srv/admin-service.cds | head -5
```

Confirm: service-level `@requires: 'Admin'` (line 5).

- [ ] **Step 2: Modify `srv/developer-service.cds` — extend ChatConfig + add LearningPreferences projection + action**

Replace the existing `ChatConfig` projection line:

```cds
  entity ChatConfig as projection on ims.ChatSettings { ID, enabled, bannerText };
```

With:

```cds
  // PR 6 — added branchingEnabled so /me/ can show the "branching is currently disabled"
  // info-strip when the master flag is off. ChatConfig keeps @requires: 'any' (anonymous-readable)
  // because Vue islands fetch it on mount before any auth handshake; branchingEnabled is a
  // non-sensitive platform flag.
  entity ChatConfig as projection on ims.ChatSettings { ID, enabled, bannerText, branchingEnabled };
```

Then append (alongside other `@readonly entity` blocks, before the closing `}`):

```cds

  // PR 6 — Pilot enablement. The before-READ row filter (in srv/developer-service.js)
  // scopes every authenticated GET to the caller's own row only.
  // Spec: §4.2
  @(requires: 'authenticated-user')
  @readonly entity LearningPreferences as projection on ims.UserLearningPreferences {
    user, deployment, role, cloud
  };

  // PR 6 — Self-service write surface. PUT-style: all three fields are written every time;
  // values omitted by the caller are explicitly cleared to null.
  // Spec: §4.2, §7.2
  @(requires: 'authenticated-user')
  action setLearningPreferences(
    deployment : String,
    role       : String,
    cloud      : String
  ) returns LearningPreferences;
```

- [ ] **Step 3: Modify `srv/admin-service.cds` — append @readonly LearningPreferences projection**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && tail -5 srv/admin-service.cds
```

Confirm the file ends inside the `service AdminService { ... }` block.

Append (before the closing `}` of `service AdminService { ... }`):

```cds

  // PR 6 — Pilot enablement. Read-only support surface; admins read all rows
  // (no per-row filter — inherits Admin gate from the service level). UI annotations
  // live in app/admin-annotations.cds (Task 9). Edit-on-behalf is out of scope for v1.
  // Spec: §4.2
  @readonly entity LearningPreferences as projection on ims.UserLearningPreferences;
```

- [ ] **Step 4: Compile-check both services**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 npx cds compile srv/developer-service.cds srv/admin-service.cds --to edmx -s DeveloperService 2>&1 | grep -E 'EntityType Name="LearningPreferences"|EntityType Name="ChatConfig"|Property Name="branchingEnabled"' | head -5
```

Expected: hits showing `LearningPreferences` and `ChatConfig` entity types + the `branchingEnabled` Property. No errors.

- [ ] **Step 5: Re-run compile against AdminService scope**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 npx cds compile srv/admin-service.cds --to edmx -s AdminService 2>&1 | grep -E 'EntityType Name="LearningPreferences"' | head -3
```

Expected: hit on `EntityType Name="LearningPreferences"` (read-only, no key edit form).

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add srv/developer-service.cds srv/admin-service.cds
git commit -m "feat(172): project UserLearningPreferences on DeveloperService + AdminService; expose branchingEnabled on ChatConfig"
```

---

## Task 4: Override parser — `profile-override.js`

**Files:**
- Create: `srv/lib/branch/profile-override.js`
- Create: `srv/lib/branch/__tests__/profile-override.test.js`

The express-only override extractor. Gated on `Tutorial.Author` OR `Admin` (round-1 pivot 2). Imports vocab from Task 1's constants module. Empty strings treated as absent. Loops over `PROFILE_FIELDS` and validates each candidate against `PROFILE_VOCAB[field]`.

- [ ] **Step 1: Write the failing tests**

Create `srv/lib/branch/__tests__/profile-override.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { extractProfileOverride } from '../profile-override.js';

function fakeReq({ scopes = [], query = {} } = {}) {
  return {
    user: {
      id: scopes.length ? 'user-123' : 'anonymous',
      is: (scope) => scopes.includes(scope),
    },
    query,
  };
}

describe('extractProfileOverride', () => {
  it('returns the override for an authenticated Tutorial.Author with a valid query value', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['Tutorial.Author'], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toEqual({ deployment: 'cloud' });
  });

  it('returns the override for an authenticated Admin (no Tutorial.Author) — gate widening (pivot 2)', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['Admin'], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toEqual({ deployment: 'cloud' });
  });

  it('returns null for an authenticated user with neither scope', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['DeveloperApp'], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toBeNull();
  });

  it('returns null for an anonymous request', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: [], query: { 'profile.deployment': 'cloud' } })
    );
    expect(out).toBeNull();
  });

  it('drops fields with values not in PROFILE_VOCAB; returns null when nothing valid remains', () => {
    const out = extractProfileOverride(
      fakeReq({ scopes: ['Tutorial.Author'], query: { 'profile.deployment': 'hybrid' } })
    );
    expect(out).toBeNull();
  });

  it('treats empty-string the same as missing — express-default qs parser fragility guard', () => {
    const out = extractProfileOverride(
      fakeReq({
        scopes: ['Tutorial.Author'],
        query: { 'profile.deployment': 'cloud', 'profile.role': '' },
      })
    );
    expect(out).toEqual({ deployment: 'cloud' });
  });
});
```

- [ ] **Step 2: Run failing test**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit srv/lib/branch/__tests__/profile-override.test.js 2>&1 | tail -10
```

Expected: FAIL — module `../profile-override.js` not found.

- [ ] **Step 3: Implement `profile-override.js`**

Create `srv/lib/branch/profile-override.js`:

```js
// srv/lib/branch/profile-override.js
//
// Issue #172 PR 6 — Pilot enablement. Express-request override parser.
//
// Extracts a validated profile override from `?profile.<field>=<value>` query
// params on EXPRESS callsites only. Gated on Tutorial.Author OR Admin scope
// (round-1 pivot 2). Empty strings are dropped (treated same as missing).
//
// Invariant (architectural): this consumes the EXPRESS req — req.user, and
// req.query as flat string map. It is NOT for CAP action handlers; the
// chat-orchestrator and setLearningPreferences both receive a CAP req whose
// req.query is a CQN object, not an express query map. The override is
// request-time only on the two express callsites (decideHandler in
// srv/lib/branch/decide.js, missionDetailHandler in srv/lib/branch/mission-detail.js)
// and never persists.
//
// Spec: docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md §3.6, §5.3, §7.3

import { PROFILE_FIELDS, PROFILE_VOCAB } from './profile-fields.js';

/**
 * Extract a validated profile override from an EXPRESS request.
 *
 * @param {object} req - express request object (has req.user.is(scope) + req.query)
 * @returns {object|null} { <field>: <value>, ... } when at least one valid
 *   override survives the gate + allowlist; null otherwise.
 */
export function extractProfileOverride(req) {
  const isAuthor = req?.user?.is?.('Tutorial.Author');
  const isAdmin = req?.user?.is?.('Admin');
  if (!isAuthor && !isAdmin) return null;
  const override = {};
  for (const field of PROFILE_FIELDS) {
    const v = req.query?.[`profile.${field}`];
    // Empty string treated same as missing — defence in depth + qs-parser fragility.
    if (typeof v === 'string' && v !== '' && PROFILE_VOCAB[field].includes(v)) {
      override[field] = v;
    }
  }
  return Object.keys(override).length ? override : null;
}
```

- [ ] **Step 4: Re-run tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit srv/lib/branch/__tests__/profile-override.test.js 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add srv/lib/branch/profile-override.js srv/lib/branch/__tests__/profile-override.test.js
git commit -m "feat(172): profile-override parser (Tutorial.Author OR Admin gate)"
```

---

## Task 5: Engine integration — `loaders.js` typed read + `user-state.js` override merge + callsite patches

**Files:**
- Modify: `srv/lib/branch/loaders.js`
- Modify: `srv/lib/branch/user-state.js`
- Modify: `srv/lib/branch/decide.js`
- Modify: `srv/lib/branch/mission-detail.js`
- Modify: `srv/lib/branch/__tests__/loaders.test.js`
- Modify: `srv/lib/branch/__tests__/user-state.test.js`

Five surgical changes to wire profile data into the engine:

1. **`loaders.js`**: replace the `loadProfile` placeholder body (lines 38-63 + the TODO comment block above it) with a typed SELECT against `UserLearningPreferences`. Keep the try/catch + `LOG.warn` + return-null fallback so a mid-rollout deploy without the new entity doesn't crash the read path.
2. **`user-state.js`**: remove the inline `const PROFILE_FIELDS = [...]` declaration on line 9 (now imported from the new `profile-fields.js` module); add `opts.override` parameter to `buildUserState`; merge override over real profile in the per-field loop.
3. **`decide.js`**: import `extractProfileOverride`; call it on the express `req` before `buildUserState`; pass the result via `opts.override`.
4. **`mission-detail.js`**: same patch as decide.js, but place the import + extraction + buildUserState lines INSIDE the existing `if (flagOn) { ... }` block (per spec §7.3.1 placement note — outside the flag, override is meaningless and parsing wastes cycles).
5. **Tests**: extend `loaders.test.js` with 2 new cases (typed read shape + null-on-no-row); extend `user-state.test.js` with 3 new cases (override merge over real, partial override, fingerprint-divergence).

- [ ] **Step 1: Inspect existing shape**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && sed -n '36,65p' srv/lib/branch/loaders.js
```

Confirm the existing `loadProfile` body + TODO comment shape (PR 1's placeholder).

```bash
sed -n '1,20p' srv/lib/branch/user-state.js
```

Confirm line 9 is the inline `const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];`.

```bash
grep -n "buildUserState\|extractProfileOverride\|if (flagOn)" srv/lib/branch/decide.js srv/lib/branch/mission-detail.js | head -20
```

Note the existing call sites in both handlers + the `if (flagOn)` guard in `mission-detail.js`.

- [ ] **Step 2: Write extended tests for `loaders.test.js` (+2 cases)**

Append to `srv/lib/branch/__tests__/loaders.test.js`:

```js
describe('loadProfile (PR 6 typed read)', () => {
  it('returns {deployment, role, cloud} shape from UserLearningPreferences', async () => {
    // Use the existing in-memory CDS test serve; create a Users row + a
    // matching UserLearningPreferences row; assert loadProfile returns the
    // typed shape.
    const cds = (await import('@sap/cds')).default;
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const userUuid = '__test__-pr6-load-1';
    const dbUser = await INSERT.into(Users).entries({
      uuid: userUuid, legacyId: 990001, email: '', firstName: '', lastName: '',
    });
    const dbUserId = (await SELECT.one.from(Users).where({ uuid: userUuid })).ID;
    await INSERT.into(UserLearningPreferences).entries({
      user_ID: dbUserId, deployment: 'cloud', role: 'developer', cloud: 'btp',
    });
    const { makeBranchLoaders } = await import('../loaders.js');
    const loaders = makeBranchLoaders();
    const profile = await loaders.loadProfile({ id: userUuid });
    expect(profile).toEqual({ deployment: 'cloud', role: 'developer', cloud: 'btp' });
  });

  it('returns null when user has no UserLearningPreferences row', async () => {
    const { makeBranchLoaders } = await import('../loaders.js');
    const loaders = makeBranchLoaders();
    const profile = await loaders.loadProfile({ id: '__test__-pr6-load-noexist' });
    expect(profile).toBeNull();
  });
});
```

- [ ] **Step 3: Write extended tests for `user-state.test.js` (+3 cases)**

Append to `srv/lib/branch/__tests__/user-state.test.js`:

```js
describe('buildUserState — override merge (PR 6)', () => {
  function makeFakeDeps(profile) {
    return {
      loadCompletedSlugs: async () => [],
      loadCompletedMissionSlugs: async () => [],
      loadProfile: async () => profile,
    };
  }

  it('merges override OVER real profile (per-field override wins)', async () => {
    const { buildUserState } = await import('../user-state.js');
    const state = await buildUserState(
      { id: 'u' },
      makeFakeDeps({ deployment: 'onprem', role: null, cloud: null }),
      { override: { deployment: 'cloud' } }
    );
    expect(state.profile).toEqual({ deployment: 'cloud', role: null, cloud: null });
  });

  it('respects null fields in override merge — partial override + real profile preserved', async () => {
    const { buildUserState } = await import('../user-state.js');
    const state = await buildUserState(
      { id: 'u' },
      makeFakeDeps({ deployment: 'onprem', role: 'developer', cloud: null }),
      { override: { deployment: 'cloud' } }
    );
    expect(state.profile).toEqual({ deployment: 'cloud', role: 'developer', cloud: null });
  });

  it('fingerprint-cache isolation: override-mode and learner-mode produce distinct fingerprints', async () => {
    const { buildUserState, fingerprintUserState } = await import('../user-state.js');
    const deps = makeFakeDeps({ deployment: 'onprem', role: null, cloud: null });
    const learner = await buildUserState({ id: 'u' }, deps);
    const override = await buildUserState({ id: 'u' }, deps, { override: { deployment: 'cloud' } });
    expect(fingerprintUserState(override)).not.toBe(fingerprintUserState(learner));
  });
});
```

- [ ] **Step 4: Run failing tests (5 new cases)**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit srv/lib/branch/__tests__/loaders.test.js srv/lib/branch/__tests__/user-state.test.js 2>&1 | tail -10
```

Expected: 5 failures (loaders: typed shape mismatch since current loadProfile reads UserMetaData; user-state: override param not yet supported).

- [ ] **Step 5: Rewrite `loadProfile` in `srv/lib/branch/loaders.js`**

Replace the existing `loadProfile` function body (lines 38-63 inclusive — including the TODO comment block above it) with:

```js
    async loadProfile(user) {
      if (!user?.id || user.id === 'anonymous') return null;
      try {
        // PR 6: typed read against UserLearningPreferences (replaces PR 1's
        // key/value placeholder against UserMetaData). Defensive try/catch +
        // LOG.warn + return-null shape preserved so a mid-rollout deploy that
        // hasn't yet run `cds deploy` for the new entity continues to serve
        // the engine with a null profile rather than crashing the read path.
        const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
        const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
        if (!dbUser?.ID) return null;
        const row = await SELECT.one.from(UserLearningPreferences)
          .where({ user_ID: dbUser.ID });
        return row ? { deployment: row.deployment, role: row.role, cloud: row.cloud } : null;
      } catch (err) {
        LOG.warn(`loadProfile: ${err.message} — degrading to null profile`);
        return null;
      }
    },
```

- [ ] **Step 6: Modify `srv/lib/branch/user-state.js` — import vocab + add override merge**

Replace the existing line 9:

```js
const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];
```

with:

```js
import { PROFILE_FIELDS } from './profile-fields.js';
```

(Remove the inline `const` declaration; the value now comes from the constants module — single source of truth.)

Replace the `buildUserState` function (the body up to and including the return statement). The new signature accepts `opts = {}`:

```js
export async function buildUserState(user, deps, opts = {}) {
  if (!user) return EMPTY_STATE;

  const [slugs, missions, profileRaw] = await Promise.all([
    deps.loadCompletedSlugs(user),
    deps.loadCompletedMissionSlugs(user),
    deps.loadProfile(user),
  ]);

  // PR 6: merge override. The override is already validated by
  // extractProfileOverride (only valid enum values, only when user has
  // Tutorial.Author or Admin scope, empty strings already dropped). We
  // additionally treat undefined/null/'' as "absent" here for defence in depth.
  const profile = Object.create(null);
  for (const f of PROFILE_FIELDS) {
    const ov = opts.override?.[f];
    profile[f] = (typeof ov === 'string' && ov !== '') ? ov : (profileRaw?.[f] ?? null);
  }

  return Object.freeze({
    completedSlugs: new Set(slugs),
    completedMissionSlugs: new Set(missions),
    profile: Object.freeze(profile),
  });
}
```

Note: `EMPTY_STATE` declaration above remains unchanged. The `fingerprintUserState` function below also remains unchanged — it already references `PROFILE_FIELDS` (which is now imported instead of locally declared).

- [ ] **Step 7: Patch `srv/lib/branch/decide.js` — extract + pass override**

Add the import near the top of the file (alongside other branch-engine imports):

```js
import { extractProfileOverride } from './profile-override.js';
```

In the handler body, find the `await buildUserState(user, loaders)` call and replace with:

```js
const override = extractProfileOverride(req);
const userState = await buildUserState(user, loaders, { override });
```

(Three lines added: the import, the override extraction, and the `{ override }` opts arg on `buildUserState`.)

- [ ] **Step 8: Patch `srv/lib/branch/mission-detail.js` — same shape, INSIDE the `if (flagOn)` block**

Add the import near the top (alongside other branch-engine imports):

```js
import { extractProfileOverride } from './profile-override.js';
```

Find the existing `if (flagOn) { ... await buildUserState(user, loaders) ... }` block. INSIDE that block, before `buildUserState`, add:

```js
const override = extractProfileOverride(req);
```

Then update the `buildUserState` call to pass `{ override }` as the third argument.

(Per spec §7.3.1 placement note: this MUST go inside the `if (flagOn)` block so override extraction only happens when the engine is consulted; outside the flag the override is meaningless and parsing wastes cycles.)

- [ ] **Step 9: Run all tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit srv/lib/branch/__tests__/ 2>&1 | tail -10
```

Expected: all branch-engine unit tests pass (existing + 5 new = 17+ passing).

- [ ] **Step 10: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add srv/lib/branch/loaders.js srv/lib/branch/user-state.js srv/lib/branch/decide.js srv/lib/branch/mission-detail.js srv/lib/branch/__tests__/loaders.test.js srv/lib/branch/__tests__/user-state.test.js
git commit -m "feat(172): typed loadProfile + buildUserState override merge + callsite patches"
```

---

## Task 6: Action handler + before-READ row filter — `srv/developer-service.js`

**Files:**
- Modify: `srv/developer-service.js`
- Create: `test/unit/learning-preferences.test.js`

The CAP service-impl class additions: a `before('READ', 'LearningPreferences', ...)` hook that injects a `where({ user_ID: dbUser.ID })` filter using the CQN builder API (which AND-conjoins safely with any pre-existing where clause), and an `on('setLearningPreferences', ...)` handler that auto-provisions the Users row (mirroring `completeStep` at lines 122-135), validates each field against `PROFILE_VOCAB`, and writes via SELECT-then-INSERT-or-UPDATE.

**PUT-style semantics:** all three fields are written every time. Values omitted by the caller (action params with no value) default to `null` and are explicitly cleared. The Vue island always sends all three values via the explicit Save button.

**No cache-bust:** the engine's `mission-detail.js` + `decide.js` per-callsite caches expire on their own 5-minute TTL.

- [ ] **Step 1: Inspect existing class shape + completeStep auto-provision pattern**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && grep -nE "class DeveloperService|async init|this\.before|this\.on|getNextLegacyId|cds\.entities" srv/developer-service.js | head -20
```

Confirm: `export default class DeveloperService extends cds.ApplicationService` with `async init()` containing `cds.entities('com.sap.developers.ims')` destructure, `this.before(...)` and `this.on(...)` registrations.

```bash
sed -n '120,140p' srv/developer-service.js
```

Confirm the `completeStep` auto-provision pattern at lines 122-135.

- [ ] **Step 2: Write failing tests in `test/unit/learning-preferences.test.js`**

Create the file:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('setLearningPreferences action handler', () => {
  beforeAll(async () => {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { like: '__test__-pr6-%' } });
    await DELETE.from(Users).where({ uuid: { like: '__test__-pr6-%' } });
  });

  afterAll(async () => {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { like: '__test__-pr6-%' } });
    await DELETE.from(Users).where({ uuid: { like: '__test__-pr6-%' } });
  });

  it('1. INSERTs a new row on first call; subsequent SELECT returns the typed shape', async () => {
    const userUuid = '__test__-pr6-act-1';
    // Simulate authenticated request via cds.test default user override; PR 5
    // hybrid tests use the same pattern.
    const result = await POST(
      '/api/setLearningPreferences',
      { deployment: 'cloud', role: null, cloud: 'btp' },
      { auth: { username: userUuid } }
    );
    expect(result.deployment).toBe('cloud');
    expect(result.role).toBeNull();
    expect(result.cloud).toBe('btp');
  });

  it('2. PUT-style clearing: re-call with {deployment: onprem, role: null, cloud: null} — clears prior role+cloud', async () => {
    const userUuid = '__test__-pr6-act-2';
    await POST('/api/setLearningPreferences',
      { deployment: 'cloud', role: 'developer', cloud: 'btp' },
      { auth: { username: userUuid } }
    );
    const result = await POST('/api/setLearningPreferences',
      { deployment: 'onprem', role: null, cloud: null },
      { auth: { username: userUuid } }
    );
    expect(result.deployment).toBe('onprem');
    expect(result.role).toBeNull();
    expect(result.cloud).toBeNull();
  });

  it('3. Invalid enum value returns 400 with field-level error message', async () => {
    const userUuid = '__test__-pr6-act-3';
    await expect(
      POST('/api/setLearningPreferences',
        { deployment: 'hybrid', role: null, cloud: null },
        { auth: { username: userUuid } }
      )
    ).rejects.toMatchObject({ response: { status: 400 } });
  });

  it('4. Anonymous caller is rejected by the XSUAA gate (401)', async () => {
    await expect(
      POST('/api/setLearningPreferences',
        { deployment: 'cloud', role: null, cloud: null }
        // no auth
      )
    ).rejects.toMatchObject({ response: { status: 401 } });
  });

  it('5. GET /api/LearningPreferences returns the caller own row only (before-READ filter)', async () => {
    const userUuid = '__test__-pr6-act-5';
    await POST('/api/setLearningPreferences',
      { deployment: 'cloud', role: 'architect', cloud: 'aws' },
      { auth: { username: userUuid } }
    );
    const list = await GET('/api/LearningPreferences', { auth: { username: userUuid } });
    expect(list.value).toHaveLength(1);
    expect(list.value[0]).toMatchObject({
      deployment: 'cloud', role: 'architect', cloud: 'aws',
    });
  });

  it('6. role = sysadmin is a valid enum value (regression guard against admin XSUAA collision)', async () => {
    const userUuid = '__test__-pr6-act-6';
    const result = await POST('/api/setLearningPreferences',
      { deployment: null, role: 'sysadmin', cloud: null },
      { auth: { username: userUuid } }
    );
    expect(result.role).toBe('sysadmin');
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/unit/learning-preferences.test.js 2>&1 | tail -10
```

Expected: 6 failures — `setLearningPreferences` action not yet registered.

- [ ] **Step 4: Implement the handler in `srv/developer-service.js`**

Add the import near the top of the file (alongside other srv imports):

```js
import { PROFILE_FIELDS, PROFILE_VOCAB } from './lib/branch/profile-fields.js';
```

Inside the existing `class DeveloperService extends cds.ApplicationService { async init() { ... } }`, after the existing destructure of entities, add:

```js
    // PR 6 — Pilot enablement: extend cds.entities destructure
    const { UserLearningPreferences } = cds.entities('com.sap.developers.ims');

    // PR 6 — Self-service row filter: scope every authenticated READ on
    // LearningPreferences to the caller's own row only. The XSUAA gate
    // (`@requires: 'authenticated-user'` on the projection) already guarantees
    // an authenticated user — no defensive 401 needed here.
    // CB2 fix: use the CQN builder (req.query.where(...)) — it AND-conjoins
    // safely with any pre-existing where clause. Hand-built CQN-token splices
    // get AND-precedence wrong on existing where clauses and are a security
    // boundary; do NOT revert.
    this.before('READ', 'LearningPreferences', async (req) => {
      const dbUser = await SELECT.one.from(dbUsers).columns('ID').where({ uuid: req.user.id });
      if (!dbUser?.ID) {
        // No DB user record yet — return empty result set, not an error.
        req.query.where('1 = 0');
        return;
      }
      req.query.where({ user_ID: dbUser.ID });
    });

    // PR 6 — Self-service write surface. PUT-style: all three fields are
    // written every time; values omitted by the caller default to null and
    // explicitly clear the slot. SELECT-then-INSERT-or-UPDATE matches the
    // codebase-wide idiom (zero direct UPSERT statements anywhere under srv/).
    // Spec: §4.2, §7.2
    this.on('setLearningPreferences', async (req) => {
      // Destructure with explicit null defaults — caller MUST send all three;
      // anything missing is treated as "clear this slot".
      const { deployment = null, role = null, cloud = null } = req.data;

      // Validate each field: null OR a value from the vocab. JS validation
      // layer is the actual runtime gate — CAP's @assert.range fires only at
      // the OData protocol layer, not on programmatic CQL writes from action
      // handlers, so the explicit loop here IS the security boundary.
      for (const [field, value] of Object.entries({ deployment, role, cloud })) {
        if (value === null) continue;
        if (!PROFILE_VOCAB[field].includes(value)) {
          return req.error(400, `${field}: must be one of [${PROFILE_VOCAB[field].join(', ')}]`);
        }
      }

      // Auto-provision the Users row for first-time savers (mirrors completeStep
      // pattern at developer-service.js:122-135). A learner who lands on /me/
      // before completing any tutorial otherwise hits a hard 404 here.
      let dbUser = await SELECT.one.from(dbUsers).where({ uuid: req.user.id });
      if (!dbUser) {
        const newUser = {
          uuid: req.user.id,
          legacyId: await getNextLegacyId('Users', db),
          email: req.user.attr?.email || '',
          firstName: req.user.attr?.given_name || '',
          lastName: req.user.attr?.family_name || '',
        };
        await INSERT.into(dbUsers).entries(newUser);
        dbUser = await SELECT.one.from(dbUsers).where({ uuid: req.user.id });
      }

      // PUT-style write — SELECT-then-INSERT-or-UPDATE (codebase-wide idiom).
      const existing = await SELECT.one.from(UserLearningPreferences)
        .where({ user_ID: dbUser.ID });
      if (existing) {
        await UPDATE(UserLearningPreferences)
          .where({ user_ID: dbUser.ID })
          .set({ deployment, role, cloud });
      } else {
        await INSERT.into(UserLearningPreferences).entries({
          user_ID: dbUser.ID, deployment, role, cloud,
        });
      }
      return SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
    });
```

- [ ] **Step 5: Run tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/unit/learning-preferences.test.js 2>&1 | tail -10
```

Expected: 6 tests pass.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add srv/developer-service.js test/unit/learning-preferences.test.js
git commit -m "feat(172): setLearningPreferences action + before-READ row filter"
```

---

## Task 7: Vue island — `LearningPreferences.vue` + main.ts mount + Hugo template

**Files:**
- Create: `hugo-apps/src/me/LearningPreferences.vue`
- Create: `hugo-apps/src/me/__tests__/LearningPreferences.test.ts`
- Modify: `hugo-apps/src/me/main.ts`
- Modify: `hugo/layouts/me/list.html`

The user-facing "Learning preferences" panel on `/me/`. Three `<ui5-select>` dropdowns + an explicit `<ui5-button>` ("Save preferences", enabled only when dirty), plus an `Information` `<ui5-message-strip>` shown when `branchingEnabled === false` (read from `/api/ChatConfig`). On mount, fetches `GET /api/LearningPreferences` (extracts `data.value?.[0]`) AND `GET /api/ChatConfig` (reads `.branchingEnabled`). Sentinel value `__none__` represents the empty state in the Selects; the `onChange` handler maps `__none__` back to JS `null` before storing in the local `prefs` ref. State machine: `idle | saving | saved | error`. A11y: status `<ui5-message-strip>` wrapped in a `role="alert" aria-live="polite"` div; on save failure, focus moves to the first Select via its `ref`.

Imports for `main.ts` (per spec §7.6 — all 7 net-new for `me.js`): `Select`, `Option`, `MessageStrip`, `Button`, `Label`, `Title`, `Text`. Bundle estimate: ~20-30 kB gzip net add.

- [ ] **Step 1: Inspect existing /me/ entry point + Hugo template**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && cat hugo-apps/src/me/main.ts
cat hugo/layouts/me/list.html
```

Confirm: `main.ts` currently mounts `MyCompletions` only with one Timeline import; `list.html` has the `{{ if not site.Params.qa }}` guard around the existing mount.

- [ ] **Step 2: Inspect a precedent user-form Vue island for state-machine pattern**

```bash
ls hugo-apps/src/tutorial-feedback/ 2>&1
sed -n '1,80p' hugo-apps/src/tutorial-feedback/TutorialFeedbackForm.vue 2>&1 | head -80
```

The Vue island below mirrors this state-machine + ref-based focus pattern.

- [ ] **Step 3: Write failing Vue tests in `hugo-apps/src/me/__tests__/LearningPreferences.test.ts`**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import LearningPreferences from '../LearningPreferences.vue';

function mockFetch(routes: Record<string, () => Promise<any>>) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method || 'GET'} ${url}`;
    const handler = routes[key] ?? routes[url];
    if (!handler) throw new Error(`unmocked: ${key}`);
    const result = await handler();
    return {
      ok: result.ok ?? true,
      status: result.status ?? 200,
      json: async () => result.body,
    };
  });
}

describe('LearningPreferences.vue', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('1. mount fetches /api/LearningPreferences AND /api/ChatConfig; Save button disabled', async () => {
    const fetchMock = mockFetch({
      '/api/LearningPreferences': async () => ({ body: { value: [{ deployment: 'cloud', role: null, cloud: 'btp' }] } }),
      '/api/ChatConfig': async () => ({ body: { branchingEnabled: true, enabled: true, bannerText: '' } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect(fetchMock).toHaveBeenCalledWith('/api/LearningPreferences', expect.anything());
    expect(fetchMock).toHaveBeenCalledWith('/api/ChatConfig', expect.anything());
    const saveBtn = wrapper.find('ui5-button');
    expect(saveBtn.attributes('disabled')).toBeDefined();
  });

  it('2. change Select → Save enables → click Save → POST all three values; success-strip appears', async () => {
    const postBody: any[] = [];
    const fetchMock = mockFetch({
      '/api/LearningPreferences': async () => ({ body: { value: [] } }),
      '/api/ChatConfig': async () => ({ body: { branchingEnabled: true } }),
      'POST /api/setLearningPreferences': async () => {
        postBody.push((global as any).__lastPost);
        return { body: { deployment: 'cloud', role: null, cloud: null } };
      },
    });
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
      if (init?.method === 'POST') (global as any).__lastPost = JSON.parse(init.body as string);
      return await fetchMock(url, init);
    }));
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    // Simulate user picking deployment=cloud
    await (wrapper.vm as any).onChange('deployment', { detail: { selectedOption: { value: 'cloud' } } });
    await wrapper.vm.$nextTick();
    await (wrapper.vm as any).onSave();
    await new Promise(r => setTimeout(r, 0));
    expect((global as any).__lastPost).toEqual({ deployment: 'cloud', role: null, cloud: null });
    expect((wrapper.vm as any).status).toBe('saved');
  });

  it('3. server returns 500 → negative-strip appears; Selects keep user values; first Select gets focus', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return { ok: false, status: 500, json: async () => ({}) };
      if (url.endsWith('/LearningPreferences')) return { ok: true, json: async () => ({ value: [] }) };
      return { ok: true, json: async () => ({ branchingEnabled: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    await (wrapper.vm as any).onChange('deployment', { detail: { selectedOption: { value: 'onprem' } } });
    await (wrapper.vm as any).onSave();
    await new Promise(r => setTimeout(r, 0));
    expect((wrapper.vm as any).status).toBe('error');
    expect((wrapper.vm as any).prefs.deployment).toBe('onprem');  // not reverted
  });

  it('4. branchingEnabled = false → Information strip rendered; branchingEnabled = true → strip NOT rendered', async () => {
    // Off
    let fetchMock = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.endsWith('LearningPreferences')
        ? { value: [] } : { branchingEnabled: false },
    }));
    vi.stubGlobal('fetch', fetchMock);
    let wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).branchingDisabled).toBe(true);

    // On
    fetchMock = vi.fn(async (url: string) => ({
      ok: true, json: async () => url.endsWith('LearningPreferences')
        ? { value: [] } : { branchingEnabled: true },
    }));
    vi.stubGlobal('fetch', fetchMock);
    wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).branchingDisabled).toBe(false);
  });

  it('5. __none__ → null round-trip: pick "— No preference —" → Save → POST body has deployment: null', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        (global as any).__post = JSON.parse(init.body as string);
        return { ok: true, json: async () => ({}) };
      }
      if (url.endsWith('LearningPreferences')) {
        return { ok: true, json: async () => ({ value: [{ deployment: 'cloud', role: 'developer', cloud: 'btp' }] }) };
      }
      return { ok: true, json: async () => ({ branchingEnabled: true }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    const wrapper = mount(LearningPreferences);
    await new Promise(r => setTimeout(r, 0));
    await wrapper.vm.$nextTick();
    expect((wrapper.vm as any).prefs.deployment).toBe('cloud');
    await (wrapper.vm as any).onChange('deployment', { detail: { selectedOption: { value: '__none__' } } });
    await (wrapper.vm as any).onSave();
    await new Promise(r => setTimeout(r, 0));
    expect((global as any).__post).toEqual({ deployment: null, role: 'developer', cloud: 'btp' });
  });
});
```

- [ ] **Step 4: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit hugo-apps/src/me/__tests__/LearningPreferences.test.ts 2>&1 | tail -10
```

Expected: 5 failures — module not found.

- [ ] **Step 5: Implement `LearningPreferences.vue`**

Create `hugo-apps/src/me/LearningPreferences.vue`:

```vue
<template>
  <div class="learning-preferences sapUiSmallMargin">
    <ui5-title level="H3">Learning preferences</ui5-title>
    <ui5-text>Help us personalize tutorial branching. All fields optional.</ui5-text>

    <ui5-message-strip
      v-if="branchingDisabled"
      design="Information"
      hide-close-button
    >
      Branching is currently disabled platform-wide. Your preferences will be saved
      and will activate when branching is turned on.
    </ui5-message-strip>

    <ui5-label for="deployment">Where do you typically deploy?</ui5-label>
    <ui5-select
      id="deployment"
      ref="deploymentRef"
      @change="(e) => onChange('deployment', e)"
    >
      <ui5-option value="__none__" :selected="prefs.deployment === null">— No preference —</ui5-option>
      <ui5-option value="cloud" :selected="prefs.deployment === 'cloud'">Cloud</ui5-option>
      <ui5-option value="onprem" :selected="prefs.deployment === 'onprem'">On-premise</ui5-option>
    </ui5-select>

    <ui5-label for="role">What's your role?</ui5-label>
    <ui5-select id="role" ref="roleRef" @change="(e) => onChange('role', e)">
      <ui5-option value="__none__" :selected="prefs.role === null">— No preference —</ui5-option>
      <ui5-option value="developer" :selected="prefs.role === 'developer'">Developer</ui5-option>
      <ui5-option value="architect" :selected="prefs.role === 'architect'">Architect</ui5-option>
      <ui5-option value="sysadmin" :selected="prefs.role === 'sysadmin'">System administrator</ui5-option>
      <ui5-option value="student" :selected="prefs.role === 'student'">Student</ui5-option>
    </ui5-select>

    <ui5-label for="cloud">Preferred cloud provider?</ui5-label>
    <ui5-select id="cloud" ref="cloudRef" @change="(e) => onChange('cloud', e)">
      <ui5-option value="__none__" :selected="prefs.cloud === null">— No preference —</ui5-option>
      <ui5-option value="btp" :selected="prefs.cloud === 'btp'">SAP BTP</ui5-option>
      <ui5-option value="aws" :selected="prefs.cloud === 'aws'">AWS</ui5-option>
      <ui5-option value="gcp" :selected="prefs.cloud === 'gcp'">Google Cloud</ui5-option>
    </ui5-select>

    <ui5-button design="Emphasized" :disabled="!dirty || saving" @click="onSave">
      {{ saving ? 'Saving…' : 'Save preferences' }}
    </ui5-button>

    <!-- A11y (I15): wrap status strip in role=alert live region -->
    <div role="alert" aria-live="polite">
      <ui5-message-strip v-if="status === 'saved'" design="Positive">Saved.</ui5-message-strip>
      <ui5-message-strip v-if="status === 'error'" design="Negative">
        Couldn't save preferences. Try again.
      </ui5-message-strip>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, computed, onMounted } from 'vue';

type ProfileField = 'deployment' | 'role' | 'cloud';
type ProfileValue = string | null;

const prefs = reactive<{ deployment: ProfileValue; role: ProfileValue; cloud: ProfileValue }>({
  deployment: null, role: null, cloud: null,
});
const dirty = ref(false);
const status = ref<'idle' | 'saving' | 'saved' | 'error'>('idle');
const branchingDisabled = ref(false);
const saving = computed(() => status.value === 'saving');

const deploymentRef = ref<HTMLElement | null>(null);
const roleRef = ref<HTMLElement | null>(null);
const cloudRef = ref<HTMLElement | null>(null);

let savedTimer: number | undefined;

onMounted(async () => {
  // Fetch existing prefs (collection — extract first row)
  try {
    const resp = await fetch('/api/LearningPreferences', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (resp.ok) {
      const data = await resp.json();
      const row = data.value?.[0];
      if (row) {
        prefs.deployment = row.deployment ?? null;
        prefs.role = row.role ?? null;
        prefs.cloud = row.cloud ?? null;
      }
    }
  } catch {
    // silent — empty form is the safe default
  }

  // Fetch master flag (singleton)
  try {
    const resp = await fetch('/api/ChatConfig', {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (resp.ok) {
      const data = await resp.json();
      branchingDisabled.value = data?.branchingEnabled === false;
    }
  } catch {
    // silent — show form without the disabled-info strip
  }
});

function onChange(field: ProfileField, ev: any) {
  const raw = ev?.detail?.selectedOption?.value ?? '__none__';
  prefs[field] = raw === '__none__' ? null : raw;
  dirty.value = true;
}

async function onSave() {
  if (!dirty.value || status.value === 'saving') return;
  status.value = 'saving';
  if (savedTimer) clearTimeout(savedTimer);
  try {
    const resp = await fetch('/api/setLearningPreferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        deployment: prefs.deployment,
        role: prefs.role,
        cloud: prefs.cloud,
      }),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    status.value = 'saved';
    dirty.value = false;
    savedTimer = window.setTimeout(() => { if (status.value === 'saved') status.value = 'idle'; }, 3000);
  } catch {
    status.value = 'error';
    // A11y: focus the first Select for the user to retry
    const focusable = (deploymentRef.value as any) || (roleRef.value as any) || (cloudRef.value as any);
    focusable?.focus?.();
  }
}

defineExpose({ prefs, dirty, status, branchingDisabled, onChange, onSave });
</script>
```

- [ ] **Step 6: Update `hugo-apps/src/me/main.ts` — mount + 7 UI5 imports**

Replace the existing content with:

```ts
import { createApp } from 'vue'
import MyCompletions from './MyCompletions.vue'
import LearningPreferences from './LearningPreferences.vue'

// U17: Recent Activity timeline on the profile page (existing).
import "@ui5/webcomponents-fiori/dist/Timeline.js";
import "@ui5/webcomponents-fiori/dist/TimelineItem.js";

// PR 6 — UI5 imports for LearningPreferences island. Per recon: all 7 are
// net-new for me.js. Bundle estimate ~20-30 kB gzip net add.
import "@ui5/webcomponents/dist/Select.js";
import "@ui5/webcomponents/dist/Option.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/Label.js";
import "@ui5/webcomponents/dist/Title.js";
import "@ui5/webcomponents/dist/Text.js";

const myCompletionsEl = document.getElementById('me-completions')
if (myCompletionsEl) createApp(MyCompletions).mount(myCompletionsEl)

const learningPrefsEl = document.getElementById('me-learning-preferences')
if (learningPrefsEl) createApp(LearningPreferences).mount(learningPrefsEl)
```

- [ ] **Step 7: Update `hugo/layouts/me/list.html` — append mount-point div inside QA-gate**

Replace the existing content with:

```html
{{ define "main" }}
{{/* U17 profile timeline + recent activity. QA preview strips this — read-only
     preview has no per-user progress data. Also excluded by hugo.qa.toml ignoreFiles. */}}
{{ if not site.Params.qa }}
<div id="me-completions"></div>
<div id="me-learning-preferences"></div>
<script type="module" src="/js/me.js?v={{ now.Unix }}"></script>
{{ end }}
{{ end }}
```

- [ ] **Step 8: Run all tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit hugo-apps/src/me/__tests__/LearningPreferences.test.ts 2>&1 | tail -10
```

Expected: 5 tests pass.

- [ ] **Step 9: Smoke-build the apps bundle**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 90 npm run build:apps 2>&1 | tail -10
```

Expected: build succeeds. New `me.js` chunk in `hugo/static/js/`.

- [ ] **Step 10: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add hugo-apps/src/me/LearningPreferences.vue hugo-apps/src/me/main.ts hugo-apps/src/me/__tests__/LearningPreferences.test.ts hugo/layouts/me/list.html
git commit -m "feat(172): /me/ Learning preferences Vue island + Hugo mount + UI5 imports"
```

---

## Task 8: Admin Fiori Elements list view — `app/admin-annotations.cds`

**Files:**
- Modify: `app/admin-annotations.cds`

Read-only Fiori Elements list view for support. Search by user.email + user.displayName. LineItem shows email + displayName + the three preference fields + modifiedAt. No edit form (entity is `@readonly` per round-2 CB5).

- [ ] **Step 1: Inspect existing template — Events block at lines 41-65**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && sed -n '40,70p' app/admin-annotations.cds
```

Confirm the structure.

- [ ] **Step 2: Append annotations**

Append to `app/admin-annotations.cds`:

```cds

// PR 6 — Pilot enablement: read-only Fiori Elements list view for support.
// Edit-on-behalf is out of scope for v1 (the entity is @readonly on AdminService).
// Spec: §7.7
annotate AdminService.LearningPreferences with @cds.search: { user.email, user.displayName };

annotate AdminService.LearningPreferences with @UI: {
  HeaderInfo: {
    TypeName: 'Learning preference', TypeNamePlural: 'Learning preferences',
    Title: { Value: user.email },
    Description: { Value: user.displayName }
  },
  SelectionFields: [ deployment, role, cloud ],
  LineItem: [
    { Value: user.email },
    { Value: user.displayName },
    { Value: deployment },
    { Value: role },
    { Value: cloud },
    { Value: modifiedAt }
  ],
  Facets: [
    { $Type: 'UI.ReferenceFacet', Target: '@UI.FieldGroup#General', Label: 'Preferences' }
  ],
  FieldGroup#General: { Data: [
    { Value: user.email }, { Value: deployment }, { Value: role }, { Value: cloud }
  ]}
};
```

- [ ] **Step 3: Compile-check**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 npx cds compile srv/admin-service.cds app/admin-annotations.cds --to edmx -s AdminService 2>&1 | grep -E 'EntityType Name="LearningPreferences"|Annotations Target=.AdminService.LearningPreferences' | head -5
```

Expected: hits showing the entity type + annotation block. No errors.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add app/admin-annotations.cds
git commit -m "feat(172): admin Fiori Elements list view for LearningPreferences (read-only)"
```

---

## Task 9: Schema/vocab sync test + cascade-walker test

**Files:**
- Create: `scripts/__tests__/profile-fields-sync.test.ts`
- Create: `scripts/__tests__/anonymization-cascade-pr6.test.ts`

Two tiny unit tests that close the spec's drift-prevention loop:

1. **`profile-fields-sync.test.ts`** — parses `db/schema.cds` via `cds.compile.to.csn(...)` and asserts the enum strings on `UserLearningPreferences.deployment/role/cloud` match `PROFILE_VOCAB` exactly. Catches drift if a future PR changes the schema enum but forgets the constants module (or vice versa).

2. **`anonymization-cascade-pr6.test.ts`** — imports the cascade walker from `srv/lib/anonymization-cascade.js`, loads the model via `cds.load`, asserts `UserLearningPreferences` appears in the cascade plan with `cascade: 'delete'`. Guards the §4.1 `@PersonalData` annotation against drift; runs in default CI without `ALLOW_HYBRID_WRITES` (pure model walk, no DB writes).

Both files use `.test.ts` extension per round-3 DI2 (vitest config only includes `.ts` for the `scripts/` glob).

- [ ] **Step 1: Inspect cascade-walker shape**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && grep -nE "export function|getCascadePlan" srv/lib/anonymization-cascade.js | head -5
```

Confirm `getCascadePlan(modelDefinitions)` is the entry point.

- [ ] **Step 2: Write the failing tests**

Create `scripts/__tests__/profile-fields-sync.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { PROFILE_VOCAB } from '../../srv/lib/branch/profile-fields.js';

describe('profile-fields-sync (drift guard)', () => {
  it('schema enum strings match PROFILE_VOCAB constants module exactly', async () => {
    const csn = await cds.load('db/schema.cds');
    const def = csn.definitions['com.sap.developers.ims.UserLearningPreferences'];
    expect(def, 'UserLearningPreferences entity must exist in CSN').toBeDefined();

    for (const field of ['deployment', 'role', 'cloud'] as const) {
      const elementEnum = def.elements?.[field]?.enum;
      expect(elementEnum, `${field} must have enum on element`).toBeDefined();
      const schemaValues = Object.keys(elementEnum).sort();
      const vocabValues = [...PROFILE_VOCAB[field]].sort();
      expect(schemaValues).toEqual(vocabValues);
    }
  });
});
```

Create `scripts/__tests__/anonymization-cascade-pr6.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { getCascadePlan } from '../../srv/lib/anonymization-cascade.js';

describe('anonymization-cascade pickup of UserLearningPreferences (PR 6)', () => {
  it('UserLearningPreferences appears in the cascade plan with cascade: delete', async () => {
    const csn = await cds.load('db/schema.cds');
    const plan = getCascadePlan(csn.definitions);
    const entry = plan.find((p: any) => p.name === 'com.sap.developers.ims.UserLearningPreferences');
    expect(entry, 'UserLearningPreferences must appear in cascade plan').toBeDefined();
    expect(entry?.action).toBe('delete');
  });
});
```

- [ ] **Step 3: Run failing tests**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit scripts/__tests__/profile-fields-sync.test.ts scripts/__tests__/anonymization-cascade-pr6.test.ts 2>&1 | tail -10
```

Expected: tests run; if Tasks 1+2+5 are merged in this branch, both should already PASS. (TDD discipline: write tests AFTER the producer was ready in earlier tasks; the tests must be in this branch as guards.)

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add scripts/__tests__/profile-fields-sync.test.ts scripts/__tests__/anonymization-cascade-pr6.test.ts
git commit -m "test(172): profile-fields-sync + anonymization-cascade-pr6 drift guards"
```

---

## Task 10: Hybrid HANA tests — `test/hybrid/learning-preferences.test.js`

**Files:**
- Create: `test/hybrid/learning-preferences.test.js`

Three real-HANA tests gated by `ALLOW_HYBRID_WRITES=true` + `isSafeForWrites()` (mirrors PR 5 pattern):

1. **JS-validation enum gate**: invalid `deployment: 'hybrid'` returns 400 from the action handler — verifies the action's `for ... if (!PROFILE_VOCAB[field].includes(value)) ...` loop fires on programmatic CQL writes (CAP's `@assert.range` is OData-protocol-only and does NOT fire here).
2. **Schema + SELECT-then-INSERT-or-UPDATE**: HANA table has single-column PK on `USER_ID`, FK to `USERS.ID`, second naïve INSERT fails with PK-violation, calling `setLearningPreferences` twice with the same payload yields the same row UPDATEd (idempotent).
3. **`@PersonalData cascade: 'delete'`**: deleting the parent Users row removes the child UserLearningPreferences row.

- [ ] **Step 1: Inspect existing hybrid test pattern (PR 5 precedent)**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && cat test/hybrid/_guard.js
ls test/hybrid/*.test.js | head -5
```

Confirm guard pattern + existing hybrid test shape.

- [ ] **Step 2: Write the hybrid tests**

Create `test/hybrid/learning-preferences.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

cds.test('serve', '--project', '.', '--profile', 'hybrid');

const PREFIX = '__test__-pr6-hybrid';
const writesEnabled = process.env.ALLOW_HYBRID_WRITES === 'true';

describe('UserLearningPreferences (hybrid HANA)', () => {
  beforeAll(async () => {
    if (!writesEnabled) return;
    if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { in: SELECT.from(Users).columns('ID').where({ uuid: { like: `${PREFIX}-%` } }) } });
    await DELETE.from(Users).where({ uuid: { like: `${PREFIX}-%` } });
  });

  afterAll(async () => {
    if (!writesEnabled) return;
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    await DELETE.from(UserLearningPreferences).where({ user_ID: { in: SELECT.from(Users).columns('ID').where({ uuid: { like: `${PREFIX}-%` } }) } });
    await DELETE.from(Users).where({ uuid: { like: `${PREFIX}-%` } });
  });

  it.skipIf(!writesEnabled)(
    '1. invalid enum value rejected at the JS validation layer in the action handler',
    async () => {
      // Hybrid hits the action endpoint with invalid enum and asserts a 400.
      const userUuid = `${PREFIX}-enum`;
      await expect(
        POST('/api/setLearningPreferences',
          { deployment: 'hybrid', role: null, cloud: null },
          { auth: { username: userUuid } }
        )
      ).rejects.toMatchObject({ response: { status: 400 } });
    }
  );

  it.skipIf(!writesEnabled)(
    '2. Schema + SELECT-then-INSERT-or-UPDATE shape: PK is single-column on USER_ID; FK to USERS.ID; idempotent same-payload writes',
    async () => {
      const userUuid = `${PREFIX}-schema`;
      // First call INSERTs.
      await POST('/api/setLearningPreferences',
        { deployment: 'cloud', role: 'developer', cloud: 'btp' },
        { auth: { username: userUuid } }
      );
      // Same payload twice — idempotent: existing row UPDATEd, no duplicate INSERT.
      await POST('/api/setLearningPreferences',
        { deployment: 'cloud', role: 'developer', cloud: 'btp' },
        { auth: { username: userUuid } }
      );
      const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
      const dbUser = await SELECT.one.from(Users).where({ uuid: userUuid });
      const rows = await SELECT.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ deployment: 'cloud', role: 'developer', cloud: 'btp' });
    }
  );

  it.skipIf(!writesEnabled)(
    '3. @PersonalData cascade: delete removes the row when the parent Users row is deleted',
    async () => {
      const userUuid = `${PREFIX}-cascade`;
      await POST('/api/setLearningPreferences',
        { deployment: 'cloud', role: null, cloud: null },
        { auth: { username: userUuid } }
      );
      const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
      const dbUser = await SELECT.one.from(Users).where({ uuid: userUuid });
      // Trigger anonymization cascade: simulate by deleting the parent row.
      await DELETE.from(Users).where({ ID: dbUser.ID });
      const rows = await SELECT.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
      expect(rows).toHaveLength(0);
    }
  );
});
```

- [ ] **Step 3: Run hybrid test (requires `cf login` to DEV space)**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 240 ALLOW_HYBRID_WRITES=true npm run test:hybrid -- learning-preferences.test.js 2>&1 | tail -30
```

Expected: 3 tests pass against real HANA. If `ALLOW_HYBRID_WRITES` not set, tests skip silently.

If `cf login` not available in the implementer's session, surface the skip explicitly:

```bash
[ "${ALLOW_HYBRID_WRITES}" = "true" ] || echo "SKIP: hybrid learning-preferences test (set ALLOW_HYBRID_WRITES=true and cf login to DEV space, then re-run)"
```

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add test/hybrid/learning-preferences.test.js
git commit -m "test(172): hybrid HANA tests for UserLearningPreferences"
```

---

## Task 11: Smoke tests — `test/smoke/learning-preferences.smoke.test.js`

**Files:**
- Create: `test/smoke/learning-preferences.smoke.test.js`

Two smoke tests against the deployed srv URL — both unauthenticated (CI-safe; no GH secret needed per round-2 B10):

1. `GET /api/LearningPreferences` without auth returns 401 (gate works).
2. `GET /api/ChatConfig` returns 200 and the response includes `branchingEnabled` field at the top level alongside `enabled` + `bannerText` (confirms the public projection extension from Task 3 is reachable; assertion is shape-tolerant of OData singleton wrappers).

The authenticated override path is NOT in CI smoke — exercised manually via the runbook (round-2 B10).

- [ ] **Step 1: Inspect existing smoke pattern**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && ls test/smoke/ && head -30 test/smoke/*.smoke.test.js 2>/dev/null | head -50
```

- [ ] **Step 2: Write smoke tests**

Create `test/smoke/learning-preferences.smoke.test.js`:

```js
import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;

describe.skipIf(!SRV)('LearningPreferences smoke (deployed)', () => {
  it('1. GET /api/LearningPreferences without auth returns 401', async () => {
    const resp = await fetch(`${SRV}/api/LearningPreferences`, {
      headers: { Accept: 'application/json' },
    });
    expect(resp.status).toBe(401);
  });

  it('2. GET /api/ChatConfig returns 200 and includes branchingEnabled at top level', async () => {
    const resp = await fetch(`${SRV}/api/ChatConfig`, {
      headers: { Accept: 'application/json' },
    });
    expect(resp.status).toBe(200);
    const body = await resp.json();
    // OData singleton wrapper varies — find branchingEnabled wherever it sits.
    const flat = JSON.stringify(body);
    expect(flat).toMatch(/"branchingEnabled"\s*:/);
    expect(flat).toMatch(/"enabled"\s*:/);
    expect(flat).toMatch(/"bannerText"\s*:/);
  });
});
```

- [ ] **Step 3: Verify the test compiles + skips when `SMOKE_SRV_URL` unset**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 30 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project smoke test/smoke/learning-preferences.smoke.test.js 2>&1 | tail -10
```

Expected: tests skip (with `SMOKE_SRV_URL` unset) or pass against deployed.

- [ ] **Step 4: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add test/smoke/learning-preferences.smoke.test.js
git commit -m "test(172): smoke tests for /api/LearningPreferences + ChatConfig branchingEnabled"
```

---

## Task 12: Author docs — runbook + cookbook extension + sidebar entry

**Files:**
- Create: `docs/authors/pilot-runbook.md`
- Modify: `docs/authors/branching-cookbook.md`
- Modify: `docs/.vitepress/config.ts`

The pilot runbook is a four-phase rollout checklist for curators. The cookbook extension adds a `## Testing your conditions with the debug override` section under the `#debug-override` deeplink anchor, with the format, examples, the `?nocache=1` escape hatch, and a back-link to runbook Phase 2. Sidebar adds the new runbook page under the existing "Branching paths" group as the fifth entry after "Reading branch telemetry".

- [ ] **Step 1: Inspect existing sidebar group + cookbook tail**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && sed -n '85,100p' docs/.vitepress/config.ts
```

Confirm the "Branching paths" group at lines ~92-97 with 4 entries (branched-missions, branched-tutorials, branching-cookbook, reading-branch-telemetry).

```bash
tail -20 docs/authors/branching-cookbook.md
```

Confirm where to append the new section.

- [ ] **Step 2: Write the runbook**

Create `docs/authors/pilot-runbook.md`:

```markdown
# Pilot enablement runbook

> **Audience:** mission curators piloting branching for the first time.
> **Status:** PR 6 (issue #172). Companion to [branched missions](./branched-missions.md), [branched tutorials](./branched-tutorials.md), the [branching cookbook](./branching-cookbook.md), and [reading branch telemetry](./reading-branch-telemetry.md).

PR 6 ships the user-facing learning-preferences panel + the author/admin debug override. This runbook walks a curator through choosing a pilot mission and rolling out branching. Four phases:

## Phase 1: Pre-pilot

**Mission selection criteria:**

- Mission has at least one tutorial with a natural author-condition fork (e.g. "cloud vs on-prem deployment", "developer vs architect role").
- Mission is in active rotation (≥10 completions/week so telemetry accumulates fast).
- The pilot author owns the mission (or has commit rights) and can iterate on conditions during the pilot.
- Profile fields the pilot will use match the v1 vocabulary: `deployment ∈ {cloud, onprem}`, `role ∈ {developer, architect, sysadmin, student}`, `cloud ∈ {btp, aws, gcp}`.

**Author readiness:**

- The author can write `[BRANCH_BEGIN ... condition="..."]` directives (see [branched-tutorials.md](./branched-tutorials.md)).
- The author has access to the QA channel and can run `npm run fetch-tutorials:qa` locally.
- The author has set their own learning preferences at `/me/` so they have a non-null profile to test against.

## Phase 2: QA pilot

Author writes branches in their fork, pushes to a `*-Contribution` repo, and tests via the QA channel.

**Debug override** (see [Testing your conditions with the debug override](./branching-cookbook.md#debug-override) for the full syntax):

```text
https://tutorial-system-qa.cfapps.eu10-005.hana.ondemand.com/tutorials-qa/<slug>/?profile.deployment=cloud
```

Author exercises all four debug paths:

- `?profile.deployment=cloud` → confirms cloud branch is rendered
- `?profile.deployment=onprem` → confirms on-prem branch is rendered
- No override (anonymous viewing) → confirms the deterministic default branch
- No override + `localStorage` of a completed prerequisite slug → confirms the ranker-driven branch

Joule narration: confirmed to ignore overrides; chat from the unmodified URL (the chat-orchestrator runs through CAP `req`, not the express request — the override never reaches it). See [cookbook §debug-override](./branching-cookbook.md#debug-override) for the full out-of-scope explanation.

**Stale-after-write workaround:** if the author has just edited their own preferences and wants to bypass the 5-minute TTL on the engine's per-callsite caches, combine the override with `?nocache=1` (e.g. `?profile.deployment=cloud&nocache=1`) — `decideHandler` and `missionDetailHandler` short-circuit the per-callsite cache when this flag is present.

## Phase 3: Production rollout

Curator + an admin work together to flip the master flag:

1. Admin sets `ChatSettings.branchingEnabled = true` via `/admin-ui/#chatsettings-display` (DEV first, then PROD).
2. Curator monitors `/admin/analytics/AnalyticsBranchPerformance` (the [Branch Performance section in the Missions ObjectPage](./reading-branch-telemetry.md) — PR 5 surface) for the pilot mission's branch points.
3. Curator watches for `branch-staleness` lint notices in the next `tutorial-markdown` lint run (PR 5 also added this lint rule).

**Rollback:** flip `ChatSettings.branchingEnabled = false`. The engine reverts to default-order behaviour without redeploying.

## Phase 4: Iterate / rollback

- **High click-through rate but low follow-rate:** the recommendation matches reader intent. Tune wording on branch labels.
- **Low click-through rate (<5%):** readers don't see the value of the choice. Consider collapsing the branch back to a single path or rephrasing the prompt.
- **One option picked >95% of the time after 50+ decisions:** the branch is converged — `branch-staleness` lint will emit a notice. Collapse to single path, OR rephrase the prompt to make the underused option more attractive.
- **Pilot fails (low engagement, confusing UX, conflicting feedback):** rollback (Phase 3 step 1 rollback) and revisit the bifurcation criteria from Phase 1.
```

- [ ] **Step 3: Append the cookbook section**

Append to `docs/authors/branching-cookbook.md`:

```markdown

## Testing your conditions with the debug override {#debug-override}

> **Audience:** authors with `Tutorial.Author` or `Admin` scope.

When you write a `[BRANCH_BEGIN ... condition="profile.deployment == 'cloud'"]` directive, you need a way to test both arms of the branch without changing your own learning preferences in `/me/`. The `?profile.<field>=<value>` query parameter does exactly that.

**Format:** add `?profile.<field>=<value>` to any tutorial URL. Multiple fields are AND-ed:

```text
https://.../tutorials-qa/<slug>/?profile.deployment=cloud
https://.../tutorials-qa/<slug>/?profile.deployment=onprem&profile.role=architect
```

**Allowed values** (see [pilot-runbook.md#phase-1-pre-pilot](./pilot-runbook.md#phase-1-pre-pilot) for the v1 vocabulary):

- `profile.deployment`: `cloud`, `onprem`
- `profile.role`: `developer`, `architect`, `sysadmin`, `student`
- `profile.cloud`: `btp`, `aws`, `gcp`

**Cache fingerprint:** the override is mixed into the per-callsite cache key, so override-mode traffic gets a separate cache slot from learner-mode traffic. You won't poison cache for real learners.

**Invalid values are silently dropped.** `?profile.deployment=hybrid` is treated as if no override were sent for `deployment`.

**Empty strings are treated as missing.** `?profile.deployment=` is the same as omitting the field.

**Without `Tutorial.Author` or `Admin` scope:** the override is silently ignored (parser returns null). The widened gate (`Tutorial.Author OR Admin`) lets admins test the override on their existing role-collection without needing a separate Tutorial.Author grant.

**Joule narration ignores overrides.** The chat-orchestrator runs through a CAP `req`, not the express request, so `?profile.*` doesn't reach the narration tool. To test branch narration, clear the override from the URL and chat from the unmodified URL. (Plumbing the override through chat is a v2 candidate.)

**Stale-after-write workaround:** if you just edited your own preferences in `/me/` and want to bypass the 5-minute TTL on the per-callsite cache, combine with `?nocache=1`:

```text
https://.../tutorials-qa/<slug>/?profile.deployment=cloud&nocache=1
```

For the canonical pilot-time debug walkthrough, see [Phase 2: QA pilot](./pilot-runbook.md#phase-2-qa-pilot) in the pilot runbook.
```

- [ ] **Step 4: Add sidebar entry**

In `docs/.vitepress/config.ts`, find the "Branching paths" group (around lines 92-97) and add a fifth entry:

```ts
{ text: 'Branching paths', items: [
  { text: 'Branched missions',  link: '/authors/branched-missions' },
  { text: 'Branched tutorials', link: '/authors/branched-tutorials' },
  { text: 'Branching cookbook', link: '/authors/branching-cookbook' },
  { text: 'Reading branch telemetry', link: '/authors/reading-branch-telemetry' },
  { text: 'Pilot runbook',     link: '/authors/pilot-runbook' }
]}
```

- [ ] **Step 5: Build the docs site**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 90 npm run docs:build 2>&1 | tail -15
```

Expected: build succeeds. The pre-build sidebar guard accepts the new runbook entry.

- [ ] **Step 6: Commit**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git add docs/authors/pilot-runbook.md docs/authors/branching-cookbook.md docs/.vitepress/config.ts
git commit -m "docs(172): pilot runbook + cookbook debug-override section + sidebar"
```

---

## Task 13: Final-branch sanity, smoke, push, PR

**Files:**
- None (verification + push + PR creation)

This task wraps the work and surfaces it for review. Mirrors PR 3/4/5 final-branch tasks. **Do not push to `main` directly** ([[feedback_pr_over_direct_merge]]).

- [ ] **Step 1: Confirm branch + worktree + clean tree + commit count**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current && pwd && git status -sb && git log --oneline main..HEAD
```

Expected: `feat/172-pr6-pilot-enablement` branch on `.../feat-172-pr6` worktree, clean tree, commit count of ~13 (one per task that wrote code, plus the spec/plan).

- [ ] **Step 2: Run the unit suite end-to-end**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 300 npm test 2>&1 | tail -30
```

Expected: all PR 6 unit tests pass (29 cases) + existing PR 1-5 tests pass unchanged. If the unit suite hangs ([[feedback_worktree_tests_hang]]), fall back to running only the PR 6 files via the absolute vitest path:

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 90 D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit test/unit/learning-preferences.test.js srv/lib/branch/__tests__/profile-override.test.js srv/lib/branch/__tests__/loaders.test.js srv/lib/branch/__tests__/user-state.test.js scripts/__tests__/profile-fields-sync.test.ts scripts/__tests__/anonymization-cascade-pr6.test.ts hugo-apps/src/me/__tests__/LearningPreferences.test.ts 2>&1 | tail -15
```

- [ ] **Step 3: Compile-check both services + Vue island build**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && timeout 60 npx cds compile srv/developer-service.cds srv/admin-service.cds --to sql 2>&1 | tail -10 && timeout 90 npm run build:apps 2>&1 | tail -5 && timeout 90 npm run docs:build 2>&1 | tail -5
```

Expected: clean SQL emission for both services, clean apps bundle, docs build passes.

- [ ] **Step 4: Re-walk srv-qa transitive deps**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && grep -nE "scripts/lib/merge-branch-perf|lint-rules/branch-staleness|profile-fields|profile-override" .deploy/mta.yaml 2>/dev/null
```

PR 6 only adds frontend (Vue) + lint-script files + new srv lib files (`profile-fields.js`, `profile-override.js`). The srv-side new files are imported by `srv/developer-service.js` (which IS in srv-qa cp list), so they need to be added.

```bash
grep -nE "srv/lib/branch/profile-fields\|srv/lib/branch/profile-override" .deploy/mta.yaml | head -3
```

Expected: zero matches (current state). **Add the two new files to the srv-qa cp list in `.deploy/mta.yaml`** if PR 6 srv-qa parity is required:

```yaml
# .deploy/mta.yaml — under the srv-qa module's "cp" list, alongside other srv/lib/branch entries
- src: ../srv/lib/branch/profile-fields.js
- src: ../srv/lib/branch/profile-override.js
```

(Per [[feedback_srv_qa_cp_list]] / [[feedback_check_srv_qa_when_changing_srv]]: walk transitive `./` imports from `srv/developer-service.js` whenever new srv lib files are added.)

- [ ] **Step 5: Final-branch reviewer subagent**

Dispatch a `feature-dev:code-reviewer` subagent over the entire branch diff:

```text
Branch: feat/172-pr6-pilot-enablement
Spec: docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md
Plan: docs/superpowers/plans/2026-06-13-172-pr6-pilot-enablement.md

Focus areas:
1. CDS shape vs spec §4.1 (entity has @assert.range BEFORE enum; @PersonalData annotation matches UserMetaData pattern)
2. Override gate: req.user.is('Tutorial.Author') OR req.user.is('Admin') — both author and admin can use the override
3. SELECT-then-INSERT-or-UPDATE write idiom (NO UPSERT; matches completeStep precedent at developer-service.js:122-135)
4. before-READ hook uses CQN builder (req.query.where({user_ID: dbUser.ID})), NOT hand-built CQN tokens (CB2 security boundary)
5. Auto-provision Users row mirrors completeStep verbatim (CB4)
6. AdminService projection is @readonly (CB5)
7. profile-fields.js is single source of truth; user-state.js imports from it (no inline PROFILE_FIELDS const)
8. extractProfileOverride consumes EXPRESS req only; CAP action handlers do not support overrides
9. Vue island uses explicit Save button (no debounced auto-save); __none__ ↔ null sentinel mapping; a11y role=alert live region
10. Cache strategy is TTL-only (no bustForUser hook); spec §5.2 documents stale-after-write window
11. PR 1's reviewer-mandated TODO comment stripped from loaders.js
12. ChatConfig projection extended with branchingEnabled; anonymous-readable acknowledged
13. Tests: 29 new cases (19 unit + 5 Vue + 3 hybrid + 2 smoke); profile-fields-sync drift guard + anonymization-cascade-pr6 cascade-walker pickup
14. No regressions to PR 1-5 surfaces (engine, Joule narration, author observability)

Return findings classified Critical / Important / Minor / Nit.
```

If the subagent flags Critical or Important issues, fix them, run tests again, commit, and re-dispatch. **Don't push with open Criticals.**

- [ ] **Step 6: Push and open PR**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && git branch --show-current
git push origin feat/172-pr6-pilot-enablement
gh pr create \
  --base main \
  --head feat/172-pr6-pilot-enablement \
  --title "feat(172): PR 6 — pilot enablement (UserLearningPreferences + override + runbook)" \
  --body "$(cat <<'EOF'
## Summary

Closes the pilot-enablement piece of issue #172 (branching paths). This is **PR 6 of 6** — the final PR in the sequence. PR 6 turns the substrate from PRs 1–5 live by giving learners a typed profile the engine can read.

- **`UserLearningPreferences` entity** — typed, enum-constrained (`deployment`/`role`/`cloud`), composition-keyed on `key user : Association to Users`. One row per user.
- **DeveloperService projection + `setLearningPreferences` action** — self-service GET (gated to caller's own row via before-READ hook using CQN builder) + PUT-style write that auto-provisions the Users row for first-time savers (mirrors `completeStep`).
- **AdminService projection** — `@readonly` for support read; admin Fiori Elements list view via `app/admin-annotations.cds`.
- **`/me/` Vue island** — explicit Save button, three `<ui5-select>` dropdowns, `__none__` sentinel for the empty state, branching-disabled Information strip when the master flag is off, a11y `role=alert` live region.
- **Engine integration** — `loaders.js#loadProfile` swapped from PR 1's UserMetaData placeholder to a typed read against `UserLearningPreferences` (TODO comment stripped); `buildUserState` gains `opts.override` param; `decide.js` + `mission-detail.js` pass the result of `extractProfileOverride(req)` (express-only, gated on Tutorial.Author OR Admin scope).
- **Author docs** — pilot runbook + cookbook section under `#debug-override` anchor.

## Architectural decisions baked in (from spec rounds 1-4)

- **Storage shape** — typed entity, NOT three String columns on UserMetaData (PR 1 reviewer mandate).
- **Override gate** — `Tutorial.Author OR Admin`. Admins can test the override on their existing admin login (Tom's pivot).
- **Save UX** — explicit "Save preferences" button, not debounced auto-save (matches every existing user-form Vue island).
- **Write idiom** — SELECT-then-INSERT-or-UPDATE (codebase has zero UPSERT precedent; round-3 BLOCKING DB1).
- **Cache invalidation** — TTL-only (mission-detail.js + decide.js per-callsite caches expire on their own 5-minute TTL; no `bustForUser` hook added; round-2 BLOCKING B1).
- **AdminService projection** — `@readonly` in v1; edit-on-behalf is out of scope (round-2 BLOCKING CB5).
- **Joule narration** — ignores `?profile.*` overrides (chat-orchestrator runs through CAP `req`, not express); v2 candidate (round-2 BLOCKING B8).

## Test plan

- [x] Unit (in-memory SQLite): 6 action handler + 6 override parser + 2 loaders extension + 3 user-state extension + 1 profile-fields-sync drift guard + 1 anonymization-cascade-pr6 drift guard + 5 Vue island = **24 unit tests pass**
- [ ] Hybrid (HANA Cloud): test file written; runs opt-in via `ALLOW_HYBRID_WRITES=true` (Tom must run before merging — 3 hybrid tests)
- [x] Smoke (CI-safe; unauthenticated): 2 tests confirm 401 gate + ChatConfig.branchingEnabled exposure
- [x] Vue island compiles cleanly via `npm run build:apps`
- [x] Docs site builds cleanly via `npm run docs:build`
- [x] CDS compile clean for both services (`npx cds compile srv/developer-service.cds srv/admin-service.cds --to sql`)

## Spec / Plan

- Spec: `docs/superpowers/specs/2026-06-12-172-pr6-pilot-enablement-design.md`
- Plan: `docs/superpowers/plans/2026-06-13-172-pr6-pilot-enablement.md`

## Operator action items

1. (Optional) Set GitHub Actions secret `TUTORIAL_AUTHOR_TOKEN` if you want to add an authenticated override smoke later — **NOT REQUIRED for v1** (per round-2 B10: override smoke is manual via the runbook, not CI).
2. After merge, run `cf push tutorials-srv` to deploy. The first `cds deploy` will create the `USER_LEARNING_PREFERENCES` table (cleanly — net-new entity, no migration).
3. Pick a pilot mission with a curator (per the runbook Phase 1). Set `ChatSettings.branchingEnabled = true` once Phase 2 QA validation completes (per the runbook Phase 3).
4. (Optional) After 1 week of telemetry, review `branch-staleness` lint notices for the pilot mission's branch points (PR 5 surface).
EOF
)"
```

- [ ] **Step 7: Confirm PR is open and CI is green**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/feat-172-pr6 && gh pr view --json number,url,state,statusCheckRollup
```

Expected: `state: OPEN`, eventually `statusCheckRollup` all-green. If anything fails, address before requesting Tom's review.

- [ ] **Step 8: Manual checklist for Tom (paste into PR comment)**

```markdown
**Manual verification checklist (Tom):**

1. [ ] Open `/me/` while logged in → "Learning preferences" panel renders below the existing Recent Activity (MyCompletions) timeline; Save button is disabled (no dirty state)
2. [ ] Pick `deployment: cloud` → Save button enables → click "Save preferences" → "Saved" strip appears for ~3s; refresh page → Select shows `cloud`
3. [ ] Open a tutorial with a `[BRANCH_BEGIN ... condition="profile.deployment == 'cloud'"]` block → cloud branch is the recommendation
4. [ ] Append `?profile.deployment=onprem` to the same URL while logged in as a `Tutorial.Author` user → recommendation switches to the on-prem branch
5. [ ] **Admin override (pivot 2):** same URL while logged in as Tom (Admin role-collection, no `Tutorial.Author`) → override still applies (recommendation switches)
6. [ ] Same URL as a non-author, non-admin user → override is ignored (returns to `cloud`)
7. [ ] Trigger account anonymization (admin path) → `UserLearningPreferences` row is removed (audit log entry)
8. [ ] **Branching disabled UX (I7):** flip `ChatSettings.branchingEnabled = false` in admin → reload `/me/` → Information `<ui5-message-strip>` appears above the form; preferences still saveable
9. [ ] **A11y / SR announcement (I15):** with a screen reader on, click Save with a network error injected → SR announces "Couldn't save preferences. Try again." (live region role=alert); focus moves to first Select
```

---

## Done

PR 6 ships when:

- [ ] All 13 tasks above are checked
- [ ] Final-branch reviewer surfaces no Critical or Important findings
- [ ] PR CI is green
- [ ] Manual checklist (Step 8) is acknowledged by Tom

## Reviewer addendum

(Reserved — items A-N added during plan-review loop, mirrored from PR 3/4/5 plans. Implementer agents MUST read this section before starting each task.)

A. **ALWAYS run vitest via `D:/projects/tutorials-poc/node_modules/.bin/vitest run --project unit <path>` from project root**, NEVER `npx vitest` from `hugo-apps/` ([[feedback_worktree_tests_hang]]).

B. **ChatSettings singleton ID is `'00000000-0000-0000-0000-00000000c8a7'`** — relevant if any task touches ChatSettings handlers.

C. **Tutorial slugs are lowercase canonical** — never compare slugs to publish-payload values without `.toLowerCase()`.

D. **HANA boolean shape: `case when col = true` lowercase** — `db/views.cds:190` is the precedent. SQLite (unit tests) silently accepts the bare form; HANA (hybrid + prod) rejects.

E. **Branch verification before commits**: always run `git branch --show-current` in the same Bash invocation as `git commit` and abort if it shows `main` ([[feedback_verify_branch_before_commit]]).

F. **DeveloperService class registers handlers on `this`, NOT a free `srv` variable** — class structure is `export default class DeveloperService extends cds.ApplicationService { async init() { ... } }` (per recon — round-2 CB3).

G. **Codebase has ZERO `UPSERT` statements** — canonical pattern is SELECT-then-INSERT-or-UPDATE (per `completeStep` at developer-service.js:122-135). Do not introduce `UPSERT.into()` (round-3 DB1).

H. **No new npm dependencies** — use what's already in `package.json`.

I. **CRLF on Windows** — after multi-section edits, run `file <path>` and normalize line endings before committing ([[feedback_crlf_regression_on_windows]]).

J. **`@assert.range` placement**: BEFORE `enum {}` block. Canonical CAP syntax: `String(20) @assert.range enum { cloud; onprem; };`. NOT `enum { ... } @assert.range`.

K. **`@assert.range` is OData-protocol-only** — does NOT fire on programmatic CQL writes from action handlers. The action handler's enum-validation loop is the actual runtime gate.

L. **Profile vocabulary uses `sysadmin` (NOT `admin`)** — avoids collision with the XSUAA Admin scope. Schema enum, PROFILE_VOCAB constants, Vue Select options, and tests all use `sysadmin` consistently.

M. **`profile-fields-sync.test.ts` and `anonymization-cascade-pr6.test.ts` use `.test.ts` extension** — vitest config only includes `.ts` for the `scripts/__tests__/` glob (round-3 DI2).

N. **Override-gate widening**: `req.user.is('Tutorial.Author') || req.user.is('Admin')`. Both author and admin can test the override. xs-security.json role-collections stay disjoint (Tutorials Admin has Admin only; Tutorials Author has Tutorial.Author only) — the gate is permissive, the role-collection model is not (round-1 pivot 2).

O. **`extractProfileOverride` consumes EXPRESS req only** — NOT CAP action-handler `req`. The two callsites are `decideHandler` and `missionDetailHandler` (express handlers). CAP action handlers (e.g. `setLearningPreferences`, Joule narration tools) do NOT support overrides; the override never persists (round-1 B3).

P. **before-READ hook uses CQN builder, NOT hand-built CQN tokens** — `req.query.where({ user_ID: dbUser.ID })` AND-conjoins safely with any pre-existing where clause. Hand-spelled `xpr` arrays get AND-precedence wrong on existing where clauses (round-2 CB2 security boundary).
