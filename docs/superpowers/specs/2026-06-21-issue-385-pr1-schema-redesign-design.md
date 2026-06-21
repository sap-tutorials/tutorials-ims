# #385 PR-1 of 3: CAP schema redesign for TutorialRepositories + Tag column additions — Design

> Spec brainstormed 2026-06-21. First of 3 sequential PRs that close [#385](https://github.com/sap-tutorials/tutorials-ims/issues/385).

## Summary

The CAP schema for `TutorialRepositories` does not match the IMS source's `IMS_TUTORIAL_REPOSITORY` shape — the CAP version models per-tutorial GitHub-URL metadata while the source models repository groups (e.g. "btp-foundation"). The `Tags` entity is also missing 3 source columns that the migrator drops. This PR reshapes the CAP schema to be structurally aligned with the IMS source so subsequent PRs (PR-2 migrator extension, PR-3 AuthorService field expansion) can land cleanly.

**No data migration in this PR.** DEV's `TutorialRepositories` is verified empty (0 of 2792 tutorials have rows), so destructive HDI DROPs are safe.

## Context — why this PR exists

Riley's [#385](https://github.com/sap-tutorials/tutorials-ims/issues/385) contract (settled 2026-06-19) included `MyTutorials.repositoryName` and `AuthorService.Tags.actualTag` fields. During brainstorming for PR-3 (AuthorService field expansion), we discovered:

1. **`TutorialRepositories` is empty in DEV** (0/2792). The migrator at `scripts/migrate-from-hana.js` does not include the entity.
2. **`Tags.titlePath` is NULL** for all 10,523 tag rows. The migrator's `tags` entity pulls only `(ID, NAME)`.
3. **CAP `TutorialRepositories` schema is wrongly shaped vs source**. Source `IMS_TUTORIAL_REPOSITORY = (id, repository_name, repository_owner_id)`; CAP has `(tutorial, repoUrl, branch, owner)`. Different concepts.
4. **Riley's `actualTag` is a source BOOLEAN, not a path-parse**. Source has `IMS_TAG.is_actual_tag : boolean`, not "leaf after last `>` of titlePath". His spec comment described the path-parse approach because the source schema was unfamiliar; the actual source has a stored boolean.

PR-1 fixes the schema. PR-2 (separate spec) extends the migrator. PR-3 (separate spec) exposes the fields through AuthorService.

## Settled decisions (from 2026-06-21 brainstorming)

1. **TutorialRepositories shape**: Faithful to IMS source. `{ name (unique), repositoryOwner : Association to TutorialContributors }`. DROP `tutorial/repoUrl/branch/owner`.
2. **TutorialMeta.repository**: New `Association to TutorialRepositories` (matches source `IMS_TUTORIAL_METADATA.repository_id`).
3. **Tags new columns**: Add `semaphoreId : String(255)` (nullable for now), `isActualTag : Boolean default false`, `isInterestItem : Boolean default false`. Keep existing `label` (admin-edited, no source counterpart).
4. **HDI transition**: Drop-then-add. DEV is empty so destructive DROPs are safe.
5. **`contributor-notifications.js`**: Updated in PR-1 to read repo-group owner via the new chain `meta.repository.repositoryOwner.email`. NULL-safe (falls through to `null` when chain doesn't resolve).

## Why this is split into 3 PRs

Each PR has a single responsibility:

- **PR-1 (this spec)**: Schema structural alignment. No data flow.
- **PR-2**: Migrator extension. Populates new columns from IMS source HANA (us30 / `Developer Destination_IMS` / PROD).
- **PR-3**: AuthorService field expansion (Riley's #385 contract). Exposes new columns via `MyTutorialsView`.

The PRs depend in sequence — PR-2 cannot run without PR-1's schema; PR-3's calc fields produce NULL until PR-2 populates source data. But each PR is independently reviewable + revertable, and stops at a known-good intermediate state.

## Source schema (verified against Java IMS @Entity)

Read from `D:\projects\com.sap.developers.ims\application\src\main\java\com\sap\developers\ims\model\` 2026-06-21:

```java
// IMS_TAG (Tag.java):
id, name (not null), semaphore_id (not null), title_path, is_actual_tag, is_interest_item
// Java computed: mdFormat = TagUtil.textToMdFormat(titlePath)

// IMS_TUTORIAL_REPOSITORY (RepositoryModel.java):
id, repository_name (not null, unique), repository_owner_id → TutorialContributor

// IMS_TUTORIAL_METADATA.repository_id FK → IMS_TUTORIAL_REPOSITORY
// Java computed: TutorialMeta.getRepositoryName() = repositoryModel.getName()
```

## Changes by file

### 1. `db/schema.cds` — TutorialRepositories reshape

**OLD** (lines ~320-325):

```cds
entity TutorialRepositories : cuid, LegacyKeyed {
  tutorial                  : Association to Tutorials;
  repoUrl                   : String(1000);
  branch                    : String(255);
  owner                     : String(255);
}
```

**NEW**:

```cds
@assert.unique.name : [name]
entity TutorialRepositories : cuid, LegacyKeyed {
  name             : String(255);                          // matches IMS_TUTORIAL_REPOSITORY.repository_name
  repositoryOwner  : Association to TutorialContributors;  // matches IMS_TUTORIAL_REPOSITORY.repository_owner_id
}
```

### 2. `db/schema.cds` — TutorialMeta.repository association

In the existing `TutorialMeta` entity, add (after `lastNotificationDate : Timestamp;` near the end of the entity body):

```cds
repository : Association to TutorialRepositories;
```

### 3. `db/schema.cds` — Tags 3 new columns

In the existing `Tags` entity (~line 281), add 3 columns after the existing `virtual mdFormat`:

```cds
entity Tags : cuid, LegacyKeyed {
  name                      : String(255);
  label                     : String(255);
  titlePath                 : String(255);
  virtual mdFormat          : String;
  semaphoreId               : String(255);          // NEW — matches IMS_TAG.semaphore_id; nullable for migration safety
  isActualTag               : Boolean default false; // NEW — matches IMS_TAG.is_actual_tag
  isInterestItem            : Boolean default false; // NEW — matches IMS_TAG.is_interest_item
}
```

**Note on `semaphoreId` nullability**: source enforces `NOT NULL`. CAP version stays nullable in this PR for HDI migration safety (HDI cannot add a NOT NULL column to a table with existing rows without a default). PR-2 backfills `semaphoreId` from source; a follow-up PR can tighten the constraint to `not null` once data exists.

### 4. `db/schema.cds` — Tutorials.repositories composition stays valid

The existing `Tutorials.repositories : Composition of many TutorialRepositories on repositories.tutorial = $self` is now **structurally broken** because `TutorialRepositories.tutorial` is removed. This composition needs to be DROPPED from `Tutorials`. The new model is `TutorialMeta.repository : Association to TutorialRepositories` (a single FK, not a composition).

```cds
// OLD line ~43 inside Tutorials entity:
repositories : Composition of many TutorialRepositories on repositories.tutorial = $self;

// REMOVE this line.
```

This is **structurally required** — without it, `cds compile` errors with "association target field not found".

### 5. `srv/lib/contributor-notifications.js` — repo-owner chain read

The existing `computeStaleNotifications` reads `TutorialRepositories.owner` via `tutorial_ID` FK. Both column AND FK are gone in the new schema.

**OLD** (lines 29-43):

```javascript
const contributors = await SELECT.from(TutorialContributors)
  .where({ tutorial_ID: tutorial.ID });

const repo = await SELECT.one.from(TutorialRepositories)
  .where({ tutorial_ID: tutorial.ID });

notifications.push({
  tutorialId: tutorial.ID,
  slug: tutorial.slug,
  title: tutorial.title,
  reviewedDate: meta.reviewedDate,
  notificationLevel: meta.notificationNumber || 0,
  contributors: contributors.map(c => ({ name: c.name, email: c.email, role: c.role })),
  repoOwner: repo?.owner || null
});
```

**NEW**:

```javascript
const contributors = await SELECT.from(TutorialContributors)
  .where({ tutorial_ID: tutorial.ID });

// #385 PR-1: repo-group owner now lives on TutorialMeta.repository.repositoryOwner.
// Chain query through Associations; CAP compiles to LEFT JOIN. NULL-safe — if
// meta.repository is null (no group assigned yet — common until PR-2 migrator
// runs), the chain returns null and notificationLevel 1 falls through to
// owner-only recipients (existing behaviour).
const repoOwnerRow = await SELECT.one.from(TutorialMeta)
  .columns('repository.repositoryOwner.email as email')
  .where({ tutorial_ID: tutorial.ID });

notifications.push({
  tutorialId: tutorial.ID,
  slug: tutorial.slug,
  title: tutorial.title,
  reviewedDate: meta.reviewedDate,
  notificationLevel: meta.notificationNumber || 0,
  contributors: contributors.map(c => ({ name: c.name, email: c.email, role: c.role })),
  repoOwner: repoOwnerRow?.email ?? null
});
```

The `determineRecipients` function consumes `repoOwner` as a string-or-null already; no change needed there.

### 6. `scripts/cleanup-catalog-pollution.cjs` — remove TutorialRepositories from childTablesById

The cleanup script (line ~166) currently includes `'TutorialRepositories'` in the `childTablesById` array that gets a `DELETE FROM ... WHERE TUTORIAL_ID IN (...)` per slug-orphaned tutorial. After this PR:

- `TutorialRepositories.tutorial_ID` column no longer exists.
- `TutorialRepositories` is now a repo-GROUP table, not per-tutorial — deleting from it as part of a tutorial-cleanup makes no semantic sense anyway.

The script wraps each delete in try/catch and `console.warn`s on failure, so it would not crash, but it would silently fail to do anything (the column won't exist). Remove `'TutorialRepositories'` from the `childTablesById` array.

### 7. Auto-regenerated files

`cds build` will regenerate:

- `db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable` — currently at `== version=1` with no migration blocks (the entity has never been altered since first deploy). This PR will emit `== version=2` plus a new `== migration=2` block with `ALTER TABLE ... DROP (TUTORIAL_ID, REPOURL, BRANCH, OWNER)` + `ADD (NAME, REPOSITORYOWNER_ID)`. HDI flags DROPs as `>>>>> Manual resolution required` — implementer uncomments them after verifying `TutorialRepositories` is empty.
- `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` — currently at `== version=3` with last block `== migration=3` (from #513 `firstNotificationDate`). This PR will emit `== version=4` plus a new `== migration=4` block with `ALTER TABLE ... ADD (REPOSITORY_ID NVARCHAR(36))`.
- `db/src/com.sap.developers.ims.Tags.hdbmigrationtable` — currently at `== version=3` with last block `== migration=3`. This PR will emit `== version=4` plus a new `== migration=4` block with `ALTER TABLE ... ADD (SEMAPHOREID NVARCHAR(255), ISACTUALTAG BOOLEAN DEFAULT FALSE, ISINTERESTITEM BOOLEAN DEFAULT FALSE)`.
- `db/last-dev/csn.json` — CSN cache regen.

## HDI migration safety

Memory `[feedback_hdi_deploys_can_wipe_data]` warned about destructive HDI operations. **The DROPs in this PR are safe because**:

- `TutorialRepositories.repoUrl/branch/owner` — column drops on a table with **0 rows** in DEV (verified 2026-06-21).
- `TutorialRepositories.tutorial_ID` — same.

**Pre-DROP verification** (mandatory implementer step before uncommenting `>>>>>` blocks):

```sql
SELECT COUNT(*) FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES";
```

Expected: `0`. If non-zero, STOP and re-evaluate (probably means QA channel or some import populated the entity between brainstorm and execution).

**QA channel check**: this PR's schema changes flow to `tutorials-hana-qa` too. The `tutorials-db-qa-deployer` MTA module runs the same hdbmigrationtable. Verify QA channel also has 0 rows:

```sql
-- against tutorials-hana-qa container
SELECT COUNT(*) FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES";
```

If QA has data, hold the PR until QA can also be safely migrated.

## Tests

### Hybrid test (new file)

**`test/hybrid/385-schema-redesign.test.js`** — verifies new shape works against live HANA:

1. `TutorialRepositories.name` is queryable and unique-constrained (insert two rows with same name → second fails with assertion violation).
2. `TutorialMeta.repository_ID` FK is accepted in INSERT, resolves to a `TutorialRepositories` row on SELECT.
3. `Tags.semaphoreId`, `isActualTag`, `isInterestItem` columns exist and accept NULL/false/false defaults.
4. **End-to-end 2-level chain query**: insert TutorialContributors row (`email: 'owner@sap.com'`) → insert TutorialRepositories row with `repositoryOwner_ID` set to that contributor → insert TutorialMeta with `repository_ID` set to that repo. Run `SELECT.one.from(TutorialMeta).columns('repository.repositoryOwner.email as email').where({ ID: metaId })`. **Assert the returned `email === 'owner@sap.com'`.** This proves the 2-level chain compiles to a LEFT JOIN on HANA AND returns the correct value end-to-end (not just "syntactically parses"). 2-level path expressions are uncommon in this codebase — grep for `\.columns\(.*\\.\\w+\\.\\w+\\.\\w+` returns ZERO hits today — so the hybrid test is the only way to verify the JOIN works on real HANA.
5. **NULL-safe chain**: same fixture but with `TutorialMeta.repository_ID = NULL`. Run the same chain query. **Assert the returned row has `email: null`** (not undefined, not a throw). Confirms NULL-safety of the chain when `meta.repository` is unset — the common case before PR-2 migrator runs.

Cleanup in `afterAll` (existing `test/hybrid/_guard.js` enforces `ALLOW_HYBRID_WRITES=true`).

### Unit test (extend existing)

**`test/lib/contributor-notifications.test.js`** — extend to cover the new chain:

- Add fixture (in `beforeAll`, AFTER the existing TutorialContributors INSERT and BEFORE the existing TutorialMeta INSERT — the order matters for FK resolution): insert one `TutorialRepositories` row (`name: 'btp-foundation'`, `repositoryOwner_ID` pointing to the existing 'alice@sap.com' TutorialContributor). Then update the existing `TutorialMeta` INSERT to include `repository_ID` pointing to the new TutorialRepositories row.
- New test: `computeStaleNotifications` produces `repoOwner: 'alice@sap.com'` when chain resolves.
- New test: another fixture seeded with `TutorialMeta.repository_ID = null`, assert `repoOwner: null`. Confirms NULL-safe path.

### Migration table verification

Acceptance criteria:

- `db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable` contains `migration=3` with the DROP+ADD pair, manually-resolved (no `>>>>>` markers remaining).
- `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` contains `migration=4` with `ADD (repository_ID NVARCHAR(36))`.
- `db/src/com.sap.developers.ims.Tags.hdbmigrationtable` contains a new migration block with `ADD (semaphoreId NVARCHAR(255), isActualTag BOOLEAN DEFAULT FALSE, isInterestItem BOOLEAN DEFAULT FALSE)`.
- `node --check srv/lib/contributor-notifications.js` passes.
- All in-scope unit + hybrid tests green.

## Rollout

1. **Pre-deploy verification**: query DEV HANA `TutorialRepositories` row count. Must be 0.
2. **Deploy**: lands via the next `Build & Deploy` workflow_dispatch run. The `tutorials-db-deployer` HDI deploy will:
   - DROP TutorialRepositories columns (safe — empty table)
   - ADD TutorialRepositories columns
   - ADD TutorialMeta.repository_ID
   - ADD Tags 3 new columns
3. **Post-deploy verification**: query DEV HANA to confirm new columns exist:
   ```sql
   SELECT COLUMN_NAME FROM "PUBLIC"."TABLE_COLUMNS"
   WHERE TABLE_NAME LIKE 'COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES';
   ```
   Should show `name`, `repositoryOwner_ID`, plus the standard cuid+managed+LegacyKeyed columns.
4. **Cron health check**: the next weekly Monday 09:00 UTC `contributor-notifications` run should complete without errors. New chain query returns `repoOwner: null` for all rows until PR-2 populates `TutorialMeta.repository_ID`.
5. **PR-2 unblocked**: with the new schema in place, PR-2 (migrator extension spec) can extend `migrate-from-hana.js` to populate the new columns from IMS source.

## Out of scope

- **No data migration.** PR-2 covers IMS-to-CAP data population.
- **No AuthorService changes.** PR-3 covers MyTutorials field expansion + actualTag exposure.
- **No `label` column changes.** Stays admin-editable; no source counterpart.
- **No NOT NULL constraint on `semaphoreId`.** Source enforces NOT NULL but CAP version stays nullable until PR-2 backfills.
- **No follow-up sub-issues filed in this PR.** PR-2 and PR-3 specs come next; they reference back to this PR.
- **No QA channel data migration.** Same schema shape lands in `tutorials-hana-qa` via the existing deploy path; no special QA-side work.

## Acceptance criteria

- [ ] `db/schema.cds` `TutorialRepositories` has `name` (unique) + `repositoryOwner : Association to TutorialContributors`; no `tutorial/repoUrl/branch/owner` columns remain.
- [ ] `db/schema.cds` `TutorialMeta` has `repository : Association to TutorialRepositories`.
- [ ] `db/schema.cds` `Tags` has `semaphoreId`, `isActualTag`, `isInterestItem` columns.
- [ ] `db/schema.cds` `Tutorials.repositories` Composition is REMOVED (otherwise CDS compile fails).
- [ ] `cds compile db/schema.cds` succeeds; CSN has expected element shapes.
- [ ] `cds build --production` emits the 3 migration table updates: TutorialRepositories `version=2` / `migration=2`; TutorialMeta `version=4` / `migration=4`; Tags `version=4` / `migration=4`.
- [ ] Implementer manually resolves the `>>>>>` blocks in `TutorialRepositories.hdbmigrationtable`'s `migration=2` (uncomments DROP statements after confirming row count = 0).
- [ ] `srv/lib/contributor-notifications.js` uses 2-level chain query through `meta.repository.repositoryOwner.email`.
- [ ] `scripts/cleanup-catalog-pollution.cjs` `childTablesById` array no longer includes `'TutorialRepositories'`.
- [ ] `node --check srv/lib/contributor-notifications.js` passes.
- [ ] Unit tests for the lib extended with new chain coverage (2 new tests: chain resolves email, chain returns null when repository_ID is null).
- [ ] Hybrid test for schema reachability + end-to-end chain query (asserts actual email returned, not just "parses").
- [ ] **DEV** HANA `TutorialRepositories` row count = 0 verified before manual-resolution uncomment.
- [ ] **QA** HANA `TutorialRepositories` row count = 0 verified before merge (both `tutorials-hana` and `tutorials-hana-qa` containers receive the same migration).
- [ ] DEV HANA deploy succeeds.

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| HDI DROP wipes data we didn't expect | Mandatory pre-DROP `SELECT COUNT(*)` verification; STOP if non-zero |
| QA channel has different data than DEV | Verify `tutorials-hana-qa` row count too before merge |
| `contributor-notifications.js` cron crashes mid-deploy | NULL-safe chain query; `repoOwner: null` falls through to existing level-1 owner-only path |
| Other code reads `TutorialRepositories` columns we drop | Grep-verified consumers: (a) `srv/lib/contributor-notifications.js` (updated in this PR), (b) `scripts/cleanup-catalog-pollution.cjs` (`'TutorialRepositories'` removed from `childTablesById`); `admin-service.cds` star-projection auto-propagates new shape |
| `db/undeploy.json:36` references `TutorialRepositories.hdbtable` (not `.hdbmigrationtable`) | Stale reference predates the `@cds.persistence.journal` annotation. Implementer should confirm `cds build` doesn't emit conflicting undeploy artifacts; if it does, update `undeploy.json` to reference `.hdbmigrationtable` instead. Not blocking the schema change itself. |
| PR-2 migrator can't populate the new shape | Source schema verified against Java IMS @Entity files (Tag.java + RepositoryModel.java + TutorialMeta.java); shape is faithful |
| Tutorials.repositories Composition removal breaks something | Grep shows zero consumers; the Composition only existed as a CDS declaration that auto-derived NULL anyway |

## References

- Issue: [#385](https://github.com/sap-tutorials/tutorials-ims/issues/385)
- Riley's contract comment (2026-06-19): proposes the field-expansion contract; this PR fixes the prerequisite schema gaps.
- Memory `[project_385_authorservice_field_expansion]` — Riley's contract details
- Memory `[feedback_hdi_deploys_can_wipe_data]` — destructive HDI risk; addressed via empty-table verification
- Memory `[reference_hana_raw_sql_uppercase]` — HANA quoted-identifier semantics; CAP query builder handles
- Memory `[project_prod_cutover_july_2026]` — DEV-only operations until end-July; no author-visible impact from PR-1 deploys
- Java IMS source: `D:\projects\com.sap.developers.ims\application\src\main\java\com\sap\developers\ims\model\{Tag,RepositoryModel,TutorialMeta}.java`
- Brainstorm decisions log (2026-06-21):
  - TutorialRepositories shape: faithful to IMS source
  - Tag missing columns: add 3 (semaphoreId, isActualTag, isInterestItem); keep label
  - Transition: drop-then-add (DEV empty so safe)
  - contributor-notifications.js: read repo-group owner via chain meta.repository.repositoryOwner.email

## Subsequent PRs (out of scope for PR-1)

- **PR-2**: Migrator extension. Extend `scripts/migrate-from-hana.js` to:
  - Pull `IMS_TAG` with full column set (`title_path`, `is_actual_tag`, `is_interest_item`, `semaphore_id`).
  - Add new `tutorial_repositories` entity to the migration order.
  - Populate `TutorialMeta.repository_ID` from source `IMS_TUTORIAL_METADATA.repository_id`.
  - Will need separate spec + plan + execution.

- **PR-3**: AuthorService field expansion (Riley's #385 contract):
  - Renames: `MyTutorials.ownerName → owner`, `lastNotificationDate → notificationDate`.
  - New calc fields: `repositoryName : String` (from `meta.repository.name`), `monitored : Boolean`, `daysSinceReview : Integer`.
  - `AuthorService.Tags.actualTag : Boolean` (now a passthrough of the new `isActualTag` column, not a path-parse).
  - `AuthorService.isSlugAvailable(slug) returns Boolean` action.
  - Old→new field-rename map in PR + `docs/developers/architecture/author-service.md`.
  - Will need separate spec + plan + execution.
