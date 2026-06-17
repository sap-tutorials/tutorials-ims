# Fix Duplicate TutorialMeta Implementation Plan (follow-up to PR #386)

> **For agentic workers:** Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Eliminate the 123 tutorials that have 2 `TutorialMeta` rows each (created during the duplicate-slug merge in PR #386 because `TutorialMeta` is `cuid` not `singleton`), enforce singleton uniqueness via `@assert.unique.tutorial`, update the merge script for future correctness, and add a hybrid regression test.

**Architecture:** Five-layer fix mirroring the duplicate-slugs PR pattern. **Pure helper:** `pickCanonicalMeta(rows)` extracted into a unit-tested function. **Repair script:** [scripts/dedupe-tutorial-meta.cjs](../../scripts/dedupe-tutorial-meta.cjs) — snapshot-then-delete, idempotent, dry-run by default. **Schema constraint:** `@assert.unique.tutorial : [tutorial]` on `TutorialMeta`. **Merge script:** add a `'singleton'` kind to `FK_REDIRECTS` so the merge logic understands logical-singleton tables. **Regression test:** [test/hybrid/duplicate-tutorial-meta.test.js](../../test/hybrid/duplicate-tutorial-meta.test.js).

**Tech Stack:** Same as PR #386 (Node.js 22, CDS 9, HANA Cloud, raw SQL via `db.run`, Vitest hybrid project, `cds bind --exec`).

---

## Context

The duplicate-slugs merge in PR #386 worked because `TutorialMeta.tutorial_ID` was treated as a simple FK column (cuid PK on `ID`). The merge correctly redirected the loser's `TutorialMeta` rows onto the winner — but didn't dedupe them, because `TutorialMeta` lacked any uniqueness invariant. Result: every merged tutorial now has 2 rows.

This is logically wrong: `TutorialMeta` is a one-row-per-tutorial review-state record. Its `tutorial` association should be the de-facto primary key. Any code that does `SELECT.one.from(TutorialMeta).where({ tutorial_ID })` (the publish-side auto-init does this) will pick whichever row HANA returns first — non-deterministic. The admin UI's `meta.owner` field group binding picks the older row (Michelle Wang in our case), while Tutorial Health's filter picks the row with `monitoredStatus=ACTIVE` and `notificationNumber>0` (Thomas Jung). Two views, two answers.

Diagnosed live 2026-06-17: 123 tutorials with 2 `TutorialMeta` rows each. Distribution: every dup is exactly 2 (no triples). 123 redundant rows total to delete.

---

## Task 1: Add hybrid test that catches duplicate TutorialMeta

TDD-style: failing first, turns green after Task 3 repair runs.

**Files:**

- Create: `test/hybrid/duplicate-tutorial-meta.test.js`

- [ ] **Step 1.1: Write the failing test**

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

// Hybrid-only — see beforeAll guard. Mirrors duplicate-slugs.test.js.
describe('TutorialMeta singleton invariant (follow-up to PR #386)', () => {
  let db;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    if (!isHana) {
      throw new Error(
        'duplicate-tutorial-meta.test.js must run against HANA. ' +
        'Run via `npm run test:hybrid` after `cds bind` to the DEV space.'
      );
    }
  });

  it('TutorialMeta has at most one row per tutorial', async () => {
    const dups = await db.run(`
      SELECT "TUTORIAL_ID", COUNT(*) AS C
        FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"
       WHERE "TUTORIAL_ID" IS NOT NULL
       GROUP BY "TUTORIAL_ID"
      HAVING COUNT(*) > 1
       ORDER BY C DESC
    `);
    if (dups.length > 0) {
      const sample = dups.slice(0, 5).map(r => `  ${r.TUTORIAL_ID} → ${r.C} rows`).join('\n');
      throw new Error(
        `Found ${dups.length} tutorial(s) with > 1 TutorialMeta row. Sample:\n${sample}\n` +
        `Run: npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --commit`
      );
    }
    expect(dups.length).toBe(0);
  });
});
```

- [ ] **Step 1.2: Run, confirm FAIL** with `Found 123 tutorial(s)…`.

- [ ] **Step 1.3: Commit**

```bash
git add test/hybrid/duplicate-tutorial-meta.test.js
git commit -m "test(meta-dedupe): add hybrid assertion for duplicate TutorialMeta

Currently FAILS — captures the 123 tutorials with 2 TutorialMeta rows
each, created by the slug-merge in PR #386 (TutorialMeta lacks a
uniqueness invariant on tutorial_ID). Will turn green after the
dedupe script runs and @assert.unique lands."
```

---

## Task 2: Build the dedupe script with a pure picker

**Files:**

- Create: `scripts/lib/pick-canonical-meta.cjs` — pure, exported, unit-tested
- Create: `scripts/dedupe-tutorial-meta.cjs` — the live-DB repair tool
- Create: `test/scripts/pick-canonical-meta.test.js` — unit tests for the picker

- [ ] **Step 2.1: Write the picker as a pure function**

`scripts/lib/pick-canonical-meta.cjs`:

```javascript
/**
 * Pick the canonical TutorialMeta row when a tutorial has multiple rows.
 *
 * Priority (highest first):
 *   1. Non-null OWNER beats null OWNER.
 *   2. Higher NOTIFICATIONNUMBER wins.
 *   3. More recent REVIEWEDDATE wins (null treated as older than any date).
 *   4. More recent MODIFIEDAT wins (final non-empty tiebreaker).
 *   5. Lower LEGACYID wins (deterministic tiebreaker for fully-equal rows).
 *
 * @param {Array<object>} rows - TutorialMeta rows (uppercase HANA keys).
 * @returns {{ winner: object, losers: Array<object> }}
 */
function pickCanonicalMeta(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('pickCanonicalMeta: rows must be non-empty array');
  }
  if (rows.length === 1) return { winner: rows[0], losers: [] };

  // Score is a tuple compared lexicographically: each field returns a number,
  // higher = "wins". Null values are treated as the lowest possible score.
  const score = (r) => [
    r.OWNER != null ? 1 : 0,
    Number(r.NOTIFICATIONNUMBER ?? 0),
    r.REVIEWEDDATE ? Date.parse(r.REVIEWEDDATE) : -Infinity,
    r.MODIFIEDAT ? Date.parse(r.MODIFIEDAT) : -Infinity,
    // LEGACYID inverted (lower wins) so we negate it so "higher score" still picks lower legacyId
    -(Number(r.LEGACYID ?? Number.MAX_SAFE_INTEGER)),
  ];

  let winner = rows[0];
  let winnerScore = score(winner);
  for (let i = 1; i < rows.length; i++) {
    const s = score(rows[i]);
    for (let j = 0; j < s.length; j++) {
      if (s[j] > winnerScore[j]) { winner = rows[i]; winnerScore = s; break; }
      if (s[j] < winnerScore[j]) break;
    }
  }
  const losers = rows.filter(r => r.ID !== winner.ID);
  return { winner, losers };
}

module.exports = { pickCanonicalMeta };
```

- [ ] **Step 2.2: Write unit tests**

`test/scripts/pick-canonical-meta.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { pickCanonicalMeta } from '../../scripts/lib/pick-canonical-meta.cjs';

describe('pickCanonicalMeta', () => {
  it('returns the only row when array has length 1', () => {
    const r = { ID: 'a', OWNER: null };
    expect(pickCanonicalMeta([r])).toEqual({ winner: r, losers: [] });
  });

  it('throws on empty input', () => {
    expect(() => pickCanonicalMeta([])).toThrow();
  });

  it('prefers non-null OWNER over null', () => {
    const a = { ID: 'a', OWNER: null, NOTIFICATIONNUMBER: 5, MODIFIEDAT: '2026-06-17T00:00:00' };
    const b = { ID: 'b', OWNER: 'thomas@sap.com', NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2024-01-01T00:00:00' };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks owner tie by NOTIFICATIONNUMBER (higher wins)', () => {
    const a = { ID: 'a', OWNER: 'x@sap.com', NOTIFICATIONNUMBER: 1, MODIFIEDAT: '2026-06-17' };
    const b = { ID: 'b', OWNER: 'y@sap.com', NOTIFICATIONNUMBER: 3, MODIFIEDAT: '2026-06-17' };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks notification tie by REVIEWEDDATE (more recent wins)', () => {
    const a = { ID: 'a', OWNER: 'x', NOTIFICATIONNUMBER: 0, REVIEWEDDATE: '2024-01-01T00:00:00', MODIFIEDAT: '2026-06-17' };
    const b = { ID: 'b', OWNER: 'y', NOTIFICATIONNUMBER: 0, REVIEWEDDATE: '2026-06-01T00:00:00', MODIFIEDAT: '2026-06-17' };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks reviewedDate tie by MODIFIEDAT (more recent wins)', () => {
    const a = { ID: 'a', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-16T17:12:05.062', LEGACYID: 100 };
    const b = { ID: 'b', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-17T18:00:00.000', LEGACYID: 200 };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('breaks fully-equal tie by lower LEGACYID', () => {
    const a = { ID: 'a', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-16T17:12:05.062', LEGACYID: 200 };
    const b = { ID: 'b', OWNER: null, NOTIFICATIONNUMBER: 0, MODIFIEDAT: '2026-06-16T17:12:05.062', LEGACYID: 100 };
    expect(pickCanonicalMeta([a, b]).winner.ID).toBe('b');
  });

  it('reproduces the worked example: Thomas wins over Michelle', () => {
    const michelle = { ID: 'm', OWNER: 'michelle.wang05@sap.com', OWNEREMAIL: 'michelle.wang05@sap.com', NOTIFICATIONNUMBER: 0, REVIEWEDDATE: '2024-04-08T16:28:13', MODIFIEDAT: '2026-06-16T16:26:46.228', LEGACYID: 10001597 };
    const thomas =   { ID: 't', OWNER: 'thomas.jung@sap.com',     OWNEREMAIL: null,                       NOTIFICATIONNUMBER: 3, REVIEWEDDATE: '2026-02-23T16:59:07.569', MODIFIEDAT: '2026-06-16T17:35:34.633', LEGACYID: 10004279 };
    const { winner, losers } = pickCanonicalMeta([michelle, thomas]);
    expect(winner.ID).toBe('t');
    expect(losers).toEqual([michelle]);
  });
});
```

- [ ] **Step 2.3: Run unit tests, confirm 7/7 pass**

```bash
npm test -- test/scripts/pick-canonical-meta.test.js
```

- [ ] **Step 2.4: Write the dedupe script**

`scripts/dedupe-tutorial-meta.cjs`:

```javascript
/* eslint-disable no-console */
/**
 * One-shot repair: dedupe TutorialMeta rows so each tutorial has at most one.
 *
 * Background: PR #386's slug-merge redirected loser TutorialMeta rows onto the
 * winner tutorial via simple FK UPDATE (TutorialMeta is cuid, so no PK
 * collision). But TutorialMeta is logically a singleton — a tutorial should
 * have ONE review-state record, not two. After the slug merge, 123 tutorials
 * have 2 TutorialMeta rows each. This script picks the canonical row using
 * pickCanonicalMeta() and DELETEs the rest.
 *
 * The chosen row is then guaranteed to be the one returned by future
 * SELECT.one queries (after Task 4 adds @assert.unique.tutorial).
 *
 * Modes:
 *   --dry-run     (default) — print plan, no writes
 *   --commit               — execute, snapshot first
 *   --verify-only          — count remaining duplicate groups, exit 0/2
 *
 * Run via:  npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs [--commit]
 */

const cds = require('@sap/cds');
const fs = require('node:fs');
const path = require('node:path');
const { pickCanonicalMeta } = require('./lib/pick-canonical-meta.cjs');

const SNAPSHOT_DIR = path.resolve(__dirname, '..', '.migration-data');
const SNAPSHOT_PATH = path.join(
  SNAPSHOT_DIR,
  `tutorialmeta-dedupe-backup-${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`
);
let snapshotInited = false;
function appendSnapshot(record) {
  if (!snapshotInited) {
    fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
    snapshotInited = true;
  }
  fs.appendFileSync(SNAPSHOT_PATH, JSON.stringify(record) + '\n');
}

const argv = process.argv.slice(2);
const COMMIT = argv.includes('--commit');
const VERIFY_ONLY = argv.includes('--verify-only');
const DRY_RUN = argv.includes('--dry-run');
if (COMMIT && VERIFY_ONLY) {
  console.error('--commit and --verify-only are mutually exclusive');
  process.exit(1);
}
if (COMMIT && DRY_RUN) {
  console.error('--commit and --dry-run are mutually exclusive');
  process.exit(1);
}

const TBL = '"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"';

async function main() {
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (!isHana) {
    console.error('FATAL: this script must run on HANA. Use `cds bind --exec`.');
    process.exit(1);
  }
  if (COMMIT) console.log(`Snapshot will be written to: ${SNAPSHOT_PATH}\n`);

  const dupGroups = await db.run(`
    SELECT "TUTORIAL_ID", COUNT(*) AS C
      FROM ${TBL}
     WHERE "TUTORIAL_ID" IS NOT NULL
     GROUP BY "TUTORIAL_ID"
    HAVING COUNT(*) > 1
     ORDER BY "TUTORIAL_ID"
  `);

  if (VERIFY_ONLY) {
    console.log(`tutorials with > 1 TutorialMeta row: ${dupGroups.length}`);
    process.exit(dupGroups.length === 0 ? 0 : 2);
  }

  console.log(`\n--- TutorialMeta duplicates: ${dupGroups.length} tutorial(s) ---`);
  let deleted = 0;
  let casingChecked = false;

  for (const g of dupGroups) {
    const rows = await db.run(`SELECT * FROM ${TBL} WHERE "TUTORIAL_ID" = ?`, [g.TUTORIAL_ID]);

    if (!casingChecked && rows.length > 0) {
      casingChecked = true;
      const keys = Object.keys(rows[0]);
      if (!keys.includes('ID') || !keys.includes('TUTORIAL_ID')) {
        throw new Error(
          `Row keys are not uppercase as expected. Got: ${keys.join(', ')}\n` +
          `Are you connected to HANA? Run with: cds bind --exec -- node ...`
        );
      }
    }

    const { winner, losers } = pickCanonicalMeta(rows);
    console.log(
      `  tutorial=${g.TUTORIAL_ID.slice(0,8)}: keep=${winner.ID.slice(0,8)} ` +
      `(owner=${winner.OWNER ?? 'null'}, notif=${winner.NOTIFICATIONNUMBER ?? 0})  ` +
      `delete=[${losers.map(l => l.ID.slice(0,8)).join(',')}]`
    );

    if (!COMMIT) continue;

    await db.tx(async tx => {
      // Snapshot every loser row before delete.
      for (const loser of losers) {
        appendSnapshot({ kind: 'row', table: TBL, data: loser });
      }
      // Delete losers.
      for (const loser of losers) {
        await tx.run(`DELETE FROM ${TBL} WHERE "ID" = ?`, [loser.ID]);
        deleted++;
      }
    });
  }

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify({ tutorialsAffected: dupGroups.length, rowsDeleted: deleted }, null, 2));
  if (!COMMIT) console.log('\nDry-run complete. Re-run with --commit to apply.');
}

main().catch(e => { console.error(e); process.exit(1); });
```

- [ ] **Step 2.5: Run dry-run, confirm 123 tutorials listed**

```bash
npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --dry-run
```

Expected: 123 lines, each `tutorial=XXXXXXXX: keep=... delete=[...]`. SUMMARY shows `tutorialsAffected: 123, rowsDeleted: 0`. Live DB unchanged.

- [ ] **Step 2.6: Commit**

```bash
git add scripts/lib/pick-canonical-meta.cjs scripts/dedupe-tutorial-meta.cjs test/scripts/pick-canonical-meta.test.js
git commit -m "scripts(meta-dedupe): add dedupe script + canonical-row picker

Adds:
- scripts/lib/pick-canonical-meta.cjs — pure picker, info-density priority
  (non-null owner > notificationNumber > reviewedDate > MODIFIEDAT > LEGACYID).
- scripts/dedupe-tutorial-meta.cjs — live-DB repair, snapshot-then-delete.
  Dry-run by default; --commit writes; --verify-only for CI.
- test/scripts/pick-canonical-meta.test.js — 7 unit tests covering every
  tier of the priority ladder + the worked Michelle/Thomas example.

Diagnoses 123 tutorials with 2 TutorialMeta rows on DEV HANA. Tasks 3-5
will execute the merge, add @assert.unique.tutorial, and update the
slug-merge script."
```

---

## Task 3: Run dedupe against live HANA

- [ ] **Step 3.1: Re-confirm cf target**

```bash
cf target
```
Must show `tutorial-system / dev`. STOP otherwise.

- [ ] **Step 3.2: Run --commit**

```bash
npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --commit
```

Expected SUMMARY: `tutorialsAffected: 123, rowsDeleted: 123`. No errors.

- [ ] **Step 3.3: Verify clean**

```bash
npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --verify-only
echo "exit=$?"
```

Expected: `tutorials with > 1 TutorialMeta row: 0`, `exit=0`.

- [ ] **Step 3.4: Spot-check the worked example**

Write a temp `.cjs` file (delete after) that queries `TutorialMeta WHERE TUTORIAL_ID = 'c9cd2dc8-5ee3-46dc-a5eb-6883ce08be2d'`. Expected: ONE row, OWNER='thomas.jung@sap.com'.

- [ ] **Step 3.5: Run the new hybrid test (should now PASS)**

```bash
npm run test:hybrid -- test/hybrid/duplicate-tutorial-meta.test.js
```

Expected: 1/1 pass.

- [ ] **Step 3.6: Commit run-log**

```bash
git commit --allow-empty -m "data(meta-dedupe): repaired 123 duplicate TutorialMeta rows on DEV

Snapshot at .migration-data/tutorialmeta-dedupe-backup-<ts>.jsonl
(gitignored). All 123 tutorials now have exactly one TutorialMeta row;
hybrid test test/hybrid/duplicate-tutorial-meta.test.js is GREEN."
```

---

## Task 4: Add `@assert.unique.tutorial` constraint

**Files:**

- Modify: `db/schema.cds` — add annotation on `TutorialMeta`

- [ ] **Step 4.1: Verify CAP supports the annotation on a managed Association**

```
mcp__plugin_cds-mcp_cds-mcp__search_docs with query: "@assert.unique association"
```

Confirm the dot-form `@assert.unique.<name>: [associationField]` works on associations and emits `UNIQUE INVERTED INDEX` on the underlying FK column (`tutorial_ID`).

- [ ] **Step 4.2: Add the annotation**

Locate `entity TutorialMeta : cuid, managed, LegacyKeyed` in [db/schema.cds](../../db/schema.cds). Insert:

```cds
@assert.unique.tutorial : [tutorial]
entity TutorialMeta : cuid, managed, LegacyKeyed { … }
```

- [ ] **Step 4.3: Build + inspect HDI artefact**

```bash
npx cds build --for hana
ls db/src/gen/com.sap.developers.ims.TutorialMeta.tutorial.hdbindex 2>/dev/null \
  || ls db/src/gen | grep -i TutorialMeta
grep -i unique db/src/gen/com.sap.developers.ims.TutorialMeta.tutorial.hdbindex
```

Expected: `UNIQUE INVERTED INDEX … ON com_sap_developers_ims_TutorialMeta (tutorial_ID)`.

- [ ] **Step 4.4: Run unit tests, confirm no new failures**

```bash
npm test 2>&1 | tail -5
```

Compare against the baseline. If the publish path's auto-init test now fails (because it could be inserting a second TutorialMeta row in the test fixture), update the test to delete-then-insert or to use a unique tutorial.

- [ ] **Step 4.5: Commit**

```bash
git add db/schema.cds db/last-dev/csn.json
git commit -m "schema(meta-dedupe): add @assert.unique on TutorialMeta.tutorial

Closes the architectural hole that allowed PR #386's slug-merge to
end up with 2 TutorialMeta rows per tutorial. TutorialMeta is a
logical singleton (one review-state record per tutorial); future
INSERTs that violate that fail loud at the DB layer."
```

---

## Task 5: Update merge script to handle singleton FK tables

**Files:**

- Modify: `scripts/merge-duplicate-slugs.cjs` — extend `FK_REDIRECTS` with a `'singleton'` kind, dispatch to a new `redirectFkSingleton` helper

- [ ] **Step 5.1: Add `redirectFkSingleton` helper**

In `scripts/merge-duplicate-slugs.cjs`, alongside `redirectFkSafe`, add:

```javascript
// Redirect a "logical singleton" FK column (e.g. TutorialMeta) where the
// parent should have exactly one child row. If the winner already has a
// child, DELETE the loser's child(ren) — the winner's row is canonical.
// If the winner has no child, UPDATE the loser's row to point at winner.
//
// This avoids the post-merge state of two singleton rows per parent.
async function redirectFkSingleton(tx, tbl, col, loserId, winnerId) {
  const winnerRows = await tx.run(`SELECT "ID" FROM ${tbl} WHERE ${col} = ?`, [winnerId]);
  if (winnerRows.length === 0) {
    // Winner has no row — promote the loser's row.
    const r = await tx.run(`UPDATE ${tbl} SET ${col} = ? WHERE ${col} = ?`, [winnerId, loserId]);
    return { redirected: typeof r === 'number' ? r : 0, dropped: 0 };
  }
  // Winner already has a row — drop loser's row(s).
  const loserRows = await tx.run(`SELECT "ID" FROM ${tbl} WHERE ${col} = ?`, [loserId]);
  for (const r of loserRows) {
    await tx.run(`DELETE FROM ${tbl} WHERE "ID" = ?`, [r.ID]);
  }
  return { redirected: 0, dropped: loserRows.length };
}
```

- [ ] **Step 5.2: Reclassify `TutorialMeta` to `'singleton'` in `FK_REDIRECTS`**

In the `FK_REDIRECTS.tutorials` array, find the line:

```javascript
{ tbl: '"COM_SAP_DEVELOPERS_IMS_TUTORIALMETA"', col: '"TUTORIAL_ID"', kind: 'simple' },
```

Change `kind: 'simple'` to `kind: 'singleton'`.

- [ ] **Step 5.3: Dispatch on the new kind in the FK redirect loop**

In the loop that iterates `FK_REDIRECTS[table]` (around line 638 in `merge-duplicate-slugs.cjs`), add a `'singleton'` case:

```javascript
} else if (fk.kind === 'singleton') {
  const summary = await redirectFkSingleton(tx, fk.tbl, fk.col, loser.ID, winner.ID);
  if (summary.dropped > 0 || summary.redirected > 50) {
    console.log(`    ${fk.tbl}.${fk.col}: redirected=${summary.redirected} dropped=${summary.dropped}`);
  }
}
```

(Goes between the `'simple'` and the existing error throw.)

- [ ] **Step 5.4: Re-run dry-run to confirm the script still parses**

```bash
npx cds bind --exec -- node scripts/merge-duplicate-slugs.cjs --dry-run
```

Expected: `groups: 0, missions: 0, tutorials: 0` (we're past all merges now). No errors.

- [ ] **Step 5.5: Commit**

```bash
git add scripts/merge-duplicate-slugs.cjs
git commit -m "scripts(slug-dedupe): add 'singleton' FK kind for TutorialMeta

PR #386's slug-merge treated TutorialMeta as 'simple' (single-column
PK on ID), so when both winner and loser had a row it produced two
rows on the merged tutorial. TutorialMeta is a logical singleton;
add a 'singleton' kind to FK_REDIRECTS that DELETEs the loser's row
when the winner already has one, otherwise UPDATEs the loser's row
to point at winner.

If a future migration ever produces dup-groups, the merge will leave
TutorialMeta in the right shape from the start."
```

---

## Task 6: Update CLAUDE.md docs + open follow-up PR

- [ ] **Step 6.1: Add gotcha to CLAUDE.md**

Add this entry near the existing slug-uniqueness entry:

```markdown
- **TutorialMeta is a logical singleton (one row per tutorial)** — `db/schema.cds` declares `@assert.unique.tutorial : [tutorial]` on `TutorialMeta`. Auto-init at [srv/lib/content-publish-session.js:349](srv/lib/content-publish-session.js#L349) checks for an existing row before INSERT; the slug-merge script ([scripts/merge-duplicate-slugs.cjs](scripts/merge-duplicate-slugs.cjs)) classifies `TutorialMeta.TUTORIAL_ID` as `kind: 'singleton'` so cross-tutorial merges leave at most one row per tutorial. The hybrid test [test/hybrid/duplicate-tutorial-meta.test.js](test/hybrid/duplicate-tutorial-meta.test.js) fails CI if duplicates ever appear. To repair: `npx cds bind --exec -- node scripts/dedupe-tutorial-meta.cjs --commit`.
```

- [ ] **Step 6.2: Commit docs**

```bash
git add CLAUDE.md
git commit -m "docs(meta-dedupe): document TutorialMeta singleton invariant"
```

- [ ] **Step 6.3: Open follow-up PR**

If PR #386 is still open, this work can either:

(a) **Be added to PR #386** — push to the same branch (`worktree-fix-duplicate-slugs`); the existing PR grows. Cleaner for review (related concerns merged together) but expands the scope of what's already approved.

(b) **Open as a follow-up PR** stacked on `worktree-fix-duplicate-slugs` — branch off, push, `gh pr create --base worktree-fix-duplicate-slugs`. Keeps PR #386 small and reviewable; the follow-up can land independently.

If PR #386 has merged: branch off `main` and open a new PR.

The decision is the human's call — recommend (a) since the two issues share root cause (schema lacked uniqueness invariants on logical-singleton fields) and the merge-script change is a direct refinement of PR #386's design.

PR body suggestion (if separate):

```markdown
Follow-up to #386. The slug-merge in #386 treated TutorialMeta as a simple cuid FK (single-column PK on ID), so when both winner and loser had a TutorialMeta row, the merge produced two rows on the merged tutorial. TutorialMeta is a logical singleton — one review-state record per tutorial.

Affects 123 of 123 merged tutorials (every dup-group from PR #386 inherited 2 TutorialMeta rows).

## What this PR does

1. Hybrid test (test/hybrid/duplicate-tutorial-meta.test.js) — fails CI if any tutorial has > 1 TutorialMeta row.
2. Dedupe script (scripts/dedupe-tutorial-meta.cjs + scripts/lib/pick-canonical-meta.cjs) — picks the canonical row (info-density priority: non-null owner > notificationNumber > reviewedDate > MODIFIEDAT > LEGACYID), DELETEs the rest, snapshots first. 7 unit tests covering every tier of the picker.
3. Schema constraint (db/schema.cds) — `@assert.unique.tutorial : [tutorial]` on TutorialMeta. Emits UNIQUE INVERTED INDEX in HANA HDI; future colliding INSERTs fail loud.
4. Slug-merge update (scripts/merge-duplicate-slugs.cjs) — adds a `'singleton'` FK kind. Future merges of slug duplicates won't recreate the issue.
5. CLAUDE.md gotcha entry.

## Live DEV repair already executed

- 123 → 0 tutorials with duplicate TutorialMeta
- Snapshot: .migration-data/tutorialmeta-dedupe-backup-*.jsonl (gitignored)
- Worked example: tutorial c9cd2dc8 now has ONE TutorialMeta row, OWNER=thomas.jung@sap.com

## Verification

- `npm run test:hybrid -- test/hybrid/duplicate-tutorial-meta.test.js` → 1/1 green
- `npm test -- test/scripts/pick-canonical-meta.test.js` → 7/7 green
- /admin-ui/#tutorials editor will show Thomas as Owner (was showing Michelle pre-fix because the OData expand picked the older publish-side row first)
```

---

## Out of scope

- **Other potentially-singleton FK tables.** Not auditing the schema for other "should be one-row-per-parent" entities. If similar bugs exist, they'll surface separately and can be fixed with the same pattern (`'singleton'` FK kind + `@assert.unique`).
- **Backfilling owner from frontmatter.** Some tutorials have null OWNER in their TutorialMeta because the auto-init's `meta.primaryContributorEmail` was null when first published. A backfill that re-resolves owner from current frontmatter is a separate concern.
- **Changing how owner is derived (frontmatter author vs first contributor).** The choice of `contributors[0]` as primary is a publish-pipeline decision that predates this PR; revisiting it is its own design discussion.

---

## Risk register

| Risk | Likelihood | Mitigation |
|---|---|---|
| Picker chooses the wrong row for a complex case | Low-Medium | 7 unit tests including the worked Michelle/Thomas example; snapshot enables full revert |
| `@assert.unique.tutorial` deploy fails because dup data still exists | Low | Schema change ships AFTER Task 3 dedupe; `--verify-only` in Task 3.3 confirms 0 dups before Task 4 |
| Existing publish-side auto-init breaks under the new constraint | Medium | The auto-init at [srv/lib/content-publish-session.js:349](srv/lib/content-publish-session.js#L349) already checks `existingMeta` and INSERTs only if absent — should be fine. Task 4 unit-test run will catch any test that violates this. |
| Singleton merge in slug-merge produces unexpected DELETEs | Low | The 'singleton' helper is unit-test-equivalent in shape (delete-on-conflict) to the composite-pk helper, which we already proved correct on 123 dup-groups |
