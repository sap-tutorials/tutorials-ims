# External SAP Channels — P1 Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the `Channels` source-of-truth entity, a re-ingestable seed pipeline from the research dataset, a `/channels` browsable directory, and fill verb-lane shelf gaps — the foundation every later phase builds on.

**Architecture:** A new journaled CAP entity `Channels` (namespace `com.sap.developers.ims`) is the single source of truth. A CLI seed script normalizes the research JSON and idempotently upserts it, preserving admin-curated columns. A `/build/channels` Express feed bakes to `hugo/data/channels.json`; a Hugo section page + Vue facet island render the directory client-side over that baked JSON. A promotion module maps featured channels into the existing `HomepageShelves` entity to fill verb lanes. An admin Fiori Elements app exposes curation.

**Tech Stack:** SAP CAP (Node.js) · CDS · SAP HANA (HDI) · Hugo · Vue 3 (Vite islands) · SAPUI5 Fiori Elements · Vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-external-channels-integration-design.md`

## Global Constraints

- **Namespace:** all new persisted entities live under `com.sap.developers.ims` (the `ims` namespace, same as `HomepageShelves`), NOT `.external`. Verbatim: `namespace com.sap.developers.ims;`.
- **Journal required:** every new persisted entity MUST get an explicit `annotate ims.<Entity> with @cds.persistence.journal;` line in `db/persistence.cds`, or it deploys as a DROP+CREATE `.hdbtable` and loses curated data on redeploy.
- **Array columns need reflection:** entity handles for INSERT/SELECT of `array of String` columns MUST be obtained via `cds.linked(cds.model ?? await cds.load('*')).entities('com.sap.developers.ims')` — a fully-qualified string entity name is not type-aware and fails on HANA for array columns (serializes to JSON NCLOB). Pattern documented in `srv/lib/homepage/seed-homepage-shelves.js:26-31`.
- **HANA table/column names are UPPERCASE, underscore-joined** (`COM_SAP_DEVELOPERS_IMS_CHANNELS`); never SELECT a BLOB alongside metadata (N/A here — no BLOBs).
- **Upsert on natural key:** all write paths SELECT-then-UPDATE-or-INSERT on the natural key (`sourceId`), never blind INSERT.
- **Community channels never land in `START_HERE`** — third-party/community items map only to `REFERENCE`/`TOOLS`/`KEEP_CURRENT`.
- **Validate before commit:** run `npx cds deploy --to sqlite::memory:` after any `db/**/*.cds` change; run relevant tests before every commit.
- **Test bootstrap:** service tests use one top-level `const project = cds.test('serve', '--project', '.', '--in-memory');` per file (per-describe bootstrap races the port). Admin service is `@requires`-gated → read/write over HTTP with `{ auth: { username:'admin', password:'admin' } }`.
- **CDS-MCP:** before landing any CDS-model or CAP-API change, validate the exact syntax with `cds-mcp` per repo rules.

---

### Task 1: `Channels` entity + persistence journal

**Files:**
- Create: `db/channels.cds`
- Modify: `db/persistence.cds` (append one journal line)
- Test: `test/channels-model.test.js`

**Interfaces:**
- Produces: entity `com.sap.developers.ims.Channels` with fields `sourceId, name, url, relatedUrls[], aliases[], purpose, notes, ownerName, ownerType, isSapOwned, category, subcategory, platform, status, focusAreas[], tags[], updateFrequency, githubStars, subscribers, isPublished, isFeatured, editorialNote, contentHash, ingestBatch, linkStatus, linkStatusOverride, lastChecked`. Enums `ChannelOwnerType`, `ChannelStatus`.

- [ ] **Step 1: Write `db/channels.cds`**

```cds
namespace com.sap.developers.ims;

using { managed, cuid } from '@sap/cds/common';

type ChannelOwnerType : String enum {
  SAP_Official; SAP_Developer_Advocate; SAP_Executive;
  Community_Member; Community_Organization; User_Group;
  Third_party_Training; Third_party_Media; Third_party_Platform;
}
type ChannelStatus : String enum { Active; Archived; Closed; Discontinued; EOL; }

@assert.unique.sourceId: [sourceId]
entity Channels : cuid, managed {
  sourceId       : String(40)  @mandatory;   // "portal-001" — dedup / re-ingest key
  name           : String(200) @mandatory;
  url            : String(500) @mandatory;
  relatedUrls    : array of String(500);
  aliases        : array of String(120);
  purpose        : String(1000);             // cleaned of [cite:] markers at ingest
  notes          : String(1000);
  ownerName      : String(120);
  ownerType      : ChannelOwnerType;
  isSapOwned     : Boolean default false;
  category       : String(60);
  subcategory    : String(80);
  platform       : String(40);
  status         : ChannelStatus default 'Active';
  focusAreas     : array of String(60);
  tags           : array of String(40);
  updateFrequency: String(40);
  githubStars    : Integer;
  subscribers    : Integer;

  // ── curation / lifecycle (admin-editable; absent from ingest so re-seed never wipes) ──
  isPublished        : Boolean default true;
  isFeatured         : Boolean default false;
  editorialNote      : String(800);
  contentHash        : String(64);
  ingestBatch        : String(40);
  linkStatus         : String(20) default 'UNKNOWN';
  linkStatusOverride : String(20);
  lastChecked        : Timestamp;
}
```

- [ ] **Step 2: Append journal annotation to `db/persistence.cds`**

Add this line alongside the existing `annotate ims.* with @cds.persistence.journal;` block:

```cds
annotate ims.Channels with @cds.persistence.journal;
```

- [ ] **Step 3: Verify the model compiles**

Run: `npx cds deploy --to sqlite::memory:`
Expected: exits 0, no compile error (confirms enums/arrays/annotation are valid and the new file loads).

- [ ] **Step 4: Write the failing model test**

```js
// test/channels-model.test.js
import cds from '@sap/cds';
import { describe, it, expect, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('Channels entity', () => {
  const NS = 'com.sap.developers.ims';
  const linked = () => cds.linked(cds.model).entities(NS);

  afterAll(async () => {
    const { Channels } = linked();
    await DELETE.from(Channels).where({ sourceId: 'test-001' });
  });

  it('round-trips array columns', async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries({
      ID: cds.utils.uuid(), sourceId: 'test-001', name: 'Test', url: 'https://x.test',
      focusAreas: ['abap', 'cap'], tags: ['t1'], relatedUrls: ['https://y.test'],
      isSapOwned: true, isPublished: true,
    });
    const row = await SELECT.one.from(Channels).where({ sourceId: 'test-001' });
    expect(row.focusAreas).toEqual(['abap', 'cap']);
    expect(row.tags).toEqual(['t1']);
    expect(row.isPublished).toBe(true);
  });
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/channels-model.test.js`
Expected: PASS (entity exists, arrays round-trip).

- [ ] **Step 6: Commit**

```bash
git add db/channels.cds db/persistence.cds test/channels-model.test.js
git commit -m "feat(channels): add Channels source-of-truth entity + persistence journal"
```

---

### Task 2: Ingestion — normalize module + seed CLI

Split pure normalization (unit-testable, no DB) from the thin DB-writing CLI.

**Files:**
- Create: `srv/lib/channels/normalize.js`
- Create: `scripts/seed-channels.cjs`
- Modify: `package.json` (add `seed-channels` script entry)
- Test: `test/channels-normalize.test.js`, `test/channels-seed.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.Channels` (Task 1).
- Produces: `srv/lib/channels/normalize.js` exports `cleanCitations(text) -> string`, `normalizeOwnerType(raw) -> enumString|null`, `normalizeStatus(raw) -> {status, note}`, `computeContentHash(sourceFields) -> string`, `normalizeChannel(rawJson) -> channelRow`. CLI `scripts/seed-channels.cjs` reads `--file <path>` (default `d:/tmp/External-SAP-Channels-Complete.json`), flags `--commit` (default dry-run) and `--force`.

- [ ] **Step 1: Write the failing normalize test**

```js
// test/channels-normalize.test.js
import { describe, it, expect } from 'vitest';
import {
  cleanCitations, normalizeOwnerType, normalizeStatus,
  computeContentHash, normalizeChannel,
} from '../srv/lib/channels/normalize.js';

describe('channels normalize', () => {
  it('strips [cite:] markers and trailing space', () => {
    expect(cleanCitations('The BTP portal. [cite: 12]')).toBe('The BTP portal.');
    expect(cleanCitations('No marker')).toBe('No marker');
  });

  it('maps owner_type strings to the enum', () => {
    expect(normalizeOwnerType('SAP Official')).toBe('SAP_Official');
    expect(normalizeOwnerType('Community Member')).toBe('Community_Member');
    expect(normalizeOwnerType('unknown junk')).toBeNull();
  });

  it('normalizes status with a carry-over note', () => {
    expect(normalizeStatus('Active')).toEqual({ status: 'Active', note: null });
    expect(normalizeStatus('Entering EOL')).toEqual({ status: 'EOL', note: 'Entering EOL' });
    expect(normalizeStatus('Active (Canonical source)'))
      .toEqual({ status: 'Active', note: 'Canonical source' });
  });

  it('content hash is stable across key order and changes with content', () => {
    const a = computeContentHash({ name: 'X', url: 'u', purpose: 'p' });
    const b = computeContentHash({ url: 'u', purpose: 'p', name: 'X' });
    const c = computeContentHash({ name: 'X', url: 'u', purpose: 'q' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('normalizeChannel produces an upsert-ready row', () => {
    const row = normalizeChannel({
      id: 'portal-001', name: 'BTP Portal', url: 'https://x',
      owner_type: 'SAP Official', isSapOwned: true, status: 'Active',
      focus_areas: ['btp'], tags: ['btp'], purpose: 'Portal. [cite: 1]',
    }, '2026-09-03');
    expect(row.sourceId).toBe('portal-001');
    expect(row.purpose).toBe('Portal.');
    expect(row.ownerType).toBe('SAP_Official');
    expect(row.focusAreas).toEqual(['btp']);
    expect(row.ingestBatch).toBe('2026-09-03');
    expect(typeof row.contentHash).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/channels-normalize.test.js`
Expected: FAIL — cannot resolve `../srv/lib/channels/normalize.js`.

- [ ] **Step 3: Write `srv/lib/channels/normalize.js`**

```js
'use strict';
const crypto = require('node:crypto');

// Strip trailing "[cite: N]" style markers (and any trailing whitespace).
function cleanCitations(text) {
  if (!text) return text;
  return String(text).split('[cite')[0].replace(/\s+$/, '');
}

const OWNER_TYPE_MAP = {
  'sap official': 'SAP_Official',
  'sap developer advocate': 'SAP_Developer_Advocate',
  'sap executive': 'SAP_Executive',
  'community member': 'Community_Member',
  'community organization': 'Community_Organization',
  'user group': 'User_Group',
  'third-party training': 'Third_party_Training',
  'third-party media': 'Third_party_Media',
  'third-party platform': 'Third_party_Platform',
};
function normalizeOwnerType(raw) {
  if (!raw) return null;
  return OWNER_TYPE_MAP[String(raw).trim().toLowerCase()] ?? null;
}

// Map free-text status → enum, carrying any parenthetical / qualifier as a note.
function normalizeStatus(raw) {
  if (!raw) return { status: 'Active', note: null };
  const s = String(raw).trim();
  const lower = s.toLowerCase();
  if (lower.startsWith('entering eol') || lower === 'eol') return { status: 'EOL', note: s === 'EOL' ? null : s };
  if (lower.startsWith('active')) {
    const m = s.match(/\((.+)\)/);
    return { status: 'Active', note: m ? m[1].trim() : null };
  }
  if (lower.startsWith('archiv')) return { status: 'Archived', note: null };
  if (lower.startsWith('closed')) return { status: 'Closed', note: null };
  if (lower.startsWith('discontinu')) return { status: 'Discontinued', note: null };
  return { status: 'Active', note: s };
}

// Hash only the source (dataset-owned) fields, order-independent.
function computeContentHash(sourceFields) {
  const canonical = JSON.stringify(sourceFields, Object.keys(sourceFields).sort());
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function normalizeChannel(raw, ingestBatch) {
  const { status, note } = normalizeStatus(raw.status);
  const purpose = cleanCitations(raw.purpose);
  const notesParts = [cleanCitations(raw.notes), note].filter(Boolean);
  const source = {
    name: raw.name, url: raw.url,
    relatedUrls: raw.related_urls ?? [],
    aliases: raw.aliases ?? [],
    purpose, notes: notesParts.join(' — ') || null,
    ownerName: raw.owner ?? raw.owner_name ?? null,
    ownerType: normalizeOwnerType(raw.owner_type),
    isSapOwned: raw.isSapOwned === true,
    category: raw.category ?? null,
    subcategory: raw.subcategory ?? null,
    platform: raw.platform ?? null,
    status,
    focusAreas: raw.focus_areas ?? [],
    tags: raw.tags ?? [],
    updateFrequency: raw.update_frequency ?? null,
    githubStars: raw.github_stars ?? null,
    subscribers: raw.subscribers ?? null,
  };
  return { sourceId: raw.id, ...source, contentHash: computeContentHash(source), ingestBatch };
}

module.exports = { cleanCitations, normalizeOwnerType, normalizeStatus, computeContentHash, normalizeChannel };
```

- [ ] **Step 4: Run normalize test to verify it passes**

Run: `npx vitest run test/channels-normalize.test.js`
Expected: PASS.

- [ ] **Step 5: Write `scripts/seed-channels.cjs`**

```js
'use strict';
// Idempotent re-ingest of the external-channels research dataset into Channels.
// Preserves admin-curated columns; retires-on-absence (soft). Run:
//   npx cds bind --exec -- node scripts/seed-channels.cjs --file d:/tmp/External-SAP-Channels-Complete.json --commit
const cds = require('@sap/cds');
const { readFileSync } = require('node:fs');
const { normalizeChannel } = require('../srv/lib/channels/normalize.js');

const CURATED = ['isPublished', 'isFeatured', 'editorialNote', 'linkStatus', 'linkStatusOverride', 'lastChecked'];

async function main() {
  const args = process.argv.slice(2);
  const commit = args.includes('--commit');
  const force = args.includes('--force');
  const fileIdx = args.indexOf('--file');
  const file = fileIdx >= 0 ? args[fileIdx + 1] : 'd:/tmp/External-SAP-Channels-Complete.json';

  const doc = JSON.parse(readFileSync(file, 'utf8'));
  const batch = doc.metadata?.generated ?? new Date().toISOString().slice(0, 10);
  const rawChannels = doc.channels ?? doc;

  const db = await cds.connect.to('db');
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { Channels } = linked.entities('com.sap.developers.ims');

  let inserted = 0, updated = 0, skipped = 0;
  const seen = new Set();
  for (const raw of rawChannels) {
    const row = normalizeChannel(raw, batch);
    seen.add(row.sourceId);
    const existing = await SELECT.one.from(Channels).where({ sourceId: row.sourceId });
    if (existing && existing.contentHash === row.contentHash && !force) { skipped++; continue; }
    if (existing) {
      // update source-owned fields only; never touch curated columns
      const patch = { ...row };
      for (const k of CURATED) delete patch[k];
      if (commit) await UPDATE(Channels).set(patch).where({ ID: existing.ID });
      updated++;
    } else {
      if (commit) await INSERT.into(Channels).entries({ ID: cds.utils.uuid(), ...row });
      inserted++;
    }
  }

  // retire-on-absence (soft): rows never seen in this batch → Archived, curation untouched
  const all = await SELECT.from(Channels).columns('ID', 'sourceId', 'status');
  let retired = 0;
  for (const r of all) {
    if (!seen.has(r.sourceId) && r.status !== 'Archived') {
      if (commit) await UPDATE(Channels).set({ status: 'Archived' }).where({ ID: r.ID });
      retired++;
    }
  }

  console.log(`[seed-channels] batch=${batch} ${commit ? 'COMMIT' : 'DRY-RUN'} `
    + `inserted=${inserted} updated=${updated} skipped=${skipped} retired=${retired}`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Add the package.json script entry**

In `package.json` `scripts`, add:

```json
"seed-channels": "cds bind --exec -- node scripts/seed-channels.cjs"
```

- [ ] **Step 7: Write the failing seed idempotency test**

```js
// test/channels-seed.test.js
import cds from '@sap/cds';
import { describe, it, expect, afterAll } from 'vitest';
import { normalizeChannel } from '../srv/lib/channels/normalize.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

// Mirror the seed's upsert semantics (curated-column preservation) directly against the DB.
async function upsert(raw, batch, { commit = true } = {}) {
  const { Channels } = linked();
  const row = normalizeChannel(raw, batch);
  const existing = await SELECT.one.from(Channels).where({ sourceId: row.sourceId });
  const CURATED = ['isPublished', 'isFeatured', 'editorialNote', 'linkStatus', 'linkStatusOverride', 'lastChecked'];
  if (existing && existing.contentHash === row.contentHash) return 'skipped';
  if (existing) {
    const patch = { ...row }; for (const k of CURATED) delete patch[k];
    if (commit) await UPDATE(Channels).set(patch).where({ ID: existing.ID });
    return 'updated';
  }
  if (commit) await INSERT.into(Channels).entries({ ID: cds.utils.uuid(), ...row });
  return 'inserted';
}

describe('channels seed upsert', () => {
  const base = { id: 'seed-001', name: 'Portal', url: 'https://p', owner_type: 'SAP Official', status: 'Active', purpose: 'A. [cite: 1]' };
  afterAll(async () => { await DELETE.from(linked().Channels).where({ sourceId: 'seed-001' }); });

  it('inserts, then skips unchanged, and preserves curated columns on change', async () => {
    expect(await upsert(base, '2026-09-03')).toBe('inserted');
    // curator flips isFeatured
    const { Channels } = linked();
    await UPDATE(Channels).set({ isFeatured: true }).where({ sourceId: 'seed-001' });
    // same content → skip
    expect(await upsert(base, '2026-09-03')).toBe('skipped');
    // changed purpose → update source col, keep isFeatured
    expect(await upsert({ ...base, purpose: 'B.' }, '2026-09-10')).toBe('updated');
    const row = await SELECT.one.from(Channels).where({ sourceId: 'seed-001' });
    expect(row.purpose).toBe('B.');
    expect(row.isFeatured).toBe(true);
  });
});
```

- [ ] **Step 8: Run seed test to verify it passes**

Run: `npx vitest run test/channels-seed.test.js`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add srv/lib/channels/normalize.js scripts/seed-channels.cjs package.json test/channels-normalize.test.js test/channels-seed.test.js
git commit -m "feat(channels): normalize module + idempotent re-ingestable seed CLI"
```

---

### Task 3: `/build/channels` read feed

**Files:**
- Modify: `srv/server.js` (add route in the `/build/*` block, ~line 337)
- Test: `test/build-channels-feed.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.Channels` (Task 1).
- Produces: `GET /build/channels` → `{ channels: [...], buildAt: ISOString }`. Each channel includes parsed array columns and coalesced `linkStatus` (override wins); `isPublished: false` and `linkStatus === 'BROKEN'` rows are excluded.

- [ ] **Step 1: Write the failing feed test**

```js
// test/build-channels-feed.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('GET /build/channels', () => {
  beforeAll(async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries([
      { ID: cds.utils.uuid(), sourceId: 'feed-pub', name: 'Pub', url: 'https://pub', isPublished: true, linkStatus: 'OK', focusAreas: ['btp'] },
      { ID: cds.utils.uuid(), sourceId: 'feed-unpub', name: 'Unpub', url: 'https://unpub', isPublished: false, linkStatus: 'OK' },
      { ID: cds.utils.uuid(), sourceId: 'feed-broken', name: 'Broken', url: 'https://broken', isPublished: true, linkStatus: 'BROKEN' },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['feed-pub', 'feed-unpub', 'feed-broken'] } });
  });

  it('returns only published, non-broken channels with parsed arrays', async () => {
    const { status, data } = await project.get('/build/channels');
    expect(status).toBe(200);
    const ids = data.channels.map((c) => c.sourceId);
    expect(ids).toContain('feed-pub');
    expect(ids).not.toContain('feed-unpub');
    expect(ids).not.toContain('feed-broken');
    const pub = data.channels.find((c) => c.sourceId === 'feed-pub');
    expect(pub.focusAreas).toEqual(['btp']);
    expect(typeof data.buildAt).toBe('string');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/build-channels-feed.test.js`
Expected: FAIL — 404 on `/build/channels`.

- [ ] **Step 3: Add the route in `srv/server.js`**

Insert next to `GET /build/homepage-shelves` (~line 337). Note the array-column parse guard — HANA returns `array of String` columns as JSON strings; SQLite returns arrays.

```js
app.get('/build/channels', async (_req, res) => {
  const db = await cds.connect.to('db');
  const rows = await db.run(
    SELECT.from('com.sap.developers.ims.Channels')
      .where({ isPublished: true })
      .orderBy('category', 'name'),
  );
  const parseArr = (v) => (Array.isArray(v) ? v : (typeof v === 'string' && v ? JSON.parse(v) : []));
  const channels = rows
    .map((r) => ({
      ...r,
      linkStatus: r.linkStatusOverride || r.linkStatus,
      focusAreas: parseArr(r.focusAreas),
      tags: parseArr(r.tags),
      relatedUrls: parseArr(r.relatedUrls),
      aliases: parseArr(r.aliases),
    }))
    .filter((r) => r.linkStatus !== 'BROKEN');
  res.set('Cache-Control', 'public, max-age=60');
  res.json({ channels, buildAt: new Date().toISOString() });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/build-channels-feed.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/server.js test/build-channels-feed.test.js
git commit -m "feat(channels): /build/channels read feed (published, non-broken, parsed arrays)"
```

---

### Task 4: Hugo bake — `scripts/fetch-channels.ts` + build wiring

**Files:**
- Create: `scripts/fetch-channels.ts`
- Modify: `package.json` (add `fetch-channels` script + insert into the `build:all` chain, line ~90)
- Test: manual bake verification (build script; no unit test — mirrors sibling fetchers which have none)

**Interfaces:**
- Consumes: `GET /build/channels` (Task 3).
- Produces: `hugo/data/channels.json` shaped `{ channels: [...], buildAt, error }`. Consumed by Task 5 via `.Site.Data.channels`.

- [ ] **Step 1: Write `scripts/fetch-channels.ts`** (mirror `scripts/fetch-homepage-shelves.ts`)

```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const CAP_BASE = process.env.CAP_BASE_URL || 'http://localhost:4004';
const OUT_PATH = join('hugo', 'data', 'channels.json');

let payload: { channels: unknown[]; buildAt: string; error: string | null } = {
  channels: [], buildAt: new Date().toISOString(), error: null,
};
try {
  const res = await fetch(`${CAP_BASE}/build/channels`);
  if (!res.ok) throw new Error(`status ${res.status}`);
  payload = { ...payload, ...(await res.json()) };
} catch (err) {
  payload.error = err instanceof Error ? err.message : String(err);
  console.warn(`[fetch-channels] warn: ${payload.error} — writing empty payload`);
}
mkdirSync(join('hugo', 'data'), { recursive: true });
writeFileSync(OUT_PATH, JSON.stringify(payload, null, 2), 'utf-8');
console.log(`[fetch-channels] wrote ${payload.channels.length} channels → ${OUT_PATH}`);
```

- [ ] **Step 2: Add the package.json script entry**

In `scripts`, next to `fetch-homepage-shelves`:

```json
"fetch-channels": "tsx scripts/fetch-channels.ts"
```

- [ ] **Step 3: Insert into the `build:all` chain**

In the `build:all` script value, add `&& npm run fetch-channels` immediately after `npm run fetch-homepage-shelves`, before `npm run build:hugo`.

- [ ] **Step 4: Verify the bake against a running CAP**

Run (with `cds watch` up and the seed applied):
```bash
npm run fetch-channels && npx jq '.channels | length' hugo/data/channels.json
```
Expected: prints a positive count; `hugo/data/channels.json` exists with a `channels` array. (With CAP down, it writes an empty payload with `error` set — the deliberate warn-and-continue convention.)

- [ ] **Step 5: Commit**

```bash
git add scripts/fetch-channels.ts package.json
git commit -m "feat(channels): bake /build/channels into hugo/data/channels.json"
```

---

### Task 5: `/channels` directory — Hugo page + Vue facet island

Client-side facet/search over the baked JSON embedded in the page (no runtime API call — mirrors the offline-capable island pattern).

**Files:**
- Create: `hugo/content/channels/_index.md`
- Create: `hugo/layouts/channels/list.html`
- Create: `hugo-apps/src/channels-directory/index.ts`
- Create: `hugo-apps/src/channels-directory/ChannelsDirectory.vue`
- Create: `hugo-apps/src/channels-directory/filter.ts`
- Modify: `hugo-apps/vite.config.ts` (add rollup input)
- Test: `hugo-apps/src/channels-directory/filter.test.ts`

**Interfaces:**
- Consumes: `hugo/data/channels.json` (Task 4) via `.Site.Data.channels.channels`; island manifest via `island-src.html`.
- Produces: `filter.ts` exports `filterChannels(channels, { query, category, ownerScope, platform }) -> Channel[]` where `ownerScope ∈ 'all'|'sap'|'community'`.

- [ ] **Step 1: Write the failing filter test**

```ts
// hugo-apps/src/channels-directory/filter.test.ts
import { describe, it, expect } from 'vitest';
import { filterChannels } from './filter';

const data = [
  { name: 'BTP Docs', category: 'Portal', platform: 'Web', isSapOwned: true, purpose: 'docs', tags: ['btp'] },
  { name: 'Reddit SAP', category: 'Community', platform: 'Web', isSapOwned: false, purpose: 'forum', tags: ['community'] },
];

describe('filterChannels', () => {
  it('matches query across name/purpose/tags', () => {
    expect(filterChannels(data, { query: 'reddit' }).map((c) => c.name)).toEqual(['Reddit SAP']);
    expect(filterChannels(data, { query: 'btp' }).map((c) => c.name)).toEqual(['BTP Docs']);
  });
  it('filters by owner scope', () => {
    expect(filterChannels(data, { ownerScope: 'sap' }).map((c) => c.name)).toEqual(['BTP Docs']);
    expect(filterChannels(data, { ownerScope: 'community' }).map((c) => c.name)).toEqual(['Reddit SAP']);
  });
  it('filters by category and platform', () => {
    expect(filterChannels(data, { category: 'Portal' })).toHaveLength(1);
    expect(filterChannels(data, { platform: 'Web' })).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit hugo-apps/src/channels-directory/filter.test.ts`
Expected: FAIL — cannot resolve `./filter`.

- [ ] **Step 3: Write `hugo-apps/src/channels-directory/filter.ts`**

```ts
export interface Channel {
  name: string; url?: string; purpose?: string; category?: string;
  platform?: string; isSapOwned?: boolean; tags?: string[]; ownerType?: string;
}
export interface FilterState {
  query?: string; category?: string; platform?: string;
  ownerScope?: 'all' | 'sap' | 'community';
}
export function filterChannels(channels: Channel[], state: FilterState): Channel[] {
  const q = (state.query || '').trim().toLowerCase();
  return channels.filter((c) => {
    if (state.category && c.category !== state.category) return false;
    if (state.platform && c.platform !== state.platform) return false;
    if (state.ownerScope === 'sap' && !c.isSapOwned) return false;
    if (state.ownerScope === 'community' && c.isSapOwned) return false;
    if (q) {
      const hay = `${c.name} ${c.purpose || ''} ${(c.tags || []).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit hugo-apps/src/channels-directory/filter.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the Vue component `ChannelsDirectory.vue`**

```vue
<script setup lang="ts">
import { ref, computed } from 'vue';
import { filterChannels, type Channel } from './filter';

const props = defineProps<{ channels: Channel[] }>();
const query = ref('');
const category = ref('');
const platform = ref('');
const ownerScope = ref<'all' | 'sap' | 'community'>('all');

const categories = computed(() => [...new Set(props.channels.map((c) => c.category).filter(Boolean))].sort());
const platforms = computed(() => [...new Set(props.channels.map((c) => c.platform).filter(Boolean))].sort());
const results = computed(() =>
  filterChannels(props.channels, { query: query.value, category: category.value, platform: platform.value, ownerScope: ownerScope.value }));
</script>

<template>
  <div class="channels-directory">
    <div class="channels-directory__controls">
      <input v-model="query" type="search" placeholder="Search channels…" aria-label="Search channels" />
      <select v-model="ownerScope" aria-label="Ownership">
        <option value="all">All owners</option><option value="sap">SAP</option><option value="community">Community</option>
      </select>
      <select v-model="category" aria-label="Category">
        <option value="">All categories</option><option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
      </select>
      <select v-model="platform" aria-label="Platform">
        <option value="">All platforms</option><option v-for="p in platforms" :key="p" :value="p">{{ p }}</option>
      </select>
      <span class="channels-directory__count">{{ results.length }} channels</span>
    </div>
    <ul class="channels-directory__list">
      <li v-for="c in results" :key="c.url || c.name" class="channel-card">
        <a :href="c.url" target="_blank" rel="noopener">{{ c.name }}</a>
        <span v-if="!c.isSapOwned" class="badge badge--community">Community</span>
        <p>{{ c.purpose }}</p>
      </li>
    </ul>
  </div>
</template>
```

- [ ] **Step 6: Write the island entry `index.ts`**

```ts
import { createApp } from 'vue';
import ChannelsDirectory from './ChannelsDirectory.vue';

function boot() {
  document.querySelectorAll('[data-island="channels-directory"]').forEach((el) => {
    const dataEl = document.getElementById('channels-data');
    let channels: unknown[] = [];
    try { channels = JSON.parse(dataEl?.textContent || '[]'); } catch { channels = []; }
    createApp(ChannelsDirectory, { channels }).mount(el);
  });
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
else boot();
```

- [ ] **Step 7: Register the Vite input**

In `hugo-apps/vite.config.ts` `rollupOptions.input`, add:

```ts
'channels-directory': resolve(__dirname, 'src/channels-directory/index.ts'),
```

- [ ] **Step 8: Write the Hugo section + layout**

`hugo/content/channels/_index.md`:

```markdown
---
title: "SAP Developer Channels"
description: "The portals, docs, repos, communities, and voices SAP developers use every day."
layout: "list"
---
```

`hugo/layouts/channels/list.html`:

```go-html-template
{{ define "main" }}
{{- $channels := (.Site.Data.channels.channels) | default slice -}}
<section class="channels-page">
  <header class="channels-page__intro">
    <h1>{{ .Title }}</h1>
    <p>{{ .Description }}</p>
  </header>
  <script id="channels-data" type="application/json">{{ $channels | jsonify }}</script>
  <div data-island="channels-directory"></div>
  <noscript>
    <ul>
      {{- range $channels }}
      <li><a href="{{ .url }}" target="_blank" rel="noopener">{{ .name }}</a> — {{ .purpose }}</li>
      {{- end }}
    </ul>
  </noscript>
</section>
<script type="module" src="{{ partial "island-src.html" "channels-directory" }}"></script>
{{ end }}
```

- [ ] **Step 9: Run the filter test again + build the islands**

Run: `npx vitest run --project unit hugo-apps/src/channels-directory/filter.test.ts && npm --prefix hugo-apps run build`
Expected: test PASS; Vite build emits `channels-directory-<hash>.js` into `hugo/static/js/`.

- [ ] **Step 10: Commit**

```bash
git add hugo/content/channels/_index.md hugo/layouts/channels/list.html hugo-apps/src/channels-directory/ hugo-apps/vite.config.ts
git commit -m "feat(channels): /channels directory page + Vue facet/search island"
```

---

### Task 6: Surface A — promote featured channels into `HomepageShelves`

**Files:**
- Create: `srv/lib/channels/promote-to-shelves.js`
- Create: `scripts/promote-channels-to-shelves.cjs`
- Modify: `package.json` (add `promote-channels` script)
- Test: `test/channels-promote.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.Channels` (Task 1), `com.sap.developers.ims.HomepageShelves` (`db/homepage.cds`).
- Produces: `promote-to-shelves.js` exports `mapChannelToShelf(channel) -> { verb, shelf } | null` and `promoteFeatured(db) -> { upserted, skipped }`. Upserts `HomepageShelves` on `(verb, url)` (honors `@assert.unique.verbUrl`). Community/third-party (`isSapOwned === false`) is never mapped to `START_HERE`.

- [ ] **Step 1: Write the failing mapping test**

```js
// test/channels-promote.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mapChannelToShelf, promoteFeatured } from '../srv/lib/channels/promote-to-shelves.js';

const project = cds.test('serve', '--project', '.', '--in-memory');
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('mapChannelToShelf', () => {
  it('maps an SAP learning portal to START_HERE/learn', () => {
    expect(mapChannelToShelf({ isSapOwned: true, category: 'Learning', focusAreas: ['onboarding'] }))
      .toEqual({ verb: 'learn', shelf: 'START_HERE' });
  });
  it('never puts a community channel in START_HERE', () => {
    const m = mapChannelToShelf({ isSapOwned: false, category: 'Learning', focusAreas: ['onboarding'] });
    expect(m?.shelf).not.toBe('START_HERE');
  });
  it('maps a GitHub repo to TOOLS', () => {
    expect(mapChannelToShelf({ isSapOwned: true, category: 'GitHub Repository', focusAreas: ['cap'] }).shelf).toBe('TOOLS');
  });
});

describe('promoteFeatured', () => {
  beforeAll(async () => {
    const { Channels } = linked();
    await INSERT.into(Channels).entries([
      { ID: cds.utils.uuid(), sourceId: 'promo-sap', name: 'CAP Docs', url: 'https://promo-cap', isSapOwned: true, isFeatured: true, isPublished: true, category: 'Portal', focusAreas: ['cap'] },
      { ID: cds.utils.uuid(), sourceId: 'promo-comm', name: 'Reddit', url: 'https://promo-reddit', isSapOwned: false, isFeatured: true, isPublished: true, category: 'Community', focusAreas: ['abap'] },
    ]);
  });
  afterAll(async () => {
    await DELETE.from(linked().Channels).where({ sourceId: { in: ['promo-sap', 'promo-comm'] } });
    await DELETE.from(linked().HomepageShelves).where({ url: { in: ['https://promo-cap', 'https://promo-reddit'] } });
  });

  it('upserts featured channels into HomepageShelves and is idempotent', async () => {
    const db = await cds.connect.to('db');
    const first = await promoteFeatured(db);
    expect(first.upserted).toBeGreaterThan(0);
    const second = await promoteFeatured(db);
    expect(second.upserted).toBe(0); // already present → skipped on second run
    const { HomepageShelves } = linked();
    const reddit = await SELECT.one.from(HomepageShelves).where({ url: 'https://promo-reddit' });
    expect(reddit.badge).toBe('THIRD_PARTY');
    expect(reddit.shelf).not.toBe('START_HERE');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/channels-promote.test.js`
Expected: FAIL — cannot resolve `../srv/lib/channels/promote-to-shelves.js`.

- [ ] **Step 3: Write `srv/lib/channels/promote-to-shelves.js`**

```js
'use strict';
const cds = require('@sap/cds');

// Deterministic category → shelf and focus → verb defaults (admin-overridable later).
const CATEGORY_TO_SHELF = {
  'Portal': 'REFERENCE', 'Documentation': 'REFERENCE', 'Docs': 'REFERENCE',
  'GitHub Repository': 'TOOLS', 'Package Registry': 'TOOLS', 'Tool': 'TOOLS',
  'YouTube': 'KEEP_CURRENT', 'Podcast': 'KEEP_CURRENT', 'Blog': 'KEEP_CURRENT', 'News': 'KEEP_CURRENT',
  'Learning': 'START_HERE', 'Community': 'REFERENCE',
};
const FOCUS_TO_VERB = [
  [['integration'], 'integrate'], [['ops', 'admin', 'operations'], 'operate'],
  [['ai', 'genai'], 'AI'], [['rap', 'data-model', 'cds'], 'model'],
  [['abap', 'cap', 'sdk', 'build'], 'build'], [['onboarding', 'tutorial', 'learn'], 'learn'],
];

function pickVerb(focusAreas = []) {
  const lower = focusAreas.map((f) => String(f).toLowerCase());
  for (const [keys, verb] of FOCUS_TO_VERB) if (keys.some((k) => lower.includes(k))) return verb;
  return 'build';
}

function mapChannelToShelf(channel) {
  let shelf = CATEGORY_TO_SHELF[channel.category] || 'REFERENCE';
  // community / third-party may never land in START_HERE
  if (shelf === 'START_HERE' && channel.isSapOwned !== true) shelf = 'REFERENCE';
  return { verb: pickVerb(channel.focusAreas), shelf };
}

async function promoteFeatured(db) {
  const linked = cds.linked(cds.model ?? (await cds.load('*')));
  const { Channels, HomepageShelves } = linked.entities('com.sap.developers.ims');
  const featured = await db.run(SELECT.from(Channels).where({ isFeatured: true, isPublished: true }));
  let upserted = 0, skipped = 0;
  for (const ch of featured) {
    const { verb, shelf } = mapChannelToShelf(ch);
    const existing = await db.run(SELECT.one.from(HomepageShelves).where({ verb, url: ch.url }));
    if (existing) { skipped++; continue; }
    await db.run(INSERT.into(HomepageShelves).entries({
      ID: cds.utils.uuid(), verb, shelf, url: ch.url, title: ch.name,
      description: ch.editorialNote || ch.purpose, whyItMatters: ch.editorialNote || null,
      isExternal: true, isActive: true, badge: ch.isSapOwned ? null : 'THIRD_PARTY',
      authoringStatus: 'AI_SEEDED', sortOrder: 500,
    }));
    upserted++;
  }
  return { upserted, skipped };
}

module.exports = { mapChannelToShelf, promoteFeatured, CATEGORY_TO_SHELF, FOCUS_TO_VERB };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/channels-promote.test.js`
Expected: PASS.

- [ ] **Step 5: Write the CLI wrapper `scripts/promote-channels-to-shelves.cjs`**

```js
'use strict';
const cds = require('@sap/cds');
const { promoteFeatured } = require('../srv/lib/channels/promote-to-shelves.js');

(async () => {
  await cds.load('*');
  const db = await cds.connect.to('db');
  const { upserted, skipped } = await promoteFeatured(db);
  console.log(`[promote-channels] upserted=${upserted} skipped=${skipped}`);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
```

- [ ] **Step 6: Add the package.json script entry**

```json
"promote-channels": "cds bind --exec -- node scripts/promote-channels-to-shelves.cjs"
```

- [ ] **Step 7: Commit**

```bash
git add srv/lib/channels/promote-to-shelves.js scripts/promote-channels-to-shelves.cjs package.json test/channels-promote.test.js
git commit -m "feat(channels): promote featured channels into HomepageShelves (verb-lane fill)"
```

---

### Task 7: Admin — `Channels` CRUD (service projection + Fiori Elements app + shell wiring)

**Files:**
- Modify: `srv/admin-service.cds` (add `Channels` projection)
- Create: `app/admin/channels/package.json`, `ui5.yaml`
- Create: `app/admin/channels/webapp/Component.js`, `webapp/manifest.json`, `webapp/i18n/i18n.properties`
- Modify: `app/admin-shell/webapp/manifest.json` (resourceRoot + componentUsage + route + target)
- Test: `test/admin-channels.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.Channels` (Task 1), `AdminService` (`@path:'/admin'`, `db/admin-service.cds`).
- Produces: `GET /admin/Channels` (admin-auth) list; draft-enabled ObjectPage for editing `isPublished`, `isFeatured`, `editorialNote`, `linkStatusOverride`.

- [ ] **Step 1: Write the failing admin-service test**

```js
// test/admin-channels.test.js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';

const project = cds.test('serve', '--project', '.', '--in-memory');
const adminAuth = { auth: { username: 'admin', password: 'admin' } };
const NS = 'com.sap.developers.ims';
const linked = () => cds.linked(cds.model).entities(NS);

describe('AdminService.Channels', () => {
  beforeAll(async () => {
    await INSERT.into(linked().Channels).entries({
      ID: cds.utils.uuid(), sourceId: 'admin-001', name: 'Admin Test', url: 'https://admin-test', isPublished: true,
    });
  });
  afterAll(async () => { await DELETE.from(linked().Channels).where({ sourceId: 'admin-001' }); });

  it('is exposed at /admin/Channels and requires admin auth', async () => {
    await expect(project.get('/admin/Channels')).rejects.toMatchObject({ response: { status: 401 } });
    const { status, data } = await project.get('/admin/Channels', adminAuth);
    expect(status).toBe(200);
    expect(data.value.some((c) => c.sourceId === 'admin-001')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/admin-channels.test.js`
Expected: FAIL — `/admin/Channels` 404/not found.

- [ ] **Step 3: Add the projection to `srv/admin-service.cds`**

Next to the `HomepageShelves` projection (~line 291):

```cds
@odata.draft.enabled
entity Channels as projection on ims.Channels;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/admin-channels.test.js`
Expected: PASS.

- [ ] **Step 5: Create the Fiori Elements app** (mirror `app/admin/homepage/`)

`app/admin/channels/webapp/Component.js`:

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.channels.Component", { metadata: { manifest: "json" } });
});
```

`app/admin/channels/webapp/manifest.json`:

```json
{
  "_version": "1.65.0",
  "sap.app": {
    "id": "sap.tutorials.admin.channels",
    "type": "application",
    "title": "Channels",
    "dataSources": {
      "mainService": { "uri": "/admin/", "type": "OData", "settings": { "odataVersion": "4.0" } }
    },
    "crossNavigation": { "inbounds": { "Channels-manage": { "semanticObject": "Channels", "action": "manage", "signature": { "parameters": {}, "additionalParameters": "allowed" } } } }
  },
  "sap.ui5": {
    "dependencies": { "libs": { "sap.fe.templates": {} } },
    "models": { "": { "dataSource": "mainService", "settings": { "operationMode": "Server", "autoExpandSelect": true, "earlyRequests": true } } },
    "routing": {
      "routes": [
        { "name": "ChannelsList", "pattern": ":?query:", "target": "ChannelsList" },
        { "name": "ChannelsObject", "pattern": "Channels({key}):?query:", "target": "ChannelsObject" }
      ],
      "targets": {
        "ChannelsList": { "type": "Component", "id": "ChannelsList", "name": "sap.fe.templates.ListReport", "options": { "settings": { "contextPath": "/Channels", "initialLoad": "Enabled" } } },
        "ChannelsObject": { "type": "Component", "id": "ChannelsObject", "name": "sap.fe.templates.ObjectPage", "options": { "settings": { "contextPath": "/Channels" } } }
      }
    }
  }
}
```

`app/admin/channels/webapp/i18n/i18n.properties`:

```properties
appTitle=Channels
appDescription=Curate external SAP developer channels
```

`app/admin/channels/package.json` and `ui5.yaml`: copy verbatim from `app/admin/homepage/` and rename `id`/`name` fields to `sap.tutorials.admin.channels`.

- [ ] **Step 6: Wire the app into the admin shell**

In `app/admin-shell/webapp/manifest.json`, add the four entries (mirror the `homepage` quartet):
- `sap.ui5.resourceRoots`: `"sap.tutorials.admin.channels": "./components/channels"`
- `sap.ui5.componentUsages`: `"channelsComponent": { "name": "sap.tutorials.admin.channels", "lazy": true }`
- `sap.ui5.routing.routes`: `{ "name": "channels", "pattern": "channels", "target": [{ "name": "channelsTarget", "prefix": "ch" }] }`
- `sap.ui5.routing.targets`: `"channelsTarget": { "type": "Component", "usage": "channelsComponent", "id": "channelsTarget", "viewLevel": 1, "prefix": "ch" }`

(If the shell uses `manifest.template.json` + `generate-manifest.js`, edit the template and re-run `npm --prefix app/admin-shell run build`.)

- [ ] **Step 7: Add a UI-nav entry** (if the shell has a side-nav list — mirror the `homepage` `sap.tnt.NavigationListItem`): add a "Channels" item pointing to the `channels` route. Locate via the existing `homepage`/`homepageShelves` nav item in the shell's `ToolPage` view/controller and add a sibling.

- [ ] **Step 8: Build the shell and verify no manifest error**

Run: `npm --prefix app/admin-shell run build`
Expected: build succeeds; `components/channels/` present in the shell output.

- [ ] **Step 9: Commit**

```bash
git add srv/admin-service.cds app/admin/channels/ app/admin-shell/webapp/manifest.json test/admin-channels.test.js
git commit -m "feat(channels): admin CRUD app + AdminService.Channels projection + shell wiring"
```

---

### Task 8: Full-suite gate + docs pointer

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` (or a new `docs/developers/reference/channels.md`) — one section documenting the channels subsystem
- Modify: `CLAUDE.md` (one Top-Gotchas bullet pointing to the doc)

- [ ] **Step 1: Run the full unit suite**

Run: `npm test`
Expected: all channels tests green; no pre-existing test regressed. If a pre-existing anon-write test breaks because of the new admin projection, update that test (service-guard rule).

- [ ] **Step 2: Compile-check the model one more time**

Run: `npx cds deploy --to sqlite::memory:`
Expected: exits 0.

- [ ] **Step 3: Write the reference doc section**

Document: the `Channels` entity + namespace/journal requirement; `seed-channels` re-ingest CLI (idempotent, preserves curated columns, retire-on-absence); `/build/channels` → `hugo/data/channels.json` → `/channels` directory island; `promote-channels` verb-lane fill (community never START_HERE); admin app location; that `fetch-channels` is wired into `build:all`.

- [ ] **Step 4: Add the CLAUDE.md gotcha bullet**

One bullet under Top Gotchas linking to the doc, e.g.:
`- **External channels subsystem** — `Channels` entity is the source of truth; re-ingest via `npm run seed-channels`; directory at `/channels`; verb-lane fill via `npm run promote-channels`. → channels.md.`

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(channels): document channels subsystem + gotcha pointer"
```

---

## Self-Review

**1. Spec coverage (P1 scope):**
- §5.1 `Channels` entity → Task 1 ✓
- §6 ingestion (clean/normalize/hash/idempotent upsert/preserve curated/retire) → Task 2 ✓
- §7 Surface A verb-lane fill (category→shelf, focus→verb, community-never-START_HERE, THIRD_PARTY badge) → Task 6 ✓
- §8 Surface B directory (facets: category/platform/SAP-vs-community, search) → Tasks 3–5 ✓
- §10 Tier-1 deterministic facets → Task 5 ✓ (Tier-2 editorial collections = P2, out of P1 scope)
- §13 admin (Channels app) → Task 7 ✓
- §14 link-health: P1 filters `BROKEN` in the feed (Task 3) + directory `noscript`/island; the nightly job *extension* to `Channels.url` is deferred to a follow-up (spec §14 reuses the existing job) — noted, not silently dropped.
- §9 Surface C, §5.2–5.4 collections/crosswalk/submissions → P2–P4, explicitly out of P1 scope.

**2. Placeholder scan:** No TBD/TODO; every code step has real code. Task 5 Step 8 and Task 7 Step 5 reference "copy verbatim from `app/admin/homepage/`" for boilerplate (`package.json`/`ui5.yaml`) — acceptable because those files are pure scaffolding with a single renamed id, and the exact rename is stated.

**3. Type consistency:** `normalizeChannel(raw, ingestBatch)` signature consistent across Tasks 2 tests + impl. `mapChannelToShelf`/`promoteFeatured` signatures consistent across Task 6 test + impl. Entity reflection via `cds.linked(...).entities('com.sap.developers.ims')` used identically in every task. `filterChannels(channels, state)` consistent across Task 5 test + impl + component. Feed shape `{ channels, buildAt }` consistent Task 3 → Task 4 → Task 5.

**Follow-up plans (not this plan):** P2 editorial `ChannelCollections`; P3 `ChannelTopicMap` crosswalk + per-topic bands; P4 `ChannelSubmissions` moderation loop. Each gets its own spec-derived plan.
