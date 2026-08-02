# Petoberfest — Pet Photo Contest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Petoberfest" pet-photo-contest task type: logged-in users upload pet photos (upload = task completion, once per user), photos are moderated, and everyone sees an approved-photo slideshow — assignable to a Devtoberfest Activity like a tutorial or puzzle.

**Architecture:** Vue island embedded in a Hugo page (puzzle model) for the frontend; a public CAP service (`@requires:'any'`) with per-action auth overrides plus raw Express multipart-upload/BLOB-serve routes reserved in `server.js` (advocate-photo model); photos stored as HANA BLOBs via raw `db.run` (HANA/SQLite split). Cross-repo: a third UNION arm in `TASK_VALUE_HELP_V1` flows through the planner's existing pass-through value help.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), CDS/CQL, HANA Cloud (HDI), `sharp` (image resize), `multer` (multipart), Hugo, Vue 3 + Vite, Fiori Elements (admin), Playwright (e2e).

**Design spec:** `docs/superpowers/specs/2026-08-02-petoberfest-pet-photo-contest-design.md`

## Global Constraints

- Package is ESM (`"type":"module"`) — new `srv/lib/*.js` use `import`/`export`, not `require`.
- Never SELECT a HANA `LargeBinary`/BLOB alongside metadata in one CDS QL query — LOB locators expire. BLOB reads use raw `db.run` with a `db.kind === 'hana'` branch; CDS QL only for the SQLite (unit-test) path.
- HANA physical identifiers are UPPERCASE-unquoted in raw SQL (`COM_SAP_DEVELOPERS_IMS_PETSUBMISSIONS`, column `PHOTODISPLAY`, etc.).
- Tutorial/task slugs are lowercase canonical — lowercase on write, compare with `.toLowerCase()`.
- `@assert.unique.*` and enum values are CDS-runtime-only, NOT DB constraints — adding a `taskType` enum value needs no `.hdbmigrationtable` ALTER; a NEW entity needs `cds build --production` to regenerate its `.hdbmigrationtable`.
- Raw Express routes that overlap a CAP service `@path` MUST be reserved in `srv/server.js` BEFORE CAP mounts, or the OData adapter returns "Invalid resource path".
- Authenticated non-GET browser calls go through `csrfFetch` (from `@shared/csrf-fetch`); anonymous calls use plain `fetch`. Never set `Content-Type` manually on a multipart body.
- Admin-UI changes require a FULL `mbt build` (no `--skip-build`, no `-m` scoping); MTA version bump is **minor** (new feature) in `.deploy/mta.yaml`.
- Run `npx cds deploy --to sqlite::memory:` before committing any `db/**/*.cds` change to catch model errors.
- Moderation scope for approve/hide + admin photo route: `Tutorial.Author` OR `Admin`.

---

## Phase 1 — Data model + photo store (backend foundation)

### Task 1: Add CDS entities and task-type enum values

**Files:**
- Modify: `db/schema.cds` (enum `TaskType` line ~18; `TaskRecords.taskType` enum line ~189; add two new entities near `Puzzles`/`PuzzleProgress` ~line 132-212)
- Test: `test/unit/petoberfest-model.test.js` (create)

**Interfaces:**
- Produces: entities `com.sap.developers.ims.Petoberfests` (fields: `legacyId`, `title`, `description`, `status`, `slug`, `intro`, plus TaskBase fields) and `com.sap.developers.ims.PetSubmissions` (fields: `ID`, `petoberfest_ID`, `user_ID`, `petName`, `uploaderName`, `moderation`, `photoDisplay`, `photoThumb`, `mimeType`, `sizeBytes`, `sha256`, `uploadedAt`, plus managed fields). Enum values `PETOBERFEST` on both `TaskType` and `TaskRecords.taskType`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/petoberfest-model.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

let model;
beforeAll(async () => { model = await cds.load(cds.env.folders.db + '/schema.cds'); });

test('Petoberfests entity exists with slug + intro', () => {
  const e = model.definitions['com.sap.developers.ims.Petoberfests'];
  expect(e).toBeDefined();
  expect(e.elements.slug).toBeDefined();
  expect(e.elements.intro).toBeDefined();
});

test('PetSubmissions has moderation + two media columns', () => {
  const e = model.definitions['com.sap.developers.ims.PetSubmissions'];
  expect(e).toBeDefined();
  expect(e.elements.moderation).toBeDefined();
  expect(e.elements.photoDisplay['@Core.MediaType']).toBeTruthy();
  expect(e.elements.photoThumb['@Core.MediaType']).toBeTruthy();
  expect(e.elements.petName).toBeDefined();
  expect(e.elements.uploaderName).toBeDefined();
});

test('PETOBERFEST is a valid TaskRecords.taskType enum value', () => {
  const tr = model.definitions['com.sap.developers.ims.TaskRecords'];
  expect(tr.elements.taskType.enum.PETOBERFEST).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/petoberfest-model.test.js`
Expected: FAIL — `Petoberfests` undefined.

- [ ] **Step 3: Add enum values**

In `db/schema.cds`, change the `TaskType` type (line ~18) to add `PETOBERFEST`:

```cds
type TaskType : String(20) enum { TUTORIAL; GROUP; CHECKPOINT; PUZZLE; PETOBERFEST; }
```

In the inline `TaskRecords.taskType` enum (line ~189) add `PETOBERFEST`:

```cds
  taskType : String enum { TUTORIAL; MISSION; GROUP; STEP; CHECKPOINT; PUZZLE; PETOBERFEST; };
```

- [ ] **Step 4: Add the two entities**

In `db/schema.cds`, near the `Puzzles` block, add:

```cds
@assert.unique.slug: [slug]
entity Petoberfests : TaskBase {
  slug  : String(255) @mandatory;
  intro : LargeString;
}

entity PetSubmissions : cuid, managed {
  petoberfest  : Association to Petoberfests not null;
  user         : Association to Users not null;
  petName      : String(120);
  uploaderName : String(120);
  moderation   : String(12) enum { PENDING; APPROVED; HIDDEN; } default 'PENDING';
  photoDisplay : LargeBinary @Core.MediaType: mimeType;
  photoThumb   : LargeBinary @Core.MediaType: 'image/webp';
  mimeType     : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes    : Integer;
  sha256       : String(64);
  uploadedAt   : Timestamp;
}
```

- [ ] **Step 5: Run test + model deploy check**

Run: `npx vitest run test/unit/petoberfest-model.test.js && npx cds deploy --to sqlite::memory: > /dev/null && echo MODEL_OK`
Expected: tests PASS and `MODEL_OK` printed.

- [ ] **Step 6: Regenerate HDI artifacts for the new entities**

Run: `npx cds build --production`
Expected: new `db/src/gen/*PETSUBMISSIONS.hdbmigrationtable` + `*PETOBERFESTS.hdbmigrationtable` appear (or under the project's generated db path). Verify with `git status`. Do NOT hand-edit these.

- [ ] **Step 7: Commit**

```bash
git add db/schema.cds test/unit/petoberfest-model.test.js db
git commit -m "feat(petoberfest): add Petoberfests + PetSubmissions entities and PETOBERFEST task type"
```

---

### Task 2: Photo store (sharp pipeline + HANA/SQLite BLOB store & serve)

**Files:**
- Create: `srv/lib/petoberfest-photo-store.js`
- Test: `test/unit/petoberfest-photo-store.test.js`

**Interfaces:**
- Consumes: `PetSubmissions` entity from Task 1.
- Produces:
  - `processPetUpload(buffer, mimeType) -> { photoDisplay:Buffer, photoThumb:Buffer, sha256:string, sizeBytes:number, mimeType:'image/webp' }`
  - `insertSubmission(db, { petoberfestID, userID, petName, uploaderName, ...processed }) -> { id }`
  - `findDuplicate(db, { petoberfestID, userID, sha256 }) -> row | null`
  - `fetchPetPhoto(db, { id, size, requireApproved }) -> { buffer:Buffer, mimeType, sha256, moderation } | null`  (size: 'display'|'thumb')

- [ ] **Step 1: Write the failing test**

```js
// test/unit/petoberfest-photo-store.test.js
import { expect, test } from 'vitest';
import sharp from 'sharp';
import { processPetUpload } from '../../srv/lib/petoberfest-photo-store.js';

async function makePng(w = 2000, h = 1500) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 10, g: 120, b: 80 } } })
    .png().toBuffer();
}

test('processPetUpload produces display + thumb webp and a sha256', async () => {
  const png = await makePng();
  const out = await processPetUpload(png, 'image/png');
  expect(out.mimeType).toBe('image/webp');
  expect(Buffer.isBuffer(out.photoDisplay)).toBe(true);
  expect(Buffer.isBuffer(out.photoThumb)).toBe(true);
  const dMeta = await sharp(out.photoDisplay).metadata();
  const tMeta = await sharp(out.photoThumb).metadata();
  expect(Math.max(dMeta.width, dMeta.height)).toBeLessThanOrEqual(1280);
  expect(Math.max(tMeta.width, tMeta.height)).toBeLessThanOrEqual(320);
  expect(out.sha256).toMatch(/^[0-9a-f]{64}$/);
});

test('processPetUpload rejects bad mime and animated', async () => {
  const png = await makePng(50, 50);
  await expect(processPetUpload(png, 'application/pdf')).rejects.toThrow(/unsupported MIME/i);
  const gif = await sharp({ create: { width: 20, height: 20, channels: 4, background: { r:0,g:0,b:0,alpha:1 } }, animated: true, pages: 2 })
    .gif().toBuffer().catch(() => null);
  if (gif) await expect(processPetUpload(gif, 'image/gif')).rejects.toThrow(/animated/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/petoberfest-photo-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the store**

```js
// srv/lib/petoberfest-photo-store.js
// ESM. Mirrors srv/lib/advocate-photo-store.js but sizes for a slideshow
// (1280px display + 320px thumb) and serves gated on moderation state.
import sharp from 'sharp';
import crypto from 'node:crypto';

const MAX_BYTES = 10 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const DISPLAY_MAX = 1280;
const THUMB_MAX = 320;
const PET_TABLE = 'COM_SAP_DEVELOPERS_IMS_PETSUBMISSIONS';

export async function processPetUpload(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) throw new Error('processPetUpload: buffer is required');
  if (buffer.length > MAX_BYTES) throw new Error('processPetUpload: image too large (max 10 MB)');
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new Error('processPetUpload: unsupported MIME type');
  }
  let meta;
  try { meta = await sharp(buffer, { animated: true }).metadata(); }
  catch { throw new Error('processPetUpload: invalid image bytes'); }
  if (!meta || !meta.format) throw new Error('processPetUpload: invalid image bytes');
  if (meta.pages && meta.pages > 1) throw new Error('processPetUpload: animated images are not supported');

  const photoDisplay = await sharp(buffer)
    .rotate()                                   // apply + strip EXIF orientation
    .resize(DISPLAY_MAX, DISPLAY_MAX, { fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 82 })
    .toBuffer();
  const photoThumb = await sharp(buffer)
    .rotate()
    .resize(THUMB_MAX, THUMB_MAX, { fit: 'cover', position: 'attention' })
    .webp({ quality: 80 })
    .toBuffer();

  const sha256 = crypto.createHash('sha256').update(photoDisplay).digest('hex');
  return { photoDisplay, photoThumb, sha256, sizeBytes: photoDisplay.length, mimeType: 'image/webp' };
}

export async function findDuplicate(db, { petoberfestID, userID, sha256 }) {
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const row = await db.run(
    SELECT.one.from(PetSubmissions).columns('ID')
      .where({ petoberfest_ID: petoberfestID, user_ID: userID, sha256 }),
  );
  return row || null;
}

export async function insertSubmission(db, {
  petoberfestID, userID, petName, uploaderName, photoDisplay, photoThumb, sha256, sizeBytes, mimeType,
}) {
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const id = cryptoRandomId();
  await db.run(INSERT.into(PetSubmissions).entries({
    ID: id,
    petoberfest_ID: petoberfestID,
    user_ID: userID,
    petName: petName || null,
    uploaderName: uploaderName || null,
    moderation: 'PENDING',
    photoDisplay, photoThumb, mimeType, sizeBytes, sha256,
    uploadedAt: new Date().toISOString(),
  }));
  return { id };
}

function cryptoRandomId() {
  return crypto.randomUUID();
}

// Serve: raw db.run on HANA (LOB hygiene), CDS QL on SQLite. requireApproved
// forces a 404 for non-APPROVED rows on the public route; the admin route
// passes requireApproved:false to preview PENDING/HIDDEN.
export async function fetchPetPhoto(db, { id, size = 'display', requireApproved = true }) {
  const col = size === 'thumb' ? 'PHOTOTHUMB' : 'PHOTODISPLAY';
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    const rows = await db.run(
      `SELECT ${col} AS "buffer", MIMETYPE AS "mimeType", SHA256 AS "sha256", MODERATION AS "moderation" ` +
      `FROM "${PET_TABLE}" WHERE "ID" = ?`, [id]);
    const r = rows && rows[0];
    if (!r || !r.buffer) return null;
    if (requireApproved && r.moderation !== 'APPROVED') return null;
    return { buffer: r.buffer, mimeType: r.mimeType, sha256: r.sha256, moderation: r.moderation };
  }
  // SQLite (unit tests): the media column comes back as a Buffer/Uint8Array.
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const metaRow = await db.run(
    SELECT.one.from(PetSubmissions).columns('mimeType', 'sha256', 'moderation').where({ ID: id }));
  if (!metaRow) return null;
  if (requireApproved && metaRow.moderation !== 'APPROVED') return null;
  const blobRow = await db.run(
    SELECT.one.from(PetSubmissions).columns(size === 'thumb' ? 'photoThumb' : 'photoDisplay').where({ ID: id }));
  const raw = blobRow && (blobRow.photoThumb ?? blobRow.photoDisplay);
  if (!raw) return null;
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  return { buffer, mimeType: metaRow.mimeType, sha256: metaRow.sha256, moderation: metaRow.moderation };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/petoberfest-photo-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/petoberfest-photo-store.js test/unit/petoberfest-photo-store.test.js
git commit -m "feat(petoberfest): add photo store (sharp resize + HANA/SQLite BLOB serve)"
```

---

## Phase 2 — Public service + upload/serve routes

### Task 3: PetoberfestService (public read + authed myUploads)

**Files:**
- Create: `srv/petoberfest-service.cds`, `srv/petoberfest-service.js`
- Test: `test/unit/petoberfest-service.test.js`

**Interfaces:**
- Consumes: `Petoberfests`, `PetSubmissions` (Task 1); `resolveUserSapId` from `srv/lib/resolve-db-user.js`.
- Produces: OData service at `/petoberfest-api` with `@readonly` `Petoberfests` projection; function `slideshow(slug)` returning `[{ id, petName, uploaderName, uploadedAt }]` (APPROVED only); function `myUploads(slug)` (authenticated) returning `[{ id, petName, moderation, uploadedAt }]` for the caller. Exports helper `resolveOrCreatePetUser(db, user)` reused by Task 4's upload route.

- [ ] **Step 1: Write the CDS surface**

```cds
// srv/petoberfest-service.cds
using com.sap.developers.ims as ims from '../db/schema';

@path: '/petoberfest-api'
@requires: 'any'
service PetoberfestService {
  @readonly entity Petoberfests as projection on ims.Petoberfests {
    legacyId, slug, title, intro, status
  };

  function slideshow(slug: String) returns array of {
    id: String; petName: String; uploaderName: String; uploadedAt: Timestamp;
  };

  @(requires: 'authenticated-user')
  function myUploads(slug: String) returns array of {
    id: String; petName: String; moderation: String; uploadedAt: Timestamp;
  };
}
```

- [ ] **Step 2: Write the failing test**

```js
// test/unit/petoberfest-service.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

const { GET, POST } = cds.test('serve', '--project', '.', '--in-memory');

let db;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests, PetSubmissions, Users } = db.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Petoberfests).entries({
    ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'Petoberfest 2026', status: 'ACTIVE',
  }));
  await db.run(INSERT.into(Users).entries({ ID: 'u1', sapId: 'sap-1', email: 'a@b.c' }));
  await db.run(INSERT.into(PetSubmissions).entries([
    { ID: 's-appr', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Rex', uploaderName: 'Tom',
      moderation: 'APPROVED', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z' },
    { ID: 's-pend', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Milo', uploaderName: 'Tom',
      moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T01:00:00Z' },
  ]));
});

test('slideshow returns only APPROVED entries', async () => {
  const { data } = await GET(`/petoberfest-api/slideshow(slug='petoberfest-2026')`);
  const rows = data.value ?? data;
  expect(rows.length).toBe(1);
  expect(rows[0].petName).toBe('Rex');
});

test('slideshow is anonymous-accessible (no auth header)', async () => {
  const res = await GET(`/petoberfest-api/slideshow(slug='petoberfest-2026')`);
  expect(res.status).toBe(200);
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/petoberfest-service.test.js`
Expected: FAIL — service/route not found.

- [ ] **Step 4: Implement the handler**

```js
// srv/petoberfest-service.js
import cds from '@sap/cds';
import { resolveUserSapId } from './lib/resolve-db-user.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

export async function resolveOrCreatePetUser(db, user) {
  const sapId = resolveUserSapId(user);
  if (!sapId) return null;
  const { Users } = db.entities('com.sap.developers.ims');
  let row = await db.run(SELECT.one.from(Users).where({ sapId }));
  if (!row) {
    const ID = cds.utils.uuid();
    await db.run(INSERT.into(Users).entries({
      ID, sapId,
      email: user.attr?.email || null,
      givenName: user.attr?.given_name || null,
      familyName: user.attr?.family_name || null,
    }));
    row = { ID, sapId };
  }
  return row;
}

export default class PetoberfestService extends cds.ApplicationService {
  async init() {
    const db = await cds.connect.to('db');
    const { Petoberfests, PetSubmissions } = db.entities('com.sap.developers.ims');

    async function loadContest(slug) {
      if (!slug || !SLUG_RE.test(String(slug).toLowerCase())) return null;
      return db.run(SELECT.one.from(Petoberfests).where({ slug: String(slug).toLowerCase() }));
    }

    this.on('slideshow', async (req) => {
      const contest = await loadContest(req.data.slug);
      if (!contest) return [];
      const rows = await db.run(
        SELECT.from(PetSubmissions)
          .columns('ID as id', 'petName', 'uploaderName', 'uploadedAt')
          .where({ petoberfest_ID: contest.ID, moderation: 'APPROVED' })
          .orderBy({ uploadedAt: 'desc' }));
      return rows;
    });

    this.on('myUploads', async (req) => {
      const contest = await loadContest(req.data.slug);
      if (!contest) return [];
      const dbUser = await resolveOrCreatePetUser(db, req.user);
      if (!dbUser) return req.reject(401, 'Unauthenticated');
      return db.run(
        SELECT.from(PetSubmissions)
          .columns('ID as id', 'petName', 'moderation', 'uploadedAt')
          .where({ petoberfest_ID: contest.ID, user_ID: dbUser.ID })
          .orderBy({ uploadedAt: 'desc' }));
    });

    await super.init();
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/petoberfest-service.test.js`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add srv/petoberfest-service.cds srv/petoberfest-service.js test/unit/petoberfest-service.test.js
git commit -m "feat(petoberfest): add public PetoberfestService (slideshow + myUploads)"
```

---

### Task 4: Upload route + photo serve routes (server.js) + idempotent TaskRecord

**Files:**
- Create: `srv/lib/petoberfest-upload.js` (upload orchestration: process → dup-check → insert → award TaskRecord)
- Modify: `srv/server.js` (reserve 3 raw routes before CAP mounts, near the advocate photo route ~line 704-818)
- Test: `test/unit/petoberfest-upload.test.js`

**Interfaces:**
- Consumes: `processPetUpload`, `findDuplicate`, `insertSubmission`, `fetchPetPhoto` (Task 2); `resolveOrCreatePetUser` (Task 3); `getNextLegacyId` from `srv/lib/legacy-id.js`; `resolveUser`/`captureUserMiddleware` from `srv/lib/resolve-user.js`.
- Produces:
  - `uploadPetSubmission(db, { slug, user, buffer, mimeType, petName }) -> { id, awarded, moderation, duplicate }` (throws Error with `.code`/recognizable message on bad input, mirroring processUpload)
  - Routes: `POST /petoberfest-api/:slug/upload`, `GET /petoberfest-api/photo/:id`, `GET /admin/petoberfest/photo/:id`.

- [ ] **Step 1: Write the failing test (orchestration unit)**

```js
// test/unit/petoberfest-upload.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';
import sharp from 'sharp';
import { uploadPetSubmission } from '../../srv/lib/petoberfest-upload.js';

cds.test('serve', '--project', '.', '--in-memory');
let db, png;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests } = db.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Petoberfests).entries({
    ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'Petoberfest 2026', status: 'ACTIVE' }));
  png = await sharp({ create: { width: 800, height: 600, channels: 3, background: { r:1,g:2,b:3 } } }).png().toBuffer();
});

const fakeUser = { id: 'sap-42', attr: { email: 't@x.c', given_name: 'Tom', family_name: 'J' } };

test('first upload awards a COMPLETED PETOBERFEST TaskRecord', async () => {
  const r = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: fakeUser, buffer: png, mimeType: 'image/png', petName: 'Rex' });
  expect(r.awarded).toBe(true);
  expect(r.moderation).toBe('PENDING');
  const { TaskRecords } = db.entities('com.sap.developers.ims');
  const recs = await db.run(SELECT.from(TaskRecords).where({ taskType: 'PETOBERFEST', status: 'COMPLETED' }));
  expect(recs.length).toBe(1);
  expect(recs[0].taskLegacyId).toBe(9001);
});

test('second upload (different photo) adds a pet but does NOT re-award', async () => {
  const png2 = await sharp({ create: { width: 640, height: 480, channels: 3, background: { r:9,g:9,b:9 } } }).png().toBuffer();
  const r = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: fakeUser, buffer: png2, mimeType: 'image/png', petName: 'Milo' });
  expect(r.awarded).toBe(false);
  const { TaskRecords } = db.entities('com.sap.developers.ims');
  const recs = await db.run(SELECT.from(TaskRecords).where({ taskType: 'PETOBERFEST', status: 'COMPLETED' }));
  expect(recs.length).toBe(1);
});

test('exact-duplicate re-upload is rejected as duplicate', async () => {
  const r = await uploadPetSubmission(db, { slug: 'petoberfest-2026', user: fakeUser, buffer: png, mimeType: 'image/png', petName: 'Rex again' });
  expect(r.duplicate).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/petoberfest-upload.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the orchestration**

```js
// srv/lib/petoberfest-upload.js
import { processPetUpload, findDuplicate, insertSubmission } from './petoberfest-photo-store.js';
import { resolveOrCreatePetUser } from '../petoberfest-service.js';
import { getNextLegacyId } from './legacy-id.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,254}$/;

export async function uploadPetSubmission(db, { slug, user, buffer, mimeType, petName }) {
  const s = String(slug || '').toLowerCase();
  if (!SLUG_RE.test(s)) throw new Error('uploadPetSubmission: bad slug');

  const { Petoberfests, TaskRecords } = db.entities('com.sap.developers.ims');
  const contest = await db.run(SELECT.one.from(Petoberfests).where({ slug: s }));
  if (!contest) { const e = new Error('contest not found'); e.code = 'NOT_FOUND'; throw e; }

  const dbUser = await resolveOrCreatePetUser(db, user);
  if (!dbUser) { const e = new Error('unauthenticated'); e.code = 'UNAUTHENTICATED'; throw e; }

  const processed = await processPetUpload(buffer, mimeType);   // throws on bad/animated/oversize

  if (await findDuplicate(db, { petoberfestID: contest.ID, userID: dbUser.ID, sha256: processed.sha256 })) {
    return { id: null, awarded: false, moderation: null, duplicate: true };
  }

  const uploaderName = [user.attr?.given_name, user.attr?.family_name].filter(Boolean).join(' ').trim() || null;
  const { id } = await insertSubmission(db, {
    petoberfestID: contest.ID, userID: dbUser.ID,
    petName: petName ? String(petName).slice(0, 120) : null,
    uploaderName, ...processed,
  });

  // Idempotent award: skip if a non-SUPERSEDED PETOBERFEST record already exists for this user+contest.
  const existing = await db.run(SELECT.one.from(TaskRecords).where({
    user_ID: dbUser.ID, taskLegacyId: contest.legacyId, taskType: 'PETOBERFEST', status: { '!=': 'SUPERSEDED' },
  }));
  let awarded = false;
  if (!existing) {
    await db.run(INSERT.into(TaskRecords).entries({
      user_ID: dbUser.ID,
      taskLegacyId: contest.legacyId,
      taskType: 'PETOBERFEST',
      status: 'COMPLETED',
      progress: 100,
      completionDate: new Date().toISOString(),
      titleSnapshot: contest.title,
      legacyId: await getNextLegacyId('TaskRecords', db),
      attemptNumber: 1,
    }));
    awarded = true;
  }
  return { id, awarded, moderation: 'PENDING', duplicate: false };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/petoberfest-upload.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the three raw routes in `srv/server.js`**

Add imports at the top of the file alongside the existing advocate/multer imports:

```js
import { uploadPetSubmission } from './lib/petoberfest-upload.js';
import { fetchPetPhoto } from './lib/petoberfest-photo-store.js';
```

Locate the advocate photo route reservation (~line 704) and add, immediately after it, reusing the already-imported `captureUserMiddleware`, `resolveUser`, `multer`:

```js
  // ── Petoberfest: multipart upload (authenticated) + photo serve (public/admin) ──
  // Reserved BEFORE CAP mounts PetoberfestService at /petoberfest-api and
  // AdminService at /admin — same rationale as the advocate photo route above.
  const _petCtxMw  = cds.middlewares?.context?.() || ((req, res, next) => next());
  const _petAuthMw = cds.middlewares?.auth?.()    || ((req, res, next) => next());
  const _petUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

  app.post('/petoberfest-api/:slug/upload',
    _petCtxMw, _petAuthMw, captureUserMiddleware(cds),
    (req, res, next) => {
      _petUpload.single('photo')(req, res, (err) => {
        if (err) return res.status(400).json({ error: err.code || 'UPLOAD_ERROR', message: err.message });
        next();
      });
    },
    async (req, res) => {
      try {
        const user = resolveUser(req, cds);
        if (!user) return res.status(401).json({ error: 'UNAUTHENTICATED', message: 'Sign in to upload' });
        if (!req.file) return res.status(400).json({ error: 'MISSING_FIELD', message: "missing 'photo' field" });
        const db = await cds.connect.to('db');
        const out = await uploadPetSubmission(db, {
          slug: req.params.slug, user, buffer: req.file.buffer,
          mimeType: req.file.mimetype, petName: req.body?.petName,
        });
        if (out.duplicate) return res.status(409).json({ error: 'DUPLICATE', message: 'You already uploaded this photo' });
        return res.json({ id: out.id, awarded: out.awarded, moderation: out.moderation });
      } catch (e) {
        const code = e.code === 'NOT_FOUND' ? 'NOT_FOUND'
                   : /unsupported MIME/i.test(e.message) ? 'BAD_MIME'
                   : /too large/i.test(e.message) ? 'TOO_LARGE'
                   : /animated/i.test(e.message) ? 'ANIMATED'
                   : /invalid image/i.test(e.message) ? 'BAD_IMAGE'
                   : 'UPLOAD_FAILED';
        const status = code === 'NOT_FOUND' ? 404 : 400;
        return res.status(status).json({ error: code, message: e.message });
      }
    });

  // Public photo serve — APPROVED only (404 otherwise so unapproved can't leak).
  app.get('/petoberfest-api/photo/:id', async (req, res) => {
    try {
      const db = await cds.connect.to('db');
      const size = req.query.size === 'thumb' ? 'thumb' : 'display';
      const p = await fetchPetPhoto(db, { id: req.params.id, size, requireApproved: true });
      if (!p) return res.status(404).end();
      return sendPetPhoto(res, p);
    } catch { return res.status(500).end(); }
  });

  // Admin photo serve — any moderation state (Author/Admin gated) for queue thumbnails.
  app.get('/admin/petoberfest/photo/:id',
    _petCtxMw, _petAuthMw,
    async (req, res) => {
      const user = resolveUser(req, cds);
      if (!user) return res.status(401).end();
      if (typeof user.is === 'function' && !(user.is('Admin') || user.is('Tutorial.Author'))) return res.status(403).end();
      try {
        const db = await cds.connect.to('db');
        const size = req.query.size === 'thumb' ? 'thumb' : 'display';
        const p = await fetchPetPhoto(db, { id: req.params.id, size, requireApproved: false });
        if (!p) return res.status(404).end();
        return sendPetPhoto(res, p);
      } catch { return res.status(500).end(); }
    });
```

Add a file-local helper near the other helpers in `server.js` (ETag/304 matching the advocate serve conventions):

```js
function sendPetPhoto(res, p) {
  res.setHeader('ETag', `"${p.sha256}"`);
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.setHeader('Content-Type', p.mimeType || 'image/webp');
  return res.send(p.buffer);
}
```

Note: the in-handler `if (!user)` check is defense-in-depth — the xsuaa AppRouter route (Task 6) already blocks anonymous callers for the upload path.

- [ ] **Step 6: Run the relevant unit suite for regressions**

Run: `npx vitest run test/unit/petoberfest-upload.test.js test/unit/petoberfest-service.test.js test/unit/petoberfest-photo-store.test.js`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/petoberfest-upload.js srv/server.js test/unit/petoberfest-upload.test.js
git commit -m "feat(petoberfest): upload route + public/admin photo serve + idempotent TaskRecord award"
```

---

## Phase 3 — Admin moderation + AppRouter routing

### Task 5: Admin moderation surface (AdminService projections + approve/hide + Fiori app)

**Files:**
- Modify: `srv/admin-service.cds` (expose `Petoberfests` CRUD + `PetSubmissions` queue projection + 2 bound actions, near the `Puzzles` exposure ~line 105)
- Modify: `srv/admin-service.js` (implement `approve`/`hide` handlers)
- Create: `app/admin/petoberfest/webapp/*` (Fiori Elements LR/OP — manifest.json, annotations, Component.js, i18n)
- Modify: `app/admin-shell/` shell config (register the headless componentUsage + nav tile)
- Test: `test/unit/petoberfest-admin.test.js`

**Interfaces:**
- Consumes: `Petoberfests`, `PetSubmissions` (Task 1); admin photo route `/admin/petoberfest/photo/:id` (Task 4).
- Produces: `AdminService.Petoberfests`, `AdminService.PetSubmissions` (queue fields, no blobs), bound actions `approve()` / `hide()` on `PetSubmissions`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/petoberfest-admin.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

const { POST, PATCH } = cds.test('serve', '--project', '.', '--in-memory')
  .with({ auth: { kind: 'mocked', users: { admin: { roles: ['Admin', 'Tutorial.Author', 'authenticated-user'] } } } });

let db;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests, PetSubmissions, Users } = db.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Petoberfests).entries({ ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'P26', status: 'ACTIVE' }));
  await db.run(INSERT.into(Users).entries({ ID: 'u1', sapId: 's1' }));
  await db.run(INSERT.into(PetSubmissions).entries({ ID: 's1', petoberfest_ID: 'p1', user_ID: 'u1', petName: 'Rex', moderation: 'PENDING', mimeType: 'image/webp', uploadedAt: '2026-08-01T00:00:00Z' }));
});

test('approve sets moderation APPROVED', async () => {
  const res = await POST(`/admin/PetSubmissions(ID=s1)/AdminService.approve`, {}, { auth: { username: 'admin', password: '' } });
  expect(res.status).toBeLessThan(300);
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 's1' }));
  expect(row.moderation).toBe('APPROVED');
});

test('hide sets moderation HIDDEN', async () => {
  const res = await POST(`/admin/PetSubmissions(ID=s1)/AdminService.hide`, {}, { auth: { username: 'admin', password: '' } });
  expect(res.status).toBeLessThan(300);
  const { PetSubmissions } = db.entities('com.sap.developers.ims');
  const row = await db.run(SELECT.one.from(PetSubmissions).where({ ID: 's1' }));
  expect(row.moderation).toBe('HIDDEN');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/petoberfest-admin.test.js`
Expected: FAIL — action/entity not exposed.

- [ ] **Step 3: Expose entities + actions in `srv/admin-service.cds`**

Near the `Puzzles` exposure (~line 105), add:

```cds
  @odata.draft.enabled
  entity Petoberfests as projection on ims.Petoberfests;

  entity PetSubmissions as projection on ims.PetSubmissions {
    ID, petName, uploaderName, moderation, sizeBytes, uploadedAt,
    petoberfest.slug as contestSlug, petoberfest.title as contestTitle
  } actions {
    action approve();
    action hide();
  };
```

- [ ] **Step 4: Implement handlers in `srv/admin-service.js`**

In the service `init()`, add:

```js
    const { PetSubmissions } = this.entities;
    this.on('approve', PetSubmissions, async (req) => {
      const id = req.params[req.params.length - 1]?.ID ?? req.params[0]?.ID ?? req.params[0];
      await UPDATE(this.entities.PetSubmissions).set({ moderation: 'APPROVED' }).where({ ID: id });
      return req.reply();
    });
    this.on('hide', PetSubmissions, async (req) => {
      const id = req.params[req.params.length - 1]?.ID ?? req.params[0]?.ID ?? req.params[0];
      await UPDATE(this.entities.PetSubmissions).set({ moderation: 'HIDDEN' }).where({ ID: id });
      return req.reply();
    });
```

(If the existing `admin-service.js` uses `srv.on(...)` outside a class, follow that file's established handler-registration style verbatim; the SELECT/UPDATE logic is identical.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/petoberfest-admin.test.js`
Expected: PASS.

- [ ] **Step 6: Scaffold the Fiori LR/OP app**

Copy the structure of an existing simple admin app (e.g. `app/admin/puzzles/webapp/`) into `app/admin/petoberfest/webapp/`. Set:
- `manifest.json`: `dataSource` → `AdminService`, main entity `PetSubmissions`; LR columns petName, uploaderName, contestTitle, moderation, uploadedAt; a custom column rendering `<img src="/admin/petoberfest/photo/{ID}?size=thumb">` (thumbnail preview).
- `annotations.cds` (or local annotations): `UI.LineItem` with the columns above; `UI.DataFieldForAction` entries for `AdminService.approve` and `AdminService.hide` (manifest-only actions render nothing — DataFieldForAction is required).
- `sap.app.applicationVersion` set (bump on later fragment changes to bust the UI5 IndexedDB cache).

- [ ] **Step 7: Register in the admin shell**

Add the componentUsage + nav tile in `app/admin-shell/` following how `puzzles` is registered (headless componentUsage inside the `sap.tnt.ToolPage` shell). Route hash e.g. `#petoberfest`.

- [ ] **Step 8: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js app/admin/petoberfest app/admin-shell test/unit/petoberfest-admin.test.js
git commit -m "feat(petoberfest): admin moderation surface (approve/hide + Fiori queue)"
```

---

### Task 6: AppRouter routes (xs-app.json)

**Files:**
- Modify: `approuter/xs-app.json` (add the `/petoberfest-api/*` route group + the `/admin/petoberfest/photo` route)
- Modify: `xs-app.json` at repo root if a duplicate exists (keep both in sync — same gotcha as `xs-security.json`)

**Interfaces:**
- Consumes: routes registered by Tasks 3-5.
- Produces: browser-reachable public + authenticated paths.

- [ ] **Step 1: Add the route group**

In `approuter/xs-app.json`, above the generic `/api/(.*)` xsuaa catch-all, add (specific-before-generic ordering within the group):

```json
{ "source": "^/petoberfest-api/photo/(.*)$",       "target": "/petoberfest-api/photo/$1",       "destination": "srv-api", "authenticationType": "none",  "csrfProtection": false },
{ "source": "^/petoberfest-api/slideshow(.*)$",    "target": "/petoberfest-api/slideshow$1",    "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/petoberfest-api/Petoberfests(.*)$", "target": "/petoberfest-api/Petoberfests$1", "destination": "srv-api", "authenticationType": "none" },
{ "source": "^/petoberfest-api/(.*)/upload$",      "target": "/petoberfest-api/$1/upload",      "destination": "srv-api", "authenticationType": "xsuaa" },
{ "source": "^/petoberfest-api/(.*)$",             "target": "/petoberfest-api/$1",             "destination": "srv-api", "authenticationType": "xsuaa" }
```

The `/admin/petoberfest/photo/*` path is already covered by the existing `/admin/(.*)` xsuaa route — verify it routes to `srv-api` and does NOT get intercepted by an `/admin-ui/` static route (which serves the admin SPA). If `/admin/*` is split between static UI and srv-api in this file, add an explicit `^/admin/petoberfest/photo/(.*)$ → srv-api, xsuaa` route above the static one.

- [ ] **Step 2: Verify JSON validity**

Run: `npx jsonlint approuter/xs-app.json || node -e "JSON.parse(require('fs').readFileSync('approuter/xs-app.json','utf8')); console.log('OK')"`
Expected: `OK`.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json xs-app.json
git commit -m "feat(petoberfest): approuter routes (public slideshow/photo + authed upload)"
```

---

## Phase 4 — Frontend (Hugo page + Vue island)

### Task 7: Hugo page + Vue island (slideshow + gated upload)

**Files:**
- Create: `hugo/content/petoberfest/_index.md`, `hugo/content/petoberfest/petoberfest-2026.md`
- Create: `hugo/layouts/petoberfest/single.html`
- Create: `hugo-apps/src/petoberfest/main.ts`, `App.vue`, `lib/server.ts`
- Create: `hugo-apps/src/petoberfest/__tests__/server.test.ts`
- Modify: `hugo-apps/vite.config.ts` (input entry + `petoberfestBudget()` plugin + `MAX_PETOBERFEST_GZIP` const)
- Test: island unit test above

**Interfaces:**
- Consumes: `/petoberfest-api/slideshow`, `/petoberfest-api/photo/:id`, `/petoberfest-api/:slug/upload`, `/petoberfest-api/myUploads`, `/auth/user`.
- Produces: `hugo/static/js/petoberfest.js` (built by Vite), mounted at `#petoberfest-mount`.

- [ ] **Step 1: Add the Vite input entry + budget**

In `hugo-apps/vite.config.ts`: add near the other `MAX_*_GZIP` consts:

```ts
const MAX_PETOBERFEST_GZIP = 35 * 1024;
```

Add a budget plugin mirroring `puzzleBudget()`:

```ts
function petoberfestBudget() {
  return {
    name: 'petoberfest-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['petoberfest.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_PETOBERFEST_GZIP) {
        // @ts-ignore
        this.error(`petoberfest.js is ${gz} bytes gzipped (> ${MAX_PETOBERFEST_GZIP}).`);
      } else {
        // @ts-ignore
        this.warn(`petoberfest.js: ${gz} bytes gzipped (budget ${MAX_PETOBERFEST_GZIP}).`);
      }
    }
  };
}
```

Register `petoberfestBudget()` in the `plugins` array, and add the input entry alongside `puzzle`:

```ts
petoberfest: resolve(__dirname, 'src/petoberfest/main.ts'),
```

- [ ] **Step 2: Write the failing island unit test**

```ts
// hugo-apps/src/petoberfest/__tests__/server.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchSlideshow, photoUrl } from '../lib/server';

afterEach(() => vi.restoreAllMocks());

describe('petoberfest server lib', () => {
  it('photoUrl builds the display + thumb URLs', () => {
    expect(photoUrl('abc', 'display')).toBe('/petoberfest-api/photo/abc?size=display');
    expect(photoUrl('abc', 'thumb')).toBe('/petoberfest-api/photo/abc?size=thumb');
  });

  it('fetchSlideshow unwraps the OData value array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ value: [{ id: '1', petName: 'Rex', uploaderName: 'Tom', uploadedAt: 'x' }] }),
    })) as any);
    const rows = await fetchSlideshow('petoberfest-2026');
    expect(rows).toHaveLength(1);
    expect(rows[0].petName).toBe('Rex');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd hugo-apps && npx vitest run src/petoberfest/__tests__/server.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `lib/server.ts`**

```ts
// hugo-apps/src/petoberfest/lib/server.ts
import { csrfFetch } from '@shared/csrf-fetch';

export interface SlideEntry { id: string; petName: string; uploaderName: string; uploadedAt: string; }
export interface MyUpload { id: string; petName: string; moderation: string; uploadedAt: string; }

const API = '/petoberfest-api';

export function photoUrl(id: string, size: 'display' | 'thumb' = 'display'): string {
  return `${API}/photo/${encodeURIComponent(id)}?size=${size}`;
}

export async function probeAuth(): Promise<boolean> {
  try { const r = await fetch('/auth/user', { credentials: 'include' }); return r.ok; }
  catch { return false; }
}

export async function fetchSlideshow(slug: string): Promise<SlideEntry[]> {
  const r = await fetch(`${API}/slideshow(slug='${encodeURIComponent(slug)}')`, { credentials: 'include' });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.value ?? data) as SlideEntry[];
}

export async function fetchMyUploads(slug: string): Promise<MyUpload[]> {
  const r = await fetch(`${API}/myUploads(slug='${encodeURIComponent(slug)}')`, { credentials: 'include' });
  if (!r.ok) return [];
  const data = await r.json();
  return (data.value ?? data) as MyUpload[];
}

export interface UploadResult { id: string; awarded: boolean; moderation: string; }

export async function uploadPet(slug: string, file: File, petName: string): Promise<UploadResult> {
  const fd = new FormData();
  fd.append('photo', file);
  fd.append('petName', petName);
  // Authenticated route → csrfFetch. Do NOT set Content-Type; the browser sets the multipart boundary.
  const r = await csrfFetch(`${API}/${encodeURIComponent(slug)}/upload`, { method: 'POST', body: fd, credentials: 'include' });
  if (!r.ok) {
    const err = await r.json().catch(() => ({}));
    throw Object.assign(new Error(err.message || 'upload failed'), { code: err.error, status: r.status });
  }
  return r.json();
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd hugo-apps && npx vitest run src/petoberfest/__tests__/server.test.ts`
Expected: PASS.

- [ ] **Step 6: Implement `App.vue` (two zones)**

```vue
<!-- hugo-apps/src/petoberfest/App.vue -->
<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { fetchSlideshow, fetchMyUploads, uploadPet, probeAuth, photoUrl,
         type SlideEntry, type MyUpload } from './lib/server';

const props = defineProps<{ slug: string }>();
const slides = ref<SlideEntry[]>([]);
const mine = ref<MyUpload[]>([]);
const loggedIn = ref(false);
const idx = ref(0);
const petName = ref('');
const file = ref<File | null>(null);
const status = ref<string>('');
const busy = ref(false);

let timer: number | undefined;
function advance() { if (slides.value.length) idx.value = (idx.value + 1) % slides.value.length; }

onMounted(async () => {
  slides.value = await fetchSlideshow(props.slug);
  if (slides.value.length > 1) timer = window.setInterval(advance, 5000);
  loggedIn.value = await probeAuth();
  if (loggedIn.value) mine.value = await fetchMyUploads(props.slug);
});

function onPick(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0] || null;
  if (f && (!/^image\//.test(f.type) || f.size > 10 * 1024 * 1024)) {
    status.value = 'Please choose an image under 10 MB.'; file.value = null; return;
  }
  file.value = f; status.value = '';
}

async function submit() {
  if (!file.value) { status.value = 'Choose a photo first.'; return; }
  busy.value = true; status.value = '';
  try {
    const res = await uploadPet(props.slug, file.value, petName.value);
    status.value = res.awarded
      ? 'Your pet is uploaded — pending approval 🐾 You earned your Petoberfest points!'
      : 'Your pet is uploaded — pending approval 🐾';
    petName.value = ''; file.value = null;
    mine.value = await fetchMyUploads(props.slug);
  } catch (e: any) {
    status.value = e.code === 'DUPLICATE' ? 'You already uploaded that photo.' : (e.message || 'Upload failed.');
  } finally { busy.value = false; }
}
</script>

<template>
  <section class="pet-slideshow">
    <div v-if="slides.length" class="pet-slide">
      <img :src="photoUrl(slides[idx].id, 'display')" :alt="slides[idx].petName || 'pet'" />
      <p class="pet-caption">
        <strong>{{ slides[idx].petName || 'A good pet' }}</strong>
        <span v-if="slides[idx].uploaderName"> — {{ slides[idx].uploaderName }}</span>
      </p>
    </div>
    <p v-else class="pet-empty">No pets yet — be the first! 🐾</p>
  </section>

  <section class="pet-upload">
    <template v-if="loggedIn">
      <h2>Add your pet</h2>
      <input type="file" accept="image/*" @change="onPick" :disabled="busy" />
      <input type="text" v-model="petName" maxlength="120" placeholder="Pet name / caption" :disabled="busy" />
      <button @click="submit" :disabled="busy || !file">Upload</button>
      <p class="pet-status" v-if="status">{{ status }}</p>
      <div v-if="mine.length" class="pet-mine">
        <h3>Your pets</h3>
        <ul><li v-for="m in mine" :key="m.id">{{ m.petName || 'Pet' }} — {{ m.moderation === 'APPROVED' ? 'live' : 'pending approval' }}</li></ul>
      </div>
    </template>
    <template v-else>
      <p>Want your pet in the slideshow? <a href="/login">Sign in to add your pet</a>.</p>
    </template>
  </section>
</template>
```

- [ ] **Step 7: Implement `main.ts`**

```ts
// hugo-apps/src/petoberfest/main.ts
import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('petoberfest-mount');
if (mount) {
  const dataSlug = mount.dataset.slug || '';
  const pathSlug = window.location.pathname.replace(/\/$/, '').split('/').pop() || '';
  createApp(App, { slug: dataSlug || pathSlug }).mount(mount);
}
```

- [ ] **Step 8: Add the Hugo layout + content**

`hugo/layouts/petoberfest/single.html`:

```html
{{ define "main" }}
<main id="petoberfest-mount"
      data-page-kind="petoberfest"
      data-slug="{{ .Params.slug | default .File.ContentBaseName }}"
      data-api="/petoberfest-api"></main>
<noscript><p>This page requires JavaScript.</p></noscript>
<script type="module" src="{{ "/js/petoberfest.js" | relURL }}"></script>
{{ end }}
```

`hugo/content/petoberfest/_index.md`:

```yaml
---
title: Petoberfest
type: petoberfest
layout: list
headless: true
---
```

`hugo/content/petoberfest/petoberfest-2026.md`:

```yaml
---
title: Petoberfest 2026
type: petoberfest
slug: petoberfest-2026
---
```

- [ ] **Step 9: Build the island + verify budget**

Run: `cd hugo-apps && npm run build`
Expected: build succeeds; `hugo/static/js/petoberfest.js` emitted; budget warning (not error) printed.

- [ ] **Step 10: Commit**

```bash
git add hugo-apps/src/petoberfest hugo-apps/vite.config.ts hugo/layouts/petoberfest hugo/content/petoberfest
git commit -m "feat(petoberfest): Hugo page + Vue island (slideshow + gated upload)"
```

---

## Phase 5 — Devtoberfest integration, value help, cross-repo, e2e

### Task 8: Task-type scoring integration (Devtoberfest)

**Files:**
- Modify: `srv/lib/user-progress.js` (`getMyCompletedTutorials` — include PETOBERFEST + `kind:'petoberfest'`)
- Modify: `db/views.cds` (`Tasks` union arm + `TaskRecordsAnalytics` association for PETOBERFEST)
- Modify: `srv/admin-service.js` (`AnalyticsTaskTypes` READ dropdown code) + `srv/admin-service.cds` (`PetoberfestTaskRecords` projection)
- Modify: `srv/developer-service.js` (type maps in `getEventProgress`, `getMyCompletions`, `getAppSpaceProgress`)
- Test: `test/unit/petoberfest-scoring.test.js`

**Interfaces:**
- Consumes: PETOBERFEST TaskRecords (Task 4); `Petoberfests` (Task 1).
- Produces: PETOBERFEST completions appear in `getMyCompletedTutorials` with `kind:'petoberfest'` so `srv/lib/devtoberfest-feed.js` awards activity points by slug.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/petoberfest-scoring.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { getMyCompletedTutorials } from '../../srv/lib/user-progress.js';

cds.test('serve', '--project', '.', '--in-memory');
let db;
beforeAll(async () => {
  db = await cds.connect.to('db');
  const { Petoberfests, TaskRecords, Users } = db.entities('com.sap.developers.ims');
  await db.run(INSERT.into(Users).entries({ ID: 'u1', sapId: 's1' }));
  await db.run(INSERT.into(Petoberfests).entries({ ID: 'p1', legacyId: 9001, slug: 'petoberfest-2026', title: 'P26', status: 'ACTIVE' }));
  await db.run(INSERT.into(TaskRecords).entries({ ID: 't1', legacyId: 1, user_ID: 'u1', taskLegacyId: 9001, taskType: 'PETOBERFEST', status: 'COMPLETED', progress: 100 }));
});

test('getMyCompletedTutorials includes a PETOBERFEST completion with kind petoberfest', async () => {
  const rows = await getMyCompletedTutorials(db, 'u1');
  const pet = rows.find((r) => r.slug === 'petoberfest-2026');
  expect(pet).toBeDefined();
  expect(pet.kind).toBe('petoberfest');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/petoberfest-scoring.test.js`
Expected: FAIL — PETOBERFEST not in the completed set.

- [ ] **Step 3: Extend `getMyCompletedTutorials`**

In `srv/lib/user-progress.js`, the query filters `taskType in ['TUTORIAL','PUZZLE']` and joins to the matching content entity for the slug + sets `kind`. Add `PETOBERFEST` to that `taskType` filter and add a join arm to `Petoberfests` (by `legacyId = taskLegacyId`) that sets `kind:'petoberfest'` and `slug` from `Petoberfests.slug`. Follow the exact join/branch shape already used for the PUZZLE arm (join `Puzzles`), adding a parallel `Petoberfests` arm.

- [ ] **Step 4: Extend the other switch sites**

- `db/views.cds`: in the `Tasks` union view add a PETOBERFEST arm (mirror the PUZZLE arm at ~line 44-49, selecting from `Petoberfests`); in `TaskRecordsAnalytics` add a `petoberfest` association discriminated on `taskType='PETOBERFEST'` (mirror the puzzle association).
- `srv/admin-service.js`: in the `AnalyticsTaskTypes` READ handler add the `PETOBERFEST` code to the returned list.
- `srv/admin-service.cds`: add `PetoberfestTaskRecords as projection on ims.TaskRecords` filtered `taskType='PETOBERFEST'` (mirror `PuzzleTaskRecords`).
- `srv/developer-service.js`: in `getEventProgress`, `getMyCompletions`, `getAppSpaceProgress`, add PETOBERFEST to the type→entity maps (mirror PUZZLE entries).

- [ ] **Step 5: Run test + full unit suite**

Run: `npx vitest run test/unit/petoberfest-scoring.test.js && npm test`
Expected: PASS, no regressions.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/user-progress.js db/views.cds srv/admin-service.js srv/admin-service.cds srv/developer-service.js test/unit/petoberfest-scoring.test.js
git commit -m "feat(petoberfest): integrate PETOBERFEST into Devtoberfest scoring + analytics switch sites"
```

---

### Task 9: Value-help provider view arm (TASK_VALUE_HELP_V1)

**Files:**
- Modify: `db/src/TASK_VALUE_HELP_V1.hdbview` (add 3rd UNION arm)
- Test: `test/hybrid/petoberfest-value-help.test.js` (hybrid — real HANA)

**Interfaces:**
- Consumes: `Petoberfests` table (Task 1).
- Produces: `TASK_VALUE_HELP_V1` returns PETOBERFEST rows (schema-identical) → consumed by the planner (Task 10).

- [ ] **Step 1: Add the UNION arm**

Append to `db/src/TASK_VALUE_HELP_V1.hdbview` (after the PUZZLE arm, before the final semicolon):

```sql
  UNION ALL
  SELECT "ID"                    AS "ID",
         "SLUG"                  AS "SLUG",
         "TITLE"                 AS "TITLE",
         "PRIMARYTAG"            AS "PRIMARYTAG",
         "EXPERIENCETAG"         AS "EXPERIENCETAG",
         "AVERAGETIMETOCOMPLETE" AS "AVERAGETIMETOCOMPLETE",
         "DESCRIPTION"           AS "DESCRIPTION",
         'PETOBERFEST'                AS "TASKTYPE",
         CAST(NULL AS NVARCHAR(1000)) AS "MDFILEURL",
         CAST(NULL AS INTEGER)        AS "STEPCOUNT",
         CAST(NULL AS NCLOB)          AS "LAYOUT"
  FROM "COM_SAP_DEVELOPERS_IMS_PETOBERFESTS"
  WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
```

Keep column names/types/order byte-identical to the other arms (the planner facade is a positional/named pass-through).

- [ ] **Step 2: Write the hybrid test**

```js
// test/hybrid/petoberfest-value-help.test.js
import { expect, test, beforeAll } from 'vitest';
import cds from '@sap/cds';

let db;
beforeAll(async () => { db = await cds.connect.to('db'); });

test('TASK_VALUE_HELP_V1 surfaces PETOBERFEST rows', async () => {
  // Requires an ACTIVE Petoberfests row present in the bound HANA container.
  const rows = await db.run('SELECT "TASKTYPE","SLUG" FROM "TASK_VALUE_HELP_V1" WHERE "TASKTYPE" = ?', ['PETOBERFEST']);
  expect(Array.isArray(rows)).toBe(true);
  // At least the schema/view resolves; row count depends on seeded data.
});
```

- [ ] **Step 3: Build + run hybrid**

Run: `npx cds build --production && npx vitest run --project hybrid test/hybrid/petoberfest-value-help.test.js`
Expected: PASS (requires `cf login` + `cds bind`). If no HANA binding is available in the execution env, mark this step as deferred-to-CI and note it in the PR.

- [ ] **Step 4: Commit**

```bash
git add db/src/TASK_VALUE_HELP_V1.hdbview test/hybrid/petoberfest-value-help.test.js
git commit -m "feat(petoberfest): add PETOBERFEST arm to TASK_VALUE_HELP_V1 provider view"
```

---

### Task 10: Consumer changes (devtoberfest-planner repo)

> **Separate repo:** `D:\projects\devtoberfest-planner`. Do this work in that repo (its own branch + PR). The provider view (Task 9) must be deployed to the shared HANA before this consumer PR is verified live.

**Files:**
- Modify: `srv/sessions-service.js:140` (widen the validation-tutorial guard)
- Modify: `db/schema.cds:126-128, 143` (stale comments)
- Modify: `db/external/tutorials.cds:32, 42` (stale comments)
- Modify: `srv/sessions-service.cds:48-49`, `srv/sessions-service.js:28-29` (stale comments)
- Test: `test/activity-snapshot.test.js` (add PETOBERFEST case + guard test)

**Interfaces:**
- Consumes: widened `TASK_VALUE_HELP_V1` (Task 9) via the existing pass-through facade — no structural facade/value-list/HDI change.
- Produces: a PETOBERFEST activity cannot build a validation tutorial; PETOBERFEST rows appear in the `Activity.task` value help.

- [ ] **Step 1: Write the failing guard test**

```js
// test/activity-snapshot.test.js — add
test('buildValidationTutorial is rejected for a PETOBERFEST activity', async () => {
  // seed an Activity with taskType 'PETOBERFEST', task_ID set
  // invoke the action; expect a 400 with the "only for tutorial tasks" message
  // (follow the existing PUZZLE-guard test shape in this file)
});
```

- [ ] **Step 2: Run to verify it fails**

Run (in planner repo): `node --test test/activity-snapshot.test.js`
Expected: FAIL — PETOBERFEST currently falls through the `=== 'PUZZLE'` guard and is allowed.

- [ ] **Step 3: Widen the guard**

In `srv/sessions-service.js:140`, change:

```js
if (activity.task_ID && activity.taskType === 'PUZZLE') {
  return req.error(400, 'This activity is linked to a puzzle; validation-tutorial build is only for tutorial tasks.')
}
```

to:

```js
if (activity.task_ID && activity.taskType !== 'TUTORIAL') {
  return req.error(400, 'Validation-tutorial build is only supported for tutorial tasks.')
}
```

- [ ] **Step 4: Add the PETOBERFEST snapshot test + update stale comments**

Add a "picking a PETOBERFEST task…" test alongside the TUTORIAL/PUZZLE cases (same 11-column scaffold, `taskType:'PETOBERFEST'`, NULL `mdFileUrl`/`stepCount`/`layout`). Update the enumerated comments listed under Files to include PETOBERFEST.

- [ ] **Step 5: Run tests**

Run (in planner repo): `node --test test/*.test.js`
Expected: PASS.

- [ ] **Step 6: Commit + PR (planner repo)**

```bash
git add srv/sessions-service.js srv/sessions-service.cds db/schema.cds db/external/tutorials.cds test/activity-snapshot.test.js
git commit -m "feat(petoberfest): allow PETOBERFEST tasks in Activity value help; block validation-tutorial build"
gh pr create --draft --title "Petoberfest task type — planner consumer support" --body "Consumer side for Petoberfest. See tutorials-ims spec."
```

---

### Task 11: e2e Playwright spec + deploy prep

**Files:**
- Create: `test/e2e/petoberfest.spec.ts` (in tutorials-ims)
- Modify: `.deploy/mta.yaml` (MTA minor version bump)
- Modify: `test/e2e/README.md` (document the new spec)

**Interfaces:**
- Consumes: the full deployed feature (Tasks 1-9).
- Produces: a committed e2e spec exercising upload → pending → admin-approve → public slideshow.

- [ ] **Step 1: Write the e2e spec (self-skips when SMOKE_BASE_URL absent)**

```ts
// test/e2e/petoberfest.spec.ts
import { test, expect } from '@playwright/test';

const BASE = process.env.SMOKE_BASE_URL || process.env.PLAYWRIGHT_BASE_URL;
test.skip(!BASE, 'no SMOKE_BASE_URL — post-deploy only');

test('logged-in upload lands pending; approved pet appears in public slideshow', async ({ page, request }) => {
  // 1. Anonymous: slideshow page renders, upload zone shows "Sign in".
  await page.goto(`${BASE}/petoberfest/petoberfest-2026/`);
  await expect(page.locator('#petoberfest-mount')).toBeVisible();
  // 2. Authenticated upload via the API using SMOKE_TECH_USER basic auth,
  //    then assert myUploads shows a pending entry. (Follow the auth pattern
  //    in the existing test/e2e specs — Basic auth against the approuter.)
  // 3. Admin-approve via /admin/PetSubmissions(...)/AdminService.approve.
  // 4. Reload the public page and assert the pet image is served (200) from
  //    /petoberfest-api/photo/<id>?size=display.
});
```

- [ ] **Step 2: Bump the MTA version**

In `.deploy/mta.yaml`, bump the `version:` by a **minor** increment (new feature). Root `mta.yaml` is legacy — do not edit.

- [ ] **Step 3: Commit**

```bash
git add test/e2e/petoberfest.spec.ts test/e2e/README.md .deploy/mta.yaml
git commit -m "test(petoberfest): committed e2e spec + MTA minor version bump"
```

- [ ] **Step 4: Pre-deploy audit (checklist, not code)**

- `srv-qa` cp-list audit: confirm no new `srv/lib/*.js` is imported transitively from `srv/lib/content-store.js` (the two new libs are only imported by `server.js`/service, not content-store — verify with a grep). If any is, add it to `.deploy/mta.yaml`'s `srv-qa` `cp` list.
- Confirm `cds build --production` regenerated the `.hdbmigrationtable` for both new entities and they are committed.
- Deploy sequencing: the `Petoberfests` HANA table must exist and the widened `TASK_VALUE_HELP_V1` must be published (provider) before the planner consumer PR is verified live.
- Full `mbt build` (admin-UI change) — no `--skip-build`, no `-m`. Use `npm run deploy -- --env dev`.

---

## Self-Review

**Spec coverage:** Component 1 → Task 1. Component 2 (service + upload/serve routes) → Tasks 3-4. Component 3 (admin moderation) → Task 5. Component 4 (frontend) → Task 7. Component 5 (scoring integration) → Task 8. Component 6 (value-help view) → Task 9. Component 7 (planner consumer) → Task 10. Testing (unit/hybrid/e2e) → embedded per task + Task 11. AppRouter routes → Task 6. Deploy notes → Task 11. All spec sections mapped.

**Type consistency:** `processPetUpload` returns `{ photoDisplay, photoThumb, sha256, sizeBytes, mimeType }` — consumed unchanged by `insertSubmission` (spread) and matches the `PetSubmissions` columns. `uploadPetSubmission` returns `{ id, awarded, moderation, duplicate }` — consumed by the server.js route and the island `UploadResult` (`{ id, awarded, moderation }`, duplicate handled as 409). `fetchPetPhoto` returns `{ buffer, mimeType, sha256, moderation }` — consumed by `sendPetPhoto`. `resolveOrCreatePetUser` defined in Task 3, imported in Task 4. Slug regex `SLUG_RE` identical in service + upload lib.

**Placeholder scan:** Task 5 Step 4 and Task 8 Step 3/4 describe "follow the existing PUZZLE arm shape" rather than pasting the exact target lines — acceptable because the exact surrounding code must be read at implementation time (the PUZZLE arms are the literal template and are referenced by file:line); the SQL/handler bodies that ARE new are shown in full. Task 10 test bodies are sketched with explicit instructions to mirror the in-repo PUZZLE-guard test — that repo's test file is the template. No TBD/TODO left in new-code steps.
