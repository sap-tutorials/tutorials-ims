# Tutorial Quarantine Persistence + Admin UI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist tutorial pre-publish quarantine results to HANA via an authenticated CI endpoint and surface the current set in the Admin UI, so quarantine reasons are no longer discarded on the ephemeral CI runner.

**Architecture:** A full rebuild (`mode=full`) posts its complete quarantine set to a new `POST /content/quarantine-events` Express route (reusing the existing `contentAuthMiddleware`). The handler writes an immutable snapshot (`QuarantineSnapshots`) + child rows (`QuarantineEvents`) in one transaction and flips the prior snapshot's `isCurrent` flag off, so "current quarantine set" = the latest snapshot's children. A Fiori Elements list view in the Admin UI binds to a `QuarantineEventsCurrent` projection; raw snapshot/event projections drive over-time / per-repo reporting.

**Tech Stack:** CAP (Node.js, CDS), SAP HANA Cloud, Express, Fiori Elements (sap.fe.templates), Vitest, TypeScript (tsx) for the validator script, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-04-tutorial-quarantine-persistence-design.md`

## Global Constraints

- Namespace is `com.sap.developers.ims` everywhere (DB entities, `cds.entities(NS)`).
- Never write raw SQL — use `cds.ql` / CQL (`SELECT`/`INSERT`/`UPDATE`/`DELETE`). Raw `db.run()` is ONLY for HANA BLOB locators; quarantine entities have no BLOBs, so CDS QL throughout.
- Ingest endpoint auth: Bearer token = `CONTENT_API_KEY` via the existing `contentAuthMiddleware` (503 unconfigured / 401 missing-or-malformed bearer / 403 wrong key, `timingSafeEqual`). Do not invent a new key.
- The validator (`scripts/validate-tutorials.ts`) MUST remain fail-open: it never exits non-zero and never throws on a failed network post. It runs in two places — `rebuild-content.yml` AND the `mta.yaml` before-all build (where no CAP backend exists) — so the post MUST be a silent no-op unless `QUARANTINE_REPORT === 'full'` AND both `CAP_BASE_URL` and `CONTENT_API_KEY` are set.
- Only `mode=full` writes a snapshot; non-full `buildMode` is rejected 400 by the handler.
- House DB style: `: cuid, managed` (UUID `ID` + managed timestamps), `@mandatory` on required strings, status fields `String(N) default '...'`.
- Admin UI entities are auto-discovered — do NOT edit the admin-shell generated manifest. Admin-UI changes require a FULL deploy (no `--skip-build`, no `-m` scoping); Step 3.5 bundle-drift guard enforces this.
- Fiori app id MUST be `sap.tutorials.admin.quarantineEvents` (enforced at discover time by `app/admin-shell/scripts/discover-admin-components.js`).
- PRs target `DEV`, never `main`. Work is on branch `worktree-quarantine-2585` (based on `origin/DEV`).

---

## File Structure

- **Create** `db/tutorial-quarantine.cds` — `QuarantineSnapshots` + `QuarantineEvents` entities.
- **Modify** `srv/admin-service.cds` — `using` import + 3 read-only projections (`QuarantineSnapshots`, `QuarantineEvents`, `QuarantineEventsCurrent`).
- **Modify** `app/admin-annotations.cds` — Fiori `@UI` annotations for `AdminService.QuarantineEventsCurrent`.
- **Create** `app/admin/quarantine-events/webapp/{Component.js,manifest.json,i18n/i18n.properties}` — Fiori Elements list view (auto-discovered).
- **Modify** `packages/content/content-store.js` — add `quarantineIngestHandler` inside `createContentHandlers`, add to the returned object + default re-export.
- **Modify** `srv/lib/content-store.js` — re-export `quarantineIngestHandler` from the shim.
- **Modify** `srv/server.js` — import + register `POST /content/quarantine-events`.
- **Create** `srv/__tests__/lib/quarantine-ingest-routes.test.js` — Vitest route tests.
- **Modify** `scripts/validate-tutorials.ts` — add `slug`/`sourceRepo` to entries + best-effort POST (extracted to a testable function).
- **Create** `test/validate-tutorials-quarantine-post.test.ts` — unit tests for the POST guard/fail-open behaviour.
- **Modify** `.github/workflows/rebuild-content.yml` — add `env:` block to the "Validate tutorials" step.

---

## Task 1: DB entities — `db/tutorial-quarantine.cds`

**Files:**
- Create: `db/tutorial-quarantine.cds`
- Test: covered via Task 4 (handler round-trip exercises the schema under `cds.test` in-memory)

**Interfaces:**
- Consumes: `com.sap.developers.ims` namespace from `db/schema`.
- Produces: entities `com.sap.developers.ims.QuarantineSnapshots` (fields: `ID`, `runId`, `workflowUrl`, `manifestVersion`, `buildMode`, `isCurrent`, `eventCount`, `events` composition, managed fields) and `com.sap.developers.ims.QuarantineEvents` (fields: `ID`, `snapshot` assoc, `slug`, `sourceFile`, `sourceRepo`, `reason`, `sourceUrl`, managed fields).

- [ ] **Step 1: Create the entity file**

```cds
namespace com.sap.developers.ims;

using { com.sap.developers.ims as ims } from './schema';
using { cuid, managed } from '@sap/cds/common';

/**
 * One row per full rebuild that posts a quarantine snapshot (#2585).
 * The newest snapshot with isCurrent = true defines the live quarantine set;
 * writing a new current snapshot flips the prior one to false. Snapshots are
 * immutable once written — "clearing" a slug is just a later snapshot that
 * does not contain it.
 */
entity QuarantineSnapshots : cuid, managed {
  runId           : String(60);                 // github.run_id
  workflowUrl     : String(400);                // .../actions/runs/<runId>
  manifestVersion : String(60);                 // ContentManifest version at build time (nullable)
  buildMode       : String(20) default 'full';  // full (only full builds post)
  isCurrent       : Boolean    default false;
  eventCount      : Integer    default 0;
  events          : Composition of many QuarantineEvents on events.snapshot = $self;
}

/**
 * One quarantined slug within a snapshot: why it was dropped and where it came from.
 */
entity QuarantineEvents : cuid, managed {
  snapshot    : Association to QuarantineSnapshots;
  slug        : String(255) @mandatory;   // lowercase canonical slug
  sourceFile  : String(255);              // e.g. foo.md
  sourceRepo  : String(120);              // from fetch _discovery.json repoBySlug
  reason      : String(500) @mandatory;   // validator reason string
  sourceUrl   : String(600);              // link to source .md in its repo (nullable)
}
```

- [ ] **Step 2: Verify the model compiles**

Run: `npx cds compile db/tutorial-quarantine.cds`
Expected: compiles with no errors; prints CSN for both entities. (If it complains it cannot resolve `./schema`, run from repo root — the `using` resolves relative to the file.)

- [ ] **Step 3: Verify it loads in the full model**

Run: `npx cds compile srv --to sql 2>&1 | grep -i quarantine`
Expected: `CREATE TABLE` statements for `com_sap_developers_ims_QuarantineSnapshots` and `..._QuarantineEvents` appear (confirms it's picked up by the service model once Task 2 adds the projection — if run before Task 2, just confirm no compile error).

- [ ] **Step 4: Commit**

```bash
git add db/tutorial-quarantine.cds
git commit -m "feat(#2585): QuarantineSnapshots + QuarantineEvents entities"
```

---

## Task 2: AdminService projections — `srv/admin-service.cds`

**Files:**
- Modify: `srv/admin-service.cds` (add `using` near the other `using` lines at the top, lines 1-15; add projections in the service body)
- Test: covered via Task 6 (annotations) and the handler test (Task 4)

**Interfaces:**
- Consumes: entities from Task 1.
- Produces: `AdminService.QuarantineSnapshots`, `AdminService.QuarantineEvents`, `AdminService.QuarantineEventsCurrent` (read-only OData entity sets under `/admin`). `QuarantineEventsCurrent` exposes only events whose parent snapshot `isCurrent = true`.

- [ ] **Step 1: Add the `using` import**

Add alongside the existing `using from '../db/...'` lines near the top of `srv/admin-service.cds`:

```cds
using from '../db/tutorial-quarantine';
```

- [ ] **Step 2: Add the three projections in the AdminService body**

Place near the other `@readonly` log-style projections (e.g. by `FreshnessReport` / `StepFailures`):

```cds
  @readonly entity QuarantineSnapshots as projection on ims.QuarantineSnapshots;
  @readonly entity QuarantineEvents    as projection on ims.QuarantineEvents;

  // Current quarantine set: events belonging to the one snapshot flagged
  // isCurrent. Drives the default Admin list view with no filter ceremony.
  @readonly entity QuarantineEventsCurrent as
    projection on ims.QuarantineEvents
    { *, snapshot.runId as runId, snapshot.workflowUrl as workflowUrl, snapshot.createdAt as buildAt }
    where snapshot.isCurrent = true;
```

- [ ] **Step 3: Verify the service model compiles**

Run: `npx cds compile srv --to sql 2>&1 | grep -iE "quarantine" | head`
Expected: the three entity sets resolve; no "Unknown ... QuarantineEvents" errors. A `where` on a projection is a view, which compiles to a `CREATE VIEW` / `SELECT` — confirm no compiler error about the association path `snapshot.isCurrent`.

- [ ] **Step 4: Commit**

```bash
git add srv/admin-service.cds
git commit -m "feat(#2585): AdminService projections for quarantine events"
```

---

## Task 3: Ingest handler — `packages/content/content-store.js` + shim

**Files:**
- Modify: `packages/content/content-store.js` (add `quarantineIngestHandler` inside `createContentHandlers`, before the `return {` at line ~2157; add to the returned object ~2157-2176; add a default re-export ~2198)
- Modify: `srv/lib/content-store.js` (add re-export line after line 29)
- Test: `srv/__tests__/lib/quarantine-ingest-routes.test.js` (Task 4)

**Interfaces:**
- Consumes: `namespace` + `apiKeyEnv` from the enclosing `createContentHandlers({ namespace, apiKeyEnv })` scope; `cds` global; `contentAuthMiddleware` (already in scope, applied at the route). The handler signature is `async function quarantineIngestHandler(req, res)`.
- Produces: export `quarantineIngestHandler` from both `packages/content/content-store.js` (named default export) and `srv/lib/content-store.js` (shim). Request body `{ runId, workflowUrl, manifestVersion?, buildMode, events: Array<{ slug, sourceFile?, sourceRepo?, reason, sourceUrl? }> }`. Response `201 { snapshotId, eventCount }`; `400` on non-full `buildMode` or non-array `events`; auth codes handled by middleware before the handler runs.

- [ ] **Step 1: Add the handler inside `createContentHandlers`**

Insert immediately before `return {` (the big handler-map return at ~line 2157), so it closes over `namespace`:

```js
  // --- quarantineIngestHandler: Express handler for /content/quarantine-events ---
  //
  // Called by scripts/validate-tutorials.ts on a FULL rebuild (#2585). Writes an
  // immutable snapshot of the current quarantine set + child events, and flips any
  // prior isCurrent snapshot off, so "current quarantine set" = the newest
  // isCurrent snapshot's children. Only mode=full posts (a partial run's set would
  // wrongly clear out-of-scope slugs). Idempotent per runId: a repeat POST for the
  // same runId replaces that run's snapshot. Same auth as /content/publish.
  async function quarantineIngestHandler(req, res) {
    try {
      const { runId, workflowUrl, manifestVersion, buildMode, events } = req.body || {};
      if (buildMode !== 'full') {
        return res.status(400).json({ error: "Only buildMode 'full' may post a quarantine snapshot" });
      }
      if (!Array.isArray(events)) {
        return res.status(400).json({ error: "'events' must be an array" });
      }
      const { QuarantineSnapshots, QuarantineEvents } = cds.entities(namespace);
      const db = await cds.connect.to('db');
      const result = await db.tx(async (tx) => {
        // Idempotency: drop any prior snapshot for this runId (and its events via composition cascade).
        if (runId) {
          const prior = await tx.run(SELECT.from(QuarantineSnapshots).columns('ID').where({ runId }));
          if (prior.length) {
            await tx.run(DELETE.from(QuarantineSnapshots).where({ ID: prior.map(p => p.ID) }));
          }
        }
        // Flip the existing current snapshot off.
        await tx.run(UPDATE(QuarantineSnapshots).set({ isCurrent: false }).where({ isCurrent: true }));
        // Insert the new current snapshot + its events via deep insert.
        const snapshotId = cds.utils.uuid();
        await tx.run(INSERT.into(QuarantineSnapshots).entries({
          ID: snapshotId,
          runId: runId ? String(runId).slice(0, 60) : null,
          workflowUrl: workflowUrl ? String(workflowUrl).slice(0, 400) : null,
          manifestVersion: manifestVersion ? String(manifestVersion).slice(0, 60) : null,
          buildMode: 'full',
          isCurrent: true,
          eventCount: events.length,
          events: events.map(e => ({
            ID: cds.utils.uuid(),
            slug: String(e.slug || '').toLowerCase().slice(0, 255),
            sourceFile: e.sourceFile ? String(e.sourceFile).slice(0, 255) : null,
            sourceRepo: e.sourceRepo ? String(e.sourceRepo).slice(0, 120) : null,
            reason: String(e.reason || '').slice(0, 500),
            sourceUrl: e.sourceUrl ? String(e.sourceUrl).slice(0, 600) : null,
          })),
        }));
        return { snapshotId, eventCount: events.length };
      });
      LOG.warn(`[content/quarantine-events] recorded snapshot ${result.snapshotId} with ${result.eventCount} events (run ${runId || 'n/a'})`);
      return res.status(201).json(result);
    } catch (err) {
      LOG.error(`[content/quarantine-events] ${err.message}`);
      return res.status(500).json({ error: err.message });
    }
  }
```

(Note: `LOG` is already in scope in this module — it's used by `pipelineLogFailureHandler` a few lines up. `SELECT`/`INSERT`/`UPDATE`/`DELETE` are CAP CQL globals.)

- [ ] **Step 2: Add to the returned handler map**

In the `return { ... }` object (~line 2157), add after `pipelineLogFailureHandler,`:

```js
    quarantineIngestHandler,
```

- [ ] **Step 3: Add the default re-export**

After the `export const pipelineLogFailureHandler = _defaults.pipelineLogFailureHandler;` line (~2198):

```js
export const quarantineIngestHandler = _defaults.quarantineIngestHandler;
```

- [ ] **Step 4: Re-export from the shim**

In `srv/lib/content-store.js`, after line 29 (`export const pipelineLogFailureHandler = mod.pipelineLogFailureHandler;`):

```js
export const quarantineIngestHandler = mod.quarantineIngestHandler;
```

- [ ] **Step 5: Verify imports resolve**

Run: `node --input-type=module -e "import('./srv/lib/content-store.js').then(m => console.log(typeof m.quarantineIngestHandler))"`
Expected: prints `function`. (If it prints `undefined`, the workspace alias `@tutorials/content` resolved to a stale bundle — run `npm run build` of the content package or confirm the workspace link; for local dev the first `import('@tutorials/content/content-store.js')` branch should hit the edited source directly.)

- [ ] **Step 6: Commit**

```bash
git add packages/content/content-store.js srv/lib/content-store.js
git commit -m "feat(#2585): quarantineIngestHandler for POST /content/quarantine-events"
```

---

## Task 4: Register route + handler tests

**Files:**
- Modify: `srv/server.js` (line 34 import; add route near line 974 by `/content/pipeline-log`)
- Create: `srv/__tests__/lib/quarantine-ingest-routes.test.js`

**Interfaces:**
- Consumes: `quarantineIngestHandler` + `contentAuthMiddleware` from `./lib/content-store.js` (Task 3). Test harness mirrors `srv/__tests__/lib/content-publish-routes.test.js` (`makeReq`/`makeRes`, `cds.test('serve', '--project', '.', '--in-memory')`, `CONTENT_API_KEY='test-key'`).
- Produces: live route `POST /content/quarantine-events`.

- [ ] **Step 1: Write the failing test**

Create `srv/__tests__/lib/quarantine-ingest-routes.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { quarantineIngestHandler } from '../../lib/content-store.js';

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

describe('quarantine ingest route', () => {
  beforeAll(async () => { await cds.connect.to('db'); });

  beforeEach(async () => {
    const { QuarantineSnapshots, QuarantineEvents } = cds.entities(NS);
    await DELETE.from(QuarantineEvents);
    await DELETE.from(QuarantineSnapshots);
  });

  it('rejects non-full buildMode with 400', async () => {
    const res = makeRes();
    await quarantineIngestHandler(makeReq({ buildMode: 'slug', events: [] }), res);
    expect(res._status).toBe(400);
  });

  it('rejects non-array events with 400', async () => {
    const res = makeRes();
    await quarantineIngestHandler(makeReq({ buildMode: 'full', events: 'nope' }), res);
    expect(res._status).toBe(400);
  });

  it('inserts a current snapshot + events and flips prior current off', async () => {
    const { QuarantineSnapshots } = cds.entities(NS);

    const res1 = makeRes();
    await quarantineIngestHandler(makeReq({
      runId: 'run-1', workflowUrl: 'https://x/runs/run-1', buildMode: 'full',
      events: [{ slug: 'Foo-Bar', sourceFile: 'foo.md', sourceRepo: 'repo-a', reason: 'empty' }]
    }), res1);
    expect(res1._status).toBe(201);
    expect(res1._body.eventCount).toBe(1);

    const res2 = makeRes();
    await quarantineIngestHandler(makeReq({
      runId: 'run-2', buildMode: 'full',
      events: [{ slug: 'baz', reason: 'bad stepCount' }]
    }), res2);
    expect(res2._status).toBe(201);

    const currents = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(currents.length).toBe(1);
    expect(currents[0].runId).toBe('run-2');
  });

  it('lowercases slugs on insert', async () => {
    const { QuarantineEvents } = cds.entities(NS);
    await quarantineIngestHandler(makeReq({
      runId: 'r', buildMode: 'full',
      events: [{ slug: 'MixedCase-Slug', reason: 'x' }]
    }), makeRes());
    const rows = await SELECT.from(QuarantineEvents);
    expect(rows.map(r => r.slug)).toContain('mixedcase-slug');
  });

  it('is idempotent per runId (repeat replaces, no double-count)', async () => {
    const { QuarantineSnapshots } = cds.entities(NS);
    const body = { runId: 'dup', buildMode: 'full', events: [{ slug: 'a', reason: 'x' }] };
    await quarantineIngestHandler(makeReq(body), makeRes());
    await quarantineIngestHandler(makeReq(body), makeRes());
    const snaps = await SELECT.from(QuarantineSnapshots).where({ runId: 'dup' });
    expect(snaps.length).toBe(1);
  });

  it('empty events on full build writes an empty current snapshot (auto-clear)', async () => {
    const { QuarantineSnapshots } = cds.entities(NS);
    await quarantineIngestHandler(makeReq({ runId: 'clean', buildMode: 'full', events: [] }), makeRes());
    const cur = await SELECT.from(QuarantineSnapshots).where({ isCurrent: true });
    expect(cur.length).toBe(1);
    expect(cur[0].eventCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run srv/__tests__/lib/quarantine-ingest-routes.test.js`
Expected: FAIL — either `quarantineIngestHandler is not a function` (if Task 3 export missing) or table-not-found (if Task 1/2 not loaded). This confirms the test exercises the new code.

- [ ] **Step 3: Register the route in `srv/server.js`**

Add `quarantineIngestHandler` to the import on line 34 (append before the closing `}`):

```js
, quarantineIngestHandler } from './lib/content-store.js';
```

Add the route next to `/content/pipeline-log` (after line 974):

```js
  // #2585 — CI full-rebuild quarantine snapshot. Same auth as /content/publish.
  app.post('/content/quarantine-events', express.json({ limit: '2mb' }), contentAuthMiddleware, quarantineIngestHandler);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run srv/__tests__/lib/quarantine-ingest-routes.test.js`
Expected: PASS (all 6 tests). The route registration itself isn't exercised by these unit tests (they call the handler directly, matching the sibling test), so a green run here proves the handler + schema; the route wiring is a one-line mirror of the verified `pipeline-log` pattern.

- [ ] **Step 5: Commit**

```bash
git add srv/server.js srv/__tests__/lib/quarantine-ingest-routes.test.js
git commit -m "feat(#2585): register POST /content/quarantine-events + handler tests"
```

---

## Task 5: Validator posts the snapshot — `scripts/validate-tutorials.ts`

**Files:**
- Modify: `scripts/validate-tutorials.ts`
- Create: `test/validate-tutorials-quarantine-post.test.ts`

**Interfaces:**
- Consumes: the existing `quarantined` array (now carrying `slug` + `sourceRepo`), `repoBySlug` map (already loaded via `loadRepoBySlug()`), env `CAP_BASE_URL`, `CONTENT_API_KEY`, `RUN_ID`, `WORKFLOW_URL`, `QUARANTINE_REPORT`.
- Produces: exported `async function postQuarantineSnapshot(events, env): Promise<void>` where `events: Array<{ slug, sourceFile, sourceRepo, reason, sourceUrl? }>` and `env: { base?, key?, runId?, workflowUrl?, report? }`. It POSTs `{ runId, workflowUrl, buildMode:'full', events }` and NEVER throws / never exits non-zero.

- [ ] **Step 1: Write the failing test**

Create `test/validate-tutorials-quarantine-post.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { postQuarantineSnapshot } from '../scripts/validate-tutorials'

const events = [{ slug: 'a', sourceFile: 'a.md', sourceRepo: 'r', reason: 'x' }]

afterEach(() => { vi.restoreAllMocks() })

describe('postQuarantineSnapshot (fail-open guard)', () => {
  it('no-ops when report !== full', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await postQuarantineSnapshot(events, { base: 'http://x', key: 'k', report: '' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('no-ops when base or key missing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await postQuarantineSnapshot(events, { base: '', key: 'k', report: 'full' })
    await postQuarantineSnapshot(events, { base: 'http://x', key: '', report: 'full' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('posts with Bearer auth when fully configured', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ snapshotId: 's', eventCount: 1 }), { status: 201 }) as any
    )
    await postQuarantineSnapshot(events, {
      base: 'http://x/', key: 'k', runId: '42', workflowUrl: 'http://x/runs/42', report: 'full'
    })
    expect(fetchSpy).toHaveBeenCalledOnce()
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('http://x/content/quarantine-events')
    expect((init as any).headers.Authorization).toBe('Bearer k')
    const body = JSON.parse((init as any).body)
    expect(body.buildMode).toBe('full')
    expect(body.events).toHaveLength(1)
  })

  it('never throws when fetch rejects (fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'))
    await expect(
      postQuarantineSnapshot(events, { base: 'http://x', key: 'k', report: 'full' })
    ).resolves.toBeUndefined()
  })

  it('never throws when server returns non-ok (fail-open)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }) as any)
    await expect(
      postQuarantineSnapshot(events, { base: 'http://x', key: 'k', report: 'full' })
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/validate-tutorials-quarantine-post.test.ts`
Expected: FAIL — `postQuarantineSnapshot is not exported` / import error.

- [ ] **Step 3: Add the exported function + wire it into the script**

In `scripts/validate-tutorials.ts`, add near the other exported helpers (after `emptyContentCheck`):

```ts
/**
 * Best-effort POST of the full-rebuild quarantine snapshot to the CAP backend
 * (#2585). FAIL-OPEN by contract: a missing config, a rejected fetch, or a
 * non-ok response is logged and swallowed — this must NEVER throw or make the
 * validator exit non-zero, and must NOT fire from the mta.yaml before-all build
 * or local runs (no backend), which is why it no-ops unless report === 'full'
 * AND both base + key are present.
 */
export async function postQuarantineSnapshot(
  events: Array<{ slug: string; sourceFile: string; sourceRepo?: string; reason: string; sourceUrl?: string }>,
  env: { base?: string; key?: string; runId?: string; workflowUrl?: string; report?: string },
): Promise<void> {
  if (env.report !== 'full' || !env.base || !env.key) return
  const url = `${env.base.replace(/\/$/, '')}/content/quarantine-events`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.key}`,
        'Content-Type': 'application/json',
        'x-initiator': env.runId ? `ci/${env.runId}` : 'ci',
      },
      body: JSON.stringify({
        runId: env.runId,
        workflowUrl: env.workflowUrl,
        buildMode: 'full',
        events,
      }),
    })
    if (!resp.ok) {
      console.warn(`  ⚠ quarantine snapshot POST returned ${resp.status} — continuing (fail-open)`)
    } else {
      console.log(`  → quarantine snapshot posted (${events.length} events)`)
    }
  } catch (e: any) {
    console.warn(`  ⚠ quarantine snapshot POST failed: ${e?.message ?? e} — continuing (fail-open)`)
  }
}
```

Change the `quarantined` collection to carry `slug` + `sourceRepo`. Replace the declaration (currently `const quarantined: Array<{ file: string; reason: string }> = []`) with:

```ts
const quarantined: Array<{ file: string; slug: string; sourceRepo?: string; reason: string }> = []
```

In the loop, where it currently does `quarantined.push({ file, reason })`, capture the slug/repo. The frontmatter is already parsed as `fm` inside the `try`; but `reason` can also be set before/outside parse (empty-content / parse error) where `fm` is unavailable. So compute slug defensively from the filename when frontmatter is absent:

```ts
  if (reason) {
    const slug = String((typeof fm !== 'undefined' && fm?.slug) ? fm.slug : file.replace(/\.md$/, '')).toLowerCase()
    quarantined.push({ file, slug, sourceRepo: repoBySlug[slug], reason })
    mkdirSync(QUARANTINE_DIR, { recursive: true })
    renameSync(join(TUTORIALS_DIR, file), join(QUARANTINE_DIR, file))
    console.log(`  ✗ ${file}: ${reason}`)
  }
```

> Note: `fm` is currently scoped inside the `try` block. Hoist its declaration to the top of the loop body (`let fm: any`) so it's in scope at the push site. Assign `fm = matter(content).data` inside the try as today.

At the very end of the script (after the summary logs), add the best-effort post — it runs for a full build even when `quarantined` is empty (empty snapshot = auto-clear):

```ts
await postQuarantineSnapshot(
  quarantined.map(q => ({ slug: q.slug, sourceFile: q.file, sourceRepo: q.sourceRepo, reason: q.reason })),
  {
    base: process.env.CAP_BASE_URL,
    key: process.env.CONTENT_API_KEY,
    runId: process.env.RUN_ID,
    workflowUrl: process.env.WORKFLOW_URL,
    report: process.env.QUARANTINE_REPORT,
  },
)
```

> The file currently runs top-level synchronous code (no `main()`); a trailing top-level `await` requires the module to be ESM (it is — it uses `import`/`import.meta.url`), so top-level await is valid under the project's `tsx` runner. If `tsx` complains, wrap the whole script tail in an `async function main(){…}; await main()` — but try the top-level await first.

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/validate-tutorials-quarantine-post.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Verify existing validator tests still pass**

Run: `npx vitest run test/validate-tutorials-shortcode.test.ts`
Expected: PASS — the `stepCountReason` / `shortcodeBalanceCheck` / `emptyContentCheck` exports are unchanged.

- [ ] **Step 6: Commit**

```bash
git add scripts/validate-tutorials.ts test/validate-tutorials-quarantine-post.test.ts
git commit -m "feat(#2585): validate-tutorials posts full-build quarantine snapshot (fail-open)"
```

---

## Task 6: Admin UI list view

**Files:**
- Create: `app/admin/quarantine-events/webapp/manifest.json`
- Create: `app/admin/quarantine-events/webapp/Component.js`
- Create: `app/admin/quarantine-events/webapp/i18n/i18n.properties`
- Modify: `app/admin-annotations.cds` (add `@UI` for `AdminService.QuarantineEventsCurrent`)

**Interfaces:**
- Consumes: `AdminService.QuarantineEventsCurrent` (Task 2) over `/admin/`.
- Produces: a discoverable admin component with app id `sap.tutorials.admin.quarantineEvents`, deep-linkable at `/admin-ui/#quarantineEventsCurrent-manage`, listing current quarantined slugs.

- [ ] **Step 1: Add Fiori annotations** in `app/admin-annotations.cds` (template: the `StepFailures` block):

```cds
annotate AdminService.QuarantineEventsCurrent with {
  slug       @Common.Label: 'Slug';
  reason     @Common.Label: 'Reason';
  sourceRepo @Common.Label: 'Source Repo';
  sourceFile @Common.Label: 'Source File';
  sourceUrl  @Common.Label: 'Source URL';
  buildAt    @Common.Label: 'Last Seen Build';
  runId      @Common.Label: 'Run';
};
annotate AdminService.QuarantineEventsCurrent with @(
  UI: {
    HeaderInfo: { TypeName: 'Quarantined Tutorial', TypeNamePlural: 'Quarantined Tutorials', Title: { Value: slug } },
    SelectionFields: [ sourceRepo, buildAt ],
    LineItem: [
      { Value: slug },
      { Value: reason },
      { Value: sourceRepo },
      { Value: sourceFile },
      { Value: buildAt },
      { $Type: 'UI.DataFieldWithUrl', Value: sourceUrl, Url: sourceUrl, Label: 'Source' }
    ]
  },
  Capabilities.DeleteRestrictions.Deletable: false,
  Capabilities.InsertRestrictions.Insertable: false,
  Capabilities.UpdateRestrictions.Updatable: false
);
```

- [ ] **Step 2: Create `Component.js`** (template: `app/admin/channels/webapp/Component.js`):

```js
sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
  "use strict";
  return AppComponent.extend("sap.tutorials.admin.quarantineEvents.Component", {
    metadata: { manifest: "json" }
  });
});
```

- [ ] **Step 3: Create `manifest.json`** (copy `app/admin/channels/webapp/manifest.json`, change ids/entity). Key values — `sap.app.id = sap.tutorials.admin.quarantineEvents`, dataSource `mainService` uri `/admin/`, ListReport `contextPath: /QuarantineEventsCurrent`, ObjectPage on the same, `crossNavigation.inbounds` key `QuarantineEventsCurrent-manage`:

```json
{
  "_version": "1.59.0",
  "sap.app": {
    "id": "sap.tutorials.admin.quarantineEvents",
    "type": "application",
    "title": "{{appTitle}}",
    "dataSources": {
      "mainService": {
        "uri": "/admin/",
        "type": "OData",
        "settings": { "odataVersion": "4.0" }
      }
    },
    "crossNavigation": {
      "inbounds": {
        "QuarantineEventsCurrent-manage": {
          "semanticObject": "QuarantineEventsCurrent",
          "action": "manage",
          "title": "{{appTitle}}",
          "signature": { "parameters": {}, "additionalParameters": "allowed" }
        }
      }
    }
  },
  "sap.ui": { "technology": "UI5", "deviceTypes": { "desktop": true, "tablet": true, "phone": true } },
  "sap.ui5": {
    "dependencies": {
      "minUI5Version": "1.120.0",
      "libs": { "sap.fe.templates": {} }
    },
    "models": {
      "i18n": { "type": "sap.ui.model.resource.ResourceModel", "settings": { "bundleName": "sap.tutorials.admin.quarantineEvents.i18n.i18n" } },
      "": {
        "dataSource": "mainService",
        "settings": { "synchronizationMode": "None", "operationMode": "Server", "autoExpandSelect": true, "earlyRequests": true }
      }
    },
    "routing": {
      "routes": [
        { "pattern": ":?query:", "name": "QuarantineEventsCurrentList", "target": "QuarantineEventsCurrentList" },
        { "pattern": "QuarantineEventsCurrent({key}):?query:", "name": "QuarantineEventsCurrentObjectPage", "target": "QuarantineEventsCurrentObjectPage" }
      ],
      "targets": {
        "QuarantineEventsCurrentList": {
          "type": "Component", "id": "QuarantineEventsCurrentList", "name": "sap.fe.templates.ListReport",
          "options": { "settings": { "contextPath": "/QuarantineEventsCurrent", "variantManagement": "Page", "initialLoad": true } }
        },
        "QuarantineEventsCurrentObjectPage": {
          "type": "Component", "id": "QuarantineEventsCurrentObjectPage", "name": "sap.fe.templates.ObjectPage",
          "options": { "settings": { "contextPath": "/QuarantineEventsCurrent" } }
        }
      }
    }
  }
}
```

> Before writing, open `app/admin/channels/webapp/manifest.json` and match its exact `_version`, `minUI5Version`, and any project-specific blocks (e.g. `sap.fe` config). Prefer the real template's values over the ones above where they differ.

- [ ] **Step 4: Create `i18n/i18n.properties`:**

```properties
appTitle=Quarantined Tutorials
appDescription=Tutorials dropped from the active content snapshot by pre-publish validation
```

- [ ] **Step 5: Verify auto-discovery picks it up**

Run: `node app/admin-shell/scripts/discover-admin-components.js`
Expected: output lists `sap.tutorials.admin.quarantineEvents` among discovered components (exact invocation may be via an npm script — check `app/admin-shell/package.json`; if it's `generate-manifest.js`, run that and confirm the generated shell manifest now contains a `quarantineEvents` componentUsage). No "app id mismatch" error.

- [ ] **Step 6: Verify the CDS model still compiles with the new annotations**

Run: `npx cds compile srv 2>&1 | grep -iE "error|quarantine" | head`
Expected: no errors referencing `QuarantineEventsCurrent`.

- [ ] **Step 7: Commit**

```bash
git add app/admin/quarantine-events app/admin-annotations.cds
git commit -m "feat(#2585): Admin UI list view for current quarantined tutorials"
```

---

## Task 7: Workflow env wiring — `.github/workflows/rebuild-content.yml`

**Files:**
- Modify: `.github/workflows/rebuild-content.yml` ("Validate tutorials" step, line ~631-633)

**Interfaces:**
- Consumes: `steps.srv.outputs.srv_url`, `secrets.CONTENT_API_KEY`, `github.run_id`, `github.server_url`, `github.repository`, `steps.mode.outputs.effective_mode` (all confirmed present in the current file).
- Produces: the validator receives `CAP_BASE_URL`, `CONTENT_API_KEY`, `RUN_ID`, `WORKFLOW_URL`, and `QUARANTINE_REPORT=full` only on a full build.

- [ ] **Step 1: Add the `env:` block to the validate step**

Replace lines ~631-633:

```yaml
      - name: Validate tutorials
        if: ${{ steps.mode.outputs.effective_mode != 'catalog-only' }}
        run: npm run validate-tutorials
```

with:

```yaml
      - name: Validate tutorials
        if: ${{ steps.mode.outputs.effective_mode != 'catalog-only' }}
        env:
          CAP_BASE_URL: ${{ steps.srv.outputs.srv_url }}
          CONTENT_API_KEY: ${{ secrets.CONTENT_API_KEY }}
          RUN_ID: ${{ github.run_id }}
          WORKFLOW_URL: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}
          QUARANTINE_REPORT: ${{ steps.mode.outputs.effective_mode == 'full' && 'full' || '' }}
        run: npm run validate-tutorials
```

(Match the surrounding indentation exactly — the file uses 6-space step indentation under `steps:`. `CONTENT_API_KEY` uses the plain secret, matching the existing fetch step at line 470 — there is no `_QA` variant for this secret in this workflow.)

- [ ] **Step 2: Validate the workflow YAML**

Run: `npx yaml-lint .github/workflows/rebuild-content.yml 2>/dev/null || yq '.' .github/workflows/rebuild-content.yml > /dev/null && echo "valid YAML"`
Expected: `valid YAML` (or the actual repo lint command if one exists — check `package.json` scripts for a workflow lint). Confirm the `env:` keys are nested under the step, not the job.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/rebuild-content.yml
git commit -m "feat(#2585): wire quarantine-snapshot env into rebuild-content validate step"
```

---

## Task 8: Route-drift guard check + full test sweep

**Files:**
- Possibly modify: `scripts/check-srv-qa-route-drift.ts` (allowlist, only if the guard flags the new route)

**Interfaces:**
- Consumes: nothing new.
- Produces: a passing route-drift guard and a green unit-test run.

- [ ] **Step 1: Run the route-drift guard**

Run: `npx tsx scripts/check-srv-qa-route-drift.ts` (confirm the exact entrypoint — it's referenced near `srv/server.js:962`; it may be invoked via an npm script or at server boot).
Expected: PASS. If it fails complaining that `/content/quarantine-events` exists on srv but not srv-qa (or vice versa), add it to the guard's allowlist following the existing entries for other `/content/*` CI routes, then re-run.

- [ ] **Step 2: Run the full unit suite**

Run: `scripts/quiet-run.sh npm test`
Expected: PASS. (Wrapped in `quiet-run.sh` per repo policy — do not paste raw scrollback. Drill into `.quiet-logs/` only if it fails.) If any pre-existing unrelated test is flaky, note it but do not fix it here.

- [ ] **Step 3: Lint the CDS**

Run: `npx cds lint . 2>&1 | tail -20`
Expected: no new errors attributable to the quarantine files.

- [ ] **Step 4: Commit any guard change**

```bash
git add scripts/check-srv-qa-route-drift.ts
git commit -m "chore(#2585): allowlist /content/quarantine-events in route-drift guard"
```

(Skip this commit if Step 1 passed with no change.)

---

## Task 9: Open the PR

- [ ] **Step 1: Push the branch**

```bash
git push -u origin worktree-quarantine-2585
```

- [ ] **Step 2: Open a draft PR targeting DEV**

```bash
gh pr create --repo sap-tutorials/tutorials-ims --base DEV --draft \
  --title "feat(#2585): persist tutorial quarantine results + Admin UI view" \
  --body "Closes #2585. Full-rebuild quarantine sets now persist to HANA (QuarantineSnapshots + QuarantineEvents) via POST /content/quarantine-events and surface in the Admin UI (current set, auto-cleared by the next clean full build). Snapshot-per-build model; DB + Admin view only (no alerting); validator posts fail-open. See docs/superpowers/specs/2026-10-04-tutorial-quarantine-persistence-design.md."
```

- [ ] **Step 3: Report the PR URL to the user.**

---

## Self-Review

**1. Spec coverage:**
- New persistence entity capturing slug/reason/sourceRepo/manifestVersion/runId/workflowUrl/createdAt → Task 1 (`managed` gives `createdAt`). ✓
- Validator writes rows to HANA via authenticated endpoint instead of throwaway errors.json → Tasks 3-5 (errors.json is kept *in addition*, per the "or in addition to" wording). ✓
- Admin UI view: current quarantined tutorials, reason + source repo + last-seen build, sortable/filterable, link to source file → Task 6 (`QuarantineEventsCurrent`, LineItem, SelectionFields, DataFieldWithUrl). Fiori Elements LRs are sortable/filterable by default. ✓
- Clean slug aged-out → snapshot-per-build: next clean full build writes a snapshot without the slug → `QuarantineEventsCurrent` no longer shows it; empty-events case tested (Task 4 Step 1). ✓
- Reporting count over time / per repo → raw `QuarantineSnapshots` + `QuarantineEvents` projections (Task 2) with `createdAt`/`sourceRepo` support ad-hoc reporting; AnalyticsService SQL can group over them. ✓

**2. Placeholder scan:** No TBD/TODO; every code step has real content. The two "match the real template's values" notes (manifest `_version`, `discover` entrypoint) are verification instructions with a concrete fallback, not placeholders.

**3. Type consistency:** `quarantineIngestHandler(req,res)` named identically across Tasks 3/4; `postQuarantineSnapshot(events, env)` signature identical across Task 5 test + impl; entity/field names (`QuarantineSnapshots`, `QuarantineEvents`, `QuarantineEventsCurrent`, `isCurrent`, `eventCount`, `runId`, `buildAt`) consistent across Tasks 1/2/4/6. `buildAt` is the projection alias for `snapshot.createdAt` (Task 2) and is the field annotated/listed in Task 6. ✓

**Residual risks flagged for the executor (verify, don't assume):**
- `cds.utils.uuid()` + deep-insert of a composition with explicit child `ID`s — if the CAP version rejects explicit composition keys on insert, drop the child `ID` and let CAP generate them.
- The `where snapshot.isCurrent = true` projection must compile as a view on the current compiler; if it rejects the association path in a `where`, fall back to exposing `QuarantineEvents` + a bound filter in the manifest (spec option (b)).
- `discover-admin-components.js` exact invocation (direct node vs npm script) — confirm from `app/admin-shell/package.json`.
```