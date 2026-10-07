# Exclude DELETED/INACTIVE Tutorials from Quarantine + Publisher — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the quarantine subsystem and publisher pipeline status-aware so a tutorial whose IMS `status` is `DELETED` or `INACTIVE` is never fetched, rendered, validated, quarantined, or surfaced in the Admin active-quarantine facet.

**Architecture:** A new public-read endpoint `GET /content/excluded-slugs` returns the lowercased slugs of DELETED/INACTIVE tutorials from HANA. The CI publisher (`fetch-tutorials`, `validate-tutorials`) fetches that set and filters at discovery/validation time (fail-open). Independently, the CAP-side `quarantineIngestHandler` drops events for excluded slugs before persisting (defense in depth). A one-off maintenance script clears the current live snapshot.

**Tech Stack:** CAP Node.js (`@sap/cds`), Express handlers in `packages/content/content-store.js`, TypeScript CI scripts (`tsx`), Vitest (`npm test` = `vitest run --project unit`, in-memory SQLite).

**Spec:** `docs/superpowers/specs/2026-10-07-exclude-deleted-tutorials-from-quarantine-publisher-design.md`

## Global Constraints

- Status set is exactly `('DELETED','INACTIVE')` everywhere.
- All slug comparisons are **lowercase-canonical** — `LOWER()` in SQL, `.toLowerCase()` in JS (CLAUDE.md: "Tutorial slugs are lowercase canonical").
- Everything **fails open**: a missing/erroring endpoint (404/503/network) must not break a rebuild or ingest — treat as empty exclusion set.
- No feature flag; behavior is a no-op when the endpoint is absent.
- Never SELECT a HANA BLOB alongside metadata (not relevant here — Tutorials has no BLOB — but keep queries metadata-only).
- The read endpoint mirrors `sourceHashesHandler`'s raw `db.run` HANA/SQLite branch. The ingest-side filter mirrors the handler's existing `cds.ql` + `cds.entities(namespace)` style (NOT raw SQL).
- Branch targets DEV (PRs target DEV; `main` is protected).
- Namespace constant: `com.sap.developers.ims`.

---

### Task 1: `GET /content/excluded-slugs` endpoint

**Files:**
- Modify: `packages/content/content-store.js` — add `excludedSlugsHandler` beside `sourceHashesHandler` (~:1390); add to the factory return object (:2227-2247); add a module-level named export (beside :2260 `sourceHashesHandler` export).
- Modify: `srv/server.js:787` — register anonymous route.
- Modify: `srv-qa/server.js:86` — register `hashesAuth`-gated route.
- Test: `srv/__tests__/lib/excluded-slugs-route.test.js` (new).

**Interfaces:**
- Produces: `excludedSlugsHandler(req, res)` — Express handler. Response JSON: `{ slugs: string[] }`, lowercased, de-duplicated. Factory property + named export both called `excludedSlugsHandler`.

- [ ] **Step 1: Write the failing test**

`srv/__tests__/lib/excluded-slugs-route.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { excludedSlugsHandler } from '../../lib/content-store.js';

const NS = 'com.sap.developers.ims';

function makeReq(body = {}, headers = {}) {
  return { body, headers, get(k) { return this.headers[k.toLowerCase()]; } };
}
function makeRes() {
  const res = {
    _status: null, _body: null, _headers: {},
    status(code) { this._status = code; return this; },
    json(body)   { this._body = body; return this; },
    setHeader(k, v) { this._headers[k] = v; }
  };
  return res;
}

cds.test('serve', '--project', '.', '--in-memory');

describe('GET /content/excluded-slugs', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  beforeEach(async () => {
    const { Tutorials } = cds.entities(NS);
    await DELETE.from(Tutorials);
  });

  it('returns only DELETED and INACTIVE slugs, lowercased', async () => {
    const { Tutorials } = cds.entities(NS);
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), slug: 'del-one', title: 't', status: 'DELETED' },
      { ID: cds.utils.uuid(), slug: 'Inact-Two', title: 't', status: 'INACTIVE' },
      { ID: cds.utils.uuid(), slug: 'active-three', title: 't', status: 'ACTIVE' },
      { ID: cds.utils.uuid(), slug: 'null-four', title: 't', status: null },
    ]);
    const res = makeRes();
    await excludedSlugsHandler(makeReq(), res);
    expect(res._body).toBeTruthy();
    const slugs = res._body.slugs.slice().sort();
    expect(slugs).toEqual(['del-one', 'inact-two']);
  });

  it('returns empty array when nothing is excluded', async () => {
    const res = makeRes();
    await excludedSlugsHandler(makeReq(), res);
    expect(res._body.slugs).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- srv/__tests__/lib/excluded-slugs-route.test.js`
Expected: FAIL — `excludedSlugsHandler` is not exported (import undefined).

- [ ] **Step 3: Add the handler**

In `packages/content/content-store.js`, immediately after `sourceHashesHandler` ends (before the next handler), add inside the factory:

```js
  // --- excludedSlugsHandler: GET /content/excluded-slugs (#2585 follow-up) ---
  //
  // Returns the lowercased slugs of tutorials whose IMS lifecycle status is
  // DELETED or INACTIVE. The CI publisher (fetch-tutorials, validate-tutorials)
  // fetches this to skip discovering/validating/quarantining them. Public-read
  // on prod (anonymous), hashesAuth on qa — mirrors /content/source-hashes.
  // Metadata-only query (no content/version join needed). Fail-open callers:
  // a 404/503 here must be treated as "nothing excluded".
  async function excludedSlugsHandler(req, res) {
    try {
      const db = await cds.connect.to('db');
      const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
      const rows = isHana
        ? (await db.run(
            `SELECT DISTINCT LOWER(t."SLUG") AS "slug"
               FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" AS t
              WHERE t."STATUS" IN ('DELETED','INACTIVE')`
          ))
        : (await db.run(
            `SELECT DISTINCT LOWER(t.slug) AS slug
               FROM com_sap_developers_ims_tutorials AS t
              WHERE t.status IN ('DELETED','INACTIVE')`
          ));
      const slugs = [];
      for (const row of rows) {
        if (row.slug) slugs.push(row.slug);
      }
      res.setHeader('Cache-Control', 'no-cache');
      res.json({ slugs });
    } catch (err) {
      LOG.error(`[content/excluded-slugs] ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
```

Add `excludedSlugsHandler` to the factory return object (after `sourceHashesHandler` at :2233):

```js
    sourceHashesHandler,
    excludedSlugsHandler,
```

Add the module-level named export (after the `sourceHashesHandler` export ~:2260):

```js
export const excludedSlugsHandler = _defaults.excludedSlugsHandler;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- srv/__tests__/lib/excluded-slugs-route.test.js`
Expected: PASS (both tests).

- [ ] **Step 5: Register the routes**

In `srv/server.js`, after :787 (`app.get('/content/source-hashes', sourceHashesHandler);`):

```js
  // #2585 follow-up — DELETED/INACTIVE slugs for the publisher to skip. Public-
  // read like /content/source-hashes (safe: exposes only slugs + lifecycle state).
  app.get('/content/excluded-slugs', excludedSlugsHandler);
```

Ensure `excludedSlugsHandler` is in the destructured import from `./lib/content-store.js` at `srv/server.js:34`.

In `srv-qa/server.js`, after :86 (`app.get('/content/source-hashes', hashesAuth, sourceHashesHandler);`):

```js
  // #2585 follow-up — mirrors prod; dual-auth like the other QA hash feeds.
  app.get('/content/excluded-slugs', hashesAuth, excludedSlugsHandler);
```

Ensure `excludedSlugsHandler` is in the destructured import at `srv-qa/server.js:26`.

- [ ] **Step 6: Run the full unit suite to confirm no regressions**

Run: `npm test`
Expected: PASS (all unit tests, including the new file).

- [ ] **Step 7: Commit**

```bash
git add packages/content/content-store.js srv/server.js srv-qa/server.js srv/__tests__/lib/excluded-slugs-route.test.js
git commit -m "feat(content): add GET /content/excluded-slugs for DELETED/INACTIVE tutorials (#2585)"
```

---

### Task 2: Quarantine ingest drops DELETED/INACTIVE events

**Files:**
- Modify: `packages/content/content-store.js` — `quarantineIngestHandler` (:2177-2225), filter `events` before the deep INSERT.
- Test: `srv/__tests__/lib/quarantine-ingest-routes.test.js` (extend; existing file, 93 lines).

**Interfaces:**
- Consumes: nothing new.
- Produces: no signature change — `quarantineIngestHandler` still `(req, res)`; behavior now drops excluded events.

- [ ] **Step 1: Write the failing test** — append inside the existing `describe('quarantine ingest route', ...)` block in `srv/__tests__/lib/quarantine-ingest-routes.test.js`:

```js
  it('drops events whose slug is a DELETED/INACTIVE tutorial', async () => {
    const { Tutorials, QuarantineEvents } = cds.entities(NS);
    await DELETE.from(Tutorials);
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), slug: 'gone-slug', title: 't', status: 'DELETED' },
      { ID: cds.utils.uuid(), slug: 'hidden-slug', title: 't', status: 'INACTIVE' },
      { ID: cds.utils.uuid(), slug: 'live-slug', title: 't', status: 'ACTIVE' },
    ]);
    const res = makeRes();
    await quarantineIngestHandler(makeReq({
      runId: 'filter-run', buildMode: 'full',
      events: [
        { slug: 'Gone-Slug', reason: 'bad stepCount' },
        { slug: 'hidden-slug', reason: 'empty' },
        { slug: 'live-slug', reason: 'unbalanced shortcode' },
      ],
    }), res);
    expect(res._status).toBe(201);
    const rows = await SELECT.from(QuarantineEvents);
    const slugs = rows.map(r => r.slug).sort();
    expect(slugs).toEqual(['live-slug']);
  });
```

(Clean up: add `await DELETE.from(Tutorials)` to the existing `beforeEach`, after the snapshot deletes, so Tutorials rows don't leak between tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- srv/__tests__/lib/quarantine-ingest-routes.test.js`
Expected: FAIL — persisted slugs are `['gone-slug','hidden-slug','live-slug']` (filter not yet applied).

- [ ] **Step 3: Add the filter** — in `quarantineIngestHandler`, after the `Array.isArray(events)` guard (:2185) and before `const { QuarantineSnapshots } = cds.entities(namespace);` (:2186), replace the entity resolution line with:

```js
      const { QuarantineSnapshots, Tutorials } = cds.entities(namespace);
      const db = await cds.connect.to('db');
      // #2585 follow-up — never quarantine a tutorial that IMS has retired.
      // DELETED/INACTIVE rows must not appear in the active-quarantine facet
      // (the Admin join is slug-only). Dropping them here is the CAP-side
      // chokepoint; the publisher also filters at discovery (defense in depth).
      const retired = await SELECT.from(Tutorials)
        .columns('slug')
        .where({ status: { in: ['DELETED', 'INACTIVE'] } });
      const retiredSet = new Set(retired.map(r => String(r.slug || '').toLowerCase()));
      const events = (req.body?.events || []).filter(
        e => !retiredSet.has(String(e.slug || '').toLowerCase())
      );
```

Then DELETE the now-duplicated `const db = await cds.connect.to('db');` line that followed (:2187), and remove `events` from the destructuring on :2179 (it is now derived locally):

```js
      const { runId, workflowUrl, manifestVersion, buildMode } = req.body || {};
```

Keep the existing `if (!Array.isArray(events))` guard working: move it to validate `req.body?.events` before the filter — change :2183-2185 to check `req.body?.events`:

```js
      if (!Array.isArray(req.body?.events)) {
        return res.status(400).json({ error: "'events' must be an array" });
      }
```

(The rest of the handler already references `events` and `events.length` — now the filtered array — unchanged.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- srv/__tests__/lib/quarantine-ingest-routes.test.js`
Expected: PASS — including the existing 400/array/idempotency/empty-snapshot tests (the array guard still fires on `events: 'nope'`).

- [ ] **Step 5: Commit**

```bash
git add packages/content/content-store.js srv/__tests__/lib/quarantine-ingest-routes.test.js
git commit -m "feat(content): quarantine ingest drops DELETED/INACTIVE tutorial events (#2585)"
```

---

### Task 3: `fetchExcludedSlugs` client helper

**Files:**
- Modify: `scripts/lib/publish-client.ts` — add `fetchExcludedSlugs` beside `fetchRemoteSourceHashes` (:201-215).
- Test: `scripts/lib/__tests__/fetch-excluded-slugs.test.ts` (new) — or colocate per existing convention (see note).

**Interfaces:**
- Produces: `export async function fetchExcludedSlugs({ baseUrl, apiKey }: { baseUrl: string; apiKey?: string }): Promise<Set<string>>` — lowercased slugs; fail-open (404/503/parse error → empty Set).

**Note:** confirm where lib unit tests live — check for an existing `scripts/lib/__tests__/` or `*.test.ts` beside a lib file, and the vitest `unit` project `include` glob in `vitest.config.*`. Place the new test to match. If no lib-test convention exists, add the test under `scripts/__tests__/`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { fetchExcludedSlugs } from '../publish-client.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('fetchExcludedSlugs', () => {
  it('returns a lowercased Set of slugs from {slugs:[...]}', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, status: 200,
      json: async () => ({ slugs: ['Foo-Bar', 'baz'] }),
    })));
    const set = await fetchExcludedSlugs({ baseUrl: 'http://x' });
    expect(set.has('foo-bar')).toBe(true);
    expect(set.has('baz')).toBe(true);
    expect(set.size).toBe(2);
  });

  it('fails open to empty Set on 404', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 404 })));
    const set = await fetchExcludedSlugs({ baseUrl: 'http://x' });
    expect(set.size).toBe(0);
  });

  it('fails open to empty Set on network error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED'); }));
    const set = await fetchExcludedSlugs({ baseUrl: 'http://x' });
    expect(set.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- fetch-excluded-slugs`
Expected: FAIL — `fetchExcludedSlugs` not exported.

- [ ] **Step 3: Implement the helper** — in `scripts/lib/publish-client.ts`, after `fetchRemoteSourceHashes` (:215):

```ts
/**
 * Fetch the lowercased slugs of DELETED/INACTIVE tutorials (#2585 follow-up).
 * `/content/excluded-slugs` returns `{ slugs: string[] }`. The publisher uses
 * this to skip discovering/validating/quarantining retired tutorials.
 *
 * Public-read on prod srv; srv-qa gates it behind hashesAuth, so pass apiKey
 * when targeting QA. Fail-open: any non-OK status or error → empty Set, so a
 * not-yet-deployed endpoint never breaks a rebuild.
 */
export async function fetchExcludedSlugs({ baseUrl, apiKey }: { baseUrl: string; apiKey?: string }): Promise<Set<string>> {
  try {
    const res = await fetch(`${baseUrl}/content/excluded-slugs`, apiKey ? { headers: { Authorization: `Bearer ${apiKey}` } } : undefined);
    if (!res.ok) return new Set();
    const body = (await res.json()) as { slugs?: string[] };
    return new Set((body.slugs || []).map(s => String(s).toLowerCase()));
  } catch {
    return new Set();
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- fetch-excluded-slugs`
Expected: PASS (all three).

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/publish-client.ts scripts/lib/__tests__/fetch-excluded-slugs.test.ts
git commit -m "feat(publish): add fetchExcludedSlugs client helper (#2585)"
```

---

### Task 4: `fetch-tutorials` skips excluded slugs at discovery

**Files:**
- Modify: `scripts/fetch-tutorials.ts` — import `fetchExcludedSlugs`; filter `allTutorials` right after the main-path assignment (:821) and in the `--regenerate` branch (:801).
- Test: covered by Task 3's helper test + a small pure-filter unit test (below). The end-to-end fetch is exercised by `test:hybrid`/CI, not unit.

**Interfaces:**
- Consumes: `fetchExcludedSlugs` from `./lib/publish-client.js` (Task 3). `DiscoveredTutorial = { slug, repo, branch }`.

- [ ] **Step 1: Write the failing test** — `scripts/__tests__/discovery-exclusion.test.ts` (new), testing the pure filter the task extracts:

```ts
import { describe, it, expect } from 'vitest';
import { applyExclusion } from '../lib/discovery-exclusion.js';

describe('applyExclusion', () => {
  it('drops tutorials whose lowercased slug is excluded', () => {
    const tutorials = [
      { slug: 'Keep-Me', repo: 'Tutorials', branch: 'master' },
      { slug: 'drop-me', repo: 'Tutorials', branch: 'master' },
    ];
    const out = applyExclusion(tutorials, new Set(['drop-me']));
    expect(out.map(t => t.slug)).toEqual(['Keep-Me']);
  });

  it('is a no-op on an empty exclusion set', () => {
    const tutorials = [{ slug: 'a', repo: 'r', branch: 'b' }];
    expect(applyExclusion(tutorials, new Set())).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- discovery-exclusion`
Expected: FAIL — `../lib/discovery-exclusion.js` does not exist.

- [ ] **Step 3: Create the pure helper** — `scripts/lib/discovery-exclusion.ts`:

```ts
import type { DiscoveredTutorial } from '../parsers/github.js'

/** Drop tutorials whose lowercased slug is in `excluded` (#2585). Pure + testable. */
export function applyExclusion(tutorials: DiscoveredTutorial[], excluded: Set<string>): DiscoveredTutorial[] {
  if (!excluded.size) return tutorials
  return tutorials.filter(t => !excluded.has(t.slug.toLowerCase()))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- discovery-exclusion`
Expected: PASS.

- [ ] **Step 5: Wire into fetch-tutorials** — add to the import block (after :8):

```ts
import { fetchExcludedSlugs } from './lib/publish-client.js'
import { applyExclusion } from './lib/discovery-exclusion.js'
```

Main path — replace :820-821:

```ts
    const discovery = await discoverAllTutorials()
    allTutorials = discovery.tutorials
    // #2585 — skip DELETED/INACTIVE tutorials before any downstream consumer
    // (cache write, HANA baseline, task map). Fail-open: unreachable endpoint
    // → empty set → no filtering.
    {
      const excluded = await fetchExcludedSlugs({
        baseUrl: process.env.CAP_BASE_URL ?? 'http://localhost:4004',
        apiKey: process.env.CONTENT_API_KEY,
      })
      if (excluded.size) {
        const before = allTutorials.length
        allTutorials = applyExclusion(allTutorials, excluded)
        console.log(`[fetch] excluded ${before - allTutorials.length} DELETED/INACTIVE tutorial(s) from discovery`)
      }
    }
```

`--regenerate` branch — after :801 (`allTutorials = cachedFiles.map(...)`), add the same filter (regenerate reads env the same way):

```ts
    {
      const excluded = await fetchExcludedSlugs({
        baseUrl: process.env.CAP_BASE_URL ?? 'http://localhost:4004',
        apiKey: process.env.CONTENT_API_KEY,
      })
      if (excluded.size) allTutorials = applyExclusion(allTutorials, excluded)
    }
```

- [ ] **Step 6: Typecheck + full suite**

Run: `npx tsc --noEmit -p tsconfig.json` (or the project's typecheck script — check `jq '.scripts' package.json` for a `typecheck`/`check` entry; use it if present)
Then: `npm test`
Expected: no new type errors; all unit tests pass.

- [ ] **Step 7: Commit**

```bash
git add scripts/fetch-tutorials.ts scripts/lib/discovery-exclusion.ts scripts/__tests__/discovery-exclusion.test.ts
git commit -m "feat(fetch): skip DELETED/INACTIVE tutorials at discovery (#2585)"
```

---

### Task 5: `validate-tutorials` skips excluded slugs

**Files:**
- Modify: `scripts/validate-tutorials.ts` — fetch the excluded set in `main()` and skip those files before validation/quarantine.
- Test: `scripts/__tests__/validate-exclusion.test.ts` (new) — test a small pure `isExcluded` helper.

**Interfaces:**
- Consumes: `fetchExcludedSlugs` (Task 3).
- Produces: `main()` skips excluded `.md` files (no quarantine, no validation).

- [ ] **Step 1: Write the failing test** — `scripts/__tests__/validate-exclusion.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { slugFromFile } from '../validate-tutorials.js';

describe('slugFromFile', () => {
  it('derives lowercased slug from a .md filename', () => {
    expect(slugFromFile('Connect-GCP.md')).toBe('connect-gcp');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- validate-exclusion`
Expected: FAIL — `slugFromFile` not exported.

- [ ] **Step 3: Extract + export the slug helper and add exclusion** — in `scripts/validate-tutorials.ts`:

Add an exported helper near the top (after the constants, ~:11):

```ts
/** Lowercased canonical slug from a tutorial .md filename. Exported for tests. */
export function slugFromFile(file: string): string {
  return file.replace(/\.md$/, '').toLowerCase()
}
```

Add the import (after :4):

```ts
import { fetchExcludedSlugs } from './lib/publish-client.js'
```

In `main()`, after `const repoBySlug = loadRepoBySlug()` (:161), add:

```ts
  // #2585 — never validate/quarantine a tutorial IMS has retired. Fail-open:
  // unreachable endpoint → empty set → validate everything as before.
  const excluded = await fetchExcludedSlugs({
    baseUrl: process.env.CAP_BASE_URL ?? 'http://localhost:4004',
    apiKey: process.env.CONTENT_API_KEY,
  })
```

At the top of the `for (const file of files)` loop body (:163+), skip excluded files before any check:

```ts
  for (const file of files) {
    if (excluded.has(slugFromFile(file))) {
      console.log(`  ⤼ ${file}: skipped (tutorial is DELETED/INACTIVE)`)
      continue
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- validate-exclusion`
Expected: PASS. (Importing the module must not run `main()` — the entrypoint guard at :243 already prevents that.)

- [ ] **Step 5: Full suite + typecheck**

Run: `npx tsc --noEmit -p tsconfig.json` then `npm test`
Expected: no new type errors; all unit tests pass.

- [ ] **Step 6: Commit**

```bash
git add scripts/validate-tutorials.ts scripts/__tests__/validate-exclusion.test.ts
git commit -m "feat(validate): skip DELETED/INACTIVE tutorials in pre-publish validation (#2585)"
```

---

### Task 6: One-off cleanup script for the live snapshot

**Files:**
- Create: `scripts/clear-deleted-from-quarantine.cjs`.
- Test: `scripts/__tests__/clear-deleted-from-quarantine.test.js` (new) — test the core function against in-memory SQLite.

**Interfaces:**
- Produces: `async function clearDeletedFromQuarantine({ commit, log }): Promise<{ currentCount, survivorCount, droppedSlugs, newSnapshotId|null }>` exported from the `.cjs` for test; CLI wrapper runs it under `cds bind --exec`.

**Note:** this mirrors `scripts/reclassify-contentless-tutorials.cjs` structure (CommonJS, `require('@sap/cds')`, `--commit` dry-run default, exported core fn + CLI guard). Read that file first for the exact bootstrap/CLI idiom and match it.

- [ ] **Step 1: Write the failing test** — `scripts/__tests__/clear-deleted-from-quarantine.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { clearDeletedFromQuarantine } from '../clear-deleted-from-quarantine.cjs';

const NS = 'com.sap.developers.ims';
cds.test('serve', '--project', '.', '--in-memory');

describe('clearDeletedFromQuarantine', () => {
  beforeAll(async () => { await cds.connect.to('db'); });
  beforeEach(async () => {
    const { QuarantineSnapshots, QuarantineEvents, Tutorials } = cds.entities(NS);
    await DELETE.from(QuarantineEvents);
    await DELETE.from(QuarantineSnapshots);
    await DELETE.from(Tutorials);
  });

  async function seed() {
    const { QuarantineSnapshots, Tutorials } = cds.entities(NS);
    await INSERT.into(Tutorials).entries([
      { ID: cds.utils.uuid(), slug: 'dead', title: 't', status: 'DELETED' },
      { ID: cds.utils.uuid(), slug: 'live', title: 't', status: 'ACTIVE' },
    ]);
    await INSERT.into(QuarantineSnapshots).entries({
      ID: cds.utils.uuid(), buildMode: 'full', isCurrent: true, eventCount: 2,
      events: [
        { ID: cds.utils.uuid(), slug: 'dead', reason: 'x' },
        { ID: cds.utils.uuid(), slug: 'live', reason: 'y' },
      ],
    });
  }

  it('dry-run reports survivors without mutating', async () => {
    await seed();
    const { QuarantineSnapshots } = cds.entities(NS);
    const r = await clearDeletedFromQuarantine({ commit: false });
    expect(r.droppedSlugs).toEqual(['dead']);
    expect(r.survivorCount).toBe(1);
    const cur = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(cur[0].eventCount).toBe(2); // unchanged
  });

  it('commit writes a new current snapshot with only survivors', async () => {
    await seed();
    const { QuarantineSnapshots, QuarantineEvents } = cds.entities(NS);
    await clearDeletedFromQuarantine({ commit: true });
    const cur = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(cur.length).toBe(1);
    const ev = await SELECT.from(QuarantineEvents).where({ snapshot_ID: cur[0].ID });
    expect(ev.map(e => e.slug)).toEqual(['live']);
  });

  it('no-op when no current event is excluded', async () => {
    const { Tutorials, QuarantineSnapshots } = cds.entities(NS);
    await INSERT.into(Tutorials).entries({ ID: cds.utils.uuid(), slug: 'live', title: 't', status: 'ACTIVE' });
    await INSERT.into(QuarantineSnapshots).entries({
      ID: cds.utils.uuid(), buildMode: 'full', isCurrent: true, eventCount: 1,
      events: [{ ID: cds.utils.uuid(), slug: 'live', reason: 'y' }],
    });
    const r = await clearDeletedFromQuarantine({ commit: true });
    expect(r.droppedSlugs).toEqual([]);
    expect(r.newSnapshotId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- clear-deleted-from-quarantine`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the script** — `scripts/clear-deleted-from-quarantine.cjs`:

```js
#!/usr/bin/env node
// scripts/clear-deleted-from-quarantine.cjs
//
// #2585 follow-up — one-off: clear DELETED/INACTIVE tutorials from the CURRENT
// quarantine snapshot without waiting for the next full rebuild. Re-writes the
// current snapshot's events minus any whose slug is a DELETED/INACTIVE
// Tutorials row, as a NEW current snapshot (snapshots stay immutable; the
// isCurrent flip clears the old one). Idempotent: no excluded current event →
// no-op (no new snapshot). Dry-run by default; --commit to apply.
//
// Usage (cf login'd shell targeting the right space):
//   npx cds bind --exec --profile hybrid -- node scripts/clear-deleted-from-quarantine.cjs
//   npx cds bind --exec --profile hybrid -- node scripts/clear-deleted-from-quarantine.cjs --commit
'use strict';

const cds = require('@sap/cds');
const NS = 'com.sap.developers.ims';
const lc = (s) => String(s || '').toLowerCase();

async function clearDeletedFromQuarantine({ commit = false, log } = {}) {
  const logger = log || cds.log('clear-deleted-quarantine');
  const { QuarantineSnapshots, Tutorials } = cds.entities(NS);

  const [current] = await SELECT.from(QuarantineSnapshots)
    .where({ isCurrent: true })
    .columns(s => { s('*'), s.events(e => e('*')); });
  if (!current) {
    logger.info('no current snapshot — nothing to do');
    return { currentCount: 0, survivorCount: 0, droppedSlugs: [], newSnapshotId: null };
  }
  const events = current.events || [];

  const retired = await SELECT.from(Tutorials)
    .columns('slug')
    .where({ status: { in: ['DELETED', 'INACTIVE'] } });
  const retiredSet = new Set(retired.map(r => lc(r.slug)));

  const survivors = events.filter(e => !retiredSet.has(lc(e.slug)));
  const droppedSlugs = events.filter(e => retiredSet.has(lc(e.slug))).map(e => lc(e.slug));

  if (droppedSlugs.length === 0) {
    logger.info(`current snapshot has ${events.length} events, none retired — no-op`);
    return { currentCount: events.length, survivorCount: survivors.length, droppedSlugs: [], newSnapshotId: null };
  }

  logger.info(`dropping ${droppedSlugs.length} retired slug(s): ${droppedSlugs.join(', ')}`);
  if (!commit) {
    logger.info('(dry-run — pass --commit to apply)');
    return { currentCount: events.length, survivorCount: survivors.length, droppedSlugs, newSnapshotId: null };
  }

  const db = await cds.connect.to('db');
  const newId = cds.utils.uuid();
  await db.tx(async (tx) => {
    await tx.run(UPDATE(QuarantineSnapshots).set({ isCurrent: false }).where({ isCurrent: true }));
    await tx.run(INSERT.into(QuarantineSnapshots).entries({
      ID: newId,
      runId: current.runId,
      workflowUrl: current.workflowUrl,
      manifestVersion: current.manifestVersion,
      buildMode: 'full',
      isCurrent: true,
      eventCount: survivors.length,
      events: survivors.map(e => ({
        ID: cds.utils.uuid(),
        slug: lc(e.slug),
        sourceFile: e.sourceFile ?? null,
        sourceRepo: e.sourceRepo ?? null,
        reason: e.reason ?? '',
        sourceUrl: e.sourceUrl ?? null,
      })),
    }));
  });
  logger.info(`wrote new current snapshot ${newId} with ${survivors.length} survivor(s)`);
  return { currentCount: events.length, survivorCount: survivors.length, droppedSlugs, newSnapshotId: newId };
}

module.exports = { clearDeletedFromQuarantine };

if (require.main === module) {
  const commit = process.argv.includes('--commit');
  cds.connect.to('db')
    .then(() => clearDeletedFromQuarantine({ commit }))
    .then((r) => { console.log(JSON.stringify(r, null, 2)); process.exit(0); })
    .catch((e) => { console.error(e); process.exit(1); });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- clear-deleted-from-quarantine`
Expected: PASS (all three). If the `.columns(s => ...)` deep-expand form errors under the installed `@sap/cds`, replace the current-snapshot read with a two-step read: `SELECT.one` the snapshot, then `SELECT.from(QuarantineEvents).where({ snapshot_ID: current.ID })`. Verify the deep-read syntax against cds-mcp before finalizing.

- [ ] **Step 5: Commit**

```bash
git add scripts/clear-deleted-from-quarantine.cjs scripts/__tests__/clear-deleted-from-quarantine.test.js
git commit -m "feat(ops): one-off script to clear DELETED/INACTIVE from current quarantine snapshot (#2585)"
```

---

### Task 7: Docs + gotcha pointer

**Files:**
- Modify: `docs/developers/reference/tutorials-ims-gotchas.md` — add a short entry under the quarantine material.
- Modify: `CLAUDE.md` — one bullet near the quarantine/`#2585` line, if present.

- [ ] **Step 1: Add the gotcha** — append to the quarantine section of `docs/developers/reference/tutorials-ims-gotchas.md`:

```markdown
### Quarantine + publisher are status-aware (#2585 follow-up)

A tutorial with `Tutorials.status IN ('DELETED','INACTIVE')` is excluded from
the whole publish/quarantine path:
- `GET /content/excluded-slugs` (public-read prod / `hashesAuth` qa) returns
  those lowercased slugs.
- `fetch-tutorials` + `validate-tutorials` fetch it and skip those slugs at
  discovery/validation (fail-open — unreachable endpoint = no filtering).
- `quarantineIngestHandler` drops events for those slugs before persisting, so
  the Admin active-quarantine facet (slug-only join) never shows them.
One-off cleanup of a live snapshot: `scripts/clear-deleted-from-quarantine.cjs`
(`cds bind --exec`, `--commit`). Note: the pre-existing `/content/source-hashes`
filter excluded only INACTIVE; the excluded-slugs query covers both statuses.
```

- [ ] **Step 2: Commit**

```bash
git add docs/developers/reference/tutorials-ims-gotchas.md CLAUDE.md
git commit -m "docs: quarantine/publisher are status-aware for DELETED/INACTIVE (#2585)"
```

---

## Self-Review

**Spec coverage:**
- Spec §1 (new endpoint) → Task 1. ✅
- Spec §2 (publisher fetch + validate) → Tasks 3, 4, 5. ✅ (Design dropped the `_excluded.json` sidecar: `validate-tutorials` already reads `CAP_BASE_URL`/`CONTENT_API_KEY` via `postQuarantineSnapshot`, so it fetches the endpoint directly — simpler, documented in Task 5. This is the one deliberate deviation from the written spec.)
- Spec §3 (ingest drop) → Task 2. ✅
- Spec §4 (one-off cleanup) → Task 6. ✅
- Spec "latent bug" (source-hashes excludes only INACTIVE) → covered by the new query handling both statuses; noted in Task 7. The source-hashes query itself is intentionally left unchanged (out of scope — changing it affects `--purge-orphans` semantics).
- Spec testing section → each task is TDD with real test code. ✅

**Placeholder scan:** No TBD/TODO. The two "confirm against cds-mcp / check vitest glob" notes are explicit verification steps, not placeholders — each has a concrete fallback.

**Type consistency:** `fetchExcludedSlugs` returns `Set<string>` and is consumed as such in Tasks 4 & 5. `applyExclusion(DiscoveredTutorial[], Set<string>)` matches the `DiscoveredTutorial = {slug,repo,branch}` shape from `parsers/github.ts`. Handler name `excludedSlugsHandler` is consistent across handler/factory/export/import/routes. `clearDeletedFromQuarantine` return shape matches its test assertions.

**Deviation flagged for implementer:** Task 2 edits the ingest handler's `events` derivation — the implementer must preserve the existing array-guard behavior (the existing test `rejects non-array events with 400` must still pass). Steps spell out the exact edit.
