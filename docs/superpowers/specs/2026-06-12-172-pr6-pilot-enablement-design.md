# PR 6 — Pilot enablement (issue #172) — Design

> **Status:** Spec — pending plan + implementation.
> **PR sequence:** Final PR of the 6-PR branching-paths sequence (PRs 1–5 merged: #290, #292, #302, #305, #307; #308/#309 = PR 5 follow-ups).
> **Master spec:** [docs/superpowers/specs/2026-06-09-172-branching-paths-design.md](./2026-06-09-172-branching-paths-design.md) §9.1 row 6.
> **Author:** brainstormed 2026-06-12 with Tom (CAP Developer / repo maintainer).

## 1. Problem

The branching-paths engine (PR 1) reads `userState.profile = { deployment, role, cloud }` to evaluate condition expressions like `profile.deployment == 'cloud'`. **Today this profile is always all-null** because there is nowhere on the user record to read from — `srv/lib/branch/loaders.js#loadProfile` ships with a TODO comment ("Until PR 6 introduces the proper `UserLearningPreferences` entity, loadProfile always returns null"), and `UserMetaData` (the empty key/value store the master spec gestured at) has no rows for any user.

Consequence: every condition referencing `profile.*` evaluates false, the ranker has no profile signal, and branches default-order only. The platform has all the moving parts shipped through PRs 1–5 (engine, mission alt-groups, step-level branches, Joule narration, author observability) but no learner-side personalization signal feeding them. **PR 6 is the keystone that turns the substrate live.**

## 2. Goals and non-goals

### 2.1 Goals (v1)

1. **Persist a fixed-vocabulary user profile** so condition expressions referencing `profile.*` evaluate against real data.
2. **Self-service editing** via a "Learning preferences" panel on `/me/` — users set their own values, no admin touch.
3. **Author debug override** via `?profile.deployment=cloud`-style query param, gated by `Tutorial.Author` scope.
4. **Pilot runbook** with mission-selection criteria + a four-phase rollout checklist.
5. **Cookbook extension** documenting the override mechanism for authors.
6. **Strip PR 1's reviewer-mandated TODO** in `loaders.js` once the typed entity replaces the key/value reader.

### 2.2 Non-goals (v2 candidates)

- Multi-language profile labels (platform is en-US-only).
- Profile change history / `@cds.changelog`.
- Auto-population from event-signup data.
- Multi-tenant boundary considerations.
- Multi-field cookbook beyond the existing three patterns + the override section.
- Pilot mission selection itself — the runbook gives a checklist; the actual pick happens off-band with a curator post-merge.
- Removing the `ChatSettings.branchingEnabled` master flag (operator action; documented in runbook Phase 3).

## 3. Architecture

```text
┌─────────────────────────────────────────────────────────────────────┐
│ 1. db/schema.cds                                                    │
│    entity UserLearningPreferences {                                 │
│      key user : Association to Users;                               │
│      deployment : String(20) enum { cloud; onprem };                │
│      role       : String(20) enum { developer; architect; admin;    │
│                                     student };                       │
│      cloud      : String(10) enum { btp; aws; gcp };                │
│    }                                                                │
│    @PersonalData (DataSubjectDetails, cascade: 'delete')            │
└─────────────────────────────────────────────────────────────────────┘
                              ▲
              ┌───────────────┴──────────────────┐
              │                                  │
┌─────────────┴───────────────┐  ┌───────────────┴──────────────────┐
│ 2. DeveloperService         │  │ 3. AdminService (read+write)     │
│    action setLearningPrefs  │  │    @readonly entity for support  │
│    @readonly entity prefs   │  │    + edit via Fiori Elements     │
│    @requires authenticated  │  │    @requires Admin               │
└─────────────┬───────────────┘  └──────────────────────────────────┘
              │
              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. /me/ Vue island: LearningPreferences.vue                         │
│    UI5 Form (ui5-select × 3) → POST /api/setLearningPreferences     │
│    Mounted on existing Hugo /me/ page below MyCompletions           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼ (consumed by branch engine)
┌─────────────────────────────────────────────────────────────────────┐
│ 5. srv/lib/branch/loaders.js (rewrite loadProfile)                  │
│    SELECT.one.from(UserLearningPreferences).where({user_ID})        │
│                                                                     │
│    + buildUserState (user-state.js): merge override AFTER load      │
│      profile = { ...real, ...override }                             │
│      override only when caller has Tutorial.Author scope            │
└─────────────────────────────────────────────────────────────────────┘
```

**Boundaries:**

- Schema (1) is the source of truth for the v1 vocabulary; enum constraints prevent invalid values at the DB layer.
- DeveloperService (2) and AdminService (3) are independent surfaces — self-service vs admin-support — over the same entity. No cross-coupling.
- Vue island (4) is a leaf consumer of DeveloperService.
- `loaders.js` (5) is the engine's single read path; `user-state.js` handles the merge.

The override is parsed in two callsites (`/api/branches/decide` and `/build/mission/<slug>`) — each callsite extracts `req.query['profile.*']`, validates `Tutorial.Author` scope, passes the validated override to `buildUserState`. Cache key fingerprint (already computed in `fingerprintUserState`) includes the merged profile, so override-mode traffic doesn't poison learner-mode cache entries.

### 3.1 Architectural invariants

- **One source of truth** for profile vocabulary: the schema enum strings. The override-parser allowlist and the Vue Select options reference the same strings via a shared constants module (`srv/lib/branch/profile-fields.js`, exported to both server and Vue).
- **Override never persists.** It's a per-request merge above the loaded row; no write path uses `req.query['profile.*']`.
- **Self-service writes are atomic per-action.** No drafts; no partial-update OData PATCH. One POST = one upsert.

## 4. Data model

### 4.1 `UserLearningPreferences` entity

```cds
// db/schema.cds (append after UserMetaData around line 131)

entity UserLearningPreferences : managed {
  key user       : Association to Users;
  deployment     : String(20) enum { cloud; onprem; };
  role           : String(20) enum { developer; architect; admin; student; };
  cloud          : String(10) enum { btp; aws; gcp; };
}
```

```cds
// db/audit-logging.cds (append next to UserMetaData annotation)

annotate ims.UserLearningPreferences with @PersonalData : {
  EntitySemantics: 'DataSubjectDetails',
  cascade: 'delete'
} {
  user @PersonalData.FieldSemantics: 'DataSubjectID';
};
```

**One row per user** (composition-keyed via `key user`). All three fields nullable — a user with only `deployment` set produces `{deployment: 'cloud', role: null, cloud: null}` and the engine treats null as "no opinion".

`@PersonalData cascade: 'delete'` integrates with the existing anonymization cascade — no new code in `srv/lib/anonymization/`.

### 4.2 Service projections

**DeveloperService** (`/api`, `@requires: 'any'` service-level + `@requires: 'authenticated-user'` per-entity):

```cds
// srv/developer-service.cds

@(requires: 'authenticated-user')
@readonly entity LearningPreferences as projection on ims.UserLearningPreferences {
  user, deployment, role, cloud
};

@(requires: 'authenticated-user')
action setLearningPreferences(
  deployment : String null,
  role       : String null,
  cloud      : String null
) returns LearningPreferences;
```

The read entity returns the caller's own row only — handler injects `where: { user_ID: req.user.id }`. The action validates enum values at the entry point (rejects invalid values with 400 + field-level error) and upserts.

**AdminService** (`/admin`, `@requires: 'Admin'` service-level):

```cds
// srv/admin-service.cds

entity LearningPreferences as projection on ims.UserLearningPreferences;
```

Plain read+write projection inheriting `Admin` from the service gate. No inline UI annotations in v1 — admin can edit via the Fiori draft UI or the Analytics Explorer.

### 4.3 Constants module (single source of truth for vocab)

```js
// srv/lib/branch/profile-fields.js (new — also reachable from Vue via the same import path the existing isomorphic helpers use)

export const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];

export const PROFILE_VOCAB = {
  deployment: ['cloud', 'onprem'],
  role: ['developer', 'architect', 'admin', 'student'],
  cloud: ['btp', 'aws', 'gcp'],
};
```

Used by:

- `srv/lib/branch/profile-override.js` — allowlist check
- `srv/developer-service.js` — action handler enum validation
- `hugo-apps/src/me/LearningPreferences.vue` — Select option lists

## 5. Runtime

### 5.1 Read path

```text
HTTP request to /api/branches/decide  OR  /build/mission/<slug>
  │
  ├─ extractProfileOverride(req):
  │     if req.user.is('Tutorial.Author') AND any req.query['profile.<field>'] valid:
  │       return { <field>: <value>, ... }
  │     else:
  │       return null
  │
  └─ buildUserState(user, loaders, { override }):
        if !user → EMPTY_STATE
        else:
          [slugs, missions, profileRaw] = await Promise.all([
            loaders.loadCompletedSlugs(user),
            loaders.loadCompletedMissionSlugs(user),
            loaders.loadProfile(user),     // ← typed read from UserLearningPreferences
          ])
          profile = {}
          for f in PROFILE_FIELDS:
            profile[f] = override?.[f] ?? profileRaw?.[f] ?? null
          return Object.freeze({ completedSlugs, completedMissionSlugs,
                                  profile: Object.freeze(profile) })
  │
  └─ fingerprintUserState(state) → sha256, cache key includes the merged profile
  │
  └─ pickBranch(...) evaluates condition against final profile
```

**Three properties:**

- Anonymous: `realProfile = null`, override skipped (no scope), profile all-null. `profile.deployment == 'cloud'` evaluates false. Engine falls through to ranker → default.
- Authenticated learner: real profile loaded; override skipped (no scope). Cache shared with same-fingerprint learners.
- Authenticated `Tutorial.Author` with `?profile.deployment=cloud`: override merged in; cache fingerprint differs → separate cache slot. Author can simulate any profile without writing to their own DB row.

### 5.2 Write path

```text
Vue Select onChange (debounced 500ms)
  │
  ├─ POST /api/setLearningPreferences { deployment, role, cloud }
  │
  ├─ @requires: 'authenticated-user' (XSUAA gate)
  │
  ├─ Action handler:
  │     1. Validate each field ∈ PROFILE_VOCAB[field] ∪ {null}
  │     2. UPSERT INTO UserLearningPreferences (user_ID, deployment, role, cloud)
  │        VALUES (req.user.id, ...) ON CONFLICT (user_ID) DO UPDATE
  │     3. After success: bust mission-detail cache for req.user.id
  │     4. Return updated row
  │
  └─ Vue: show "Saved" message-strip; on failure, retry once after 1s
```

**Cache-bust** mirrors PR 1's existing `TaskRecords.after('CREATE')` hook — when prefs change, the user's `(missionSlug, userId, fingerprint)` cache entries get invalidated. Other PR 4/5 caches don't aggregate user state, so no other bust hooks needed.

### 5.3 Override URL shape

The spec uses `?profile.deployment=cloud` (dotted query keys). Express + CAP both accept this:

```text
req.query['profile.deployment'] = 'cloud'
req.query['profile.role'] = 'developer'
```

Override extraction loops over `PROFILE_FIELDS` reading `req.query['profile.' + field]`, validates against `PROFILE_VOCAB[field]`. Invalid values get silently dropped (per §6.1).

## 6. Edge cases

### 6.1 Schema-level errors

| Error | Surface | Status |
|---|---|---|
| Invalid enum (`deployment='hybrid'`) at action | action handler | 400 with `{field}: must be one of [cloud, onprem, null]` |
| Field omitted (vs explicit null) | action handler | preserved in DB (action only writes fields the caller supplied) |
| Anonymous caller hits action | XSUAA gate | 401 |
| Concurrent UPSERT (two browser tabs) | DB | last-write-wins; preferences are read-mostly, not transactional |

### 6.2 Engine-level edge cases

| Scenario | Engine behavior |
|---|---|
| User has no `UserLearningPreferences` row | `loadProfile` returns null → profile all-null |
| Row exists with all fields null | Same as above (semantically equivalent) |
| Row with partial set (`deployment` only) | `{deployment: 'cloud', role: null, cloud: null}` |
| Anonymous request | `EMPTY_STATE` (frozen, all-null profile) |
| Override with invalid enum | Override parser drops the field silently |
| Override from non-`Tutorial.Author` user | Parser returns null; override never reaches `buildUserState` |
| Override + real both present | Override wins per-field |
| Override partial (only `deployment`) | Real contributes `role` + `cloud` |
| User account anonymized | `cascade: 'delete'` removes the row automatically |

### 6.3 Vue island error handling

| Failure | Behavior |
|---|---|
| Network error on save | Silent retry once after 1s; if second fails, `<ui5-message-strip design="Negative">` + dropdown reverts to prior value |
| 401 mid-edit | Same negative UX (approuter handles login redirect on next page load) |
| 400 invalid enum (defensive — UI shouldn't allow) | Same negative strip; console diagnostic |
| Empty initial state | All Selects show "— No preference —"; no special "first visit" mode |

### 6.4 Master flag interaction

`ChatSettings.branchingEnabled` (PR 1, default off) gates the engine's branching code paths. PR 6's profile entity + UI ship **regardless** — preferences are useful as user-data even when branching is off (a "what we'd recommend" preview for v2). Engine-side, `pickBranch` only consults `profile.*` when invoked from a branching code path that's already gated by the flag. So PR 6 is flag-independent on the user-write side; **the "branching is currently disabled but you've set preferences" UX is acceptable** — preferences become a no-op signal that activates when the flag flips.

## 7. Components in detail

### 7.1 Files (summary)

| File | Action | LoC est |
|---|---|---|
| `db/schema.cds` | append entity | ~10 |
| `db/audit-logging.cds` | annotate (cascade-delete) | ~5 |
| `srv/developer-service.cds` | append projection + action | ~10 |
| `srv/developer-service.js` | new `setLearningPreferences` handler | ~30 |
| `srv/admin-service.cds` | append projection | ~3 |
| `srv/lib/branch/profile-fields.js` | new — vocab constants | ~10 |
| `srv/lib/branch/profile-override.js` | new — override parser | ~25 |
| `srv/lib/branch/loaders.js` | rewrite `loadProfile` | ~15 (replace) |
| `srv/lib/branch/user-state.js` | add override param + merge | ~5 |
| `srv/lib/branch/decide.js` | wire override at one callsite | ~3 |
| `srv/lib/branch/mission-detail.js` | wire override at one callsite + cache-bust on UPSERT | ~6 |
| `hugo-apps/src/me/LearningPreferences.vue` | new island | ~80 |
| `hugo-apps/src/me/main.ts` | mount the new island | ~3 |
| `hugo/layouts/me/list.html` | append mount-point div | ~3 |
| `docs/authors/branching-cookbook.md` | append override section | ~30 |
| `docs/authors/pilot-runbook.md` | new | ~80 |
| `docs/.vitepress/config.ts` | sidebar entry for runbook | ~1 |
| Tests (unit + hybrid + Vue + smoke) | new + extensions | ~200 |

**~14 new/modified files. No new npm dependencies.**

### 7.2 Action handler shape

```js
// srv/developer-service.js (append)

const { PROFILE_VOCAB } = require('./lib/branch/profile-fields.js');

srv.on('setLearningPreferences', async (req) => {
  const { deployment, role, cloud } = req.data;

  // Validate each field: null OR a value from the vocab.
  for (const [field, value] of Object.entries({ deployment, role, cloud })) {
    if (value === null || value === undefined) continue;
    if (!PROFILE_VOCAB[field].includes(value)) {
      return req.error(400, `${field}: must be one of [${PROFILE_VOCAB[field].join(', ')}, null]`);
    }
  }

  const { UserLearningPreferences, Users } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: req.user.id });
  if (!dbUser?.ID) return req.error(404, 'user not found');

  // Upsert: try update, fall back to insert. CAP CDS QL has no native UPSERT;
  // use a transaction or rely on the engine's automatic idempotence on
  // composition-keyed entities (verified in unit test 1+2).
  await UPSERT.into(UserLearningPreferences).entries({
    user_ID: dbUser.ID,
    deployment, role, cloud,
  });

  // Cache-bust: mirror the TaskRecords.after('CREATE') pattern.
  bustMissionDetailCacheFor(dbUser.ID);

  return await SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
});
```

### 7.3 Override parser

```js
// srv/lib/branch/profile-override.js (new)

import { PROFILE_FIELDS, PROFILE_VOCAB } from './profile-fields.js';

/**
 * Extract a validated profile override from req.query when the requesting user
 * has Tutorial.Author scope. Returns null if no override / not authorised /
 * no valid values. Caller passes the result as opts.override to buildUserState.
 */
export function extractProfileOverride(req) {
  if (!req?.user?.is?.('Tutorial.Author')) return null;
  const override = {};
  for (const field of PROFILE_FIELDS) {
    const v = req.query?.[`profile.${field}`];
    if (typeof v === 'string' && PROFILE_VOCAB[field].includes(v)) {
      override[field] = v;
    }
  }
  return Object.keys(override).length ? override : null;
}
```

### 7.4 `loaders.js` rewrite

```js
// srv/lib/branch/loaders.js — replace lines 38-63 (the key/value reader + TODO)

async loadProfile(user) {
  if (!user?.id || user.id === 'anonymous') return null;
  try {
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
}
```

PR 1's reviewer-mandated TODO comment ("Until PR 6 introduces the proper `UserLearningPreferences` entity, loadProfile always returns null") is stripped.

### 7.5 `buildUserState` extension

```js
// srv/lib/branch/user-state.js — add override merge

export async function buildUserState(user, deps, opts = {}) {
  if (!user) return EMPTY_STATE;

  const [slugs, missions, profileRaw] = await Promise.all([
    deps.loadCompletedSlugs(user),
    deps.loadCompletedMissionSlugs(user),
    deps.loadProfile(user),
  ]);

  // PR 6: merge override (already validated by caller — only valid enum
  // values and only when user has Tutorial.Author scope).
  const profile = Object.create(null);
  for (const f of PROFILE_FIELDS) {
    profile[f] = opts.override?.[f] ?? profileRaw?.[f] ?? null;
  }

  return Object.freeze({
    completedSlugs: new Set(slugs),
    completedMissionSlugs: new Set(missions),
    profile: Object.freeze(profile),
  });
}
```

### 7.6 Vue island

```vue
<!-- hugo-apps/src/me/LearningPreferences.vue (new) -->

<template>
  <div class="learning-preferences sapUiSmallMargin">
    <ui5-title level="H3">Learning preferences</ui5-title>
    <ui5-text>Help us personalize tutorial branching. All fields optional.</ui5-text>

    <ui5-label for="deployment">Where do you typically deploy?</ui5-label>
    <ui5-select id="deployment" :value="prefs.deployment ?? ''" @change="onChange('deployment', $event)">
      <ui5-option value="">— No preference —</ui5-option>
      <ui5-option value="cloud">Cloud</ui5-option>
      <ui5-option value="onprem">On-premise</ui5-option>
    </ui5-select>

    <!-- role + cloud blocks identical shape -->

    <ui5-message-strip v-if="status === 'saved'" design="Positive">Saved.</ui5-message-strip>
    <ui5-message-strip v-if="status === 'error'" design="Negative">
      Couldn't save preferences. Try again.
    </ui5-message-strip>
  </div>
</template>
```

Logic: load from `GET /api/LearningPreferences` on mount, debounce 500ms on Select change, POST to `/api/setLearningPreferences`, retry once on failure, revert dropdown to prior value on second failure.

### 7.7 Pilot runbook

`docs/authors/pilot-runbook.md` — four-phase checklist:

- **Phase 1 — Pre-pilot:** mission selection criteria, vocab alignment, author readiness.
- **Phase 2 — QA pilot:** author writes branches, tests via QA channel, exercises all four debug paths (cloud / onprem / no-override-anonymous / no-override-completed-slug).
- **Phase 3 — Production rollout:** flip `ChatSettings.branchingEnabled` (DEV first, then prod), monitor `/admin/analytics/AnalyticsBranchPerformance`, check Branch Performance section in Missions ObjectPage, watch for `branch-staleness` notices.
- **Phase 4 — Iterate / rollback:** thresholds for collapse / tune / investigate; rollback path (`branchingEnabled = false`).

### 7.8 Cookbook extension

`docs/authors/branching-cookbook.md` — append "Testing your conditions with the debug override" section: format, examples, cache-fingerprint note, what happens with invalid values, what happens without `Tutorial.Author` scope.

## 8. Testing strategy

### 8.1 Test surface

| Layer | File | Cases |
|---|---|---|
| Unit | `test/unit/learning-preferences.test.js` | 6 |
| Unit | `srv/lib/branch/__tests__/profile-override.test.js` | 5 |
| Unit | `srv/lib/branch/__tests__/loaders.test.js` (extend) | +2 |
| Unit | `srv/lib/branch/__tests__/user-state.test.js` (extend) | +2 |
| Vue island | `hugo-apps/src/me/__tests__/LearningPreferences.test.ts` | 4 |
| Hybrid (HANA, opt-in) | `test/hybrid/learning-preferences.test.js` | 3 |
| Smoke (deployed) | `test/smoke/learning-preferences.smoke.test.js` | 2 |

**~22 new test cases.** Existing PR 1–5 tests pass unchanged.

### 8.2 Per-layer coverage

**Unit — `learning-preferences.test.js` (action handler):**

1. `setLearningPreferences({deployment: 'cloud', role: null, cloud: 'btp'})` — UPSERTs row; subsequent SELECT returns `{deployment: 'cloud', role: null, cloud: 'btp'}`
2. Re-call with `{deployment: 'onprem'}` — partial update preserves prior `cloud: 'btp'`; new `deployment: 'onprem'`; explicit `null` for unspecified args clears them
3. Invalid enum (`deployment: 'hybrid'`) — 400 with field-level error message
4. Anonymous caller — 401 (XSUAA gate)
5. `GET /api/LearningPreferences` returns the caller's row only (handler-injected `where: {user_ID: $user}`)
6. After UPSERT, mission-detail cache for that user is busted (assert via in-memory cache spy)

**Unit — `profile-override.test.js`:**

1. Authenticated `Tutorial.Author` + valid `?profile.deployment=cloud` → returns `{deployment: 'cloud'}`
2. Authenticated non-`Tutorial.Author` + same query → returns `null` (gate works)
3. Anonymous + same query → returns `null`
4. Author + invalid value (`?profile.deployment=hybrid`) → field dropped, returns `null` (or partial if other fields valid)
5. Author + multiple fields including one invalid → returns only the valid ones

**Unit — extend `loaders.test.js` (+2):**

1. `loadProfile` returns `{deployment, role, cloud}` shape from `UserLearningPreferences` (replaces existing key/value test)
2. `loadProfile` returns null when user has no row (anonymous + missing-row paths)

**Unit — extend `user-state.test.js` (+2):**

1. `buildUserState(user, deps, {override: {deployment: 'cloud'}})` merges override over real `{deployment: 'onprem'}` → final `deployment: 'cloud'`
2. Override-merge respects null fields: `override = {deployment: 'cloud'}`, real = `{deployment: 'onprem', role: 'developer'}` → final `{deployment: 'cloud', role: 'developer', cloud: null}`

**Vue island — `LearningPreferences.test.ts`:**

1. Mount → fetches `/api/LearningPreferences` → renders Selects with current values
2. Change `deployment` Select → debounce fires after 500ms → POST to `/api/setLearningPreferences` with the changed field; success-strip appears
3. Server returns 500 → retry once after 1s → second 500 → negative-strip appears, dropdown reverts
4. Empty initial state (404 / null row) → all Selects show "— No preference —"

**Hybrid — `learning-preferences.test.js`** (gated by `ALLOW_HYBRID_WRITES=true` + `isSafeForWrites()`):

1. Real HANA: enum constraint enforced (insert with `deployment='hybrid'` rejected at DB layer)
2. Real HANA: UPSERT pattern works against the live DB driver (CAP-on-HANA upsert quirks)
3. Real HANA: `@PersonalData cascade: 'delete'` removes the row when the parent Users row is deleted

**Smoke — `learning-preferences.smoke.test.js`** (HTTP against deployed):

1. `GET /api/LearningPreferences` against deployed srv URL with a real user JWT — returns 200 (or 404 when no row)
2. `POST /api/setLearningPreferences` with valid payload → 200; subsequent GET reflects the change

### 8.3 Conventions

- Test prefix: `__test__-pr6-` for any test users (matches PR 5's `__test__-pr5-` precedent)
- Hybrid uses `ALLOW_HYBRID_WRITES=true` + `isSafeForWrites()` (PR 5's pattern verbatim)
- Smoke uses `SMOKE_BASE_URL` + `SMOKE_SRV_URL` env vars (existing infra)

### 8.4 Manual verification (PR body checklist)

1. Open `/me/` while logged in → "Learning preferences" panel renders below "Recent Activity"
2. Pick `deployment: cloud` → 500ms later "Saved" strip appears; refresh page → Select shows `cloud`
3. Open a tutorial with a `[BRANCH_BEGIN ... condition="profile.deployment == 'cloud'"]` block → `cloud` branch is the recommendation
4. Append `?profile.deployment=onprem` to the same URL while logged in as a `Tutorial.Author` user → recommendation switches to the on-prem branch
5. Same URL as a non-author user → override is ignored (returns to `cloud`)
6. Trigger account anonymization (admin path) → `UserLearningPreferences` row is removed (audit log entry)

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Override leakage to non-author | Low | Two-line `req.user.is('Tutorial.Author')` gate; tests 2+3 of `profile-override.test.js` cover negative paths |
| Cache poisoning between author + learner | Low | `fingerprintUserState` hashes the merged profile; override-mode produces different fingerprint, separate cache slot |
| Schema migration on prod | Low | Net-new entity; CAP/HANA `cds deploy` adds the table cleanly; no data migration |
| Enum mismatch between schema / override-parser allowlist / Vue Select options | Medium | Single source of truth via `srv/lib/branch/profile-fields.js`; unit test asserts allowlist matches |
| Cookie/JWT scope on `/me/` returning empty | Low | `@requires: 'authenticated-user'` matches existing `MyCompletions` gate |
| Vue island bundle size | Low | Pure UI5-webcomponents (`<ui5-select>`, `<ui5-message-strip>`) already in bundle; <5 kB gzip |
| Concurrent UPSERT race (two browser tabs) | Low | Last-write-wins; preferences are read-mostly |
| Anonymization cascade misses the new entity | Low | `@PersonalData cascade: 'delete'` is documented mechanism (UserMetaData + TaskRecords precedent); hybrid test 3 verifies |
| `branchingEnabled = false` + user sets preferences | Low | Documented in §6.4; preferences stored regardless; engine consults only when branching code paths reached |

## 10. Definition of Done

- [ ] All ~22 unit + 3 hybrid + 2 smoke tests pass (or hybrid skipped via `ALLOW_HYBRID_WRITES`)
- [ ] `cds compile srv/developer-service.cds srv/admin-service.cds --to sql` clean
- [ ] Vue island builds clean via `npm run build:apps`
- [ ] `npm run docs:build` passes (sidebar guard accepts the new runbook)
- [ ] Manual checklist (§8.4) verified against DEV
- [ ] `@PersonalData` annotation present on `UserLearningPreferences`
- [ ] PR 1's reviewer-mandated TODO comment stripped from `loaders.js`
- [ ] No new GH secret / role-collection grant required (PR 5's `TUTORIAL_AUTHOR_TOKEN` is unrelated; PR 6 is purely user-side)
- [ ] PR opened against `main`; CI green; manual checklist acknowledged by Tom

## 11. Out of scope (explicit non-goals)

- Multi-language profile labels — platform is en-US-only.
- Profile change history / `@cds.changelog` on user-edited fields.
- Auto-population from event-signup data.
- Multi-tenant boundary considerations.
- Pilot mission selection itself — runbook gives a checklist; the pick happens off-band post-merge.
- Removing the `ChatSettings.branchingEnabled` master flag — operator action documented in runbook Phase 3.
- Multi-field cookbook beyond the existing three patterns + the override section.
