# Persist Tutorial Images — Plan 1: Pipeline (default store) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve tutorial images from a durable store the app owns, hitting GitHub only at publish time or on a first-view self-heal miss — so a GitHub outage never breaks images. This plan builds the full pipeline on the **default (HANA-backed) `@cap-js/attachments` store**; Plan 2 swaps storage to BTP Object Store.

**Architecture:** A new `TutorialImages` CDS entity (keyed by source URL, associated to `Tutorials`) carries a `@cap-js/attachments` composition holding the **original** image bytes. A `srv/lib/image-store.js` seam wraps the plugin (put/get/head by source URL). `srv/lib/image-ingest.js` fetches the original from GitHub (anonymous-first, token-on-404 for QA `-Contribution` repos, retry on 429/5xx — reusing the module from PR #1868), hashes it, and stores it via the seam, deduping by hash. A CAP endpoint `GET /content/image-source?u=<url>` streams the stored original and self-heals on miss. The approuter `/img-cdn` proxy is unchanged except its **origin flips from GitHub to that CAP endpoint**, keeping the existing `sharp` resize/WebP + Akamai caching; it **fails open** to PR #1868's direct-GitHub path behind a per-env flag.

**Tech Stack:** SAP CAP (Node.js), `@cap-js/attachments`, HANA (default attachments store for this plan), `sharp` (unchanged, approuter), `@sap/approuter`, vitest (`unit` + `hybrid` projects), `safeFetch` SSRF guard.

**Spec:** `docs/superpowers/specs/2026-08-17-persist-tutorial-images-design.md`

## Global Constraints

- **Node.js CAP; never raw SQL** — use `cds.ql`/CQL. Exception: BLOB reads on HANA use raw `db.run()` (LOB-locator hazard — never SELECT a BLOB alongside metadata in one CDS QL query). The `@cap-js/attachments` plugin handles content I/O; our seam must not co-select content with metadata.
- **Attachments store for THIS plan = default (HANA).** Do NOT bind Object Store here. `cds.requires.attachments.kind` stays unset/default so content lands in HANA. (Plan 2 binds BTP Object Store: service plan `objectstore`/**`s3-standard`**, plugin `kind: "s3"` or `"standard"` — the two names are different layers; do not conflate.)
- **`srv/lib` cp-list audit:** any new module under `srv/lib/` that becomes a transitive `./` import of `content-store.js` (or otherwise ships in the approuter/`srv-qa`) MUST be added to the relevant `cp` lists in `.deploy/mta.yaml`. Re-walk after adding files. (Repo rule.)
- **HANA column identifiers are UPPERCASE** in raw SQL / `.hdbview`; account for this in any raw read.
- **Slugs are lowercase canonical** — lowercase before comparing/keying.
- **All GitHub fetches go through `safeFetch`** (host allowlist `raw.githubusercontent.com` + private-IP block). No direct `fetch()` to user-influenced URLs.
- **Fail-open:** every new serving path must degrade to PR #1868's behavior, never hard-fail images.
- **No HTML re-bake:** the baked `/img-cdn?u=&w=` URL shape is preserved end to end.
- **`cds build --production` after schema changes**; never hand-author `.hdbmigrationtable`.
- Reuse PR #1868's `img-cdn-fetch.js` fetch logic — do not reimplement anon-first/token/retry.

---

### Task 0: Feasibility spike — pin the `@cap-js/attachments` write/read API + anonymous serve

**Goal:** Prove, in a throwaway hybrid scratch, the exact Node calls to (a) store bytes for an attachment programmatically (no Fiori), (b) stream them back, and (c) serve them to an anonymous caller. Output is a short findings note that makes Tasks 2–4 concrete. **Throwaway** — no scratch code is kept.

**Files:**
- Create (throwaway): `tmp/attachments-spike/` (a minimal CAP app or a hybrid test — deleted at task end)
- Create (kept): `docs/superpowers/specs/2026-08-17-attachments-spike-findings.md`

- [ ] **Step 1: Stand up a minimal composition** — an entity with `content: Composition of many Attachments` from `@cap-js/attachments`, `cds deploy` to sqlite/HANA.

- [ ] **Step 2: Prove programmatic write.** Determine which of these round-trips a Buffer into an attachment without a Fiori PUT, and record the winner verbatim:
  - `INSERT` the parent + `INSERT.into(<Entity>.content).entries({ ...keys, content: buffer, mimeType, fileName })`
  - vs. `UPDATE(<Entity>.content, key).with({ content: readableStream })`
  - vs. the plugin's own service API (`cds.connect.to('attachments')`).

- [ ] **Step 3: Prove read/stream.** Confirm the Node call that returns a `Readable` (or Buffer) for stored content (e.g. a media READ handler / `SELECT` of the media element), and the content-type source.

- [ ] **Step 4: Prove anonymous serve.** Confirm that a service without `@requires` can stream attachment content to an unauthenticated request (this is how prod images serve). Note any constraint that pushes us to a thin custom stream handler instead of the plugin's default media endpoint.

- [ ] **Step 5: Write findings** to `2026-08-17-attachments-spike-findings.md`: the exact write call, read call, content-type field, anonymous-serve verdict, and any deviation from Tasks 2/4 code below. Delete `tmp/attachments-spike/`.

- [ ] **Step 6: Commit**

```bash
git add docs/superpowers/specs/2026-08-17-attachments-spike-findings.md
git commit -m "docs(spike): pin @cap-js/attachments programmatic write/read + anon serve"
```

---

### Task 1: Relocate the shared GitHub-fetch module to `srv/lib` (usable by both srv and approuter)

**Why:** PR #1868 put `img-cdn-fetch.js`/`img-cdn-retry.js` in `approuter/lib`. Ingestion (srv) needs the same anon-first/token/retry logic. Make `srv/lib` the canonical home and keep the approuter copy via the build `cp` (same pattern as `legacy-redirects-resolver.js`).

**Files:**
- Create: `srv/lib/img-cdn-fetch.js` (moved content), `srv/lib/img-cdn-retry.js` (moved content)
- Modify: `approuter/server.js` require path stays `./lib/img-cdn-fetch` (approuter keeps a build-time copy)
- Modify: `.deploy/mta.yaml` — add `srv/lib/img-cdn-fetch.js` + `srv/lib/img-cdn-retry.js` to the `tutorials-approuter` before-all `cp` list (so the approuter still gets them), and confirm they are in the `srv`/`srv-qa` `cp` lists.
- Test: existing `test/unit/img-cdn-fetch.test.js`, `test/unit/img-cdn-retry.test.js` (retarget import paths)

**Interfaces:**
- Produces: `require('<lib>/img-cdn-fetch').fetchImageResponse(u, { safeFetch, resolveSecret, host, allowedHosts, timeoutMs, maxRetries })` → `Promise<Response>` (anon-first, token-on-404, retry on 429/5xx). Unchanged signature from #1868.

- [ ] **Step 1: Move the two modules** to `srv/lib/`, update the approuter copy to be produced by the build `cp` (leave `approuter/lib/*` in place for local dev; CF gets the copy).
- [ ] **Step 2: Retarget the unit tests' import paths** to `srv/lib/…` and run them.

Run: `npx vitest run --project unit test/unit/img-cdn-fetch.test.js test/unit/img-cdn-retry.test.js`
Expected: PASS (same assertions as #1868).

- [ ] **Step 3: Verify mta cp-list** — re-walk transitive `./` imports; confirm both files are in every `cp` list that ships them.
- [ ] **Step 4: Commit**

```bash
git add srv/lib/img-cdn-fetch.js srv/lib/img-cdn-retry.js .deploy/mta.yaml test/unit/img-cdn-fetch.test.js test/unit/img-cdn-retry.test.js
git commit -m "refactor(img-cdn): move shared fetch/retry to srv/lib for ingest reuse"
```

---

### Task 2: `TutorialImages` entity + attachments composition

**Files:**
- Create: `db/tutorial-images.cds`
- Test: `test/unit/tutorial-images-model.test.js`

**Interfaces:**
- Produces: entity `sap.tutorials.TutorialImages` with `key sourceUrl: String`, `tutorial: Association to Tutorials`, `slug: String`, `channel: String`, `contentHash: String`, `mimeType: String`, `content: Composition of many Attachments`.

- [ ] **Step 1: Write the failing test** (model compiles and exposes the fields + composition)

```js
import { describe, it, expect } from 'vitest'
import cds from '@sap/cds'
describe('TutorialImages model', () => {
  it('defines TutorialImages with an Attachments composition and source-url key', async () => {
    const m = await cds.load(['db/tutorial-images.cds', 'db/schema.cds'])
    const e = m.definitions['sap.tutorials.TutorialImages']
    expect(e).toBeTruthy()
    expect(e.elements.sourceUrl.key).toBe(true)
    expect(e.elements.content).toBeTruthy()          // composition present
    expect(e.elements.contentHash).toBeTruthy()
    expect(e.elements.channel).toBeTruthy()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --project unit test/unit/tutorial-images-model.test.js`
Expected: FAIL (definition not found)

- [ ] **Step 3: Write the model**

```cds
using { Attachments } from '@cap-js/attachments';
using { sap.tutorials.Tutorials } from './schema';

namespace sap.tutorials;

entity TutorialImages {
  key sourceUrl   : String(1024);            // raw.githubusercontent.com URL (stable identity)
      tutorial    : Association to Tutorials on tutorial.slug = slug;
      slug        : String(255);             // lowercase canonical
      channel     : String(8);               // 'prod' | 'qa'
      contentHash : String(64);              // sha-256 of the stored original
      mimeType    : String(128);
      content     : Composition of many Attachments;
}
```

- [ ] **Step 4: Run test + a sqlite deploy smoke**

Run: `npx vitest run --project unit test/unit/tutorial-images-model.test.js`
Then: `npx cds deploy --to sqlite::memory:` (must not error)
Expected: PASS + clean deploy

- [ ] **Step 5: `cds build --production`** to regenerate HANA artifacts; do not hand-edit migration tables.

- [ ] **Step 6: Commit**

```bash
git add db/tutorial-images.cds test/unit/tutorial-images-model.test.js
git commit -m "feat(images): add TutorialImages entity with attachments composition"
```

---

### Task 3: `image-store.js` seam over `@cap-js/attachments`

**Files:**
- Create: `srv/lib/image-store.js`
- Test: `test/hybrid/image-store.test.js` (real persistence; `--project hybrid`)

**Interfaces:**
- Consumes: `TutorialImages` (Task 2). The exact write/read calls come from Task 0 findings — the two lines marked `SPIKE` below are the only ones Task 0 may adjust.
- Produces:
  - `head(sourceUrl)` → `Promise<{ exists: boolean, contentHash?: string, mimeType?: string }>`
  - `put(sourceUrl, { buffer, mimeType, contentHash, slug, channel })` → `Promise<void>` (upsert row + store bytes)
  - `getStream(sourceUrl)` → `Promise<{ stream: Readable, mimeType: string } | null>`
  - `remove(sourceUrl)` → `Promise<void>`

- [ ] **Step 1: Write the failing hybrid test** (round-trip)

```js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
let store
beforeAll(async () => { await cds.test('serve', '--in-memory'); store = require('../../srv/lib/image-store') })
describe('image-store round-trip', () => {
  const url = 'https://raw.githubusercontent.com/o/r/main/x.png'
  it('put then head then getStream returns the same bytes', async () => {
    const buffer = Buffer.from([137,80,78,71,1,2,3])
    await store.put(url, { buffer, mimeType: 'image/png', contentHash: 'abc', slug: 's', channel: 'prod' })
    const h = await store.head(url)
    expect(h.exists).toBe(true); expect(h.contentHash).toBe('abc')
    const got = await store.getStream(url)
    const chunks = []; for await (const c of got.stream) chunks.push(c)
    expect(Buffer.concat(chunks)).toEqual(buffer)
    expect(got.mimeType).toBe('image/png')
  })
  it('head returns exists:false for an unknown url', async () => {
    expect((await store.head('https://raw.githubusercontent.com/o/r/main/none.png')).exists).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project hybrid test/hybrid/image-store.test.js`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement the seam** (write/read lines marked SPIKE are confirmed in Task 0)

```js
'use strict'
const cds = require('@sap/cds')

// Metadata lives on TutorialImages; original bytes live in its Attachments
// composition (HANA for Plan 1, Object Store in Plan 2 — transparent here).
async function head(sourceUrl) {
  const { TutorialImages } = cds.entities('sap.tutorials')
  const row = await SELECT.one.from(TutorialImages)
    .columns('sourceUrl', 'contentHash', 'mimeType').where({ sourceUrl })
  return row ? { exists: true, contentHash: row.contentHash, mimeType: row.mimeType }
             : { exists: false }
}

async function put(sourceUrl, { buffer, mimeType, contentHash, slug, channel }) {
  const { TutorialImages } = cds.entities('sap.tutorials')
  await UPSERT.into(TutorialImages).entries({ sourceUrl, slug, channel, contentHash, mimeType })
  // SPIKE(Task0): store bytes into the Attachments composition programmatically.
  const { TutorialImages: { content: Content } } = cds.entities('sap.tutorials')
  await UPSERT.into(Content).entries({
    up__sourceUrl: sourceUrl, ID: cds.utils.uuid(),
    fileName: sourceUrl.split('/').pop(), mimeType, content: buffer,
  })
}

async function getStream(sourceUrl) {
  const meta = await head(sourceUrl)
  if (!meta.exists) return null
  const { TutorialImages: { content: Content } } = cds.entities('sap.tutorials')
  // SPIKE(Task0): read the media element as a Readable stream (LOB-safe; content only).
  const row = await SELECT.one.from(Content).columns('content').where({ up__sourceUrl: sourceUrl })
  const stream = row && row.content
  return stream ? { stream, mimeType: meta.mimeType } : null
}

async function remove(sourceUrl) {
  const { TutorialImages } = cds.entities('sap.tutorials')
  await DELETE.from(TutorialImages).where({ sourceUrl }) // composition cascades content delete
}

module.exports = { head, put, getStream, remove }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project hybrid test/hybrid/image-store.test.js`
Expected: PASS (adjust the two SPIKE lines per Task 0 if needed, then re-run)

- [ ] **Step 5: cp-list audit** — `image-store.js` is imported by srv handlers (Task 4/5) → confirm it's in the `srv` and `srv-qa` `cp` lists in `.deploy/mta.yaml`.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/image-store.js test/hybrid/image-store.test.js .deploy/mta.yaml
git commit -m "feat(images): image-store seam over @cap-js/attachments"
```

---

### Task 4: `image-ingest.js` — fetch, hash, dedup, store

**Files:**
- Create: `srv/lib/image-ingest.js`
- Test: `test/unit/image-ingest.test.js`

**Interfaces:**
- Consumes: `fetchImageResponse` (Task 1), `image-store` (Task 3), `safeFetch`, `resolveSecret`.
- Produces: `ingestImage(sourceUrl, { slug, channel, deps })` → `Promise<{ action: 'stored'|'unchanged'|'failed', contentHash?, mimeType?, status? }>`. `deps` (all injectable for tests): `{ fetchImageResponse, safeFetch, resolveSecret, store, hash }`.

- [ ] **Step 1: Write the failing tests** (dedup + store + fetch failure), using fakes

```js
import { describe, it, expect } from 'vitest'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { ingestImage } = require('../../srv/lib/image-ingest')

const png = Buffer.from([1,2,3,4])
function okResponse() {
  return { ok: true, status: 200, headers: { get: () => 'image/png' }, arrayBuffer: async () => png }
}
function fakeStore(initialHash) {
  const state = { hash: initialHash, puts: 0 }
  return { state,
    head: async () => initialHash ? { exists: true, contentHash: initialHash } : { exists: false },
    put: async (_u, { contentHash }) => { state.hash = contentHash; state.puts++ } }
}

describe('ingestImage', () => {
  const RAW = 'raw.githubusercontent.com'
  const base = { slug: 's', channel: 'prod' }
  it('stores when the image is new', async () => {
    const store = fakeStore(null)
    const r = await ingestImage(`https://${RAW}/o/r/main/x.png`, { ...base, deps: {
      fetchImageResponse: async () => okResponse(), safeFetch: {}, resolveSecret: async () => null, store,
    }})
    expect(r.action).toBe('stored'); expect(store.state.puts).toBe(1)
  })
  it('is a no-op when the stored hash already matches (dedup)', async () => {
    const known = require('node:crypto').createHash('sha256').update(png).digest('hex')
    const store = fakeStore(known)
    const r = await ingestImage(`https://${RAW}/o/r/main/x.png`, { ...base, deps: {
      fetchImageResponse: async () => okResponse(), safeFetch: {}, resolveSecret: async () => null, store,
    }})
    expect(r.action).toBe('unchanged'); expect(store.state.puts).toBe(0)
  })
  it('returns failed (no throw) when upstream is not ok', async () => {
    const store = fakeStore(null)
    const r = await ingestImage(`https://${RAW}/o/r/main/x.png`, { ...base, deps: {
      fetchImageResponse: async () => ({ ok: false, status: 429, headers: { get: () => null } }),
      safeFetch: {}, resolveSecret: async () => null, store,
    }})
    expect(r.action).toBe('failed'); expect(r.status).toBe(429); expect(store.state.puts).toBe(0)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit test/unit/image-ingest.test.js`
Expected: FAIL (module missing)

- [ ] **Step 3: Implement**

```js
'use strict'
const crypto = require('node:crypto')
const IMG_CDN_HOSTS = new Set(['raw.githubusercontent.com'])

async function ingestImage(sourceUrl, { slug, channel, deps }) {
  const { fetchImageResponse, safeFetch, resolveSecret, store,
          hash = (buf) => crypto.createHash('sha256').update(buf).digest('hex') } = deps
  let host
  try { host = new URL(sourceUrl).hostname } catch { return { action: 'failed', status: 400 } }

  const res = await fetchImageResponse(sourceUrl, {
    safeFetch, resolveSecret, host, allowedHosts: IMG_CDN_HOSTS,
    timeoutMs: 12000, maxRetries: 2,
  })
  if (!res.ok) return { action: 'failed', status: res.status }

  const buffer = Buffer.from(await res.arrayBuffer())
  const contentHash = hash(buffer)
  const existing = await store.head(sourceUrl)
  if (existing.exists && existing.contentHash === contentHash) {
    return { action: 'unchanged', contentHash }
  }
  const mimeType = res.headers.get('content-type') || 'application/octet-stream'
  await store.put(sourceUrl, { buffer, mimeType, contentHash, slug, channel })
  return { action: 'stored', contentHash, mimeType }
}

module.exports = { ingestImage }
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit test/unit/image-ingest.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add srv/lib/image-ingest.js test/unit/image-ingest.test.js
git commit -m "feat(images): ingestImage — fetch, hash, dedup, store"
```

---

### Task 5: CAP `GET /content/image-source` — stream stored original + self-heal

**Files:**
- Modify: the content service CDS (add an unbound function/endpoint) + `srv/lib/content-store.js` (or a new `srv/lib/image-source-handler.js` imported by it). Exact mount confirmed against `content-store.js`'s existing `/content/tutorials/:slug` serve pattern.
- Test: `test/hybrid/image-source-endpoint.test.js`

**Interfaces:**
- Consumes: `image-store` (Task 3), `image-ingest` (Task 4). `channel` is derived: a `-Contribution` repo in the URL ⇒ `qa`, else `prod`.
- Produces: HTTP `GET /content/image-source?u=<encoded-source-url>` → `200` streaming original bytes with `Content-Type`; `404` when ingest also fails; runs single-flight so concurrent misses coalesce (reuse the in-flight-Map pattern from PR #1868).

- [ ] **Step 1: Write the failing hybrid test** (store hit streams; miss self-heals via injected ingest)

```js
import { describe, it, expect, beforeAll } from 'vitest'
import cds from '@sap/cds'
let GET, base
beforeAll(async () => { ({ GET } = cds.test('serve', '--in-memory')); base = '/content/image-source' })
describe('GET /content/image-source', () => {
  it('streams a stored image (store hit)', async () => {
    const store = require('../../srv/lib/image-store')
    const url = 'https://raw.githubusercontent.com/o/r/main/hit.png'
    await store.put(url, { buffer: Buffer.from([9,9,9]), mimeType: 'image/png', contentHash: 'h', slug: 's', channel: 'prod' })
    const res = await GET(`${base}?u=${encodeURIComponent(url)}`, { responseType: 'arraybuffer' })
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toMatch(/image\/png/)
    expect(Buffer.from(res.data)).toEqual(Buffer.from([9,9,9]))
  })
  it('404s when the image is absent and self-heal cannot fetch it', async () => {
    const url = 'https://raw.githubusercontent.com/o/r/main/missing.png'
    await expect(GET(`${base}?u=${encodeURIComponent(url)}`)).rejects.toMatchObject({ response: { status: 404 } })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project hybrid test/hybrid/image-source-endpoint.test.js`
Expected: FAIL (endpoint not found → 404 for the hit case too)

- [ ] **Step 3: Add the endpoint + handler.** In the content service CDS, expose an **unauthenticated** media-returning function (no `@requires`), e.g.:

```cds
extend service ContentService with {
  @Core.MediaType: 'application/octet-stream'
  function imageSource(u: String) returns LargeBinary;
}
```

Handler (in `content-store.js` or `image-source-handler.js`; self-heal uses real `deps`):

```js
const store = require('./image-store')
const { ingestImage } = require('./image-ingest')
const { fetchImageResponse } = require('./img-cdn-fetch')
const { safeFetch } = require('./safe-fetch')          // srv copy or shared
const { resolveSecret } = require('./credstore-secret')
const _inflight = new Map()

function channelFor(u) { return /-Contribution\//i.test(u) ? 'qa' : 'prod' }

async function serveImageSource(req) {
  const u = req.data.u
  if (!u) return req.reject(400, 'Missing u')
  let got = await store.getStream(u)
  if (!got) {
    let p = _inflight.get(u)
    if (!p) {
      p = ingestImage(u, { slug: '', channel: channelFor(u),
        deps: { fetchImageResponse, safeFetch, resolveSecret, store } })
        .finally(() => _inflight.delete(u))
      _inflight.set(u, p)
    }
    const r = await p
    if (r.action === 'failed') return req.reject(404, 'Image unavailable')
    got = await store.getStream(u)
    if (!got) return req.reject(404, 'Image unavailable')
  }
  return req.reply(got.stream, { mimetype: got.mimeType })
}
// register: srv.on('imageSource', serveImageSource)
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project hybrid test/hybrid/image-source-endpoint.test.js`
Expected: PASS

- [ ] **Step 5: cp-list audit** for any new `srv/lib` file; confirm the endpoint is anonymous (matches prod public serving).

- [ ] **Step 6: Commit**

```bash
git add srv/**/*.cds srv/lib/*.js test/hybrid/image-source-endpoint.test.js .deploy/mta.yaml
git commit -m "feat(images): /content/image-source streams stored originals + self-heal"
```

---

### Task 6: Approuter `/img-cdn` — flip origin to CAP, keep resize, fail open

**Files:**
- Modify: `approuter/server.js` (`loadProcessedImage` / `fetchImageResponse` call site)
- Test: `test/unit/img-cdn-origin.test.js`

**Interfaces:**
- Consumes: the new CAP endpoint (SRV_URL + `/content/image-source?u=`). Env flag `IMG_CDN_SOURCE` (`store` | `github`, default `store`).
- Produces: `/img-cdn?u=&w=` behavior unchanged externally; origin of the **original** bytes is the CAP endpoint when `IMG_CDN_SOURCE=store`, else PR #1868's direct GitHub path. On any store-origin error, **fail open** to the GitHub path.

- [ ] **Step 1: Write the failing test** — with `IMG_CDN_SOURCE=store`, the proxy requests the CAP endpoint; on store failure it falls back to GitHub. Inject a fake fetch to assert the origin URL chosen.

```js
// asserts: buildOriginUrl(u, srvUrl) === `${srvUrl}/content/image-source?u=${encodeURIComponent(u)}`
// and that a store-origin throw triggers the #1868 github path (fail-open flag true).
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run --project unit test/unit/img-cdn-origin.test.js`
Expected: FAIL

- [ ] **Step 3: Implement** — extract `buildOriginUrl()` + a `IMG_CDN_SOURCE`-gated branch in `loadProcessedImage`: fetch original from CAP endpoint; wrap in try/catch that falls back to `fetchImageResponse` (GitHub) on error. Keep all `sharp`/Akamai/`Vary: Accept` behavior from #1868 untouched.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run --project unit test/unit/img-cdn-origin.test.js`
Expected: PASS

- [ ] **Step 5: Load-check** the approuter module (stubbed `@sap/approuter`) — no wiring errors.

- [ ] **Step 6: Commit**

```bash
git add approuter/server.js test/unit/img-cdn-origin.test.js
git commit -m "feat(img-cdn): source originals from CAP store, fail open to GitHub"
```

---

### Task 7: Publish-time warm — feed each tutorial's image list to `ingestImage`

**Files:**
- Modify: the publish path that already knows a tutorial's images — confirm whether that is the parser output consumed by `srv/lib/content-publish-session.js` or `scripts/publish-content.ts`. Add an `ingestImage` call per source URL after the HTML is published for a slug.
- Test: `test/unit/publish-image-warm.test.js`

**Interfaces:**
- Consumes: `ingestImage` (Task 4); the per-tutorial list of `/img-cdn?u=<raw-url>` sources (from the parser payload; if unavailable, extract `u=` params from the published HTML — prefer the parser hook).
- Produces: after publishing slug `s`, every referenced source URL is ingested (deduped). Failures are logged, non-fatal (publish must not fail because an image warm failed — self-heal covers it).

- [ ] **Step 1: Write the failing test** — given a published tutorial referencing 2 image URLs, publish calls `ingestImage` for each with the right `slug`/`channel`, and a single image failure does not throw.
- [ ] **Step 2: Run to verify it fails.**

Run: `npx vitest run --project unit test/unit/publish-image-warm.test.js`
Expected: FAIL

- [ ] **Step 3: Implement** — extract the image source list at publish time (parser hook preferred; else regex `u=([^&"]+)` over the published HTML, `decodeURIComponent`), then `for` each: `await ingestImage(url, { slug, channel, deps }).catch(logNonFatal)`.
- [ ] **Step 4: Run to verify it passes.**

Run: `npx vitest run --project unit test/unit/publish-image-warm.test.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add srv/lib/*.js scripts/*.ts test/unit/publish-image-warm.test.js
git commit -m "feat(images): warm the image store at publish time"
```

---

### Task 8: Smoke test — images serve from the store with GitHub unreachable

**Files:**
- Create: `test/hybrid/img-store-github-blocked.test.js`

**Interfaces:**
- Consumes: Tasks 3–5. Simulates the outage by injecting a `fetchImageResponse` that always fails (or blocking the `safeFetch` host), asserting a pre-warmed image still serves and a cold one 404s (never hangs).

- [ ] **Step 1: Write the test** — pre-`put` one image; stub GitHub fetch to reject; assert `GET /content/image-source` returns the stored bytes for the warmed URL and 404 (fast) for an unwarmed URL.
- [ ] **Step 2: Run**

Run: `npx vitest run --project hybrid test/hybrid/img-store-github-blocked.test.js`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/img-store-github-blocked.test.js
git commit -m "test(images): images serve from store when GitHub is unreachable"
```

---

## Self-Review

- **Spec coverage:** §3 serving → Task 6; §4 model/store → Tasks 2–3; §5 ingestion (both triggers, prod+QA token) → Tasks 4, 5 (self-heal), 7 (publish warm); §7 spikes A/B → Task 0 (C/D provisioning+sizing deferred to Plan 2); §8 testing incl. GitHub-blocked → Tasks 3/5/8; §9 rollout & fail-open → Task 6 flag. GC + bulk-warm + Object Store cutover are **Plan 2** (noted, not gaps).
- **Placeholder scan:** the only "confirm" markers are the two `SPIKE(Task0)` lines in Task 3 — gated on a real API-verification spike, with concrete best-known code and full surrounding tests, not vague TODOs.
- **Type consistency:** `fetchImageResponse` signature matches #1868; `store` interface (`head/put/getStream/remove`) is used identically in Tasks 3/4/5; `ingestImage` return `{action,...}` consistent across Tasks 4/5/7.

## Deferred to Plan 2 (Object Store cutover + scale)
- Bind BTP Object Store (service `objectstore`, plan **`s3-standard`**; plugin `cds.requires.attachments.kind: "s3"`/`"standard"`) in `mta.yaml`/mtaext; verify single-tenant caveat.
- Measure catalog image volume (sizing/cost) **before** the PROD bulk-warm.
- One-time **bulk-warm** job (iterate published tutorials → `ingestImage`), run only after Object Store is bound so PROD HANA is never bloated.
- **GC** job for orphaned `TutorialImages` rows/objects (mirror `purge-orphans`).
