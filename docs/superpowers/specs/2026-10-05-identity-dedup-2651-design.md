# Identity dedup — resolve & reconcile duplicate `Users` rows (#2651)

**Date:** 2026-10-05
**Issue:** [#2651](https://github.com/sap-tutorials/tutorials-ims/issues/2651) — Kasimir cat-game points not reaching the Devtoberfest leaderboard
**Status:** approved design → implementation

## Problem

The same human ends up with **multiple `Users` rows**, discriminated by **email** (not sapId). Confirmed against PROD (schema `2FEC…`, 817,333 Users):

- **349 duplicate-email clusters / 719 rows** — the fork population.
- **0 duplicate non-null sapIds** — forks are rows with *different* UUID sapIds for one human, not sapId collisions.
- Cat-game impact: **137 users / 167 award rows / 835 points** stranded (awards on a row with no `EventRegistration`).

### Mechanism

Cat-game awards (`CatGameAwards`) are written keyed to the `Users.ID` the *current* login resolves to. The leaderboard (`GAMEBOARD_PARTICIPANT_V1`, an inner join to `EventRegistrations`) only credits a row that has a registration. When a login reaches the same human via a different IdP/claim set and lands on (or mints) a second row, new awards accrue there while the registration + history stay on the original row → the counter climbs but the leaderboard total is frozen.

Reporter's data: two `Users` rows, same email, different UUID sapIds — Row A (older) 55 pts + registration (leaderboard-visible), Row B (newer, Oct) the recent catches, no registration. Both sapIds are UUIDs; reporter uses SAP ID only (no social) → this is **core resolution**, affecting SAP-ID-only users.

### Root causes (from `packages/core/resolve-db-user.js`)

1. **`provisionDbUser` create-path is not atomic and Tier-3 email merge is last/conditional.** `resolveUser` tiers are (iss,sub) → sapId → email. A social/IAS login provisions `sapId=null`; a later XSUAA/SAP-ID login for the same human misses Tier-1 (different iss,sub) and Tier-2 (different/null sapId), and Tier-3 only matches if `tokenEmail` is present and an existing row's email is populated — otherwise a **second row** is inserted. No DB uniqueness on `Users.sapId`; the direct `cds.db` INSERT bypasses `@assert.unique.sapId`.
2. **No reconciliation for already-forked rows.** The legacy `mergeAccounts(primaryUuid, secondaryUuid)` (`srv/lib/account-merge.js`) is uuid-keyed and only repoints `TaskRecords`/`PrizeRecords`/`AccomplishmentRecords` — it ignores `CatGameAwards`, `EventRegistrations`, and `UserIdentities`, and never runs from the login path.

## Decisions (approved)

- **No DB unique constraint on `Users.sapId`** — historic data mess makes it risky, and DUP_SAPIDS=0 means it buys little. Prevention is application-level.
- **Canonical row rule:** real/canonical sapId → else oldest `createdAt` → else lowest `legacyId`. **Override:** when the picked canonical differs from a row that holds an `EventRegistration`, merge *toward* the registered row so leaderboard identity is preserved. (Once consolidated the exact winner barely matters; this rule just makes it deterministic.)
- **CatGameAwards on merge: SUM points, then apply the per-event 100 cap** — err generous (Tom's standing rule). Dedupe only to avoid double-counting the *same* `(event, awardDate)`, never to trim totals.
- **#2 and #3 collapse into one prevention PR** — the social-login fork is the same mechanism as the P/S fork; eager email merge fixes both.

## Design

### Component 1 — Prevention (resolver hardening), PR A

In `packages/core/resolve-db-user.js`:

1. **Eager email merge before INSERT.** In `provisionDbUser`, after `resolveUser` returns null but before INSERT, if `tokenEmail(user)` is present and a non-GitHub-synthetic `Users.email` matches, reuse that row (write the (iss,sub) link via `writeIdentityLink`) instead of inserting. This promotes Tier-3's effect into the create path so a verified email never mints a duplicate.
2. **Atomic get-or-create.** Perform the existence recheck (email + (iss,sub)) and INSERT inside one `cds.tx`. On a caught `unique|duplicate` (or a post-insert re-SELECT finding a now-existing row), return the existing row rather than the new one. Keeps concurrent first-logins from both inserting.
3. **Deterministic canonical pick** replacing Tier-3's `candidates[0]` (line ~312): apply the canonical-row rule above, including the EventRegistration-preference override.

No schema change. `@assert.unique.sapId` stays as the CAP-runtime check it already is.

### Component 2 — Reconciliation (extend `mergeAccounts` + one-off job), PR B

1. **Extend `mergeAccounts(primary, secondary)`** (`srv/lib/account-merge.js`) to additionally:
   - Repoint `UserIdentities.user_ID` secondary→primary (dedupe on `(issuer,subject)` — drop a secondary link that duplicates a primary one).
   - Repoint `EventRegistrations` secondary→primary, deduping on `@assert.unique.userEvent` (keep the earliest `joinedAt`).
   - Merge `CatGameAwards`: repoint secondary→primary. On `(event, awardDate)` PK collision for the same day, keep a single row whose `points` = min(sum of the colliding rows' points, 5) — the daily 5-cap. After repointing, if an event's grand total exceeds 100, trim the most recent award rows until the event total == 100 (never below a user's legitimately-earned total). Favor keeping points.
   - (Existing `TaskRecords`/`PrizeRecords`/`AccomplishmentRecords` repoint unchanged.)
2. **Canonical selection** inside the batch driver uses the Component-1 rule, so `mergeAccounts` is always called with the correct primary.
3. **One-off batch job** (`srv/jobs/`): walk the 349 email clusters, **dry-run first** (emit a report: clusters, rows, points before/after, cap-trims), then execute idempotently, recording each merge via the existing `SecondaryAccounts` `status:'MERGED'` pattern.

### Delivery / sequencing

- **PR A (prevention) → DEV first** — stops new forks.
- **PR B (reconciliation) → DEV after A**; run dry-run against PROD data (via the gameboard-synonym / cf-env read path, see memory), review counts with Tom, then execute the merge job on PROD.

## Testing

- **Resolver (unit, in-memory SQLite):** concurrent-insert returns one row; verified-email match reuses the existing row (no insert); canonical pick order; EventRegistration-preference override; social-then-SAP-ID sequence converges to one row.
- **Merge (unit):** `CatGameAwards` sum-with-cap (including an over-cap case that trims overflow); `EventRegistrations` userEvent dedupe keeps earliest; `UserIdentities` (iss,sub) dedupe; idempotent re-run is a no-op.
- **Dry-run validation:** batch report reconciled against the 349 PROD clusters on hybrid before any PROD execution.
- Follow the `srv-qa` cp-list audit if touching `srv/lib/` (CLAUDE.md) — confirm `account-merge.js` deps are in `.deploy/mta.yaml` `srv-qa` `cp`.

## Out of scope

- Social-login IAS/approuter config (separate #2552/#2506 work).
- `/signin` warning (shipped, #2653).
- Any `Users` schema change / DB constraint.
