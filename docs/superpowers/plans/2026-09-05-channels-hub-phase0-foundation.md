# Channels Hub — Phase 0: Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `slug` and `feedUrl` nullable columns to `Channels`, generate the HANA migration, populate both fields in the normalize ingest layer, add normalize.cjs to the srv-qa cp-list, and run the re-ingest + ChannelTopicMap seeding sequence — producing the exact interfaces all later phases consume.

**Architecture:** Pure schema + ingest change. No new HTTP routes, no new Vue islands, no new Hugo content. The two new columns are nullable so deploy does not break any existing row or query. `slug` is produced by a kebab+dedup helper inside `normalize.cjs`; `feedUrl` is a direct passthrough from the raw dataset's `feed` field. The HANA migration is generated — never hand-authored — via `cds build --production`. The seeding sequence is operational (CLI commands), not automated code.

**Tech Stack:** CDS schema (`@sap/cds`), CommonJS module (`normalize.cjs`), vitest unit project (pure helper — no DB required for slug/feedUrl tests), `cds build --production` for HANA migration, `npx cds bind --exec` for re-ingest, `gh workflow run` for full content rebuild.

**Spec:** `docs/superpowers/specs/2026-09-05-channels-hub-design.md` (§ "Schema Migrations", § "Data Prerequisites", § "Global Constraints")

## Global Constraints

- Target branch is **DEV**; `main` is protected; open a PR, never direct-merge. No main-hotfix path.
- **No raw SQL** — `SELECT.from(...)` CQL / `cds.ql` only.
- Tutorial/channel slug comparisons are **lowercase-canonical** — `.toLowerCase()` before comparing.
- New columns need a `db/persistence.cds` `@cds.persistence.journal` entry AND `cds build --production` to emit the `.hdbmigrationtable` ALTER — **never hand-author the migration**.
- Run `npx cds deploy --to sqlite::memory:` after any `db/**/*.cds` edit to verify the model is well-formed before committing.
- `srv/lib` changes need a `srv-qa` cp-list audit — every new or modified file in `srv/lib/channels/` must appear in the `tutorials-srv-qa` `build-parameters.commands` cp chain in `.deploy/mta.yaml`.
- Re-ingest (`npm run seed-channels`) requires `cds bind` to a live HANA instance (`npx cds bind --exec -- node scripts/seed-channels.cjs ...`).
- Unit tests use `cds.test('serve', '--project', '.', '--in-memory')` and `cds.entities('com.sap.developers.ims')` — never bare `SELECT.from('X')`.
- `DB-flag boot-SEED` (`cds.on('served')`) also runs in `cds.test('serve')` — gate any seed call behind `!process.env.VITEST` if adding one; existing normalize helper tests in Task 1 need **no DB** (pure function tests only).

---

## File Structure

**Modify (4 files):**

- `db/channels.cds` — add `slug : String(200)` (unique, nullable) and `feedUrl : String(500)` (nullable) to the `Channels` entity.
- `db/persistence.cds` — `Channels` is already annotated with `@cds.persistence.journal` at line 54. **No new entry needed.** Confirmed before writing this plan.
- `srv/lib/channels/normalize.cjs` — add `toKebabSlug(name)`, `generateSlug(name, seenSlugs)` helpers; update `normalizeChannel(raw, ingestBatch, seenSlugs?)` to populate `slug` and `feedUrl`.
- `scripts/seed-channels.cjs` — thread a `seenSlugs` Set through the ingest loop so dedup works across the full batch.
- `.deploy/mta.yaml` — add `../../srv/lib/channels/normalize.cjs` to the `tutorials-srv-qa` cp command (currently absent — confirmed by grep before writing this plan).

**Create (1 file):**

- `test/unit/channels/normalize-slug.test.js` — pure unit tests for `toKebabSlug`, `generateSlug`, and the `slug`/`feedUrl` fields produced by `normalizeChannel`.

---

## Task 1: Schema — add slug + feedUrl columns to Channels

**Files:**
- Modify: `db/channels.cds` (after line 28, inside the `Channels` entity)
- Test: `npx cds deploy --to sqlite::memory:` (no vitest test for schema alone)

**Interfaces:**
- Consumes: existing `Channels` entity in `db/channels.cds`
- Produces:
  - `Channels.slug : String(200)` — nullable, unique constraint `@assert.unique.slugField: [slug]`
  - `Channels.feedUrl : String(500)` — nullable, no constraint

- [ ] **Step 1: Add the two columns to the Channels entity**

Open `db/channels.cds`. After line 28 (`subscribers : Integer;`) and before the blank line that precedes the curation block comment, insert:

```cds
  slug           : String(200);                // kebab-case of name; unique; populated at ingest
  feedUrl        : String(500);                // RSS/Atom feed URL from dataset; null when absent
```

The `@assert.unique` for slug: the existing pattern on `Channels` at line 13 is a named tuple annotation. Add a second tuple annotation on the entity for slug:

```cds
@assert.unique.sourceId: [sourceId]
@assert.unique.slugField: [slug]
entity Channels : cuid, managed {
```

After the edit, the top of the entity in `db/channels.cds` reads:

```cds
@assert.unique.sourceId: [sourceId]
@assert.unique.slugField: [slug]
entity Channels : cuid, managed {
  sourceId       : String(40)  @mandatory;
  name           : String(200) @mandatory;
  url            : String(500) @mandatory;
  relatedUrls    : array of String(500);
  aliases        : array of String(120);
  purpose        : String(1000);
  notes          : String(1000);
  ownerName      : String(120);
  ownerType      : ChannelOwnerType @assert.range;
  isSapOwned     : Boolean default false;
  category       : String(60);
  subcategory    : String(80);
  platform       : String(80);
  status         : ChannelStatus default 'Active' @assert.range;
  focusAreas     : array of String(60);
  tags           : array of String(40);
  updateFrequency: String(40);
  githubStars    : Integer;
  subscribers    : Integer;
  slug           : String(200);
  feedUrl        : String(500);

  // ── curation / lifecycle (admin-editable; absent from ingest so re-seed never wipes) ──
  isPublished        : Boolean default true;
  ...
```

- [ ] **Step 2: Confirm `db/persistence.cds` — no new entry needed**

Open `db/persistence.cds` and verify line 54 already reads:
```cds
annotate ims.Channels with @cds.persistence.journal;
```
It does (confirmed before writing this plan). No edit required.

- [ ] **Step 3: Verify the model compiles against in-memory SQLite**

```bash
npx cds deploy --to sqlite::memory:
```

Expected: exits 0, no errors. If you see `Cannot use array type in entity` or similar, re-check that you have not introduced a syntax error in the entity body.

- [ ] **Step 4: Commit the schema change**

```bash
git add db/channels.cds
git commit -m "feat(schema): add Channels.slug + feedUrl nullable columns"
```

---

## Task 2: Normalize — kebab+dedup helper + slug/feedUrl population

**Files:**
- Modify: `srv/lib/channels/normalize.cjs`
- Modify: `scripts/seed-channels.cjs`
- Create: `test/unit/channels/normalize-slug.test.js`

**Interfaces:**
- Consumes: `normalizeChannel(raw, ingestBatch)` from Task 0 (existing export in `normalize.cjs`)
- Produces (exact exports added to `normalize.cjs`):
  - `toKebabSlug(name: string) : string` — lowercase, non-alphanumeric runs → `-`, trim leading/trailing `-`
  - `generateSlug(name: string, seenSlugs?: Set<string>) : string` — calls `toKebabSlug`; if result is already in `seenSlugs`, appends `-2`, `-3`, … until unique; adds final slug to `seenSlugs`; safe to call with `seenSlugs=undefined` (no-dedup mode)
  - `normalizeChannel(raw, ingestBatch, seenSlugs?: Set<string>)` — existing signature extended with optional third arg; adds `slug` and `feedUrl` fields to the returned object; **does not** add them to `contentHash` source (they are not dataset-owned content fields — `feedUrl` IS from the dataset but the spec is silent on hash; treat it as content-owned like `url` — include it in the `source` object so hash changes when the feed URL changes in the raw data)

- [ ] **Step 1: Write the failing tests**

Create `test/unit/channels/normalize-slug.test.js`:

```javascript
// test/unit/channels/normalize-slug.test.js
// Pure unit tests — no DB, no cds.test(), pure function calls only.
import { describe, it, expect } from 'vitest';
import {
  toKebabSlug,
  generateSlug,
  normalizeChannel,
} from '../../../srv/lib/channels/normalize.cjs';

describe('toKebabSlug', () => {
  it('lowercases and replaces spaces with hyphens', () => {
    expect(toKebabSlug('SAP HANA Cloud')).toBe('sap-hana-cloud');
  });

  it('collapses multiple non-alphanumeric runs into a single hyphen', () => {
    expect(toKebabSlug('Coffee & Code — Weekly!')).toBe('coffee-code-weekly');
  });

  it('strips leading and trailing hyphens', () => {
    expect(toKebabSlug('  Hello World  ')).toBe('hello-world');
  });

  it('handles names that are purely punctuation → empty string', () => {
    expect(toKebabSlug('---')).toBe('');
  });

  it('preserves digits', () => {
    expect(toKebabSlug('UI5 2.0 Samples')).toBe('ui5-2-0-samples');
  });
});

describe('generateSlug', () => {
  it('returns the kebab slug when seenSlugs is empty', () => {
    const seen = new Set();
    expect(generateSlug('SAP HANA Cloud', seen)).toBe('sap-hana-cloud');
    expect(seen.has('sap-hana-cloud')).toBe(true);
  });

  it('appends -2 on first collision, -3 on second', () => {
    const seen = new Set(['sap-hana-cloud']);
    expect(generateSlug('SAP HANA Cloud', seen)).toBe('sap-hana-cloud-2');
    seen.add('sap-hana-cloud-2');
    expect(generateSlug('SAP HANA Cloud', seen)).toBe('sap-hana-cloud-3');
  });

  it('skips the suffix entirely when seenSlugs is undefined (no-dedup mode)', () => {
    // Used when normalizing a single channel in isolation (e.g., unit tests
    // that don't care about dedup). Must not throw.
    expect(generateSlug('My Channel', undefined)).toBe('my-channel');
  });

  it('does not mutate seen for no-dedup mode', () => {
    // Just ensures no crash when seen is undefined
    expect(() => generateSlug('X', undefined)).not.toThrow();
  });
});

describe('normalizeChannel — slug + feedUrl fields', () => {
  const BASE_RAW = {
    id: 'portal-001',
    name: 'SAP Developers',
    url: 'https://developers.sap.com',
    related_urls: [],
    aliases: [],
    purpose: null,
    notes: null,
    owner_type: null,
    isSapOwned: true,
    category: 'Official',
    subcategory: null,
    platform: 'Web',
    status: 'Active',
    focus_areas: [],
    tags: [],
    update_frequency: null,
    github_stars: null,
    subscribers: null,
  };

  it('populates slug from name when no seenSlugs provided', () => {
    const row = normalizeChannel(BASE_RAW, '2026-09');
    expect(row.slug).toBe('sap-developers');
  });

  it('populates slug with dedup suffix when name collides', () => {
    const seen = new Set(['sap-developers']);
    const row = normalizeChannel(BASE_RAW, '2026-09', seen);
    expect(row.slug).toBe('sap-developers-2');
  });

  it('feedUrl is null when raw.feed is absent', () => {
    const row = normalizeChannel(BASE_RAW, '2026-09');
    expect(row.feedUrl).toBeNull();
  });

  it('feedUrl is populated from raw.feed when present', () => {
    const raw = { ...BASE_RAW, feed: 'https://developers.sap.com/feed.xml' };
    const row = normalizeChannel(raw, '2026-09');
    expect(row.feedUrl).toBe('https://developers.sap.com/feed.xml');
  });

  it('contentHash changes when feedUrl changes (feedUrl is content-owned)', () => {
    const row1 = normalizeChannel(BASE_RAW, '2026-09');
    const raw2 = { ...BASE_RAW, feed: 'https://example.com/feed.xml' };
    const row2 = normalizeChannel(raw2, '2026-09');
    expect(row1.contentHash).not.toBe(row2.contentHash);
  });

  it('slug is NOT included in contentHash (re-ingest must not re-hash on dedup suffix change)', () => {
    const seen1 = new Set();
    const seen2 = new Set(['sap-developers']); // causes suffix
    const row1 = normalizeChannel(BASE_RAW, '2026-09', seen1);
    const row2 = normalizeChannel(BASE_RAW, '2026-09', seen2);
    expect(row1.contentHash).toBe(row2.contentHash);
  });
});
```

- [ ] **Step 2: Run the failing tests**

```bash
npx vitest run test/unit/channels/normalize-slug.test.js --project unit
```

Expected: FAIL — `toKebabSlug` / `generateSlug` not exported from `normalize.cjs`; `normalizeChannel` does not populate `slug` or `feedUrl`.

- [ ] **Step 3: Implement helpers and update normalizeChannel**

Open `srv/lib/channels/normalize.cjs`. After the `computeContentHash` function and before `normalizeChannel`, add:

```javascript
// Converts a channel name to a kebab-case URL slug.
// Lowercases, collapses all non-alphanumeric runs to a single '-', trims ends.
function toKebabSlug(name) {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Returns a unique kebab slug. Appends -2, -3, … on collision.
// When seenSlugs is undefined (single-channel mode), dedup is skipped.
function generateSlug(name, seenSlugs) {
  const base = toKebabSlug(name);
  if (!seenSlugs || !seenSlugs.has(base)) {
    if (seenSlugs) seenSlugs.add(base);
    return base;
  }
  let n = 2;
  while (seenSlugs.has(`${base}-${n}`)) n++;
  const slug = `${base}-${n}`;
  seenSlugs.add(slug);
  return slug;
}
```

Update `normalizeChannel` to accept `seenSlugs` and include `slug` and `feedUrl`:

Replace the existing `normalizeChannel` function (lines 62–85 in the current file) with:

```javascript
function normalizeChannel(raw, ingestBatch, seenSlugs) {
  const { status, note } = normalizeStatus(raw.status);
  const purpose = cleanCitations(raw.purpose);
  const notesParts = [cleanCitations(raw.notes), note].filter(Boolean);
  const feedUrl = raw.feed ? String(raw.feed).trim() : null;
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
    githubStars: parseApproxCount(raw.github_stars),
    subscribers: parseApproxCount(raw.subscribers),
    feedUrl,
  };
  // slug is generated from name — not part of the content hash (dedup suffix must
  // not trigger a content-hash mismatch on re-ingest of an unchanged record).
  const slug = generateSlug(raw.name, seenSlugs);
  return { sourceId: raw.id, ...source, contentHash: computeContentHash(source), ingestBatch, slug };
}
```

Update the `module.exports` line to export the new helpers:

```javascript
module.exports = {
  cleanCitations, normalizeOwnerType, normalizeStatus, parseApproxCount,
  computeContentHash, toKebabSlug, generateSlug, normalizeChannel,
};
```

- [ ] **Step 4: Run tests and verify they pass**

```bash
npx vitest run test/unit/channels/normalize-slug.test.js --project unit
```

Expected: all tests PASS.

- [ ] **Step 5: Update seed-channels.cjs to thread seenSlugs through the batch**

Open `scripts/seed-channels.cjs`. In the `main()` function, add a `seenSlugs` Set before the ingest loop and pass it to `normalizeChannel`:

Locate the line:
```javascript
  for (const raw of rawChannels) {
    const row = normalizeChannel(raw, batch);
```

Replace with:
```javascript
  // Pre-populate seenSlugs with slugs already in the DB so incremental
  // re-ingests don't collide with rows not in this batch.
  const existingAll = await SELECT.from(Channels).columns('sourceId', 'slug');
  const seenSlugs = new Set(existingAll.map((r) => r.slug).filter(Boolean));

  for (const raw of rawChannels) {
    const row = normalizeChannel(raw, batch, seenSlugs);
```

The `UPDATE` block already strips curated fields. `slug` is NOT in `CURATED` (it is ingest-owned, like `sourceId`). No further change to the update path is needed — `slug` will be re-computed from `name` on every ingest run, which is idempotent for unchanged names.

- [ ] **Step 6: Verify in-memory SQLite deploy still passes after normalize edit**

```bash
npx cds deploy --to sqlite::memory:
```

Expected: exits 0.

- [ ] **Step 7: Commit normalize + seed-channels changes**

```bash
git add srv/lib/channels/normalize.cjs scripts/seed-channels.cjs test/unit/channels/normalize-slug.test.js
git commit -m "feat(ingest): add slug+feedUrl fields to Channels normalize + seed loop"
```

---

## Task 3: srv-qa cp-list audit — add normalize.cjs to mta.yaml

**Files:**
- Modify: `.deploy/mta.yaml`

**Interfaces:**
- Consumes: `normalize.cjs` path `../../srv/lib/channels/normalize.cjs` (relative to `gen/srv-qa`)
- Produces: `normalize.cjs` available in the `tutorials-srv-qa` runtime bundle so `seed-channel-topic-map.cjs` (which lazy-imports from the same `srv/lib/channels/` directory) can resolve it at boot.

**Context:** The `tutorials-srv-qa` module in `.deploy/mta.yaml` has a custom `build-parameters.commands` block that contains a long `bash -c "mkdir -p ... && cp ... srv/lib/"` chain. `normalize.cjs` is currently absent from this chain (confirmed by grep before writing this plan). Any `srv/lib/channels/` file used by QA runtime code must be in this list.

- [ ] **Step 1: Confirm normalize.cjs is absent from the cp chain**

```bash
grep -c "normalize.cjs" .deploy/mta.yaml
```

Expected: `0` — the file is not yet listed.

- [ ] **Step 2: Add normalize.cjs to the cp chain in mta.yaml**

The `bash -c "..."` command in `tutorials-srv-qa`'s `build-parameters.commands` at line 175 ends with a long sequence of `cp ../../srv/lib/<file> srv/lib/` commands followed by a `mkdir -p srv/lib/channels &&` section (if it exists) or immediately before the closing `"`. Locate where `image-store.cjs` and `attachment-ingest.cjs` are copied (near the end of the chain — these are the most recently added `.cjs` entries). After the last `../../srv/lib/*.cjs` copy, append:

```
&& mkdir -p srv/lib/channels && cp ../../srv/lib/channels/normalize.cjs srv/lib/channels/
```

The exact insertion point is in the single-line `bash -c "..."` string. Find the segment containing:
```
../../srv/lib/attachment-source-handler.js ../../srv/lib/attachment-ingest-handler.js
```

After the `contributors-publish.js ../../srv/lib/validation-rules-publish.js ../../srv/lib/island-manifest.json srv/lib/` segment (which is the last `srv/lib/` batch copy), and before `&& mkdir -p srv/lib/feature-flags`, insert:

```
&& mkdir -p srv/lib/channels && cp ../../srv/lib/channels/normalize.cjs srv/lib/channels/
```

- [ ] **Step 3: Verify the yaml is still valid YAML**

```bash
yq eval '.' .deploy/mta.yaml > /dev/null && echo "YAML OK"
```

Expected: `YAML OK` with no errors.

- [ ] **Step 4: Confirm normalize.cjs now appears in the cp chain**

```bash
grep -c "normalize.cjs" .deploy/mta.yaml
```

Expected: `1`.

- [ ] **Step 5: Commit the mta.yaml srv-qa cp-list update**

```bash
git add .deploy/mta.yaml
git commit -m "chore(deploy): add channels/normalize.cjs to srv-qa cp-list"
```

---

## Task 4: HANA migration — emit .hdbmigrationtable ALTER via cds build --production

**Files:**
- Read + commit any generated files under `db/src/gen/` (or `gen/db/` depending on build config)

**Interfaces:**
- Consumes: `db/channels.cds` with `slug` and `feedUrl` columns from Task 1; `db/persistence.cds` with existing `@cds.persistence.journal` on `Channels`
- Produces: an `.hdbmigrationtable` file in the CDS build output for `CHANNELS` that contains `ALTER TABLE ADD` statements for `SLUG` and `FEEDURL` — this is the artifact that HANA's HDI container applies on next deploy.

**Warning:** Never hand-author the `.hdbmigrationtable` file. The `cds build --production` command generates it. Committing the generated artifact is correct and required — HDI uses the version counter embedded in the file.

- [ ] **Step 1: Run cds build --production**

```bash
npx cds build --production
```

Expected: exits 0. The build writes artifacts under `gen/db/src/gen/` (or the path configured in `.cdsrc.json` / `package.json` `cds.build`).

- [ ] **Step 2: Locate the updated CHANNELS migration artifact**

```bash
fd "CHANNELS.hdbmigrationtable" gen/
```

Expected: one file path, e.g. `gen/db/src/gen/CHANNELS.hdbmigrationtable`.

- [ ] **Step 3: Verify the ALTER statements are present**

```bash
grep -i "SLUG\|FEEDURL" $(fd "CHANNELS.hdbmigrationtable" gen/)
```

Expected: lines containing `ADD (SLUG NVARCHAR(200))` and `ADD (FEEDURL NVARCHAR(500))` (HANA column type names; exact casing may vary).

If you see neither, the `Channels` entity does not have `@cds.persistence.journal` applied. Recheck `db/persistence.cds` line 54.

- [ ] **Step 4: Verify the version counter incremented**

```bash
grep "^== Version:" $(fd "CHANNELS.hdbmigrationtable" gen/)
```

Expected: a version number higher than the previous generation. The tool manages this automatically.

- [ ] **Step 5: Commit the updated migration artifact**

```bash
git add gen/
git commit -m "chore(migration): regenerate CHANNELS hdbmigrationtable for slug + feedUrl columns"
```

---

## Task 5 (Operational): Re-ingest channels + ChannelTopicMap seeding sequence

This task is operational (CLI + admin UI) rather than code. It must be executed against a live HANA instance after Tasks 1–4 are deployed to DEV. The task documents the exact commands and expected outputs.

**Prerequisites:**
- Tasks 1–4 are deployed to DEV (`cf deploy` with the updated MTAR — including the CHANNELS migration).
- `cds bind` is set up against the DEV HANA service instance (`npm run bind:setup` if not already done in this worktree).
- The raw dataset JSON file is available locally (e.g. `d:/tmp/External-SAP-Channels-Complete.json`).

**Interfaces:**
- Consumes: deployed `Channels` table with `SLUG` and `FEEDURL` columns; `seed-channels.cjs` updated in Task 2; `seed-channel-topic-map.cjs` from existing `srv/lib/channels/` (no changes in Phase 0)
- Produces:
  - All `Channels` rows updated with `slug` (kebab, dedup-suffixed) and `feedUrl` (null or feed URL)
  - `ChannelTopicMap` rows land as `authoringStatus = 'AI_SEEDED'`
  - After admin review + full rebuild: `ChannelTopicMap` rows promoted to `REVIEWED`, topic BLOBs re-rendered with `relatedChannels` populated

**Step-by-step:**

- [ ] **Step 1: Dry-run re-ingest to preview slug + feedUrl population**

```bash
npx cds bind --exec -- node scripts/seed-channels.cjs \
  --file d:/tmp/External-SAP-Channels-Complete.json
```

(Omitting `--commit` runs in dry-run mode.)

Expected output pattern:
```
[seed-channels] batch=2026-09-05 DRY-RUN inserted=0 updated=<N> skipped=<M> retired=0
```

All existing rows should show as `updated` (slug + feedUrl are new content-owned fields; contentHash will change for every row that gains a `feedUrl`). `skipped=0` for any row with a feed URL in the dataset.

- [ ] **Step 2: Commit the re-ingest**

```bash
npx cds bind --exec -- node scripts/seed-channels.cjs \
  --file d:/tmp/External-SAP-Channels-Complete.json \
  --commit
```

Expected: same summary with `COMMIT` instead of `DRY-RUN`. Verify `updated` and `inserted` counts match dry-run.

- [ ] **Step 3: Spot-check slug population in HANA**

```bash
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
(async () => {
  const db = await cds.connect.to('db');
  await cds.load('*');
  const { Channels } = cds.entities('com.sap.developers.ims');
  const rows = await db.run(SELECT.from(Channels).columns('sourceId','name','slug','feedUrl').limit(5));
  console.table(rows);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
"
```

Expected: 5 rows each with a non-null `slug` value matching the kebab of `name`.

- [ ] **Step 4: Dry-run ChannelTopicMap seed (size the review burden)**

```bash
npx cds bind --exec -- node scripts/seed-channel-topic-map.cjs
```

Expected output:
```
[seed-channel-topic-map] commit=false { created: <N>, updatedDraft: 0, skippedReviewed: 0 }
[seed-channel-topic-map] dry run — pass --commit to write. Drafts land as AI_SEEDED; review in /admin-ui/#channelTopicMap.
```

Note `created` count — that is the review burden. Typical: 100–500 rows for a ~150-channel corpus with ~30 topic tags. Record the count as a comment in the PR description.

- [ ] **Step 5: Commit ChannelTopicMap rows as AI_SEEDED**

```bash
npx cds bind --exec -- node scripts/seed-channel-topic-map.cjs --commit
```

Expected: same count with `commit=true`.

- [ ] **Step 6: Admin review at /admin-ui/#channelTopicMap**

Open the DEV admin UI at `/admin-ui/#channelTopicMap`. Filter by `authoringStatus = AI_SEEDED`. Review each row; promote acceptable rows to `REVIEWED` by editing `authoringStatus`. Reject (delete) rows that are wrong.

Minimum viable: at least one `REVIEWED` row per major topic so the topic-band test in Task 1 of Phase 1 (Surface C) fires with real data.

- [ ] **Step 7: Full content rebuild to bake relatedChannels into topic BLOBs**

```bash
gh workflow run rebuild-content.yml \
  --repo sap-tutorials/tutorials-ims \
  --ref main \
  -f mode=full
```

Wait ~10 min. Verify `/topics/<any-reviewed-tag-slug>/` renders the `relatedChannels` band.

---

## Self-Review

### 1. Spec coverage

| Spec requirement | Task |
|---|---|
| `Channels.slug : String(200)` nullable, unique | Task 1 |
| `Channels.feedUrl : String(500)` nullable | Task 1 |
| `db/persistence.cds` journal entry for Channels | Task 1 (confirmed existing — no new entry needed) |
| `cds build --production` migration (never hand-authored) | Task 4 |
| `normalize.cjs` kebab+dedup helper | Task 2 |
| `normalizeChannel` populates slug + feedUrl | Task 2 |
| `srv-qa` cp-list audit for normalize.cjs | Task 3 |
| Re-ingest via `npm run seed-channels` with cds bind | Task 5 Step 1–3 |
| ChannelTopicMap seeding sequence (dry-run → commit → review → rebuild) | Task 5 Steps 4–7 |
| Locked interface: `Channels.slug : String(200)` (nullable, unique) | Task 1 |
| Locked interface: `Channels.feedUrl : String(500)` (nullable) | Task 1 |
| Locked interface: namespace `com.sap.developers.ims` | Task 2 tests |
| Locked interface: `topicTag = titlePathToMdFormat(tag.titlePath)` | Task 5 Step 4 (existing seeder uses this) |
| Locked interface: `ChannelTopicMap` lands `AI_SEEDED`, consumers filter `REVIEWED` | Task 5 Step 4 |

All spec requirements for Phase 0 are covered.

### 2. Placeholder scan

No "TBD", "TODO", "implement later", or "add appropriate" phrases found. All code blocks are concrete. Test file is fully written out.

### 3. Type consistency

- `toKebabSlug` defined and exported in Task 2 Step 3; used by `generateSlug` in same step; test imports it in Task 2 Step 1. Consistent.
- `generateSlug` defined and exported in Task 2 Step 3; used in updated `normalizeChannel` in same step; test imports it in Task 2 Step 1. Consistent.
- `normalizeChannel(raw, ingestBatch, seenSlugs?)` signature updated in Task 2 Step 3; `seed-channels.cjs` update in Task 2 Step 5 passes `seenSlugs` as third arg. Consistent.
- `Channels.slug` added in Task 1; referenced in `normalizeChannel` return value in Task 2; queried in Task 5 spot-check. Consistent.
- `Channels.feedUrl` added in Task 1; populated in `normalizeChannel` in Task 2; queried in Task 5 spot-check. Consistent.
- `authoringStatus = 'AI_SEEDED'` / `'REVIEWED'` — matches existing `AuthoringStatus` enum in `db/homepage.cds` (used by `ChannelTopicMap` via import). Consistent with existing seeder in `seed-channel-topic-map.cjs`.
