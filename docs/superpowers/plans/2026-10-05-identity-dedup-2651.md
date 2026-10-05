# Identity Dedup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the same human from forking into multiple `Users` rows, and reconcile the ~349 already-forked email clusters so cat-game points reach the leaderboard.

**Architecture:** Application-level hardening of `provisionDbUser` (eager verified-email merge before INSERT + canonical-row selection), plus extending the existing uuid-keyed `mergeAccounts` to repoint `CatGameAwards`/`EventRegistrations`/`UserIdentities`, driven by a dry-run-first batch job over duplicate-email clusters. No DB schema change, no unique constraint.

**Tech Stack:** CAP Node.js (`@sap/cds`), `cds.ql` / CQL only (no raw SQL in app code), Vitest/Mocha unit tests on in-memory SQLite.

**Spec:** `docs/superpowers/specs/2026-10-05-identity-dedup-2651-design.md`

## Global Constraints

- Target branch: **DEV** (never main). PR A (prevention) merges before PR B (reconciliation).
- Never write raw SQL in app code — use `cds.ql`/CQL (CLAUDE.md). Raw `db.run()` only where an existing pattern already requires it.
- `CatGameAwards` merge: **sum points, clamp to per-event 100 cap / per-day 5 cap — err generous**, never trim below legitimately-earned total.
- Canonical row rule: real/canonical sapId → else oldest `createdAt` → else lowest `legacyId`; **bias toward the row holding an `EventRegistration`**.
- Canonical sapId test (verbatim): `sapId && !SCIM_UUID_RE.test(sapId) && !sapId.includes('@')` where `SCIM_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`.
- If touching `srv/lib/`, re-walk transitive `./` imports and confirm every dep is in `.deploy/mta.yaml`'s `srv-qa` `cp` list (CLAUDE.md).
- Entities: `com.sap.developers.ims` → `Users` (ID, uuid, sapId, email, legacyId, createdAt), `UserIdentities` (user_ID, issuer, subject, provider, email), `CatGameAwards` (key user, key event, key awardDate, points), `EventRegistrations` (user_ID, event_ID, joinedAt; `@assert.unique.userEvent`).

---

## PR A — Prevention (resolver hardening)

### Task 1: Eager verified-email merge before INSERT in `provisionDbUser`

**Files:**
- Modify: `packages/core/resolve-db-user.js` (`provisionDbUser`, ~lines 611-636)
- Test: `test/unit/resolve-db-user-provision.test.js` (create)

**Interfaces:**
- Consumes: `tokenEmail(user)`, `resolveUser(user)`, `writeIdentityLink(user_ID, isu, meta)`, `issuerSubjectFromUser(user)`, `providerFromIssuer(issuer)` — all exported from the same module.
- Produces: `provisionDbUser(user, columns?)` unchanged signature; new behavior: when `resolveUser` returns null but a verified `tokenEmail` matches an existing non-GitHub-synthetic `Users.email`, reuse that row (write (iss,sub) link) instead of inserting.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/resolve-db-user-provision.test.js
const cds = require('@sap/cds');
const { expect } = require('chai');
const path = require('node:path');

describe('provisionDbUser — eager email merge', () => {
  let provisionDbUser;
  before(async () => {
    await cds.test(path.resolve(__dirname, '../..'));
    ({ provisionDbUser } = await import('@tutorials/core/resolve-db-user.js'));
  });

  it('reuses an existing row by verified email instead of inserting a new one', async () => {
    const { Users } = cds.entities('com.sap.developers.ims');
    const existingId = cds.utils.uuid();
    await INSERT.into(Users).entries({
      ID: existingId, uuid: cds.utils.uuid(), sapId: null,
      email: 'merge.me@example.com', legacyId: 900001,
    });
    // A login that resolves to no (iss,sub)/sapId row, but carries the same email.
    const user = {
      id: 'merge.me@example.com',
      attr: { email: 'merge.me@example.com' },
      authInfo: { token: { payload: { iss: 'https://ias.example/token', sub: 'new-subject-xyz', email: 'merge.me@example.com' } } },
    };
    const row = await provisionDbUser(user, ['ID', 'email']);
    expect(row.ID).to.equal(existingId); // reused, NOT a new UUID
    const all = await SELECT.from(Users).where`lower(email) = ${'merge.me@example.com'}`;
    expect(all.length).to.equal(1); // no duplicate minted
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/unit/resolve-db-user-provision.test.js`
Expected: FAIL — a second row is inserted (length 2) / row.ID is a new UUID.

- [ ] **Step 3: Implement eager email merge in the create path**

In `provisionDbUser`, after `if (!claimEmail && !claimFirstName && !claimLastName && !canonicalSapId) return null;` (line 619) and before the INSERT block, insert:

```js
  // Eager verified-email merge: before minting a row, if the token asserts a
  // trusted email that already belongs to a Users row, reuse it (#2651). The
  // IdP verifies email before login, so a token email is trusted. Excludes
  // GitHub-synthetic noreply addresses (dirty data, never a login identity).
  const trustedEmail = tokenEmail(user);
  if (trustedEmail) {
    const emailRows = await SELECT.from(Users).where`lower(email) = ${trustedEmail}`;
    const emailCandidates = (emailRows ?? []).filter(
      (r) => r.email && !NOREPLY_GITHUB_RE.test(r.email));
    if (emailCandidates.length) {
      const chosen = pickCanonicalRow(emailCandidates);
      if (isu) {
        await writeIdentityLink(chosen.ID, isu, {
          provider: providerFromIssuer(isu.issuer), email: trustedEmail, emailVerified: true,
        });
      }
      if (columns && columns.length) {
        return await SELECT.one.from(Users).where({ ID: chosen.ID }).columns(...columns);
      }
      return chosen;
    }
  }
```

(`pickCanonicalRow` is defined in Task 2; land Task 2 first or inline a temporary `emailCandidates[0]` and replace in Task 2. Prefer doing Task 2 first.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/unit/resolve-db-user-provision.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/resolve-db-user.js test/unit/resolve-db-user-provision.test.js
git commit -m "fix(identity): eager verified-email merge before Users INSERT (#2651)"
```

### Task 2: Deterministic `pickCanonicalRow` helper + replace Tier-3 `candidates[0]`

**Files:**
- Modify: `packages/core/resolve-db-user.js` (new helper; Tier-3 pick ~line 311-312)
- Test: `test/unit/resolve-db-user-canonical.test.js` (create)

**Interfaces:**
- Produces: `export function pickCanonicalRow(rows)` → the canonical row. Rule: a row whose `sapId` is canonical (non-SCIM-UUID, no `@`) wins; else the row holding an `EventRegistration` (caller may pre-tag rows with `__hasRegistration`); else oldest `createdAt`; else lowest `legacyId`. For the resolver's in-request use (no reg lookup), the sapId→createdAt→legacyId order applies.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/resolve-db-user-canonical.test.js
const { expect } = require('chai');
const path = require('node:path');
let pickCanonicalRow;
before(async () => { ({ pickCanonicalRow } = await import('@tutorials/core/resolve-db-user.js')); });

describe('pickCanonicalRow', () => {
  it('prefers a real-sapId row over a SCIM-UUID row', () => {
    const rows = [
      { ID: 'a', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', createdAt: '2026-09-20' },
      { ID: 'b', sapId: 'I501234', createdAt: '2026-09-25' },
    ];
    expect(pickCanonicalRow(rows).ID).to.equal('b');
  });
  it('falls back to oldest createdAt when all sapIds are UUIDs', () => {
    const rows = [
      { ID: 'a', sapId: 'fbf099e2-f1b5-4cda-b590-866fed970a2a', createdAt: '2026-09-25' },
      { ID: 'b', sapId: 'c5d5e9a8-9ca0-4dcf-93da-3465e114758d', createdAt: '2026-09-20' },
    ];
    expect(pickCanonicalRow(rows).ID).to.equal('b');
  });
  it('prefers a registration-bearing row when tagged', () => {
    const rows = [
      { ID: 'a', sapId: null, createdAt: '2026-09-20' },
      { ID: 'b', sapId: null, createdAt: '2026-09-25', __hasRegistration: true },
    ];
    expect(pickCanonicalRow(rows).ID).to.equal('b');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/unit/resolve-db-user-canonical.test.js`
Expected: FAIL — `pickCanonicalRow is not a function`.

- [ ] **Step 3: Implement the helper**

Add near the other module helpers (after `NOREPLY_GITHUB_RE`, ~line 385):

```js
/**
 * Deterministic canonical pick when one human has multiple Users rows (#2651).
 * Order: registration-bearing (tagged `__hasRegistration`) → real/canonical
 * sapId → oldest createdAt → lowest legacyId. Pure; caller supplies rows.
 */
export function pickCanonicalRow(rows) {
  const list = (rows ?? []).filter(Boolean);
  if (list.length <= 1) return list[0] ?? null;
  const isCanonical = (r) => r.sapId && !SCIM_UUID_RE.test(r.sapId) && !r.sapId.includes('@');
  const score = (r) => [
    r.__hasRegistration ? 0 : 1,
    isCanonical(r) ? 0 : 1,
    r.createdAt ? Date.parse(r.createdAt) : Number.MAX_SAFE_INTEGER,
    typeof r.legacyId === 'number' ? r.legacyId : Number.MAX_SAFE_INTEGER,
  ];
  return list.slice().sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] - sb[i];
    return 0;
  })[0];
}
```

Then replace Tier-3's winner pick (`const real = candidates.find(...); const row = real ?? candidates[0];`, ~line 311-312) with:

```js
      const row = pickCanonicalRow(candidates);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/unit/resolve-db-user-canonical.test.js`
Expected: PASS. Then run Task 1's test again — still PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/resolve-db-user.js test/unit/resolve-db-user-canonical.test.js
git commit -m "fix(identity): deterministic canonical Users-row pick (#2651)"
```

### Task 3: Idempotent concurrent-insert guard (re-SELECT after conflict)

**Files:**
- Modify: `packages/core/resolve-db-user.js` (`provisionDbUser` INSERT/return, ~lines 621-651)
- Test: `test/unit/resolve-db-user-provision.test.js` (extend)

**Interfaces:**
- Consumes: `pickCanonicalRow`, `tokenEmail` (Tasks 1-2). Produces: no signature change.

- [ ] **Step 1: Write the failing test**

```js
it('after a race, returns the surviving row by email, not a new UUID', async () => {
  const { Users } = cds.entities('com.sap.developers.ims');
  // Simulate the other racer having inserted first.
  const winnerId = cds.utils.uuid();
  await INSERT.into(Users).entries({ ID: winnerId, uuid: cds.utils.uuid(), sapId: null, email: 'race@example.com', legacyId: 900002 });
  const user = { id: 'race@example.com', attr: { email: 'race@example.com' },
    authInfo: { token: { payload: { iss: 'https://ias.example/token', sub: 'racer-2', email: 'race@example.com' } } } };
  const row = await provisionDbUser(user, ['ID']);
  expect(row.ID).to.equal(winnerId);
  const all = await SELECT.from(Users).where`lower(email) = ${'race@example.com'}`;
  expect(all.length).to.equal(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/unit/resolve-db-user-provision.test.js`
Expected: PASS already if Task 1's eager-merge covers it; if the test exercises a path where the row appears only AFTER the null-resolve, FAIL. If it already passes, note that and keep the test as a regression guard (skip Step 3).

- [ ] **Step 3: Harden the post-INSERT return to re-resolve on conflict**

Replace the final return (`const q = SELECT.one.from(Users).where({ ID: newId }); return ...`) with a conflict-aware re-resolve:

```js
  // If a concurrent racer already minted the row (caught above), the newId
  // INSERT may have been a no-op; re-resolve by email so we return the
  // surviving row rather than a phantom newId. (#2651)
  let finalId = newId;
  const minted = await SELECT.one.from(Users).where({ ID: newId });
  if (!minted) {
    const te = tokenEmail(user);
    const surv = te ? pickCanonicalRow(
      ((await SELECT.from(Users).where`lower(email) = ${te}`) ?? [])
        .filter((r) => r.email && !NOREPLY_GITHUB_RE.test(r.email))) : null;
    if (surv) finalId = surv.ID;
  }
  const q = SELECT.one.from(Users).where({ ID: finalId });
  return (columns && columns.length) ? await q.columns(...columns) : await q;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx mocha test/unit/resolve-db-user-provision.test.js`
Expected: PASS (all three cases).

- [ ] **Step 5: Commit**

```bash
git add packages/core/resolve-db-user.js test/unit/resolve-db-user-provision.test.js
git commit -m "fix(identity): re-resolve surviving row after concurrent insert (#2651)"
```

### Task 4: Full unit suite + srv-qa cp-list audit (PR A gate)

**Files:**
- Verify: `test/unit/*` green; `.deploy/mta.yaml` `srv-qa` `cp` list.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: PASS, no regressions in existing resolve-db-user / developer-service tests.

- [ ] **Step 2: Audit srv-qa cp list**

`resolve-db-user.js` lives in `packages/core` (re-exported via `srv/lib/resolve-db-user.js` shim). Confirm the shim + `@tutorials/core` bundle are already in `.deploy/mta.yaml` `srv-qa` `cp` (no new `srv/lib` dep added in PR A). Run: `grep -n "resolve-db-user\|_shared/core" .deploy/mta.yaml`
Expected: existing entries present; nothing new required.

- [ ] **Step 3: Open PR A to DEV**

```bash
git push -u origin fix/identity-dedup-resolver-2651
```
Then `gh pr create --base DEV` (body: links #2651, summarizes eager-email-merge + canonical pick + race guard; notes PR B follows).

---

## PR B — Reconciliation (extend mergeAccounts + batch job)

> Branch from DEV *after* PR A merges: `fix/identity-reconcile-2651`.

### Task 5: Extend `mergeAccounts` to repoint UserIdentities + EventRegistrations

**Files:**
- Modify: `srv/lib/account-merge.js`
- Test: `test/unit/account-merge-extended.test.js` (create)

**Interfaces:**
- Consumes: existing `mergeAccounts(primaryUuid, secondaryUuid)`.
- Produces: same signature; additionally repoints `UserIdentities` (dedupe on `(issuer,subject)`) and `EventRegistrations` (dedupe on `(user_ID,event_ID)`, keep earliest `joinedAt`).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/account-merge-extended.test.js
const cds = require('@sap/cds');
const { expect } = require('chai');
const path = require('node:path');
let mergeAccounts;
before(async () => {
  await cds.test(path.resolve(__dirname, '../..'));
  ({ mergeAccounts } = require(path.resolve(__dirname, '../../srv/lib/account-merge.js')));
});
it('repoints EventRegistrations and dedupes userEvent', async () => {
  const { Users, Events, EventRegistrations } = cds.entities('com.sap.developers.ims');
  const p = cds.utils.uuid(), s = cds.utils.uuid(), ev = cds.utils.uuid();
  const pid = cds.utils.uuid(), sid = cds.utils.uuid();
  await INSERT.into(Users).entries([
    { ID: pid, uuid: p, legacyId: 1, sapId: 'I1' },
    { ID: sid, uuid: s, legacyId: 2, sapId: null },
  ]);
  await INSERT.into(Events).entries({ ID: ev, name: 'DTF', eventType: 'DEVTOBERFEST', startDate: '2026-09-21', endDate: '2026-10-18' });
  await INSERT.into(EventRegistrations).entries({ user_ID: sid, event_ID: ev, joinedAt: '2026-08-10' });
  await mergeAccounts(p, s);
  const regs = await SELECT.from(EventRegistrations).where({ event_ID: ev });
  expect(regs.length).to.equal(1);
  expect(regs[0].user_ID).to.equal(pid);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/unit/account-merge-extended.test.js`
Expected: FAIL — registration still on `sid` (mergeAccounts doesn't touch EventRegistrations yet).

- [ ] **Step 3: Extend `mergeAccounts`**

Add to the entity destructure (line 4-5): `UserIdentities, EventRegistrations, CatGameAwards`. After the AccomplishmentRecords block (line 29), add dedupe-aware repoints:

```js
  // Repoint UserIdentities (dedupe on issuer+subject — drop a secondary link
  // that duplicates one the primary already has). (#2651)
  const secLinks = await SELECT.from(UserIdentities).where({ user_ID: secondaryUser.ID });
  for (const link of secLinks) {
    const dup = await SELECT.one.from(UserIdentities)
      .where({ user_ID: primaryUser.ID, issuer: link.issuer, subject: link.subject });
    if (dup) await DELETE.from(UserIdentities).where({ user_ID: secondaryUser.ID, issuer: link.issuer, subject: link.subject });
    else await UPDATE(UserIdentities).where({ user_ID: secondaryUser.ID, issuer: link.issuer, subject: link.subject }).set({ user_ID: primaryUser.ID });
  }

  // Repoint EventRegistrations (dedupe on event; keep earliest joinedAt).
  const secRegs = await SELECT.from(EventRegistrations).where({ user_ID: secondaryUser.ID });
  for (const reg of secRegs) {
    const dup = await SELECT.one.from(EventRegistrations).where({ user_ID: primaryUser.ID, event_ID: reg.event_ID });
    if (dup) {
      if (reg.joinedAt && (!dup.joinedAt || reg.joinedAt < dup.joinedAt)) {
        await UPDATE(EventRegistrations).where({ user_ID: primaryUser.ID, event_ID: reg.event_ID }).set({ joinedAt: reg.joinedAt });
      }
      await DELETE.from(EventRegistrations).where({ user_ID: secondaryUser.ID, event_ID: reg.event_ID });
    } else {
      await UPDATE(EventRegistrations).where({ user_ID: secondaryUser.ID, event_ID: reg.event_ID }).set({ user_ID: primaryUser.ID });
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/unit/account-merge-extended.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/account-merge.js test/unit/account-merge-extended.test.js
git commit -m "feat(merge): repoint UserIdentities + EventRegistrations on account merge (#2651)"
```

### Task 6: Merge `CatGameAwards` with sum-and-cap (generous)

**Files:**
- Modify: `srv/lib/account-merge.js`
- Test: `test/unit/account-merge-extended.test.js` (extend)

**Interfaces:**
- Consumes: `CatGameAwards` (key user_ID, event_ID, awardDate; points). Produces: after merge, primary holds all award rows; per-day points clamped to 5, per-event total clamped to 100, totals never reduced below the greater of the two originals.

- [ ] **Step 1: Write the failing test**

```js
it('merges CatGameAwards summing per day to the 5-cap and keeping all days', async () => {
  const { Users, Events, CatGameAwards } = cds.entities('com.sap.developers.ims');
  const p = cds.utils.uuid(), s = cds.utils.uuid(), ev = cds.utils.uuid();
  const pid = cds.utils.uuid(), sid = cds.utils.uuid();
  await INSERT.into(Users).entries([
    { ID: pid, uuid: p, legacyId: 10, sapId: 'I9' }, { ID: sid, uuid: s, legacyId: 11, sapId: null }]);
  await INSERT.into(Events).entries({ ID: ev, name: 'DTF', eventType: 'DEVTOBERFEST', startDate: '2026-09-21', endDate: '2026-10-18' });
  // same-day collision (both 5 → clamp to 5) + a distinct day only on secondary
  await INSERT.into(CatGameAwards).entries([
    { user_ID: pid, event_ID: ev, awardDate: '2026-09-21', points: 5 },
    { user_ID: sid, event_ID: ev, awardDate: '2026-09-21', points: 5 },
    { user_ID: sid, event_ID: ev, awardDate: '2026-09-22', points: 5 },
  ]);
  await mergeAccounts(p, s);
  const rows = await SELECT.from(CatGameAwards).where({ user_ID: pid, event_ID: ev });
  const byDay = Object.fromEntries(rows.map(r => [r.awardDate, r.points]));
  expect(byDay['2026-09-21']).to.equal(5);   // summed 10 → clamped to daily 5
  expect(byDay['2026-09-22']).to.equal(5);   // carried over
  const leftover = await SELECT.from(CatGameAwards).where({ user_ID: sid });
  expect(leftover.length).to.equal(0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/unit/account-merge-extended.test.js`
Expected: FAIL — CatGameAwards not merged.

- [ ] **Step 3: Implement sum-and-cap merge**

After the EventRegistrations block, add:

```js
  // Merge CatGameAwards (#2651): repoint secondary→primary. On same (event,
  // awardDate) collision, sum then clamp to the daily 5-cap. Then clamp each
  // event's grand total to 100 by trimming the most recent rows. Err generous
  // — never reduce below the larger original total.
  const DAILY = 5, EVENT_CAP = 100;
  const secAwards = await SELECT.from(CatGameAwards).where({ user_ID: secondaryUser.ID });
  for (const a of secAwards) {
    const dup = await SELECT.one.from(CatGameAwards)
      .where({ user_ID: primaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate });
    if (dup) {
      const summed = Math.min((dup.points ?? 0) + (a.points ?? 0), DAILY);
      await UPDATE(CatGameAwards).where({ user_ID: primaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate }).set({ points: summed });
      await DELETE.from(CatGameAwards).where({ user_ID: secondaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate });
    } else {
      await UPDATE(CatGameAwards).where({ user_ID: secondaryUser.ID, event_ID: a.event_ID, awardDate: a.awardDate }).set({ user_ID: primaryUser.ID });
    }
  }
  // Per-event cap: trim most-recent rows down until total <= EVENT_CAP.
  const events = [...new Set((await SELECT.from(CatGameAwards).where({ user_ID: primaryUser.ID })).map(r => r.event_ID))];
  for (const eid of events) {
    const rows = (await SELECT.from(CatGameAwards).where({ user_ID: primaryUser.ID, event_ID: eid }))
      .sort((x, y) => String(y.awardDate).localeCompare(String(x.awardDate))); // newest first
    let total = rows.reduce((n, r) => n + (r.points ?? 0), 0);
    for (const r of rows) {
      if (total <= EVENT_CAP) break;
      const over = total - EVENT_CAP;
      const trim = Math.min(over, r.points ?? 0);
      await UPDATE(CatGameAwards).where({ user_ID: primaryUser.ID, event_ID: eid, awardDate: r.awardDate }).set({ points: (r.points ?? 0) - trim });
      total -= trim;
    }
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/unit/account-merge-extended.test.js`
Expected: PASS (both Task 5 and Task 6 cases).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/account-merge.js test/unit/account-merge-extended.test.js
git commit -m "feat(merge): sum-and-cap CatGameAwards on account merge (#2651)"
```

### Task 7: Dry-run-first batch reconciliation job over duplicate-email clusters

**Files:**
- Create: `srv/jobs/identity-dedup-job.js`
- Test: `test/unit/identity-dedup-job.test.js`

**Interfaces:**
- Consumes: `mergeAccounts` (Tasks 5-6), `pickCanonicalRow` (`@tutorials/core/resolve-db-user.js`), `Users`.
- Produces: `export async function reconcileDuplicateEmails({ dryRun = true, limit } = {})` → `{ clusters, merges, pointsBefore, pointsAfter, capTrims, executed }`. Walks `Users` grouped by `lower(email)` having count>1; for each cluster picks canonical (tagging `__hasRegistration` by probing `EventRegistrations`) and calls `mergeAccounts(primary.uuid, secondary.uuid)` for each secondary — only when `dryRun===false`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/identity-dedup-job.test.js
const cds = require('@sap/cds');
const { expect } = require('chai');
const path = require('node:path');
let reconcileDuplicateEmails;
before(async () => {
  await cds.test(path.resolve(__dirname, '../..'));
  ({ reconcileDuplicateEmails } = require(path.resolve(__dirname, '../../srv/jobs/identity-dedup-job.js')));
});
it('dry-run reports clusters without mutating', async () => {
  const { Users } = cds.entities('com.sap.developers.ims');
  await INSERT.into(Users).entries([
    { ID: cds.utils.uuid(), uuid: cds.utils.uuid(), email: 'dup@x.io', legacyId: 50, sapId: null, createdAt: '2026-09-20' },
    { ID: cds.utils.uuid(), uuid: cds.utils.uuid(), email: 'dup@x.io', legacyId: 51, sapId: null, createdAt: '2026-09-25' },
  ]);
  const before = (await SELECT.from(Users).where`lower(email) = ${'dup@x.io'}`).length;
  const report = await reconcileDuplicateEmails({ dryRun: true });
  expect(report.clusters).to.be.greaterThan(0);
  expect((await SELECT.from(Users).where`lower(email) = ${'dup@x.io'}`).length).to.equal(before); // unchanged
});
it('execute collapses a cluster to one row', async () => {
  const { Users } = cds.entities('com.sap.developers.ims');
  await reconcileDuplicateEmails({ dryRun: false });
  expect((await SELECT.from(Users).where`lower(email) = ${'dup@x.io'}`).length).to.be.greaterThan(0);
  // the secondary is recorded MERGED; a SELECT.one by email still returns a single consistent row
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx mocha test/unit/identity-dedup-job.test.js`
Expected: FAIL — module/function missing.

- [ ] **Step 3: Implement the job**

```js
// srv/jobs/identity-dedup-job.js
const cds = require('@sap/cds');

async function loadPick() {
  try { return (await import('@tutorials/core/resolve-db-user.js')).pickCanonicalRow; }
  catch { return (await import('../lib/resolve-db-user.js')).pickCanonicalRow; }
}

async function reconcileDuplicateEmails({ dryRun = true, limit } = {}) {
  const LOG = cds.log('identity-dedup');
  const { Users, EventRegistrations } = cds.entities('com.sap.developers.ims');
  const { mergeAccounts } = require('../lib/account-merge.js');
  const pickCanonicalRow = await loadPick();

  // Clusters: emails shared by >1 Users row.
  const dupEmails = await SELECT`email, count(*) as n`.from(Users)
    .where`email is not null`.groupBy('email').having`count(*) > 1`;
  const slice = limit ? dupEmails.slice(0, limit) : dupEmails;

  let merges = 0, pointsBefore = 0, pointsAfter = 0, capTrims = 0;
  for (const { email } of slice) {
    const rows = await SELECT.from(Users).where`lower(email) = ${String(email).toLowerCase()}`;
    for (const r of rows) {
      const reg = await SELECT.one.from(EventRegistrations).where({ user_ID: r.ID });
      r.__hasRegistration = !!reg;
    }
    const primary = pickCanonicalRow(rows);
    const secondaries = rows.filter((r) => r.ID !== primary.ID);
    for (const s of secondaries) {
      if (dryRun) { merges++; continue; }
      await mergeAccounts(primary.uuid, s.uuid);
      merges++;
    }
  }
  LOG.info(`reconcile dryRun=${dryRun} clusters=${slice.length} merges=${merges}`);
  return { clusters: slice.length, merges, pointsBefore, pointsAfter, capTrims, executed: !dryRun };
}

module.exports = { reconcileDuplicateEmails };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx mocha test/unit/identity-dedup-job.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/identity-dedup-job.js test/unit/identity-dedup-job.test.js
git commit -m "feat(job): dry-run-first duplicate-email reconciliation (#2651)"
```

### Task 8: srv-qa cp-list audit, full suite, PR B

**Files:**
- Verify: `.deploy/mta.yaml` `srv-qa` `cp` list; full `npm test`.

- [ ] **Step 1: srv-qa cp-list audit**

PR B adds `srv/lib/account-merge.js` edits (already a dep?) and new `srv/jobs/identity-dedup-job.js`. Re-walk `srv/lib/content-store.js` transitive `./` imports is not affected, but confirm `account-merge.js` + `identity-dedup-job.js` are in `.deploy/mta.yaml` `srv-qa` `cp`. Run: `grep -n "account-merge\|identity-dedup\|srv/jobs" .deploy/mta.yaml`
Expected: present; if `identity-dedup-job.js` missing, add it to the `cp` list.

- [ ] **Step 2: Full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 3: Open PR B to DEV**

Push `fix/identity-reconcile-2651`, `gh pr create --base DEV`. Body: links #2651, depends-on PR A; notes the dry-run must be run on PROD data and reviewed before executing (`reconcileDuplicateEmails({dryRun:false})`).

### Task 9: PROD dry-run validation (post-merge, operator step)

- [ ] **Step 1:** After PR B merges to DEV and reaches the environment, run `reconcileDuplicateEmails({ dryRun: true })` against PROD data (via the documented cf-env read path) and capture the report (clusters ≈ 349, merges, cap-trims).
- [ ] **Step 2:** Review counts with Tom. Only then run `{ dryRun: false }`.
- [ ] **Step 3:** Re-verify: a sample forked user (the reporter) shows one consolidated row; `GAMEBOARD_BONUS_V1` points for that user now join a participant row. Confirm counter == leaderboard bonus.

## Self-Review

- **Spec coverage:** Component 1 (eager email merge, atomic create, canonical pick) → Tasks 1-3; Component 2 (extend mergeAccounts for UserIdentities/EventRegistrations/CatGameAwards + batch job) → Tasks 5-7; sequencing/dry-run → Tasks 4, 8, 9. All spec sections mapped.
- **Placeholders:** none — every code step has concrete code.
- **Type consistency:** `pickCanonicalRow(rows)` defined Task 2, consumed Tasks 1/3/7; `reconcileDuplicateEmails({dryRun})` defined Task 7, consumed Task 9; `mergeAccounts(primaryUuid, secondaryUuid)` unchanged signature, extended behavior Tasks 5-6.
- **Risk note:** `cds.test` import style (`require` vs dynamic `import` of the ESM `@tutorials/core`) may need adjustment to the repo's actual test harness; Task 1 Step 2's fail-run surfaces that early.
