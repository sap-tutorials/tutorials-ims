# Tutorial Attachment Object-Store Pipeline — Design

**Date:** 2026-08-21
**Status:** Approved (design), pending implementation plan
**Related:** [#1931](https://github.com/sap-tutorials/tutorials-ims/issues/1931) (dead attachment links — the trigger), [#1963](https://github.com/sap-tutorials/tutorials-ims/issues/1963) (subsystem B: source markdown scanner, parallel effort), `docs/superpowers/specs/2026-08-17-persist-tutorial-images-design.md` (the image pipeline this mirrors).

## Problem

Tutorial markdown links to **repo attachment files** — `[CDS metadata extension ...](EX2_DDLX_ZRAP100_C_TRAVELTP.txt)` — render as **bare relative anchors** (`<a href=EX2_DDLX_ZRAP100_C_TRAVELTP.txt>`). Served at `/tutorials/<slug>`, the browser resolves them against the page path → 404. The attachment exists in the source repo (`abap-core-development/tutorials/<slug>/EX2_DDLX_ZRAP100_C_TRAVELTP.txt`) but is never ingested or served.

Root cause: `resolveImageURLs()` (`scripts/parsers/images.ts`) rewrites `![alt](relative)` **images** to absolute raw-GitHub URLs, but plain **links** `[text](relative)` get no rewrite. Images additionally flow through an object-store pipeline (ingest → S3 → served via `/img-cdn` / `/content/image-source`); attachments have no equivalent.

**Scope:** 44 relative non-http attachment links across 24 tutorials (`.txt`×18, `.json`×11, `.html`×7, `.csv`×6, `.zip`×1, `.pdf`×1) as of 2026-08-21.

## Decision

Attachments are **binary assets** and belong in the object store like images — not a markdown defect to fix at source. Build a parallel attachment pipeline that mirrors the image pipeline **minus resize/WebP**, serving files through a CAP endpoint the approuter already routes.

Confirmed decisions:
1. **New `TutorialAssets` CDS entity** (own `@cap-js/attachments` composition) reusing the existing **shared Object Store (S3)** binding — clean separation from image dedup/warm/backfill.
2. **Malware scanning: mock/off, image parity** — `malwareScanner-mocked`, `status:'Clean'` hardcoded. Files are already publicly downloadable from GitHub; we mirror curated SAP source. Real scanning is a documented follow-up gap.
3. **Serve inline-by-default with an explicit download option.** Text types view inline (the #1931 "CTRL+F the source code" use case); binaries download; `.html` is neutered (served as `text/plain`, never inline-executed). Every rendered attachment link is accompanied by a download affordance (`&dl=1`).

## Architecture

Seven components across parse → publish → serve, mirroring the image lifecycle. No approuter code changes (attachments need no resize; the existing `^/content/(.*)$ → srv-api` route carries the serve endpoint).

### 1. Detect + bake (parse JS + Hugo render-link hook)

**JS resolve (relative → raw URL).** Add an attachment-link resolver alongside `resolveImageURLs` in `scripts/parsers/images.ts` (or a new `scripts/parsers/attachment-links.ts` imported by `compose.ts`). It rewrites `[text](path)` where `path` ends in an allowlisted extension:
```
base = `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}`
[text](file.ext) → [text](${base}/file.ext)
```
Same guardrails as the image resolver: skip destinations starting with `http://`, `https://`, `#`, `mailto:`, `/` (absolute), or containing `../`. Only rewrite when the destination's extension is in the allowlist. This guarantees links to other tutorials (absolute/`/`-prefixed) and in-page anchors are never touched. Idempotent: a destination already on `raw.githubusercontent.com` is left as-is.

**Allowlist** (`ATTACHMENT_EXTENSIONS`): `.txt .csv .json .md .sql .abap .properties .yaml .yml .xml .html .zip .pdf .war .jar .zargo .har`. Seeded from the 6 observed extensions plus common code/text/archive types. `.html` is special-cased at serve time (see §5). Maintained in one shared module so the resolver, render hook, extract regex, and serve handler agree.

**Hugo render-link hook** — new `hugo/layouts/_default/_markup/render-link.html`:
- **Faithfully passes through all non-attachment links** unchanged (`<a href="{{ .Destination | safeURL }}"{{ with .Title }} title="{{ . }}"{{ end }}>{{ .Text | safeHTML }}</a>`), preserving Hugo's default behavior. Creating this hook overrides *all* link rendering, so the default branch must be complete and correct.
- When `.Destination` is a `raw.githubusercontent.com` URL with an allowlisted extension: emit the primary link with `href="/content/attachment-source?u=<urlquery .Destination>"` **plus a sibling download link** `href="/content/attachment-source?u=<enc>&dl=1"` (small `↓`/"download" affordance, class-tagged for styling, `aria-label`).
- Security note in-template: destination is a Hugo-known raw-GitHub URL derived from trusted authored markdown; `u` is percent-encoded via `urlquery`.

**Prerequisites/compose:** attachment links inside `## Prerequisites` raw-HTML tables (`prerequisites-markup.ts`) are **out of scope for v1** (body links only). Flagged for a follow-up if needed.

### 2. Store — `srv/lib/attachment-store.cjs` + `db/tutorial-assets.cds`

New CDS entity (mirror `db/tutorial-images.cds`):
```cds
entity TutorialAssets {
  key ID       : UUID;
  sourceUrl    : String(1024);
  tutorial     : Association to Tutorials on tutorial.slug = slug;
  slug         : String(255);
  channel      : String(8);          // 'prod' | 'qa'
  contentHash  : String(64);         // sha256 of stored bytes (dedup)
  mimeType     : String(128);
  filename     : String(255);        // for Content-Disposition
  content      : Composition of many Attachments;   // @cap-js/attachments
}
```
`attachment-store.cjs` is a copy of `image-store.cjs` with the entity/namespace swapped and `filename` persisted: `head(sourceUrl)`, `put(sourceUrl, {buffer, mimeType, contentHash, slug, channel, filename})`, `getStream(sourceUrl) → {stream, mimeType, filename}`, `remove(sourceUrl)`. Keyed by `sourceUrl`; one-row-per-URL via delete-then-insert (avoids `NonUpdatableProperties:[content]` 409). Wrapped in `withCtx` for the out-of-request warm/serve paths. `status:'Clean'` hardcoded (mock parity).

### 3. Ingest (push) — `srv/lib/attachment-ingest.cjs` + `POST /content/attachment`

Mirror `image-ingest.cjs` + `image-ingest-handler.js`:
- Route `app.post('/content/attachment', contentAuthMiddleware, express.raw({ type: '*/*', limit: '25mb' }), attachmentIngestHandler)` — **CONTENT_API_KEY auth** (reused). Query `?u=&slug=&channel=&force=`.
- Bytes-in (srv CF egress is anon-404'd by GitHub — same reason images push). Host allowlist = `raw.githubusercontent.com`. `contentHash = sha256(body)`; `head` hash-match → `unchanged`; else `put` → `stored`. `force=1` bypasses dedup to heal orphaned rows.
- **MIME:** prefer request `Content-Type`; when absent/generic, derive from an **extension→MIME map** (`.txt→text/plain; charset=utf-8`, `.json→application/json`, `.csv→text/csv`, `.md→text/markdown`, `.sql/.abap/.properties/.yaml/.yml/.xml→text/plain`, `.html→text/html` (neutered at serve), `.zip→application/zip`, `.pdf→application/pdf`, `.war/.jar→application/java-archive`, else `application/octet-stream`). Preserve `filename` (`sourceUrl.split('/').pop()`).
- 25 MB cap (reuse image limit; attachments are small source docs).

### 4. Warm on publish

- `extractAttachmentUrls(html)` — regex matching `/content/attachment-source?u=<enc>` in published HTML (mirror `extractImgCdnUrls`), deduped + decoded, `channelFor(u)` reused for prod/qa.
- Fire-and-forget in `srv/lib/content-publish-session.js` beside the existing image warm (`setImmediate`, failures swallowed, never fail publish).
- **PROD** srv egress reaches GitHub → warm-live auto-populates S3 at publish. **DEV** srv egress is GitHub-flagged → warm-live fails; population relies on the backfill push (§6). Identical asymmetry to images; documented, not a bug.

### 5. Serve — `srv/lib/attachment-source-handler.js` + `GET /content/attachment-source?u=&dl=`

Mirror `image-source-handler.js` minus resize:
- **Anonymous**, registered `app.get('/content/attachment-source', attachmentSourceHandler)`. 400 if `u` missing.
- Fast path `store.getStream(u)`; miss → **self-heal single-flight** (`_inflight` Map) calling `attachmentIngest(u, {slug:'', channel, deps})`. In PROD this heals; in DEV it 404s until backfilled (same as images).
- **Content-Disposition logic** (the core new behavior):
  - `dl=1` (or `dl=true`) → `attachment; filename="<filename>"` for **any** type.
  - Else by MIME class:
    - `text/plain`, `text/csv`, `text/markdown`, `application/json`, `application/xml` → `inline`.
    - `application/zip`, `application/pdf`, `application/java-archive`, `application/octet-stream` → `attachment; filename="<filename>"`.
    - **`text/html`** → override `Content-Type` to `text/plain; charset=utf-8`, serve `inline`, add `X-Content-Type-Options: nosniff`. Viewable + CTRL+F-able, **never executed** (no XSS from the content domain). `dl=1` still downloads it as `.html`.
  - Always set `X-Content-Type-Options: nosniff`, `Cache-Control: public, max-age=3600`, `X-Content-Source: attachment-store`.
- Miss/ingest-failed → **404** `{error:'Attachment unavailable'}` (fail-open — the page still renders; only the file link 404s, same as a genuinely-missing source file).

### 6. Backfill — `scripts/backfill-attachments.ts`

Mirror `scripts/backfill-images.ts`:
- `collectAttachmentUrls(publicDir)` walks `hugo/public/tutorials/*/index.html`, runs `extractAttachmentUrls` → `Map<sourceUrl, slug>`.
- `fetchAttachment(u, token)` anon-first, Bearer-token fallback **only on 404** for `raw.githubusercontent.com`.
- `pushAttachment(baseUrl, apiKey, u, slug, buffer, mimeType, force)` → `POST /content/attachment`.
- Concurrency pool (default 12), flags `--limit --concurrency --dry-run --force`. Exit 2 only if every push failed. `npm run backfill-attachments`.

### 7. Deploy wiring

- **srv-qa `cp` list** in `.deploy/mta.yaml`: add `attachment-store.cjs`, `attachment-ingest.cjs`, `attachment-source-handler.js`, and any shared helper (e.g. `attachment-warm-utils.js`) — the serve/warm handlers are registered in `srv/server.js`, which also boots srv-qa. Audit transitive `./` imports.
- New entity → `cds build --production` emits `TutorialAssets` hdbtable + `@cap-js/attachments` composition table + hdbmigrationtable. No `.cdsrc.json` build-task special-casing (our own `db/` entity auto-builds; the caching-plugin gotcha does not apply).
- **Object store binding** (`tutorials-objectstore`, `s3-standard`, shared) and **CONTENT_API_KEY** reused — no new resources/entitlements.
- Add `backfill-attachments` npm script.

## Data flow

```
Author markdown: [doc](EX2.txt)
  └─ compose/images.ts: → [doc](raw.githubusercontent.com/.../EX2.txt)
       └─ Hugo render-link.html: → <a href="/content/attachment-source?u=<enc>">doc</a> <a href="...&dl=1">↓</a>
            └─ publish: extractAttachmentUrls(html) → warm (PROD auto; DEV via backfill push)
                 └─ POST /content/attachment (bytes) → attachment-store.put → S3
  Browser GET /content/attachment-source?u=<enc>
       └─ approuter ^/content/(.*)$ → srv-api → attachmentSourceHandler
            └─ store.getStream (hit) | self-heal ingest (miss) → stream + Content-Disposition
```

## Error handling & fail-open

- Serve miss → 404, page unaffected. Broken source link (file absent in repo) → ingest fails → 404 (acceptable; equals a genuinely-missing file). Consistent with the image pipeline's "broken source img refs 404, fail-open serves."
- Warm/publish never throws into the publish tx.
- Ingest store error → 500 (surfaces to backfill for retry).

## Testing

- **Unit:** attachment-link resolver (allowlist hits/misses, guardrails, idempotency); `extractAttachmentUrls` regex; disposition map incl. `.html` neutering + `dl=1` override; ingest sha256 dedup + ext→MIME map.
- **Render hook (Hugo golden):** `.txt` link → `/content/attachment-source?u=...` + download sibling; **normal links (external, internal, anchors) render unchanged**.
- **Hybrid (real HANA + S3):** store put/head/getStream/remove round-trip; serve self-heal single-flight.
- **Smoke (post-deploy):** fetch a known attachment (`EX2_DDLX_ZRAP100_C_TRAVELTP.txt` from `abap-environment-rap100-enhance-data-model`) via `/content/attachment-source` → 200 + correct Content-Type + inline; `&dl=1` → attachment disposition.

## Out of scope

- Real malware scanning (documented gap; follow-up if downloadable-binary risk posture changes).
- Subsystem B source markdown scanner/fixer (#1963, parallel).
- Prerequisites-table attachment links (body links only, v1).

## Rollback

Delete the `render-link.html` hook (links revert to bare relative — the current dead-link state, no worse) and revert the parser/serve additions. The `TutorialAssets` entity + rows are inert if unreferenced. No data migration to unwind.
