# Issue #777 — Reconcile author/owner semantics across MyTutorials, advocate page, and admin Tutorial Health

- **Status:** Approved (2026-06-29), spec-reviewer pass complete
- **Issue:** [#777](https://github.com/sap-tutorials/tutorials-ims/issues/777)
- **Predecessor spec:** [`2026-06-24-tutorial-authorship-fk-design.md`](./2026-06-24-tutorial-authorship-fk-design.md) — added the `Tutorials.author` and `TutorialContributors.user` FKs that source #1 + #2 of this spec rely on
- **Related:** AuthorService spec [`2026-06-21-issue-385-pr3-authorservice-design.md`](./2026-06-21-issue-385-pr3-authorservice-design.md) — introduced `MyTutorialsView` with the email-only inner-join we're broadening

## Summary

Four different surfaces today answer "which tutorials belong to user X?" by reading four different columns, each producing a different count. For Tom on DEV:

| Surface | Source | Count |
|---|---|---|
| Legacy IMS Sage (text-search) | `TutorialMeta.owner LIKE '%Thomas Jung%'` | 77 |
| Admin Tutorial Health "monitored by me" | `TutorialMeta.owner = userEmail` | 11 |
| `/author/MyTutorials` (new IMS) | INNER JOIN `Users` on `m.ownerEmail = u.email` | 11 (0 if userId doesn't resolve via XSUAA, hence Sage's bug) |
| Advocate page `authoredTutorials` | `Tutorials.author_ID = userId` | 7 |

The semantic gap is real: each surface is "right" against the column it picked, but no two agree. Users see widely different counts of "their" tutorials depending on which page they're on. Tom's stated expectation: he should see ~77 across all surfaces (matches his pre-IMS-rewrite mental model).

This spec defines one canonical resolver — a single CDS view `MyTutorialsView` that takes the UNION of all four sources, deduped by `(tutorial, userId)` with a `bestPriority` column tracking the highest-confidence source. Every read-time surface routes through this view. A separate one-shot backfill script resolves the 66 legacy `TutorialMeta.owner` text-only rows against `Users`, populating `ownerEmail` and `author_ID` so source #4 (legacy text-match) becomes a redundancy guard rather than the primary signal over time.

## Scope

### In scope

- Rewrite `db/views.cds` `MyTutorialsView` to UNION across four sources with `bestPriority` priority-min dedup.
- Rewrite `srv/author-service.js` `before('READ')` handler to filter on `userId` (the view's new column) instead of `ownerUserId`.
- Rewrite `srv/routes/advocates-public.js` to query `MyTutorialsView` instead of `Tutorials.author_ID`.
- Add `userId` field to `/auth/user` response so the admin Tutorial Health filter can use the Users.ID UUID.
- Rewrite the admin Tutorial Health "monitored by me" filter to use `userId` instead of `email`.
- Add `srv/lib/resolve-my-tutorials.js` for JS-side consumers that don't go through OData (advocates-public.js). This is a thin wrapper over the SQL view.
- Add `scripts/backfill-tutorial-meta-author.cjs` to resolve legacy `TutorialMeta.owner` text-only rows to `Users` FKs. Default `--dry-run`, explicit `--commit` flag, idempotent.
- Unit tests + a hybrid test + manual smoke checklist.

### Out of scope

- **Schema changes.** All four columns/FKs already exist.
- **An admin UI for backfill review.** Decided B1 (one-shot script with CSV orphans review) over B2 (admin UI). 66 rows is small enough for one-time CSV review.
- **Removing source #4 (legacy text-match) from the view.** After backfill, source #4 still runs but should mostly find nothing new. Keeping it is a redundancy guard.
- **Multi-email Users** (e.g. `sap.com` vs `ext.sap.com` aliases). Documented as a known limitation in the predecessor spec, still out of scope.
- **Source provenance UI (`bestPriority` badging in admin UI).** Spec includes the column for future use, but no UI surface in this PR. Follow-up issue if useful.
- **A `TutorialReviewers` or `TutorialAssignedTo` entity** for a hypothetical 5th source. YAGNI.

## Approach

The architectural pivot: **one CDS view, four sources, UNION + GROUP BY for dedup with priority**. Every consumer (Sage's OData, the advocate page, the admin tile) reads the same view. Adding a fifth source in the future means changing one view, not three handlers.

Source priorities (lower number = higher confidence):

| Priority | Source | Rationale |
|---|---|---|
| 1 | `Tutorials.author_ID` (FK) | Set by the publish-time resolver; explicit author |
| 2 | `TutorialContributors.user_ID` (FK) | Multi-author tutorial; this user contributed |
| 3 | `TutorialMeta.ownerEmail = Users.email` | Post-publish email match; resolved at publish time |
| 4 | `TutorialMeta.owner = Users.email` OR `Users.firstName + ' ' + Users.lastName` | Legacy free-text; pre-rewrite frontmatter `author_name` |

The dedup keeps one row per `(tutorial, userId)` with `MIN(priority)` as `bestPriority`. The column is exposed but not yet UI'd — future admin work can color-code by confidence.

The backfill script does the inverse work on the data side: re-resolves source #4 free-text rows back into source #3 (`ownerEmail`) and source #1 (`author_ID`) where possible. Run once at PR-merge time; idempotent on re-runs.

## 1. Architecture

### 1.1 The new `MyTutorialsView` (two-stage shape)

**Critical context — what `userId` actually means.** Today's `MyTutorialsView` (db/views.cds:216) exposes `u.uuid as ownerUserId` and the AuthorService before-handler filters on `req.user.id`. This is the established CAP invariant on this codebase: **`req.user.id === Users.uuid`** (the XSUAA `sub` claim, which the migrator stamped into `Users.uuid`). FK columns (`Tutorials.author_ID`, `TutorialContributors.user_ID`) target `Users.ID` — a DIFFERENT UUID from `Users.uuid`. Sources 1 and 2 of the UNION therefore JOIN `Users` to translate `Users.ID` → `Users.uuid` so every UNION branch emits the same `userUuid` field. The outer view exposes this as `userId` for consistency with the existing API. **No code path requires `Users.ID` to leak out of the view; every consumer compares `userId` to `req.user.id` directly.**

The view follows the established codebase pattern of TOP-LEVEL `UNION ALL` of equally-shaped SELECTs (see `db/views.cds:7-51` `Tasks` for precedent). Each branch emits exactly three columns: `tutorial_ID`, `userUuid`, `priority`. A separate aggregate view groups + picks `MIN(priority)`. A final view joins back to `Tutorials` + `TutorialMeta` to expose the rich field set without GROUP BY constraints.

**Layer 1: `MyTutorialsRaw` (UNION ALL of 4 sources, narrow columns)**

```cds
view MyTutorialsRaw as
  // Source 1: strict author FK — priority 1 (highest confidence).
  // Join Users so the branch emits Users.uuid (matches req.user.id), not Users.ID.
  SELECT from ims.Tutorials as t
    inner join ims.Users as u on u.ID = t.author_ID
  {
    key t.ID            as tutorial_ID,
    key u.uuid          as userUuid,
    1                   as priority : Integer
  }
  UNION ALL
  // Source 2: contributor FK — priority 2.
  SELECT from ims.TutorialContributors as c
    inner join ims.Users as u on u.ID = c.user_ID
  {
    key c.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    2                   as priority : Integer
  }
  UNION ALL
  // Source 3: post-publish ownerEmail match — priority 3.
  SELECT from ims.TutorialMeta as m
    inner join ims.Users as u on u.email = m.ownerEmail
  {
    key m.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    3                   as priority : Integer
  }
  UNION ALL
  // Source 4: legacy free-text owner match — priority 4 (lowest).
  // Equality, NOT LIKE — see §1.2 rationale.
  SELECT from ims.TutorialMeta as m
    inner join ims.Users as u
      on m.owner = u.email
      or m.owner = u.firstName || ' ' || u.lastName
  {
    key m.tutorial.ID   as tutorial_ID,
    key u.uuid          as userUuid,
    4                   as priority : Integer
  };
```

**Layer 2: `MyTutorialsBestPriority` (dedup with MIN priority)**

```cds
view MyTutorialsBestPriority as
  select from MyTutorialsRaw {
    key tutorial_ID,
    key userUuid,
    min(priority)       as bestPriority : Integer
  }
  group by tutorial_ID, userUuid;
```

One row per `(tutorial, user)` pair, with `bestPriority` = the highest-confidence source (lowest number).

**Layer 3: `MyTutorialsView` (rich field set, no GROUP BY)**

```cds
view MyTutorialsView as
  select from MyTutorialsBestPriority as b
    inner join ims.Tutorials      as t on t.ID = b.tutorial_ID
    inner join ims.TutorialMeta   as m on m.tutorial.ID = t.ID  // outer? see §4.7
  {
    key t.ID                                as tutorial_ID,
    key b.userUuid                          as userId,
    b.bestPriority,
    // Existing fields preserved from today's MyTutorialsView:
    t.slug,
    t.title,
    t.primaryTag,
    t.status,
    m.reviewedDate,
    m.monitoredStatus,
    m.notificationNumber,
    m.lastNotificationDate                  as notificationDate,
    m.firstNotificationDate,
    m.owner                                 as owner,
    m.ownerEmail                            as ownerEmail,
    m.repository.name                       as repositoryName : String,
    case when m.monitoredStatus = 'ACTIVE'
         then true else false end           as monitored : Boolean,
    days_between(m.reviewedDate, $now)      as daysSinceReview : Integer
  };
```

The outer Layer 3 view has no GROUP BY because Layer 2 already deduped. The non-aggregate fields from `Tutorials` and `TutorialMeta` flow through cleanly. The OData consumer's `$filter`, `$orderby`, `$expand` all work as today.

**TutorialMeta join — INNER vs LEFT (§4.7).** Today's view INNER joins TutorialMeta — so tutorials without a TutorialMeta row never appear. Sources 1 (author FK on Tutorials) and 2 (contributor FK) don't actually require TutorialMeta to match. We have a choice:

- **(a) INNER JOIN TutorialMeta** — preserves today's behavior (tutorials without TutorialMeta drop out). Simplest. Implementation default.
- **(b) LEFT JOIN TutorialMeta** — exposes tutorials that have author/contributor FK but no TutorialMeta yet. Rich field set is partially NULL for those rows.

The implementation picks (a) for the first PR (matches today's contract). If users surface "I authored this but it doesn't appear in MyTutorials" cases due to missing TutorialMeta, switch to (b) in a follow-up. The decision is reversible — pure SQL change.

### 1.2 Why `m.owner = u.firstName || ' ' || u.lastName` (equality, not LIKE)

The original probe showed 77 matches using `LIKE '%Thomas Jung%'`. Most are exact value `"Thomas Jung"` from frontmatter `author_name`. Exact equality:

- **Avoids false positives:** "Tom" doesn't accidentally match "Tom Smith".
- **No SQL injection / LIKE-escaping concerns.**
- **Predictable count.**

If equality undercounts vs. LIKE, the backfill script's more sophisticated parsing (§1.4) catches the misses on-disk by writing FK + ownerEmail; subsequent reads find them via sources 1+3.

### 1.3 Read-time data flow

```text
Sage / Author UI / Admin Tutorial Health
  └─ GET /author/MyTutorials (CAP-managed OData over MyTutorialsView)
       └─ srv/author-service.js before('READ') injects WHERE userId = req.user.id
          (req.user.id === Users.uuid; matches MyTutorialsView.userId by design)
       └─ HANA executes the layered view (UNION ALL → GROUP BY → outer join)
       └─ OData layer applies $filter, $orderby, $expand on the result

Advocate page
  └─ GET /api/advocates (advocates-public.js)
       └─ For each advocate with linked user_ID:
            └─ Lookup the linked Users row's uuid (already needed for email today)
            └─ SELECT from MyTutorialsView WHERE userId = advocate.user.uuid
       └─ Returns Tutorial rows; response shape unchanged

Admin Tutorial Health "monitored by me" toggle
  └─ /admin/MyTutorials filtered by userId (NOT email)
       └─ Same view, same backend; different OData consumer
```

### 1.4 Backfill flow

```text
scripts/backfill-tutorial-meta-author.cjs --dry-run (default)
  └─ SELECT all TutorialMeta where owner IS NOT NULL AND ownerEmail IS NULL
  └─ For each row: try email-shape match → name-shape match → record proposal
  └─ Emit:
       - .migration-data/tutorial-meta-author-proposed.csv (rows that would update)
       - .migration-data/tutorial-meta-author-orphans.csv (ambiguous or unmatched)
  └─ Print: "X rows proposed, Y orphans (Z ambiguous, W unmatched)"

scripts/backfill-tutorial-meta-author.cjs --commit
  └─ Same resolution. Writes ONLY TutorialMeta.ownerEmail.
  └─ Tutorials.author_ID is NOT written by this script (avoids competing with
     scripts/backfill-tutorial-authors.cjs from the 2026-06-24 spec, which
     owns the author_ID write path). After this script's --commit, re-run
     backfill-tutorial-authors.cjs to pick up the newly-populated ownerEmail
     rows via its existing resolver (resolveTutorialAuthor's Phase B-c).
  └─ Idempotent — skips rows where ownerEmail IS NOT NULL.
```

## 2. Components

### 2.1 Modified files

| File | Change |
|---|---|
| `db/views.cds` (line ~216, `view MyTutorialsView`) | Rewrite to UNION across the four sources with GROUP BY dedup. Preserve the existing exposed fields (`slug`, `title`, `primaryTag`, `status`, `reviewedDate`, `owner`, `ownerEmail`, `monitoredStatus`, `notificationNumber`, `notificationDate`, `firstNotificationDate`, `repositoryName`, `monitored`, `daysSinceReview`). Replace the old `ownerUserId` column name with `userId` for consistency with the new UNION column. Add `bestPriority : Integer` as a new exposed column. |
| `srv/author-service.js` (~line 70-74, the `before('READ', MyTutorials, ...)` handler) | Replace `req.query.where({ ownerUserId: userId })` with `req.query.where({ userId })`. |
| `srv/routes/advocates-public.js` (~line 98-103, the `SELECT.from(Tutorials).where({ author_ID: { in: userIds } })` query) | Replace with `SELECT.from(MyTutorialsView).columns('slug', 'title', 'userId').where({ userId: { in: userIds } })`. The downstream `authoredByUserId` Map-building logic adapts to the new shape (1 row per user-tutorial pair instead of 1 row per tutorial with author_ID). |
| `srv/server.js` (or wherever `/auth/user` is implemented) | Add `userId` (the **Users.uuid** UUID — matches `req.user.id` per §4.4's lock) to the response. Today it returns `email`; we add the resolved Users.uuid. Lookup is one `SELECT.one.from(Users).where({ email }).columns('uuid')` per call. |
| `app/admin-shell/webapp/controller/TutorialDashboard.controller.js` (~line 74, the `_buildFilters()` "monitored by me" branch) | Replace `new Filter("owner", FilterOperator.EQ, this._sUserEmail)` with `new Filter("userId", FilterOperator.EQ, this._sUserId)`. The `_loadUserEmail()` method extends to also stash `this._sUserId` from the new `/auth/user` response. |

### 2.2 Added files

| File | Purpose |
|---|---|
| `srv/lib/resolve-my-tutorials.js` | JS wrapper around the SQL view for consumers that don't go through OData (advocates-public.js). Single function `resolveMyTutorials(db, { userId }) → Promise<Tutorial[]>`. Unit-tested. |
| `scripts/backfill-tutorial-meta-author.cjs` | One-shot backfill. Mirrors the existing `scripts/backfill-tutorial-authors.cjs` pattern. `--dry-run` default, `--commit` for writes. Emits two CSVs to `.migration-data/`. Idempotent. |
| `test/unit/srv/resolve-my-tutorials.test.js` | 8-case unit test for the JS resolver (see §5.1). |
| `test/unit/scripts/backfill-tutorial-meta-author.test.js` | 6-case unit test for the backfill resolution logic (see §5.1). |
| `test/hybrid/my-tutorials-view-union.test.js` | Hybrid test asserting all four sources contribute to the view's output on real HANA. |

### 2.3 NOT modified

| File | Why |
|---|---|
| `srv/lib/resolve-tutorial-author.js` | PUBLISH-TIME resolver. Different purpose: sets `Tutorials.author_ID` when a publish happens. The new `resolve-my-tutorials.js` is the READ-TIME resolver. Two resolvers, two purposes. |
| `db/schema.cds` | No schema change. All four columns/FKs already exist. |
| `db/last-dev/` | No CDS deploy artifact change — view changes don't trigger schema migration. |
| `Users` table | No changes. |
| Other `srv/services/*.cds` | The four-source semantic is read-time only; no other service needs it. |

## 3. Data flow

See §1.3 (read time) and §1.4 (backfill). No new persistence. The view is computed on every read; HANA will optimize the UNION + GROUP BY internally.

## 4. Error handling

### 4.1 User has no `Users` row

XSUAA-authenticated user with `email` that doesn't exist in `Users`: all four UNION sources find no match → empty result set. Same as today's behavior. No error surfaced; the OData response is `{value: []}`.

### 4.2 Sage's "0 results" mystery (current bug)

Resolved by §4.4. Today's view does `INNER JOIN Users ON u.email = m.ownerEmail` + filters on `req.user.id = u.uuid`, so any mismatch between Sage's XSUAA token and the Users.uuid for Tom's row returns zero rows. The new layered view (§1.1) preserves the same `req.user.id === Users.uuid` contract — see §4.4 for the locked-down resolution. Sage's "0 results" disappears as soon as Sage hits the new endpoint with a token whose `sub` matches Tom's `Users.uuid`.

### 4.3 Tutorial author transferred

If the original author is still in `TutorialMeta.owner` text (source #4) but the new author is in `Tutorials.author_ID` (source #1), BOTH users see the tutorial in their "mine" list. **Intentional** — the C-strict policy. Until the backfill runs, this is the right behavior (the original author shouldn't be silently dropped from their attribution). After backfill, the legacy text rows are resolved to current authors, so only the current author sees it.

### 4.4 The `userId` resolution (locked: `Users.uuid`, not `Users.ID`)

`req.user.id` in this codebase resolves to the XSUAA `sub` claim, which the IMS migrator stamped into `Users.uuid` (NOT `Users.ID` — those are two distinct UUIDs). Today's `db/views.cds:238` exposes `u.uuid as ownerUserId` and `srv/author-service.js:73` filters on `req.user.id` — that's why the existing single-source path works.

The new layered view (§1.1) is **explicitly designed to preserve this invariant**. Every UNION ALL branch JOINs `Users` to translate any `Users.ID` references into `u.uuid`, and the final outer view exposes `userUuid as userId`. The before-handler filter remains exactly `req.query.where({ userId: req.user.id })` — same shape as today, broader semantics.

Implementation steps to verify in the hybrid test (§5.2):

- Insert a synthetic Users row with both `ID` and `uuid` set.
- Insert four synthetic tutorials covering all four sources for that user.
- Query `MyTutorialsView WHERE userId = synthetic_uuid` — expect all four rows.

If the test passes, the contract is correct. If the test fails (zero rows returned), the column projection in the view is wrong — likely a source forgot to JOIN Users or projected `Users.ID` instead of `Users.uuid`.

### 4.5 Backfill ambiguous match

Two users share the same firstName + lastName (e.g. two `John Smith` rows). Backfill writes the row to `orphans.csv` with both candidate user IDs listed. Manual review picks one. No automatic resolution.

### 4.6 Backfill: email-shape value with no `Users.email` match

E.g. `owner = "former-author@example.com"` for someone who left the company and whose `Users` row was deleted. Orphan. Logged with the parsed email. Operator decides: either leave NULL (source #4 still surfaces it via the `m.owner = u.email` test, but no user matches now) or manually delete the row.

### 4.7 HANA query plan + TutorialMeta join semantics

The layered view (§1.1) is built so HANA can push down a `WHERE userId = ?` filter through each UNION ALL branch independently. Each branch's `userUuid` comes from `Users.uuid` via an INNER JOIN — HANA's optimizer pushes the filter onto that JOIN before the UNION runs. Layer 2 (`MyTutorialsBestPriority`) then groups the much smaller filtered result. Layer 3 joins back to `Tutorials` / `TutorialMeta` on the (already-filtered) primary keys.

This shape is the same as the existing `Tasks` UNION ALL view (`db/views.cds:7-51`) which HANA executes efficiently with per-user filters today. We're following the established pattern.

**TutorialMeta join — INNER vs LEFT.** Today's view INNER joins TutorialMeta. The new Layer 3 view defaults to INNER (matches today's contract). Sources 1 and 2 don't require TutorialMeta to match — they came from `Tutorials.author_ID` / `TutorialContributors.user_ID` directly. So a user who authored a tutorial that has NO TutorialMeta row will see it in sources 1 or 2 (Layer 1 + 2) but get filtered OUT by the INNER JOIN at Layer 3.

For the first PR, this matches today's behavior (these tutorials don't appear in `MyTutorialsView` today either, because today's view also INNER joins TutorialMeta). If users surface complaints, switch Layer 3 to LEFT JOIN in a follow-up — pure SQL change, reversible.

**Implementation EXPLAIN PLAN spike (mandatory).** Before merging, the implementer must:

1. Build the three-layer view in DEV.
2. Run `EXPLAIN PLAN FOR SELECT * FROM MyTutorialsView WHERE "userId" = '<test-uuid>'`.
3. Confirm the plan shows the `userId = ?` filter applied EARLY (within each UNION ALL branch's JOIN, not after the GROUP BY).
4. If filter is late, restructure to push it into each Layer-1 branch's `where` clause.

The Layer 1 branches don't have a `where` clause today — the filter comes from the OData consumer. If HANA's optimizer doesn't push it down through the GROUP BY in Layer 2, the workaround is to add a parameterized Layer-1 wrapping function or expose the filter at Layer 2. Both are CDS view changes; no JS code change.

## 5. Testing

### 5.1 Unit tests (new)

`test/unit/srv/resolve-my-tutorials.test.js` — 8 cases for the JS wrapper:

1. User with strict FK only → returns the FK-sourced tutorial with `bestPriority: 1`.
2. User with contributor FK only → priority 2.
3. User with `ownerEmail` match only → priority 3.
4. User with legacy `owner` text match only (name shape) → priority 4.
5. User with legacy `owner` text match only (email shape) → priority 4.
6. User present in MULTIPLE sources → one row, `bestPriority: 1` (MIN priority).
7. User with no matches anywhere → empty result set.
8. Two users both authored the same tutorial via contributor FK → both see it (one row each).

`test/unit/scripts/backfill-tutorial-meta-author.test.js` — 6 cases for the backfill resolver:

1. `owner = "thomas.jung@sap.com"` (email-shape) → matches `Users` by email.
2. `owner = "Thomas Jung"` (name-shape) → matches by `firstName + ' ' + lastName` exact.
3. `owner = "Thomas Jung <thomas.jung@sap.com>"` (compound) → extracts email, matches.
4. `owner = "John Smith"` with two `John Smith` rows → orphan, both candidates listed.
5. `owner = "Unknown Person"` → orphan, no candidates.
6. Idempotent: row with `ownerEmail` already set → skipped.

### 5.2 Hybrid tests (new)

`test/hybrid/my-tutorials-view-union.test.js` — exercises the actual HANA view:

1. Insert four synthetic `__TEST__`-prefixed tutorials (one per source path) + a synthetic test user.
2. Query `MyTutorialsView WHERE userId = testUserId` and assert all four tutorials appear, with the correct `bestPriority` per row.
3. Insert a fifth tutorial where the test user matches via TWO sources (FK + ownerEmail). Assert one row returned with `bestPriority: 1`.
4. Standard hybrid cleanup in `afterAll`. Uses `ALLOW_HYBRID_WRITES=true` guard.

### 5.3 Smoke tests (no change expected)

`test/smoke/author-service.test.js` and `test/smoke/admin-*.test.js` — existing tests likely just assert that the endpoint returns 200 and non-empty payload. The semantic change (broader matching) doesn't break those. If a test asserts a specific count for a specific user, update the expectation.

### 5.4 Manual smoke after deploy

1. Hit `/admin-ui/#dashboard` (Tutorial Health) as Tom — "Monitored by me" toggle shows ~77 tutorials (was 11).
2. Visit `/developer-advocates/` as anonymous; find Tom's card; observe ~77 authored tutorials listed (was 7).
3. Have Sage hit `/author/MyTutorials` — returns ~77 rows (was 0).
4. Run `npm run backfill-tutorial-meta-author -- --dry-run`. Review the CSVs with Tom. Confirm with him.
5. Re-run with `--commit`.
6. Verify counts unchanged on all three surfaces (still ~77; backfill is data cleanup, not semantic change).
7. Verify `TutorialMeta.ownerEmail IS NOT NULL` count rose substantially via a quick `cds bind --exec` probe.

## 6. Migration / rollout

Single PR. No schema migration. The CDS view changes require a redeploy of the srv module (HANA reads the updated view definitions at next query). The backfill script runs as a separate post-deploy step.

**Two backfill scripts — distinct write columns.** This PR adds `scripts/backfill-tutorial-meta-author.cjs` which writes ONLY `TutorialMeta.ownerEmail`. The existing `scripts/backfill-tutorial-authors.cjs` (from the 2026-06-24 spec) owns the `Tutorials.author_ID` write path. The intended sequence after PR-merge deploy:

1. Run new script `--dry-run` → review CSVs → `--commit`. Populates `TutorialMeta.ownerEmail` for 66 legacy rows.
2. Re-run existing `scripts/backfill-tutorial-authors.cjs --commit`. Its resolver (`srv/lib/resolve-tutorial-author.js` Phase B-c — "ownerEmail fallback") now finds matches in the just-populated rows and sets `Tutorials.author_ID`.

After both scripts run, sources 1 (FK) and 3 (ownerEmail) cover what source 4 (legacy text) had been catching alone, and source 4 becomes a redundancy guard.

**Rollout sequence:**

1. Merge + deploy the view + service refactor + admin tile change. Tom + Sage see ~77 tutorials across all three surfaces immediately, sourced through the UNION view (legacy text-match contributes most of the rows on DEV today).
2. Run `npm run backfill-tutorial-meta-author -- --dry-run` on DEV. Review CSVs.
3. Run `--commit`. The 66 legacy text-only rows resolve to `ownerEmail`.
4. Re-run `npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --commit` to pick up the newly-populated `ownerEmail` rows and write `author_ID`.
5. After PROD cutover (separate timeline), repeat 2-4 on PROD.

**Rollback:** `git revert` + redeploy. Reverts the view to its previous shape. Counts drop back to 11/7/0 across surfaces. No data corruption — both backfill scripts only write to currently-NULL columns.

## 7. References

- Issue [#777](https://github.com/sap-tutorials/tutorials-ims/issues/777)
- Predecessor spec [`2026-06-24-tutorial-authorship-fk-design.md`](./2026-06-24-tutorial-authorship-fk-design.md) — added `Tutorials.author` + `TutorialContributors.user` FKs
- AuthorService spec [`2026-06-21-issue-385-pr3-authorservice-design.md`](./2026-06-21-issue-385-pr3-authorservice-design.md) — introduced `MyTutorialsView`
- Existing backfill pattern: `scripts/backfill-tutorial-authors.cjs` (the new script mirrors this shape)
- Existing publish-time resolver: `srv/lib/resolve-tutorial-author.js` (NOT modified; different purpose)
