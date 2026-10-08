# Account History Merge (email-verified) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a logged-in user (Account A) merge tutorial history from an old Account B into A, gated by an email-verification proof of ownership of B, triggered from `/me`.

**Architecture:** A net-new, feature-flagged, email-verified *trigger* reuses the existing server-side merge engine. User enters B's email → single-use hashed magic-link emailed to B → user opens it while signed in as A → explicit confirm runs `mergeAccounts` synchronously inside the request transaction (atomic). `mergeAccounts` is extended to move the per-user entities it currently skips, dedupe duplicate TaskRecords, and recompute GROUP/MISSION rollups.

**Tech Stack:** CAP Node.js (`@sap/cds`), Vitest + `cds.test()` in-memory SQLite (unit), HANA (hybrid), Hugo + Vue 3 island, nodemailer via `srv/lib/mail-client.js`.

**Spec:** `docs/superpowers/specs/2026-10-06-account-history-merge-design.md`

## Global Constraints

- **CAP data access:** `cds.ql` / CQL only — never raw SQL. (One documented exception already exists for HANA BLOBs; not relevant here.)
- **Auth:** every new action is `@requires:'authenticated-user'`; identity resolved from `req.user` via `provisionDbUser`/`resolveDbUser` — NEVER trust a user-supplied id/email as the acting identity (#1231 IDOR rule).
- **Secrets:** none hardcoded; SMTP already resolved via credstore in `mail-client.js`.
- **Namespace:** all `cds.entities(...)` calls use `'com.sap.developers.ims'`.
- **Feature flag:** entire user-facing flow gated by `ACCOUNT_MERGE_ENABLED` (kind `'db'`, ImsConfig-backed, default OFF, DEV-first) via `isFlagEnabled('ACCOUNT_MERGE_ENABLED')`.
- **Token:** plaintext revealed exactly once (in the email); DB stores only SHA-256 hex. Mirror `generateToken()` in `srv/lib/mcp-pat-actions.js`.
- **Tests:** Vitest; boot with `cds.test('serve', '--project', '.', '--in-memory')`; call unbound actions via `srv.tx({ user:{ id, roles:{'authenticated-user':true} } }, tx => tx.send({ event, data }))`.
- **Commit style:** Conventional Commits, reference `#2641`.
- **Windows/line-endings:** files are LF; after edits verify `file <path>` shows no CRLF flip before committing.

## File Structure

| File | Responsibility | Create/Modify |
|---|---|---|
| `db/account-merge.cds` | `AccountMergeRequests` verification-ledger entity | Create |
| `srv/lib/account-merge.js` | Extend engine: new entity transfers, TaskRecords dedupe, rollup recompute, idempotency guard, `movedCounts` | Modify |
| `srv/lib/account-merge-request.js` | New: token gen/hash + `handleRequestAccountMerge` / `handleConfirmAccountMerge` handlers | Create |
| `srv/developer-service.cds` | Declare `requestAccountMerge` + `confirmAccountMerge` actions | Modify |
| `srv/developer-service.js` | Register the two action handlers | Modify |
| `srv/templates/notification/account-merge-verify.html` | Magic-link email template | Create |
| `packages/core/feature-flags/registry.js` | Register `ACCOUNT_MERGE_ENABLED` flag entry | Modify |
| `hugo/content/me/merge/_index.md` | `/me/merge` subpage front matter | Create |
| `hugo/layouts/me/merge.html` | Subpage layout, mounts `#account-merge` | Create |
| `hugo/layouts/me/list.html` | Add entry panel/link to `/me/merge` | Modify |
| `hugo-apps/vite.config.ts` | Register `account-merge` island entry | Modify |
| `hugo-apps/src/account-merge/main.ts` | Island mount | Create |
| `hugo-apps/src/account-merge/AccountMerge.vue` | Request + confirm UI states | Create |
| `test/unit/account-merge-extended.test.js` | Extend with new-entity/dedupe/rollup cases | Modify |
| `test/unit/account-merge-request.test.js` | New: request/confirm action unit tests | Create |

**Task ordering:** backend engine (1-2) → ledger entity + handlers + actions (3-5) → email (6) → flag (7) → frontend (8-9) → wiring/e2e (10). Each is independently testable; backend tasks don't depend on frontend.

---

### Task 1: Extend `mergeAccounts` to move the skipped per-user entities

**Files:**
- Modify: `srv/lib/account-merge.js`
- Test: `test/unit/account-merge-extended.test.js`

**Interfaces:**
- Consumes: existing `mergeAccounts(primaryUuid, secondaryUuid)` from `srv/lib/account-merge.js`.
- Produces: same signature, now also repoints `PuzzleProgress`, `PetSubmissions`, `UserMetaData`, `UserLearningPreferences`, `SessionFavorites`, `DeveloperEnvironmentTabs`, following each entity's conflict rule. Internal helpers `transferPuzzleProgress(db, pId, sId)` etc. each return an integer moved-count.

Entity facts (from `db/schema.cds`): `PuzzleProgress` unique `[user,puzzle]`; `PetSubmissions` no per-user uniqueness; `UserMetaData` PK is `(user_ID, key)` — NO `ID` column; `UserLearningPreferences` PK is `user_ID` only — NO `ID` column; `SessionFavorites` unique `[user,sourceType,sessionRef]`; `DeveloperEnvironmentTabs` has `ID`, no per-user uniqueness.

- [ ] **Step 1: Write failing test — PuzzleProgress dedupe keeps primary's row**

Add to `test/unit/account-merge-extended.test.js` (follow the file's existing `INSERT.into(Users)` + `mergeAccounts(pid,sid)` idiom; add `Puzzles, PuzzleProgress` to the `cds.entities` destructure in `beforeAll`):

```js
it('PuzzleProgress: on (user,puzzle) conflict, primary row is kept and secondary dropped', async () => {
  const pid = cds.utils.uuid(), sid = cds.utils.uuid();
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `pp-p-${pid}@test.example` });
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `pp-s-${sid}@test.example` });
  const P = await SELECT.one.from(Users).where({ uuid: pid });
  const S = await SELECT.one.from(Users).where({ uuid: sid });
  const puz = cds.utils.uuid();
  await INSERT.into(Puzzles).entries({ ID: puz, slug: `puz-${puz}` });
  await INSERT.into(PuzzleProgress).entries({ ID: cds.utils.uuid(), user_ID: P.ID, puzzle_ID: puz, filledGrid: '{"0,0":"A"}' });
  await INSERT.into(PuzzleProgress).entries({ ID: cds.utils.uuid(), user_ID: S.ID, puzzle_ID: puz, filledGrid: '{"0,0":"Z"}' });
  await mergeAccounts(pid, sid);
  const rows = await SELECT.from(PuzzleProgress).where({ puzzle_ID: puz });
  expect(rows.length).toBe(1);
  expect(rows[0].user_ID).toBe(P.ID);
  expect(rows[0].filledGrid).toBe('{"0,0":"A"}'); // primary kept
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/account-merge-extended.test.js -t "PuzzleProgress: on"`
Expected: FAIL — secondary row still present (2 rows) because `mergeAccounts` doesn't touch `PuzzleProgress` yet.

- [ ] **Step 3: Implement the six transfer helpers + wire into `mergeAccounts`**

In `srv/lib/account-merge.js`, add `PuzzleProgress, PetSubmissions, UserMetaData, UserLearningPreferences, SessionFavorites, DeveloperEnvironmentTabs` to the `cds.entities(...)` destructure (line 4-6). Add helpers and call them after the CatGameAwards block (before the "Track the merge" block at line ~107):

```js
// Puzzle progress: unique (user,puzzle) — keep primary's row on conflict.
async function transferPuzzleProgress(PuzzleProgress, pId, sId) {
  let moved = 0;
  const rows = await SELECT.from(PuzzleProgress).where({ user_ID: sId });
  for (const r of rows) {
    const dup = await SELECT.one.from(PuzzleProgress).where({ user_ID: pId, puzzle_ID: r.puzzle_ID });
    if (dup) await DELETE.from(PuzzleProgress).where({ ID: r.ID });
    else { await UPDATE(PuzzleProgress).where({ ID: r.ID }).set({ user_ID: pId }); moved++; }
  }
  return moved;
}
// Pet submissions: no per-user uniqueness — straight repoint.
async function transferPetSubmissions(PetSubmissions, pId, sId) {
  const r = await UPDATE(PetSubmissions).where({ user_ID: sId }).set({ user_ID: pId });
  return r | 0;
}
// Developer environment tabs: has ID, no per-user uniqueness — straight repoint.
async function transferEnvTabs(DeveloperEnvironmentTabs, pId, sId) {
  const r = await UPDATE(DeveloperEnvironmentTabs).where({ user_ID: sId }).set({ user_ID: pId });
  return r | 0;
}
// Session favorites: unique (user,sourceType,sessionRef) — drop secondary dup.
async function transferSessionFavorites(SessionFavorites, pId, sId) {
  let moved = 0;
  const rows = await SELECT.from(SessionFavorites).where({ user_ID: sId });
  for (const r of rows) {
    const dup = await SELECT.one.from(SessionFavorites)
      .where({ user_ID: pId, sourceType: r.sourceType, sessionRef: r.sessionRef });
    if (dup) await DELETE.from(SessionFavorites).where({ ID: r.ID });
    else { await UPDATE(SessionFavorites).where({ ID: r.ID }).set({ user_ID: pId }); moved++; }
  }
  return moved;
}
// UserMetaData: PK (user_ID,key), NO ID column — A wins per key; else move B's.
async function transferUserMetaData(UserMetaData, pId, sId) {
  let moved = 0;
  const rows = await SELECT.from(UserMetaData).where({ user_ID: sId });
  for (const r of rows) {
    const dup = await SELECT.one.from(UserMetaData).where({ user_ID: pId, key: r.key });
    if (dup) await DELETE.from(UserMetaData).where({ user_ID: sId, key: r.key });
    else { await UPDATE(UserMetaData).where({ user_ID: sId, key: r.key }).set({ user_ID: pId }); moved++; }
  }
  return moved;
}
// UserLearningPreferences: PK user_ID only, NO ID — A wins if it has a row; else move B's.
async function transferLearningPrefs(UserLearningPreferences, pId, sId) {
  const primary = await SELECT.one.from(UserLearningPreferences).where({ user_ID: pId });
  if (primary) { await DELETE.from(UserLearningPreferences).where({ user_ID: sId }); return 0; }
  const sec = await SELECT.one.from(UserLearningPreferences).where({ user_ID: sId });
  if (!sec) return 0;
  await UPDATE(UserLearningPreferences).where({ user_ID: sId }).set({ user_ID: pId });
  return 1;
}
```

Then in `mergeAccounts`, after the CatGameAwards per-event cap loop:

```js
const moved = {};
moved.puzzleProgress   = await transferPuzzleProgress(PuzzleProgress, primaryUser.ID, secondaryUser.ID);
moved.petSubmissions   = await transferPetSubmissions(PetSubmissions, primaryUser.ID, secondaryUser.ID);
moved.envTabs          = await transferEnvTabs(DeveloperEnvironmentTabs, primaryUser.ID, secondaryUser.ID);
moved.sessionFavorites = await transferSessionFavorites(SessionFavorites, primaryUser.ID, secondaryUser.ID);
moved.userMetaData     = await transferUserMetaData(UserMetaData, primaryUser.ID, secondaryUser.ID);
moved.learningPrefs    = await transferLearningPrefs(UserLearningPreferences, primaryUser.ID, secondaryUser.ID);
```

(Keep the existing return at the end; `movedCounts` is added in Task 2 Step 3. For now `moved` is local.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/account-merge-extended.test.js -t "PuzzleProgress: on"`
Expected: PASS.

- [ ] **Step 5: Add coverage tests for the remaining five entities**

Add one `it(...)` per entity to the same file, mirroring Step 1's structure:
- `UserLearningPreferences`: A has a row → B's deleted, A unchanged; A has none, B has one → B's moved (assert exactly one row, `user_ID === P.ID`).
- `UserMetaData`: same key on both → A kept; distinct keys → both end on A.
- `SessionFavorites`: same `(sourceType,sessionRef)` → one row on A; distinct → both on A.
- `PetSubmissions` + `DeveloperEnvironmentTabs`: straight repoint — all B rows end on A.

Run: `npx vitest run test/unit/account-merge-extended.test.js`
Expected: PASS (all, including the pre-existing #2651 cases).

- [ ] **Step 6: Verify LF endings, then commit**

```bash
file srv/lib/account-merge.js test/unit/account-merge-extended.test.js   # expect no CRLF
git add srv/lib/account-merge.js test/unit/account-merge-extended.test.js
git commit -m "feat(account-merge): repoint remaining per-user entities on merge (#2641)"
```

---

### Task 2: TaskRecords dedupe + rollup recompute + idempotency guard + `movedCounts`

**Files:**
- Modify: `srv/lib/account-merge.js`
- Test: `test/unit/account-merge-extended.test.js`

**Interfaces:**
- Consumes: `rollUpParentsForCompletion` / rollup rebuild from `srv/lib/completion-rollup.js` (verify exact export name before use — `grep -n "export" srv/lib/completion-rollup.js`).
- Produces: `mergeAccounts(primaryUuid, secondaryUuid)` now (a) throws `Error('ALREADY_MERGED')` if `secondaryUuid` is already a `SecondaryAccounts` row with `status:'MERGED'`; (b) dedupes A's TaskRecords on `(taskType, taskLegacyId)` keeping COMPLETED over IN_PROGRESS then earliest `completionDate`; (c) recomputes GROUP/MISSION rollups for A; (d) returns `{ primaryUuid, secondaryUuid, status:'MERGED', movedCounts }` where `movedCounts` includes `taskRecords`, `taskRecordsDeduped`, and the Task-1 keys.

- [ ] **Step 1: Write failing test — duplicate tutorial completion dedupes to one COMPLETED row**

```js
it('TaskRecords: duplicate (taskType,taskLegacyId) dedupes keeping COMPLETED', async () => {
  const pid = cds.utils.uuid(), sid = cds.utils.uuid();
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: pid, email: `tr-p-${pid}@test.example` });
  await INSERT.into(Users).entries({ ID: cds.utils.uuid(), uuid: sid, email: `tr-s-${sid}@test.example` });
  const P = await SELECT.one.from(Users).where({ uuid: pid });
  const S = await SELECT.one.from(Users).where({ uuid: sid });
  const { TaskRecords } = cds.entities('com.sap.developers.ims');
  await INSERT.into(TaskRecords).entries({ ID: cds.utils.uuid(), user_ID: P.ID, taskType: 'TUTORIAL', taskLegacyId: 42, status: 'IN_PROGRESS' });
  await INSERT.into(TaskRecords).entries({ ID: cds.utils.uuid(), user_ID: S.ID, taskType: 'TUTORIAL', taskLegacyId: 42, status: 'COMPLETED', completionDate: '2026-01-01T00:00:00Z' });
  await mergeAccounts(pid, sid);
  const rows = await SELECT.from(TaskRecords).where({ user_ID: P.ID, taskType: 'TUTORIAL', taskLegacyId: 42 });
  expect(rows.length).toBe(1);
  expect(rows[0].status).toBe('COMPLETED');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/account-merge-extended.test.js -t "TaskRecords: duplicate"`
Expected: FAIL — two rows remain (current engine does a bulk repoint with no dedupe).

- [ ] **Step 3: Implement guard, dedupe, rollup, movedCounts**

At the top of `mergeAccounts` (after loading `secondaryUser`, before the first `UPDATE`):

```js
const already = await SELECT.one.from(SecondaryAccounts).where({ uuid: secondaryUuid, status: 'MERGED' });
if (already) { const e = new Error('ALREADY_MERGED'); e.code = 'ALREADY_MERGED'; throw e; }
```

Add a dedupe helper and call it immediately after the existing TaskRecords bulk `UPDATE` (line ~18-20):

```js
async function dedupeTaskRecords(TaskRecords, pId) {
  const rows = await SELECT.from(TaskRecords).where({ user_ID: pId });
  const groups = new Map(); // key -> rows[]
  for (const r of rows) {
    const k = `${r.taskType}|${r.taskLegacyId}`;
    (groups.get(k) ?? groups.set(k, []).get(k)).push(r);
  }
  const rank = s => (s === 'COMPLETED' ? 2 : s === 'IN_PROGRESS' ? 1 : 0);
  let deduped = 0;
  for (const [, g] of groups) {
    if (g.length < 2) continue;
    g.sort((a, b) => rank(b.status) - rank(a.status)
      || String(a.completionDate ?? '9999').localeCompare(String(b.completionDate ?? '9999')));
    for (const loser of g.slice(1)) { await DELETE.from(TaskRecords).where({ ID: loser.ID }); deduped++; }
  }
  return deduped;
}
```

Wire counts + rollup + return. Replace the final `return { ... }` with:

```js
moved.taskRecordsDeduped = await dedupeTaskRecords(TaskRecords, primaryUser.ID);
// Recompute GROUP/MISSION rollups for the primary from the merged leaf set.
const { rollUpParentsForCompletion } = await import('./completion-rollup.js'); // confirm export name
await rollUpParentsForCompletion({ ID: primaryUser.ID });
// ... existing PrimaryAccounts/SecondaryAccounts INSERTs unchanged ...
return { primaryUuid, secondaryUuid, status: 'MERGED', movedCounts: moved };
```

> If `rollUpParentsForCompletion`'s real signature differs (check the export), adapt the call; the contract is "recompute A's GROUP+MISSION TaskRecords from its current leaf completions." If no single entry point exists, call the lower-level rebuild it uses.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/account-merge-extended.test.js`
Expected: PASS (new dedupe test + all prior).

- [ ] **Step 5: Add idempotency + rollup assertion tests**

- `it('throws ALREADY_MERGED when secondary already merged')`: run `mergeAccounts` twice with same uuids; second rejects with `code: 'ALREADY_MERGED'` (`await expect(mergeAccounts(pid,sid)).rejects.toThrow('ALREADY_MERGED')`).
- `it('recomputes GROUP rollup for union of completions')`: seed STEP/TUTORIAL leaves on both A and B that together complete a GROUP; after merge assert a `GROUP` TaskRecord with `status:'COMPLETED'` exists for A. (Match `completion-rollup.js` leaf→parent expectations.)

Run: `npx vitest run test/unit/account-merge-extended.test.js`
Expected: PASS.

- [ ] **Step 6: Verify LF, commit**

```bash
file srv/lib/account-merge.js
git add srv/lib/account-merge.js test/unit/account-merge-extended.test.js
git commit -m "feat(account-merge): dedupe TaskRecords, recompute rollups, idempotency guard, movedCounts (#2641)"
```

---

### Task 3: `AccountMergeRequests` entity

**Files:**
- Create: `db/account-merge.cds`
- Test: `test/unit/account-merge-request.test.js` (schema sanity only in this task)

**Interfaces:**
- Produces: entity `com.sap.developers.ims.AccountMergeRequests` with fields `requesterUser` (assoc→Users), `targetEmail` String(254), `targetUser` (assoc→Users), `tokenHashHex` String(64) unique, `status` enum, `expiresAt`/`verifiedAt`/`mergedAt` Timestamp, `requesterIP` String(45). Consumed by Task 4-5 handlers.

- [ ] **Step 1: Write the entity**

```cds
using { com.sap.developers.ims as ims } from './schema';
using { managed, cuid } from '@sap/cds/common';

namespace com.sap.developers.ims;

@assert.unique.tokenHashHex: [tokenHashHex]
entity AccountMergeRequests : cuid, managed {
  requesterUser : Association to ims.Users @mandatory; // Account A — bound at request time
  targetEmail   : String(254);                         // Account B email (validated, lowercased)
  targetUser    : Association to ims.Users;            // resolved Account B row (null until found)
  tokenHashHex  : String(64);                          // SHA-256 of magic-link token; plaintext NEVER stored
  status        : String enum { PENDING; VERIFIED; MERGED; EXPIRED; CANCELLED; FAILED } default 'PENDING';
  expiresAt     : Timestamp;
  verifiedAt    : Timestamp;
  mergedAt      : Timestamp;
  requesterIP   : String(45);
}
```

- [ ] **Step 2: Write failing test — entity is in the model**

```js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
cds.test('serve', '--project', '.', '--in-memory');
describe('AccountMergeRequests schema', () => {
  it('entity exists with expected elements', async () => {
    const { AccountMergeRequests } = cds.entities('com.sap.developers.ims');
    expect(AccountMergeRequests).toBeTruthy();
    expect(AccountMergeRequests.elements.tokenHashHex).toBeTruthy();
    expect(AccountMergeRequests.elements.requesterUser).toBeTruthy();
  });
});
```

- [ ] **Step 3: Run — verify pass** (entity written in Step 1, so this passes once the model loads)

Run: `npx vitest run test/unit/account-merge-request.test.js -t "entity exists"`
Expected: PASS. (If FAIL "AccountMergeRequests undefined", confirm `db/account-merge.cds` is picked up — `cds.roots` globs `db/*.cds`; no manual import needed.)

- [ ] **Step 4: Commit**

```bash
file db/account-merge.cds
git add db/account-merge.cds test/unit/account-merge-request.test.js
git commit -m "feat(account-merge): add AccountMergeRequests verification-ledger entity (#2641)"
```

---

### Task 4: `requestAccountMerge` handler + action

**Files:**
- Create: `srv/lib/account-merge-request.js`
- Modify: `srv/developer-service.cds`, `srv/developer-service.js`
- Test: `test/unit/account-merge-request.test.js`

**Interfaces:**
- Consumes: `provisionDbUser` (`srv/lib/resolve-db-user.js`), `validateEmail` (`srv/lib/email-validation.js`), `isFlagEnabled` (`srv/lib/feature-flags/db-flags.js`), `sendNotificationEmail` (Task 6 adds the template; handler calls it now), `generateToken` (new, local).
- Produces: `handleRequestAccountMerge(req)` returning `{ status, expiresInMinutes }` with `status ∈ {SENT, BLOCKED_SELF, RATE_LIMITED}`; CDS action `requestAccountMerge(targetEmail:String)`.

- [ ] **Step 1: Write the handler module**

Create `srv/lib/account-merge-request.js`:

```js
// srv/lib/account-merge-request.js
// Email-verified account-history-merge request/confirm handlers (#2641).
// Token: plaintext revealed once in the email; DB stores only SHA-256 hex.
import cds from '@sap/cds';
import crypto from 'node:crypto';
import { provisionDbUser } from './resolve-db-user.js';
import { validateEmail } from './email-validation.js';
import { isFlagEnabled } from './feature-flags/db-flags.js';
import { sendNotificationEmail } from './mail-client.js';
import { mergeAccounts } from './account-merge.js';

const TTL_MIN = 30;
const RATE_LIMIT_PER_HOUR = 5;
const FLAG = 'ACCOUNT_MERGE_ENABLED';

function newToken() {
  const token = `amt_${crypto.randomBytes(32).toString('base64url')}`;
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');
  return { token, hashHex };
}
function clientIP(req) {
  return (req.headers?.['x-forwarded-for'] || req._?.req?.ip || '').split(',')[0].trim().slice(0, 45);
}

export async function handleRequestAccountMerge(req) {
  if (!isFlagEnabled(FLAG)) return req.reject(503, 'Account merge is disabled');
  const A = await provisionDbUser(req.user);
  if (!A) return req.error(401, 'unable to resolve user');

  const v = validateEmail(req.data.targetEmail);
  if (!v.ok) return req.error(400, v.code);
  const email = v.value;

  const { Users, AccountMergeRequests, SecondaryAccounts } = cds.entities('com.sap.developers.ims');

  // Rate limit: PENDING requests by A in the last hour.
  const since = new Date(Date.now() - 3600 * 1000).toISOString();
  const recent = await SELECT.from(AccountMergeRequests)
    .where({ requesterUser_ID: A.ID, status: 'PENDING', createdAt: { '>': since } });
  if (recent.length >= RATE_LIMIT_PER_HOUR) return { status: 'RATE_LIMITED', expiresInMinutes: TTL_MIN };

  const B = await SELECT.one.from(Users).where({ email });
  if (B && B.ID === A.ID) return { status: 'BLOCKED_SELF', expiresInMinutes: TTL_MIN };

  const { token, hashHex } = newToken();
  const expiresAt = new Date(Date.now() + TTL_MIN * 60 * 1000).toISOString();

  // Already-merged (B is a merged secondary, or A is a secondary): record FAILED, send no email,
  // but return the generic SENT (anti-enumeration).
  let blocked = false;
  if (B) {
    const bMerged = await SELECT.one.from(SecondaryAccounts).where({ uuid: B.uuid, status: 'MERGED' });
    const aSecondary = await SELECT.one.from(SecondaryAccounts).where({ uuid: A.uuid });
    blocked = Boolean(bMerged || aSecondary);
  }

  await INSERT.into(AccountMergeRequests).entries({
    ID: crypto.randomUUID(),
    requesterUser_ID: A.ID,
    targetEmail: email,
    targetUser_ID: B?.ID ?? null,
    tokenHashHex: hashHex,
    status: (B && !blocked) ? 'PENDING' : 'FAILED',
    expiresAt,
    requesterIP: clientIP(req) || null,
  });

  if (B && !blocked) {
    const base = process.env.APPROUTER_URL || '';
    await sendNotificationEmail({
      to: email,
      subject: 'Confirm merging your SAP tutorial history',
      template: 'account-merge-verify',
      variables: {
        link: `${base}/me/merge?token=${token}`,
        initiatorEmail: A.email || '(your current account)',
        ttlMinutes: String(TTL_MIN),
      },
    });
  }
  return { status: 'SENT', expiresInMinutes: TTL_MIN };
}
```

- [ ] **Step 2: Declare the action + register handler**

In `srv/developer-service.cds`, inside the service body add:

```cds
@(requires: 'authenticated-user')
action requestAccountMerge(targetEmail : String) returns {
  status : String;
  expiresInMinutes : Integer;
};
```

In `srv/developer-service.js`, near the other `this.on(...)` registrations (e.g. by `getMyCompletions` ~line 512), add an import at top and:

```js
import { handleRequestAccountMerge } from './lib/account-merge-request.js';
// ...
this.on('requestAccountMerge', handleRequestAccountMerge);
```

- [ ] **Step 3: Write failing tests**

Add to `test/unit/account-merge-request.test.js` (use `__setFlagForTest`/`__resetFlagsForTest` from `srv/lib/feature-flags/db-flags.js` to force the flag on; mock mail by `vi.mock('../../srv/lib/mail-client.js', () => ({ sendNotificationEmail: vi.fn().mockResolvedValue({success:true}) }))`):

```js
it('BLOCKED_SELF when target email resolves to the caller', async () => {
  __setFlagForTest('ACCOUNT_MERGE_ENABLED', true);
  // caller provisioned with email alice@x; request same email
  const r = await callAction(srv, 'requestAccountMerge', { targetEmail: 'alice@x.example' }, { id: 'alice@x.example' });
  expect(r.status).toBe('BLOCKED_SELF');
});
it('SENT + stores hash-only + emails B when B exists', async () => {
  __setFlagForTest('ACCOUNT_MERGE_ENABLED', true);
  // seed B with email bob@x; caller is alice
  const r = await callAction(srv, 'requestAccountMerge', { targetEmail: 'bob@x.example' });
  expect(r.status).toBe('SENT');
  const { AccountMergeRequests } = cds.entities('com.sap.developers.ims');
  const [row] = await SELECT.from(AccountMergeRequests).orderBy('createdAt desc').limit(1);
  expect(row.tokenHashHex).toMatch(/^[0-9a-f]{64}$/);
  expect(row.status).toBe('PENDING');
  expect(sendNotificationEmail).toHaveBeenCalledWith(expect.objectContaining({ to: 'bob@x.example' }));
});
it('RATE_LIMITED after 5 pending requests in an hour', async () => { /* loop 5 requests, assert 6th RATE_LIMITED */ });
it('503 when flag OFF', async () => {
  __resetFlagsForTest();
  await expect(callAction(srv, 'requestAccountMerge', { targetEmail: 'bob@x.example' })).rejects.toBeTruthy();
});
```

Copy the `callAction` helper + ALICE seeding from `test/unit/mcp-pats-service.test.js`; `srv = await cds.connect.to('DeveloperService')`; seed Users for alice & bob in `beforeAll`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/unit/account-merge-request.test.js`
Expected: PASS.

- [ ] **Step 5: Verify LF, commit**

```bash
file srv/lib/account-merge-request.js srv/developer-service.js srv/developer-service.cds
git add srv/lib/account-merge-request.js srv/developer-service.js srv/developer-service.cds test/unit/account-merge-request.test.js
git commit -m "feat(account-merge): requestAccountMerge action with email verification (#2641)"
```

---

### Task 5: `confirmAccountMerge` handler + action

**Files:**
- Modify: `srv/lib/account-merge-request.js`, `srv/developer-service.cds`, `srv/developer-service.js`
- Test: `test/unit/account-merge-request.test.js`

**Interfaces:**
- Consumes: `mergeAccounts` (Tasks 1-2), the ledger entity, `provisionDbUser`.
- Produces: `handleConfirmAccountMerge(req)` returning `{ status, movedCounts }` with `status ∈ {MERGED, INVALID, EXPIRED, WRONG_ACCOUNT, ALREADY_MERGED, FAILED}`; action `confirmAccountMerge(token:String)`. Runs inside the request tx → atomic.

- [ ] **Step 1: Write failing test — WRONG_ACCOUNT when confirmer ≠ requester**

```js
it('WRONG_ACCOUNT when a different user opens the link', async () => {
  __setFlagForTest('ACCOUNT_MERGE_ENABLED', true);
  // alice requests merge of bob; carol confirms the token
  await callAction(srv, 'requestAccountMerge', { targetEmail: 'bob@x.example' }); // alice
  const token = __lastTokenForTest; // see Step 3 test seam
  const r = await callAction(srv, 'confirmAccountMerge', { token }, { id: 'carol@x.example' });
  expect(r.status).toBe('WRONG_ACCOUNT');
});
```

- [ ] **Step 2: Run — verify fail**

Run: `npx vitest run test/unit/account-merge-request.test.js -t "WRONG_ACCOUNT"`
Expected: FAIL — `confirmAccountMerge` not registered yet.

- [ ] **Step 3: Implement handler + test seam + register**

Add to `srv/lib/account-merge-request.js`:

```js
export async function handleConfirmAccountMerge(req) {
  if (!isFlagEnabled(FLAG)) return req.reject(503, 'Account merge is disabled');
  const A = await provisionDbUser(req.user);
  if (!A) return req.error(401, 'unable to resolve user');

  const token = String(req.data.token || '');
  const hashHex = crypto.createHash('sha256').update(token).digest('hex');
  const { AccountMergeRequests, Users } = cds.entities('com.sap.developers.ims');

  const reqRow = await SELECT.one.from(AccountMergeRequests).where({ tokenHashHex: hashHex });
  if (!reqRow) return { status: 'INVALID', movedCounts: '{}' };
  if (reqRow.status !== 'PENDING') return { status: 'INVALID', movedCounts: '{}' };
  if (new Date(reqRow.expiresAt).getTime() < Date.now()) {
    await UPDATE(AccountMergeRequests).where({ ID: reqRow.ID }).set({ status: 'EXPIRED' });
    return { status: 'EXPIRED', movedCounts: '{}' };
  }
  if (reqRow.requesterUser_ID !== A.ID) return { status: 'WRONG_ACCOUNT', movedCounts: '{}' };

  const B = await SELECT.one.from(Users).where({ ID: reqRow.targetUser_ID });
  if (!B) return { status: 'INVALID', movedCounts: '{}' };

  try {
    const result = await mergeAccounts(A.uuid, B.uuid); // same request tx → atomic
    await UPDATE(AccountMergeRequests).where({ ID: reqRow.ID })
      .set({ status: 'MERGED', verifiedAt: new Date().toISOString(), mergedAt: new Date().toISOString() });
    return { status: 'MERGED', movedCounts: JSON.stringify(result.movedCounts || {}) };
  } catch (e) {
    if (e.code === 'ALREADY_MERGED') return { status: 'ALREADY_MERGED', movedCounts: '{}' };
    req.error(500, 'merge failed'); // rolls back the request tx
    return { status: 'FAILED', movedCounts: '{}' };
  }
}
```

Add a tiny test seam so the test can read the plaintext token: in Task 4's `newToken()` call site, when `process.env.NODE_ENV === 'test'` set `globalThis.__lastTokenForTest = token`. (Guarded; never fires in prod.)

Declare in `.cds`:

```cds
@(requires: 'authenticated-user')
action confirmAccountMerge(token : String) returns {
  status : String;
  movedCounts : String;
};
```

Register in `.js`: `import { handleConfirmAccountMerge } ...` and `this.on('confirmAccountMerge', handleConfirmAccountMerge);`.

- [ ] **Step 4: Run — verify pass**

Run: `npx vitest run test/unit/account-merge-request.test.js -t "WRONG_ACCOUNT"`
Expected: PASS.

- [ ] **Step 5: Add remaining confirm tests**

- happy path: alice confirms bob's token → `MERGED`, `movedCounts` parses to an object; bob's TaskRecords now on alice.
- expired: insert a ledger row with past `expiresAt` → `EXPIRED`.
- invalid: random token → `INVALID`.
- rollback: seed a condition that makes `mergeAccounts` throw a non-ALREADY_MERGED error (e.g. stub) → `FAILED` and assert ledger row still `PENDING` and A's records unchanged.

Run: `npx vitest run test/unit/account-merge-request.test.js`
Expected: PASS.

- [ ] **Step 6: Verify LF, commit**

```bash
file srv/lib/account-merge-request.js
git add srv/lib/account-merge-request.js srv/developer-service.js srv/developer-service.cds test/unit/account-merge-request.test.js
git commit -m "feat(account-merge): confirmAccountMerge action, atomic synchronous merge (#2641)"
```

---

### Task 6: Email template

**Files:**
- Create: `srv/templates/notification/account-merge-verify.html`

**Interfaces:**
- Consumes: `resolveTemplate` substitutes `${link}`, `${initiatorEmail}`, `${ttlMinutes}` (the `/\$\{(\w+)\}/g` substitution in `mail-client.js`).
- Produces: template file loadable by `loadTemplate('account-merge-verify')`.

- [ ] **Step 1: Write the template**

```html
<!doctype html><html><body style="font-family:Arial,sans-serif;max-width:560px;margin:auto">
  <h2>Confirm merging your SAP tutorial history</h2>
  <p><strong>${initiatorEmail}</strong> asked to merge the SAP tutorial completion history
     from <strong>this</strong> account into it.</p>
  <p>If that was you, open the link below <strong>while signed in as the account you want to keep</strong>
     to confirm. This permanently moves this account's history and cannot be undone.</p>
  <p><a href="${link}" style="background:#0a6ed1;color:#fff;padding:10px 18px;border-radius:4px;text-decoration:none">Confirm merge</a></p>
  <p style="color:#666">This link expires in ${ttlMinutes} minutes. If you didn't request this, ignore this email — nothing will happen.</p>
</body></html>
```

- [ ] **Step 2: Write failing test — template loads & substitutes**

In `test/unit/account-merge-request.test.js`:

```js
it('email template renders link and initiator', async () => {
  const { loadTemplate, resolveTemplate } = await import('../../srv/lib/mail-client.js');
  const html = resolveTemplate(loadTemplate('account-merge-verify'),
    { link: 'https://x/me/merge?token=T', initiatorEmail: 'a@x', ttlMinutes: '30' });
  expect(html).toContain('https://x/me/merge?token=T');
  expect(html).toContain('a@x');
  expect(html).toContain('30 minutes');
});
```

- [ ] **Step 3: Run — verify pass** (template exists from Step 1)

Run: `npx vitest run test/unit/account-merge-request.test.js -t "email template renders"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
file srv/templates/notification/account-merge-verify.html
git add srv/templates/notification/account-merge-verify.html test/unit/account-merge-request.test.js
git commit -m "feat(account-merge): verification email template (#2641)"
```

---

### Task 7: Register `ACCOUNT_MERGE_ENABLED` feature flag

**Files:**
- Modify: `packages/core/feature-flags/registry.js`
- Test: existing `test/unit/feature-flags-registry.test.js` (drift guard) must stay green.

**Interfaces:**
- Produces: registry entry so `isFlagEnabled('ACCOUNT_MERGE_ENABLED')` is a managed key and the drift test passes.

- [ ] **Step 1: Add the entry**

In `packages/core/feature-flags/registry.js`, append to `FEATURE_FLAGS` (use the `featureFlagUpsert` helper already defined in-file):

```js
{
  key: 'ACCOUNT_MERGE_ENABLED', label: 'Account history merge (email-verified)',
  category: 'Users', kind: 'db', imsConfigKey: 'account.merge.enabled',
  valueType: 'boolean', default: false, issue: '#2641', status: 'dev-only',
  description: 'Self-service /me/merge: verify ownership of an old account by email, then merge its tutorial history into the current account. DEV-first, default OFF.',
  howToChange: featureFlagUpsert('ACCOUNT_MERGE_ENABLED', 'account.merge.enabled'),
},
```

> Confirm the exact `kind:'db'` required fields against a sibling `kind:'db'` entry in the same file (e.g. grep for `imsConfigKey`); match its property set exactly so the drift test passes.

- [ ] **Step 2: Run the drift guard**

Run: `npx vitest run test/unit/feature-flags-registry.test.js`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/core/feature-flags/registry.js
git commit -m "feat(account-merge): register ACCOUNT_MERGE_ENABLED feature flag (#2641)"
```

---

### Task 8: `/me/merge` Hugo subpage + entry panel

**Files:**
- Create: `hugo/content/me/merge/_index.md`, `hugo/layouts/me/merge.html`
- Modify: `hugo/layouts/me/list.html`

**Interfaces:**
- Consumes: `{{ partial "island-src.html" "account-merge" }}` (island registered in Task 9).
- Produces: route `/me/merge` with mount div `#account-merge`; a panel on `/me` linking to it.

- [ ] **Step 1: Create the subpage** — mirror `hugo/layouts/me/tokens.html` exactly, swapping `tokens`→`account-merge` / `#api-tokens`→`#account-merge`. Front matter in `_index.md`: `layout: merge`, `private: true`, title "Merge account history". (Read `hugo/content/me/tokens/_index.md` + `hugo/layouts/me/tokens.html` first and match structure.)

- [ ] **Step 2: Add entry panel on `/me`** — in `hugo/layouts/me/list.html`, after the API Tokens panel block, add a panel linking to `/me/merge/` with the same markup pattern (read the existing API-tokens panel block and mirror it).

- [ ] **Step 3: Verify the build renders the route**

Run: `npm run fetch-tutorials && npm run dev` (or `hugo` build) and confirm `/me/merge/index.html` is generated with `id="account-merge"`. (If a lighter check is wanted: `hugo --quiet && test -f public/me/merge/index.html`.)
Expected: file exists, contains the mount div.

- [ ] **Step 4: Commit**

```bash
git add hugo/content/me/merge/_index.md hugo/layouts/me/merge.html hugo/layouts/me/list.html
git commit -m "feat(account-merge): /me/merge subpage and entry panel (#2641)"
```

---

### Task 9: `account-merge` Vue island

**Files:**
- Create: `hugo-apps/src/account-merge/main.ts`, `hugo-apps/src/account-merge/AccountMerge.vue`
- Modify: `hugo-apps/vite.config.ts`

**Interfaces:**
- Consumes: `DeveloperService` actions `POST /api/requestAccountMerge` and `POST /api/confirmAccountMerge` (OData action invocation; mirror how `ApiTokens.vue` calls its service).
- Produces: island entry `account-merge` → `src/account-merge/main.ts`; component with the two states.

- [ ] **Step 1: Register the island entry** — in `hugo-apps/vite.config.ts` input map (near `me` / `tokens` entries, ~line 296), add `'account-merge': 'src/account-merge/main.ts'`.

- [ ] **Step 2: Write `main.ts`** — mirror `hugo-apps/src/tokens/main.ts`: create the Vue app, mount `AccountMerge` on `#account-merge`.

- [ ] **Step 3: Write `AccountMerge.vue`** — model on `hugo-apps/src/tokens/ApiTokens.vue`. Two states:
  - needs-login gate (reuse ApiTokens' pattern).
  - **Request state** (no `?token=`): email `<input>` + "Send verification email" → `POST /api/requestAccountMerge` with `{ targetEmail }`; render `SENT`→generic "if that account exists, we sent a link; open it while signed in here", `BLOCKED_SELF`/`RATE_LIMITED`→specific messages.
  - **Confirm state** (`new URLSearchParams(location.search).get('token')` present): read-only banner "permanently merge history from the other account into this one — cannot be undone" + Confirm button → `POST /api/confirmAccountMerge` with `{ token }`; render `MERGED` (+ parsed `movedCounts` summary and link to `/me`), `WRONG_ACCOUNT`, `EXPIRED`/`INVALID` (offer restart).

- [ ] **Step 4: Build the islands + verify bundle**

Run: `cd hugo-apps && npm run build` (or the repo's island build script) and confirm an `account-merge` chunk is emitted and `hugo/data/island_manifest.json` gains the entry.
Expected: manifest contains `account-merge`.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/account-merge/ hugo-apps/vite.config.ts hugo/data/island_manifest.json
git commit -m "feat(account-merge): /me/merge Vue island (request + confirm states) (#2641)"
```

---

### Task 10: Full test sweep, e2e spec, deploy-list audit

**Files:**
- Create: `test/e2e/account-merge.e2e.test.js` (self-skips without `SMOKE_BASE_URL`)
- Verify: `.deploy/mta.yaml` `srv-qa` `cp` list; hybrid run.

- [ ] **Step 1: Full unit sweep**

Run: `npm test`
Expected: all green, including the two account-merge files and the flag drift guard.

- [ ] **Step 2: `srv-qa` cp-list audit** — new file `srv/lib/account-merge-request.js` is imported by `srv/developer-service.js`, not by `content-store.js`'s closure, so it should NOT need adding to the `srv-qa` `cp` list; **confirm** by walking `content-store.js` transitive `./` imports (CLAUDE.md rule). Document the result in the commit message. If any new shared-lib import does cross into that closure, add it to `.deploy/mta.yaml`.

- [ ] **Step 3: Write the e2e spec** — mirror an existing `test/e2e/*.e2e.test.js`: self-skip when `!process.env.SMOKE_BASE_URL`; assert `/me/merge` renders the mount + request form. (Confirm step is exercised in hybrid, not e2e, since it needs a seeded token.)

- [ ] **Step 4: Hybrid end-to-end (real HANA)**

Run: `npm run test:hybrid` (requires `cf login`; see CLAUDE.md). Add/confirm one request→confirm→merge path against HANA.
Expected: PASS, or documented HANA-specific follow-up.

- [ ] **Step 5: Commit**

```bash
git add test/e2e/account-merge.e2e.test.js
git commit -m "test(account-merge): e2e smoke spec + full-sweep verification (#2641)"
```

---

## Self-Review

- **Spec coverage:** entity (T3), request action+safety rails (T4), confirm+atomic merge (T5), full merge coverage + dedupe + rollups (T1-2), email magic-link (T6), flag (T7), /me entry + subpage (T8), island two-state UI (T9), tests + rollout audit (T10). All spec sections mapped.
- **Placeholder scan:** code blocks are concrete; the two "confirm exact export/shape" notes (rollup fn name T2, `kind:'db'` field set T7) are explicit verify-then-adapt instructions against named files, not vague TODOs.
- **Type consistency:** `movedCounts` is a JSON string end-to-end (engine returns object → confirm handler `JSON.stringify` → action `String` → island `JSON.parse`); `generateToken` reused name is PAT's; new token helper is `newToken()` (distinct, intentional); status enums match between CDS entity, handlers, and tests.

## Rollout (post-merge, from spec)

Flag OFF by default → deploy DEV via full `npm run deploy -- --env dev` (no `--skip-build`, no `-m`; island bundle must ship) → verify on HANA with `npm run setup-dev-data` + confirm emails arrive → flip `ACCOUNT_MERGE_ENABLED` on in DEV via `AdminService.setFeatureFlag` → soak → promote to prod, flag OFF→on. Kill-switch = flip flag off.
