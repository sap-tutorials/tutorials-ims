# Tutorial authorship — `Tutorials.author` FK + `TutorialContributors.user` FK + backfill

**Status:** Approved (Tom Jung, 2026-06-24)
**Spec author:** Brainstorming session 2026-06-24
**Predecessor:** PR [#607](https://github.com/sap-tutorials/tutorials-ims/pull/607) (Advocate value-help fixes)
**Successor (separate spec, blocked on this one):** Advocate ↔ User 1:1 self-add + Object-Page history facets

## Problem

There is no first-class "who authored this tutorial?" association in the schema. Authorship lives in two places, both as plain strings:

- [`TutorialContributors`](../../../db/schema.cds#L327) `{ tutorial, name, email, role }` — one row per contributor per tutorial, sourced from tutorial markdown frontmatter at fetch time.
- [`TutorialMeta`](../../../db/schema.cds#L814) `{ tutorial, owner, ownerEmail, ... }` — one row per tutorial.

Neither has a foreign key to [`Users`](../../../db/schema.cds#L116). Any feature that wants to answer "which tutorials did this user author?" has to email-match on a string column — fragile, case-sensitive, and incapable of expressing "this is the primary author" cleanly.

The immediate consumer is the upcoming Advocate ↔ User 1:1 feature (separate spec) which wants a read-only **Authored tutorials** facet on the Advocate Object Page. That facet needs a clean ID-to-ID join path. This spec creates the foundation; the facet ships in the follow-up spec.

## Goals (in scope)

- Add `Tutorials.author : Association to Users` — the **primary author** FK, single-valued. Nullable.
- Add `TutorialContributors.user : Association to Users` — per-contributor FK, so co-authored tutorials appear in **every** contributor's "authored tutorials" list. Nullable.
- Add inverse associations on `Users`: `authoredTutorials`, `tutorialContributions` — so consumers (notably the upcoming Object-Page facet) can navigate `user/authoredTutorials/...` instead of writing a custom join.
- **Idempotent one-shot backfill script** that populates both FKs from existing data, with a dry-run-first / review-orphans / commit workflow.
- **Auto-set on every publish** going forward, via shared resolver (`srv/lib/resolve-tutorial-author.js`) so backfill and publish never diverge.
- **Migration runbook update** so the backfill is a documented step after every IMS user-progress import.
- Post-deploy smoke check that fails CI if no tutorial has a non-null `author` after migration.

## Non-goals (yagni)

- Admin UI for editing authorship. (Future; for now, authorship is data-driven.)
- Multi-email Users (e.g., `sap.com` and `ext.sap.com` aliases). Documented as a known limitation in the orphans report.
- Backfill orphan auto-creation of stub Users rows — orphans stay null, logged for human review.
- Schema changes to `TutorialMeta.owner` / `ownerEmail` — those columns stay; they're a fallback source for the backfill, not the join target.
- Any UI change. This spec is purely schema + backfill + publish-path + runbook.

## Data model

### `db/schema.cds`

```cds
@assert.unique.slug: [slug]
entity Tutorials : TaskBase {
  // ... existing fields unchanged ...
  redirectTo     : Association to Tutorials;
  steps          : Composition of many Steps           on steps.tutorial = $self;
  tags           : Association  to many TutorialTags   on tags.tutorial = $self;
  meta           : Composition of many TutorialMeta    on meta.tutorial = $self;
  contributors   : Composition of many TutorialContributors on contributors.tutorial = $self;
  categories     : Composition of many TutorialCategories   on categories.tutorial = $self;
  author         : Association to Users;   // NEW — primary author FK, nullable
}

entity TutorialContributors : cuid, LegacyKeyed {
  tutorial : Association to Tutorials;
  name     : String(255);
  email    : String(255);
  role     : String(50);
  user     : Association to Users;         // NEW — per-contributor FK, nullable
}

entity Users : cuid, managed, LegacyKeyed {
  // ... existing fields unchanged ...
  // Inverse associations — used by the upcoming Advocate Object-Page
  // facets (separate spec) and by any future "my authored tutorials"
  // query. Adding them here so the upcoming facet ships with a clean
  // navigation path rather than a custom CQL join.
  authoredTutorials      : Association to many Tutorials              on authoredTutorials.author = $self;
  tutorialContributions  : Association to many TutorialContributors   on tutorialContributions.user = $self;
}
```

Both FKs are **nullable** by design: the schema must tolerate (a) historical tutorials whose contributor emails don't match any `Users` row, and (b) new tutorials published before their author has logged in for the first time. Nullable FKs also keep the HDI deploy purely additive — no NOT NULL constraint, no risky DEFAULT-fill.

### HDI migration

Two `ALTER TABLE ADD COLUMN` operations, both nullable, both safe to apply against an active DB. No DDL changes to `Users` (the new aspects are CDS-side inverse associations, not stored columns).

```sql
ALTER TABLE com_sap_developers_ims_Tutorials             ADD (author_ID NVARCHAR(36));
ALTER TABLE com_sap_developers_ims_TutorialContributors  ADD (user_ID   NVARCHAR(36));
```

Both columns get the standard CAP-generated NavigationProperty + ReferentialConstraint when CDS compiles. `db/last-dev/csn.json` is rebuilt as part of the PR (the `predocs:build` guard will catch unregistered changes).

### Why two FKs, not one

A single `Tutorials.author` is enough for the most-common query ("show me the primary author") but cannot answer "show me every tutorial Alice contributed to" without joining through `TutorialContributors` and email-matching anyway — i.e., the exact problem this spec is trying to solve. Conversely, only adding `TutorialContributors.user` forces the OP facet to do a more expensive distinct-on-tutorial-via-contributor query for every render.

Two FKs give us both:
- `WHERE Tutorials.author_ID = ?` → the fast "primary author" path (4 rows for Tom, today).
- `WHERE TutorialContributors.user_ID = ?` → the "contributed in any role" path (might be 40 rows).

The OP can show both as separate facets ("Authored" vs "Contributed to") in the follow-up spec.

## Backfill script — `scripts/backfill-tutorial-authors.cjs`

CommonJS, follows the pattern set by [`scripts/setup-dev-data.cjs`](../../../scripts/setup-dev-data.cjs) and [`scripts/merge-duplicate-slugs.cjs`](../../../scripts/merge-duplicate-slugs.cjs): dry-run by default, `--commit` to actually write, writes a JSON report to `.migration-data/`.

### CLI

```bash
# Dry run — computes everything, writes report, zero writes
npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs

# Commit
npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --commit

# Per-phase (debugging)
npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --phase=contributors --commit
npx cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --phase=tutorials   --commit
```

### Phases

1. **Build email→user map** — `SELECT ID, LOWER(TRIM(email)) AS email FROM Users WHERE email IS NOT NULL` → in-memory `Map<lowerEmail, userId>`. ~1k entries today; ~50 KB. Cached for the lifetime of the script invocation.
2. **Phase A — `TutorialContributors.user_ID`** — for every contributor row where `user_ID IS NULL AND email IS NOT NULL`, look up `LOWER(TRIM(email))` in the map. Hit → `UPDATE TutorialContributors SET user_ID = ? WHERE ID = ?`. Miss → push to `orphans_contributors`.
3. **Phase B — `Tutorials.author_ID`** — for every tutorial where `author_ID IS NULL`:
    a. Prefer `TutorialContributors` rows on this tutorial with `LOWER(role) IN ('author','owner')`, ordered by created-at (stable first-match).
    b. Fallback: first contributor row on this tutorial (any role).
    c. Fallback 2: `TutorialMeta.ownerEmail` for this tutorial.
    Try (a), (b), (c) in order; first email that hits the map wins. Hit → `UPDATE Tutorials SET author_ID = ?`. All-miss → push to `orphans_tutorials` with the slug, the candidate emails tried, and which fallback level produced each.
4. **Write report** — `.migration-data/tutorial-author-backfill-<ISO-timestamp>.json`:
    ```json
    {
      "ranAt": "2026-06-24T13:50:00Z",
      "committed": true,
      "summary": {
        "users_indexed": 1042,
        "contributors_matched": 187,
        "contributors_orphaned": 23,
        "tutorials_matched": 156,
        "tutorials_orphaned": 12
      },
      "orphans_contributors": [
        { "id": "…", "tutorialSlug": "…", "name": "…", "email": "…", "role": "author" }
      ],
      "orphans_tutorials": [
        { "slug": "…", "candidatesTried": [
            { "level": "contributor:author", "email": "x@y.z" },
            { "level": "contributor:any",    "email": "a@b.c" },
            { "level": "meta:ownerEmail",    "email": "p@q.r" }
          ]
        }
      ]
    }
    ```

### Idempotence

Both UPDATEs are gated by `WHERE … IS NULL` predicates. Re-running with no schema changes produces zero updates. Re-running after new `Users` rows arrive (e.g., a fresh IMS user-progress migration batch) backfills exactly the rows the previous run skipped.

### Manual-edit safety

The backfill **never overwrites a non-null FK**. If an admin (in a future spec) corrects a tutorial's author via the admin UI, the backfill will not undo it.

### Performance

Single email→user map fetch + one `SELECT` of contributors and one of tutorials. With ~1.4k tutorials and a typical ~3-5 contributors each, the script runs in well under 30 s against DEV HANA — bounded by the count of UPDATEs, not by the join shape. No SQL functions involved beyond `LOWER`/`TRIM` at index time.

## Shared resolver — `srv/lib/resolve-tutorial-author.js`

Single pure function. Same input shape, same output, used by both backfill and publish — guarantees they cannot diverge.

```js
/**
 * @param {object} input
 * @param {Array<{email: string, role: string}>} input.contributors
 *        Contributor rows for this tutorial (in publish order).
 * @param {string|null} input.ownerEmail
 *        TutorialMeta.ownerEmail for this tutorial (or null).
 * @param {Map<string, string>} input.emailToUserId
 *        LOWER(TRIM(email)) → Users.ID. Built once per run.
 * @returns {{
 *   authorUserId: string|null,
 *   contributorUserIds: Array<{ contributorIndex: number, userId: string }>,
 *   orphans: Array<{ kind: 'contributor'|'tutorial', email: string|null, reason: string }>
 * }}
 */
export function resolveTutorialAuthor({ contributors, ownerEmail, emailToUserId }) { … }
```

Pure, no I/O, no DB. The caller is responsible for providing `emailToUserId` and persisting the result.

## Publish-path integration

[`srv/lib/content-publish-session.js`](../../../srv/lib/content-publish-session.js) already has an `upsertTutorialMetadata` step where it writes `TutorialMeta`. Add a sibling step `linkTutorialAuthorship` that:

1. Builds the `emailToUserId` map **once per publish session** (cached on the session, not per slug).
2. For each tutorial in the payload, calls `resolveTutorialAuthor()`.
3. UPSERT `Tutorials.author_ID` (only if currently null — preserves manual corrections).
4. UPSERT `TutorialContributors.user_ID` (only if currently null) for each row.

Failure mode: any error in `linkTutorialAuthorship` is logged and **swallowed**. Content publishing must not fail because of an authorship-resolution glitch. The next publish or a manual `npm run migrate:authors` run recovers it.

## Tests

### Unit — `test/unit/resolve-tutorial-author.test.js` (new)

Pure-function tests on `resolveTutorialAuthor()`, no DB. Covers:

- Single contributor, role `author`, email in map → that user is `authorUserId`.
- Multiple contributors, only one with role `author` → that one wins.
- Multiple `author` roles → stable first match (lowest contributorIndex).
- No role-match, falls through to "first contributor (any role)".
- No contributors at all → falls through to `ownerEmail`.
- Nothing matches → `authorUserId` null, all candidate emails reported as orphans.
- Case-insensitive (`Tom.Jung@SAP.com` ↔ `tom.jung@sap.com`).
- Whitespace trim (`"  tom@sap.com  "` matches `"tom@sap.com"`).
- Empty contributors array — no throw.
- Map miss never throws.

### Hybrid — `test/hybrid/tutorial-author-backfill.test.js` (new)

Three test cases exercising the **real HANA** pipeline. All writes gated by `ALLOW_HYBRID_WRITES=true`; all rows prefixed `__TEST__`; cleaned in `afterAll`.

1. **Idempotency:** seed one tutorial + one contributor + one `Users` row whose email matches; run the backfill twice with `--commit`; assert the second run reports zero updates.
2. **Inverse association works:** after seed + backfill, `SELECT * FROM Users` with `expand: { authoredTutorials: { ID, slug } }` returns the seeded tutorial. This is the exact join the Spec-2 OP facet will use — if it doesn't work here, it won't work there.
3. **Publish-time auto-set:** seed a contributor + matching `Users` row, run `content-publish-session.publishTutorial(slug, html)` (the live publish path), assert `Tutorials.author_ID` ends up populated.

### Smoke — `test/smoke/tutorial-author-fk.smoke.test.js` (new)

A single post-deploy assertion: `GET /admin/Tutorials?$top=5&$expand=author($select=email)&$filter=author_ID ne null` returns at least one row. If migration was forgotten entirely, this fails the post-deploy gate.

## Operations / runbook

### `docs/developers/operations/migration-from-ims.md` (edit)

Add a new step between "import user progress" and "verify slugs":

> ### Step N — Backfill tutorial authorship
>
> After `migrate-user-progress.js` succeeds, the `Users` table is populated. Run the authorship backfill so existing tutorials and contributors get linked to user rows:
>
> ```bash
> # Dry run — review the orphans report at .migration-data/tutorial-author-backfill-<ts>.json
> npm run migrate:authors -- --dry-run
>
> # Commit
> npm run migrate:authors
> ```
>
> Re-runnable. Won't overwrite manually-corrected FKs. Orphans (contributors whose email isn't in `Users`) stay null — see the report.

### `package.json` script

```json
{
  "scripts": {
    "migrate:authors": "cds bind --exec -- node scripts/backfill-tutorial-authors.cjs --commit"
  }
}
```

The default-commit shape mirrors `migrate:reference` and `migrate:users` (the existing migrators all commit by default; the script itself accepts `--dry-run` to override).

### Hybrid migration-order test

`test/hybrid/migration-runbook-order.test.js` (new — or amend the existing migrate-from-hana test) seeds the pre-state, runs `migrate-user-progress.js --commit` then `backfill-tutorial-authors.cjs --commit`, and asserts the final FK population matches expectations. This pins the **order** as well as the result — if a future refactor reorders the runbook, this test fails.

### MEMORY pointer

One line added to `MEMORY.md` under "Migration / QA / publish":

```
- [Tutorial author backfill is a migration step](feedback_tutorial_author_backfill_runs_after_user_migration.md) — npm run migrate:authors after migrate:users; logs orphans
```

The body of that memory points back to the runbook section, so a future agent helping with PROD cutover sees the step in its index.

## Failure modes & rollback

- **HDI deploy fails on the ADD COLUMN** — extremely unlikely (both columns nullable, no constraints), but the deploy is reversible by `ALTER TABLE … DROP COLUMN` (rollback DDL committed alongside the migration). No data loss.
- **Backfill writes wrong values** — `WHERE … IS NULL` makes every write conservative; the worst case is a wrongly-linked author, which an admin can null out manually. The orphans report captures every decision so it's auditable.
- **Publish-path resolver throws** — caught and logged, content publish proceeds. Next publish or `npm run migrate:authors` recovers.
- **`Users.email` collisions** — multiple Users rows with the same email shouldn't exist (`Users.email` has no uniqueness constraint today; this is a latent data-quality issue). The map-build step warns if it sees duplicates and uses the lexicographically-first ID; the orphans report includes a `warnings` section listing colliding emails so the operator can deduplicate Users first if needed.

## Out-of-scope follow-ups (informational)

- **Advocate ↔ User 1:1 + self-add + Object-Page history facets** — separate spec, blocked on this one. Will consume `Users.authoredTutorials` (inverse of the FK added here) for the "Authored tutorials" facet on the Advocate Object Page.
- **Multi-email Users** — a future `Users.aliases : Composition of many UserEmailAliases` would let one user match several historical contributor emails. Not needed v1.
- **Tutorials.author admin-UI edit** — future. Today authorship is data-driven (from frontmatter + Users matches). When admin-side correction becomes useful (e.g., reassigning ownership after a developer leaves), the existing draft-enabled Tutorials projection in `AdminService` can surface the FK with a value-help on `Users` — the FK is already there.

## Acceptance checklist

- [ ] `db/schema.cds` carries the three new associations (`Tutorials.author`, `TutorialContributors.user`, `Users.authoredTutorials` + `Users.tutorialContributions`).
- [ ] `db/last-dev/csn.json` regenerated.
- [ ] `scripts/backfill-tutorial-authors.cjs` exists, runs idempotently, writes the orphans report.
- [ ] `srv/lib/resolve-tutorial-author.js` exports the pure resolver.
- [ ] `srv/lib/content-publish-session.js` calls the resolver in a try/catch and never lets publish fail because of it.
- [ ] `npm run migrate:authors` works.
- [ ] `docs/developers/operations/migration-from-ims.md` documents the new step.
- [ ] `MEMORY.md` carries the cross-link.
- [ ] Unit tests pass (`test/unit/resolve-tutorial-author.test.js`).
- [ ] Hybrid tests pass (`test/hybrid/tutorial-author-backfill.test.js`, `test/hybrid/migration-runbook-order.test.js`).
- [ ] Smoke test guards post-deploy (`test/smoke/tutorial-author-fk.smoke.test.js`).
- [ ] No regressions in `test/admin-annotations.test.js`, `test/admin-service.test.js`, `test/admin-drafts.test.js`, `test/admin-schema-ext.test.js`.
