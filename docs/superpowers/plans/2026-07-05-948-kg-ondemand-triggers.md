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


