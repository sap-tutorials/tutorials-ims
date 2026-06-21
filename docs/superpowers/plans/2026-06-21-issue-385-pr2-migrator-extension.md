# #385 PR-2 — HANA→HANA Migrator Extension Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the HANA→HANA migrator and the TutorialMeta backfill script to populate the 5 columns/tables PR-1 (#517) added — so PR-3 has real source data underneath its calc fields.

**Architecture:** Two scripts, two surgical extensions each. Reuses every existing pattern: deterministic UUIDs (via `migration-uuid-namespaces.cjs`), the `migrateEntity` helper's delete-then-insert path for new entities, `COALESCE`-non-clobber UPDATEs for the backfill script, and pure helper extraction for vitest unit tests. No new scripts, no new infrastructure.

**Tech Stack:** Node.js (ESM for `migrate-from-hana.js`, CJS for `backfill-tutorial-meta-from-ims.cjs`), `hdb` driver, `uuid` v5, vitest, SAP HANA.

**Spec:** [`docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md`](../specs/2026-06-21-issue-385-pr2-migrator-extension-design.md)

---

## File Structure

**Files modified:**
- [scripts/lib/migration-uuid-namespaces.cjs](../../../scripts/lib/migration-uuid-namespaces.cjs) — append 2 namespace UUIDs.
- [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js) — 4 surgical extensions: extend `tags` mapRow, add `uuidMap.contributors` + `uuidMap.repositories` to the lookup-map preamble, add new `tutorialcontributors` entity block, add new `tutorialrepositories` entity block. Extract 3 named exports (`mapTagRow`, `mapTutorialContributorRow`, `mapTutorialRepositoryRow`) for vitest reach-through.
- [scripts/backfill-tutorial-meta-from-ims.cjs](../../../scripts/backfill-tutorial-meta-from-ims.cjs) — extend SELECT, prepared statement, per-row loop, summary. Extract `buildBackfillUpdateParams(row)` helper with `module.exports`.

**Files created:**

- [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js) — vitest unit tests for the 3 new migrator mapRow helpers and the 1 backfill helper. (Note: this is a new file rather than extending `test/scripts/migrate-from-hana.test.js`. The spec §"Tests" left this open; using a dedicated PR-2 file keeps the diff cleaner and groups the new test surface for the next PR's reviewers.)
- [test/hybrid/385-pr2-migrator.test.js](../../../test/hybrid/385-pr2-migrator.test.js) — hybrid test (verifies post-deploy data shape).

**Files NOT changed:** schema, CDS, srv/, any front-end. PR-2 is data-plumbing only.

---

## Task 0: Pre-Merge Source + Target Probes

**Files:** None modified — this task produces a fact set that gets pasted into the PR description and gates whether the plan continues.

- [ ] **Step 0: Verify branch is `worktree-385-pr2-migrator`**

```bash
git branch --show-current
```

Expected: `worktree-385-pr2-migrator`. If anything else (especially `main`), STOP — see memory [[feedback_branch_slip_after_long_session]] and [[feedback_verify_branch_before_commit]]; re-checkout and try again.

- [ ] **Step 1: Verify CF target points to DEV space**

Run: `cf target`
Expected: `org: <expected>`, `space: dev`. If not, run `cf login` and `cf target -o ... -s dev`.

- [ ] **Step 2: Get source IMS HANA creds**

Per CLAUDE.md "HANA Migration Credentials" memory: `cf env imsprod` (NOT imsdev) → copy the `imsdb` service binding's `url`, `user`, `password` into env vars locally:

```bash
export IMS_DB_URL='<from cf env imsprod>'
export IMS_DB_USERNAME='<...>'
export IMS_DB_PASSWORD='<...>'
```

- [ ] **Step 3: Probe source IMS column names**

Run with `hana-cli` against the source connection (preferred) OR via `hdbsql -j -A -m -n <host:port> -u <user> -p <password> -i 0 -d IMSDBUSER`:

```sql
SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS
  WHERE TABLE_NAME = 'IMS_TAG'
    AND COLUMN_NAME IN ('SEMAPHORE_ID', 'IS_ACTUAL_TAG', 'IS_INTEREST_ITEM')
  ORDER BY COLUMN_NAME;

SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS
  WHERE TABLE_NAME = 'IMS_TUTORIAL_REPOSITORY'
  ORDER BY COLUMN_NAME;

SELECT COLUMN_NAME FROM SYS.TABLE_COLUMNS
  WHERE TABLE_NAME = 'IMS_TUTORIAL_AUTHOR'
  ORDER BY COLUMN_NAME;
```

Expected:
- IMS_TAG → 3 rows (`IS_ACTUAL_TAG`, `IS_INTEREST_ITEM`, `SEMAPHORE_ID`).
- IMS_TUTORIAL_REPOSITORY → `ID`, `REPOSITORY_NAME`, `REPOSITORY_OWNER_ID` (plus any AbstractEntity audit columns).
- IMS_TUTORIAL_AUTHOR → `ID`, `NAME`, `EMAIL` (plus audit columns).

**If any column name differs from the spec, HALT and update the spec before continuing.**

- [ ] **Step 4: Probe source row counts**

```sql
SELECT COUNT(*) AS C FROM IMS_TUTORIAL_REPOSITORY;
SELECT COUNT(*) AS C FROM IMS_TUTORIAL_AUTHOR;
SELECT COUNT(*) AS NULL_OWNER_FK FROM IMS_TUTORIAL_REPOSITORY WHERE REPOSITORY_OWNER_ID IS NULL;
SELECT COUNT(*) AS WITH_REPO FROM IMS_TUTORIAL_METADATA WHERE REPOSITORY_ID IS NOT NULL;
SELECT COUNT(*) AS NULL_SEMAPHORE FROM IMS_TAG WHERE SEMAPHORE_ID IS NULL;
SELECT COUNT(*) AS NULL_INTEREST FROM IMS_TAG WHERE IS_INTEREST_ITEM IS NULL;
SELECT COUNT(*) AS TRUE_INTEREST FROM IMS_TAG WHERE IS_INTEREST_ITEM = TRUE;
SELECT COUNT(*) AS TRUE_ACTUAL FROM IMS_TAG WHERE IS_ACTUAL_TAG = TRUE;
```

Record all numbers. Surprises (e.g. `NULL_SEMAPHORE > 0` though Java says NOT NULL; `TRUE_ACTUAL = 0`) get documented in the PR description but don't necessarily halt — the migrator code is already defensive.

- [ ] **Step 5: Probe DEV target tables are empty**

Get DEV target creds:

```bash
cf target -s dev
cf service-keys tutorials-hana   # list existing keys; pick one or create with `cf create-service-key tutorials-hana <key-name>`
cf service-key tutorials-hana <actual-key-name>
# copy the JSON into CAP_HANA_CREDENTIALS
export CAP_HANA_CREDENTIALS='<JSON>'
```

Connect to DEV target and run:

```sql
SELECT COUNT(*) AS C FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS";
SELECT COUNT(*) AS C FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES";
```

Expected: both `0`. **If either is non-zero, HALT and re-evaluate** — could be admin tooling or a prior partial migration we don't know about.

- [ ] **Step 6: Save probe results**

Create `.migration-data/385-pr2-probe-results.txt` (gitignored — `.migration-data/` is already in `.gitignore`) with the raw output. This is what gets pasted into the PR description in Task 9.

```bash
# example layout — put this in the file:
# === Source probes (IMS prod) ===
# IMS_TAG.SEMAPHORE_ID present, IS_ACTUAL_TAG present, IS_INTEREST_ITEM present
# IMS_TUTORIAL_REPOSITORY columns: ID, REPOSITORY_NAME, REPOSITORY_OWNER_ID, CREATED_AT, UPDATED_AT, CREATED_BY, UPDATED_BY
# ...
# IMS_TUTORIAL_REPOSITORY row count: 14   (sample)
# IMS_TUTORIAL_AUTHOR row count: 385
# IMS_TUTORIAL_METADATA WHERE REPOSITORY_ID IS NOT NULL: 1284
# IMS_TAG SEMAPHORE_ID NULL: 0
# IMS_TAG IS_INTEREST_ITEM NULL: 7  (interesting — but defensive)
# === DEV target probes ===
# TutorialContributors row count: 0
# TutorialRepositories row count: 0
```

- [ ] **Step 7: Commit (probe results are gitignored — no commit yet, just verify clean tree)**

```bash
cd d:/projects/tutorials-poc/.claude/worktrees/385-pr2-migrator
git status --short
# expect: clean except for any pre-existing untracked files
```

---

## Task 1: Add Namespace UUIDs

**Files:**
- Modify: [scripts/lib/migration-uuid-namespaces.cjs](../../../scripts/lib/migration-uuid-namespaces.cjs)

- [ ] **Step 1: Generate two fresh UUIDs**

Run in a Node REPL or one-liner:

```bash
node -e "const {randomUUID} = require('crypto'); console.log('tutorialcontributor: ' + randomUUID()); console.log('tutorialrepository:  ' + randomUUID());"
```

Record the two UUIDs. Paste both into the PR description in Task 9 (acceptance criterion requires grep-witness).

- [ ] **Step 2: Append two entries to NAMESPACES**

In [scripts/lib/migration-uuid-namespaces.cjs](../../../scripts/lib/migration-uuid-namespaces.cjs), inside the `Object.freeze({ ... })` block, add the two new lines **at the end** (after `tutorialtag`):

```javascript
  tutorialtag:          '2247f0d9-48f1-400d-ac73-8ce074633fe3',
  tutorialcontributor:  '<UUID from Step 1>',  // added 2026-06-21 for #385 PR-2
  tutorialrepository:   '<UUID from Step 1>',  // added 2026-06-21 for #385 PR-2
});
```

**Do NOT edit any existing entries.** The file's docstring says "**THESE VALUES ARE PERMANENT.** … never edit existing entries."

- [ ] **Step 3: Verify file still parses**

Run:

```bash
node -e "console.log(Object.keys(require('./scripts/lib/migration-uuid-namespaces.cjs').NAMESPACES).length)"
```

Expected output: `17` (was 15, now 15 + 2 = 17).

- [ ] **Step 4: Commit**

```bash
git add scripts/lib/migration-uuid-namespaces.cjs
git commit -m "feat(migration): #385 PR-2 — add tutorialcontributor + tutorialrepository UUID namespaces"
```

---

## Task 2: Extract `mapTagRow` and Write Failing Test

**Files:**
- Modify: [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js) — extract pure helper.
- Create: [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js)

- [ ] **Step 1: Write the failing test FIRST**

Create [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js) with:

```javascript
/**
 * Unit tests for #385 PR-2 — the three new mapRow helpers + one backfill helper.
 * Pattern mirrors test/scripts/migrate-from-hana.test.js (pure-function tests
 * against named exports).
 *
 * Spec: docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md
 */
import { describe, it, expect } from 'vitest';
import {
  mapTagRow,
  mapTutorialContributorRow,
  mapTutorialRepositoryRow,
} from '../../scripts/migrate-from-hana.js';
import { v5 as uuidv5 } from 'uuid';
const { NAMESPACES } = await import('../../scripts/lib/migration-uuid-namespaces.cjs');

describe('mapTagRow() — 3 new columns (#385 PR-2)', () => {
  // The legacy ID space matches what tagMap.get() / uuidMap.tags.get() yield.
  const tagUuid = uuidv5('42', NAMESPACES.tag);

  it('emits all 3 new columns when source row carries them', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'sap-s-4hana', SEMAPHORE_ID: 'sem-xyz', IS_ACTUAL_TAG: 1, IS_INTEREST_ITEM: 1 },
      tagUuid,
    );
    expect(out).toMatchObject({
      ID: tagUuid,
      LEGACYID: 42,
      NAME: 'sap-s-4hana',
      SEMAPHOREID: 'sem-xyz',
      ISACTUALTAG: true,
      ISINTERESTITEM: true,
    });
  });

  it('handles boolean returned as JS true (not just 1)', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: 's', IS_ACTUAL_TAG: true, IS_INTEREST_ITEM: true },
      tagUuid,
    );
    expect(out.ISACTUALTAG).toBe(true);
    expect(out.ISINTERESTITEM).toBe(true);
  });

  it('maps NULL/undefined IS_INTEREST_ITEM to false (Boolean boxed in Java source)', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: 's', IS_ACTUAL_TAG: 0, IS_INTEREST_ITEM: null },
      tagUuid,
    );
    expect(out.ISACTUALTAG).toBe(false);
    expect(out.ISINTERESTITEM).toBe(false);
  });

  it('passes null SEMAPHORE_ID through unchanged (CAP-side column is nullable)', () => {
    const out = mapTagRow(
      { ID: 42, NAME: 'x', SEMAPHORE_ID: null, IS_ACTUAL_TAG: 1, IS_INTEREST_ITEM: 1 },
      tagUuid,
    );
    expect(out.SEMAPHOREID).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: FAIL with `mapTagRow is not exported` (or similar import-error). This confirms the test reaches the migrator file and the symbol doesn't exist yet.

- [ ] **Step 3: Extract `mapTagRow` as a named export**

In [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js), add this function near the other pure helpers (around line 309 after `partitionBySlug`):

```javascript
// #385 PR-2: extracted for vitest reach-through. Source schema verified against
// Tag.java 2026-06-21 — semaphore_id is NOT NULL in source but CAP stays
// nullable; is_actual_tag is primitive bool (never null); is_interest_item is
// Boolean boxed (nullable). HANA's hdb driver returns booleans as 1/0
// integers — accept both 1 and true explicitly.
export function mapTagRow(row, tagUuid) {
  return {
    ID: tagUuid,
    LEGACYID: row.ID,
    NAME: truncStr(row.NAME, 255),
    SEMAPHOREID: truncStr(row.SEMAPHORE_ID, 255),
    ISACTUALTAG:    row.IS_ACTUAL_TAG === 1 || row.IS_ACTUAL_TAG === true,
    ISINTERESTITEM: row.IS_INTEREST_ITEM === 1 || row.IS_INTEREST_ITEM === true,
  };
}
```

- [ ] **Step 4: Re-run test to verify it passes**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: PASS (4 tests).

- [ ] **Step 5: Replace the inline `tags` mapRow in main() with the helper**

Find the `tags` migration block (~line 805). Update **both** the `sourceQuery` and the `mapRow`:

```javascript
// 1. Tags — extended for #385 PR-2 (3 new source columns).
results.push(await migrateEntity(source, target, T, {
  name: 'tags',
  sourceQuery: `SELECT "ID", "NAME", "SEMAPHORE_ID", "IS_ACTUAL_TAG", "IS_INTEREST_ITEM" FROM ${S}."IMS_TAG"`,
  targetTable: 'COM_SAP_DEVELOPERS_IMS_TAGS',
  mapRow: (row) => mapTagRow(row, uuidMap.tags.get(row.ID)),
}));
```

- [ ] **Step 6: Verify migrator still parses + tests still pass**

```bash
node --check scripts/migrate-from-hana.js
npx vitest run test/scripts/migrate-from-hana.test.js test/scripts/385-pr2-migrator.test.js
```

Expected: both pass (existing migrator tests for `partitionBySlug` etc. + new `mapTagRow` tests).

- [ ] **Step 7: Commit**

```bash
git add scripts/migrate-from-hana.js test/scripts/385-pr2-migrator.test.js
git commit -m "feat(migration): #385 PR-2 — extend tags mapRow with semaphoreId / isActualTag / isInterestItem"
```

---

## Task 3: Extract `mapTutorialContributorRow` and Test

**Files:**
- Modify: [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js)
- Modify: [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js)

- [ ] **Step 1: Add failing test**

Append to [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js):

```javascript
describe('mapTutorialContributorRow() (#385 PR-2)', () => {
  it('derives deterministic UUID from legacyId via tutorialcontributor namespace', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.ID).toBe(uuidv5('7', NAMESPACES.tutorialcontributor));
  });

  it('same legacyId always yields the same UUID (idempotent re-runs)', () => {
    const a = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    const b = mapTutorialContributorRow({ ID: 7, NAME: 'Renamed', EMAIL: 'alice@sap.com' });
    expect(a.ID).toBe(b.ID);
  });

  it('emits TUTORIAL_ID: null (source is flat global table; no per-tutorial FK)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.TUTORIAL_ID).toBeNull();
  });

  it('emits ROLE: null (CAP-side concept; no source counterpart)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.ROLE).toBeNull();
  });

  it('passes name and email through (truncated to 255 chars)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: 'alice@sap.com' });
    expect(out.NAME).toBe('Alice');
    expect(out.EMAIL).toBe('alice@sap.com');
  });

  it('handles null email (source has ~136/385 authors with null EMAIL)', () => {
    const out = mapTutorialContributorRow({ ID: 7, NAME: 'Alice', EMAIL: null });
    expect(out.EMAIL).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: 4 PASS (from Task 2) + 6 FAIL (the new contributor tests) due to missing export.

- [ ] **Step 3: Add the helper to migrate-from-hana.js**

After the `mapTagRow` definition added in Task 2:

```javascript
// #385 PR-2: extracted for vitest reach-through. IMS_TUTORIAL_AUTHOR is a
// flat global table — no per-tutorial FK on the Java entity. Migrated rows
// land with TUTORIAL_ID = NULL; CAP-side TutorialContributors.tutorial is
// nullable, so flat-global rows co-exist with future per-tutorial records.
export function mapTutorialContributorRow(row) {
  return {
    ID: deriveUuid('tutorialcontributor', row.ID),
    LEGACYID: row.ID,
    TUTORIAL_ID: null,
    NAME:  truncStr(row.NAME, 255),
    EMAIL: truncStr(row.EMAIL, 255),
    ROLE:  null,
  };
}
```

- [ ] **Step 4: Re-run test to verify it passes**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: all 10 PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-from-hana.js test/scripts/385-pr2-migrator.test.js
git commit -m "feat(migration): #385 PR-2 — add mapTutorialContributorRow helper + tests"
```

---

## Task 4: Extract `mapTutorialRepositoryRow` and Test

**Files:**
- Modify: [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js)
- Modify: [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js)

- [ ] **Step 1: Add failing test**

Append to [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js):

```javascript
describe('mapTutorialRepositoryRow() (#385 PR-2)', () => {
  // The contributorMap is what main() builds from `SELECT "ID" FROM IMS_TUTORIAL_AUTHOR`.
  // Test fixtures inject a controlled map so we don't depend on real source data.
  const contributorMap = new Map([
    [10, uuidv5('10', NAMESPACES.tutorialcontributor)],
    [11, uuidv5('11', NAMESPACES.tutorialcontributor)],
  ]);

  it('derives deterministic UUID from legacyId via tutorialrepository namespace', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 10 },
      contributorMap,
    );
    expect(out.ID).toBe(uuidv5('5', NAMESPACES.tutorialrepository));
  });

  it('resolves REPOSITORYOWNER_ID via the contributor map', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 10 },
      contributorMap,
    );
    expect(out.REPOSITORYOWNER_ID).toBe(uuidv5('10', NAMESPACES.tutorialcontributor));
  });

  it('emits REPOSITORYOWNER_ID: null when source REPOSITORY_OWNER_ID is null', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: null },
      contributorMap,
    );
    expect(out.REPOSITORYOWNER_ID).toBeNull();
  });

  it('emits REPOSITORYOWNER_ID: null when REPOSITORY_OWNER_ID is set but not in contributor map (orphan FK)', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 999 }, // 999 not in map
      contributorMap,
    );
    expect(out.REPOSITORYOWNER_ID).toBeNull();
  });

  it('passes name through (truncated to 255 chars)', () => {
    const out = mapTutorialRepositoryRow(
      { ID: 5, REPOSITORY_NAME: 'btp-foundation', REPOSITORY_OWNER_ID: 10 },
      contributorMap,
    );
    expect(out.NAME).toBe('btp-foundation');
    expect(out.LEGACYID).toBe(5);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: 10 PASS + 5 FAIL.

- [ ] **Step 3: Add the helper to migrate-from-hana.js**

After the `mapTutorialContributorRow` definition:

```javascript
// #385 PR-2: extracted for vitest reach-through. Source IMS_TUTORIAL_REPOSITORY
// = (id, repository_name UNIQUE, repository_owner_id → IMS_TUTORIAL_AUTHOR.id).
// PR-1 reshape made TutorialRepositories.repositoryOwner an Association to
// TutorialContributors — `contributorMap` resolves the FK at map time so we
// don't need a runtime JOIN. Orphan FKs (source row points at a missing
// contributor) become NULL — matches the spec's chain-query NULL-safe path.
export function mapTutorialRepositoryRow(row, contributorMap) {
  return {
    ID: deriveUuid('tutorialrepository', row.ID),
    LEGACYID: row.ID,
    NAME: truncStr(row.REPOSITORY_NAME, 255),
    REPOSITORYOWNER_ID: row.REPOSITORY_OWNER_ID
      ? (contributorMap.get(row.REPOSITORY_OWNER_ID) || null)
      : null,
  };
}
```

- [ ] **Step 4: Re-run test to verify it passes**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: all 15 PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/migrate-from-hana.js test/scripts/385-pr2-migrator.test.js
git commit -m "feat(migration): #385 PR-2 — add mapTutorialRepositoryRow helper + tests"
```

---

## Task 5: Wire New Helpers into main() — uuidMap + Entity Blocks

**Files:**
- Modify: [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js)

- [ ] **Step 1: Add `contributors` + `repositories` keys to uuidMap declaration**

Find the `uuidMap` declaration (~line 715). Add two entries:

```javascript
const uuidMap = {
  tutorials: new Map(),
  missions: new Map(),
  groups: new Map(),
  steps: new Map(),
  users: new Map(),
  events: new Map(),
  tags: new Map(),
  completionPaths: new Map(),
  prizes: new Map(),
  accomplishments: new Map(),
  contributors: new Map(),       // NEW (#385 PR-2)
  repositories: new Map(),       // NEW (#385 PR-2)
};
```

- [ ] **Step 2: Populate the two maps in the lookup-map preamble**

Find the `try { … prizes … } catch (e) { /* optional table */ }` block (~line 769) and **after** it, add two new try/catch-optional blocks matching the pattern:

```javascript
// #385 PR-2: build contributor + repository uuidMaps. Both source tables are
// optional from the migrator's POV — if missing (e.g. older IMS instance),
// migration of dependent entities just skips silently.
try {
  const contributors = await query(source, `SELECT "ID" FROM ${S}."IMS_TUTORIAL_AUTHOR"`);
  contributors.forEach(c => uuidMap.contributors.set(c.ID, deriveUuid('tutorialcontributor', c.ID)));
  console.log(`  TutorialContributors: ${uuidMap.contributors.size}`);
} catch (e) { /* optional table */ }

try {
  const repositories = await query(source, `SELECT "ID" FROM ${S}."IMS_TUTORIAL_REPOSITORY"`);
  repositories.forEach(r => uuidMap.repositories.set(r.ID, deriveUuid('tutorialrepository', r.ID)));
  console.log(`  TutorialRepositories: ${uuidMap.repositories.size}`);
} catch (e) { /* optional table */ }
```

- [ ] **Step 3: Insert the `tutorialcontributors` entity block**

Find the `auditNullSapidUsers` call (~line 998-1005 — the block that ends with `await auditNullSapidUsers(...)`). **After** that block (before the `// 7b. UserMetaData — INTENTIONALLY NOT MIGRATED.` comment ~line 1007), insert:

```javascript
  // 7c. TutorialContributors — global flat author table (#385 PR-2).
  // Source IMS_TUTORIAL_AUTHOR has no tutorial_id FK; rows are the global pool
  // of named authors. CAP TutorialContributors.tutorial is nullable so migrated
  // rows land with tutorial_ID = NULL. PR-1 reshape made
  // TutorialRepositories.repositoryOwner an Association to this entity, so
  // these rows MUST exist before tutorialrepositories migrates.
  if (uuidMap.contributors.size > 0) {
    results.push(await migrateEntity(source, target, T, {
      name: 'tutorialcontributors',
      sourceQuery: `SELECT "ID", "NAME", "EMAIL" FROM ${S}."IMS_TUTORIAL_AUTHOR"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS',
      mapRow: (row) => mapTutorialContributorRow(row),
    }));
  }

  // 7d. TutorialRepositories — repo-group reference table (#385 PR-2).
  // PR-1 reshape; source IMS_TUTORIAL_REPOSITORY =
  // (id, repository_name UNIQUE, repository_owner_id).
  // repositoryOwner_ID resolves through uuidMap.contributors built above.
  if (uuidMap.repositories.size > 0) {
    results.push(await migrateEntity(source, target, T, {
      name: 'tutorialrepositories',
      sourceQuery: `SELECT "ID", "REPOSITORY_NAME", "REPOSITORY_OWNER_ID" FROM ${S}."IMS_TUTORIAL_REPOSITORY"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES',
      mapRow: (row) => mapTutorialRepositoryRow(row, uuidMap.contributors),
    }));
  }
```

- [ ] **Step 4: Verify migrator parses + all tests pass**

```bash
node --check scripts/migrate-from-hana.js
npx vitest run test/scripts/migrate-from-hana.test.js test/scripts/385-pr2-migrator.test.js
```

Expected: all pass.

- [ ] **Step 5: Optional dry-run smoke test (recommended if creds are still in env from Task 0)**

Run with `--dry-run --entity=tags,tutorialcontributors,tutorialrepositories` to verify the new entity blocks reach the right code paths without writing:

```bash
node scripts/migrate-from-hana.js --dry-run --entity=tags,tutorialcontributors,tutorialrepositories
```

Expected output should include:
```
  Read N records from source
  [dry-run] Would insert: ...
```

…for each of the 3 entities, where N matches the source row counts from Task 0 Step 4.

- [ ] **Step 6: Commit**

```bash
git add scripts/migrate-from-hana.js
git commit -m "feat(migration): #385 PR-2 — wire tutorialcontributors + tutorialrepositories into main()"
```

---

## Task 6: Backfill Script — Extract Helper and Test

**Files:**
- Modify: [scripts/backfill-tutorial-meta-from-ims.cjs](../../../scripts/backfill-tutorial-meta-from-ims.cjs)
- Modify: [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js)

- [ ] **Step 1: Add failing tests for the backfill helper**

Append to [test/scripts/385-pr2-migrator.test.js](../../../test/scripts/385-pr2-migrator.test.js):

```javascript
import backfillModule from '../../scripts/backfill-tutorial-meta-from-ims.cjs';
const { buildBackfillUpdateParams } = backfillModule;

describe('buildBackfillUpdateParams() — backfill row→params (#385 PR-2)', () => {
  it('derives repoUuid via tutorialrepository namespace when REPO_LEGACY_ID is set', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: 'alice@sap.com',
      IS_REVIEWED: 1,
      UPDATED_AT: '2026-06-01T00:00:00Z',
      NOTIF_NUM: 2,
      NOTIF_DATE: '2026-05-01T00:00:00Z',
      REPO_LEGACY_ID: 42,
    });
    // Expected param order: [owner, reviewedDate, notifNum, notifDate, repoUuid, targetTutorialUuid]
    expect(out.params[4]).toBe(uuidv5('42', NAMESPACES.tutorialrepository));
    expect(out.params[5]).toBe(uuidv5('100', NAMESPACES.tutorial));
    expect(out.skip).toBe(false);
    expect(out.placeholderEmail).toBe(false);
  });

  it('emits null repoUuid when REPO_LEGACY_ID is null', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: 'alice@sap.com',
      IS_REVIEWED: 0,
      UPDATED_AT: '2026-06-01T00:00:00Z',
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: null,
    });
    expect(out.params[4]).toBeNull();
  });

  it('does NOT skip a row that has only REPO_LEGACY_ID populated', () => {
    // Defends against the regression where adding the new column to the
    // SELECT but forgetting to extend the early-skip predicate would drop
    // every row that only carries a repository reference.
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: null,  // null/placeholder
      IS_REVIEWED: 0,
      UPDATED_AT: '2026-06-01T00:00:00Z',
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: 42,
    });
    expect(out.skip).toBe(false);
    expect(out.params[4]).toBe(uuidv5('42', NAMESPACES.tutorialrepository));
  });

  it('still skips a row with NO useful data at all', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: null,
      IS_REVIEWED: 0,
      UPDATED_AT: null,
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: null,
    });
    expect(out.skip).toBe(true);
  });

  it('flags placeholder emails and emits null for ownerEmail', () => {
    const out = buildBackfillUpdateParams({
      TUT_LEGACY_ID: 100,
      OWNER_EMAIL: '12345+bob@users.noreply.github.com',
      IS_REVIEWED: 0,
      UPDATED_AT: null,
      NOTIF_NUM: 0,
      NOTIF_DATE: null,
      REPO_LEGACY_ID: 42,
    });
    expect(out.placeholderEmail).toBe(true);
    expect(out.params[0]).toBeNull();
    expect(out.skip).toBe(false);  // REPO_LEGACY_ID keeps it alive
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: 15 PASS + 5 FAIL (`buildBackfillUpdateParams is not a function`).

- [ ] **Step 3: Refactor the backfill script — extract helper + extend UPDATE**

In [scripts/backfill-tutorial-meta-from-ims.cjs](../../../scripts/backfill-tutorial-meta-from-ims.cjs), do four edits:

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

**Edit B — extract the helper AND gate the IIFE so `require()` doesn't auto-run it** (before the IIFE at line 110).

⚠️ **CRITICAL — guard the IIFE.** The current file has `(async function main() { … })().catch(…)` at lines 110–227 — a bare IIFE that fires on `require()`. The new unit test imports this module; without a guard, `main()` would execute at import time, throw on missing creds, and break the test. Wrap it.

**Edit B.1 — delete the inline `tutorialUuid` at lines 106-108** (it will be replaced by the version inside the new helper block; otherwise there's a duplicate that survives the next code-review pass):

```bash
# Verify before delete:
grep -n 'function tutorialUuid' scripts/backfill-tutorial-meta-from-ims.cjs
# Expect: one match at line 106. After Edit B completes, expect one match (the new location).
```

**Edit B.2 — add the helper block immediately before the IIFE** (insert at line 110, pushing the IIFE down):

```javascript
function tutorialUuid(legacyId) {
  return uuidv5(String(legacyId), NAMESPACES.tutorial);
}

// #385 PR-2: extracted for vitest reach-through. Pure function — produces the
// params array + decision flags for the UPDATE statement from a single source
// row. `skip: true` short-circuits the loop's early-out path. `placeholderEmail`
// is surfaced to the caller for the existing skippedPlaceholders counter.
function buildBackfillUpdateParams(row) {
  const isPlaceholderEmail =
    row.OWNER_EMAIL && /(@users\.noreply\.github\.com|@sap-tutorials\.local)$/i.test(row.OWNER_EMAIL);
  const ownerEmail = (row.OWNER_EMAIL && !isPlaceholderEmail) ? row.OWNER_EMAIL : null;
  const reviewedDate = (row.IS_REVIEWED === 1 && row.UPDATED_AT) ? row.UPDATED_AT : null;
  const notifNum  = (row.NOTIF_NUM != null && row.NOTIF_NUM !== 0) ? row.NOTIF_NUM : null;
  const notifDate = row.NOTIF_DATE || null;
  const repoUuid  = row.REPO_LEGACY_ID
    ? uuidv5(String(row.REPO_LEGACY_ID), NAMESPACES.tutorialrepository)
    : null;
  const targetTutorialUuid = tutorialUuid(row.TUT_LEGACY_ID);

  const skip = !ownerEmail && !reviewedDate && notifNum == null && notifDate == null && !repoUuid;

  return {
    skip,
    placeholderEmail: !!isPlaceholderEmail,
    params: [ownerEmail, reviewedDate, notifNum, notifDate, repoUuid, targetTutorialUuid],
  };
}

module.exports = { buildBackfillUpdateParams };
```

**Edit B.3 — gate the IIFE so it only runs as a script, not on require()**

Replace the line-110 `(async function main() {` opener with a named declaration, and gate the call:

```javascript
async function main() {
  const sourceCreds = resolveSourceCreds();
  const targetCreds = resolveTargetCreds();
  // … existing body unchanged, but the trailing `})().catch(...)` line below
  // changes too — see Edit B.4.
```

**Edit B.4 — replace the trailing IIFE-invocation lines** at the bottom (currently `})().catch((e) => { ... })`):

```javascript
}  // end of async function main()

if (require.main === module) {
  main().catch((e) => {
    console.error('FATAL:', e.message);
    process.exit(2);
  });
}
```

This matches the same `require.main === module` pattern other CJS scripts in `scripts/` use to remain importable from tests. After Edit B.4, `require('scripts/backfill-tutorial-meta-from-ims.cjs')` returns `{ buildBackfillUpdateParams }` without executing `main()`.

**Edit C — update the prepared UPDATE to include REPOSITORY_ID (~line 147):**

```javascript
stmt = await prepareStmt(target,
  `UPDATE COM_SAP_DEVELOPERS_IMS_TUTORIALMETA
      SET OWNER                = COALESCE(?, OWNER),
          REVIEWEDDATE         = COALESCE(?, REVIEWEDDATE),
          NOTIFICATIONNUMBER   = COALESCE(?, NOTIFICATIONNUMBER),
          LASTNOTIFICATIONDATE = COALESCE(?, LASTNOTIFICATIONDATE),
          REPOSITORY_ID        = COALESCE(?, REPOSITORY_ID),
          MODIFIEDAT           = CURRENT_TIMESTAMP,
          MODIFIEDBY           = 'backfill-script'
    WHERE TUTORIAL_ID = ?`);
```

**Edit D — replace the per-row loop body** (~line 158-206) to use the new helper. The current loop has all the inline logic; replace from `for (const row of sourceRows) {` down to (but NOT including) `if (stmt) stmt.drop();`:

```javascript
let updatedRepo = 0;

for (const row of sourceRows) {
  const decision = buildBackfillUpdateParams(row);
  if (decision.placeholderEmail) skippedPlaceholders++;

  if (decision.skip) {
    missing++;
    continue;
  }

  const [ownerEmail, reviewedDate, notifNum, notifDate, repoUuid, targetTutorialUuid] = decision.params;

  if (DRY_RUN) {
    if (VERBOSE) {
      console.log(`  [dry-run] tut=${row.TUT_LEGACY_ID} owner=${ownerEmail||'-'} reviewed=${reviewedDate?'Y':'N'} repo=${repoUuid?'Y':'-'}`);
    }
    if (ownerEmail) updatedOwner++;
    if (reviewedDate) updatedReviewed++;
    if (notifNum != null || notifDate) updatedNotif++;
    if (repoUuid) updatedRepo++;
    continue;
  }

  try {
    const affected = await runStmt(stmt, decision.params);
    if (affected > 0) {
      if (ownerEmail) updatedOwner++;
      if (reviewedDate) updatedReviewed++;
      if (notifNum != null || notifDate) updatedNotif++;
      if (repoUuid) updatedRepo++;
    } else {
      missing++;
    }
  } catch (e) {
    errCount++;
    if (errCount <= 5) console.error(`  ✗ ${row.TUT_LEGACY_ID}: ${e.message.split('\n')[0]}`);
  }
}
```

**Edit E — extend the summary** (~line 210-219) to report `updatedRepo`:

Before `console.log(\`  Errors:`...\`);`, add:

```javascript
  console.log(`  ${DRY_RUN ? 'Would update' : 'Updated'} repository FK:      ${updatedRepo}`);
```

- [ ] **Step 4: Re-run test to verify it passes**

```bash
npx vitest run test/scripts/385-pr2-migrator.test.js
```

Expected: all 20 PASS.

- [ ] **Step 5: Verify script still parses + cross-check the syntax**

```bash
node --check scripts/backfill-tutorial-meta-from-ims.cjs
```

Expected: no output (success).

Verify the test import does NOT trigger `main()` to run (this is what the Edit B.4 guard exists to prevent):

```bash
node -e "const m = require('./scripts/backfill-tutorial-meta-from-ims.cjs'); console.log(Object.keys(m));"
```

Expected output: `[ 'buildBackfillUpdateParams' ]`. **Must NOT** print "Connecting to source…" or throw "No source credentials…". If it does, Edit B.4's `require.main === module` guard wasn't applied correctly — fix before continuing.

Run a `--dry-run` smoke against the live source/target if creds are still in the env from Task 0:

```bash
node scripts/backfill-tutorial-meta-from-ims.cjs --dry-run --verbose 2>&1 | tail -20
```

Expected output includes:
```
  Would update repository FK:      N
```

…where `N` is the number of source rows whose REPOSITORY_ID is non-NULL (from the Task 0 probe, "WITH_REPO").

- [ ] **Step 6: Commit**

```bash
git add scripts/backfill-tutorial-meta-from-ims.cjs test/scripts/385-pr2-migrator.test.js
git commit -m "feat(migration): #385 PR-2 — backfill TutorialMeta.repository_ID + extract buildBackfillUpdateParams"
```

---

## Task 7: Hybrid Test (Cannot Run Until Post-Deploy)

**Files:**
- Create: [test/hybrid/385-pr2-migrator.test.js](../../../test/hybrid/385-pr2-migrator.test.js)

- [ ] **Step 1: Look at an existing hybrid test for the template**

```bash
head -30 test/hybrid/385-schema-redesign.test.js
```

The PR-1 spec dropped a hybrid test file at `test/hybrid/385-schema-redesign.test.js`. Match its shape (env-guard, `cds.test('serve')` boot, `ALLOW_HYBRID_WRITES` not needed for read-only assertions).

- [ ] **Step 2: Create the new hybrid test**

Write [test/hybrid/385-pr2-migrator.test.js](../../../test/hybrid/385-pr2-migrator.test.js):

```javascript
/**
 * #385 PR-2 hybrid test — verifies post-deploy data shape after the next
 * migration pass populates TutorialContributors + TutorialRepositories +
 * Tags.semaphoreId + TutorialMeta.repository_ID from IMS source.
 *
 * Read-only — no fixture writes, no cleanup. Spec:
 * docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md
 *
 * Run with: cf login + cds bind --exec -- npx vitest run test/hybrid/385-pr2-migrator.test.js
 * Cannot pass until migrator + backfill have executed against DEV.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('#385 PR-2 — post-migration data shape', () => {
  let db, TutorialContributors, TutorialRepositories, TutorialMeta, Tags;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const ns = cds.entities('com.sap.developers.ims');
    TutorialContributors = ns.TutorialContributors;
    TutorialRepositories = ns.TutorialRepositories;
    TutorialMeta         = ns.TutorialMeta;
    Tags                 = ns.Tags;
  });

  it('TutorialContributors has at least 1 row with a non-empty email', async () => {
    const row = await SELECT.one.from(TutorialContributors).where(`email is not null and email <> ''`);
    expect(row).toBeTruthy();
    expect(row.email).toMatch(/@/);
  });

  it('TutorialRepositories has at least 1 row with a non-empty name', async () => {
    const row = await SELECT.one.from(TutorialRepositories).where(`name is not null and name <> ''`);
    expect(row).toBeTruthy();
    expect(typeof row.name).toBe('string');
    expect(row.name.length).toBeGreaterThan(0);
  });

  it('At least 1 TutorialMeta row has a non-null repository_ID FK', async () => {
    const row = await SELECT.one.from(TutorialMeta).where(`repository_ID is not null`);
    expect(row).toBeTruthy();
  });

  it('End-to-end chain query (PR-1 pattern) returns a non-null email', async () => {
    const row = await SELECT.one.from(TutorialMeta)
      .columns('repository.repositoryOwner.email as email')
      .where('repository_ID IS NOT NULL');
    expect(row).toBeTruthy();
    // PR-1 documented that some repository_owner_id FKs may be null in source —
    // assert that at least one chain through the table resolves to a real email.
  });

  it('At least 1 Tags row has a non-null semaphoreId', async () => {
    const row = await SELECT.one.from(Tags).where(`semaphoreId is not null`);
    expect(row).toBeTruthy();
    expect(typeof row.semaphoreId).toBe('string');
  });
});
```

- [ ] **Step 3: Verify the test parses but is expected to fail pre-deploy**

```bash
node --check test/hybrid/385-pr2-migrator.test.js
```

Expected: no output (success).

**Do NOT run the test** — it requires DEV to have the migrated data and would fail until post-deploy. Document this in the PR description.

- [ ] **Step 4: Commit**

```bash
git add test/hybrid/385-pr2-migrator.test.js
git commit -m "test(hybrid): #385 PR-2 — post-migration data-shape verification (runs after next migration pass)"
```

---

## Task 8: Final Sanity Pass

**Files:** None modified — verification only.

- [ ] **Step 1: Re-run all in-scope tests**

```bash
npx vitest run test/scripts/migrate-from-hana.test.js test/scripts/385-pr2-migrator.test.js
```

Expected: all green (existing migrator tests + 20 new tests).

- [ ] **Step 2: Run `cds compile` sanity check**

```bash
npx cds compile db/schema.cds 2>&1 | tail -5
```

Expected: no errors (PR-2 doesn't change the schema, but this confirms PR-1's schema still compiles).

- [ ] **Step 3: Verify no schema or service code was touched**

```bash
git log --stat main..HEAD -- db/ srv/ app/ hugo/ hugo-apps/ 2>&1 | head -20
```

Expected: empty output. PR-2 is data-plumbing only.

- [ ] **Step 4: Verify only the 7 expected files changed**

```bash
git diff --stat main..HEAD
```

Expected files only:
- `docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md` (from earlier brainstorming commit)
- `docs/superpowers/plans/2026-06-21-issue-385-pr2-migrator-extension.md` (this plan)
- `scripts/lib/migration-uuid-namespaces.cjs`
- `scripts/migrate-from-hana.js`
- `scripts/backfill-tutorial-meta-from-ims.cjs`
- `test/scripts/385-pr2-migrator.test.js`
- `test/hybrid/385-pr2-migrator.test.js`

If anything else is listed, investigate (likely a Windows CRLF flip — see memory [[feedback_crlf_regression_on_windows]]). Run `file <path>` on the suspect file; if CRLF, `dos2unix` it and re-commit.

- [ ] **Step 5: Commit the plan itself (if not yet committed)**

```bash
git add docs/superpowers/plans/2026-06-21-issue-385-pr2-migrator-extension.md
git commit -m "docs(plan): #385 PR-2/3 migrator extension implementation plan"
```

---

## Task 9: Open the PR

**Files:** None modified — PR creation step.

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-385-pr2-migrator
```

- [ ] **Step 2: Draft the PR body** (use the template below verbatim; fill in placeholders)

````markdown
Second of 3 sequential PRs that close #385. Depends on PR #517 (merged 2026-06-21).

## Why

PR-1 (#517) reshaped the CAP schema for `TutorialRepositories`, `TutorialMeta.repository`, and 3 new `Tags` columns. Those columns hold NULL in DEV today because no migrator populates them. PR-2 wires the data plumbing so PR-3's AuthorService field expansion has real values to project.

## What's in this PR

**Migration (scripts/migrate-from-hana.js):**
- `tags` entity: 3 new columns (`SEMAPHOREID`, `ISACTUALTAG`, `ISINTERESTITEM`) from `IMS_TAG.semaphore_id / is_actual_tag / is_interest_item`.
- New entity `tutorialcontributors`: full migration of `IMS_TUTORIAL_AUTHOR` (~385 rows, flat global author table). Migrated rows have `tutorial_ID = NULL`.
- New entity `tutorialrepositories`: full migration of `IMS_TUTORIAL_REPOSITORY` with `REPOSITORYOWNER_ID` resolved via the contributor uuidMap.
- Extracted 3 named exports (`mapTagRow`, `mapTutorialContributorRow`, `mapTutorialRepositoryRow`) for vitest unit-test reach-through.

**Backfill (scripts/backfill-tutorial-meta-from-ims.cjs):**
- SELECT extended with `TM.REPOSITORY_ID AS REPO_LEGACY_ID`.
- UPDATE adds `REPOSITORY_ID = COALESCE(?, REPOSITORY_ID)` — same non-clobber semantics as OWNER/REVIEWEDDATE.
- New `updatedRepo` counter in summary.
- Extracted `buildBackfillUpdateParams(row)` helper for unit tests.

**Namespaces (scripts/lib/migration-uuid-namespaces.cjs):**
- Added `tutorialcontributor` and `tutorialrepository` UUIDs. Both freshly generated via `crypto.randomUUID()`. **Permanent — never edit:**
  - `tutorialcontributor`: `<paste UUID-1 here>`
  - `tutorialrepository`:  `<paste UUID-2 here>`

**Tests:**
- `test/scripts/385-pr2-migrator.test.js` — 20 unit tests (4 mapTagRow + 6 mapTutorialContributorRow + 5 mapTutorialRepositoryRow + 5 buildBackfillUpdateParams).
- `test/hybrid/385-pr2-migrator.test.js` — 5 hybrid tests, run after the next migration pass on DEV.

## Pre-merge source + target probe results

(Paste raw output of `.migration-data/385-pr2-probe-results.txt` from Task 0.)

```
=== Source probes (IMS prod) ===
IMS_TAG.SEMAPHORE_ID present: yes
IMS_TAG.IS_ACTUAL_TAG present: yes
IMS_TAG.IS_INTEREST_ITEM present: yes
IMS_TUTORIAL_REPOSITORY columns: ID, REPOSITORY_NAME, REPOSITORY_OWNER_ID, ...
IMS_TUTORIAL_AUTHOR columns: ID, NAME, EMAIL, ...

IMS_TUTORIAL_REPOSITORY row count: <N>
IMS_TUTORIAL_AUTHOR row count: <N>
IMS_TUTORIAL_REPOSITORY WHERE REPOSITORY_OWNER_ID IS NULL: <N>
IMS_TUTORIAL_METADATA WHERE REPOSITORY_ID IS NOT NULL: <N>
IMS_TAG WHERE SEMAPHORE_ID IS NULL: <N>
IMS_TAG WHERE IS_INTEREST_ITEM IS NULL: <N>
IMS_TAG WHERE IS_INTEREST_ITEM = TRUE: <N>
IMS_TAG WHERE IS_ACTUAL_TAG = TRUE: <N>

=== DEV target probes ===
TutorialContributors row count: 0
TutorialRepositories row count: 0
```

## Rollout

1. Merge PR-2.
2. Run the cutover-rehearsal sequence on DEV (existing runbook in `docs/developers/operations/migration-from-ims.md`).
3. Verify post-deploy with `npx cds bind --exec -- npx vitest run test/hybrid/385-pr2-migrator.test.js` — all 5 should pass.
4. PR-3 (AuthorService field expansion) unblocked.

## Backout

- Revert the PR. The migrator's delete-then-insert path will leave the new entities empty on the next run; `tags` rows lose the 3 new columns.
- **Do NOT** remove the 2 new namespace UUIDs from `migration-uuid-namespaces.cjs` on revert — any rows already written depend on them.

## Spec + plan trail

- Spec: `docs/superpowers/specs/2026-06-21-issue-385-pr2-migrator-extension-design.md`
- Plan: `docs/superpowers/plans/2026-06-21-issue-385-pr2-migrator-extension.md`
- Predecessor: PR #517 (PR-1/3 schema redesign, merged 2026-06-21)

## Sequence after this PR

- **PR-3**: AuthorService `MyTutorials` field expansion — renames + `repositoryName` + `monitored` + `daysSinceReview` calc fields + `isSlugAvailable` action + `Tags.actualTag` projection. Per Riley's #385 contract.
````

- [ ] **Step 3: Open the PR via gh**

```bash
gh pr create --title "feat(migration): #385 PR-2/3 — migrator + backfill extension for new schema columns" \
             --body-file <(<paste-PR-body-from-step-2>) \
             --base main
```

- [ ] **Step 4: Confirm the PR was created and link it back here**

```bash
gh pr view --json number,url
```

Record the PR number; the next session (or PR-3 spec) will reference it.

---

## Notes for the executor

- **Pre-merge probes are non-negotiable.** If Task 0 surfaces ANY column-name drift from the spec, halt the plan and update the spec before continuing — don't paper over with a quick fix in code, because PR-3 will inherit the spec's assumptions.
- **Branch is `worktree-385-pr2-migrator`.** Stay on it — `git branch --show-current` should match before every commit. See memory [[feedback_branch_slip_after_long_session]] and [[feedback_verify_branch_before_commit]].
- **No `cf set-env` work needed.** PR-2 uses only existing env vars (`IMS_DB_URL`, `IMS_DB_USERNAME`, `IMS_DB_PASSWORD`, `CAP_HANA_CREDENTIALS`, `IMS_HANA_CREDENTIALS`) that the migrator already documents.
- **No QA-channel work.** QA schema doesn't include these entities — see PR-1 spec's "QA channel unaffected" note.
- **Each commit message uses the conventional-commit format** matching the project — `feat(migration):` for code, `test(hybrid):` for hybrid tests, `docs(plan):` for the plan doc.
- **When in doubt, dry-run.** Both scripts have `--dry-run` mode. Use it before any write to verify the shape of the work, especially if Task 0 surfaced surprises.
