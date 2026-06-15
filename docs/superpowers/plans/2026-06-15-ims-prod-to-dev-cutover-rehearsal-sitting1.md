# IMS Prod → DEV Cutover Rehearsal — Sitting 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the script-side preparation for the IMS-prod-to-DEV cutover rehearsal so Sitting 2 (the rehearsal day itself) is a click-through.

**Architecture:** Three deliverables, all under `scripts/`. (1) Extend `scripts/migrate-from-hana.js` with `usermetadata`, `accomplishments`, `accomplishmentrecords`, `prizerecords` migration blocks plus a `--list-entities` flag. (2) New `scripts/verify-migration-rowcounts.cjs` — Tier-A row-count diff with reference/activity tolerance rules. (3) New `scripts/cutover-rehearsal.cjs` — 13-step Windows-portable orchestrator. Plus one new author-side test file using Vitest's `unit` workspace.

**Tech Stack:** Node 22+, `hdb` Node.js HANA client (already a dep), `node:crypto` for UUIDs, Vitest for tests. No CDS schema changes, no deploys.

**Spec:** [docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md](../specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md)

---

## File Structure

| Path | Action | Responsibility |
|---|---|---|
| `scripts/migrate-from-hana.js` | Modify | Add 4 migration blocks + UUID-map seeding for accomplishments + `--list-entities` flag |
| `scripts/verify-migration-rowcounts.cjs` | Create | Tier-A: side-by-side row counts with tolerance rules; CLI exits 0/1/2 |
| `scripts/cutover-rehearsal.cjs` | Create | 13-step orchestrator that drives the rehearsal end-to-end |
| `scripts/lib/migration-tolerance.cjs` | Create | Pure helper: classify table as reference/activity, validate diff against tolerance. Tested in isolation. |
| `test/unit/migration-tolerance.test.js` | Create | Vitest unit tests for the tolerance helper |
| `package.json` | Modify | Add `cutover:rehearsal`, `verify:rowcounts` npm scripts |
| `.gitignore` | Modify | Ensure `.migration-data/cutover-*/` is gitignored (likely already, verify) |

**Why this split:** The tolerance rule is the only piece of real logic — everything else is glue. Pulling it into `lib/migration-tolerance.cjs` makes it the only thing we test in CI; the orchestrator and verifier scripts are tested by running them.

---

## Constraints carried from the spec

- **Sitting 1 produces a PR**, no rehearsal-day execution. Validation = dry-run with `--discover` against IMS prod from Tom's laptop, post-merge.
- **No CDS schema changes.** No `cds build`, no deploy, no schema-drift check.
- **PR-over-direct-merge** (memory `feedback_pr_over_direct_merge`): land changes via PR on the existing `spec/ims-prod-to-dev-cutover-rehearsal` branch.
- **Windows-portable.** All scripts are `.cjs` (CommonJS) or stay as `.js` matching existing migrator style; no `.sh`. Use `path.join`, no shell pipes inside Node.
- **No CRLF flips** (memory `feedback_crlf_regression_on_windows`): verify `file <path>` shows LF after each edit.
- **Verify-branch-before-commit** (memory `feedback_verify_branch_before_commit`): every commit step runs `git branch --show-current` in the same Bash invocation.

---

## Task 1: Tolerance helper (TDD)

**Why first:** The tolerance rule is the only piece of real logic in this PR. Building it test-first locks in the spec's tolerance contract (zero on reference tables; ±2 on activity tables) before anything depends on it.

**Files:**
- Create: `scripts/lib/migration-tolerance.cjs`
- Test: `test/unit/migration-tolerance.test.js`

The Vitest `unit` workspace already runs `test/unit/**` (see [vitest.config.ts](../../../vitest.config.ts)). No config change required.

- [ ] **Step 1.1: Write the failing test**

Create `test/unit/migration-tolerance.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  classifyEntity,
  checkTolerance,
  REFERENCE_ENTITIES,
  ACTIVITY_ENTITIES,
} from '../../scripts/lib/migration-tolerance.cjs';

describe('classifyEntity', () => {
  it('classifies known reference entities as "reference"', () => {
    expect(classifyEntity('tutorials')).toBe('reference');
    expect(classifyEntity('missions')).toBe('reference');
    expect(classifyEntity('groups')).toBe('reference');
    expect(classifyEntity('tags')).toBe('reference');
    expect(classifyEntity('events')).toBe('reference');
    expect(classifyEntity('prizes')).toBe('reference');
    expect(classifyEntity('completionpaths')).toBe('reference');
    expect(classifyEntity('completionpathitems')).toBe('reference');
    expect(classifyEntity('tutorialtags')).toBe('reference');
    expect(classifyEntity('steps')).toBe('reference');
    expect(classifyEntity('accomplishments')).toBe('reference');
  });

  it('classifies known activity entities as "activity"', () => {
    expect(classifyEntity('users')).toBe('activity');
    expect(classifyEntity('taskrecords')).toBe('activity');
    expect(classifyEntity('prizerecords')).toBe('activity');
    expect(classifyEntity('accomplishmentrecords')).toBe('activity');
    expect(classifyEntity('usermetadata')).toBe('activity');
  });

  it('throws on unknown entities — fail loud, never silently allow drift', () => {
    expect(() => classifyEntity('mystery_table')).toThrow(/unknown entity/i);
  });

  it('every entity declared is in exactly one bucket', () => {
    const overlap = REFERENCE_ENTITIES.filter(e => ACTIVITY_ENTITIES.includes(e));
    expect(overlap).toEqual([]);
  });
});

describe('checkTolerance', () => {
  it('reference tables: zero diff is OK', () => {
    expect(checkTolerance('tutorials', 1398, 1398)).toEqual({
      ok: true,
      diff: 0,
      tolerance: 0,
      class: 'reference',
    });
  });

  it('reference tables: any non-zero diff fails', () => {
    const r = checkTolerance('tutorials', 1398, 1397);
    expect(r.ok).toBe(false);
    expect(r.diff).toBe(-1);
  });

  it('activity tables: diff within ±2 is OK', () => {
    expect(checkTolerance('taskrecords', 892341, 892340).ok).toBe(true);
    expect(checkTolerance('taskrecords', 892341, 892343).ok).toBe(true);
    expect(checkTolerance('taskrecords', 892341, 892339).ok).toBe(true);
  });

  it('activity tables: diff beyond ±2 fails', () => {
    expect(checkTolerance('taskrecords', 892341, 892338).ok).toBe(false);
    expect(checkTolerance('taskrecords', 892341, 892344).ok).toBe(false);
  });

  it('reports the diff signed (target - source)', () => {
    expect(checkTolerance('users', 100, 98).diff).toBe(-2);
    expect(checkTolerance('users', 100, 102).diff).toBe(2);
  });

  it('throws on unknown entity (does not silently allow)', () => {
    expect(() => checkTolerance('mystery', 0, 0)).toThrow(/unknown entity/i);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
git branch --show-current && npx vitest run test/unit/migration-tolerance.test.js
```
Expected: FAIL with `Cannot find module '../../scripts/lib/migration-tolerance.cjs'`.

- [ ] **Step 1.3: Write minimal implementation**

Create `scripts/lib/migration-tolerance.cjs`:

```javascript
'use strict';

// Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Decisions row 9
// Reference tables: zero diff required.
// Activity tables: ±2 to absorb live-write skew on IMS prod during the read window.

const REFERENCE_ENTITIES = [
  'tutorials',
  'missions',
  'groups',
  'tags',
  'events',
  'prizes',
  'completionpaths',
  'completionpathitems',
  'tutorialtags',
  'steps',
  'accomplishments',
];

const ACTIVITY_ENTITIES = [
  'users',
  'taskrecords',
  'prizerecords',
  'accomplishmentrecords',
  'usermetadata',
];

const TOLERANCES = { reference: 0, activity: 2 };

function classifyEntity(name) {
  if (REFERENCE_ENTITIES.includes(name)) return 'reference';
  if (ACTIVITY_ENTITIES.includes(name)) return 'activity';
  throw new Error(`unknown entity: "${name}" — add to REFERENCE_ENTITIES or ACTIVITY_ENTITIES in scripts/lib/migration-tolerance.cjs`);
}

function checkTolerance(name, sourceCount, targetCount) {
  const cls = classifyEntity(name);
  const tolerance = TOLERANCES[cls];
  const diff = targetCount - sourceCount;
  const ok = Math.abs(diff) <= tolerance;
  return { ok, diff, tolerance, class: cls };
}

module.exports = {
  classifyEntity,
  checkTolerance,
  REFERENCE_ENTITIES,
  ACTIVITY_ENTITIES,
  TOLERANCES,
};
```

- [ ] **Step 1.4: Run tests to verify pass**

```bash
npx vitest run test/unit/migration-tolerance.test.js
```
Expected: all 9 tests pass.

- [ ] **Step 1.5: Commit**

```bash
git branch --show-current && \
  git add scripts/lib/migration-tolerance.cjs test/unit/migration-tolerance.test.js && \
  git commit -m "feat(migration): tolerance helper for cutover row-count verification

Pure module classifying entities as reference (zero-diff) or activity (±2).
Wired in next commits by verify-migration-rowcounts.cjs.

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md"
```

---

## Task 2: Migrator extension — accomplishments catalog (+UUID-map seeding)

**Why this order:** AccomplishmentRecords needs both `users` and `accomplishments` UUIDs resolved. The discovery pass already seeds `uuidMap.accomplishments` (migrate-from-hana.js:363-367) but no migration block exists for the catalog itself. We add the catalog block first, then the records block.

**Files:**
- Modify: `scripts/migrate-from-hana.js` — add a new `accomplishments` migration block after `tutorialtags` (it has no FK dependencies, so order is flexible; placing late keeps the existing reference-data ordering untouched).

- [ ] **Step 2.1: Read the source schema first to confirm column names**

The migrator's existing pattern is to discover then map. We don't have IMS prod creds yet, but we can read the existing `IMS_ACCOMPLISHMENT` references (line 364) to confirm the table name. The columns are unknown until `--discover` runs against IMS prod, so we'll write defensive SQL: `SELECT * FROM ... ` and only project the columns we map.

The CDS target shape is (from `db/schema.cds:243-247`):

```cds
entity Accomplishments : cuid, LegacyKeyed {
  name        : String(255);
  rule        : String(2000);
  description : String(1000);
}
```

HDI table name (from `db/last-dev/csn.json:1082`): `COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS`. Columns: `ID`, `LEGACYID`, `NAME`, `RULE`, `DESCRIPTION`.

- [ ] **Step 2.2: Add the accomplishments migration block**

In `scripts/migrate-from-hana.js`, immediately before the `// 12. TutorialTags` comment block (around line 608), insert:

```javascript
  // 11b. Accomplishments catalog (CAP entity: Accomplishments)
  // FK shape: parent of AccomplishmentRecords. No own FKs.
  if (uuidMap.accomplishments.size > 0) {
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'accomplishments',
        sourceQuery: `SELECT "ID", "NAME", "RULE", "DESCRIPTION" FROM ${S}."IMS_ACCOMPLISHMENT"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTS',
        mapRow: (row) => ({
          ID: uuidMap.accomplishments.get(row.ID),
          LEGACYID: row.ID,
          NAME: truncStr(row.NAME, 255),
          RULE: truncStr(row.RULE, 2000),
          DESCRIPTION: truncStr(row.DESCRIPTION, 1000),
        }),
      }));
    } catch (e) {
      console.log(`  ⊘ Accomplishments: ${e.message.split('\n')[0]}`);
    }
  }
```

The defensive `try/catch` matches the pattern used for prizes and completionpathitems — IMS prod may have column-name drift versus what we infer.

- [ ] **Step 2.3: Verify file still parses (Node syntax check)**

```bash
git branch --show-current && node --check scripts/migrate-from-hana.js
```
Expected: silent success.

- [ ] **Step 2.4: Verify line endings**

```bash
file scripts/migrate-from-hana.js
```
Expected: `... ASCII text` (not `with CRLF`). Per memory `feedback_crlf_regression_on_windows`.

- [ ] **Step 2.5: Commit**

```bash
git branch --show-current && \
  git add scripts/migrate-from-hana.js && \
  git commit -m "feat(migration): add Accomplishments catalog migration block

Closes the existing gap where uuidMap.accomplishments is seeded but the
catalog itself never lands in the target. Required prerequisite for
AccomplishmentRecords (next commit).

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Components"
```

---

## Task 3: Migrator extension — UserMetaData

**Why this slot:** UserMetaData has only one FK (→ Users). Per spec §Components, it lands after `users` and before `taskrecords`. We add it inline at that position so re-runs do not break ordering.

**CDS target** (`db/schema.cds:127-131`):

```cds
entity UserMetaData : cuid, LegacyKeyed {
  user                      : Association to Users;
  ![key]                    : String(255);
  value                     : String(2000);
}
```

**HDI table** (`db/last-dev/csn.json:1115`): `COM_SAP_DEVELOPERS_IMS_USERMETADATA`. Columns: `ID`, `LEGACYID`, `USER_ID`, `key` (note: lowercase, escaped in CDS — verify in step 3.1), `VALUE`.

**Files:**
- Modify: `scripts/migrate-from-hana.js`

- [ ] **Step 3.1: Confirm the actual HANA column name for `key`**

The CDS source uses `![key]` because `key` is a reserved word. Determine the actual HANA column name:

```bash
grep -A2 -B1 "USERMETADATA" db/last-dev/*.json db/src/*.hdbtable 2>/dev/null | head -40
```
Note the casing — likely `"key"` (lowercase, quoted) or `"KEY"`. Use it in the INSERT.

- [ ] **Step 3.2: Add the UserMetaData migration block**

Insert immediately after the `// 7. Users` block (line 523) and before `// 8. Task Records` (line 525):

```javascript
  // 7b. UserMetaData (CAP entity: UserMetaData)
  // FK: user_id → Users. Insert after Users so the FK resolves.
  // Defensive: IMS prod may not have this table populated.
  try {
    results.push(await migrateEntity(source, target, T, {
      name: 'usermetadata',
      sourceQuery: `SELECT "ID", "USER_ID", "KEY", "VALUE" FROM ${S}."IMS_USER_METADATA"`,
      targetTable: 'COM_SAP_DEVELOPERS_IMS_USERMETADATA',
      mapRow: (row) => {
        const userUuid = uuidMap.users.get(row.USER_ID);
        if (!userUuid) return null; // orphan: no migrated user → drop row
        return {
          ID: randomUUID(),
          LEGACYID: row.ID,
          USER_ID: userUuid,
          key: truncStr(row.KEY, 255),
          VALUE: truncStr(row.VALUE, 2000),
        };
      },
    }));
  } catch (e) {
    console.log(`  ⊘ UserMetaData: ${e.message.split('\n')[0]}`);
  }
```

The mapRow's `key` (lowercase) target column matches what step 3.1 confirmed; adjust if the HDI table uses `KEY`. CAP `cuid` + `LegacyKeyed` aspects only — no managed columns, so `createdAt`/`createdBy` stay NULL per spec.

- [ ] **Step 3.3: Syntax check + line-ending check**

```bash
git branch --show-current && node --check scripts/migrate-from-hana.js && file scripts/migrate-from-hana.js
```
Expected: silent success + `ASCII text`.

- [ ] **Step 3.4: Commit**

```bash
git branch --show-current && \
  git add scripts/migrate-from-hana.js && \
  git commit -m "feat(migration): add UserMetaData migration block

Inserts after Users so user_id FK resolves. Orphan rows (user not
migrated) are dropped and counted as null returns. Defensive try/catch
matches pattern used by prizes/completionpathitems.

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Components"
```

---

## Task 4: Migrator extension — AccomplishmentRecords

**Why now:** Depends on `users` and `accomplishments` (Task 2). Both are seeded by this point.

**CDS target** (`db/schema.cds:249-253`):

```cds
entity AccomplishmentRecords : cuid, LegacyKeyed {
  user                      : Association to Users;
  accomplishment            : Association to Accomplishments;
  awardedAt                 : Timestamp;
}
```

**HDI table**: `COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS`. Columns: `ID`, `LEGACYID`, `USER_ID`, `ACCOMPLISHMENT_ID`, `AWARDEDAT`.

**Files:**
- Modify: `scripts/migrate-from-hana.js`

- [ ] **Step 4.1: Add the AccomplishmentRecords migration block**

Insert immediately after the `// 11b. Accomplishments` block (added in Task 2), before `// 12. TutorialTags`:

```javascript
  // 11c. AccomplishmentRecords (user-earned badges)
  // FKs: user_id → Users; accomplishment_id → Accomplishments.
  if (uuidMap.users.size > 0 && uuidMap.accomplishments.size > 0) {
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'accomplishmentrecords',
        sourceQuery: `SELECT "ID", "USER_ID", "ACCOMPLISHMENT_ID", "AWARDED_AT" FROM ${S}."IMS_ACCOMPLISHMENT_RECORD"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_ACCOMPLISHMENTRECORDS',
        mapRow: (row) => {
          const userUuid = uuidMap.users.get(row.USER_ID);
          const accUuid = uuidMap.accomplishments.get(row.ACCOMPLISHMENT_ID);
          if (!userUuid || !accUuid) return null;
          return {
            ID: randomUUID(),
            LEGACYID: row.ID,
            USER_ID: userUuid,
            ACCOMPLISHMENT_ID: accUuid,
            AWARDEDAT: toISOTimestamp(row.AWARDED_AT),
          };
        },
      }));
    } catch (e) {
      console.log(`  ⊘ AccomplishmentRecords: ${e.message.split('\n')[0]}`);
    }
  }
```

- [ ] **Step 4.2: Syntax check + line-ending check**

```bash
git branch --show-current && node --check scripts/migrate-from-hana.js && file scripts/migrate-from-hana.js
```

- [ ] **Step 4.3: Commit**

```bash
git branch --show-current && \
  git add scripts/migrate-from-hana.js && \
  git commit -m "feat(migration): add AccomplishmentRecords migration block

User-earned badge junction. FK-resolves user_id and accomplishment_id;
drops orphan rows. Closes the documented coverage gap from spec Q6.

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Components"
```

---

## Task 5: Migrator extension — PrizeRecords

**Why last of the migration blocks:** Depends on `users`, `prizes`, `events`, and `completionpathitems`. All four are populated by this point.

**CDS target** (`db/schema.cds:185-191`):

```cds
entity PrizeRecords : cuid, LegacyKeyed {
  user                      : Association to Users;
  event                     : Association to Events;
  prize                     : Association to Prizes;
  completionPathItem        : Association to CompletionPathItems;
  status                    : String(50);
}
```

**HDI table**: `COM_SAP_DEVELOPERS_IMS_PRIZERECORDS`. Columns: `ID`, `LEGACYID`, `USER_ID`, `EVENT_ID`, `PRIZE_ID`, `COMPLETIONPATHITEM_ID`, `STATUS`.

**Note on Spec Q3 follow-up ("bring prize claims over verbatim"):** the CAP schema lacks separate `claimed`/`claimedAt` columns; the CDS shape stores claim state in `status` (e.g. `'CLAIMED'`, `'AWARDED'`). We carry the IMS source's status string verbatim, which is what "verbatim claims" means against this schema.

**Files:**
- Modify: `scripts/migrate-from-hana.js`

- [ ] **Step 5.1: Add the PrizeRecords migration block**

Insert after the `// 11c. AccomplishmentRecords` block (added in Task 4), still before `// 12. TutorialTags`:

```javascript
  // 11d. PrizeRecords (user prize claims)
  // FKs: user_id → Users; prize_id → Prizes; event_id → Events;
  //      completionpathitem_id → CompletionPathItems (optional).
  // CompletionPathItems uses LEGACYID → newly-generated UUID; the
  // migrator generates a fresh UUID per row (line 579) and never
  // builds a lookup map, so we can only resolve via legacyId match
  // — punt on this FK and leave NULL. See spec §Risk register.
  if (uuidMap.users.size > 0 && uuidMap.prizes.size > 0) {
    try {
      results.push(await migrateEntity(source, target, T, {
        name: 'prizerecords',
        sourceQuery: `SELECT "ID", "USER_ID", "EVENT_ID", "PRIZE_ID", "STATUS" FROM ${S}."IMS_PRIZE_RECORD"`,
        targetTable: 'COM_SAP_DEVELOPERS_IMS_PRIZERECORDS',
        mapRow: (row) => {
          const userUuid = uuidMap.users.get(row.USER_ID);
          const prizeUuid = uuidMap.prizes.get(row.PRIZE_ID);
          if (!userUuid || !prizeUuid) return null;
          return {
            ID: randomUUID(),
            LEGACYID: row.ID,
            USER_ID: userUuid,
            EVENT_ID: row.EVENT_ID ? uuidMap.events.get(row.EVENT_ID) : null,
            PRIZE_ID: prizeUuid,
            COMPLETIONPATHITEM_ID: null, // see comment above
            STATUS: truncStr(row.STATUS, 50),
          };
        },
      }));
    } catch (e) {
      console.log(`  ⊘ PrizeRecords: ${e.message.split('\n')[0]}`);
    }
  }
```

- [ ] **Step 5.2: Syntax check + line-ending check**

```bash
git branch --show-current && node --check scripts/migrate-from-hana.js && file scripts/migrate-from-hana.js
```

- [ ] **Step 5.3: Commit**

```bash
git branch --show-current && \
  git add scripts/migrate-from-hana.js && \
  git commit -m "feat(migration): add PrizeRecords migration block

Carries STATUS verbatim per spec — claim state lives in the status
column, not a separate boolean. completionPathItem FK is left NULL
since the migrator does not build a CompletionPathItems lookup map.

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Components"
```

---

## Task 6: Migrator extension — `--list-entities` flag

**Why:** Spec §Components calls for auditability of the migration order before the real run. Pure listing, no DB connection.

**Files:**
- Modify: `scripts/migrate-from-hana.js`

- [ ] **Step 6.1: Add the flag declaration**

Near the existing flag declarations (around line 27-30):

```javascript
const LIST_ENTITIES = process.argv.includes('--list-entities');
```

- [ ] **Step 6.2: Add the early-exit handler in main()**

After the banner block but before the source-creds resolution, list the 16 entities (incl. the 4 new ones), tag each as reference vs activity, and print the SQL source. Then `process.exit(0)`. See implementation in Step 6.3 below.

- [ ] **Step 6.3: Run the flag**

```bash
git branch --show-current && node scripts/migrate-from-hana.js --list-entities
```
Expected: 16-row table prints with FK-correct ordering, exit 0.

- [ ] **Step 6.4: Commit**

```bash
git branch --show-current && \
  git add scripts/migrate-from-hana.js && \
  git commit -m "feat(migration): --list-entities flag for cutover-rehearsal auditability"
```

---

## Task 7: Verifier — `scripts/verify-migration-rowcounts.cjs`

**Why now:** All 15 entities exist in the migrator. The verifier needs the same entity list and the tolerance helper.

**Behavior contract:**
- Connects to source (IMS) and target (DEV) using the same env-var resolution as the migrator (`IMS_HANA_CREDENTIALS`, `CAP_HANA_CREDENTIALS`, or `cf service-key` fallback).
- Runs `SELECT COUNT(*) FROM "<schema>"."<table>"` on both sides for every entity.
- Calls `checkTolerance(name, sourceCount, targetCount)` per entity.
- Writes side-by-side report to `<output-dir>/tier-a-rowcount-diff.json`.
- Exit code: `0` all-pass; `1` any out-of-tolerance diff; `2` connection or query error.

**Files:**
- Create: `scripts/verify-migration-rowcounts.cjs`

**Implementation outline (full code in execution; this is the structure):**

1. CommonJS module. Requires: `child_process.execFileSync`, `fs`, `path`, `hdb`, plus the local `./lib/migration-tolerance.cjs`.
2. `ENTITY_TABLES` const — array of `[name, sourceTable, targetTable]` triples for all 16 rows from Task 6.2.
3. `TASK_TYPE_FILTER` const — `{ groups: 'GROUP', missions: 'MISSION', tutorials: 'TUTORIAL', steps: 'STEP' }`. These four come from the same `IMS_TASK` source table and need a `WHERE TASK_TYPE = ?` filter.
4. Connection helpers mirroring [scripts/migrate-from-hana.js:40-90](../../../scripts/migrate-from-hana.js): `getCredentials()` shells out to `cf service-key` via `execFileSync`, `connect()` wraps `hdb.createClient(...)`, `query()` wraps the HDB client's `exec` callback in a Promise.
5. `resolveCreds(side)` — checks `IMS_HANA_CREDENTIALS` / `CAP_HANA_CREDENTIALS` env vars first, falls back to `cf service-key` lookup.
6. `main()`:
   - Parse `--output-dir=<path>` and `--json` flags.
   - Connect to both sides; on connect error, print and `process.exit(2)`.
   - Loop entities: build the COUNT SQL, await both sides, `checkTolerance`, push to `results`.
   - Print human table unless `--json`.
   - Write JSON to `<output-dir>/tier-a-rowcount-diff.json` if dir given.
   - `process.exit(2)` on any per-entity error, `1` on any `ok===false`, `0` otherwise.

The HDB client uses a `.exec(sql, callback)` method on the connection (not Node's `child_process.exec`); wrap it in the existing `query()` Promise helper from the migrator pattern.

- [ ] **Step 7.1: Write the script**

Use the structure above. Cross-reference [scripts/migrate-from-hana.js:40-122](../../../scripts/migrate-from-hana.js) for connection patterns. Keep file ASCII LF.

- [ ] **Step 7.2: Smoke-test offline (no real creds)**

```bash
git branch --show-current && \
  IMS_HANA_CREDENTIALS='{"host":"unreachable.invalid","port":"443","user":"x","password":"x","schema":"X"}' \
  CAP_HANA_CREDENTIALS='{"host":"unreachable.invalid","port":"443","user":"x","password":"x","schema":"X"}' \
  node scripts/verify-migration-rowcounts.cjs ; echo "exit=$?"
```
Expected: `✗ Connection error: ...` and `exit=2`.

- [ ] **Step 7.3: Line endings**

```bash
file scripts/verify-migration-rowcounts.cjs
```
Expected: `... ASCII text` (LF, not CRLF).

- [ ] **Step 7.4: Commit**

```bash
git branch --show-current && \
  git add scripts/verify-migration-rowcounts.cjs && \
  git commit -m "feat(migration): Tier-A row-count verifier

Connects to both HDI containers, COUNT per entity, applies tolerance helper.
Exits 0/1/2 for all-pass / diff / error so the orchestrator can halt cleanly.

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Components"
```

---

## Task 8: Orchestrator — `scripts/cutover-rehearsal.cjs`

**Why now:** Migrator + verifier are in place; the orchestrator is the only piece that ties them together for Sitting 2.

**Behavior contract** (matches Spec §Components, the 13 numbered runner steps):

```text
1.  Verify cf target = tutorial-system / dev (refuse otherwise)
2.  Snapshot DEV row counts → preflight-rowcounts.json
3.  Preflight env check: cf env tutorials-srv | grep CONTENT_API_KEY
4.  Document non-action: tutorials-srv left running (printed only)
5.  Prompt for IMS prod org switch; cache source-creds.json
6.  node scripts/migrate-from-hana.js --discover  (probe)
7.  node scripts/migrate-from-hana.js --dry-run   (mapRow check)
8.  Confirmation prompt: type WIPE to overwrite DEV
9.  node scripts/migrate-from-hana.js              (real run)
10. node scripts/verify-migration-rowcounts.cjs    (Tier A)
11. node scripts/compare-systems.js                (Tier B, existing)
12. Print Tier C smoke checklist with URLs
13. Prompt: trigger gh workflow run rebuild-content.yml?
```

Each step writes its stdout+stderr to a per-step log under `.migration-data/cutover-<ISO-timestamp>/<NN>-<step-name>.log`. The runner halts on any non-zero exit and prints the path for forensic review.

**Files:**
- Create: `scripts/cutover-rehearsal.cjs`

**Implementation outline:**

1. CommonJS module, Windows-portable. Top-level `'use strict'`.
2. `OUTPUT_DIR = path.join('.migration-data', 'cutover-' + new Date().toISOString().replace(/[:.]/g, '-'))`. Created at start with `fs.mkdirSync({ recursive: true })`.
3. Helper `runStep(num, name, fn)` — wraps each step with: print "▸ Step NN: name", await fn(), capture exit code. On non-zero exit: print failure summary with log path, `process.exit(1)`.
4. Helper `runChild(num, name, command, args)` — spawns child via `child_process.spawnSync` (Windows-safe, no shell), tees stdout+stderr to console AND to `<OUTPUT_DIR>/<NN>-<name>.log` via a write stream. Returns the exit code.
5. Helper `prompt(question)` — uses `node:readline` to read a line from stdin. Used for confirmation gates (step 8: type WIPE; step 13: type yes/no).
6. **Step 1**: shell out to `cf target`; parse text for `org:` and `space:` lines; exit 1 if not `tutorial-system / dev`.
7. **Step 2**: spawn `node scripts/verify-migration-rowcounts.cjs --output-dir=<OUTPUT_DIR>/preflight --json`. Rename the `tier-a-rowcount-diff.json` output to `preflight-rowcounts.json`. NB: this is the snapshot of *current DEV state*, not yet a comparison — the `source` side will be IMS prod which is what we want to record anyway. (Both sides recorded; only the DEV column is the recovery anchor.)
8. **Step 3**: spawn `cf env tutorials-srv`; grep stdout for `CONTENT_API_KEY=`. If absent, exit 1 with the remediation hint from CLAUDE.md (`cf set-env tutorials-srv CONTENT_API_KEY ... && cf restart tutorials-srv`).
9. **Step 4**: print the documented non-action. No subprocess. Always succeeds.
10. **Step 5**: prompt the user to confirm they have switched cf target to `Developer Destination_IMS / DEV`. Then run `cf service-key ims-hana-prod-container ims-hana-prod-container-key` and write the `credentials` JSON object to `<OUTPUT_DIR>/source-creds.json`. Subsequent steps consume it via env var.
11. **Step 6**: spawn `node scripts/migrate-from-hana.js --discover` with `IMS_HANA_CREDENTIALS=<source-creds-json>` and `CAP_HANA_CREDENTIALS=<target-creds-json>` env. Tee log.
12. **Step 7**: spawn the same with `--dry-run`.
13. **Step 8**: prompt with `Type WIPE to overwrite tutorials-hana DEV: `. If anything other than `WIPE`, exit 1.
14. **Step 9**: spawn the migrator without flags. Same env. Long-running (~15-30 min); the tee'd log lets the operator follow progress.
15. **Step 10**: spawn the verifier with `--output-dir=<OUTPUT_DIR>`. Reuses same env. Halt on exit 1 (diff) or 2 (connection).
16. **Step 11**: spawn `node scripts/compare-systems.js` with `IMS_BASE_URL` and `CAP_BASE_URL` from the spec's known endpoint constants, and `--output=<OUTPUT_DIR>/parity.json`. (If the existing script doesn't accept `--output`, capture stdout to that path instead.)
17. **Step 12**: print the 14-item Tier C checklist (verbatim from spec §Components) to stdout AND write to `<OUTPUT_DIR>/smoke-checklist.md`.
18. **Step 13**: prompt `Trigger content rebuild via gh workflow run rebuild-content.yml? [y/N]: `. If `y`, spawn `gh workflow run rebuild-content.yml`; otherwise print the manual command for the operator.

**Hard-fail behavior**: any non-zero exit halts the runner with a clear summary printed to stderr including the path to the failed step's log.

- [ ] **Step 8.1: Write the script**

Per the outline above. Use `child_process.spawnSync` (not Node's `child_process.exec` — see memory `npm_security_config`'s preference for execFile-style calls). Tee stdout+stderr through `process.stdout.write` plus an `fs.createWriteStream` opened in append mode.

- [ ] **Step 8.2: Smoke-test step 1 only (cf target check)**

The runner should exit 1 immediately if cf is not on tutorial-system/dev. Easiest test: temporarily target a different space, run the script, expect exit 1.

```bash
git branch --show-current
cf target -o tutorial-system -s dev   # ensure we're on dev
node scripts/cutover-rehearsal.cjs --dry-run-step1-only
# Expected: ✓ Step 1 passes; script may then prompt or proceed to step 2.
```

(Add a `--dry-run-step1-only` short-circuit flag to the runner so this smoke test exists; remove it if the runner already exits naturally before any destructive action when given some other guard flag. Pragmatic version: a `--no-act` flag that halts before step 5.)

- [ ] **Step 8.3: Line endings**

```bash
file scripts/cutover-rehearsal.cjs
```
Expected: `... ASCII text` (LF).

- [ ] **Step 8.4: Commit**

```bash
git branch --show-current && \
  git add scripts/cutover-rehearsal.cjs && \
  git commit -m "feat(migration): cutover-rehearsal.cjs orchestrator

13-step Windows-portable runner that drives Sitting 2: cf target check,
preflight snapshots, IMS source-creds capture, discover/dry-run/real
migrate, Tier A and Tier B verification, Tier C checklist, content
rebuild prompt. Hard-fails on any non-zero step exit, leaves a forensic
log per step under .migration-data/cutover-<ts>/.

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md §Components"
```

---

## Task 9: Wire-up — npm scripts and .gitignore

**Files:**
- Modify: `package.json`
- Modify: `.gitignore` (verify only; likely already covers `.migration-data/`)

- [ ] **Step 9.1: Verify .gitignore covers the new artifact path**

```bash
grep -n "migration-data" .gitignore
```
Expected: a line like `.migration-data/` already present. If not, append:

```text
# Cutover-rehearsal artifact pack
.migration-data/cutover-*/
```

- [ ] **Step 9.2: Add npm scripts to package.json**

In the `"scripts"` section, add:

```json
"verify:rowcounts": "node scripts/verify-migration-rowcounts.cjs",
"cutover:rehearsal": "node scripts/cutover-rehearsal.cjs"
```

Place them alphabetically near the other `migrate:*` scripts. Use `jq` to verify the JSON is valid:

```bash
jq '.scripts' package.json | grep -E "verify:rowcounts|cutover:rehearsal"
```
Expected: both scripts appear in the printed object.

- [ ] **Step 9.3: Commit**

```bash
git branch --show-current && \
  git add package.json .gitignore && \
  git commit -m "chore(migration): wire cutover-rehearsal + verify:rowcounts npm scripts

Spec: docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md"
```

---

## Task 10: Push the branch and open PR

**Files:** none — git/GitHub only.

- [ ] **Step 10.1: Run the unit suite once more before push**

```bash
git branch --show-current && npm test -- test/unit/migration-tolerance.test.js
```
Expected: 9 tests pass.

- [ ] **Step 10.2: Verify branch state**

```bash
git branch --show-current
git log --oneline main..HEAD
```
Expected: branch `spec/ims-prod-to-dev-cutover-rehearsal`, ~9 new commits.

- [ ] **Step 10.3: Push and open PR**

```bash
git push -u origin spec/ims-prod-to-dev-cutover-rehearsal && \
  gh pr create --base main \
    --title "spec+scripts: IMS prod → DEV cutover rehearsal (Sitting 1)" \
    --body "Sitting 1 of the IMS-prod → DEV cutover rehearsal.

**Spec:** [docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md](docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md)
**Plan:** [docs/superpowers/plans/2026-06-15-ims-prod-to-dev-cutover-rehearsal-sitting1.md](docs/superpowers/plans/2026-06-15-ims-prod-to-dev-cutover-rehearsal-sitting1.md)

## What this PR adds

- \`scripts/lib/migration-tolerance.cjs\` — pure helper for row-count tolerance (zero on reference tables, ±2 on activity)
- \`scripts/migrate-from-hana.js\` — adds 4 entities (Accomplishments, UserMetaData, AccomplishmentRecords, PrizeRecords) and a \`--list-entities\` flag
- \`scripts/verify-migration-rowcounts.cjs\` — Tier-A row-count diff
- \`scripts/cutover-rehearsal.cjs\` — 13-step Windows-portable orchestrator for Sitting 2
- \`test/unit/migration-tolerance.test.js\` — 9-test Vitest unit suite
- \`package.json\` — wires \`verify:rowcounts\` and \`cutover:rehearsal\` scripts

## What this PR does NOT do

- No CDS schema changes
- No deploys
- Does not run the migration; that is Sitting 2.

## Validation

- [x] \`npm test -- test/unit/migration-tolerance.test.js\` (9/9 pass)
- [x] \`node scripts/migrate-from-hana.js --list-entities\` lists all 16 entities in FK-correct order
- [x] \`node scripts/verify-migration-rowcounts.cjs\` exits 2 with no creds (graceful failure)
- [x] All scripts ASCII LF (no CRLF flips)

## Sitting 2 (the rehearsal day)

Operator runs \`npm run cutover:rehearsal\` after this is merged and Tom is at the keyboard. ~1.5 hr active." \
    --assignee @me
```

- [ ] **Step 10.4: Capture the PR URL**

The `gh pr create` output prints the PR URL on the last line. Note it for the rehearsal-day handoff.

---

## Out-of-scope (deferred to Sitting 2)

- Running the migrator against IMS prod.
- Real cutover-day artifact pack production.
- Tier C functional smoke (Tom in a browser).
- `gh workflow run rebuild-content.yml` execution.
- Anonymization decisions for DEV after the rehearsal.

---

## Recovery notes

- **If a commit slips on the wrong branch** (memory `feedback_branch_slip_after_long_session`): `git log --oneline main..HEAD` should match the commit cadence above; if HEAD has reverted to `main`, re-issue `git checkout spec/ims-prod-to-dev-cutover-rehearsal` in the same Bash invocation as the next commit.
- **If the unit suite hangs in a fresh worktree** (memory `feedback_worktree_tests_hang`): run `npm run setup` first; the postinstall hook needs explicit invocation per `npm_security_config`.
- **If `node --check` fails on the migrator** after a multi-edit pass: most likely a CRLF flip (memory `feedback_crlf_regression_on_windows`); run `file scripts/migrate-from-hana.js` to confirm and re-emit with LF.

---

## Final state of the branch

After Task 10, the branch contains (relative to `main`):

```text
docs/superpowers/specs/2026-06-15-ims-prod-to-dev-cutover-rehearsal-design.md  (already committed in brainstorm)
docs/superpowers/plans/2026-06-15-ims-prod-to-dev-cutover-rehearsal-sitting1.md  (this plan)
scripts/lib/migration-tolerance.cjs                     (Task 1)
test/unit/migration-tolerance.test.js                   (Task 1)
scripts/migrate-from-hana.js                            (modified Tasks 2–6)
scripts/verify-migration-rowcounts.cjs                  (Task 7)
scripts/cutover-rehearsal.cjs                           (Task 8)
package.json                                            (modified Task 9)
.gitignore                                              (verified Task 9)
```

Total ~9-10 commits. PR open against `main`. Sitting 2 starts after merge.



