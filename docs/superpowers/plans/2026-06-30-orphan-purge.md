# Orphan-Purge Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CI-only `--purge-orphans` mode to `scripts/publish-content.ts` that soft-deletes tutorials whose source markdown no longer exists in any upstream repo. Backed by a new `POST /content/orphan-purge` bare-Express endpoint (CONTENT_API_KEY-authenticated, same auth model as `/content/publish`) and a `purge-orphans` workflow input on `rebuild-content.yml`.

**Architecture:** Three changes in two PRs.

- **PR-1 (server + companion fix):** filter `Tutorials.status='INACTIVE'` out of `GET /content/source-hashes`; add `orphanPurgeHandler` in `srv/lib/content-store.js` with soft-delete batching + `logPipeline` attribution; route as `POST /content/orphan-purge` (NOT `/admin/`) with `contentAuthMiddleware` so the CI's existing `CONTENT_API_KEY` works; unit + hybrid tests.
- **PR-2 (CLI + workflow):** `--purge-orphans` flag on `publish-content.ts` with 50-slug absolute cap and CI-only `GITHUB_ACTIONS` hard-block; `purge-orphans` boolean input on `rebuild-content.yml` gated on `effective_mode=='full' && publish.outcome=='success'`; mode-determine step rejects `slug-targeted + purge-orphans=true` combo.

**Tech Stack:** Node.js (CAP), TypeScript (CLI script), CDS / SQL, GitHub Actions YAML, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-30-orphan-purge-design.md](../specs/2026-06-30-orphan-purge-design.md)

**Auth-model note (resolves spec ambiguity):** the spec's phrase "Same XSUAA bearer as `/content/publish`" is misleading — `/content/publish` is bare-Express + `contentAuthMiddleware` + static `CONTENT_API_KEY`, NOT XSUAA. AdminService is XSUAA-scope-gated (`@requires: 'Admin'`). To keep the existing CI auth model (single `CONTENT_API_KEY` secret already wired into `rebuild-content.yml`), the new endpoint is **routed as bare Express under `/content/`**, NOT as a CAP action on AdminService.

---

## File Structure

### PR-1: Server + companion fix (own PR, deploys first)

| File | Action | Responsibility |
|---|---|---|
| `srv/lib/content-store.js` | Modify `sourceHashesHandler` (line 1107) + add new `orphanPurgeHandler` near `rollbackHandler` (~line 1360) + export it from `createContentHandlers` (line 1480-ish) | INACTIVE filter on source-hashes; new bare-Express POST handler with bucket dispatch, 100-slug server cap, logPipeline integration. |
| `srv/server.js` | Modify near line 338 (next to `rollbackHandler` route) | Register `POST /content/orphan-purge` with `express.json` + `contentAuthMiddleware`. |
| `scripts/check-null-status-rows.cjs` | Create | One-shot diagnostic — counts `Tutorials.status IS NULL` rows for the source-hashes filter design. |
| `test/unit/source-hashes-filter.test.js` | Create | Unit test for the INACTIVE filter on the public source-hashes endpoint. |
| `test/unit/orphan-purge-endpoint.test.js` | Create | Unit test for the `/content/orphan-purge` handler buckets. |
| `test/hybrid/orphan-purge.test.js` | Create | E2E against HANA; seeds `__TEST__purge-orphan-*` rows; asserts status flip, source-hashes exclusion, PipelineLog row. |
| `test/hybrid/source-hashes-filters-inactive.test.js` | Create | Independent hybrid regression test for the source-hashes companion fix. |
| `test/smoke/auth-enforcement.test.js` | Modify | Add `/content/orphan-purge` 401-without-bearer assertion. |

### PR-2: CLI + workflow (separate PR, after PR-1 in DEV)

| File | Action | Responsibility |
|---|---|---|
| `scripts/lib/purge-orphans.ts` | Create | Pure helpers: `computeOrphans`, `enforceCap`, `formatStepSummary`. |
| `scripts/publish-content.ts` | Modify `validateFlagCombo` (line 437), extend `parseArgs` flag-parse (~line 533), extend `PublishOptions` interface (lines 501-515), add new `--purge-orphans` branch in `main` after the `--verify-only` short-circuit's closing brace (line 715) | New flag, CI-only guard, cap, POST `/content/orphan-purge`, error handling, step summary. |
| `.github/workflows/rebuild-content.yml` | Modify | New `purge-orphans` input; extend mode-determine step to reject `slug-targeted + purge-orphans=true`; add `id: publish` to existing "Publish tutorial content to HANA" step; new gated "Purge orphan tutorials" step. |
| `test/unit/purge-orphans-cap.test.js` | Create | Unit tests for pure helpers. |
| `test/unit/purge-orphans-cli-guard.test.js` | Create | `GITHUB_ACTIONS` guard + mutex tests. |
| `docs/developers/operations/rebuild-content-workflow.md` | Modify | Operator-facing "When to run purge-orphans" section. |

---

# PR-1 — Server + companion fix

## Task 1: Pre-deploy NULL-status row check (diagnostic only)

**Why:** Get evidence for the data state before shipping the source-hashes filter. The filter in Task 3 ships with `OR status IS NULL` defensively in either case (matches the serve handler's existing NULL semantics at [content-store.js:978](../../../srv/lib/content-store.js#L978)), so this task is a sanity check that informs the PR description, not a branch point. If count > 0, no migration is required — the OR-NULL preserves visibility.

**Files:**
- Create: `scripts/check-null-status-rows.cjs`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// One-shot diagnostic — run via `cds bind --exec -- node scripts/check-null-status-rows.cjs`
// against DEV (and optionally PROD). Reports Tutorials rows with status IS NULL.
//
// Used by docs/superpowers/plans/2026-06-30-orphan-purge.md Task 1 to validate
// the assumption that NULL-status rows are rare. The source-hashes filter in
// Task 3 already handles both cases (ships with OR-NULL clause), so this is
// a sanity check, not a decision branch.

const cds = require('@sap/cds');

(async () => {
  await cds.connect.to('db');
  const db = await cds.connect.to('db');
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  const sql = isHana
    ? `SELECT COUNT(*) AS NULL_COUNT FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "STATUS" IS NULL`
    : `SELECT COUNT(*) AS NULL_COUNT FROM com_sap_developers_ims_tutorials WHERE status IS NULL`;
  const result = await db.run(sql);
  const count = result[0]?.NULL_COUNT ?? result[0]?.null_count ?? result[0]?.['COUNT(*)'] ?? 0;
  console.log(`Tutorials with status IS NULL: ${count}`);
  if (count > 0) {
    console.log(`\n→ The new /content/source-hashes filter ships with`);
    console.log(`  WHERE (t.status IS NULL OR t.status != 'INACTIVE')`);
    console.log(`  so these NULL rows continue to be returned (matches the serve handler).`);
  } else {
    console.log(`→ Filter's OR-NULL clause is currently defensive (no rows match it today).`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run against DEV**

```bash
cd /d/projects/tutorials-poc
cf login   # if not already logged into DEV space
npx cds bind --exec -- node scripts/check-null-status-rows.cjs
```

Expected: prints a count (probably 0). Record it for the PR description.

- [ ] **Step 3: Commit**

```bash
git add scripts/check-null-status-rows.cjs
git commit -m "scripts: add NULL-status row check for orphan-purge plan

One-shot diagnostic for docs/superpowers/plans/2026-06-30-orphan-purge.md
Task 1. Records evidence for the data state of Tutorials.status NULL
rows before shipping the new /content/source-hashes INACTIVE filter."
```

## Task 2: Source-hashes filter — write the failing test

**Files:**
- Create: `test/unit/source-hashes-filter.test.js`

- [ ] **Step 1: Write the test**

```js
/**
 * Verifies GET /content/source-hashes excludes Tutorials.status='INACTIVE'
 * rows from the returned map.
 *
 * Carry-forward keeps INACTIVE rows in the manifest for snapshot integrity;
 * this filter only affects the external-facing endpoint so the daily drift
 * workflow stops re-reporting purged slugs forever.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-1
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('GET /content/source-hashes — INACTIVE filter', () => {
  const namespace = 'com.sap.developers.ims';
  const testManifestVersion = 99999;
  const ts = Date.now();
  const activeSlug = `test-active-${ts}`;
  const inactiveSlug = `test-inactive-${ts}`;

  beforeAll(async () => {
    const { ContentFiles, ContentManifest, Tutorials } = cds.entities(namespace);
    await UPDATE(ContentManifest).where({ status: 'ACTIVE' }).set({ status: 'SUPERSEDED' });
    await INSERT.into(ContentManifest).entries({
      version: testManifestVersion,
      status: 'ACTIVE',
      trigger: 'test',
      hugoVersion: 'test'
    });
    await INSERT.into(ContentFiles).entries([
      { slug: activeSlug,   version: testManifestVersion, sourceHash: 'aaa', content: Buffer.from('x'), contentHash: 'h1', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html' },
      { slug: inactiveSlug, version: testManifestVersion, sourceHash: 'bbb', content: Buffer.from('y'), contentHash: 'h2', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html' },
    ]);
    await INSERT.into(Tutorials).entries([
      { slug: activeSlug,   status: 'ACTIVE',   title: 'Active test' },
      { slug: inactiveSlug, status: 'INACTIVE', title: 'Inactive test' },
    ]);
  });

  afterAll(async () => {
    const { ContentFiles, ContentManifest, Tutorials } = cds.entities(namespace);
    await DELETE.from(ContentFiles).where({ version: testManifestVersion });
    await DELETE.from(ContentManifest).where({ version: testManifestVersion });
    await DELETE.from(Tutorials).where({ slug: { in: [activeSlug, inactiveSlug] } });
  });

  it('includes ACTIVE-status slug in the response map', async () => {
    const res = await project.get('/content/source-hashes');
    expect(res.status).toBe(200);
    expect(res.data[activeSlug]).toBe('aaa');
  });

  it('excludes INACTIVE-status slug from the response map', async () => {
    const res = await project.get('/content/source-hashes');
    expect(res.status).toBe(200);
    expect(res.data[inactiveSlug]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect failure on the second test**

```bash
npx vitest run test/unit/source-hashes-filter.test.js
```

Expected: second test FAILS (`inactiveSlug` is currently in the map).

## Task 3: Source-hashes filter — implement

**Files:**
- Modify: `srv/lib/content-store.js` `sourceHashesHandler` (~line 1107)

- [ ] **Step 1: Read the current handler (lines 1107-1132) so the diff is clear**

The existing body:

```js
async function sourceHashesHandler(req, res) {
  const { ContentFiles } = cds.entities(namespace);
  try {
    const activeVersion = await getActiveVersion();
    if (activeVersion === null) {
      return res.json({});
    }
    const rows = await SELECT.from(ContentFiles)
      .where({ version: activeVersion })
      .columns('slug', 'sourceHash');
    const map = {};
    for (const row of rows) {
      if (!row.sourceHash) continue;
      if (row.slug === '__nav__' || row.slug === '__404__' || row.slug === '__shell__') continue;
      map[row.slug] = row.sourceHash;
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.json(map);
  } catch (err) {
    console.error('[content/source-hashes]', err instanceof Error ? err.message : String(err));
    res.status(500).json({ error: 'Source-hash retrieval failed' });
  }
}
```

- [ ] **Step 2: Replace ONLY the SELECT chain (3 lines) with a Tutorials-aware JOIN; leave the rows-iteration loop unchanged**

Replace:

```js
    const rows = await SELECT.from(ContentFiles)
      .where({ version: activeVersion })
      .columns('slug', 'sourceHash');
```

With:

```js
    // Exclude soft-deleted tutorials so the daily drift workflow stops re-
    // reporting them as "missing locally" forever. Carry-forward keeps
    // INACTIVE rows in the manifest for snapshot integrity; this filter
    // only affects this external-facing endpoint and matches the serve
    // handler's NULL-tolerant behavior at content-store.js:978.
    //
    // LOWER() on both sides because Tutorials.slug may be mixed-case in
    // legacy rows even though new slugs are lowercase canonical
    // (CLAUDE.md > "Tutorial slugs are lowercase canonical").
    const db = await cds.connect.to('db');
    const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
    const rows = isHana
      ? (await db.run(
          `SELECT cf."SLUG" AS "slug", cf."SOURCEHASH" AS "sourceHash"
             FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES" AS cf
             LEFT JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" AS t
               ON LOWER(cf."SLUG") = LOWER(t."SLUG")
            WHERE cf."VERSION" = ?
              AND (t."STATUS" IS NULL OR t."STATUS" != 'INACTIVE')`,
          [activeVersion]
        ))
      : (await db.run(
          `SELECT cf.slug AS slug, cf.sourceHash AS sourceHash
             FROM com_sap_developers_ims_contentfiles AS cf
             LEFT JOIN com_sap_developers_ims_tutorials AS t
               ON LOWER(cf.slug) = LOWER(t.slug)
            WHERE cf.version = ?
              AND (t.status IS NULL OR t.status != 'INACTIVE')`,
          [activeVersion]
        ));
```

Keep the rows-iteration loop and `res.setHeader` / `res.json(map)` calls below unchanged — they still need to skip `__nav__/__404__/__shell__` and null `sourceHash`.

- [ ] **Step 3: Run the failing test from Task 2**

```bash
npx vitest run test/unit/source-hashes-filter.test.js
```

Expected: both tests PASS.

- [ ] **Step 4: Run the full unit suite to confirm no regression**

```bash
npm test -- --run 2>&1 | grep -E "FAIL|✗|Test Files|Tests " | tail -20
```

Expected: no new failures.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-store.js test/unit/source-hashes-filter.test.js
git commit -m "feat(content-store): exclude INACTIVE tutorials from /content/source-hashes

Adds a LEFT JOIN to Tutorials with
  WHERE (t.status IS NULL OR t.status != 'INACTIVE')
so the daily content-drift workflow stops re-reporting soft-deleted slugs
as 'missing locally' forever. The carry-forward path keeps INACTIVE rows
in the manifest for snapshot integrity — this filter only affects the
external-facing endpoint, matching how the serve handler treats INACTIVE
rows (content-store.js:978).

The OR-NULL clause preserves the existing invariant that NULL-status
legacy rows are treated as not-INACTIVE; Task 1's diagnostic in the same
PR records how many such rows exist today.

Companion fix to the orphan-purge endpoint (next commit). Spec:
docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-1."
```

## Task 4: orphan-purge endpoint — write the failing test

**Files:**
- Create: `test/unit/orphan-purge-endpoint.test.js`

- [ ] **Step 1: Write the test**

```js
/**
 * Unit tests for POST /content/orphan-purge.
 *
 * The endpoint is bare-Express (not an AdminService action) — same auth
 * model as /content/publish (contentAuthMiddleware + CONTENT_API_KEY).
 * The CI's existing CONTENT_API_KEY secret authenticates the call.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-2
 *
 * Per-slug bucket dispatch:
 *   - slug in Tutorials with status=ACTIVE                  → purged[]
 *   - slug in Tutorials with status=INACTIVE                → alreadyInactive[]
 *   - slug in Tutorials with redirectTo_ID set              → redirected[]
 *     (the validator at admin-service.js:837-843 enforces these are
 *      always already-INACTIVE — the bucket exists so the operator
 *      sees them in the response instead of them silently landing in
 *      alreadyInactive)
 *   - slug NOT in Tutorials                                  → notFound[]
 *     (phantom ContentFiles row; requires operator action)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { _resetForTests as resetSecretResolver } from '../../srv/lib/secret-resolver.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('POST /content/orphan-purge', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slugActive    = `test-purge-active-${ts}`;
  const slugActive2   = `test-purge-active2-${ts}`;
  const slugInactive  = `test-purge-inactive-${ts}`;
  const slugRedirect  = `test-purge-redirect-${ts}`;   // INACTIVE + redirectTo_ID set
  const slugRedirectTarget = `test-purge-redirect-target-${ts}`;
  const slugMissing   = `test-purge-missing-${ts}`;     // not in Tutorials at all

  const headers = { 'authorization': `Bearer ${process.env.CONTENT_API_KEY || 'test-key'}`, 'x-initiator': 'test/unit-1' };

  beforeAll(async () => {
    // contentAuthMiddleware reads CONTENT_API_KEY via secret-resolver,
    // which caches in a globalThis singleton (5-min TTL). If another test
    // in the same worker primed the cache to null or a different value,
    // setting process.env here won't take effect. Reset explicitly —
    // matches the precedent at test/unit/mail-client-credstore.test.js.
    process.env.CONTENT_API_KEY = 'test-key';
    resetSecretResolver();
    const { Tutorials } = cds.entities(ns);
    const targetID = randomUUID();
    await INSERT.into(Tutorials).entries([
      { ID: randomUUID(),         slug: slugActive,         status: 'ACTIVE',   title: 'Active 1' },
      { ID: randomUUID(),         slug: slugActive2,        status: 'ACTIVE',   title: 'Active 2' },
      { ID: randomUUID(),         slug: slugInactive,       status: 'INACTIVE', title: 'Inactive' },
      { ID: targetID,             slug: slugRedirectTarget, status: 'ACTIVE',   title: 'Redirect target' },
      { ID: randomUUID(),         slug: slugRedirect,       status: 'INACTIVE', title: 'With redirect', redirectTo_ID: targetID },
    ]);
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug: { in: [slugActive, slugActive2, slugInactive, slugRedirect, slugRedirectTarget] } });
  });

  it('buckets slugs by per-slug behavior', async () => {
    const res = await project.post('/content/orphan-purge', { slugs: [slugActive, slugActive2, slugInactive, slugRedirect, slugMissing] }, { headers });
    expect(res.status).toBe(200);
    expect(res.data.purged.sort()).toEqual([slugActive, slugActive2].sort());
    expect(res.data.alreadyInactive).toEqual([slugInactive]);
    expect(res.data.redirected).toEqual([slugRedirect]);
    expect(res.data.notFound).toEqual([slugMissing]);
    expect(res.data.totalAttempted).toBe(5);
    expect(res.data.totalPurged).toBe(2);
    expect(typeof res.data.version).toBe('number');
  });

  it('flips Tutorials.status to INACTIVE for purged slugs', async () => {
    const { Tutorials } = cds.entities(ns);
    const rows = await SELECT.from(Tutorials).where({ slug: { in: [slugActive, slugActive2] } }).columns('slug', 'status');
    expect(rows.every(r => r.status === 'INACTIVE')).toBe(true);
  });

  it('returns 401 without bearer token', async () => {
    const res = await project.post('/content/orphan-purge', { slugs: [] }, { validateStatus: () => true });
    expect(res.status).toBe(401);
  });

  it('rejects > 100 slugs with 400', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `test-purge-bulk-${ts}-${i}`);
    const res = await project.post('/content/orphan-purge', { slugs: tooMany }, { headers, validateStatus: () => true });
    expect(res.status).toBe(400);
    expect(String(res.data.error?.message || res.data.error || res.data)).toMatch(/100-slug ceiling/i);
  });

  it('is idempotent — re-running yields all alreadyInactive', async () => {
    const res = await project.post('/content/orphan-purge', { slugs: [slugActive, slugActive2] }, { headers });
    expect(res.status).toBe(200);
    expect(res.data.alreadyInactive.sort()).toEqual([slugActive, slugActive2].sort());
    expect(res.data.purged).toEqual([]);
  });
});
```

- [ ] **Step 2: Run — expect failure**

```bash
npx vitest run test/unit/orphan-purge-endpoint.test.js
```

Expected: 404 on POST `/content/orphan-purge` (route doesn't exist yet).

## Task 5: orphan-purge endpoint — implement the handler

**Files:**
- Modify: `srv/lib/content-store.js` — add `orphanPurgeHandler` next to `rollbackHandler` (~line 1410), then add to the returned object and to the top-level `_defaults` re-export (~lines 1483-1505)

- [ ] **Step 1: Add the `logPipeline` import at the top of the file**

Top of `srv/lib/content-store.js`. After existing imports, add:

```js
import { logPipeline } from './pipeline-log.js';
```

(Match the import style — top of file uses ESM `import` statements.)

- [ ] **Step 2: Add the handler immediately after `rollbackHandler`'s closing brace (~line 1410)**

```js
  // --- POST /content/orphan-purge ---
  //
  // CI-only batched soft-delete of tutorials whose source markdown is no
  // longer present in any upstream repo. Bare-Express + contentAuthMiddleware
  // (same auth model as /content/publish) so the existing CONTENT_API_KEY
  // secret authenticates the call — NOT routed through AdminService because
  // AdminService is XSUAA-scope-gated and CI doesn't carry an XSUAA bearer.
  //
  // Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md
  // Per-slug bucket dispatch — see spec §Architecture-2.
  // Server-side 100-slug ceiling — defense in depth; client refuses at 50.
  // Initiator captured via x-initiator header; persisted as PipelineLog with
  // metadata.stage='purge-orphans'.

  async function orphanPurgeHandler(req, res) {
    const slugs = Array.isArray(req.body?.slugs) ? req.body.slugs : null;
    if (!slugs) {
      return res.status(400).json({ error: 'Request body must include { slugs: array of String }' });
    }
    if (slugs.length > 100) {
      return res.status(400).json({ error: 'batch too large; orphan purge enforces a 100-slug ceiling per call' });
    }

    const initiator = req.headers['x-initiator'] || 'system';
    const runId = typeof initiator === 'string' && initiator.startsWith('ci/') ? initiator.slice(3) : null;

    try {
      const result = await logPipeline(
        'SCHEDULED_JOB',
        initiator,
        async () => {
          const { Tutorials, ContentManifest } = cds.entities(namespace);

          if (slugs.length === 0) {
            const [m] = await SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version').orderBy('version desc').limit(1);
            return {
              purged: [], alreadyInactive: [], notFound: [], redirected: [],
              totalAttempted: 0, totalPurged: 0, version: m?.version ?? 0
            };
          }

          // Bucket dispatch — fetch in one round trip, classify, then write.
          const lowered = slugs.map(s => String(s).toLowerCase());
          const rows = await SELECT.from(Tutorials)
            .where({ slug: { in: lowered } })
            .columns('ID', 'slug', 'status', 'redirectTo_ID');

          const bySlug = new Map(rows.map(r => [String(r.slug).toLowerCase(), r]));
          const purged = [], alreadyInactive = [], notFound = [], redirected = [];

          for (const original of slugs) {
            const key = String(original).toLowerCase();
            const row = bySlug.get(key);
            if (!row) { notFound.push(original); continue; }
            if (row.redirectTo_ID) { redirected.push(original); continue; }
            if (row.status === 'INACTIVE') { alreadyInactive.push(original); continue; }
            // Soft-delete — @cap-js/change-tracking records the status flip
            // via the annotation at db/change-tracking.cds:37. The Changes
            // row gets entity='AdminService.Tutorials' (projection name).
            await UPDATE(Tutorials).set({ status: 'INACTIVE' }).where({ ID: row.ID });
            purged.push(original);
          }

          const [activeManifest] = await SELECT.from(ContentManifest)
            .where({ status: 'ACTIVE' })
            .columns('version')
            .orderBy('version desc')
            .limit(1);

          return {
            purged,
            alreadyInactive,
            notFound,
            redirected,
            totalAttempted: slugs.length,
            totalPurged: purged.length,
            version: activeManifest?.version ?? 0
          };
        },
        { stage: 'purge-orphans', slugCount: slugs.length, runId }
      );

      res.json(result);
    } catch (err) {
      console.error('[content/orphan-purge]', err instanceof Error ? err.message : String(err));
      res.status(500).json({ error: 'Orphan purge failed' });
    }
  }
```

- [ ] **Step 3: Add `orphanPurgeHandler` to the returned object in `createContentHandlers` (~line 1483)**

Find the returned object that exposes the handlers (look for the `return { contentAuthMiddleware, publishHandler, ... }` block near line 1480). Add `orphanPurgeHandler,` to the list.

- [ ] **Step 4: Add the top-level re-export at the end of the file (~line 1505)**

After the other `export const ... = _defaults.X` lines, add:

```js
export const orphanPurgeHandler = _defaults.orphanPurgeHandler;
```

- [ ] **Step 5: Register the route in `srv/server.js` (next to the existing `/content/rollback` route at line 338)**

Find the line:

```js
app.post('/content/rollback', express.json(), contentAuthMiddleware, rollbackHandler);
```

Add immediately after:

```js
// Issue #orphan-purge — CI-only batched soft-delete. Same auth as /content/publish.
app.post('/content/orphan-purge', express.json({ limit: '1mb' }), contentAuthMiddleware, orphanPurgeHandler);
```

And add `orphanPurgeHandler` to the import at the top of `srv/server.js` (line 20):

```js
import { contentAuthMiddleware, publishHandler, serveHandler, hashesHandler, sourceHashesHandler, navHandler, rollbackHandler, invalidateRenderCache, beginHandler, appendHandler, commitHandler, abortHandler, orphanPurgeHandler } from './lib/content-store.js';
```

- [ ] **Step 6: Run the failing test from Task 4**

```bash
npx vitest run test/unit/orphan-purge-endpoint.test.js
```

Expected: all PASS (buckets, status flip, 401 without auth, 400 over-100, idempotent).

- [ ] **Step 7: Run full unit suite — confirm no regression**

```bash
npm test -- --run 2>&1 | grep -E "FAIL|✗|Test Files|Tests " | tail -20
```

- [ ] **Step 8: Commit**

```bash
git add srv/lib/content-store.js srv/server.js test/unit/orphan-purge-endpoint.test.js
git commit -m "feat(content-store): add POST /content/orphan-purge for batched soft-delete

Bare-Express endpoint (NOT an AdminService action) — same auth model as
/content/publish (contentAuthMiddleware + CONTENT_API_KEY) so the
existing CI secret authenticates the call. Routed under /content/ rather
than /admin/ because AdminService is XSUAA-scope-gated and CI doesn't
carry an XSUAA bearer.

Per-slug bucket dispatch:
- purged          — Tutorials.status flipped ACTIVE → INACTIVE
- alreadyInactive — idempotent re-run, no DB write
- redirected      — redirectTo_ID set; honor admin's deliberate redirect
- notFound        — slug has no Tutorials parent row (phantom; operator action)

Wraps work in logPipeline('SCHEDULED_JOB', ...) with metadata.stage='purge-orphans'
so per-run attribution is queryable via PipelineLog without inventing a new
pipelineType enum value.

Server-side 100-slug ceiling as defense in depth; client refuses at 50.

Change-tracking on Tutorials.status flip is automatic via @cap-js/change-tracking
(db/change-tracking.cds:37); the Changes row gets entity='AdminService.Tutorials'.

Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-2"
```

## Task 6: Hybrid test — orphan-purge end-to-end against HANA

**Files:**
- Create: `test/hybrid/orphan-purge.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
/**
 * Hybrid test — exercises /content/orphan-purge against real HANA.
 * Gated by ALLOW_HYBRID_WRITES=true per test/hybrid/_guard.js.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Testing
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const writesAllowed = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const describeIf = writesAllowed ? describe : describe.skip;

describeIf('POST /content/orphan-purge — hybrid (real HANA)', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slugA = `__TEST__purge-orphan-a-${ts}`;
  const slugB = `__TEST__purge-orphan-b-${ts}`;
  let srvUrl;
  let apiKey;

  beforeAll(async () => {
    srvUrl = process.env.CAP_BASE_URL || `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;
    apiKey = process.env.CONTENT_API_KEY;
    if (!apiKey) throw new Error('CONTENT_API_KEY env var required for hybrid orphan-purge test');

    const { Tutorials } = cds.entities(ns);
    await INSERT.into(Tutorials).entries([
      { slug: slugA, status: 'ACTIVE', title: '__TEST__ Active A' },
      { slug: slugB, status: 'ACTIVE', title: '__TEST__ Active B' },
    ]);
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug: { in: [slugA, slugB] } });
  });

  it('flips both seeded slugs from ACTIVE to INACTIVE', async () => {
    const res = await fetch(`${srvUrl}/content/orphan-purge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type':  'application/json',
        'x-initiator':   `test/hybrid-${ts}`
      },
      body: JSON.stringify({ slugs: [slugA, slugB] })
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.purged.sort()).toEqual([slugA, slugB].sort());
    expect(body.totalPurged).toBe(2);

    const { Tutorials } = cds.entities(ns);
    const rows = await SELECT.from(Tutorials).where({ slug: { in: [slugA, slugB] } }).columns('slug', 'status');
    expect(rows.every(r => r.status === 'INACTIVE')).toBe(true);
  });

  it('removes purged slugs from /content/source-hashes', async () => {
    const res = await fetch(`${srvUrl}/content/source-hashes`);
    const map = await res.json();
    expect(map[slugA]).toBeUndefined();
    expect(map[slugB]).toBeUndefined();
  });

  it('records a PipelineLog row with metadata.stage=purge-orphans', async () => {
    const { PipelineLog } = cds.entities(ns);
    const rows = await SELECT.from(PipelineLog)
      .where({ initiator: `test/hybrid-${ts}`, pipelineType: 'SCHEDULED_JOB' })
      .columns('ID', 'metadata', 'status');
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].metadata).toMatch(/"stage":"purge-orphans"/);
    expect(rows[0].status).toBe('SUCCESS');
  });
});
```

- [ ] **Step 2: Run against DEV (requires `cf login` to DEV; `CONTENT_API_KEY` must be set in the calling shell — `cds bind` does NOT inject it, only service-binding env vars)**

```bash
CONTENT_API_KEY="tutorials-content-publish-2024" \
ALLOW_HYBRID_WRITES=true \
  npx cds bind --exec -- npx vitest run test/hybrid/orphan-purge.test.js
```

Expected: three tests PASS against real HANA.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/orphan-purge.test.js
git commit -m "test(hybrid): /content/orphan-purge end-to-end against real HANA

Seeds two __TEST__ ACTIVE slugs, calls /content/orphan-purge with
CONTENT_API_KEY, asserts:
- status flips ACTIVE → INACTIVE
- /content/source-hashes excludes the purged slugs (companion-fix integration)
- PipelineLog row records the run with metadata.stage='purge-orphans'

Gated by ALLOW_HYBRID_WRITES=true; afterAll cleans up by slug prefix."
```

## Task 7: Hybrid test — source-hashes INACTIVE filter (standalone)

**Files:**
- Create: `test/hybrid/source-hashes-filters-inactive.test.js`

- [ ] **Step 1: Write the focused filter test**

```js
/**
 * Hybrid coverage for the /content/source-hashes companion fix.
 *
 * Independent of orphan-purge.test.js so a regression in the filter
 * surfaces here even when the purge endpoint test is green.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const writesAllowed = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const describeIf = writesAllowed ? describe : describe.skip;

describeIf('/content/source-hashes — INACTIVE filter (hybrid)', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slug = `__TEST__sourcehashes-inactive-${ts}`;
  let srvUrl;

  beforeAll(async () => {
    srvUrl = process.env.CAP_BASE_URL || `http://localhost:${cds.server?.address?.()?.port ?? 4004}`;
    const { Tutorials } = cds.entities(ns);
    await INSERT.into(Tutorials).entries({ slug, status: 'INACTIVE', title: '__TEST__ Inactive' });
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug });
  });

  it('does not return an INACTIVE slug from /content/source-hashes', async () => {
    const res = await fetch(`${srvUrl}/content/source-hashes`);
    expect(res.status).toBe(200);
    const map = await res.json();
    expect(map[slug]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/source-hashes-filters-inactive.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/source-hashes-filters-inactive.test.js
git commit -m "test(hybrid): /content/source-hashes excludes INACTIVE Tutorials

Independent regression test for the companion fix. Catches filter
regressions even if the orphan-purge endpoint test is green for other
reasons."
```

## Task 8: Smoke — add `/content/orphan-purge` auth-gate assertion

**Files:**
- Modify: `test/smoke/auth-enforcement.test.js`

- [ ] **Step 1: Read the existing file shape**

```bash
cat test/smoke/auth-enforcement.test.js
```

It uses `import { SRV_URL, fetchWithRetry } from './smoke.config.js'` and asserts `expect([401, 403]).toContain(res.status)`.

- [ ] **Step 2: Add a new `it()` block before the closing `});` of `describe('Auth enforcement', ...)`**

```js
  it('POST /content/orphan-purge without auth is rejected', async () => {
    const res = await fetchWithRetry(`${SRV_URL}/content/orphan-purge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slugs: [] })
    });
    expect([401, 403]).toContain(res.status);
  });
```

- [ ] **Step 3: Run smoke (after PR-1 is deployed; this step pins to the deploy gate in Task 9)**

Defer running this until after Task 9 deploys to DEV.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/auth-enforcement.test.js
git commit -m "test(smoke): /content/orphan-purge requires CONTENT_API_KEY bearer

Anti-regression for the contentAuthMiddleware gate on the new endpoint."
```

## Task 9: Deploy PR-1 to DEV + verify

- [ ] **Step 1: Open PR**

```bash
gh pr create --base main --head <branch> \
  --title "feat(orphan-purge): server endpoint + /content/source-hashes INACTIVE filter (PR 1/2)" \
  --body "Phase 1 of orphan-purge per docs/superpowers/specs/2026-06-30-orphan-purge-design.md.

  Server-side only. PR 2/2 will add the CLI + workflow.

  - GET /content/source-hashes now filters Tutorials.status='INACTIVE' (drift workflow stops re-reporting purged slugs forever; no-op until something flips a slug to INACTIVE)
  - POST /content/orphan-purge new bare-Express endpoint for batched soft-delete with PipelineLog attribution + 100-slug server ceiling
  - Same auth model as /content/publish (contentAuthMiddleware + CONTENT_API_KEY); NOT routed through AdminService because AdminService requires XSUAA Admin scope and CI doesn't carry an XSUAA bearer
  - Unit tests for the filter + endpoint; hybrid tests against real HANA; smoke 401-without-bearer

  Task 1 diagnostic result: Tutorials.status IS NULL row count = <N>."
```

- [ ] **Step 2: After merge to main, deploy DEV from the primary tree**

```bash
cd /d/projects/tutorials-poc          # primary tree, NOT a worktree (memory: feedback_always_deploy_from_main_primary_tree.md)
git checkout main && git pull
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

- [ ] **Step 3: Smoke-verify deployed endpoint**

```bash
curl -i -X POST "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/content/orphan-purge" \
  -H "Content-Type: application/json" -d '{"slugs":[]}'
```

Expected: HTTP/2 401.

Then run the smoke test from Task 8:

```bash
SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  npx vitest run test/smoke/auth-enforcement.test.js
```

- [ ] **Step 4: Wait one day, check drift workflow**

The next 04:13 UTC `content-drift-check` run should still report the same 24 missing-locally slugs. The filter is wired but inert (nothing has been flipped to INACTIVE yet). Confirms not over-filtering.

---

# PR-2 — CLI + workflow

## Task 10: Extract pure helpers into a new module

**Files:**
- Create: `scripts/lib/purge-orphans.ts`

- [ ] **Step 1: Confirm the import path style other scripts use**

```bash
grep -rE "from\s+['\"]\\./lib/" scripts/publish-content.ts | head -3
```

Confirmed convention: project uses `.js` extension for all `./lib/*` imports in `scripts/publish-content.ts` (e.g. `./lib/publish-client.js`). Use `.js` in the snippets below.

- [ ] **Step 2: Write the helper module**

```ts
/**
 * Pure helpers for the --purge-orphans mode of scripts/publish-content.ts.
 *
 * Module is import-only — no top-level side effects, no HTTP, no fs.
 * Orchestration (env reading, fetch, exit codes) lives in publish-content.ts.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode
 */

/**
 * Compute the set of orphan slugs: server has it, local doesn't.
 *
 * Set membership only — never hash equality — so a corrupted/empty local
 * hash never causes a false-positive orphan. Drift slugs go through --heal.
 */
export function computeOrphans(serverSlugs: string[], localSlugs: Set<string>): string[] {
  return serverSlugs.filter(s => !localSlugs.has(s));
}

/**
 * Enforce the absolute cap. Returns null on pass; returns an error message on fail.
 * Uses <= (at-cap passes; over-cap fails) — matches spec wording "Refuse if orphans > N".
 */
export function enforceCap(orphanCount: number, capAbs: number): string | null {
  if (orphanCount <= capAbs) return null;
  return `Orphan count ${orphanCount} exceeds cap (${orphanCount} > ${capAbs} abs). ` +
         `Investigate fetch output before raising --purge-cap-abs.`;
}

/** Build the markdown block for $GITHUB_STEP_SUMMARY. */
export function formatStepSummary(opts: {
  mode: 'dry-run' | 'committed' | 'failed';
  serverCount: number;
  orphanCount: number;
  purged?: number;
  alreadyInactive?: number;
  notFound?: number;
  redirected?: number;
  redirectedSamples?: string[];
  version?: number;
  errorMessage?: string;
}): string {
  const lines = ['### 🧹 Orphan purge — full mode', ''];
  if (opts.mode === 'dry-run') {
    lines.push(`- **Dry run** — would have purged ${opts.orphanCount} slug(s)`);
    lines.push(`- Server slugs scanned: ${opts.serverCount}`);
    return lines.join('\n');
  }
  if (opts.mode === 'failed') {
    lines.push(`- **FAILED** — ${opts.errorMessage}`);
    lines.push(`- Server slugs scanned: ${opts.serverCount}`);
    lines.push(`- Orphans detected: ${opts.orphanCount}`);
    return lines.join('\n');
  }
  lines.push(`- Server slugs scanned: ${opts.serverCount}`);
  lines.push(`- Orphans detected:     ${opts.orphanCount}`);
  lines.push(`- Soft-deleted:         ${opts.purged ?? 0}`);
  if ((opts.redirected ?? 0) > 0) {
    const samples = (opts.redirectedSamples ?? []).slice(0, 5).join(', ');
    lines.push(`- Preserved (redirect): ${opts.redirected} — ${samples}`);
  }
  if ((opts.notFound ?? 0) > 0) {
    lines.push(`- ⚠️ Not found:        ${opts.notFound} (phantom rows — operator action required)`);
  }
  lines.push(`- Manifest version:     ${opts.version ?? 'unknown'}`);
  return lines.join('\n');
}
```

- [ ] **Step 3: Commit**

```bash
git add scripts/lib/purge-orphans.ts
git commit -m "feat(publish-content): pure helpers for --purge-orphans

computeOrphans, enforceCap, formatStepSummary extracted so they can be
unit-tested without booting CDS or fetching anything. The --purge-orphans
branch (next commit) imports them."
```

## Task 11: Unit test the pure helpers

**Files:**
- Create: `test/unit/purge-orphans-cap.test.js`

- [ ] **Step 1: Write tests**

```js
/**
 * Tests for scripts/lib/purge-orphans.ts pure helpers.
 * No HTTP, no DB.
 */
import { describe, it, expect } from 'vitest';
import { computeOrphans, enforceCap, formatStepSummary } from '../../scripts/lib/purge-orphans.js';

describe('computeOrphans', () => {
  it('returns slugs in server but not in local', () => {
    expect(computeOrphans(['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['b']);
  });
  it('returns [] when local is a superset', () => {
    expect(computeOrphans(['a', 'b'], new Set(['a', 'b', 'c']))).toEqual([]);
  });
  it('returns full server set when local is empty', () => {
    expect(computeOrphans(['a', 'b'], new Set())).toEqual(['a', 'b']);
  });
  it('returns [] when server is empty', () => {
    expect(computeOrphans([], new Set(['a']))).toEqual([]);
  });
});

describe('enforceCap', () => {
  it('passes when count below cap', () => {
    expect(enforceCap(22, 50)).toBeNull();
  });
  it('passes at exactly the cap (at-cap is OK; spec "refuse > N")', () => {
    expect(enforceCap(50, 50)).toBeNull();
  });
  it('fails when count exceeds cap by one', () => {
    const msg = enforceCap(51, 50);
    expect(msg).toMatch(/exceeds cap/);
    expect(msg).toMatch(/51 > 50 abs/);
  });
  it('fails when count is very large', () => {
    expect(enforceCap(500, 50)).toMatch(/500 > 50/);
  });
  it('with capAbs=0 only zero orphans passes', () => {
    expect(enforceCap(0, 0)).toBeNull();
    expect(enforceCap(1, 0)).toMatch(/1 > 0 abs/);
  });
});

describe('formatStepSummary', () => {
  it('dry-run mode renders "would have purged" line', () => {
    const out = formatStepSummary({ mode: 'dry-run', serverCount: 1396, orphanCount: 22 });
    expect(out).toMatch(/Dry run/);
    expect(out).toMatch(/would have purged 22 slug/);
  });
  it('committed mode lists soft-deleted + redirect samples', () => {
    const out = formatStepSummary({
      mode: 'committed', serverCount: 1396, orphanCount: 24,
      purged: 21, alreadyInactive: 0, redirected: 3,
      redirectedSamples: ['btp-ea-onboard-04-subm', 'btp-ea-onboard-06-abapm'],
      version: 218
    });
    expect(out).toMatch(/Soft-deleted:\s+21/);
    expect(out).toMatch(/Preserved \(redirect\): 3 — btp-ea-onboard-04-subm/);
    expect(out).toMatch(/Manifest version:\s+218/);
  });
  it('failed mode includes error message', () => {
    const out = formatStepSummary({
      mode: 'failed', serverCount: 1396, orphanCount: 24,
      errorMessage: 'Auth failure — check CONTENT_API_KEY'
    });
    expect(out).toMatch(/FAILED/);
    expect(out).toMatch(/Auth failure/);
  });
  it('committed mode warns on notFound > 0', () => {
    const out = formatStepSummary({
      mode: 'committed', serverCount: 1, orphanCount: 1,
      purged: 0, notFound: 1, version: 218
    });
    expect(out).toMatch(/⚠️.*Not found.*1.*operator action/);
  });
});
```

- [ ] **Step 2: Run — expect PASS**

```bash
npx vitest run test/unit/purge-orphans-cap.test.js
```

- [ ] **Step 3: Commit**

```bash
git add test/unit/purge-orphans-cap.test.js
git commit -m "test(unit): pure helpers for --purge-orphans"
```

## Task 12: Write the CLI-guard + flag-mutex failing test

**Files:**
- Create: `test/unit/purge-orphans-cli-guard.test.js`

- [ ] **Step 1: Write the test**

```js
/**
 * Tests for the --purge-orphans flag's CI-only guard and mutex with
 * the other publish modes.
 */
import { describe, it, expect } from 'vitest';
import { validateFlagCombo } from '../../scripts/publish-content.ts';

describe('validateFlagCombo with --purge-orphans', () => {
  it('purgeOrphans alone is valid', () => {
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: false, purgeOrphans: true })).not.toThrow();
  });
  it('purgeOrphans + force throws', () => {
    expect(() => validateFlagCombo({ force: true, heal: false, verifyOnly: false, purgeOrphans: true }))
      .toThrow(/mutually exclusive/);
  });
  it('purgeOrphans + heal throws', () => {
    expect(() => validateFlagCombo({ force: false, heal: true, verifyOnly: false, purgeOrphans: true }))
      .toThrow(/mutually exclusive/);
  });
  it('purgeOrphans + verifyOnly throws', () => {
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: true, purgeOrphans: true }))
      .toThrow(/mutually exclusive/);
  });
});
```

- [ ] **Step 2: Run — expect FAIL (signature doesn't accept purgeOrphans yet)**

```bash
npx vitest run test/unit/purge-orphans-cli-guard.test.js
```

## Task 13: Extend `validateFlagCombo` and add `--purge-orphans` branch

**Files:**
- Modify: `scripts/publish-content.ts`

- [ ] **Step 1: Update `validateFlagCombo` (line 437)**

Replace:

```ts
export function validateFlagCombo(flags: { force: boolean; heal: boolean; verifyOnly: boolean }) {
  const modes = [flags.force && 'force', flags.heal && 'heal', flags.verifyOnly && 'verify-only'].filter(Boolean);
  if (modes.length > 1) {
    throw new Error(`Flags ${modes.join(', ')} are mutually exclusive`);
  }
}
```

With:

```ts
export function validateFlagCombo(flags: { force: boolean; heal: boolean; verifyOnly: boolean; purgeOrphans?: boolean }) {
  const modes = [
    flags.force && 'force',
    flags.heal && 'heal',
    flags.verifyOnly && 'verify-only',
    flags.purgeOrphans && 'purge-orphans'
  ].filter(Boolean);
  if (modes.length > 1) {
    throw new Error(`Flags ${modes.join(', ')} are mutually exclusive`);
  }
}
```

- [ ] **Step 2: Add `purgeOrphans` + `purgeCapAbs` to `PublishOptions` interface (lines 501-515)**

Find the `interface PublishOptions { ... }` block (or `type PublishOptions = { ... }`) and add:

```ts
  purgeOrphans: boolean;
  purgeCapAbs: number;
```

- [ ] **Step 3: Add to `parseArgs` (~line 533)**

Find the `return { ... }` at the bottom of `parseArgs`. Add to the returned object:

```ts
    purgeOrphans: has('--purge-orphans'),
    purgeCapAbs:  parseInt(get('--purge-cap-abs', process.env.PURGE_CAP_ABS ?? '50'), 10),
```

(`get` and `has` are the closures defined at the top of `parseArgs`; verify they exist — search for `function parseArgs` and read its first 20 lines.)

- [ ] **Step 4: Update the `validateFlagCombo` call site (~line 762)**

```ts
validateFlagCombo({ force: opts.force, heal: opts.heal, verifyOnly: opts.verifyOnly, purgeOrphans: opts.purgeOrphans });
```

- [ ] **Step 5: Add the `--purge-orphans` branch in `main`**

Find the closing `}` of the `if (opts.verifyOnly) { ... }` block — should be around line 715 (the `process.exit(2)` is at line 714, closing brace at 715). Insert the new branch between the closing `}` of `verifyOnly` and the next statement `log(\`Discovering tutorials in...\`)` (~line 717).

```ts
  // --- --purge-orphans short-circuit ---
  // CI-only batched soft-delete of tutorials whose source markdown is no
  // longer in any upstream repo. Spec:
  //   docs/superpowers/specs/2026-06-30-orphan-purge-design.md
  if (opts.purgeOrphans) {
    // 1. CI-only guard
    if (!process.env.GITHUB_ACTIONS) {
      console.error('purge-orphans is CI-only; run via:');
      console.error('  gh workflow run rebuild-content.yml -f mode=full -f purge-orphans=true');
      process.exit(1);
    }

    // 2. Load local hashes (same readdir as --verify-only)
    const cacheDir = opts.channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');
    let mdFiles: string[];
    try { mdFiles = readdirSync(cacheDir).filter(f => f.endsWith('.md') && !f.startsWith('_')); }
    catch (err) {
      console.error(`purge-orphans: cannot read tutorial-cache dir ${cacheDir}: ${formatErrorChain(err)}`);
      process.exit(1);
    }
    const localSlugs = new Set(mdFiles.map(f => f.replace(/\.md$/, '')));
    log(`[purge-orphans] Hashed ${localSlugs.size} local source markdown files in ${cacheDir}`);

    // 3. Fetch /content/source-hashes
    let remote: Record<string, string>;
    try { remote = await fetchRemoteSourceHashes({ baseUrl: opts.baseUrl }); }
    catch (err) {
      console.error('purge-orphans: cannot reach /content/source-hashes:', formatErrorChain(err));
      process.exit(1);
    }
    const serverSlugs = Object.keys(remote);
    log(`[purge-orphans] Fetched ${serverSlugs.length} server slugs`);

    // 4. Compute orphans
    const orphans = computeOrphans(serverSlugs, localSlugs);
    const pctInfo = serverSlugs.length ? ((orphans.length / serverSlugs.length) * 100).toFixed(1) : '0.0';
    log(`[purge-orphans] Computed ${orphans.length} orphans (${pctInfo}% of server — informational)`);

    // 5. Cap check
    const capErr = enforceCap(orphans.length, opts.purgeCapAbs);
    if (capErr) {
      console.error(`[purge-orphans] ${capErr}`);
      console.error(`[purge-orphans] First 20 orphans:`);
      for (const s of orphans.slice(0, 20)) console.error(`  - ${s}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: capErr
      }));
      process.exit(1);
    }
    log(`[purge-orphans] Cap check: ${orphans.length} <= ${opts.purgeCapAbs} abs → passes`);

    // 6. Sample
    const sample = orphans.slice(0, 10).join(', ');
    log(`[purge-orphans] Sample orphans: ${sample}${orphans.length > 10 ? ` ... (+${orphans.length - 10} more)` : ''}`);

    // 7. Dry-run short-circuit
    if (opts.dryRun) {
      log(`[purge-orphans] --dry-run: would have purged ${orphans.length} slug(s); exiting`);
      writeStepSummary(formatStepSummary({
        mode: 'dry-run', serverCount: serverSlugs.length, orphanCount: orphans.length
      }));
      process.exit(0);
    }

    // 8. POST /content/orphan-purge
    const initiator = opts.initiator;
    const purgeUrl = `${opts.baseUrl.replace(/\/$/, '')}/content/orphan-purge`;
    log(`[purge-orphans] POST ${purgeUrl} (${orphans.length} slugs, initiator=${initiator})`);

    let resp: Response;
    try {
      resp = await fetch(purgeUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.CONTENT_API_KEY ?? ''}`,
          'Content-Type':  'application/json',
          'x-initiator':   initiator
        },
        body: JSON.stringify({ slugs: orphans })
      });
    } catch (err) {
      const msg = `Connectivity error — verify CAP_BASE_URL: ${formatErrorChain(err)}`;
      console.error(`[purge-orphans] ${msg}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: msg
      }));
      process.exit(1);
    }

    // 9. Error handling
    if (!resp.ok) {
      const bodyText = await resp.text();
      let msg: string;
      if (resp.status === 401 || resp.status === 403) {
        msg = `Auth failure — check CONTENT_API_KEY secret for this environment`;
      } else if (resp.status === 400) {
        msg = `Server rejected payload — ${bodyText}`;
      } else if (resp.status >= 500) {
        msg = `Server error — retry once with same INITIATOR; endpoint is idempotent. Body: ${bodyText}`;
      } else {
        msg = `Unexpected status ${resp.status}: ${bodyText}`;
      }
      console.error(`[purge-orphans] ${msg}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: msg
      }));
      process.exit(1);
    }

    // 10. Parse + sanity check
    const result = await resp.json() as {
      purged: string[]; alreadyInactive: string[]; notFound: string[]; redirected: string[];
      totalAttempted: number; totalPurged: number; version: number;
    };
    const bucketSum = result.purged.length + result.alreadyInactive.length + result.notFound.length + result.redirected.length;
    if (bucketSum !== result.totalAttempted) {
      const msg = `Server returned malformed response: bucket sum ${bucketSum} != totalAttempted ${result.totalAttempted}`;
      console.error(`[purge-orphans] ${msg}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length, errorMessage: msg
      }));
      process.exit(1);
    }

    // 11. Print summary to stdout
    console.log(`[purge-orphans] Response:`);
    console.log(`  purged:          ${result.purged.length}`);
    console.log(`  alreadyInactive: ${result.alreadyInactive.length}`);
    console.log(`  notFound:        ${result.notFound.length}`);
    if (result.notFound.length > 0) {
      console.log(`    ⚠️  These slugs have no Tutorials parent row (phantom). Operator action required — file one issue per slug:`);
      for (const s of result.notFound) console.log(`      - ${s}`);
    }
    console.log(`  redirected:      ${result.redirected.length}${result.redirected.length ? ` (preserved: ${result.redirected.slice(0, 5).join(', ')})` : ''}`);
    console.log(`  manifest version: ${result.version}`);

    // 12. Step summary
    writeStepSummary(formatStepSummary({
      mode: 'committed',
      serverCount: serverSlugs.length,
      orphanCount: orphans.length,
      purged: result.purged.length,
      alreadyInactive: result.alreadyInactive.length,
      notFound: result.notFound.length,
      redirected: result.redirected.length,
      redirectedSamples: result.redirected,
      version: result.version
    }));

    log(`[purge-orphans] Done — ${result.purged.length} slugs soft-deleted`);
    process.exit(0);
  }
```

- [ ] **Step 6: Add imports at the top of `scripts/publish-content.ts`**

Add after the existing imports:

```ts
import { appendFileSync } from 'node:fs';
import { computeOrphans, enforceCap, formatStepSummary } from './lib/purge-orphans.js';
```

(If `readdirSync` isn't already imported, add it — `import { readdirSync, appendFileSync } from 'node:fs'`.)

- [ ] **Step 7: Add the `writeStepSummary` helper near other utility functions in the file**

```ts
/** Append a markdown block to $GITHUB_STEP_SUMMARY if set. No-op locally. */
function writeStepSummary(markdown: string) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    appendFileSync(target, markdown + '\n');
  } catch (err) {
    console.error(`[purge-orphans] Failed to append $GITHUB_STEP_SUMMARY: ${formatErrorChain(err)}`);
  }
}
```

- [ ] **Step 8: Run the failing test from Task 12 — should now PASS**

```bash
npx vitest run test/unit/purge-orphans-cli-guard.test.js
```

- [ ] **Step 9: Full unit suite**

```bash
npm test -- --run 2>&1 | grep -E "FAIL|✗|Test Files|Tests " | tail -20
```

- [ ] **Step 10: Commit**

```bash
git add scripts/publish-content.ts test/unit/purge-orphans-cli-guard.test.js
git commit -m "feat(publish-content): add --purge-orphans CI-only mode

- GITHUB_ACTIONS env-var hard-block (refuses to run from workstation)
- Mutex with --force/--heal/--verify-only
- Absolute cap (default 50, env PURGE_CAP_ABS) — refuses before HTTP
- Set-membership orphan detection (never hash equality)
- POST /content/orphan-purge with CONTENT_API_KEY bearer + x-initiator header
- Distinct error messages for 401/403/400/5xx/network
- Bucket-sum sanity check (malformed response → exit 1)
- \$GITHUB_STEP_SUMMARY block always written (committed / dry-run / failed)"
```

## Task 14: Workflow — add input, mode rejection, gated step

**Files:**
- Modify: `.github/workflows/rebuild-content.yml`

- [ ] **Step 1: Add the `purge-orphans` input under `workflow_dispatch.inputs:`**

Find the `workflow_dispatch:` block near the top of the file. Add (sibling of existing inputs like `mode`, `slug`, `slugs`):

```yaml
      purge-orphans:
        description: 'After publish, soft-delete tutorials no longer present in any upstream repo. CI-only, 50-slug safety cap (override via PURGE_CAP_ABS env).'
        required: false
        type: boolean
        default: false
```

- [ ] **Step 2: Extend the `Determine effective rebuild mode` step (id: mode, line ~123)**

In its `env:` block, add:

```yaml
          INPUT_PURGE_ORPHANS: ${{ inputs.purge-orphans }}
```

In its `run:` block, replace the existing body with:

```bash
          EFFECTIVE="$INPUT_MODE"
          REASON="explicit (inputs.mode=$INPUT_MODE)"

          if [ "$EVENT" = "workflow_dispatch" ] \
             && [ "$INPUT_MODE" = "full" ] \
             && { [ -n "$INPUT_SLUG" ] || [ -n "$INPUT_SLUGS" ]; }; then
            EFFECTIVE='slug-targeted'
            REASON='auto-inferred (slug/slugs set, mode left at default)'
          fi

          # Issue #orphan-purge — reject purge-orphans=true with anything other
          # than effective_mode=full. slug-targeted/catalog-only deliberately
          # don't fetch the whole catalog, so 1392+ slugs would falsely appear
          # as orphans. Fail loud (operator clearly intended the purge).
          if [ "${INPUT_PURGE_ORPHANS:-false}" = "true" ] && [ "$EFFECTIVE" != "full" ]; then
            echo "::error title=purge-orphans requires mode=full::Got effective_mode=$EFFECTIVE. Re-run with -f mode=full -f purge-orphans=true."
            exit 1
          fi

          echo "effective_mode=$EFFECTIVE" >> "$GITHUB_OUTPUT"
          echo "effective_reason=$REASON" >> "$GITHUB_OUTPUT"
          echo "::notice title=Rebuild mode::$EFFECTIVE ($REASON)"
```

- [ ] **Step 3: Add `id: publish` to the existing "Publish tutorial content to HANA" step (line ~300)**

Find:

```yaml
      - name: Publish tutorial content to HANA
        # Concurrency / batch-size are tunable...
```

Change to:

```yaml
      - name: Publish tutorial content to HANA
        id: publish
        # Concurrency / batch-size are tunable...
```

- [ ] **Step 4: Add the new "Purge orphan tutorials" step (right after Publish's env block ~line 340)**

```yaml
      - name: Purge orphan tutorials
        id: purge
        if: |
          inputs.purge-orphans == true &&
          steps.mode.outputs.effective_mode == 'full' &&
          steps.publish.outcome == 'success'
        env:
          CAP_BASE_URL:    ${{ steps.srv.outputs.srv_url }}
          CONTENT_API_KEY: ${{ secrets.CONTENT_API_KEY }}
          PURGE_CAP_ABS:   '50'
          INITIATOR:       "ci/${{ github.run_id }}"
        run: npx tsx scripts/publish-content.ts --purge-orphans
```

- [ ] **Step 5: Lint YAML locally**

```bash
npx js-yaml .github/workflows/rebuild-content.yml > /dev/null && echo "YAML valid"
```

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/rebuild-content.yml
git commit -m "ci(rebuild-content): add purge-orphans input + gated step

- New workflow_dispatch input \`purge-orphans\` (default false)
- Mode-determine step rejects purge-orphans=true with anything other
  than effective_mode=full, via ::error annotation
- Existing 'Publish tutorial content to HANA' step gains id: publish so
  the new step can gate on steps.publish.outcome == 'success'
- New 'Purge orphan tutorials' step runs ONLY when the three-conjunct
  if: holds (input + mode + publish-succeeded). Clean skip on mode
  mismatch, not a failed run."
```

## Task 15: Operator docs

**Files:**
- Modify: `docs/developers/operations/rebuild-content-workflow.md`

- [ ] **Step 1: Append the new section**

Near the end of the file (after existing mode-selection content):

```markdown
## When to run `purge-orphans`

The `purge-orphans=true` workflow input batches the soft-delete operation the admin Tutorials Fiori app performs one-at-a-time. It targets tutorials whose source markdown is no longer present in any upstream repo — the daily [content-drift workflow](../../../.github/workflows/content-drift-check.yml) surfaces these as "missing locally" slugs.

### When to use it

- The drift report consistently shows ≥20 missing-locally slugs.
- You've inspected the list (artifact `content-drift-<env>-<run_number>`) and confirmed they are genuinely orphaned, not the result of a fetch regression.
- You want a one-shot cleanup rather than 20+ clicks in the admin Tutorials app.

### When NOT to use it

- `fetch-tutorials` recently changed — verify the discovery output first.
- The drift count jumped overnight — that's a fetch problem, not real orphans. Fix the fetch first.
- You're trying to "unpublish" a single tutorial — use the admin Tutorials app at `/admin-ui/#tutorials-display`.

### How

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full -f purge-orphans=true
```

The workflow:
1. Runs `full`-mode fetch + publish first (the cache is what defines "orphan").
2. Then the gated `Purge orphan tutorials` step runs `publish-content.ts --purge-orphans`.
3. Result lands in `$GITHUB_STEP_SUMMARY` ("🧹 Orphan purge — full mode" block).

### Safety caps

- **Client:** 50 absolute orphans. If exceeded, the step fails before any HTTP traffic. Override via `PURGE_CAP_ABS` env in the workflow file.
- **Server:** 100-slug ceiling. Server returns 400 if the client cap was loosened past this point. Split into multiple calls (or file a separate change to raise the server ceiling).

### Auth

The CLI sends `Authorization: Bearer $CONTENT_API_KEY` — same secret as `/content/publish`. The endpoint is `POST /content/orphan-purge` (bare-Express + contentAuthMiddleware), NOT a CAP AdminService action.

### Rollback

See the [orphan-purge design § Rollback](../../superpowers/specs/2026-06-30-orphan-purge-design.md#rollback) — uses change-tracking + PipelineLog to enumerate which rows flipped.
```

- [ ] **Step 2: Commit**

```bash
git add docs/developers/operations/rebuild-content-workflow.md
git commit -m "docs(operations): add 'When to run purge-orphans' section"
```

## Task 16: Deploy PR-2 + verify against DEV

- [ ] **Step 1: Open PR**

```bash
gh pr create --base main --head <branch> \
  --title "feat(orphan-purge): CLI + workflow input (PR 2/2)" \
  --body "Phase 2 of orphan-purge per docs/superpowers/specs/2026-06-30-orphan-purge-design.md.

  Requires PR 1/2 (server-side) merged + deployed first.

  - scripts/publish-content.ts gains --purge-orphans mode (CI-only via GITHUB_ACTIONS env hard-block; 50-slug client cap; POST /content/orphan-purge)
  - scripts/lib/purge-orphans.ts new pure helpers
  - .github/workflows/rebuild-content.yml new \`purge-orphans\` input; mode-determine step rejects slug-targeted + purge-orphans=true with ::error; new gated 'Purge orphan tutorials' step
  - Unit tests for pure helpers + CLI guard + mutex
  - id: publish added to the existing 'Publish tutorial content to HANA' step so the new step can gate on steps.publish.outcome=='success'"
```

- [ ] **Step 2: After merge + DEV deploy, dispatch the workflow**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full -f purge-orphans=true
```

- [ ] **Step 3: Verify the run summary**

The run's `Purge orphan tutorials` step should land a `🧹 Orphan purge — full mode` block in `$GITHUB_STEP_SUMMARY` (~21 purged, depending on current drift state).

- [ ] **Step 4: Verify DB reflects the purge**

```bash
curl -s "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/content/source-hashes" | \
  node -e "const m=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('server slug count:',Object.keys(m).length);"
```

Expected: count drops from ~1396 to ~1375.

- [ ] **Step 5: Re-run drift workflow**

```bash
gh workflow run content-drift-check.yml --repo sap-tutorials/tutorials-ims -f environment=dev
```

Expected: "missing locally" count drops from 24 to ≤3.

- [ ] **Step 6: Reject-on-misconfig sanity check**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full -f slugs=appgyver-fetch-data -f purge-orphans=true
```

Expected: mode-determine step emits `::error title=purge-orphans requires mode=full` and exits 1 before any work runs.

---

## Phase 3 — PROD rollout (no code)

After ≥24 h of DEV soak:

- [ ] **Step 1: Refresh drift report against PROD**

```bash
gh workflow run content-drift-check.yml --repo sap-tutorials/tutorials-ims -f environment=prod
```

Confirm count is within `24 ± 5`. If wildly different, **STOP** and investigate.

- [ ] **Step 2: Dispatch against PROD**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f environment=prod -f mode=full -f purge-orphans=true
```

- [ ] **Step 3: Confirm via source-hashes count + next drift run**

Same checks as Task 16 Steps 4-5 but against PROD srv URL.

---

## Risks during execution

| Risk | Mitigation |
|---|---|
| Hybrid test floods DEV DB with `__TEST__` rows if `afterAll` fails | `afterAll` runs on test failure too per Vitest contract; manual cleanup is `DELETE FROM com_sap_developers_ims_tutorials WHERE slug LIKE '__TEST__purge-orphan-%'` |
| `scripts/lib/purge-orphans.ts` import path style mismatch | Task 10 Step 1 grep confirms project convention before writing |
| Workflow YAML indentation regression | Task 14 Step 5 local lint |
| PR-1 deploys but PR-2 doesn't | Acceptable — filter is no-op until something flips a slug to INACTIVE |
| PR-2 deploys but PR-1 didn't | CI's POST gets 404 → CLI's error-handling step reports `Unexpected status 404` and exits 1 |
| AdminService 401 from older spec wording | Resolved by routing through bare-Express `/content/orphan-purge` instead of `/admin/orphanPurge` — same auth model as `/content/publish` |
