# #385 PR-1/3: CAP schema redesign for TutorialRepositories + Tags — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reshape CAP `TutorialRepositories` to match IMS source (repository GROUP entity, not per-tutorial GitHub-URL row); add `TutorialMeta.repository` FK; add 3 missing source columns to `Tags`. No data migration; DEV table is verified empty so destructive HDI DROPs are safe.

**Architecture:** Atomic schema edit (single CDS commit; partial state won't compile) → HDI migration regen with manual DROP-resolve → update single runtime consumer (`contributor-notifications.js`) to use 2-level Association chain query → drop the entity from the cleanup script's child-tables list → hybrid test for end-to-end chain query → finalize.

**Tech Stack:** SAP CAP Node.js, SAP HANA Cloud (HDI deploy with destructive ALTER TABLE DROP COLUMN), Vitest (in-memory SQLite unit + live HANA hybrid via `cds bind`), CDS Association chain queries (2-level path expression).

**Spec:** [docs/superpowers/specs/2026-06-21-issue-385-pr1-schema-redesign-design.md](../specs/2026-06-21-issue-385-pr1-schema-redesign-design.md) (approved iter-2; 10 findings folded across 2 iterations; commit `746c5cd3`)

**Branch:** `worktree-385-pr1-schema-redesign` (already checked out in worktree).

## Explicit out-of-scope (top-of-plan)

- **No data migration.** PR-2 (separate spec) extends `migrate-from-hana.js` to populate the new columns from IMS source HANA.
- **No AuthorService changes.** PR-3 (separate spec) renames + calc fields on `MyTutorials` + `AuthorService.Tags.actualTag` + `isSlugAvailable`.
- **No NOT NULL on `semaphoreId`.** Source enforces NOT NULL but CAP stays nullable until PR-2 backfills. A follow-up PR can tighten the constraint.
- **No `label` column changes.** Stays admin-editable; no source counterpart.
- **No QA-channel-specific work.** Same schema lands in `tutorials-hana-qa` via existing deploy path.

## Commit-checkpoint reminders

Every Task below ends with a `git add ... && git commit -m "..."` step. Treat each Task's commit as a checkpoint:

- Run verification (`node --check`, `npx cds compile`, `npx vitest`) BEFORE the commit.
- Don't commit broken state. If verification fails, fix forward.
- After a successful commit, the worktree is recoverable to that point.

## Rollback notes

- **Task 1 (schema)**: revert is destructive in reverse (DROP new columns, ADD back old). Acceptable since the new columns are empty until PR-2 lands.
- **Task 2 (migration table)**: HDI migration blocks are append-only; revert means deleting the new block from the file + bumping `version=` back down. Don't revert in PROD-deployed state.
- **Task 3 (contributor-notifications.js)**: revert is safe; cron uses Promise-chain queries with NULL-safe results in both shapes.
- **Task 4 (cleanup script)**: revert is safe; the line just changes which tables get a DELETE.
- **Task 5 (hybrid test)**: test-only; safe to revert.

---

## Worktree state (verified pre-flight 2026-06-21)

Worktree branched from `origin/main` at `ff22d0d6`. Verified:

- `db/schema.cds:43` has `repositories : Composition of many TutorialRepositories on repositories.tutorial = $self;` ✓
- `db/schema.cds:204` declares `entity Tags : cuid, LegacyKeyed { ... }` with `name, label, titlePath, virtual mdFormat` ✓
- `db/schema.cds:320` declares `entity TutorialRepositories : cuid, LegacyKeyed { tutorial, repoUrl, branch, owner }` ✓
- `db/schema.cds:~204` declares `entity TutorialMeta` ending with `firstNotificationDate : Timestamp;` ✓
- `srv/lib/contributor-notifications.js:32-43` reads `SELECT.one.from(TutorialRepositories).where({ tutorial_ID })` and pushes `repoOwner: repo?.owner || null` ✓
- `scripts/cleanup-catalog-pollution.cjs:166` has `'TutorialRepositories'` in `childTablesById` array ✓
- `db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable` is at `== version=1` (no migration blocks yet) ✓
- `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` is at `== version=3` (last block `== migration=3`) ✓
- `db/src/com.sap.developers.ims.Tags.hdbmigrationtable` is at `== version=3` (last block `== migration=3`) ✓
- `test/lib/contributor-notifications.test.js` has 6 existing tests (2 base + 2 markNotificationSent + 2 edge); no fixture for TutorialRepositories ✓

**No rebase risk expected.** No worktree-state-aware branching needed.

---

## File Structure

### New files (1)

| File | Purpose |
| --- | --- |
| `test/hybrid/385-schema-redesign.test.js` | End-to-end 2-level chain query against live HANA; 5 tests (unique-constraint, FK accepted, Tag columns exist, chain returns email, chain returns null when repository_ID null) |

### Modified files (6)

| File | Change |
| --- | --- |
| `db/schema.cds` | Atomic edit: reshape `TutorialRepositories` (drop tutorial/repoUrl/branch/owner; add name/repositoryOwner), remove `Tutorials.repositories` Composition, add `TutorialMeta.repository : Association to TutorialRepositories`, add `Tags` 3 new columns (semaphoreId/isActualTag/isInterestItem) |
| `db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable` | Auto-regen by `cds build`: emits `version=2` + `migration=2` block with DROP + ADD; implementer manually uncomments `>>>>>` DROP statements after row-count = 0 verification |
| `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable` | Auto-regen: emits `version=4` + `migration=4` block with `ALTER TABLE ... ADD (REPOSITORY_ID NVARCHAR(36))` |
| `db/src/com.sap.developers.ims.Tags.hdbmigrationtable` | Auto-regen: emits `version=4` + `migration=4` block with `ALTER TABLE ... ADD (SEMAPHOREID NVARCHAR(255), ISACTUALTAG BOOLEAN DEFAULT FALSE, ISINTERESTITEM BOOLEAN DEFAULT FALSE)` |
| `db/last-dev/csn.json` | Auto-regen by `cds build`: CSN cache update |
| `srv/lib/contributor-notifications.js` | Replace `SELECT.one.from(TutorialRepositories).where({ tutorial_ID })` (lines 32-33) with 2-level chain `SELECT.one.from(TutorialMeta).columns('repository.repositoryOwner.email as email').where({ tutorial_ID })`. Update the `notifications.push({ ..., repoOwner: ... })` line accordingly. Update the imports (line 8) to drop unused `TutorialRepositories`. |
| `scripts/cleanup-catalog-pollution.cjs` | Remove `'TutorialRepositories'` from `childTablesById` array (line 166). Also update the file header comment (line 16) that lists the entity. |
| `test/lib/contributor-notifications.test.js` | TDD: extend with 2 new tests inside the existing top-level describe — (a) chain query resolves repo-group-owner email when fixture has full Tutorial → Meta → Repository → Owner chain, (b) NULL-safe when `meta.repository_ID = NULL`. Fixture insert order: TutorialContributors → TutorialRepositories → TutorialMeta. |

### Auto-regenerated files (no manual edit)

- `db/last-dev/csn.json` — included in source git tracking per existing pattern (verified via `git log` against the repo).

---

## Pre-flight (Step 0)

Before any task, the implementer subagent runs these checks. Each should return the expected output; any deviation means STOP and re-orient.

- [ ] **Step 0.1: Confirm working in the worktree**

  ```bash
  cd D:/projects/tutorials-poc/.claude/worktrees/issue-385-pr1-schema
  pwd
  git branch --show-current
  ```

  Expected: pwd ends in `issue-385-pr1-schema`; branch is `worktree-385-pr1-schema-redesign`.

  Memory [[feedback_subagent_writes_can_leak_to_parent_repo]]: writes to the parent `D:/projects/tutorials-poc/` will be missed by the rebase + push. STOP and re-`cd` if wrong.

- [ ] **Step 0.2: Verify spec-cited file:line anchors all match**

  ```bash
  grep -n "entity TutorialRepositories" db/schema.cds
  grep -n "entity TutorialMeta " db/schema.cds
  grep -n "entity Tags " db/schema.cds
  grep -n "repositories.*Composition" db/schema.cds
  grep -n "TutorialRepositories" srv/lib/contributor-notifications.js
  grep -n "'TutorialRepositories'" scripts/cleanup-catalog-pollution.cjs
  ```

  Expected:
  - `db/schema.cds:320` → `entity TutorialRepositories : cuid, LegacyKeyed {`
  - `db/schema.cds` → an `entity TutorialMeta` line
  - `db/schema.cds:204` → `entity Tags : cuid, LegacyKeyed {`
  - `db/schema.cds:43` → `repositories : Composition of many TutorialRepositories...`
  - `srv/lib/contributor-notifications.js:8` and `:32-33` → references to TutorialRepositories
  - `scripts/cleanup-catalog-pollution.cjs:166` → `'TutorialRepositories',`

  If any line has drifted, note the new line and proceed.

- [ ] **Step 0.3: Verify HDI migration tables are at expected baseline versions**

  ```bash
  head -1 db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable
  head -1 db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable
  head -1 db/src/com.sap.developers.ims.Tags.hdbmigrationtable
  echo "---"
  grep -E "^==.*migration=" db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable | head -3
  grep -E "^==.*migration=" db/src/com.sap.developers.ims.Tags.hdbmigrationtable | head -3
  ```

  Expected:
  - TutorialRepositories: `== version=1` (no migration blocks)
  - TutorialMeta: `== version=3`, last block `== migration=3`
  - Tags: `== version=3`, last block `== migration=3`

  After this PR's `cds build` (Task 2): TutorialRepositories `version=2`/`migration=2`; TutorialMeta `version=4`/`migration=4`; Tags `version=4`/`migration=4`.

- [ ] **Step 0.4: Verify DEV HANA `TutorialRepositories` row count = 0 (gate the destructive DROPs)**

  ```bash
  cf target | head -6
  ```

  Expected: org `tutorial-system`, space `dev`. If wrong, `cf api https://api.cf.eu10-005.hana.ondemand.com && cf login --sso`.

  Then query:

  ```bash
  npx cds bind --exec -- node -e "(async () => {
    const cds = require('@sap/cds');
    const db = await cds.connect.to('db');
    const r = await cds.run('SELECT COUNT(*) AS CNT FROM \"COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES\"');
    console.log('TutorialRepositories row count:', r[0].CNT);
    process.exit(r[0].CNT === 0 ? 0 : 2);
  })().catch(e => { console.error(e.message); process.exit(1); });"
  ```

  Expected: `TutorialRepositories row count: 0`. Exit 0. If non-zero, STOP and surface to the human — the spec's safety assumption is invalidated.

- [ ] **Step 0.5: Verify QA HANA `TutorialRepositories` row count = 0**

  The QA channel binding is separate. Use `cds bind --profile` or a direct HDI key. Per memory `[project_qa_shared_aspects]` the same schema migration runs against both:

  ```bash
  # If a QA profile exists in default-env or .cdsrc, use it. Otherwise bind temporarily:
  cf bind-service tutorials-srv-qa tutorials-hana-qa-key 2>/dev/null || echo "(already bound)"
  # Then query the QA container:
  npx cds bind --to tutorials-hana-qa --exec -- node -e "(async () => {
    const cds = require('@sap/cds');
    const db = await cds.connect.to('db');
    const r = await cds.run('SELECT COUNT(*) AS CNT FROM \"COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES\"');
    console.log('QA TutorialRepositories row count:', r[0].CNT);
    process.exit(r[0].CNT === 0 ? 0 : 2);
  })().catch(e => { console.error(e.message); process.exit(1); });"
  ```

  Expected: `QA TutorialRepositories row count: 0`. If non-zero, STOP and surface.

  **Fallback if QA binding isn't easily accessible**: defer this step until just before push (Task 6). At minimum, the implementer should call out in the PR body that QA verification was/wasn't done.

- [ ] **Step 0.6: Baseline tests pass**

  ```bash
  npx vitest run test/lib/contributor-notifications.test.js test/unit/lib/tutorial-review.test.js test/notification-reset.test.js 2>&1 | grep -E "Test Files|Tests " | head -3
  ```

  Expected: all green (15 tests / 3 files post-#513, or similar). Establishes baseline.

- [ ] **Step 0.7: CDS compiles on baseline**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null 2>&1 && echo OK
  npx cds compile srv/author-service.cds > /dev/null 2>&1 && echo OK
  npx cds compile db/views.cds > /dev/null 2>&1 && echo OK
  ```

  Expected: 3× OK. Confirms baseline schema compiles.

---

## Task 1: Atomic CDS schema edit

**Files:**

- Modify: `db/schema.cds`

This is the BIGGEST risk task because the schema edits must land atomically. Partial state = uncompilable CDS. The 4 sub-edits MUST land in one commit:

1. Remove `Tutorials.repositories` Composition (line 43).
2. Reshape `TutorialRepositories` (line 320): drop `tutorial/repoUrl/branch/owner`, add `name/repositoryOwner`.
3. Add `TutorialMeta.repository` Association.
4. Add `Tags` 3 new columns.

If the implementer commits any of these without the others, `npx cds compile` errors with cross-reference failures.

- [ ] **Step 1.1: Edit 1 — Remove `Tutorials.repositories` Composition**

  Use Edit on `db/schema.cds`. Anchor on the exact line:

  ```cds
    repositories              : Composition of many TutorialRepositories on repositories.tutorial = $self;
  ```

  Replace with NOTHING (delete the line). Specifically, anchor on a 3-line context that includes the preceding and following lines so the Edit removes only this line cleanly. Read the surrounding lines first to capture the exact context.

- [ ] **Step 1.2: Edit 2 — Reshape TutorialRepositories**

  Use Edit. Anchor on the entire existing entity body:

  ```cds
  entity TutorialRepositories : cuid, LegacyKeyed {
    tutorial                  : Association to Tutorials;
    repoUrl                   : String(1000);
    branch                    : String(255);
    owner                     : String(255);
  }
  ```

  Replace with:

  ```cds
  @assert.unique.name : [name]
  entity TutorialRepositories : cuid, LegacyKeyed {
    name                      : String(255);                          // matches IMS_TUTORIAL_REPOSITORY.repository_name
    repositoryOwner           : Association to TutorialContributors;  // matches IMS_TUTORIAL_REPOSITORY.repository_owner_id
  }
  ```

- [ ] **Step 1.3: Edit 3 — Add `TutorialMeta.repository` Association**

  Use Edit. Anchor on the closing `}` of the `TutorialMeta` entity body. Read the file around `entity TutorialMeta` first to confirm the exact whitespace:

  ```cds
    firstNotificationDate       : Timestamp;
  }
  ```

  Replace with (preserve indent):

  ```cds
    firstNotificationDate       : Timestamp;
    repository                  : Association to TutorialRepositories;
  }
  ```

- [ ] **Step 1.4: Edit 4 — Add `Tags` 3 new columns**

  Use Edit. Anchor on the closing `}` of the `Tags` entity body:

  ```cds
  entity Tags : cuid, LegacyKeyed {
    name                      : String(255);
    label                     : String(255);
    titlePath                 : String(255);
    virtual mdFormat           : String;
  }
  ```

  Replace with:

  ```cds
  entity Tags : cuid, LegacyKeyed {
    name                      : String(255);
    label                     : String(255);
    titlePath                 : String(255);
    virtual mdFormat           : String;
    semaphoreId               : String(255);                // NEW (PR-1 of #385): matches IMS_TAG.semaphore_id; nullable until PR-2 backfills
    isActualTag               : Boolean default false;      // NEW: matches IMS_TAG.is_actual_tag
    isInterestItem            : Boolean default false;      // NEW: matches IMS_TAG.is_interest_item
  }
  ```

  (Note the existing file's whitespace style: 2-space outer indent + column-aligned padding before `:`. Match it.)

- [ ] **Step 1.5: Verify CDS compiles after all 4 edits**

  ```bash
  npx cds compile db/schema.cds > /dev/null 2>&1 && echo OK_schema
  npx cds compile srv/admin-service.cds > /dev/null 2>&1 && echo OK_admin
  npx cds compile srv/author-service.cds > /dev/null 2>&1 && echo OK_author
  npx cds compile db/views.cds > /dev/null 2>&1 && echo OK_views
  ```

  Expected: 4× `OK_*`. If ANY fails, the schema is in an inconsistent state — DO NOT commit. Common failure: `Element "tutorial" not found in entity "com.sap.developers.ims.TutorialRepositories"` means Edit 1 (Composition removal) didn't land, OR Edit 2 didn't add the `name` column.

- [ ] **Step 1.6: Verify CSN shape**

  ```bash
  npx cds compile db/schema.cds --to json 2>/dev/null | python -c "
  import json, sys
  d = json.load(sys.stdin)
  tr = d['definitions']['com.sap.developers.ims.TutorialRepositories']
  print('TutorialRepositories elements:', sorted(tr['elements'].keys()))
  tm = d['definitions']['com.sap.developers.ims.TutorialMeta']
  print('TutorialMeta.repository:', tm['elements'].get('repository', 'MISSING'))
  tags = d['definitions']['com.sap.developers.ims.Tags']
  print('Tags new cols:', {k: tags['elements'].get(k, 'MISSING') for k in ['semaphoreId', 'isActualTag', 'isInterestItem']})
  tut = d['definitions']['com.sap.developers.ims.Tutorials']
  print('Tutorials.repositories present?', 'repositories' in tut['elements'])
  "
  ```

  Expected:
  - `TutorialRepositories elements: ['ID', 'createdAt', 'createdBy', 'legacyId', 'modifiedAt', 'modifiedBy', 'name', 'repositoryOwner']` (NO `tutorial/repoUrl/branch/owner`)
  - `TutorialMeta.repository`: a dict with `type: 'cds.Association'` etc. (not 'MISSING')
  - `Tags new cols`: all 3 present as `{ type: 'cds.String' }` / `{ type: 'cds.Boolean', default: ... }`
  - `Tutorials.repositories present? False`

- [ ] **Step 1.7: Verify line endings preserved**

  ```bash
  file db/schema.cds | grep -v CRLF || echo "CRLF_DETECTED — fix"
  ```

  Memory [[feedback_crlf_regression_on_windows]]. Expected: NOT CRLF.

- [ ] **Step 1.8: Commit**

  ```bash
  git add db/schema.cds
  git commit -m "feat(schema): reshape TutorialRepositories + add TutorialMeta.repository + Tags columns (#385 PR-1/3)

  Atomic 4-edit change (partial state is uncompilable):
  1. DROP Tutorials.repositories Composition (refs the removed FK).
  2. RESHAPE TutorialRepositories: drop (tutorial, repoUrl, branch, owner),
     add (name @assert.unique, repositoryOwner Association to TutorialContributors).
     Matches IMS_TUTORIAL_REPOSITORY source schema.
  3. ADD TutorialMeta.repository Association to TutorialRepositories.
     Matches IMS_TUTORIAL_METADATA.repository_id FK in source.
  4. ADD Tags columns (semaphoreId, isActualTag, isInterestItem).
     Source IMS_TAG columns dropped from migration today.

  No data migration in this PR — DEV TutorialRepositories verified empty
  (0/2792). PR-2 (separate spec) extends migrate-from-hana.js to populate.

  HDI migrations regenerated in Task 2."
  ```

---

## Task 2: HDI migration table regeneration + manual DROP-resolve

**Files:**

- Auto-regenerate: `db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable` (manual resolution required)
- Auto-regenerate: `db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable`
- Auto-regenerate: `db/src/com.sap.developers.ims.Tags.hdbmigrationtable`
- Auto-regenerate: `db/last-dev/csn.json`

- [ ] **Step 2.1: Run `cds build --production`**

  ```bash
  npx cds build --production 2>&1 | tail -10
  ```

  Expected:
  - Build succeeds.
  - Output may include `[ERROR] Manual resolution required for file db\src\com.sap.developers.ims.TutorialRepositories.hdbmigrationtable. Check migration version content for further details.` This is EXPECTED. `cds build` emits the DROP statements but flags them for manual review.
  - The actual hdbmigrationtable files get regenerated in `db/src/`.

- [ ] **Step 2.2: Inspect the regenerated TutorialRepositories migration block**

  ```bash
  cat db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable
  ```

  Expected: a `== version=2` line at the top + an `== migration=2` block at the bottom containing something like:

  ```
  == migration=2
  -- generated by cds-compiler version X.X.X
  >>>>> Manual resolution required - DROP statements causing data loss are disabled by default.
  >>>>> You may either:
  >>>>>   uncomment statements to allow incompatible changes, or
  >>>>>   refactor statements, e.g. replace DROP/ADD by single RENAME statement
  >>>>> After manual resolution delete all lines starting with >>>>>
  ALTER TABLE com_sap_developers_ims_TutorialRepositories ADD (name NVARCHAR(255), repositoryOwner_ID NVARCHAR(36));
  -- ALTER TABLE com_sap_developers_ims_TutorialRepositories DROP (tutorial_ID, repoUrl, branch, owner);
  ```

  The DROP statements are commented out with `--`. The implementer must:
  1. Verify DEV row count = 0 (already done in Step 0.4).
  2. Uncomment the DROP statement.
  3. Delete all `>>>>>` lines.

- [ ] **Step 2.3: Re-verify DEV row count = 0 RIGHT BEFORE the uncomment**

  ```bash
  npx cds bind --exec -- node -e "(async () => {
    const cds = require('@sap/cds');
    const db = await cds.connect.to('db');
    const r = await cds.run('SELECT COUNT(*) AS CNT FROM \"COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES\"');
    console.log('TutorialRepositories row count:', r[0].CNT);
    process.exit(r[0].CNT === 0 ? 0 : 2);
  })().catch(e => { console.error(e.message); process.exit(1); });"
  ```

  Expected: 0, exit 0. **If non-zero, STOP** — the DROP would wipe data.

- [ ] **Step 2.4: Manually resolve the migration block**

  Use Edit on `db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable`. Three sub-edits:

  **A. Uncomment the DROP statement.** Find:

  ```
  -- ALTER TABLE com_sap_developers_ims_TutorialRepositories DROP (tutorial_ID, repoUrl, branch, owner);
  ```

  Replace with (just the leading `-- ` removed):

  ```
  ALTER TABLE com_sap_developers_ims_TutorialRepositories DROP (tutorial_ID, repoUrl, branch, owner);
  ```

  (The actual emitted column list may differ; use whatever `cds build` produced.)

  **B. Delete the `>>>>>` block.** Find and remove all 4 lines starting with `>>>>>`. Use Edit with a multi-line anchor.

  Resulting `migration=2` block should look like:

  ```
  == migration=2
  -- generated by cds-compiler version X.X.X
  ALTER TABLE com_sap_developers_ims_TutorialRepositories ADD (name NVARCHAR(255), repositoryOwner_ID NVARCHAR(36));
  ALTER TABLE com_sap_developers_ims_TutorialRepositories DROP (tutorial_ID, repoUrl, branch, owner);
  ```

- [ ] **Step 2.5: Inspect the other 2 migration tables (no manual resolution needed; they're additive-only)**

  ```bash
  echo "--- TutorialMeta migration=4 ---"
  awk '/== migration=4/,/^$/' db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable
  echo "--- Tags migration=4 ---"
  awk '/== migration=4/,/^$/' db/src/com.sap.developers.ims.Tags.hdbmigrationtable
  ```

  Expected:
  - TutorialMeta `migration=4` has a single `ALTER TABLE ... ADD (repository_ID NVARCHAR(36));`.
  - Tags `migration=4` has `ALTER TABLE ... ADD (semaphoreId NVARCHAR(255), isActualTag BOOLEAN DEFAULT FALSE, isInterestItem BOOLEAN DEFAULT FALSE);`.
  - Neither has `>>>>>` markers (both are pure ADDs).

- [ ] **Step 2.6: Re-run `cds build` to confirm clean state**

  ```bash
  npx cds build --production 2>&1 | tail -5
  ```

  Expected: build completes without `[ERROR] Manual resolution required` (since we resolved it in Step 2.4).

- [ ] **Step 2.7: Verify CDS still compiles**

  ```bash
  npx cds compile srv/admin-service.cds > /dev/null 2>&1 && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 2.8: Line-ending checks**

  ```bash
  file db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable \
       db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable \
       db/src/com.sap.developers.ims.Tags.hdbmigrationtable | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 2.9: Commit**

  ```bash
  git add db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable \
          db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable \
          db/src/com.sap.developers.ims.Tags.hdbmigrationtable \
          db/last-dev/csn.json
  git commit -m "feat(schema): regen HDI migration tables for #385 PR-1

  - TutorialRepositories: version=1 → 2; migration=2 manually-resolved
    (uncommented DROP statements after verifying DEV row count = 0).
  - TutorialMeta: version=3 → 4; migration=4 adds repository_ID column.
  - Tags: version=3 → 4; migration=4 adds semaphoreId + isActualTag +
    isInterestItem columns.
  - db/last-dev/csn.json regenerated.

  DROP statements are safe — TutorialRepositories verified empty
  (0/2792 in DEV; QA also 0 per Step 0.5)."
  ```

---

## Task 3: Update contributor-notifications.js with 2-level chain query (TDD)

**Files:**

- Modify: `srv/lib/contributor-notifications.js` (lines 8, 32-43)
- Modify: `test/lib/contributor-notifications.test.js` (add 2 new tests + fixture extension)

This is the highest-risk-of-bug Task because the 2-level Association chain query (`columns('repository.repositoryOwner.email as email')`) is a NEW pattern in this codebase — grep `\.columns\(.*\.[a-z]\w*\.[a-z]\w*\.[a-z]\w*` returns 0 hits. TDD is mandatory here.

- [ ] **Step 3.1: Read the existing implementation + test to anchor**

  ```bash
  sed -n '5,45p' srv/lib/contributor-notifications.js
  ```

  Confirm the exact shape of:
  - Line 8: `const { Tutorials, TutorialMeta, TutorialContributors, TutorialRepositories } = cds.entities(...)`
  - Lines 32-33: `const repo = await SELECT.one.from(TutorialRepositories).where({ tutorial_ID: tutorial.ID });`
  - Line 42: `repoOwner: repo?.owner || null`

- [ ] **Step 3.2: Write the 2 new tests (red phase) — extend test file**

  Use Edit on `test/lib/contributor-notifications.test.js`. Anchor on the closing `});` of the `describe('computeStaleNotifications filtering edge cases', ...)` block (around line 171). Insert BEFORE the FINAL `});` (the one that closes the outermost describe):

  ```javascript

    describe('PR-1 2-level chain query for repo-group owner', () => {
      it('resolves repoOwner via TutorialMeta.repository.repositoryOwner.email', async () => {
        const { Tutorials, TutorialMeta, TutorialContributors, TutorialRepositories } =
          cds.entities('com.sap.developers.ims');

        const tutorialId = 'ffffffff-385a-0000-0000-000000000001';
        const metaId = 'aaaaaaaa-385a-0000-0000-000000000001';
        const repoId = 'cccccccc-385a-0000-0000-000000000001';
        const ownerContribId = 'bbbbbbbb-385a-0000-0000-000000000001';

        // FK insertion order: TutorialContributors first (FK target for repositoryOwner),
        // then TutorialRepositories (FK target for TutorialMeta.repository), then TutorialMeta.
        await INSERT.into(Tutorials).entries({
          ID: tutorialId, slug: '385a-tutorial', title: 'PR-1 chain test',
          legacyId: 9301, status: 'ACTIVE',
        });
        await INSERT.into(TutorialContributors).entries({
          ID: ownerContribId, tutorial_ID: tutorialId,
          name: 'Repo Owner', email: 'repoowner@sap.com', role: 'OWNER', legacyId: 9501,
        });
        await INSERT.into(TutorialRepositories).entries({
          ID: repoId, name: 'btp-foundation',
          repositoryOwner_ID: ownerContribId, legacyId: 9601,
        });
        await INSERT.into(TutorialMeta).entries({
          ID: metaId, tutorial_ID: tutorialId,
          reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
          owner: 'metaowner@sap.com', monitoredStatus: 'ACTIVE',
          notificationNumber: 0, legacyId: 9401,
          repository_ID: repoId,
        });

        const notifications = await computeStaleNotifications(90);
        const match = notifications.find(n => n.slug === '385a-tutorial');
        expect(match).toBeTruthy();
        expect(match.repoOwner).toBe('repoowner@sap.com');
      });

      it('returns repoOwner=null when meta.repository is unset (NULL-safe)', async () => {
        const { Tutorials, TutorialMeta, TutorialContributors } =
          cds.entities('com.sap.developers.ims');

        const tutorialId = 'ffffffff-385b-0000-0000-000000000001';
        const metaId = 'aaaaaaaa-385b-0000-0000-000000000001';

        await INSERT.into(Tutorials).entries({
          ID: tutorialId, slug: '385b-tutorial', title: 'PR-1 null-safe test',
          legacyId: 9302, status: 'ACTIVE',
        });
        await INSERT.into(TutorialContributors).entries({
          ID: 'bbbbbbbb-385b-0000-0000-000000000001', tutorial_ID: tutorialId,
          name: 'Solo', email: 'solo@sap.com', role: 'AUTHOR', legacyId: 9502,
        });
        await INSERT.into(TutorialMeta).entries({
          ID: metaId, tutorial_ID: tutorialId,
          reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
          owner: 'solo@sap.com', monitoredStatus: 'ACTIVE',
          notificationNumber: 0, legacyId: 9402,
          // No repository_ID — left null.
        });

        const notifications = await computeStaleNotifications(90);
        const match = notifications.find(n => n.slug === '385b-tutorial');
        expect(match).toBeTruthy();
        expect(match.repoOwner).toBeNull();
      });
    });
  ```

- [ ] **Step 3.3: Run the tests — expect FAIL (red)**

  ```bash
  npx vitest run test/lib/contributor-notifications.test.js 2>&1 | tail -25
  ```

  Expected:
  - **Test "resolves repoOwner..."** FAILS — current implementation does `SELECT.one.from(TutorialRepositories).where({ tutorial_ID })`. The TutorialRepositories table now has the NEW schema (no `tutorial_ID` column), so the WHERE clause fails. Or — if WHERE silently returns empty — `repo?.owner` is undefined and `repoOwner: undefined || null = null`, mismatching the expected `'repoowner@sap.com'`. Test FAILS.
  - **Test "returns null..."** may PASS or FAIL depending on the WHERE-clause-on-missing-column behavior. Either way, after Step 3.4 it will pass.

  If both tests pass at red phase, something's off (probably the schema didn't change — re-check Tasks 1 and 2 landed).

- [ ] **Step 3.4: Implement the chain query (green phase)**

  Use Edit on `srv/lib/contributor-notifications.js`. Three sub-edits:

  **A. Remove `TutorialRepositories` from the imports.** Find:

  ```javascript
    const { Tutorials, TutorialMeta, TutorialContributors, TutorialRepositories } =
      cds.entities('com.sap.developers.ims');
  ```

  Replace with:

  ```javascript
    const { Tutorials, TutorialMeta, TutorialContributors } =
      cds.entities('com.sap.developers.ims');
  ```

  **B. Replace the SELECT.one.from(TutorialRepositories) chunk.** Find:

  ```javascript
      const repo = await SELECT.one.from(TutorialRepositories)
        .where({ tutorial_ID: tutorial.ID });
  ```

  Replace with:

  ```javascript
      // #385 PR-1: repo-group owner now lives on TutorialMeta.repository.repositoryOwner.
      // 2-level Association chain compiles to a LEFT JOIN on HANA. NULL-safe — if
      // meta.repository is null (no group assigned yet — common until PR-2 migrator
      // runs), the chain returns { email: null } and notification level 1 falls
      // through to owner-only recipients (existing behaviour).
      const repoOwnerRow = await SELECT.one.from(TutorialMeta)
        .columns('repository.repositoryOwner.email as email')
        .where({ tutorial_ID: tutorial.ID });
  ```

  **C. Update the `notifications.push` to use the new variable name.** Find:

  ```javascript
        repoOwner: repo?.owner || null
  ```

  Replace with:

  ```javascript
        repoOwner: repoOwnerRow?.email ?? null
  ```

- [ ] **Step 3.5: Run the tests — expect PASS (green)**

  ```bash
  npx vitest run test/lib/contributor-notifications.test.js 2>&1 | tail -15
  ```

  Expected: 8 tests pass (6 existing + 2 new). If a NEW test fails:
  - **"resolves repoOwner..." fails with `expected null to be 'repoowner@sap.com'`**: the chain query isn't resolving. Diagnose:
    1. Check the fixture order: TutorialContributors → TutorialRepositories → TutorialMeta. The Repositories row's `repositoryOwner_ID` must reference an existing TutorialContributors.ID. The Meta row's `repository_ID` must reference the Repositories row's ID.
    2. Check the chain syntax: `columns('repository.repositoryOwner.email as email')`. Some CAP versions need `.columns('repository_repositoryOwner_email as email')` (with underscores). Try the underscore variant if the dotted form fails.
    3. Try the explicit-join form: `SELECT.one.from(TutorialMeta, m => { m.where({ tutorial_ID }); m.repository.repositoryOwner.columns('email'); })` — but this is verbose.
  - **"returns null..." fails**: should pass even without the impl change. If it fails, the WHERE clause on `tutorial_ID` doesn't match — maybe the fixture's tutorial_ID is wrong.

  Report `DONE_WITH_CONCERNS` if you have to use a workaround syntax (e.g. underscore form vs dotted form); the workaround is acceptable but should be documented in the PR body.

- [ ] **Step 3.6: Run broader unit suite to confirm no regression**

  ```bash
  npx vitest run test/lib/ test/unit/lib/ test/notification-reset.test.js 2>&1 | grep -E "Test Files|Tests " | head -3
  ```

  Expected: all green.

- [ ] **Step 3.7: Syntax + line endings**

  ```bash
  node --check srv/lib/contributor-notifications.js && echo OK
  file srv/lib/contributor-notifications.js test/lib/contributor-notifications.test.js | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 3.8: Commit**

  ```bash
  git add srv/lib/contributor-notifications.js test/lib/contributor-notifications.test.js
  git commit -m "feat(lib): chain query meta.repository.repositoryOwner.email (#385 PR-1)

  computeStaleNotifications no longer reads TutorialRepositories
  directly (the old shape had a tutorial_ID FK that doesn't exist
  in the new schema). The repo-group owner is now reached via a
  2-level Association chain through TutorialMeta:

    meta.repository.repositoryOwner.email

  NULL-safe — if meta.repository is null (common before PR-2 migrator
  runs), the chain returns { email: null } and notification level 1
  falls through to owner-only recipients.

  Tests: 2 new inside describe('PR-1 2-level chain query for
  repo-group owner'):
  - resolves repoOwner via chain
  - returns null when meta.repository is unset (NULL-safe)"
  ```

---

## Task 4: Update cleanup-catalog-pollution.cjs

**Files:**

- Modify: `scripts/cleanup-catalog-pollution.cjs`

After Task 1, `TutorialRepositories` has no `tutorial_ID` column. The cleanup script's per-tutorial DELETE would silently fail (the column doesn't exist; the try/catch logs a warn but skips). Worse: even if the column existed, the new entity is a repo-GROUP not per-tutorial, so deleting on tutorial-cleanup makes no semantic sense.

- [ ] **Step 4.1: Read the existing list to anchor**

  ```bash
  sed -n '160,172p' scripts/cleanup-catalog-pollution.cjs
  ```

  Confirm `'TutorialRepositories',` is at line 166 inside `childTablesById`.

- [ ] **Step 4.2: Remove the line**

  Use Edit. Anchor on the exact entries:

  ```javascript
      const childTablesById = [
        'Steps',
        'TutorialMeta',
        'TutorialContributors',
        'TutorialRepositories',
        'TutorialTags',
        'TutorialEmbedding',
      ];
  ```

  Replace with:

  ```javascript
      const childTablesById = [
        'Steps',
        'TutorialMeta',
        'TutorialContributors',
        // TutorialRepositories removed (#385 PR-1): the entity is now a repo-GROUP
        // table without a tutorial_ID FK; deleting it on per-tutorial cleanup is a
        // category error.
        'TutorialTags',
        'TutorialEmbedding',
      ];
  ```

- [ ] **Step 4.3: Update the file-header comment that lists this table**

  Use Edit. Anchor on the file-header comment block:

  ```javascript
   *   2. Drop Tutorials rows with the same slug shape, plus their dependents
   *      (Steps, TutorialMeta, TutorialContributors, TutorialRepositories,
   *       TutorialTags, TutorialEmbedding, TutorialBodyText,
   *       TutorialFeedback). These are the rows that show up in the Admin UI
  ```

  Replace with:

  ```javascript
   *   2. Drop Tutorials rows with the same slug shape, plus their dependents
   *      (Steps, TutorialMeta, TutorialContributors, TutorialTags,
   *       TutorialEmbedding, TutorialBodyText, TutorialFeedback).
   *      (TutorialRepositories was removed from this list in #385 PR-1; it's
   *       now a repo-GROUP entity without a per-tutorial FK.)
  ```

- [ ] **Step 4.4: Verify the file parses**

  ```bash
  node --check scripts/cleanup-catalog-pollution.cjs && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 4.5: Verify no functional references to TutorialRepositories survive in this file**

  ```bash
  grep -n "TutorialRepositories" scripts/cleanup-catalog-pollution.cjs
  ```

  Expected: only the comment lines that explain the removal; NO array entries or DB-query references.

- [ ] **Step 4.6: Line-ending check**

  ```bash
  file scripts/cleanup-catalog-pollution.cjs | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 4.7: Commit**

  ```bash
  git add scripts/cleanup-catalog-pollution.cjs
  git commit -m "fix(cleanup): drop TutorialRepositories from per-tutorial cleanup (#385 PR-1)

  The new TutorialRepositories schema has no tutorial_ID FK — it's a
  repo-GROUP entity with a 1:N relationship via TutorialMeta.repository.
  Including it in childTablesById of cleanup-catalog-pollution.cjs
  would silently fail (try/catch swallows the missing-column error)
  AND semantically wrong (groups shouldn't be deleted on per-tutorial
  cleanup).

  Header comment + array updated."
  ```

---

## Task 5: Hybrid test for end-to-end chain query

**Files:**

- Create: `test/hybrid/385-schema-redesign.test.js`

The most important test in this PR — verifies the 2-level Association chain query works against live HANA, not just SQLite. CAP path expressions compile to LEFT JOINs at SQL emit time, and HANA + SQLite can diverge on edge cases (memory `[feedback_hana_boolean_case_when]` for WHERE-clause; this is a SELECT-list chain, which is different but worth verifying).

- [ ] **Step 5.1: Read existing hybrid test for the bootstrap pattern**

  ```bash
  head -25 test/hybrid/author-service.test.js
  cat test/hybrid/_guard.js
  ```

  Note the bootstrap pattern (`cds.test('serve', ...)` or `cds.bind`) and the `ALLOW_HYBRID_WRITES` guard.

- [ ] **Step 5.2: Create `test/hybrid/385-schema-redesign.test.js`**

  Write the file with this content:

  ```javascript
  // test/hybrid/385-schema-redesign.test.js
  // PR-1 of #385. Verifies the new TutorialRepositories shape + 2-level
  // Association chain query work against live HANA (not just SQLite).
  //
  // Run with: npm run test:hybrid (requires cds bind to tutorials-hana)
  // Guards via test/hybrid/_guard.js — needs ALLOW_HYBRID_WRITES=true.

  import { describe, it, expect, beforeAll, afterAll } from 'vitest';
  import cds from '@sap/cds';
  import './_guard.js';

  describe('#385 PR-1 schema redesign (hybrid)', () => {
    let TutorialRepositories, TutorialMeta, TutorialContributors, Tutorials, Tags;
    const PREFIX = '__TEST_385__';
    const ids = {
      tutorial: '385a-1111-0000-0000-000000000001',
      meta:     '385a-2222-0000-0000-000000000001',
      repo:     '385a-3333-0000-0000-000000000001',
      contrib:  '385a-4444-0000-0000-000000000001',
      contrib2: '385a-4444-0000-0000-000000000002',
      tag:      '385a-5555-0000-0000-000000000001',
    };

    beforeAll(async () => {
      ({ TutorialRepositories, TutorialMeta, TutorialContributors, Tutorials, Tags } =
        cds.entities('com.sap.developers.ims'));
    });

    afterAll(async () => {
      // Cleanup all __TEST_385__ rows. Order: drop FK-dependents before FK-targets.
      await DELETE.from(TutorialMeta).where({ ID: { in: [ids.meta] } });
      await DELETE.from(TutorialRepositories).where({ ID: { in: [ids.repo] } });
      await DELETE.from(TutorialContributors).where({ ID: { in: [ids.contrib, ids.contrib2] } });
      await DELETE.from(Tutorials).where({ ID: { in: [ids.tutorial] } });
      await DELETE.from(Tags).where({ ID: { in: [ids.tag] } });
    });

    it('TutorialRepositories.name has a unique constraint', async () => {
      const repo1 = { ID: ids.repo, name: `${PREFIX}-btp-foundation` };
      const repo2 = { ID: 'duplicate-test-id', name: `${PREFIX}-btp-foundation` };

      await INSERT.into(TutorialRepositories).entries(repo1);
      // Second insert with the same name should fail @assert.unique.name.
      await expect(INSERT.into(TutorialRepositories).entries(repo2)).rejects.toThrow();
      // Cleanup leftover
      await DELETE.from(TutorialRepositories).where({ ID: 'duplicate-test-id' });
    });

    it('Tags accepts the 3 new columns (semaphoreId/isActualTag/isInterestItem)', async () => {
      await INSERT.into(Tags).entries({
        ID: ids.tag, name: `${PREFIX}-tag`,
        semaphoreId: 'test-semaphore', isActualTag: true, isInterestItem: false,
        legacyId: 938501,
      });
      const row = await SELECT.one.from(Tags).where({ ID: ids.tag });
      expect(row.semaphoreId).toBe('test-semaphore');
      expect(row.isActualTag).toBe(true);
      expect(row.isInterestItem).toBe(false);
    });

    it('2-level chain query resolves repo-group owner email end-to-end', async () => {
      // FK chain: TutorialContributor → TutorialRepository.repositoryOwner_ID → ...
      //           TutorialRepository.ID ← TutorialMeta.repository_ID
      await INSERT.into(Tutorials).entries({
        ID: ids.tutorial, slug: `${PREFIX}-chain-tutorial`,
        title: 'PR-1 hybrid chain test', legacyId: 938301, status: 'ACTIVE',
      });
      await INSERT.into(TutorialContributors).entries({
        ID: ids.contrib, tutorial_ID: ids.tutorial,
        name: 'Repo Owner Hybrid', email: 'repoowner-hybrid@sap.com',
        role: 'OWNER', legacyId: 938401,
      });
      await INSERT.into(TutorialRepositories).entries({
        ID: ids.repo, name: `${PREFIX}-btp-foundation`,
        repositoryOwner_ID: ids.contrib, legacyId: 938601,
      });
      await INSERT.into(TutorialMeta).entries({
        ID: ids.meta, tutorial_ID: ids.tutorial,
        reviewedDate: new Date(Date.now() - 200 * 86400000).toISOString(),
        owner: 'metaowner-hybrid@sap.com', monitoredStatus: 'ACTIVE',
        notificationNumber: 0, legacyId: 938201,
        repository_ID: ids.repo,
      });

      const result = await SELECT.one.from(TutorialMeta)
        .columns('repository.repositoryOwner.email as email')
        .where({ ID: ids.meta });

      expect(result).toBeTruthy();
      expect(result.email).toBe('repoowner-hybrid@sap.com');
    });

    it('2-level chain query returns email=null when meta.repository is unset (NULL-safe)', async () => {
      // Re-use the existing TutorialMeta row from the previous test. Update it
      // to clear repository_ID, then re-run the chain query.
      await UPDATE(TutorialMeta).set({ repository_ID: null }).where({ ID: ids.meta });

      const result = await SELECT.one.from(TutorialMeta)
        .columns('repository.repositoryOwner.email as email')
        .where({ ID: ids.meta });

      expect(result).toBeTruthy();
      expect(result.email).toBeNull();
    });

    it('TutorialMeta.repository association resolves on a CDS query (not just raw SQL)', async () => {
      // Restore the FK from the previous test's UPDATE.
      await UPDATE(TutorialMeta).set({ repository_ID: ids.repo }).where({ ID: ids.meta });

      const meta = await SELECT.one.from(TutorialMeta)
        .columns('ID', 'repository_ID')
        .where({ ID: ids.meta });
      expect(meta.repository_ID).toBe(ids.repo);

      const repo = await SELECT.one.from(TutorialRepositories).where({ ID: meta.repository_ID });
      expect(repo.name).toBe(`${PREFIX}-btp-foundation`);
    });
  });
  ```

- [ ] **Step 5.3: Verify the test file parses**

  ```bash
  node --check test/hybrid/385-schema-redesign.test.js && echo OK
  ```

  Expected: `OK`.

- [ ] **Step 5.4: Run the hybrid test (requires cf login + cds bind)**

  **IMPORTANT — sync the chain query form with Task 3.** If Task 3 had to fall back from the dotted form `'repository.repositoryOwner.email as email'` to the underscore form `'repository_repositoryOwner_email as email'` (or the callback form), use the SAME form in this hybrid test. Otherwise this test will re-discover the same incompatibility. Before running, grep what Task 3 actually shipped:

  ```bash
  grep -n "repository.*repositoryOwner.*email\|repository_repositoryOwner_email" srv/lib/contributor-notifications.js
  ```

  If the actual form differs from the dotted-form examples in Step 5.2, edit the hybrid test's two chain queries to match before running.

  ```bash
  ALLOW_HYBRID_WRITES=true npx vitest run test/hybrid/385-schema-redesign.test.js 2>&1 | tail -20
  ```

  Expected: 5 tests pass. If the 2-level chain test fails with "Cannot resolve association", report `DONE_WITH_CONCERNS` and try the alternate `_`-separated path syntax (some CAP versions): `.columns('repository_repositoryOwner_email as email')`.

  If the test fails because `cf` isn't logged in, run `cf login --sso` first.

- [ ] **Step 5.5: Line-ending check**

  ```bash
  file test/hybrid/385-schema-redesign.test.js | grep -v CRLF || echo "CRLF_DETECTED"
  ```

- [ ] **Step 5.6: Commit**

  ```bash
  git add test/hybrid/385-schema-redesign.test.js
  git commit -m "test(hybrid): #385 PR-1 schema reshape + 2-level chain query

  5 tests against live HANA:
  - TutorialRepositories.name unique constraint trips on duplicate insert.
  - Tags accepts semaphoreId/isActualTag/isInterestItem.
  - 2-level chain meta.repository.repositoryOwner.email resolves
    end-to-end (the riskiest piece — new path-expression pattern).
  - 2-level chain returns email=null when meta.repository is unset
    (NULL-safe; common until PR-2 migrator runs).
  - TutorialMeta.repository association resolves via CDS query.

  Cleanup in afterAll honors FK dependency order.
  ALLOW_HYBRID_WRITES guard from test/hybrid/_guard.js."
  ```

---

## Task 6: End-to-end verification + finalize

- [ ] **Step 6.1: Run the full unit suite**

  ```bash
  npx vitest run test/lib/ test/unit/ test/notification-reset.test.js 2>&1 | grep -E "Test Files|Tests " | head -3
  ```

  Expected: all green. Includes the 2 new tests from Task 3.

- [ ] **Step 6.2: Run the hybrid suite (subset)**

  ```bash
  ALLOW_HYBRID_WRITES=true npx vitest run test/hybrid/385-schema-redesign.test.js 2>&1 | grep -E "Test Files|Tests " | head -3
  ```

  Expected: 5/5 pass.

- [ ] **Step 6.3: Re-verify the migration tables look right**

  ```bash
  echo "--- TutorialRepositories ---"
  cat db/src/com.sap.developers.ims.TutorialRepositories.hdbmigrationtable
  echo ""
  echo "--- TutorialMeta migration=4 only ---"
  awk '/== migration=4/,/^$/' db/src/com.sap.developers.ims.TutorialMeta.hdbmigrationtable
  echo ""
  echo "--- Tags migration=4 only ---"
  awk '/== migration=4/,/^$/' db/src/com.sap.developers.ims.Tags.hdbmigrationtable
  ```

  Verify:
  - TutorialRepositories: `== version=2`, `migration=2` has ADD + DROP statements, no `>>>>>` markers.
  - TutorialMeta migration=4: single ADD for `repository_ID`.
  - Tags migration=4: 3 ADD columns.

- [ ] **Step 6.4: Verify no stale references to dropped TutorialRepositories columns survive**

  ```bash
  grep -rn "TutorialRepositories.*tutorial_ID\|repoUrl\|TutorialRepositories.*branch\b\|TutorialRepositories.*owner\b" srv/ scripts/ test/ 2>&1 | grep -v "node_modules" | head -10
  ```

  Expected: zero matches (or only comments/historical references).

- [ ] **Step 6.5: Confirm commit chain**

  ```bash
  git log --oneline main..HEAD 2>/dev/null | head -10 || git log --oneline -10
  ```

  Expected: 5 task commits (Tasks 1-5) plus the 2 spec doc commits already there. Each task commit has a descriptive message referencing #385 PR-1.

- [ ] **Step 6.6: Rebase onto latest main (in case main moved)**

  ```bash
  git fetch origin main 2>&1 | tail -2
  git rebase origin/main 2>&1 | tail -5
  ```

  If conflicts arise, resolve (most likely on `db/last-dev/csn.json` which other PRs touch). Re-run Step 6.1 + 6.2 after rebase.

- [ ] **Step 6.7: Push the branch**

  ```bash
  git push -u origin worktree-385-pr1-schema-redesign --force-with-lease 2>&1 | tail -5
  ```

  Expected: push succeeds (`--force-with-lease` because rebase rewrote history).

- [ ] **Step 6.8: Open the PR**

  ```bash
  gh pr create --base main --head worktree-385-pr1-schema-redesign \
    --title "feat(schema): #385 PR-1/3 — TutorialRepositories reshape + Tags missing columns" \
    --body-file - <<'BODY'
  First of 3 sequential PRs that close #385.

  ## Why

  Brainstorming #385's AuthorService field expansion surfaced that two of the
  contract fields (`MyTutorials.repositoryName` + `AuthorService.Tags.actualTag`)
  depend on data + schema that don't exist in DEV today:

  - `TutorialRepositories` has 0 rows in DEV (migrator at `scripts/migrate-from-hana.js`
    doesn't include the entity in its 12-entity order).
  - `Tags.titlePath`, `is_actual_tag`, `is_interest_item`, `semaphore_id`, `label` are
    dropped from source by the migrator (only `(ID, NAME)` is pulled from `IMS_TAG`).
  - The CAP `TutorialRepositories` schema (`tutorial / repoUrl / branch / owner`)
    is wrongly shaped vs source `IMS_TUTORIAL_REPOSITORY` (`id / repository_name /
    repository_owner_id`). The two model different concepts: source = repository
    GROUP (e.g. 'btp-foundation'); CAP = per-tutorial GitHub URL.

  This PR fixes the CAP schema. PR-2 (separate spec) will extend the migrator.
  PR-3 (separate spec) will expose the new fields through AuthorService.

  ## What's in this PR

  **Schema (`db/schema.cds`):**
  - **`TutorialRepositories` RESHAPED**: drop `tutorial / repoUrl / branch / owner`;
    add `name` (unique) + `repositoryOwner : Association to TutorialContributors`.
    Matches IMS source.
  - **`TutorialMeta.repository`**: new Association FK matching source's
    `IMS_TUTORIAL_METADATA.repository_id`.
  - **`Tags`**: 3 new columns matching source IMS_TAG — `semaphoreId : String(255)`,
    `isActualTag : Boolean default false`, `isInterestItem : Boolean default false`.
  - **`Tutorials.repositories` Composition REMOVED** (would fail CDS compile after
    `TutorialRepositories.tutorial` removal).

  **HDI migrations (auto-regenerated):**
  - `TutorialRepositories`: `version=2` / `migration=2` with ADD + manually-resolved DROP.
  - `TutorialMeta`: `version=4` / `migration=4` ADDs `repository_ID`.
  - `Tags`: `version=4` / `migration=4` ADDs 3 new columns.

  **Runtime consumer update (`srv/lib/contributor-notifications.js`):**
  - Replaces `SELECT.from(TutorialRepositories).where({ tutorial_ID })` with the
    2-level Association chain query `meta.repository.repositoryOwner.email`.
  - NULL-safe — falls through to `repoOwner: null` when `meta.repository` is unset
    (common until PR-2 migrator runs).

  **Cleanup script (`scripts/cleanup-catalog-pollution.cjs`):**
  - `TutorialRepositories` removed from `childTablesById` — it's no longer a
    per-tutorial table.

  **Tests:**
  - `test/lib/contributor-notifications.test.js`: +2 tests covering chain query
    success and NULL-safe path.
  - `test/hybrid/385-schema-redesign.test.js` (new): 5 tests against live HANA
    — unique constraint, new Tags columns, end-to-end 2-level chain, NULL-safe
    chain, TutorialMeta.repository association resolves.

  ## Data safety

  Schema change is destructive (`ALTER TABLE ... DROP (tutorial_ID, repoUrl, branch, owner)`)
  but `TutorialRepositories` is verified EMPTY in DEV (0/2792 tutorials have rows)
  AND QA (0 rows). The DROPs lose nothing. Memory `[feedback_hdi_deploys_can_wipe_data]`
  applies and is honored via the row-count gate in Task 2.

  ## Sequence after this PR

  - **PR-2**: Extend `migrate-from-hana.js` to populate the new columns from IMS
    source HANA. Until then, the new columns hold NULL.
  - **PR-3**: AuthorService `MyTutorials` field expansion (Riley's #385 contract:
    renames, calc fields, `isSlugAvailable` action, Tags.actualTag projection).

  ## Spec + brainstorm

  - Spec: `docs/superpowers/specs/2026-06-21-issue-385-pr1-schema-redesign-design.md`
    (iter-2 approved; 10 findings folded across 2 review iterations)
  - Plan: `docs/superpowers/plans/2026-06-21-issue-385-pr1-schema-redesign.md`

  🤖 Generated with [Claude Code](https://claude.com/claude-code)
  BODY
  ```

- [ ] **Step 6.9: Verify PR URL printed**

  Capture the PR URL from the `gh pr create` output. Report it as the final output.

---

## Acceptance criteria (verify before requesting review)

- [ ] `db/schema.cds` `TutorialRepositories` has `name` (unique) + `repositoryOwner : Association to TutorialContributors`; no `tutorial/repoUrl/branch/owner` columns remain.
- [ ] `db/schema.cds` `TutorialMeta` has `repository : Association to TutorialRepositories`.
- [ ] `db/schema.cds` `Tags` has `semaphoreId`, `isActualTag`, `isInterestItem` columns.
- [ ] `db/schema.cds` `Tutorials.repositories` Composition is REMOVED.
- [ ] `cds compile db/schema.cds` succeeds; CSN has expected element shapes.
- [ ] `cds build --production` emits the 3 migration table updates: TutorialRepositories `version=2` / `migration=2`; TutorialMeta `version=4` / `migration=4`; Tags `version=4` / `migration=4`.
- [ ] Implementer manually resolved the `>>>>>` blocks in TutorialRepositories.hdbmigrationtable's `migration=2` (DROP statements uncommented).
- [ ] DEV HANA `TutorialRepositories` row count = 0 verified RIGHT BEFORE the manual-resolve uncomment.
- [ ] QA HANA `TutorialRepositories` row count = 0 verified before push.
- [ ] `srv/lib/contributor-notifications.js` uses 2-level chain query through `meta.repository.repositoryOwner.email`. Existing `TutorialRepositories` import removed.
- [ ] `scripts/cleanup-catalog-pollution.cjs` `childTablesById` array no longer includes `'TutorialRepositories'`. File-header comment updated to match.
- [ ] `node --check srv/lib/contributor-notifications.js` passes; `node --check scripts/cleanup-catalog-pollution.cjs` passes.
- [ ] `test/lib/contributor-notifications.test.js` has 8 tests total (6 existing + 2 new). All green.
- [ ] `test/hybrid/385-schema-redesign.test.js` has 5 tests; all green against live HANA.
- [ ] DEV HANA deploy succeeds (via next `Build & Deploy` workflow_dispatch run).

---

## Notes for the implementer

- **TDD discipline**: Task 3 follows strict TDD (red → green). Task 5 (hybrid test) is written before-the-fact but only verifiable post-deploy; document the expected behavior in test code regardless.
- **Worktree discipline**: All edits land in `D:/projects/tutorials-poc/.claude/worktrees/issue-385-pr1-schema`. After every commit, verify `cd D:/projects/tutorials-poc && git status -s` to ensure no writes leak to the parent. Memory `[feedback_subagent_writes_can_leak_to_parent_repo]`.
- **Line-ending discipline**: After every Edit, verify with `file <path> | grep -v CRLF || echo CRLF_DETECTED`. Memory `[feedback_crlf_regression_on_windows]`.
- **HANA uppercase**: HDI uppercases identifiers. The new `firstNotificationDate` will become `FIRSTNOTIFICATIONDATE` in `.hdbmigrationtable`. Memory `[reference_hana_raw_sql_uppercase]`.
- **HDI manual-resolve pattern**: When `cds build` emits `>>>>>` markers, the implementer MUST uncomment the DROP statements AND delete the `>>>>>` lines. Don't commit the file with `>>>>>` markers present — that's the signal that human review is pending.
- **Chain query fallback**: if `.columns('repository.repositoryOwner.email as email')` doesn't work on the installed CAP version, try `.columns('repository_repositoryOwner_email as email')` (underscore form) or `.columns(m => { m.repository.repositoryOwner.email.as('email'); })` (callback form). Report which form was used in the PR body.
- **Don't push without QA row-count check**: Step 0.5 says "verify QA HANA row count = 0" but is gated by access; if QA is inaccessible during execution, defer the check to Step 6.6 right before push. If still inaccessible, surface to Tom.
