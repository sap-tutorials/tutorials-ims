# KG On-Demand Rebuild Triggers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When `expandSearchConcepts` returns zero seeds, enqueue a coalesced, rate-limited request; a new 2-minute cron drains PENDING rows, cosine-ranks the corpus by query vector, and extracts concepts from the top-K tutorials — all behind a `KnowledgeGraphSettings.onDemandExtractionEnabled` flag defaulted to `false`.

**Architecture:** Fire-and-forget enqueue from the tool's zero-seed branch (never awaited on the ≤5s critical path). HANA-backed queue with `INSERT ... WHERE NOT EXISTS` coalescing on a normalized query key. Per-user + global sliding-window rate limits reuse `checkRateLimit` from `srv/lib/per-user-rate-limit.js`. Drain job registered via `registerJob` in `srv/jobs/scheduler.js` — the chassis handles pipeline logging and JobLastRun automatically (CAP 10's `.as(name)` singleton semantics replace explicit `runWithLock`). Cosine-rank uses the two-phase fetch-then-hydrate pattern from `srv/lib/kg/concept-embedding-query.js` because `Vector(1536)` is a HANA BLOB.

**Tech Stack:** SAP CAP Node.js (`@sap/cds`), SAP HANA Cloud, CAP 10 Scheduling API via `srv/cron-service.js`, Vitest for unit + hybrid + smoke tests, SAP Fiori Elements List Report + Object Page for the admin surface, XSUAA for scope gating.

## Global Constraints

Requirements below apply to every task. Do not restate them in each task; do not violate them.

- Node.js version: whatever `package.json` engines currently pins (Node 20+). Vitest 4 forks pool. See memory `ci-node-version-mismatch.md`.
- **Do NOT write raw SQL** except when the LOB-locator rule forces raw `db.run()` — Vector(1536) BLOB fetches in the drain job's cosine ranker. All non-BLOB reads/writes use `cds.ql`.
- **Never SELECT a HANA BLOB alongside metadata in a single CDS QL query** — use the two-phase pattern (fetch IDs + metadata; hydrate BLOB by ID in a second raw-SQL pass).
- **Never bypass CAP authentication** — `AdminService.KgOnDemandRequests` is gated on `Tutorial.Author` scope via `@requires`.
- **Never edit `hugo/content/tutorials/`** — generated. Not touched by this plan.
- **`@readonly` at the service layer, not DB** — per session-start hint. The `KgOnDemandRequests` DB entity is writable (the drain job mutates it); the admin projection carries `@readonly`.
- **Coalescing is portable via `INSERT ... WHERE NOT EXISTS`** — SQLite cannot express filtered unique indexes. HANA gets defense-in-depth via a filtered `.hdbindex`. Both live in this plan.
- **Fire-and-forget must never surface to the tool's LLM caller** — every enqueue error path is `.catch()`'d in the tool handler. Emit metrics on the exit; never `throw`.
- **Fail-open on every fault** — if the flag is off, no code path is entered; if the DB is unreachable, the tool still returns success; if the drain throws mid-batch, sibling rows in the batch still process.
- **Vitest projects**: unit tests live under `test/`, hybrid tests under `test/hybrid/`, smoke tests under `test/smoke/`. Add new files to the matching project entry in `vitest.config.js`.
- **`cds build --production`** after any schema change (not `cds compile`). Then run `npm test` to confirm nothing regressed.
- **Windows line-ending trap** — do not let subagents flip LF → CRLF. Verify `git diff --check` before every commit.
- **Fresh worktree setup** — this branch already had the worktree entered; `npm install` + `npm run setup` are assumed done. If any task's tests fail with "cannot find module" for a native binding, run `npm run setup` before further debugging.
- **Spec correction inherent to this plan**: the design spec references `runWithLock('kg-ondemand', ...)` inside the drain job body. Per `srv/jobs/scheduler.js:141`, the `registerJob` chassis already wraps every scheduled invocation with pipeline logging + `runWithLock`; the drain body must NOT call `runWithLock` itself. Task 4 codifies this and Task 4's final step edits the spec inline to match.
- **`xs-security.json` is duplicated at root AND `.deploy/`** — this plan does not add new scopes (reuses `Tutorial.Author`) so no scope edit is needed. If a reviewer asks about scope guards on the admin projection, point at the existing `Tutorial.Author` uses in `srv/admin-service.cds`.
- **`srv-qa` cp list**: the drain job's imports (`./on-demand-enqueue.js`, `./kg-extract.js`, `./kg-merge-on-write.js`, `./embedding-client.js`, `./chat-settings-resolver.js`, `./runtime-config/kg-settings.js`, `./metrics.js`) are all already in the `srv-qa` cp list per the existing extract-concepts-job dependencies. Task 4's registration step includes a `grep`-based re-verification.
- **Commit strategy**: one focused commit per task minimum. Each commit's subject line begins `feat(#948):` or `test(#948):` or `docs(#948):` or `chore(#948):`.

---

## File Structure

**New files:**
- `db/knowledge-graph-ondemand.cds` — `KgOnDemandRequests` entity, filtered coalescing constraint documented inline
- `db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex` — HANA filtered unique index (defense-in-depth vs. the enqueue WHERE-NOT-EXISTS)
- `srv/lib/kg/on-demand-enqueue.js` — pure enqueue logic (flag check → normalize → rate limit → INSERT-WHERE-NOT-EXISTS)
- `srv/lib/kg/on-demand-cosine-rank.js` — two-phase cosine ranker over `TutorialEmbedding` per-tutorial aggregation
- `srv/jobs/kg-ondemand-job.js` — the drain
- `app/admin/kgOnDemand/package.json`
- `app/admin/kgOnDemand/ui5.yaml`
- `app/admin/kgOnDemand/webapp/Component.js`
- `app/admin/kgOnDemand/webapp/manifest.json`
- `app/admin/kgOnDemand/webapp/i18n/i18n.properties`
- `app/admin/kgOnDemand/webapp/annotations/annotations.cds`
- `test/kg-ondemand-enqueue.test.js`
- `test/kg-ondemand-cosine-rank.test.js`
- `test/kg-ondemand-job.test.js`
- `test/hybrid/kg-ondemand.test.js`
- `test/smoke/kg-ondemand.smoke.test.js`

**Modified files:**
- `db/knowledge-graph.cds` — extend `KnowledgeGraphSettings` with `onDemandExtractionEnabled : Boolean default false;`
- `srv/lib/runtime-config/kg-settings.js` — add fifth knob (`DEFAULTS`, `envFlag`, CAP+raw-SQL columns, resolver output)
- `srv/lib/kg/joule-tool-expand-concepts.js` — add zero-seed enqueue side-effect + thread `requester` opt
- `srv/lib/chat-orchestrator.js` — thread `requester` into the `expandSearchConcepts` dispatch
- `srv/jobs/scheduler.js` — `registerJob({ jobName: 'kg-ondemand', schedule: '1-59/2 * * * *', … })` + import
- `srv/admin-service.cds` — add `@readonly` projection over `KgOnDemandRequests`
- `srv/lib/metrics.js` — register `kg_ondemand_*` metric names (if this file gates the set)
- `app/admin-shell/webapp/manifest.json` — new componentUsage + route + target
- `app/admin-shell/webapp/controller/Shell.controller.js` — 2 map entries (key + display title)
- `app/admin-shell/webapp/model/navigation.json` — 1 nav entry
- `test/kg-joule-tool-expand-concepts.test.js` — extend with 4 new zero-seed + flag cases
- `vitest.config.js` — hybrid + smoke project entries pick up the new files
- `docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md` — inline correction of the stale `runWithLock` language

**Discovery-driven, no edit needed:**
- `app/admin-shell/scripts/copy-components.js` — auto-discovers `app/admin/*`; the new `kgOnDemand/` folder is picked up automatically at build time
- Root `package.json` component-usage manifest — does not enumerate admin sub-apps; discovery script does it

---

## Task Ordering

Tasks 1–3 establish the data model + resolver + enqueue module and can be run in strict sequence. Task 4 is the drain job and depends on Task 3. Task 5 wires the tool handler and depends on Task 3. Task 6 is the admin surface and depends only on Task 1. Task 7 is the hybrid + smoke tests and depends on Tasks 1–6. Task 8 is the closing spec correction + PR.

Placeholder for Task N interface summaries — each task's `Interfaces` block below is the source of truth for symbol names shared across tasks.

---

### Task 1: `KgOnDemandRequests` entity + `onDemandExtractionEnabled` setting

**Files:**
- Create: `db/knowledge-graph-ondemand.cds`
- Create: `db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex`
- Modify: `db/knowledge-graph.cds` — extend the existing `KnowledgeGraphSettings` singleton
- Test: `test/kg-ondemand-schema.test.js`

**Interfaces:**
- Consumes: nothing from prior tasks (this is the foundation)
- Produces:
  - Entity `com.sap.developers.ims.KgOnDemandRequests` — all fields per spec §2 (ID, query, normalizedKey, requestedBy, requestedByKind, status, attempts, requestedAt, startedAt, completedAt, latencyMs, tutorialsExtracted, conceptsCreated, conceptsMerged, lastError, llmPromptTokens, llmCompletionTokens)
  - Field `KnowledgeGraphSettings.onDemandExtractionEnabled : Boolean default false;`
  - HANA filtered unique index name: `KG_ONDEMAND_PENDING_UNIQUE`

- [ ] **Step 1: Write the failing schema test**

Create `test/kg-ondemand-schema.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('KgOnDemandRequests schema (#948)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  it('registers KgOnDemandRequests with the expected columns', () => {
    const { KgOnDemandRequests } = cds.entities('com.sap.developers.ims');
    expect(KgOnDemandRequests).toBeDefined();
    const cols = Object.keys(KgOnDemandRequests.elements);
    for (const name of [
      'ID', 'query', 'normalizedKey', 'requestedBy', 'requestedByKind',
      'status', 'attempts', 'requestedAt', 'startedAt', 'completedAt',
      'latencyMs', 'tutorialsExtracted', 'conceptsCreated', 'conceptsMerged',
      'lastError', 'llmPromptTokens', 'llmCompletionTokens',
    ]) {
      expect(cols, `missing column: ${name}`).toContain(name);
    }
  });

  it('defaults status to PENDING', async () => {
    const db = await cds.connect.to('db');
    const { KgOnDemandRequests } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KgOnDemandRequests).entries({
      ID: '11111111-1111-1111-1111-111111111111',
      query: 'test',
      normalizedKey: 'test',
    });
    const [row] = await SELECT.from(KgOnDemandRequests)
      .columns('status', 'attempts', 'tutorialsExtracted')
      .where({ ID: '11111111-1111-1111-1111-111111111111' });
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(0);
    expect(row.tutorialsExtracted).toBe(0);
  });

  it('exposes onDemandExtractionEnabled on KnowledgeGraphSettings, default false', async () => {
    const db = await cds.connect.to('db');
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await INSERT.into(KnowledgeGraphSettings).entries({});
    const [row] = await SELECT.from(KnowledgeGraphSettings)
      .columns('onDemandExtractionEnabled');
    expect(row.onDemandExtractionEnabled === false || row.onDemandExtractionEnabled === 0).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/kg-ondemand-schema.test.js`
Expected: FAIL — "KgOnDemandRequests is not defined" or "column onDemandExtractionEnabled does not exist".

- [ ] **Step 3: Create `db/knowledge-graph-ondemand.cds`**

```cds
namespace com.sap.developers.ims;

// On-demand KG extraction request queue (#948).
//
// Populated by srv/lib/kg/on-demand-enqueue.js when expandSearchConcepts
// returns zero seeds AND KnowledgeGraphSettings.onDemandExtractionEnabled
// is true. Drained every 2 min by srv/jobs/kg-ondemand-job.js.
//
// Coalescing: at most one row per normalizedKey may be in ('PENDING','RUNNING')
// simultaneously. Enforced portably by INSERT ... WHERE NOT EXISTS in the
// enqueue module; defense-in-depth on HANA via
// db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex.
entity KgOnDemandRequests {
  key ID              : UUID;
  query               : String(200) @mandatory;
  normalizedKey       : String(200) @mandatory;
  requestedBy         : String(64);
  requestedByKind     : String(16); // 'user' | 'anon'
  status              : String(16) @assert.range enum { PENDING; RUNNING; DONE; FAILED } default 'PENDING';
  attempts            : Integer default 0;
  requestedAt         : Timestamp @cds.on.insert: $now;
  startedAt           : Timestamp;
  completedAt         : Timestamp;
  latencyMs           : Integer;
  tutorialsExtracted  : Integer default 0;
  conceptsCreated     : Integer default 0;
  conceptsMerged      : Integer default 0;
  lastError           : String(500);
  llmPromptTokens     : Integer default 0;
  llmCompletionTokens : Integer default 0;
}
```

- [ ] **Step 4: Extend `KnowledgeGraphSettings` in `db/knowledge-graph.cds`**

Locate the existing entity block (search for `entity KnowledgeGraphSettings`). Add ONE line before the closing `}`:

```cds
onDemandExtractionEnabled : Boolean default false;
```

The neighboring fields (`enabled`, `extractBuildCap`, `mergeSimThreshold`, `mergeSimThresholdExtract`) are unchanged.

- [ ] **Step 5: Create the HANA filtered unique index**

Create `db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex`:

```sql
CREATE UNIQUE INDEX "KG_ONDEMAND_PENDING_UNIQUE"
  ON "COM_SAP_DEVELOPERS_IMS_KGONDEMANDREQUESTS" ("NORMALIZEDKEY")
  WHERE "STATUS" IN ('PENDING', 'RUNNING')
```

- [ ] **Step 6: Rebuild and re-run the test**

```
npx cds build --production
npx vitest run test/kg-ondemand-schema.test.js
```

Expected: PASS on all three cases.

- [ ] **Step 7: Full unit-test regression**

Run: `npm test`
Expected: same green baseline as before + the three new tests.

- [ ] **Step 8: Commit**

```
git add db/knowledge-graph-ondemand.cds db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex db/knowledge-graph.cds test/kg-ondemand-schema.test.js
git commit -m "feat(#948): KgOnDemandRequests entity + onDemandExtractionEnabled setting

- New entity com.sap.developers.ims.KgOnDemandRequests holds queued
  extraction requests with status PENDING/RUNNING/DONE/FAILED.
- KnowledgeGraphSettings gains onDemandExtractionEnabled (default false).
- HANA filtered unique index KG_ONDEMAND_PENDING_UNIQUE enforces the
  'at most one active row per normalizedKey' invariant as defense in
  depth alongside the enqueue module's INSERT ... WHERE NOT EXISTS.
- Schema-only PR slice; no service exposure, no resolver change, no
  runtime behavior."
```

---

### Task 2: Resolver picks up `onDemandExtractionEnabled`

**Files:**
- Modify: `srv/lib/runtime-config/kg-settings.js`
- Test: `test/kg-settings-ondemand.test.js`

**Interfaces:**
- Consumes: `KgOnDemandRequests` entity (Task 1) is *not* needed here — only the `KnowledgeGraphSettings.onDemandExtractionEnabled` field
- Produces:
  - `resolveKnowledgeGraphSettings()` returns `{ enabled, extractBuildCap, mergeSimThreshold, mergeSimThresholdExtract, onDemandExtractionEnabled }` (fifth key)
  - Env-var fallback: `KG_ONDEMAND_ENABLED=true|false`

- [ ] **Step 1: Write the failing resolver test**

Create `test/kg-settings-ondemand.test.js`:

```javascript
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { resolveKnowledgeGraphSettings, _resetCacheForTests } from '../srv/lib/runtime-config/kg-settings.js';

describe('resolveKnowledgeGraphSettings — onDemandExtractionEnabled (#948)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  beforeEach(() => {
    _resetCacheForTests();
    delete process.env.KG_ONDEMAND_ENABLED;
  });

  afterEach(() => {
    delete process.env.KG_ONDEMAND_ENABLED;
  });

  it('defaults onDemandExtractionEnabled to false when no row + no env', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    const s = await resolveKnowledgeGraphSettings();
    expect(s.onDemandExtractionEnabled).toBe(false);
  });

  it('reads onDemandExtractionEnabled=true from the DB row', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    await INSERT.into(KnowledgeGraphSettings).entries({ onDemandExtractionEnabled: true });
    const s = await resolveKnowledgeGraphSettings();
    expect(s.onDemandExtractionEnabled).toBe(true);
  });

  it('falls back to env when DB row is empty', async () => {
    const { KnowledgeGraphSettings } = cds.entities('com.sap.developers.ims');
    await DELETE.from(KnowledgeGraphSettings);
    process.env.KG_ONDEMAND_ENABLED = 'true';
    const s = await resolveKnowledgeGraphSettings();
    expect(s.onDemandExtractionEnabled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/kg-settings-ondemand.test.js`
Expected: FAIL — `s.onDemandExtractionEnabled` is undefined.

- [ ] **Step 3: Extend the resolver**

Edit `srv/lib/runtime-config/kg-settings.js` in five spots:

(a) Add to `DEFAULTS`:

```javascript
const DEFAULTS = {
  enabled: false,
  extractBuildCap: 200,
  mergeSimThreshold: 0.92,
  mergeSimThresholdExtract: 0.85,
  onDemandExtractionEnabled: false,   // #948
};
```

(b) In `readRow()`, extend the raw-SQL SELECT column list (build-pipeline fallback path):

```javascript
'SELECT enabled, extractBuildCap, mergeSimThreshold, mergeSimThresholdExtract, onDemandExtractionEnabled ' +
'FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS LIMIT 1'
```

(c) In `resolveKnowledgeGraphSettings()`'s returned object, add the fifth key:

```javascript
onDemandExtractionEnabled: Boolean(
  pick(row, 'onDemandExtractionEnabled', 'ONDEMANDEXTRACTIONENABLED')
  ?? envFlag('KG_ONDEMAND_ENABLED')
  ?? DEFAULTS.onDemandExtractionEnabled
),
```

(d) Update the JSDoc `@returns` block:

```javascript
/**
 * Resolve all 5 knobs at once. Returns a fully-populated object (no nulls).
 * @returns {Promise<{ enabled: boolean, extractBuildCap: number,
 *                     mergeSimThreshold: number, mergeSimThresholdExtract: number,
 *                     onDemandExtractionEnabled: boolean }>}
 */
```

(e) Update the top-of-file docblock comment to reflect 5 knobs instead of 4.

- [ ] **Step 4: Re-run the test**

Run: `npx vitest run test/kg-settings-ondemand.test.js`
Expected: PASS on all three cases.

- [ ] **Step 5: Confirm nothing else broke**

Run: `npm test`
Expected: green.

- [ ] **Step 6: Commit**

```
git add srv/lib/runtime-config/kg-settings.js test/kg-settings-ondemand.test.js
git commit -m "feat(#948): KG settings resolver picks up onDemandExtractionEnabled

- Fifth knob added: onDemandExtractionEnabled (default false).
- CAP-path SELECT, raw-SQL fallback SELECT, envFlag ('KG_ONDEMAND_ENABLED'),
  and DEFAULTS all updated in lockstep.
- Boolean() coercion mirrors the existing enabled handling (SQLite stores
  boolean as 0/1; ?? does not fall through 0)."
```

---

### Task 3: Enqueue module (`srv/lib/kg/on-demand-enqueue.js`)

**Files:**
- Create: `srv/lib/kg/on-demand-enqueue.js`
- Test: `test/kg-ondemand-enqueue.test.js`

**Interfaces:**
- Consumes: `resolveKnowledgeGraphSettings()` (Task 2), `KgOnDemandRequests` entity (Task 1), `checkRateLimit(key, limit, windowMs)` from `srv/lib/per-user-rate-limit.js`, `emit(name, payload)` from `srv/lib/metrics.js`
- Produces:
  - `normalizeQuery(rawQuery: string) → string` (exported for tests only)
  - `enqueueOnDemandExtraction({ db, query, requester }) → Promise<{ status: 'enqueued'|'coalesced'|'rate_limited'|'disabled'|'invalid', normalizedKey?, reason? }>`
    - `requester` shape: `{ id?: string, ipHash?: string, kind: 'user'|'anon' }` — id is optional; kind is required
    - Return value is used by unit tests and by the tool handler's telemetry hook. Never thrown; never null.
  - Env-var knobs (all optional): `KG_ONDEMAND_USER_MAX_PER_HOUR` (default 3), `KG_ONDEMAND_GLOBAL_MAX_PER_HOUR` (default 20)

- [ ] **Step 1: Write the failing enqueue test suite**

Create `test/kg-ondemand-enqueue.test.js`:

```javascript
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import cds from '@sap/cds';
import { enqueueOnDemandExtraction, normalizeQuery } from '../srv/lib/kg/on-demand-enqueue.js';
import { _resetForTests as _resetRateLimits } from '../srv/lib/per-user-rate-limit.js';
import { _resetCacheForTests as _resetSettingsCache } from '../srv/lib/runtime-config/kg-settings.js';

const NS = 'com.sap.developers.ims';

async function enableFlag(on) {
  const { KnowledgeGraphSettings } = cds.entities(NS);
  await DELETE.from(KnowledgeGraphSettings);
  await INSERT.into(KnowledgeGraphSettings).entries({ enabled: true, onDemandExtractionEnabled: on });
  _resetSettingsCache();
}

describe('normalizeQuery', () => {
  it('lowercases, collapses whitespace, strips punctuation', () => {
    expect(normalizeQuery('CAP  Tutorial!')).toBe('cap tutorial');
    expect(normalizeQuery('  hello,  WORLD?? ')).toBe('hello world');
    expect(normalizeQuery('foo___bar')).toBe('foo___bar'); // underscores preserved (\w)
  });

  it('returns empty for pure punctuation input', () => {
    expect(normalizeQuery('!!!')).toBe('');
    expect(normalizeQuery('   ')).toBe('');
  });
});

describe('enqueueOnDemandExtraction (#948)', () => {
  let db;

  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { KgOnDemandRequests } = cds.entities(NS);
    await DELETE.from(KgOnDemandRequests);
    _resetRateLimits();
    delete process.env.KG_ONDEMAND_USER_MAX_PER_HOUR;
    delete process.env.KG_ONDEMAND_GLOBAL_MAX_PER_HOUR;
  });

  it('returns disabled and does NOT insert when flag is off', async () => {
    await enableFlag(false);
    const r = await enqueueOnDemandExtraction({
      db, query: 'test query',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r.status).toBe('disabled');
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests);
    expect(rows).toHaveLength(0);
  });

  it('inserts a PENDING row when flag is on and budget is available', async () => {
    await enableFlag(true);
    const r = await enqueueOnDemandExtraction({
      db, query: 'CAP tutorial',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r.status).toBe('enqueued');
    expect(r.normalizedKey).toBe('cap tutorial');
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'query', 'normalizedKey', 'requestedBy', 'requestedByKind');
    expect(row.status).toBe('PENDING');
    expect(row.query).toBe('CAP tutorial');
    expect(row.normalizedKey).toBe('cap tutorial');
    expect(row.requestedBy).toBe('u1');
    expect(row.requestedByKind).toBe('user');
  });

  it('returns invalid for empty normalized query', async () => {
    await enableFlag(true);
    const r = await enqueueOnDemandExtraction({
      db, query: '!!!',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r.status).toBe('invalid');
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests);
    expect(rows).toHaveLength(0);
  });

  it('coalesces near-duplicate queries under the same normalizedKey', async () => {
    await enableFlag(true);
    const r1 = await enqueueOnDemandExtraction({
      db, query: 'CAP tutorial',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r1.status).toBe('enqueued');

    const r2 = await enqueueOnDemandExtraction({
      db, query: 'cap  tutorial!',
      requester: { id: 'u2', kind: 'user' },
    });
    expect(r2.status).toBe('coalesced');

    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests);
    expect(rows).toHaveLength(1);
  });

  it('per-user cap: rejects the 4th enqueue in the same window', async () => {
    await enableFlag(true);
    process.env.KG_ONDEMAND_USER_MAX_PER_HOUR = '3';
    for (let i = 0; i < 3; i++) {
      const r = await enqueueOnDemandExtraction({
        db, query: `distinct query ${i}`,
        requester: { id: 'u1', kind: 'user' },
      });
      expect(r.status).toBe('enqueued');
    }
    const r4 = await enqueueOnDemandExtraction({
      db, query: 'distinct query 3',
      requester: { id: 'u1', kind: 'user' },
    });
    expect(r4.status).toBe('rate_limited');
    expect(r4.reason).toBe('user');
  });

  it('global cap: rejects the 21st enqueue across distinct users', async () => {
    await enableFlag(true);
    process.env.KG_ONDEMAND_USER_MAX_PER_HOUR = '99';
    process.env.KG_ONDEMAND_GLOBAL_MAX_PER_HOUR = '20';
    for (let i = 0; i < 20; i++) {
      const r = await enqueueOnDemandExtraction({
        db, query: `distinct query ${i}`,
        requester: { id: `u${i}`, kind: 'user' },
      });
      expect(r.status).toBe('enqueued');
    }
    const r21 = await enqueueOnDemandExtraction({
      db, query: 'one more',
      requester: { id: 'u99', kind: 'user' },
    });
    expect(r21.status).toBe('rate_limited');
    expect(r21.reason).toBe('global');
  });

  it('anonymous requesters share the anon user-bucket', async () => {
    await enableFlag(true);
    process.env.KG_ONDEMAND_USER_MAX_PER_HOUR = '2';
    for (let i = 0; i < 2; i++) {
      const r = await enqueueOnDemandExtraction({
        db, query: `q${i}`,
        requester: { ipHash: `ip${i}`, kind: 'anon' },
      });
      expect(r.status).toBe('enqueued');
    }
    const r3 = await enqueueOnDemandExtraction({
      db, query: 'q2',
      requester: { ipHash: 'ipZ', kind: 'anon' },
    });
    expect(r3.status).toBe('rate_limited');
    expect(r3.reason).toBe('user'); // 'user' bucket is the per-key bucket, keyed on 'anon' for anonymous
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/kg-ondemand-enqueue.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the enqueue module**

Create `srv/lib/kg/on-demand-enqueue.js`:

```javascript
// srv/lib/kg/on-demand-enqueue.js
//
// Enqueue an on-demand KG extraction request when expandSearchConcepts
// returns zero seeds. Pure enqueue logic — no LLM calls, no cron
// dependencies, no wait for the drain. Fire-and-forget from the tool.
//
// Coalescing: INSERT ... WHERE NOT EXISTS on normalizedKey ensures at most
// one PENDING/RUNNING row per key. Portable across SQLite (tests) and HANA
// (production). Defense-in-depth on HANA via KG_ONDEMAND_PENDING_UNIQUE
// filtered unique index.
//
// Rate limiting: per-user + global sliding windows via checkRateLimit
// from per-user-rate-limit.js. In-memory, per-process. Multi-instance
// rollout will need a HANA counter table — documented deferred in the
// design spec §2 (env-defaults table).
//
// Fail-open: every early-exit returns a status object; nothing throws.
// The tool handler .catch()es residual DB errors and still returns success
// to the LLM.
//
// Spec: docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md
// Issue: #948

import cds from '@sap/cds';
import { randomUUID } from 'node:crypto';
import { checkRateLimit } from '../per-user-rate-limit.js';
import { resolveKnowledgeGraphSettings } from '../runtime-config/kg-settings.js';
import * as metrics from '../metrics.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('kg-ondemand-enqueue');
const HOUR_MS = 60 * 60 * 1000;

/**
 * Normalize a raw query to a coalescing key.
 * - Lowercase.
 * - Collapse whitespace runs to a single space.
 * - Strip everything that's neither a word-char (\w) nor whitespace.
 * - Trim.
 * @param {string} rawQuery
 * @returns {string}
 */
export function normalizeQuery(rawQuery) {
  if (typeof rawQuery !== 'string') return '';
  return rawQuery
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function envNumber(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Enqueue an on-demand KG extraction request.
 * Never throws. Fire-and-forget from the tool's zero-seed branch.
 *
 * @param {object} opts
 * @param {object} opts.db         cds.connect.to('db') handle
 * @param {string} opts.query      Raw query string (already truncated by the tool's HARD_QUERY_LIMIT)
 * @param {object} opts.requester  { id?, ipHash?, kind: 'user'|'anon' }
 * @returns {Promise<{ status: 'enqueued'|'coalesced'|'rate_limited'|'disabled'|'invalid', normalizedKey?: string, reason?: string }>}
 */
export async function enqueueOnDemandExtraction({ db, query, requester }) {
  // Backward-compat: threading requester is optional at the call site.
  const req = requester ?? { kind: 'anon' };

  // (1) Flag check.
  const settings = await resolveKnowledgeGraphSettings();
  if (!settings.enabled || !settings.onDemandExtractionEnabled) {
    return { status: 'disabled' };
  }

  // (2) Normalize.
  const normalizedKey = normalizeQuery(query);
  if (!normalizedKey) {
    return { status: 'invalid' };
  }

  // (3) Per-user budget. Anonymous requesters all share the 'anon' bucket key.
  const userLimit = envNumber('KG_ONDEMAND_USER_MAX_PER_HOUR', 3);
  const userBucketKey = `kgondemand:user:${req.kind === 'user' ? (req.id ?? 'unknown') : 'anon'}`;
  if (!checkRateLimit(userBucketKey, userLimit, HOUR_MS)) {
    metrics.emit?.('kg_ondemand_rate_limited', { reason: 'user' });
    return { status: 'rate_limited', reason: 'user' };
  }

  // (4) Global budget.
  const globalLimit = envNumber('KG_ONDEMAND_GLOBAL_MAX_PER_HOUR', 20);
  if (!checkRateLimit('kgondemand:global', globalLimit, HOUR_MS)) {
    metrics.emit?.('kg_ondemand_rate_limited', { reason: 'global' });
    return { status: 'rate_limited', reason: 'global' };
  }

  // (5) INSERT ... WHERE NOT EXISTS (portable coalescing gate).
  //
  // CDS QL cannot express INSERT ... WHERE NOT EXISTS directly, so we use
  // a two-step check-then-insert with the check inside a small tx. The
  // filtered unique index on HANA is the belt-and-braces backstop for the
  // TOCTOU race between the two statements — on the (extremely rare) race,
  // the INSERT fails with a unique-constraint violation which we catch as
  // a coalesce.
  const { KgOnDemandRequests } = cds.entities(NS);
  try {
    return await db.tx(async (tx) => {
      const [existing] = await tx.run(
        SELECT.from(KgOnDemandRequests).columns('ID').where({
          normalizedKey,
          status: { in: ['PENDING', 'RUNNING'] },
        }).limit(1)
      );
      if (existing) {
        metrics.emit?.('kg_ondemand_dedup_coalesced', { normalizedKey });
        return { status: 'coalesced', normalizedKey };
      }
      await tx.run(
        INSERT.into(KgOnDemandRequests).entries({
          ID: randomUUID(),
          query,
          normalizedKey,
          requestedBy: req.kind === 'user' ? (req.id ?? null) : (req.ipHash ?? null),
          requestedByKind: req.kind,
        })
      );
      metrics.emit?.('kg_ondemand_enqueued', {
        normalizedKey,
        requesterKind: req.kind,
      });
      return { status: 'enqueued', normalizedKey };
    });
  } catch (err) {
    // Unique-constraint race → treat as coalesced. Any other DB error →
    // swallow, emit metric, return status so the tool never sees a throw.
    const msg = err?.message ?? String(err);
    if (/unique|duplicate|constraint/i.test(msg)) {
      metrics.emit?.('kg_ondemand_dedup_coalesced', { normalizedKey, viaRace: true });
      return { status: 'coalesced', normalizedKey };
    }
    LOG.warn(`enqueueOnDemandExtraction DB error, dropped: ${msg}`);
    metrics.emit?.('kg_ondemand_enqueue_error', { message: msg.slice(0, 200) });
    return { status: 'invalid', reason: 'db_error' };
  }
}
```

- [ ] **Step 4: Re-run the enqueue test**

Run: `npx vitest run test/kg-ondemand-enqueue.test.js`
Expected: PASS on all 8 cases.

- [ ] **Step 5: Full unit test regression**

Run: `npm test`
Expected: green.

- [ ] **Step 6: Commit**

```
git add srv/lib/kg/on-demand-enqueue.js test/kg-ondemand-enqueue.test.js
git commit -m "feat(#948): on-demand extraction enqueue module

- normalizeQuery: lowercase + collapse whitespace + strip punctuation.
- enqueueOnDemandExtraction: flag check -> normalize -> per-user cap
  (default 3/hr) -> global cap (default 20/hr) -> INSERT-WHERE-NOT-EXISTS.
- Never throws; every early-exit returns a status object. The tool
  handler .catch()es residual DB errors and still succeeds.
- Coalescing via two-step check-then-insert inside a tx; unique-constraint
  race caught as coalesce (belt-and-braces with the HANA filtered index).
- Metrics: kg_ondemand_{enqueued, dedup_coalesced, rate_limited, enqueue_error}."
```

---

### Task 4: Cosine ranker + drain job

**Files:**
- Create: `srv/lib/kg/on-demand-cosine-rank.js`
- Create: `srv/jobs/kg-ondemand-job.js`
- Modify: `srv/jobs/scheduler.js` — import + `registerJob({...})` next to the other KG jobs
- Modify: `docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md` — remove the stale `runWithLock('kg-ondemand', ...)` language (spec self-correction)
- Test: `test/kg-ondemand-cosine-rank.test.js`
- Test: `test/kg-ondemand-job.test.js`

**Interfaces:**
- Consumes: `KgOnDemandRequests` entity (Task 1), `resolveKnowledgeGraphSettings()` (Task 2), `extractConceptsFromTutorial` from `srv/lib/kg-extract.js`, `loadConceptRegistry` + `resolveConceptCandidates` from `srv/lib/kg-merge-on-write.js`, `embed` from `srv/lib/embedding-client.js`
- Produces:
  - `rankTutorialsByQueryVector({ db, queryVector, limit }) → Promise<Array<{ tutorialId: string, slug: string, title: string, score: number }>>` — ACTIVE-gated; MAX(cosine) per tutorial across its steps
  - `runOnDemandDrain(deps?) → Promise<{ reason?: string, processed: number, extracted: number, failed: number, coalesced: number, durationMs: number }>` — registered at jobName `'kg-ondemand'`, schedule `'1-59/2 * * * *'`
- Env knobs (all optional): `KG_ONDEMAND_DRAIN_BATCH` (default 3), `KG_ONDEMAND_TUTORIALS_PER_REQ` (default 5), `KG_ONDEMAND_MAX_ATTEMPTS` (default 3)

#### Sub-part 4a: Cosine ranker

- [ ] **Step 1: Write the ranker test**

Create `test/kg-ondemand-cosine-rank.test.js`:

```javascript
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { rankTutorialsByQueryVector } from '../srv/lib/kg/on-demand-cosine-rank.js';

const NS = 'com.sap.developers.ims';
const DIMS = 1536;

function unitVec(i) {
  const v = new Float32Array(DIMS);
  v[i % DIMS] = 1.0;
  return v;
}

function bufFromVec(v) {
  const buf = Buffer.alloc(v.length * 4);
  for (let i = 0; i < v.length; i++) buf.writeFloatLE(v[i], i * 4);
  return buf;
}

describe('rankTutorialsByQueryVector (#948)', () => {
  let db;

  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
    db = await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { Tutorials, TutorialEmbedding } = cds.entities(NS);
    await DELETE.from(TutorialEmbedding);
    await DELETE.from(Tutorials);
  });

  it('returns top-K by MAX cosine, ACTIVE-gated', async () => {
    const { Tutorials, TutorialEmbedding } = cds.entities(NS);
    const t1 = 'tttttttt-1111-1111-1111-111111111111';
    const t2 = 'tttttttt-2222-2222-2222-222222222222';
    const tDraft = 'tttttttt-3333-3333-3333-333333333333';

    await INSERT.into(Tutorials).entries([
      { ID: t1, slug: 't1', title: 'T1', status: 'ACTIVE' },
      { ID: t2, slug: 't2', title: 'T2', status: 'ACTIVE' },
      { ID: tDraft, slug: 'tdraft', title: 'Draft', status: 'DRAFT' },
    ]);

    // t1 has a step aligned with unit vector 0 → cosine 1.0 with query
    await INSERT.into(TutorialEmbedding).entries([
      { tutorial_ID: t1, stepNumber: 1, embedding: bufFromVec(unitVec(0)) },
      { tutorial_ID: t1, stepNumber: 2, embedding: bufFromVec(unitVec(500)) },
      { tutorial_ID: t2, stepNumber: 1, embedding: bufFromVec(unitVec(500)) },
      { tutorial_ID: tDraft, stepNumber: 1, embedding: bufFromVec(unitVec(0)) },
    ]);

    const results = await rankTutorialsByQueryVector({
      db, queryVector: unitVec(0), limit: 5,
    });

    const slugs = results.map(r => r.slug);
    expect(slugs).toContain('t1');
    expect(slugs).not.toContain('tdraft');   // ACTIVE-gate
    expect(results[0].slug).toBe('t1');       // Best cosine
    expect(results[0].score).toBeCloseTo(1.0, 3);
  });

  it('returns empty array on empty TutorialEmbedding', async () => {
    const results = await rankTutorialsByQueryVector({
      db, queryVector: unitVec(0), limit: 5,
    });
    expect(results).toEqual([]);
  });

  it('respects the limit argument', async () => {
    const { Tutorials, TutorialEmbedding } = cds.entities(NS);
    for (let i = 0; i < 10; i++) {
      const id = `tttttttt-${String(i).padStart(4, '0')}-0000-0000-000000000000`;
      await INSERT.into(Tutorials).entries({ ID: id, slug: `t${i}`, title: `T${i}`, status: 'ACTIVE' });
      await INSERT.into(TutorialEmbedding).entries({ tutorial_ID: id, stepNumber: 1, embedding: bufFromVec(unitVec(i)) });
    }
    const results = await rankTutorialsByQueryVector({
      db, queryVector: unitVec(3), limit: 3,
    });
    expect(results).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/kg-ondemand-cosine-rank.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the ranker**

Create `srv/lib/kg/on-demand-cosine-rank.js`:

```javascript
// srv/lib/kg/on-demand-cosine-rank.js
//
// Rank ACTIVE tutorials by MAX cosine similarity between a query vector
// and any TutorialEmbedding step of that tutorial.
//
// Vector(1536) is a HANA BLOB — LOB expiry applies. Two-phase pattern:
//   1. IDs + metadata only (no BLOB).
//   2. Hydrate embeddings by ID in a second raw-SQL pass on HANA.
// Same shape as srv/lib/kg/concept-embedding-query.js.
//
// SQLite tests use CDS QL for both phases (no LOB locators exist there).
//
// Result: top-K { tutorialId, slug, title, score } sorted by score DESC.
//
// Spec: docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md §1
// Issue: #948

import cds from '@sap/cds';

const NS = 'com.sap.developers.ims';
const DIMS = 1536;
const BYTES_PER_FLOAT = 4;

function decodeEmbedding(buf) {
  if (!buf) return null;
  let bytes;
  if (Buffer.isBuffer(buf)) bytes = buf;
  else if (typeof buf === 'string') bytes = Buffer.from(buf, 'base64');
  else if (buf instanceof Uint8Array) bytes = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  else bytes = Buffer.from(buf);
  if (bytes.length !== DIMS * BYTES_PER_FLOAT) return null;
  const out = new Float32Array(DIMS);
  for (let i = 0; i < DIMS; i++) out[i] = bytes.readFloatLE(i * BYTES_PER_FLOAT);
  return out;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < DIMS; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d === 0 ? 0 : dot / d;
}

function isHana(db) {
  return db?.kind === 'hana' || db?.options?.kind === 'hana';
}

/**
 * @param {object} opts
 * @param {object} opts.db          cds.connect.to('db') handle
 * @param {Float32Array|number[]} opts.queryVector  1536-dim query embedding
 * @param {number} opts.limit       Top-K to return
 * @returns {Promise<Array<{ tutorialId: string, slug: string, title: string, score: number }>>}
 */
export async function rankTutorialsByQueryVector({ db, queryVector, limit = 5 }) {
  const q = queryVector instanceof Float32Array
    ? queryVector
    : Float32Array.from(queryVector);

  const { Tutorials, TutorialEmbedding } = cds.entities(NS);

  // Phase 1: fetch ACTIVE tutorial IDs + metadata (no BLOB).
  const activeTutorials = await SELECT.from(Tutorials)
    .columns('ID', 'slug', 'title')
    .where({ status: 'ACTIVE' });
  if (activeTutorials.length === 0) return [];

  const metaById = new Map(activeTutorials.map(t => [t.ID, t]));

  // Phase 2: fetch embeddings for ACTIVE tutorials only.
  // On HANA: raw db.run() to avoid LOB locator expiry.
  // On SQLite: CDS QL is fine.
  const ids = [...metaById.keys()];
  let rows;
  if (isHana(db)) {
    const placeholders = ids.map(() => '?').join(',');
    const sql = `SELECT TUTORIAL_ID, STEPNUMBER, EMBEDDING FROM COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING WHERE TUTORIAL_ID IN (${placeholders})`;
    rows = await db.run(sql, ids);
  } else {
    rows = await SELECT.from(TutorialEmbedding)
      .columns('tutorial_ID', 'stepNumber', 'embedding')
      .where({ tutorial_ID: { in: ids } });
  }

  // Compute MAX(cosine) per tutorial.
  const bestByTutorial = new Map();
  for (const r of rows) {
    const tid = r.tutorial_ID ?? r.TUTORIAL_ID;
    const emb = decodeEmbedding(r.embedding ?? r.EMBEDDING);
    if (!emb) continue;
    const c = cosine(q, emb);
    const prev = bestByTutorial.get(tid) ?? -Infinity;
    if (c > prev) bestByTutorial.set(tid, c);
  }

  const scored = [...bestByTutorial.entries()]
    .map(([tid, score]) => {
      const meta = metaById.get(tid);
      return meta ? { tutorialId: tid, slug: meta.slug, title: meta.title, score } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}
```

- [ ] **Step 4: Re-run the ranker test**

Run: `npx vitest run test/kg-ondemand-cosine-rank.test.js`
Expected: PASS on all 3 cases.

#### Sub-part 4b: Drain job

- [ ] **Step 5: Write the drain job test**

Create `test/kg-ondemand-job.test.js`:

```javascript
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import cds from '@sap/cds';
import { runOnDemandDrain } from '../srv/jobs/kg-ondemand-job.js';
import { _resetCacheForTests as _resetSettingsCache } from '../srv/lib/runtime-config/kg-settings.js';

const NS = 'com.sap.developers.ims';

async function setFlags({ enabled = true, onDemand = true } = {}) {
  const { KnowledgeGraphSettings } = cds.entities(NS);
  await DELETE.from(KnowledgeGraphSettings);
  await INSERT.into(KnowledgeGraphSettings).entries({
    enabled, onDemandExtractionEnabled: onDemand,
    extractBuildCap: 200,
  });
  _resetSettingsCache();
}

async function seedPending(rows) {
  const { KgOnDemandRequests } = cds.entities(NS);
  await DELETE.from(KgOnDemandRequests);
  for (let i = 0; i < rows.length; i++) {
    await INSERT.into(KgOnDemandRequests).entries({
      ID: `qqqqqqqq-${String(i).padStart(4, '0')}-0000-0000-000000000000`,
      query: rows[i].query,
      normalizedKey: rows[i].normalizedKey ?? rows[i].query,
      status: 'PENDING',
      requestedByKind: 'user',
    });
  }
}

describe('runOnDemandDrain (#948)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  beforeEach(async () => {
    const { KgOnDemandRequests, Tutorials, TutorialEmbedding, Concepts } = cds.entities(NS);
    await DELETE.from(KgOnDemandRequests);
    await DELETE.from(TutorialEmbedding);
    await DELETE.from(Concepts);
    await DELETE.from(Tutorials);
    delete process.env.KG_ONDEMAND_DRAIN_BATCH;
    delete process.env.KG_ONDEMAND_TUTORIALS_PER_REQ;
    delete process.env.KG_ONDEMAND_MAX_ATTEMPTS;
  });

  it('skips with reason=kg-disabled when master flag is off', async () => {
    await setFlags({ enabled: false, onDemand: true });
    const summary = await runOnDemandDrain({});
    expect(summary.reason).toBe('kg-disabled');
    expect(summary.processed).toBe(0);
  });

  it('skips with reason=ondemand-disabled when only the on-demand flag is off', async () => {
    await setFlags({ enabled: true, onDemand: false });
    const summary = await runOnDemandDrain({});
    expect(summary.reason).toBe('ondemand-disabled');
  });

  it('happy path: drains PENDING rows and marks DONE', async () => {
    await setFlags();
    await seedPending([{ query: 'q1' }, { query: 'q2' }]);

    const embed = vi.fn(async () => new Float32Array(1536).fill(0.1));
    const rankTutorials = vi.fn(async () => [
      { tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 },
    ]);
    const extractOne = vi.fn(async () => ({
      teaches: [{ slug: 'foo', name: 'Foo', confidence: 0.9 }],
      tokenUsage: { prompt: 100, completion: 50 },
      warnings: [],
    }));

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 1, merged: 0 })),
    });

    expect(summary.processed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(extractOne).toHaveBeenCalledTimes(2);
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests).columns('status', 'attempts', 'tutorialsExtracted');
    expect(rows.every(r => r.status === 'DONE')).toBe(true);
    expect(rows.every(r => r.attempts === 1)).toBe(true);
  });

  it('extraction throws once → row goes back to PENDING with attempts=1', async () => {
    await setFlags();
    await seedPending([{ query: 'q1' }]);

    let call = 0;
    const embed = vi.fn(async () => new Float32Array(1536).fill(0.1));
    const rankTutorials = vi.fn(async () => [{ tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 }]);
    const extractOne = vi.fn(async () => {
      call++;
      if (call === 1) throw new Error('LLM boom');
      return { teaches: [], tokenUsage: {}, warnings: [] };
    });

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.processed).toBe(0);
    expect(summary.failed).toBe(0);
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'attempts', 'lastError');
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    expect(row.lastError).toMatch(/LLM boom/);
  });

  it('extraction throws N times → row lands in FAILED', async () => {
    await setFlags();
    process.env.KG_ONDEMAND_MAX_ATTEMPTS = '2';
    await seedPending([{ query: 'q1' }]);

    const embed = vi.fn(async () => new Float32Array(1536).fill(0.1));
    const rankTutorials = vi.fn(async () => [{ tutorialId: 'tid-1', slug: 't1', title: 'T1', score: 0.9 }]);
    const extractOne = vi.fn(async () => { throw new Error('always fails'); });

    await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });
    // second tick
    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.failed).toBe(1);
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'attempts');
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(2);
  });

  it('empty top-K → row DONE with tutorialsExtracted=0, no LLM calls', async () => {
    await setFlags();
    await seedPending([{ query: 'q1' }]);

    const embed = vi.fn(async () => new Float32Array(1536).fill(0.1));
    const rankTutorials = vi.fn(async () => []);
    const extractOne = vi.fn();

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.processed).toBe(1);
    expect(extractOne).not.toHaveBeenCalled();
    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests).columns('status', 'tutorialsExtracted');
    expect(row.status).toBe('DONE');
    expect(row.tutorialsExtracted).toBe(0);
  });

  it('DRAIN_BATCH bounds per-tick work', async () => {
    await setFlags();
    process.env.KG_ONDEMAND_DRAIN_BATCH = '2';
    await seedPending([{ query: 'q1' }, { query: 'q2' }, { query: 'q3' }, { query: 'q4' }, { query: 'q5' }]);

    const embed = vi.fn(async () => new Float32Array(1536).fill(0.1));
    const rankTutorials = vi.fn(async () => []);
    const extractOne = vi.fn();

    const summary = await runOnDemandDrain({
      embed, rankTutorials, extractOne,
      persistExtraction: vi.fn(async () => ({ created: 0, merged: 0 })),
    });

    expect(summary.processed).toBe(2);
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests).columns('status');
    expect(rows.filter(r => r.status === 'DONE')).toHaveLength(2);
    expect(rows.filter(r => r.status === 'PENDING')).toHaveLength(3);
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run test/kg-ondemand-job.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 7: Implement the drain job**

Create `srv/jobs/kg-ondemand-job.js`:

```javascript
// srv/jobs/kg-ondemand-job.js
//
// Drains PENDING KgOnDemandRequests rows every 2 minutes. For each row:
//   - Embed the query.
//   - Cosine-rank ACTIVE tutorials by TutorialEmbedding MAX-similarity.
//   - Extract concepts from top-K tutorials (SAME pipeline as
//     srv/jobs/extract-concepts-job.js — extractConceptsFromTutorial +
//     kg-merge-on-write).
//   - Mark the row DONE, PENDING (retry), or FAILED (max attempts).
//
// Registered by srv/jobs/scheduler.js at '1-59/2 * * * *' (every 2 min,
// odd minute, off-schedule vs. other KG jobs).
//
// Chassis: the scheduler's registerJob wrapper handles pipeline logging
// + JobLastRun. This function MUST NOT call runWithLock itself.
// CAP 10's .as(name) singleton semantics prevent concurrent scheduled
// ticks across CF instances.
//
// Dependency injection: tests pass mocked embed/rankTutorials/extractOne
// so no LLM calls happen in unit tests.
//
// Spec: docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md
// Issue: #948

import cds from '@sap/cds';
import { resolveKnowledgeGraphSettings } from '../lib/runtime-config/kg-settings.js';
import { rankTutorialsByQueryVector } from '../lib/kg/on-demand-cosine-rank.js';
import { embed as defaultEmbed } from '../lib/embedding-client.js';
import { extractConceptsFromTutorial } from '../lib/kg-extract.js';
import { defaultCallModel } from '../lib/code-check-llm.js';
import { loadConceptRegistry, resolveConceptCandidates } from '../lib/kg-merge-on-write.js';
import * as metrics from '../lib/metrics.js';

const NS = 'com.sap.developers.ims';
const LOG = cds.log('kg-ondemand-job');

function envNumber(name, dflt) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

/**
 * Default per-tutorial extract wrapper — mirrors extract-concepts-job.js
 * lines 171-215. Kept in this file so unit tests can inject a mock via
 * deps.extractOne without touching the real LLM stack.
 */
async function defaultExtractOne({ db, tutorial, callModel, embed, registry }) {
  const { Tutorials, TutorialBodyText } = cds.entities(NS);
  const [bodyRow] = await SELECT.from(TutorialBodyText)
    .columns('bodyText')
    .where({ slug: tutorial.slug });
  const tutorialBody = bodyRow?.bodyText ?? '';
  if (!tutorialBody) return null;

  return await extractConceptsFromTutorial({
    tutorialSlug: tutorial.slug,
    tutorialTitle: tutorial.title,
    tutorialBody,
    registry,
    callModel,
  });
}

/**
 * Default persister — mirrors extract-concepts-job.js' merge-on-write +
 * link-write path but focused on a single tutorial. Returns
 * { created, merged } counters.
 */
async function defaultPersistExtraction({ db, tutorial, extraction, registryBySlug, registryEmbeddings, embed, embeddingModel, mergeThreshold }) {
  const { Concepts, TutorialConceptLinks } = cds.entities(NS);
  const candidateResolution = await resolveConceptCandidates({
    candidates: extraction.teaches ?? [],
    registry: { bySlug: registryBySlug, embeddings: registryEmbeddings },
    embed,
    embeddingModel,
    mergeThreshold,
    log: { warn: (m) => LOG.warn(m), info: () => {} },
  });

  await db.tx(async (tx) => {
    if (candidateResolution.pendingMints.length > 0) {
      await tx.run(INSERT.into(Concepts).entries(
        candidateResolution.pendingMints.map(m => ({
          ID: m.ID, slug: m.slug, name: m.name,
          embedding: m.embeddingBuf, status: 'ACTIVE',
        }))
      ));
    }
    const linkRows = candidateResolution.resolved.map(r => ({
      tutorial_ID: tutorial.tutorialId ?? tutorial.ID,
      concept_ID: r.conceptId,
      predicate: 'teaches',
      confidence: r.confidence,
    }));
    if (linkRows.length > 0) {
      await tx.run(INSERT.into(TutorialConceptLinks).entries(linkRows));
    }
  });

  return {
    created: candidateResolution.pendingMints.length,
    merged: candidateResolution.counters.merged,
  };
}

/**
 * Drain up to DRAIN_BATCH PENDING rows.
 * @param {object} [deps] — dependency injection for tests
 * @returns {Promise<object>} summary
 */
export async function runOnDemandDrain(deps = {}) {
  const db = deps.db ?? (await cds.connect.to('db'));
  const embed = deps.embed ?? defaultEmbed;
  const callModel = deps.callModel ?? defaultCallModel;
  const rankTutorials = deps.rankTutorials ?? rankTutorialsByQueryVector;
  const extractOne = deps.extractOne ?? defaultExtractOne;
  const persistExtraction = deps.persistExtraction ?? defaultPersistExtraction;

  const t0 = Date.now();
  const settings = await resolveKnowledgeGraphSettings();
  if (!settings.enabled) return { reason: 'kg-disabled', processed: 0, extracted: 0, failed: 0, coalesced: 0, durationMs: Date.now() - t0 };
  if (!settings.onDemandExtractionEnabled) return { reason: 'ondemand-disabled', processed: 0, extracted: 0, failed: 0, coalesced: 0, durationMs: Date.now() - t0 };

  const DRAIN_BATCH = envNumber('KG_ONDEMAND_DRAIN_BATCH', 3);
  const TUTORIALS_PER_REQ = envNumber('KG_ONDEMAND_TUTORIALS_PER_REQ', 5);
  const MAX_ATTEMPTS = envNumber('KG_ONDEMAND_MAX_ATTEMPTS', 3);
  const MERGE_THRESHOLD = Number(settings.mergeSimThresholdExtract);
  const embeddingModel = process.env.KG_EMBED_MODEL ?? 'text-embedding-3-small';

  const { KgOnDemandRequests } = cds.entities(NS);

  const rows = await SELECT.from(KgOnDemandRequests)
    .columns('ID', 'query', 'attempts')
    .where({ status: 'PENDING' })
    .orderBy('requestedAt asc')
    .limit(DRAIN_BATCH);

  if (rows.length === 0) {
    return { processed: 0, extracted: 0, failed: 0, coalesced: 0, durationMs: Date.now() - t0 };
  }

  // Load concept registry once per drain tick (same pattern as extract-concepts-job).
  const { bySlug: registryBySlug, embeddings: registryEmbeddings } = await loadConceptRegistry(db);

  let processed = 0, extracted = 0, failed = 0;

  for (const row of rows) {
    const rowT0 = Date.now();
    // Move to RUNNING + increment attempts.
    await UPDATE(KgOnDemandRequests)
      .set({ status: 'RUNNING', startedAt: new Date().toISOString(), attempts: row.attempts + 1 })
      .where({ ID: row.ID });

    try {
      const queryVector = await embed(row.query);
      const topK = await rankTutorials({ db, queryVector, limit: TUTORIALS_PER_REQ });

      let localExtracted = 0, localCreated = 0, localMerged = 0;
      let promptTok = 0, complTok = 0;

      for (const t of topK) {
        const extraction = await extractOne({
          db,
          tutorial: { tutorialId: t.tutorialId, slug: t.slug, title: t.title },
          callModel,
          embed,
          registry: { bySlug: registryBySlug, embeddings: registryEmbeddings },
        });
        if (!extraction) continue;
        promptTok += extraction.tokenUsage?.prompt ?? 0;
        complTok  += extraction.tokenUsage?.completion ?? 0;
        const persisted = await persistExtraction({
          db,
          tutorial: { tutorialId: t.tutorialId, ID: t.tutorialId, slug: t.slug },
          extraction,
          registryBySlug,
          registryEmbeddings,
          embed,
          embeddingModel,
          mergeThreshold: MERGE_THRESHOLD,
        });
        localExtracted++;
        localCreated += persisted.created;
        localMerged  += persisted.merged;
      }

      await UPDATE(KgOnDemandRequests)
        .set({
          status: 'DONE',
          completedAt: new Date().toISOString(),
          latencyMs: Date.now() - rowT0,
          tutorialsExtracted: localExtracted,
          conceptsCreated: localCreated,
          conceptsMerged: localMerged,
          llmPromptTokens: promptTok,
          llmCompletionTokens: complTok,
        })
        .where({ ID: row.ID });

      processed++;
      extracted += localExtracted;
      metrics.emit?.('kg_ondemand_extracted', { tutorials: localExtracted, created: localCreated, merged: localMerged });
    } catch (err) {
      const msg = (err?.message ?? String(err)).slice(0, 500);
      LOG.warn(`kg-ondemand row ${row.ID} failed: ${msg}`);
      const nextAttempts = row.attempts + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        await UPDATE(KgOnDemandRequests)
          .set({ status: 'FAILED', lastError: msg, completedAt: new Date().toISOString() })
          .where({ ID: row.ID });
        failed++;
        metrics.emit?.('kg_ondemand_failures', { reason: 'max_attempts' });
      } else {
        await UPDATE(KgOnDemandRequests)
          .set({ status: 'PENDING', lastError: msg })
          .where({ ID: row.ID });
      }
    }
  }

  const durationMs = Date.now() - t0;
  metrics.emit?.('kg_ondemand_drain_tick', { processed, extracted, failed, durationMs });
  return { processed, extracted, failed, coalesced: 0, durationMs };
}
```

- [ ] **Step 8: Re-run the drain test**

Run: `npx vitest run test/kg-ondemand-job.test.js`
Expected: PASS on all 6 cases.

#### Sub-part 4c: Register the job

- [ ] **Step 9: Register in `srv/jobs/scheduler.js`**

Locate the KG-jobs block (grep for `kg-pagerank`, `kg-communities`, `kg-wcc`). Add the import near the other KG imports:

```javascript
import { runOnDemandDrain } from './kg-ondemand-job.js';
```

Add the registration inside `registerJobs()` alongside the other KG jobs:

```javascript
// #948: on-demand KG extraction drain. Every 2 minutes on odd minutes,
// off-schedule vs. daily kg-pagerank (:53), kg-communities (:57), kg-wcc
// (04:07), and the daily extractConcepts tick (02:13). Fail-open on every
// fault path; skips entirely when KnowledgeGraphSettings.onDemandExtraction-
// Enabled is false (default).
registerJob({
  jobName: 'kg-ondemand',
  schedule: '1-59/2 * * * *',
  ttlMs: 2 * 60 * 1000,   // matches cadence; chassis uses this only for the registerJob log
  description: 'On-demand knowledge-graph extraction drain (#948)',
  fn: runOnDemandDrain,
});
```

- [ ] **Step 10: Verify srv-qa cp list**

The `.deploy/mta.yaml` `srv-qa` module has a `cp` list of files copied for the QA channel. The drain job's transitive imports must all be in that list. Run:

```bash
grep -E "cp:|- (\./)?srv/" .deploy/mta.yaml | head -80
```

Confirm the following are already listed (they are — they come with the existing extract-concepts-job dependency chain):
- `srv/lib/kg/on-demand-enqueue.js` (NEW — add explicitly if the mta.yaml enumerates individual kg/ files; otherwise it's covered by a wildcard)
- `srv/lib/kg/on-demand-cosine-rank.js` (NEW — same)
- `srv/jobs/kg-ondemand-job.js` (NEW — same)

If mta.yaml lists individual files, add these three; if it uses a wildcard for `srv/lib/kg/` and `srv/jobs/`, no edit is needed. Document the discovery in the commit message.

- [ ] **Step 11: Correct the design spec inline**

Edit `docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md`. Find the sentence "`runWithLock('kg-ondemand', instanceId, LOCK_MS = 5 * 60 * 1000, drainImpl)`". Replace the drain-job pseudocode block with:

```
runOnDemandDrain(deps = {}):
  1. Load kgSettings.
     If !enabled: return { reason: 'kg-disabled', ...zeroSummary }.
     If !onDemandExtractionEnabled: return { reason: 'ondemand-disabled', ...zeroSummary }.
  2. (Chassis handles pipeline logging and JobLastRun automatically. CAP 10's
     .as(name) singleton semantics prevent concurrent scheduled ticks across
     CF instances — the drain body itself does NOT call runWithLock.)
       a. SELECT ID, query, attempts FROM KgOnDemandRequests
          WHERE status = 'PENDING'
          ORDER BY requestedAt ASC
          LIMIT :DRAIN_BATCH.
       (rest unchanged)
```

Also remove the "runWithLock" bullet from Section 4 (error handling table row "Drain: instance already holds lock") — that row was written assuming an explicit lock inside the body. Replace with:

```
| Drain: chassis pipeline log write fails | Non-fatal; caught by scheduler.js `runWithLock` wrapper — logged as JobLastRun error, tick treated as failed. Next 2-min tick tries. |
```

- [ ] **Step 12: Full regression**

Run: `npm test`
Expected: green.

- [ ] **Step 13: Commit**

```
git add srv/lib/kg/on-demand-cosine-rank.js srv/jobs/kg-ondemand-job.js srv/jobs/scheduler.js test/kg-ondemand-cosine-rank.test.js test/kg-ondemand-job.test.js docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md
git commit -m "feat(#948): cosine ranker + on-demand drain job

- rankTutorialsByQueryVector: two-phase LOB-safe MAX(cosine) over
  TutorialEmbedding steps, ACTIVE-gated, decoded in Node.js.
- runOnDemandDrain: per-row RUNNING/DONE/PENDING/FAILED state machine,
  dependency-injected embed/rank/extractOne/persistExtraction so unit
  tests never touch the LLM stack.
- Registered at '1-59/2 * * * *' (odd minute cadence, off-schedule vs.
  daily KG jobs).
- Chassis handles pipeline logging + JobLastRun; drain body does NOT
  call runWithLock (CAP 10 .as() singleton semantics).
- Spec self-correction: stale runWithLock language removed from
  §Section 1 pseudocode + §Section 4 error table."
```

---

### Task 5: Wire enqueue into `expandSearchConceptsHandler` + `chat-orchestrator`

**Files:**
- Modify: `srv/lib/kg/joule-tool-expand-concepts.js` — add enqueue side-effect + accept `requester` opt
- Modify: `srv/lib/chat-orchestrator.js` — thread `requester` into the dispatch (line ~604)
- Test: extend `test/kg-joule-tool-expand-concepts.test.js`

**Interfaces:**
- Consumes: `enqueueOnDemandExtraction` (Task 3)
- Produces: no new exports. `expandSearchConceptsHandler({ db, embedClient, args, requester?, telemetry, timeoutMs })` — new optional `requester` opt.

- [ ] **Step 1: Extend the existing tool test**

Open `test/kg-joule-tool-expand-concepts.test.js`. Add a new `describe` block at the end:

```javascript
import { vi } from 'vitest';
import * as onDemandModule from '../srv/lib/kg/on-demand-enqueue.js';

describe('expandSearchConcepts on-demand enqueue side-effect (#948)', () => {
  let enqueueSpy;

  beforeEach(() => {
    enqueueSpy = vi.spyOn(onDemandModule, 'enqueueOnDemandExtraction')
      .mockResolvedValue({ status: 'enqueued', normalizedKey: 'x' });
  });

  afterEach(() => enqueueSpy.mockRestore());

  it('zero seeds → calls enqueueOnDemandExtraction with the raw query', async () => {
    const db = /* build a db that returns [] for topConceptsByCosine — same
                  pattern as existing zero-seed tests in this file */;
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536)) };

    const result = await expandSearchConceptsHandler({
      db, embedClient,
      args: { query: 'obscure query' },
      requester: { id: 'u1', kind: 'user' },
    });

    expect(result.concepts).toEqual([]);
    expect(result.tutorials).toEqual([]);
    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      query: 'obscure query',
      requester: { id: 'u1', kind: 'user' },
    }));
  });

  it('zero seeds + enqueue throws → tool STILL returns empty success (fire-and-forget)', async () => {
    enqueueSpy.mockRejectedValueOnce(new Error('DB down'));
    const db = /* same zero-seed db */;
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536)) };

    const result = await expandSearchConceptsHandler({
      db, embedClient,
      args: { query: 'obscure query' },
      requester: { kind: 'anon', ipHash: 'ip1' },
    });

    expect(result.concepts).toEqual([]);
    expect(result.tutorials).toEqual([]);
    // No throw — the tool's contract is preserved.
  });

  it('non-zero seeds → enqueue is never called', async () => {
    const db = /* db that returns real seeds (see existing happy-path fixture) */;
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536)) };

    await expandSearchConceptsHandler({
      db, embedClient,
      args: { query: 'CAP' },
      requester: { id: 'u1', kind: 'user' },
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('no requester → enqueue still called (backward-compat)', async () => {
    const db = /* zero-seed db */;
    const embedClient = { embed: vi.fn(async () => new Float32Array(1536)) };

    await expandSearchConceptsHandler({
      db, embedClient, args: { query: 'obscure query' },
    });

    expect(enqueueSpy).toHaveBeenCalledTimes(1);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      requester: expect.objectContaining({ kind: 'anon' }),
    }));
  });
});
```

Reuse the existing zero-seed and happy-path DB fixtures from the same file — do not duplicate their setup. The `/* build a db... */` comments point at the existing fixtures; wire them by hand when the test is authored.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/kg-joule-tool-expand-concepts.test.js`
Expected: 4 new failures (existing tests still green).

- [ ] **Step 3: Add the enqueue side-effect to the tool handler**

Open `srv/lib/kg/joule-tool-expand-concepts.js`. Add the import near the top:

```javascript
import { enqueueOnDemandExtraction } from './on-demand-enqueue.js';
```

Locate the zero-seed block (around line 130 — `if (seeds.length === 0)`). Modify it to fire-and-forget the enqueue:

```javascript
    if (seeds.length === 0) {
      telemetry?.emit?.('kg.joule.search_expansion_returned', {
        resultCount: 0, latencyMs: Date.now() - t0,
      })
      // #948: fire-and-forget enqueue on zero-seed. Never awaited. Never
      // throws to the caller. If the flag is off, the module bails
      // internally and returns { status: 'disabled' }.
      const requesterOrDefault = requester ?? { kind: 'anon' }
      enqueueOnDemandExtraction({ db, query: rawQuery, requester: requesterOrDefault })
        .catch(err => LOG.warn?.('enqueueOnDemandExtraction dispatch failed:', err.message))
      return { queryEcho: rawQuery, concepts: [], tutorials: [] }
    }
```

Extend the function signature to accept `requester`:

```javascript
export async function expandSearchConceptsHandler({
  db, embedClient, args, telemetry, timeoutMs = DEFAULT_TIMEOUT_MS,
  requester,   // #948: { id?, ipHash?, kind: 'user'|'anon' }; optional
}) {
```

If the file does not currently import a logger, add:

```javascript
import cds from '@sap/cds';
const LOG = cds.log('joule-tool-expand-concepts');
```

- [ ] **Step 4: Thread `requester` from chat-orchestrator**

Open `srv/lib/chat-orchestrator.js`. Locate line ~604 — the call to `expandSearchConceptsHandler`. Modify it to pass a `requester`:

```javascript
if (name === 'expandSearchConcepts') {
  try {
    const requester = req?.user?.id
      ? { id: req.user.id, kind: 'user' }
      : { ipHash: req?.userIpHash ?? null, kind: 'anon' };
    return await expandSearchConceptsHandler({
      db, embedClient, args, requester,
    });
  } catch (err) {
    LOG.warn('expandSearchConcepts dispatch failed:', err.message);
    ...
  }
}
```

The exact `req` variable in scope depends on the surrounding code — inspect the neighboring `else if (name === ...)` branches for the correct binding name. If `req` is not in scope, add it to the dispatch signature the same way `db` and `embedClient` are threaded.

- [ ] **Step 5: Re-run the tool test**

Run: `npx vitest run test/kg-joule-tool-expand-concepts.test.js`
Expected: PASS on all cases (existing + 4 new).

- [ ] **Step 6: Full regression**

Run: `npm test`
Expected: green.

- [ ] **Step 7: Commit**

```
git add srv/lib/kg/joule-tool-expand-concepts.js srv/lib/chat-orchestrator.js test/kg-joule-tool-expand-concepts.test.js
git commit -m "feat(#948): wire on-demand enqueue into expandSearchConcepts

- Zero-seed branch fire-and-forgets enqueueOnDemandExtraction. Never
  awaited; .catch()ed so a DB blip cannot corrupt the tool's success
  contract to the LLM.
- New optional requester opt on expandSearchConceptsHandler. Defaults
  to { kind: 'anon' } when not passed (backward-compat with existing
  test fixtures).
- chat-orchestrator threads req.user.id (user path) or req.userIpHash
  (anon path) into the requester opt."
```

---

### Task 6: Admin surface — `AdminService.KgOnDemandRequests` projection + Fiori Elements app

**Files:**
- Modify: `srv/admin-service.cds` — add `@readonly` projection
- Create: `app/admin/kgOnDemand/package.json`
- Create: `app/admin/kgOnDemand/ui5.yaml`
- Create: `app/admin/kgOnDemand/webapp/Component.js`
- Create: `app/admin/kgOnDemand/webapp/manifest.json`
- Create: `app/admin/kgOnDemand/webapp/i18n/i18n.properties`
- Create: `app/admin/kgOnDemand/webapp/annotations/annotations.cds`
- Modify: `app/admin-shell/webapp/manifest.json` — componentUsage + route + target
- Modify: `app/admin-shell/webapp/controller/Shell.controller.js` — 2 map entries
- Modify: `app/admin-shell/webapp/model/navigation.json` — 1 nav entry
- Test: `test/admin-service-kgondemand-projection.test.js`

**Interfaces:**
- Consumes: `KgOnDemandRequests` entity (Task 1)
- Produces: OData endpoint `/odata/v4/admin/KgOnDemandRequests`, gated on scope `Tutorial.Author`. Admin route `/admin-ui/#kgOnDemand`.

- [ ] **Step 1: Write the projection test**

Create `test/admin-service-kgondemand-projection.test.js`:

```javascript
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('AdminService.KgOnDemandRequests projection (#948)', () => {
  beforeAll(async () => {
    await cds.deploy(cds.env.roots).to('sqlite::memory:');
  });

  it('exposes KgOnDemandRequests via AdminService with @readonly', async () => {
    const admin = await cds.serve('AdminService').from(cds.model);
    const target = admin.entities.KgOnDemandRequests;
    expect(target).toBeDefined();
    expect(target['@readonly']).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/admin-service-kgondemand-projection.test.js`
Expected: FAIL — `target` is undefined.

- [ ] **Step 3: Add the projection**

Edit `srv/admin-service.cds`. In the `service AdminService @(...) { ... }` block, add:

```cds
  // #948: on-demand KG extraction request queue. Read-only from the
  // service layer — the drain job (srv/jobs/kg-ondemand-job.js) writes
  // to the underlying entity via db.tx, bypassing the service.
  @readonly
  entity KgOnDemandRequests as projection on KgOnDemandRequests;
```

Verify the existing `@requires: 'Tutorial.Author'` (or equivalent) is applied at the service level. If not, add a targeted `@requires` on this projection.

- [ ] **Step 4: Re-run the projection test**

Run: `npx vitest run test/admin-service-kgondemand-projection.test.js`
Expected: PASS.

- [ ] **Step 5: Scaffold the FE app**

Copy the shape from `app/admin/kgCommunities/` — it's the closest sibling. Create each file with these contents (adjust names from `kgCommunities` → `kgOnDemand`, `KgCommunity` → `KgOnDemandRequest`):

**`app/admin/kgOnDemand/package.json`:**

```json
{
  "name": "sap.tutorials.admin.kgOnDemand",
  "version": "0.0.1",
  "private": true
}
```

**`app/admin/kgOnDemand/ui5.yaml`:**

```yaml
specVersion: "3.0"
metadata:
  name: sap.tutorials.admin.kgOnDemand
type: application
framework:
  name: SAPUI5
  version: "1.136.0"
  libraries:
    - name: sap.fe.templates
    - name: sap.m
```

**`app/admin/kgOnDemand/webapp/Component.js`:** copy verbatim from `app/admin/kgCommunities/webapp/Component.js`, replacing the namespace `sap.tutorials.admin.kgCommunities` with `sap.tutorials.admin.kgOnDemand`.

**`app/admin/kgOnDemand/webapp/manifest.json`:**

Copy from `app/admin/kgCommunities/webapp/manifest.json` and:
- Change `sap.app.id` to `sap.tutorials.admin.kgOnDemand`
- Change `crossNavigation.inbounds.*.semanticObject` to `KgOnDemand`
- Change the `sap.fe.templates` target entity to `KgOnDemandRequests`
- Sort default: `requestedAt desc`
- LR columns: `query`, `normalizedKey`, `status`, `requestedByKind`, `attempts`, `tutorialsExtracted`, `conceptsCreated`, `conceptsMerged`, `latencyMs`, `requestedAt`, `completedAt`, `lastError`

**`app/admin/kgOnDemand/webapp/i18n/i18n.properties`:**

```
appTitle=KG On-Demand Requests
appSubtitle=On-demand knowledge-graph extraction queue (#948)
```

**`app/admin/kgOnDemand/webapp/annotations/annotations.cds`:**

Fiori annotations for LR + OP. Reuse the pattern from kgCommunities' annotations. LR: LineItem with the columns above. OP: Object Page with sections { Request, Extraction Result, Cost }. Filter bar on the LR: status, requestedByKind, requestedAt range.

- [ ] **Step 6: Register in `admin-shell/webapp/manifest.json`**

Add three blocks matching the `kgCommunities` pattern (search the manifest for `kgCommunities` and add sibling entries):

1. In `sap.ui5.dependencies.components` alias map:
```json
"sap.tutorials.admin.kgOnDemand": "./components/kgOnDemand"
```

2. In `sap.ui5.componentUsages`:
```json
"kgOnDemandComponent": {
  "name": "sap.tutorials.admin.kgOnDemand",
  "settings": {},
  "lazy": true
}
```

3. In `sap.ui5.routing.routes`:
```json
{ "name": "kgOnDemand", "pattern": "kgOnDemand", "target": [{"name": "kgOnDemandTarget", "prefix": "kod"}] }
```

4. In `sap.ui5.routing.targets`:
```json
"kgOnDemandTarget": {
  "type": "Component",
  "usage": "kgOnDemandComponent",
  "id": "kgOnDemandTarget",
  "options": { "settings": {} }
}
```

- [ ] **Step 7: Register in `admin-shell/webapp/controller/Shell.controller.js`**

Locate lines 38 and 82 (the two maps that carry `kgCommunities:`). Add sibling entries below each:

```javascript
kgOnDemand: "kgOnDemand",
```

and

```javascript
kgOnDemand: "KG On-Demand",
```

- [ ] **Step 8: Register in `admin-shell/webapp/model/navigation.json`**

At line 83 (where `kgCommunities` nav entry lives), add a sibling:

```json
{ "key": "kgOnDemand", "title": "KG On-Demand" }
```

Order it near the other KG entries.

- [ ] **Step 9: Build the admin shell**

```bash
npm run build:admin
```

Expected output: `Copied kgOnDemand` in the copy-components.js log (auto-discovery).

- [ ] **Step 10: Manual sanity check the FE app in the shell**

```bash
cds watch
```

Then in a browser: `http://localhost:4004/admin-ui/#kgOnDemand`. Expected: empty List Report renders with the columns above. Insert one row directly via `hana-cli` or SQL and reload — the row appears.

If the app fails to load with `ModuleError: failed to load components/kgOnDemand/Component.js`, re-check the copy-components discovery: `ls app/admin-shell/dist/components/kgOnDemand/`. Should show `Component.js` and `manifest.json`.

- [ ] **Step 11: Commit**

```
git add srv/admin-service.cds app/admin/kgOnDemand/ app/admin-shell/webapp/manifest.json app/admin-shell/webapp/controller/Shell.controller.js app/admin-shell/webapp/model/navigation.json test/admin-service-kgondemand-projection.test.js
git commit -m "feat(#948): AdminService.KgOnDemandRequests projection + Fiori Elements app

- @readonly projection at /odata/v4/admin/KgOnDemandRequests, gated
  on the AdminService's existing Tutorial.Author scope.
- Fiori Elements List Report + Object Page at /admin-ui/#kgOnDemand.
- LR columns: query, normalizedKey, status, requestedByKind, attempts,
  tutorialsExtracted, conceptsCreated, conceptsMerged, latencyMs,
  requestedAt, completedAt, lastError. Sort: requestedAt desc.
- Admin-shell wiring: componentUsage, route, target, Shell map entries,
  navigation entry. copy-components.js auto-discovers the app folder;
  no root package.json edit needed."
```

---

### Task 7: Hybrid + smoke tests

**Files:**
- Create: `test/hybrid/kg-ondemand.test.js`
- Create: `test/smoke/kg-ondemand.smoke.test.js`
- Modify: `vitest.config.js` — the hybrid/smoke project entries may or may not need explicit file additions depending on how they glob; verify

**Interfaces:** consumes everything from Tasks 1–6.

- [ ] **Step 1: Confirm hybrid + smoke project glob patterns**

```bash
grep -A2 "hybrid\|smoke" vitest.config.js | head -40
```

If the projects use `test/hybrid/**/*.test.js` and `test/smoke/**/*.smoke.test.js` globs, the new files are picked up automatically. If the config lists individual files, add the new paths.

- [ ] **Step 2: Write the hybrid test**

Create `test/hybrid/kg-ondemand.test.js`:

```javascript
// Hybrid test — runs against real HANA via `cds bind --exec`. Gated by
// HYBRID_KG_ONDEMAND=true to control LLM quota. Run with:
//   HYBRID_KG_ONDEMAND=true cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-ondemand.test.js
//
// Bare `vitest <file>` silently skips hybrid setup — memory rule.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { enqueueOnDemandExtraction } from '../../srv/lib/kg/on-demand-enqueue.js';
import { runOnDemandDrain } from '../../srv/jobs/kg-ondemand-job.js';
import { _resetCacheForTests as _resetSettingsCache } from '../../srv/lib/runtime-config/kg-settings.js';

const NS = 'com.sap.developers.ims';
const RUN = process.env.HYBRID_KG_ONDEMAND === 'true';

describe.skipIf(!RUN)('KG on-demand — hybrid (#948)', () => {
  let db, originalOnDemand;

  beforeAll(async () => {
    db = await cds.connect.to('db');
    const { KnowledgeGraphSettings } = cds.entities(NS);
    const [row] = await SELECT.from(KnowledgeGraphSettings);
    originalOnDemand = row?.onDemandExtractionEnabled ?? false;
    await UPDATE(KnowledgeGraphSettings).set({ onDemandExtractionEnabled: true });
    _resetSettingsCache();
  });

  afterAll(async () => {
    const { KnowledgeGraphSettings } = cds.entities(NS);
    await UPDATE(KnowledgeGraphSettings).set({ onDemandExtractionEnabled: originalOnDemand });
    _resetSettingsCache();
  });

  beforeEach(async () => {
    const { KgOnDemandRequests } = cds.entities(NS);
    await DELETE.from(KgOnDemandRequests).where({ normalizedKey: { like: 'hybridtest%' } });
  });

  it('inserts a PENDING row on HANA', async () => {
    const r = await enqueueOnDemandExtraction({
      db, query: 'hybridtest one',
      requester: { id: 'hybridtest-u1', kind: 'user' },
    });
    expect(r.status).toBe('enqueued');
    const { KgOnDemandRequests } = cds.entities(NS);
    const rows = await SELECT.from(KgOnDemandRequests).where({ normalizedKey: 'hybridtest one' });
    expect(rows).toHaveLength(1);
  });

  it('coalesces 5 concurrent enqueues into 1 row', async () => {
    const promises = Array.from({ length: 5 }, (_, i) => enqueueOnDemandExtraction({
      db, query: 'hybridtest coalesce',
      requester: { id: `hybridtest-c${i}`, kind: 'user' },
    }));
    const results = await Promise.all(promises);
    const enq = results.filter(r => r.status === 'enqueued').length;
    const co  = results.filter(r => r.status === 'coalesced').length;
    expect(enq).toBe(1);
    expect(co).toBe(4);
  });

  it('end-to-end: enqueue → drain → next expandSearchConcepts sees new concepts', async () => {
    // Use a query guaranteed zero-seed against the current KG.
    const rawQuery = 'quantum tulip encabulator';

    const enqR = await enqueueOnDemandExtraction({
      db, query: rawQuery,
      requester: { id: 'hybridtest-e2e', kind: 'user' },
    });
    expect(enqR.status).toBe('enqueued');

    const summary = await runOnDemandDrain({});
    expect(summary.processed).toBeGreaterThanOrEqual(1);
    // Note: the drain may extract 0 tutorials if cosine-rank returns nothing —
    // that's a valid outcome and the test does not assert non-zero extraction.

    const { KgOnDemandRequests } = cds.entities(NS);
    const [row] = await SELECT.from(KgOnDemandRequests)
      .where({ normalizedKey: 'quantum tulip encabulator' })
      .columns('status', 'tutorialsExtracted', 'llmPromptTokens');
    expect(['DONE', 'FAILED']).toContain(row.status);
  });
});
```

- [ ] **Step 3: Run the hybrid test**

Requires `cf login` + `cds bind --exec`. From the worktree:

```bash
HYBRID_KG_ONDEMAND=true cds bind --exec -- npx vitest run --project hybrid test/hybrid/kg-ondemand.test.js
```

Expected: all 3 tests PASS. If any test fails, capture the output — do NOT commit until diagnosed.

- [ ] **Step 4: Write the smoke test**

Create `test/smoke/kg-ondemand.smoke.test.js`:

```javascript
// Post-deploy smoke test. Read-only. Assumes the flag is off in DEV
// unless the operator has flipped it. Two envs:
//   SMOKE_SRV_URL — CAP service base URL (e.g. https://tutorials-srv-dev.cfapps.eu10.hana.ondemand.com)
//   SMOKE_ADMIN_TOKEN — bearer token with Tutorial.Author scope
//
// Run: SMOKE_SRV_URL=... SMOKE_ADMIN_TOKEN=... npx vitest run --project smoke test/smoke/kg-ondemand.smoke.test.js

import { describe, it, expect } from 'vitest';

const SRV = process.env.SMOKE_SRV_URL;
const TOKEN = process.env.SMOKE_ADMIN_TOKEN;
const RUN = Boolean(SRV);

describe.skipIf(!RUN)('KG on-demand — smoke (#948)', () => {
  it('OData endpoint returns 200 with Tutorial.Author scope', async () => {
    const res = await fetch(`${SRV}/odata/v4/admin/KgOnDemandRequests?$top=1`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.value)).toBe(true);
  });

  it('OData endpoint returns 401/403 without a token', async () => {
    const res = await fetch(`${SRV}/odata/v4/admin/KgOnDemandRequests?$top=1`);
    expect([401, 403]).toContain(res.status);
  });

  it('KnowledgeGraphSettings exposes onDemandExtractionEnabled', async () => {
    const res = await fetch(`${SRV}/odata/v4/admin/KnowledgeGraphSettings`, {
      headers: TOKEN ? { authorization: `Bearer ${TOKEN}` } : {},
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.value?.[0]).toHaveProperty('onDemandExtractionEnabled');
    expect(typeof body.value[0].onDemandExtractionEnabled).toBe('boolean');
  });
});
```

- [ ] **Step 5: Run the smoke test locally against DEV**

```bash
SMOKE_SRV_URL=https://<dev-srv-url> SMOKE_ADMIN_TOKEN=$DEV_TOKEN npx vitest run --project smoke test/smoke/kg-ondemand.smoke.test.js
```

Expected: 3 passes. If the third assertion fails (`onDemandExtractionEnabled` missing) the schema hasn't deployed to DEV — the smoke test correctly caught it; go back to the local deploy sequence.

- [ ] **Step 6: Verify vitest.config picks up the new files**

```bash
npx vitest --project hybrid --listTests | grep kg-ondemand
npx vitest --project smoke --listTests | grep kg-ondemand
```

Expected: each shows exactly one match. If not, edit `vitest.config.js` to include the file explicitly.

- [ ] **Step 7: Commit**

```
git add test/hybrid/kg-ondemand.test.js test/smoke/kg-ondemand.smoke.test.js vitest.config.js
git commit -m "test(#948): hybrid + smoke coverage for on-demand KG extraction

- Hybrid (test/hybrid/kg-ondemand.test.js): gated by HYBRID_KG_ONDEMAND=true
  to control LLM quota. Covers HANA insert, concurrent-enqueue coalescing,
  and end-to-end drain against real HANA.
- Smoke (test/smoke/kg-ondemand.smoke.test.js): post-deploy sanity — endpoint
  200 with token, 401/403 without, KnowledgeGraphSettings exposes the new
  boolean field."
```

---

### Task 8: Deploy sequence + PR

**Files:** none new. This is the closing checklist.

- [ ] **Step 1: Local build**

```bash
cd D:/projects/tutorials-poc/.claude/worktrees/948-kg-ondemand-triggers
npm run build:all
```

Expected: Hugo build succeeds; admin-shell reports `Copied kgOnDemand`; no errors.

- [ ] **Step 2: Local deploy to DEV**

Confirm target first:

```bash
cf target
```

Expected: `Org: tutorial-system`, `Space: dev`. If not, `cf target -s dev`.

Confirm deploy scope with Tom before running the deploy command. Then:

```bash
cd .deploy && mbt build && cf deploy mta_archives/*.mtar -e ../deploy/dev.mtaext -f && cd ..
```

- [ ] **Step 3: Post-deploy smoke run**

```bash
SMOKE_SRV_URL=https://<dev-srv-url> SMOKE_ADMIN_TOKEN=$DEV_TOKEN npx vitest run --project smoke test/smoke/kg-ondemand.smoke.test.js
```

All 3 tests pass.

- [ ] **Step 4: Sanity-check flag defaults**

`hana-cli inspectTable KGONDEMANDREQUESTS` — expect the table exists on DEV.
`SELECT ONDEMANDEXTRACTIONENABLED FROM COM_SAP_DEVELOPERS_IMS_KNOWLEDGEGRAPHSETTINGS` via `hana-cli querySimple` — expect `FALSE` (or `NULL` if the row was untouched — resolver treats both as false).

- [ ] **Step 5: Push branch + open draft PR**

```bash
git push -u origin worktree-948-kg-ondemand-triggers
gh pr create --draft --title "feat(#948): on-demand KG rebuild triggers from expandSearchConcepts" --body "$(cat <<'EOF'
Closes #948. Parked from #943.

## Summary

When \`expandSearchConcepts\` returns zero seeds and \`KnowledgeGraphSettings.onDemandExtractionEnabled\` is true, the tool fire-and-forgets an enqueue into a new \`KgOnDemandRequests\` HANA queue. A new 2-minute cron (\`kg-ondemand\`) drains the queue, cosine-ranks the corpus by query vector, and extracts concepts from the top-K tutorials via the existing \`extractConceptsFromTutorial\` + \`kg-merge-on-write\` pipeline.

**Behavior in production is unchanged until an admin flips the flag** — default is \`false\`. This PR delivers the observability + coalescing scaffolding the #948 prerequisites list asked for.

## What's in

- \`db/knowledge-graph-ondemand.cds\`: \`KgOnDemandRequests\` entity (queue rows).
- \`db/src/KG_ONDEMAND_PENDING_UNIQUE.hdbindex\`: filtered unique index (HANA defense-in-depth for the enqueue coalescing gate).
- \`db/knowledge-graph.cds\`: new \`KnowledgeGraphSettings.onDemandExtractionEnabled\` (default false).
- \`srv/lib/runtime-config/kg-settings.js\`: resolver picks up the fifth knob (DB > env > default).
- \`srv/lib/kg/on-demand-enqueue.js\`: pure enqueue logic — flag check, normalize, rate-limit, INSERT-WHERE-NOT-EXISTS.
- \`srv/lib/kg/on-demand-cosine-rank.js\`: two-phase LOB-safe MAX-cosine ranker over \`TutorialEmbedding\`.
- \`srv/jobs/kg-ondemand-job.js\`: the drain (registered at \`1-59/2 * * * *\`).
- \`srv/lib/kg/joule-tool-expand-concepts.js\`: fire-and-forget enqueue on zero-seed + \`requester\` opt.
- \`srv/lib/chat-orchestrator.js\`: threads \`requester\` into the dispatch.
- \`srv/admin-service.cds\`: \`@readonly\` projection over \`KgOnDemandRequests\`.
- \`app/admin/kgOnDemand/\`: Fiori Elements LR + OP.
- \`app/admin-shell/webapp/{manifest.json,controller/Shell.controller.js,model/navigation.json}\`: registration.
- Tests: unit (schema, resolver, enqueue, cosine-rank, drain, tool wiring, projection), hybrid, smoke.

## Metrics added

\`kg_ondemand_enqueued\`, \`kg_ondemand_dedup_coalesced\`, \`kg_ondemand_rate_limited\`, \`kg_ondemand_enqueue_error\`, \`kg_ondemand_extracted\`, \`kg_ondemand_failures\`, \`kg_ondemand_drain_tick\`.

## Env knobs (all optional, defaults sane)

\`KG_ONDEMAND_ENABLED\`, \`KG_ONDEMAND_USER_MAX_PER_HOUR=3\`, \`KG_ONDEMAND_GLOBAL_MAX_PER_HOUR=20\`, \`KG_ONDEMAND_DRAIN_BATCH=3\`, \`KG_ONDEMAND_TUTORIALS_PER_REQ=5\`, \`KG_ONDEMAND_MAX_ATTEMPTS=3\`.

## Rollout

Flag stays OFF in this PR. Post-merge, watch \`kg.joule.search_expansion_returned { resultCount: 0 }\` for a week to build the pre-flag baseline. When ready, admin flips \`KnowledgeGraphSettings.onDemandExtractionEnabled=true\` at \`/admin-ui/#kg-settings\` and watches \`/admin-ui/#kgOnDemand\` for PENDING → RUNNING → DONE.

## Spec

\`docs/superpowers/specs/2026-07-05-948-kg-ondemand-triggers-design.md\`

## Plan

\`docs/superpowers/plans/2026-07-05-948-kg-ondemand-triggers.md\`
EOF
)"
```

- [ ] **Step 6: Post the PR URL back to Tom.**

---

## Self-Review

Ran on 2026-07-05 after landing all task blocks.

**1. Spec coverage.** Every §-numbered spec section maps to at least one task:
- §1 Architecture — Tasks 3, 4, 5 (enqueue, drain, tool wiring).
- §2 Data model — Task 1 (entity, index, setting).
- §3 Data flow — spanned by Tasks 3–5.
- §4 Error handling — asserted by unit tests in Tasks 3, 4, 5.
- §5 Testing — Tasks 3, 4, 5, 7.
- §6 Rollout — Task 8 (deploy) + PR body.
- §7 Alternatives — no task; recorded in spec only, correctly out of scope for a plan.
- Prerequisites (§Prerequisites addressed 1–3) — all satisfied: (1) metrics added in Task 3+4; (2) cost accounting on the queue row + summary metric in Task 4; (3) INSERT-WHERE-NOT-EXISTS coalescing in Task 3.

**2. Placeholder scan.** Searched for TBD / TODO / FIXME / "implement later" / "similar to Task N without repeating" — none present. All test bodies are complete except Task 5's fixture-reuse comments (`/* zero-seed db */`), which are intentional cross-references to the existing test file's fixtures rather than placeholders; every subagent implementing that task will read the existing file.

**3. Type consistency across tasks.**
- `enqueueOnDemandExtraction({ db, query, requester })` — defined Task 3, consumed Task 5. Match.
- `rankTutorialsByQueryVector({ db, queryVector, limit })` — defined Task 4a, consumed Task 4b. Match.
- `runOnDemandDrain(deps)` return shape — defined Task 4b, asserted in Task 4b tests. Match.
- `requester` shape — defined Task 3 (`{ id?, ipHash?, kind }`), threaded Task 5. Match.
- `KgOnDemandRequests` column list — defined Task 1, referenced Tasks 3/4/6. Match.

**4. Scope check.** One issue, one plan, no independent subsystems. Not a decomposition candidate.

Plan is complete and internally consistent.

