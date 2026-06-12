# PR 6 — Pilot enablement (issue #172) — Design

> **Status:** Spec — pending plan + implementation.
> **PR sequence:** Final PR of the 6-PR branching-paths sequence (PRs 1–5 merged: #290, #292, #302, #305, #307; #308/#309 = PR 5 follow-ups).
> **Master spec:** [docs/superpowers/specs/2026-06-09-172-branching-paths-design.md](./2026-06-09-172-branching-paths-design.md) §9.1 row 6.
> **Author:** brainstormed 2026-06-12 with Tom (CAP Developer / repo maintainer).

## 1. Problem

The branching-paths engine (PR 1) reads `userState.profile = { deployment, role, cloud }` to evaluate condition expressions like `profile.deployment == 'cloud'`. **Today this profile is always all-null** because there is nowhere on the user record to read from — `srv/lib/branch/loaders.js#loadProfile` ships with a TODO comment ("Until PR 6 introduces the proper `UserLearningPreferences` entity, loadProfile always returns null"), and `UserMetaData` (the empty key/value store the master spec gestured at) has no rows for any user.

Consequence: every condition referencing `profile.*` evaluates as falsy/null, the ranker has no profile signal, and branches default-order only. The platform has all the moving parts shipped through PRs 1–5 (engine, mission alt-groups, step-level branches, Joule narration, author observability) but no learner-side personalization signal feeding them. **PR 6 is the keystone that turns the substrate live.**

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
│      role       : String(20) enum { developer; architect; sysadmin; │
│                                     student };                      │
│      cloud      : String(20) enum { btp; aws; gcp };                │
│    }                                                                │
│    @PersonalData (DataSubjectDetails, cascade: 'delete')            │
│    (annotation lives in db/audit-logging.cds — see §4.1)            │
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
│      override only when caller has Tutorial.Author OR Admin scope   │
└─────────────────────────────────────────────────────────────────────┘
```

**Boundaries:**

- Schema (1) is the source of truth for the v1 vocabulary; enum constraints prevent invalid values at the DB layer.
- DeveloperService (2) and AdminService (3) are independent surfaces — self-service vs admin-support — over the same entity. No cross-coupling.
- Vue island (4) is a leaf consumer of DeveloperService.
- `loaders.js` (5) is the engine's single read path; `user-state.js` handles the merge.

The override is parsed in two callsites (`/api/branches/decide` and `/build/mission/<slug>`) — each callsite extracts `req.query['profile.*']` from the **express request**, validates `Tutorial.Author` **OR** `Admin` scope, passes the validated override to `buildUserState`. Cache key fingerprint (already computed in `fingerprintUserState`) includes the merged profile, so override-mode traffic doesn't poison learner-mode cache entries.

### 3.1 Architectural invariants

- **One source of truth** for profile vocabulary: the schema enum strings. The override-parser allowlist and the Vue Select options reference the same strings via a shared constants module (`srv/lib/branch/profile-fields.js`, exported to both server and Vue).
- **Override is request-time only on express callsites.** `extractProfileOverride(req)` consumes the **express request** (not the CAP `req` object inside action handlers). The two callsites today are `decideHandler` and `missionDetailHandler` — both express handlers. CAP action handlers (e.g. `setLearningPreferences`, Joule narration tools) do **not** support `?profile.*` overrides; the override never persists in any code path.
- **Self-service writes use PUT-style semantics.** `setLearningPreferences` always writes all three fields; values omitted by the caller are explicitly cleared (set to null). The Vue island always sends all three values via the explicit Save button. No drafts; no partial-update OData PATCH.
- **Override-merge treats empty string as absent.** `extractProfileOverride` rejects `''` the same as missing — only string values present in `PROFILE_VOCAB[field]` are merged.

## 4. Data model

### 4.1 `UserLearningPreferences` entity

```cds
// db/schema.cds (append after UserMetaData around line 131)

entity UserLearningPreferences : managed {
  key user       : Association to Users;
  deployment     : String(20) @assert.range enum { cloud; onprem; };
  role           : String(20) @assert.range enum { developer; architect; sysadmin; student; };
  cloud          : String(20) @assert.range enum { btp; aws; gcp; };
}
```

> **Note (new pattern in this repo):** `key user : Association to Users` is the first use of an
> association-as-key in this codebase. The HANA table PK is `USER_ID` only — there is no `ID` column.
> Canonical lookup: `req.query.where({ user_ID: ... })` or
> `SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID })`. The `@assert.range`
> annotation MUST appear **before** the inline `enum { ... }` block (no colon between annotation
> and the enum literal) — this is the canonical CAP syntax confirmed via cds-mcp.

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
  deployment : String,
  role       : String,
  cloud      : String
) returns LearningPreferences;
```

The read entity returns the caller's own row only via a CAP `this.before('READ', 'LearningPreferences', ...)` hook (registered in the existing `DeveloperService.init()` class method) that looks up `dbUser.ID` from `req.user.id` (XSUAA UUID) and appends `req.query.where({ user_ID: dbUser.ID })` using the CQN builder API (which AND-conjoins safely with any pre-existing where clause). The handler is registered alongside the action handler in `srv/developer-service.js` (~10 LoC). The action validates enum values at the entry point (rejects invalid values with 400 + field-level error) and upserts using **PUT-style semantics**: all three fields are always written. Values omitted by the caller are explicitly cleared to `null` (see §6.1, §7.2).

**AdminService** (`/admin`, `@requires: 'Admin'` service-level):

```cds
// srv/admin-service.cds

@readonly entity LearningPreferences as projection on ims.UserLearningPreferences;
```

Read-only projection inheriting `Admin` from the service gate. AdminService inherits service-level `@requires: 'Admin'` — admins read all rows; **no per-row filter is injected** for AdminService (the before-READ hook is registered only on the DeveloperService projection). UI annotations live in `app/admin-annotations.cds` (§7.7) and provide a minimal Fiori Elements list view.

> **v1 scope note:** Admin Fiori Elements is **read-only** in v1 — admins cannot create or edit user
> preferences via the admin UI. Edit-on-behalf support cases are out of scope; the user-facing `/me/`
> panel is the only edit path. Rationale: the projection key is `user : Association to Users` (FK is
> not in the writable projection shape), so a Fiori create form has no clean way to pick the target
> user. Reopen for v2 if support actually needs admin edit. See §11 Out of scope.

### 4.3 Constants module (single source of truth for vocab)

```js
// srv/lib/branch/profile-fields.js (new — ESM, matches srv/ "type": "module")

export const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];

export const PROFILE_VOCAB = {
  deployment: ['cloud', 'onprem'],
  role: ['developer', 'architect', 'sysadmin', 'student'],
  cloud: ['btp', 'aws', 'gcp'],
};
```

**Module shape:** ESM. `srv/` already has `"type": "module"` in `package.json` and PR 1's `user-state.js` is ESM, so server-side imports use standard `import { PROFILE_FIELDS, PROFILE_VOCAB } from './profile-fields.js';`. The Vue island imports the same file via a Vite-resolved relative path (`import { PROFILE_VOCAB } from '../../../srv/lib/branch/profile-fields.js'`); no bundler-specific shim is needed because the file has zero dependencies and is pure data. The `.js` extension keeps both consumers honest.

Used by:

- `srv/lib/branch/profile-override.js` — allowlist check
- `srv/developer-service.js` — action handler enum validation
- `hugo-apps/src/me/LearningPreferences.vue` — Select option lists

## 5. Runtime

### 5.1 Read path

```text
HTTP request to /api/branches/decide  OR  /build/mission/<slug>
  │
  ├─ extractProfileOverride(req):  // express request only
  │     if (req.user.is('Tutorial.Author') OR req.user.is('Admin'))
  │        AND any req.query['profile.<field>'] valid:
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

  fingerprintUserState(state) → sha256, cache key includes the merged profile

  pickBranch(...) evaluates condition against final profile
```

**Three properties:**

- Anonymous: `realProfile = null`, override skipped (no scope), profile all-null. `profile.deployment == 'cloud'` evaluates falsy/null. Engine falls through to ranker → default.
- Authenticated learner: real profile loaded; override skipped (no scope). Cache shared with same-fingerprint learners.
- Authenticated `Tutorial.Author` **or** `Admin` with `?profile.deployment=cloud`: override merged in; cache fingerprint differs → separate cache slot. Author/Admin can simulate any profile without writing to their own DB row.

### 5.2 Write path

```text
Vue "Save preferences" button click (only enabled when dirty)
  │
  ├─ POST /api/setLearningPreferences { deployment, role, cloud }
  │     ALL THREE fields always sent (PUT-style; null clears the slot)
  │
  ├─ @requires: 'authenticated-user' (XSUAA gate)
  │
  ├─ Action handler:
  │     1. Validate each field ∈ PROFILE_VOCAB[field] ∪ {null}
  │     2. UPSERT INTO UserLearningPreferences (user_ID, deployment, role, cloud)
  │        VALUES (req.user.id, ...) ON CONFLICT (user_ID) DO UPDATE
  │        — ALL THREE columns are written every time (PUT semantics)
  │     3. Return updated row
  │
  └─ Vue: show "Saved" <ui5-message-strip> for 3s; on failure,
        show "Couldn't save" strip and leave Selects on user's choices
```

**Cache invalidation:** PR 6 does **not** add a cache-bust hook. `mission-detail.js` and `decide.js` each maintain their own private 5-minute TTL caches keyed on **slug + user-id + the full `userState` fingerprint (which already includes the merged profile)**. After a profile write the user may see up to a 5-minute stale-after-write window before the merged profile takes effect; this is acceptable for v1 (preferences are read-mostly, the engine still returns a sensible recommendation, and the fingerprint includes all three fields so a subsequent author override creates a different cache slot anyway). Per recon, neither cache exports a `bustForUser` / `invalidateForUser` hook — only `__resetCacheForTest`. v2 follow-up could add an explicit invalidator if the stale window proves user-visible (out of scope this PR).

### 5.3 Override URL shape

The spec uses `?profile.deployment=cloud` (dotted query keys). `extractProfileOverride(req)` consumes the **express request** only — both confirmed callsites (`decideHandler` in `srv/lib/branch/decide.js` and `missionDetailHandler` in `srv/lib/branch/mission-detail.js`) are express handlers. Express's default query parser surfaces the dotted keys as flat strings:

```text
req.query['profile.deployment'] = 'cloud'
req.query['profile.role'] = 'developer'
```

CAP action handlers (e.g. `setLearningPreferences`, the Joule narration tool) do **not** support `?profile.*` overrides — those handlers receive a CAP `req` whose `req.query` is a CQN object, not an express query map. The override is request-time only on the two express callsites; it never persists.

Override extraction loops over `PROFILE_FIELDS` reading `req.query['profile.' + field]`, validates against `PROFILE_VOCAB[field]`, and treats empty string the same as missing. Invalid values get silently dropped (per §6.1).

## 6. Edge cases

### 6.1 Schema-level errors

| Error | Surface | Status |
|---|---|---|
| Invalid enum (`deployment='hybrid'`) at action | action handler | 400 with `{field}: must be one of [cloud, onprem]` |
| Field omitted (vs explicit null) | action handler | **PUT-style**: caller MUST send all three fields. Omitted fields are explicitly cleared to null. The Vue island always sends all three values; programmatic callers that only want to update one field must read the existing row, mutate locally, then send the full payload. |
| Anonymous caller hits action | XSUAA gate | 401 |
| Concurrent UPSERT (two browser tabs) | DB | last-write-wins; preferences are read-mostly, not transactional |
| Empty-string override (`?profile.deployment=`) | override parser | dropped (treated same as missing key) |
| First-time-user save (no `Users` row yet) | action handler | **auto-provision Users row** mirroring the `completeStep` pattern at developer-service.js:122-135 (uuid + legacyId + email + firstName + lastName from `req.user.attr`); avoids a hard 404 when a learner saves prefs before completing any tutorial |

### 6.2 Engine-level edge cases

| Scenario | Engine behavior |
|---|---|
| User has no `UserLearningPreferences` row | `loadProfile` returns null → profile all-null |
| Row exists with all fields null | Same as above (semantically equivalent) |
| Row with partial set (`deployment` only) | `{deployment: 'cloud', role: null, cloud: null}` |
| Anonymous request | `EMPTY_STATE` (frozen, all-null profile) |
| Override with invalid enum | Override parser drops the field silently |
| Override from non-`Tutorial.Author`, non-`Admin` user | Parser returns null; override never reaches `buildUserState` |
| Override + real both present | Override wins per-field |
| Override partial (only `deployment`) | Real contributes `role` + `cloud` |
| User account anonymized | `cascade: 'delete'` removes the row automatically |
| Joule narration tool | Ignores `?profile.*` overrides — narration runs through CAP `chat-orchestrator` and never sees the express `req.query`. Author must clear the override and chat from the unmodified URL to test narration. Plumbing the override through the orchestrator is deferred to v2 (see §11). |

### 6.3 Vue island error handling

| Failure | Behavior |
|---|---|
| Network error on save | `<ui5-message-strip design="Negative">` "Couldn't save preferences. Try again." appears for 3s; Selects keep the user's chosen values; Save button re-enables for retry |
| 401 mid-edit | Same negative strip (approuter handles login redirect on next page load) |
| 400 invalid enum (defensive — UI shouldn't allow) | Same negative strip; console diagnostic |
| Empty initial state | All Selects show "— No preference —" (sentinel value `__none__`); Save button disabled until user changes something |
| `branchingEnabled === false` (read from `/api/ChatConfig`) | `<ui5-message-strip design="Information">` shown above the form: "Branching is currently disabled platform-wide. Your preferences will be saved and will activate when branching is turned on." |

### 6.4 Master flag interaction

`ChatSettings.branchingEnabled` (PR 1, default off) gates the engine's branching code paths. PR 6's profile entity + UI ship **regardless** — preferences are useful as user-data even when branching is off (a "what we'd recommend" preview for v2). Engine-side, `pickBranch` only consults `profile.*` when invoked from a branching code path that's already gated by the flag. So PR 6 is flag-independent on the user-write side; **the "branching is currently disabled but you've set preferences" UX is acceptable** — preferences become a no-op signal that activates when the flag flips.

## 7. Components in detail

### 7.1 Files (summary)

| File | Action | LoC est |
|---|---|---|
| `db/schema.cds` | append entity + add `branchingEnabled : Boolean default false` to `ChatSettings` (verify field is absent before adding) | ~12 |
| `db/audit-logging.cds` | annotate (cascade-delete) | ~5 |
| `srv/developer-service.cds` | append projection + action; **extend `ChatConfig` projection to include `branchingEnabled`** (~1 LoC change to existing `entity ChatConfig as projection on ims.ChatSettings { ID, enabled, bannerText }` → `{ ID, enabled, bannerText, branchingEnabled }` so the Vue island can read the platform-flag state) | ~11 |
| `srv/developer-service.js` | new `setLearningPreferences` handler + before-READ row filter | ~40 |
| `srv/admin-service.cds` | append projection | ~3 |
| `app/admin-annotations.cds` | new admin Fiori Elements list view (I6) | ~15 |
| `srv/lib/branch/profile-fields.js` | new — vocab constants (ESM) | ~10 |
| `srv/lib/branch/profile-override.js` | new — override parser (`Tutorial.Author` OR `Admin`) | ~25 |
| `srv/lib/branch/loaders.js` | rewrite `loadProfile` body (keep try/catch) | ~15 (replace) |
| `srv/lib/branch/user-state.js` | add override param + merge | ~5 |
| `srv/lib/branch/decide.js` | extract + pass override at express callsite | ~3 |
| `srv/lib/branch/mission-detail.js` | extract + pass override at express callsite | ~3 |
| `hugo-apps/src/me/LearningPreferences.vue` | new island — explicit Save button, branching-disabled strip + ChatConfig fetch (I7) | ~110 |
| `hugo-apps/src/me/main.ts` | mount the new island alongside existing MyCompletions | ~3 |
| `hugo-apps/vite.config.ts` | (no entry change — `me` entry already exists) | 0 |
| `hugo/layouts/me/list.html` | append mount-point div inside existing QA-gate `{{ if not site.Params.qa }}` block | ~1 |
| `docs/authors/branching-cookbook.md` | append override section (`#debug-override` anchor) | ~30 |
| `docs/authors/pilot-runbook.md` | new | ~80 |
| `docs/.vitepress/config.ts` | sidebar entry for runbook (under existing "Branching paths" group, after "Reading branch telemetry") | ~1 |
| Tests (unit + hybrid + Vue + smoke) | new + extensions | ~210 |

**~17 new/modified files. No new npm dependencies.**

### 7.2 Action handler shape + before-READ row filter

```js
// srv/developer-service.js — INSIDE the existing class DeveloperService extends cds.ApplicationService
// (handlers register on `this`, not a free `srv` variable; mirrors the existing class shape verbatim).

import { PROFILE_FIELDS, PROFILE_VOCAB } from './lib/branch/profile-fields.js';

export default class DeveloperService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { Users: dbUsers, UserLearningPreferences } =
      cds.entities('com.sap.developers.ims');

    // ... existing handlers (CREATE TaskRecords, getProgress, completeStep, …) unchanged …

    // Self-service row filter: scope every READ on LearningPreferences to the caller.
    // The XSUAA gate (`@requires: 'authenticated-user'` on the projection) already
    // guarantees an authenticated user — no defensive 401 needed here.
    this.before('READ', 'LearningPreferences', async (req) => {
      const dbUser = await SELECT.one.from(dbUsers).columns('ID').where({ uuid: req.user.id });
      if (!dbUser?.ID) {
        // No DB user record yet — return empty result set, not an error.
        // Use the CQN builder so we don't fight any pre-existing where clause.
        req.query.where('1 = 0');
        return;
      }
      // CQN builder appends with AND — safe regardless of existing where clause.
      req.query.where({ user_ID: dbUser.ID });
    });

    // Action: PUT-style upsert — all three fields are written; omitted = null.
    this.on('setLearningPreferences', async (req) => {
      // Destructure with explicit null defaults — caller MUST send all three;
      // anything missing is treated as "clear this slot".
      const { deployment = null, role = null, cloud = null } = req.data;

      // Validate each field: null OR a value from the vocab (JS validation layer —
      // CAP's @assert.range fires only at the OData protocol layer, not on programmatic
      // CQL writes from action handlers, so the explicit loop here IS the gate).
      for (const [field, value] of Object.entries({ deployment, role, cloud })) {
        if (value === null) continue;
        if (!PROFILE_VOCAB[field].includes(value)) {
          return req.error(400, `${field}: must be one of [${PROFILE_VOCAB[field].join(', ')}]`);
        }
      }

      // Auto-provision the Users row if this is a first-time-saver (mirrors completeStep
      // pattern at developer-service.js:122-135 — a learner who lands on /me/ before
      // completing any tutorial otherwise hits a hard 404 here).
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

      // PUT-style UPSERT — all three columns get written every time.
      // CAP generic handlers do NOT fire on UPSERT, so we hand-set the managed-aspect
      // modifiedAt/modifiedBy fields explicitly to compensate. createdAt/createdBy are
      // populated by the managed aspect on first INSERT; on subsequent UPSERTs CAP
      // preserves them.
      await UPSERT.into(UserLearningPreferences).entries({
        user_ID: dbUser.ID,
        deployment, role, cloud,
        modifiedAt: req.timestamp,
        modifiedBy: req.user.id,
      });

      return await SELECT.one.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
    });
  }
}
```

The `this.before('READ', ...)` hook implements the per-row filter described in §4.2 — it runs for the DeveloperService projection only. AdminService inherits its own service-level `@requires: 'Admin'` and intentionally has no row filter. There is **no cache-bust call** in the action handler — the engine's mission-detail.js + decide.js caches expire on their own 5-minute TTL (see §5.2).

> **Why explicit `modifiedAt: req.timestamp` (CI4)?** CAP's generic `@cds.on.update` handlers
> attached by the `: managed` aspect run on `UPDATE` events, NOT on `UPSERT`. The Fiori Elements
> admin list view (§7.7) renders `modifiedAt` in its LineItem column, and a `null` or stale
> `modifiedAt` would degrade the list view's usefulness. The explicit assignment in the action
> handler compensates for the managed-aspect skip on UPSERT. `createdAt`/`createdBy` need no
> compensation — the managed aspect populates them on the first INSERT, and CAP's UPSERT preserves
> them on subsequent writes.

> **Cross-user data-leak guard (CB2):** the CQN builder `req.query.where({ user_ID: dbUser.ID })`
> AND-conjoins with any pre-existing where clause (e.g. an admin-impersonation scenario where the
> SELECT already carries a filter). Hand-building CQN tokens with `xpr` arrays gets AND-precedence
> wrong on existing where clauses and is a security boundary; do **not** revert.

### 7.3 Override parser

```js
// srv/lib/branch/profile-override.js (new — ESM)

import { PROFILE_FIELDS, PROFILE_VOCAB } from './profile-fields.js';

/**
 * Extract a validated profile override from an EXPRESS request when the
 * requesting user has Tutorial.Author OR Admin scope. Returns null if no
 * override / not authorised / no valid values. Caller passes the result as
 * opts.override to buildUserState.
 *
 * Invariant: this consumes the express `req` (req.user, req.query as flat
 * map of strings). It is NOT for CAP action handlers — there is no `?profile.*`
 * surface on /api/setLearningPreferences or chat-orchestrator tools.
 */
export function extractProfileOverride(req) {
  const isAuthor = req?.user?.is?.('Tutorial.Author');
  const isAdmin = req?.user?.is?.('Admin');
  if (!isAuthor && !isAdmin) return null;
  const override = {};
  for (const field of PROFILE_FIELDS) {
    const v = req.query?.[`profile.${field}`];
    // Treat empty string the same as missing.
    if (typeof v === 'string' && v !== '' && PROFILE_VOCAB[field].includes(v)) {
      override[field] = v;
    }
  }
  return Object.keys(override).length ? override : null;
}
```

The widened `Tutorial.Author OR Admin` gate lets Tom (an Admin in DEV) test the override on his existing admin login without needing a `Tutorial.Author` role-collection grant. Both author and admin are trusted-internal roles — the override is never exposed to learners.

#### 7.3.1 Callsite integration

Both express callsites (`decideHandler` in `srv/lib/branch/decide.js` and `missionDetailHandler` in `srv/lib/branch/mission-detail.js`) need the same ~3-LoC patch — import `extractProfileOverride`, call it on the express `req`, then pass the result to `buildUserState` via `opts.override`:

```js
// srv/lib/branch/decide.js  AND  srv/lib/branch/mission-detail.js
// (apply the SAME patch to both — pattern is identical)

import { extractProfileOverride } from "./profile-override.js";

// inside the handler, before buildUserState:
const override = extractProfileOverride(req);
const userState = await buildUserState(user, loaders, { override });
```

`extractProfileOverride` returns `null` when the requester lacks `Tutorial.Author`/`Admin` scope or when no valid override values are present, so passing `{ override: null }` is the documented no-op path (see §7.5 — `opts.override?.[f]` short-circuits cleanly on null).

### 7.4 `loaders.js` rewrite

Replace the body of `loadProfile` (lines ~38-63 + the TODO comment block above it). Imports + the file-scope `LOG` declaration are unchanged. The try/catch + `LOG.warn` + return-null shape is kept verbatim — the new body just swaps the key/value reader for a typed read against `UserLearningPreferences`.

```js
// srv/lib/branch/loaders.js — replace the body of loadProfile

async loadProfile(user) {
  if (!user?.id || user.id === 'anonymous') return null;
  try {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
    if (!dbUser?.ID) return null;
    // Defensive: degrade to null if entity not yet deployed (mid-rollout).
    const row = await SELECT.one.from(UserLearningPreferences)
      .where({ user_ID: dbUser.ID });
    return row ? { deployment: row.deployment, role: row.role, cloud: row.cloud } : null;
  } catch (err) {
    LOG.warn(`loadProfile: ${err.message} — degrading to null profile`);
    return null;
  }
}
```

PR 1's reviewer-mandated TODO comment ("Until PR 6 introduces the proper `UserLearningPreferences` entity, loadProfile always returns null") is stripped. The protective try/catch + LOG.warn fallback is preserved so a mid-rollout deployment that hasn't yet run `cds deploy` for the new entity continues to serve the engine with a null profile rather than crashing the read path.

### 7.5 `buildUserState` extension

> **Remove the existing line-9 inline `const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];`
> declaration in `srv/lib/branch/user-state.js`** — the value now comes from `./profile-fields.js`
> (the new constants module in §4.3). Replace with `import { PROFILE_FIELDS } from './profile-fields.js';`
> at the top of the file. Leaving both creates a shadowed binding (the local `const` would win and
> any later edit to `profile-fields.js` would silently fail to propagate to user-state.js).

```js
// srv/lib/branch/user-state.js — add override merge
// PROFILE_FIELDS is imported from ./profile-fields.js (single source of truth)

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

### 7.6 Vue island

```vue
<!-- hugo-apps/src/me/LearningPreferences.vue (new) -->

<template>
  <div class="learning-preferences sapUiSmallMargin">
    <ui5-title level="H3">Learning preferences</ui5-title>
    <ui5-text>Help us personalize tutorial branching. All fields optional.</ui5-text>

    <!-- I7: branching-disabled platform-wide notice -->
    <ui5-message-strip v-if="branchingDisabled" design="Information" :hide-close-button="true">
      Branching is currently disabled platform-wide. Your preferences will be saved
      and will activate when branching is turned on.
    </ui5-message-strip>

    <ui5-label for="deployment">Where do you typically deploy?</ui5-label>
    <ui5-select id="deployment" ref="deploymentRef"
                @change="onChange('deployment', $event)">
      <ui5-option value="__none__" :selected="prefs.deployment === null">— No preference —</ui5-option>
      <ui5-option value="cloud" :selected="prefs.deployment === 'cloud'">Cloud</ui5-option>
      <ui5-option value="onprem" :selected="prefs.deployment === 'onprem'">On-premise</ui5-option>
    </ui5-select>

    <ui5-label for="role">What's your role?</ui5-label>
    <ui5-select id="role" ref="roleRef" @change="onChange('role', $event)">
      <ui5-option value="__none__" :selected="prefs.role === null">— No preference —</ui5-option>
      <ui5-option value="developer" :selected="prefs.role === 'developer'">Developer</ui5-option>
      <ui5-option value="architect" :selected="prefs.role === 'architect'">Architect</ui5-option>
      <ui5-option value="sysadmin" :selected="prefs.role === 'sysadmin'">System administrator</ui5-option>
      <ui5-option value="student" :selected="prefs.role === 'student'">Student</ui5-option>
    </ui5-select>

    <ui5-label for="cloud">Preferred cloud provider?</ui5-label>
    <ui5-select id="cloud" ref="cloudRef" @change="onChange('cloud', $event)">
      <ui5-option value="__none__" :selected="prefs.cloud === null">— No preference —</ui5-option>
      <ui5-option value="btp" :selected="prefs.cloud === 'btp'">SAP BTP</ui5-option>
      <ui5-option value="aws" :selected="prefs.cloud === 'aws'">AWS</ui5-option>
      <ui5-option value="gcp" :selected="prefs.cloud === 'gcp'">Google Cloud</ui5-option>
    </ui5-select>

    <ui5-button design="Emphasized" :disabled="!dirty || saving" @click="onSave">
      {{ saving ? 'Saving…' : 'Save preferences' }}
    </ui5-button>

    <!-- I15: a11y — wrap status strip in role=alert live region for SR announcements -->
    <div role="alert" aria-live="polite">
      <ui5-message-strip v-if="status === 'saved'" design="Positive">Saved.</ui5-message-strip>
      <ui5-message-strip v-if="status === 'error'" design="Negative">
        Couldn't save preferences. Try again.
      </ui5-message-strip>
    </div>
  </div>
</template>
```

**State machine (`'idle' | 'saving' | 'saved' | 'error'`)** — mirrors `TutorialFeedbackForm.vue` precedent (per recon item 10). On mount: `GET /api/LearningPreferences` (404 / null row → all Selects show `__none__` sentinel) AND `GET /api/ChatConfig` to learn `branchingEnabled` (read from the public projection). Each Select `change` event maps `__none__` back to `null` and updates the local `prefs` ref + flips `dirty = true`. The Save button stays disabled until `dirty === true`. On click: POST all three values; show "Saved" strip and reset `dirty = false` after 3s auto-dismiss; on failure, show "Couldn't save" strip and focus the first Select via its `ref` (a11y per I15). The Selects keep the user's chosen values regardless of save outcome — there is no auto-revert.

**Required UI5 imports in `main.ts`:**

```ts
import "@ui5/webcomponents/dist/Select.js";
import "@ui5/webcomponents/dist/Option.js";
import "@ui5/webcomponents/dist/MessageStrip.js";
import "@ui5/webcomponents/dist/Button.js";
import "@ui5/webcomponents/dist/Label.js";
import "@ui5/webcomponents/dist/Title.js";
import "@ui5/webcomponents/dist/Text.js";
```

**Bundle estimate:** Per recon item 8, `hugo-apps/src/me/main.ts` only imports `Timeline` + `TimelineItem`. `Title` + `Text` + `Select` + `Option` + `MessageStrip` + `Button` + `Label` are **all net-new for `me.js`** — strike any "already in the bundle" claim. Honest estimate: ~20-30 kB gzip net add (each web component ≈ 3-5 kB gzip), plus ~3 kB for the Vue SFC itself. Total `me.js` chunk grows from ~12 kB to ~35-45 kB gzip — still well under the 100 kB rule-of-thumb.

**Mount-point div ID:** `me-learning-preferences` (N5).

### 7.7 Admin Fiori Elements list view

```cds
// app/admin-annotations.cds (append; pattern mirrors Events block at lines 41-65)

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

Shape mirrors the canonical Events template in `app/admin-annotations.cds` lines 41-65 (per recon item 9). The `@cds.search` annotation enables the standard Fiori Elements list-page search input over user identity columns. `modifiedAt` is provided by the `: managed` aspect on `UserLearningPreferences`.

### 7.8 Pilot runbook

`docs/authors/pilot-runbook.md` — four-phase checklist:

- **Phase 1 — Pre-pilot:** mission selection criteria, vocab alignment, author readiness.
- **Phase 2: QA pilot** *(heading slug `phase-2-qa-pilot`)*: author writes branches, tests via QA channel, exercises all four debug paths (cloud / onprem / no-override-anonymous / no-override-completed-slug). Deeplinks to the cookbook's [`#debug-override`](../authors/branching-cookbook.md#debug-override) anchor for the override syntax. **Stale-after-write workaround:** if the author has just edited their own preferences and wants to bypass the 5-minute TTL, combine the override with `?nocache=1` (e.g. `?profile.deployment=cloud&nocache=1`) — `decideHandler` and `missionDetailHandler` short-circuit the per-callsite cache when this flag is present.
- **Phase 3 — Production rollout:** flip `ChatSettings.branchingEnabled` (DEV first, then prod), monitor `/admin/analytics/AnalyticsBranchPerformance`, check Branch Performance section in Missions ObjectPage, watch for `branch-staleness` notices.
- **Phase 4 — Iterate / rollback:** thresholds for collapse / tune / investigate; rollback path (`branchingEnabled = false`).

Sidebar placement: added to the existing **Branching paths** group in `docs/.vitepress/config.ts` (lines 92-97), as the **fifth** entry after `Reading branch telemetry`. Single line: `{ text: 'Pilot runbook', link: '/authors/pilot-runbook' }`.

### 7.9 Cookbook extension

`docs/authors/branching-cookbook.md` — append `## Testing your conditions with the debug override` section under a deeplink anchor `#debug-override`. Content: format (`?profile.deployment=cloud&profile.role=architect`), examples, cache-fingerprint note, the `?nocache=1` escape hatch (`?profile.deployment=cloud&nocache=1` bypasses the 5-min TTL when iterating quickly), what happens with invalid values, what happens without `Tutorial.Author` or `Admin` scope, and a back-link to runbook **Phase 2: QA pilot** (`../authors/pilot-runbook.md#phase-2-qa-pilot`) for the canonical pilot-time debug walkthrough.

## 8. Testing strategy

### 8.1 Test surface

| Layer | File | Cases |
|---|---|---|
| Unit | `test/unit/learning-preferences.test.js` | 6 |
| Unit | `srv/lib/branch/__tests__/profile-override.test.js` | 6 |
| Unit | `srv/lib/branch/__tests__/loaders.test.js` (extend) | +2 |
| Unit | `srv/lib/branch/__tests__/user-state.test.js` (extend) | +3 |
| Unit | `scripts/__tests__/profile-fields-sync.test.js` | 1 |
| Vue island | `hugo-apps/src/me/__tests__/LearningPreferences.test.ts` | 5 |
| Hybrid (HANA, opt-in) | `test/hybrid/learning-preferences.test.js` | 3 |
| Smoke (deployed) | `test/smoke/learning-preferences.smoke.test.js` | 2 |

**28 new test cases total.** Existing PR 1–5 tests pass unchanged.

### 8.2 Per-layer coverage

**Unit — `learning-preferences.test.js` (action handler):**

1. `setLearningPreferences({deployment: 'cloud', role: null, cloud: 'btp'})` — UPSERTs row; subsequent SELECT returns `{deployment: 'cloud', role: null, cloud: 'btp'}`
2. **PUT-style clearing:** Re-call with `{deployment: 'onprem', role: null, cloud: null}` — clears prior `role` and `cloud` while setting `deployment: 'onprem'`. Confirms PUT semantics: omitted = cleared, not preserved.
3. Invalid enum (`deployment: 'hybrid'`) — 400 with field-level error message
4. Anonymous caller — 401 (XSUAA gate)
5. `GET /api/LearningPreferences` returns the caller's row only — driven by the `this.before('READ', ...)` hook that appends `where({ user_ID: dbUser.ID })` to the SELECT via the CQN builder
6. `setLearningPreferences` is **role: 'sysadmin'** — confirms `sysadmin` is a valid role enum (regression guard against renaming back to `admin` and colliding with the XSUAA Admin scope)

**Unit — `profile-override.test.js`:**

1. Authenticated `Tutorial.Author` + valid `?profile.deployment=cloud` → returns `{deployment: 'cloud'}`
2. Authenticated **`Admin`** (no `Tutorial.Author`) + same query → returns `{deployment: 'cloud'}` (gate widening per pivot 2)
3. Authenticated non-`Tutorial.Author`, non-`Admin` + same query → returns `null`
4. Anonymous + same query → returns `null`
5. Author + invalid value (`?profile.deployment=hybrid`) → field dropped; if no other valid values → returns `null`
6. **Express query-parser fragility guard:** mock `req.query = { 'profile.deployment': 'cloud', 'profile.role': '' }` — empty-string value dropped (treated as missing); only `deployment` survives. Pairs with smoke test 1 below as a live HTTP check.

**Unit — extend `loaders.test.js` (+2):**

1. `loadProfile` returns `{deployment, role, cloud}` shape from `UserLearningPreferences` (replaces existing key/value test)
2. `loadProfile` returns null when user has no row (anonymous + missing-row paths)

**Unit — extend `user-state.test.js` (+3):**

1. `buildUserState(user, deps, {override: {deployment: 'cloud'}})` merges override over real `{deployment: 'onprem'}` → final `deployment: 'cloud'`
2. Override-merge respects null fields: `override = {deployment: 'cloud'}`, real = `{deployment: 'onprem', role: 'developer'}` → final `{deployment: 'cloud', role: 'developer', cloud: null}`
3. **Fingerprint-cache isolation (CI7):** with `deps.loadProfile` returning `{deployment: 'onprem', role: null, cloud: null}`, assert `fingerprintUserState(buildUserState(u, deps, {override: {deployment: 'cloud'}})) !== fingerprintUserState(buildUserState(u, deps))` — proves override-mode traffic gets a distinct cache slot from the matching learner-mode call (the property §3 architecture relies on for cache safety).

**Unit — `profile-fields-sync.test.js`:**

1. **Schema/vocab sync:** parse `db/schema.cds` via CDS CSN (`cds.compile.to.csn(...)`), extract the enum values for `UserLearningPreferences.deployment`, `.role`, `.cloud`, and assert they match `PROFILE_VOCAB` from `srv/lib/branch/profile-fields.js` exactly. Catches drift if a future PR changes the schema enum but forgets the constants module (or vice versa). Uses the same compiled-CSN technique as PR 1's existing CSN-shape tests.

**Vue island — `LearningPreferences.test.ts`:**

1. Mount → fetches `/api/LearningPreferences` AND `/api/ChatConfig` → renders Selects with current values; Save button disabled (not dirty)
2. Change `deployment` Select → Save button enables → click Save → POST to `/api/setLearningPreferences` with **all three values** (PUT-style); success-strip appears for 3s; Save button disabled again
3. Server returns 500 → negative-strip appears; Selects keep the user's chosen values; first Select gets focus (a11y)
4. **`branchingEnabled` strip toggle:** mock `/api/ChatConfig` to return `{ enabled: true, bannerText: '', branchingEnabled: false }` and assert the Information `<ui5-message-strip>` IS rendered above the form. Re-mount with `branchingEnabled: true` and assert the strip is NOT rendered. (Active assertion on the fetched value — not a tautology; relies on §4.2 ChatConfig projection actually exposing `branchingEnabled`.)
5. **`__none__` round-trip:** initial state has `prefs.deployment === 'cloud'`; user picks "— No preference —" (sentinel `__none__`) → click Save → assert POST body is `{ deployment: null, role: <orig>, cloud: <orig> }` (NOT `deployment: '__none__'`). Guards against sentinel drift junking the DB.

**Hybrid — `learning-preferences.test.js`** (gated by `ALLOW_HYBRID_WRITES=true` + `isSafeForWrites()`):

1. Real HANA: invalid enum value rejected at the **JS validation layer** in the action handler (CAP `@assert.range` is OData-protocol-only and does **not** fire on programmatic CQL writes from action handlers; the action handler's explicit `for (const [field, value] of Object.entries(...)) { if (!PROFILE_VOCAB[field].includes(value)) ... }` loop is the actual gate). The hybrid test calls the action endpoint with `deployment: 'hybrid'` and asserts a 400 surface.
2. Real HANA: schema + UPSERT shape — confirms the entity's PK is the single composition column (`USER_ID`), the FK from `USER_LEARNING_PREFERENCES.USER_ID` to `USERS.ID` enforces referential integrity, a second INSERT for the same user fails with PK-violation (driving the UPSERT path), and a UPSERT with the same payload twice yields the same row (idempotent — row count unchanged)
3. Real HANA: `@PersonalData cascade: 'delete'` removes the row when the parent Users row is deleted (anonymization integration)

**Smoke — `learning-preferences.smoke.test.js`** (HTTP against deployed):

1. `GET /api/LearningPreferences` against deployed srv URL **without** auth → returns 401 (unauthenticated read path is gated; this is the only smoke run in CI)
2. `GET /api/ChatConfig` against deployed srv URL → returns 200 with `{ enabled, bannerText, branchingEnabled }` shape (confirms the public projection used by the Vue island for the branching-disabled strip is reachable unauthenticated and that the `branchingEnabled` field is actually projected — guards against the projection accidentally being narrowed in a future PR)

**Manual override smoke (runbook, not CI):** the `?profile.deployment=cloud` override path requires a `Tutorial.Author` or `Admin` JWT and is exercised manually via the §8.4 checklist + the pilot runbook Phase 2. We do **not** add a CI smoke for the authenticated override path because that would require a new GH secret (per §10 DoD: "no new role-collection or GH secret added").

### 8.3 Conventions

- Test prefix: `__test__-pr6-` for any test users (matches PR 5's `__test__-pr5-` precedent)
- Hybrid uses `ALLOW_HYBRID_WRITES=true` + `isSafeForWrites()` (PR 5's pattern verbatim)
- Smoke uses `SMOKE_BASE_URL` + `SMOKE_SRV_URL` env vars (existing infra)
- **Test commands:** `npm test` (unit), `npm run test:hybrid` (real HANA, requires `cf login`), `npm run test:smoke` (deployed)

### 8.4 Manual verification (PR body checklist)

1. Open `/me/` while logged in → "Learning preferences" panel renders below the existing Recent Activity (MyCompletions) timeline; Save button is disabled (no dirty state)
2. Pick `deployment: cloud` → Save button enables → click "Save preferences" → "Saved" strip appears for ~3s; refresh page → Select shows `cloud`
3. Open a tutorial with a `[BRANCH_BEGIN ... condition="profile.deployment == 'cloud'"]` block → `cloud` branch is the recommendation
4. Append `?profile.deployment=onprem` to the same URL while logged in as a `Tutorial.Author` user → recommendation switches to the on-prem branch
5. **Admin override (pivot 2):** same URL while logged in as Tom (Admin role-collection, no `Tutorial.Author`) → override still applies (recommendation switches)
6. Same URL as a non-author, non-admin user → override is ignored (returns to `cloud`)
7. Trigger account anonymization (admin path) → `UserLearningPreferences` row is removed (audit log entry)
8. **Branching disabled UX (I7):** flip `ChatSettings.branchingEnabled = false` in admin → reload `/me/` → Information `<ui5-message-strip>` appears above the form; preferences still saveable
9. **A11y / SR announcement (I15):** with a screen reader on, click Save with a network error injected → SR announces "Couldn't save preferences. Try again." (live region role=alert); focus moves to first Select

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Override leakage to non-author / non-admin | Low | Two-line `req.user.is('Tutorial.Author') OR req.user.is('Admin')` gate (per pivot 2); tests 3+4 of `profile-override.test.js` cover negative paths |
| Cache poisoning between author/admin + learner | Low | `fingerprintUserState` hashes the merged profile; override-mode produces different fingerprint, separate cache slot in both `mission-detail.js` and `decide.js` per-callsite caches |
| Stale-after-write window for own profile | Low | Up to 5 min until `mission-detail.js` + `decide.js` TTL caches expire (per recon: only `__resetCacheForTest` exported, no per-user invalidator). Acceptable for v1; documented in §5.2; v2 follow-up could add explicit invalidator |
| Schema migration on prod | Low | Net-new entity; CAP/HANA `cds deploy` adds the table cleanly; no data migration |
| Enum mismatch between schema / override-parser allowlist / Vue Select options | Medium | Single source of truth via `srv/lib/branch/profile-fields.js`; **`profile-fields-sync.test.js`** asserts allowlist matches the compiled CSN of `db/schema.cds` (B7) |
| Cookie/JWT scope on `/me/` returning empty | Low | `@requires: 'authenticated-user'` matches existing `MyCompletions` gate |
| Vue island bundle size | Low | New UI5 components (`<ui5-select>`, `<ui5-option>`, `<ui5-message-strip>`, `<ui5-button>`, `<ui5-label>`) add ~15-25 kB gzip to `me.js` (~30-40 kB total chunk, well under 100 kB rule-of-thumb) |
| Concurrent UPSERT race (two browser tabs) | Low | Last-write-wins; preferences are read-mostly; PUT-style semantics make divergence visible (each tab sees the other's clears) |
| Anonymization cascade misses the new entity | Low | The cascade-walker is **annotation-driven** (`srv/lib/anonymization-cascade.js` discovers every `@PersonalData` entity via a CSN walk over `Object.entries(modelDefinitions)` — there is **NO hardcoded allowlist**). The `@PersonalData` block in §4.1 carries `EntitySemantics: 'DataSubjectDetails'` and `cascade: 'delete'`, plus `user @PersonalData.FieldSemantics: 'DataSubjectID'`, so the entity is picked up automatically. Hybrid test 3 verifies cascade-delete in real HANA. |
| `branchingEnabled = false` + user sets preferences | Low | Documented in §6.4; Info `<ui5-message-strip>` shown to user (I7); preferences stored regardless; engine consults only when branching code paths reached |
| Joule narration ignores override (B8) | Low | Documented in §6.2; cookbook callout. Plumbing the override through `chat-orchestrator` deferred to v2 (§11) |

## 10. Definition of Done

- [ ] All 28 tests pass (18 unit including profile-fields-sync, 5 Vue, 3 hybrid, 2 smoke; hybrid optional via `ALLOW_HYBRID_WRITES`)
- [ ] `cds compile srv/developer-service.cds srv/admin-service.cds --to sql` clean
- [ ] Vue island builds clean via `npm run build:apps`
- [ ] `npm run docs:build` passes (sidebar guard accepts the new runbook entry under "Branching paths" → "Pilot runbook")
- [ ] Manual checklist (§8.4) verified against DEV — including the **admin override path** (pivot 2)
- [ ] **Manual override smoke** runbooked, not in CI — CI smoke covers only the unauthenticated read path returning 401 (B10)
- [ ] `@PersonalData` annotation present on `UserLearningPreferences` with `cascade: 'delete'`
- [ ] PR 1's reviewer-mandated TODO comment stripped from `loaders.js`
- [ ] **No new role-collection or GH secret added** — override reuses `Tutorial.Author` OR `Admin` scope (pivot 2); user-side write reuses standard `authenticated-user` gate (M6)
- [ ] **`profile-fields-sync.test.js` passes** — schema enum values match `PROFILE_VOCAB` constants module (B7)
- [ ] **Cache-bust hook NOT added** — write path relies on the existing 5-minute TTL on `mission-detail.js` + `decide.js` caches (B1; documented in §5.2)
- [ ] PR opened against `main`; CI green; manual checklist acknowledged by Tom

## 11. Out of scope (explicit non-goals)

- Multi-language profile labels — platform is en-US-only.
- Profile change history / `@cds.changelog` on user-edited fields.
- Auto-population from event-signup data.
- Multi-tenant boundary considerations.
- Pilot mission selection itself — runbook gives a checklist; the pick happens off-band post-merge.
- Removing the `ChatSettings.branchingEnabled` master flag — operator action documented in runbook Phase 3.
- Multi-field cookbook beyond the existing three patterns + the override section.
- **Plumbing the `?profile.*` override into the Joule narration tool** — the `chat-orchestrator` uses a CAP `req`, not the express request, so the override does not flow through. Authors must clear the override and chat from the unmodified URL to test narration. v2 candidate (B8).
- **Per-user cache invalidator (`bustForUser` / `invalidateForUser`)** — write path relies on the existing 5-minute TTL. v2 candidate if the stale-after-write window proves user-visible (B1).
- **Optimistic concurrency / `@odata.etag` on UPSERT** — no etag header, no version check; last-write-wins is the documented contract for v1 (preferences are read-mostly, two-tab edit divergence is bounded by PUT-style clearing semantics).
- **Admin edit-on-behalf via Fiori Elements** — the AdminService projection is `@readonly` in v1; admins read but do NOT edit user preferences. The user-facing `/me/` panel is the only edit path. v2 candidate if support cases actually require it (CB5).
