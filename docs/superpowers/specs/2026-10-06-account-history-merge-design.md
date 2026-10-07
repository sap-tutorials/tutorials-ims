# Account History Merge (email-verified) — Design

**Issue:** [sap-tutorials/tutorials-ims#2641](https://github.com/sap-tutorials/tutorials-ims/issues/2641)
**Date:** 2026-10-06
**Status:** Approved design, pre-implementation

## Problem

A developer is logged in as **Account A** but has tutorial completion history under an
old **Account B** (different email — common as people change companies; Universal ID
does not fully solve it when a person holds multiple Universal IDs). We need a
self-service way, from the `/me` page, for the user to merge Account B's history into
Account A — **but only after proving ownership of Account B via email verification**.
The user triggers verification from `/me`, and only after verifying returns to perform
the permanent merge.

## Scope decisions (locked)

- **One-to-one, one-shot:** merge exactly one verified Account B into the current
  Account A as a single permanent operation. Repeatable later for another old account.
  No un-merge, no choose-primary-direction, no many-B batch. (YAGNI.)
- **Proof of ownership:** magic-link emailed to Account B's address.
- **Link binding:** the verification link confirms only inside an authenticated
  **Account A** session (the confirming JWT must match the requester who started the flow).
- **Merge coverage:** full — move every per-user entity and recompute completion rollups.
- **Execution:** synchronous on confirm (runs inside the request transaction → atomic).
- **Safety rails:** block self-merge; block already-merged accounts; short-lived
  single-use token; rate-limit verification emails.
- **Gating:** DB feature flag `ACCOUNT_MERGE_ENABLED`, default **OFF**, DEV-first.

## Approach

**Reuse-and-extend.** The server already has a merge engine
(`srv/lib/account-merge.js` `mergeAccounts(primaryUuid, secondaryUuid)`) driven today by
admin/cron paths via `SecondaryAccounts.status='SCHEDULED'`. This feature adds a
**net-new, user-facing, email-verified trigger** and **extends the engine** to lose no
history. Email sending (`srv/lib/mail-client.js` `sendNotificationEmail`) and hash-only
single-reveal token minting (`srv/lib/mcp-pat-actions.js`) already exist as patterns to
copy.

## Components

### 1. Data model — `AccountMergeRequests` (verification ledger)

New entity (new file `db/account-merge.cds`, or appended to `db/schema.cds`), modeled on
`PATs` (`db/mcp-pats.cds`) — hash-only, expiring, single-use.

```cds
entity AccountMergeRequests : cuid, managed {
  requesterUser   : Association to Users @mandatory;  // Account A, bound at request time
  targetEmail     : String(254);                      // Account B email (validated, lowercased)
  targetUser      : Association to Users;              // resolved Account B row (null until found)
  tokenHashHex    : String(64);                        // SHA-256 of magic-link token; plaintext NEVER stored
  status          : String enum {
                      PENDING; VERIFIED; MERGED; EXPIRED; CANCELLED; FAILED };
  expiresAt       : Timestamp;                          // request time + TTL (30 min)
  verifiedAt      : Timestamp;
  mergedAt        : Timestamp;
  requesterIP     : String;                             // audit, mirrors PATs.createdFromIP
}
```

- `tokenHashHex` unique; store only SHA-256, reveal plaintext once (in the emailed link),
  exactly like `generateToken()` in `mcp-pat-actions.js`.
- `requesterUser` binds the flow to Account A; confirm requires the JWT to resolve to this
  same user.
- `targetEmail` normalized/validated via `srv/lib/email-validation.js` `validateEmail`.
- `targetUser` resolved at **request** time so self-merge / already-merged checks run
  before any email is sent.
- The **final** merge record remains the existing `PrimaryAccounts` / `SecondaryAccounts`
  rows written by `mergeAccounts`. `AccountMergeRequests` is the verification ledger, not a
  second merge record.

### 2. Service actions & auth — on `DeveloperService`

`DeveloperService` (`srv/developer-service.cds`, `@requires:'any'` with per-endpoint
`authenticated-user`) already owns the other `/me` reads and the island already talks to
it. Both actions are **JWT-scoped — never trust a user-supplied identity** (the #1231 IDOR
guidance). Both check `isFlagEnabled('ACCOUNT_MERGE_ENABLED')` first and return a
disabled/404 response when off.

```cds
action requestAccountMerge(targetEmail : String) returns {
  status : String;        // 'SENT' (anti-enumeration default) | 'BLOCKED_SELF' | 'RATE_LIMITED'
  expiresInMinutes : Integer;
};
action confirmAccountMerge(token : String) returns {
  status : String;        // 'MERGED' | 'INVALID' | 'EXPIRED' | 'WRONG_ACCOUNT' | 'ALREADY_MERGED' | 'FAILED'
  movedCounts : String;   // JSON summary {taskRecords, prizes, puzzles, ...}
};
```

**`requestAccountMerge(targetEmail)`** handler (`srv/developer-service.js`):
1. `provisionDbUser(req.user)` → Account A row (A).
2. `validateEmail(targetEmail)` → normalized email; invalid → reuse validator error codes.
3. Rate-limit: count A's `PENDING` requests in the last hour; `>= N` (N=5) → `RATE_LIMITED`.
4. Resolve B = `SELECT.one.from(Users).where lower(email)=…`. Safety:
   - `B.ID === A.ID` → `BLOCKED_SELF`.
   - B already a `SecondaryAccounts`, or A already a secondary → return generic `SENT`
     (no leak), record the request `FAILED` with reason, send **no** email.
5. If B exists and passes: generate token, insert `AccountMergeRequests` with
   `tokenHashHex`, `expiresAt`, `requesterIP`, `status:'PENDING'`; email the link to **B's
   email** (component 4).
6. Return `{status:'SENT', expiresInMinutes:30}` in all cases except the explicit
   `BLOCKED_SELF` / `RATE_LIMITED` (which reveal nothing about B's existence).

**`confirmAccountMerge(token)`** handler — runs inside the request transaction, so any
throw rolls the whole merge back:
1. `provisionDbUser(req.user)` → confirming user (expected = A).
2. Hash token; `SELECT.one.from(AccountMergeRequests).where({tokenHashHex})`. Not found →
   `INVALID`.
3. `status !== 'PENDING'` → `INVALID`; `expiresAt < now` → set `EXPIRED`, return `EXPIRED`.
4. `requesterUser.ID !== confirmingUser.ID` → `WRONG_ACCOUNT` (the "confirm in
   authenticated A session" binding).
5. Re-run safety against current state (B still not already-merged) → `ALREADY_MERGED`.
6. Call extended `mergeAccounts(A.uuid, B.uuid)` (component 3). On throw: request tx rolls
   back, request stays `PENDING`/recoverable, return `FAILED`.
7. Mark request `MERGED` + `mergedAt`; return `{status:'MERGED', movedCounts}`.

### 3. Extended merge engine — `srv/lib/account-merge.js`

Extend `mergeAccounts(primaryUuid, secondaryUuid)` so a user-initiated merge loses nothing
and returns a `movedCounts` summary. Benefits the admin and dedup-job paths too (shared
engine).

**New entities to repoint** (close the gap: the current engine moves only TaskRecords,
PrizeRecords, AccomplishmentRecords, UserIdentities, EventRegistrations, CatGameAwards):

| Entity | Key beyond user | Conflict rule |
|---|---|---|
| `PuzzleProgress` | puzzle | keep more-complete/earlier row; delete B dup |
| `PetSubmissions` | per submission | straight repoint (no per-user uniqueness) |
| `UserMetaData` | user (+visitorId) | A wins if present; else move B's |
| `UserLearningPreferences` | **user_ID is whole PK** | A wins if A has a row; else move B's (never two) |
| `SessionFavorites` | session | repoint; drop B dup on same session |
| `DeveloperEnvironmentTabs` | per tab | straight repoint |

**TaskRecords dedupe + rollup recompute** (new logic — the current engine does a bulk
`UPDATE … set user_ID` that can create duplicate `(user_ID, taskType, taskLegacyId)` rows
and leaves GROUP/MISSION rollups stale):
1. After repointing TaskRecords, **dedupe** A on `(taskType, taskLegacyId)` — keep the best
   row (`COMPLETED` > `IN_PROGRESS`; earliest `completionDate`), delete the loser. Fixes a
   latent bug present even for the engine's existing entities.
2. **Recompute rollups** via `srv/lib/completion-rollup.js` for A's affected leaf
   completions (`rollUpParentsForCompletion` / rebuild GROUP+MISSION) so parent completion
   reflects the union.

**Structure.** Keep `mergeAccounts` as orchestrator; split per-entity transfers into small
named helpers in the same file (`transferTaskRecords`, `dedupeTaskRecords`,
`transferPuzzleProgress`, …). Each returns a moved/deduped count; orchestrator aggregates
into `movedCounts`.

**Atomicity.** No `cds.tx` wrapper inside `mergeAccounts` — it inherits the caller's
transaction (confirm action request tx; the batch job's tx). Document: **must be called
within a transaction.**

**Idempotency guard.** First line: if B is already a `SecondaryAccounts` with status
`MERGED`, throw/`ALREADY_MERGED` so a double-confirm cannot double-apply CatGameAwards caps.

### 4. Email (magic link) — `srv/lib/mail-client.js`

Reuse `sendNotificationEmail`; add template
`srv/templates/notification/account-merge-verify.html`.

- **To:** Account B's email. **From:** `developers@sap.com` (default).
- **Link:** `${APPROUTER_URL}/me/merge?token=<plaintext>` → the authenticated `/me/merge`
  subpage, so clicking lands in the user's logged-in session (approuter forces login).
  Plaintext token appears **only** here; DB stores only the hash.
- **Body:** names the initiating account and the direction explicitly — "Account A
  (`a@…`) requested to merge the SAP tutorial history from **this** account into it. If
  this was you, open the link **while signed in as the account you want to keep** to
  confirm. The link expires in 30 minutes. If you didn't request this, ignore this email —
  nothing happens." (Phishing/clarity safeguard.)
- SMTP failure → existing `FailedEmails` queue + `retryFailedEmails()` applies automatically.
- **Anti-enumeration:** `requestAccountMerge` returns the same `SENT` whether or not B
  exists; mail only ever goes to a real inbox.

### 5. Frontend — `/me/merge`

Mirror the existing `/me/tokens` structure (closest template).

- **Entry point:** add a "Merge history from another account" panel/link on
  `hugo/layouts/me/list.html` pointing to `/me/merge`, matching the existing
  "API Tokens → /me/tokens/" pattern.
- **Subpage:** `hugo/content/me/merge/_index.md` (`private: true`, skipped under
  `site.Params.qa`) + `hugo/layouts/me/merge.html` mounting `#account-merge` — mirrors
  `hugo/layouts/me/tokens.html`.
- **Island:** `account-merge` registered in `hugo-apps/vite.config.ts` input map;
  `hugo-apps/src/account-merge/main.ts` + `AccountMerge.vue`, modeled on
  `hugo-apps/src/tokens/ApiTokens.vue` (needs-login gating; calls the authenticated
  `DeveloperService` actions).

**Two states in one component:**
1. **Request** (default): email input + "Send verification email" → `requestAccountMerge`.
   Shows generic "If that account exists, we've sent a link to it — check that inbox and
   open the link while signed in here." Plus explicit `BLOCKED_SELF` / `RATE_LIMITED`
   messages.
2. **Confirm** (page loaded with `?token=…`): auto-read token from query; show "You're
   about to permanently merge history from **B** into **A (you)**. This can't be undone." +
   confirm button → `confirmAccountMerge(token)`. On `MERGED`: success panel with moved
   summary + link back to `/me`. On `WRONG_ACCOUNT`: "sign in as the account you're keeping"
   guidance. On `EXPIRED`/`INVALID`: offer to restart.

The irreversible merge happens **only** on the explicit confirm click in state 2 — never on
link-open alone — satisfying the issue's "verify first, then return and do the permanent
merge" sequence.

## Testing

Project splits unit / hybrid / smoke / e2e. The merge engine is DB-agnostic `cds.ql`, so
logic is unit-tested on in-memory SQLite; HANA-specific behavior covered by hybrid.

**Unit (`npm test`, in-memory SQLite):**
- `mergeAccounts` extended coverage: each new entity repointed; dedupe conflict rules
  (two rows → one, correct winner); TaskRecords dedupe on `(taskType, taskLegacyId)`;
  rollup recompute yields correct GROUP/MISSION completion for the union; idempotency guard
  rejects double-merge; existing CatGameAwards caps still hold.
- `requestAccountMerge`: self-merge blocked; already-merged → generic `SENT` + no email;
  rate-limit trips at N; email validation; token stored hash-only (plaintext never
  persisted); flag-off → disabled.
- `confirmAccountMerge`: happy path; `WRONG_ACCOUNT` when JWT ≠ requester; expired; invalid;
  already-merged; **throw mid-merge rolls back** (assert A unchanged, request not `MERGED`).
- Mail: assert `sendNotificationEmail` called with B's address + both account identifiers in
  variables (mock transport).

**Hybrid (`npm run test:hybrid`, real HANA via `cds bind --exec`):** one end-to-end
request → confirm → merge against HANA to catch LOB/SQL-dialect issues SQLite can't.

**e2e (`npm run test:e2e`, post-DEV-deploy, self-skips without `SMOKE_BASE_URL`):**
Playwright — `/me` shows the merge panel; `/me/merge` request state submits; confirm state
with a seeded token merges. (Advisory PR e2e nudge fires on `app/**`/`hugo/**` changes.)

## Rollout

1. `ACCOUNT_MERGE_ENABLED` DB flag default **OFF**, DEV-first. Ship dark.
2. Deploy to DEV; verify engine on real HANA with test accounts (`npm run setup-dev-data`);
   confirm emails actually arrive (SMTP via credstore).
3. Flip flag on in DEV; exercise full UX; verify rollups + no orphaned rows.
4. Promote to prod flag-off → on after soak. Kill-switch = flip flag off.

**Deploy caveats (from CLAUDE.md):**
- Touches `srv/lib/` → re-walk the `srv-qa` `cp` list in `.deploy/mta.yaml` for any new
  transitive `./` imports from `content-store.js`'s dependency closure (this engine is not a
  content-store dep, but confirm no new shared-lib import crosses over).
- Island + any admin-adjacent change → full `npm run deploy -- --env <env>` (NO
  `--skip-build`, NO `-m` scoping) so the island bundle ships; never bypass the shipped-bundle
  check.

## Out of scope (YAGNI)

Many-B-over-time; un-merge/undo; choosing primary direction; non-email proofs (OTP,
re-login). One-to-one, one-shot per the locked scope.

## Key files

| Area | File(s) |
|---|---|
| New entity | `db/account-merge.cds` (or appended to `db/schema.cds`) |
| Actions + handlers | `srv/developer-service.cds`, `srv/developer-service.js` |
| Merge engine | `srv/lib/account-merge.js` (extended) |
| Rollups | `srv/lib/completion-rollup.js` (reused) |
| Email | `srv/lib/mail-client.js` (reused) + `srv/templates/notification/account-merge-verify.html` (new) |
| Token pattern reference | `srv/lib/mcp-pat-actions.js`, `db/mcp-pats.cds` |
| Validation | `srv/lib/email-validation.js` (reused) |
| Identity resolution | `srv/lib/resolve-db-user.js` (`provisionDbUser`, `resolveDbUser`) |
| Final merge record | `db/schema.cds` `PrimaryAccounts` / `SecondaryAccounts` (reused) |
| Frontend subpage | `hugo/content/me/merge/_index.md`, `hugo/layouts/me/merge.html`, `hugo/layouts/me/list.html` (entry panel) |
| Island | `hugo-apps/vite.config.ts`, `hugo-apps/src/account-merge/{main.ts,AccountMerge.vue}` |
| Feature flag | `srv/lib/feature-flags/db-flags.js` (`isFlagEnabled('ACCOUNT_MERGE_ENABLED')`) |
