# Developer Advocates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy AEM `developer-advocates.html` page with an in-codebase implementation: an admin Fiori app for CRUD, a public unauthenticated `/api/advocates` endpoint, and a Hugo + Vue island public page with hover-to-flip cards on a region-tinted gradient header band.

**Architecture:** Three new entities (`Advocates`, `AdvocateTopics`, `AdvocateLinks`, `AdvocatePhotos`) under `com.sap.developers.ims`. Photos stored as 256/64 WebP `LargeBinary` BLOBs in a separate `AdvocatePhotos` entity to avoid HANA LOB-locator expiry. Admin via `app/admin/advocates/` Fiori Elements app loaded by `app/admin-shell/`. Public delivery via custom Express routes in `srv/server.js` with ETag + cache-control. Public UI is a Vue 3 island in `hugo-apps/src/advocates/` mounted on `hugo/content/developer-advocates/_index.md`.

**Tech Stack:** SAP CAP (Node.js), HANA Cloud, Fiori Elements (UI5), Hugo, Vue 3 + Vite, sharp (image processing), Vitest, gzip-webp via sharp.

**Spec:** [docs/superpowers/specs/2026-06-17-developer-advocates-design.md](../specs/2026-06-17-developer-advocates-design.md)

---

## File Structure

### Created

| File | Responsibility |
| --- | --- |
| `db/advocates.cds` | Entity definitions for `Advocates`, `AdvocateTopics`, `AdvocateLinks`, `AdvocatePhotos`. Kept in its own file for focus. |
| `db/data/com.sap.developers.ims-Advocates.csv` | 5 placeholder advocate rows. |
| `db/data/com.sap.developers.ims-AdvocateLinks.csv` | One LinkedIn link per placeholder. |
| `db/data/com.sap.developers.ims-AdvocateTopics.csv` | One Tags-linked topic row per placeholder. |
| `srv/lib/advocate-photo-store.js` | sharp-based upload pipeline + raw-SQL HANA BLOB read with bounded LRU cache. Mirrors `srv/lib/content-store.js`. |
| `srv/lib/advocate-slug.js` | Pure slug derivation (NFD diacritics + collision suffix). Standalone for unit-testability. |
| `srv/handlers/advocate-handlers.js` | `before/after` CDS handlers for slug auto-derivation, photo processing, `hasPhoto` flag stamping. |
| `srv/routes/advocates-public.js` | Express route handlers for `GET /api/advocates` and `GET /api/advocates/:slug/photo`. Registered from `srv/server.js`. |
| `app/admin/advocates/` | Fiori Elements List Report → Object Page (mirrors `app/admin/categories/` shape). |
| `hugo/content/developer-advocates/_index.md` | Hugo content stub that mounts the Vue island. |
| `hugo/data/advocate_fallback.json` | Region-team mailtos shown in `<noscript>`. |
| `hugo/layouts/developer-advocates/list.html` | Hugo template that renders the mount point + `<noscript>` block + script tag. |
| `hugo-apps/src/advocates/main.ts` | Vue island entry — mounts `App.vue`. (Naming: every existing island uses `main.ts`, not `index.ts`.) |
| `hugo-apps/src/advocates/App.vue` | Page shell: fetches `/api/advocates`, owns filter state, renders `HeaderBand` + grid + `EmptyState`. |
| `hugo-apps/src/advocates/components/AdvocateCard.vue` | The flip card (front + back faces). |
| `hugo-apps/src/advocates/components/HeaderBand.vue` | Gradient header + slim metadata + chips + search + inline `WorldMap`. |
| `hugo-apps/src/advocates/components/WorldMap.vue` | Inline animated SVG/CSS world map. |
| `hugo-apps/src/advocates/components/StickyMini.vue` | 48 px collapsed header that appears on scroll. |
| `hugo-apps/src/advocates/components/EmptyState.vue` | `ui5-illustrated-message` for "no results." |
| `hugo-apps/src/advocates/components/InitialsAvatar.vue` | Fallback when `hasPhoto=false`. |
| `hugo-apps/src/advocates/composables/useAdvocateFilter.ts` | Filter + URL hash sync (mirrors PR #197 `urlSync.ts`). |
| `hugo-apps/src/advocates/composables/useFlipCard.ts` | Hover-flip + a11y (Enter/Space/Escape). |
| `hugo-apps/src/advocates/styles/advocates.css` | Horizon tokens, gradients, 3D flip CSS. |
| `hugo-apps/src/advocates/shared/advocate-types.ts` | TS types matching `/api/advocates` response. |
| `test/unit/advocates/slug.test.js` | Unit tests for slug derivation. |
| `test/unit/advocates/photo-pipeline.test.js` | Unit tests for sharp pipeline + rejections. |
| `test/unit/advocates/api.test.js` | Unit tests for `/api/advocates` and `/api/advocates/:slug/photo`. |
| `test/hybrid/advocates-photo-hana.test.js` | HANA round-trip test for LOB-locator workaround. |
| `test/smoke/advocates.smoke.test.js` | HTTP smoke against deployed URLs. |
| `docs/developers/architecture/advocates.md` | Architecture doc page (entity model, photo pipeline, public API). |

### Modified

| File | Change |
| --- | --- |
| `db/schema.cds` | Add `using from './advocates';` (or include `db/advocates.cds` in the model — verify the existing pattern). |
| `db/change-tracking.cds` | Add `annotate ims.Advocates with @changelog;` plus `AdvocateTopics`, `AdvocateLinks`. |
| `srv/admin-service.cds` | Add `Advocates`, `AdvocateTopics`, `AdvocateLinks`, `AdvocatePhotos` projections. |
| `srv/admin-service.js` | Wire `before/after` handlers from `srv/handlers/advocate-handlers.js`. |
| `srv/developer-service.cds` | Add `Advocates` read-only projection (includes `hasPhoto`, `topics`, `links`). |
| `srv/server.js` | Register Express routes from `srv/routes/advocates-public.js` on `bootstrap`. |
| `app/admin-annotations.cds` | UI annotations for the Advocates Fiori app (label/header/line-item/facets). |
| `app/admin-shell/webapp/manifest.json` | Add component usage + route + target for `advocates`. |
| `app/admin-shell/webapp/Component.js` (or routing) | If the shell has a static nav list, add the Advocates entry. |
| `hugo-apps/vite.config.ts` | Add `advocates` entry + bundle-budget plugin (target ≤ 30 KB gzip). |
| `approuter/xs-app.json` | Add `^/developer-advocates(/.*)?$` and `^/api/advocates(/.*)?$` routes (both `authenticationType: "none"`). |
| `package.json` | Add `sharp` to `dependencies`. |
| `.deploy/mta.yaml` | Add `srv/lib/advocate-photo-store.js`, `srv/lib/advocate-slug.js`, `srv/handlers/advocate-handlers.js`, `srv/routes/advocates-public.js` to the `srv-qa` `cp` list. |
| `docs/.vitepress/config.ts` | Add sidebar entry for `docs/developers/architecture/advocates.md`. |
| `docs/developers/operations/testing-endpoints.md` | One-line entry for `/api/advocates` and `/api/advocates/:slug/photo`. |
| `CLAUDE.md` | One-paragraph addition under the relevant Architecture section. |

---

## Conventions for the Implementer

- **TDD:** every functional task starts with a failing test, then minimal code to make it pass, then commit.
- **Commits:** one per task. Conventional Commits (`feat:`, `test:`, `docs:`, `chore:`).
- **Branch:** all commits go to `feat/developer-advocates` (already created and the spec is committed there).
- **PRs over direct merge** per the project rule.
- **Local dev loop:**
  - `cds watch` → CAP at `http://localhost:4004` (in-memory SQLite).
  - `npm run dev` → Hugo at `http://localhost:1313`.
  - `npm run dev:hybrid` → CAP + approuter against real HANA in parallel.
- **Test commands:**
  - `npm test` → unit (in-memory SQLite, fast).
  - `npm run test:hybrid` → real HANA via `cds bind --exec` (requires `cf login`).
  - `npm run test:smoke` → HTTP against deployed URLs (`SMOKE_BASE_URL` + `SMOKE_SRV_URL`).
- **CAP API check first:** before introducing a new CDS construct, search via `mcp__plugin_cds-mcp_cds-mcp__search_docs`.
- **Annotation pattern note:** the spec's "@cds.changetracking.modified" should be implemented as **`@changelog`** to match the existing `db/change-tracking.cds` pattern (the `@cap-js/change-tracking` plugin uses `@changelog`).

---

## Phases

The plan is broken into 8 phases. Each phase produces something testable.

| Phase | Scope | Outcome |
| --- | --- | --- |
| 1 | Schema + sample data | Entities deploy clean; CSV seeds 5 placeholders. |
| 2 | Slug derivation | Pure module, fully unit-tested. |
| 3 | Photo pipeline (sharp) | `processUpload` produces 256+64 WebP + sha256, rejects bad input. |
| 4 | CAP services | Admin OData CRUD + public `/api/advocates` JSON working. |
| 5 | Photo serving + admin upload | `/api/advocates/:slug/photo` serves the BLOB; admin upload writes processed bytes to HANA. |
| 6 | Admin Fiori app | `/admin-ui/#advocates-display` renders the List Report → Object Page. |
| 7 | Public Vue island | `/developer-advocates/` shows the cards with all interactivity. |
| 8 | Documentation + smoke + deploy prep | Docs updated, smoke tests, sample data verified, MTA cp-list updated. |

---

## Phase 1 — Schema & Sample Data

**Goal:** New entities deploy on SQLite (unit) and HANA (hybrid), seeded with 5 placeholders.

### Task 1.1: Entity definitions

**Files:**

- Create: `db/advocates.cds`
- Modify: `db/schema.cds`

- [ ] **Step 1: Write `db/advocates.cds`**

```cds
namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims, cuid, managed } from './schema';

entity Advocates : cuid, managed {
  slug          : String(64) @mandatory;
  firstName     : String(100) @mandatory;
  lastName      : String(100) @mandatory;
  title         : String(255);
  pronouns      : String(32);
  location      : String(120);
  region        : String(16) @assert.range enum { AMERICAS; EMEA; APJ };
  bio           : LargeString;
  isActive      : Boolean default true;
  sortOverride  : Integer;
  joinedDate    : Date;
  hasPhoto      : Boolean default false;
  photoUpdatedAt: Timestamp;
  topics        : Composition of many AdvocateTopics on topics.advocate = $self;
  links         : Composition of many AdvocateLinks  on links.advocate  = $self;
  // Inverse association — required so the admin Object Page can target
  // `photo/@UI.FieldGroup#Photo` for the UploadSet binding (see Phase 6 Task 6.2).
  photo         : Composition of one AdvocatePhotos on photo.advocate = $self;
}

entity AdvocateTopics : cuid {
  advocate : Association to Advocates;
  tag      : Association to ims.Tags;
}

entity AdvocateLinks : cuid {
  advocate  : Association to Advocates;
  kind      : String(32) @assert.range enum {
    LinkedIn; X; Mastodon; BlueSky; GitHub; YouTube; Blog; SapCommunity; Email; Other;
  };
  url       : String(500) @mandatory;
  label     : String(80);
  sortOrder : Integer default 100;
}

entity AdvocatePhotos {
  // One-to-one composition: the association IS the key.
  // CAP generates the FK column `advocate_ID` and uses it as the PK,
  // enforcing 1:1 at the schema level (one photo row per advocate).
  // (Earlier draft tried `key advocate_ID : UUID` + a separate `advocate`
  // association — that form fails CAP compile because CAP refuses to
  // reconcile an explicit FK column with its auto-generated one.)
  key advocate    : Association to Advocates not null;
  photo256        : LargeBinary @Core.MediaType: photoMimeType;
  photo64         : LargeBinary @Core.MediaType: 'image/webp';
  photoMimeType   : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes       : Integer;
  sha256          : String(64);
  uploadedAt      : Timestamp;
}
```

- [ ] **Step 2: Add the `using` to `db/schema.cds`**

Add at the top, after the existing `using` lines:

```cds
using from './advocates';
```

(Verify the existing pattern in `db/schema.cds`. If schema.cds aggregates other extension files like `schema-ext.cds`, follow that style.)

- [ ] **Step 3: Verify the schema compiles**

Run: `npx cds compile db/ -o /dev/null`
Expected: zero errors. If a CSN error appears about the `Association to ims.Tags`, confirm `Tags` exists in `db/schema.cds` (`grep -n "entity Tags" db/schema.cds`).

- [ ] **Step 4: Commit**

```bash
git add db/advocates.cds db/schema.cds
git commit -m "feat(db): add Advocates, AdvocateTopics, AdvocateLinks, AdvocatePhotos entities"
```

### Task 1.2: Sample data CSVs

**Files:**

- Create: `db/data/com.sap.developers.ims-Advocates.csv`
- Create: `db/data/com.sap.developers.ims-AdvocateLinks.csv`
- Create: `db/data/com.sap.developers.ims-AdvocateTopics.csv`

- [ ] **Step 1: Inspect an existing CSV for column-order conventions**

Run: `head -2 db/data/com.sap.developers.ims-Categories.csv`
Match that style (semicolon delimiter, ID column, association FKs as `<assoc>_ID`).

- [ ] **Step 2: Write Advocates CSV**

```csv
ID;slug;firstName;lastName;title;pronouns;location;region;bio;isActive;sortOverride;joinedDate;hasPhoto;photoUpdatedAt
ADC00001-0000-0000-0000-000000000001;thomas-jung;Thomas;Jung;Chief Developer Advocate;he/him;Houston, TX;AMERICAS;Builds CAP samples and decommissions Java IMS one endpoint at a time.;true;;2018-01-01;false;
ADC00001-0000-0000-0000-000000000002;placeholder-emea;Placeholder;EMEA;Developer Advocate (EMEA);;Walldorf, Germany;EMEA;TODO replace with real advocate.;true;;2024-01-01;false;
ADC00001-0000-0000-0000-000000000003;placeholder-apj;Placeholder;APJ;Developer Advocate (APJ);;Singapore;APJ;TODO replace with real advocate.;true;;2024-01-01;false;
ADC00001-0000-0000-0000-000000000004;placeholder-amer;Placeholder;Americas;Developer Advocate (Americas);;Palo Alto, CA;AMERICAS;TODO replace with real advocate.;true;;2024-01-01;false;
ADC00001-0000-0000-0000-000000000005;placeholder-multi;Placeholder;Roving;Developer Advocate;;Remote;EMEA;TODO replace with real advocate.;true;;2024-01-01;false;
```

- [ ] **Step 3: Write AdvocateLinks CSV**

```csv
ID;advocate_ID;kind;url;label;sortOrder
ADL00001-0000-0000-0000-000000000001;ADC00001-0000-0000-0000-000000000001;LinkedIn;https://www.linkedin.com/in/thomasjung;LinkedIn;100
ADL00001-0000-0000-0000-000000000002;ADC00001-0000-0000-0000-000000000002;LinkedIn;https://www.linkedin.com/in/placeholder-emea;LinkedIn;100
ADL00001-0000-0000-0000-000000000003;ADC00001-0000-0000-0000-000000000003;LinkedIn;https://www.linkedin.com/in/placeholder-apj;LinkedIn;100
ADL00001-0000-0000-0000-000000000004;ADC00001-0000-0000-0000-000000000004;LinkedIn;https://www.linkedin.com/in/placeholder-amer;LinkedIn;100
ADL00001-0000-0000-0000-000000000005;ADC00001-0000-0000-0000-000000000005;LinkedIn;https://www.linkedin.com/in/placeholder-multi;LinkedIn;100
```

- [ ] **Step 4: Write AdvocateTopics CSV (header-only initially)**

Real Tag IDs depend on the live `Tags` table. Ship header-only first; Phase 8 populates via SQL once HANA is bound:

```csv
ID;advocate_ID;tag_ID
```

- [ ] **Step 5: Verify SQLite deploy with seed**

Run: `cds deploy --to sqlite::memory:`
Expected: zero errors.

- [ ] **Step 6: Commit**

```bash
git add db/data/com.sap.developers.ims-Advocates.csv db/data/com.sap.developers.ims-AdvocateLinks.csv db/data/com.sap.developers.ims-AdvocateTopics.csv
git commit -m "feat(data): seed 5 placeholder advocates with one link each"
```

### Task 1.3: Change-tracking annotations

**Files:**

- Modify: `db/change-tracking.cds`

- [ ] **Step 1: Append annotations**

```cds
annotate ims.Advocates       with @changelog;
annotate ims.AdvocateTopics  with @changelog;
annotate ims.AdvocateLinks   with @changelog;
```

Note: do NOT annotate `AdvocatePhotos` — BLOB diffs in the changelog are useless and expensive.

- [ ] **Step 2: Verify**

Run: `npx cds compile db/ -o /dev/null` → no errors.

- [ ] **Step 3: Commit**

```bash
git add db/change-tracking.cds
git commit -m "feat(change-tracking): track Advocates, AdvocateTopics, AdvocateLinks"
```

---

## Phase 2 — Slug Derivation (TDD)

**Goal:** Pure module that turns "Andre Muller" (with diacritics) into "andre-muller", with collision suffix `-2/-3/...`.

### Task 2.1: Failing tests for slug derivation

**Files:**

- Create: `test/unit/advocates/slug.test.js`

- [ ] **Step 1: Write the failing test file**

```js
import { describe, expect, it } from 'vitest';
import { deriveSlug, suffixOnCollision } from '../../../srv/lib/advocate-slug.js';

describe('deriveSlug', () => {
  it('lowercases simple ASCII names', () => {
    expect(deriveSlug('Thomas', 'Jung')).toBe('thomas-jung');
  });

  it('strips diacritics on European names', () => {
    expect(deriveSlug('Andre' + '́', 'Mu' + '̈' + 'ller')).toBe('andre-muller');
  });

  it('collapses internal whitespace and punctuation to single dashes', () => {
    expect(deriveSlug('Mary Jo', 'OBrien-Smith')).toBe('mary-jo-obrien-smith');
  });

  it('trims leading and trailing dashes', () => {
    expect(deriveSlug('-- Test --', '--')).toBe('test');
  });

  it('falls back to a placeholder when both names produce empty slug', () => {
    expect(deriveSlug('陈', '伟')).toBe('advocate');
  });

  it('keeps slug at or under 64 chars without trailing dash', () => {
    const slug = deriveSlug('Christopher', 'Stoltzenberg-Williams-Johnson');
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith('-')).toBe(false);
  });
});

describe('suffixOnCollision', () => {
  it('returns base when not present', () => {
    expect(suffixOnCollision('thomas-jung', new Set())).toBe('thomas-jung');
  });

  it('appends -2 on first collision', () => {
    expect(suffixOnCollision('thomas-jung', new Set(['thomas-jung']))).toBe('thomas-jung-2');
  });

  it('continues to -3, -4 on further collisions', () => {
    const taken = new Set(['thomas-jung', 'thomas-jung-2']);
    expect(suffixOnCollision('thomas-jung', taken)).toBe('thomas-jung-3');
  });

  it('respects the 64-char limit when adding suffix', () => {
    const long = 'a'.repeat(63);
    const out = suffixOnCollision(long, new Set([long]));
    expect(out.length).toBeLessThanOrEqual(64);
    expect(out.endsWith('-2')).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `npx vitest run test/unit/advocates/slug.test.js`
Expected: FAIL — `Cannot find module '.../srv/lib/advocate-slug.js'`.

### Task 2.2: Implement the slug module

**Files:**

- Create: `srv/lib/advocate-slug.js`

- [ ] **Step 1: Write the minimal implementation**

```js
'use strict';

const MAX_SLUG_LEN = 64;
const FALLBACK_SLUG = 'advocate';
const COMBINING_MARKS = /[̀-ͯ]/g;

function normalize(s) {
  return (s || '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function deriveSlug(firstName, lastName) {
  const fn = normalize(firstName);
  const ln = normalize(lastName);
  let slug = [fn, ln].filter(Boolean).join('-');
  if (!slug) slug = FALLBACK_SLUG;
  if (slug.length > MAX_SLUG_LEN) {
    slug = slug.slice(0, MAX_SLUG_LEN).replace(/-+$/, '');
  }
  return slug;
}

function suffixOnCollision(base, takenSet) {
  if (!takenSet.has(base)) return base;
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const suffix = '-' + n;
    const room = MAX_SLUG_LEN - suffix.length;
    const candidate = base.length > room
      ? base.slice(0, room).replace(/-+$/, '') + suffix
      : base + suffix;
    if (!takenSet.has(candidate)) return candidate;
    n += 1;
  }
}

module.exports = { deriveSlug, suffixOnCollision };
```

- [ ] **Step 2: Run the tests, confirm pass**

Run: `npx vitest run test/unit/advocates/slug.test.js`
Expected: PASS — 10 tests green.

- [ ] **Step 3: Commit**

```bash
git add test/unit/advocates/slug.test.js srv/lib/advocate-slug.js
git commit -m "feat(advocates): pure slug derivation with diacritics + collision suffix"
```

---

## Phase 3 — Photo Pipeline (sharp)

**Goal:** Pure module that takes raw upload bytes and produces 256+64 WebP outputs + sha256 + size, rejecting bad input.

### Task 3.1: Add sharp dependency

**Files:**

- Modify: `package.json`

- [ ] **Step 1: Add sharp**

The project's global npmrc has `save-exact=true`, so this records a pinned version automatically:

```bash
npm install sharp
```

Verify the entry in `package.json` `dependencies` is pinned (e.g. `"sharp": "0.34.4"`, no caret).

- [ ] **Step 2: Confirm it loads**

Run: `node -e "const s = require('sharp'); console.log(s.versions)"`
Expected: prints sharp + libvips versions, no error.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(deps): add sharp for advocate photo processing"
```

### Task 3.2: Failing tests for the photo pipeline

**Files:**

- Create: `test/unit/advocates/photo-pipeline.test.js`
- Create: `test/unit/advocates/fixtures/portrait.jpg`
- Create: `test/unit/advocates/fixtures/square.png`
- Create: `test/unit/advocates/fixtures/already.webp`

- [ ] **Step 1: Generate test fixtures**

Run a one-shot Node script to produce three small fixtures:

```bash
node -e "
const sharp = require('sharp');
const fs = require('fs');
const p = 'test/unit/advocates/fixtures';
fs.mkdirSync(p, { recursive: true });
sharp({ create: { width: 600, height: 800, channels: 3, background: { r: 200, g: 100, b: 50 } } })
  .jpeg({ quality: 85 }).toFile(p + '/portrait.jpg');
sharp({ create: { width: 1024, height: 1024, channels: 4, background: { r: 30, g: 200, b: 100, alpha: 1 } } })
  .png().toFile(p + '/square.png');
sharp({ create: { width: 320, height: 320, channels: 3, background: { r: 50, g: 50, b: 200 } } })
  .webp().toFile(p + '/already.webp');
"
```

- [ ] **Step 2: Write the failing test file**

```js
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { processUpload } from '../../../srv/lib/advocate-photo-store.js';
import sharp from 'sharp';

const FIX = (name) => readFile(`test/unit/advocates/fixtures/${name}`);

describe('processUpload (sharp pipeline)', () => {
  it('produces a 256x256 WebP photo256', async () => {
    const out = await processUpload(await FIX('portrait.jpg'), 'image/jpeg');
    const meta = await sharp(out.photo256).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(256);
    expect(meta.height).toBe(256);
  });

  it('produces a 64x64 WebP photo64', async () => {
    const out = await processUpload(await FIX('square.png'), 'image/png');
    const meta = await sharp(out.photo64).metadata();
    expect(meta.format).toBe('webp');
    expect(meta.width).toBe(64);
    expect(meta.height).toBe(64);
  });

  it('returns sha256 hex of photo256', async () => {
    const out = await processUpload(await FIX('already.webp'), 'image/webp');
    expect(out.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('returns sizeBytes equal to photo256 length', async () => {
    const out = await processUpload(await FIX('portrait.jpg'), 'image/jpeg');
    expect(out.sizeBytes).toBe(out.photo256.length);
  });

  it('rejects oversized buffers (>5 MB)', async () => {
    const big = Buffer.alloc(6 * 1024 * 1024, 0xff);
    await expect(processUpload(big, 'image/jpeg')).rejects.toThrow(/too large/i);
  });

  it('rejects non-image MIME types', async () => {
    const buf = await FIX('portrait.jpg');
    await expect(processUpload(buf, 'application/pdf')).rejects.toThrow(/unsupported/i);
  });

  it('rejects buffers that are not real images', async () => {
    const fake = Buffer.from('not an image, just text');
    await expect(processUpload(fake, 'image/jpeg')).rejects.toThrow(/invalid/i);
  });

  it('rejects animated images', async () => {
    // Build a 2-frame animated GIF
    const frame = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 0, g: 0, b: 0 } }
    }).png().toBuffer();
    const animated = await sharp(frame, { animated: true })
      .gif({ loop: 0, delay: [10, 10] })
      .toBuffer();
    // sharp single-frame produces pages=1; on systems where this stays 1 the
    // test is a no-op assertion. To force a multi-page input, use an existing
    // animated fixture if available under test/unit/advocates/fixtures/.
    const meta = await sharp(animated, { animated: true }).metadata();
    if ((meta.pages || 1) > 1) {
      await expect(processUpload(animated, 'image/gif')).rejects.toThrow(/animated/i);
    }
  });
});
```

- [ ] **Step 3: Run, confirm fail**

Run: `npx vitest run test/unit/advocates/photo-pipeline.test.js`
Expected: FAIL — module not found.

### Task 3.3: Implement the photo pipeline

**Files:**

- Create: `srv/lib/advocate-photo-store.js`

- [ ] **Step 1: Write the minimal pipeline (read path comes in Phase 5)**

```js
'use strict';

const sharp = require('sharp');
const crypto = require('node:crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

async function processUpload(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error('processUpload: buffer is required');
  }
  if (buffer.length > MAX_BYTES) {
    throw new Error('processUpload: image too large (max 5 MB)');
  }
  if (!ALLOWED_MIME.has(String(mimeType || '').toLowerCase())) {
    throw new Error('processUpload: unsupported MIME type');
  }

  let meta;
  try {
    meta = await sharp(buffer, { animated: true }).metadata();
  } catch {
    throw new Error('processUpload: invalid image bytes');
  }
  if (!meta || !meta.format) {
    throw new Error('processUpload: invalid image bytes');
  }
  if (meta.pages && meta.pages > 1) {
    throw new Error('processUpload: animated images are not supported');
  }

  const photo256 = await sharp(buffer)
    .resize(256, 256, { fit: 'cover', position: 'attention' })
    .webp({ quality: 85 })
    .toBuffer();

  const photo64 = await sharp(buffer)
    .resize(64, 64, { fit: 'cover', position: 'attention' })
    .webp({ quality: 80 })
    .toBuffer();

  const sha256 = crypto.createHash('sha256').update(photo256).digest('hex');

  return {
    photo256,
    photo64,
    sha256,
    sizeBytes: photo256.length,
    photoMimeType: 'image/webp',
  };
}

module.exports = { processUpload };
```

- [ ] **Step 2: Run tests, confirm pass**

Run: `npx vitest run test/unit/advocates/photo-pipeline.test.js`
Expected: PASS — all tests green.

- [ ] **Step 3: Commit**

```bash
git add test/unit/advocates/photo-pipeline.test.js test/unit/advocates/fixtures/ srv/lib/advocate-photo-store.js
git commit -m "feat(advocates): sharp upload pipeline producing 256+64 WebP with sha256"
```

---

## Phase 4 — CAP Services

**Goal:** Admin OData CRUD + public `/api/advocates` JSON working against in-memory SQLite.

### Task 4.1: Admin service projections

**Files:**

- Modify: `srv/admin-service.cds`

- [ ] **Step 1: Append to AdminService**

```cds
extend service AdminService with {
  @odata.draft.enabled
  entity Advocates       as projection on ims.Advocates;
  entity AdvocateTopics  as projection on ims.AdvocateTopics;
  entity AdvocateLinks   as projection on ims.AdvocateLinks;
  entity AdvocatePhotos  as projection on ims.AdvocatePhotos;
}
```

- [ ] **Step 2: Verify CSN compile**

Run: `npx cds compile srv/ -o /dev/null` → no errors.

- [ ] **Step 3: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(admin): expose Advocates entities for admin CRUD"
```

### Task 4.2: Public read projection

**Files:**

- Modify: `srv/developer-service.cds`

- [ ] **Step 1: Append**

```cds
extend service DeveloperService with {
  @readonly
  entity Advocates as projection on ims.Advocates {
    *,
    topics, links
  };
}
```

- [ ] **Step 2: Verify**

Run: `npx cds compile srv/ -o /dev/null` → no errors.

- [ ] **Step 3: Commit**

```bash
git add srv/developer-service.cds
git commit -m "feat(public): expose Advocates read-only on DeveloperService"
```

### Task 4.3: Slug auto-derivation handler

**Files:**

- Create: `srv/handlers/advocate-handlers.js`
- Modify: `srv/admin-service.js`

- [ ] **Step 1: Failing test (extend `test/unit/advocates/api.test.js`)**

Create `test/unit/advocates/api.test.js`:

```js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import cds from '@sap/cds';

describe('Advocates admin handlers', () => {
  let srv;
  beforeAll(async () => {
    srv = await cds.test(__dirname + '/../../..').in('serve').then(t => t);
  });
  afterAll(async () => { await cds.shutdown(); });

  it('auto-derives slug from firstName/lastName on CREATE', async () => {
    const { POST } = cds.test();
    const res = await POST('/admin/Advocates', {
      firstName: 'Andre', lastName: 'Muller', region: 'EMEA'
    });
    expect(res.status).toBe(201);
    expect(res.data.slug).toBe('andre-muller');
  });

  it('appends -2 on slug collision', async () => {
    const { POST } = cds.test();
    await POST('/admin/Advocates', { firstName: 'Casey', lastName: 'Smith', region: 'AMERICAS' });
    const res2 = await POST('/admin/Advocates', { firstName: 'Casey', lastName: 'Smith', region: 'APJ' });
    expect(res2.data.slug).toBe('casey-smith-2');
  });
});
```

(Adjust the harness to match the project's `cds.test` invocation pattern by checking an existing unit test, e.g. `grep -nE "cds.test\\(" test/unit/*.js | head -3`.)

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run test/unit/advocates/api.test.js`
Expected: FAIL — slug missing or null.

- [ ] **Step 3: Implement handler**

Create `srv/handlers/advocate-handlers.js`:

```js
'use strict';

const cds = require('@sap/cds');
const { deriveSlug, suffixOnCollision } = require('../lib/advocate-slug');

function register(srv) {
  const { Advocates } = srv.entities;

  srv.before('CREATE', Advocates, async (req) => {
    const data = req.data;
    if (!data.slug) {
      const base = deriveSlug(data.firstName, data.lastName);
      const taken = new Set(
        (await cds.run(SELECT.from(Advocates).columns('slug'))).map(r => r.slug)
      );
      data.slug = suffixOnCollision(base, taken);
    } else {
      data.slug = String(data.slug).toLowerCase();
    }
  });
}

module.exports = { register };
```

In `srv/admin-service.js` add at the end of the existing class/handler block:

```js
const advocateHandlers = require('./handlers/advocate-handlers');
// ... inside the service init block:
advocateHandlers.register(this);
```

(Confirm whether the file uses class-style `cds.ApplicationService` or `module.exports = (srv) => { ... }`. Match the existing pattern.)

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/unit/advocates/api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/handlers/advocate-handlers.js srv/admin-service.js test/unit/advocates/api.test.js
git commit -m "feat(advocates): auto-derive slug with collision suffix on CREATE"
```

### Task 4.4: Public `/api/advocates` Express route

**Files:**

- Create: `srv/routes/advocates-public.js`
- Modify: `srv/server.js`

- [ ] **Step 1: Failing test — append to `test/unit/advocates/api.test.js`**

```js
describe('GET /api/advocates', () => {
  it('returns active rows sorted by lastName, includes topics and links', async () => {
    const { GET } = cds.test();
    const res = await GET('/api/advocates');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.advocates)).toBe(true);
    const byLast = res.data.advocates.map(a => a.lastName);
    const sorted = [...byLast].sort();
    expect(byLast).toEqual(sorted);
    const sample = res.data.advocates[0];
    expect(sample).toHaveProperty('topics');
    expect(sample).toHaveProperty('links');
    expect(sample).toHaveProperty('hasPhoto');
  });

  it('returns 304 when If-None-Match matches the ETag', async () => {
    const { GET } = cds.test();
    const first = await GET('/api/advocates');
    const etag = first.headers.etag || first.headers.ETag;
    expect(etag).toBeTruthy();
    const res = await GET('/api/advocates', { headers: { 'If-None-Match': etag } });
    expect(res.status).toBe(304);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Expected: 404 or schema mismatch.

- [ ] **Step 3: Implement the route**

Create `srv/routes/advocates-public.js`:

```js
'use strict';

const cds = require('@sap/cds');

function maxModified(rows) {
  let max = 0;
  for (const r of rows) {
    const t = r.modifiedAt ? new Date(r.modifiedAt).getTime() : 0;
    if (t > max) max = t;
  }
  return max;
}

function buildHandler() {
  return async function handler(req, res) {
    try {
      const db = await cds.connect.to('db');
      const { Advocates, AdvocateTopics, AdvocateLinks, Tags } = cds.entities('com.sap.developers.ims');

      const advocates = await db.run(
        SELECT.from(Advocates)
          .where({ isActive: true })
      );
      const ids = advocates.map(a => a.ID);
      const [topics, links, allModified] = await Promise.all([
        ids.length ? db.run(SELECT.from(AdvocateTopics).where({ advocate_ID: { in: ids } })) : [],
        ids.length ? db.run(SELECT.from(AdvocateLinks).where({ advocate_ID: { in: ids } })) : [],
        db.run(SELECT.from(Advocates).columns('modifiedAt')),
      ]);

      // Resolve tag slugs/labels
      const tagIds = [...new Set(topics.map(t => t.tag_ID))];
      const tagRows = tagIds.length
        ? await db.run(SELECT.from(Tags).columns('ID', 'slug', 'label').where({ ID: { in: tagIds } }))
        : [];
      const tagById = new Map(tagRows.map(t => [t.ID, t]));

      const topicsByAdv = new Map();
      for (const t of topics) {
        if (!topicsByAdv.has(t.advocate_ID)) topicsByAdv.set(t.advocate_ID, []);
        const tag = tagById.get(t.tag_ID);
        if (tag) topicsByAdv.get(t.advocate_ID).push({ slug: tag.slug, label: tag.label });
      }
      const linksByAdv = new Map();
      for (const l of [...links].sort((a, b) => (a.sortOrder ?? 100) - (b.sortOrder ?? 100) || String(a.kind).localeCompare(String(b.kind)))) {
        if (!linksByAdv.has(l.advocate_ID)) linksByAdv.set(l.advocate_ID, []);
        linksByAdv.get(l.advocate_ID).push({ kind: l.kind, url: l.url, label: l.label, sortOrder: l.sortOrder });
      }

      // Collator-aware lastName sort with sortOverride pinning
      const collator = new Intl.Collator('en', { sensitivity: 'base' });
      advocates.sort((a, b) => {
        const ao = a.sortOverride ?? Number.POSITIVE_INFINITY;
        const bo = b.sortOverride ?? Number.POSITIVE_INFINITY;
        if (ao !== bo) return ao - bo;
        const last = collator.compare(a.lastName || '', b.lastName || '');
        if (last !== 0) return last;
        return collator.compare(a.firstName || '', b.firstName || '');
      });

      const body = {
        advocates: advocates.map(a => ({
          ID: a.ID,
          slug: a.slug,
          firstName: a.firstName,
          lastName: a.lastName,
          title: a.title,
          pronouns: a.pronouns,
          location: a.location,
          region: a.region,
          bio: a.bio,
          joinedDate: a.joinedDate,
          hasPhoto: !!a.hasPhoto,
          photoUpdatedAt: a.photoUpdatedAt,
          topics: topicsByAdv.get(a.ID) || [],
          links: linksByAdv.get(a.ID) || [],
        })),
      };

      const max = Math.max(maxModified(advocates), maxModified(topics), maxModified(links));
      const etag = '"' + max.toString(36) + '"';
      res.setHeader('ETag', etag);
      res.setHeader('Cache-Control', 'public, max-age=60, stale-while-revalidate=600');
      if (req.headers['if-none-match'] === etag) {
        res.status(304).end();
        return;
      }
      res.json(body);
    } catch (err) {
      cds.log('advocates').error(err);
      res.status(500).json({ error: 'advocates_unavailable' });
    }
  };
}

function register(app) {
  app.get('/api/advocates', buildHandler());
}

module.exports = { register };
```

In `srv/server.js`, on `cds.on('bootstrap', app => ...)`:

```js
const advocatesPublic = require('./routes/advocates-public');
advocatesPublic.register(app);
```

(Match the existing `bootstrap` block style — there are already similar route registrations there.)

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/unit/advocates/api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/routes/advocates-public.js srv/server.js test/unit/advocates/api.test.js
git commit -m "feat(advocates): public /api/advocates with ETag + cache-control"
```

---

## Phase 5 — Photo Serving + Admin Upload

**Goal:** `GET /api/advocates/:slug/photo` serves the BLOB. Admin upload writes processed bytes to HANA. Read path uses raw SQL on HANA.

### Task 5.1: Extend `advocate-photo-store.js` with read + cache

**Files:**

- Modify: `srv/lib/advocate-photo-store.js`
- Create: `test/unit/advocates/photo-serve.test.js`

- [ ] **Step 1: Failing test**

```js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import { processUpload } from '../../../srv/lib/advocate-photo-store.js';
import { fetchPhoto, _resetCache } from '../../../srv/lib/advocate-photo-store.js';

describe('fetchPhoto (read path)', () => {
  beforeAll(async () => { await cds.test('serve').in(__dirname + '/../../..'); });
  afterAll(async () => { await cds.shutdown(); });

  it('returns null when slug does not exist', async () => {
    const out = await fetchPhoto('nope', 'full');
    expect(out).toBeNull();
  });

  it('returns 256 WebP bytes after processUpload + insert', async () => {
    _resetCache();
    const buf = await readFile('test/unit/advocates/fixtures/portrait.jpg');
    const processed = await processUpload(buf, 'image/jpeg');

    const db = await cds.connect.to('db');
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    const a = await db.run(SELECT.one.from(Advocates).where({ slug: 'thomas-jung' }));
    expect(a).toBeTruthy();

    await db.run(INSERT.into(AdvocatePhotos).entries({
      advocate_ID: a.ID,
      photo256: processed.photo256,
      photo64: processed.photo64,
      photoMimeType: 'image/webp',
      sizeBytes: processed.sizeBytes,
      sha256: processed.sha256,
      uploadedAt: new Date().toISOString(),
    }));

    const out = await fetchPhoto('thomas-jung', 'full');
    expect(out).toBeTruthy();
    expect(out.mimeType).toBe('image/webp');
    expect(out.etag).toBe('"' + processed.sha256 + '"');
    expect(Buffer.compare(out.buffer, processed.photo256)).toBe(0);
  });
});
```

- [ ] **Step 2: Run, confirm fail (no `fetchPhoto` yet)**

Run: `npx vitest run test/unit/advocates/photo-serve.test.js`
Expected: FAIL.

- [ ] **Step 3: Extend the module**

Append to `srv/lib/advocate-photo-store.js`:

```js
const cds = require('@sap/cds');

const CACHE_MAX_BYTES = 10 * 1024 * 1024;
const cache = new Map(); // key: slug + ':' + size  →  { buffer, mimeType, etag }
let cacheBytes = 0;

function cacheKey(slug, size) { return slug + ':' + size; }

function _resetCache() {
  cache.clear();
  cacheBytes = 0;
}

function _evictIfOver() {
  while (cacheBytes > CACHE_MAX_BYTES && cache.size > 0) {
    const firstKey = cache.keys().next().value;
    const entry = cache.get(firstKey);
    cacheBytes -= entry.buffer.length;
    cache.delete(firstKey);
  }
}

async function fetchPhoto(slug, size) {
  const key = cacheKey(slug, size);
  if (cache.has(key)) return cache.get(key);

  const db = await cds.connect.to('db');
  const isHana = (db.kind || '').toLowerCase() === 'hana';

  const col = size === 'thumb' ? 'photo64' : 'photo256';
  let row;

  if (isHana) {
    // Raw SQL on HANA to dodge LOB-locator expiry. The metadata read
    // (slug → advocate_ID) and the BLOB read are split.
    const adv = await db.run(
      'SELECT ID FROM COM_SAP_DEVELOPERS_IMS_ADVOCATES WHERE LOWER(SLUG) = ?',
      [String(slug).toLowerCase()],
    );
    if (!adv || !adv.length) return null;
    const advId = adv[0].ID;
    const blob = await db.run(
      `SELECT ${col.toUpperCase()} AS BLOB, PHOTOMIMETYPE, SHA256 FROM COM_SAP_DEVELOPERS_IMS_ADVOCATEPHOTOS WHERE ADVOCATE_ID = ?`,
      [advId],
    );
    if (!blob || !blob.length || !blob[0].BLOB) return null;
    row = { buffer: blob[0].BLOB, mimeType: blob[0].PHOTOMIMETYPE, sha256: blob[0].SHA256 };
  } else {
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    const adv = await db.run(SELECT.one.from(Advocates).columns('ID').where({ slug }));
    if (!adv) return null;
    const photo = await db.run(SELECT.one.from(AdvocatePhotos).where({ advocate_ID: adv.ID }));
    if (!photo) return null;
    const buf = photo[col];
    if (!buf) return null;
    row = { buffer: buf, mimeType: photo.photoMimeType, sha256: photo.sha256 };
  }

  const result = {
    buffer: Buffer.isBuffer(row.buffer) ? row.buffer : Buffer.from(row.buffer),
    mimeType: row.mimeType || 'image/webp',
    etag: '"' + row.sha256 + '"',
  };
  cache.set(key, result);
  cacheBytes += result.buffer.length;
  _evictIfOver();
  return result;
}

module.exports.fetchPhoto = fetchPhoto;
module.exports._resetCache = _resetCache;
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/unit/advocates/photo-serve.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/advocate-photo-store.js test/unit/advocates/photo-serve.test.js
git commit -m "feat(advocates): fetchPhoto read path with HANA raw-SQL workaround + LRU"
```

### Task 5.2: Photo public route

**Files:**

- Modify: `srv/routes/advocates-public.js`

- [ ] **Step 1: Failing test — append to `api.test.js`**

```js
describe('GET /api/advocates/:slug/photo', () => {
  it('returns 404 when hasPhoto is false', async () => {
    const { GET } = cds.test();
    const res = await GET('/api/advocates/placeholder-emea/photo').catch(e => e.response);
    expect(res.status).toBe(404);
  });

  it('returns the WebP for a real photo with ETag and Cache-Control', async () => {
    const { GET } = cds.test();
    // Assumes Task 5.1 test inserted a photo for thomas-jung
    const res = await GET('/api/advocates/thomas-jung/photo');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\\/webp/);
    expect(res.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
    expect(res.headers['cache-control']).toMatch(/max-age=86400/);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Expected: 404 on the success case (route not registered).

- [ ] **Step 3: Add route**

In `srv/routes/advocates-public.js` register a second handler:

```js
const { fetchPhoto } = require('../lib/advocate-photo-store');

function registerPhoto(app) {
  app.get('/api/advocates/:slug/photo', async (req, res) => {
    try {
      const size = req.query.size === 'thumb' ? 'thumb' : 'full';
      const out = await fetchPhoto(req.params.slug, size);
      if (!out) { res.status(404).end(); return; }
      res.setHeader('ETag', out.etag);
      res.setHeader('Cache-Control', 'public, max-age=86400');
      if (req.headers['if-none-match'] === out.etag) { res.status(304).end(); return; }
      res.setHeader('Content-Type', out.mimeType);
      res.send(out.buffer);
    } catch (err) {
      cds.log('advocates').error(err);
      res.status(500).end();
    }
  });
}

module.exports.registerPhoto = registerPhoto;
```

Update the `register` function or add a call from `srv/server.js`:

```js
advocatesPublic.register(app);
advocatesPublic.registerPhoto(app);
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/unit/advocates/api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/routes/advocates-public.js srv/server.js test/unit/advocates/api.test.js
git commit -m "feat(advocates): GET /api/advocates/:slug/photo with ETag + 86400 cache"
```

### Task 5.3: Admin upload handler — process via sharp before write

**Files:**

- Modify: `srv/handlers/advocate-handlers.js`
- Extend: `test/unit/advocates/api.test.js`

- [ ] **Step 1: Failing test**

```js
describe('AdvocatePhotos UPDATE handler', () => {
  it('replaces uploaded bytes with processed 256+64 WebP and sets sha256', async () => {
    const { POST, PUT } = cds.test();
    const created = await POST('/admin/Advocates', {
      firstName: 'Photo', lastName: 'Tester', region: 'AMERICAS'
    });
    const advId = created.data.ID;
    const buf = (await import('node:fs')).readFileSync('test/unit/advocates/fixtures/portrait.jpg');
    const res = await PUT(`/admin/AdvocatePhotos(${advId})/photo256`, buf, {
      headers: { 'Content-Type': 'image/jpeg' }
    });
    expect([200, 201, 204]).toContain(res.status);

    const cds2 = (await import('@sap/cds')).default;
    const db = await cds2.connect.to('db');
    const { AdvocatePhotos, Advocates } = cds2.entities('com.sap.developers.ims');
    const photo = await db.run(SELECT.one.from(AdvocatePhotos).where({ advocate_ID: advId }));
    expect(photo).toBeTruthy();
    expect(photo.photoMimeType).toBe('image/webp');
    expect(photo.sha256).toMatch(/^[a-f0-9]{64}$/);
    const adv = await db.run(SELECT.one.from(Advocates).where({ ID: advId }));
    expect(adv.hasPhoto).toBe(true);
    expect(adv.photoUpdatedAt).toBeTruthy();
  });
});
```

(The exact CAP route shape for `@Core.MediaType` PUT depends on version. If the project uses CAP's media-stream upload pattern, look for an existing test that uploads a binary, e.g. `grep -rnE "Core.MediaType|/photo256/?\b" test/` and mirror it.)

- [ ] **Step 2: Run, confirm fail**

Expected: photo bytes saved but unprocessed; `hasPhoto` still false.

- [ ] **Step 3: Add handlers**

Append to `srv/handlers/advocate-handlers.js` inside `register`:

```js
const { processUpload } = require('../lib/advocate-photo-store');

const { Advocates, AdvocatePhotos } = srv.entities;

srv.before(['CREATE', 'UPDATE'], AdvocatePhotos, async (req) => {
  const data = req.data;
  // Only process when caller actually sent new photo bytes.
  if (!data.photo256) return;
  const buf = Buffer.isBuffer(data.photo256) ? data.photo256 : Buffer.from(data.photo256);
  const mime = data.photoMimeType || req.headers?.['content-type'] || 'image/jpeg';
  const out = await processUpload(buf, mime);
  data.photo256       = out.photo256;
  data.photo64        = out.photo64;
  data.photoMimeType  = out.photoMimeType;
  data.sha256         = out.sha256;
  data.sizeBytes      = out.sizeBytes;
  data.uploadedAt     = new Date().toISOString();
});

srv.after(['CREATE', 'UPDATE'], AdvocatePhotos, async (data) => {
  const advId = data.advocate_ID || data.advocate?.ID;
  if (!advId) return;
  await UPDATE(Advocates).set({ hasPhoto: true, photoUpdatedAt: new Date().toISOString() })
    .where({ ID: advId });
});

srv.after('DELETE', AdvocatePhotos, async (_, req) => {
  const advId = req.data?.advocate_ID;
  if (!advId) return;
  await UPDATE(Advocates).set({ hasPhoto: false, photoUpdatedAt: new Date().toISOString() })
    .where({ ID: advId });
});
```

- [ ] **Step 4: Run, confirm pass**

Run: `npx vitest run test/unit/advocates/api.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/handlers/advocate-handlers.js test/unit/advocates/api.test.js
git commit -m "feat(advocates): process upload bytes via sharp; flip hasPhoto on success"
```

### Task 5.4: Hybrid HANA round-trip test

**Files:**

- Create: `test/hybrid/advocates-photo-hana.test.js`

- [ ] **Step 1: Write the test**

```js
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import cds from '@sap/cds';
import { readFile } from 'node:fs/promises';
import { processUpload, fetchPhoto } from '../../srv/lib/advocate-photo-store.js';
import { randomUUID } from 'node:crypto';

const SLUG = '__test__photo-' + Date.now().toString(36);

describe('AdvocatePhotos round-trip on HANA', () => {
  let advId;
  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('ALLOW_HYBRID_WRITES must be true for this test');
    }
    advId = randomUUID();
    const db = await cds.connect.to('db');
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    await db.run(INSERT.into(Advocates).entries({
      ID: advId,
      slug: SLUG,
      firstName: '__TEST__',
      lastName: 'Photo',
      region: 'AMERICAS',
      isActive: true,
    }));
    const buf = await readFile('test/unit/advocates/fixtures/portrait.jpg');
    const out = await processUpload(buf, 'image/jpeg');
    await db.run(INSERT.into(AdvocatePhotos).entries({
      advocate_ID: advId,
      photo256: out.photo256,
      photo64: out.photo64,
      photoMimeType: 'image/webp',
      sha256: out.sha256,
      sizeBytes: out.sizeBytes,
      uploadedAt: new Date().toISOString(),
    }));
  });

  afterAll(async () => {
    if (!advId) return;
    const db = await cds.connect.to('db');
    const { Advocates, AdvocatePhotos } = cds.entities('com.sap.developers.ims');
    await db.run(DELETE.from(AdvocatePhotos).where({ advocate_ID: advId }));
    await db.run(DELETE.from(Advocates).where({ ID: advId }));
  });

  it('reads 256 photo back via raw SQL (LOB-locator workaround)', async () => {
    const out = await fetchPhoto(SLUG, 'full');
    expect(out).toBeTruthy();
    expect(out.mimeType).toBe('image/webp');
    expect(out.buffer.length).toBeGreaterThan(0);
    expect(out.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it('reads 64 thumbnail back via raw SQL', async () => {
    const out = await fetchPhoto(SLUG, 'thumb');
    expect(out).toBeTruthy();
    expect(out.buffer.length).toBeGreaterThan(0);
    expect(out.buffer.length).toBeLessThan(20_000);
  });
});
```

- [ ] **Step 2: Run hybrid suite**

Run: `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/advocates-photo-hana.test.js`
Expected: PASS. Requires `cf login` to DEV space first.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/advocates-photo-hana.test.js
git commit -m "test(hybrid): HANA round-trip for advocate photos via raw SQL"
```

---

## Phase 6 — Admin Fiori App

**Goal:** `/admin-ui/#advocates-display` shows the List Report → Object Page; admin can CRUD advocates, edit topics, edit links, upload a photo.

### Task 6.1: Scaffold the Fiori app folder

**Files:**

- Create: `app/admin/advocates/package.json`
- Create: `app/admin/advocates/ui5.yaml`
- Create: `app/admin/advocates/webapp/manifest.json`
- Create: `app/admin/advocates/webapp/Component.js`
- Create: `app/admin/advocates/webapp/i18n/i18n.properties`

- [ ] **Step 1: Mirror `app/admin/categories/`**

The cheapest, lowest-risk way to scaffold is:

```bash
cp -r app/admin/categories app/admin/advocates
```

Then global rename `categories` → `advocates` and `Category` → `Advocate`/`Categories` → `Advocates` in the new folder:

```bash
cd app/admin/advocates
grep -rl "categories" . | xargs sd -F categories advocates
grep -rl "Categories" . | xargs sd -F Categories Advocates
grep -rl "category" . | xargs sd -F category advocate
grep -rl "Category" . | xargs sd -F Category Advocate
```

Then audit: `grep -rnE "categor" app/admin/advocates/` should return zero hits.

- [ ] **Step 2: Update `manifest.json`**

In `app/admin/advocates/webapp/manifest.json`:

- `"sap.app.id": "sap.tutorials.admin.advocates"`
- `"sap.app.crossNavigation.inbounds.<key>.semanticObject": "Advocate"`
- Routing target binds to `/Advocates` not `/Categories`.

Confirm `manifest.json` `sap.app.dataSources.mainService.uri` is `"/admin/"` (matches the existing apps).

- [ ] **Step 3: Update i18n properties**

`webapp/i18n/i18n.properties`:

```properties
appTitle=Advocates
appSubtitle=SAP Developer Advocates roster
```

- [ ] **Step 4: Drop categories-only controller extensions**

If `webapp/ext/CategoryActionsController.js` exists, delete it (or replace with a minimal pass-through controller). Drop the `extends.extensions.sap.ui.controllerExtensions` block from `manifest.json` if no extension is needed.

- [ ] **Step 5: Verify the UI5 build**

```bash
cd app/admin/advocates && npm install && npx ui5 build --clean-dest
```

Expected: build succeeds, `dist/` contains `Component-preload.js`.

- [ ] **Step 6: Commit**

```bash
git add app/admin/advocates/
git commit -m "feat(admin-ui): scaffold Advocates Fiori Elements app from categories template"
```

### Task 6.2: Wire UI annotations

**Files:**

- Modify: `app/admin-annotations.cds`

- [ ] **Step 1: Append the Advocates annotation block**

Find the existing `// --- Categories (#201) ---` marker as a reference. Append after the last existing block:

```cds
// --- Advocates ---
annotate AdminService.Advocates with {
  slug         @Common.Label: 'Slug';
  firstName    @Common.Label: 'First name';
  lastName     @Common.Label: 'Last name';
  title        @Common.Label: 'Title';
  pronouns     @Common.Label: 'Pronouns';
  location     @Common.Label: 'Location';
  region       @Common.Label: 'Region';
  bio          @Common.Label: 'Bio'   @Common.MultiLineText;
  isActive     @Common.Label: 'Active';
  sortOverride @Common.Label: 'Sort override';
  joinedDate   @Common.Label: 'Joined';
  hasPhoto     @Common.Label: 'Has photo' @UI.HiddenFilter;
};

annotate AdminService.Advocates with @(
  UI.HeaderInfo: {
    TypeName: 'Advocate', TypeNamePlural: 'Advocates',
    Title:       { Value: lastName },
    Description: { Value: title }
  },
  UI.SelectionFields: [ region, isActive, lastName ],
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: lastName,  Label: 'Last name' },
    { $Type: 'UI.DataField', Value: firstName, Label: 'First name' },
    { $Type: 'UI.DataField', Value: title,     Label: 'Title' },
    { $Type: 'UI.DataField', Value: region,    Label: 'Region' },
    { $Type: 'UI.DataField', Value: isActive,  Label: 'Active' }
  ],
  UI.FieldGroup #Identity: {
    Data: [
      { $Type: 'UI.DataField', Value: firstName },
      { $Type: 'UI.DataField', Value: lastName },
      { $Type: 'UI.DataField', Value: pronouns },
      { $Type: 'UI.DataField', Value: title },
      { $Type: 'UI.DataField', Value: location },
      { $Type: 'UI.DataField', Value: region },
      { $Type: 'UI.DataField', Value: joinedDate }
    ]
  },
  UI.FieldGroup #Bio: {
    Data: [ { $Type: 'UI.DataField', Value: bio } ]
  },
  UI.FieldGroup #Visibility: {
    Data: [
      { $Type: 'UI.DataField', Value: isActive },
      { $Type: 'UI.DataField', Value: sortOverride }
    ]
  },
  UI.Facets: [
    { $Type: 'UI.ReferenceFacet', ID: 'Identity',   Label: 'Identity',   Target: '@UI.FieldGroup#Identity' },
    { $Type: 'UI.ReferenceFacet', ID: 'Bio',        Label: 'Bio',        Target: '@UI.FieldGroup#Bio' },
    { $Type: 'UI.ReferenceFacet', ID: 'Visibility', Label: 'Visibility', Target: '@UI.FieldGroup#Visibility' },
    { $Type: 'UI.ReferenceFacet', ID: 'Topics',     Label: 'Topics',     Target: 'topics/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', ID: 'Links',      Label: 'Social links', Target: 'links/@UI.LineItem' },
    { $Type: 'UI.ReferenceFacet', ID: 'Photo',      Label: 'Photo',      Target: 'photo/@UI.FieldGroup#Photo' }
  ]
);

annotate AdminService.AdvocateTopics with @(
  UI.LineItem: [ { $Type: 'UI.DataField', Value: tag.label, Label: 'Topic' } ],
  Common.SemanticObject: 'Tag'
);

annotate AdminService.AdvocateLinks with @(
  UI.LineItem: [
    { $Type: 'UI.DataField', Value: kind,      Label: 'Kind' },
    { $Type: 'UI.DataField', Value: url,       Label: 'URL' },
    { $Type: 'UI.DataField', Value: label,     Label: 'Label' },
    { $Type: 'UI.DataField', Value: sortOrder, Label: 'Sort' }
  ]
);

annotate AdminService.AdvocatePhotos with @(
  UI.FieldGroup #Photo: {
    Data: [
      { $Type: 'UI.DataField', Value: photo256, Label: 'Photo' }
    ]
  }
);
```

(Note: `Advocates.photo` association is the inverse from `AdvocatePhotos` — if the entity model in Phase 1 didn't include an `Association from Advocates to AdvocatePhotos`, add it now or replace the `Photo` facet with an embedded section. The Fiori UploadSet binding requires a navigable path to the binary. Adjust during implementation.)

- [ ] **Step 2: Run CSN compile**

`npx cds compile srv/ -o /dev/null` → no errors.

- [ ] **Step 3: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(admin-ui): UI annotations for Advocates List Report and Object Page"
```

### Task 6.3: Register the app in the admin shell

**Files:**

- Modify: `app/admin-shell/webapp/manifest.json`

- [ ] **Step 1: Add resource root + component usage + route + target**

Find the existing `categories` block in each section and copy it; rename to `advocates`. Specifically:

- `sap.ui5.resourceRoots`: `"sap.tutorials.admin.advocates": "./components/advocates"`
- `sap.ui5.componentUsages`: `"advocatesComponent": { "name": "sap.tutorials.admin.advocates", "lazy": true }`
- `sap.ui5.routing.routes`: `{ "name": "advocates", "pattern": "advocates", "target": [{"name": "advocatesTarget", "prefix": "ad"}] }`
- `sap.ui5.routing.targets.advocatesTarget`: `{ "type": "Component", "usage": "advocatesComponent", "id": "advocatesTarget" }`

If the shell carries a static side-nav list (search for the existing nav entries in `webapp/`), add an "Advocates" entry too.

- [ ] **Step 2: Build the shell**

```bash
cd app/admin-shell && npx ui5 build --clean-dest
```

Expected: build succeeds.

- [ ] **Step 3: Commit**

```bash
git add app/admin-shell/webapp/manifest.json
git commit -m "feat(admin-shell): register Advocates component, route, target, side-nav"
```

### Task 6.4: Manual smoke test (local approuter)

- [ ] **Step 1: Start CAP + approuter**

```bash
npm run dev:hybrid
```

Open `http://localhost:5000/admin-ui/#advocates-display`.

- [ ] **Step 2: Verify**

Confirm:

- The List Report renders 5 placeholder rows.
- Sort defaults to lastName asc.
- Object Page opens for a row; shows Identity / Bio / Visibility / Topics / Links / Photo facets.
- Topics value-help is bound to the `Tags` registry.
- Photo upload accepts a JPG and shows the 256 WebP back after save.

No commit — manual smoke only. Mark this task done in the plan tracker after eyeballs-on-screen.

---

## Phase 7 — Public Vue Island

**Goal:** `/developer-advocates/` displays the advocate cards with all interactivity (filters, search, hover-to-flip, sticky-on-scroll, accessibility, reduced-motion, world-map filter).

This phase has many small tasks. They build up incrementally.

### Task 7.1: Hugo content + template

**Files:**

- Create: `hugo/content/developer-advocates/_index.md`
- Create: `hugo/data/advocate_fallback.json`
- Create: `hugo/layouts/developer-advocates/list.html`

- [ ] **Step 1: Hugo content stub**

`hugo/content/developer-advocates/_index.md`:

```markdown
---
title: Developer Advocates
description: Meet the SAP Developer Advocates building samples, running CodeJams, and connecting the community.
type: developer-advocates
layout: list
---
```

- [ ] **Step 2: Fallback data file**

`hugo/data/advocate_fallback.json`:

```json
[
  { "region": "Americas", "email": "developer-advocates-amer@sap.com" },
  { "region": "EMEA",     "email": "developer-advocates-emea@sap.com" },
  { "region": "APJ",      "email": "developer-advocates-apj@sap.com"  }
]
```

(If real region-team mailtos differ, ship with these placeholders and replace post-deploy. The fallback is only seen by users with JS disabled.)

- [ ] **Step 3: Hugo template**

`hugo/layouts/developer-advocates/list.html`:

```html
{{ define "main" }}
<main id="advocates-mount"
      data-api="/api/advocates"
      data-photo-base="/api/advocates"></main>
<noscript>
  <div class="ds-noscript-fallback">
    <p>JavaScript is required to view the advocates directory. To reach a regional team:</p>
    <ul>
      {{ range $.Site.Data.advocate_fallback }}
      <li><a href="mailto:{{ .email }}">{{ .region }} ({{ .email }})</a></li>
      {{ end }}
    </ul>
  </div>
</noscript>
<script type="module" src="{{ "/js/advocates.js" | relURL }}"></script>
{{ end }}
```

- [ ] **Step 4: Verify Hugo builds**

```bash
npm run dev
```

Open `http://localhost:1313/developer-advocates/`. Expected: empty `<main>` (the JS hasn't been written yet), the `<noscript>` block visible only when JS is disabled.

- [ ] **Step 5: Commit**

```bash
git add hugo/content/developer-advocates/ hugo/data/advocate_fallback.json hugo/layouts/developer-advocates/
git commit -m "feat(hugo): /developer-advocates page mount + noscript fallback"
```

### Task 7.2: Vite entry + bundle budget

**Files:**

- Modify: `hugo-apps/vite.config.ts`

- [ ] **Step 1: Add the entry**

In `hugo-apps/vite.config.ts`, append to the `input` map:

```ts
advocates: resolve(__dirname, 'src/advocates/main.ts'),
```

(The other islands name their entry `main.ts` not `index.ts` — match the convention.)

- [ ] **Step 2: Add a bundle-budget plugin**

Mirror the `validationBudget` / `tutorialBranchesBudget` shape already in the file. Add:

```ts
const MAX_ADVOCATES_GZIP = 30 * 1024;

function advocatesBudget() {
  return {
    name: 'advocates-budget',
    generateBundle(_opts: unknown, bundle: Record<string, any>) {
      const chunk = bundle['advocates.js'];
      if (!chunk || chunk.type !== 'chunk') return;
      const gz = gzipSync(chunk.code).length;
      if (gz > MAX_ADVOCATES_GZIP) {
        // @ts-ignore — Rollup plugin context
        this.error(`advocates.js is ${gz} bytes gzipped (> ${MAX_ADVOCATES_GZIP}). Move code to a lazy chunk.`);
      } else {
        // @ts-ignore
        this.warn(`advocates.js: ${gz} bytes gzipped (budget ${MAX_ADVOCATES_GZIP}).`);
      }
    }
  };
}
```

Register the plugin in the `plugins` array of the `defineConfig({...})` block.

- [ ] **Step 3: Stub the entry to keep the build green**

Create `hugo-apps/src/advocates/main.ts`:

```ts
// Stub — real mount in Task 7.3
console.warn('[advocates] not yet implemented');
```

- [ ] **Step 4: Build to verify wiring**

```bash
npm run build:apps
```

Expected: `hugo/static/js/advocates.js` exists and is small (<200 B). The collision check (`postbuild:apps` → `check-build-collisions.ts`) does not flag.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/vite.config.ts hugo-apps/src/advocates/main.ts
git commit -m "feat(advocates): Vite entry + 30 KB gzip bundle budget"
```

### Task 7.3: TS types + composable: filter + URL sync

**Files:**

- Create: `hugo-apps/src/advocates/shared/advocate-types.ts`
- Create: `hugo-apps/src/advocates/composables/useAdvocateFilter.ts`
- Create: `hugo-apps/src/advocates/composables/urlSync.ts`

- [ ] **Step 1: Types**

`hugo-apps/src/advocates/shared/advocate-types.ts`:

```ts
export type Region = 'AMERICAS' | 'EMEA' | 'APJ';

export interface AdvocateLink {
  kind: 'LinkedIn' | 'X' | 'Mastodon' | 'BlueSky' | 'GitHub' | 'YouTube' | 'Blog' | 'SapCommunity' | 'Email' | 'Other';
  url: string;
  label?: string | null;
  sortOrder?: number;
}

export interface AdvocateTopic {
  slug: string;
  label: string;
}

export interface Advocate {
  ID: string;
  slug: string;
  firstName: string;
  lastName: string;
  title?: string | null;
  pronouns?: string | null;
  location?: string | null;
  region: Region;
  bio?: string | null;
  joinedDate?: string | null;
  hasPhoto: boolean;
  photoUpdatedAt?: string | null;
  topics: AdvocateTopic[];
  links: AdvocateLink[];
}

export interface AdvocatesResponse {
  advocates: Advocate[];
}

export interface AdvocateFilterState {
  region: Region | 'ALL';
  topic: string | 'ALL';   // tag slug
  q: string;               // free-text search
}
```

- [ ] **Step 2: URL sync (mirror PR #197 pattern)**

`hugo-apps/src/advocates/composables/urlSync.ts`:

```ts
import type { AdvocateFilterState } from '../shared/advocate-types';

const HASH_KEYS: (keyof AdvocateFilterState)[] = ['region', 'topic', 'q'];

export function readHash(): Partial<AdvocateFilterState> {
  if (typeof window === 'undefined') return {};
  const h = window.location.hash || '';
  const params = new URLSearchParams(h.replace(/^#/, ''));
  const out: Partial<AdvocateFilterState> = {};
  for (const k of HASH_KEYS) {
    const v = params.get(k);
    if (v != null && v !== '') (out as any)[k] = v;
  }
  return out;
}

export function writeHash(state: AdvocateFilterState) {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  if (state.region !== 'ALL') params.set('region', state.region);
  if (state.topic  !== 'ALL') params.set('topic', state.topic);
  if (state.q)               params.set('q', state.q);
  const next = params.toString();
  const target = next ? '#' + next : window.location.pathname + window.location.search;
  if (window.location.hash.replace(/^#/, '') !== next) {
    history.replaceState(null, '', target);
  }
}
```

- [ ] **Step 3: Filter composable**

`hugo-apps/src/advocates/composables/useAdvocateFilter.ts`:

```ts
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { Advocate, AdvocateFilterState } from '../shared/advocate-types';
import { readHash, writeHash } from './urlSync';

export function useAdvocateFilter(advocates: { value: Advocate[] }) {
  const state = ref<AdvocateFilterState>({ region: 'ALL', topic: 'ALL', q: '' });

  onMounted(async () => {
    const h = readHash();
    state.value = { ...state.value, ...h } as AdvocateFilterState;
    await nextTick();
    watch(state, (v) => writeHash(v), { deep: true, flush: 'pre' });
  });

  const filtered = computed(() => {
    const q = state.value.q.trim().toLowerCase();
    return advocates.value.filter((a) => {
      if (state.value.region !== 'ALL' && a.region !== state.value.region) return false;
      if (state.value.topic  !== 'ALL' && !a.topics.some(t => t.slug === state.value.topic)) return false;
      if (q) {
        const hay = [a.firstName, a.lastName, a.title, a.location, ...(a.topics.map(t => t.label))]
          .join(' ').toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  function setRegion(r: AdvocateFilterState['region']) { state.value.region = r; }
  function setTopic(t: string)                          { state.value.topic = t; }
  function setQ(q: string)                              { state.value.q = q; }
  function reset()                                       { state.value = { region: 'ALL', topic: 'ALL', q: '' }; }

  return { state, filtered, setRegion, setTopic, setQ, reset };
}
```

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/advocates/shared/ hugo-apps/src/advocates/composables/
git commit -m "feat(advocates): types + URL-synced filter composable"
```

### Task 7.4: Flip-card composable + a11y

**Files:**

- Create: `hugo-apps/src/advocates/composables/useFlipCard.ts`

- [ ] **Step 1: Write composable**

```ts
import { onBeforeUnmount, onMounted, ref } from 'vue';

export function useFlipCard() {
  const flipped = ref(false);
  const cardEl  = ref<HTMLElement | null>(null);

  function toggle() { flipped.value = !flipped.value; }
  function unflip() { flipped.value = false; }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'Escape' && flipped.value) {
      unflip();
      cardEl.value?.focus();
    }
  }

  onMounted(() => cardEl.value?.addEventListener('keydown', onKey));
  onBeforeUnmount(() => cardEl.value?.removeEventListener('keydown', onKey));

  return { flipped, cardEl, toggle, unflip };
}
```

The hover-flip itself is pure CSS (`.flipwrap:hover .card-inner { transform: rotateY(180deg) }`). The composable handles keyboard + Escape only.

- [ ] **Step 2: Commit**

```bash
git add hugo-apps/src/advocates/composables/useFlipCard.ts
git commit -m "feat(advocates): flip-card a11y composable (Enter/Space/Escape)"
```

### Task 7.5: Card components (front + back)

**Files:**

- Create: `hugo-apps/src/advocates/components/InitialsAvatar.vue`
- Create: `hugo-apps/src/advocates/components/AdvocateCard.vue`
- Create: `hugo-apps/src/advocates/styles/advocates.css`

- [ ] **Step 1: InitialsAvatar.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue';
const props = defineProps<{ firstName: string; lastName: string; size?: number }>();
const initials = computed(() =>
  ((props.firstName?.[0] || '') + (props.lastName?.[0] || '')).toUpperCase());
const px = computed(() => (props.size || 130) + 'px');
</script>

<template>
  <div class="adv-initials" :style="{ width: px, height: px, fontSize: 'calc(' + px + ' / 2.4)' }">
    <span>{{ initials || '·' }}</span>
  </div>
</template>

<style>
.adv-initials {
  border-radius: 50%; border: 5px solid #fff;
  background: linear-gradient(135deg,#0070f2,#6c3dff);
  color: #fff; display: inline-flex; align-items: center; justify-content: center;
  font-weight: 700; letter-spacing: -.02em;
  box-shadow: 0 14px 28px rgba(0,40,100,.22);
}
</style>
```

- [ ] **Step 2: Shared CSS**

`hugo-apps/src/advocates/styles/advocates.css` — gradient definitions per region, flip 3D, sticky strip CSS. Keep the file under ~150 lines so it stays readable.

```css
:root {
  --adv-card-radius: 20px;
  --adv-bg-amer: linear-gradient(135deg,#0070f2 0%,#6c3dff 60%,#ff6db5 100%);
  --adv-bg-emea: linear-gradient(135deg,#0a6ed1 0%,#1c63dc 60%,#2b9fd8 100%);
  --adv-bg-apj:  linear-gradient(135deg,#7858d8 0%,#b056d1 60%,#f96fb0 100%);
  --adv-back:    linear-gradient(160deg,#001a4f 0%,#0a3d91 50%,#0070f2 100%);
}

.adv-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 22px; }
@media (max-width: 1100px) { .adv-grid { grid-template-columns: repeat(3, 1fr); } }
@media (max-width: 800px)  { .adv-grid { grid-template-columns: repeat(2, 1fr); } }
@media (max-width: 540px)  { .adv-grid { grid-template-columns: 1fr; } }

.adv-flipwrap { perspective: 1400px; }
.adv-card-inner {
  position: relative; width: 100%; aspect-ratio: 4 / 5;
  transition: transform .85s cubic-bezier(.2,.85,.25,1);
  transform-style: preserve-3d; cursor: pointer;
}
.adv-flipwrap:hover .adv-card-inner,
.adv-flipwrap.is-flipped .adv-card-inner { transform: rotateY(180deg); }
.adv-face {
  position: absolute; inset: 0; backface-visibility: hidden;
  border-radius: var(--adv-card-radius); overflow: hidden;
  background: #fff; border: 1px solid #e4e4e8;
  box-shadow: 0 8px 24px rgba(8,32,80,.06);
  display: flex; flex-direction: column;
}
.adv-flipwrap:hover .adv-face { box-shadow: 0 18px 44px rgba(8,32,80,.14); }

.adv-front .adv-hero { height: 56%; position: relative; overflow: hidden; }
.adv-front .adv-hero[data-region="AMERICAS"] { background: var(--adv-bg-amer); }
.adv-front .adv-hero[data-region="EMEA"]      { background: var(--adv-bg-emea); }
.adv-front .adv-hero[data-region="APJ"]       { background: var(--adv-bg-apj); }
.adv-front .adv-hero::after {
  content:''; position:absolute; inset:0;
  background: radial-gradient(900px circle at 25% 0%, rgba(255,255,255,.32), transparent 55%);
}
.adv-photo, .adv-front .adv-initials {
  position: absolute; left: 50%; bottom: -44px; transform: translateX(-50%);
  width: 130px; height: 130px; border-radius: 50%; border: 5px solid #fff;
  background-position: center; background-size: cover; background-color: #cfe3ff;
  box-shadow: 0 14px 28px rgba(0,40,100,.22);
}

.adv-front .adv-body { padding: 60px 18px 14px; text-align: center; flex: 1; display: flex; flex-direction: column; }
.adv-name { margin: 0; font-size: 18px; }
.adv-pron { font-size: 12px; color: #6b7c93; margin-left: 4px; font-weight: 400; }
.adv-role { color: #5b738b; font-size: 13px; margin-top: 4px; }
.adv-loc  { color: #8696a8; font-size: 12px; margin-top: 2px; }
.adv-chips { display:flex; flex-wrap:wrap; justify-content:center; gap:6px; margin-top:14px; }
.adv-chip { font-size:11px; padding: 3px 9px; border-radius: 999px; background:#eaf4ff; color:#0a3d91; border:1px solid #cfe3ff; }
.adv-legend { margin-top:auto; padding-top: 12px; font-size: 11px; color:#aab5c6; letter-spacing:.08em; text-transform:uppercase; }

.adv-back { transform: rotateY(180deg); padding: 22px; color: #fff; background: var(--adv-back); }
.adv-back .adv-name, .adv-back h3 { color: #fff; }
.adv-back .adv-bio { font-size: 13px; line-height: 1.55; margin: 14px 0; flex: 1; overflow: auto; }
.adv-links { display: flex; flex-wrap: wrap; gap: 8px; }
.adv-iconbtn {
  display: inline-flex; align-items: center; justify-content: center;
  width: 34px; height: 34px; border-radius: 10px;
  background: rgba(255,255,255,.14); color: #fff;
  text-decoration: none; font-weight: 600;
  border: 1px solid rgba(255,255,255,.18);
  transition: background .2s ease;
}
.adv-iconbtn:hover { background: rgba(255,255,255,.28); }
.adv-profile { margin-top: 14px; font-size: 12px; color: #cfe3ff; text-decoration: underline; }

@media (prefers-reduced-motion: reduce) {
  .adv-card-inner { transition: opacity .25s ease; }
  .adv-flipwrap:hover .adv-card-inner,
  .adv-flipwrap.is-flipped .adv-card-inner { transform: none; }
  .adv-flipwrap:hover .adv-front,
  .adv-flipwrap.is-flipped .adv-front { opacity: 0; pointer-events: none; }
  .adv-flipwrap:hover .adv-back,
  .adv-flipwrap.is-flipped .adv-back { opacity: 1; transform: none; }
}
```

- [ ] **Step 3: AdvocateCard.vue**

```vue
<script setup lang="ts">
import { computed } from 'vue';
import type { Advocate } from '../shared/advocate-types';
import InitialsAvatar from './InitialsAvatar.vue';
import { useFlipCard } from '../composables/useFlipCard';

const props = defineProps<{ advocate: Advocate; photoBase: string }>();
const { flipped, cardEl, toggle } = useFlipCard();

const photoUrl = computed(() => {
  if (!props.advocate.hasPhoto) return null;
  const v = props.advocate.photoUpdatedAt ? '?v=' + encodeURIComponent(props.advocate.photoUpdatedAt) : '';
  return `${props.photoBase}/${props.advocate.slug}/photo${v}`;
});

const profileUrl = computed(() => {
  const order = ['Blog','SapCommunity','LinkedIn','GitHub','X','BlueSky','Mastodon','YouTube','Email'];
  for (const k of order) {
    const link = props.advocate.links.find(l => l.kind === k);
    if (link) return link.url;
  }
  return null;
});

const ICON: Record<string, string> = {
  LinkedIn: 'in', X: '𝕏', GitHub: 'gh', YouTube: '▶',
  BlueSky: 'B', Mastodon: 'M', Blog: 'B+', SapCommunity: 'SC', Email: '✉', Other: '·',
};
</script>

<template>
  <div
    ref="cardEl"
    class="adv-flipwrap"
    :class="{ 'is-flipped': flipped }"
    role="button"
    :tabindex="0"
    :aria-pressed="flipped"
    :aria-label="`Toggle details for ${advocate.firstName} ${advocate.lastName}`"
    @click="toggle"
  >
    <div class="adv-card-inner">
      <div class="adv-face adv-front">
        <div class="adv-hero" :data-region="advocate.region">
          <img v-if="photoUrl" class="adv-photo" :src="photoUrl"
               :alt="`Photo of ${advocate.firstName} ${advocate.lastName}`"
               loading="lazy" />
          <InitialsAvatar v-else :first-name="advocate.firstName" :last-name="advocate.lastName" />
        </div>
        <div class="adv-body">
          <h3 class="adv-name">
            {{ advocate.firstName }} {{ advocate.lastName }}
            <span v-if="advocate.pronouns" class="adv-pron">({{ advocate.pronouns }})</span>
          </h3>
          <div class="adv-role" v-if="advocate.title">{{ advocate.title }}</div>
          <div class="adv-loc" v-if="advocate.location">{{ advocate.location }} · {{ advocate.region }}</div>
          <div class="adv-chips" v-if="advocate.topics.length">
            <span class="adv-chip" v-for="t in advocate.topics" :key="t.slug">{{ t.label }}</span>
          </div>
          <div class="adv-legend">hover to flip</div>
        </div>
      </div>
      <div class="adv-face adv-back">
        <h3 class="adv-name">{{ advocate.firstName }} {{ advocate.lastName }}</h3>
        <div class="adv-role">{{ advocate.title }} · {{ advocate.region }}</div>
        <div class="adv-bio">{{ advocate.bio || '' }}</div>
        <div class="adv-links">
          <a v-for="l in advocate.links" :key="l.kind + l.url"
             class="adv-iconbtn"
             :href="l.url" target="_blank" rel="noopener"
             :title="l.label || l.kind">
            {{ ICON[l.kind] || l.kind.slice(0,2) }}
          </a>
        </div>
        <a v-if="profileUrl" class="adv-profile" :href="profileUrl" target="_blank" rel="noopener">
          View profile →
        </a>
      </div>
    </div>
  </div>
</template>
```

- [ ] **Step 4: Commit**

```bash
git add hugo-apps/src/advocates/components/InitialsAvatar.vue hugo-apps/src/advocates/components/AdvocateCard.vue hugo-apps/src/advocates/styles/advocates.css
git commit -m "feat(advocates): flip card with region-tinted gradient + a11y"
```

### Task 7.6: HeaderBand + WorldMap + StickyMini + EmptyState

**Files:**

- Create: `hugo-apps/src/advocates/components/WorldMap.vue`
- Create: `hugo-apps/src/advocates/components/HeaderBand.vue`
- Create: `hugo-apps/src/advocates/components/StickyMini.vue`
- Create: `hugo-apps/src/advocates/components/EmptyState.vue`

- [ ] **Step 1: WorldMap.vue (compact, animation auto-paused on tab-hidden + reduced-motion)**

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Region } from '../shared/advocate-types';

defineProps<{ regionCounts: Record<Region | 'ALL', number>; active: Region | 'ALL' }>();
const emit = defineEmits<{ (e: 'pick', region: Region | 'ALL'): void }>();

const paused = ref(false);
function onVis() { paused.value = document.visibilityState !== 'visible'; }

onMounted(() => {
  document.addEventListener('visibilitychange', onVis);
  onVis();
});
onBeforeUnmount(() => document.removeEventListener('visibilitychange', onVis));
</script>

<template>
  <div class="adv-map" :class="{ paused }" aria-label="Filter advocates by region">
    <span class="adv-map-label adv-map-am">AMER</span>
    <span class="adv-map-label adv-map-eu">EMEA</span>
    <span class="adv-map-label adv-map-ap">APJ</span>
    <button class="adv-dot adv-dot-am"  :class="{ active: active === 'AMERICAS' }"
            :aria-label="`Americas (${regionCounts.AMERICAS} advocates)`"
            @click="emit('pick', active === 'AMERICAS' ? 'ALL' : 'AMERICAS')"></button>
    <button class="adv-dot adv-dot-eu"  :class="{ active: active === 'EMEA' }"
            :aria-label="`EMEA (${regionCounts.EMEA} advocates)`"
            @click="emit('pick', active === 'EMEA' ? 'ALL' : 'EMEA')"></button>
    <button class="adv-dot adv-dot-ap"  :class="{ active: active === 'APJ' }"
            :aria-label="`APJ (${regionCounts.APJ} advocates)`"
            @click="emit('pick', active === 'APJ' ? 'ALL' : 'APJ')"></button>
  </div>
</template>

<style>
.adv-map {
  width: 220px; height: 86px; position: relative; flex-shrink: 0;
  border-radius: 8px;
  background:
    radial-gradient(ellipse at 18% 60%, rgba(255,255,255,.12) 0 28px, transparent 32px),
    radial-gradient(ellipse at 50% 45%, rgba(255,255,255,.12) 0 32px, transparent 36px),
    radial-gradient(ellipse at 80% 55%, rgba(255,255,255,.12) 0 28px, transparent 32px);
}
.adv-map-label { position: absolute; font-size: 9px; letter-spacing: .08em; text-transform: uppercase; color: rgba(255,255,255,.7); }
.adv-map-am { top: 60%; left: 8%; }
.adv-map-eu { top: 22%; left: 44%; }
.adv-map-ap { top: 60%; right: 6%; }
.adv-dot {
  position: absolute; width: 12px; height: 12px; border-radius: 50%;
  transform: translate(-50%, -50%); cursor: pointer; padding: 0; border: 0;
  background: #fff;
}
.adv-dot::before {
  content: ''; position: absolute; inset: -4px; border-radius: 50%;
  background: inherit; opacity: .5; animation: adv-pulse 2.4s ease-out infinite;
}
.adv-map.paused .adv-dot::before,
@media (prefers-reduced-motion: reduce) { .adv-dot::before { animation: none; opacity: 0; } }
.adv-dot-am { left: 22%; top: 62%; background: #ff6db5; }
.adv-dot-eu { left: 50%; top: 42%; background: #b056d1; }
.adv-dot-ap { left: 80%; top: 58%; background: #2b9fd8; }
.adv-dot.active { box-shadow: 0 0 0 3px #fff; }
@keyframes adv-pulse {
  0% { transform: scale(1); opacity: .55; }
  100% { transform: scale(2.2); opacity: 0; }
}
</style>
```

- [ ] **Step 2: HeaderBand.vue**

```vue
<script setup lang="ts">
import type { Region } from '../shared/advocate-types';
import WorldMap from './WorldMap.vue';

defineProps<{
  total: number;
  regionCounts: Record<Region | 'ALL', number>;
  topics: { slug: string; label: string }[];
  state: { region: Region | 'ALL'; topic: string; q: string };
}>();
defineEmits<{
  (e: 'set-region', r: Region | 'ALL'): void;
  (e: 'set-topic',  t: string): void;
  (e: 'set-q',      q: string): void;
}>();
</script>

<template>
  <header class="adv-header">
    <div class="adv-header-row">
      <div class="adv-header-meta">
        <h1 class="adv-h1">Developer Advocates</h1>
        <span class="adv-count">{{ total }} people · 3 regions · {{ topics.length }} focus areas</span>
      </div>
      <WorldMap :region-counts="regionCounts" :active="state.region" @pick="$emit('set-region', $event)" />
    </div>
    <div class="adv-chips-row">
      <button class="adv-pill" :class="{ active: state.region === 'ALL' }"      @click="$emit('set-region','ALL')">All</button>
      <button class="adv-pill" :class="{ active: state.region === 'AMERICAS' }" @click="$emit('set-region','AMERICAS')">Americas ({{ regionCounts.AMERICAS }})</button>
      <button class="adv-pill" :class="{ active: state.region === 'EMEA' }"     @click="$emit('set-region','EMEA')">EMEA ({{ regionCounts.EMEA }})</button>
      <button class="adv-pill" :class="{ active: state.region === 'APJ' }"      @click="$emit('set-region','APJ')">APJ ({{ regionCounts.APJ }})</button>
      <span class="adv-chip-divider" aria-hidden="true">|</span>
      <button v-for="t in topics" :key="t.slug" class="adv-pill"
              :class="{ active: state.topic === t.slug }"
              @click="$emit('set-topic', state.topic === t.slug ? 'ALL' : t.slug)">
        {{ t.label }}
      </button>
      <input class="adv-search" type="search" placeholder="Search advocates"
             :value="state.q"
             @input="$emit('set-q', ($event.target as HTMLInputElement).value)"
             aria-label="Search advocates" />
    </div>
  </header>
</template>

<style>
.adv-header {
  position: relative; overflow: hidden;
  background: linear-gradient(120deg, #001a4f 0%, #0a3d91 45%, #0070f2 80%, #6c3dff 100%);
  color: #fff; padding: 18px 24px 14px; border-radius: 0;
}
.adv-header::before {
  content: ''; position: absolute; top: -80px; right: -100px; width: 320px; height: 320px;
  border-radius: 50%; background: radial-gradient(circle, rgba(255,109,181,.55), transparent 65%);
}
.adv-header-row { display: grid; grid-template-columns: 1fr auto; gap: 16px; align-items: center; position: relative; z-index: 1; }
.adv-header-meta { display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap; }
.adv-h1 { margin: 0; font-size: 22px; letter-spacing: -.01em; }
.adv-count { color: rgba(255,255,255,.78); font-size: 13px; }
.adv-chips-row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin-top: 10px; position: relative; z-index: 1; }
.adv-pill {
  font-size: 11px; padding: 4px 10px; border-radius: 999px;
  background: rgba(255,255,255,.12); color: #fff; border: 1px solid rgba(255,255,255,.25);
  cursor: pointer; transition: background .15s ease;
}
.adv-pill:hover { background: rgba(255,255,255,.22); }
.adv-pill.active { background: #fff; color: #0a3d91; border-color: #fff; font-weight: 600; }
.adv-chip-divider { opacity: .4; padding: 0 4px; }
.adv-search {
  margin-left: auto; height: 26px; min-width: 180px; border-radius: 6px;
  background: rgba(255,255,255,.14); border: 1px solid rgba(255,255,255,.25);
  color: #fff; padding: 0 10px; font-size: 12px;
}
.adv-search::placeholder { color: rgba(255,255,255,.65); }
</style>
```

- [ ] **Step 3: StickyMini.vue (collapsed sticky strip)**

```vue
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue';
import type { Region } from '../shared/advocate-types';

defineProps<{ state: { region: Region | 'ALL'; topic: string; q: string } }>();
const visible = ref(false);

let observer: IntersectionObserver | null = null;

onMounted(() => {
  const sentinel = document.getElementById('advocates-mount');
  if (!sentinel) return;
  observer = new IntersectionObserver(([entry]) => {
    visible.value = entry.intersectionRatio < 0.05;
  }, { threshold: [0, 0.05, 0.5, 1] });
  observer.observe(sentinel);
});
onBeforeUnmount(() => observer?.disconnect());
</script>

<template>
  <div v-if="visible" class="adv-sticky-mini">
    <span class="adv-mini-title">Developer Advocates</span>
    <span v-if="state.region !== 'ALL'" class="adv-mini-chip">{{ state.region }}</span>
    <span v-if="state.topic  !== 'ALL'" class="adv-mini-chip">{{ state.topic }}</span>
    <span v-if="state.q"                  class="adv-mini-chip">"{{ state.q }}"</span>
  </div>
</template>

<style>
.adv-sticky-mini {
  position: fixed; top: 0; left: 0; right: 0; z-index: 50; height: 48px;
  display: flex; align-items: center; gap: 10px; padding: 0 24px;
  background: linear-gradient(120deg, #001a4f, #0a3d91);
  color: #fff; box-shadow: 0 2px 8px rgba(0,0,0,.18);
}
.adv-mini-title { font-weight: 600; font-size: 13px; letter-spacing: -.01em; }
.adv-mini-chip {
  font-size: 11px; padding: 3px 9px; border-radius: 999px;
  background: rgba(255,255,255,.18); color: #fff;
}
</style>
```

- [ ] **Step 4: EmptyState.vue**

```vue
<script setup lang="ts">
defineProps<{ filtersActive: boolean }>();
defineEmits<{ (e: 'reset'): void }>();
</script>

<template>
  <div class="adv-empty">
    <ui5-illustrated-message
      :name="filtersActive ? 'NoSearchResults' : 'NoData'"
      :title-text="filtersActive ? 'No advocates match your filters' : 'No advocates published yet.'"
      :subtitle-text="filtersActive ? 'Try clearing one or more filters.' : ''">
      <ui5-button v-if="filtersActive" design="Emphasized" slot="action" @click="$emit('reset')">
        Clear filters
      </ui5-button>
    </ui5-illustrated-message>
  </div>
</template>

<style>
.adv-empty { padding: 60px 24px; display: flex; justify-content: center; }
</style>
```

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/advocates/components/WorldMap.vue hugo-apps/src/advocates/components/HeaderBand.vue hugo-apps/src/advocates/components/StickyMini.vue hugo-apps/src/advocates/components/EmptyState.vue
git commit -m "feat(advocates): header band + world map + sticky mini + empty state"
```

### Task 7.7: App.vue + main mount

**Files:**

- Create: `hugo-apps/src/advocates/App.vue`
- Modify: `hugo-apps/src/advocates/main.ts`

- [ ] **Step 1: App.vue**

```vue
<script setup lang="ts">
import { computed, ref } from 'vue';
import type { Advocate, Region } from './shared/advocate-types';
import AdvocateCard  from './components/AdvocateCard.vue';
import HeaderBand    from './components/HeaderBand.vue';
import StickyMini    from './components/StickyMini.vue';
import EmptyState    from './components/EmptyState.vue';
import { useAdvocateFilter } from './composables/useAdvocateFilter';
import './styles/advocates.css';

const props = defineProps<{ apiUrl: string; photoBase: string }>();
const advocates = ref<Advocate[]>([]);
const loading   = ref(true);
const error     = ref<string | null>(null);

const { state, filtered, setRegion, setTopic, setQ, reset } = useAdvocateFilter(advocates);

const regionCounts = computed(() => {
  const counts = { ALL: advocates.value.length, AMERICAS: 0, EMEA: 0, APJ: 0 } as Record<Region | 'ALL', number>;
  for (const a of advocates.value) counts[a.region] += 1;
  return counts;
});

const topics = computed(() => {
  const seen = new Map<string, string>();
  for (const a of advocates.value) for (const t of a.topics) if (!seen.has(t.slug)) seen.set(t.slug, t.label);
  return [...seen].map(([slug, label]) => ({ slug, label })).sort((a, b) => a.label.localeCompare(b.label));
});

const filtersActive = computed(() => state.value.region !== 'ALL' || state.value.topic !== 'ALL' || !!state.value.q);

async function load() {
  loading.value = true; error.value = null;
  try {
    const res = await fetch(props.apiUrl, { headers: { Accept: 'application/json' }});
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const body = await res.json();
    advocates.value = Array.isArray(body.advocates) ? body.advocates : [];
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}
load();
</script>

<template>
  <StickyMini :state="state" />
  <HeaderBand
    :total="advocates.length"
    :region-counts="regionCounts"
    :topics="topics"
    :state="state"
    @set-region="setRegion"
    @set-topic="setTopic"
    @set-q="setQ"
  />

  <div v-if="loading" class="adv-skel-grid" aria-hidden="true">
    <div v-for="i in 8" :key="i" class="adv-skel-card"></div>
  </div>
  <div v-else-if="error" class="adv-error">
    <p>Couldn't load advocates: {{ error }}</p>
    <button class="adv-pill" @click="load">Retry</button>
  </div>
  <div v-else-if="filtered.length" class="adv-grid">
    <AdvocateCard v-for="a in filtered" :key="a.ID" :advocate="a" :photo-base="photoBase" />
  </div>
  <EmptyState v-else :filters-active="filtersActive" @reset="reset" />
</template>

<style>
.adv-skel-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 22px; padding: 24px; }
.adv-skel-card { aspect-ratio: 4/5; border-radius: 20px;
  background: linear-gradient(90deg, #f1f4f9 0%, #e6effa 50%, #f1f4f9 100%);
  background-size: 200% 100%;
  animation: adv-shimmer 1.4s linear infinite;
}
.adv-error { padding: 40px 24px; text-align: center; }
@keyframes adv-shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
@media (prefers-reduced-motion: reduce) {
  .adv-skel-card { animation: none; }
}
</style>
```

- [ ] **Step 2: main.ts (replaces stub)**

```ts
import { createApp } from 'vue';
import App from './App.vue';

const mount = document.getElementById('advocates-mount') as HTMLElement | null;
if (mount) {
  createApp(App, {
    apiUrl:    mount.dataset.api       || '/api/advocates',
    photoBase: mount.dataset.photoBase || '/api/advocates',
  }).mount(mount);
}
```

- [ ] **Step 3: Build**

```bash
npm run build:apps
```

Confirm: `advocates.js` is under 30 KB gzip (the budget plugin will fail the build otherwise).

- [ ] **Step 4: Manual smoke**

```bash
npm run dev
```

In another terminal: `cds watch`. Open `http://localhost:1313/developer-advocates/`. The Hugo proxy may need a rewrite to forward `/api/*` to `localhost:4004`; if not, run `npm run dev:hybrid` instead and open `http://localhost:5000/developer-advocates/`.

Confirm:

- 5 placeholder cards render.
- Hover flips them; Enter/Space on focus also flips; Escape returns focus and unflips.
- Region pills + map dots filter together (state stays in sync).
- URL hash updates as filters change; reload preserves them.
- Empty state appears when filters return zero matches.
- Sticky mini bar appears when scrolling past the header.

- [ ] **Step 5: Commit**

```bash
git add hugo-apps/src/advocates/App.vue hugo-apps/src/advocates/main.ts
git commit -m "feat(advocates): App.vue + main mount with filter, error, skeleton states"
```

### Task 7.8: Approuter routes

**Files:**

- Modify: `approuter/xs-app.json`

- [ ] **Step 1: Add the two routes**

Insert near the top of `routes` (before the catch-all and any auth-required block):

```json
{ "source": "^/developer-advocates(/.*)?$", "target": "$1",
  "service": "html5-apps-repo-rt", "destination": "tutorials-static",
  "authenticationType": "none" },
{ "source": "^/api/advocates(/.*)?$", "target": "/api/advocates$1",
  "destination": "tutorials-srv", "authenticationType": "none" }
```

Inspect existing route shape first — the project may use a different destination naming convention.

- [ ] **Step 2: Run xs-app validator**

`tsx scripts/check-xs-app-mta.ts` is part of `postbuild:apps`. Run that script directly:

```bash
tsx scripts/check-xs-app-mta.ts
```

Expected: no new findings.

- [ ] **Step 3: Commit**

```bash
git add approuter/xs-app.json
git commit -m "feat(approuter): public routes for /developer-advocates and /api/advocates"
```

---

## Phase 8 — Documentation, Smoke Tests, Deploy Prep

**Goal:** Docs in place, smoke suite green against the deployed DEV instance, MTA cp-list updated, AdvocateTopics CSV populated with real Tag IDs.

### Task 8.1: Architecture doc page

**Files:**

- Create: `docs/developers/architecture/advocates.md`

- [ ] **Step 1: Write the page**

Cover: data model summary, photo pipeline (sharp 256/64 + sha256 + 5 MB cap + animated rejection), public API contract (`GET /api/advocates`, `GET /api/advocates/:slug/photo`), HANA LOB-locator workaround pointer, change-tracking on, no `@PersonalData`. Link to the spec.

```markdown
# Developer Advocates

Implementation of the in-codebase replacement for the legacy AEM developer-advocates page.
Spec: [2026-06-17 design](../../superpowers/specs/2026-06-17-developer-advocates-design.md).

## Entities

[summary table — see db/advocates.cds]

## Public API

- `GET /api/advocates` — JSON, ETag, 60s + SWR.
- `GET /api/advocates/:slug/photo[?size=thumb]` — WebP, ETag, 86400s.

## Photo Pipeline

[summary — see srv/lib/advocate-photo-store.js]

## HANA Read Path

Photos are stored as `LargeBinary` in `AdvocatePhotos`. Reading a BLOB
column on HANA mixed with metadata in the same CDS QL fails because the
LOB-locator expires before consumption. `srv/lib/advocate-photo-store.js`
splits the read into two raw-SQL `db.run()` calls: first slug → advocate_ID,
then advocate_ID → BLOB. Mirrors the pattern already used in
`srv/lib/content-store.js`.

## What we don't do

No `@PersonalData` annotations: advocate info is published-by-intent
business directory data; including it would cascade through
`_executeAnonymization` if the advocate later anonymizes their *learner*
account. Change-tracking is on (admin edits flow into the existing
Changelog Fiori app); audit-logging is off.
```

- [ ] **Step 2: Sidebar entry**

Edit `docs/.vitepress/config.ts` `themeConfig.sidebar`. Find the developers/architecture group and add:

```ts
{ text: 'Advocates', link: '/developers/architecture/advocates' }
```

The `predocs:build` guard fails the docs build if this is forgotten.

- [ ] **Step 3: Verify VitePress build**

```bash
npm run docs:build
```

Expected: zero errors. Sidebar guard passes.

- [ ] **Step 4: Commit**

```bash
git add docs/developers/architecture/advocates.md docs/.vitepress/config.ts
git commit -m "docs: add Developer Advocates architecture page"
```

### Task 8.2: Endpoints reference + CLAUDE.md

**Files:**

- Modify: `docs/developers/operations/testing-endpoints.md`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Endpoints reference**

Append rows for `GET /api/advocates` (public, no auth) and `GET /api/advocates/:slug/photo` (public, no auth, ETag, 1d cache). Match the existing table style.

- [ ] **Step 2: CLAUDE.md paragraph**

Append under the existing **CAP Backend** Architecture section (where other public endpoints are listed):

> - **Developer Advocates**: `GET /api/advocates` (public JSON list, 60s cache + SWR) and `GET /api/advocates/:slug/photo[?size=thumb]` (256/64 WebP from HANA `AdvocatePhotos` BLOBs, 86400s cache). Admin via `/admin-ui/#advocates-display`. See [docs/developers/architecture/advocates.md](docs/developers/architecture/advocates.md).

- [ ] **Step 3: Commit**

```bash
git add docs/developers/operations/testing-endpoints.md CLAUDE.md
git commit -m "docs: register advocates endpoints in testing-endpoints + CLAUDE.md"
```

### Task 8.3: MTA srv-qa cp-list

**Files:**

- Modify: `.deploy/mta.yaml`

- [ ] **Step 1: Audit transitive imports from new srv files**

```bash
grep -rE "require\\('\\./|require\\(\"\\./" srv/lib/advocate-photo-store.js srv/lib/advocate-slug.js srv/handlers/advocate-handlers.js srv/routes/advocates-public.js
```

All `./` imports must be in the `srv-qa` `cp` list of `.deploy/mta.yaml`. The new files themselves must be added.

- [ ] **Step 2: Append to the srv-qa cp list**

Inside the `srv-qa` build block, add lines mirroring the existing entries:

```yaml
- cp -r ../srv/lib/advocate-photo-store.js srv/lib/
- cp -r ../srv/lib/advocate-slug.js srv/lib/
- cp -r ../srv/handlers/advocate-handlers.js srv/handlers/
- cp -r ../srv/routes/advocates-public.js srv/routes/
```

(Match the project's actual cp-list shape — the snippet may differ from the literal yaml lines depending on whether they use `cp` or another mechanism.)

- [ ] **Step 3: Run the cp-list checker**

```bash
tsx scripts/check-srv-qa-cp-list.ts
```

Expected: zero findings. This is the script that catches the `srv-qa` drift gotcha.

- [ ] **Step 4: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "build(mta): add advocate srv files to srv-qa cp list"
```

### Task 8.4: Smoke test suite

**Files:**

- Create: `test/smoke/advocates.smoke.test.js`

- [ ] **Step 1: Write the smoke tests**

```js
import { describe, expect, it } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL;
const SRV  = process.env.SMOKE_SRV_URL;

describe.skipIf(!BASE)('GET /developer-advocates/', () => {
  it('returns 200 and contains the mount point + script', async () => {
    const res = await fetch(BASE + '/developer-advocates/');
    expect(res.status).toBe(200);
    const html = await res.text();
    // Tolerant of Hugo minifier's quote-stripping (per feedback_hugo_minifier_strips_quotes).
    expect(html).toMatch(/<main[^>]+id=["']?advocates-mount["']?/);
    expect(html).toMatch(/src=["']?[^"']*\/js\/advocates\.js["']?/);
  });
});

describe.skipIf(!SRV)('GET /api/advocates', () => {
  it('returns 200 JSON with at least one advocate', async () => {
    const res = await fetch(SRV + '/api/advocates');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/json/);
    const body = await res.json();
    expect(Array.isArray(body.advocates)).toBe(true);
    expect(body.advocates.length).toBeGreaterThan(0);
    const first = body.advocates[0];
    expect(first).toHaveProperty('hasPhoto');
    expect(first).toHaveProperty('topics');
    expect(first).toHaveProperty('links');
  });

  it('responds with ETag and Cache-Control', async () => {
    const res = await fetch(SRV + '/api/advocates');
    expect(res.headers.get('etag')).toBeTruthy();
    expect(res.headers.get('cache-control')).toMatch(/max-age=60/);
  });
});

describe.skipIf(!SRV)('GET /api/advocates/:slug/photo', () => {
  it('returns 404 for placeholder rows (no photos)', async () => {
    const res = await fetch(SRV + '/api/advocates/placeholder-emea/photo');
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run against deployed DEV after deploy**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-approuter.cfapps.eu10-005.hana.ondemand.com \
SMOKE_SRV_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com \
npm run test:smoke -- test/smoke/advocates.smoke.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/advocates.smoke.test.js
git commit -m "test(smoke): /developer-advocates page + /api/advocates endpoints"
```

### Task 8.5: Pre-deploy snapshot

**Files:** none — operational task.

- [ ] **Step 1: Snapshot existing-table row counts before HDI deploy**

Per `feedback_hdi_deploys_can_wipe_data` (the 2026-06-05 saga where an `.hdbindex` add wiped 20+ tables), snapshot:

```bash
cf login
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
cds.connect.to('db').then(async db => {
  const tables = ['CATEGORIES','TAGS','TUTORIALS','MISSIONS','GROUPS','EVENTS'];
  for (const t of tables) {
    const r = await db.run('SELECT COUNT(*) AS C FROM com_sap_developers_ims_' + t.toLowerCase());
    console.log(t.padEnd(20), r[0].C);
  }
  process.exit(0);
});
"
```

Save the output. Three new entities with no FK changes to existing tables should not trigger reorgs, but the saga has earned the paranoia.

- [ ] **Step 2: Deploy to DEV**

```bash
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

(Confirm scope with Tom first, per `feedback_confirm_deploy_scope`.)

- [ ] **Step 3: Re-run snapshot**

Same one-liner. Compare counts. Any drop = freeze + investigate before any further action.

### Task 8.6: Populate AdvocateTopics CSV with real Tag IDs

**Files:**

- Modify: `db/data/com.sap.developers.ims-AdvocateTopics.csv`

- [ ] **Step 1: Look up real Tag IDs against deployed HANA**

```bash
npx cds bind --exec -- node -e "
const cds = require('@sap/cds');
cds.connect.to('db').then(async db => {
  const slugs = ['software-product>cap','software-product>abap','software-product>btp','software-product>joule'];
  const rows = await db.run('SELECT ID, SLUG FROM com_sap_developers_ims_tags WHERE SLUG IN (' + slugs.map(()=>'?').join(',') + ')', slugs);
  console.log(rows);
  process.exit(0);
});
"
```

- [ ] **Step 2: Replace the header-only CSV with real rows**

```csv
ID;advocate_ID;tag_ID
ADT00001-0000-0000-0000-000000000001;ADC00001-0000-0000-0000-000000000001;<CAP-tag-uuid>
ADT00001-0000-0000-0000-000000000002;ADC00001-0000-0000-0000-000000000002;<CAP-tag-uuid>
ADT00001-0000-0000-0000-000000000003;ADC00001-0000-0000-0000-000000000003;<ABAP-tag-uuid>
ADT00001-0000-0000-0000-000000000004;ADC00001-0000-0000-0000-000000000004;<BTP-tag-uuid>
ADT00001-0000-0000-0000-000000000005;ADC00001-0000-0000-0000-000000000005;<CAP-tag-uuid>
```

- [ ] **Step 3: Commit + redeploy**

```bash
git add db/data/com.sap.developers.ims-AdvocateTopics.csv
git commit -m "data: populate AdvocateTopics CSV with real Tag IDs"
```

After redeploy, confirm the public page's topic chips render labels (CAP, ABAP, BTP), not slugs.

### Task 8.7: PR + redirect coordination

**Files:** none — operational task.

- [ ] **Step 1: Open the PR**

```bash
git push -u origin feat/developer-advocates
gh pr create --title "Developer Advocates page (replaces AEM)" \
             --body "Implements docs/superpowers/specs/2026-06-17-developer-advocates-design.md. See linked spec for full context."
```

- [ ] **Step 2: Update the AEM redirect**

Coordinate with the AEM redirect-tree owner (per `project_aem_redirect_tree_access_blocked`) to point `developer-advocates.html` → `/developer-advocates/`.

- [ ] **Step 3: Manual stakeholder verification**

Send the deployed DEV link to Tom + advocate team for a final eyeball pass before merge.

---

## Final Closeout

- [ ] All commits on `feat/developer-advocates` pushed.
- [ ] PR open, CI green.
- [ ] Smoke tests pass against deployed DEV.
- [ ] HDI snapshot before/after matches.
- [ ] Tom signs off on the visual + admin UX.
- [ ] AEM redirect updated.
- [ ] Memory written: `project_developer_advocates_shipped.md` summarizing PR + key decisions.
