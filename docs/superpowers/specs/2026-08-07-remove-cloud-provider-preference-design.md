# Remove "Preferred cloud provider" from Learning Preferences — Design

**Date:** 2026-08-07
**Status:** Approved (design), pending implementation
**Author:** Tom (via Claude Code)

## Motivation

The Learning Preferences form (`/me/`) exposes a **"Preferred cloud provider?"** select
(`cloud` field: `btp`, `aws`, `azure`, `gcp`, `alibaba`, `oracle`, `ibm`). Going forward we
position content on the **SAP Business AI Platform** only, so the cloud-provider preference and
everything that depends on it should be removed.

This is distinct from the **`deployment`** field ("Where do you typically deploy?" → `cloud` /
`onprem`), which is unrelated and **stays**.

## Decisions (locked)

1. **Deprecate the HANA column in place.** The `cloud` column on `UserLearningPreferences`
   remains defined in `db/schema.cds` so no destructive `ALTER TABLE DROP COLUMN`
   (hdbmigrationtable) runs against the live PROD table. It simply stops being read, written, or
   exposed — writes leave it `NULL`. A dedicated migration can drop it later.
2. **Remove the cloud personalization signals.** The homepage personalization code paths that key
   off `cloud` (video filter tags, RSS tags, the "Because you're a … on AWS" chip, the emitted
   `PersonalizedProfile.cloud`) are removed rather than left reading a permanently-null field.

## Scope of change (by layer)

### 1. Vocabulary source of truth
- `srv/lib/branch/profile-fields.js`
  - Remove `'cloud'` from `PROFILE_FIELDS`.
  - Delete the `cloud` key from `PROFILE_VOCAB`.

### 2. DB schema (deprecate in place)
- `db/schema.cds` — **keep** the `cloud` column definition on `UserLearningPreferences`; update
  the comment to mark it deprecated/unused (do not re-wire). No migration.

### 3. CAP service
- `srv/developer-service.cds`
  - `LearningPreferences` projection: drop `cloud` from the column list.
  - `setLearningPreferences` action: remove the `cloud : String` parameter.
- `srv/developer-service.js` (`setLearningPreferences` handler, ~line 810)
  - Stop destructuring / validating / persisting `cloud`. INSERT/UPDATE no longer set it → column
    stays `NULL` for new writes; existing values are untouched (never read).

### 4. Vue island
- `hugo-apps/src/me/LearningPreferences.vue`
  - Remove the cloud `<ui5-label>` + `<ui5-select>` block.
  - Remove `cloudRef`, `CLOUD_LABEL`, `cloud` from the `prefs` reactive + its type, the
    `syncSelectValue` call, the `watch`, and the `onSave` POST body.
  - Remove `cloud` from `ProfileField` union and the error-focus fallback chain.

### 5. Homepage personalization (remove cloud signals)
- `srv/lib/homepage/personalized-envelope.js`
  - `deriveVideoFilterTags`: drop the `profile.cloud` push (still always includes `btp`).
  - Delete the `CLOUD_RSS` map; `deriveRssFilterTags` keeps only the role-based tags.
  - Drop `cloud` from the emitted `profile` object in `buildEnvelope`.
- `hugo-apps/src/homepage-personalizer/mount-for-you.ts`
  - Remove the `if (profile.cloud) parts.push('on …')` clause + `cloud` from the param type.
- `srv/homepage-service.js` — stop selecting `cloud`; drop `cloud` from the composed `profile`.
- `srv/lib/mcp-homepage-tools.js` (`resolvePersona`) — stop selecting/emitting `cloud`.
- `srv/homepage-service.cds` — drop `cloud` from the `PersonalizedProfile` type.

### 6. Branch engine
- `srv/lib/branch/loaders.js` (`loadProfile`) — return `{ deployment, role }` only.
- `srv/lib/branch/user-state.js` — drop `cloud` from `EMPTY_STATE.profile`.
- **No change** to `srv/lib/branch/condition.js` (generic `profile.<field>` parser) or
  `srv/lib/homepage/persona-scoring.js` (generic `field:value` matcher) — both are field-agnostic.
  Any authored branch condition referencing `profile.cloud` will simply never match (dead
  predicate), which is the intended outcome.

### 7. Admin Fiori annotations
- `app/admin-annotations.cds` — remove `cloud` from `AdminService.LearningPreferences`
  `SelectionFields`, `LineItem`, and `FieldGroup#General`.

### 8. Tests
- `scripts/__tests__/profile-fields-sync.test.ts` — narrow the drift-guard field loop from
  `['deployment','role','cloud']` to `['deployment','role']` (schema still *has* the column, but
  it is no longer in `PROFILE_VOCAB`, so asserting equality on `cloud` would fail by design).
- `test/unit/learning-preferences.test.js` — remove `cloud` from request bodies + assertions.
- `test/hybrid/learning-preferences.test.js` — same.
- `hugo-apps/src/me/__tests__/LearningPreferences.test.ts` — drop `cloud` from fetched-row
  fixtures, POST-body assertions, and the `#cloud` DOM reads; **remove test #8** (cloud-vocab
  render guard).
- `test/unit/mcp-recommend-tools.test.js` — re-key the seed + `personaTags` from `cloud:btp` onto
  `role`/`deployment` signals the resolver still carries (persona ranking must still exercise a
  real matching tag).

### 9. Docs
- `docs/authors/branching-cookbook.md` — remove the `profile.cloud` vocab line; note cloud
  targeting is no longer available.

## Non-goals
- No `ALTER TABLE` / column drop.
- No change to the `deployment` field.
- No deploy (handled by the normal deploy flow after merge).

## Verification
- `npx cds compile db/schema.cds` — schema still compiles (column retained).
- `npm test` — unit suite (in-memory SQLite) incl. the drift guard + service handler.
- hugo-apps vitest — the `LearningPreferences.vue` + `mount-for-you` specs.
- Manual read of the rendered `/me/` form has no "Preferred cloud provider" select
  (out of band, post-deploy).

## Rollback
Revert the branch. Because the HANA column is retained, no data is lost and no migration needs
reversing.
