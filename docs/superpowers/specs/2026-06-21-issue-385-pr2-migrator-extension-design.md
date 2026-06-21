# #385 PR-2 of 3: HANA→HANA migrator extension for new TutorialRepositories / TutorialContributors / Tag columns — Design

> Spec brainstormed 2026-06-21. Second of 3 sequential PRs that close [#385](https://github.com/sap-tutorials/tutorials-ims/issues/385). Sibling to [PR-1 spec](./2026-06-21-issue-385-pr1-schema-redesign-design.md) and merged as [PR #517](https://github.com/sap-tutorials/tutorials-ims/pull/517).

## Summary

PR-1 reshaped the CAP schema: `TutorialRepositories` now matches the IMS-source repo-group shape, `TutorialMeta` got a `repository` Association, and `Tags` gained 3 source-aligned columns (`semaphoreId`, `isActualTag`, `isInterestItem`). All of these columns hold NULL in DEV today because no migrator populates them.

PR-2 extends the established HANA→HANA migration path so those columns hold real source data:

- `scripts/migrate-from-hana.js` gains two new entities — `tutorialcontributors` (so repository owner FKs resolve) and `tutorialrepositories` — and the existing `tags` entity emits the 3 new columns.
- `scripts/backfill-tutorial-meta-from-ims.cjs` gains the `TutorialMeta.repository_ID` UPDATE column.
- `scripts/lib/migration-uuid-namespaces.cjs` gains two new permanent namespace UUIDs.

After PR-2 lands and the next migration pass runs on DEV, PR-3's `MyTutorials.repositoryName` calc field and `Tags.actualTag` projection have real data underneath them.

## Context — why this PR exists

PR-1's design doc lays out the 3-PR sequence (schema → migrator → AuthorService surface). PR-1 deliberately stops at schema reshape so destructive HDI DROPs land in isolation; PR-2 is the data-plumbing follow-up.

The PR-1 spec already names the gaps PR-2 must close (§"Sequence after this PR"):
- `TutorialRepositories` is empty in DEV (0/2792 tutorials).
- `Tags.semaphoreId/isActualTag/isInterestItem` are NULL/false for all 10,523 rows.
- `TutorialMeta.repository_ID` is NULL for every row.

PR-2 supplies the missing migration logic. No CAP-schema or service changes.

## Settled decisions (from 2026-06-21 brainstorming with Tom)

1. **Migrate the contributor side too.** `TutorialRepositories.repositoryOwner` is `Association to TutorialContributors`, and DEV's `TutorialContributors` is empty today. PR-2 migrates `IMS_TUTORIAL_AUTHOR` (~385 rows in source) into `TutorialContributors` with `tutorial_ID = NULL`. The CAP `tutorial : Association to Tutorials` element on `TutorialContributors` is nullable, so NULL-tutorial rows co-exist with any future per-tutorial contributor rows.

2. **Extend the existing two scripts; no new scripts.** `migrate-from-hana.js` already handles HANA→HANA entity migration with the right primitives (batch insert, dedup, dry-run, entity-filter). `backfill-tutorial-meta-from-ims.cjs` already UPDATEs `COM_SAP_DEVELOPERS_IMS_TUTORIALMETA` rows in place with `COALESCE`-non-clobber semantics. Both are already wired into `cutover-rehearsal.cjs` (steps 9 and 9.6). Reusing them keeps cutover orchestration unchanged and avoids spreading migration logic across more entry points.

3. **Deterministic UUIDs for new entities.** Add `tutorialcontributor` + `tutorialrepository` namespace UUIDs to `scripts/lib/migration-uuid-namespaces.cjs`. Every other entity in the migrator uses `uuidv5(String(legacyId), NS[type])`; the new entities follow the same shape. Re-runs are idempotent. The PR-1 backfill in `backfill-tutorial-meta-from-ims.cjs` can derive `TutorialMeta.repository_ID = uuidv5(String(sourceRepoLegacyId), NS.tutorialrepository)` without holding a lookup map.

## Source schema (verified against Java IMS @Entity)

Re-read from `D:\projects\com.sap.developers.ims\application\src\main\java\com\sap\developers\ims\model\` 2026-06-21:

```java
// IMS_TUTORIAL_AUTHOR (TutorialContributor.java) — flat global author table:
id, name, email
// No tutorial_id FK on the entity. Java code uses it as the global pool
// referenced by RepositoryModel.repository_owner_id and TutorialMeta.{owner_id,
// creator_id, last_contributor_id}.

// IMS_TUTORIAL_REPOSITORY (RepositoryModel.java):
id, repository_name (NOT NULL, unique), repository_owner_id → IMS_TUTORIAL_AUTHOR.id

// IMS_TAG (Tag.java):
id, name (NOT NULL), semaphore_id (NOT NULL), title_path,
is_actual_tag (boolean primitive — never null in source),
is_interest_item (Boolean boxed — nullable in source)

// IMS_TUTORIAL_METADATA.repository_id (column on TutorialMeta.java):
@ManyToOne @JoinColumn(name = "repository_id") private RepositoryModel repositoryModel;
// Nullable on source; not every tutorial belongs to a repo group.
```

A `--probe` pass on source HANA before merge is mandatory (see Rollout §1) to confirm column names and that `IMS_TUTORIAL_REPOSITORY` actually carries the row count we expect (PR-1 spec mentioned 0/2792 in DEV's TARGET but the SOURCE row count is what gates this PR).

## Changes by file

### 1. `scripts/lib/migration-uuid-namespaces.cjs` — 2 new namespaces

Append two entries to the `NAMESPACES` `Object.freeze` block (the file's docstring already says "**THESE VALUES ARE PERMANENT.** … never edit existing entries" — we only add):

```javascript
const NAMESPACES = Object.freeze({
  // … existing 15 entries unchanged …
  tutorialcontributor:  '<UUID-1>',  // generated 2026-06-21 for #385 PR-2
  tutorialrepository:   '<UUID-2>',  // generated 2026-06-21 for #385 PR-2
});
```

The two UUIDs MUST be freshly generated via `crypto.randomUUID()` at implementation time (NOT chosen by Claude — the file's docstring instructs to generate fresh UUIDs for new entries, never re-use), and once they land in a merged commit they are permanent. The plan's first task is "generate two UUIDs and paste them into namespace + spec acceptance".

### 2. `scripts/migrate-from-hana.js` — extend `tags` entity (3 new columns)

The existing `tags` migration block reads (~line 805):

```javascript
results.push(await migrateEntity(source, target, T, {
  name: 'tags',
  sourceQuery: `SELECT "ID", "NAME" FROM ${S}."IMS_TAG"`,
  targetTable: 'COM_SAP_DEVELOPERS_IMS_TAGS',
  mapRow: (row) => ({
    ID: uuidMap.tags.get(row.ID),
    LEGACYID: row.ID,
    NAME: truncStr(row.NAME, 255),
  }),
}));
```

Extend the source query and mapRow:

```javascript
results.push(await migrateEntity(source, target, T, {
  name: 'tags',
  sourceQuery: `SELECT "ID", "NAME", "SEMAPHORE_ID", "IS_ACTUAL_TAG", "IS_INTEREST_ITEM" FROM ${S}."IMS_TAG"`,
  targetTable: 'COM_SAP_DEVELOPERS_IMS_TAGS',
  mapRow: (row) => ({
    ID: uuidMap.tags.get(row.ID),
    LEGACYID: row.ID,
    NAME: truncStr(row.NAME, 255),
    SEMAPHOREID:    truncStr(row.SEMAPHORE_ID, 255),  // NEW (PR-1 column)
    ISACTUALTAG:    row.IS_ACTUAL_TAG === 1 || row.IS_ACTUAL_TAG === true,
    ISINTERESTITEM: row.IS_INTEREST_ITEM === 1 || row.IS_INTEREST_ITEM === true,
  }),
}));
```

**Notes:**
- `truncStr(null, 255)` returns `null` so a missing source `semaphore_id` (shouldn't happen — NOT NULL in source — but defence in depth) yields `null`, matching PR-1's nullable CAP column.
- HANA returns BOOLEAN-typed columns as `1`/`0` integers via `hdb`, NOT as JS booleans. Explicit `=== 1 || === true` works for both code paths (real HANA + the in-memory test stubs).
- `IS_INTEREST_ITEM` is a boxed `Boolean` in Java — nullable. The expression above maps NULL → `false`, honoring CAP's `default false` semantics.

The existing path is delete-then-insert, so adding these columns simply replaces the whole table. No re-run concern.

### 3. `scripts/migrate-from-hana.js` — new `tutorialcontributors` entity

Insert after the `users` migration (~line 990) and **after** the `auditNullSapidUsers` call (so users are written first; FK ordering safe). New block:

```javascript
// 7c. TutorialContributors — global flat author table.
// Source (IMS_TUTORIAL_AUTHOR) has no tutorial_id FK; rows model the global
// pool of named authors. CAP TutorialContributors.tutorial is nullable so
// migrated rows land with tutorial_ID = NULL. PR-1 reshape made
// TutorialRepositories.repositoryOwner an Association to this entity, so
// these rows MUST exist before tutorialrepositories migrates.
//
// Issue #385 PR-2.
results.push(await migrateEntity(source, target, T, {
  name: 'tutorialcontributors',
  sourceQuery: `SELECT "ID", "NAME", "EMAIL" FROM ${S}."IMS_TUTORIAL_AUTHOR"`,
  targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS',
  mapRow: (row) => ({
    ID: deriveUuid('tutorialcontributor', row.ID),
    LEGACYID: row.ID,
    TUTORIAL_ID: null,           // source has no per-tutorial FK
    NAME:  truncStr(row.NAME, 255),
    EMAIL: truncStr(row.EMAIL, 255),
    ROLE:  null,                  // CAP-side concept, no source counterpart
  }),
}));
```

(`uuidMap.contributors` is built once in the lookup-map preamble shown above — no in-block lookup-population.)

The migrator's `uuidMap` is currently a fixed-shape object with named keys. Initialize the two new maps alongside the existing ones near line 715:

```javascript
const uuidMap = {
  tutorials: new Map(),
  // …
  contributors: new Map(),         // NEW
  repositories: new Map(),         // NEW
};
// … later …
const allContributors = await query(source, `SELECT "ID" FROM ${S}."IMS_TUTORIAL_AUTHOR"`);
allContributors.forEach(c => uuidMap.contributors.set(c.ID, deriveUuid('tutorialcontributor', c.ID)));
console.log(`  TutorialContributors: ${uuidMap.contributors.size}`);

const allRepositories = await query(source, `SELECT "ID" FROM ${S}."IMS_TUTORIAL_REPOSITORY"`);
allRepositories.forEach(r => uuidMap.repositories.set(r.ID, deriveUuid('tutorialrepository', r.ID)));
console.log(`  TutorialRepositories: ${uuidMap.repositories.size}`);
```

Both maps are needed up-front because the lookup table preamble runs before the per-entity loop. Treat both `SELECT "ID"` calls as try/catch-optional (matching the existing pattern for `prizes`, `accomplishments`, etc.) so a missing source table doesn't sink the whole migrator.

### 4. `scripts/migrate-from-hana.js` — new `tutorialrepositories` entity

Insert immediately after the new `tutorialcontributors` block:

```javascript
// 7d. TutorialRepositories — repo-group reference table.
// PR-1 reshape; source IMS_TUTORIAL_REPOSITORY = (id, repository_name, repository_owner_id).
// repositoryOwner_ID resolves through uuidMap.contributors built above.
// Issue #385 PR-2.
if (uuidMap.repositories.size > 0) {
  results.push(await migrateEntity(source, target, T, {
    name: 'tutorialrepositories',
    sourceQuery: `SELECT "ID", "REPOSITORY_NAME", "REPOSITORY_OWNER_ID" FROM ${S}."IMS_TUTORIAL_REPOSITORY"`,
    targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES',
    mapRow: (row) => ({
      ID: uuidMap.repositories.get(row.ID),
      LEGACYID: row.ID,
      NAME: truncStr(row.REPOSITORY_NAME, 255),
      REPOSITORYOWNER_ID: row.REPOSITORY_OWNER_ID
        ? (uuidMap.contributors.get(row.REPOSITORY_OWNER_ID) || null)
        : null,
    }),
  }));
}
```

- `@assert.unique.name` on the CAP entity ensures source `repository_name UNIQUE` is honored downstream. If a duplicate ever sneaks past (shouldn't — source enforces unique), the migrator's batch path falls back row-by-row and surfaces the constraint violation as a logged error rather than crashing.
- An orphan `repository_owner_id` (FK points at an IMS_TUTORIAL_AUTHOR row that's somehow missing) becomes `null` — the chain query then returns `null` email, identical to the no-repo case.

### 5. `scripts/migrate-from-hana.js` — `tags` UUID-map probe stays unchanged

The existing lookup-map preamble already populates `uuidMap.tags` from `SELECT "ID" FROM IMS_TAG`. No change. The new column extension at §2 reuses that map.

### 6. `scripts/backfill-tutorial-meta-from-ims.cjs` — REPOSITORY_ID wiring

Two surgical edits:

**Edit A — extend the source SELECT (~line 127):**

```javascript
const sourceRows = await runSql(source, `
  SELECT
    TM.TUTORIAL_ID  AS TUT_LEGACY_ID,
    A.EMAIL         AS OWNER_EMAIL,
    TM.IS_REVIEWED  AS IS_REVIEWED,
    TM.UPDATED_AT   AS UPDATED_AT,
    TM.NOTIFICATION_NUMBER AS NOTIF_NUM,
    TM.NOTIFICATION_DATE   AS NOTIF_DATE,
    TM.REPOSITORY_ID       AS REPO_LEGACY_ID
  FROM IMS_TUTORIAL_META TM
  JOIN IMS_TUTORIAL_AUTHOR A ON TM.OWNER_ID = A.ID
`);
```

**Edit B — prepared statement + UPDATE call (~line 147):**

> Pre-edit verification: confirm the file already imports `uuidv5` from `uuid` and `NAMESPACES` from `./lib/migration-uuid-namespaces.cjs`. (Re-read of the file 2026-06-21 confirmed both are present at lines 48–49.) If a future drift removes either import, add the two `require` lines as part of Edit B.

```javascript

stmt = await prepareStmt(target,
  `UPDATE COM_SAP_DEVELOPERS_IMS_TUTORIALMETA
      SET OWNER                = COALESCE(?, OWNER),
          REVIEWEDDATE         = COALESCE(?, REVIEWEDDATE),
          NOTIFICATIONNUMBER   = COALESCE(?, NOTIFICATIONNUMBER),
          LASTNOTIFICATIONDATE = COALESCE(?, LASTNOTIFICATIONDATE),
          REPOSITORY_ID        = COALESCE(?, REPOSITORY_ID),       -- NEW
          MODIFIEDAT           = CURRENT_TIMESTAMP,
          MODIFIEDBY           = 'backfill-script'
    WHERE TUTORIAL_ID = ?`);
```

**Edit C — derive the FK in the per-row loop (~line 175):**

```javascript
const repoUuid = row.REPO_LEGACY_ID
  ? uuidv5(String(row.REPO_LEGACY_ID), NAMESPACES.tutorialrepository)
  : null;
// …
const params = [ownerEmail, reviewedDate, notifNum, notifDate, repoUuid, targetTutorialUuid];
```

**Edit D — extend the early-skip predicate (~line 179):**

```javascript
if (!ownerEmail && !reviewedDate && notifNum == null && notifDate == null && !repoUuid) {
  missing++;
  continue;
}
```

**Edit E — summary counter:**

Add a parallel `updatedRepo` counter and log it in the summary block.

This preserves the script's idempotency and non-clobber semantics — `COALESCE(?, REPOSITORY_ID)` means a non-null source value wins, null source preserves the existing target.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Source column names differ from Java entity (e.g. `semaphore_id` actually stored as `SEMAPHOREID`) | Implementation Task 0 is a `--probe` run against source HANA: `SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS WHERE TABLE_NAME IN ('IMS_TAG','IMS_TUTORIAL_REPOSITORY','IMS_TUTORIAL_AUTHOR','IMS_TUTORIAL_META')`. If names differ, spec is updated before any code is written. |
| `IS_INTEREST_ITEM` source values surprise us (e.g. NULL → unexpected `false` collision with explicit `false` rows) | Pre-impl probe: `SELECT COUNT(*) FILTER (WHERE IS_INTEREST_ITEM IS NULL), COUNT(*) FILTER (WHERE IS_INTEREST_ITEM = TRUE) FROM IMS_TAG`. If interesting, surface in PR description. |
| HANA boolean returned as 1/0 vs true/false confuses mapRow | Explicit `=== 1 \|\| === true` handles both. Documented in §2 note. |
| `TutorialContributors` table is non-empty in DEV (admin tooling wrote rows we don't know about) | Pre-merge probe: `SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS;`. If non-zero, halt and re-evaluate (could mean a migrator generation we missed or admin tooling). |
| Re-running the migrator after admin tooling adds per-tutorial TutorialContributors rows would wipe them (delete-then-insert path) | Real concern only if admin tooling starts writing. Today it doesn't (`grep -rn 'INSERT.*TUTORIALCONTRIBUTORS\|cds.insert.*TutorialContributors' srv/ → 0`). Belt-and-braces: leave the entity on the standard delete-then-insert path (matching `tags`, `events`, etc.); a future PR can switch to upsert if admin tooling lands. |
| New namespace UUIDs accidentally collide with one of the existing 15 | Use `crypto.randomUUID()` to generate; collision probability ~2^-122. Spec acceptance criterion requires the UUIDs are pasted both into the namespace file AND into the spec's "Acceptance criteria" section as a witness, so a reviewer can grep both locations. |
| Existing namespace docstring's "never edit existing entries" rule is silently broken | Plan checklist item explicitly lists "added 2 entries; touched zero existing entries" with a `git diff` quote in the PR description. |
| `backfill-tutorial-meta-from-ims.cjs` UPDATE clobbers admin-set REPOSITORY_ID | Impossible today — `REPOSITORY_ID` is a new column with no admin UI write path. Future-proofed by `COALESCE(?, REPOSITORY_ID)`. |
| Source `IMS_TUTORIAL_METADATA.repository_id` references a repo row that doesn't migrate (e.g. orphaned FK in source) | `uuidv5(legacyId, NS)` derives a UUID regardless of whether the row exists in target. The CAP-side `Association` doesn't have a foreign-key constraint set on it in HDI today; the UPDATE will succeed and the chain query at PR-1's read path will return NULL email (NULL-safe path). |
| The migrator + backfill run order in `cutover-rehearsal.cjs` matters: TutorialRepositories rows must exist before backfill runs | Already correct — `migrate-from-hana.js` is step 9, `backfill-tutorial-meta-from-ims.cjs` is step 9.6. PR-2 doesn't move either step. |

## Tests

### Unit tests

**`test/scripts/migrate-from-hana.test.js`** (existing or new file — check first; the migrator's `partitionBySlug` already has a unit test):

- New: `mapRow` for `tags` emits all 5 fields with correct types when source row has all columns populated (`SEMAPHOREID` string, `ISACTUALTAG` true, `ISINTERESTITEM` true).
- New: `mapRow` for `tags` emits `ISINTERESTITEM: false` when source value is NULL (defence-in-depth for `Boolean` boxed).
- New: `mapRow` for `tutorialcontributors` emits stable UUID for the same legacyId across calls; emits `TUTORIAL_ID: null`.
- New: `mapRow` for `tutorialrepositories` resolves `REPOSITORYOWNER_ID` to the deterministic contributor UUID; emits `null` when source `REPOSITORY_OWNER_ID` is `null`.
- New: `mapRow` for `tutorialrepositories` emits `null` when source `REPOSITORY_OWNER_ID` is set but the contributor uuidMap doesn't have that key (orphan-FK defensive path).

### Backfill script unit test

**`test/scripts/backfill-tutorial-meta-from-ims.test.js`** (new file or extension of existing):

- Test fixture: a source-row shape with `REPO_LEGACY_ID = 42` produces the prepared-statement params containing `uuidv5("42", NAMESPACES.tutorialrepository)` as the 5th element.
- Test fixture: `REPO_LEGACY_ID = null` yields `null` 5th element.
- Test: a row that has ONLY `REPO_LEGACY_ID` set (no email, no reviewed, no notif) is NOT skipped by the early-out check (defends against the new field being orphaned).

### Hybrid test

**`test/hybrid/385-pr2-migrator.test.js`** (new file). Cannot run until PR-2 is merged AND `migrate-from-hana.js + backfill` have executed against DEV; CI annotation `@todo-after-deploy: 385-pr2` should mark it. Test cases:

1. `TutorialContributors` has ≥ 1 row with non-empty `email` (sample-by-name).
2. `TutorialRepositories` has ≥ 1 row with `name` matching a known IMS repo group (e.g. `btp-foundation` if present in source).
3. `TutorialMeta.repository_ID` is non-NULL for ≥ 1 row.
4. **End-to-end chain (re-uses PR-1's pattern)** — run this query:

   ```javascript
   SELECT.one.from(TutorialMeta)
     .columns('repository.repositoryOwner.email as email')
     .where('repository_ID IS NOT NULL')
   ```

   …and assert a non-null `email` in the result. This is the same CDS-QL chain that PR-3's `MyTutorials.repositoryName` / owner-email reads will use — so passing it here doubles as a forward-compat guard against any chain-path drift in PR-3.
5. `Tags.semaphoreId` is non-NULL for ≥ 1 row; `Tags.isActualTag = true` is satisfied by ≥ 1 row (assuming source has at least one `is_actual_tag = true`; pre-probe confirms).

`afterAll` cleanup is not required — this is read-only verification against migrated data.

### Migration-table verification — N/A

PR-2 does not change CDS shape, so HDI migration tables don't regenerate.

## Rollout

1. **Pre-merge source probe** (mandatory, by implementer):

   ```sql
   -- Against IMS source HANA
   SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS
     WHERE TABLE_NAME = 'IMS_TAG'
       AND COLUMN_NAME IN ('SEMAPHORE_ID', 'IS_ACTUAL_TAG', 'IS_INTEREST_ITEM');
   -- Expect 3 rows.

   SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS
     WHERE TABLE_NAME = 'IMS_TUTORIAL_REPOSITORY';
   -- Expect rows for ID, REPOSITORY_NAME, REPOSITORY_OWNER_ID.

   SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS
     WHERE TABLE_NAME = 'IMS_TUTORIAL_AUTHOR';
   -- Expect rows for ID, NAME, EMAIL.

   SELECT COUNT(*) AS C FROM IMS_TUTORIAL_REPOSITORY;
   SELECT COUNT(*) AS C FROM IMS_TUTORIAL_AUTHOR;
   SELECT COUNT(*) FILTER (WHERE REPOSITORY_ID IS NOT NULL) AS C
     FROM IMS_TUTORIAL_META;
   ```

   If any column name differs or row counts are surprising, halt and amend spec before writing code.

2. **Pre-merge target probe** (mandatory):

   ```sql
   -- Against DEV CAP HANA
   SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS;
   SELECT COUNT(*) FROM COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES;
   -- Both expect 0. If non-zero, halt and re-evaluate.
   ```

3. **Merge PR-2**.

4. **Run the migration pass on DEV** (manual op, follows the existing `cutover-rehearsal.cjs` runbook in `docs/developers/operations/migration-from-ims.md`). The two scripts pick up the new columns/entities automatically. No env-var changes.

5. **Post-migration verification** — run the hybrid test file from §"Tests" against DEV. Expected pass: all 5 assertions green.

6. **PR-3 unblocked** — AuthorService field expansion can land knowing the underlying data is real.

## Out of scope

- AuthorService `MyTutorials` field expansion + `isSlugAvailable` action + `Tags.actualTag` projection — that's PR-3.
- Tightening `Tags.semaphoreId` to NOT NULL — separate follow-up after PR-2 confirms backfill is clean.
- Reshaping `TutorialContributors.tutorial` (its current per-tutorial vs global confusion) — pre-existing schema concern unaffected by PR-2.
- Backfilling `Tags.titlePath` — also dropped by the migrator today; PR-1 spec confirmed it's a deliberate out-of-scope omission since CAP-side `label` (admin-edited) is the surface that matters.
- Any tightening of `@assert.unique` on TutorialContributors — they're a flat global table; uniqueness only applies to `TutorialRepositories.name` (already enforced).
- No QA channel migration. QA's schema doesn't include TutorialMeta / TutorialRepositories / full Tags.

## Acceptance criteria

### Pre-merge (code shape)

- [ ] `scripts/lib/migration-uuid-namespaces.cjs` has new entries `tutorialcontributor` and `tutorialrepository`; both UUIDs were generated via `crypto.randomUUID()` at impl time and ARE pasted into this spec's PR description for grep-witness.
- [ ] `scripts/migrate-from-hana.js` `tags` entity sourceQuery selects 5 columns; mapRow emits `SEMAPHOREID`, `ISACTUALTAG`, `ISINTERESTITEM`.
- [ ] `scripts/migrate-from-hana.js` lookup-map preamble populates `uuidMap.contributors` and `uuidMap.repositories` from source `SELECT "ID"` calls (try/catch optional pattern matching prizes/accomplishments).
- [ ] `scripts/migrate-from-hana.js` has new `tutorialcontributors` block immediately after `users` (positioned to honor FK ordering) and new `tutorialrepositories` block immediately after.
- [ ] `scripts/backfill-tutorial-meta-from-ims.cjs` SELECT includes `TM.REPOSITORY_ID AS REPO_LEGACY_ID`; prepared UPDATE includes `REPOSITORY_ID = COALESCE(?, REPOSITORY_ID)`; per-row loop derives `repoUuid = uuidv5(String(row.REPO_LEGACY_ID), NAMESPACES.tutorialrepository)`; early-skip predicate includes `!repoUuid`; summary has `updatedRepo` counter.
- [ ] Unit tests for new mapRows and backfill row shape pass.
- [ ] Hybrid test file committed (cannot run pre-deploy; CI must be tolerant).
- [ ] `cds compile db/schema.cds` still succeeds (no schema changes in PR-2; this is a sanity check).
- [ ] PR description quotes the pre-merge source probe + target probe results (column names + row counts).
- [ ] No `compat_*` flags or CAP 10 readiness regressions introduced (pure migrator change; no service code touched).
- [ ] `npm test` runs green; new tests added to the workspace.

### Post-deploy (data shape — gated on a successful DEV migration pass)

- [ ] Hybrid test file from §"Tests" runs green on DEV after the next migration pass.
- [ ] Manual SQL check on DEV HANA confirms `COUNT(*) FROM TutorialContributors > 0` and `COUNT(*) FROM TutorialRepositories > 0`.
- [ ] Manual SQL check confirms `Tags.semaphoreId IS NOT NULL` for the bulk of rows (allowing for any source NULLs that slip past the source's NOT NULL constraint).

## Backout

If post-deploy verification fails:

1. `migrate-from-hana.js` extensions: revert the PR (the migrator's delete-then-insert path will leave `TutorialContributors` + `TutorialRepositories` empty again on the next run; `tags` rows lose the 3 new columns and they go back to NULL — equivalent to pre-PR state).
2. `backfill-tutorial-meta-from-ims.cjs` `REPOSITORY_ID` edits: revert; `TutorialMeta.repository_ID` reverts to NULL on the next backfill run.
3. Namespaces: `tutorialcontributor` + `tutorialrepository` SHOULD NOT be removed even on revert — any data that was already keyed on them in DEV would orphan. Leave them in `migration-uuid-namespaces.cjs` (the file's own docstring already encodes this rule).

## Spec + brainstorm trail

- Predecessor spec: [`docs/superpowers/specs/2026-06-21-issue-385-pr1-schema-redesign-design.md`](./2026-06-21-issue-385-pr1-schema-redesign-design.md) (PR #517, merged 2026-06-21).
- Brainstorming: 2026-06-21 with Tom; 3 decisions captured in §"Settled decisions".
- Next: PR-3 spec (AuthorService field expansion).
