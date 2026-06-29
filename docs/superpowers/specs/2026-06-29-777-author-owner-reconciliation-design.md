# Issue #777 — Reconcile author/owner semantics across MyTutorials, advocate page, and admin Tutorial Health

- **Status:** Approved (2026-06-29), pending spec-reviewer pass
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

### 1.1 The new `MyTutorialsView`

```cds
view MyTutorialsView as
  select from (
      // Source 1: strict author FK — priority 1 (highest confidence)
      select key t.ID                  as tutorial_ID,
                 t.author_ID           as userId,
                 1                     as priority
        from ims.Tutorials as t
        where t.author_ID is not null
    union
      // Source 2: contributor FK — priority 2
      select key c.tutorial_ID,
                 c.user_ID             as userId,
                 2                     as priority
        from ims.TutorialContributors as c
        where c.user_ID is not null
    union
      // Source 3: post-publish ownerEmail match — priority 3
      select key m.tutorial_ID,
                 u.ID                  as userId,
                 3                     as priority
        from ims.TutorialMeta as m
          inner join ims.Users as u on u.email = m.ownerEmail
    union
      // Source 4: legacy free-text owner match — priority 4 (lowest)
      // Matches BOTH email-shape (e.g. "thomas.jung@sap.com") and
      // name-shape (e.g. "Thomas Jung") legacy values.
      select key m.tutorial_ID,
                 u.ID                  as userId,
                 4                     as priority
        from ims.TutorialMeta as m
          inner join ims.Users as u
            on m.owner = u.email
            or m.owner = u.firstName || ' ' || u.lastName
  ) {
      tutorial_ID,
      userId,
      min(priority) as bestPriority : Integer,
      // Outer join back to Tutorials + TutorialMeta so OData consumers
      // get the existing fields (title, slug, primaryTag, status,
      // reviewedDate, monitoredStatus, notificationNumber, daysSinceReview).
  }
  group by tutorial_ID, userId;
```

The outer SELECT joins back to `Tutorials` and `TutorialMeta` to expose the columns Sage and the admin tile currently consume. Exact field list during implementation; the existing `MyTutorialsView` field surface is the baseline (Section 2.1 of this spec).

### 1.2 Why `m.owner = u.firstName || ' ' || u.lastName` instead of `LIKE`

The original probe showed 77 matches using `LIKE '%Thomas Jung%'`. Most of those 77 are exact value `"Thomas Jung"` (from frontmatter `author_name`). Exact equality is safer:

- **Avoids false positives:** "Tom" doesn't accidentally match "Tom Smith" or "Thomas Jr".
- **No SQL injection / LIKE-escaping concerns:** no `%` or `_` to escape.
- **Predictable count:** the dedup gives one row per tutorial regardless of how the legacy `owner` string was formatted.

If equality misses cases that `LIKE` would have caught, the backfill script catches them (it has more sophisticated string parsing). The view stays conservative.

### 1.3 Read-time data flow

```text
Sage / Author UI / Admin Tutorial Health
  └─ GET /author/MyTutorials (CAP-managed OData over MyTutorialsView)
       └─ srv/author-service.js before('READ') injects WHERE userId = req.user.id
       └─ HANA executes the four-source UNION + GROUP BY dedup
       └─ OData layer applies $filter, $orderby, $expand on the result

Advocate page
  └─ GET /api/advocates (advocates-public.js)
       └─ For each advocate with linked user_ID:
            └─ SELECT from MyTutorialsView WHERE userId = advocate.user_ID
       └─ Returns Tutorial rows; response shape unchanged

Admin Tutorial Health "monitored by me" toggle
  └─ /admin/MyTutorials filtered by userId (NOT email)
       └─ Same view, same backend; just a different OData consumer
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
  └─ Same resolution + UPDATEs TutorialMeta.ownerEmail + Tutorials.author_ID
  └─ Idempotent — re-runs skip rows where ownerEmail IS NOT NULL
```

## 2. Components

### 2.1 Modified files

| File | Change |
|---|---|
| `db/views.cds` (line ~216, `view MyTutorialsView`) | Rewrite to UNION across the four sources with GROUP BY dedup. Preserve the existing exposed fields (`slug`, `title`, `primaryTag`, `status`, `reviewedDate`, `owner`, `ownerEmail`, `monitoredStatus`, `notificationNumber`, `notificationDate`, `firstNotificationDate`, `repositoryName`, `monitored`, `daysSinceReview`). Replace the old `ownerUserId` column name with `userId` for consistency with the new UNION column. Add `bestPriority : Integer` as a new exposed column. |
| `srv/author-service.js` (~line 70-74, the `before('READ', MyTutorials, ...)` handler) | Replace `req.query.where({ ownerUserId: userId })` with `req.query.where({ userId })`. |
| `srv/routes/advocates-public.js` (~line 98-103, the `SELECT.from(Tutorials).where({ author_ID: { in: userIds } })` query) | Replace with `SELECT.from(MyTutorialsView).columns('slug', 'title', 'userId').where({ userId: { in: userIds } })`. The downstream `authoredByUserId` Map-building logic adapts to the new shape (1 row per user-tutorial pair instead of 1 row per tutorial with author_ID). |
| `srv/server.js` (or wherever `/auth/user` is implemented) | Add `userId` (the Users.ID UUID) to the response. Today it returns `email`; we add the resolved Users.ID. Lookup is one `SELECT.one.from(Users).where({ email }).columns('ID')` per call — already implicit in the codebase elsewhere. |
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

Today's `MyTutorialsView` does `INNER JOIN Users ON u.email = m.ownerEmail`. The `before('READ')` filter then adds `WHERE ownerUserId = req.user.id`. **If Sage's `req.user.id` resolves to a UUID different from the `u.uuid` for Tom's user row, 0 rows return.** Investigation needed during implementation: which Users.ID is `req.user.id` resolving to for Sage's session? CAP's XSUAA mapping uses the SAP IDP `sub` claim, which should match `Users.uuid`, but the legacy view exposed `u.uuid as ownerUserId` — so the filter went through correctly only if `req.user.id === u.uuid`. The new view exposes the `Users.ID` UUID (not `uuid` column) — implementation must verify which one `req.user.id` resolves to. Suspected: it's `Users.uuid` (the BTP-IDP `sub`), so we either keep that column name or add `Users.ID` to `/auth/user`. Section 4.4 below.

### 4.3 Tutorial author transferred

If the original author is still in `TutorialMeta.owner` text (source #4) but the new author is in `Tutorials.author_ID` (source #1), BOTH users see the tutorial in their "mine" list. **Intentional** — the C-strict policy. Until the backfill runs, this is the right behavior (the original author shouldn't be silently dropped from their attribution). After backfill, the legacy text rows are resolved to current authors, so only the current author sees it.

### 4.4 The `userId` resolution question (implementation TBD)

Three candidate UUIDs in the system:

- **`Users.ID`** — CAP cuid primary key, used by FK columns (`author_ID`, `user_ID`).
- **`Users.uuid`** — distinct UUID stored alongside; legacy from IMS migration.
- **`req.user.id`** — the XSUAA `sub` claim; per CAP convention maps to one of the above.

The view's UNION uses `Users.ID` (it's the FK target). The before-handler filter must match `req.user.id` against `Users.ID`. If `req.user.id` resolves to `Users.uuid` instead of `Users.ID`, the filter mismatches and returns 0 rows.

**Implementation step:** verify the mapping during the AuthorService refactor. If `req.user.id === Users.uuid`, the before-handler must look up `Users.ID` via `Users.uuid`. If `req.user.id === Users.email` (some XSUAA configs), do the email → ID lookup. The right answer is one `SELECT.one.from(Users).columns('ID').where({ uuid: req.user.id })` (or by email) once per request, cached on `req.context` if needed.

### 4.5 Backfill ambiguous match

Two users share the same firstName + lastName (e.g. two `John Smith` rows). Backfill writes the row to `orphans.csv` with both candidate user IDs listed. Manual review picks one. No automatic resolution.

### 4.6 Backfill: email-shape value with no `Users.email` match

E.g. `owner = "former-author@example.com"` for someone who left the company and whose `Users` row was deleted. Orphan. Logged with the parsed email. Operator decides: either leave NULL (source #4 still surfaces it via the `m.owner = u.email` test, but no user matches now) or manually delete the row.

### 4.7 HANA query plan concerns

The UNION view does 4 sub-selects, GROUP BY, and a final outer join. Concrete worry: HANA may not push down a `WHERE userId = ?` filter efficiently through the UNION + GROUP BY. **Mitigation during implementation:** measure `EXPLAIN PLAN` for `SELECT * FROM MyTutorialsView WHERE userId = ?`. If the filter doesn't push down (full-table scan + late filter), restructure the view so the filter applies per-source-subselect.

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

Single PR. No schema migration. The CDS view change requires a redeploy of the srv module (HANA reads the updated view definition at next query). The backfill script runs as a separate post-deploy step.

**Rollout sequence:**

1. Merge + deploy the view + service refactor + admin tile change. Tom + Sage see ~77 tutorials across all three surfaces immediately, sourced through the UNION view (legacy text-match contributes most of the rows).
2. Run backfill `--dry-run` on DEV. Review CSVs.
3. Run backfill `--commit` on DEV. The 66 legacy text-only rows resolve to `ownerEmail` + `author_ID`.
4. After PROD cutover (separate timeline), repeat 2-3 on PROD.

**Rollback:** `git revert` + redeploy. Reverts the view to its previous shape. Counts drop back to 11/7/0 across surfaces. No data corruption — the backfill script only adds data (writes to currently-NULL `ownerEmail` / `author_ID`).

## 7. References

- Issue [#777](https://github.com/sap-tutorials/tutorials-ims/issues/777)
- Predecessor spec [`2026-06-24-tutorial-authorship-fk-design.md`](./2026-06-24-tutorial-authorship-fk-design.md) — added `Tutorials.author` + `TutorialContributors.user` FKs
- AuthorService spec [`2026-06-21-issue-385-pr3-authorservice-design.md`](./2026-06-21-issue-385-pr3-authorservice-design.md) — introduced `MyTutorialsView`
- Existing backfill pattern: `scripts/backfill-tutorial-authors.cjs` (the new script mirrors this shape)
- Existing publish-time resolver: `srv/lib/resolve-tutorial-author.js` (NOT modified; different purpose)
