# Fix Duplicate Slugs in Tutorials/Missions/Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 123 duplicate-slug groups currently in the live HANA `Tutorials` table (created during the 2026-06-16 cutover rehearsal), apply the same repair to `Missions` and `Groups` (preventatively), and add three guardrails — schema-level uniqueness, migrator-side upsert, and a hybrid test — so this class of bug cannot recur.

**Architecture:** Three-layer fix. **Data layer:** a one-shot, idempotent CJS repair script that snapshots, merges, and verifies; merge picks the publish-side row as canonical and copies forward `legacyId`, `mdFileUrl`, and other legacy-only fields *before* deleting the loser. **Schema layer:** add `@assert.unique` on `slug` for `Tutorials`, `Missions`, `Groups` so future colliding writes fail loud. **Migrator layer:** patch `migrate-from-hana.js` to do the same `LOWER(slug)=?` upsert as the publisher, plus a hybrid test that fails CI if any duplicate ever sneaks in.

**Tech Stack:** Node.js 22, CDS 9, SAP HANA Cloud, `cds.run()` raw SQL (CDS QL doesn't expose `LOWER()` portably across HANA/SQLite), Vitest hybrid project, `cds bind --exec` for live-DB scripts.

---

## Context for the Implementing Engineer

You may have zero context for this codebase. Read these before starting:

- [CLAUDE.md](../../../CLAUDE.md) — project overview, command reference, gotchas. Especially:
  - The "HANA LOB locator expiry" gotcha (we don't hit it here, but you'll see the pattern in `srv/lib/_tutorials-table.js`)
  - The "Tutorial slugs are lowercase canonical" gotcha — we are fixing the *write-side* mirror of that gotcha
  - The `cds.entities is Runtime-Only` memory referenced for CJS scripts
- [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js) — the migrator Tom ran during 2026-06-16 cutover rehearsal that created the duplicates
- [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js) lines 263–313 — the publish-side upsert that the migrator must mirror
- [srv/lib/_tutorials-table.js](../../../srv/lib/_tutorials-table.js) — the helper that returns dialect-specific table/column identifiers for HANA vs SQLite
- [scripts/repair-mixed-case-tutorial-duplicates.cjs](../../../scripts/repair-mixed-case-tutorial-duplicates.cjs) — a sibling repair script. Read it for the dry-run / commit / FK-redirect pattern. Our new script follows the same shape.

### Critical facts the engineer must understand

1. **CAP does not emit DB-level FK constraints.** Verified via `SYS.REFERENTIAL_CONSTRAINTS` — zero FKs reference Tutorials/Missions/Groups. So `UPDATE … SET tutorial_ID = winnerId WHERE tutorial_ID = loserId` works without cascade fights.

2. **TaskRecords is keyed on `taskLegacyId` (numeric), not on `tutorial_ID`.** Each tutorial may have thousands of TaskRecords (the worked example has 3,009 just for slug `hana-trial-advanced-analytics`). **The merge must copy `legacyId` from the loser onto the winner** before deleting the loser, otherwise every user's progress history orphans.

3. **The 123 dup-groups have a consistent shape:** one row was inserted by the migrator (`createdBy != 'anonymous'`, has `legacyId`, has `mdFileUrl`, often has null `stepCount`), and one was inserted by the publisher (`createdBy = 'anonymous'`, null `legacyId`, null `mdFileUrl`, has `stepCount`). The publish-side row has the *fresh* content data; the migrator row has the *user-progress join key*. Merge must keep both kinds of fields.

4. **`ContentFiles`, `TutorialFeedback.tutorialSlug`, and `ValidateAnswerSubmissions.tutorialSlug` are slug-keyed, not ID-keyed.** No FK redirect needed for those tables.

### Authoritative FK column list (probed live 2026-06-17)

These tables/columns must be redirected from loser → winner during merge:

**Tables that reference `Tutorials.ID`:**
- `COM_SAP_DEVELOPERS_IMS_CODECHECKSPECS.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_STEPS.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_TUTORIALCATEGORIES.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_TUTORIALMETA.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_TUTORIALS.REDIRECTTO_ID` (self-reference)
- `COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS.TUTORIAL_ID`
- `COM_SAP_DEVELOPERS_IMS_VALIDATEANSWERSPECS.TUTORIAL_ID`

**Tables that reference `Missions.ID`:**
- `COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS.MISSION_ID`
- `COM_SAP_DEVELOPERS_IMS_EVENTS.MISSION_ID`
- `COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES.MISSION_ID`
- `COM_SAP_DEVELOPERS_IMS_MISSIONSLUGREDIRECTS.MISSION_ID`
- `COM_SAP_DEVELOPERS_IMS_MISSIONTAGS.MISSION_ID`

**Tables that reference `Groups.ID`:**
- `COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS.GROUP_ID`
- `COM_SAP_DEVELOPERS_IMS_GROUPCATEGORIES.GROUP_ID`
- `COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS.GROUP_ID`
- `COM_SAP_DEVELOPERS_IMS_GROUPSLUGREDIRECTS.GROUP_ID`
- `COM_SAP_DEVELOPERS_IMS_GROUPTAGS.GROUP_ID`
- `COM_SAP_DEVELOPERS_IMS_MISSIONS.GROUP_ID`

If you discover any new FK column during execution (this list was probed 2026-06-17; new branches/codecheck/etc. tables may have landed), **STOP and add it to the redirect loop** — orphaned rows are silent corruption.

---

## File Structure

### Created

- `scripts/merge-duplicate-slugs.cjs` — one-shot repair script. Dry-run by default. CJS (not ESM) to match the existing repair-script pattern at [scripts/repair-mixed-case-tutorial-duplicates.cjs](../../../scripts/repair-mixed-case-tutorial-duplicates.cjs). Three modes: `--dry-run` (default), `--commit`, `--verify-only`. Writes a snapshot to `.migration-data/dup-merge-backup-<ISO>.json` before any DELETE.
- `test/hybrid/duplicate-slugs.test.js` — hybrid Vitest suite that runs `SELECT LOWER(slug), COUNT(*) … HAVING COUNT(*)>1` against `Tutorials`/`Missions`/`Groups` and fails if any group exists.

### Modified

- `db/schema.cds` — add `@assert.unique.slug : [slug]` on `Tutorials`, `Missions`, and `Groups`. This emits a named `UNIQUE` constraint in the generated `.hdbtable` artefact (per CAP docs: "CDL Compilation to Database-Specific DDLs > Keys, Constraints").
- `scripts/migrate-from-hana.js` — change the Tutorials/Missions/Groups insert path to do a `LOWER(slug)=?` lookup first and `UPDATE` if found. Same dialect helper as the publisher (`tutorialsTableInfo`).
- `CLAUDE.md` — add a "Slug uniqueness" gotcha entry pointing at the new test and the new repair script.

### NOT Touched

- `srv/lib/content-publish-session.js` and `srv/lib/content-store.js` — the publish path's upsert is correct as-is; it just lost a race with a buggy migrator. Once we add `@assert.unique`, an `UPDATE` on a colliding row would still update the wrong winner if duplicates somehow recurred — but `@assert.unique` will prevent the new row from being inserted in the first place. No code change needed here.

---

## Pre-flight Checks

Before any task, the engineer MUST confirm the environment.

- [ ] **Pre-1: Confirm working directory and branch**

```bash
pwd  # → D:\projects\tutorials-poc\.claude\worktrees\fix-duplicate-slugs (or wherever the worktree was created)
git branch --show-current  # → worktree-fix-duplicate-slugs (or your equivalent)
```

If you are NOT in a worktree off `main`, STOP and consult @superpowers:using-git-worktrees.

- [ ] **Pre-2: Confirm CF login and target**

```bash
cf target
```

Expected output must show `org=tutorial-system`, `space=dev`, `api endpoint = api.cf.eu10-005.hana.ondemand.com`. Per [cf target before push] memory, **a wrong target here can wipe IMS PROD data.** If the target is wrong:

```bash
cf target -o tutorial-system -s dev
```

- [ ] **Pre-3: Confirm HANA binding**

```bash
npx cds bind --exec -- node -e "console.log('ok')"
```

Expected: prints `ok`. If it errors, run `cf login` and retry.

- [ ] **Pre-4: Verify the bug still exists (sanity check)**

```bash
mkdir -p .migration-data
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  const r = await db.run(\`
    SELECT LOWER(SLUG) AS S, COUNT(*) AS C
      FROM COM_SAP_DEVELOPERS_IMS_TUTORIALS
     WHERE SLUG IS NOT NULL
     GROUP BY LOWER(SLUG)
    HAVING COUNT(*) > 1
  \`);
  console.log('Tutorials dup-groups:', r.length);
  process.exit(0);
})();
"
```

Expected: prints `Tutorials dup-groups: 123` (or similar number > 0).

If it prints `0`, the merge has already been completed by another agent or a prior partial run — that's fine, this script is idempotent. Run the broader verify-only check before skipping ahead:

```bash
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  for (const t of ['TUTORIALS','MISSIONS','GROUPS']) {
    const r = await db.run(\`SELECT COUNT(*) AS C FROM (
      SELECT LOWER(\"SLUG\") AS S FROM \"COM_SAP_DEVELOPERS_IMS_\${t}\"
       WHERE \"SLUG\" IS NOT NULL GROUP BY LOWER(\"SLUG\") HAVING COUNT(*)>1
    )\`);
    console.log(t, '=', r[0].C ?? r[0].c);
  }
  process.exit(0);
})();
"
```

If all three are zero, skip Tasks 2–4 and proceed directly to Task 5 (the schema guardrail still needs adding so future regressions fail fast).

---

## Task 1: Add hybrid test that catches duplicate slugs

This is task #1 deliberately. We want the test to **fail first** (proving it works), then turn green only after the data repair runs.

**Files:**
- Create: `test/hybrid/duplicate-slugs.test.js`

- [ ] **Step 1.1: Write the failing test**

Create `test/hybrid/duplicate-slugs.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// File lives under test/hybrid/ — picked up only by the "hybrid" Vitest
// project (vitest.config.ts), which runs `cds bind --exec` against the
// real HANA. The beforeAll() guard below FAILS hard if somehow run
// against SQLite, rather than silently passing on an empty schema.

describe('slug uniqueness invariant (issue: duplicate-slugs 2026-06-17)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'duplicate-slugs.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('Tutorials has no duplicate slugs (case-insensitive)', async () => {
    const dups = await db.run(`
      SELECT LOWER("SLUG") AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS"
       WHERE "SLUG" IS NOT NULL
       GROUP BY LOWER("SLUG")
      HAVING COUNT(*) > 1
       ORDER BY C DESC, S
    `);
    if (dups.length > 0) {
      const sample = dups.slice(0, 5).map(r => `  ${r.S} → ${r.C} rows`).join('\n');
      throw new Error(
        `Found ${dups.length} duplicate-slug group(s) in Tutorials. Sample:\n${sample}\n` +
        `Run: npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit`
      );
    }
    expect(dups.length).toBe(0);
  });

  it('Missions has no duplicate slugs (case-insensitive)', async () => {
    const dups = await db.run(`
      SELECT LOWER("SLUG") AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_MISSIONS"
       WHERE "SLUG" IS NOT NULL
       GROUP BY LOWER("SLUG")
      HAVING COUNT(*) > 1
    `);
    expect(dups, JSON.stringify(dups.slice(0, 5), null, 2)).toEqual([]);
  });

  it('Groups has no duplicate slugs (case-insensitive)', async () => {
    const dups = await db.run(`
      SELECT LOWER("SLUG") AS S, COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_GROUPS"
       WHERE "SLUG" IS NOT NULL
       GROUP BY LOWER("SLUG")
      HAVING COUNT(*) > 1
    `);
    expect(dups, JSON.stringify(dups.slice(0, 5), null, 2)).toEqual([]);
  });
});
```

- [ ] **Step 1.2: Run the test to verify it FAILS**

```bash
npm run test:hybrid -- test/hybrid/duplicate-slugs.test.js
```

Expected: FAIL on the Tutorials assertion with a sample listing 5 dup slugs.

- [ ] **Step 1.3: Commit the failing test**

```bash
git add test/hybrid/duplicate-slugs.test.js
git commit -m "test(slug-dedupe): add hybrid assertion for duplicate slugs

Currently FAILS — captures the 123 duplicate-slug groups in Tutorials
created during the 2026-06-16 cutover rehearsal. Will turn green once
scripts/merge-duplicate-slugs.cjs has run."
```

---

## Task 2: Build the repair script (dry-run mode)

We build the script in three commits: first the inspect/dry-run, then the snapshot, then the commit-mode merge. This keeps each commit reviewable and lets a reviewer verify the merge logic on real data without anything being written.

**Files:**
- Create: `scripts/merge-duplicate-slugs.cjs`

- [ ] **Step 2.1: Write the dry-run skeleton**

Create `scripts/merge-duplicate-slugs.cjs`:

```javascript
/* eslint-disable no-console */
/**
 * One-shot repair for duplicate slugs in Tutorials, Missions, and Groups.
 *
 * Background: the 2026-06-16 cutover rehearsal of scripts/migrate-from-hana.js
 * inserted rows whose SLUG had a `.md` suffix; the publish path's
 * LOWER(slug)=? lookup did not match those, so it INSERTed a duplicate.
 * A subsequent bulk UPDATE stripped `.md` from the migrated rows, leaving
 * 123 dup-groups in Tutorials.
 *
 * Strategy per dup-group:
 *   1. Pick the publish-side row as the WINNER (it has fresh stepCount,
 *      lowercase experienceTag, slug-format primaryTag — what the live
 *      site needs).
 *   2. Copy LEGACY-ONLY non-null fields (legacyId, mdFileUrl, featuredOrder,
 *      description, redirectTo_ID) from the loser onto the winner if the
 *      winner's value is null. Without this, the 3000+ TaskRecords keyed on
 *      taskLegacyId would orphan.
 *   3. Redirect every FK column in the project from loser.ID → winner.ID.
 *   4. Delete the loser.
 *
 * Modes:
 *   --dry-run     (default) — print every planned change, write nothing.
 *   --commit               — execute. Refuses to run without a fresh snapshot.
 *   --verify-only          — print remaining dup-groups, exit 0/2.
 *   --table=tutorials      — restrict to one of: tutorials | missions | groups.
 *
 * Run via:  npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERIFY_ONLY = argv.includes('--verify-only');
const TABLE_FILTER = (argv.find(a => a.startsWith('--table=')) || '').split('=')[1];
if (COMMIT && VERIFY_ONLY) {
  console.error('--commit and --verify-only are mutually exclusive');
  process.exit(1);
}

// Dialect identifiers: HANA only. Throw if SQLite — running this against
// the in-memory dev DB makes no sense.
function ident() {
  return {
    tables: {
      tutorials: '"COM_SAP_DEVELOPERS_IMS_TUTORIALS"',
      missions:  '"COM_SAP_DEVELOPERS_IMS_MISSIONS"',
      groups:    '"COM_SAP_DEVELOPERS_IMS_GROUPS"',
    },
    cols: {
      id: '"ID"',
      slug: '"SLUG"',
      createdAt: '"CREATEDAT"',
      createdBy: '"CREATEDBY"',
      legacyId: '"LEGACYID"',
    },
  };
}

// FK columns referencing Tutorials.ID / Missions.ID / Groups.ID, probed
// live 2026-06-17. If you add a new entity that associates to one of these,
// extend this map AND test/hybrid/duplicate-slugs.test.js.
const FK_REDIRECTS = {
  tutorials: [
    ['"COM_SAP_DEVELOPERS_IMS_CODECHECKSPECS"',         '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"',    '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS"',         '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_STEPS"',                  '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALCATEGORIES"',     '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALCONTRIBUTORS"',   '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"',      '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"',           '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALREPOSITORIES"',   '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALS"',              '"REDIRECTTO_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_TUTORIALTAGS"',           '"TUTORIAL_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_VALIDATEANSWERSPECS"',    '"TUTORIAL_ID"'],
  ],
  missions: [
    ['"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHS"',        '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_EVENTS"',                 '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONCATEGORIES"',      '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONSLUGREDIRECTS"',   '"MISSION_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONTAGS"',            '"MISSION_ID"'],
  ],
  groups: [
    ['"COM_SAP_DEVELOPERS_IMS_COMPLETIONPATHITEMS"',    '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPCATEGORIES"',        '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPPATHITEMS"',         '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPSLUGREDIRECTS"',     '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_GROUPTAGS"',              '"GROUP_ID"'],
    ['"COM_SAP_DEVELOPERS_IMS_MISSIONS"',               '"GROUP_ID"'],
  ],
};

// Columns we copy from loser → winner if winner's value is null. Each entry
// is [column-name, treat-zero-as-null]. legacyId is the critical one.
const CARRY_FORWARD = {
  tutorials: [
    ['"LEGACYID"', false],
    ['"MDFILEURL"', false],
    ['"FEATUREDORDER"', false],
    ['"DESCRIPTION"', false],
    ['"REDIRECTTO_ID"', false],
  ],
  missions: [['"LEGACYID"', false], ['"DESCRIPTION"', false], ['"GROUP_ID"', false]],
  groups:   [['"LEGACYID"', false], ['"DESCRIPTION"', false]],
};

async function main() {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  const I = ident();
  // Order matters: groups must be merged BEFORE missions (Missions.GROUP_ID
  // is a carry-forward field for missions, so group-loser IDs must already
  // be redirected when we evaluate that carry-forward), and missions before
  // tutorials by symmetry. The default reflects this — do not flip.
  const tables = TABLE_FILTER ? [TABLE_FILTER] : ['groups', 'missions', 'tutorials'];
  for (const t of tables) {
    if (!I.tables[t]) {
      console.error(`Unknown --table=${t}. Pick one of tutorials, missions, groups.`);
      process.exit(1);
    }
  }

  if (VERIFY_ONLY) {
    let total = 0;
    for (const t of tables) {
      const dups = await findDups(db, I, t);
      console.log(`${t}: ${dups.length} dup-group(s)`);
      total += dups.length;
    }
    process.exit(total === 0 ? 0 : 2);
  }

  // Dry-run / commit path
  const summary = { tables: {} };
  for (const t of tables) {
    summary.tables[t] = await processTable(db, I, t, COMMIT);
  }
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
  if (!COMMIT) {
    console.log('\nDry-run complete. Re-run with --commit to apply.');
  }
}

async function findDups(db, I, table) {
  return db.run(`
    SELECT LOWER(${I.cols.slug}) AS S, COUNT(*) AS C
      FROM ${I.tables[table]}
     WHERE ${I.cols.slug} IS NOT NULL
     GROUP BY LOWER(${I.cols.slug})
    HAVING COUNT(*) > 1
     ORDER BY S
  `);
}

async function processTable(db, I, table, commit) {
  const dups = await findDups(db, I, table);
  console.log(`\n--- ${table}: ${dups.length} dup-group(s) ---`);
  let merged = 0;
  let casingChecked = false;
  for (const g of dups) {
    const slug = g.S;
    const rows = await db.run(
      `SELECT * FROM ${I.tables[table]} WHERE LOWER(${I.cols.slug}) = ?`,
      [slug]
    );

    // One-time sanity check: every column lookup in this script assumes
    // the HANA driver returns row keys in UPPERCASE (because we SELECT
    // from a quoted upper-case table). If the keys come back lowercase,
    // we are connected to SQLite by accident — fail loud.
    if (!casingChecked && rows.length > 0) {
      casingChecked = true;
      const keys = Object.keys(rows[0]);
      if (!keys.includes('ID') || !keys.includes('SLUG')) {
        throw new Error(
          `Row keys are not uppercase as expected. Got: ${keys.join(', ')}\n` +
          `Are you connected to HANA? Run with: cds bind --exec -- node ...`
        );
      }
    }

    // Winner = the row whose CREATEDBY = 'anonymous' (publish path).
    // Fallback: newest CREATEDAT.
    const publishRows = rows.filter(r => r.CREATEDBY === 'anonymous');
    const winner = publishRows.length === 1
      ? publishRows[0]
      : rows.slice().sort((a, b) => (b.CREATEDAT > a.CREATEDAT ? 1 : -1))[0];
    const losers = rows.filter(r => r.ID !== winner.ID);

    console.log(`  slug=${slug}: winner=${winner.ID.slice(0,8)} losers=[${losers.map(l => l.ID.slice(0,8)).join(',')}]`);

    // Step 2.1.x is implemented in subsequent steps. Dry-run prints the plan.
    if (!commit) continue;

    // (Commit logic added in later steps)
    throw new Error('Commit mode not yet implemented; rebuild after step 2.3');
  }
  return { dupCount: dups.length, merged };
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2.2: Run dry-run and confirm output**

```bash
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --dry-run
```

Expected: prints `tutorials: 123 dup-group(s)` (or current count), then 123 lines like `  slug=hana-trial-advanced-analytics: winner=c9cd2dc8 losers=[9c33332c]`. **No DB writes.**

Verify: re-run the pre-flight dup count from Pre-4. The number must be unchanged.

- [ ] **Step 2.3: Commit the dry-run skeleton**

```bash
git add scripts/merge-duplicate-slugs.cjs
git commit -m "scripts(slug-dedupe): add dry-run scaffold for duplicate-slug merge

Identifies dup-groups, picks publish-side row as winner. Commit-mode
not yet implemented (errors out). Probes 123 Tutorials dup-groups +
0 Missions/Groups dup-groups against live DEV HANA."
```

---

## Task 3: Add snapshot-before-write

Per [HDI Deploys Can Wipe Data] memory and Tom's preference: snapshot every affected row before any DELETE. Reversible.

**Files:**
- Modify: `scripts/merge-duplicate-slugs.cjs`

- [ ] **Step 3.1: Add the snapshot helper**

In `scripts/merge-duplicate-slugs.cjs`, replace the `if (!commit) continue;` line and the `throw new Error(...)` with the snapshot+merge logic. Insert this AFTER the `losers` line and BEFORE the `if (!commit) continue;` deletion:

```javascript
    // Pre-merge snapshot: every row about to be touched, plus every FK row
    // about to be redirected. Written once per run, append-mode.
    if (commit) await ensureSnapshot(db, I, table, rows, FK_REDIRECTS[table]);
```

Add at top of file (after `path = require('node:path')`):

```javascript
const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `dup-merge-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);
let snapshotInited = false;
function appendSnapshot(record) {
  if (!snapshotInited) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    snapshotInited = true;
  }
  fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
}

async function ensureSnapshot(db, I, table, rows, fkList) {
  // Snapshot the duplicate Tutorial/Mission/Group rows themselves.
  for (const r of rows) {
    appendSnapshot({ kind: 'row', table: I.tables[table], data: r });
  }
  // Snapshot every FK row about to be redirected.
  for (const [tbl, col] of fkList) {
    for (const r of rows) {
      const refs = await db.run(`SELECT * FROM ${tbl} WHERE ${col} = ?`, [r.ID]);
      for (const ref of refs) {
        appendSnapshot({ kind: 'fk', table: tbl, col, fromId: r.ID, data: ref });
      }
    }
  }
}
```

Add a banner near the start of `main()` so the user sees the snapshot path:

```javascript
  if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);
```

- [ ] **Step 3.2: Manually verify snapshot writes correctly**

Temporarily change the `throw new Error(...)` line to `if (commit) throw new Error('STOP_AFTER_SNAPSHOT')` and run:

```bash
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit
```

Expected: prints snapshot path, errors out with `STOP_AFTER_SNAPSHOT`, but `.migration-data/dup-merge-backup-*.jsonl` exists and has > 246 lines (246 row snapshots + thousands of FK snapshots — Steps alone has ~1300 rows referencing duplicates).

Verify the snapshot is well-formed:

```bash
ls -lh .migration-data/dup-merge-backup-*.jsonl
head -5 .migration-data/dup-merge-backup-*.jsonl
wc -l .migration-data/dup-merge-backup-*.jsonl
```

Then revert the temporary `STOP_AFTER_SNAPSHOT` change (it'll be replaced by the merge logic in Task 4).

- [ ] **Step 3.3: Commit**

```bash
git add scripts/merge-duplicate-slugs.cjs
git commit -m "scripts(slug-dedupe): snapshot affected rows before merge

Snapshots both the dup rows themselves and every FK row about to be
redirected, to .migration-data/dup-merge-backup-<timestamp>.jsonl.
Append-mode JSONL so a partial run is still useful for forensics."
```

---

## Task 4: Implement the merge (commit mode)

This is the destructive step. Each merge is wrapped in a HANA transaction so a partial failure leaves the row pair intact.

**Files:**
- Modify: `scripts/merge-duplicate-slugs.cjs`

- [ ] **Step 4.1: Replace the commit-mode placeholder with the merge**

Replace the entire body of the `for (const g of dups) { … }` loop (the part after the snapshot call) with:

```javascript
    if (!commit) continue;

    // KEY-CASING NOTE: every SELECT in this script targets a quoted
    // upper-case table name (e.g. "COM_SAP_DEVELOPERS_IMS_TUTORIALS").
    // HANA preserves case for quoted identifiers, so result rows always
    // come back keyed UPPERCASE: r.ID, r.SLUG, r.LEGACYID, r.CREATEDAT,
    // etc. Sanity-check this once on first run with:
    //     console.log(Object.keys(rows[0]));
    // If the keys come back lowercase, the script is connected to SQLite
    // (e.g. accidentally without `cds bind --exec`) — abort.
    const colKey = (q) => q.replace(/"/g, '');  // '"LEGACYID"' -> 'LEGACYID'

    // Wrap the per-slug merge in a transaction so a mid-merge failure
    // leaves the original row pair intact rather than half-redirecting
    // FKs and then crashing.
    await db.tx(async tx => {

      // 1. Carry forward legacy-only fields. This is the critical step:
      //    TaskRecords are keyed on legacyId (numeric), not tutorial_ID.
      //    Without this, every user's progress history orphans.
      //
      //    Edge case: the carried-forward column may itself be a self-ref
      //    (e.g. Tutorials.REDIRECTTO_ID) pointing at another loser ID
      //    that gets deleted later in this same run. Map donor's value
      //    through the loser-set so we never carry a dangling reference.
      const sets = [];
      const params = [];
      for (const [colQ] of CARRY_FORWARD[table]) {
        const colName = colKey(colQ);
        const donor = losers.find(l => l[colName] !== null && l[colName] !== undefined);
        const winnerVal = winner[colName];
        if (!donor) continue;
        if (winnerVal !== null && winnerVal !== undefined) continue;

        let donorVal = donor[colName];

        // If the donor value is itself a loser ID we are about to delete,
        // remap it to that loser's winner. For the simple two-row dup-group
        // case this collapses to a self-loop — null it out instead of
        // pointing at the winner row itself.
        if (typeof donorVal === 'string' && allLoserIds.has(donorVal)) {
          const target = allLoserIdToWinnerId.get(donorVal);
          donorVal = (target === winner.ID) ? null : target;
        }

        sets.push(`${colQ} = ?`);
        params.push(donorVal);
      }
      if (sets.length > 0) {
        params.push(winner.ID);
        await tx.run(
          `UPDATE ${I.tables[table]} SET ${sets.join(', ')} WHERE ${I.cols.id} = ?`,
          params
        );
      }

      // 2. Redirect every FK column from loser.ID -> winner.ID. CAP doesn't
      //    emit DB-level FK constraints (verified via SYS.REFERENTIAL_CONSTRAINTS),
      //    so plain UPDATE works without cascade fights.
      for (const loser of losers) {
        for (const [tbl, col] of FK_REDIRECTS[table]) {
          const r = await tx.run(
            `UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`,
            [winner.ID, loser.ID]
          );
          if (typeof r === 'number' && r > 50) {
            console.log(`    ${tbl}.${col}: ${r} rows`);
          }
        }
      }

      // 3. Delete the loser row(s). At this point nothing references them.
      for (const loser of losers) {
        await tx.run(
          `DELETE FROM ${I.tables[table]} WHERE ${I.cols.id} = ?`,
          [loser.ID]
        );
      }
    });

    merged++;
```

The merge above references two precomputed sets — `allLoserIds` and `allLoserIdToWinnerId` — that must be populated BEFORE the per-slug loop. Add this near the top of `processTable`, immediately after the `findDups` call:

```javascript
  // Pre-compute the full loser set across this table so the carry-forward
  // step can detect self-references that would dangle after deletion.
  // Self-ref columns we care about: Tutorials.REDIRECTTO_ID, Missions.GROUP_ID.
  const allLoserIds = new Set();
  const allLoserIdToWinnerId = new Map();
  for (const g of dups) {
    const slug = g.S;
    const rs = await db.run(
      `SELECT ${I.cols.id}, ${I.cols.createdBy}, ${I.cols.createdAt}
         FROM ${I.tables[table]} WHERE LOWER(${I.cols.slug}) = ?`,
      [slug]
    );
    const pubRows = rs.filter(r => r.CREATEDBY === 'anonymous');
    const w = pubRows.length === 1
      ? pubRows[0]
      : rs.slice().sort((a, b) => (b.CREATEDAT > a.CREATEDAT ? 1 : -1))[0];
    for (const r of rs) {
      if (r.ID !== w.ID) {
        allLoserIds.add(r.ID);
        allLoserIdToWinnerId.set(r.ID, w.ID);
      }
    }
  }
```

- [ ] **Step 4.2: Re-run dry-run to confirm code parses**

```bash
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --dry-run
```

Expected: same output as Step 2.2 — still 123 dup-groups, no writes.

- [ ] **Step 4.3: Run --commit on a SINGLE table first**

Per [Confirm Deploy Scope] memory: never bulk-mutate without a smoke run. Restrict to Tutorials and run:

```bash
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit --table=tutorials
```

Expected output ends with:

```
=== SUMMARY ===
{
  "tables": {
    "tutorials": { "dupCount": 123, "merged": 123 }
  }
}
```

- [ ] **Step 4.4: Verify the live DB is clean for Tutorials**

```bash
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --verify-only --table=tutorials
echo "exit=$?"
```

Expected: prints `tutorials: 0 dup-group(s)` and `exit=0`.

- [ ] **Step 4.5: Spot-check the worked example**

```bash
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  const r = await db.run(\`SELECT \"ID\", \"LEGACYID\", \"STATUS\", \"STEPCOUNT\", \"PRIMARYTAG\", \"MDFILEURL\"
    FROM \"COM_SAP_DEVELOPERS_IMS_TUTORIALS\"
    WHERE LOWER(\"SLUG\") = 'hana-trial-advanced-analytics'\`);
  console.log(JSON.stringify(r, null, 2));
  process.exit(0);
})();
"
```

Expected: ONE row with `LEGACYID: 11415` (carried forward from loser), `STEPCOUNT: 13` (from publish), `STATUS: 'ACTIVE'` (from publish), `MDFILEURL: 'https://github.com/...'` (carried forward), `PRIMARYTAG: 'products>sap-hana'` (from publish — the slug-format tag).

- [ ] **Step 4.6: Run the hybrid test from Task 1 to confirm green**

```bash
npm run test:hybrid -- test/hybrid/duplicate-slugs.test.js
```

Expected: 3/3 pass.

- [ ] **Step 4.7: Commit Tutorials repair**

```bash
git add scripts/merge-duplicate-slugs.cjs
git commit -m "scripts(slug-dedupe): implement commit mode + repair Tutorials live

123 Tutorials dup-groups merged on tutorial-system DEV. Each merge:
1. Carries forward legacyId/mdFileUrl/etc. from loser to winner.
2. Redirects FK rows on 12 child tables.
3. Deletes loser.

Snapshot at .migration-data/dup-merge-backup-<ts>.jsonl (gitignored).
Worked example (legacyId=11415) verified: 3009 TaskRecords now resolve."
```

- [ ] **Step 4.8: Run --commit for Missions and Groups**

```bash
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit --table=missions
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit --table=groups
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --verify-only
echo "exit=$?"
```

Expected: each table prints its own dup count (probably 0 if our pre-flight numbers held). Final verify-only prints all three tables with `0 dup-group(s)` and `exit=0`. If Missions/Groups have non-zero dup-groups, they're merged using the same logic; spot-check a few via Step 4.5's pattern.

- [ ] **Step 4.9: Commit run-log if Missions/Groups had any merges**

If non-zero merges happened, commit a one-line note:

```bash
git commit --allow-empty -m "data(slug-dedupe): repaired N Missions / M Groups dup-groups on DEV"
```

Otherwise skip.

---

## Task 5: Add @assert.unique to schema (the guardrail)

Now that the data is clean, we add the schema-level constraint that would have prevented this in the first place.

**Files:**
- Modify: `db/schema.cds:27` (Tutorials), `:45` (Missions), `:61` (Groups)

- [ ] **Step 5.1: Verify CAP supports `@assert.unique` for the field name `slug`**

Per the global CLAUDE.md rule "always check CAP docs via cds-mcp before modifying CDS models":

```
Use mcp__plugin_cds-mcp_cds-mcp__search_docs with query: "@assert.unique"
```

Expected hit: docs page describing `@assert.unique.<name> : [field1, field2]` syntax. Confirm the annotation lives at the entity level, NOT field level, and that it deploys as a `UNIQUE` index on HANA.

- [ ] **Step 5.2: Add the annotations**

Edit [db/schema.cds](../../../db/schema.cds). Locate the three entity declarations: `entity Tutorials : TaskBase`, `entity Missions : TaskBase`, `entity Groups : TaskBase`. Insert the annotation IMMEDIATELY before each `entity` keyword:

```cds
@assert.unique.slug : [slug]
entity Tutorials : TaskBase { … }

@assert.unique.slug : [slug]
entity Missions : TaskBase { … }

@assert.unique.slug : [slug]
entity Groups : TaskBase { … }
```

This is the canonical dot-form per the CAP docs ("CDL Compilation to Database-Specific DDLs > Keys, Constraints"). The annotation name (`slug`) becomes the DB constraint name; the array is the field list (single-field uniqueness here, but the array form is required by the compiler).

- [ ] **Step 5.3: Build and inspect the generated HDI artefact**

```bash
npx cds build --for hana
ls db/src/gen/com.sap.developers.ims-Tutorials.hdbtable | head -5
grep -i unique db/src/gen/com.sap.developers.ims-Tutorials.hdbtable
```

Expected: hdbtable file exists; `UNIQUE` keyword on the `slug` column.

If `cds build` errors or the UNIQUE keyword is absent, **STOP** and consult @superpowers:systematic-debugging. Do NOT skip the build artefact check.

- [ ] **Step 5.4: Run unit tests (in-memory SQLite path)**

```bash
npm test -- --reporter=default 2>&1 | tail -20
```

Expected: 0 new failures. If there's a test that asserts insert-by-slug-twice succeeds (unlikely but possible), it'll surface here. Read failures and fix.

- [ ] **Step 5.5: Commit**

```bash
git add db/schema.cds
git commit -m "schema(slug-dedupe): add @assert.unique on Tutorials/Missions/Groups.slug

Closes the architectural hole that allowed scripts/migrate-from-hana.js
to silently insert duplicate slugs against the publish path's
LOWER(slug)=? upsert. Going forward, any colliding INSERT fails at
the DB layer before silent corruption can spread."
```

---

## Task 6: Patch migrate-from-hana.js to upsert on slug

Belt-and-braces: even with `@assert.unique`, we want the migrator to NOT throw on the next cutover rehearsal. It should detect existing rows and UPDATE them instead.

**Files:**

- Modify: `scripts/migrate-from-hana.js` — the `migrateEntity` helper and the three calls (`name: 'tutorials'`, `name: 'missions'`, `name: 'groups'`).

- [ ] **Step 6.1: Read the current migrator insert path**

Open [scripts/migrate-from-hana.js](../../../scripts/migrate-from-hana.js). Locate the `migrateEntity` function definition (search for `async function migrateEntity`) and the three `results.push(await migrateEntity(...))` callers whose `name:` field is `'tutorials'`, `'missions'`, and `'groups'`. Read each end-to-end before editing — line numbers may have shifted since this plan was written. Note that `migrateEntity` currently batches plain INSERTs.

- [ ] **Step 6.2: Add a slug-aware upsert hook**

Modify `migrateEntity` so callers can pass an optional `upsertOnSlug: true` flag. When set, BEFORE batch-INSERT, the helper looks up existing rows by `LOWER(SLUG)` and partitions inputs into INSERT vs UPDATE buckets.

Suggested implementation sketch (the engineer may need to adapt based on actual code structure):

```javascript
async function migrateEntity(source, target, T, opts) {
  const { name, sourceQuery, targetTable, mapRow, upsertOnSlug = false } = opts;
  const rawRows = await source.run(sourceQuery);
  const mapped = rawRows.map(mapRow);

  if (upsertOnSlug && mapped.length > 0) {
    // Look up which slugs already exist in target.
    const slugs = mapped.map(r => (r.SLUG || '').toLowerCase()).filter(Boolean);
    const existing = slugs.length === 0 ? [] : await target.run(
      `SELECT "ID", LOWER("SLUG") AS S FROM "${T}"."${targetTable}"
        WHERE LOWER("SLUG") IN (${slugs.map(() => '?').join(',')})`,
      slugs
    );
    const existingMap = new Map(existing.map(r => [r.S, r.ID]));

    const inserts = [];
    const updates = [];
    for (const row of mapped) {
      const key = (row.SLUG || '').toLowerCase();
      if (existingMap.has(key)) {
        updates.push({ ...row, ID: existingMap.get(key) });
      } else {
        inserts.push(row);
      }
    }
    // … run UPDATEs, then INSERTs (existing batch-insert code) …
  } else {
    // … existing batch-insert path unchanged …
  }
}
```

Then in the three callers (search for `name: 'tutorials'`, `name: 'missions'`, `name: 'groups'` in the same file), add `upsertOnSlug: true`.

- [ ] **Step 6.3: Add a unit test for the upsert hook**

Create or extend a unit test under `test/scripts/migrate-from-hana.test.js` (create if missing) that exercises the new code path against the in-memory SQLite DB. Pre-seed one row with `slug='foo'`, then call the upsert helper with a payload containing `slug='Foo'` (mixed case). Assert exactly one row exists after, and that its `title` matches the new payload.

- [ ] **Step 6.4: Run the unit test**

```bash
npm test -- test/scripts/migrate-from-hana.test.js
```

Expected: PASS.

- [ ] **Step 6.5: Commit**

```bash
git add scripts/migrate-from-hana.js test/scripts/migrate-from-hana.test.js
git commit -m "scripts(slug-dedupe): make migrate-from-hana upsert on slug

Mirrors the publish-side LOWER(slug)=? upsert in
srv/lib/content-publish-session.js so a re-run of the cutover migrator
no longer creates duplicates on top of already-published rows.
Belt-and-braces: @assert.unique would also block this, but a clean
no-op on re-run is friendlier than a constraint violation."
```

---

## Task 7: Verification + docs

- [ ] **Step 7.1: Full hybrid suite**

```bash
npm run test:hybrid 2>&1 | tail -30
```

Expected: all tests pass, including the three new ones from Task 1.

- [ ] **Step 7.2: Manually verify in admin UI**

Hit the deployed admin /admin-ui/#tutorials-display, search for "Thomas". Expected: TWO rows shown (one ACTIVE `hana-trial-advanced-analytics`, one DELETED `hxe-k8s-advanced-analytics`) — not three.

- [ ] **Step 7.3: Update CLAUDE.md gotchas**

Add this entry to the Gotchas section of [CLAUDE.md](../../../CLAUDE.md), alphabetically near the other slug-related entries:

```markdown
- **Tutorial/Mission/Group slugs are unique (case-insensitive)** — `db/schema.cds` declares `@assert.unique.slug : [slug]` on `Tutorials`, `Missions`, `Groups`. Any new write path (migrators, importers, repair scripts) MUST upsert on slug, not blind-INSERT. The publish path's pattern at [srv/lib/content-publish-session.js:285](srv/lib/content-publish-session.js#L285) is canonical: `SELECT id FROM table WHERE LOWER(slug)=?` then UPDATE-or-INSERT. The hybrid test [test/hybrid/duplicate-slugs.test.js](test/hybrid/duplicate-slugs.test.js) fails CI if duplicates ever sneak in. To repair an existing dup-group: `npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --commit`.
```

- [ ] **Step 7.4: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs(slug-dedupe): document slug-uniqueness invariant and repair script"
```

- [ ] **Step 7.5: Push branch and open PR**

Per [PR Over Direct Merge] memory: PR not direct merge.

```bash
git push -u origin worktree-fix-duplicate-slugs
gh pr create --title "fix(#TBD): merge duplicate slugs + add @assert.unique guardrail" \
  --body "Repairs 123 Tutorials dup-groups created during the 2026-06-16 cutover rehearsal. Adds @assert.unique on Tutorials/Missions/Groups.slug, patches migrate-from-hana.js to upsert on slug, and adds a hybrid test that fails CI on duplicate slugs.

Closes #TBD.

## Live DEV repair already executed
- Tutorials: 123 → 0 dup-groups
- Missions: 0 → 0
- Groups: 0 → 0
- Snapshot: .migration-data/dup-merge-backup-*.jsonl (locally, not pushed)

## Verification
- npm run test:hybrid → 3/3 new assertions green
- /admin-ui/#tutorials-display shows expected single ACTIVE row for the worked example (legacyId=11415)
- 3009 TaskRecords for legacyId=11415 still resolve (legacyId carried forward, not lost)
"
```

---

## Rollback procedure (if anything goes wrong on PROD)

If the merge produces wrong results on a future PROD run:

1. Locate the snapshot file: `.migration-data/dup-merge-backup-<timestamp>.jsonl`.
2. Each line is JSON of the form `{kind, table, data, ...}`. Reverse the merge by:
   - For each `{kind: 'row'}` line — re-INSERT the row.
   - For each `{kind: 'fk', table, col, fromId, data}` line — re-set `data.<col> = fromId` (the FK redirect target).
3. A reverse script can be written ad-hoc; the snapshot is the source of truth.

Snapshot format is JSONL specifically so a partial reverse is feasible (parse and apply line-by-line).

**Note on tx-rolled-back runs:** the snapshot is written before the per-slug transaction begins, so if a transaction rolls back mid-merge, the snapshot file will contain entries for rows that were NOT actually mutated. This is harmless for forensics (extra noise, no data loss) and reverse-replay is idempotent — a re-INSERT of an unchanged row hits the existing PK and is a clean no-op.

---

## Out of Scope

- **Static URLs / sitemaps / SEO redirects.** None of the duplicate-slug pairs share their slug with a previously-public page that's no longer reachable; the public URL was always `/tutorials/<slug>` and that resolves either way.
- **Tutorial soft-delete cleanup.** The 2018 row `663b54dc…` (slug `hxe-k8s-advanced-analytics`, STATUS=DELETED) is unrelated and will remain. It's a real history record.
- **TaskRecords reconciliation.** Once `legacyId` is carried forward, all 3,009 TaskRecords for legacyId=11415 (and the equivalent for the other 122 dup-groups) keep working without any change.
- **Embedding regeneration.** The publish-side row already has its embedding row in `TutorialEmbedding`; the legacy row didn't. After merge the winner keeps its embedding — nothing to regenerate.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| New FK column landed since 2026-06-17 probe | Medium | Pre-flight runs the broader probe again as Step 0; commit-mode also surfaces orphan-after-merge counts |
| `@assert.unique` deploy fails because schema migration drops UNIQUE on existing duplicates first | Low | Schema change ships AFTER data repair; verify-only confirms 0 dups before Task 5 |
| Wrong row picked as winner | Low | Pre-flight spot-check at Step 4.5; snapshot allows full revert |
| 3009 TaskRecords orphaned per dup-group | Medium-High if legacyId not carried | CARRY_FORWARD bakes legacyId into the merge as the FIRST field; spot-check verifies |
| `cf target` points at IMS PROD | Catastrophic | Pre-flight Step Pre-2; per [cf target before push] memory |

---

## Notes for the reviewer

- The merge picks the publish row as canonical because it has the freshest content data (stepCount, lowercase tags, slug-format primaryTag) — that's what the live site reads. The legacy row's *only* irreplaceable contribution is `legacyId` (TaskRecords join key) and `mdFileUrl`, both of which are explicitly carried forward.
- We use `@assert.unique` rather than a raw `.hdbindex` on UNIQUE because CAP-emitted artefacts are the canonical source. Per [HDI .hdbindex syntax] memory, hand-rolled HDI artefacts are a footgun.
- The snapshot path `.migration-data/dup-merge-backup-*.jsonl` is gitignored ([.gitignore](../../../.gitignore) `.migration-data/`).
