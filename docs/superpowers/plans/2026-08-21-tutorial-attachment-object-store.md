# Tutorial Attachment Object-Store Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve tutorial repo attachment files (`.txt/.zip/.pdf/.csv/.json/...`) through the object store like images, so relative attachment links stop 404-ing (the #1931 follow-up).

**Architecture:** Mirror the image asset pipeline minus resize/WebP. A parser rewrites relative allowlisted links to raw-GitHub URLs; a new Hugo `render-link.html` hook wraps them to `/content/attachment-source?u=<enc>` (plus a download sibling). A new `TutorialAssets` CDS entity (own `@cap-js/attachments` composition on the existing shared S3 binding) holds bytes. A push ingest endpoint + backfill script populate the store; an anonymous serve endpoint streams with inline/download disposition (`.html` neutered). No approuter changes — the existing `^/content/(.*)$ → srv-api` route carries the endpoint.

**Tech Stack:** SAP CAP (Node.js, `@sap/cds`), `@cap-js/attachments` v4 + `@aws-sdk/client-s3`, Hugo/Goldmark render hooks, TypeScript parsers (`scripts/parsers/`), Vitest (`unit` project, in-memory SQLite via `cds.test`), Express handlers.

**Spec:** `docs/superpowers/specs/2026-08-21-tutorial-attachment-object-store-design.md`

## Global Constraints

- **srv-qa cp-list audit:** any new `srv/lib/*` file reachable from `content-store.js`/`content-publish-session.js`/`server.js` at runtime MUST be added to the `srv-qa` `cp` list in `.deploy/mta.yaml` (line ~174) or QA boot crashes at deploy. Guarded by `scripts/check-srv-qa-cp-list.ts` (runs in `postbuild:apps`).
- **CDS model validation:** run `npx cds deploy --to sqlite::memory:` before committing any `db/**/*.cds` change.
- **Schema build:** after adding an entity, run `npm run build:cds` (`cds build --production`); never hand-author `.hdbmigrationtable` ALTERs.
- **No raw SQL:** use `cds.ql`/CQL. (Store copies the image-store CQL pattern.)
- **Never SELECT a HANA BLOB alongside non-BLOB metadata in one CDS QL query** — the store fetches metadata and content in separate steps (image-store pattern already does this).
- **Tutorial slugs are lowercase canonical** — never compare slugs without `.toLowerCase()`; the store keys on `sourceUrl`, not slug, so this is informational.
- **PR over direct merge:** land via `gh pr create` from the feature branch; never direct-merge to `main`.
- **Vitest:** run unit tests with `npx vitest run --project unit <file>` from repo root.
- **Malware scanning stays mocked** (`status:'Clean'` hardcoded) — image parity, documented gap. Do not wire a real scanner.
- **RAW_BASE_URL** = `https://raw.githubusercontent.com` (exported from `scripts/parsers/types.ts`).
- **Attachment host allowlist** = `raw.githubusercontent.com` only (matches images).

---

## File Structure

**Parser / build (TypeScript):**
- `scripts/parsers/attachment-links.ts` — allowlist + `resolveAttachmentLinks()` (relative → raw URL, fence-aware).
- `scripts/parsers/compose.ts` — MODIFY: call `resolveAttachmentLinks` after `resolveImageURLs`.
- `hugo/layouts/_default/_markup/render-link.html` — NEW Hugo hook: passthrough + attachment wrap + download sibling.

**Data model:**
- `db/tutorial-assets.cds` — `TutorialAssets` entity.

**Runtime (srv, JS/ESM + CJS):**
- `srv/lib/attachment-store.cjs` — head/put/getStream/remove (keyed by sourceUrl; persists filename).
- `srv/lib/attachment-mime.cjs` — `extToMime()`, `dispositionFor()`.
- `srv/lib/attachment-warm-utils.js` — `extractAttachmentUrls()`, `warmAttachments()` (reuses `channelFor` from image-warm-utils).
- `srv/lib/attachment-ingest.cjs` — `ingestAttachment()`.
- `srv/lib/attachment-source-handler.js` — GET serve handler + `warmAttachmentsLive()`.
- `srv/lib/attachment-ingest-handler.js` — POST push handler.
- `srv/server.js` — MODIFY: register the two routes.
- `srv/lib/content-publish-session.js` — MODIFY: fire attachment warm beside image warm.

**Scripts / deploy:**
- `scripts/backfill-attachments.ts` — enumerate + push.
- `package.json` — MODIFY: add `backfill-attachments` script.
- `.deploy/mta.yaml` — MODIFY: add 4 new `srv/lib/attachment-*` files to srv-qa `cp` list.

---

## Task 1: Attachment-link resolver (parser)

**Files:**
- Create: `scripts/parsers/attachment-links.ts`
- Test: `test/parsers/attachment-links.test.ts`

**Interfaces:**
- Produces: `ATTACHMENT_EXTENSIONS: Set<string>` (lowercase, no dot); `isAttachmentPath(path: string): boolean`; `resolveAttachmentLinks(content: string, opts: { repo: string, branch: string, slug: string, rewrite?: boolean }): string`.
- Consumes: `RAW_BASE_URL` from `./types.js`; `createFenceTracker` from `./fence-tracker.js`.

- [ ] **Step 1: Write the failing test**

```ts
// test/parsers/attachment-links.test.ts
import { describe, it, expect } from 'vitest'
import { resolveAttachmentLinks, isAttachmentPath } from '../../scripts/parsers/attachment-links.js'

const opts = { repo: 'abap-core-development', branch: 'main', slug: 'rap100' }
const base = 'https://raw.githubusercontent.com/sap-tutorials/abap-core-development/main/tutorials/rap100'

describe('resolveAttachmentLinks', () => {
  it('rewrites a relative allowlisted link to a raw-GitHub URL', () => {
    const out = resolveAttachmentLinks('[doc](EX2_DDLX.txt)', opts)
    expect(out).toBe(`[doc](${base}/EX2_DDLX.txt)`)
  })
  it('rewrites ./-prefixed links and strips the ./', () => {
    expect(resolveAttachmentLinks('[d](./a.csv)', opts)).toBe(`[d](${base}/a.csv)`)
  })
  it('leaves images (![]) untouched', () => {
    expect(resolveAttachmentLinks('![alt](img.png)', opts)).toBe('![alt](img.png)')
  })
  it('leaves absolute, anchor, mailto, root-relative, and ../ links untouched', () => {
    for (const s of ['[a](https://x.com/f.txt)', '[a](#sec)', '[a](mailto:x@y.z)', '[a](/other/f.txt)', '[a](../sib/f.txt)']) {
      expect(resolveAttachmentLinks(s, opts)).toBe(s)
    }
  })
  it('leaves non-allowlisted extensions untouched', () => {
    expect(resolveAttachmentLinks('[a](page.aspx)', opts)).toBe('[a](page.aspx)')
  })
  it('does not touch link-like text inside a fenced code block', () => {
    const src = '```md\n[x](y.txt)\n```'
    expect(resolveAttachmentLinks(src, opts)).toBe(src)
  })
  it('is idempotent (already-raw URLs are left as-is)', () => {
    const once = resolveAttachmentLinks('[d](EX2.txt)', opts)
    expect(resolveAttachmentLinks(once, opts)).toBe(once)
  })
  it('respects rewrite:false', () => {
    expect(resolveAttachmentLinks('[d](a.txt)', { ...opts, rewrite: false })).toBe('[d](a.txt)')
  })
  it('isAttachmentPath matches allowlist case-insensitively', () => {
    expect(isAttachmentPath('X.TXT')).toBe(true)
    expect(isAttachmentPath('x.png')).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/parsers/attachment-links.test.ts`
Expected: FAIL — cannot resolve module `attachment-links.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// scripts/parsers/attachment-links.ts
import { RAW_BASE_URL } from './types.js'
import { createFenceTracker } from './fence-tracker.js'

// Repo attachment file extensions served through the object store (lowercase, no dot).
// KEEP IN SYNC with the Hugo render-link hook's disposition and srv/lib/attachment-mime.cjs.
export const ATTACHMENT_EXTENSIONS = new Set([
  'txt', 'csv', 'json', 'md', 'sql', 'abap', 'properties',
  'yaml', 'yml', 'xml', 'html', 'zip', 'pdf', 'war', 'jar', 'zargo', 'har',
])

export function isAttachmentPath(path: string): boolean {
  const m = /\.([a-z0-9]+)$/i.exec(path.trim())
  return m ? ATTACHMENT_EXTENSIONS.has(m[1].toLowerCase()) : false
}

export interface AttachmentResolveOpts {
  repo: string
  branch: string
  slug: string
  rewrite?: boolean
}

// Matches a markdown link `[text](dest)` NOT preceded by `!` (which would be an image).
// Destination captured up to whitespace or `)`; an optional `"title"` is preserved.
const LINK_RE = /(^|[^!])(\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g

export function resolveAttachmentLinks(content: string, opts: AttachmentResolveOpts): string {
  const { repo, branch, slug, rewrite = true } = opts
  if (!rewrite) return content
  const base = `${RAW_BASE_URL}/sap-tutorials/${repo}/${branch}/tutorials/${slug}`
  const fence = createFenceTracker()
  return content
    .split('\n')
    .map((line) => {
      if (fence(line)) return line // inside a code fence — leave verbatim
      return line.replace(LINK_RE, (m, pre, open, dest, tail) => {
        if (/^(https?:\/\/|#|mailto:|\/)/i.test(dest)) return m
        if (dest.includes('../')) return m
        if (!isAttachmentPath(dest)) return m
        const clean = dest.replace(/^\.?\//, '')
        return `${pre}${open}${base}/${clean}${tail}`
      })
    })
    .join('\n')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/parsers/attachment-links.test.ts`
Expected: PASS (all 9 cases).

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/attachment-links.ts test/parsers/attachment-links.test.ts
git commit -m "feat(attachments): parser resolver for relative attachment links (#1931)"
```

---

## Task 2: Wire the resolver into compose

**Files:**
- Modify: `scripts/parsers/compose.ts` (right after the `resolveImageURLs(mergedBody, …)` call, ~line 108-112)
- Test: `test/parsers/attachment-links-compose.test.ts` (or extend an existing compose test)

**Interfaces:**
- Consumes: `resolveAttachmentLinks` from `./attachment-links.js` (Task 1).

- [ ] **Step 1: Write the failing test**

```ts
// test/parsers/attachment-links-compose.test.ts
import { describe, it, expect } from 'vitest'
import { composeTutorial } from '../../scripts/parsers/compose.js'

describe('compose rewrites attachment links in the body', () => {
  it('body [doc](EX2.txt) becomes a raw-GitHub URL', () => {
    const md = `---\ntitle: T\n---\n\n## Intro\n\nSee [doc](EX2.txt) below.\n`
    const out = composeTutorial(md, { repo: 'abap-core-development', branch: 'main', slug: 'rap100', target: 'hugo' } as any)
    expect(out.body ?? JSON.stringify(out)).toContain(
      'https://raw.githubusercontent.com/sap-tutorials/abap-core-development/main/tutorials/rap100/EX2.txt'
    )
  })
})
```

> NOTE: inspect `composeTutorial`'s real signature/return shape in `scripts/parsers/compose.ts` and adjust the call/assertion to match (it returns a composed object; assert against the field that carries the rendered body). If an existing compose test already exercises `resolveImageURLs`, add this case there instead of a new file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/parsers/attachment-links-compose.test.ts`
Expected: FAIL — body still contains the bare `EX2.txt`.

- [ ] **Step 3: Add the call in compose.ts**

Find (~line 108):
```ts
  let processedBody = resolveImageURLs(mergedBody, {
    repo: opts.repo, branch: opts.branch, slug: opts.slug,
    rewriteImages: opts.rewriteImages,
  })
```
Add immediately after it:
```ts
  // [#1931] Rewrite relative attachment links (.txt/.zip/.pdf/...) to raw-GitHub
  // URLs so the render-link hook can route them through /content/attachment-source.
  // Gated by rewriteImages (same "resolve relative repo paths" switch as images).
  processedBody = resolveAttachmentLinks(processedBody, {
    repo: opts.repo, branch: opts.branch, slug: opts.slug,
    rewrite: opts.rewriteImages,
  })
```
Add the import at the top with the other parser imports:
```ts
import { resolveAttachmentLinks } from './attachment-links.js'
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/parsers/attachment-links-compose.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/parsers/compose.ts test/parsers/attachment-links-compose.test.ts
git commit -m "feat(attachments): wire attachment-link resolver into compose (#1931)"
```

---

## Task 3: Hugo render-link hook

**Files:**
- Create: `hugo/layouts/_default/_markup/render-link.html`
- Test: `test/parsers/render-link-hook.test.ts` (template-content assertions — a full Hugo build is verified in Task 16)

**Interfaces:**
- Emits browser URL shape `/content/attachment-source?u=<urlquery .Destination>` and download sibling `…&dl=1`.

- [ ] **Step 1: Write the failing test**

```ts
// test/parsers/render-link-hook.test.ts
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'

const p = 'hugo/layouts/_default/_markup/render-link.html'

describe('render-link hook', () => {
  it('exists', () => { expect(existsSync(p)).toBe(true) })
  it('wraps raw.githubusercontent destinations to the attachment endpoint', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('raw.githubusercontent.com')
    expect(t).toContain('/content/attachment-source?u=')
    expect(t).toContain('dl=1')                 // download sibling
    expect(t).toContain('urlquery')             // encodes the source URL
  })
  it('has a passthrough branch for non-attachment links', () => {
    const t = readFileSync(p, 'utf8')
    expect(t).toContain('.Destination | safeURL') // default anchor emission
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/parsers/render-link-hook.test.ts`
Expected: FAIL — file does not exist.

- [ ] **Step 3: Write the hook**

```go-html-template
{{- /* Render hook for links (issue #1931).
       Default behavior for all links is Hugo's standard <a> emission. Attachment
       links whose destination is a raw.githubusercontent.com URL with an
       allowlisted extension (rewritten by scripts/parsers/attachment-links.ts)
       are routed through the CAP attachment store and get a download sibling.
       KEEP the extension list in sync with attachment-links.ts / attachment-mime.cjs. */ -}}
{{- $dest := .Destination -}}
{{- $exts := slice "txt" "csv" "json" "md" "sql" "abap" "properties" "yaml" "yml" "xml" "html" "zip" "pdf" "war" "jar" "zargo" "har" -}}
{{- $ext := lower (path.Ext $dest | strings.TrimPrefix ".") -}}
{{- $isAttachment := and (hasPrefix $dest "https://raw.githubusercontent.com/") (in $exts $ext) -}}
{{- if $isAttachment -}}
  {{- $enc := $dest | urlquery -}}
  {{- $view := printf "/content/attachment-source?u=%s" $enc -}}
  {{- $dl := printf "/content/attachment-source?u=%s&dl=1" $enc -}}
  <a href="{{ $view | safeURL }}"{{ with .Title }} title="{{ . }}"{{ end }} class="tutorial-attachment-link">{{ .Text | safeHTML }}</a><a href="{{ $dl | safeURL }}" class="tutorial-attachment-download" aria-label="Download {{ .PlainText | default .Text }}" download>&#8595;</a>
{{- else -}}
  <a href="{{ $dest | safeURL }}"{{ with .Title }} title="{{ . }}"{{ end }}{{ if strings.HasPrefix $dest "http" }} rel="noopener"{{ end }}>{{ .Text | safeHTML }}</a>
{{- end -}}
```

> NOTE: verify against the running Hugo version that `path.Ext`, `strings.TrimPrefix`, and `in` are available (they are in modern Hugo). Confirm no OTHER partial already emits links in a way this would double-wrap; the option-tabs shortcode reprocesses inner markdown, so keep the emitted `<a>` on a single line (same single-line rule as `render-image.html`, issue #1591) — the template above keeps each `<a>` unbroken.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/parsers/render-link-hook.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add hugo/layouts/_default/_markup/render-link.html test/parsers/render-link-hook.test.ts
git commit -m "feat(attachments): Hugo render-link hook routes attachment links to store (#1931)"
```

---

## Task 4: TutorialAssets CDS entity

**Files:**
- Create: `db/tutorial-assets.cds`
- Test: `test/unit/tutorial-assets-model.test.js` (mirror `test/unit/tutorial-images-model.test.js`)

**Interfaces:**
- Produces entity `com.sap.developers.ims.TutorialAssets` with composition `…TutorialAssets.content`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/tutorial-assets-model.test.js
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'

describe('TutorialAssets model', () => {
  it('compiles with a filename column and an Attachments composition', async () => {
    const m = await cds.load(['db/tutorial-assets.cds'], { root: '.' })
    const e = cds.linked(m).definitions['com.sap.developers.ims.TutorialAssets']
    expect(e).toBeTruthy()
    expect(e.elements.sourceUrl.length).toBe(1024)
    expect(e.elements.filename).toBeTruthy()
    expect(e.elements.content.type).toBe('cds.Composition')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/tutorial-assets-model.test.js`
Expected: FAIL — file `db/tutorial-assets.cds` not found.

- [ ] **Step 3: Write the entity**

```cds
using { Attachments } from '@cap-js/attachments';
using { com.sap.developers.ims.Tutorials } from './schema';

namespace com.sap.developers.ims;

entity TutorialAssets {
  key ID        : UUID;
      sourceUrl   : String(1024);  // raw.githubusercontent.com URL; one-row-per-sourceUrl maintained by attachment-store put() (delete-then-insert), NOT a DB constraint
      tutorial    : Association to Tutorials on tutorial.slug = slug;
      slug        : String(255);             // lowercase canonical
      channel     : String(8);               // 'prod' | 'qa'
      contentHash : String(64);              // sha-256 of stored bytes
      mimeType    : String(128);
      filename    : String(255);             // for Content-Disposition
      content     : Composition of many Attachments;
}
```

- [ ] **Step 4: Run test + validate model deploys**

Run: `npx vitest run --project unit test/unit/tutorial-assets-model.test.js`
Expected: PASS.
Then (Global Constraint): `npx cds deploy --to sqlite::memory:`
Expected: exits 0, no compile error.

- [ ] **Step 5: Commit**

```bash
git add db/tutorial-assets.cds test/unit/tutorial-assets-model.test.js
git commit -m "feat(attachments): TutorialAssets entity (#1931)"
```

---

## Task 5: attachment-store.cjs

**Files:**
- Create: `srv/lib/attachment-store.cjs`
- Test: `test/unit/attachment-store.test.js` (mirror `test/unit/image-store.test.js`)

**Interfaces:**
- Produces: `head(sourceUrl) → {exists, ID?, contentHash?, mimeType?, filename?}`; `put(sourceUrl, {buffer, mimeType, contentHash, slug, channel, filename}) → void`; `getStream(sourceUrl) → {stream, mimeType, filename} | null`; `remove(sourceUrl) → void`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/attachment-store.test.js
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
cds.test('serve', '--project', '.', '--in-memory')
const store = require('../../srv/lib/attachment-store.cjs')

describe('attachment-store round-trip', () => {
  const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
  it('put → head → getStream returns the same bytes, mime, and filename', async () => {
    const buffer = Buffer.from('@Search.searchable: true', 'utf8')
    await store.put(url, { buffer, mimeType: 'text/plain; charset=utf-8', contentHash: 'h1', slug: 's', channel: 'prod', filename: 'EX2.txt' })
    const h = await store.head(url)
    expect(h.exists).toBe(true)
    expect(h.contentHash).toBe('h1')
    expect(h.filename).toBe('EX2.txt')
    const got = await store.getStream(url)
    const chunks = []
    for await (const c of got.stream) chunks.push(c)
    expect(Buffer.concat(chunks)).toEqual(buffer)
    expect(got.mimeType).toMatch(/text\/plain/)
    expect(got.filename).toBe('EX2.txt')
  })
  it('head returns exists:false for an unknown url', async () => {
    expect((await store.head('https://raw.githubusercontent.com/o/r/main/none.txt')).exists).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/attachment-store.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the store (copy of image-store.cjs, entity swapped, filename added)**

```js
'use strict'
const cds = require('@sap/cds')
const { Readable } = require('node:stream')

// Metadata on TutorialAssets; original bytes in its Attachments composition.
// Mirror of image-store.cjs; see that file for the withCtx/tenant rationale.
function linkedContent() {
  return cds.linked(cds.model).definitions['com.sap.developers.ims.TutorialAssets.content']
}
function withCtx(fn) { return cds.context ? fn() : cds.tx(fn) }

async function head(sourceUrl) {
  return withCtx(async () => {
    const { TutorialAssets } = cds.entities('com.sap.developers.ims')
    const row = await SELECT.one.from(TutorialAssets)
      .columns('ID', 'contentHash', 'mimeType', 'filename').where({ sourceUrl })
    return row
      ? { exists: true, ID: row.ID, contentHash: row.contentHash, mimeType: row.mimeType, filename: row.filename }
      : { exists: false }
  })
}

async function put(sourceUrl, { buffer, mimeType, contentHash, slug, channel, filename }) {
  return withCtx(async () => {
    const { TutorialAssets } = cds.entities('com.sap.developers.ims')
    await remove(sourceUrl) // delete-then-insert avoids NonUpdatableProperties:[content] 409
    const parentID = cds.utils.uuid()
    const name = filename || sourceUrl.split('/').pop()
    await INSERT.into(TutorialAssets).entries({ ID: parentID, sourceUrl, slug, channel, contentHash, mimeType, filename: name })
    const AttachmentsSrv = await cds.connect.to('attachments')
    await AttachmentsSrv.put(linkedContent(), {
      ID: cds.utils.uuid(), up__ID: parentID, url: cds.utils.uuid(),
      content: Readable.from(buffer), mimeType, filename: name, status: 'Clean',
    })
  })
}

async function getStream(sourceUrl) {
  return withCtx(async () => {
    const meta = await head(sourceUrl)
    if (!meta.exists) return null
    const Content = linkedContent()
    const att = await SELECT.one.from(Content).columns('ID').where({ up__ID: meta.ID })
    if (!att) return null
    const AttachmentsSrv = await cds.connect.to('attachments')
    const stream = await AttachmentsSrv.get(Content, { ID: att.ID })
    return stream ? { stream, mimeType: meta.mimeType, filename: meta.filename } : null
  })
}

async function remove(sourceUrl) {
  return withCtx(async () => {
    const { TutorialAssets } = cds.entities('com.sap.developers.ims')
    await DELETE.from(TutorialAssets).where({ sourceUrl })
  })
}

module.exports = { head, put, getStream, remove }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/attachment-store.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/attachment-store.cjs test/unit/attachment-store.test.js
git commit -m "feat(attachments): attachment-store CRUD on TutorialAssets (#1931)"
```

---

## Task 6: attachment-mime.cjs (MIME + disposition)

**Files:**
- Create: `srv/lib/attachment-mime.cjs`
- Test: `test/unit/attachment-mime.test.js`

**Interfaces:**
- Produces: `extToMime(filenameOrUrl: string) → string`; `dispositionFor(mimeType: string, opts: { download?: boolean, filename?: string }) → { contentType: string, disposition: string }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/attachment-mime.test.js
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { extToMime, dispositionFor } = require('../../srv/lib/attachment-mime.cjs')

describe('extToMime', () => {
  it('maps known extensions', () => {
    expect(extToMime('a.txt')).toMatch(/text\/plain/)
    expect(extToMime('a.json')).toBe('application/json')
    expect(extToMime('a.csv')).toBe('text/csv')
    expect(extToMime('a.zip')).toBe('application/zip')
    expect(extToMime('a.pdf')).toBe('application/pdf')
  })
  it('falls back to octet-stream for unknown', () => {
    expect(extToMime('a.bin')).toBe('application/octet-stream')
  })
})

describe('dispositionFor', () => {
  it('text types serve inline', () => {
    expect(dispositionFor('text/plain; charset=utf-8', { filename: 'a.txt' }).disposition).toMatch(/^inline/)
  })
  it('binaries force attachment with filename', () => {
    const d = dispositionFor('application/zip', { filename: 'a.zip' })
    expect(d.disposition).toBe('attachment; filename="a.zip"')
  })
  it('text/html is neutered to text/plain inline', () => {
    const d = dispositionFor('text/html', { filename: 'a.html' })
    expect(d.contentType).toMatch(/text\/plain/)
    expect(d.disposition).toMatch(/^inline/)
  })
  it('download:true forces attachment for any type', () => {
    const d = dispositionFor('text/plain; charset=utf-8', { download: true, filename: 'a.txt' })
    expect(d.disposition).toBe('attachment; filename="a.txt"')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/attachment-mime.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```js
'use strict'
// Extension→MIME + Content-Disposition policy for tutorial attachments (#1931).
// KEEP the extension set in sync with scripts/parsers/attachment-links.ts and the render-link hook.

const EXT_MIME = {
  txt: 'text/plain; charset=utf-8', csv: 'text/csv', json: 'application/json',
  md: 'text/markdown; charset=utf-8', sql: 'text/plain; charset=utf-8',
  abap: 'text/plain; charset=utf-8', properties: 'text/plain; charset=utf-8',
  yaml: 'text/plain; charset=utf-8', yml: 'text/plain; charset=utf-8',
  xml: 'text/plain; charset=utf-8', html: 'text/html',
  zip: 'application/zip', pdf: 'application/pdf',
  war: 'application/java-archive', jar: 'application/java-archive',
  zargo: 'application/octet-stream', har: 'application/json',
}

function extToMime(filenameOrUrl) {
  const m = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(String(filenameOrUrl))
  const ext = m ? m[1].toLowerCase() : ''
  return EXT_MIME[ext] || 'application/octet-stream'
}

// Inline-viewable MIME classes (rest download).
const INLINE = new Set(['text/plain', 'text/csv', 'text/markdown', 'application/json', 'application/xml'])

function baseType(mime) { return String(mime).split(';')[0].trim().toLowerCase() }

function dispositionFor(mimeType, { download = false, filename = 'file' } = {}) {
  const safeName = String(filename).replace(/"/g, '')
  // text/html is neutered: serve as text/plain, inline, never executed.
  if (baseType(mimeType) === 'text/html' && !download) {
    return { contentType: 'text/plain; charset=utf-8', disposition: `inline; filename="${safeName}"` }
  }
  if (download) return { contentType: mimeType, disposition: `attachment; filename="${safeName}"` }
  const inline = INLINE.has(baseType(mimeType))
  return { contentType: mimeType, disposition: `${inline ? 'inline' : 'attachment'}; filename="${safeName}"` }
}

module.exports = { extToMime, dispositionFor }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/attachment-mime.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/attachment-mime.cjs test/unit/attachment-mime.test.js
git commit -m "feat(attachments): ext→MIME + Content-Disposition policy (#1931)"
```

---

## Task 7: attachment-warm-utils.js

**Files:**
- Create: `srv/lib/attachment-warm-utils.js`
- Test: `test/unit/attachment-warm-utils.test.js`

**Interfaces:**
- Consumes: `channelFor` from `./image-warm-utils.js` (re-export).
- Produces: `extractAttachmentUrls(html: string) → string[]`; `warmAttachments(urls, { slug, ingestFn }) → Promise<void>`; re-export `channelFor`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/attachment-warm-utils.test.js
import { describe, it, expect, vi } from 'vitest'
import { extractAttachmentUrls, warmAttachments } from '../../srv/lib/attachment-warm-utils.js'

describe('extractAttachmentUrls', () => {
  it('extracts and decodes u= from attachment-source hrefs (view + dl)', () => {
    const raw = 'https://raw.githubusercontent.com/o/r/main/tutorials/s/EX2.txt'
    const enc = encodeURIComponent(raw)
    const html = `<a href="/content/attachment-source?u=${enc}">d</a><a href="/content/attachment-source?u=${enc}&dl=1">↓</a>`
    expect(extractAttachmentUrls(html)).toEqual([raw]) // deduped
  })
  it('returns [] when there are no attachment links', () => {
    expect(extractAttachmentUrls('<p>no links</p>')).toEqual([])
  })
})

describe('warmAttachments', () => {
  it('calls ingestFn per url and never throws on failure', async () => {
    const ingestFn = vi.fn().mockRejectedValue(new Error('boom'))
    await expect(warmAttachments(['a', 'b'], { slug: 's', ingestFn })).resolves.toBeUndefined()
    expect(ingestFn).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/attachment-warm-utils.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```js
// srv/lib/attachment-warm-utils.js
// Pure warm-orchestration utilities for tutorial attachments (mirror of image-warm-utils.js).
export { channelFor } from './image-warm-utils.js'
import { channelFor } from './image-warm-utils.js'

/**
 * Extract + decode unique source URLs from `/content/attachment-source?u=<enc>` hrefs.
 * Matches both `?u=` and `&u=`; captures up to the next & / quote / whitespace / >.
 * @param {string} html
 * @returns {string[]}
 */
export function extractAttachmentUrls(html) {
  const results = new Set()
  const re = /\/content\/attachment-source[^"'\s>]*[?&]u=([^&"'\s>]+)/g
  let m
  while ((m = re.exec(html)) !== null) {
    try { results.add(decodeURIComponent(m[1])) } catch { /* skip malformed */ }
  }
  return [...results]
}

/**
 * Warm the attachment store for `urls`. Per-URL try/catch; always resolves.
 * @param {string[]} urls
 * @param {{ slug: string, ingestFn: (url: string, opts: {slug: string, channel: string}) => Promise<{action: string, status?: number}> }} opts
 * @returns {Promise<void>}
 */
export async function warmAttachments(urls, { slug, ingestFn }) {
  for (const url of urls) {
    const channel = channelFor(url)
    try {
      const result = await ingestFn(url, { slug, channel })
      if (result?.action === 'failed') {
        console.warn(`[attachment-warm] slug=${slug} u=${url}: ingest failed (status=${result.status})`)
      }
    } catch (err) {
      console.warn(`[attachment-warm] slug=${slug} u=${url}: ingest threw: ${err?.message}`)
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/attachment-warm-utils.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/attachment-warm-utils.js test/unit/attachment-warm-utils.test.js
git commit -m "feat(attachments): warm-utils (extract + orchestrate) (#1931)"
```

---

## Task 8: attachment-ingest.cjs

**Files:**
- Create: `srv/lib/attachment-ingest.cjs`
- Test: `test/unit/attachment-ingest.test.js` (mirror `test/unit/image-ingest.test.js`)

**Interfaces:**
- Consumes: `fetchImageResponse` from `./img-cdn-fetch.cjs` (reused — generic HTTP fetch with anon-first/token-on-404), `extToMime` from `./attachment-mime.cjs`, store from Task 5.
- Produces: `ingestAttachment(sourceUrl, { slug, channel, deps }) → { action: 'stored'|'unchanged'|'failed', status?, contentHash?, mimeType? }` where `deps = { fetchImageResponse, safeFetch, resolveSecret, store, hash? }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/attachment-ingest.test.js
import { describe, it, expect, vi } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ingestAttachment } = require('../../srv/lib/attachment-ingest.cjs')

function res(body, { ok = true, status = 200, ct = 'text/plain' } = {}) {
  return { ok, status, headers: new Map([['content-type', ct], ['content-length', String(body.length)]]),
    arrayBuffer: async () => Buffer.from(body) }
}

describe('ingestAttachment', () => {
  const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
  it('stores on a fresh URL', async () => {
    const store = { head: vi.fn().mockResolvedValue({ exists: false }), put: vi.fn().mockResolvedValue() }
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('hello')), safeFetch: {}, resolveSecret: {}, store }
    const out = await ingestAttachment(url, { slug: 's', channel: 'prod', deps })
    expect(out.action).toBe('stored')
    expect(store.put).toHaveBeenCalledOnce()
  })
  it('is unchanged when hash matches', async () => {
    const buf = Buffer.from('hello')
    const crypto = require('node:crypto')
    const h = crypto.createHash('sha256').update(buf).digest('hex')
    const store = { head: vi.fn().mockResolvedValue({ exists: true, contentHash: h }), put: vi.fn() }
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('hello')), store }
    const out = await ingestAttachment(url, { slug: 's', channel: 'prod', deps })
    expect(out.action).toBe('unchanged')
    expect(store.put).not.toHaveBeenCalled()
  })
  it('fails on a non-ok fetch', async () => {
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('', { ok: false, status: 404 })), store: {} }
    const out = await ingestAttachment(url, { slug: 's', channel: 'prod', deps })
    expect(out).toEqual({ action: 'failed', status: 404 })
  })
  it('uses extToMime when the response content-type is generic', async () => {
    const store = { head: vi.fn().mockResolvedValue({ exists: false }), put: vi.fn().mockResolvedValue() }
    const deps = { fetchImageResponse: vi.fn().mockResolvedValue(res('{}', { ct: 'application/octet-stream' })), store }
    await ingestAttachment('https://raw.githubusercontent.com/o/r/main/a.json', { slug: 's', channel: 'prod', deps })
    expect(store.put.mock.calls[0][1].mimeType).toBe('application/json')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/attachment-ingest.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the module (copy of image-ingest.cjs, MIME from extToMime)**

```js
'use strict'
const crypto = require('node:crypto')
const { extToMime } = require('./attachment-mime.cjs')
const ATTACHMENT_HOSTS = new Set(['raw.githubusercontent.com'])
const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024

async function ingestAttachment(sourceUrl, { slug, channel, deps }) {
  const { fetchImageResponse, safeFetch, resolveSecret, store,
          hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex') } = deps
  let host
  try { host = new URL(sourceUrl).hostname } catch { return { action: 'failed', status: 400 } }

  const res = await fetchImageResponse(sourceUrl, {
    safeFetch, resolveSecret, host, allowedHosts: ATTACHMENT_HOSTS, timeoutMs: 12000, maxRetries: 2,
  })
  if (!res.ok) return { action: 'failed', status: res.status }

  const contentLength = Number(res.headers.get('content-length'))
  if (!Number.isNaN(contentLength) && contentLength > MAX_BYTES) return { action: 'failed', status: 413 }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (buffer.length > MAX_BYTES) return { action: 'failed', status: 413 }

  const contentHash = hash(buffer)
  const existing = await store.head(sourceUrl)
  if (existing.exists && existing.contentHash === contentHash) return { action: 'unchanged', contentHash }

  // GitHub serves most text attachments as text/plain; trust a specific content-type,
  // otherwise derive from the extension so .json/.csv/.pdf get correct types.
  const ct = res.headers.get('content-type') || ''
  const mimeType = (ct && ct !== 'application/octet-stream') ? ct : extToMime(sourceUrl)
  const filename = sourceUrl.split('/').pop()
  await store.put(sourceUrl, { buffer, mimeType, contentHash, slug, channel, filename })
  return { action: 'stored', contentHash, mimeType }
}

module.exports = { ingestAttachment }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --project unit test/unit/attachment-ingest.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/attachment-ingest.cjs test/unit/attachment-ingest.test.js
git commit -m "feat(attachments): ingestAttachment with ext-aware MIME (#1931)"
```

---

## Task 9: attachment-source-handler.js (serve + warm-live)

**Files:**
- Create: `srv/lib/attachment-source-handler.js`
- Test: `test/unit/attachment-source-endpoint.test.js` (mirror `test/unit/image-source-endpoint.test.js`)

**Interfaces:**
- Consumes: store (Task 5), `ingestAttachment` (Task 8), `dispositionFor` (Task 6), `channelFor`/`warmAttachments` (Task 7), `fetchImageResponse` (`./img-cdn-fetch.cjs`), `safeFetch`, `resolveSecret`.
- Produces: `attachmentSourceHandler(req, res)`; `warmAttachmentsLive(urls, { slug })`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/attachment-source-endpoint.test.js
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const project = cds.test('serve', '--project', '.', '--in-memory')
const store = require('../../srv/lib/attachment-store.cjs')
const base = '/content/attachment-source'

describe('GET /content/attachment-source', () => {
  it('streams a stored .txt inline', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/EX2.txt'
    await store.put(url, { buffer: Buffer.from('code'), mimeType: 'text/plain; charset=utf-8', contentHash: 'h', slug: 's', channel: 'prod', filename: 'EX2.txt' })
    const res = await project.get(`${base}?u=${encodeURIComponent(url)}`, { responseType: 'arraybuffer' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/text\/plain/)
    expect(res.headers['content-disposition']).toMatch(/^inline/)
    expect(res.headers['x-content-type-options']).toBe('nosniff')
  })
  it('dl=1 forces attachment disposition', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/D2.txt'
    await store.put(url, { buffer: Buffer.from('x'), mimeType: 'text/plain; charset=utf-8', contentHash: 'h2', slug: 's', channel: 'prod', filename: 'D2.txt' })
    const res = await project.get(`${base}?u=${encodeURIComponent(url)}&dl=1`, { responseType: 'arraybuffer' })
    expect(res.headers['content-disposition']).toMatch(/^attachment/)
  })
  it('400 on missing u', async () => {
    await expect(project.get(base)).rejects.toMatchObject({ response: { status: 400 } })
  })
  it('404 on a miss that cannot self-heal (github-blocked in test)', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/missing.txt'
    await expect(project.get(`${base}?u=${encodeURIComponent(url)}`)).rejects.toMatchObject({ response: { status: 404 } })
  })
})
```

> NOTE: the 404 self-heal case relies on the srv being unable to fetch GitHub in the test env (network-blocked / anon-404), mirroring `img-store-github-blocked.test.js`. If the test env has network, stub `fetchImageResponse` or assert on `img-store-github-blocked.test.js`'s approach.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/attachment-source-endpoint.test.js`
Expected: FAIL — handler/route not present.

- [ ] **Step 3: Write the handler** (Task 11 registers the route; this test will stay red until Task 11 — that is expected. Implement the handler now; re-run after Task 11.)

```js
// srv/lib/attachment-source-handler.js
// Express handler for GET /content/attachment-source?u=<enc>&dl=. Anonymous.
// Streams the stored attachment; self-heals on miss (single-flight). Mirror of image-source-handler.js.
import cds from '@sap/cds'
import { createRequire } from 'node:module'
import { safeFetch } from './safe-fetch.js'
import { resolveSecret } from './secret-resolver.js'
import { channelFor, warmAttachments } from './attachment-warm-utils.js'

const require = createRequire(import.meta.url)
const attachmentStore = require('./attachment-store.cjs')
const { ingestAttachment } = require('./attachment-ingest.cjs')
const { dispositionFor } = require('./attachment-mime.cjs')
const { fetchImageResponse } = require('./img-cdn-fetch.cjs')

const LOG = cds.log('attachment-source')
const _inflight = new Map()

export function warmAttachmentsLive(urls, { slug }) {
  const ingestFn = (url, { slug: s, channel }) =>
    ingestAttachment(url, { slug: s, channel, deps: { fetchImageResponse, safeFetch, resolveSecret, store: attachmentStore } })
  return warmAttachments(urls, { slug, ingestFn })
}

export async function attachmentSourceHandler(req, res) {
  const u = req.query.u
  if (!u) return res.status(400).json({ error: 'Missing u parameter' })
  const download = req.query.dl === '1' || req.query.dl === 'true'

  let got = await attachmentStore.getStream(u)
  if (!got) {
    let p = _inflight.get(u)
    if (!p) {
      const channel = channelFor(u)
      p = ingestAttachment(u, { slug: '', channel,
        deps: { fetchImageResponse, safeFetch, resolveSecret, store: attachmentStore } })
        .finally(() => _inflight.delete(u))
      _inflight.set(u, p)
    }
    let result = { action: 'failed' }
    try { result = await p } catch (err) { LOG.warn('[attachment-source] self-heal threw:', err.message) }
    if (result.action === 'failed') return res.status(404).json({ error: 'Attachment unavailable' })
    got = await attachmentStore.getStream(u)
    if (!got) return res.status(404).json({ error: 'Attachment unavailable' })
  }

  const filename = got.filename || String(u).split('/').pop() || 'file'
  const { contentType, disposition } = dispositionFor(got.mimeType || 'application/octet-stream', { download, filename })
  res.setHeader('Content-Type', contentType)
  res.setHeader('Content-Disposition', disposition)
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'public, max-age=3600')
  res.setHeader('X-Content-Source', 'attachment-store')

  got.stream.on('error', (err) => {
    LOG.warn('[attachment-source] stream error:', err.message)
    if (!res.headersSent) res.status(500).json({ error: 'Stream error' })
  })
  got.stream.pipe(res)
}
```

- [ ] **Step 4: Commit (test remains red until Task 11 registers the route)**

```bash
git add srv/lib/attachment-source-handler.js test/unit/attachment-source-endpoint.test.js
git commit -m "feat(attachments): serve handler with inline/download disposition (#1931)"
```

---

## Task 10: attachment-ingest-handler.js (POST push)

**Files:**
- Create: `srv/lib/attachment-ingest-handler.js`
- Test: `test/unit/attachment-ingest-endpoint.test.js` (mirror `test/unit/image-ingest-endpoint.test.js`)

**Interfaces:**
- Consumes: store (Task 5), `channelFor` (Task 7), `extToMime` (Task 6).
- Produces: `attachmentIngestHandler(req, res)` — POST `/content/attachment?u=&slug=&channel=&force=`, body = raw bytes.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/attachment-ingest-endpoint.test.js
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const project = cds.test('serve', '--project', '.', '--in-memory')
const store = require('../../srv/lib/attachment-store.cjs')
const base = '/content/attachment'
const KEY = process.env.CONTENT_API_KEY || 'test-key' // set in vitest env for this suite

describe('POST /content/attachment', () => {
  it('stores pushed bytes then serves them', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/push.txt'
    const res = await project.post(`${base}?u=${encodeURIComponent(url)}&slug=s`, Buffer.from('pushed'), {
      headers: { authorization: `Bearer ${KEY}`, 'content-type': 'text/plain' },
    })
    expect(res.status).toBe(200)
    expect(res.data.action).toBe('stored')
    const got = await store.getStream(url)
    const chunks = []; for await (const c of got.stream) chunks.push(c)
    expect(Buffer.concat(chunks).toString()).toBe('pushed')
  })
  it('401 without the api key', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/noauth.txt'
    await expect(project.post(`${base}?u=${encodeURIComponent(url)}`, Buffer.from('x'),
      { headers: { 'content-type': 'text/plain' } })).rejects.toMatchObject({ response: { status: 401 } })
  })
})
```

> NOTE: `CONTENT_API_KEY` must be present for `contentAuthMiddleware`. Mirror how `image-ingest-endpoint.test.js` sets it (env var in the suite or `vitest.config.ts`). Copy that exact setup.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/attachment-ingest-endpoint.test.js`
Expected: FAIL — route not registered.

- [ ] **Step 3: Write the handler** (copy of image-ingest-handler.js, ext-aware MIME)

```js
// srv/lib/attachment-ingest-handler.js
// POST /content/attachment?u=&slug=&channel=&force= — persist client-supplied attachment bytes.
// Bytes-in (srv CF egress is GitHub-anon-404'd, same as images). Auth: CONTENT_API_KEY.
import cds from '@sap/cds'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { channelFor } from './attachment-warm-utils.js'

const require = createRequire(import.meta.url)
const attachmentStore = require('./attachment-store.cjs')
const { extToMime } = require('./attachment-mime.cjs')
const LOG = cds.log('attachment-ingest')
const MAX_BYTES = Number(process.env.ATTACHMENT_MAX_BYTES) || 25 * 1024 * 1024

export async function attachmentIngestHandler(req, res) {
  const u = req.query.u
  if (!u) return res.status(400).json({ error: 'Missing u parameter' })
  const buffer = req.body
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return res.status(400).json({ error: 'Empty body' })
  if (buffer.length > MAX_BYTES) return res.status(400).json({ error: 'Attachment too large' })

  const slug = typeof req.query.slug === 'string' ? req.query.slug : ''
  const channel = typeof req.query.channel === 'string' && req.query.channel ? req.query.channel : channelFor(u)
  const reqCt = req.get('content-type') || ''
  const mimeType = (reqCt && reqCt !== 'application/octet-stream') ? reqCt : extToMime(u)
  const filename = String(u).split('/').pop()
  const contentHash = crypto.createHash('sha256').update(buffer).digest('hex')
  const force = req.query.force === '1' || req.query.force === 'true'

  try {
    if (!force) {
      const existing = await attachmentStore.head(u)
      if (existing.exists && existing.contentHash === contentHash) return res.status(200).json({ action: 'unchanged', contentHash })
    }
    await attachmentStore.put(u, { buffer, mimeType, contentHash, slug, channel, filename })
    return res.status(200).json({ action: 'stored', contentHash })
  } catch (err) {
    LOG.error('[attachment-ingest] store put failed for', u, '-', err.message)
    return res.status(500).json({ error: 'store write failed' })
  }
}
```

- [ ] **Step 4: Commit (test red until Task 11)**

```bash
git add srv/lib/attachment-ingest-handler.js test/unit/attachment-ingest-endpoint.test.js
git commit -m "feat(attachments): POST push ingest handler (#1931)"
```

---

## Task 11: Register routes in server.js

**Files:**
- Modify: `srv/server.js` (imports near line 31-32; route registration near lines 523-527)

**Interfaces:**
- Consumes: `attachmentSourceHandler` (Task 9), `attachmentIngestHandler` (Task 10), existing `contentAuthMiddleware`.

- [ ] **Step 1: Add imports** (next to the image handler imports)

```js
import { attachmentSourceHandler } from './lib/attachment-source-handler.js';
import { attachmentIngestHandler } from './lib/attachment-ingest-handler.js';
```

- [ ] **Step 2: Register the routes** (next to the `/content/image` routes, ~lines 523-527)

```js
  app.get('/content/attachment-source', attachmentSourceHandler);
  app.post('/content/attachment', contentAuthMiddleware, express.raw({ type: '*/*', limit: '25mb' }), attachmentIngestHandler);
```

- [ ] **Step 3: Run the serve + ingest endpoint tests (now they can pass)**

Run: `npx vitest run --project unit test/unit/attachment-source-endpoint.test.js test/unit/attachment-ingest-endpoint.test.js`
Expected: PASS (all cases from Tasks 9 & 10).

- [ ] **Step 4: Commit**

```bash
git add srv/server.js
git commit -m "feat(attachments): register /content/attachment-source + /content/attachment routes (#1931)"
```

---

## Task 12: Warm attachments on publish

**Files:**
- Modify: `srv/lib/content-publish-session.js` (inside the `setImmediate` warm block, ~lines 248-261)
- Test: `test/unit/attachment-warm-utils.test.js` already covers extraction; add an assertion here that the block imports the attachment warm modules (guards against a copy/paste regression).

- [ ] **Step 1: Add attachment warm beside image warm**

Inside the existing `if (slugHtmlMap.size > 0) { setImmediate(async () => { … }) }` block, after the image-warm loop, add:
```js
          const { extractAttachmentUrls } = await import('./attachment-warm-utils.js');
          const { warmAttachmentsLive } = await import('./attachment-source-handler.js');
          for (const [slug, html] of slugHtmlMap) {
            const aUrls = extractAttachmentUrls(html);
            if (aUrls.length > 0) await warmAttachmentsLive(aUrls, { slug });
          }
```
> These run in the same `try` as the image warm (failures already swallowed and logged; never fail publish). In DEV the srv can't fetch GitHub so these warm calls no-op-fail — population is via Task 13 backfill. In PROD they auto-populate.

- [ ] **Step 2: Add a guard test**

```js
// append to test/unit/attachment-warm-utils.test.js
import { readFileSync } from 'node:fs'
it('content-publish-session wires attachment warm', () => {
  const src = readFileSync('srv/lib/content-publish-session.js', 'utf8')
  expect(src).toContain('extractAttachmentUrls')
  expect(src).toContain('warmAttachmentsLive')
})
```

- [ ] **Step 3: Run**

Run: `npx vitest run --project unit test/unit/attachment-warm-utils.test.js`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/content-publish-session.js test/unit/attachment-warm-utils.test.js
git commit -m "feat(attachments): warm attachment store on publish (#1931)"
```

---

## Task 13: backfill-attachments.ts + npm script

**Files:**
- Create: `scripts/backfill-attachments.ts` (mirror `scripts/backfill-images.ts`)
- Modify: `package.json` — add `"backfill-attachments": "tsx scripts/backfill-attachments.ts"`
- Test: `test/scripts/backfill-attachments.test.ts` (unit-test `collectAttachmentUrls` over a fixture HTML dir)

**Interfaces:**
- Produces: `collectAttachmentUrls(publicDir: string) → Map<string, string>` (sourceUrl → slug); CLI with `--limit --concurrency --dry-run --force`.

- [ ] **Step 1: Write the failing test**

```ts
// test/scripts/backfill-attachments.test.ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { collectAttachmentUrls } from '../../scripts/backfill-attachments.js'

describe('collectAttachmentUrls', () => {
  it('collects attachment source URLs from built tutorial HTML', () => {
    const root = mkdtempSync(join(tmpdir(), 'bf-'))
    const dir = join(root, 'tutorials', 'rap100'); mkdirSync(dir, { recursive: true })
    const raw = 'https://raw.githubusercontent.com/sap-tutorials/abap-core-development/main/tutorials/rap100/EX2.txt'
    writeFileSync(join(dir, 'index.html'), `<a href="/content/attachment-source?u=${encodeURIComponent(raw)}">d</a>`)
    const map = collectAttachmentUrls(root)
    expect(map.get(raw)).toBe('rap100')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/scripts/backfill-attachments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the script**

Copy `scripts/backfill-images.ts` verbatim, then change:
- Import `extractAttachmentUrls` from `./parsers/... ` → actually from `../srv/lib/attachment-warm-utils.js`? `backfill-images.ts` imports `extractImgCdnUrls` — replicate that import path but for attachments (`extractAttachmentUrls` from `srv/lib/attachment-warm-utils.js`). Match how backfill-images imports it.
- Rename `collectImageUrls` → `collectAttachmentUrls` (uses `extractAttachmentUrls`).
- Rename `fetchImage`→`fetchAttachment`, `pushImage`→`pushAttachment`.
- Change the push endpoint from `/content/image` to `/content/attachment`.
- Keep the anon-first → Bearer-token-on-404 fetch, the concurrency pool, and the `--limit/--concurrency/--dry-run/--force` flags unchanged.
- `export function collectAttachmentUrls(publicDir: string): Map<string,string>` so the test can import it.

> Follow `scripts/backfill-images.ts` structure exactly; the only semantic differences are the extraction function, the endpoint path, and the identifiers. Do not re-derive the pool/flag logic.

- [ ] **Step 4: Add the npm script + run test**

Add to `package.json` `scripts`:
```json
"backfill-attachments": "tsx scripts/backfill-attachments.ts",
```
Run: `npx vitest run --project unit test/scripts/backfill-attachments.test.ts`
Expected: PASS.
Then dry-run smoke (requires a prior `npm run build:all` producing `hugo/public`):
`CAP_BASE_URL=http://localhost:4004 CONTENT_API_KEY=x npx tsx scripts/backfill-attachments.ts --dry-run --limit 3`
Expected: lists candidate attachment URLs, pushes nothing.

- [ ] **Step 5: Commit**

```bash
git add scripts/backfill-attachments.ts package.json test/scripts/backfill-attachments.test.ts
git commit -m "feat(attachments): backfill-attachments push script (#1931)"
```

---

## Task 14: Add new srv files to srv-qa cp list

**Files:**
- Modify: `.deploy/mta.yaml` (srv-qa builder `cp` command, ~line 174)

**Interfaces:** none (deploy packaging).

- [ ] **Step 1: Add the four runtime files to the cp list**

In the long `cp ... srv/lib/` command, append these to the source file list (before ` srv/lib/`):
```
../../srv/lib/attachment-store.cjs ../../srv/lib/attachment-ingest.cjs ../../srv/lib/attachment-mime.cjs ../../srv/lib/attachment-warm-utils.js ../../srv/lib/attachment-source-handler.js ../../srv/lib/attachment-ingest-handler.js
```
> Rationale (Global Constraint): `server.js` registers the serve/ingest routes and `content-publish-session.js` (already copied) dynamically imports `attachment-warm-utils.js` + `attachment-source-handler.js`, which pull the store/ingest/mime modules. All six must be present in srv-qa or QA boot crashes.

- [ ] **Step 2: Run the srv-qa cp-list guard**

Run: `npx tsx scripts/check-srv-qa-cp-list.ts`
Expected: PASS (no missing transitive deps reported).

- [ ] **Step 3: Commit**

```bash
git add .deploy/mta.yaml
git commit -m "chore(attachments): add attachment-* srv files to srv-qa cp list (#1931)"
```

---

## Task 15: Build CDS artifacts + full test/lint sweep

**Files:** none created; validates the schema build and full suite.

- [ ] **Step 1: Build production CDS artifacts**

Run: `npm run build:cds`
Expected: exits 0; emits `TutorialAssets` hdbtable + `@cap-js/attachments` composition table + a fresh `.hdbmigrationtable` under the gen output. Verify no "Duplicate definition"/resolve errors. Do NOT hand-edit any migration table.

- [ ] **Step 2: Run the full unit suite**

Run: `npm test`
Expected: PASS, including all new attachment tests.

- [ ] **Step 3: Run the postbuild guards that touch srv-qa/routes**

Run: `npx tsx scripts/check-srv-qa-cp-list.ts && npx tsx scripts/check-srv-qa-route-drift.ts && npx tsx scripts/check-public-endpoints.ts`
Expected: PASS. `check-public-endpoints.ts` must accept the new anonymous `GET /content/attachment-source` (if it enforces an allowlist of public endpoints, add `/content/attachment-source` there — same posture as `/content/image-source`).

- [ ] **Step 4: Commit any guard/config updates**

```bash
git add -A
git commit -m "chore(attachments): cds build artifacts + public-endpoint allowlist (#1931)"
```

---

## Task 16: End-to-end verification (local hybrid or DEV)

**Files:** none — live verification.

- [ ] **Step 1: Build + run against a backend with the RAP100 tutorial present**

Fetch + build so the RAP100 page bakes the new link shape:
```bash
npm run fetch-tutorials
npm run build:all
```
Grep the built page for the wrapped link:
```bash
grep -o '/content/attachment-source?u=[^"]*EX2_DDLX[^"]*' hugo/public/tutorials/abap-environment-rap100-enhance-data-model/index.html
```
Expected: a `/content/attachment-source?u=...EX2_DDLX...` href (and a sibling `&dl=1`), NOT the bare `EX2_DDLX_ZRAP100_C_TRAVELTP.txt`.

- [ ] **Step 2: Populate the store + verify serving (hybrid)**

With a `cds bind`'d hybrid srv (real HANA + S3) or a DEV deploy:
```bash
CAP_BASE_URL=<srv-url> CONTENT_API_KEY=<key> npm run backfill-attachments -- --limit 50
curl -sI "<srv-url>/content/attachment-source?u=$(python3 -c "import urllib.parse;print(urllib.parse.quote('https://raw.githubusercontent.com/sap-tutorials/abap-core-development/main/tutorials/abap-environment-rap100-enhance-data-model/EX2_DDLX_ZRAP100_C_TRAVELTP.txt'))")"
```
Expected: `200`, `Content-Type: text/plain; charset=utf-8`, `Content-Disposition: inline; filename="EX2_DDLX_ZRAP100_C_TRAVELTP.txt"`, `X-Content-Type-Options: nosniff`. Append `&dl=1` → `Content-Disposition: attachment; …`.

- [ ] **Step 3: Open the PR**

```bash
git push -u origin worktree-attachment-object-store
gh pr create --repo sap-tutorials/tutorials-ims --base main \
  --title "Attachment object-store pipeline: serve tutorial repo attachments like images (#1931)" \
  --body "Implements docs/superpowers/specs/2026-08-21-tutorial-attachment-object-store-design.md. Fixes dead relative attachment links (#1931 follow-up) by ingesting .txt/.zip/.pdf/.csv/.json into the object store and serving via /content/attachment-source (inline text, download binaries, .html neutered, ?dl=1 to force download)."
```

> Deploy note (from CLAUDE.md/memory): a full deploy must run `npm run build:all` before `mbt build`; content publish into HANA is a built-in final deploy step; the QA content rebuild must also run. Confirm deploy scope with the maintainer. The new `TutorialAssets` HDI artifacts deploy with the srv module.

---

## Self-Review

**Spec coverage:** §1 detect+bake → Tasks 1-3; §2 store → Tasks 4-5; §3 ingest → Tasks 8,10,11; §4 warm → Tasks 7,12; §5 serve → Tasks 6,9,11; §6 backfill → Task 13; §7 deploy wiring → Tasks 14-15; testing → per-task + Task 15-16; out-of-scope (real scan, subsystem B, prerequisites links) not implemented, as specified. ✅

**Placeholder scan:** No TBD/TODO in code steps. Two "NOTE" callouts (compose signature in Task 2, CONTENT_API_KEY setup in Task 10, github-blocked assumption in Task 9, backfill copy in Task 13) point the executor to the exact template file/test to mirror — not placeholders for logic. ✅

**Type consistency:** `resolveAttachmentLinks(content, {repo,branch,slug,rewrite})` (Tasks 1,2); store `put(url,{buffer,mimeType,contentHash,slug,channel,filename})` / `getStream→{stream,mimeType,filename}` (Tasks 5,8,9,10); `ingestAttachment(url,{slug,channel,deps})→{action,status?,contentHash?,mimeType?}` (Tasks 8,9); `extractAttachmentUrls(html)→string[]`, `warmAttachments(urls,{slug,ingestFn})`, `warmAttachmentsLive(urls,{slug})` (Tasks 7,9,12); `dispositionFor(mime,{download,filename})→{contentType,disposition}`, `extToMime(name)→string` (Tasks 6,8,9,10); routes `/content/attachment-source` + `/content/attachment` (Tasks 9,10,11,12,13). Consistent across tasks. ✅
