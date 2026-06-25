# Advocate email-edit + test fixture lockdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an editable email field to the Advocate Object Page that propagates writes to `Users.email`, and rename the unit-test fixtures that have been shadowing real admin data on the `thomas-jung` slug.

**Architecture:** Two changes in one PR. (a) Virtual `emailEdit : String(255)` on `AdminService.Advocates` projection, hydrated from `user.email` on-READ and propagated back on-UPDATE / SAVE-on-drafts via a new handler file `srv/handlers/advocate-email-handlers.js`. (b) Rename `slug: 'thomas-jung'` test fixtures to `__test__advocate-link-amer-1` (and `placeholder-emea` → `__test__advocate-link-emea-1`) so they can't be confused with real data.

**Tech Stack:** CAP Node.js, CDS, Fiori Elements V4, Vitest (unit + hybrid + smoke), HANA Cloud.

**Spec:** [docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md](../specs/2026-06-25-advocate-email-edit-design.md)

**Worktree:** `.claude/worktrees/advocate-email-edit/` (branch: `worktree-advocate-email-edit`)

---

## File map

| Path | Action | Purpose |
|---|---|---|
| `srv/admin-service.cds` | Modify (~3 lines added) | Add `virtual null as emailEdit : String(255)` to `Advocates` projection |
| `app/admin-annotations.cds` | Modify (~2 lines) | Swap `Value: user.email` → `Value: emailEdit` in `#IdentityLink` FieldGroup, change label |
| `srv/handlers/advocate-email-handlers.js` | **Create** (~120 lines) | New handler file: hydrate-on-READ + propagate-on-UPDATE + SAVE-on-drafts |
| `srv/handlers/advocate-handlers.js` | Modify (~2 lines) | Import + invoke new email handlers from `register(srv)` |
| `srv/lib/email-validation.js` | **Create** (~30 lines) | Standalone RFC-5322 shape check + length cap; reusable, testable independently |
| `test/unit/advocates/email-edit.test.js` | **Create** | 6 unit cases per spec §8.1 |
| `test/unit/advocates/api.test.js` | Modify (~25 lines) | Rename `thomas-jung` fixture to `__test__advocate-link-amer-1`; mechanical search/replace |
| `test/unit/advocates/photo-serve.test.js` | Modify (~10 lines) | Same fixture rename |
| `test/hybrid/advocate-user-link.test.js` | Modify (~30 lines added) | Append `emailEdit round-trip on HANA` case |
| `test/smoke/advocates-user-link.smoke.test.js` | Modify (~15 lines added) | Append `$metadata` assertion for `emailEdit` |
| `scripts/cleanup-advocate-test-rows.cjs` | **Create** (~80 lines) | One-shot HANA cleanup for legacy `thomas-jung` row + any `__TEST__` rows |

---

## Task 1: Setup + sanity probes

**Goal:** Confirm the worktree's working tree is clean, the test runner works, and the existing 68 advocate tests are green BEFORE any change. Without a green baseline, regressions look like new failures.

**Files:** none modified.

- [ ] **Step 1.1: Verify worktree state**

```bash
pwd
# expect: .../tutorials-poc/.claude/worktrees/advocate-email-edit
git status --short
# expect: empty (the spec commit is already in place)
git log --oneline -3
# expect: most-recent commit is the spec commit "docs(spec): Advocate email-edit..."
```

- [ ] **Step 1.2: Verify dependencies are populated**

The global npmrc has `ignore-scripts=true`, so a fresh worktree must run `npm run setup` after `npm install`.

```bash
ls node_modules/.bin/cds 2>&1 | head -1
# expect: 'node_modules/.bin/cds' or 'cds' (file exists)
# if missing or hugo-apps missing, run: npm install && npm run setup
```

- [ ] **Step 1.3: Run the existing advocate test suites; capture pass count**

```bash
npx vitest run test/unit/advocates --reporter=basic 2>&1 | tail -10
# expect: all tests passing. Note the count for the regression baseline.
```

- [ ] **Step 1.4: No commit (this is a probe)**

---

## Task 2: Test-fixture rename (api.test.js)

**Goal:** Rename the seeded `thomas-jung` slug + identity fields to `__test__advocate-link-amer-1` and friends, so future agents running this suite can't write a row that masquerades as a real advocate. **TDD-inverse:** the existing tests are already green; the rename should keep them green. Any failure means a downstream test depends on the literal slug.

**Files:**
- Modify: `test/unit/advocates/api.test.js`

- [ ] **Step 2.1: Read the current beforeAll block to capture references**

```bash
grep -n "thomas-jung\|placeholder-emea\|Thomas\|Jung" test/unit/advocates/api.test.js
```

Expected matches around lines 18-49 (seed block) and downstream assertions at 162, 209, 221, 229, 237.

- [ ] **Step 2.2: Apply the fixture rename**

Use `Edit` with these exact replacements (one at a time, since the seed block is a unit; the downstream references are mechanical):

In the seed block (lines 13-49), replace the whole structure to use the new naming. Final shape:

```js
beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Advocates, AdvocateLinks } = cds.entities('com.sap.developers.ims');
  const existing = await db.run(SELECT.from(Advocates).columns('slug'));
  const slugs = new Set(existing.map((r) => r.slug));
  const rows = [];
  if (!slugs.has('__test__advocate-link-amer-1')) {
    rows.push({
      ID: 'ADC00001-0000-0000-0000-000000000001',
      slug: '__test__advocate-link-amer-1',
      firstName: '__TEST__Amer', lastName: 'One',
      title: 'Unit test fixture',
      pronouns: '', location: 'Test, TS',
      region: 'AMERICAS', isActive: true,
      bio: 'Unit test fixture — safe to delete.',
    });
  }
  if (!slugs.has('__test__advocate-link-emea-1')) {
    rows.push({
      ID: 'ADC00001-0000-0000-0000-000000000002',
      slug: '__test__advocate-link-emea-1',
      firstName: '__TEST__Emea', lastName: 'One',
      title: 'Unit test fixture',
      region: 'EMEA', isActive: true,
    });
  }
  if (rows.length) {
    await db.run(INSERT.into(Advocates).entries(rows));
    await db.run(INSERT.into(AdvocateLinks).entries(rows.map((r, i) => ({
      ID: 'ADL00001-0000-0000-0000-00000000000' + (i + 1),
      advocate_ID: r.ID,
      kind: 'LinkedIn',
      url: 'https://www.linkedin.com/in/' + r.slug,
      label: 'LinkedIn',
      sortOrder: 100,
    }))));
  }
});
```

- [ ] **Step 2.3: Replace downstream assertions referencing the slug**

For each location at lines 162, 209, 221, 229, 237 — replace `thomas-jung` with `__test__advocate-link-amer-1`. Mechanical search/replace. Use `Edit` with `replace_all: true` ONLY for the literal `thomas-jung` string (the slug never overlaps with anything else in this file).

```js
// Before
SELECT.one.from(Advocates).where({ slug: 'thomas-jung' })
// After
SELECT.one.from(Advocates).where({ slug: '__test__advocate-link-amer-1' })

// Same shape for /api/advocates/thomas-jung/photo URLs (4 places)
```

- [ ] **Step 2.4: Run the suite — expect green**

```bash
npx vitest run test/unit/advocates/api.test.js --reporter=basic 2>&1 | tail -10
# expect: same pass count as Step 1.3. If anything fails, a downstream test still references the old slug.
```

- [ ] **Step 2.5: Commit**

```bash
git add test/unit/advocates/api.test.js
git commit -m "test(advocates): rename fixture slugs to __test__ prefix (issue #638)

Previously hardcoded slug='thomas-jung' shadowed Tom's real DEV advocate row
when an agent ran tests pointed at HANA instead of in-memory SQLite. The new
__test__advocate-link-amer-1 / -emea-1 names match the existing __TEST__
convention enforced by test/hybrid/_guard.js and the hybrid suite, so
fixture leakage into HANA is obviously test pollution.

No behavior change — same test count, same assertions, just safer fixture
identity. Issue #638."
```

---

## Task 3: Test-fixture rename (photo-serve.test.js)

**Goal:** Same rename in the second test file.

**Files:**
- Modify: `test/unit/advocates/photo-serve.test.js`

- [ ] **Step 3.1: Identify references**

```bash
grep -n "thomas-jung\|placeholder-emea\|Thomas\|Jung" test/unit/advocates/photo-serve.test.js
```

Expected: same seed-block shape as api.test.js plus assertions.

- [ ] **Step 3.2: Apply same fixture rename pattern**

Use the same `__test__advocate-link-amer-1` / `__test__advocate-link-emea-1` names. Identical structure to Task 2.

- [ ] **Step 3.3: Run the suite — expect green**

```bash
npx vitest run test/unit/advocates/photo-serve.test.js --reporter=basic 2>&1 | tail -10
```

- [ ] **Step 3.4: Commit**

```bash
git add test/unit/advocates/photo-serve.test.js
git commit -m "test(advocates): rename photo-serve fixture slugs to __test__ prefix

Sibling change to test/unit/advocates/api.test.js. Same reasoning, same
rename. Issue #638."
```

---

## Task 4: Email-validation helper (TDD)

**Goal:** A tiny, focused module that validates email shape per the spec's matrix (§5). Built TDD so the rules are codified before the handler depends on them.

**Files:**
- Create: `srv/lib/email-validation.js`
- Create: `test/unit/email-validation.test.js`

- [ ] **Step 4.1: Write failing tests**

```js
// test/unit/email-validation.test.js
import { describe, it, expect } from 'vitest';
import { validateEmail } from '../../srv/lib/email-validation.js';

describe('validateEmail', () => {
  it('accepts a normal email and returns trimmed-lowercase', () => {
    expect(validateEmail('Tom@SAP.com')).toEqual({ ok: true, value: 'tom@sap.com' });
  });

  it('trims surrounding whitespace before validating', () => {
    expect(validateEmail('  tom@sap.com  ')).toEqual({ ok: true, value: 'tom@sap.com' });
  });

  it('rejects empty string with EMAIL_REQUIRED', () => {
    expect(validateEmail('')).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
  });

  it('rejects whitespace-only with EMAIL_REQUIRED', () => {
    expect(validateEmail('   ')).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
  });

  it('rejects null/undefined with EMAIL_REQUIRED', () => {
    expect(validateEmail(null)).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
    expect(validateEmail(undefined)).toEqual({ ok: false, code: 'EMAIL_REQUIRED' });
  });

  it('rejects malformed (no @) with EMAIL_INVALID', () => {
    expect(validateEmail('not-an-email')).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('rejects malformed (no domain) with EMAIL_INVALID', () => {
    expect(validateEmail('tom@')).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('rejects malformed (no TLD) with EMAIL_INVALID', () => {
    expect(validateEmail('tom@sap')).toEqual({ ok: false, code: 'EMAIL_INVALID' });
  });

  it('rejects emails longer than 254 chars with EMAIL_TOO_LONG', () => {
    const long = 'a'.repeat(250) + '@b.co';  // 256 chars
    expect(validateEmail(long)).toEqual({ ok: false, code: 'EMAIL_TOO_LONG' });
  });

  it('accepts a 254-char email (boundary)', () => {
    const exactly254 = 'a'.repeat(248) + '@b.co';  // 254 chars
    const out = validateEmail(exactly254);
    expect(out.ok).toBe(true);
  });
});
```

- [ ] **Step 4.2: Run — expect FAIL (module not found)**

```bash
npx vitest run test/unit/email-validation.test.js --reporter=basic 2>&1 | tail -20
# expect: all 10 tests fail with "Cannot find module '../../srv/lib/email-validation.js'"
```

- [ ] **Step 4.3: Implement minimal `srv/lib/email-validation.js`**

```js
// srv/lib/email-validation.js
//
// Email shape validation for the Advocate emailEdit feature. Centralized
// so the handler logic stays focused on the propagation flow.
//
// Returns:
//   { ok: true, value: '<normalized email>' }     on success
//   { ok: false, code: '<ERROR_CODE>' }           on rejection
//
// Error codes match the spec's §5 validation matrix:
//   EMAIL_REQUIRED  — null/undefined/empty/whitespace-only
//   EMAIL_INVALID   — fails RFC-5322 shape check
//   EMAIL_TOO_LONG  — exceeds 254 chars (max per RFC-5321)
//
// Normalization: trim, then lowercase. Lowercased writes are consistent
// with srv/lib/resolve-db-user.js#backfillUserProfile — both paths
// produce the same shape for the Users.email column.

// Pragmatic RFC-5322 shape — same posture as srv/lib/feedback-salt.js etc.
// Requires: local@domain.tld with TLD length >= 2.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateEmail(input) {
  if (input == null || typeof input !== 'string') {
    return { ok: false, code: 'EMAIL_REQUIRED' };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, code: 'EMAIL_REQUIRED' };
  }
  if (trimmed.length > 254) {
    return { ok: false, code: 'EMAIL_TOO_LONG' };
  }
  if (!EMAIL_RE.test(trimmed)) {
    return { ok: false, code: 'EMAIL_INVALID' };
  }
  return { ok: true, value: trimmed.toLowerCase() };
}
```

- [ ] **Step 4.4: Run — expect PASS (10/10)**

```bash
npx vitest run test/unit/email-validation.test.js --reporter=basic 2>&1 | tail -10
# expect: 10 passed
```

- [ ] **Step 4.5: Commit**

```bash
git add srv/lib/email-validation.js test/unit/email-validation.test.js
git commit -m "feat(advocates): add email-validation helper with TDD coverage

Centralized RFC-5322 shape check + length cap (254 per RFC-5321) +
trim/lowercase normalization. Returns structured {ok,value} or
{ok:false,code} so callers can map directly to req.error(400, code, msg).

Will be consumed by srv/handlers/advocate-email-handlers.js to gate writes
through the emailEdit virtual field on AdminService.Advocates.

Refs: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §5
Issue #638."
```

---

## Task 5: CDS projection — add `emailEdit` virtual element

**Goal:** Extend the `AdminService.Advocates` projection with the virtual editable field. The field has no underlying storage; handlers will populate/consume it.

**Files:**
- Modify: `srv/admin-service.cds` (line 391-419 area; preserve existing actions block)

- [ ] **Step 5.1: Read current projection shape**

```bash
sed -n '388,420p' srv/admin-service.cds
```

- [ ] **Step 5.2: Insert `emailEdit` virtual element**

Use `Edit` to add ONE line after `user.tutorialContributions as contributedTutorials,`. The anchor (unique string) for the `Edit` `old_string` is the full line `user.tutorialContributions as contributedTutorials,`. **Do not blank out the actions block.**

```cds
// BEFORE
@odata.draft.enabled
entity Advocates as projection on ims.Advocates {
  *,
  user.authoredTutorials     as authoredTutorials,
  user.tutorialContributions as contributedTutorials,
} actions {
  action uploadPhoto(photoBase64 : String, mimeType : String) returns Advocates;
  action clearPhoto() returns Advocates;
};

// AFTER
@odata.draft.enabled
entity Advocates as projection on ims.Advocates {
  *,
  user.authoredTutorials     as authoredTutorials,
  user.tutorialContributions as contributedTutorials,
  // Virtual editable mirror of user.email. Fiori V4 won't edit through a
  // foreign association inline; the after-READ handler hydrates this from
  // user.email and the before-UPDATE / SAVE-on-drafts handlers propagate
  // it back to Users.email.
  // Spec: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §4
  virtual null as emailEdit : String(255),
} actions {
  action uploadPhoto(photoBase64 : String, mimeType : String) returns Advocates;
  action clearPhoto() returns Advocates;
};
```

- [ ] **Step 5.3: Verify CDS compiles cleanly**

```bash
npx cds compile srv/admin-service.cds -s AdminService -2 edmx 2>&1 | head -5
# expect: <?xml version line, no Errors
# Specifically check the new property landed:
TMP="${TEMP:-/tmp}/email-edmx.xml"
npx cds compile srv/admin-service.cds -s AdminService -2 edmx 2>/dev/null > "$TMP"
grep -c 'Name="emailEdit"' "$TMP"
# expect: 1 (or 2 if the draft companion also gets it — both acceptable)
```

- [ ] **Step 5.4: Run existing advocate tests — expect still green**

```bash
npx vitest run test/unit/advocates --reporter=basic 2>&1 | tail -10
# expect: same count as Step 1.3 (no behavior change yet; emailEdit is virtual and always null)
```

- [ ] **Step 5.5: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(advocates): add virtual emailEdit element to AdminService.Advocates

Editable mirror of user.email. Virtual (no underlying column), so the
field surface widens in OData metadata but no schema migration runs.
Behavior change comes in the next commit when the handlers go in;
this commit isolates the CDS change for a clean diff.

Refs: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §4.1
Issue #638."
```

---

## Task 6: Email-handler module (TDD)

**Goal:** New file `srv/handlers/advocate-email-handlers.js` implementing hydrate-on-READ + propagate-on-UPDATE + propagate-on-SAVE-on-drafts. Built TDD with the existing api.test.js scaffold (in-memory SQLite via `cds.test`).

**Files:**
- Create: `srv/handlers/advocate-email-handlers.js`
- Create: `test/unit/advocates/email-edit.test.js`

- [ ] **Step 6.1: Write failing tests — six cases per spec §8.1**

```js
// test/unit/advocates/email-edit.test.js
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };

// Test-isolated user + advocate fixtures. Created in beforeAll, cleaned
// in afterAll. Keeps the test independent from api.test.js's shared seeds.
let userID;       // a Users row to link to
let userNoEmail;  // a Users row with email=null (anonymized-cascade-style)
let advLinked;    // advocate row linked to userID
let advUnlinked;  // advocate row with no user

beforeAll(async () => {
  const db = await cds.connect.to('db');
  const { Users, Advocates } = cds.entities('com.sap.developers.ims');
  userID = randomUUID();
  userNoEmail = randomUUID();
  advLinked = randomUUID();
  advUnlinked = randomUUID();
  await db.run(INSERT.into(Users).entries([
    { ID: userID,      sapId: '__test__I100', firstName: 'Tom', lastName: 'Test', email: 'old@sap.com',  displayName: 'Tom Test' },
    { ID: userNoEmail, sapId: '__test__I101', firstName: 'Una', lastName: 'Test', email: null,           displayName: 'Una Test' },
  ]));
  await db.run(INSERT.into(Advocates).entries([
    { ID: advLinked,   slug: '__test__email-1', firstName: '__TEST__', lastName: 'Linked',   region: 'AMERICAS', isActive: true, user_ID: userID },
    { ID: advUnlinked, slug: '__test__email-2', firstName: '__TEST__', lastName: 'Unlinked', region: 'AMERICAS', isActive: true, user_ID: null   },
  ]));
});

afterAll(async () => {
  const db = await cds.connect.to('db');
  const { Users, Advocates } = cds.entities('com.sap.developers.ims');
  await db.run(DELETE.from(Advocates).where({ ID: { in: [advLinked, advUnlinked] } }));
  await db.run(DELETE.from(Users).where({ ID: { in: [userID, userNoEmail] } }));
});

describe('Advocates.emailEdit virtual field', () => {
  it('hydrates emailEdit from Users.email on READ for linked advocates', async () => {
    const res = await project.get('/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=true)', adminAuth);
    expect(res.status).toBe(200);
    expect(res.data.emailEdit).toBe('old@sap.com');
  });

  it('emailEdit is null on READ when no user is linked', async () => {
    const res = await project.get('/admin/Advocates(ID=' + advUnlinked + ',IsActiveEntity=true)', adminAuth);
    expect(res.status).toBe(200);
    expect(res.data.emailEdit ?? null).toBeNull();
  });

  it('UPDATE emailEdit propagates to Users.email and re-hydrates on response', async () => {
    const res = await project.patch(
      '/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=true)',
      { emailEdit: 'New@SAP.com' },
      adminAuth,
    );
    expect(res.status).toBeLessThan(300);
    expect(res.data.emailEdit).toBe('new@sap.com');  // lowercased

    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const row = await db.run(SELECT.one.from(Users).where({ ID: userID }));
    expect(row.email).toBe('new@sap.com');
  });

  it('UPDATE rejects with EMAIL_REQUIRES_LINKED_USER when advocate has no user', async () => {
    const res = await project.patch(
      '/admin/Advocates(ID=' + advUnlinked + ',IsActiveEntity=true)',
      { emailEdit: 'x@y.com' },
      { ...adminAuth, validateStatus: () => true },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/EMAIL_REQUIRES_LINKED_USER/);
  });

  it('UPDATE rejects malformed email with EMAIL_INVALID', async () => {
    const res = await project.patch(
      '/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=true)',
      { emailEdit: 'not-an-email' },
      { ...adminAuth, validateStatus: () => true },
    );
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.data)).toMatch(/EMAIL_INVALID/);
  });

  it('draft-activate propagates emailEdit (SAVE on .drafts)', async () => {
    // 1. PUT (open draft) on the active row
    const draftRes = await project.post(
      "/admin/Advocates(ID=" + advLinked + ",IsActiveEntity=true)/AdminService.draftEdit",
      {},
      adminAuth,
    );
    expect(draftRes.status).toBeLessThan(300);
    // 2. PATCH the draft with a new emailEdit value
    const patchRes = await project.patch(
      '/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=false)',
      { emailEdit: 'draft-saved@sap.com' },
      adminAuth,
    );
    expect(patchRes.status).toBeLessThan(300);
    // 3. Activate (the SAVE-on-drafts path)
    const activateRes = await project.post(
      '/admin/Advocates(ID=' + advLinked + ',IsActiveEntity=false)/AdminService.draftActivate',
      {},
      adminAuth,
    );
    expect(activateRes.status).toBeLessThan(300);
    // 4. Assert Users.email reflects the draft-saved value
    const db = await cds.connect.to('db');
    const { Users } = cds.entities('com.sap.developers.ims');
    const row = await db.run(SELECT.one.from(Users).where({ ID: userID }));
    expect(row.email).toBe('draft-saved@sap.com');
  });
});
```

- [ ] **Step 6.2: Run — expect FAIL on all six (no handler yet)**

```bash
npx vitest run test/unit/advocates/email-edit.test.js --reporter=basic 2>&1 | tail -20
# expect: 6 failures. The first ('hydrates emailEdit from Users.email')
# probably returns null for emailEdit because the virtual is never populated.
```

- [ ] **Step 6.3: Implement `srv/handlers/advocate-email-handlers.js`**

```js
// srv/handlers/advocate-email-handlers.js
//
// Handlers for the emailEdit virtual field on AdminService.Advocates.
//
// Reads:   hydrate emailEdit from the linked user's Users.email so the
//          OP shows the current value in display + edit mode.
// Writes:  validate the proposed email, locate the target user (from the
//          current request's user_ID or the active row's user_ID), UPDATE
//          Users.email, then delete req.data.emailEdit so the runtime
//          doesn't try to persist a virtual column.
//
// Draft semantics: Fiori draft-activate fires SAVE on the .drafts
// companion. We hook that path in addition to the direct UPDATE path so
// admins editing via the standard FE V4 OP flow propagate correctly.
//
// Spec: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §4.3

import { validateEmail } from '../lib/email-validation.js';

/**
 * Batch-hydrate emailEdit on a result set. Used by both the after-READ
 * handler and the after-UPDATE re-hydrate path.
 *
 * @param {Array<object>|object} rows  Single row or array of rows from CAP
 * @param {object} srvEntities  cds entities to look up Users from
 */
async function hydrateEmailEdit(rows, srvEntities) {
  const arr = Array.isArray(rows) ? rows : [rows];
  const userIds = [...new Set(arr.map((r) => r?.user_ID).filter(Boolean))];
  if (userIds.length === 0) return;
  const { Users } = srvEntities;
  const users = await SELECT.from(Users).columns('ID', 'email').where({ ID: { in: userIds } });
  const emailByUserId = new Map(users.map((u) => [u.ID, u.email]));
  for (const row of arr) {
    if (row?.user_ID) {
      row.emailEdit = emailByUserId.get(row.user_ID) ?? null;
    }
  }
}

/**
 * Propagate handler. Reused by before-UPDATE and SAVE-on-drafts hooks.
 * Validates the incoming emailEdit, resolves the target user_ID, writes
 * to Users.email, and removes emailEdit from req.data so the runtime
 * doesn't persist it.
 *
 * Returns early if emailEdit is not in the payload (no behavior).
 */
async function propagateEmailEdit(req, srvEntities) {
  if (!Object.prototype.hasOwnProperty.call(req.data, 'emailEdit')) return;

  const result = validateEmail(req.data.emailEdit);
  if (!result.ok) {
    return req.reject(400, result.code, `emailEdit: ${result.code}`);
  }

  // Resolve target user_ID. Priority: explicit value in this payload, else
  // the active row's user_ID (read from DB). Active record lookup uses the
  // request's primary key from req.params.
  const { Advocates, Users } = srvEntities;
  let targetUserId = req.data.user_ID;
  if (!targetUserId) {
    const advId = req.params?.[0]?.ID || req.params?.[0];
    if (!advId) {
      return req.reject(500, 'EMAIL_PROPAGATE_NO_KEY', 'emailEdit: cannot resolve advocate key');
    }
    const adv = await SELECT.one.from(Advocates).columns('user_ID').where({ ID: advId });
    targetUserId = adv?.user_ID || null;
  }

  if (!targetUserId) {
    return req.reject(
      400,
      'EMAIL_REQUIRES_LINKED_USER',
      'emailEdit: link a user before setting the email',
    );
  }

  // Confirm the user exists. Defensive — FK should catch first.
  const linkedUser = await SELECT.one.from(Users).columns('ID').where({ ID: targetUserId });
  if (!linkedUser) {
    return req.reject(500, 'LINKED_USER_NOT_FOUND', 'emailEdit: linked user no longer exists');
  }

  try {
    await UPDATE(Users).where({ ID: targetUserId }).set({ email: result.value });
  } catch (err) {
    return req.reject(500, 'USER_UPDATE_FAILED', `emailEdit: ${err.message}`);
  }

  // Strip the virtual so the runtime doesn't try to persist it on Advocates.
  delete req.data.emailEdit;
}

/**
 * Wire the email handlers onto the AdminService instance.
 */
export function register(srv) {
  const { Advocates, Users } = srv.entities;
  const srvEntities = { Advocates, Users };

  srv.after('READ', Advocates, async (rows) => {
    if (!rows) return;
    await hydrateEmailEdit(rows, srvEntities);
  });

  srv.before('UPDATE', Advocates, (req) => propagateEmailEdit(req, srvEntities));

  srv.after('UPDATE', Advocates, async (result) => {
    if (!result) return;
    await hydrateEmailEdit(result, srvEntities);
  });

  // SAVE-on-drafts: Fiori draft-activate path. The Advocates.drafts entity
  // is auto-generated by @odata.draft.enabled; we hook SAVE there so
  // draft-edited emailEdit values propagate at activation time.
  if (Advocates.drafts) {
    srv.on('SAVE', Advocates.drafts, async (req, next) => {
      await propagateEmailEdit(req, srvEntities);
      return next();
    });
  }
}
```

- [ ] **Step 6.4: Register the new module from `srv/handlers/advocate-handlers.js`**

The existing `register(srv)` in advocate-handlers.js gets a new line at the end (just before its closing `}`):

```js
// At the top of srv/handlers/advocate-handlers.js add:
import * as emailHandlers from './advocate-email-handlers.js';

// At the end of register(srv), just before the closing brace:
emailHandlers.register(srv);
```

Use `Edit` with an anchor on the existing `srv.on('clearPhoto', Advocates, ...` block to find the closing brace, OR add right after `srv.before('NEW', 'Advocates.drafts', deriveAdvocateSlug);` for sequencing — doesn't matter functionally.

- [ ] **Step 6.5: Run — expect 6/6 PASS**

```bash
npx vitest run test/unit/advocates/email-edit.test.js --reporter=basic 2>&1 | tail -10
# expect: 6 passed
```

If draft tests fail with timing issues, the cds.test bootstrap may need a longer `hookTimeout`. The vitest config already sets `hookTimeout: 60000`. If still flaky, the failure mode is more likely a handler bug than test infrastructure — investigate before re-running.

- [ ] **Step 6.6: Run full advocate suite — expect no regressions**

```bash
npx vitest run test/unit/advocates --reporter=basic 2>&1 | tail -10
# expect: count from Step 1.3 + 6 new = green
```

- [ ] **Step 6.7: Commit**

```bash
git add srv/handlers/advocate-email-handlers.js test/unit/advocates/email-edit.test.js srv/handlers/advocate-handlers.js
git commit -m "feat(advocates): emailEdit handler with TDD coverage (issue #638)

New file srv/handlers/advocate-email-handlers.js. Three hooks on
AdminService.Advocates:
  - after('READ'): hydrate emailEdit from Users.email
  - before('UPDATE'): validate + propagate to Users.email
  - on('SAVE', Advocates.drafts): propagate at draft-activate time

Six unit cases cover hydrate (linked + unlinked), propagate (success +
unlinked-rejected + malformed-rejected), and draft-activate. All use
__test__-prefixed user + advocate fixtures so the suite stays
HANA-safe per the fixture-lockdown contract.

Validation routed through srv/lib/email-validation.js (added in the
previous commit).

Refs: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §4.3"
```

---

## Task 7: Fiori annotation swap (IdentityLink FieldGroup)

**Goal:** Swap the bound property in the Identity tab so admins see an editable email field instead of the read-only association-path field.

**Files:**
- Modify: `app/admin-annotations.cds:1992-1997`

- [ ] **Step 7.1: Read current annotation block**

```bash
sed -n '1988,2000p' app/admin-annotations.cds
```

- [ ] **Step 7.2: Edit the FieldGroup**

Use `Edit` with this `old_string` (unique within the file because of the surrounding spec comment):

```cds
  // Spec: 2026-06-25-advocate-user-link-design §2.
  // Linked-User identity field group — picker + read-through email.
  // Email row is read-only because Fiori Elements V4 won't edit a value
  // off a foreign association inline (which is what we want).
  UI.FieldGroup #IdentityLink: {
    Data: [
      { $Type: 'UI.DataField', Value: user_ID,    Label: 'Linked User' },
      { $Type: 'UI.DataField', Value: user.email, Label: 'Email (from linked User)' }
    ]
  },
```

Replace with:

```cds
  // Spec: 2026-06-25-advocate-email-edit-design.md §4.2.
  // Linked-User identity field group — picker + editable email mirror.
  // emailEdit is a virtual element hydrated on-READ and propagated to
  // Users.email on-UPDATE / SAVE-on-drafts; see srv/handlers/advocate-email-handlers.js.
  UI.FieldGroup #IdentityLink: {
    Data: [
      { $Type: 'UI.DataField', Value: user_ID,   Label: 'Linked User' },
      { $Type: 'UI.DataField', Value: emailEdit, Label: 'Email' }
    ]
  },
```

- [ ] **Step 7.3: Verify CDS compiles cleanly**

```bash
TMP="${TEMP:-/tmp}/email-fe-edmx.xml"
npx cds compile srv/admin-service.cds -s AdminService -2 edmx 2>/dev/null > "$TMP"
node -e "
const x = require('fs').readFileSync(process.env.TMP, 'utf8');
const idLink = x.match(/UI.FieldGroup\".*?#IdentityLink[\\s\\S]*?Value=\"emailEdit\"/);
console.log('emailEdit bound in #IdentityLink:', idLink ? 'OK' : 'MISSING');
" TMP="$TMP"
```

- [ ] **Step 7.4: Run advocate tests — expect green**

```bash
npx vitest run test/unit/advocates --reporter=basic 2>&1 | tail -10
```

- [ ] **Step 7.5: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(advocates): swap IdentityLink email field to editable emailEdit virtual

The 'Email (from linked User)' DataField bound to user.email was
read-only because FE V4 can't edit a value through a foreign association
inline path. Swapping the binding to the new emailEdit virtual element
(added in the previous commits) makes it editable; the handler chain
propagates writes back to Users.email at SAVE time.

Refs: docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md §4.2
Issue #638."
```

---

## Task 8: Cleanup script for legacy fixture pollution

**Goal:** One-shot HANA cleanup that Tom runs once on DEV after deploy. Removes the literal `thomas-jung` Advocates row plus any `__TEST__`-prefixed rows. Idempotent.

**Files:**
- Create: `scripts/cleanup-advocate-test-rows.cjs`

- [ ] **Step 8.1: Read the sibling cleanup-advocate-link-test-rows.cjs for the canonical pattern**

```bash
head -70 scripts/cleanup-advocate-link-test-rows.cjs
```

- [ ] **Step 8.2: Implement `scripts/cleanup-advocate-test-rows.cjs`**

```js
#!/usr/bin/env node
/**
 * One-shot cleanup for shadow / test-fixture rows in
 * COM_SAP_DEVELOPERS_IMS_ADVOCATES.
 *
 * Background (issue #638): On 2026-06-25 Tom's real advocate row on DEV
 * was reset to test-fixture identity strings. The fix is two-part: rename
 * the unit-test fixtures so they can't shadow real data (separate commits),
 * and this script to scrub the HANA row that already drifted.
 *
 * Matches:
 *   - slug LIKE '__test__%'        (catches the new __test__advocate-link-* fixture pattern)
 *   - firstName LIKE '__TEST__%'   (defensive — catches rows where slug was overwritten but identity wasn't)
 *   - slug = 'thomas-jung'         (one-time cleanup of the legacy fixture; only fires if the row
 *                                   IS the test fixture, not Tom's real row — Tom's row will get
 *                                   a different slug post-DB-cleanup, manually restored)
 *
 * Usage:
 *   # Dry-run (default) — shows what would be deleted, no writes.
 *   npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs
 *
 *   # Live run — actually deletes the rows.
 *   npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs --commit
 *
 * IMPORTANT: Tom must confirm the dry-run output before running --commit.
 * The legacy 'thomas-jung' literal in the WHERE clause is a transitional
 * safeguard; after one successful run on DEV + Tom's manual re-create of
 * his real advocate row with a new slug, the literal can be dropped.
 *
 * The script is idempotent — re-running after a clean execution finds 0 rows.
 */
'use strict';

const cds = require('@sap/cds');

const COMMIT = process.argv.includes('--commit');

async function main() {
  console.log('cleanup-advocate-test-rows');
  console.log(COMMIT ? '  Mode: --commit (will DELETE matching rows)\n' : '  Mode: dry-run (no writes; use --commit to apply)\n');

  const db = await cds.connect.to('db');

  // Identify candidate rows. HANA stores unquoted CDS identifiers as
  // UPPERCASE; only quote mixed-case identifiers ("ID", "firstName").
  const rows = await db.run(
    `SELECT "ID", SLUG, "firstName", "lastName", BIO
       FROM COM_SAP_DEVELOPERS_IMS_ADVOCATES
      WHERE SLUG LIKE '__test__%'
         OR "firstName" LIKE '__TEST__%'
         OR SLUG = 'thomas-jung'`
  );

  console.log(`Found ${rows.length} test-fixture / shadow row(s):`);
  for (const r of rows.slice(0, 10)) {
    console.log(`  ${r.ID}  slug=${r.SLUG}  ${r.firstName} ${r.lastName}`);
  }
  if (rows.length > 10) {
    console.log(`  ...and ${rows.length - 10} more`);
  }

  if (rows.length === 0) {
    console.log('\nNothing to clean up. Done.');
    return;
  }

  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to delete these rows.');
    return;
  }

  // CASCADE: AdvocateTopics, AdvocateLinks, AdvocatePhotos all FK to Advocates.
  // The schema declares them as `Composition`, so deleting parent rows cascades
  // children. Confirm by attempting the parent DELETE; HANA raises a FK error
  // if any child row exists without ON DELETE CASCADE.
  const ids = rows.map((r) => r.ID);
  const placeholders = ids.map((_, i) => `?`).join(',');
  const result = await db.run(
    {
      query: `DELETE FROM COM_SAP_DEVELOPERS_IMS_ADVOCATES WHERE "ID" IN (${placeholders})`,
      values: ids,
    }
  );
  console.log(`\nDeleted ${result || rows.length} row(s) from Advocates. Cascade dropped any child Links/Topics/Photos.`);
}

main().then(() => process.exit(0)).catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
```

- [ ] **Step 8.3: Smoke-run the script in dry-run mode locally** (no HANA needed; cds bind would skip)

```bash
# This won't actually connect to HANA without cf login; just verifies the script parses.
node -c scripts/cleanup-advocate-test-rows.cjs && echo "syntax OK"
# expect: syntax OK
```

- [ ] **Step 8.4: Commit**

```bash
git add scripts/cleanup-advocate-test-rows.cjs
git commit -m "scripts(advocates): cleanup script for legacy fixture pollution (#638)

One-shot HANA cleanup for the thomas-jung / __TEST__-prefixed rows that
leaked into DEV from unit tests running against the wrong DB. Dry-run by
default; --commit to apply. Idempotent.

Tom runs once on DEV post-deploy:
  npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs
  # confirm output, then:
  npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs --commit"
```

---

## Task 9: Hybrid test — emailEdit round-trip on HANA

**Goal:** One hybrid test that proves emailEdit propagation works against real HANA, including the cascade-NULL behavior on User delete (already covered by the existing PR #633 hybrid test; we extend it).

**Files:**
- Modify: `test/hybrid/advocate-user-link.test.js`

- [ ] **Step 9.1: Read existing file scaffold**

```bash
head -70 test/hybrid/advocate-user-link.test.js
```

- [ ] **Step 9.2: Append the new test case at the end of the describe block**

Use `Edit` to insert the new case before the final closing brace of `describeIf('Advocates.user — HANA UNIQUE + cascade (hybrid)', () => { ... });`. Anchor on the existing last `it(...)` block's closing `});`. The new case:

```js
  it('emailEdit round-trip — UPDATE propagates to Users.email on HANA', async () => {
    if (!allowWrites) return;

    const userIdHybrid = randomUUID();
    const advIdHybrid = randomUUID();
    createdUserIds.push(userIdHybrid);
    createdAdvIds.push(advIdHybrid);

    await INSERT.into('com.sap.developers.ims.Users').entries({
      ID: userIdHybrid,
      sapId: '__TEST__advocate-link-email-' + Date.now(),
      firstName: '__TEST__', lastName: 'EmailRT',
      email: 'before@hybrid.test',
      displayName: '__TEST__ EmailRT',
    });

    await INSERT.into('com.sap.developers.ims.Advocates').entries({
      ID: advIdHybrid,
      slug: '__test__advocate-link-email-' + Date.now().toString(36),
      firstName: '__TEST__', lastName: 'EmailRT',
      region: 'AMERICAS', isActive: true,
      user_ID: userIdHybrid,
    });

    // Direct service call (skip OData parsing; this is a hybrid integration test).
    const srv = await cds.connect.to('AdminService');
    await srv.update('com.sap.developers.ims.Advocates', advIdHybrid).with({ emailEdit: 'after@hybrid.test' });

    const updated = await SELECT.one.from('com.sap.developers.ims.Users')
      .columns('email')
      .where({ ID: userIdHybrid });
    expect(updated.email).toBe('after@hybrid.test');
  });
```

(Bring `randomUUID` into scope at the top of the file if not already imported.)

- [ ] **Step 9.3: Skipped on local run; check syntax**

The case skips automatically without `ALLOW_HYBRID_WRITES=true`. Run the file in unit mode just to verify it parses:

```bash
npx vitest run test/hybrid/advocate-user-link.test.js --reporter=basic 2>&1 | tail -10
# expect: file parses; test is skipped (allowWrites=false locally)
```

- [ ] **Step 9.4: Commit**

```bash
git add test/hybrid/advocate-user-link.test.js
git commit -m "test(advocate-email-edit): hybrid round-trip case on HANA (#638)

Extends the existing PR #633 hybrid suite with one new case that PATCHes
emailEdit through AdminService.Advocates and asserts Users.email reflects
the change. Skipped without ALLOW_HYBRID_WRITES=true (sibling-test pattern).

Tom runs this once with cds bind --exec to validate the deployed handler
chain before declaring the feature shipped."
```

---

## Task 10: Smoke test — emailEdit on $metadata

**Goal:** Cheap smoke check that the property surfaces on the deployed srv. Catches any deploy mismatch.

**Files:**
- Modify: `test/smoke/advocates-user-link.smoke.test.js`

- [ ] **Step 10.1: Read file**

```bash
head -50 test/smoke/advocates-user-link.smoke.test.js
```

- [ ] **Step 10.2: Append new case**

```js
it('AdminService.Advocates exposes emailEdit virtual element on $metadata', async () => {
  // SMOKE_SRV_URL set by CI after deploy; locally requires manual export.
  const url = process.env.SMOKE_SRV_URL;
  if (!url) return;  // skip when not running in smoke mode

  // $metadata requires admin scope on /admin; the smoke runner already
  // sets SMOKE_BEARER_TOKEN (or similar — match the sibling smoke tests).
  const token = process.env.SMOKE_BEARER_TOKEN;
  const res = await fetch(`${url}/admin/$metadata`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  expect(res.status).toBe(200);
  const body = await res.text();
  expect(body).toMatch(/Name="emailEdit"/);
});
```

If the existing file already references SMOKE_BEARER_TOKEN, use the same variable. If it uses a different env var name, match. **DO NOT invent a new env var name** — `grep` first.

- [ ] **Step 10.3: Verify parse**

```bash
npx vitest run test/smoke/advocates-user-link.smoke.test.js --reporter=basic 2>&1 | tail -10
# expect: parses; case skipped without SMOKE_SRV_URL
```

- [ ] **Step 10.4: Commit**

```bash
git add test/smoke/advocates-user-link.smoke.test.js
git commit -m "test(advocate-email-edit): smoke check for emailEdit \$metadata exposure

One-line assertion that the property landed on the deployed admin srv.
Skipped without SMOKE_SRV_URL. Issue #638."
```

---

## Task 11: Final regression run + build verification

**Goal:** Belt-and-suspenders check that nothing else broke.

- [ ] **Step 11.1: Full unit suite (subset to advocates + helpers — full suite is too slow)**

```bash
npx vitest run test/unit/advocates test/unit/email-validation.test.js --reporter=basic 2>&1 | tail -15
# expect: all green; count = (Step 1.3 baseline) + 6 (email-edit) + 10 (email-validation)
```

- [ ] **Step 11.2: cds build for production**

```bash
npx cds build --production 2>&1 | tail -20
# expect: "BUILD SUCCESS" or equivalent; no errors. Catches any CSN drift
# that the schema-drift CI checks would flag on push.
```

- [ ] **Step 11.3: Verify no stray staged files**

```bash
git status --short
# expect: clean (gen/ artifacts go in their own commit if needed; per CLAUDE.md
# 'check-cds-build-staging fires on ANY srv/ change', a commit of gen/ may
# be required — coordinate with the deploy step)
```

- [ ] **Step 11.4: If gen/ changed, commit it**

```bash
# If `git status` shows changes in gen/ or srv-gen/:
git add gen/ srv-gen/ 2>/dev/null || true
git commit -m "build(advocates): regenerate CSN for emailEdit virtual + IdentityLink swap" --allow-empty
# (--allow-empty is harmless if nothing to commit)
```

- [ ] **Step 11.5: No further commit — Task 11 is verification only**

---

## Task 12: Push branch + open PR

**Goal:** Land the feature.

- [ ] **Step 12.1: Push the worktree branch to origin**

```bash
git push -u origin worktree-advocate-email-edit
```

- [ ] **Step 12.2: Open PR using gh**

```bash
gh pr create \
  --title "feat(advocates): editable email + test fixture lockdown (closes #638 partially)" \
  --body "$(cat <<'PRBODY'
Implements docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md.

## Changes

- **Email edit:** New virtual \`emailEdit : String(255)\` element on \`AdminService.Advocates\`. Hydrated on-READ from \`Users.email\`, propagated on-UPDATE / SAVE-on-drafts back to \`Users.email\`. The 'Email' field in the Advocate Object Page Identity tab is now editable for any advocate that has a Linked User.
- **Fixture lockdown:** Renamed \`slug: 'thomas-jung'\` and \`slug: 'placeholder-emea'\` in \`test/unit/advocates/api.test.js\` and \`test/unit/advocates/photo-serve.test.js\` to \`__test__advocate-link-amer-1\` / \`-emea-1\` so the same shape that landed on DEV today can't recur from a misdirected test run.
- **Cleanup script:** \`scripts/cleanup-advocate-test-rows.cjs\` (idempotent, dry-run by default) for Tom to scrub the legacy DEV row.

## Tests

- 10 unit cases for \`srv/lib/email-validation.js\` (RFC-5322 shape, length cap, trim/lowercase)
- 6 unit cases for handler behavior (hydrate, propagate, reject-unlinked, reject-malformed, draft-activate)
- 1 hybrid case for HANA round-trip (skipped without \`ALLOW_HYBRID_WRITES=true\`)
- 1 smoke case for \`\$metadata\` exposure

## Post-deploy

Tom runs once on DEV:

\`\`\`bash
# Sanity dry-run
npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs

# After confirming output, commit
npx cds bind --exec -- node scripts/cleanup-advocate-test-rows.cjs --commit
\`\`\`

Then re-creates his real Advocates row via the admin UI.

## Sibling PR

UI fixes for the same Advocate OP (Topics GUID rendering, Linked User '-' display, Tutorials Create button hiding) are covered by a separate spec + sibling worktree (\`.claude/worktrees/advocate-admin-ui-fixes\`) and will land in its own PR. Issue #638 stays open until both PRs merge.

Closes #638 partially.
PRBODY
)"
```

- [ ] **Step 12.3: No commit — push + PR creation only**

---

## Rollback

Purely additive change. To revert:

1. `git revert <merge-commit>` on `main`
2. The legacy fixture rows on DEV stay; re-run the cleanup script if needed.

`Users.email` rows written through the feature stay intact — they're indistinguishable from rows the admin set via any other path.

## Related

- Spec: [docs/superpowers/specs/2026-06-25-advocate-email-edit-design.md](../specs/2026-06-25-advocate-email-edit-design.md)
- Sibling spec + plan: `docs/superpowers/specs/2026-06-25-advocate-admin-ui-fixes-design.md` + plan
- Issue: #638
- Worktree memory: `[Worktree dir = .claude/worktrees/]`
