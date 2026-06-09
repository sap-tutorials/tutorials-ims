# 172 PR 6 — Pilot Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the profile vocabulary (`deployment / role / cloud`) end-to-end, ship the public profile-page UI for setting preferences, add the `Tutorial.Author`-gated `?profile.X` debug override, write the pilot runbook, and select pilot mission(s) with the curator. After this PR, the pilot author can flip `branchingEnabled = true` on `tutorials-srv-qa` and validate.

> **⚠️ Reviewer addendum (apply before starting — see end of file).** PR 6 plan-review found 5 real issues: (1) `LearningPreferences` projection drops `ID` but the UPDATE handler needs it; (2) `me/main.ts` snippet REPLACES existing `me-completions` mount instead of appending; (3) **profile field validation missing** — schema is free-text `String(20)` with no enum constraint; (4) CJS/ESM convention not verified vs PRs 1–5 (`profile-override.js` snippet uses ESM, must match); (5) `Users` back-association was conditionally suggested — make it unconditional or drop entirely. **See "Reviewer addendum" section at the end of this plan.**

**Architecture:** A new 1:1 entity `UserLearningPreferences` on Users (avoids mixing into the key-value `UserMetaData` entity); a public `DeveloperService.LearningPreferences` projection so the user can edit their own row from the `/me/` page; a small `?profile.<field>=<value>` query-string interceptor in `srv/lib/branch/loaders.js` gated by the existing `Tutorial.Author` XSUAA scope. No production rollout in this PR — `branchingEnabled` stays default-`false`. The runbook documents the QA flip-and-validate flow.

**Tech Stack:** CAP CDS + DeveloperService projection, Vue 3 (existing `me/` page or hugo-apps `me` island), XSUAA scope, vitest unit + smoke.

**Spec section refs:** §4.3 profile vocabulary (`deployment / role / cloud` fixed in v1), §8.4 author validation pilot, §9.1 row 6, §9.2 PR 6 docs (pilot runbook), §9.4 definition of done.

**Depends on:** PR 1–5 merged.

---

## File Structure

**Create (5 files):**
- `db/_user-prefs.cds` — `UserLearningPreferences` entity (1:1 with Users)
- `srv/lib/branch/profile-override.js` — `?profile.<field>=<value>` interceptor (scope-gated)
- `test/branch-profile-override.test.js` — unit tests for the override
- `docs/developers/operations/branching-pilot-runbook.md` — the runbook
- `docs/end-users/learning-preferences.md` — short end-user explainer

**Modify (8 files):**
- `db/schema.cds` — `using` the new file; extend `Users` entity with `learningPreferences: Association to one UserLearningPreferences`
- `srv/lib/branch/loaders.js` — `loadProfile()` now reads `UserLearningPreferences`, with `?profile.X` override gated on `Tutorial.Author` scope
- `srv/developer-service.cds` — projection `LearningPreferences` (anonymous read-only own; authenticated write own)
- `srv/admin-service.cds` — admin can read all (analytics)
- `app/admin-annotations.cds` — `Users` admin Object Page gets a "Learning preferences" facet
- `hugo-apps/src/me/` — extend `/me/` page with a "Learning preferences" panel (deployment/role/cloud dropdowns)
- `.deploy/mta.yaml` — register `srv/lib/branch/profile-override.js` in srv-qa cp list
- `docs/.vitepress/config.ts` — sidebar registration; `docs/end-users/README.md` link

**No new npm dependencies.**

---

## Task 1: `UserLearningPreferences` entity

**Files:**
- Create: `db/_user-prefs.cds`
- Modify: `db/schema.cds`

The existing `UserMetaData` entity is a generic key/value store ([db/schema.cds:127](db/schema.cds#L127)). Adding three named columns there mixes patterns. v1 vocabulary is fixed (`deployment / role / cloud`) and 1:1 with Users — a separate entity is cleaner.

- [ ] **Step 1: Create the entity**

`db/_user-prefs.cds`:

```cds
namespace com.sap.developers.ims;
using { com.sap.developers.ims as ims } from './schema';

// Issue #172 — fixed v1 vocabulary for branching predicates.
// 1:1 with Users so existing key-value UserMetaData stays unchanged.
//
// @PersonalData: profile preferences are personal data (DataSubjectDetails)
// per [[cap_personal_data_entity_semantics]]. Anonymized via the existing
// cascade ([[211_anonymize_cascade_shipped]]) by virtue of `user: Association to Users`.

@PersonalData : { EntitySemantics: 'DataSubjectDetails' }
entity UserLearningPreferences : cuid, managed {
  user        : Association to ims.Users @PersonalData.FieldSemantics: 'DataSubjectID';
  deployment  : String(20)  @PersonalData.IsPotentiallyPersonal;  // 'cloud' | 'onprem'
  role        : String(20)  @PersonalData.IsPotentiallyPersonal;  // 'developer' | 'architect' | 'admin' | 'student'
  cloud       : String(20)  @PersonalData.IsPotentiallyPersonal;  // 'btp' | 'aws' | 'gcp'
}
```

- [ ] **Step 2: `using` the file from `db/schema.cds`**

At the top of `db/schema.cds`, add:

```cds
using from './_user-prefs';
```

If schema.cds doesn't aggregate other partial files, also extend the `Users` entity to expose the back-association:

```cds
entity Users : cuid, managed, LegacyKeyed {
  /* existing fields */
  learningPreferences : Association to UserLearningPreferences on learningPreferences.user = $self;
}
```

- [ ] **Step 3: Smoke**

Run: `npx vitest run --project unit`
Expected: green; entity compiles to in-memory SQLite.

- [ ] **Step 4: Commit**

```bash
git add db/_user-prefs.cds db/schema.cds
git commit -m "feat(172): UserLearningPreferences entity (deployment/role/cloud)"
```

---

## Task 2: Wire `loadProfile()` to read the new entity

**Files:**
- Modify: `srv/lib/branch/loaders.js`

PR 2 stubbed `loadProfile` to degrade-with-warn when the entity didn't exist. Now it does — replace the warn-degraded path with the real read.

- [ ] **Step 1: Edit `loadProfile`**

In `srv/lib/branch/loaders.js`, replace the `loadProfile` body with:

```javascript
async loadProfile(user) {
  if (!user?.id || user.id === 'anonymous') return null;
  try {
    const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
    const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user.id });
    if (!dbUser?.ID) return null;
    const prefs = await SELECT.one.from(UserLearningPreferences)
      .columns('deployment', 'role', 'cloud')
      .where({ user_ID: dbUser.ID });
    return prefs || null;
  } catch (err) {
    cds.log('branch-loaders').warn(`loadProfile failed: ${err.message}`);
    return null;
  }
},
```

(Remove the `UserMetaData` reference that PR 2 placeholdered.)

- [ ] **Step 2: Update / extend the loader test**

In `test/branch-loaders.test.js`, replace the placeholder profile test with a real round-trip:

```javascript
it('loadProfile returns the saved preferences', async () => {
  const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
  const userRow = await SELECT.one.from(Users).where({ uuid: 'xsuaa-9100' });
  await UPSERT.into(UserLearningPreferences).entries({ ID: 'aaaa-9700-0001', user_ID: userRow.ID, deployment: 'cloud', role: 'developer', cloud: 'btp' });

  const loaders = makeBranchLoaders();
  const profile = await loaders.loadProfile({ id: 'xsuaa-9100' });
  expect(profile).toEqual({ deployment: 'cloud', role: 'developer', cloud: 'btp' });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run test/branch-loaders.test.js --project unit`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/branch/loaders.js test/branch-loaders.test.js
git commit -m "feat(172): loadProfile reads UserLearningPreferences"
```

---

## Task 3: `?profile.<field>=<value>` debug override (scope-gated)

**Files:**
- Create: `srv/lib/branch/profile-override.js`
- Test: `test/branch-profile-override.test.js`
- Modify: `srv/lib/branch/mission-detail.js` and `srv/lib/branch/decide-handler.js` (apply the override after `buildUserState`)

- [ ] **Step 1: Failing test**

Create `test/branch-profile-override.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { applyProfileOverride } from '../srv/lib/branch/profile-override.js';

describe('applyProfileOverride', () => {
  it('returns userState unchanged when user lacks Tutorial.Author scope', () => {
    const state = { profile: { deployment: 'cloud', role: 'developer', cloud: 'btp' } };
    const out = applyProfileOverride(state, { 'profile.deployment': 'onprem' }, /* user */ { is: () => false });
    expect(out.profile.deployment).toBe('cloud');
  });

  it('overrides the named field when the user has Tutorial.Author', () => {
    const state = { profile: { deployment: 'cloud', role: 'developer', cloud: 'btp' } };
    const out = applyProfileOverride(state, { 'profile.deployment': 'onprem' }, { is: (s) => s === 'Tutorial.Author' });
    expect(out.profile.deployment).toBe('onprem');
    expect(out.profile.role).toBe('developer');         // untouched
  });

  it('ignores unknown fields', () => {
    const state = { profile: { deployment: 'cloud' } };
    const out = applyProfileOverride(state, { 'profile.unknown': 'x' }, { is: () => true });
    expect(out.profile).toEqual({ deployment: 'cloud' });
  });

  it('ignores anonymous user', () => {
    const state = { profile: { deployment: 'cloud' } };
    const out = applyProfileOverride(state, { 'profile.deployment': 'onprem' }, /* user */ null);
    expect(out.profile.deployment).toBe('cloud');
  });
});
```

- [ ] **Step 2: Run the failing test**

Run: `npx vitest run test/branch-profile-override.test.js --project unit`
Expected: FAIL.

- [ ] **Step 3: Implement**

Create `srv/lib/branch/profile-override.js`:

```javascript
// srv/lib/branch/profile-override.js
//
// Issue #172 §8.4 — author-validation debug. Only effective for users in the
// Tutorial.Author XSUAA scope group; ignored for everyone else.

const PROFILE_FIELDS = ['deployment', 'role', 'cloud'];
const REQUIRED_SCOPE = 'Tutorial.Author';

/**
 * @param {object} userState  — frozen state from buildUserState
 * @param {object} query      — req.query (URLSearchParams already parsed)
 * @param {object} user       — req.user (with .is() per CAP)
 * @returns {object} new state (or the original if no override applies)
 */
export function applyProfileOverride(userState, query, user) {
  if (!user || typeof user.is !== 'function') return userState;
  if (!user.is(REQUIRED_SCOPE)) return userState;

  let touched = false;
  const profile = { ...userState.profile };
  for (const f of PROFILE_FIELDS) {
    const v = query?.[`profile.${f}`];
    if (typeof v === 'string' && v.length) { profile[f] = v; touched = true; }
  }
  if (!touched) return userState;
  return { ...userState, profile: Object.freeze(profile) };
}
```

- [ ] **Step 4: Wire into mission-detail and decide-handler**

In both `srv/lib/branch/mission-detail.js` and `srv/lib/branch/decide-handler.js`, after `userState = await buildUserState(...)`, add:

```javascript
import { applyProfileOverride } from './profile-override.js';
// ...
userState = applyProfileOverride(userState, req.query, req.user);
```

- [ ] **Step 5: Run all branch tests**

Run: `npx vitest run test/branch-profile-override.test.js test/build-catalog-mission-detail.test.js test/api-branches-decide.test.js --project unit`
Expected: green.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/branch/profile-override.js test/branch-profile-override.test.js srv/lib/branch/mission-detail.js srv/lib/branch/decide-handler.js
git commit -m "feat(172): ?profile.X debug override gated by Tutorial.Author scope"
```

---

## Task 4: DeveloperService projection — public read/write own preferences

**Files:**
- Modify: `srv/developer-service.cds`

- [ ] **Step 1: Add the projection**

In `srv/developer-service.cds`, add:

```cds
@requires: 'authenticated-user'
entity LearningPreferences as projection on ims.UserLearningPreferences {
  *
} excluding { ID };
```

The existing DeveloperService instance handler should already filter to "current user only" via `req.user.id` — match whatever pattern it uses for other personal entities (e.g., `getMyCompletedTutorials`).

- [ ] **Step 2: Add a service handler for `getMyLearningPreferences` / `setMyLearningPreferences`**

Add to `srv/developer-service.js`:

```javascript
this.on('READ', 'LearningPreferences', async (req) => {
  const user = req.user?.id;
  if (!user || user === 'anonymous') return req.reject(401);
  const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user });
  if (!dbUser) return [];
  return SELECT.from(UserLearningPreferences).where({ user_ID: dbUser.ID });
});

this.on('CREATE', 'LearningPreferences', async (req) => {
  const user = req.user?.id;
  if (!user || user === 'anonymous') return req.reject(401);
  const { Users } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user });
  if (!dbUser) return req.reject(404);
  // Force user_ID to the authenticated user — never trust the client
  return INSERT.into('LearningPreferences').entries({ ...req.data, user_ID: dbUser.ID });
});

this.on('UPDATE', 'LearningPreferences', async (req) => {
  const user = req.user?.id;
  if (!user || user === 'anonymous') return req.reject(401);
  // Refuse to update someone else's row — match on user_ID = current user
  const { Users } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user });
  return UPDATE('LearningPreferences').set(req.data).where({ ID: req.data.ID, user_ID: dbUser.ID });
});
```

- [ ] **Step 3: Smoke**

Run: `npx vitest run test/developer-service.test.js --project unit`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add srv/developer-service.cds srv/developer-service.js
git commit -m "feat(172): DeveloperService.LearningPreferences (read/write own)"
```

---

## Task 5: `/me/` page — Learning Preferences panel

**Files:**
- Modify: `hugo-apps/src/me/` (find existing source)

- [ ] **Step 1: Find the `/me/` page sources**

```bash
ls D:/projects/tutorials-poc/hugo-apps/src/me/ 2>/dev/null
grep -rn "/me/\|page-slug" D:/projects/tutorials-poc/hugo/layouts/me/ 2>/dev/null | head -10
```

- [ ] **Step 2: Add a `LearningPreferences.vue` SFC**

Create `hugo-apps/src/me/LearningPreferences.vue`:

```vue
<script setup lang="ts">
import { onMounted, ref } from 'vue';

const deployment = ref<string>('');
const role = ref<string>('');
const cloud = ref<string>('');
const recordId = ref<string | null>(null);
const saving = ref(false);
const error = ref<string | null>(null);

const DEPLOYMENT_VALUES = ['', 'cloud', 'onprem'];
const ROLE_VALUES = ['', 'developer', 'architect', 'admin', 'student'];
const CLOUD_VALUES = ['', 'btp', 'aws', 'gcp'];

async function load() {
  try {
    const r = await fetch('/api/LearningPreferences');
    if (!r.ok) return;
    const data = await r.json();
    const row = data?.value?.[0];
    if (row) {
      deployment.value = row.deployment ?? '';
      role.value = row.role ?? '';
      cloud.value = row.cloud ?? '';
      recordId.value = row.ID;
    }
  } catch {}
}

async function save() {
  saving.value = true;
  error.value = null;
  try {
    const body = { deployment: deployment.value || null, role: role.value || null, cloud: cloud.value || null };
    const url = recordId.value
      ? `/api/LearningPreferences(ID=${recordId.value})`
      : '/api/LearningPreferences';
    const method = recordId.value ? 'PATCH' : 'POST';
    const r = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    if (!recordId.value) {
      const created = await r.json();
      recordId.value = created.ID;
    }
  } catch (e: any) {
    error.value = e?.message || 'save failed';
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<template>
  <section class="learning-prefs">
    <h2>Learning preferences</h2>
    <p>Tell us how you learn — we use these to recommend the right path through branched tutorials.</p>

    <label>Deployment
      <select v-model="deployment">
        <option v-for="v in DEPLOYMENT_VALUES" :key="v" :value="v">{{ v || '— not set —' }}</option>
      </select>
    </label>

    <label>Role
      <select v-model="role">
        <option v-for="v in ROLE_VALUES" :key="v" :value="v">{{ v || '— not set —' }}</option>
      </select>
    </label>

    <label>Cloud provider
      <select v-model="cloud">
        <option v-for="v in CLOUD_VALUES" :key="v" :value="v">{{ v || '— not set —' }}</option>
      </select>
    </label>

    <button @click="save" :disabled="saving">{{ saving ? 'Saving…' : 'Save' }}</button>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<style>
.learning-prefs { padding: 1rem 0; max-width: 540px; }
.learning-prefs label { display: block; margin: .5rem 0; }
.learning-prefs select { margin-left: .5rem; padding: .25rem .5rem; }
.learning-prefs .error { color: var(--sapNegativeColor, #b00020); }
</style>
```

- [ ] **Step 3: Mount it from the `me` island entry**

In `hugo-apps/src/me/main.ts`, mount the component on a `<div id="learning-prefs-mount"></div>` placed in `hugo/layouts/me/list.html` (or wherever `/me/` is rendered).

```typescript
import { createApp } from 'vue';
import LearningPreferences from './LearningPreferences.vue';

const el = document.getElementById('learning-prefs-mount');
if (el) createApp(LearningPreferences).mount(el);
```

- [ ] **Step 4: Add the mount point in the Hugo `me` layout**

In `hugo/layouts/me/list.html`, add `<div id="learning-prefs-mount"></div>` in a sensible position (after the existing profile timeline section).

- [ ] **Step 5: Smoke**

Run `npm run dev`, open `http://localhost:1313/me/` (auth'd), verify the panel renders.

- [ ] **Step 6: Commit**

```bash
git add hugo-apps/src/me/LearningPreferences.vue hugo-apps/src/me/main.ts hugo/layouts/me/list.html
git commit -m "feat(172): /me/ page — Learning Preferences panel"
```

---

## Task 6: Pilot runbook

**Files:**
- Create: `docs/developers/operations/branching-pilot-runbook.md`
- Create: `docs/end-users/learning-preferences.md`

- [ ] **Step 1: Write the runbook**

```markdown
# Branching pilot runbook (issue #172)

> **Audience:** Tom + curator/author piloting branching paths in QA before any prod rollout.

## Pre-flight (one-time)

1. Confirm PRs 1–6 are deployed to DEV + QA.
2. `cf login` to the DEV CF target.
3. Verify chat is enabled in QA:
   ```bash
   curl -H "Authorization: Bearer $TOKEN" "$CAP_BASE_URL/admin/ChatSettings(true)"
   ```
   Expect `enabled: true`. If not, use the admin Joule Chat Settings tile.

## Phase 1 — Pick the pilot mission

Candidates (decision in this phase):

| Mission slug | Why | Risk |
|---|---|---|
| `btp-cap-getting-started` | Cloud-vs-onprem deployment is canonical example. | Mission is high-traffic; first impression matters. |
| `abap-cloud-get-started` | Same shape, lower traffic. | Smaller signal in telemetry. |
| Custom mission with `__PILOT__` prefix | Zero blast radius. | No real learners → no real signal. |

**Decision criterion:** pick the smallest mission that has at least 2 plausibly-distinct paths AND traffic > 50/day in the last 30 days. Use `/admin/ChangeLog` filtered by mission to verify recent activity.

## Phase 2 — Author the alt-group

1. Open `/admin-ui/#missions` on QA.
2. Find the pilot mission, open its Path.
3. For two existing TUTORIAL items at the same itemOrder (or move them to share one):
   - Set `altGroupKey: 'deployment'` on both
   - Set `altGroupLabel: 'HANA Cloud'` and `'PostgreSQL'`
   - On the cloud one, set `altCondition: profile.deployment == 'cloud'`
   - Leave the postgres one's condition blank (deterministic-default fallback)
4. Save.
5. Verify validator did NOT reject (no toast errors).

## Phase 3 — Author a step-level branch (optional)

In the contribution repo for one tutorial in the mission, edit the markdown:

```md
### Step 3 — Configure your runtime

[BRANCH_BEGIN group="deployment" key="cloud" label="BTP" condition="profile.deployment == 'cloud'"]
### Step 3a — On BTP
…
[BRANCH_END]

[BRANCH_BEGIN group="deployment" key="onprem" label="On-prem"]
### Step 3a' — Locally with Docker
…
[BRANCH_END]

### Step 4 — Continue
```

PR + merge in the contribution repo. The QA `rebuild-content-qa.yml` will re-fetch and re-publish.

## Phase 4 — Flip the master flag on QA

```bash
cf target -s qa  # or whatever space hosts tutorials-srv-qa
curl -X PATCH \
     -H "Authorization: Bearer $TOKEN_QA" \
     -H "Content-Type: application/json" \
     -d '{"branchingEnabled": true}' \
     "$CAP_BASE_URL_QA/admin/ChatSettings(true)"
```

Verify: `GET /api/branches/decide?slug=<pilot-tutorial-slug>` should now return 200, not 404.

## Phase 5 — Validate as the author

1. Open the pilot mission in QA approuter (XSUAA-authenticated, `Tutorial.Author` scope).
2. Set your learning preferences via `/me/` → Learning preferences → Deployment: cloud.
3. Open the mission. Mission side-nav should show alt-group chips with HANA Cloud highlighted ★.
4. Open the pilot tutorial. Branch picker should show with HANA Cloud selected.
5. Use `?profile.deployment=onprem` in the URL → recommendation flips to on-prem.
6. Open the Joule FAB on the tutorial; ask "should I do HANA or Postgres here?"
   - LLM should call `getBranchRecommendation`
   - Response should reference "your profile (cloud deployment)" and the alternative

## Phase 6 — Validate as a fresh learner

1. Use a different XSUAA test user (no preferences set).
2. Open the same pilot mission. Recommendation should be deterministic-default (first branch) since no condition matches and no completion history exists.
3. Complete a related tutorial (anything that's expected to "vote" for one branch via co-completion). Re-open the mission. Recommendation may shift if the ranker has signal.

## Phase 7 — Collect telemetry

After 7 days of QA traffic:

1. Open `/analytics-ui/` and run:
   ```sql
   SELECT branchPointId, total, followed, overridden, avgConfidence
     FROM AnalyticsBranchPerformance
    WHERE missionSlug = '<pilot>'
    ORDER BY total DESC;
   ```
2. Open the Mission Object Page in `/admin-ui/#missions` — Alt-group performance tile should match.

## Decision: ship to prod, or iterate

| Signal | Action |
|---|---|
| Followed/total > 70% | Ship — recommendation is landing. |
| Followed/total ~50% | Iterate — refine condition or relabel branches. |
| Followed/total < 30% | Rethink — recommendation is wrong; turn off `branchingEnabled` and rework. |
| Tile shows zero rows | Wait — not enough traffic; revisit in 7 more days. |

To ship to prod, run the same flag-flip as Phase 4 against the prod ChatSettings (NOT casual — confirm with Tom first per [[feedback_confirm_deploy_scope]]).

## Rollback

`branchingEnabled = false` is instant: clears the recommendation field server-side; the Vue island degrades to "show all branches, no highlight." No client-side cleanup required. The data model (alt-group columns + branch markdown) is still in place — flipping the flag back on is non-destructive.

## See also

- [Authoring branched missions](../../authors/branched-missions.md)
- [Authoring branched tutorials](../../authors/branched-tutorials.md)
- [Branching cookbook](../../authors/branching-cookbook.md)
- [Branching paths design (issue #172)](../../superpowers/specs/2026-06-09-172-branching-paths-design.md)
```

- [ ] **Step 2: End-user explainer**

Create `docs/end-users/learning-preferences.md`:

```markdown
# Learning preferences

The `/me/` page lets you set three preferences:

- **Deployment** — `cloud` or `onprem`. Some tutorials and missions have alternate paths for cloud vs on-premise stacks.
- **Role** — `developer`, `architect`, `admin`, or `student`. Used to tailor recommendations.
- **Cloud provider** — `btp`, `aws`, or `gcp`. Used when multiple cloud stacks have alternate paths.

These preferences only influence which branch is **highlighted** as recommended. You can always pick any branch — recommendations are hints, not gates.

We never share these preferences. If you want them gone, set each one back to "— not set —" and save, or delete your account (which anonymizes them via the existing privacy cascade).
```

- [ ] **Step 3: Sidebar registration**

In `docs/.vitepress/config.ts`, add both new pages.
In `docs/end-users/README.md` and `docs/developers/operations/README.md` (if it exists), add links.

- [ ] **Step 4: Build docs**

Run: `npm run docs:build`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add docs/developers/operations/branching-pilot-runbook.md docs/end-users/learning-preferences.md docs/.vitepress/config.ts docs/end-users/README.md
git commit -m "docs(172): pilot runbook + end-user learning-preferences explainer"
```

---

## Task 7: srv-qa cp list

**Files:**
- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Append `profile-override.js` to the cp list**

- [ ] **Step 2: Verify**

```bash
grep -q "branch/profile-override.js" D:/projects/tutorials-poc/.deploy/mta.yaml && echo OK
```

- [ ] **Step 3: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore(172): register profile-override in srv-qa cp list"
```

---

## Task 8: Final-branch sanity, push, PR

- [ ] **Step 1: Run the full unit project**

Run: `npx vitest run --project unit`
Expected: green.

- [ ] **Step 2: Run smoke**

Run: `npx vitest run --project smoke`
Expected: still green; existing flows unchanged.

- [ ] **Step 3: Verify file invariants**

```bash
file D:/projects/tutorials-poc/srv/lib/branch/profile-override.js D:/projects/tutorials-poc/db/_user-prefs.cds
grep -q "profile-override.js" D:/projects/tutorials-poc/.deploy/mta.yaml && echo OK
```

- [ ] **Step 4: Push + PR**

```bash
git push origin feat/172-branching-paths-design
gh pr create \
  --title "feat(172): pilot enablement — UserLearningPreferences, /me/ panel, runbook" \
  --body "PR 6 of #172 plan (final). Wires the profile vocabulary end-to-end and ships the pilot runbook. branchingEnabled stays default-false. See plan: docs/superpowers/plans/2026-06-09-172-branching-pr6-pilot-enablement.md" \
  --base main
```

---

## Definition of done for PR 6

- [ ] All 8 tasks complete and committed
- [ ] `UserLearningPreferences` deploys to in-memory SQLite + HANA hybrid
- [ ] `/me/` page renders the new panel; round-trip save → load works
- [ ] `?profile.X` override gated by `Tutorial.Author` scope; ignored otherwise
- [ ] Pilot runbook published; sidebar updated; `npm run docs:build` green
- [ ] PR opened against `main`
- [ ] **`branchingEnabled` stays false in prod** — no flip-the-flag in this PR

## Cross-references

- Closes the loop on PR 1's `loadProfile` placeholder.
- Closes the v1 issue #172 acceptance criterion: "decide on data model" (PRs 1–3) + "pilot on one mission and validate with authors" (PR 6 runbook).
- After this PR, the pilot is run by Tom + curator on QA per the runbook. Issue #172 stays open until the pilot's "decision: ship to prod" step is taken.

---

## Reviewer addendum (apply before starting)

Plan-review found 5 real issues.

### A. Drop `excluding { ID }` from the projection

In **Task 4 Step 1**, the projection drops `ID`, but the UPDATE handler in Step 2 needs `req.data.ID` to resolve the row. Fix one of:

- Remove `excluding { ID }` so the projection exposes the primary key.
- OR update the UPDATE handler to upsert by `user_ID` only (it's a 1:1 with Users):

```javascript
this.on('UPDATE', 'LearningPreferences', async (req) => {
  const user = req.user?.id;
  if (!user || user === 'anonymous') return req.reject(401);
  const { Users } = cds.entities('com.sap.developers.ims');
  const dbUser = await SELECT.one.from(Users).columns('ID').where({ uuid: user });
  if (!dbUser) return req.reject(404);
  return UPDATE('LearningPreferences').set(req.data).where({ user_ID: dbUser.ID });
});
```

Preferred: keep `ID` in the projection (don't `excluding`) — simpler downstream OData PATCH.

### B. `me/main.ts` — APPEND, don't replace

The existing `hugo-apps/src/me/main.ts` already mounts a `MyCompletions` component to `#me-completions` (PR #30 / [[U17 Profile Timeline]]). **Task 5 Step 2's snippet must be appended, not replace the file.** The corrected snippet:

```typescript
// hugo-apps/src/me/main.ts (APPEND below the existing imports + MyCompletions mount)

import LearningPreferences from './LearningPreferences.vue';

const prefsEl = document.getElementById('learning-prefs-mount');
if (prefsEl) createApp(LearningPreferences).mount(prefsEl);
```

If `createApp` isn't already imported in main.ts, the existing file will already import it for `MyCompletions` — confirm before adding.

### C. Schema-level value validation

**Task 1 Step 1** uses `String(20)` with no enum constraint. Spec §4.3 names a fixed v1 vocabulary, but free-text strings let `deployment = 'random-garbage'` slip through. Replace `String(20)` with explicit enums:

```cds
@PersonalData : { EntitySemantics: 'DataSubjectDetails' }
entity UserLearningPreferences : cuid, managed {
  user        : Association to ims.Users @PersonalData.FieldSemantics: 'DataSubjectID';
  deployment  : String enum { cloud; onprem }                @PersonalData.IsPotentiallyPersonal;
  role        : String enum { developer; architect; admin; student } @PersonalData.IsPotentiallyPersonal;
  cloud       : String enum { btp; aws; gcp }                @PersonalData.IsPotentiallyPersonal;
}
```

Add a unit test that asserts a write of an out-of-vocabulary value fails with a CDS validation error.

### D. CJS vs ESM convention

Verify `srv/lib/branch/profile-override.js` matches the import style of PRs 1–5 (which use `import`/`export` ESM per `package.json` `"type": "module"`). The plan uses ESM — should be correct, but **read the package.json `type` field before adding** and match neighboring files in `srv/lib/branch/` regardless.

### E. `Users` back-association

**Task 1 Step 2** says "If schema.cds doesn't aggregate other partial files." Make this unconditional — `db/schema.cds` is the aggregator and the back-association is harmless even if `loadProfile` doesn't use it. Or drop entirely if you confirm `loadProfile`'s `where({ user_ID: dbUser.ID })` works without it. Don't leave it conditional.

```cds
// In Users entity body, append:
learningPreferences : Association to UserLearningPreferences on learningPreferences.user = $self;
```

### F. Hybrid test for the new entity

Add **Task 1.5: hybrid smoke** that writes/reads a `UserLearningPreferences` row on real HANA:

```javascript
// test/hybrid/user-learning-preferences.test.js
import { describe, it, expect } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const project = cds.test.in(__dirname).profile('hybrid');

describe.skipIf(process.env.ALLOW_HYBRID_WRITES !== 'true')(
  'hybrid: UserLearningPreferences round-trip on real HANA',
  () => {
    it('inserts and reads back a row', async () => {
      if (!isSafeForWrites()) throw new Error('refusing to write to a prod-shaped target');
      const { Users, UserLearningPreferences } = cds.entities('com.sap.developers.ims');
      const someUser = await SELECT.one.from(Users).columns('ID');
      if (!someUser) return; // empty hybrid DB; skip silently
      const PREF_ID = `aaaa-9700-${Date.now().toString(36).padEnd(12, '0').slice(0, 12)}`;
      await UPSERT.into(UserLearningPreferences).entries({ ID: PREF_ID, user_ID: someUser.ID, deployment: 'cloud', role: 'developer', cloud: 'btp' });
      try {
        const row = await SELECT.one.from(UserLearningPreferences).where({ ID: PREF_ID });
        expect(row).toMatchObject({ deployment: 'cloud', role: 'developer', cloud: 'btp' });
      } finally {
        await DELETE.from(UserLearningPreferences).where({ ID: PREF_ID });
      }
    });
  }
);
```

Per [[project_qa_shared_aspects]], MTA deploys break on column-type or annotation issues only at deploy time; this catches them earlier.

### G. Misc

- **PROFILE_FIELDS DRY** — define once in `srv/lib/branch/condition.js` (or `user-state.js`) and import. Currently duplicated in `profile-override.js` and `user-state.js` (PR 1).
- **Task 5 toast** — add a `<ui5-toast>` "Preferences saved" on success, matching [[U10 Toast]].
- **Task 6 runbook Phase 4** — verify `ChatSettings(true)` is the actual sentinel by inspecting an existing PATCH against `ragEnabled`/`codeCheckEnabled` (the project may use the singleton-ID PATCH path instead — `ChatSettings(00000000-0000-0000-0000-00000000c8a7)`).
- **Task 8 final check** — re-run `npm run docs:build` after sidebar edits.
