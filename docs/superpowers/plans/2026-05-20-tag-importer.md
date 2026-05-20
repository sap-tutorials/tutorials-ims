# Tag Importer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a two-step (preview + commit) bulk-import for the `Tags` entity exposed through the existing admin Tags Fiori Elements list-report. Imports accept CSV or JSON, classify each row as `new`/`conflict`/`invalid`, and let the admin pick a strategy (`upsert` / `skip-duplicates` / `abort-on-duplicate`) before any write happens.

**Architecture:** Two unbound CAP actions on `AdminService` (`previewTagImport`, `commitTagImport`) protected by the existing `@requires: 'Admin'`. Backend is decomposed into four small pure modules under `srv/lib/tag-import/` (parser, classifier, applier, preview-cache). A controller extension on the existing `app/admin/tags` Fiori Elements app renders an `Import…` header button and a single 3-state dialog (`upload | preview | done`).

**Tech Stack:** CAP Node.js (`@sap/cds`), `csv-parse` (sync API, new dep), Fiori Elements list-report controller extensions, OpenUI5 sap.m / sap.ui.unified, vitest (unit + hybrid).

**Spec:** [`docs/superpowers/specs/2026-05-20-tag-importer-design.md`](../specs/2026-05-20-tag-importer-design.md)

**Reviewer-flagged caveats to honor:**
- `LargeString` has no inherent size limit — parser is the gatekeeper. Reject `> 1 MB` early with `req.error(413, ...)` before parsing.
- `existingId`/`existingTitlePath` on `new` and `invalid` rows are returned as `null` (CDS `UUID`/`String` default). Document for the frontend.
- The in-memory preview cache will silently break under multi-instance srv scaling — add a `// SCALING CAVEAT` comment in `preview-cache.js`.
- Hybrid test seeds the existing `__TEST__` tag in `beforeAll`, not just cleanup in `afterAll`.

**Working directory:** All paths in this plan are relative to the worktree root: `d:\projects\tutorials-poc\.worktrees\tag-importer`

---

## File Structure

**New files:**
```
srv/lib/tag-import/preview-cache.js          Map-based 5-min TTL token store
srv/lib/tag-import/parser.js                 CSV + JSON parsing with hard caps
srv/lib/tag-import/classifier.js             rows + existing tags → preview report
srv/lib/tag-import/applier.js                strategy → in-tx INSERT / UPDATE
srv/lib/tag-import/index.js                  barrel export
test/unit/tag-import/preview-cache.test.js
test/unit/tag-import/parser.test.js
test/unit/tag-import/classifier.test.js
test/unit/tag-import/applier.test.js
test/hybrid/tag-import.test.js               end-to-end against real HANA
app/admin/tags/webapp/ext/TagImportController.js
app/admin/tags/webapp/ext/TagImportDialog.fragment.xml
app/admin/tags/webapp/i18n/i18n.properties
```

**Modified files:**
```
srv/admin-service.cds                        declare 4 types + 2 actions
srv/admin-service.js                         wire previewTagImport + commitTagImport handlers
app/admin/tags/webapp/manifest.json          register controller extension + LineItem action
package.json                                 add csv-parse dependency
TODO.md                                      mark "Tag Import" as done (last task)
```

---

## Task 1: Add csv-parse dependency

**Files:**
- Modify: `package.json` (`dependencies` block)

- [ ] **Step 1: Install csv-parse and confirm it lands in `dependencies`**

```bash
npm install csv-parse@^5.5.6 --save-exact
```

Note: Tom's global npmrc has `ignore-scripts=true` and `save-exact=true` — this is expected. The version pin is intentional.

- [ ] **Step 2: Verify install**

```bash
node -e "const { parse } = require('csv-parse/sync'); console.log(parse('a,b\n1,2', {columns:true}))"
```
Expected: `[ { a: '1', b: '2' } ]`

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat(tag-import): add csv-parse dependency

Pinned to 5.5.6 (sync API). Used by srv/lib/tag-import/parser.js."
```

---

## Task 2: PreviewCache module

**Files:**
- Create: `srv/lib/tag-import/preview-cache.js`
- Test: `test/unit/tag-import/preview-cache.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/tag-import/preview-cache.test.js`:

```js
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { PreviewCache } from '../../../srv/lib/tag-import/preview-cache.js';

describe('PreviewCache', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('stores and retrieves a value by token', () => {
    const cache = new PreviewCache({ ttlMs: 60_000, maxEntries: 10 });
    cache.set('tok1', { rows: [1, 2] });
    expect(cache.get('tok1')).toEqual({ rows: [1, 2] });
  });

  it('returns undefined for unknown token', () => {
    const cache = new PreviewCache({ ttlMs: 60_000, maxEntries: 10 });
    expect(cache.get('nope')).toBeUndefined();
  });

  it('expires entries after ttlMs', () => {
    const cache = new PreviewCache({ ttlMs: 1000, maxEntries: 10 });
    cache.set('tok1', { rows: [] });
    vi.advanceTimersByTime(1001);
    expect(cache.get('tok1')).toBeUndefined();
  });

  it('evicts oldest entry once maxEntries exceeded (FIFO)', () => {
    const cache = new PreviewCache({ ttlMs: 60_000, maxEntries: 2 });
    cache.set('a', 1);
    cache.set('b', 2);
    cache.set('c', 3);
    expect(cache.get('a')).toBeUndefined();
    expect(cache.get('b')).toBe(2);
    expect(cache.get('c')).toBe(3);
  });

  it('lazily removes expired entry on read', () => {
    const cache = new PreviewCache({ ttlMs: 1000, maxEntries: 10 });
    cache.set('tok1', { rows: [] });
    vi.advanceTimersByTime(1001);
    cache.get('tok1');
    expect(cache.size()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/tag-import/preview-cache.test.js
```
Expected: FAIL — `Failed to load url ../../../srv/lib/tag-import/preview-cache.js`

- [ ] **Step 3: Implement PreviewCache**

Create `srv/lib/tag-import/preview-cache.js`:

```js
// SCALING CAVEAT: This cache is in-memory and scoped to a single srv instance.
// If tutorials-srv is ever scaled to >1 instance, commitTagImport will return 410
// (preview expired) on any call routed to a different instance. Move this to a
// HANA-backed table or a shared Redis if/when horizontal scaling lands.

export class PreviewCache {
  constructor({ ttlMs = 5 * 60 * 1000, maxEntries = 20 } = {}) {
    this._ttlMs = ttlMs;
    this._maxEntries = maxEntries;
    this._store = new Map();
  }

  set(token, value) {
    if (this._store.size >= this._maxEntries) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
    this._store.set(token, { value, expiresAt: Date.now() + this._ttlMs });
  }

  get(token) {
    const entry = this._store.get(token);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this._store.delete(token);
      return undefined;
    }
    return entry.value;
  }

  size() {
    return this._store.size;
  }
}

export const sharedCache = new PreviewCache();
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/tag-import/preview-cache.test.js
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/tag-import/preview-cache.js test/unit/tag-import/preview-cache.test.js
git commit -m "feat(tag-import): add in-memory preview cache

5-min TTL, FIFO eviction at 20 entries, lazy expiry on read.
Documented single-instance scaling caveat at module head."
```

---

## Task 3: Parser module

**Files:**
- Create: `srv/lib/tag-import/parser.js`
- Test: `test/unit/tag-import/parser.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/tag-import/parser.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { parsePayload, MAX_ROWS, MAX_BYTES } from '../../../srv/lib/tag-import/parser.js';

describe('parsePayload — CSV', () => {
  it('parses a valid 2-row CSV with required headers', () => {
    const csv = 'name,titlePath\nABAP,Languages:ABAP\nFiori,UI:Fiori';
    const { rows, parseErrors } = parsePayload(csv, 'csv');
    expect(rows).toEqual([
      { name: 'ABAP', titlePath: 'Languages:ABAP' },
      { name: 'Fiori', titlePath: 'UI:Fiori' }
    ]);
    expect(parseErrors).toEqual([]);
  });

  it('strips a UTF-8 BOM', () => {
    const csv = '﻿name,titlePath\nABAP,Languages:ABAP';
    const { rows } = parsePayload(csv, 'csv');
    expect(rows[0].name).toBe('ABAP');
  });

  it('trims values and ignores empty lines', () => {
    const csv = 'name,titlePath\n  ABAP  ,  Languages:ABAP  \n\n';
    const { rows } = parsePayload(csv, 'csv');
    expect(rows).toEqual([{ name: 'ABAP', titlePath: 'Languages:ABAP' }]);
  });

  it('throws when required headers missing', () => {
    expect(() => parsePayload('foo,bar\n1,2', 'csv')).toThrow(/required header/i);
  });

  it('marks rows with missing fields as invalid', () => {
    const csv = 'name,titlePath\nGood,Path\n,MissingName\nMissingPath,';
    const { rows } = parsePayload(csv, 'csv');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ name: 'Good', titlePath: 'Path' });
    expect(rows[1]).toMatchObject({ invalid: true, reason: expect.stringMatching(/name/i) });
    expect(rows[2]).toMatchObject({ invalid: true, reason: expect.stringMatching(/titlePath/i) });
  });

  it('marks rows that exceed 255 chars as invalid', () => {
    const longName = 'x'.repeat(256);
    const csv = `name,titlePath\n${longName},Path`;
    const { rows } = parsePayload(csv, 'csv');
    expect(rows[0]).toMatchObject({ invalid: true, reason: expect.stringMatching(/255/) });
  });

  it('drops within-file duplicates (case-insensitive) and reports them', () => {
    const csv = 'name,titlePath\nABAP,Path1\nabap,Path2\nFiori,Path3';
    const { rows, parseErrors } = parsePayload(csv, 'csv');
    expect(rows.map(r => r.name)).toEqual(['ABAP', 'Fiori']);
    expect(parseErrors).toContainEqual(expect.objectContaining({
      reason: expect.stringMatching(/duplicate/i)
    }));
  });

  it('rejects payload exceeding MAX_BYTES', () => {
    const big = 'x'.repeat(MAX_BYTES + 1);
    expect(() => parsePayload(big, 'csv')).toThrow(/payload/i);
  });

  it('rejects rows exceeding MAX_ROWS', () => {
    const lines = ['name,titlePath'];
    for (let i = 0; i < MAX_ROWS + 1; i++) lines.push(`tag${i},path${i}`);
    expect(() => parsePayload(lines.join('\n'), 'csv')).toThrow(/rows/i);
  });
});

describe('parsePayload — JSON', () => {
  it('parses a valid JSON array', () => {
    const json = JSON.stringify([
      { name: 'ABAP', titlePath: 'Languages:ABAP' }
    ]);
    const { rows } = parsePayload(json, 'json');
    expect(rows).toEqual([{ name: 'ABAP', titlePath: 'Languages:ABAP' }]);
  });

  it('rejects non-array JSON', () => {
    expect(() => parsePayload('{"name":"x","titlePath":"y"}', 'json'))
      .toThrow(/array/i);
  });

  it('marks JSON rows missing fields as invalid', () => {
    const json = JSON.stringify([{ name: 'Only' }]);
    const { rows } = parsePayload(json, 'json');
    expect(rows[0]).toMatchObject({ invalid: true });
  });
});

describe('parsePayload — format guard', () => {
  it('rejects unknown format', () => {
    expect(() => parsePayload('x', 'xml')).toThrow(/format/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/tag-import/parser.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement parser**

Create `srv/lib/tag-import/parser.js`:

```js
import { parse as csvParse } from 'csv-parse/sync';

export const MAX_ROWS = 5000;
export const MAX_BYTES = 1_000_000;
const MAX_FIELD_LEN = 255;

export function parsePayload(payload, format) {
  if (typeof payload !== 'string' || payload.length === 0) {
    throw new Error('Empty payload');
  }
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
    throw new Error(`Payload exceeds ${MAX_BYTES} bytes`);
  }

  let raw;
  if (format === 'csv') raw = parseCsv(payload);
  else if (format === 'json') raw = parseJson(payload);
  else throw new Error(`Unsupported format: ${format}`);

  if (raw.length > MAX_ROWS) {
    throw new Error(`Too many rows: ${raw.length} > ${MAX_ROWS}`);
  }

  return classifyRows(raw);
}

function parseCsv(payload) {
  const stripped = payload.replace(/^﻿/, '');
  const records = csvParse(stripped, {
    columns: true,
    trim: true,
    skip_empty_lines: true,
    relax_column_count: false
  });
  if (records.length === 0) {
    throw new Error('CSV must contain a header row and at least one data row');
  }
  const cols = Object.keys(records[0]);
  for (const required of ['name', 'titlePath']) {
    if (!cols.includes(required)) {
      throw new Error(`Missing required header: ${required}`);
    }
  }
  return records;
}

function parseJson(payload) {
  let parsed;
  try { parsed = JSON.parse(payload); }
  catch (e) { throw new Error(`Invalid JSON: ${e.message}`); }
  if (!Array.isArray(parsed)) throw new Error('JSON payload must be an array');
  return parsed;
}

function classifyRows(raw) {
  const rows = [];
  const parseErrors = [];
  const seen = new Map();

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i];
    const name = (r.name ?? '').toString().trim();
    const titlePath = (r.titlePath ?? '').toString().trim();

    if (!name) {
      rows.push({ invalid: true, name, titlePath, reason: 'missing required field: name' });
      continue;
    }
    if (!titlePath) {
      rows.push({ invalid: true, name, titlePath, reason: 'missing required field: titlePath' });
      continue;
    }
    if (name.length > MAX_FIELD_LEN || titlePath.length > MAX_FIELD_LEN) {
      rows.push({ invalid: true, name, titlePath, reason: 'field exceeds 255 chars' });
      continue;
    }

    const key = name.toLowerCase();
    if (seen.has(key)) {
      parseErrors.push({
        line: i + 2,
        name,
        reason: `duplicate of row ${seen.get(key) + 2} (case-insensitive)`
      });
      continue;
    }
    seen.set(key, i);
    rows.push({ name, titlePath });
  }

  return { rows, parseErrors };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/tag-import/parser.test.js
```
Expected: 12 passed.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/tag-import/parser.js test/unit/tag-import/parser.test.js
git commit -m "feat(tag-import): add CSV/JSON parser

Hard caps: 5000 rows, 1 MB. Per-row validation surfaces invalid rows
inline rather than failing the whole parse. Within-file duplicates are
case-insensitive and dropped (second+ occurrences) with line metadata
returned in parseErrors."
```

---

## Task 4: Classifier module

**Files:**
- Create: `srv/lib/tag-import/classifier.js`
- Test: `test/unit/tag-import/classifier.test.js`

- [ ] **Step 1: Write the failing tests**

Create `test/unit/tag-import/classifier.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { classify } from '../../../srv/lib/tag-import/classifier.js';

const existing = [
  { ID: 'id-abap', name: 'ABAP', titlePath: 'Languages:ABAP' },
  { ID: 'id-fiori', name: 'Fiori', titlePath: 'UI:Fiori' }
];

describe('classify', () => {
  it('marks unseen names as new', () => {
    const rows = [{ name: 'CAP', titlePath: 'Frameworks:CAP' }];
    const { summary, rows: out } = classify(rows, existing);
    expect(summary).toEqual({ total: 1, new_: 1, conflict: 0, invalid: 0 });
    expect(out[0]).toMatchObject({ status: 'new', name: 'CAP' });
  });

  it('matches existing names case-insensitively as conflict', () => {
    const rows = [{ name: 'abap', titlePath: 'NewPath' }];
    const { summary, rows: out } = classify(rows, existing);
    expect(summary).toMatchObject({ conflict: 1 });
    expect(out[0]).toMatchObject({
      status: 'conflict',
      name: 'abap',
      existingId: 'id-abap',
      existingTitlePath: 'Languages:ABAP'
    });
  });

  it('passes through invalid flag from parser', () => {
    const rows = [{ invalid: true, name: '', titlePath: 'x', reason: 'missing required field: name' }];
    const { summary, rows: out } = classify(rows, existing);
    expect(summary).toMatchObject({ invalid: 1 });
    expect(out[0]).toMatchObject({
      status: 'invalid',
      reason: 'missing required field: name'
    });
  });

  it('handles a mixed batch', () => {
    const rows = [
      { name: 'CAP', titlePath: 'Frameworks:CAP' },
      { name: 'ABAP', titlePath: 'Languages:ABAP' },
      { invalid: true, name: '', titlePath: '', reason: 'missing required field: name' }
    ];
    const { summary } = classify(rows, existing);
    expect(summary).toEqual({ total: 3, new_: 1, conflict: 1, invalid: 1 });
  });

  it('returns null for existingId/existingTitlePath on new and invalid rows', () => {
    const rows = [
      { name: 'CAP', titlePath: 'Frameworks:CAP' },
      { invalid: true, name: '', titlePath: '', reason: 'x' }
    ];
    const { rows: out } = classify(rows, existing);
    expect(out[0].existingId).toBeNull();
    expect(out[0].existingTitlePath).toBeNull();
    expect(out[1].existingId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/tag-import/classifier.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement classifier**

Create `srv/lib/tag-import/classifier.js`:

```js
export function classify(rows, existingTags) {
  const byName = new Map(
    existingTags.map(t => [t.name.toLowerCase(), t])
  );

  const out = [];
  let news = 0, conflicts = 0, invalids = 0;

  for (const r of rows) {
    if (r.invalid) {
      invalids++;
      out.push({
        status: 'invalid',
        name: r.name,
        titlePath: r.titlePath,
        existingId: null,
        existingTitlePath: null,
        reason: r.reason
      });
      continue;
    }

    const match = byName.get(r.name.toLowerCase());
    if (match) {
      conflicts++;
      out.push({
        status: 'conflict',
        name: r.name,
        titlePath: r.titlePath,
        existingId: match.ID,
        existingTitlePath: match.titlePath,
        reason: null
      });
    } else {
      news++;
      out.push({
        status: 'new',
        name: r.name,
        titlePath: r.titlePath,
        existingId: null,
        existingTitlePath: null,
        reason: null
      });
    }
  }

  return {
    summary: { total: out.length, new_: news, conflict: conflicts, invalid: invalids },
    rows: out
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/tag-import/classifier.test.js
```
Expected: 5 passed.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/tag-import/classifier.js test/unit/tag-import/classifier.test.js
git commit -m "feat(tag-import): classify rows as new/conflict/invalid

Pure module: takes parser output + existing-tags snapshot, emits
preview-shaped rows with existingId/existingTitlePath set on conflicts
and null elsewhere. Case-insensitive name match."
```

---

## Task 5: Applier module

**Files:**
- Create: `srv/lib/tag-import/applier.js`
- Test: `test/unit/tag-import/applier.test.js`

The applier touches the database, so the test runs against an in-memory CAP server using `cds.test()` for each strategy.

- [ ] **Step 1: Write the failing tests**

Create `test/unit/tag-import/applier.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeEach } from 'vitest';
import { apply } from '../../../srv/lib/tag-import/applier.js';

cds.test('serve', '--project', '.', '--in-memory');

describe('apply', () => {
  let db;
  let Tags;

  beforeEach(async () => {
    db = await cds.connect.to('db');
    ({ Tags } = cds.entities('com.sap.developers.ims'));
    await DELETE.from(Tags);
    await INSERT.into(Tags).entries([
      { ID: 'id-abap', name: 'ABAP', titlePath: 'Languages:ABAP', legacyId: 1 }
    ]);
  });

  it('upsert: inserts new + updates conflicts whose titlePath differs', async () => {
    const rows = [
      { status: 'new', name: 'CAP', titlePath: 'Frameworks:CAP' },
      { status: 'conflict', name: 'ABAP', titlePath: 'NewPath', existingId: 'id-abap', existingTitlePath: 'Languages:ABAP' },
      { status: 'invalid', name: '', titlePath: '', reason: 'x' }
    ];
    const result = await apply(rows, 'upsert', db);
    expect(result).toEqual({ inserted: 1, updated: 1, skipped: 1, total: 3 });
    const updated = await SELECT.one.from(Tags).where({ ID: 'id-abap' });
    expect(updated.titlePath).toBe('NewPath');
  });

  it('upsert: does NOT update when titlePath matches', async () => {
    const rows = [
      { status: 'conflict', name: 'ABAP', titlePath: 'Languages:ABAP', existingId: 'id-abap', existingTitlePath: 'Languages:ABAP' }
    ];
    const result = await apply(rows, 'upsert', db);
    expect(result).toEqual({ inserted: 0, updated: 0, skipped: 1, total: 1 });
  });

  it('skip-duplicates: only inserts new rows', async () => {
    const rows = [
      { status: 'new', name: 'CAP', titlePath: 'Frameworks:CAP' },
      { status: 'conflict', name: 'ABAP', titlePath: 'NewPath', existingId: 'id-abap' }
    ];
    const result = await apply(rows, 'skip-duplicates', db);
    expect(result).toEqual({ inserted: 1, updated: 0, skipped: 1, total: 2 });
    const abap = await SELECT.one.from(Tags).where({ ID: 'id-abap' });
    expect(abap.titlePath).toBe('Languages:ABAP');
  });

  it('abort-on-duplicate: throws and does not insert any new rows', async () => {
    const rows = [
      { status: 'new', name: 'CAP', titlePath: 'Frameworks:CAP' },
      { status: 'conflict', name: 'ABAP', titlePath: 'NewPath', existingId: 'id-abap' }
    ];
    await expect(apply(rows, 'abort-on-duplicate', db)).rejects.toThrow(/conflict/i);
    const cap = await SELECT.one.from(Tags).where({ name: 'CAP' });
    expect(cap).toBeUndefined();
  });

  it('rejects unknown strategy', async () => {
    await expect(apply([], 'merge', db)).rejects.toThrow(/strategy/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx vitest run test/unit/tag-import/applier.test.js
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement applier**

Create `srv/lib/tag-import/applier.js`:

```js
import cds from '@sap/cds';

const VALID_STRATEGIES = new Set(['upsert', 'skip-duplicates', 'abort-on-duplicate']);

export async function apply(rows, strategy, db) {
  if (!VALID_STRATEGIES.has(strategy)) {
    throw new Error(`Unknown strategy: ${strategy}`);
  }

  const { Tags } = cds.entities('com.sap.developers.ims');

  const conflicts = rows.filter(r => r.status === 'conflict');
  if (strategy === 'abort-on-duplicate' && conflicts.length > 0) {
    throw new Error(`${conflicts.length} conflict(s) found; aborting per strategy`);
  }

  let inserted = 0, updated = 0, skipped = 0;
  const total = rows.length;

  for (const r of rows) {
    if (r.status === 'invalid') {
      skipped++;
      continue;
    }
    if (r.status === 'new') {
      // legacyId auto-assigned by AdminService before('CREATE') hook on Tags
      await INSERT.into(Tags).entries({ name: r.name, titlePath: r.titlePath });
      inserted++;
    } else if (r.status === 'conflict') {
      if (strategy === 'upsert' && r.titlePath !== r.existingTitlePath) {
        await UPDATE(Tags, r.existingId).set({ titlePath: r.titlePath });
        updated++;
      } else {
        skipped++;
      }
    }
  }

  return { inserted, updated, skipped, total };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
npx vitest run test/unit/tag-import/applier.test.js
```
Expected: 5 passed.

Note: This test uses `cds.test('serve', '--project', '.', '--in-memory')` which suffers a known 10s hook-timeout on this Windows machine for some test files. If the test fails with `Hook timed out`, increase per-test timeout via vitest CLI: `--testTimeout=60000`. Do not change the production code to chase this.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/tag-import/applier.js test/unit/tag-import/applier.test.js
git commit -m "feat(tag-import): apply strategy in single transaction

Three strategies: upsert (insert + update-where-different), skip-duplicates
(insert-only), abort-on-duplicate (throws if any conflict). Invalid rows
always skipped. legacyId auto-assigned by AdminService CREATE hook."
```

---

## Task 6: Barrel export + format detection helper

**Files:**
- Create: `srv/lib/tag-import/index.js`

- [ ] **Step 1: Implement index.js**

Create `srv/lib/tag-import/index.js`:

```js
export { parsePayload, MAX_ROWS, MAX_BYTES } from './parser.js';
export { classify } from './classifier.js';
export { apply } from './applier.js';
export { PreviewCache, sharedCache } from './preview-cache.js';
```

- [ ] **Step 2: Verify import**

```bash
node -e "import('./srv/lib/tag-import/index.js').then(m => console.log(Object.keys(m)))"
```
Expected: `[ 'parsePayload', 'MAX_ROWS', 'MAX_BYTES', 'classify', 'apply', 'PreviewCache', 'sharedCache' ]`

- [ ] **Step 3: Commit**

```bash
git add srv/lib/tag-import/index.js
git commit -m "feat(tag-import): barrel export for tag-import modules"
```

---

## Task 7: Declare action types and signatures in admin-service.cds

**Files:**
- Modify: `srv/admin-service.cds` (add types + 2 actions before the closing `}`)

- [ ] **Step 1: Add types and actions**

In `srv/admin-service.cds`, add the following block after `function getBoardStatistics() returns { ... };` and before the closing `}` of the service:

```cds

  // --- Tag Import ---

  type TagImportRow {
    name              : String(255);
    titlePath         : String(255);
    status            : String(20);    // 'new' | 'conflict' | 'invalid'
    existingId        : UUID;
    existingTitlePath : String(255);
    reason            : String(500);
  }

  type TagImportSummary {
    total    : Integer;
    new_     : Integer;                // 'new' is a CDS reserved word
    conflict : Integer;
    invalid  : Integer;
  }

  type TagImportPreview {
    token        : String(64);
    summary      : TagImportSummary;
    rows         : many TagImportRow;
    parseWarnings : many { line : Integer; name : String(255); reason : String(500); };
  }

  type TagImportResult {
    inserted : Integer;
    updated  : Integer;
    skipped  : Integer;
    total    : Integer;
  }

  action previewTagImport(payload: LargeString, format: String) returns TagImportPreview;
  action commitTagImport(token: String, strategy: String) returns TagImportResult;
```

- [ ] **Step 2: Verify the model compiles**

```bash
npx cds compile srv/admin-service.cds --to json > /dev/null
```
Expected: no output, exit 0. If it errors with `Found type "new"`, the underscore on `new_` was lost — re-check.

- [ ] **Step 3: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(tag-import): declare AdminService preview/commit actions

Two unbound actions guarded by the existing service-level @requires:'Admin'.
Types are inline so they appear in $metadata for the FE controller extension."
```

---

## Task 8: Implement previewTagImport handler

**Files:**
- Modify: `srv/admin-service.js` (add import + handler near other admin actions)

- [ ] **Step 1: Add the import**

At the top of `srv/admin-service.js`, after the existing imports:

```js
import { randomUUID } from 'node:crypto';
import { parsePayload, classify, sharedCache, MAX_BYTES } from './lib/tag-import/index.js';
```

- [ ] **Step 2: Wire the handler**

Inside `init()`, after the `cleanupUnusedTags` block (around line 346), add:

```js
this.on('previewTagImport', async (req) => {
  const log = cds.log('tag-import');
  const started = Date.now();
  const { payload, format } = req.data;

  if (!payload) return req.error(400, 'payload is required');
  if (typeof payload !== 'string') return req.error(400, 'payload must be a string');
  if (Buffer.byteLength(payload, 'utf8') > MAX_BYTES) {
    return req.error(413, `Payload exceeds ${MAX_BYTES} bytes`);
  }
  if (!['csv', 'json'].includes(format)) {
    return req.error(400, `format must be 'csv' or 'json'`);
  }

  let parsed;
  try {
    parsed = parsePayload(payload, format);
  } catch (e) {
    return req.error(400, e.message);
  }

  const existingTags = await SELECT.from(Tags).columns('ID', 'name', 'titlePath');
  const { summary, rows } = classify(parsed.rows, existingTags);

  const token = randomUUID();
  sharedCache.set(token, { rows, classifiedAt: Date.now() });

  log.info({
    event: 'tag-import.preview',
    user: req.user?.id,
    total: summary.total,
    summary,
    durationMs: Date.now() - started
  });

  return {
    token,
    summary,
    rows,
    parseWarnings: parsed.parseErrors
  };
});
```

- [ ] **Step 3: Run the in-memory test against the live action**

Add a quick action test to `test/unit/tag-import/applier.test.js` (yes, in the same file — both touch the in-memory db; it avoids a second cds.test bootstrap):

```js
import supertest from 'supertest';

describe('previewTagImport (action)', () => {
  let app;
  beforeEach(() => { app = cds.app; });

  it('returns a token and summary for a valid CSV', async () => {
    const csv = 'name,titlePath\nNEW_TAG_X,Path:X\nABAP,Languages:ABAP';
    const res = await supertest(app)
      .post('/admin/previewTagImport')
      .send({ payload: csv, format: 'csv' })
      .set('authorization', 'Basic ' + Buffer.from('admin:').toString('base64'))
      .expect(200);
    expect(res.body.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.summary).toEqual({ total: 2, new_: 1, conflict: 1, invalid: 0 });
  });

  it('rejects oversized payload with 413', async () => {
    const big = 'x'.repeat(MAX_BYTES + 1);
    await supertest(app)
      .post('/admin/previewTagImport')
      .send({ payload: big, format: 'csv' })
      .set('authorization', 'Basic ' + Buffer.from('admin:').toString('base64'))
      .expect(413);
  });

  it('rejects malformed CSV with 400', async () => {
    await supertest(app)
      .post('/admin/previewTagImport')
      .send({ payload: 'wrongheader\nfoo', format: 'csv' })
      .set('authorization', 'Basic ' + Buffer.from('admin:').toString('base64'))
      .expect(400);
  });
});
```

Add the import at the top of the same test file:

```js
import { MAX_BYTES } from '../../../srv/lib/tag-import/parser.js';
```

(Note: `supertest` and `MAX_BYTES` may already be imported indirectly — keep imports clean.)

- [ ] **Step 4: Run the tests**

```bash
npx vitest run test/unit/tag-import/applier.test.js
```
Expected: all `apply` tests pass + 3 new action tests pass.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.js test/unit/tag-import/applier.test.js
git commit -m "feat(tag-import): implement previewTagImport handler

Validates payload size before parsing (413 path), parses, classifies
against current Tags snapshot, caches result by UUID token. Logs
counts via cds.log('tag-import') — no raw tag names emitted."
```

---

## Task 9: Implement commitTagImport handler

**Files:**
- Modify: `srv/admin-service.js`

- [ ] **Step 1: Wire the handler**

After the `previewTagImport` handler in `init()`, add:

```js
this.on('commitTagImport', async (req) => {
  const log = cds.log('tag-import');
  const started = Date.now();
  const { token, strategy } = req.data;

  if (!token) return req.error(400, 'token is required');
  if (!['upsert', 'skip-duplicates', 'abort-on-duplicate'].includes(strategy)) {
    return req.error(400, `strategy must be one of upsert, skip-duplicates, abort-on-duplicate`);
  }

  const cached = sharedCache.get(token);
  if (!cached) return req.error(410, 'Preview expired or unknown token; please re-upload');

  // Re-classify inside the request to catch races (another admin inserting
  // between preview and commit). The cached parsed rows stay as-is; only the
  // classification against existing tags is refreshed.
  const { apply, classify: reclassify } = await import('./lib/tag-import/index.js');
  const existingTags = await SELECT.from(Tags).columns('ID', 'name', 'titlePath');
  const inputRows = cached.rows.map(r => r.status === 'invalid'
    ? { invalid: true, name: r.name, titlePath: r.titlePath, reason: r.reason }
    : { name: r.name, titlePath: r.titlePath });
  const { rows: freshRows } = reclassify(inputRows, existingTags);

  let result;
  try {
    result = await apply(freshRows, strategy, db);
  } catch (e) {
    if (/conflict/i.test(e.message) && strategy === 'abort-on-duplicate') {
      return req.error(409, e.message);
    }
    throw e;
  }

  log.info({
    event: 'tag-import.commit',
    user: req.user?.id,
    strategy,
    ...result,
    durationMs: Date.now() - started
  });

  return result;
});
```

- [ ] **Step 2: Add commit-action tests**

Append to `test/unit/tag-import/applier.test.js`:

```js
describe('commitTagImport (action)', () => {
  let app;
  beforeEach(() => { app = cds.app; });

  async function preview(csv) {
    const res = await supertest(app)
      .post('/admin/previewTagImport')
      .send({ payload: csv, format: 'csv' })
      .set('authorization', 'Basic ' + Buffer.from('admin:').toString('base64'))
      .expect(200);
    return res.body.token;
  }

  it('upsert path returns counts and applies changes', async () => {
    const token = await preview('name,titlePath\nNEW_TAG_Y,P:Y\nABAP,Languages:ABAP-NEW');
    const res = await supertest(app)
      .post('/admin/commitTagImport')
      .send({ token, strategy: 'upsert' })
      .set('authorization', 'Basic ' + Buffer.from('admin:').toString('base64'))
      .expect(200);
    expect(res.body).toEqual({ inserted: 1, updated: 1, skipped: 0, total: 2 });
  });

  it('returns 410 when token is unknown', async () => {
    await supertest(app)
      .post('/admin/commitTagImport')
      .send({ token: 'does-not-exist', strategy: 'upsert' })
      .set('authorization', 'Basic ' + Buffer.from('admin:').toString('base64'))
      .expect(410);
  });

  it('returns 409 on abort-on-duplicate with conflicts', async () => {
    const token = await preview('name,titlePath\nABAP,Languages:ABAP-NEW');
    await supertest(app)
      .post('/admin/commitTagImport')
      .send({ token, strategy: 'abort-on-duplicate' })
      .set('authorization', 'Basic ' + Buffer.from('admin:').toString('base64'))
      .expect(409);
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
npx vitest run test/unit/tag-import/applier.test.js
```
Expected: all earlier tests + 3 new commit-action tests pass.

- [ ] **Step 4: Commit**

```bash
git add srv/admin-service.js test/unit/tag-import/applier.test.js
git commit -m "feat(tag-import): implement commitTagImport handler

Re-classifies inside the request to catch races between preview and commit.
410 when token unknown/expired, 409 when abort-on-duplicate hits a conflict.
Returns inserted/updated/skipped/total counts."
```

---

## Task 10: Hybrid integration test against real HANA

**Files:**
- Create: `test/hybrid/tag-import.test.js`

- [ ] **Step 1: Write the test**

Create `test/hybrid/tag-import.test.js`:

```js
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';

describe('tag-import (hybrid HANA)', () => {
  let db, Tags;
  const SEED_NAME = '__TEST__seed-tag';
  const NEW_NAME_1 = '__TEST__new-tag-1';
  const NEW_NAME_2 = '__TEST__new-tag-2';

  beforeAll(async () => {
    db = await cds.connect.to('db');
    ({ Tags } = cds.entities('com.sap.developers.ims'));
    // Seed the existing-tag we will collide with in the preview.
    await DELETE.from(Tags).where({ name: { like: '__TEST__%' } });
    const { getNextLegacyId } = await import('../../srv/lib/legacy-id.js');
    await INSERT.into(Tags).entries({
      name: SEED_NAME,
      titlePath: 'Test:OldPath',
      legacyId: await getNextLegacyId('Tags', db)
    });
  });

  afterAll(async () => {
    await DELETE.from(Tags).where({ name: { like: '__TEST__%' } });
  });

  it('previews + commits an upsert end-to-end', async () => {
    const { previewTagImport, commitTagImport } = await import('@sap/cds')
      .then(m => m.default.connect.to('AdminService'))
      .then(s => ({
        previewTagImport: (data) => s.send('previewTagImport', data),
        commitTagImport:  (data) => s.send('commitTagImport',  data)
      }));

    const csv = [
      'name,titlePath',
      `${NEW_NAME_1},Test:Path1`,
      `${NEW_NAME_2},Test:Path2`,
      `${SEED_NAME},Test:NewPath`
    ].join('\n');

    const preview = await previewTagImport({ payload: csv, format: 'csv' });
    expect(preview.summary).toEqual({ total: 3, new_: 2, conflict: 1, invalid: 0 });
    expect(preview.token).toBeTruthy();

    const result = await commitTagImport({ token: preview.token, strategy: 'upsert' });
    expect(result).toEqual({ inserted: 2, updated: 1, skipped: 0, total: 3 });

    const seeded = await SELECT.one.from(Tags).where({ name: SEED_NAME });
    expect(seeded.titlePath).toBe('Test:NewPath');

    const news = await SELECT.from(Tags).where({ name: { in: [NEW_NAME_1, NEW_NAME_2] } });
    expect(news).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run only when explicitly testing against HANA**

This test is skipped on the regular `npm test` run (it lives under `test/hybrid/`). To run:

```bash
cf login   # if not already logged into the DEV space
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project hybrid test/hybrid/tag-import.test.js
```
Expected: 1 passed.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/tag-import.test.js
git commit -m "test(tag-import): hybrid HANA integration test

Seeds one __TEST__-prefixed tag in beforeAll, verifies preview+commit
upsert end-to-end (2 inserts, 1 update), cleans up in afterAll."
```

---

## Task 11: Add i18n strings for the dialog

**Files:**
- Create: `app/admin/tags/webapp/i18n/i18n.properties`

- [ ] **Step 1: Create the file**

Create `app/admin/tags/webapp/i18n/i18n.properties`:

```properties
# Generic
appTitle=Tags
appSubtitle=View Tags

# Import action
tagImport.action=Import…
tagImport.dialog.title=Import Tags
tagImport.tab.file=File
tagImport.tab.paste=Paste
tagImport.upload.help=Upload a CSV or JSON file with columns/keys: name, titlePath
tagImport.format.label=Format
tagImport.format.csv=CSV
tagImport.format.json=JSON
tagImport.button.preview=Preview
tagImport.button.back=Back
tagImport.button.import=Import
tagImport.button.close=Close
tagImport.summary={0} new, {1} conflicts, {2} invalid (total {3})
tagImport.strategy.label=Conflict strategy
tagImport.strategy.upsert=Upsert (update conflicts)
tagImport.strategy.skip=Skip duplicates
tagImport.strategy.abort=Abort if any conflict
tagImport.col.status=Status
tagImport.col.name=Name
tagImport.col.titlePath=Title Path
tagImport.col.existingTitlePath=Existing Title Path
tagImport.col.reason=Reason
tagImport.status.new=New
tagImport.status.conflict=Conflict
tagImport.status.invalid=Invalid
tagImport.result={0} inserted, {1} updated, {2} skipped (total {3})
tagImport.error.expired=Preview expired. Please re-upload.
tagImport.error.generic=Import failed: {0}
```

- [ ] **Step 2: Commit**

```bash
git add app/admin/tags/webapp/i18n/i18n.properties
git commit -m "feat(tag-import): i18n strings for the import dialog"
```

---

## Task 12: Register the controller extension in manifest

**Files:**
- Modify: `app/admin/tags/webapp/manifest.json`

- [ ] **Step 1: Add i18n model + controller extension**

Replace the contents of `app/admin/tags/webapp/manifest.json` with:

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.tags",
    "type": "application",
    "title": "{{appTitle}}",
    "description": "{{appSubtitle}}",
    "applicationVersion": { "version": "0.0.1" },
    "i18n": "i18n/i18n.properties",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "Tag-display": {
          "semanticObject": "Tag",
          "action": "display",
          "title": "{{appTitle}}",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.136.0",
      "libs": { "sap.fe.templates": {}, "sap.m": {}, "sap.ui.unified": {} }
    },
    "models": {
      "": {
        "dataSource": "mainService",
        "preload": true,
        "settings": {
          "synchronizationMode": "None",
          "operationMode": "Server",
          "autoExpandSelect": true,
          "earlyRequests": true
        }
      },
      "i18n": {
        "type": "sap.ui.model.resource.ResourceModel",
        "settings": { "bundleName": "sap.tutorials.admin.tags.i18n.i18n" }
      }
    },
    "extends": {
      "extensions": {
        "sap.ui.controllerExtensions": {
          "sap.fe.templates.ListReport.ListReportController": {
            "controllerName": "sap.tutorials.admin.tags.ext.TagImportController"
          }
        }
      }
    },
    "routing": {
      "routes": [
        { "pattern": ":?query:", "name": "TagsList", "target": "TagsList" }
      ],
      "targets": {
        "TagsList": {
          "type": "Component",
          "id": "TagsList",
          "name": "sap.fe.templates.ListReport",
          "options": {
            "settings": {
              "contextPath": "/Tags",
              "variantManagement": "Page",
              "initialLoad": "Enabled",
              "controlConfiguration": {
                "@com.sap.vocabularies.UI.v1.LineItem": {
                  "actions": {
                    "TagImportAction": {
                      "press": "sap.tutorials.admin.tags.ext.TagImportController.openTagImportDialog",
                      "visible": true,
                      "enabled": true,
                      "text": "{i18n>tagImport.action}",
                      "position": { "placement": "Before", "anchor": "DataFieldForAction::cleanupUnusedTagsAction" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}
```

- [ ] **Step 2: Validate the manifest**

The repo has UI5 manifest validation available. From the worktree root:

```bash
npx ui5-mcp-server-validate || true
```

Or simply build the admin shell to verify nothing breaks:

```bash
npm run build:admin
```
Expected: clean build, no errors mentioning `tags/webapp/manifest.json`.

- [ ] **Step 3: Commit**

```bash
git add app/admin/tags/webapp/manifest.json
git commit -m "feat(tag-import): register controller extension on Tags FE app

Adds Import… header button via UI.LineItem custom action and wires the
TagImportController extension on the standard ListReportController."
```

---

## Task 13: Build the dialog fragment

**Files:**
- Create: `app/admin/tags/webapp/ext/TagImportDialog.fragment.xml`

- [ ] **Step 1: Create the fragment**

Create `app/admin/tags/webapp/ext/TagImportDialog.fragment.xml`:

```xml
<core:FragmentDefinition
  xmlns="sap.m"
  xmlns:core="sap.ui.core"
  xmlns:u="sap.ui.unified">
  <Dialog
    id="tagImportDialog"
    title="{i18n>tagImport.dialog.title}"
    contentWidth="640px"
    contentHeight="520px"
    stretch="{device>/system/phone}">
    <content>

      <!-- UPLOAD STATE -->
      <VBox visible="{= ${viewState>/state} === 'upload' }" class="sapUiSmallMargin">
        <IconTabBar selectedKey="{viewState>/uploadTab}" expandable="false">
          <items>
            <IconTabFilter key="file" text="{i18n>tagImport.tab.file}">
              <VBox class="sapUiSmallMargin">
                <Label text="{i18n>tagImport.upload.help}" />
                <u:FileUploader
                  id="tagImportFileUploader"
                  fileType="csv,json"
                  maximumFileSize="1"
                  change=".extension.sap.tutorials.admin.tags.onFileSelected"
                  buttonText="{i18n>tagImport.tab.file}"
                  uploadOnChange="false"
                  width="100%" />
              </VBox>
            </IconTabFilter>
            <IconTabFilter key="paste" text="{i18n>tagImport.tab.paste}">
              <VBox class="sapUiSmallMargin">
                <HBox alignItems="Center">
                  <Label text="{i18n>tagImport.format.label}" labelFor="tagImportFormatSelect" class="sapUiTinyMarginEnd" />
                  <Select id="tagImportFormatSelect" selectedKey="{viewState>/format}">
                    <core:Item key="csv" text="{i18n>tagImport.format.csv}" />
                    <core:Item key="json" text="{i18n>tagImport.format.json}" />
                  </Select>
                </HBox>
                <TextArea
                  id="tagImportPasteArea"
                  value="{viewState>/payload}"
                  rows="14"
                  growing="false"
                  width="100%" />
              </VBox>
            </IconTabFilter>
          </items>
        </IconTabBar>
        <Button
          text="{i18n>tagImport.button.preview}"
          type="Emphasized"
          press=".extension.sap.tutorials.admin.tags.onPreview"
          enabled="{= !!${viewState>/payload} }"
          class="sapUiSmallMarginTop" />
      </VBox>

      <!-- PREVIEW STATE -->
      <VBox visible="{= ${viewState>/state} === 'preview' }" class="sapUiSmallMargin">
        <MessageStrip
          text="{viewState>/summaryText}"
          type="{viewState>/summaryStripType}"
          showIcon="true"
          class="sapUiSmallMarginBottom" />
        <Table
          items="{viewState>/rows}"
          mode="None"
          growing="true"
          growingThreshold="50">
          <columns>
            <Column><header><Text text="{i18n>tagImport.col.status}" /></header></Column>
            <Column><header><Text text="{i18n>tagImport.col.name}" /></header></Column>
            <Column><header><Text text="{i18n>tagImport.col.titlePath}" /></header></Column>
            <Column><header><Text text="{i18n>tagImport.col.existingTitlePath}" /></header></Column>
            <Column><header><Text text="{i18n>tagImport.col.reason}" /></header></Column>
          </columns>
          <items>
            <ColumnListItem>
              <cells>
                <ObjectStatus text="{viewState>statusLabel}" state="{viewState>statusState}" />
                <Text text="{viewState>name}" />
                <Text text="{viewState>titlePath}" />
                <Text text="{viewState>existingTitlePath}" />
                <Text text="{viewState>reason}" />
              </cells>
            </ColumnListItem>
          </items>
        </Table>
        <HBox alignItems="Center" class="sapUiSmallMarginTop">
          <Label text="{i18n>tagImport.strategy.label}" labelFor="tagImportStrategySelect" class="sapUiTinyMarginEnd" />
          <Select id="tagImportStrategySelect" selectedKey="{viewState>/strategy}">
            <core:Item key="upsert" text="{i18n>tagImport.strategy.upsert}" />
            <core:Item key="skip-duplicates" text="{i18n>tagImport.strategy.skip}" />
            <core:Item key="abort-on-duplicate" text="{i18n>tagImport.strategy.abort}" />
          </Select>
        </HBox>
      </VBox>

      <!-- DONE STATE -->
      <VBox visible="{= ${viewState>/state} === 'done' }" class="sapUiSmallMargin">
        <MessageStrip
          text="{viewState>/resultText}"
          type="Success"
          showIcon="true" />
      </VBox>

    </content>
    <buttons>
      <Button
        text="{i18n>tagImport.button.back}"
        visible="{= ${viewState>/state} === 'preview' }"
        press=".extension.sap.tutorials.admin.tags.onBack" />
      <Button
        text="{i18n>tagImport.button.import}"
        type="Emphasized"
        visible="{= ${viewState>/state} === 'preview' }"
        press=".extension.sap.tutorials.admin.tags.onCommit" />
      <Button
        text="{i18n>tagImport.button.close}"
        press=".extension.sap.tutorials.admin.tags.onClose" />
    </buttons>
  </Dialog>
</core:FragmentDefinition>
```

- [ ] **Step 2: Commit**

```bash
git add app/admin/tags/webapp/ext/TagImportDialog.fragment.xml
git commit -m "feat(tag-import): dialog fragment with 3 states

Single dialog driven by viewState>/state: upload, preview, done.
Upload tab supports file picker + paste with format radio.
Preview shows classified rows + strategy selector. Done shows result strip."
```

---

## Task 14: Implement the controller extension

**Files:**
- Create: `app/admin/tags/webapp/ext/TagImportController.js`

- [ ] **Step 1: Create the controller**

Create `app/admin/tags/webapp/ext/TagImportController.js`:

```js
sap.ui.define([
  "sap/ui/core/mvc/ControllerExtension",
  "sap/ui/model/json/JSONModel",
  "sap/ui/core/Fragment",
  "sap/m/MessageBox",
  "sap/m/MessageStrip"
], function (ControllerExtension, JSONModel, Fragment, MessageBox) {
  "use strict";

  return ControllerExtension.extend("sap.tutorials.admin.tags.ext.TagImportController", {

    override: {
      onInit: function () {
        this._dialog = null;
      }
    },

    _initialState: function () {
      return {
        state: "upload",
        uploadTab: "file",
        format: "csv",
        payload: "",
        rows: [],
        summaryText: "",
        summaryStripType: "Information",
        strategy: "upsert",
        resultText: "",
        token: null
      };
    },

    _ensureViewState: function () {
      const view = this.base.getView();
      let model = view.getModel("viewState");
      if (!model) {
        model = new JSONModel(this._initialState());
        view.setModel(model, "viewState");
      } else {
        model.setData(this._initialState());
      }
      return model;
    },

    openTagImportDialog: function () {
      const view = this.base.getView();
      this._ensureViewState();
      const open = (dlg) => { this._dialog = dlg; dlg.open(); };
      if (this._dialog) {
        open(this._dialog);
      } else {
        Fragment.load({
          id: view.getId(),
          name: "sap.tutorials.admin.tags.ext.TagImportDialog",
          controller: this
        }).then((dlg) => { view.addDependent(dlg); open(dlg); });
      }
    },

    onFileSelected: function (oEvent) {
      const file = oEvent.getParameter("files") && oEvent.getParameter("files")[0];
      if (!file) return;
      const view = this.base.getView();
      const model = view.getModel("viewState");
      const reader = new FileReader();
      reader.onload = (e) => {
        model.setProperty("/payload", e.target.result);
        const fmt = file.name.toLowerCase().endsWith(".json") ? "json" : "csv";
        model.setProperty("/format", fmt);
      };
      reader.readAsText(file);
    },

    onPreview: function () {
      const view = this.base.getView();
      const model = view.getModel("viewState");
      const payload = model.getProperty("/payload");
      const format  = model.getProperty("/format");
      const ctx = view.getBindingContext();
      const odataModel = view.getModel();
      const op = odataModel.bindContext("/previewTagImport(...)");
      op.setParameter("payload", payload);
      op.setParameter("format",  format);
      op.execute().then(() => {
        const result = op.getBoundContext().getObject();
        model.setProperty("/token", result.token);
        model.setProperty("/rows", result.rows.map((r) => ({
          ...r,
          statusLabel: this._statusLabel(r.status),
          statusState: this._statusState(r.status)
        })));
        const s = result.summary;
        model.setProperty("/summaryText", this._fmtSummary(s));
        model.setProperty("/summaryStripType",
          s.invalid > 0 ? "Warning" : (s.conflict > 0 ? "Information" : "Success"));
        model.setProperty("/state", "preview");
      }).catch((err) => MessageBox.error(this._fmtError(err)));
    },

    onCommit: function () {
      const view = this.base.getView();
      const model = view.getModel("viewState");
      const odataModel = view.getModel();
      const op = odataModel.bindContext("/commitTagImport(...)");
      op.setParameter("token", model.getProperty("/token"));
      op.setParameter("strategy", model.getProperty("/strategy"));
      op.execute().then(() => {
        const r = op.getBoundContext().getObject();
        model.setProperty("/resultText", this._fmtResult(r));
        model.setProperty("/state", "done");
        // Refresh the list-report binding so newly-imported rows appear.
        const lr = view.byId("fe::table::Tags::LineItem-innerTable");
        if (lr && lr.getBinding("items")) lr.getBinding("items").refresh();
      }).catch((err) => {
        // Token expired → fall back to upload state
        const status = err && err.error && err.error.code;
        if (status === "410" || /expired/i.test(err.message || "")) {
          model.setProperty("/state", "upload");
          MessageBox.warning(this.base.getView().getModel("i18n").getResourceBundle()
            .getText("tagImport.error.expired"));
          return;
        }
        MessageBox.error(this._fmtError(err));
      });
    },

    onBack: function () {
      this.base.getView().getModel("viewState").setProperty("/state", "upload");
    },

    onClose: function () {
      if (this._dialog) this._dialog.close();
    },

    _statusLabel: function (status) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      return bundle.getText("tagImport.status." + status);
    },

    _statusState: function (status) {
      switch (status) {
        case "new":      return "Success";
        case "conflict": return "Warning";
        case "invalid":  return "Error";
        default:         return "None";
      }
    },

    _fmtSummary: function (s) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      return bundle.getText("tagImport.summary", [s.new_, s.conflict, s.invalid, s.total]);
    },

    _fmtResult: function (r) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      return bundle.getText("tagImport.result", [r.inserted, r.updated, r.skipped, r.total]);
    },

    _fmtError: function (err) {
      const bundle = this.base.getView().getModel("i18n").getResourceBundle();
      const detail = (err && err.error && err.error.message) || (err && err.message) || String(err);
      return bundle.getText("tagImport.error.generic", [detail]);
    }

  });
});
```

- [ ] **Step 2: Build the admin shell to verify it loads**

```bash
npm run build:admin
```
Expected: clean build.

- [ ] **Step 3: Commit**

```bash
git add app/admin/tags/webapp/ext/TagImportController.js
git commit -m "feat(tag-import): controller extension for Tags FE app

Drives the dialog through upload → preview → done states. Calls the two
new AdminService actions via OData v4 bound-action API. Refreshes the
list-report binding on success so imported tags appear immediately."
```

---

## Task 15: Manual smoke verification

**Files:**
- None (manual)

This is a deferred step the executor performs only when ready to test in the browser. List included so the plan is complete.

- [ ] **Step 1: Start hybrid dev environment**

```bash
npm run dev:hybrid
```

- [ ] **Step 2: Walk the golden path**

Open `http://localhost:5000/admin-ui/#/tags`, click **Import…**, paste:

```
name,titlePath
__SMOKE__alpha,Smoke:Alpha
__SMOKE__bravo,Smoke:Bravo
```

Click Preview → confirm 2 new rows shown → click Import (strategy: upsert) → confirm `2 inserted, 0 updated`.

- [ ] **Step 3: Walk the conflict path**

Open Import again, paste:

```
name,titlePath
__SMOKE__alpha,Smoke:AlphaUpdated
```

Preview → 1 conflict shown → strategy `Upsert` → Import → confirm `0 inserted, 1 updated`. Refresh the list-report and verify `__SMOKE__alpha` shows `Smoke:AlphaUpdated`.

- [ ] **Step 4: Walk the abort path**

Repeat with strategy `Abort if any conflict`. Expect 409 surfaced as a `MessageBox.error`.

- [ ] **Step 5: Cleanup**

In the FE list, filter on `__SMOKE__` and delete the rows. (Or: use the existing `cleanupUnusedTags` action — they have no TutorialTag references.)

---

## Task 16: Update TODO.md and final commit

**Files:**
- Modify: `TODO.md`

- [ ] **Step 1: Mark the line done**

Edit line 545 of `TODO.md`. Change:

```
- [ ] **Tag Import** — Implement bulk import of tags from an external source (e.g., CSV, API, or taxonomy system) into the Tags entity.
```

to:

```
- [x] **Tag Import** — Bulk CSV/JSON import via Tags admin app. Two-step preview/commit flow on AdminService with upsert / skip-duplicates / abort-on-duplicate strategies.
```

- [ ] **Step 2: Run the unit suite once more end-to-end**

```bash
npm test -- --project unit
```
Expected: all `tag-import` files green. Pre-existing hook-timeout failures noted in plan header are unrelated (32 passed / 20 unrelated failed at baseline).

- [ ] **Step 3: Commit**

```bash
git add TODO.md
git commit -m "chore: mark Tag Import as done in TODO

Resolves: TODO line 545"
```

- [ ] **Step 4: Push the branch and open a PR**

```bash
git push -u origin feature/tag-importer
gh pr create --title "Tag importer: bulk CSV/JSON import via admin Tags app" --body "$(cat <<'EOF'
## Summary
- Two-step preview/commit flow on AdminService for bulk tag imports
- CSV + JSON formats, hard caps at 5,000 rows / 1 MB
- Three conflict strategies: upsert, skip-duplicates, abort-on-duplicate
- Surfaced via Import… button on the existing Tags Fiori Elements list-report

## Test plan
- [x] Unit: parser, classifier, applier, preview-cache (all in test/unit/tag-import/)
- [x] Action: previewTagImport + commitTagImport via supertest against in-memory CAP
- [x] Hybrid: end-to-end against real HANA (test/hybrid/tag-import.test.js, run with ALLOW_HYBRID_WRITES=true npm run test:hybrid)
- [ ] Manual smoke (per plan task 15) once deployed to DEV

Spec: docs/superpowers/specs/2026-05-20-tag-importer-design.md
Plan: docs/superpowers/plans/2026-05-20-tag-importer.md
EOF
)"
```

---

## Verification Checklist (post-implementation)

- [ ] All unit tests pass: `npm test -- --project unit`
- [ ] Hybrid test passes: `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/tag-import.test.js`
- [ ] Admin shell builds clean: `npm run build:admin`
- [ ] Manual smoke walked (Task 15)
- [ ] PR opened, CI green

## Notes for the Implementer

- The CLAUDE.md rule is firm: **never write raw SQL**. The applier uses CDS QL exclusively (`INSERT.into(Tags).entries(...)`, `UPDATE(Tags, id).set(...)`).
- The legacyId for new Tags is auto-assigned by the existing `before('CREATE')` hook in `srv/admin-service.js:55-61` (Tags is in `legacyKeyedEntities`). The applier deliberately omits `legacyId` from its INSERT payload.
- Conflict detection is **case-insensitive** by design: imports of "ABAP" and "abap" should be treated as the same tag to avoid taxonomy drift. The classifier and applier respect this.
- The in-memory preview cache is single-instance only. See SCALING CAVEAT comment at the head of `srv/lib/tag-import/preview-cache.js`. Not a v1 issue — tutorials-srv runs as a single instance today.
- If a Windows hook-timeout (10s) bites a CAP-test-bootstrapped file, raise per-test timeout via `--testTimeout=60000` rather than touching production code. The pre-existing baseline shows ~20 unrelated test files affected.
- When in doubt about CAP API shape, use `mcp__plugin_cds-mcp_cds-mcp__search_docs` per the project's CLAUDE.md global rule.
