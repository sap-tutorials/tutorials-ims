# Advocate email-edit propagation + test fixture lockdown

**Status:** Approved · **Date:** 2026-06-25 · **Author:** Thomas Jung (decisions) + Claude (capture)
**Issue:** [#638](https://github.com/sap-tutorials/tutorials-ims/issues/638)

## 1 — Problem

Two issues, scoped together because they share the same surface (Advocates admin) and the same risk model (admin-edited rows getting overwritten):

1. **Admin-edited Advocates rows got reset on the morning of 2026-06-25.** Tom hit this exact pattern in PR #396 two weeks earlier — `db/data/*Advocate*.csv` files were CSV-seed-overwriting his admin edits. PR #396 removed the CSVs. Today the symptom returned, but no CSV exists in `db/data/`, no `.hdbtabledata` is generated, no runtime code in `srv/` seeds Advocates. The shape of the reset row matches the *unit test fixture* at [test/unit/advocates/api.test.js:13-49](../../../test/unit/advocates/api.test.js#L13-L49) — a hardcoded `slug: 'thomas-jung'`, `firstName: 'Thomas'`, `lastName: 'Jung'`, `title: 'Chief Developer Advocate'`, `bio: 'Builds CAP samples and decommissions Java IMS one endpoint at a time.'`. The test runs against in-memory SQLite via `cds.test('serve', '--in-memory')`, so it should never touch HANA — but an agent in the parent codebase plausibly ran tests pointed at the wrong DB context, or a hybrid-test variant cross-contaminated HANA. Decision: don't trace the exact vector; just rename the fixture so it's obvious test pollution and trivially cleanable.

2. **No way for admins to edit a linked user's email from the Advocate UI.** The Identity tab currently shows `Email (from linked User)` as read-only because Fiori V4 won't edit a value through a foreign-association inline path (`user.email`). Tom wants an editable email field on the Advocate Object Page that writes through to `Users.email`.

## 2 — Decisions captured

Five decisions made during brainstorming on 2026-06-25:

1. **Test fixture lockdown is minimal.** Just rename the seeded slug + identity to `__TEST__`-prefixed strings. **No** CI guard for future CSV re-introductions; **no** forensic trace of which agent wrote to HANA this morning. (Tom: "Minimal: just rename the test fixture slug.")
2. **Email propagation writes through to `Users.email`.** Not a separate `Advocates.contactEmail` column; not a two-field hybrid. The single source of truth stays `Users.email`. Login-break risk is real in theory but mitigated in practice: SAP IDP matches login JWTs to `Users.sapId`, NOT `Users.email` ([srv/lib/resolve-db-user.js:48-57](../../../srv/lib/resolve-db-user.js#L48-L57)). Editing email is a display-field change, not an identity change.
3. **Implementation is a virtual editable element + handler pair** on `AdminService.Advocates`, not a real column. Keeps `Users.email` as the single source of truth, preserves the `@PersonalData` audit chain, and avoids a sync invariant. The virtual `emailEdit : String` is hydrated on-READ from `user.email` and propagated on-SAVE back to `Users.email`.
4. **Validation rejects empty + malformed.** Empty-string is NOT a "clear" operation; unlinking the user is how you remove the email. Validation matrix in §5.
5. **Tom restores his bio/title manually** via the admin UI after this PR deploys. The cleanup script (§4.3) only scrubs `__TEST__`-prefixed rows; it doesn't reconstruct his real row.

## 3 — Architecture

### Two changes in one PR

```
PR scope:
├─ Issue 1: rename unit-test fixtures so they don't shadow real admin data
│  ├─ test/unit/advocates/api.test.js          (slug 'thomas-jung' → '__test__-amer-1')
│  ├─ test/unit/advocates/photo-serve.test.js  (same rename + identity strings)
│  └─ scripts/cleanup-advocate-test-rows.cjs   (new; sibling to existing cleanup-advocate-link-test-rows.cjs)
│
└─ Issue 2: editable email field on AdminService.Advocates
   ├─ srv/admin-service.cds                    (add `virtual null as emailEdit : String(255)`)
   ├─ app/admin-annotations.cds                (#IdentityLink Data value swap user.email → emailEdit)
   ├─ srv/handlers/advocate-email-handlers.js  (new; hydrate-on-READ + propagate-on-SAVE)
   ├─ srv/handlers/advocate-handlers.js        (register new handlers)
   └─ tests/unit + hybrid + smoke              (6 + 1 + 1 cases)
```

### Why virtual + handler, not a real column

A duplicate `Advocates.contactEmail` column would:
- create a sync invariant (`contactEmail` vs `Users.email`) that the next maintainer would break
- split the `@PersonalData` annotation chain — `Users.email` is `@PersonalData.IsPotentiallyPersonal`, a duplicate column would need the same annotation independently
- break `/api/advocates` consumers expecting one canonical email source
- require migration code to copy existing `Users.email` values into the new column

Virtual + handler keeps `Users.email` as the single source of truth and the audit-logging plugin captures the write automatically.

### Identity model — why email-edit is safe

Login matches on `Users.sapId` (I-number from JWT's `user_uuid` claim), not `Users.email`. From [srv/lib/resolve-db-user.js:48-57](../../../srv/lib/resolve-db-user.js#L48-L57):

```js
export function resolveUserSapId(user) {
  if (!user || !user.id || user.id === 'anonymous') return null;
  const t = user.authInfo?.token;
  if (t?.userId) return t.userId;                       // XSUAA via @sap/xssec
  if (t?.payload?.user_uuid) return t.payload.user_uuid;
  return user.id;                                       // fallback
}
```

Subsequent logins won't overwrite admin-set emails because `backfillUserProfile` ([srv/lib/resolve-db-user.js:131-133](../../../srv/lib/resolve-db-user.js#L131-L133)) only fills `email` when it's blank:

```js
if (!dbUser.email && claimEmail) updates.email = claimEmail;
```

So admin edits survive future logins. No code change to `backfillUserProfile` needed.

## 4 — Components

### 4.1 CDS projection change

[srv/admin-service.cds:390](../../../srv/admin-service.cds#L390) — extend the `Advocates` projection:

```cds
@odata.draft.enabled
entity Advocates as projection on ims.Advocates {
  *,
  user.authoredTutorials     as authoredTutorials,
  user.tutorialContributions as contributedTutorials,
  // Virtual editable mirror of user.email. Fiori V4 won't edit through a
  // foreign association inline; the after-READ handler hydrates this from
  // user.email and the before-UPDATE / SAVE-on-drafts handlers propagate
  // it back to Users.email. Spec §4.3.
  virtual null as emailEdit : String(255),
} actions { ... };
```

### 4.2 Annotation swap

[app/admin-annotations.cds:1992-1997](../../../app/admin-annotations.cds#L1992-L1997) — swap the bound property:

```cds
UI.FieldGroup #IdentityLink: {
  Data: [
    { $Type: 'UI.DataField', Value: user_ID,   Label: 'Linked User' },
    { $Type: 'UI.DataField', Value: emailEdit, Label: 'Email' }
  ]
}
```

The label changes from `Email (from linked User)` → `Email` because it's now editable; the "from linked User" qualifier is implicit (the field is in the IdentityLink facet, next to `user_ID`).

No `@Common.FieldControl` dynamic readonly — instead, the before-UPDATE handler rejects writes with `EMAIL_REQUIRES_LINKED_USER` when `user_ID` is null. Simpler than path-bound dynamic field control, and the error message is clearer for admins than a greyed-out field with no explanation.

### 4.3 Server-side handler wiring

New file [srv/handlers/advocate-email-handlers.js](../../../srv/handlers/advocate-email-handlers.js), registered from [srv/handlers/advocate-handlers.js:51](../../../srv/handlers/advocate-handlers.js#L51) right after the existing `Advocates`/`AdvocatePhotos` destructure.

| Hook | Phase | Behavior |
|---|---|---|
| `after('READ', 'Advocates')` | hydrate | For each row with `user_ID`, fetch `Users.email` and set `row.emailEdit = email`. Batch user lookup: `SELECT ID, email FROM Users WHERE ID IN (…)` per request. |
| `before('UPDATE', 'Advocates')` | propagate | If `req.data.emailEdit !== undefined`: validate (see §5), determine target `user_ID` (from `req.data.user_ID` if changing, else from active row), UPDATE `Users SET email = ? WHERE ID = <user_ID>`, then `delete req.data.emailEdit` so the runtime doesn't try to persist a virtual. |
| `after('UPDATE', 'Advocates')` | re-hydrate | Re-run hydrate logic on the returned row so the response reflects the just-written value. |
| `srv.on('SAVE', 'Advocates.drafts')` | propagate | Same as before-UPDATE — covers the Fiori draft-activate path. Existing precedent at [srv/handlers/advocate-handlers.js:80-81](../../../srv/handlers/advocate-handlers.js#L80-L81) shows the draft-handler pattern. |
| `after('CREATE', 'Advocates')` | nothing | Skip — fresh advocate has no linked user yet; link is set by a follow-up edit. |

**Concurrency / staleness.** The hydrate fills `emailEdit` from current `Users.email`. If two admins draft-edit the same advocate simultaneously, FE V4's existing draft-lock handles it. If admin A changes `user_ID` *and* `emailEdit` in the same save, the propagate handler reads `req.data.user_ID` first, falling back to the active row's `user_ID` only when not changing — so the email lands on the intended user.

**Audit trail.** `Users.email` is annotated `@PersonalData.IsPotentiallyPersonal` in [db/audit-logging.cds](../../../db/audit-logging.cds). The `@cap-js/audit-logging` plugin captures every UPDATE automatically. **No new audit code.**

**Anonymization cascade.** `cascadeNullPersonal` ([srv/lib/anonymization-cascade.js](../../../srv/lib/anonymization-cascade.js)) already NULLs `Advocates.user_ID` on User delete (PR #633), which leaves `emailEdit` empty on the next read. Natural behavior, no extra work.

## 5 — Validation matrix

| Condition | HTTP | Error code | Message |
|---|---|---|---|
| `emailEdit` set, `user_ID` null on active row + not being set in same patch | 400 | `EMAIL_REQUIRES_LINKED_USER` | "Link a user before setting the email." |
| `emailEdit` empty string after trim | 400 | `EMAIL_REQUIRED` | "Email cannot be empty. Unlink the user instead." |
| `emailEdit` fails RFC-5322 shape | 400 | `EMAIL_INVALID` | "Not a valid email address." |
| `emailEdit` length > 254 | 400 | `EMAIL_TOO_LONG` | "Email exceeds 254 characters." |
| `user_ID` references a nonexistent User | 500 | `LINKED_USER_NOT_FOUND` | "Linked user no longer exists." (defensive — FK should catch first) |
| Users UPDATE fails (DB error) | 500 | `USER_UPDATE_FAILED` | error.message |

Validation regex: pragmatic RFC-5322 single-pass, codebase precedent in `srv/lib/feedback-salt.js`. Trim before validating; lowercase before writing (consistent with `backfillUserProfile`).

Errors return via CAP's `req.error(400, code, message)`; audit-logging captures attempts; FE V4 renders inline next to the field via standard message-strip propagation.

## 6 — Test fixture cleanup (Issue 1)

### 6.1 Rename what

Two unit-test files seed `slug: 'thomas-jung'` and friends:

- [test/unit/advocates/api.test.js:13-49](../../../test/unit/advocates/api.test.js#L13-L49)
- [test/unit/advocates/photo-serve.test.js:21-34](../../../test/unit/advocates/photo-serve.test.js#L21-L34)

Both run against in-memory SQLite via `cds.test('serve', '--in-memory')` and should never touch HANA. But on the morning of 2026-06-25 an admin Advocates row on DEV had this exact shape, which means something pointed one of them (or a copy) at the real DB.

### 6.2 What to rename to

```js
// test/unit/advocates/api.test.js  — BEFORE
{
  ID: 'ADC00001-0000-0000-0000-000000000001',
  slug: 'thomas-jung',
  firstName: 'Thomas', lastName: 'Jung',
  title: 'Chief Developer Advocate',
  pronouns: 'he/him', location: 'Houston, TX',
  region: 'AMERICAS', isActive: true,
  bio: 'Builds CAP samples and decommissions Java IMS one endpoint at a time.',
}

// AFTER — matches the __TEST__advocate-link- convention used by test/hybrid/advocate-user-link.test.js
{
  ID: 'ADC00001-0000-0000-0000-000000000001',
  slug: '__test__advocate-link-amer-1',
  firstName: '__TEST__Amer', lastName: 'One',
  title: 'Unit test fixture',
  pronouns: '', location: 'Test, TS',
  region: 'AMERICAS', isActive: true,
  bio: 'Unit test fixture — safe to delete.',
}
```

Same treatment for `placeholder-emea` → `__test__advocate-link-emea-1` and for `photo-serve.test.js`. Hardcoded IDs (`ADC00001-...`) stay (test isolation). All downstream assertions in api.test.js that hardcode `thomas-jung` get the slug rename mechanically (greppable change: lines 162, 209, 221, 229, 237).

`test/chat-context.test.js:77` references `linkedin.com/in/thomas-jung` in a chat-context rendering test — independent fixture, no DB write, leave alone.

### 6.3 Cleanup script

New file [scripts/cleanup-advocate-test-rows.cjs](../../../scripts/cleanup-advocate-test-rows.cjs), sibling to [scripts/cleanup-advocate-link-test-rows.cjs](../../../scripts/cleanup-advocate-link-test-rows.cjs) from PR #557:

```js
// Deletes Advocates rows matching __TEST__ patterns. Dry-run by default;
// --commit to apply. Idempotent. Tom runs once on DEV post-deploy:
//   npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs --commit
//
// Pattern: slug LIKE '__test__%' OR firstName LIKE '__TEST__%' OR slug = 'thomas-jung'
// (the literal 'thomas-jung' is included as a one-time cleanup of the legacy fixture
// shape; can be dropped from the script once DEV is clean.)
```

The legacy `thomas-jung` literal in the cleanup script's WHERE clause is a transitional safeguard for the existing DEV pollution. After Tom runs it once + re-creates his real row, the literal can be dropped in a follow-up PR.

## 7 — What I'm explicitly NOT doing

To keep the PR small and avoid scope creep:

- **No CI guard** for `db/data/*Advocate*.csv` re-introductions (Tom: minimal preference)
- **No forensic trace** of which agent wrote to HANA this morning
- **No `Advocates.contactEmail`** separate field (Tom chose direct propagation)
- **No restoration** of Tom's real advocate row — he'll re-edit via admin UI after the email feature lands
- **No public `/api/advocates` change** — [srv/routes/advocates-public.js:46](../../../srv/routes/advocates-public.js#L46) already exposes `Users.email`; writing through means `/api/advocates` automatically sees the new value on the next request
- **No change** to `backfillUserProfile` — its `if (!dbUser.email && claimEmail)` guard already protects admin overrides on subsequent logins
- **No `@Common.FieldControl` dynamic readonly** — handler-side rejection is clearer

## 8 — Testing

### 8.1 Unit tests (6 new cases in [test/unit/advocates/api.test.js](../../../test/unit/advocates/api.test.js))

1. **READ hydrate** — POST `/admin/Advocates` with `user_ID` set, GET, assert `emailEdit` matches `Users.email`
2. **READ hydrate when unlinked** — `user_ID` null → `emailEdit` is null
3. **UPDATE propagates** — PATCH `emailEdit='new@sap.com'`, assert `Users.email` reflects the change
4. **UPDATE rejects on unlinked** — PATCH `emailEdit='x@y.com'` on unlinked advocate → 400 `EMAIL_REQUIRES_LINKED_USER`
5. **UPDATE rejects malformed** — PATCH `emailEdit='not-an-email'` → 400 `EMAIL_INVALID`
6. **Draft-activate propagates** — PUT to draft, set `emailEdit`, activate, assert `Users.email` updated (covers `SAVE on .drafts`)

### 8.2 Hybrid test (1 new case in [test/hybrid/advocate-user-link.test.js](../../../test/hybrid/advocate-user-link.test.js))

7. **emailEdit round-trip on HANA** — create `__TEST__advocate-link-email` advocate + user, link them, PATCH `emailEdit`, verify `Users.email` updated, clean up. Skipped without `ALLOW_HYBRID_WRITES=true`.

### 8.3 Smoke test (1 new case in [test/smoke/advocates-user-link.smoke.test.js](../../../test/smoke/advocates-user-link.smoke.test.js))

8. **emailEdit is exposed on `/admin/Advocates` $metadata** — proves the projection change reached the deployed srv. Read-only check, no writes.

### 8.4 Regression coverage

Existing tests that must keep passing:
- 68 advocate tests cited in PR #557
- 4 advocate-user-link unit cases + 4 smoke cases from PR #633

## 9 — Build & deploy sequence

1. CDS-only change (projection adds virtual element; annotation swaps bound property) + JS handlers + tests. **No** `db/schema.cds` change → **no** HDI ALTER TABLE → **no** `db/last-dev/` regeneration.
2. `cds build` refreshes `srv-gen/` CSN (counts as service-only change for schema-drift CI). Run locally with `npx cds build --production` before push so staging-csn diff lands in same commit.
3. `npm run build:all` + `cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.resolved.mtaext -f` (standard local-deploy path per CLAUDE.md).
4. Post-deploy smoke: `curl -s https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/admin/$metadata | grep emailEdit` should show the property.
5. Tom runs cleanup: `npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs --commit` against DEV.

## 10 — Rollback

Purely additive change. To revert:

1. Restore annotation Value `emailEdit` → `user.email` in [app/admin-annotations.cds:1995](../../../app/admin-annotations.cds#L1995).
2. Drop the new handler registration from [srv/handlers/advocate-handlers.js](../../../srv/handlers/advocate-handlers.js).
3. Drop the `virtual null as emailEdit` line from [srv/admin-service.cds:390](../../../srv/admin-service.cds#L390).

No data migration. The virtual element is non-persisted; removing it leaves no orphan column. `Users.email` rows written through the feature stay intact — they're indistinguishable from rows the admin set via any other path.

## 11 — Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Admin sets a malformed email that matches an unrelated user's identity in a future system | Low | Medium | Validation regex catches malformed shapes; audit log captures who set what when |
| Draft-activate path skipped by handler (CAP draft semantics) | Medium | High (silent data loss) | Hybrid test #7 + the `SAVE on .drafts` hook explicitly cover this; precedent at [srv/handlers/advocate-handlers.js:80-81](../../../srv/handlers/advocate-handlers.js#L80-L81) |
| Cleanup script deletes Tom's real row by accident | Low | High | Dry-run by default; pattern matches `__TEST__` or literal `thomas-jung`; Tom confirms dry-run output before `--commit` |
| Concurrent admin patches to `user_ID` + `emailEdit` race | Low | Medium | Handler reads `req.data.user_ID` before falling back to active row, so the email lands on the intended target user — spelled out in §4.3 |
| Test pollution returns via a different vector | Medium | Low | Out of scope per Tom's minimal preference; if it recurs, add the CI guard in a follow-up |

## 12 — References

- Issue: https://github.com/sap-tutorials/tutorials-ims/issues/638
- PR #396 (removed CSVs): https://github.com/sap-tutorials/tutorials-ims/pull/396
- PR #557 (test-fixture cleanup precedent): https://github.com/sap-tutorials/tutorials-ims/pull/557
- PR #633 (Advocate-User link feature, just merged): https://github.com/sap-tutorials/tutorials-ims/pull/633
- Existing spec: [docs/superpowers/specs/2026-06-25-advocate-user-link-design.md](2026-06-25-advocate-user-link-design.md)
- IDP user-resolution module: [srv/lib/resolve-db-user.js](../../../srv/lib/resolve-db-user.js)
- Audit-logging annotations: [db/audit-logging.cds](../../../db/audit-logging.cds)
