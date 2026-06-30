# Orphan-Purge Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a CI-only `--purge-orphans` mode to `scripts/publish-content.ts` that soft-deletes tutorials whose source markdown no longer exists in any upstream repo. Backed by a new `AdminService.orphanPurge` action and a `purge-orphans` workflow input on `rebuild-content.yml`.

**Architecture:** Three changes in two PRs.
- **PR-1 (server + companion fix):** filter `Tutorials.status='INACTIVE'` out of `GET /content/source-hashes`; add `AdminService.orphanPurge` action with soft-delete batching + `logPipeline` attribution; unit + hybrid tests.
- **PR-2 (CLI + workflow):** `--purge-orphans` flag on `publish-content.ts` with 50-slug absolute cap and CI-only `GITHUB_ACTIONS` hard-block; `purge-orphans` boolean input on `rebuild-content.yml` gated on `effective_mode=='full' && publish.outcome=='success'`; mode-determine step rejects `slug-targeted + purge-orphans=true` combo.

**Tech Stack:** Node.js (CAP), TypeScript (CLI script), CDS / SQL, GitHub Actions YAML, Vitest.

**Spec:** [docs/superpowers/specs/2026-06-30-orphan-purge-design.md](../specs/2026-06-30-orphan-purge-design.md)

---

## File Structure

### PR-1: Server + companion fix (own PR, deploys first)

| File | Action | Responsibility |
|---|---|---|
| `srv/lib/content-store.js` | Modify around line 1107 (`sourceHashesHandler`) | Add LEFT JOIN to `Tutorials` and `WHERE status != 'INACTIVE'` filter (with optional `OR status IS NULL` gate decided by Task 1). |
| `srv/admin-service.cds` | Modify near line 392 (`cleanupUnusedTags` declaration) | Declare `orphanPurge` action signature: input `slugs: array of String`, returns the four-bucket response. |
| `srv/admin-service.js` | Modify near line 1074 (`cleanupUnusedTags` handler) | Implement `this.on('orphanPurge', ...)` handler — wrap in `logPipeline('SCHEDULED_JOB', ...)` with `metadata.stage='purge-orphans'`; per-slug bucket dispatch; 100-slug server cap. |
| `scripts/check-null-status-rows.cjs` | Create | One-shot pre-deploy script run via `cds bind --exec` to count `Tutorials.status IS NULL` against DEV + PROD, decide whether the filter needs `OR status IS NULL` or whether a migration UPDATE seeds them to `'ACTIVE'`. |
| `test/unit/source-hashes-filter.test.js` | Create | Verifies `sourceHashesHandler` excludes INACTIVE rows. Pure CDS in-memory. |
| `test/unit/orphan-purge-endpoint.test.js` | Create | Seeds ACTIVE + INACTIVE + redirectTo-set + missing-row scenarios; asserts four bucket arrays. |
| `test/hybrid/orphan-purge.test.js` | Create | E2E against HANA; seeds `__TEST__purge-orphan-*` rows; asserts status flip + source-hashes exclusion + catalog exclusion; cleans up in `afterAll`. |
| `test/hybrid/source-hashes-filters-inactive.test.js` | Create | Hybrid companion-fix coverage; one seeded INACTIVE row + assert source-hashes excludes it. |
| `test/smoke/admin-auth.test.js` | Modify | Add `/admin/orphanPurge` 401-without-bearer assertion. |

### PR-2: CLI + workflow (separate PR, after PR-1 in DEV)

| File | Action | Responsibility |
|---|---|---|
| `scripts/publish-content.ts` | Modify `validateFlagCombo` (line 437) + add new mode branch in `main` (after the `--verify-only` short-circuit ~line 618) | New `--purge-orphans` flag; CI-only guard; absolute cap; POST `/admin/orphanPurge`; error-handling + step summary writer. |
| `scripts/lib/purge-orphans.ts` | Create | Pure helpers extracted from `publish-content.ts` for testability: `computeOrphans`, `enforceCap`, `formatStepSummary`. |
| `.github/workflows/rebuild-content.yml` | Modify | Add `purge-orphans` boolean input; add `id: publish` to existing "Publish tutorial content to HANA" step (line 300); extend mode-determine step to reject `slug-targeted + purge-orphans=true`; add new "Purge orphan tutorials" step. |
| `test/unit/purge-orphans-cap.test.js` | Create | Pure-math tests for absolute cap. |
| `test/unit/purge-orphans-cli-guard.test.js` | Create | `GITHUB_ACTIONS` guard + mutex with `--force`/`--heal`/`--verify-only`. |
| `docs/developers/operations/rebuild-content-workflow.md` | Modify | New "When to run purge-orphans" subsection with command + caveats. |

---

# PR-1 — Server + companion fix

## Task 1: Pre-deploy NULL-status row check (decision gate)

**Why first:** Tasks 2-3 both depend on whether the source-hashes filter needs the `OR status IS NULL` clause. Per spec §1 "Pre-deploy data check," this is a data fact we have to look up, not assume.

**Files:**
- Create: `scripts/check-null-status-rows.cjs`

- [ ] **Step 1: Write the script**

```js
#!/usr/bin/env node
// One-shot diagnostic — run via `cds bind --exec -- node scripts/check-null-status-rows.cjs`
// against DEV and PROD. Prints the count of Tutorials rows with status IS NULL.
// Used by the orphan-purge plan (PR-1 Task 1) to decide whether the new
// /content/source-hashes filter needs an `OR status IS NULL` defensive clause.

const cds = require('@sap/cds');

(async () => {
  await cds.connect.to('db');
  const db = await cds.connect.to('db');
  const result = await db.run(
    `SELECT COUNT(*) AS NULL_COUNT FROM com_sap_developers_ims_tutorials WHERE STATUS IS NULL`
  );
  const count = result[0]?.NULL_COUNT ?? result[0]?.null_count ?? 0;
  console.log(`Tutorials with status IS NULL: ${count}`);
  if (count > 0) {
    console.log(`\n→ Filter MUST include 'OR status IS NULL', OR you must run:`);
    console.log(`  UPDATE com_sap_developers_ims_tutorials SET status='ACTIVE' WHERE status IS NULL;`);
    console.log(`  (then re-run this script to confirm count=0)`);
  } else {
    console.log(`→ Filter ships as plain WHERE status != 'INACTIVE' (no OR-NULL clause needed)`);
  }
  process.exit(0);
})().catch((err) => {
  console.error('Check failed:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: Run against DEV (requires `cf login` to DEV space)**

```bash
cd d:/projects/tutorials-poc
npx cds bind --exec -- node scripts/check-null-status-rows.cjs
```

Expected: prints either "count = 0 → no OR-NULL clause" OR "count > 0 → must include OR-NULL".

- [ ] **Step 3: Run against PROD via `cf target -s prod` (if Phase 3 prep started early)**

If PROD access isn't available yet, defer the PROD check to Phase 3 and assume DEV is representative; document the assumption in the PR description.

- [ ] **Step 4: Record the decision**

In this plan file, add a line at the top of Task 2 stating "NULL-row count = N; clause [include / omit]." This is the decision input for Task 2.

- [ ] **Step 5: If count > 0, run the seeding UPDATE**

```sql
UPDATE com_sap_developers_ims_tutorials SET status='ACTIVE' WHERE status IS NULL;
```

Via `npx cds bind --exec -- node -e "(async()=>{const cds=require('@sap/cds');await cds.connect.to('db');const db=await cds.connect.to('db');await db.run(\"UPDATE com_sap_developers_ims_tutorials SET status='ACTIVE' WHERE status IS NULL\");console.log('done');})()"` — or hand-execute via hana-cli.

Then re-run Step 2; expected output: count=0.

- [ ] **Step 6: Commit (only the script — diagnostic stays in repo)**

```bash
git add scripts/check-null-status-rows.cjs
git commit -m "scripts: add NULL-status row check for orphan-purge plan

Pre-deploy diagnostic used by docs/superpowers/plans/2026-06-30-orphan-purge.md
Task 1 to decide whether the new /content/source-hashes filter needs a
defensive OR-NULL clause. One-shot; safe to keep in repo for future audits."
```

## Task 2: Source-hashes filter — write the failing test

**Files:**
- Create: `test/unit/source-hashes-filter.test.js`

- [ ] **Step 1: Write the test**

```js
/**
 * Verifies GET /content/source-hashes excludes Tutorials.status='INACTIVE'
 * rows from the returned map. Pre-existing behavior keeps INACTIVE rows
 * in carry-forward (snapshot integrity); this filter only affects the
 * external-facing source-hashes endpoint so drift workflow stops
 * re-reporting purged slugs forever.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-1
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

cds.test('serve', '--project', '.', '--in-memory');

describe('GET /content/source-hashes — INACTIVE filter', () => {
  let db;
  const namespace = 'com.sap.developers.ims';
  const testManifestVersion = 99999;
  const activeSlug = 'test-active-' + Date.now();
  const inactiveSlug = 'test-inactive-' + Date.now();

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { ContentFiles, ContentManifest, Tutorials } = cds.entities(namespace);

    // Seed a fresh ACTIVE manifest with two files. Mark any pre-existing
    // ACTIVE manifest as SUPERSEDED to keep this isolated.
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
    const res = await fetch(`http://localhost:${cds.test.server.address().port}/content/source-hashes`);
    expect(res.status).toBe(200);
    const map = await res.json();
    expect(map[activeSlug]).toBe('aaa');
  });

  it('excludes INACTIVE-status slug from the response map', async () => {
    const res = await fetch(`http://localhost:${cds.test.server.address().port}/content/source-hashes`);
    expect(res.status).toBe(200);
    const map = await res.json();
    expect(map[inactiveSlug]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

```bash
npx vitest run test/unit/source-hashes-filter.test.js
```

Expected: the second test (`excludes INACTIVE-status slug`) FAILS — currently `sourceHashesHandler` does NOT filter by `Tutorials.status`, so `inactiveSlug` will be present in the map.

## Task 3: Source-hashes filter — implement

**Files:**
- Modify: `srv/lib/content-store.js` around line 1107 (`sourceHashesHandler`)

- [ ] **Step 1: Read the current handler**

Read `srv/lib/content-store.js` lines 1107-1135 to confirm the current SELECT shape.

- [ ] **Step 2: Replace the SELECT with a Tutorials-aware filter**

Replace:

```js
const rows = await SELECT.from(ContentFiles)
  .where({ version: activeVersion })
  .columns('slug', 'sourceHash');
```

With (assuming Task 1 found NULL count = 0; if count > 0 was unresolvable, use the `OR-NULL` variant in the alternate code block at the end of this step):

```js
// Issue #orphan-purge — exclude soft-deleted tutorials from the public
// source-hashes map so the daily drift workflow stops re-reporting purged
// slugs forever. Carry-forward keeps INACTIVE rows in the manifest for
// snapshot integrity; this filter only affects external-facing endpoints.
// See docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-1.
//
// LOWER() on both sides because Tutorials.slug may be mixed-case in legacy
// rows even though new slugs are lowercase canonical (CLAUDE.md > Tutorial
// slugs are lowercase canonical).
const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
const rows = isHana
  ? await db.run(
      `SELECT cf."SLUG" AS "slug", cf."SOURCEHASH" AS "sourceHash"
         FROM "com_sap_developers_ims_contentfiles" AS cf
         LEFT JOIN "com_sap_developers_ims_tutorials" AS t
           ON LOWER(cf."SLUG") = LOWER(t."SLUG")
        WHERE cf."VERSION" = ?
          AND (t."STATUS" IS NULL OR t."STATUS" != 'INACTIVE')`,
      [activeVersion]
    )
  : await cds.ql`
      SELECT cf.slug AS slug, cf.sourceHash AS sourceHash
        FROM ${ContentFiles} AS cf
        LEFT JOIN ${cds.entities(namespace).Tutorials} AS t
          ON LOWER(cf.slug) = LOWER(t.slug)
       WHERE cf.version = ${activeVersion}
         AND (t.status IS NULL OR t.status != 'INACTIVE')`;
```

Note: the `OR status IS NULL` clause matches the existing serve handler's NULL-tolerant behavior ([content-store.js:978](../../../srv/lib/content-store.js#L978)). Even if Task 1 found NULL count = 0 today, keeping the OR-NULL preserves the invariant cheaply and matches the spec's "must match the serve handler's NULL semantics on whichever data state lands in the DB."

The `db` connection is already in scope inside the handler (used by other functions in this file). If not, add `const db = await cds.connect.to('db');` at the top of `sourceHashesHandler`.

- [ ] **Step 3: Re-fetch the connection if it's not already in scope**

Confirm `db` is accessible inside `sourceHashesHandler`. If not (open the file and check), add `const db = await cds.connect.to('db');` at the top of the function body.

- [ ] **Step 4: Run the failing test from Task 2 — it should now pass**

```bash
npx vitest run test/unit/source-hashes-filter.test.js
```

Expected: both tests PASS.

- [ ] **Step 5: Run the full unit suite to confirm no regression**

```bash
npm test -- --run 2>&1 | tail -50
```

Expected: all previously-passing tests still pass; new tests pass.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/content-store.js test/unit/source-hashes-filter.test.js
git commit -m "feat(content-store): exclude INACTIVE tutorials from /content/source-hashes

Adds a LEFT JOIN to Tutorials with WHERE (status IS NULL OR status != 'INACTIVE')
so the daily content-drift workflow stops re-reporting soft-deleted slugs as
'missing locally' forever. The carry-forward path keeps INACTIVE rows in the
manifest for snapshot integrity — this filter only affects the external-facing
endpoint, matching how the serve handler treats INACTIVE rows.

OR-NULL clause preserves the existing serve-handler invariant (content-store.js:978)
that NULL-status legacy rows are treated as not-INACTIVE.

Companion to the orphan-purge endpoint (next commit). Spec:
docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-1."
```

## Task 4: AdminService.orphanPurge — write the failing test

**Files:**
- Create: `test/unit/orphan-purge-endpoint.test.js`

- [ ] **Step 1: Write the test**

```js
/**
 * Unit tests for AdminService.orphanPurge.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-2
 *
 * Per-slug bucket dispatch:
 *   - slug in Tutorials with status=ACTIVE  → purged[]
 *   - slug in Tutorials with status=INACTIVE → alreadyInactive[]
 *   - slug in Tutorials with redirectTo set  → redirected[]
 *   - slug NOT in Tutorials                   → notFound[]
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';

const { POST } = cds.test('serve', '--project', '.', '--in-memory');

describe('AdminService.orphanPurge', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slugActive    = `test-purge-active-${ts}`;
  const slugInactive  = `test-purge-inactive-${ts}`;
  const slugRedirect  = `test-purge-redirect-${ts}`;
  const slugMissing   = `test-purge-missing-${ts}`;     // not in Tutorials
  const slugActive2   = `test-purge-active2-${ts}`;

  beforeAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await INSERT.into(Tutorials).entries([
      { slug: slugActive,    status: 'ACTIVE',   title: 'Active 1' },
      { slug: slugActive2,   status: 'ACTIVE',   title: 'Active 2' },
      { slug: slugInactive,  status: 'INACTIVE', title: 'Inactive' },
      { slug: slugRedirect,  status: 'ACTIVE',   title: 'With redirect', redirectTo: 'somewhere-else' },
    ]);
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug: { in: [slugActive, slugActive2, slugInactive, slugRedirect] } });
  });

  it('buckets slugs by per-slug behavior', async () => {
    const res = await POST(
      '/odata/v4/admin/orphanPurge',
      { slugs: [slugActive, slugActive2, slugInactive, slugRedirect, slugMissing] },
      { headers: { 'x-initiator': 'test/unit-1' } }
    );
    expect(res.status).toBe(200);
    const body = res.data;
    expect(body.purged.sort()).toEqual([slugActive, slugActive2].sort());
    expect(body.alreadyInactive).toEqual([slugInactive]);
    expect(body.redirected).toEqual([slugRedirect]);
    expect(body.notFound).toEqual([slugMissing]);
    expect(body.totalAttempted).toBe(5);
    expect(body.totalPurged).toBe(2);
    expect(typeof body.version).toBe('number');
  });

  it('flips Tutorials.status to INACTIVE for purged slugs', async () => {
    const { Tutorials } = cds.entities(ns);
    const rows = await SELECT.from(Tutorials).where({ slug: { in: [slugActive, slugActive2] } }).columns('slug', 'status');
    expect(rows.every(r => r.status === 'INACTIVE')).toBe(true);
  });

  it('rejects > 100 slugs with 400', async () => {
    const tooMany = Array.from({ length: 101 }, (_, i) => `test-purge-bulk-${ts}-${i}`);
    const res = await POST(
      '/odata/v4/admin/orphanPurge',
      { slugs: tooMany },
      { headers: { 'x-initiator': 'test/unit-2' }, validateStatus: () => true }
    );
    expect(res.status).toBe(400);
    expect(String(res.data.error?.message || res.data)).toMatch(/100-slug ceiling/i);
  });

  it('is idempotent — re-running yields all alreadyInactive', async () => {
    const res = await POST(
      '/odata/v4/admin/orphanPurge',
      { slugs: [slugActive, slugActive2] },
      { headers: { 'x-initiator': 'test/unit-3' } }
    );
    expect(res.status).toBe(200);
    expect(res.data.alreadyInactive.sort()).toEqual([slugActive, slugActive2].sort());
    expect(res.data.purged).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
npx vitest run test/unit/orphan-purge-endpoint.test.js
```

Expected: FAIL with "action 'orphanPurge' not defined" or similar 404.

## Task 5: AdminService.orphanPurge — declare action

**Files:**
- Modify: `srv/admin-service.cds` near line 392

- [ ] **Step 1: Declare the action**

After line 392 (`action cleanupUnusedTags();`), add:

```cds
  // Issue #orphan-purge — CI-only batched soft-delete of tutorials whose
  // source markdown is no longer present in any upstream repo. Spec:
  // docs/superpowers/specs/2026-06-30-orphan-purge-design.md
  //
  // Called by scripts/publish-content.ts --purge-orphans (CI-only via
  // GITHUB_ACTIONS env hard-block). Server enforces a 100-slug ceiling
  // as defense in depth against a client that loosens its own cap.
  action orphanPurge(
    slugs : array of String
  ) returns {
    purged          : array of String;
    alreadyInactive : array of String;
    notFound        : array of String;
    redirected      : array of String;
    totalAttempted  : Integer;
    totalPurged     : Integer;
    version         : Integer;
  };
```

- [ ] **Step 2: Re-run the test (still expected to fail)**

```bash
npx vitest run test/unit/orphan-purge-endpoint.test.js
```

Expected: still fails — action is declared but no handler.

## Task 6: AdminService.orphanPurge — implement handler

**Files:**
- Modify: `srv/admin-service.js` near line 1083 (after `cleanupUnusedTags` handler closes)

- [ ] **Step 1: Add import at top of file (if `logPipeline` not already imported)**

Check the top of `srv/admin-service.js`. If `logPipeline` isn't imported, add:

```js
import { logPipeline } from './lib/pipeline-log.js';
```

(Match existing import style — CommonJS `require` vs ESM `import`.)

- [ ] **Step 2: Add the handler after `cleanupUnusedTags` (after line 1083)**

```js
    this.on('orphanPurge', async (req) => {
      const { Tutorials, ContentManifest } = cds.entities('com.sap.developers.ims');
      const slugs = Array.isArray(req.data.slugs) ? req.data.slugs : [];

      // Server-side cap (defense in depth) — client should already have refused at 50.
      if (slugs.length > 100) {
        return req.error(400, 'batch too large; orphan purge enforces a 100-slug ceiling per call');
      }
      if (slugs.length === 0) {
        return { purged: [], alreadyInactive: [], notFound: [], redirected: [], totalAttempted: 0, totalPurged: 0, version: 0 };
      }

      // Initiator from x-initiator header; falls back to req.user.id for symmetry
      // with how /content/publish records initiator on ContentManifest.initiator.
      const initiator = req.req?.headers?.['x-initiator'] || req.user?.id || 'system';
      const runId = initiator.startsWith('ci/') ? initiator.slice(3) : null;

      return await logPipeline(
        'SCHEDULED_JOB',
        initiator,
        async () => {
          // Bucket dispatch — fetch in one round trip so we can classify before any writes.
          const lowered = slugs.map(s => String(s).toLowerCase());
          const rows = await SELECT.from(Tutorials)
            .where({ slug: { in: lowered } })
            .columns('ID', 'slug', 'status', 'redirectTo');

          const bySlug = new Map(rows.map(r => [String(r.slug).toLowerCase(), r]));
          const purged = [], alreadyInactive = [], notFound = [], redirected = [];

          for (const original of slugs) {
            const key = String(original).toLowerCase();
            const row = bySlug.get(key);
            if (!row) { notFound.push(original); continue; }
            if (row.redirectTo) { redirected.push(original); continue; }
            if (row.status === 'INACTIVE') { alreadyInactive.push(original); continue; }
            // Soft-delete — change-tracking on Tutorials records the status flip via
            // @cap-js/change-tracking (db/change-tracking.cds:37). entity column on
            // the Changes row will be 'AdminService.Tutorials' (the projection name).
            await UPDATE(Tutorials).set({ status: 'INACTIVE' }).where({ ID: row.ID });
            purged.push(original);
          }

          // Read current ACTIVE manifest version — not bumped by purge, just reported
          // so the operator knows which publish state the purge ran against.
          const [activeManifest] = await SELECT.from(ContentManifest)
            .where({ status: 'ACTIVE' })
            .columns('version')
            .orderBy({ version: 'desc' })
            .limit(1);
          const version = activeManifest?.version ?? 0;

          return {
            purged,
            alreadyInactive,
            notFound,
            redirected,
            totalAttempted: slugs.length,
            totalPurged: purged.length,
            version
          };
        },
        { stage: 'purge-orphans', slugCount: slugs.length, runId }
      );
    });
```

- [ ] **Step 3: Run the test from Task 4**

```bash
npx vitest run test/unit/orphan-purge-endpoint.test.js
```

Expected: ALL tests PASS (buckets, status flip, 400 over-100, idempotent).

- [ ] **Step 4: Run the full unit suite — confirm no regression**

```bash
npm test -- --run 2>&1 | tail -50
```

Expected: all previously-passing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/orphan-purge-endpoint.test.js
git commit -m "feat(admin): add AdminService.orphanPurge for batched soft-delete

POST /admin/orphanPurge accepts an array of slugs and dispatches them into
four buckets:
- purged          — Tutorials.status flipped ACTIVE → INACTIVE
- alreadyInactive — idempotent re-run, no DB write
- redirected      — admin set up redirectTo deliberately, honored
- notFound        — slug has no Tutorials parent row (phantom; operator action)

Wraps work in logPipeline('SCHEDULED_JOB', ...) with metadata.stage='purge-orphans'
so per-run attribution is queryable via PipelineLog without inventing a new
pipelineType enum value. The 'stage' discriminator lives in metadata because
SCHEDULED_JOB also covers cron jobs.

Server-side 100-slug ceiling as defense in depth; client refuses at 50.

Change-tracking on Tutorials.status flip is automatic via @cap-js/change-tracking
(db/change-tracking.cds:37); the Changes row gets entity='AdminService.Tutorials'.

Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-2"
```

## Task 7: Hybrid test — orphan-purge end-to-end against HANA

**Files:**
- Create: `test/hybrid/orphan-purge.test.js`

- [ ] **Step 1: Write the hybrid test**

```js
/**
 * Hybrid test — exercises AdminService.orphanPurge against real HANA.
 * Gated by ALLOW_HYBRID_WRITES=true per test/hybrid/_guard.js.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Testing
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import { isSafeForWrites } from './_guard.js';

const writesAllowed = process.env.ALLOW_HYBRID_WRITES === 'true' && isSafeForWrites();
const describeIf = writesAllowed ? describe : describe.skip;

describeIf('AdminService.orphanPurge — hybrid (real HANA)', () => {
  const ns = 'com.sap.developers.ims';
  const ts = Date.now();
  const slugA = `__TEST__purge-orphan-a-${ts}`;
  const slugB = `__TEST__purge-orphan-b-${ts}`;
  let server, port;

  beforeAll(async () => {
    server = await cds.test.run({ project: '.' });
    port = server.address().port;
    const db = await cds.connect.to('db');
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
    const adminBearer = process.env.ADMIN_BEARER_TOKEN;
    if (!adminBearer) throw new Error('ADMIN_BEARER_TOKEN env var required for hybrid admin test');

    const res = await fetch(`http://localhost:${port}/odata/v4/admin/orphanPurge`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${adminBearer}`,
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
    const res = await fetch(`http://localhost:${port}/content/source-hashes`);
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

- [ ] **Step 2: Run the hybrid test (requires `cf login` to DEV space)**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/orphan-purge.test.js
```

Expected: all three tests PASS against real HANA.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/orphan-purge.test.js
git commit -m "test(hybrid): orphan-purge end-to-end against real HANA

Seeds two __TEST__ slugs, calls /odata/v4/admin/orphanPurge, asserts:
- status flips ACTIVE → INACTIVE
- /content/source-hashes excludes the purged slugs (companion-fix integration)
- PipelineLog row records the run with metadata.stage='purge-orphans'

Gated by ALLOW_HYBRID_WRITES=true; cleans up in afterAll. Spec:
docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Testing-hybrid"
```

## Task 8: Hybrid test — source-hashes INACTIVE filter

**Files:**
- Create: `test/hybrid/source-hashes-filters-inactive.test.js`

- [ ] **Step 1: Write the focused filter test**

```js
/**
 * Hybrid coverage for the /content/source-hashes companion fix.
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Architecture-1
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
  let server, port;

  beforeAll(async () => {
    server = await cds.test.run({ project: '.' });
    port = server.address().port;
    const { Tutorials } = cds.entities(ns);
    await INSERT.into(Tutorials).entries({ slug, status: 'INACTIVE', title: '__TEST__ Inactive' });
    // Note: we don't seed a ContentFiles row — the filter operates on the
    // Tutorials JOIN side. Verifying absence in the returned map is the
    // contract we care about.
  });

  afterAll(async () => {
    const { Tutorials } = cds.entities(ns);
    await DELETE.from(Tutorials).where({ slug });
  });

  it('does not return an INACTIVE slug from /content/source-hashes', async () => {
    const res = await fetch(`http://localhost:${port}/content/source-hashes`);
    expect(res.status).toBe(200);
    const map = await res.json();
    expect(map[slug]).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test**

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run test/hybrid/source-hashes-filters-inactive.test.js
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/source-hashes-filters-inactive.test.js
git commit -m "test(hybrid): /content/source-hashes excludes INACTIVE Tutorials

Independent regression test for the companion fix shipped with the
orphan-purge endpoint. Catches a regression in the source-hashes filter
even if the orphan-purge endpoint test is green for other reasons.

Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Testing-hybrid"
```

## Task 9: Smoke test — admin auth gate on orphanPurge

**Files:**
- Modify: `test/smoke/admin-auth.test.js` (or whichever existing file covers admin auth — `grep -l "401" test/smoke/*.test.js`)

- [ ] **Step 1: Find the existing admin-auth smoke file**

```bash
grep -lE "(/admin/|admin.auth|401)" test/smoke/*.test.js
```

- [ ] **Step 2: Add a new `it()` block in the appropriate file**

```js
it('POST /odata/v4/admin/orphanPurge returns 401 without bearer', async () => {
  const res = await fetch(`${process.env.SMOKE_SRV_URL}/odata/v4/admin/orphanPurge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slugs: [] })
  });
  expect(res.status).toBe(401);
});
```

- [ ] **Step 3: Run smoke test against DEV (after PR-1 is deployed; this step pins to the deploy gate)**

```bash
SMOKE_BASE_URL="https://tutorial-system-dev-tutorials-approuter.cfapps.eu10-005.hana.ondemand.com" \
SMOKE_SRV_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" \
  npx vitest run test/smoke/admin-auth.test.js
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add test/smoke/admin-auth.test.js
git commit -m "test(smoke): /admin/orphanPurge requires admin bearer

Anti-regression for the XSUAA scope gate on the new admin action."
```

## Task 10: Deploy PR-1 to DEV + verify

- [ ] **Step 1: Open PR**

```bash
gh pr create --base main --head <branch> \
  --title "feat(orphan-purge): server endpoint + /content/source-hashes INACTIVE filter (PR 1/2)" \
  --body "Phase 1 of orphan-purge per docs/superpowers/specs/2026-06-30-orphan-purge-design.md.

  This PR is server-side only. PR 2/2 will add the CLI + workflow.

  - GET /content/source-hashes now filters Tutorials.status='INACTIVE' (drift workflow stops re-reporting purged slugs forever; behavior is no-op until something flips a slug to INACTIVE)
  - POST /admin/orphanPurge new action for batched soft-delete with PipelineLog attribution + 100-slug server ceiling
  - Unit tests for the filter + endpoint; hybrid tests against real HANA; smoke 401-without-bearer

  Pre-deploy data check (Task 1) result: NULL-status row count = <N>; filter ships with OR-NULL clause."
```

- [ ] **Step 2: Wait for CI + merge, then deploy DEV**

After merge to main:

```bash
cd /d/projects/tutorials-poc          # NOT the worktree — primary tree, per feedback_always_deploy_from_main_primary_tree.md
git checkout main && git pull
npm run build:all
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f
```

- [ ] **Step 3: Smoke-verify deployed endpoint**

```bash
# 401 path — confirms auth gate is wired
curl -i -X POST "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/odata/v4/admin/orphanPurge" \
  -H "Content-Type: application/json" -d '{"slugs":[]}'
```

Expected: HTTP/2 401.

- [ ] **Step 4: Wait one day, check the drift workflow**

The next 04:13 UTC `content-drift-check` run should still report the same 24 missing-locally slugs. The filter is wired but inert (nothing has been flipped to INACTIVE yet). Confirms the filter is not over-filtering live content.

---

# PR-2 — CLI + workflow

## Task 11: Extract pure helpers into a new module

**Why:** keep `publish-content.ts` from growing past its current ~1000 lines and make the cap + summary helpers testable without HTTP boot.

**Files:**
- Create: `scripts/lib/purge-orphans.ts`

- [ ] **Step 1: Write the helper module**

```ts
/**
 * Pure helpers for the --purge-orphans mode of scripts/publish-content.ts.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode
 *
 * Module is import-only — no top-level side effects, no HTTP, no fs. The
 * orchestration (env-var reading, fetch, exit codes) lives in
 * scripts/publish-content.ts under the `--purge-orphans` branch.
 */

/**
 * Compute the set of orphan slugs: server has it, local doesn't.
 *
 * Set membership only — never hash equality — so a corrupted/empty local
 * hash never causes a false-positive orphan. Drift slugs go through
 * --heal, not --purge-orphans.
 */
export function computeOrphans(serverSlugs: string[], localSlugs: Set<string>): string[] {
  return serverSlugs.filter(s => !localSlugs.has(s));
}

/**
 * Enforce the absolute cap.
 * Returns null on pass; returns an error message on fail.
 */
export function enforceCap(orphanCount: number, capAbs: number): string | null {
  if (orphanCount <= capAbs) return null;
  return `Orphan count ${orphanCount} exceeds cap (${orphanCount} > ${capAbs} abs). ` +
         `Investigate fetch output before raising --purge-cap-abs.`;
}

/**
 * Build the markdown block for $GITHUB_STEP_SUMMARY.
 */
export function formatStepSummary(opts: {
  mode: 'dry-run' | 'committed' | 'failed' | 'skipped';
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

- [ ] **Step 2: Commit the helper (tests come in Task 12)**

```bash
git add scripts/lib/purge-orphans.ts
git commit -m "feat(publish-content): extract pure purge-orphans helpers

computeOrphans, enforceCap, formatStepSummary lifted into scripts/lib/
so they can be unit-tested without booting CDS or fetching anything.
publish-content.ts orchestration (next commit) imports them under the
new --purge-orphans branch."
```

## Task 12: Unit test the pure helpers

**Files:**
- Create: `test/unit/purge-orphans-cap.test.js`

- [ ] **Step 1: Write tests**

```js
/**
 * Tests for the pure helpers in scripts/lib/purge-orphans.ts.
 * No HTTP, no DB — just function-input → function-output.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode-cap-design
 */
import { describe, it, expect } from 'vitest';
import { computeOrphans, enforceCap, formatStepSummary } from '../../scripts/lib/purge-orphans.ts';

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
  it('passes at exactly the cap', () => {
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
  it('with capAbs=0, only zero orphans passes', () => {
    expect(enforceCap(0, 0)).toBeNull();
    expect(enforceCap(1, 0)).toMatch(/1 > 0 abs/);
  });
});

describe('formatStepSummary', () => {
  it('dry-run mode renders the "would have purged" line', () => {
    const out = formatStepSummary({ mode: 'dry-run', serverCount: 1396, orphanCount: 22 });
    expect(out).toMatch(/Dry run/);
    expect(out).toMatch(/would have purged 22 slug/);
  });
  it('committed mode lists soft-deleted + redirect samples', () => {
    const out = formatStepSummary({
      mode: 'committed',
      serverCount: 1396,
      orphanCount: 24,
      purged: 21,
      alreadyInactive: 0,
      redirected: 3,
      redirectedSamples: ['btp-ea-onboard-04-subm', 'btp-ea-onboard-06-abapm'],
      version: 218
    });
    expect(out).toMatch(/Soft-deleted:\s+21/);
    expect(out).toMatch(/Preserved \(redirect\): 3 — btp-ea-onboard-04-subm/);
    expect(out).toMatch(/Manifest version:\s+218/);
  });
  it('failed mode includes the error message', () => {
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

- [ ] **Step 2: Run tests**

```bash
npx vitest run test/unit/purge-orphans-cap.test.js
```

Expected: all PASS (helper code already exists from Task 11).

- [ ] **Step 3: Commit**

```bash
git add test/unit/purge-orphans-cap.test.js
git commit -m "test(unit): pure helpers for --purge-orphans (cap + summary + orphan-set)"
```

## Task 13: CLI guard + flag-combo test

**Files:**
- Create: `test/unit/purge-orphans-cli-guard.test.js`

- [ ] **Step 1: Write the test**

```js
/**
 * Tests for the --purge-orphans CLI flag's CI-only guard and mutex with
 * the other publish modes.
 *
 * Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode-execution-flow
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

- [ ] **Step 2: Run the test — expect failure (validateFlagCombo hasn't been extended yet)**

```bash
npx vitest run test/unit/purge-orphans-cli-guard.test.js
```

Expected: FAIL — `purgeOrphans` isn't in `validateFlagCombo`'s signature.

## Task 14: Extend `validateFlagCombo` + add `--purge-orphans` branch in publish-content.ts

**Files:**
- Modify: `scripts/publish-content.ts` line 437 (validateFlagCombo) + branch after `--verify-only` short-circuit (~line 715)

- [ ] **Step 1: Update `validateFlagCombo` to accept `purgeOrphans`**

Replace the existing function at line 437:

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

- [ ] **Step 2: Add the flag-parsing for `--purge-orphans` and the env-driven cap**

Find the `has = ...` flag-parse block (currently around line 533-540). Add:

```ts
purgeOrphans: has('--purge-orphans'),
purgeCapAbs:  Number(process.env.PURGE_CAP_ABS ?? readFlagArg('--purge-cap-abs') ?? 50),
```

If `readFlagArg` doesn't exist, use the same pattern other flags use — search for how `--concurrency` is read.

- [ ] **Step 3: Add the `--purge-orphans` branch in `main()` near line 618 (after `--verify-only` short-circuit)**

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
    const pctInformational = serverSlugs.length ? ((orphans.length / serverSlugs.length) * 100).toFixed(1) : '0.0';
    log(`[purge-orphans] Computed ${orphans.length} orphans (${pctInformational}% of server — informational)`);

    // 5. Cap check
    const capErr = enforceCap(orphans.length, opts.purgeCapAbs);
    if (capErr) {
      console.error(`[purge-orphans] ${capErr}`);
      console.error(`[purge-orphans] First 20 orphans:`);
      for (const s of orphans.slice(0, 20)) console.error(`  - ${s}`);
      writeStepSummary(formatStepSummary({
        mode: 'failed', serverCount: serverSlugs.length, orphanCount: orphans.length,
        errorMessage: capErr
      }));
      process.exit(1);
    }
    log(`[purge-orphans] Cap check: ${orphans.length} < ${opts.purgeCapAbs} abs → passes`);

    // 6. Print sample
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

    // 8. POST /odata/v4/admin/orphanPurge
    const initiator = opts.initiator;
    const purgeUrl = `${opts.baseUrl.replace(/\/$/, '')}/odata/v4/admin/orphanPurge`;
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

    // 11. Print response summary
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

    // 12. Write step summary
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

- [ ] **Step 4: Add the imports + writeStepSummary helper at top**

Top-of-file imports — add `computeOrphans`, `enforceCap`, `formatStepSummary`:

```ts
import { computeOrphans, enforceCap, formatStepSummary } from './lib/purge-orphans.ts';
```

Add a `writeStepSummary` helper near other utility functions:

```ts
function writeStepSummary(markdown: string) {
  const target = process.env.GITHUB_STEP_SUMMARY;
  if (!target) return;
  try {
    const fs = require('fs');
    fs.appendFileSync(target, markdown + '\n');
  } catch (err) {
    console.error(`[purge-orphans] Failed to append $GITHUB_STEP_SUMMARY: ${err}`);
  }
}
```

- [ ] **Step 5: Update `validateFlagCombo` call site (line 762)**

```ts
validateFlagCombo({ force: opts.force, heal: opts.heal, verifyOnly: opts.verifyOnly, purgeOrphans: opts.purgeOrphans });
```

- [ ] **Step 6: Run the failing test from Task 13 — it should now pass**

```bash
npx vitest run test/unit/purge-orphans-cli-guard.test.js
```

Expected: all PASS.

- [ ] **Step 7: Run the full unit suite to confirm no regression**

```bash
npm test -- --run 2>&1 | tail -50
```

- [ ] **Step 8: Commit**

```bash
git add scripts/publish-content.ts test/unit/purge-orphans-cli-guard.test.js
git commit -m "feat(publish-content): add --purge-orphans CI-only mode

Adds the --purge-orphans branch to publish-content.ts:
- GITHUB_ACTIONS env-var hard-block (refuses to run from workstation)
- Mutex with --force/--heal/--verify-only via validateFlagCombo
- Absolute cap (default 50, env PURGE_CAP_ABS) — refuses before HTTP
- Set-membership orphan detection (never hash equality — corrupted local
  hash never causes false-positive orphan)
- POST /odata/v4/admin/orphanPurge with x-initiator header
- Error handling with distinct exit messages for 401/403/400/5xx/network
- Bucket-sum sanity check (malformed response → exit 1, never silent success)
- \$GITHUB_STEP_SUMMARY block always written (committed / dry-run / failed)

Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §CLI-mode"
```

## Task 15: Workflow — add input + extend mode-determine step

**Files:**
- Modify: `.github/workflows/rebuild-content.yml`

- [ ] **Step 1: Add the `purge-orphans` input near the other workflow_dispatch inputs**

Find the `workflow_dispatch:` block (top of file) and add:

```yaml
      purge-orphans:
        description: 'After publish, soft-delete tutorials no longer present in any upstream repo. CI-only, 50-slug safety cap (override via PURGE_CAP_ABS env).'
        required: false
        type: boolean
        default: false
```

- [ ] **Step 2: Extend the `Determine effective rebuild mode` step (line ~123-148)**

Replace the body of the step's `run:` with:

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
          # as orphans. Fail loud, don't silently skip — operator clearly
          # intended the purge.
          if [ "${INPUT_PURGE_ORPHANS:-false}" = "true" ] && [ "$EFFECTIVE" != "full" ]; then
            echo "::error title=purge-orphans requires mode=full::Got effective_mode=$EFFECTIVE. Re-run with -f mode=full -f purge-orphans=true."
            exit 1
          fi

          echo "effective_mode=$EFFECTIVE" >> "$GITHUB_OUTPUT"
          echo "effective_reason=$REASON" >> "$GITHUB_OUTPUT"
          echo "::notice title=Rebuild mode::$EFFECTIVE ($REASON)"
```

And add `INPUT_PURGE_ORPHANS: ${{ inputs.purge-orphans }}` to the step's `env:` block.

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

- [ ] **Step 4: Add the new "Purge orphan tutorials" step (right after the Publish step finishes — find its closing `env:` block around line 340)**

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

- [ ] **Step 5: Lint the workflow file locally (catches YAML errors before push)**

```bash
npx js-yaml .github/workflows/rebuild-content.yml > /dev/null && echo "YAML valid"
```

Expected: prints "YAML valid". If it errors, fix indentation.

- [ ] **Step 6: Commit**

```bash
git add .github/workflows/rebuild-content.yml
git commit -m "ci(rebuild-content): add purge-orphans input + gated step

- New workflow_dispatch input \`purge-orphans\` (default false)
- Mode-determine step rejects purge-orphans=true with anything other than
  effective_mode=full, with a clear ::error annotation
- Existing 'Publish tutorial content to HANA' step gains id: publish so
  the new step can gate on steps.publish.outcome == 'success'
- New 'Purge orphan tutorials' step runs ONLY when all three conjuncts
  hold (input + mode + publish-succeeded). Clean skip on mode mismatch,
  not a failed run.

Spec: docs/superpowers/specs/2026-06-30-orphan-purge-design.md §Workflow-integration"
```

## Task 16: Update operator-facing docs

**Files:**
- Modify: `docs/developers/operations/rebuild-content-workflow.md`

- [ ] **Step 1: Add the "When to run purge-orphans" section**

Append (near the end of the file, after the existing mode-selection content):

```markdown
## When to run `purge-orphans`

The `purge-orphans=true` workflow input batches the soft-delete operation the admin Tutorials Fiori app performs one-at-a-time. It targets tutorials whose source markdown is no longer present in any upstream repo — the daily [content-drift workflow](../../../.github/workflows/content-drift-check.yml) surfaces these as "missing locally" slugs.

### When to use it

- The drift report consistently shows N missing-locally slugs (e.g. 20+).
- You've inspected the list (artifact `content-drift-<env>-<run_number>` on the drift run) and confirmed they are genuinely orphaned, not the result of a fetch regression.
- You want a one-shot cleanup rather than 20+ clicks in the admin Tutorials app.

### When NOT to use it

- `fetch-tutorials` recently changed — verify the discovery output before purging.
- The drift count jumped from ~24 to ~200 overnight — that's a fetch problem, not real orphans. Fix the fetch first.
- You're trying to "unpublish" a single tutorial — use the admin Tutorials app (`/admin-ui/#tutorials-display`) instead; soft-delete one row at a time.

### How

```bash
# Dry-run first (lists what would be purged; no DB write):
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full -f purge-orphans=true
# Wait for the run to land; check the run summary's "Orphan purge" section.
```

The workflow:
1. Runs `full`-mode fetch + publish first (the cache is what defines "orphan").
2. Then the gated `Purge orphan tutorials` step runs `publish-content.ts --purge-orphans`.
3. Result lands in `$GITHUB_STEP_SUMMARY` ("🧹 Orphan purge — full mode" block).

### Safety caps

- **Client**: 50 absolute orphans. If the count exceeds this, the step fails before any HTTP traffic. Override via `PURGE_CAP_ABS` env in the workflow file.
- **Server**: 100-slug ceiling. Server returns 400 if the client cap was loosened past this point. Operator splits the work into multiple calls (or files a separate change to raise the server ceiling).

### Rollback

If the purge mis-soft-deletes, see the [orphan-purge design § Rollback](../../superpowers/specs/2026-06-30-orphan-purge-design.md#rollback) — the SQL there uses change-tracking + PipelineLog to enumerate exactly which rows flipped.
```

- [ ] **Step 2: Commit**

```bash
git add docs/developers/operations/rebuild-content-workflow.md
git commit -m "docs(operations): add 'When to run purge-orphans' section

Operator-facing instructions for the new --purge-orphans CLI flag and the
rebuild-content workflow's purge-orphans input. Includes when to use it,
when NOT to use it, the dispatch command, the safety caps, and a pointer
to the spec's rollback SQL."
```

## Task 17: Deploy PR-2 to DEV + exercise the workflow

- [ ] **Step 1: Open the PR**

```bash
gh pr create --base main --head <branch> \
  --title "feat(orphan-purge): CLI + workflow input (PR 2/2)" \
  --body "Phase 2 of orphan-purge per docs/superpowers/specs/2026-06-30-orphan-purge-design.md.

  Requires PR 1/2 (server side) to be merged and deployed first.

  - scripts/publish-content.ts gains --purge-orphans mode (CI-only via GITHUB_ACTIONS env hard-block; 50-slug client cap; POST /admin/orphanPurge)
  - scripts/lib/purge-orphans.ts new pure helpers (computeOrphans, enforceCap, formatStepSummary)
  - .github/workflows/rebuild-content.yml new \`purge-orphans\` input; mode-determine step rejects slug-targeted+purge-orphans=true with ::error; new gated 'Purge orphan tutorials' step
  - Unit tests for pure helpers + CLI guard + mutex; docs update with operator runbook
  - id: publish added to the existing 'Publish tutorial content to HANA' step so the new step can gate on steps.publish.outcome=='success'"
```

- [ ] **Step 2: After merge + DEV deploy, run the workflow manually against DEV**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full -f purge-orphans=true
```

Watch via `gh run watch` or check the run UI.

- [ ] **Step 3: Verify the run summary**

The run's "Purge orphan tutorials" step should land a `🧹 Orphan purge — full mode` block in `$GITHUB_STEP_SUMMARY` with the expected counts (~21 purged, ~3 redirected as preserved, depending on current drift state).

- [ ] **Step 4: Verify the database reflects the purge**

```bash
curl -s "https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com/content/source-hashes" | \
  node -e "const m=JSON.parse(require('fs').readFileSync(0,'utf8'));console.log('server slug count:',Object.keys(m).length);"
```

Expected: count drops from 1396 → ~1375 (24 orphans minus 3 redirected = 21 purged).

- [ ] **Step 5: Re-run the daily drift workflow manually**

```bash
gh workflow run content-drift-check.yml --repo sap-tutorials/tutorials-ims -f environment=dev
```

Expected outcome: "missing locally" count drops from 24 to 3 (just the `redirectTo`-preserved ones).

- [ ] **Step 6: Reject-on-misconfig sanity check**

```bash
# Intentionally pass slug-targeted with purge-orphans=true — should fail loud.
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f mode=full -f slugs=appgyver-fetch-data -f purge-orphans=true
```

Expected: the mode-determine step emits the `::error::` annotation "purge-orphans requires mode=full" and exits non-zero before any fetch/publish runs. Auto-infer would have flipped this to `slug-targeted`; our new check catches that.

---

## Phase 3 — PROD rollout (no code)

After ≥24 h of DEV soak with no regressions:

- [ ] **Step 1: Refresh the drift report against PROD**

```bash
gh workflow run content-drift-check.yml --repo sap-tutorials/tutorials-ims -f environment=prod
```

Inspect the `verify.log` artifact; confirm count is within `24 ± 5`. If wildly different, **STOP** and investigate.

- [ ] **Step 2: Dispatch against PROD**

```bash
gh workflow run rebuild-content.yml --repo sap-tutorials/tutorials-ims --ref main \
  -f environment=prod -f mode=full -f purge-orphans=true
```

- [ ] **Step 3: Confirm via source-hashes count + next drift run**

Same checks as Task 17 Steps 4-5 but against the PROD srv URL.

---

## Risks during execution

| Risk | Mitigation |
|---|---|
| `cds bind --exec` not available locally for Task 1 | Defer to CI or have a maintainer with PROD CF login run it; record the number in the PR description |
| Hybrid test floods the DEV DB with `__TEST__` rows if `afterAll` fails | `afterAll` runs always (even on test failure) per Vitest contract; the seeded slugs all share the `__TEST__purge-orphan-*` prefix so manual cleanup is `DELETE FROM tutorials WHERE slug LIKE '__TEST__purge-orphan-%'` |
| `scripts/lib/purge-orphans.ts` imports break if tsx config doesn't resolve `./lib/` | Mirror the import path style of an existing `scripts/lib/` import — `grep "from './lib/" scripts/publish-content.ts` and copy the form |
| Workflow YAML indentation regression breaks all rebuilds | Local `js-yaml` lint at Task 15 Step 5; don't push until valid |
| PR-1 deploys but PR-2 doesn't (server has filter but no CI cleanup) | Acceptable — the filter is no-op until something flips a slug to INACTIVE. Drift reports still surface 24 ghosts in this intermediate state |
| PR-2 deploys but PR-1 didn't (CI tries to POST to a missing endpoint) | 404 from `/admin/orphanPurge` → CLI's error-handling step (9) reports `Unexpected status 404` and exits 1; no data damage, just a failed CI run |
