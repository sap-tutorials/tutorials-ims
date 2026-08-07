# Remove "Preferred cloud provider" Preference — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the `cloud` ("Preferred cloud provider?") field from the Learning Preferences UI and every dependency, keeping the separate `deployment` field, and deprecating the HANA column in place (no destructive migration).

**Architecture:** `cloud` is defined once in `srv/lib/branch/profile-fields.js` (`PROFILE_FIELDS` + `PROFILE_VOCAB`) and consumed across the CAP service, Vue island, homepage personalization, branch engine, admin Fiori annotations, and tests. We remove it from the vocab and every consumer, but leave the HANA column in `db/schema.cds` so no `ALTER TABLE DROP COLUMN` runs against live PROD. The generic matchers (`condition.js` `profile.<field>`, `persona-scoring.js` `field:value`) are field-agnostic and need no change.

**Tech Stack:** SAP CAP (Node.js), CDS, Vue 3 + UI5 Web Components (hugo-apps islands), Vitest, HANA Cloud.

## Global Constraints

- **Do NOT remove the `cloud` column from `db/schema.cds`** — deprecate in place (comment only). No migration.
- **Do NOT touch the `deployment` field** (cloud/onprem) anywhere — it is a separate preference that stays.
- Vocabulary single source of truth is `srv/lib/branch/profile-fields.js`; all other cloud references derive from it.
- Action-handler JS validation is the runtime security gate (`@assert.range` fires only at the OData layer) — keep that pattern for the remaining fields.
- Run file-mutating Bash from the worktree path (`cd` inside the worktree before git ops); never `cd` out.
- Windows: subagents may flip LF→CRLF — leave line endings as-is on edited files.

---

### Task 1: Remove `cloud` from the vocabulary source of truth + fix the drift guard

**Files:**
- Modify: `srv/lib/branch/profile-fields.js`
- Modify: `scripts/__tests__/profile-fields-sync.test.ts`

**Interfaces:**
- Produces: `PROFILE_FIELDS = ['deployment', 'role', 'preferredEventRegion']`; `PROFILE_VOCAB` with keys `deployment`, `role`, `preferredEventRegion` (no `cloud`). Every downstream task relies on `cloud` being absent from these exports.

- [ ] **Step 1: Update the drift-guard test first (it will fail until the vocab changes)**

In `scripts/__tests__/profile-fields-sync.test.ts`, narrow the field loop so it no longer asserts `cloud` (the schema retains the column by design, so equality on `cloud` must not be checked):

```typescript
    for (const field of ['deployment', 'role'] as const) {
```

- [ ] **Step 2: Run the drift guard — expect it to FAIL**

Run: `npx vitest run scripts/__tests__/profile-fields-sync.test.ts`
Expected: FAIL — `PROFILE_VOCAB` still has a `cloud` key not being compared, but more importantly the test file changed ahead of the source. (If it passes already, that's fine — proceed.)

- [ ] **Step 3: Remove `cloud` from `profile-fields.js`**

In `srv/lib/branch/profile-fields.js`:
- Change `PROFILE_FIELDS` to:

```javascript
export const PROFILE_FIELDS = ['deployment', 'role', 'preferredEventRegion'];   // #1030
```

- Delete the entire `cloud: [...]` line and its preceding Issue #669 comment block from `PROFILE_VOCAB`, leaving:

```javascript
export const PROFILE_VOCAB = {
  deployment: ['cloud', 'onprem'],
  role: ['developer', 'architect', 'sysadmin', 'student'],
  // #1030 — homepage Row 3 events band region preference.
  // VIRTUAL and ALL are UI modes (never physical regions).
  preferredEventRegion: ['AMERICAS', 'EMEA', 'APJ', 'VIRTUAL', 'ALL'],
};
```

- [ ] **Step 4: Run the drift guard — expect PASS**

Run: `npx vitest run scripts/__tests__/profile-fields-sync.test.ts`
Expected: PASS — schema `deployment`/`role` enums equal `PROFILE_VOCAB`.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/branch/profile-fields.js scripts/__tests__/profile-fields-sync.test.ts
git commit -m "refactor: drop cloud from profile vocab + narrow drift guard"
```

---

### Task 2: Deprecate the HANA `cloud` column in schema (comment only)

**Files:**
- Modify: `db/schema.cds:256-265`

**Interfaces:**
- Produces: `UserLearningPreferences` still declares a `cloud` column (retained, unused). No behavior change.

- [ ] **Step 1: Update the schema comment**

In `db/schema.cds`, replace the Issue #669 comment above the `cloud` line and mark it deprecated. Keep the column line itself:

```cds
  // DEPRECATED (2026-08-07): the "Preferred cloud provider" preference was removed
  // from the UI + service. This column is retained (not dropped) to avoid a
  // destructive ALTER on the live PROD table; it is no longer read or written and
  // stays NULL for new rows. Drop it in a dedicated migration if ever needed.
  // NOTE: intentionally NOT in srv/lib/branch/profile-fields.js PROFILE_VOCAB, so
  // the profile-fields-sync drift guard does not assert this enum.
  cloud          : String(20) @assert.range enum { btp; aws; azure; gcp; alibaba; oracle; ibm; };
```

- [ ] **Step 2: Verify the schema still compiles**

Run: `npx cds compile db/schema.cds > /dev/null && echo COMPILE_OK`
Expected: `COMPILE_OK` (no errors).

- [ ] **Step 3: Commit**

```bash
git add db/schema.cds
git commit -m "chore: mark UserLearningPreferences.cloud deprecated (retained, unused)"
```

---

### Task 3: Remove `cloud` from the CAP DeveloperService (CDS + handler)

**Files:**
- Modify: `srv/developer-service.cds:220-232`
- Modify: `srv/developer-service.js:810-858`
- Test: `test/unit/learning-preferences.test.js`

**Interfaces:**
- Consumes: `PROFILE_VOCAB` (no `cloud`) from Task 1.
- Produces: `setLearningPreferences(deployment, role)` action; `LearningPreferences` projection exposes `user, deployment, role` only.

- [ ] **Step 1: Update the unit test to drop `cloud`**

In `test/unit/learning-preferences.test.js`, remove `cloud` from every request body and assertion. Concretely:
- Test 1: POST body `{ deployment: 'cloud', role: null }`; delete `expect(result.cloud)...`.
- Test 2: seed/POST bodies drop `cloud`; the "clears prior role" title/body drop `cloud`; delete `expect(result.cloud).toBeNull()`.
- Test with `role: 'architect', cloud: 'aws'` (~line 65-71): drop `cloud: 'aws'` from body and from the `toMatchObject`.
- Any remaining `cloud:` keys in bodies/asserts: remove.

(Keep `deployment: 'cloud'` values — that is the `deployment` field, not the removed one.)

- [ ] **Step 2: Run the unit test — expect FAIL**

Run: `npx vitest run test/unit/learning-preferences.test.js`
Expected: FAIL — action still returns `cloud`, or signature mismatch, depending on edit order.

- [ ] **Step 3: Remove `cloud` from the CDS service**

In `srv/developer-service.cds`:
- Projection (~line 220-222):

```cds
  @readonly entity LearningPreferences as projection on ims.UserLearningPreferences {
    user, deployment, role
  };
```

- Action (~line 228-232):

```cds
  action setLearningPreferences(
    deployment : String,
    role       : String
  ) returns LearningPreferences;
```

- [ ] **Step 4: Remove `cloud` from the handler**

In `srv/developer-service.js` `setLearningPreferences` handler (~line 810-858):
- Destructure: `const { deployment = null, role = null } = req.data;`
- Validation loop: `for (const [field, value] of Object.entries({ deployment, role })) {`
- UPDATE `.set({ deployment, role });`
- INSERT entries: `{ user_ID: dbUser.ID, deployment, role },`

- [ ] **Step 5: Run the unit test — expect PASS**

Run: `npx vitest run test/unit/learning-preferences.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/developer-service.cds srv/developer-service.js test/unit/learning-preferences.test.js
git commit -m "feat: remove cloud field from setLearningPreferences service + handler"
```

---

### Task 4: Remove the cloud select from the Vue island

**Files:**
- Modify: `hugo-apps/src/me/LearningPreferences.vue`
- Test: `hugo-apps/src/me/__tests__/LearningPreferences.test.ts`

**Interfaces:**
- Consumes: `PROFILE_VOCAB` (no `cloud`) from Task 1.
- Produces: form with `deployment`, `role`, `preferredEventRegion` selects only; `onSave` POST body `{ deployment, role }`.

- [ ] **Step 1: Update the island tests to drop `cloud`**

In `hugo-apps/src/me/__tests__/LearningPreferences.test.ts`:
- Remove `cloud` keys from every fetched-row fixture and `__post`/`__lastPost` assertions (tests 1, 2, 5, 6). E.g. test 2 asserts `{ deployment: 'cloud', role: null }`; test 5 asserts `{ deployment: null, role: 'developer' }`.
- Test 6: delete the `const cloud = ...` line and its `expect(cloud.value).toBe('btp')` assertion.
- **Delete test 8 entirely** (`8. issue #669: cloud Select renders all major providers`).

- [ ] **Step 2: Run the island tests — expect FAIL**

Run: `cd hugo-apps && npx vitest run src/me/__tests__/LearningPreferences.test.ts`
Expected: FAIL — component still renders `#cloud` / posts `cloud`.

- [ ] **Step 3: Remove the cloud UI + state from the component**

In `hugo-apps/src/me/LearningPreferences.vue`:
- Delete the cloud `<ui5-label for="cloud">` + `<ui5-select id="cloud" ...>` block (template ~line 51-59).
- Delete the `CLOUD_LABEL` const (~line 106-117).
- `ProfileField` type → `'deployment' | 'role'`.
- `prefs` reactive + its type annotation → drop `cloud` (keep `deployment`, `role`, `preferredEventRegion`).
- Delete `const cloudRef = ...`.
- Delete `prefs.cloud = row.cloud ?? null;` in onMounted.
- Delete `syncSelectValue(cloudRef.value, prefs.cloud);` in onMounted.
- Delete the `watch(() => prefs.cloud, ...)` line.
- `onSave` POST body → `{ deployment: prefs.deployment, role: prefs.role }`.
- Error-focus fallback → `const focusable = (deploymentRef.value as any) || (roleRef.value as any);`
- Update the stale comment referencing "Google Cloud" as the last option if it now misleads (optional, keep tidy).

- [ ] **Step 4: Run the island tests — expect PASS**

Run: `cd hugo-apps && npx vitest run src/me/__tests__/LearningPreferences.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/me/LearningPreferences.vue hugo-apps/src/me/__tests__/LearningPreferences.test.ts
git commit -m "feat: remove cloud-provider select from learning-preferences island"
```

---

### Task 5: Remove cloud signals from homepage personalization

**Files:**
- Modify: `srv/lib/homepage/personalized-envelope.js`
- Modify: `hugo-apps/src/homepage-personalizer/mount-for-you.ts`
- Modify: `srv/homepage-service.js:682-708`
- Modify: `srv/lib/mcp-homepage-tools.js:32-48`
- Modify: `srv/homepage-service.cds:102`

**Interfaces:**
- Consumes: profiles now shaped `{ role, deployment }` (no `cloud`).
- Produces: envelope `profile` = `{ role, deployment }`; `videoFilterTags` derived from `btp` only; `rssFilterTags` from role only.

- [ ] **Step 1: Update `personalized-envelope.js`**

- `deriveVideoFilterTags` → drop the cloud push:

```javascript
function deriveVideoFilterTags(_profile) {
  // Cloud-provider fan-out removed (2026-08-07). SAP-first content dominates,
  // so we always seed btp.
  return ['btp'];
}
```

- Delete the `CLOUD_RSS` map; `deriveRssFilterTags`:

```javascript
function deriveRssFilterTags(profile) {
  const tags = new Set();
  for (const t of ROLE_RSS[profile?.role] || []) tags.add(t);
  return [...tags];
}
```

- In `buildEnvelope`'s returned `profile`, drop the `cloud` line → `{ role: p.role ?? null, deployment: p.deployment ?? null }`.

- [ ] **Step 2: Update `mount-for-you.ts`**

- Param type → `{ role?: string | null; deployment?: string | null } | null`.
- Delete the `if (profile.cloud) parts.push(...)` line.

- [ ] **Step 3: Update `homepage-service.js`**

- The `.columns('deployment', 'role', 'cloud', 'preferredEventRegion')` → `.columns('deployment', 'role', 'preferredEventRegion')`.
- The composed `profile` object → drop `cloud: prefsRow?.cloud ?? null,`.

- [ ] **Step 4: Update `mcp-homepage-tools.js` `resolvePersona`**

- `.columns('deployment', 'role', 'cloud')` → `.columns('deployment', 'role')`.
- Returned object → drop `cloud: prefs?.cloud ?? null,`.
- Update the JSDoc `Returns {role, deployment, cloud}` → `{role, deployment}`.

- [ ] **Step 5: Update `homepage-service.cds`**

```cds
  type PersonalizedProfile { role: String; deployment: String; }
```

- [ ] **Step 6: Update the MCP recommend test to not rely on cloud**

In `test/unit/mcp-recommend-tools.test.js`, re-key the seed + `personaTags` off `cloud`:
- Seed row: drop `cloud: 'btp'` (keep `role: 'developer', deployment: 'cloud'`).
- Every `personaTags: ['role:developer', 'cloud:btp']` → `['role:developer', 'deployment:cloud']`.
- Keep the `btp-hana-cloud-intro` slug + its `toContain` assertion (slug text is unrelated to the removed field).

- [ ] **Step 7: Run the affected suites — expect PASS**

Run: `npx vitest run test/unit/mcp-recommend-tools.test.js && cd hugo-apps && npx vitest run src/homepage-personalizer`
Expected: PASS. (If `src/homepage-personalizer` has no `mount-for-you` spec, the CAP-side + island build in Task 7 covers it.)

- [ ] **Step 8: Commit**

```bash
git add srv/lib/homepage/personalized-envelope.js hugo-apps/src/homepage-personalizer/mount-for-you.ts srv/homepage-service.js srv/lib/mcp-homepage-tools.js srv/homepage-service.cds test/unit/mcp-recommend-tools.test.js
git commit -m "feat: drop cloud persona signal from homepage personalization"
```

---

### Task 6: Remove `cloud` from the branch engine + admin Fiori annotations

**Files:**
- Modify: `srv/lib/branch/loaders.js:52-54`
- Modify: `srv/lib/branch/user-state.js:13`
- Modify: `app/admin-annotations.cds:2240-2253`

**Interfaces:**
- Consumes: `UserLearningPreferences` rows (cloud column ignored).
- Produces: `loadProfile` returns `{ deployment, role }`; `EMPTY_STATE.profile` = `{ deployment, role, preferredEventRegion }` (no `cloud`).

- [ ] **Step 1: Update `loaders.js` `loadProfile`**

```javascript
        return row ? { deployment: row.deployment, role: row.role } : null;
```

- [ ] **Step 2: Update `user-state.js` `EMPTY_STATE`**

```javascript
  profile: Object.freeze({ deployment: null, role: null, preferredEventRegion: null }),
```

- [ ] **Step 3: Update admin Fiori annotations**

In `app/admin-annotations.cds` `AdminService.LearningPreferences` `@UI` block:
- `SelectionFields: [ deployment, role ],`
- `LineItem`: delete the `{ Value: cloud },` entry.
- `FieldGroup#General.Data`: delete `{ Value: cloud }`.

- [ ] **Step 4: Verify branch loader unit tests still pass**

Run: `npx vitest run test/unit/branch/loaders.test.js test/branch-loaders.test.js`
Expected: PASS (these don't assert `cloud`; confirm no regression).

- [ ] **Step 5: Verify the model compiles with the annotation change**

Run: `npx cds compile srv --to json > /dev/null && echo COMPILE_OK`
Expected: `COMPILE_OK`.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/branch/loaders.js srv/lib/branch/user-state.js app/admin-annotations.cds
git commit -m "feat: drop cloud from branch loaders, user-state, admin LR annotations"
```

---

### Task 7: Docs + full verification sweep

**Files:**
- Modify: `docs/authors/branching-cookbook.md:131-133`

- [ ] **Step 1: Update the branching cookbook vocab**

In `docs/authors/branching-cookbook.md`, remove the `profile.cloud` line and add a note:

```markdown
- `profile.deployment`: `cloud`, `onprem`
- `profile.role`: `developer`, `architect`, `sysadmin`, `student`

> **Note (2026-08-07):** the `profile.cloud` preference was removed. Conditions
> referencing `profile.cloud` will never match.
```

(Leave the historical `docs/superpowers/plans/2026-06-13-172-...` reference untouched — it is an archived plan.)

- [ ] **Step 2: Full unit suite**

Run: `npm test`
Expected: PASS (in-memory SQLite; incl. drift guard, service handler, mcp-recommend).

- [ ] **Step 3: hugo-apps suite for the touched islands**

Run: `cd hugo-apps && npx vitest run src/me src/homepage-personalizer`
Expected: PASS.

- [ ] **Step 4: Confirm no stray `cloud` references remain in changed surfaces**

Run: `grep -rn "\.cloud\b\|cloud:\|'cloud'\|profile.cloud\|CLOUD_" srv/lib/homepage srv/lib/branch srv/lib/mcp-homepage-tools.js hugo-apps/src/me hugo-apps/src/homepage-personalizer app/admin-annotations.cds | grep -iv "deployment\|hana-cloud\|cap.cloud\|discovery-center\|cloud.sap\|cloud-logging\|cloud-management\|cloud-foundry\|abap-cloud\|deployment: 'cloud'\|'cloud', 'onprem'\|cloud; onprem"`
Expected: no output (every remaining hit is either the `deployment` vocab value or an unrelated URL/product name). Manually eyeball any residual line.

- [ ] **Step 5: Commit**

```bash
git add docs/authors/branching-cookbook.md
git commit -m "docs: remove profile.cloud from branching cookbook vocab"
```

---

## Self-Review

- **Spec coverage:** vocab (T1), schema-deprecate (T2), CAP service+handler (T3), Vue island (T4), homepage personalization incl. video/RSS/because-chip/MCP/CDS type (T5), branch engine + admin Fiori (T6), docs + verification (T7). All spec sections mapped.
- **Drift-guard subtlety:** T1 narrows the guard to `['deployment','role']` because T2 keeps the `cloud` column in the schema but T1 drops it from `PROFILE_VOCAB` — asserting equality on `cloud` would fail by design. Called out in both spec and T1/T2.
- **deployment vs cloud:** every task explicitly preserves `deployment` (including its `'cloud'` enum value). Verification grep in T7 filters `deployment` out.
- **Type consistency:** `loadProfile` → `{deployment, role}`; envelope/persona profiles → `{role, deployment}`; `EMPTY_STATE.profile` retains `preferredEventRegion`. Consistent across T5/T6.
- **No placeholders:** every code step shows the exact replacement.
