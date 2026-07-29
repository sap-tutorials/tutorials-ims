# Devtoberfest Configurable Banner + Overlaid CTA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins upload a per-event banner image in the Devtoberfest Object Page (stored in HANA), served to the public homepage as a hero image with the "Join the Fest" CTA overlaid lower-right; falls back to today's gradient header when no banner is set.

**Architecture:** Mirror the Developer Advocates photo-upload pattern exactly — a 1:1 `DevtoberfestBanner` composition under the draft-enabled `DevtoberfestConfig`, written via a base64 `uploadBanner` bound action (FE UploadSet drops bytes on draft compositions), processed with `sharp` into a single wide WebP, served from HANA via an anonymous REST route with ETag/caching. The Vue island reads a new `bannerUrl` off `/status` and renders image + overlay CTA, reflowing below the banner under 720px.

**Tech Stack:** CAP Node.js (ESM), `@sap/cds`, `sharp`, HANA (LargeBinary BLOB), Fiori Elements V4 (draft), Vue 3 + Vite island, SAP approuter.

## Global Constraints

- ESM only — project `package.json` is `"type": "module"`; use `import`, not `require`.
- Never SELECT a HANA BLOB alongside metadata in one CDS QL query — LOB locator expires. Use raw `db.run()` with two calls on HANA; plain CDS QL is fine on SQLite (unit tests). (`srv/lib/advocate-photo-store.js:100-168` precedent.)
- HANA raw-SQL identifiers are UPPERCASE-unquoted (e.g. `COM_SAP_DEVELOPERS_IMS_DEVTOBERFESTBANNER`, `CONFIG_ID`).
- Schema change → run `npx cds build --production` to regenerate the `hdbmigrationtable` version bump; NEVER hand-edit the `.hdbmigrationtable` ALTER. Run `npx cds deploy --to sqlite::memory:` before committing any `db/**/*.cds`.
- Banner is optional at every layer — no active config / no banner must no-op gracefully (island reverts to gradient header), never 500.
- Full deploy required (schema + admin UI bundle-gated + srv + approuter). Admin-UI change needs full `mbt build` — NO `--skip-build`, NO `-m` scoping. Deploy is a later, separate step — NOT part of these tasks.
- PR, not direct merge to main.
- Work happens in worktree `devtoberfest-banner-upload` on branch `worktree-devtoberfest-banner-upload`.

---

### Task 1: Data model — DevtoberfestBanner entity + config fields

**Files:**
- Modify: `db/devtoberfest.cds` (add fields to `DevtoberfestConfig` entity at lines 27-37; add new `DevtoberfestBanner` entity after it)

**Interfaces:**
- Produces: entity `com.sap.developers.ims.DevtoberfestBanner` with key `config : Association to DevtoberfestConfig`, and columns `image` (LargeBinary MediaType), `mimeType`, `sizeBytes`, `sha256`, `width`, `height`, `uploadedAt`. `DevtoberfestConfig` gains `hasBanner : Boolean`, `bannerUpdatedAt : Timestamp`, and `banner : Composition of one DevtoberfestBanner`.

- [ ] **Step 1: Add banner fields + entity to the CDS model**

In `db/devtoberfest.cds`, inside the `DevtoberfestConfig` entity body (after `activitiesUrl : String(500);`, before the closing `}`), add:

```cds
  hasBanner         : Boolean default false;
  bannerUpdatedAt   : Timestamp;
  banner            : Composition of one DevtoberfestBanner on banner.config = $self;
```

Then add this new entity immediately after the `DevtoberfestConfig` closing brace (before the `EventRegistrations` doc comment):

```cds
/**
 * Per-config hero banner image (the SAP TechEd key visual for that
 * Devtoberfest edition). 1:1 composition: the association IS the key,
 * so exactly one banner row exists per config. Mirrors AdvocatePhotos
 * (db/advocates.cds). Bytes are a single wide WebP rendition produced by
 * the sharp pipeline in srv/lib/devtoberfest-banner-store.js. Served
 * publicly (anonymous) via GET /api/devtoberfest/banner for the active row.
 */
entity DevtoberfestBanner {
  key config    : Association to DevtoberfestConfig not null;
  image         : LargeBinary @Core.MediaType: mimeType;
  mimeType      : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes     : Integer;
  sha256        : String(64);
  width         : Integer;
  height        : Integer;
  uploadedAt    : Timestamp;
}
```

- [ ] **Step 2: Verify the model compiles + deploys to in-memory SQLite**

Run: `cd .claude/worktrees/devtoberfest-banner-upload && npx cds deploy --to sqlite::memory: 2>&1 | tail -20`
Expected: no compile errors; ends cleanly (no `Error:` lines). This confirms the association-as-key and MediaType annotations parse.

- [ ] **Step 3: Regenerate the HANA migration table**

Run: `npx cds build --production 2>&1 | tail -20`
Expected: build succeeds; `git status` shows a modified/new `db/src/*DEVTOBERFESTCONFIG*.hdbmigrationtable` (version-counter bump) and a new `db/src/*DEVTOBERFESTBANNER*.hdbtable`. Do NOT hand-edit these.

- [ ] **Step 4: Commit**

```bash
git add db/devtoberfest.cds db/src/ gen/ db/last-dev/ 2>/dev/null; git add -A db/
git commit -m "feat(devtoberfest): add DevtoberfestBanner entity + config banner fields"
```

---

### Task 2: Banner store — sharp pipeline + upsert helper

**Files:**
- Create: `srv/lib/devtoberfest-banner-store.js`
- Test: `srv/lib/__tests__/devtoberfest-banner-store.test.js`

**Interfaces:**
- Consumes: `com.sap.developers.ims.DevtoberfestBanner` + `DevtoberfestConfig` (Task 1); `sharp`, `node:crypto`.
- Produces:
  - `processBannerUpload(buffer: Buffer, mimeType: string) → Promise<{ image: Buffer, mimeType: 'image/webp', sha256: string, sizeBytes: number, width: number, height: number }>` — validates + resizes to max-width 2000 WebP.
  - `uploadAndUpsertBanner({ configID: string, buffer: Buffer, mimeType: string }) → Promise<{ sizeBytes, sha256, width, height }>` — runs the pipeline, upserts the banner row by `config_ID`, flips `DevtoberfestConfig.hasBanner=true` + `bannerUpdatedAt`.
  - `fetchBanner(configID: string) → Promise<{ buffer: Buffer, mimeType: string, etag: string } | null>` — reads bytes (raw SQL on HANA, CDS QL on SQLite).

- [ ] **Step 1: Write the failing test**

Create `srv/lib/__tests__/devtoberfest-banner-store.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { processBannerUpload } from '../devtoberfest-banner-store.js';

// Build a real 3000x1000 PNG so the resize has something to shrink.
async function makeWidePng() {
  return sharp({
    create: { width: 3000, height: 1000, channels: 3, background: { r: 20, g: 30, b: 120 } },
  }).png().toBuffer();
}

describe('processBannerUpload', () => {
  it('resizes a wide image to max-width 2000 WebP and reports dimensions', async () => {
    const src = await makeWidePng();
    const out = await processBannerUpload(src, 'image/png');
    expect(out.mimeType).toBe('image/webp');
    expect(out.width).toBe(2000);
    expect(out.height).toBe(667); // 1000 * (2000/3000) rounded
    expect(out.sizeBytes).toBe(out.image.length);
    expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
    // WebP magic: bytes 8-11 are 'WEBP'
    expect(out.image.slice(8, 12).toString('ascii')).toBe('WEBP');
  });

  it('does not upscale an already-small image', async () => {
    const small = await sharp({
      create: { width: 800, height: 300, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).png().toBuffer();
    const out = await processBannerUpload(small, 'image/png');
    expect(out.width).toBe(800);
    expect(out.height).toBe(300);
  });

  it('rejects an unsupported MIME type', async () => {
    await expect(processBannerUpload(Buffer.from('x'), 'application/pdf'))
      .rejects.toThrow(/unsupported MIME/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/lib/__tests__/devtoberfest-banner-store.test.js`
Expected: FAIL — `Cannot find module '../devtoberfest-banner-store.js'`.

- [ ] **Step 3: Write the implementation**

Create `srv/lib/devtoberfest-banner-store.js`:

```javascript
// ESM module. Sharp pipeline + upsert + read for the Devtoberfest banner.
// Mirrors srv/lib/advocate-photo-store.js + advocate-photo-upsert.js, but
// produces a SINGLE wide WebP rendition (max-width 2000) instead of 256/64
// squares — a hero banner, not an avatar.

import cds from '@sap/cds';
import sharp from 'sharp';
import crypto from 'node:crypto';

const MAX_BYTES = 8 * 1024 * 1024; // raw upload cap (banner is larger than an avatar)
const MAX_WIDTH = 2000;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);

/** Coerce Buffer | Uint8Array | Readable | string into a Buffer. */
export async function toBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value && typeof value.pipe === 'function') {
    const chunks = [];
    for await (const chunk of value) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (typeof value === 'string') return Buffer.from(value);
  throw new Error('toBuffer: unsupported value type');
}

export async function processBannerUpload(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('processBannerUpload: buffer is required');
  if (buffer.length > MAX_BYTES) throw new Error('processBannerUpload: image too large (max 8 MB)');
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new Error('processBannerUpload: unsupported MIME type');
  }

  let meta;
  try {
    meta = await sharp(buffer).metadata();
  } catch {
    throw new Error('processBannerUpload: invalid image bytes');
  }
  if (!meta || !meta.format) throw new Error('processBannerUpload: invalid image bytes');

  // Resize to max-width 2000 without upscaling; height auto to preserve ratio.
  const image = await sharp(buffer)
    .resize({ width: MAX_WIDTH, withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();

  const outMeta = await sharp(image).metadata();
  const sha256 = crypto.createHash('sha256').update(image).digest('hex');

  return {
    image,
    mimeType: 'image/webp',
    sha256,
    sizeBytes: image.length,
    width: outMeta.width,
    height: outMeta.height,
  };
}

/**
 * Run the pipeline + upsert the DevtoberfestBanner row + flip config flags.
 * @returns {Promise<{ sizeBytes:number, sha256:string, width:number, height:number }>}
 */
export async function uploadAndUpsertBanner({ configID, buffer, mimeType }) {
  if (!configID) throw new Error('uploadAndUpsertBanner: configID is required');
  if (!Buffer.isBuffer(buffer)) throw new Error('uploadAndUpsertBanner: buffer is required');

  const processed = await processBannerUpload(buffer, mimeType || 'image/png');
  const db = await cds.connect.to('db');
  const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
  const now = new Date().toISOString();

  const existing = await db.run(
    SELECT.one.from(DevtoberfestBanner).columns('config_ID').where({ config_ID: configID }),
  );
  const entry = {
    image: processed.image,
    mimeType: processed.mimeType,
    sizeBytes: processed.sizeBytes,
    sha256: processed.sha256,
    width: processed.width,
    height: processed.height,
    uploadedAt: now,
  };
  if (existing) {
    await db.run(UPDATE(DevtoberfestBanner).set(entry).where({ config_ID: configID }));
  } else {
    await db.run(INSERT.into(DevtoberfestBanner).entries({ config_ID: configID, ...entry }));
  }

  await db.run(
    UPDATE(DevtoberfestConfig).set({ hasBanner: true, bannerUpdatedAt: now }).where({ ID: configID }),
  );

  return {
    sizeBytes: processed.sizeBytes,
    sha256: processed.sha256,
    width: processed.width,
    height: processed.height,
  };
}

/**
 * Read a config's banner bytes. Returns null when the config has no banner.
 * HANA: two raw db.run() calls (LOB locator rule). SQLite: plain CDS QL.
 */
export async function fetchBanner(configID) {
  if (!configID) return null;
  const db = await cds.connect.to('db');
  const isHana = (db.kind || '').toLowerCase() === 'hana';

  let row;
  if (isHana) {
    const res = await db.run(
      'SELECT IMAGE AS "image", MIMETYPE AS "mimeType", SHA256 AS "sha256" ' +
      'FROM COM_SAP_DEVELOPERS_IMS_DEVTOBERFESTBANNER WHERE CONFIG_ID = ?',
      [configID],
    );
    if (!res || !res.length || !res[0].image) return null;
    row = res[0];
  } else {
    const { DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    const b = await db.run(
      SELECT.one.from(DevtoberfestBanner).columns('image', 'mimeType', 'sha256').where({ config_ID: configID }),
    );
    if (!b || !b.image) return null;
    row = b;
  }

  return {
    buffer: await toBuffer(row.image),
    mimeType: row.mimeType || 'image/webp',
    etag: '"' + row.sha256 + '"',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/lib/__tests__/devtoberfest-banner-store.test.js`
Expected: PASS (3 tests). If the height assertion is off by one due to rounding, adjust the expected value to the actual `sharp` output.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/devtoberfest-banner-store.js srv/lib/__tests__/devtoberfest-banner-store.test.js
git commit -m "feat(devtoberfest): banner sharp pipeline + upsert + fetch store"
```

---

### Task 3: Admin service — projection, bound actions, handlers

**Files:**
- Modify: `srv/admin-service.cds` (add `uploadBanner`/`clearBanner` actions to the `DevtoberfestConfig` projection at line 456; expose `DevtoberfestBanner` projection near line 869)
- Create: `srv/handlers/devtoberfest-banner-handlers.js`
- Modify: `srv/admin-service.js` (import + register the new handlers next to `advocateHandlers.register(this)` at line 922)
- Test: `srv/handlers/__tests__/devtoberfest-banner-handlers.test.js`

**Interfaces:**
- Consumes: `uploadAndUpsertBanner`, `fetchBanner` (Task 2).
- Produces: bound actions `AdminService.DevtoberfestConfig.uploadBanner(imageBase64, mimeType)` and `.clearBanner()`; a `register(srv)` export wiring `srv.on('uploadBanner'/'clearBanner', DevtoberfestConfig, ...)`.

- [ ] **Step 1: Add the actions + projection to the CDS service**

In `srv/admin-service.cds`, change the `DevtoberfestConfig` projection (currently `entity DevtoberfestConfig as projection on ims.DevtoberfestConfig;` at line 456) to a block form with actions:

```cds
  entity DevtoberfestConfig as projection on ims.DevtoberfestConfig actions {
    // Base64-over-OData upload (FE UploadSet drops bytes on draft compositions —
    // same reason as Advocates.uploadPhoto). sharp → single wide WebP → upsert
    // DevtoberfestBanner → flip hasBanner. See srv/handlers/devtoberfest-banner-handlers.js.
    action uploadBanner(imageBase64 : String, mimeType : String) returns DevtoberfestConfig;
    action clearBanner() returns DevtoberfestConfig;
  };
```

And expose the banner entity projection (near the `AdvocatePhotos` projection at line 869):

```cds
  entity DevtoberfestBanner as projection on ims.DevtoberfestBanner;
```

The existing `@cds.server.body_parser.limit: '8mb'` (line 19) already covers the banner base64 payload — no change needed.

- [ ] **Step 2: Write the failing test**

Create `srv/handlers/__tests__/devtoberfest-banner-handlers.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const root = path.resolve(fileURLToPath(import.meta.url), '../../../..');

describe('DevtoberfestConfig uploadBanner / clearBanner', () => {
  let admin;
  beforeAll(async () => {
    cds.root = root;
    await cds.test(root); // boots in-memory SQLite from the project model
    admin = await cds.connect.to('AdminService');
  });

  async function makeBase64Png() {
    const buf = await sharp({
      create: { width: 3000, height: 1000, channels: 3, background: { r: 10, g: 20, b: 90 } },
    }).png().toBuffer();
    return buf.toString('base64');
  }

  it('uploadBanner processes bytes, stores a banner, flips hasBanner', async () => {
    const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await INSERT.into(DevtoberfestConfig).entries({ ID, termsVersion: 1 });

    await admin.send({
      event: 'uploadBanner',
      entity: 'DevtoberfestConfig',
      params: { ID },
      data: { imageBase64: await makeBase64Png(), mimeType: 'image/png' },
    });

    const cfg = await SELECT.one.from(DevtoberfestConfig).columns('hasBanner').where({ ID });
    expect(cfg.hasBanner).toBe(true);
    const banner = await SELECT.one.from(DevtoberfestBanner)
      .columns('width', 'sizeBytes', 'mimeType').where({ config_ID: ID });
    expect(banner.width).toBe(2000);
    expect(banner.mimeType).toBe('image/webp');
    expect(banner.sizeBytes).toBeGreaterThan(0);
  });

  it('clearBanner removes the row and flips hasBanner=false', async () => {
    const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    const ID = cds.utils.uuid();
    await INSERT.into(DevtoberfestConfig).entries({ ID, termsVersion: 1 });
    await admin.send({
      event: 'uploadBanner', entity: 'DevtoberfestConfig', params: { ID },
      data: { imageBase64: await makeBase64Png(), mimeType: 'image/png' },
    });

    await admin.send({ event: 'clearBanner', entity: 'DevtoberfestConfig', params: { ID }, data: {} });

    const cfg = await SELECT.one.from(DevtoberfestConfig).columns('hasBanner').where({ ID });
    expect(cfg.hasBanner).toBe(false);
    const banner = await SELECT.one.from(DevtoberfestBanner).where({ config_ID: ID });
    expect(banner).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run srv/handlers/__tests__/devtoberfest-banner-handlers.test.js`
Expected: FAIL — action not handled / `uploadBanner` rejects (no `on` handler registered yet).

- [ ] **Step 4: Write the handler module**

Create `srv/handlers/devtoberfest-banner-handlers.js`:

```javascript
// Bound-action handlers for the Devtoberfest banner, registered onto
// AdminService.init(). Mirrors srv/handlers/advocate-handlers.js uploadPhoto/
// clearPhoto. The base64-over-OData path exists because a Fiori UploadSet on
// a draft-enabled `Composition of one` (key = parent association) silently
// drops uploaded bytes on activation.

import cds from '@sap/cds';
import { uploadAndUpsertBanner } from '../lib/devtoberfest-banner-store.js';

export function register(srv) {
  const { DevtoberfestConfig } = srv.entities;

  srv.on('uploadBanner', DevtoberfestConfig, async (req) => {
    const configID = req.params?.[0]?.ID || req.params?.[0];
    if (!configID) return req.error(400, 'uploadBanner: missing config key in path');

    const { imageBase64, mimeType } = req.data || {};
    if (!imageBase64 || typeof imageBase64 !== 'string') {
      return req.error(400, 'uploadBanner: imageBase64 (string) is required');
    }
    let buffer;
    try {
      const cleaned = imageBase64.replace(/^data:[^,]+,/, '');
      buffer = Buffer.from(cleaned, 'base64');
    } catch {
      return req.error(400, 'uploadBanner: imageBase64 must be valid base64');
    }
    try {
      await uploadAndUpsertBanner({ configID, buffer, mimeType: mimeType || 'image/png' });
    } catch (e) {
      return req.error(400, 'uploadBanner: ' + e.message);
    }
    return SELECT.one.from(DevtoberfestConfig).where({ ID: configID });
  });

  srv.on('clearBanner', DevtoberfestConfig, async (req) => {
    const configID = req.params?.[0]?.ID || req.params?.[0];
    if (!configID) return req.error(400, 'clearBanner: missing config key in path');

    const db = await cds.connect.to('db');
    const { DevtoberfestBanner, DevtoberfestConfig: Cfg } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(DevtoberfestBanner).where({ config_ID: configID }));
    await db.run(
      UPDATE(Cfg).set({ hasBanner: false, bannerUpdatedAt: null }).where({ ID: configID }),
    );
    return SELECT.one.from(Cfg).where({ ID: configID });
  });
}
```

- [ ] **Step 5: Register the handlers in AdminService.init()**

In `srv/admin-service.js`, add the import near the other handler imports (next to line 14 `import * as advocateHandlers from './handlers/advocate-handlers.js';`):

```javascript
import * as devtoberfestBannerHandlers from './handlers/devtoberfest-banner-handlers.js';
```

Then register it right after `advocateHandlers.register(this);` (line 922):

```javascript
    devtoberfestBannerHandlers.register(this);
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run srv/handlers/__tests__/devtoberfest-banner-handlers.test.js`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js srv/handlers/devtoberfest-banner-handlers.js srv/handlers/__tests__/devtoberfest-banner-handlers.test.js
git commit -m "feat(devtoberfest): uploadBanner/clearBanner bound actions + handlers"
```

---

### Task 4: Admin UI — Object Page upload facet + version bump

**Files:**
- Modify: `app/admin-annotations.cds` (annotate `AdminService.DevtoberfestBanner` for the UploadSet + add a Banner facet to `DevtoberfestConfig` UI, near lines 2394-2410 for the AdvocatePhotos precedent and 2801-2820 for the config Facets)
- Modify: `app/admin/devtoberfest/webapp/manifest.json` (bump `applicationVersion.version` to bust the UI5 IndexedDB fragment cache)

**Interfaces:**
- Consumes: `AdminService.DevtoberfestBanner` projection + `uploadBanner`/`clearBanner` actions (Task 3).
- Produces: an "Event Banner" facet on the Devtoberfest Object Page exposing image upload.

- [ ] **Step 1: Annotate DevtoberfestBanner for the UploadSet**

In `app/admin-annotations.cds`, after the existing `AdvocatePhotos` annotation block (ends ~line 2411), add (mirrors that block):

```cds
// DevtoberfestBanner — FE renders an UploadSet for the @Core.MediaType
// `image` column when it's a LineItem in the composition's FieldGroup.
annotate AdminService.DevtoberfestBanner with {
  image  @Common.Label: 'Banner Image'  @Core.ContentDisposition: { Filename: 'devtoberfest-banner.webp' };
};

annotate AdminService.DevtoberfestBanner with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: image, Label: 'Banner Image' }
  ]
);
```

Then add a Banner facet to the `DevtoberfestConfig` UI Facets array (line 2801-2805 block). Change the `Facets: [ ... ]` to include:

```cds
    { $Type: 'UI.ReferenceFacet', Target: 'banner/@UI.LineItem', Label: 'Event Banner' }
```

(append as the last entry in the existing `Facets` array).

- [ ] **Step 2: Bump the admin app version to bust the fragment cache**

In `app/admin/devtoberfest/webapp/manifest.json`, change `"applicationVersion": { "version": "0.0.3" }` to `"0.0.4"`. (Admin UI5 fragment/view changes don't take effect post-deploy until the `ui5-cachemanager-db` IndexedDB entry busts; bumping the version auto-busts it.)

- [ ] **Step 3: Validate the manifest**

Run the manifest validation on `app/admin/devtoberfest/webapp/manifest.json` (via the UI5 MCP `run_manifest_validation` tool with the absolute path).
Expected: no new errors.

- [ ] **Step 4: Compile the CDS to confirm annotations resolve**

Run: `npx cds compile srv/admin-service.cds 2>&1 | tail -20`
Expected: no `Error:` lines; `banner/@UI.LineItem` and the `DevtoberfestBanner` projection resolve.

- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds app/admin/devtoberfest/webapp/manifest.json
git commit -m "feat(devtoberfest): admin Object Page banner upload facet + version bump"
```

---

### Task 5: Public route — GET /api/devtoberfest/banner + status.bannerUrl

**Files:**
- Modify: `srv/routes/devtoberfest-public.js` (add `bannerUrl` to `statusHandler` response; add `bannerHandler` + register `/api/devtoberfest/banner`)
- Test: `srv/routes/__tests__/devtoberfest-banner-route.test.js`

**Interfaces:**
- Consumes: `fetchBanner` (Task 2); active `DevtoberfestConfig` row.
- Produces: `GET /api/devtoberfest/banner` (anonymous) serving WebP bytes with ETag/`Cache-Control: public, max-age=86400`; `statusHandler` JSON gains `bannerUrl: string` (`'/api/devtoberfest/banner'` when the active config has a banner, else `''`).

- [ ] **Step 1: Write the failing test**

Create `srv/routes/__tests__/devtoberfest-banner-route.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { bannerHandler, statusHandler } from '../devtoberfest-public.js';

const root = path.resolve(fileURLToPath(import.meta.url), '../../../..');

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: undefined, ended: false,
    status(c) { this.statusCode = c; return this; },
    setHeader(k, v) { this.headers[k] = v; },
    json(o) { this.body = o; return this; },
    send(b) { this.body = b; return this; },
    end() { this.ended = true; return this; },
  };
}

describe('GET /api/devtoberfest/banner', () => {
  beforeAll(async () => { cds.root = root; await cds.test(root); });

  it('404s when the active config has no banner', async () => {
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    await DELETE.from(DevtoberfestConfig);
    await INSERT.into(DevtoberfestConfig).entries({ ID: cds.utils.uuid(), isActive: true, termsVersion: 1 });
    const res = mockRes();
    await bannerHandler({ headers: {} }, res);
    expect(res.statusCode).toBe(404);
  });

  it('serves WebP bytes + ETag when the active config has a banner', async () => {
    const { DevtoberfestConfig, DevtoberfestBanner } = cds.entities('com.sap.developers.ims');
    await DELETE.from(DevtoberfestConfig);
    const ID = cds.utils.uuid();
    await INSERT.into(DevtoberfestConfig).entries({ ID, isActive: true, hasBanner: true, termsVersion: 1 });
    const image = await sharp({ create: { width: 100, height: 40, channels: 3, background: { r: 1, g: 2, b: 3 } } })
      .webp().toBuffer();
    await INSERT.into(DevtoberfestBanner).entries({
      config_ID: ID, image, mimeType: 'image/webp', sizeBytes: image.length,
      sha256: 'deadbeef', width: 100, height: 40, uploadedAt: new Date().toISOString(),
    });
    const res = mockRes();
    await bannerHandler({ headers: {} }, res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['Content-Type']).toBe('image/webp');
    expect(res.headers['ETag']).toBe('"deadbeef"');
    expect(Buffer.isBuffer(res.body)).toBe(true);
  });

  it('status includes bannerUrl reflecting hasBanner', async () => {
    const { DevtoberfestConfig, Events } = cds.entities('com.sap.developers.ims');
    await DELETE.from(DevtoberfestConfig);
    const evID = cds.utils.uuid();
    await INSERT.into(Events).entries({ ID: evID, name: 'Devtoberfest', startDate: '2026-09-21', endDate: '2026-10-18' });
    await INSERT.into(DevtoberfestConfig).entries({
      ID: cds.utils.uuid(), isActive: true, hasBanner: true, termsVersion: 1, currentEvent_ID: evID,
    });
    const res = mockRes();
    await statusHandler({ headers: {} }, res);
    expect(res.body.bannerUrl).toBe('/api/devtoberfest/banner');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run srv/routes/__tests__/devtoberfest-banner-route.test.js`
Expected: FAIL — `bannerHandler` is not exported / `bannerUrl` undefined.

- [ ] **Step 3: Implement the route + status field**

In `srv/routes/devtoberfest-public.js`:

Add the import at the top (after the existing imports):

```javascript
import { fetchBanner } from '../lib/devtoberfest-banner-store.js';
```

In `statusHandler`, add `bannerUrl` to the returned JSON (in the `res.status(200).json({...})` object):

```javascript
      bannerUrl: config.hasBanner ? '/api/devtoberfest/banner' : '',
```

Add a new handler (after `termsHandler`):

```javascript
async function bannerHandler(req, res) {
  try {
    await cds.connect.to('db');
    const { DevtoberfestConfig } = cds.entities('com.sap.developers.ims');
    const config = await SELECT.one.from(DevtoberfestConfig).columns('ID', 'hasBanner').where({ isActive: true });
    if (!config?.hasBanner) return res.status(404).end();

    const out = await fetchBanner(config.ID);
    if (!out) return res.status(404).end();

    res.setHeader('ETag', out.etag);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    if (req.headers['if-none-match'] === out.etag) return res.status(304).end();
    res.setHeader('Content-Type', out.mimeType);
    return res.send(out.buffer);
  } catch (err) {
    LOG.error('GET /api/devtoberfest/banner failed:', err);
    return res.status(500).end();
  }
}
```

In `register(app)`, add the route (after the `terms` line):

```javascript
  app.get('/api/devtoberfest/banner', bannerHandler);
```

And extend the `export { ... }` at the bottom to include `bannerHandler`:

```javascript
export { statusHandler, termsHandler, bannerHandler };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run srv/routes/__tests__/devtoberfest-banner-route.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/routes/devtoberfest-public.js srv/routes/__tests__/devtoberfest-banner-route.test.js
git commit -m "feat(devtoberfest): public banner route + status.bannerUrl"
```

---

### Task 6: Approuter — anonymous allowlist for the banner route

**Files:**
- Modify: `approuter/xs-app.json` (extend the anonymous Devtoberfest route at line 123)

**Interfaces:**
- Consumes: `/api/devtoberfest/banner` (Task 5).
- Produces: anonymous reachability of the banner route through the approuter, ahead of the XSUAA `^/api/(.*)$` catch-all.

- [ ] **Step 1: Widen the anonymous route pattern**

In `approuter/xs-app.json`, change the route source at line 123 from:

```json
      "source": "^/api/devtoberfest/(status|terms)$",
      "target": "/api/devtoberfest/$1",
```

to:

```json
      "source": "^/api/devtoberfest/(status|terms|banner)$",
      "target": "/api/devtoberfest/$1",
```

Leave the `authenticationType: "none"` and destination unchanged.

- [ ] **Step 2: Verify the JSON parses**

Run: `cat approuter/xs-app.json | jq '.routes[] | select(.source | test("devtoberfest"))'`
Expected: valid JSON output; the banner alternative appears in the `status|terms|banner` route.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(devtoberfest): allow anonymous /api/devtoberfest/banner in approuter"
```

---

### Task 7: Vue island — image banner + overlay CTA + fallback

**Files:**
- Modify: `hugo-apps/src/devtoberfest/types.ts` (add `bannerUrl` to `StatusResponse`)
- Modify: `hugo-apps/src/devtoberfest/DevtoberfestHome.vue` (conditional image banner + overlay CTA)
- Modify: `hugo-apps/src/devtoberfest/styles.css` (banner img + overlay + 720px reflow)
- Test: `hugo-apps/src/devtoberfest/__tests__/DevtoberfestHome.banner.test.ts`

**Interfaces:**
- Consumes: `StatusResponse.bannerUrl` (Task 5 JSON contract).
- Produces: banner-vs-gradient rendering keyed on `bannerUrl`; CTA overlay class hooks.

- [ ] **Step 1: Add bannerUrl to the type**

In `hugo-apps/src/devtoberfest/types.ts`, add to the `StatusResponse` interface:

```typescript
  bannerUrl: string
```

- [ ] **Step 2: Write the failing test**

Create `hugo-apps/src/devtoberfest/__tests__/DevtoberfestHome.banner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import DevtoberfestHome from '../DevtoberfestHome.vue'

const CONFIG = {
  apiStatus: '/api/devtoberfest/status', apiTerms: '/api/devtoberfest/terms',
  apiJoin: '/api/devtoberfest/join', apiMe: '/api/devtoberfest/me',
  imgKasimir: '/k.svg', imgTeched: '/t.svg', imgDevtoberfest: '/d.svg',
}

function stubStatus(extra: Record<string, unknown>) {
  const body = {
    event: { name: 'Devtoberfest', startDate: '2026-09-21', endDate: '2026-10-18' },
    joined: true, termsVersion: 1, termsRequired: false,
    contentRulesUrl: '', faqUrl: '', gameboardUrl: '', activitiesUrl: '', bannerUrl: '',
    ...extra,
  }
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true, status: 200, json: async () => body,
  })) as unknown as typeof fetch)
}

describe('DevtoberfestHome banner', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('renders the banner image when bannerUrl is set', async () => {
    stubStatus({ bannerUrl: '/api/devtoberfest/banner' })
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    const img = wrapper.find('img.dtf-banner-img')
    expect(img.exists()).toBe(true)
    expect(img.attributes('src')).toBe('/api/devtoberfest/banner')
    // Gradient brand text/logos suppressed when banner present
    expect(wrapper.find('.dtf-brand-title').exists()).toBe(false)
  })

  it('falls back to the gradient header when bannerUrl is empty', async () => {
    stubStatus({ bannerUrl: '' })
    const wrapper = mount(DevtoberfestHome, { props: { config: CONFIG } })
    await flushPromises()
    expect(wrapper.find('img.dtf-banner-img').exists()).toBe(false)
    expect(wrapper.find('.dtf-brand-title').text()).toContain('Devtoberfest')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/devtoberfest/__tests__/DevtoberfestHome.banner.test.ts`
Expected: FAIL — `img.dtf-banner-img` not found (banner markup not added yet).

- [ ] **Step 4: Add the banner markup + computed to the component**

In `hugo-apps/src/devtoberfest/DevtoberfestHome.vue` `<script setup>`, add a computed after `eventName` (line 76):

```typescript
const hasBanner = computed<boolean>(() => !!status.value?.bannerUrl)
const bannerUrl = computed<string>(() => status.value?.bannerUrl || '')
```

Replace the `<header class="dtf-header">...</header>` block (lines 165-197) with a banner-aware version. The `.dtf-brand` block renders only when there is NO banner; the `.dtf-cta-wrap` stays but gains a `dtf-cta-overlay` class when a banner is present:

```html
    <header class="dtf-header" :data-has-banner="hasBanner ? 'true' : 'false'">
      <img
        v-if="hasBanner"
        :src="bannerUrl"
        :alt="eventName"
        class="dtf-banner-img"
      />
      <div v-if="!hasBanner" class="dtf-brand">
        <img
          v-if="config.imgDevtoberfest"
          :src="config.imgDevtoberfest"
          alt=""
          class="dtf-brand-logo"
          aria-hidden="true"
        />
        <div class="dtf-brand-text">
          <h1 class="dtf-brand-title">{{ eventName }}</h1>
          <p v-if="eventWindow" class="dtf-brand-window">{{ eventWindow }}</p>
        </div>
        <img
          v-if="config.imgTeched"
          :src="config.imgTeched"
          alt=""
          class="dtf-brand-teched"
          aria-hidden="true"
        />
      </div>
      <div class="dtf-cta-wrap" :class="{ 'dtf-cta-overlay': hasBanner }">
        <button
          type="button"
          class="dtf-cta"
          :disabled="ctaDisabled"
          @click="onCtaClick"
        >
          {{ ctaLabel }}
        </button>
        <p v-if="ctaHint" class="dtf-cta-hint" role="status">{{ ctaHint }}</p>
      </div>
    </header>
```

- [ ] **Step 5: Add the styles**

In `hugo-apps/src/devtoberfest/styles.css`, after the `.dtf-header::before` block (line 50), add:

```css
/* Image-banner variant: drop the gradient/padding, let the img fill. */
.dtf-header[data-has-banner="true"] {
  padding: 0;
  background: none;
  display: block;
}
.dtf-header[data-has-banner="true"]::before { display: none; }

.dtf-banner-img {
  width: 100%;
  height: auto;
  display: block;
  border-radius: 12px;
}

/* CTA overlaid lower-right on the banner, with a legibility scrim. */
.dtf-cta-overlay {
  position: absolute;
  right: 1.25rem;
  bottom: 1.25rem;
  z-index: 2;
  align-items: flex-end;
  padding: 0.4rem 0.5rem;
  border-radius: 999px;
  background: rgba(0, 0, 0, 0.28);
  backdrop-filter: blur(2px);
}

/* Below the body breakpoint, reflow the CTA to a static bar under the banner. */
@media (max-width: 720px) {
  .dtf-cta-overlay {
    position: static;
    background: none;
    backdrop-filter: none;
    align-items: center;
    padding: 0;
    margin-top: 0.75rem;
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/devtoberfest/__tests__/DevtoberfestHome.banner.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 7: Build the island bundle**

Run: `cd hugo-apps && npm run build 2>&1 | tail -15`
Expected: build succeeds; `hugo/static/js/devtoberfest.js` regenerated. (Confirms the Vue/TS changes compile for production.)

- [ ] **Step 8: Commit**

```bash
git add hugo-apps/src/devtoberfest/ hugo/static/js/devtoberfest.js 2>/dev/null; git add -A hugo-apps/src/devtoberfest/
git commit -m "feat(devtoberfest): image banner + overlay CTA in Vue island with gradient fallback"
```

---

### Task 8: Seed script — upload the provided key visual to active DEV config

**Files:**
- Create: `scripts/seed-devtoberfest-banner.mjs`

**Interfaces:**
- Consumes: deployed `AdminService.DevtoberfestConfig.uploadBanner` action (Task 3); the local file `D:\tmp\devtoberfest\key-visual-option1-banner-wide.png`.
- Produces: a runnable one-shot script (run manually AFTER deploy) that uploads the banner to the active config. NOT a CSV (binary + admin-editable). NOT run during these tasks.

- [ ] **Step 1: Write the seed script**

Create `scripts/seed-devtoberfest-banner.mjs`:

```javascript
// One-shot: upload a local image as the active DevtoberfestConfig banner via
// the deployed AdminService uploadBanner bound action.
//
// Usage (after deploy, with a valid bearer token for the admin service):
//   ADMIN_SRV_URL="https://<srv-host>/admin" \
//   ADMIN_TOKEN="<bearer>" \
//   node scripts/seed-devtoberfest-banner.mjs "D:\\tmp\\devtoberfest\\key-visual-option1-banner-wide.png"
//
// Resolves the active config ID, then POSTs the base64 image to
// DevtoberfestConfig(<ID>)/com.sap.developers.ims.AdminService.uploadBanner.

import { readFile } from 'node:fs/promises';

const SRV = process.env.ADMIN_SRV_URL;
const TOKEN = process.env.ADMIN_TOKEN;
const file = process.argv[2];

if (!SRV || !TOKEN || !file) {
  console.error('Set ADMIN_SRV_URL + ADMIN_TOKEN env and pass an image path arg.');
  process.exit(1);
}

const headers = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

const listRes = await fetch(`${SRV}/DevtoberfestConfig?$filter=isActive eq true&$select=ID`, { headers });
if (!listRes.ok) { console.error('list active config failed', listRes.status, await listRes.text()); process.exit(1); }
const { value } = await listRes.json();
if (!value?.length) { console.error('no active DevtoberfestConfig row'); process.exit(1); }
const ID = value[0].ID;

const bytes = await readFile(file);
const imageBase64 = bytes.toString('base64');
const mimeType = file.toLowerCase().endsWith('.png') ? 'image/png'
  : file.toLowerCase().endsWith('.webp') ? 'image/webp' : 'image/jpeg';

const action = `com.sap.developers.ims.AdminService.uploadBanner`;
const upRes = await fetch(`${SRV}/DevtoberfestConfig(${ID})/${action}`, {
  method: 'POST', headers, body: JSON.stringify({ imageBase64, mimeType }),
});
if (!upRes.ok) { console.error('uploadBanner failed', upRes.status, await upRes.text()); process.exit(1); }
console.log('Banner uploaded to active config', ID);
```

- [ ] **Step 2: Lint-check the script parses**

Run: `node --check scripts/seed-devtoberfest-banner.mjs`
Expected: no output (syntax OK). Do NOT run the script here — it targets the deployed service and runs post-deploy.

- [ ] **Step 3: Commit**

```bash
git add scripts/seed-devtoberfest-banner.mjs
git commit -m "chore(devtoberfest): post-deploy seed script for the event banner"
```

---

### Task 9: Full test sweep + docs

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` OR `CLAUDE.md` top-gotchas (add a one-line pointer to the banner feature) — pick the doc that already documents Devtoberfest config.

**Interfaces:**
- Consumes: everything above.
- Produces: green unit suite + a doc breadcrumb.

- [ ] **Step 1: Run the full unit suite**

Run: `npm test 2>&1 | tail -30`
Expected: PASS. If any pre-existing test posts to `/api/devtoberfest/status` and asserts an exact response shape, update it to tolerate the new `bannerUrl` field (grep: `grep -rn "termsRequired" srv test hugo-apps/src 2>/dev/null`).

- [ ] **Step 2: Re-run the CDS in-memory deploy (schema sanity)**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -10`
Expected: clean.

- [ ] **Step 3: Add a doc breadcrumb**

Add one line to the Devtoberfest section of the appropriate doc, e.g.:

```markdown
- **Devtoberfest banner is admin-uploadable** — per-`DevtoberfestConfig` `DevtoberfestBanner` composition (wide WebP BLOB, `uploadBanner`/`clearBanner` actions), served anonymously at `GET /api/devtoberfest/banner` for the active row; the Vue island renders it as the hero with the CTA overlaid lower-right, falling back to the CSS gradient header when unset. Full deploy (schema + admin bundle + approuter). Spec: `docs/superpowers/specs/2026-07-29-devtoberfest-banner-upload-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(devtoberfest): note admin-uploadable banner feature"
```

---

## Self-Review

**Spec coverage:**
- Data model (banner composition + config fields) → Task 1 ✓
- Sharp pipeline / single wide WebP / 2000px → Task 2 ✓
- Bound actions uploadBanner/clearBanner + handler registration → Task 3 ✓
- Admin Object Page upload + fragment-cache version bump → Task 4 ✓
- Public anonymous route + status.bannerUrl + LOB-locator raw SQL → Task 5 ✓
- Approuter anonymous allowlist → Task 6 ✓
- Vue island image banner + lower-right overlay + 720px reflow + gradient fallback → Task 7 ✓
- Seed the provided key visual (not CSV) → Task 8 ✓
- Test sweep + docs + schema sanity → Task 9 ✓

**Type consistency:** `uploadAndUpsertBanner({configID, buffer, mimeType})`, `processBannerUpload(buffer, mimeType)`, `fetchBanner(configID)`, and `bannerUrl: string` are used identically across Tasks 2/3/5/7. Column names (`config_ID`, `image`, `mimeType`, `sha256`, `width`, `height`, `sizeBytes`, `uploadedAt`, `hasBanner`, `bannerUpdatedAt`) match Task 1's entity. Bound-action name `uploadBanner`/`clearBanner` consistent across Tasks 3/4/8.

**Placeholder scan:** No TBDs; all code steps carry real code and exact run commands.
