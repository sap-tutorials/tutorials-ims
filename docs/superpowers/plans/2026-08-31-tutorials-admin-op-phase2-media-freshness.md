# Tutorials Admin OP — Phase 2 (Media + Freshness Header) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface per-tutorial object-store items (images + assets) with rich detail and a download/preview link, and add a Freshness report facet (last-run/model/cost/status) to the Tutorials Object Page.

**Architecture:** `TutorialImages`/`TutorialAssets` are persisted but exposed on no service. Add `@readonly` projections on `AdminService` reachable from `Tutorials` via slug/channel associations; the `content : Composition of many Attachments` child auto-exposes with `@cap-js/attachments` media annotations (`@Core.MediaType`/`@Core.ContentDisposition`/`@UI.MediaResource`) so Fiori renders a native download link. Persist `byteSize` at image/asset ingest (already in memory as `buffer.length`). `FreshnessReport` is already exposed — add an association from `Tutorials` and a sorted LineItem facet.

**Tech Stack:** SAP CAP (Node.js, CDS), `@cap-js/attachments` 4.0.0, Fiori Elements annotations, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-31-tutorials-admin-op-enhancements-design.md` (§WS5, decisions D1/D2)

## Global Constraints

- **D1 (prod S3 binding):** the Media facet works regardless of backing store; the missing `objectstore` resource in `mta.yaml` is a **separate ops task**, out of scope here. Do not add the S3 binding in this plan.
- **D2:** add `byteSize : Integer64`; **defer** width/height.
- **Read-only exposure** — projections are `@readonly`; use `@cds.redirection.target: false` (pattern at `srv/admin-service.cds:114,120`) to avoid stealing association redirects.
- **BLOB reads stay raw `db.run()`** — never mix LOB + metadata in one CDS QL query.
- **Schema changes** — `cds build --production`; register in `db/persistence.cds`; `npx cds deploy --to sqlite::memory:` before committing.
- **Associations on `slug`** — `TutorialImages`/`TutorialAssets` join `Tutorials` on `slug` (unmanaged `on`), filtered `channel = 'prod'`.
- **Tests:** `npm test` (unit), `npm run test:hybrid` (real HANA). PR targets DEV.

## File Structure

- Modify: `db/tutorial-images.cds`, `db/tutorial-assets.cds` — add `byteSize`.
- Modify: `db/persistence.cds` — journal (if needed for new column).
- Modify: `srv/lib/image-ingest-handler.js` (~`:77`) + the asset ingest handler — persist `byteSize`.
- Modify: `srv/admin-service.cds` — `@readonly` projections + `images`/`assets`/`freshnessReports` associations on `Tutorials`.
- Modify: `app/admin-annotations.cds` — Media facet (2 LineItems w/ download link + external sourceUrl) + Freshness Reports facet.
- Test: `test/unit/schema-media.test.js`, `test/unit/annotations-media.test.js`, `test/unit/annotations-freshness-facet.test.js`, `test/hybrid/media-exposure.test.js`.

---

### Task 1: Schema — add `byteSize` to images + assets

**Files:**
- Modify: `db/tutorial-images.cds:7-16`, `db/tutorial-assets.cds:6-16`
- Modify: `db/persistence.cds`
- Test: `test/unit/schema-media.test.js`

**Interfaces:**
- Produces: `TutorialImages.byteSize : Integer64`, `TutorialAssets.byteSize : Integer64`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/schema-media.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('media byteSize', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('images + assets have byteSize', () => {
    expect(m.definitions['com.sap.developers.ims.TutorialImages'].elements.byteSize).toBeTruthy()
    expect(m.definitions['com.sap.developers.ims.TutorialAssets'].elements.byteSize).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run test/unit/schema-media.test.js --project unit` → FAIL.

- [ ] **Step 3: Add the column** (both files):

```cds
byteSize : Integer64;  // original byte length captured at ingest
```

Register in `db/persistence.cds` if the column needs a migration-table entry (follow existing shape).

- [ ] **Step 4: Verify + deploy dry-run** — test PASS; `npx cds deploy --to sqlite::memory:` clean.
- [ ] **Step 5: Build + commit**

```bash
npx cds build --production
git add db/tutorial-images.cds db/tutorial-assets.cds db/persistence.cds db/src/gen test/unit/schema-media.test.js
git commit -m "feat(db): add byteSize to TutorialImages/TutorialAssets (#WS5)"
```

### Task 2: Persist `byteSize` at ingest

**Files:**
- Modify: `srv/lib/image-ingest-handler.js` (~`:60-77`, where `contentHash`/`mimeType` are computed and `imageStore.put` is called)
- Modify: the asset ingest handler (per research: `srv/lib/attachment-source-handler.js:118` region / the asset ingest analog — confirm exact put call)
- Modify: `srv/lib/image-store.cjs` + `srv/lib/attachment-store.cjs` — accept/persist `byteSize` on the parent row
- Test: `test/unit/ingest-bytesize.test.js`

**Interfaces:**
- Consumes: `buffer` at ingest.
- Produces: parent `TutorialImages`/`TutorialAssets` row carries `byteSize = buffer.length`.

- [ ] **Step 1: Write the failing test** (unit-level against the store put, in-memory SQLite)

```js
// test/unit/ingest-bytesize.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
const store = require('../../srv/lib/image-store.cjs')

describe('image store persists byteSize', () => {
  beforeAll(async () => { await cds.test('serve', '--in-memory').in(process.cwd()) })
  it('stores buffer length as byteSize', async () => {
    const db = await cds.connect.to('db')
    const buf = Buffer.from('hello world')
    await store.put('https://raw.example/img.png', { buffer: buf, mimeType: 'image/png', contentHash: 'abc', slug: 'demo', channel: 'prod', byteSize: buf.length })
    const { TutorialImages } = cds.entities('com.sap.developers.ims')
    const row = await db.run(SELECT.one.from(TutorialImages).where({ sourceUrl: 'https://raw.example/img.png' }))
    expect(row.byteSize).toBe(11)
  })
})
```

> Confirm `image-store.cjs` `put()` signature + how it writes the parent row before finalizing the test; adapt arg shape to the real API.

- [ ] **Step 2: Run to verify it fails** — → FAIL (byteSize null/undefined).

- [ ] **Step 3: Implement**

In `srv/lib/image-ingest-handler.js`, pass `byteSize: buffer.length` into the `imageStore.put(...)` options (~`:77`). In `srv/lib/image-store.cjs`, include `byteSize` in the parent-row INSERT/UPSERT. Mirror both for assets (`attachment-store.cjs` + the asset ingest handler).

- [ ] **Step 4: Run to verify it passes** — → PASS.
- [ ] **Step 5: Commit**

```bash
git add srv/lib/image-ingest-handler.js srv/lib/image-store.cjs srv/lib/attachment-store.cjs test/unit/ingest-bytesize.test.js
git commit -m "feat(media): persist byteSize at image/asset ingest (#WS5)"
```

> If the asset ingest handler lives in a distinct file, add it to this commit and to the srv-qa cp-list if not already present.

### Task 3: Expose read-only Media projections + associations

**Files:**
- Modify: `srv/admin-service.cds`
- Test: `test/unit/media-exposure.test.js`

**Interfaces:**
- Produces: `AdminService.TutorialImages`, `AdminService.TutorialAssets` (`@readonly`); `Tutorials.images`, `Tutorials.assets` associations (join on `slug`, `channel='prod'`).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/media-exposure.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('media exposure', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('exposes images + assets read-only', () => {
    expect(m.definitions['AdminService.TutorialImages']).toBeTruthy()
    expect(m.definitions['AdminService.TutorialAssets']).toBeTruthy()
  })
  it('Tutorials has images + assets associations', () => {
    const t = m.definitions['AdminService.Tutorials'].elements
    expect(t.images).toBeTruthy()
    expect(t.assets).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run to verify it fails** — → FAIL.

- [ ] **Step 3: Implement**

In `srv/admin-service.cds`:

```cds
@readonly @cds.redirection.target: false entity TutorialImages as projection on ims.TutorialImages;
@readonly @cds.redirection.target: false entity TutorialAssets as projection on ims.TutorialAssets;
```

Add to the `Tutorials` projection body:

```cds
images : Association to many TutorialImages on images.slug = $self.slug and images.channel = 'prod';
assets : Association to many TutorialAssets on assets.slug = $self.slug and assets.channel = 'prod';
```

> The `content` Attachments composition auto-exposes when reachable from an exposed entity (@cap-js/attachments relies on this).

- [ ] **Step 4: Run to verify it passes** — test PASS; `npx cds deploy --to sqlite::memory:` clean.
- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds test/unit/media-exposure.test.js
git commit -m "feat(admin): read-only Media projections + Tutorials associations (#WS5)"
```

### Task 4: UI — Media facet with download link + detail

**Files:**
- Modify: `app/admin-annotations.cds`
- Test: `test/unit/annotations-media.test.js`

**Interfaces:**
- Consumes: `AdminService.TutorialImages/TutorialAssets` + their `content` media child.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/annotations-media.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('Media facet', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('OP facets include Media', () => {
    const ids = m.definitions['AdminService.Tutorials']['@UI.Facets'].map((f) => f.ID)
    expect(ids).toContain('MediaImagesFacet')
    expect(ids).toContain('MediaAssetsFacet')
  })
  it('image LineItem shows sourceUrl + byteSize + mimeType', () => {
    const li = m.definitions['AdminService.TutorialImages']['@UI.LineItem']
    const vals = li.map((x) => x.Value?.['='] || x.Value)
    for (const c of ['sourceUrl','byteSize','mimeType','contentHash']) expect(vals).toContain(c)
  })
})
```

- [ ] **Step 2: Run to verify it fails** — → FAIL.

- [ ] **Step 3: Implement**

In `app/admin-annotations.cds`, add LineItems (render `sourceUrl` as external link via `DataFieldWithUrl`; the media download comes from the auto-exposed `content` child's ready-made annotations — a nested facet on `content` gives the download link):

```cds
annotate AdminService.TutorialImages with @(
  UI.LineItem: [
    { $Type: 'UI.DataFieldWithUrl', Value: sourceUrl, Url: sourceUrl, Label: 'Source (GitHub)' },
    { Value: mimeType,   Label: 'Type' },
    { Value: byteSize,   Label: 'Bytes' },
    { Value: contentHash, Label: 'Hash' },
    { Value: channel,    Label: 'Channel' }
  ]
);
annotate AdminService.TutorialAssets with @(
  UI.LineItem: [
    { Value: filename,   Label: 'File' },
    { $Type: 'UI.DataFieldWithUrl', Value: sourceUrl, Url: sourceUrl, Label: 'Source (GitHub)' },
    { Value: mimeType,   Label: 'Type' },
    { Value: byteSize,   Label: 'Bytes' },
    { Value: contentHash, Label: 'Hash' }
  ]
);
```

Add facets to the winning `@UI.Facets` block:

```cds
{ $Type: 'UI.ReferenceFacet', Label: 'Images', ID: 'MediaImagesFacet', Target: 'images/@UI.LineItem' },
{ $Type: 'UI.ReferenceFacet', Label: 'Assets', ID: 'MediaAssetsFacet', Target: 'assets/@UI.LineItem' },
```

> The @cap-js/attachments `content` child ships its own `@UI.LineItem` with a media download link. To surface a clickable download/preview, optionally add a nested facet targeting `images/content/@UI.LineItem` once verified against the running FE version.

- [ ] **Step 4: Run to verify it passes** — → PASS; `npx cds deploy --to sqlite::memory:` clean.
- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds test/unit/annotations-media.test.js
git commit -m "feat(admin-ui): Media facets (images/assets) with source link + byte size (#WS5)"
```

### Task 5: Freshness Reports facet (header)

**Files:**
- Modify: `srv/admin-service.cds` — add `freshnessReports` association on `Tutorials`
- Modify: `app/admin-annotations.cds` — LineItem + facet, sorted by `runAt` desc via `@UI.PresentationVariant`
- Test: `test/unit/annotations-freshness-facet.test.js`

**Interfaces:**
- Consumes: `AdminService.FreshnessReport` (already exposed `srv/admin-service.cds:129`).
- Produces: `Tutorials.freshnessReports` association + `FreshnessReportsFacet`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/annotations-freshness-facet.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('Freshness reports facet', () => {
  let m; beforeAll(async () => { m = await cds.load('*') })
  it('Tutorials has freshnessReports association', () => {
    expect(m.definitions['AdminService.Tutorials'].elements.freshnessReports).toBeTruthy()
  })
  it('OP facets include FreshnessReportsFacet', () => {
    const ids = m.definitions['AdminService.Tutorials']['@UI.Facets'].map((f) => f.ID)
    expect(ids).toContain('FreshnessReportsFacet')
  })
})
```

- [ ] **Step 2: Run to verify it fails** — → FAIL.

- [ ] **Step 3: Implement**

In `srv/admin-service.cds` `Tutorials` projection:

```cds
freshnessReports : Association to many FreshnessReport on freshnessReports.tutorial = $self;
```

In `app/admin-annotations.cds`:

```cds
annotate AdminService.FreshnessReport with @(
  UI.LineItem: [
    { Value: runAt,         Label: 'Run At' },
    { Value: status,        Label: 'Status' },
    { Value: model,         Label: 'Model' },
    { Value: cost,          Label: 'Cost' },
    { Value: openHighCount, Label: 'Open High' },
    { Value: error,         Label: 'Error' }
  ],
  UI.PresentationVariant: { SortOrder: [{ Property: runAt, Descending: true }], Visualizations: ['@UI.LineItem'] }
);
```

Add to `@UI.Facets` (place above the existing Freshness findings facet):

```cds
{ $Type: 'UI.ReferenceFacet', Label: 'Freshness Reports', ID: 'FreshnessReportsFacet', Target: 'freshnessReports/@UI.PresentationVariant' },
```

- [ ] **Step 4: Run to verify it passes** — → PASS; `npx cds deploy --to sqlite::memory:` clean.
- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds app/admin-annotations.cds test/unit/annotations-freshness-facet.test.js
git commit -m "feat(admin-ui): Freshness Reports facet (runAt/model/cost/status) (#WS5)"
```

### Task 6: Hybrid guard — media exposure resolves

**Files:**
- Test: `test/hybrid/media-exposure.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
// test/hybrid/media-exposure.test.js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
describe('media exposure (hybrid)', () => {
  let admin; beforeAll(async () => { admin = await cds.connect.to('AdminService') })
  it('reads images for a tutorial without LOB errors', async () => {
    const t = await admin.run(SELECT.one.from('AdminService.Tutorials').columns('ID','slug'))
    expect(t).toBeTruthy()
    // metadata-only read (no BLOB mix)
    const imgs = await admin.run(SELECT.from('AdminService.TutorialImages').columns('ID','sourceUrl','mimeType','byteSize').where({ slug: t.slug }))
    expect(Array.isArray(imgs)).toBe(true)
  })
})
```

- [ ] **Step 2: Run** `npm run test:hybrid -- test/hybrid/media-exposure.test.js` → PASS.
- [ ] **Step 3: Commit**

```bash
git add test/hybrid/media-exposure.test.js
git commit -m "test(media): hybrid guard for media exposure (#WS5)"
```

---

## Final verification

- [ ] `npm test` all green; `npx cds deploy --to sqlite::memory:` clean.
- [ ] Backfill media if needed: `npm run backfill-images` (+ assets) against the env so rows exist.
- [ ] DEV post-deploy: reference tutorial OP shows Images + Assets tables (source link, type, bytes, hash) and a Freshness Reports table sorted newest-first.

## Self-review notes

- **Spec coverage:** WS5 §Media (Tasks 1-4, 6) + §Freshness header (Task 5). D1 respected (no S3 binding change). D2 respected (byteSize yes, dimensions no).
- **Verify against live code:** `image-store.cjs`/`attachment-store.cjs` `put()` signatures (Task 2); the asset ingest handler path; FE `DataFieldWithUrl` + media-child download idiom for the current FE version (Task 4).
