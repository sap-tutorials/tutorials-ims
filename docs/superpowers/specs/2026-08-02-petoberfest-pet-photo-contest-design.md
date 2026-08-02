# Petoberfest — Pet Photo Contest (design spec)

**Date:** 2026-08-02
**Status:** Approved — ready for implementation planning
**Scope:** Cross-repo. Provider + frontend in `tutorials-ims` (local `tutorials-poc`); consumer value-help changes in `devtoberfest-planner`.

## Problem

Petoberfest is a recurring Devtoberfest activity where participants post pet photos. Historically it was manual: people posted to a community forum thread, and staff downloaded the entries and hand-awarded a special badge for contest points. We want to automate it the way the Puzzle activity is automated:

- A logged-in user uploads a photo of their pet on a dedicated page.
- Uploading records a task completion (badge/points), exactly like solving a puzzle.
- The upload is a **new task type** so it can be assigned to a Devtoberfest Activity in the planner, just like a tutorial or puzzle.
- Anyone (including unauthenticated visitors) can return to the page and view a slideshow of all uploaded pets.

## Decisions (locked)

| Topic | Decision |
|---|---|
| Completion trigger | **Upload = done, once per user.** First accepted upload writes an idempotent `COMPLETED` TaskRecord. Extra uploads add pets but do not re-award. |
| Moderation | **Hidden until approved** for the public slideshow; **points are awarded instantly on upload** regardless of moderation state. Participant is never blocked. |
| Slideshow entry content | Pet name / caption + uploader display name (snapshot) + photo. **Multiple pets per user** allowed. |
| Task structure | **Sluggable content entity** like puzzles — multiple instances possible (e.g. `petoberfest-2026`), chosen per-Activity in the planner. Page at `/petoberfest/<slug>/`. |
| Image handling | **Resize on upload** with `sharp`: display WebP (~1280px long edge) + thumbnail WebP (~320px). Strip EXIF, reject animated, MIME allowlist, input size cap. Store as HANA BLOBs. |
| Moderation scope | `Tutorial.Author` **or** `Admin` scope (same as puzzle authoring). |
| Validation-tutorial guard (planner) | A PETOBERFEST activity must **not** be allowed to build a validation tutorial. |

## Architecture

Frontend is a **Vue island embedded in a Hugo page** (the puzzle model). Backend is a **public CAP service** (`@requires: 'any'`) with per-action auth overrides, mirroring `puzzle-service`, plus raw Express routes reserved in `server.js` for multipart upload and BLOB serving (the advocate-photo model). Cross-repo task-type assignment reuses the existing `TASK_VALUE_HELP_V1` value-help path.

```text
Browser (/petoberfest/<slug>/)
  └─ Hugo page (layouts/petoberfest/single.html) mounts Vue island (hugo-apps/src/petoberfest)
       ├─ public reads  → GET /petoberfest-api/slideshow?slug=…      (auth: none)
       │                  GET /petoberfest-api/photo/:id?size=…      (auth: none, APPROVED only)
       └─ authed upload → POST /petoberfest-api/:slug/upload         (auth: xsuaa, csrfFetch, multipart)
                          GET  /petoberfest-api/myUploads?slug=…     (auth: xsuaa)

CAP srv (tutorials-ims)
  ├─ srv/petoberfest-service.{cds,js}   public read + authed myUploads
  ├─ srv/server.js raw routes           upload (multer), public photo serve, admin photo serve
  ├─ srv/lib/petoberfest-photo-store.js sharp pipeline + HANA/SQLite BLOB store+serve
  └─ TaskRecords INSERT (taskType PETOBERFEST, idempotent)  → Devtoberfest scoring by slug

HANA (single instance, cross-container)
  └─ db/src/TASK_VALUE_HELP_V1.hdbview  add 3rd UNION arm (TASKTYPE='PETOBERFEST')
        └─ devtoberfest-planner reads via synonym+grant → Activity.task value help
```

## Component 1 — Data model (`tutorials-ims` `db/schema.cds`)

Two new entities + a submission entity, mirroring the `Puzzles` / `PuzzleProgress` split.

```cds
// Sluggable contest instance (one per contest, e.g. petoberfest-2026)
entity Petoberfests : TaskBase {           // TaskBase → legacyId, title, status, description, tags
  slug  : String(255) @assert.unique.slug;
  intro : LargeString;                      // optional blurb above the upload/slideshow
}

// One row per uploaded pet photo
entity PetSubmissions : cuid, managed {
  petoberfest  : Association to Petoberfests not null;
  user         : Association to Users not null;              // uploader
  petName      : String(120);                                // caption / pet name
  uploaderName : String(120);                                // display-name snapshot (from JWT)
  moderation   : String(12) enum { PENDING; APPROVED; HIDDEN; } default 'PENDING';
  photoDisplay : LargeBinary @Core.MediaType: mimeType;      // ~1280px WebP
  photoThumb   : LargeBinary @Core.MediaType: 'image/webp';  // ~320px WebP
  mimeType     : String(40)  @Core.IsMediaType default 'image/webp';
  sizeBytes    : Integer;
  sha256       : String(64);                                 // per-user duplicate rejection + integrity
  uploadedAt   : Timestamp;
}
```

Enum additions (both are **CDS-runtime-only**, no `.hdbmigrationtable` ALTER required per the schema comments at `schema.cds:18` / `:189`):

- `TaskType` enum (`db/schema.cds:18`) → add `PETOBERFEST`.
- `TaskRecords.taskType` inline enum (`db/schema.cds:189`) → add `PETOBERFEST`.

Notes:
- `moderation` starts `PENDING`; only `APPROVED` rows are public. Points are written on upload regardless.
- `uploaderName` snapshotted at upload so the slideshow needs no live Users join / JWT re-read.
- `sha256` rejects an exact-duplicate re-upload by the same user cheaply.
- Both binary columns are `@Core.MediaType` LargeBinary — but per the HANA LOB gotcha we **never** SELECT them alongside metadata in one CDS QL query. Serving uses raw `db.run` with the HANA/SQLite branch.

## Component 2 — Backend service & endpoints (`tutorials-ims`)

New public service `srv/petoberfest-service.cds` + `.js`, `@path: '/petoberfest-api'`, `@requires: 'any'`, per-action overrides (puzzle-service pattern).

**CDS surface:**

```cds
@path: '/petoberfest-api'
@requires: 'any'
service PetoberfestService {
  @readonly entity Petoberfests as projection on ims.Petoberfests
    { legacyId, slug, title, intro, status };                 // no admin-only fields

  // approved slideshow entries for one contest — metadata only, NO blobs
  function slideshow(slug: String) returns array of {
    id: String; petName: String; uploaderName: String; uploadedAt: Timestamp;
  };

  // uploader's own entries incl. PENDING (so they can see "pending approval" state)
  @(requires: 'authenticated-user')
  function myUploads(slug: String) returns array of {
    id: String; petName: String; moderation: String; uploadedAt: Timestamp;
  };
}
```

**Raw Express routes reserved in `srv/server.js` BEFORE CAP mounts** (OData adapter would otherwise swallow these — same reservation trick as `/content/tutorials/*` and `/admin/advocates/:slug/photo`):

1. `POST /petoberfest-api/:slug/upload` — **authenticated**, `multipart/form-data`, fields: `photo` (file) + `petName` (text).
   - `multer` `memoryStorage()` + `captureUserMiddleware` / `resolveUser` (AsyncLocalStorage context-loss guard).
   - `processUpload` (sharp): produce 1280px display WebP + 320px thumb WebP; strip EXIF; reject animated; MIME allowlist (`image/jpeg|png|webp|gif`); input cap (~10 MB). Compute SHA-256; reject exact duplicate for this user+contest.
   - Store via SELECT-then-INSERT raw `db.run` (advocate-photo-upsert pattern), `moderation='PENDING'`, snapshot `uploaderName` from JWT claims.
   - Write **idempotent PETOBERFEST TaskRecord** — skip if a non-`SUPERSEDED` PETOBERFEST record already exists for this user+contest; else INSERT (`taskType:'PETOBERFEST'`, `status:'COMPLETED'`, `progress:100`, `taskLegacyId = petoberfest.legacyId`, `legacyId = getNextLegacyId()`, `completionDate`, `titleSnapshot`, `attemptNumber`).
   - Response: `{ id, awarded: <bool>, moderation: 'PENDING' }`.

2. `GET /petoberfest-api/photo/:id?size=display|thumb` — **anonymous**, serves WebP bytes for an **APPROVED** submission only (**404** for PENDING/HIDDEN so unapproved photos can't leak via direct URL). ETag + `Cache-Control: public, max-age=86400`, 304 support, HANA/SQLite raw-`db.run` split, never mixing blob + metadata.

**AppRouter routes** (`approuter/xs-app.json`), specific-before-generic ordering within the group:

```
^/petoberfest-api/photo/(.*)$        → srv-api, authenticationType: none   # public image serve
^/petoberfest-api/slideshow(.*)$     → srv-api, authenticationType: none   # public list
^/petoberfest-api/Petoberfests(.*)$  → srv-api, authenticationType: none   # public read
^/petoberfest-api/(.*)/upload$       → srv-api, authenticationType: xsuaa  # authed upload
^/petoberfest-api/(.*)$              → srv-api, authenticationType: xsuaa  # authed rest (myUploads)
```

Auth-required handlers auto-provision the DB `Users` row from JWT claims (`resolveOrCreateUser`, puzzle-service pattern).

## Component 3 — Admin moderation surface (`tutorials-ims`)

**AdminService (`srv/admin-service.cds` + `.js`):**
- Expose `Petoberfests` for CRUD (slug, title, intro, status) — mirror `Puzzles` at `admin-service.cds:105`.
- Expose `PetSubmissions` projection with queue fields (petName, uploaderName, moderation, uploadedAt, sizeBytes) — **no blob columns**.
- Bound actions `approve(id)` → `moderation='APPROVED'`; `hide(id)` → `moderation='HIDDEN'`. Gated on `Tutorial.Author` / `Admin`. Surfaced via `UI.DataFieldForAction` (manifest-only actions render nothing — see gotchas).

**Fiori app `app/admin/petoberfest/`** — List Report / Object Page over `AdminService.PetSubmissions`:
- LR columns: thumbnail preview, pet name, uploader, contest, moderation, uploaded date + Approve/Hide buttons.
- Thumbnail cell points at the **admin** photo route (below).
- Registered as a headless componentUsage in `app/admin-shell/`. Subject to the admin bundle-gate rules: full `mbt build`, **no** `--skip-build` / `-m` scoping (Step 3.5 gate).

**Admin photo serve route** — `GET /admin/petoberfest/photo/:id?size=thumb|display`, reserved raw route with in-handler `user.is('Admin')` / Author check, serves **any** moderation state so the queue can render pending thumbnails (the public route 404s on non-APPROVED).

## Component 4 — Frontend (`tutorials-ims` Hugo + Vue island)

**Hugo wiring:**
- `hugo/content/petoberfest/_index.md` (`type: petoberfest`, headless) + one `hugo/content/petoberfest/<slug>.md` per contest (`type: petoberfest, slug: …`).
- `hugo/layouts/petoberfest/single.html` mounts `<main id="petoberfest-mount" data-slug="…" data-api="/petoberfest-api">` + `<script type="module" src="/js/petoberfest.js">`, with `<noscript>` fallback.

**Vue island `hugo-apps/src/petoberfest/`:** `main.ts` (reads data-attrs, mounts), `App.vue`, `lib/server.ts` (fetch wrappers), `__tests__/`. Register a Vite input entry + a `petoberfestBudget()` gzip-size plugin in `hugo-apps/vite.config.ts`.

**`App.vue` — two zones on the single page:**
1. **Slideshow (everyone, top):** `GET /petoberfest-api/slideshow?slug=…` → approved entries (metadata); auto-advancing carousel, each `<img>` src `/petoberfest-api/photo/:id?size=display` (thumbs `?size=thumb`), pet name + uploader caption, graceful empty state ("No pets yet — be the first!").
2. **Upload (gated, below):** probe `GET /auth/user` (`credentials:'include'`).
   - Anonymous → "Sign in to add your pet" → `/login`.
   - Logged in → file picker + pet-name field + client-side validation (`image/*`, ~10 MB). Submit via `csrfFetch` multipart POST to `/petoberfest-api/:slug/upload` (do **not** set `Content-Type` manually — let the browser set the multipart boundary; upload is an authenticated route so `csrfFetch` is correct, not the anon selfie plain-fetch path). On success: "Your pet is uploaded — pending approval 🐾"; if `awarded:true`, "You earned your Petoberfest points!".
   - Fetch `myUploads` to show the user their own pending/approved pets (covers the pending-preview gap).

## Component 5 — Task-type integration (Devtoberfest scoring, `tutorials-ims`)

Add the `PETOBERFEST` branch everywhere the code switches on task type so completions count toward Devtoberfest activity scoring:

- `srv/lib/user-progress.js` — `getMyCompletedTutorials` includes `PETOBERFEST` in the completed set with a `kind:'petoberfest'` discriminator, so `srv/lib/devtoberfest-feed.js` awards activity points by `TASKSLUG` match.
- `db/views.cds` — add PETOBERFEST arm to the `Tasks` union view + `TaskRecordsAnalytics` association.
- `srv/admin-service.js` — `AnalyticsTaskTypes` READ handler dropdown code; `srv/admin-service.cds` — `PetoberfestTaskRecords` projection.
- `srv/developer-service.js` — type maps in `getEventProgress`, `getMyCompletions`, `getAppSpaceProgress`.

## Component 6 — Value-help provider view (`tutorials-ims`)

Add a third `UNION ALL` arm to `db/src/TASK_VALUE_HELP_V1.hdbview` selecting from the new `Petoberfests` table, schema-identical to the existing arms (11 columns, UPPERCASE aliases), `TASKTYPE='PETOBERFEST'`, NULLing `MDFILEURL`/`STEPCOUNT`/`LAYOUT`:

```sql
UNION ALL
SELECT "ID", "SLUG", "TITLE", "PRIMARYTAG", "EXPERIENCETAG",
       "AVERAGETIMETOCOMPLETE", "DESCRIPTION",
       'PETOBERFEST'                AS "TASKTYPE",
       CAST(NULL AS NVARCHAR(1000)) AS "MDFILEURL",
       CAST(NULL AS INTEGER)        AS "STEPCOUNT",
       CAST(NULL AS NCLOB)          AS "LAYOUT"
FROM "COM_SAP_DEVELOPERS_IMS_PETOBERFESTS"
WHERE "STATUS" = 'ACTIVE' OR "STATUS" IS NULL
```

Keeping the view schema-identical is what makes the consumer side (Component 7) a near no-op.

## Component 7 — Consumer changes (`devtoberfest-planner`)

The consumer is almost entirely a pass-through. Confirmed touch-points:

- **Facade `db/external/tutorials.cds` (lines 29-56):** pure pass-through, no filter, no type enumeration. **No structural change** — the widened view is schema-identical. Update the stale NULL-column / "tutorials + puzzles" comments (lines 32, 42) for accuracy.
- **`Activity.task` value-help wiring (`app/maintain-activities/annotations.cds:157-189`):** `ValueListWithFixedValues:false`, `taskType` is display-only, no TASKTYPE filter. **No change** — PETOBERFEST rows flow through automatically.
- **Service projection `srv/sessions-service.cds:50`:** plain read-only projection. **No change.**
- **`Activity.taskType` (`db/schema.cds:143`):** free-form `String(20)`, not an enum. **No type change**; update the stale inline comment `'TUTORIAL' | 'PUZZLE'` → include PETOBERFEST (also lines 126-128).
- **The one real code change — `srv/sessions-service.js:140`:** the "Build Validation Tutorial" guard today blocks only `taskType === 'PUZZLE'`, so a PETOBERFEST activity would fall through and be **allowed**. Widen the guard to block anything that is not `TUTORIAL` (e.g. `if (activity.task_ID && activity.taskType !== 'TUTORIAL') return req.error(400, …)`). Decision: a pet-photo contest must not build a validation tutorial.
- **HDI plumbing (`db/src/TASK_VALUE_HELP_V1.hdbsynonym{,config}`, `tutorials-grants.hdbgrants`):** name-based synonym + role-based grant, neither column/row-aware. **No change.**
- **Tests (`test/activity-snapshot.test.js`):** add a PETOBERFEST case alongside the TUTORIAL/PUZZLE cases (same 11-column scaffold). Update comments as above.
- **Deploy:** planner `mta.yaml` is currently `version: 1.2.3`; bump per that repo's convention on deploy.

## Testing

- **Unit (in-memory SQLite, `tutorials-ims`):** upload records idempotent TaskRecord (second upload → `awarded:false`, no new COMPLETED); duplicate SHA rejected; `slideshow` returns only APPROVED; public photo serve 404s on non-APPROVED; `approve`/`hide` transitions; `myUploads` returns uploader's PENDING rows.
- **Hybrid (real HANA via `cds bind`, `tutorials-ims`):** raw-`db.run` BLOB store/serve round-trip (SQLite path cannot catch the LOB-locator gotcha); `TASK_VALUE_HELP_V1` returns PETOBERFEST rows.
- **Planner unit (`devtoberfest-planner`):** PETOBERFEST snapshot test; validation-tutorial guard rejects PETOBERFEST.
- **e2e Playwright (`tutorials-ims` `test/e2e/`, committed):** logged-in upload → pending state visible; admin approve → pet appears in public slideshow. (Tom's #1 rule: test the actual user-facing workflow through the real entry point; closes the "features ship dead" cross-seam gap.)

## Deploy notes

- `tutorials-ims`: full `mbt build` (admin-UI change → no `--skip-build` / `-m`; Step 3.5 gate). Regenerate `.hdbmigrationtable` for the two new entities via `cds build --production` (enum additions need none). `srv-qa` cp-list audit if any new `srv/lib/` file is imported transitively from `content-store.js`. MTA **minor** version bump (new feature) in `.deploy/mta.yaml`.
- `devtoberfest-planner`: standard `cds build --production` + MTA deploy; version bump per repo convention. Both repos share one HANA instance; deploy provider (view) before/with consumer so the synonym resolves.
- Sequencing: publish the widened `TASK_VALUE_HELP_V1` (provider) so the planner synonym resolves against the new arm; the `Petoberfests` table must exist before the view references it.

## Out of scope (not this change)

- Bulk export of winners / badge-award batch tooling.
- Email or push notifications on approval.
- Any generic "media contest" abstraction beyond Petoberfest (YAGNI — build the one type).

## Repos touched

| Repo | Nature |
|---|---|
| `tutorials-ims` (`tutorials-poc`) | Provider: schema, service, upload/serve routes, photo store, admin moderation UI, Hugo page + Vue island, task-type integration, value-help view arm. |
| `devtoberfest-planner` | Consumer: validation-tutorial guard widening, PETOBERFEST test, stale-comment cleanup. (No facade/value-list/HDI structural change.) |
