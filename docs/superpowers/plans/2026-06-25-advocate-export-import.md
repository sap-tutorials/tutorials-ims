# Advocate Export/Import Script Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `scripts/export-advocates.cjs` and `scripts/import-advocates.cjs` so the Developer Advocate roster (records + topics + links + photos) can be snapshotted from any CAP-bound HANA DB to a JSON file on disk and restored idempotently into any other CAP-bound HANA DB.

**Architecture:** Two single-file Node CommonJS scripts run via `cds bind --exec -- node scripts/...`. Both connect with `cds.connect.to('db')` and execute raw entity-level CQN (no HTTP, no service handlers) so we bypass the AdminService sharp/WebP photo re-encoder and the `hasPhoto`/`photoUrl` after-handlers. Photos are pulled via raw HANA SQL to dodge the LOB-locator-expiry bug. Natural-key joins (`Users.email`, `Tags.slug`) re-resolve FKs at import time and gracefully NULL/skip if the target is missing the reference.

**Tech Stack:** Node 22+, `@sap/cds` (CommonJS `require`), HANA via existing `cds bind`, no new deps. Pattern is cloned from [scripts/setup-dev-data.cjs](../../../scripts/setup-dev-data.cjs).

**Spec:** [docs/superpowers/specs/2026-06-25-advocate-export-import-design.md](../specs/2026-06-25-advocate-export-import-design.md)

---

## File Structure

| File | Type | Responsibility |
| --- | --- | --- |
| `scripts/export-advocates.cjs` | Create | Read all `Advocates` (+ topics/links/photos + resolved `Users.email`/`Tags.slug`) from currently-bound DB; serialise to `.migration-data/advocates.json` |
| `scripts/import-advocates.cjs` | Create | Read `.migration-data/advocates.json`; upsert each advocate into currently-bound DB; re-resolve FKs by email/slug; replace topics/links/photo per row |
| `scripts/lib/advocate-io.cjs` | Create | Shared helpers: `advocateTableInfo(isHana)` (table + quoted column names per DB kind, mirrors [srv/lib/_tutorials-table.js](../../../srv/lib/_tutorials-table.js)), `isHanaDb(db)`, `assertSchemaVersion(payload)`, region-validation and link-kind constants. Keeps the two scripts thin and lets us unit-test the helpers without spinning up HANA. |
| `package.json` | Modify | Add `export:advocates` and `import:advocates` npm script aliases |
| `.gitignore` | Verify | Confirm `.migration-data/` is already gitignored (it is — included as a defensive grep step) |
| `test/unit/advocate-io.test.js` | Create | Unit tests for the helpers — schema-version assertion, table-name resolution, error messages |
| `docs/developers/operations/advocate-export-import.md` | Create | One-page runbook (when to use, how to use, what gets carried, warnings to expect) |
| `CLAUDE.md` | Modify | Add a one-line gotcha pointing to the runbook |

The shared `advocate-io.cjs` is the only non-trivial split. The two scripts could embed the helpers directly, but pulling them out means:
- Unit tests don't need HANA (the LOB-fetch and DB-write paths stay in the scripts; the parse/validate/SQL-builder paths live in the helper).
- The schema-version contract has exactly one definition.
- If we later add `compare-advocates.cjs` (out of scope per spec), it reuses the helper.

---

## Task 1: Scaffold helper module + unit tests

**Files:**
- Create: `scripts/lib/advocate-io.cjs`
- Create: `test/unit/advocate-io.test.js`

### Step 1: Write the failing test

- [ ] Create `test/unit/advocate-io.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import {
  SCHEMA_VERSION,
  assertSchemaVersion,
  VALID_REGIONS,
  VALID_LINK_KINDS,
  advocateTableInfo,
  isHanaDb,
} from '../../scripts/lib/advocate-io.cjs';

describe('advocate-io helpers', () => {
  describe('SCHEMA_VERSION', () => {
    it('is 1 for the initial release', () => {
      expect(SCHEMA_VERSION).toBe(1);
    });
  });

  describe('assertSchemaVersion', () => {
    it('accepts the current schema version', () => {
      expect(() => assertSchemaVersion({ schemaVersion: 1 })).not.toThrow();
    });

    it('rejects an older schema version with a clear message', () => {
      expect(() => assertSchemaVersion({ schemaVersion: 0 })).toThrow(
        /schemaVersion 0/
      );
    });

    it('rejects a future schema version with a clear message', () => {
      expect(() => assertSchemaVersion({ schemaVersion: 2 })).toThrow(
        /schemaVersion 2/
      );
    });

    it('rejects a payload missing schemaVersion', () => {
      expect(() => assertSchemaVersion({})).toThrow(/missing schemaVersion/i);
    });
  });

  describe('VALID_REGIONS', () => {
    it('lists exactly the regions from the CDS enum', () => {
      expect([...VALID_REGIONS].sort()).toEqual(['AMERICAS', 'APJ', 'EMEA']);
    });
  });

  describe('VALID_LINK_KINDS', () => {
    it('matches the CDS AdvocateLinks.kind enum', () => {
      expect([...VALID_LINK_KINDS].sort()).toEqual([
        'BlueSky', 'Blog', 'Email', 'GitHub', 'LinkedIn',
        'Mastodon', 'Other', 'SapCommunity', 'X', 'YouTube',
      ]);
    });
  });

  describe('advocateTableInfo(isHana)', () => {
    it('returns UPPERCASE unquoted-style identifiers for HANA', () => {
      const t = advocateTableInfo(true);
      expect(t.advocates).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATES');
      expect(t.topics).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATETOPICS');
      expect(t.links).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS');
      expect(t.photos).toBe('COM_SAP_DEVELOPERS_IMS_ADVOCATEPHOTOS');
      expect(t.users).toBe('COM_SAP_DEVELOPERS_IMS_USERS');
      expect(t.tags).toBe('COM_SAP_DEVELOPERS_IMS_TAGS');
      expect(t.cols.slug).toBe('SLUG');
      expect(t.cols.firstName).toBe('FIRSTNAME');
      expect(t.cols.userFk).toBe('USER_ID');
      expect(t.cols.advocateFk).toBe('ADVOCATE_ID');
      expect(t.cols.tagFk).toBe('TAG_ID');
    });

    it('returns mixed-case CDS-style identifiers for SQLite', () => {
      const t = advocateTableInfo(false);
      expect(t.advocates).toBe('com_sap_developers_ims_Advocates');
      expect(t.topics).toBe('com_sap_developers_ims_AdvocateTopics');
      expect(t.links).toBe('com_sap_developers_ims_AdvocateLinks');
      expect(t.photos).toBe('com_sap_developers_ims_AdvocatePhotos');
      expect(t.users).toBe('com_sap_developers_ims_Users');
      expect(t.tags).toBe('com_sap_developers_ims_Tags');
      expect(t.cols.slug).toBe('slug');
      expect(t.cols.firstName).toBe('firstName');
      expect(t.cols.userFk).toBe('user_ID');
      expect(t.cols.advocateFk).toBe('advocate_ID');
      expect(t.cols.tagFk).toBe('tag_ID');
    });
  });

  describe('isHanaDb', () => {
    it('returns true for { kind: "hana" }', () => {
      expect(isHanaDb({ kind: 'hana' })).toBe(true);
    });

    it('returns true for { kind: "HANA" } (case-insensitive)', () => {
      expect(isHanaDb({ kind: 'HANA' })).toBe(true);
    });

    it('returns false for { kind: "sqlite" }', () => {
      expect(isHanaDb({ kind: 'sqlite' })).toBe(false);
    });

    it('returns false for null / undefined db', () => {
      expect(isHanaDb(null)).toBe(false);
      expect(isHanaDb(undefined)).toBe(false);
    });
  });
});
```

### Step 2: Run the test, watch it fail

- [ ] Run:

```bash
npx vitest run test/unit/advocate-io.test.js
```

Expected: FAIL — `Cannot find module .../scripts/lib/advocate-io.cjs`.

### Step 3: Create the helper module

- [ ] Create `scripts/lib/advocate-io.cjs`:

```javascript
'use strict';

/**
 * Shared helpers for scripts/export-advocates.cjs and scripts/import-advocates.cjs.
 *
 * Lives in CommonJS (.cjs) so both scripts can `require()` it directly even
 * though the repo's package.json declares "type": "module". Kept zero-dep
 * and HANA-free so it can be unit-tested without a DB.
 *
 * The table-info resolver mirrors srv/lib/_tutorials-table.js so both
 * scripts speak the right SQL dialect on either side of `cds bind --exec`.
 */

const SCHEMA_VERSION = 1;

const VALID_REGIONS = new Set(['AMERICAS', 'EMEA', 'APJ']);

// Mirrors the enum in db/advocates.cds (AdvocateLinks.kind).
const VALID_LINK_KINDS = new Set([
  'LinkedIn', 'X', 'Mastodon', 'BlueSky', 'GitHub',
  'YouTube', 'Blog', 'SapCommunity', 'Email', 'Other',
]);

function assertSchemaVersion(payload) {
  if (!payload || typeof payload.schemaVersion === 'undefined') {
    throw new Error(
      'advocates.json is missing schemaVersion - refusing to import. ' +
      'Re-run scripts/export-advocates.cjs against the source DB to regenerate.'
    );
  }
  if (payload.schemaVersion !== SCHEMA_VERSION) {
    throw new Error(
      `advocates.json schemaVersion ${payload.schemaVersion} is not compatible (expected ${SCHEMA_VERSION}). ` +
      `This script supports v${SCHEMA_VERSION} payloads only.`
    );
  }
}

/**
 * @param {object|null} db - the cds.db handle, OR null/undefined
 * @returns {boolean} true when the active DB is SAP HANA
 *
 * Mirrors the check used in srv/lib/advocate-photo-store.js. We don't trust
 * db.kind to be cased consistently across CAP versions.
 */
function isHanaDb(db) {
  if (!db) return false;
  return (db.kind || '').toLowerCase() === 'hana';
}

/**
 * Returns table and column identifiers correctly cased for the active DB.
 *
 * HANA case rules (learned the hard way in PR #404):
 *   - HDI-deployed tables are stored UPPERCASE in HANA's catalog.
 *   - Unquoted identifiers in SQL are folded to UPPERCASE by the parser,
 *     so unquoted UPPERCASE works.
 *   - Quoted lowercase ("com_sap_developers_ims_Advocates") FAILS with
 *     "Could not find table/view" because HANA preserves case in quoted form.
 *   - We therefore emit unquoted UPPERCASE table/column names for HANA.
 *   - Column aliases that need mixed-case JS keys (e.g. `userEmail`) MUST
 *     be quoted: `SELECT U.EMAIL AS "userEmail"`. Otherwise HANA returns
 *     the alias UPPERCASED and the JS property lookup breaks.
 *
 * SQLite (unit/local) rules:
 *   - CDS emits tables with dots-to-underscores, preserving the original
 *     mixed case (e.g. com_sap_developers_ims_Advocates).
 *   - Columns are stored in their original CDS casing (e.g. firstName).
 *   - Identifiers can stay unquoted in raw SQL.
 *
 * @param {boolean} isHana
 * @returns {{
 *   advocates: string, topics: string, links: string, photos: string,
 *   users: string, tags: string,
 *   cols: {
 *     id: string, slug: string, firstName: string, lastName: string,
 *     title: string, pronouns: string, location: string, region: string,
 *     bio: string, isActive: string, sortOverride: string, joinedDate: string,
 *     hasPhoto: string, photoUpdatedAt: string, photoUrl: string,
 *     userFk: string, advocateFk: string, tagFk: string,
 *     kind: string, url: string, label: string, sortOrder: string,
 *     email: string, createdAt: string,
 *     photo256: string, photo64: string, photoMimeType: string,
 *     sizeBytes: string, sha256: string, uploadedAt: string,
 *   }
 * }}
 */
function advocateTableInfo(isHana) {
  if (isHana) {
    return {
      advocates: 'COM_SAP_DEVELOPERS_IMS_ADVOCATES',
      topics:    'COM_SAP_DEVELOPERS_IMS_ADVOCATETOPICS',
      links:     'COM_SAP_DEVELOPERS_IMS_ADVOCATELINKS',
      photos:    'COM_SAP_DEVELOPERS_IMS_ADVOCATEPHOTOS',
      users:     'COM_SAP_DEVELOPERS_IMS_USERS',
      tags:      'COM_SAP_DEVELOPERS_IMS_TAGS',
      cols: {
        id: 'ID', slug: 'SLUG',
        firstName: 'FIRSTNAME', lastName: 'LASTNAME',
        title: 'TITLE', pronouns: 'PRONOUNS', location: 'LOCATION', region: 'REGION',
        bio: 'BIO', isActive: 'ISACTIVE', sortOverride: 'SORTOVERRIDE',
        joinedDate: 'JOINEDDATE',
        hasPhoto: 'HASPHOTO', photoUpdatedAt: 'PHOTOUPDATEDAT', photoUrl: 'PHOTOURL',
        userFk: 'USER_ID', advocateFk: 'ADVOCATE_ID', tagFk: 'TAG_ID',
        kind: 'KIND', url: 'URL', label: 'LABEL', sortOrder: 'SORTORDER',
        email: 'EMAIL', createdAt: 'CREATEDAT',
        photo256: 'PHOTO256', photo64: 'PHOTO64', photoMimeType: 'PHOTOMIMETYPE',
        sizeBytes: 'SIZEBYTES', sha256: 'SHA256', uploadedAt: 'UPLOADEDAT',
      },
    };
  }
  // SQLite — CDS-emitted mixed-case names.
  return {
    advocates: 'com_sap_developers_ims_Advocates',
    topics:    'com_sap_developers_ims_AdvocateTopics',
    links:     'com_sap_developers_ims_AdvocateLinks',
    photos:    'com_sap_developers_ims_AdvocatePhotos',
    users:     'com_sap_developers_ims_Users',
    tags:      'com_sap_developers_ims_Tags',
    cols: {
      id: 'ID', slug: 'slug',
      firstName: 'firstName', lastName: 'lastName',
      title: 'title', pronouns: 'pronouns', location: 'location', region: 'region',
      bio: 'bio', isActive: 'isActive', sortOverride: 'sortOverride',
      joinedDate: 'joinedDate',
      hasPhoto: 'hasPhoto', photoUpdatedAt: 'photoUpdatedAt', photoUrl: 'photoUrl',
      userFk: 'user_ID', advocateFk: 'advocate_ID', tagFk: 'tag_ID',
      kind: 'kind', url: 'url', label: 'label', sortOrder: 'sortOrder',
      email: 'email', createdAt: 'createdAt',
      photo256: 'photo256', photo64: 'photo64', photoMimeType: 'photoMimeType',
      sizeBytes: 'sizeBytes', sha256: 'sha256', uploadedAt: 'uploadedAt',
    },
  };
}

module.exports = {
  SCHEMA_VERSION,
  VALID_REGIONS,
  VALID_LINK_KINDS,
  assertSchemaVersion,
  isHanaDb,
  advocateTableInfo,
};
```

### Step 4: Re-run the test, watch it pass

- [ ] Run:

```bash
npx vitest run test/unit/advocate-io.test.js
```

Expected: PASS — all tests green.

### Step 5: Commit

- [ ] Run:

```bash
git add scripts/lib/advocate-io.cjs test/unit/advocate-io.test.js
git commit -m "feat(advocates): scaffold shared advocate-io helpers + unit tests

Schema version, region enum, link-kind enum, version-assertion,
isHanaDb check, and advocateTableInfo resolver (HANA UPPERCASE vs
SQLite mixed-case) used by export-advocates.cjs and import-advocates.cjs.

Mirrors srv/lib/_tutorials-table.js. CommonJS so both .cjs scripts can
require() it. Zero-dep so unit-testable without HANA.

Refs spec: docs/superpowers/specs/2026-06-25-advocate-export-import-design.md"
```

---

## Task 2: Export script — non-photo fields + dry-run skeleton

**Files:**
- Create: `scripts/export-advocates.cjs`

### Step 1: Create the script skeleton

- [ ] Create `scripts/export-advocates.cjs`:

```javascript
#!/usr/bin/env node
'use strict';

/**
 * export-advocates.cjs — Snapshot the Developer Advocate roster to JSON.
 *
 * Reads every Advocates row (plus its topics, links, and photo BLOBs) from
 * the currently-bound CAP database and writes a self-contained snapshot to
 * .migration-data/advocates.json. The companion script import-advocates.cjs
 * restores the snapshot into any other CAP-bound DB.
 *
 * Spec: docs/superpowers/specs/2026-06-25-advocate-export-import-design.md
 *
 * Usage:
 *   cf login                              # to the source space (DEV typically)
 *   npm run export:advocates              # writes .migration-data/advocates.json
 *
 *   # Or explicitly:
 *   cds bind --exec -- node scripts/export-advocates.cjs
 *
 * Flags:
 *   --out <path>   Override the output file (default: .migration-data/advocates.json)
 *   --dry-run      Don't write the file; print summary only
 */

const cds = require('@sap/cds');
const fs = require('fs');
const path = require('path');
const {
  SCHEMA_VERSION,
  isHanaDb,
  advocateTableInfo,
} = require('./lib/advocate-io.cjs');

function parseArgs(argv) {
  const args = { out: '.migration-data/advocates.json', dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') args.dryRun = true;
    else if (a === '--out') {
      if (i + 1 >= argv.length) { console.error('--out requires a value'); process.exit(2); }
      args.out = argv[++i];
    }
    else if (a === '--help' || a === '-h') {
      console.log(__filename, '- see header comment for usage');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));
  await cds.load('*');
  const db = await cds.connect.to('db');
  const isHana = isHanaDb(db);
  const T = advocateTableInfo(isHana);

  console.log(`[advocates-export] schemaVersion=${SCHEMA_VERSION}`);
  console.log(`[advocates-export] DB kind: ${db.kind} (isHana=${isHana})`);

  // ── TODO Task 2 Step 3 onwards ─────────────────────────────────────
  console.log('[advocates-export] (skeleton — fetch logic added in subsequent steps)');
  process.exit(0);
})().catch(err => {
  console.error('[advocates-export] FAILED:', err);
  process.exit(1);
});
```

### Step 2: Verify the skeleton runs

- [ ] Run (requires `cf login` to DEV space and a `cds bind` having been done in this worktree):

```bash
cds bind --exec -- node scripts/export-advocates.cjs --dry-run
```

Expected:

```
[advocates-export] schemaVersion=1
[advocates-export] DB kind: hana
[advocates-export] (skeleton — fetch logic added in subsequent steps)
```

(If `cds bind` hasn't been done, the test is to confirm the script *parses* — run `node -c scripts/export-advocates.cjs` and expect no output / exit 0.)

### Step 3: Add the Advocates + email join query

- [ ] Replace the `── TODO Task 2 Step 3 onwards ──` block with:

```javascript
  // Fetch every Advocate, left-joining Users to resolve email at export time.
  // No LargeBinary columns here, so no LOB-locator concern. We DO include
  // bio (LargeString / CLOB) — CLOBs return inline as JS strings on HANA,
  // unlike LargeBinary.
  //
  // Column aliases are quoted with mixed case so the JS-side result objects
  // expose `userEmail`, `firstName`, etc. — unquoted aliases come back
  // UPPERCASED from HANA.
  const c = T.cols;
  const advocateRows = await db.run(`
    SELECT
      A.${c.id}             AS "id",
      A.${c.slug}           AS "slug",
      A.${c.firstName}      AS "firstName",
      A.${c.lastName}       AS "lastName",
      A.${c.title}          AS "title",
      A.${c.pronouns}       AS "pronouns",
      A.${c.location}       AS "location",
      A.${c.region}         AS "region",
      A.${c.bio}            AS "bio",
      A.${c.isActive}       AS "isActive",
      A.${c.sortOverride}   AS "sortOverride",
      A.${c.joinedDate}     AS "joinedDate",
      A.${c.hasPhoto}       AS "hasPhoto",
      A.${c.photoUpdatedAt} AS "photoUpdatedAt",
      A.${c.photoUrl}       AS "photoUrl",
      U.${c.email}          AS "userEmail"
    FROM ${T.advocates} AS A
    LEFT JOIN ${T.users} AS U ON U.${c.id} = A.${c.userFk}
    ORDER BY A.${c.slug}
  `);
  console.log(`[advocates-export] Found ${advocateRows.length} advocate(s)`);

  // Detect duplicate userEmail values in source (would cause @assert.unique.user
  // violation on import). NULL emails are allowed multiple times — HANA's
  // UNIQUE-on-nullable treats NULLs as distinct.
  const seenEmails = new Map();
  for (const a of advocateRows) {
    if (!a.userEmail) continue;
    const lower = a.userEmail.toLowerCase();
    if (seenEmails.has(lower)) {
      throw new Error(
        `Two advocates have the same userEmail in source DB: ` +
        `'${seenEmails.get(lower)}' and '${a.slug}' both linked to ${a.userEmail}. ` +
        `Fix in source admin UI before re-running.`
      );
    }
    seenEmails.set(lower, a.slug);
  }
```

### Step 4: Add topics and links queries

- [ ] Append (still inside the async IIFE, before the `process.exit(0)`):

```javascript
  // Topics — natural-key join on Tags.slug. Tags.slug is unique-asserted, so
  // one row per (advocate, tagSlug) pair. Inner join: if a Tag has been
  // deleted in source after the AdvocateTopic was created, the dangling
  // junction row is dropped from the export (it's already broken anyway).
  const topicRows = await db.run(`
    SELECT
      AT.${c.advocateFk} AS "advocateId",
      T.${c.slug}        AS "tagSlug"
    FROM ${T.topics} AS AT
    INNER JOIN ${T.tags} AS T ON T.${c.id} = AT.${c.tagFk}
    ORDER BY AT.${c.advocateFk}, T.${c.slug}
  `);

  const linkRows = await db.run(`
    SELECT
      ${c.advocateFk} AS "advocateId",
      ${c.kind}       AS "kind",
      ${c.url}        AS "url",
      ${c.label}      AS "label",
      ${c.sortOrder}  AS "sortOrder"
    FROM ${T.links}
    ORDER BY ${c.advocateFk}, ${c.sortOrder}, ${c.kind}
  `);

  // Index by advocate.id for assembly.
  const topicsByAdvocate = new Map();
  for (const t of topicRows) {
    if (!topicsByAdvocate.has(t.advocateId)) topicsByAdvocate.set(t.advocateId, []);
    topicsByAdvocate.get(t.advocateId).push({ tagSlug: t.tagSlug });
  }
  const linksByAdvocate = new Map();
  for (const l of linkRows) {
    if (!linksByAdvocate.has(l.advocateId)) linksByAdvocate.set(l.advocateId, []);
    linksByAdvocate.get(l.advocateId).push({
      kind: l.kind,
      url: l.url,
      label: l.label,
      sortOrder: l.sortOrder,
    });
  }
```

### Step 5: Assemble and (dry-run) write JSON

- [ ] Append:

```javascript
  const payload = {
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    sourceDb: `${db.kind} (${process.env.CF_ORGANIZATION_NAME || 'unknown-org'}/${process.env.CF_SPACE_NAME || 'unknown-space'})`,
    advocateCount: advocateRows.length,
    advocates: advocateRows.map(a => ({
      slug: a.slug,
      firstName: a.firstName,
      lastName: a.lastName,
      title: a.title,
      pronouns: a.pronouns,
      location: a.location,
      region: a.region,
      bio: a.bio,
      isActive: a.isActive,
      sortOverride: a.sortOverride,
      joinedDate: a.joinedDate,
      hasPhoto: a.hasPhoto,
      photoUpdatedAt: a.photoUpdatedAt,
      photoUrl: a.photoUrl,
      userEmail: a.userEmail || null,
      topics: topicsByAdvocate.get(a.id) || [],
      links:  linksByAdvocate.get(a.id)  || [],
      photo:  null,  // populated in Task 3
    })),
  };

  const topicsCount = [...topicsByAdvocate.values()].reduce((n, arr) => n + arr.length, 0);
  const linksCount  = [...linksByAdvocate.values()].reduce((n, arr) => n + arr.length, 0);
  console.log(`[advocates-export] Topics: ${topicsCount}, Links: ${linksCount}`);

  if (args.dryRun) {
    console.log('[advocates-export] --dry-run: would write payload (no file)');
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, JSON.stringify(payload, null, 2));
  const bytes = fs.statSync(args.out).size;
  console.log(`[advocates-export] Wrote ${args.out} (${(bytes / 1024).toFixed(1)} KB)`);
```

### Step 6: Smoke-test against DEV (manual; not a Vitest)

- [ ] Run:

```bash
cds bind --exec -- node scripts/export-advocates.cjs --dry-run
```

Expected output (counts vary by DB state):

```
[advocates-export] schemaVersion=1
[advocates-export] DB kind: hana
[advocates-export] Found 42 advocate(s)
[advocates-export] Topics: 156, Links: 88
[advocates-export] --dry-run: would write payload (no file)
```

If the script throws on the duplicate-email check, that's a real DEV-data issue — Tom needs to fix it via admin UI before re-running.

### Step 7: Commit

- [ ] Run:

```bash
git add scripts/export-advocates.cjs
git commit -m "feat(advocates): export non-photo fields + dry-run

Reads Advocates with LEFT JOIN Users (for userEmail), plus AdvocateTopics
joined to Tags.slug and AdvocateLinks. Detects duplicate userEmail at
export time so a future @assert.unique.user violation surfaces early.

Refs spec section 'Export payload'"
```

---

## Task 3: Export script — photo BLOB retrieval

**Files:**
- Modify: `scripts/export-advocates.cjs`

### Step 1: Add per-advocate photo fetch loop

- [ ] Insert BEFORE the `const payload = { ... }` assembly block (so the `photo: null` line you add later becomes `photo: photosByAdvocate.get(a.id) || null`):

```javascript
  // Photos — fetched in a SEPARATE query per advocate to dodge the HANA
  // LOB-locator-expiry bug (locator returned by a multi-column SELECT
  // expires before we can read the stream). Same workaround as
  // srv/lib/content-store.js and srv/lib/advocate-photo-store.js.
  // SQLite path uses CDS QL — no LOB locator concern there.
  const photosByAdvocate = new Map();
  const advocatesWithPhoto = advocateRows.filter(a => a.hasPhoto);
  console.log(`[advocates-export] Fetching ${advocatesWithPhoto.length} photo(s)…`);

  for (const a of advocatesWithPhoto) {
    let photoMeta, photo256, photo64;
    if (isHana) {
      // HANA: raw SQL, UPPERCASE identifiers. Pull both BLOBs + metadata
      // in one shot. HANA returns LargeBinary as Buffers.
      const rows = await db.run(
        `SELECT
           ${c.photo256}      AS "photo256",
           ${c.photo64}       AS "photo64",
           ${c.photoMimeType} AS "photoMimeType",
           ${c.sizeBytes}     AS "sizeBytes",
           ${c.sha256}        AS "sha256",
           ${c.uploadedAt}    AS "uploadedAt"
         FROM ${T.photos}
         WHERE ${c.advocateFk} = ?`,
        [a.id]
      );
      if (rows.length === 0) continue;
      photo256 = rows[0].photo256;
      photo64  = rows[0].photo64;
      photoMeta = {
        photoMimeType: rows[0].photoMimeType,
        sizeBytes: rows[0].sizeBytes,
        sha256: rows[0].sha256,
        uploadedAt: rows[0].uploadedAt,
      };
    } else {
      // SQLite (unit/local). CDS QL is fine; no LOB locator issue.
      const SELECT_ = cds.ql.SELECT;
      const [row] = await db.run(
        SELECT_.from('com.sap.developers.ims.AdvocatePhotos').where({ advocate_ID: a.id })
      );
      if (!row) continue;
      photo256 = row.photo256;
      photo64  = row.photo64;
      photoMeta = {
        photoMimeType: row.photoMimeType,
        sizeBytes: row.sizeBytes,
        sha256: row.sha256,
        uploadedAt: row.uploadedAt,
      };
    }
    photosByAdvocate.set(a.id, {
      photoMimeType: photoMeta.photoMimeType,
      sizeBytes: photoMeta.sizeBytes,
      sha256: photoMeta.sha256,
      uploadedAt: photoMeta.uploadedAt,
      photo256_b64: Buffer.from(photo256).toString('base64'),
      photo64_b64:  Buffer.from(photo64 ).toString('base64'),
    });
  }
  console.log(`[advocates-export] Encoded ${photosByAdvocate.size} photo(s) as base64`);
```

- [ ] Then change the `photo: null` line in the `.map(a => ({ ... }))` to:

```javascript
      photo: photosByAdvocate.get(a.id) || null,
```

### Step 2: Smoke-test with photos

- [ ] Run (no `--dry-run` this time):

```bash
cds bind --exec -- node scripts/export-advocates.cjs --out .migration-data/advocates.json
```

- [ ] Verify the file looks right:

```bash
node -e "
const p = JSON.parse(require('fs').readFileSync('.migration-data/advocates.json'));
console.log('schemaVersion:', p.schemaVersion);
console.log('advocates:', p.advocateCount);
const withPhoto = p.advocates.filter(a => a.photo);
console.log('with photo:', withPhoto.length);
if (withPhoto.length) {
  const ex = withPhoto[0];
  console.log('sample:', ex.slug, ex.photo.photoMimeType, ex.photo.sizeBytes, 'bytes',
              ex.photo.photo256_b64.length, 'b64 chars');
}
"
```

Expected: counts match, `photoMimeType` is `image/webp`, `sizeBytes` > 0, `photo256_b64.length` ≈ 4/3 × sizeBytes.

### Step 3: Commit

- [ ] Run:

```bash
git add scripts/export-advocates.cjs
git commit -m "feat(advocates): export photo BLOBs via raw SQL on HANA

Separate per-advocate SELECT against AdvocatePhotos to dodge the HANA
LOB-locator-expiry bug (same workaround as srv/lib/content-store.js).
SQLite falls back to a single CDS QL query. Photos base64-encoded for
JSON transport.

Refs spec section 'Photo BLOB retrieval'"
```

---

## Task 4: Import script — skeleton + payload validation

**Files:**
- Create: `scripts/import-advocates.cjs`

### Step 1: Create the script skeleton

- [ ] Create `scripts/import-advocates.cjs`:

```javascript
#!/usr/bin/env node
'use strict';

/**
 * import-advocates.cjs — Restore the Developer Advocate roster from a JSON snapshot.
 *
 * Reads .migration-data/advocates.json (produced by scripts/export-advocates.cjs)
 * and upserts each advocate into the currently-bound CAP database. Idempotent:
 * re-running converges target to match source. Topics/links/photo are
 * replace-not-merge.
 *
 * Uses raw cds.db.run() against entity-level CQN — no AdminService, no sharp
 * re-encoding, no after-handlers, no draft-table indirection.
 *
 * Spec: docs/superpowers/specs/2026-06-25-advocate-export-import-design.md
 *
 * Usage:
 *   cf login                              # to the target space (PROD typically)
 *   npm run import:advocates              # reads .migration-data/advocates.json
 *
 *   # Or explicitly:
 *   cds bind --exec -- node scripts/import-advocates.cjs
 *
 * Flags:
 *   --in <path>    Override the input file (default: .migration-data/advocates.json)
 */

const cds = require('@sap/cds');
const fs = require('fs');
const crypto = require('crypto');
const {
  VALID_REGIONS,
  VALID_LINK_KINDS,
  assertSchemaVersion,
  isHanaDb,
  advocateTableInfo,
} = require('./lib/advocate-io.cjs');

function parseArgs(argv) {
  const args = { in: '.migration-data/advocates.json' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--in') {
      if (i + 1 >= argv.length) { console.error('--in requires a value'); process.exit(2); }
      args.in = argv[++i];
    }
    else if (a === '--help' || a === '-h') {
      console.log(__filename, '- see header comment for usage');
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(args.in)) {
    console.error(`[advocates-import] Input file not found: ${args.in}`);
    console.error(`[advocates-import] Run 'npm run export:advocates' first.`);
    process.exit(1);
  }
  const payload = JSON.parse(fs.readFileSync(args.in, 'utf8'));
  assertSchemaVersion(payload);

  await cds.load('*');
  const db = await cds.connect.to('db');
  const isHana = isHanaDb(db);
  const T = advocateTableInfo(isHana);

  console.log(`[advocates-import] schemaVersion=${payload.schemaVersion}`);
  console.log(`[advocates-import] Source: ${payload.sourceDb || 'unknown'} (exported ${payload.exportedAt})`);
  console.log(`[advocates-import] Target DB kind: ${db.kind} (isHana=${isHana})`);
  console.log(`[advocates-import] Advocates in payload: ${payload.advocateCount}`);

  // ── TODO Task 5 onwards ───────────────────────────────────────────
  process.exit(0);
})().catch(err => {
  console.error('[advocates-import] FAILED:', err);
  process.exit(1);
});
```

### Step 2: Smoke-test the skeleton

- [ ] Run:

```bash
cds bind --exec -- node scripts/import-advocates.cjs
```

Expected (assuming `.migration-data/advocates.json` exists from Task 3):

```
[advocates-import] schemaVersion=1
[advocates-import] Source: hana (...) (exported 2026-06-25T...)
[advocates-import] Target DB kind: hana
[advocates-import] Advocates in payload: 42
```

### Step 3: Test the schema-version reject path

- [ ] Run (with a synthetic bad payload):

```bash
echo '{"schemaVersion":2,"advocates":[]}' > /tmp/bad.json
cds bind --exec -- node scripts/import-advocates.cjs --in /tmp/bad.json
```

Expected: exit 1, message containing `schemaVersion 2 is not compatible — expected 1`.

### Step 4: Commit

- [ ] Run:

```bash
git add scripts/import-advocates.cjs
git commit -m "feat(advocates): import script skeleton + payload validation

Loads .migration-data/advocates.json, asserts schemaVersion, opens DB
connection. Per-advocate upsert logic added in subsequent commits.

Refs spec section 'Import behavior'"
```

---

## Task 5: Import script — Advocates upsert with FK re-resolution

**Files:**
- Modify: `scripts/import-advocates.cjs`

### Step 1: Add the per-advocate upsert loop (Advocates row only — topics/links/photo come next)

- [ ] Replace the `── TODO Task 5 onwards ──` block with:

```javascript
  const c = T.cols;
  const stats = {
    advocates: { inserted: 0, updated: 0 },
    users:     { matched: 0, nulled: 0, nulledEmails: [] },
    topics:    { matched: 0, skipped: 0, missingTags: new Set() },
    links:     { inserted: 0 },
    photos:    { imported: 0, absent: 0 },
  };

  for (const adv of payload.advocates) {
    // ── Lightweight payload validation ──────────────────────────────
    if (!adv.slug)      throw new Error(`Advocate missing slug: ${JSON.stringify(adv).slice(0, 200)}`);
    if (!adv.firstName) throw new Error(`Advocate ${adv.slug} missing firstName`);
    if (!adv.lastName)  throw new Error(`Advocate ${adv.slug} missing lastName`);
    if (adv.region && !VALID_REGIONS.has(adv.region)) {
      throw new Error(`Advocate ${adv.slug} has invalid region: ${adv.region}`);
    }

    // ── Resolve user_ID by email (case-insensitive) ────────────────
    let userId = null;
    if (adv.userEmail) {
      const matches = await db.run(
        `SELECT ${c.id} AS "id" FROM ${T.users}
         WHERE LOWER(${c.email}) = LOWER(?)
         ORDER BY ${c.createdAt} ASC`,
        [adv.userEmail]
      );
      if (matches.length > 0) {
        userId = matches[0].id;
        stats.users.matched++;
        if (matches.length > 1) {
          console.warn(`[${adv.slug}] WARN: ${matches.length} Users rows match email ${adv.userEmail} — picking earliest createdAt`);
        }
      } else {
        stats.users.nulled++;
        stats.users.nulledEmails.push(adv.userEmail);
        console.warn(`[${adv.slug}] user FK not resolved: ${adv.userEmail} missing in target — inserting with user_ID=NULL`);
      }
    }

    // ── Upsert Advocates ────────────────────────────────────────────
    const existing = await db.run(
      `SELECT ${c.id} AS "id" FROM ${T.advocates} WHERE ${c.slug} = ?`,
      [adv.slug]
    );

    const advocateId = existing.length > 0 ? existing[0].id : crypto.randomUUID();
    const isUpdate = existing.length > 0;

    // Column-list order is the source of truth for the parameter array below.
    // Keep them in lock-step.
    const updatableCols = [
      c.firstName, c.lastName, c.title, c.pronouns, c.location, c.region,
      c.bio, c.isActive, c.sortOverride, c.joinedDate,
      c.hasPhoto, c.photoUpdatedAt, c.photoUrl, c.userFk,
    ];
    const updatableValues = [
      adv.firstName, adv.lastName, adv.title, adv.pronouns, adv.location, adv.region,
      adv.bio, adv.isActive, adv.sortOverride, adv.joinedDate,
      adv.hasPhoto, adv.photoUpdatedAt, adv.photoUrl, userId,
    ];

    if (isUpdate) {
      const setClause = updatableCols.map(col => `${col} = ?`).join(', ');
      await db.run(
        `UPDATE ${T.advocates} SET ${setClause} WHERE ${c.id} = ?`,
        [...updatableValues, advocateId]
      );
      stats.advocates.updated++;
    } else {
      const allCols = [c.id, c.slug, ...updatableCols].join(', ');
      const placeholders = ['?', '?', ...updatableCols.map(() => '?')].join(', ');
      await db.run(
        `INSERT INTO ${T.advocates} (${allCols}) VALUES (${placeholders})`,
        [advocateId, adv.slug, ...updatableValues]
      );
      stats.advocates.inserted++;
    }

    // ── TODO Task 6: topics, links, photo ───────────────────────────
  }

  // ── Summary ──────────────────────────────────────────────────────
  console.log('');
  console.log(`[advocates-import] Imported ${payload.advocateCount} advocates: ${stats.advocates.updated} updated, ${stats.advocates.inserted} inserted`);
  console.log(`[advocates-import] FK resolution: ${stats.users.matched} users matched, ${stats.users.nulled} NULLed`);
  if (stats.users.nulled > 0) {
    console.log(`                   (${stats.users.nulledEmails.join(', ')})`);
  }
  console.log('[advocates-import] (topics/links/photos pending Task 6)');
```

### Step 2: Smoke-test against a local SQLite or hybrid DB

This is the riskiest task and the one with the most ways to be wrong against HANA. Run against a clean local SQLite first (no `cds bind`):

- [ ] Run:

```bash
# Deploy schema to in-memory SQLite, seed nothing, then import.
cds deploy --to sqlite:test.sqlite > /dev/null
CDS_REQUIRES_DB_KIND=sqlite CDS_REQUIRES_DB_CREDENTIALS_URL=test.sqlite \
  node scripts/import-advocates.cjs --in .migration-data/advocates.json
```

Expected: all advocates report as **inserted** (not updated), all users **NULLed** (empty Users table in fresh sqlite), no errors.

- [ ] Then run again on the same SQLite (idempotency check):

```bash
CDS_REQUIRES_DB_KIND=sqlite CDS_REQUIRES_DB_CREDENTIALS_URL=test.sqlite \
  node scripts/import-advocates.cjs --in .migration-data/advocates.json
```

Expected: all advocates **updated** (not inserted) — same count, just under the "updated" column. `rm test.sqlite` when done.

### Step 3: Commit

- [ ] Run:

```bash
git add scripts/import-advocates.cjs
git commit -m "feat(advocates): upsert Advocates row + email FK re-resolution

Per advocate: case-insensitive email lookup against Users, NULL on
miss with WARN log. UPDATE-or-INSERT by slug; existing ID preserved
on UPDATE. Validates payload region/firstName/lastName/slug eagerly.
Topics/links/photo handled in next commit.

Refs spec section 'Import behavior' steps 1-3"
```

---

## Task 6: Import script — topics, links, photo replace logic

**Files:**
- Modify: `scripts/import-advocates.cjs`

### Step 1: Add topics replace logic

- [ ] Replace the `── TODO Task 6 ──` block with:

```javascript
    // ── Replace topics ──────────────────────────────────────────────
    await db.run(
      `DELETE FROM ${T.topics} WHERE ${c.advocateFk} = ?`,
      [advocateId]
    );
    for (const t of (adv.topics || [])) {
      const tagRows = await db.run(
        `SELECT ${c.id} AS "id" FROM ${T.tags} WHERE ${c.slug} = ?`,
        [t.tagSlug]
      );
      if (tagRows.length === 0) {
        stats.topics.skipped++;
        stats.topics.missingTags.add(t.tagSlug);
        console.warn(`[${adv.slug}] topic skipped: tag '${t.tagSlug}' missing in target`);
        continue;
      }
      await db.run(
        `INSERT INTO ${T.topics} (${c.id}, ${c.advocateFk}, ${c.tagFk})
         VALUES (?, ?, ?)`,
        [crypto.randomUUID(), advocateId, tagRows[0].id]
      );
      stats.topics.matched++;
    }

    // ── Replace links ───────────────────────────────────────────────
    await db.run(
      `DELETE FROM ${T.links} WHERE ${c.advocateFk} = ?`,
      [advocateId]
    );
    for (const l of (adv.links || [])) {
      if (!VALID_LINK_KINDS.has(l.kind)) {
        throw new Error(`Advocate ${adv.slug} has link with invalid kind: ${l.kind}`);
      }
      await db.run(
        `INSERT INTO ${T.links}
           (${c.id}, ${c.advocateFk}, ${c.kind}, ${c.url}, ${c.label}, ${c.sortOrder})
         VALUES (?, ?, ?, ?, ?, ?)`,
        [crypto.randomUUID(), advocateId, l.kind, l.url, l.label, l.sortOrder]
      );
      stats.links.inserted++;
    }

    // ── Replace photo ───────────────────────────────────────────────
    await db.run(
      `DELETE FROM ${T.photos} WHERE ${c.advocateFk} = ?`,
      [advocateId]
    );
    if (adv.photo) {
      const photo256 = Buffer.from(adv.photo.photo256_b64, 'base64');
      const photo64  = Buffer.from(adv.photo.photo64_b64,  'base64');
      await db.run(
        `INSERT INTO ${T.photos}
           (${c.advocateFk}, ${c.photo256}, ${c.photo64}, ${c.photoMimeType},
            ${c.sizeBytes},  ${c.sha256},   ${c.uploadedAt})
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [advocateId, photo256, photo64, adv.photo.photoMimeType,
         adv.photo.sizeBytes, adv.photo.sha256, adv.photo.uploadedAt]
      );
      stats.photos.imported++;
    } else {
      stats.photos.absent++;
    }
```

### Step 2: Update the final summary to print topic/link/photo lines

- [ ] Replace the `(topics/links/photos pending Task 6)` line and what comes after with:

```javascript
  if (stats.topics.skipped > 0) {
    const tagsList = [...stats.topics.missingTags].join(', ');
    console.log(`[advocates-import] Topics:  ${stats.topics.matched} matched, ${stats.topics.skipped} skipped`);
    console.log(`                   (missing tags: ${tagsList})`);
  } else {
    console.log(`[advocates-import] Topics:  ${stats.topics.matched} matched, 0 skipped`);
  }
  console.log(`[advocates-import] Links:   ${stats.links.inserted} inserted`);
  console.log(`[advocates-import] Photos:  ${stats.photos.imported} imported, ${stats.photos.absent} had no photo`);
  console.log(`[advocates-import] Done.`);
```

### Step 3: End-to-end smoke test on local SQLite

- [ ] Run:

```bash
rm -f test.sqlite
cds deploy --to sqlite:test.sqlite > /dev/null
CDS_REQUIRES_DB_KIND=sqlite CDS_REQUIRES_DB_CREDENTIALS_URL=test.sqlite \
  node scripts/import-advocates.cjs --in .migration-data/advocates.json
```

Expected: all advocates inserted, every topic skipped (`(missing tags: ...)` — empty Tags in clean SQLite is expected), links all inserted, photos imported = number with photos in source.

- [ ] Verify photo bytes round-trip (SQLite-specific verification — table names are CDS mixed-case, booleans stored as integers):

```bash
node -e "
const cds = require('@sap/cds');
(async () => {
  process.env.CDS_REQUIRES_DB_KIND = 'sqlite';
  process.env.CDS_REQUIRES_DB_CREDENTIALS_URL = 'test.sqlite';
  await cds.load('*');
  const db = await cds.connect.to('db');
  const [adv] = await db.run('SELECT ID, slug FROM com_sap_developers_ims_Advocates WHERE hasPhoto = 1 LIMIT 1');
  if (!adv) { console.log('no photo advocates'); return; }
  const [photo] = await db.run('SELECT photo256, photo64, sizeBytes, sha256 FROM com_sap_developers_ims_AdvocatePhotos WHERE advocate_ID = ?', [adv.ID]);
  const crypto = require('crypto');
  const actualSha = crypto.createHash('sha256').update(photo.photo256).digest('hex');
  console.log('advocate:', adv.slug);
  console.log('exported sha256:', photo.sha256);
  console.log('actual   sha256:', actualSha);
  console.log('sha match:', actualSha === photo.sha256);
  console.log('size match:', photo.photo256.length === photo.sizeBytes);
})();
"
rm -f test.sqlite
```

Expected: `sha match: true`, `size match: true`. (Confirms bytes survived base64 round-trip intact.)

### Step 4: Commit

- [ ] Run:

```bash
git add scripts/import-advocates.cjs
git commit -m "feat(advocates): replace topics, links, photo on import

DELETE+INSERT per advocate for the three child tables. Topics
re-resolve Tags by slug; missing slugs skipped with WARN and
collected for the summary. Links validate kind against the CDS
enum. Photos decode base64 -> Buffer and INSERT into AdvocatePhotos.

End-to-end SQLite smoke test confirms photo bytes round-trip
with sha256 match.

Refs spec section 'Import behavior' steps 4-6"
```

---

## Task 7: Wire npm script aliases + verify .gitignore

**Files:**
- Modify: `package.json`
- Verify: `.gitignore`

### Step 1: Add the npm script aliases

- [ ] Edit `package.json` and add to the `scripts` block (alphabetised next to existing `export:` / `setup-dev-data`):

```json
    "export:advocates": "cds bind --exec -- node scripts/export-advocates.cjs",
    "import:advocates": "cds bind --exec -- node scripts/import-advocates.cjs",
```

### Step 2: Verify `.migration-data/` is gitignored

- [ ] Run:

```bash
grep -nE "^\\.migration-data|^migration-data" .gitignore
```

Expected: at least one match. If none, add `.migration-data/` to `.gitignore`.

### Step 3: Verify the aliases work

- [ ] Run:

```bash
npm run export:advocates -- --dry-run
```

Expected: same output as Task 2 Step 6. Confirms the alias and arg-forwarding work.

### Step 4: Commit

- [ ] Run:

```bash
git add package.json .gitignore
git commit -m "chore(advocates): add export:advocates / import:advocates npm aliases"
```

---

## Task 8: Runbook + CLAUDE.md gotcha

**Files:**
- Create: `docs/developers/operations/advocate-export-import.md`
- Modify: `CLAUDE.md`

### Step 1: Write the runbook

- [ ] Create `docs/developers/operations/advocate-export-import.md`:

```markdown
# Advocate Export / Import Runbook

Snapshot the Developer Advocate roster (records + topics + links + photos)
from any CAP-bound HANA DB to a JSON file on disk, and restore it
idempotently into any other CAP-bound HANA DB. Use this to seed PROD
from DEV (or re-seed DEV if it gets wiped).

**Spec:** [docs/superpowers/specs/2026-06-25-advocate-export-import-design.md](../../superpowers/specs/2026-06-25-advocate-export-import-design.md)
**Scripts:** [scripts/export-advocates.cjs](../../../scripts/export-advocates.cjs), [scripts/import-advocates.cjs](../../../scripts/import-advocates.cjs)

## When to use

- Seeding a fresh PROD subaccount with DEV's curated advocate roster.
- Restoring DEV after a destructive schema redeploy wipes `Advocates`.
- Snapshotting DEV before a risky change so you can roll back.

## What gets carried

| Carried | Not carried |
| --- | --- |
| All `Advocates` columns (slug, name, bio, region, photoUrl, …) | UUID `ID` (target gets fresh UUIDs on insert) |
| `Advocates.user_ID` re-resolved by `Users.email` | `Users` rows themselves — must already exist in target |
| All `AdvocateTopics` re-resolved by `Tags.slug` | `Tags` rows themselves — missing slugs are skipped with WARN |
| All `AdvocateLinks` (kind/url/label/sortOrder) verbatim | nothing |
| Both photo variants (`photo256`, `photo64`) + `sha256` + `sizeBytes` | nothing |

## How to run

```bash
# 1. Export from source (typically DEV)
cf login   # → DEV subaccount, dev space
npm run export:advocates
# → writes .migration-data/advocates.json

# 2. Import to target (typically PROD)
cf login   # → PROD subaccount, prod space
npm run import:advocates
```

The `.migration-data/` directory is `.gitignore`d. To version a snapshot
in the repo, `git add -f .migration-data/advocates.json`.

## Idempotency

`npm run import:advocates` is safely re-runnable. On second run:

- Advocates with matching slug → UPDATE in place (existing UUID preserved).
- Topics/links/photo for that advocate → fully replaced.
- Advocates in target but not in source → left alone (no deletes).

Edits made in target between runs of the import will be lost on the next
import — DEV is the source of truth.

## Warnings to expect

The import script logs (and continues) on:

- **User FK not resolved** — the advocate's `userEmail` doesn't match any
  `Users` row in target. Advocate is inserted with `user_ID = NULL`.
  Lazy IDP self-heal on next login will populate `Users`; re-running the
  import after that will fill the FK.
- **Topic skipped** — the `tagSlug` doesn't match any `Tags` row in target.
  Edit the `Tags` table in target admin UI to add the tag, then re-run import.

Hard failures (exit 1):

- `.migration-data/advocates.json` missing — run export first.
- `schemaVersion` mismatch — payload was produced by a different version of
  the script. Either re-export from source with the current version or
  upgrade the import script.
- Duplicate `userEmail` in source — two advocates linked to the same User.
  Fix in source admin UI before re-exporting.

## What it bypasses (and why)

The scripts use raw `cds.db.run()` against entity-level CQN, not the
AdminService HTTP endpoints. This intentionally bypasses:

- The `processPhotoUpload` sharp/WebP re-encoder (would re-encode bytes
  we already exported; defeats the snapshot guarantee).
- The `flipHasPhoto` / `photoUrl` after-handlers (would re-derive fields
  we already exported; the exported values are trusted).
- The draft-table layer on the draft-enabled `Advocates` entity (we write
  directly to the active table; no draft activation).

See [the spec](../../superpowers/specs/2026-06-25-advocate-export-import-design.md#why-raw-sql-not-the-cap-service-layer)
for the full rationale.
```

### Step 2: Add the CLAUDE.md gotcha pointer

- [ ] In `CLAUDE.md`, find the **Data Migration** section (search for "Data Migration" or "migrate-from-hana"). Add this bullet to the list of migration scripts:

```markdown
- `export-advocates.cjs` / `import-advocates.cjs` — snapshot + restore the Developer Advocate roster (records + topics + links + photos) between subaccounts. Runbook: [docs/developers/operations/advocate-export-import.md](docs/developers/operations/advocate-export-import.md).
```

### Step 3: Verify the docs build cleanly (sidebar guard)

- [ ] Run:

```bash
npm run predocs:build 2>&1 | tail -20
```

Expected: no dead-link errors. If the new runbook needs to be in the VitePress sidebar, also edit `docs/.vitepress/config.ts` `themeConfig.sidebar` to add an entry under "Operations" (mirror the existing `mta-deployment.md` entry).

### Step 4: Commit

- [ ] Run:

```bash
git add docs/developers/operations/advocate-export-import.md CLAUDE.md docs/.vitepress/config.ts
git commit -m "docs(advocates): runbook for export/import + CLAUDE.md pointer"
```

---

## Task 9: Final verification + PR

### Step 1: Run full test suite

- [ ] Run:

```bash
npm test
```

Expected: all unit tests pass (including the new `test/unit/advocate-io.test.js`).

### Step 2: Final end-to-end smoke against DEV (read-only)

- [ ] Run:

```bash
npm run export:advocates -- --dry-run
```

Expected: counts match what you see in the admin UI at `/admin-ui/#advocates-display`.

### Step 3: Open the PR

- [ ] Run:

```bash
git push -u origin feat/632-bulk-idp-backfill
gh pr create \
  --base main \
  --title "feat(advocates): export/import scripts for cross-subaccount roster transfer" \
  --body "$(cat <<'EOF'
## Summary

Adds `scripts/export-advocates.cjs` and `scripts/import-advocates.cjs` so the
Developer Advocate roster (records + topics + links + photos) can be
snapshotted to JSON and restored idempotently across CAP-bound HANA DBs.

Use case: seed PROD from DEV at cutover, and re-seed DEV after any wipe so
the manually-curated roster isn't lost again.

## Approach

- Plain Node CommonJS scripts run via `cds bind --exec`.
- Raw `cds.db.run()` against entity-level CQN to bypass the AdminService
  sharp/WebP re-encoder and the `hasPhoto`/`photoUrl` after-handlers.
- Per-advocate photo fetch via raw SQL to dodge the HANA LOB-locator-expiry
  bug (same workaround as `srv/lib/content-store.js`).
- FK re-resolution by natural key (`Users.email`, `Tags.slug`) — graceful
  NULL/skip if target is missing references.
- Idempotent upsert by slug; topics/links/photo replace-not-merge.

## Spec

[docs/superpowers/specs/2026-06-25-advocate-export-import-design.md](docs/superpowers/specs/2026-06-25-advocate-export-import-design.md)

## Runbook

[docs/developers/operations/advocate-export-import.md](docs/developers/operations/advocate-export-import.md)

## Smoke tests run

- `npx vitest run test/unit/advocate-io.test.js` — 6 pass
- `npm run export:advocates -- --dry-run` against DEV — N advocates, M photos
- Local SQLite round-trip — sha256 of photo256 matches export
- Idempotency — re-import shows all advocates as "updated" not "inserted"
EOF
)"
```

---

## Done criteria

- [ ] `npm run export:advocates` writes a valid `.migration-data/advocates.json` containing the full DEV roster.
- [ ] `npm run import:advocates` against a fresh SQLite imports every advocate without error.
- [ ] Re-running import against the same DB is a no-op (all "updated", zero "inserted", same counts).
- [ ] Photo bytes round-trip with sha256 match.
- [ ] `npm test` passes including new unit tests.
- [ ] Runbook published; CLAUDE.md updated.
- [ ] PR open against `main`.
