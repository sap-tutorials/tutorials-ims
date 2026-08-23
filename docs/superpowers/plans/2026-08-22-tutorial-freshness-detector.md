# Tutorial Freshness Detector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI-assisted, author-triggered detector that flags stale code/dependencies in a tutorial, grounds its claims against real SAP docs, and surfaces confidence-tiered, dispositionable findings in the Admin UI plus a catalog-wide worklist.

**Architecture:** A per-tutorial `checkFreshness()` action (and an optional bulk scan job) drives one engine: extract code blocks from persisted `Steps` → embed each and cosine-search ApiDocs/Samples embeddings for grounding context → one forced-tool-call LLM request via `@sap-ai-sdk/orchestration` → persist a `FreshnessReport` + `FreshnessFinding` rows, migrating prior author dispositions forward by a finding fingerprint. Fiori Elements renders findings under the tutorial Object Page (confidence as criticality) and an "Open High-Confidence Flags" column on the List Report.

**Tech Stack:** CAP Node.js (`@sap/cds`), SAP HANA Cloud (REAL_VECTOR + `COSINE_SIMILARITY`), `@sap-ai-sdk/orchestration`, Fiori Elements V4 (`sap.fe.templates`), Vitest, SQLite (unit tests).

**Spec:** `docs/superpowers/specs/2026-08-22-tutorial-freshness-detector-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- **Node 20+**; prefer native `fetch` (no new HTTP client deps).
- **No raw SQL via `cds.ql`/CQL** — **except** HANA vector/BLOB ops (`TO_REAL_VECTOR`, `COSINE_SIMILARITY`, BLOB read/write), which MUST use raw `db.run(sql, binds)`. This is the project-sanctioned exception (see `srv/lib/embedding-query.js`, `srv/lib/kg/concept-embedding-query.js`).
- **Never SELECT a HANA BLOB alongside non-BLOB metadata in one CDS QL query** — LOB locators expire; use raw `db.run()` for vector/BLOB retrieval.
- **HANA column identifiers are UPPERCASE** in raw SQL (`"EMBEDDINGVEC"`, `"EMBEDDING"`).
- **Service actions require auth** — annotate with `@(requires: 'Admin')` (or the project's `'Author'`/`'SuperAdmin'` scope as matches sibling actions).
- **Never hardcode secrets/credentials.**
- **Schema changes:** regenerate `.hdbmigrationtable` via `cds build --production`; **never hand-author** the ALTER. `.cdsrc.json` has a **second `hana`/`dest:db` build task (line 15)** that clobbers a freshly generated migration — regenerate migrations with that task's interference in mind (see memory `cdsrc-second-hana-task-clobbers-fresh-migration`).
- **`srv-qa` cp-list audit:** if any new `srv/lib/*` module ends up in `content-store.js`'s transitive `./` import graph, add it to `.deploy/mta.yaml`'s `srv-qa` `cp` list. (Expected: the freshness modules are NOT content-store deps — confirm in Task 11.)
- **Feature flags:** any new env gate / `*Settings` boolean MUST be registered in `srv/lib/feature-flags/registry.js` or the `feature-flags-registry` guard test fails.
- **Fingerprint** = SHA-256 (`node:crypto`).
- **Jobs re-throw on error** so `runWithLock` records FAILED; **engine fails open** and never throws into a request/tx.
- **Cron schedules use off-minutes** (`:07/:13/:23/:37/:43/:53`), never `:00`/`:30`.
- **LLM tool schema** MUST require a `confidence` tier and a `groundingSource` field on every finding; the rubric forces `confidence:'Low'` on any API-obsolescence claim not supported by provided grounding context.

---

### Task 1: Code-block extractor (`srv/lib/freshness-extract.js`)

Pure, runtime-safe (plain JS — `scripts/parsers/*` is build-time TS and NOT importable under `cds-serve`). Ports the CommonMark fence logic from `scripts/parsers/fence-tracker.ts`, extended to capture the info-string language and accumulate code lines, and to walk a list of steps emitting a per-step block index.

**Files:**
- Create: `srv/lib/freshness-extract.js`
- Test: `test/unit/freshness-extract.test.js`

**Interfaces:**
- Produces: `extractCodeBlocks(steps) → Array<{ stepRef:number, codeBlockIndex:number, lang:string, code:string }>` where `steps` is `Array<{ number:number, content:string }>`. `lang` is the fence info-string trimmed (empty string if none). `codeBlockIndex` resets to 0 per step.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/freshness-extract.test.js
import { describe, it, expect } from 'vitest';
import { extractCodeBlocks } from '../../srv/lib/freshness-extract.js';

describe('extractCodeBlocks', () => {
  it('extracts fenced blocks with language, step ref, and per-step index', () => {
    const steps = [
      { number: 1, text: 'intro\n\n```Shell\nnpm init -y\n```\n' },
      { number: 2, text: 'code\n\n```JavaScript\nconst fetch = require("node-fetch");\n```\nand again\n\n```JavaScript\nconsole.log(1);\n```\n' },
    ];
    // NOTE: production reads persisted Steps rows; the parser accepts { number, content }.
    const blocks = extractCodeBlocks(steps.map(s => ({ number: s.number, content: s.text })));
    expect(blocks).toEqual([
      { stepRef: 1, codeBlockIndex: 0, lang: 'Shell', code: 'npm init -y' },
      { stepRef: 2, codeBlockIndex: 0, lang: 'JavaScript', code: 'const fetch = require("node-fetch");' },
      { stepRef: 2, codeBlockIndex: 1, lang: 'JavaScript', code: 'console.log(1);' },
    ]);
  });

  it('handles tilde fences and ignores unclosed fences gracefully', () => {
    const steps = [{ number: 1, content: '~~~py\nx=1\n~~~\n```\nunclosed' }];
    const blocks = extractCodeBlocks(steps);
    expect(blocks).toEqual([{ stepRef: 1, codeBlockIndex: 0, lang: 'py', code: 'x=1' }]);
  });

  it('returns [] for steps with no fences or empty input', () => {
    expect(extractCodeBlocks([{ number: 1, content: 'no code here' }])).toEqual([]);
    expect(extractCodeBlocks([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-extract.test.js`
Expected: FAIL — `extractCodeBlocks is not a function` / module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/freshness-extract.js
// Runtime-safe (plain JS) code-block extractor. Ports the CommonMark fence
// tracking from scripts/parsers/fence-tracker.ts (build-time TS, not importable
// under cds-serve), extended to capture the fence language + accumulate code.

const FENCE_OPEN = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;

/**
 * @param {Array<{number:number, content:string}>} steps
 * @returns {Array<{stepRef:number, codeBlockIndex:number, lang:string, code:string}>}
 */
export function extractCodeBlocks(steps) {
  const out = [];
  if (!Array.isArray(steps)) return out;
  for (const step of steps) {
    const content = step?.content;
    if (typeof content !== 'string' || !content) continue;
    const stepRef = Number(step.number);
    const lines = content.split(/\r?\n/);
    let idx = 0;              // per-step code block index
    let open = null;          // { marker:string, len:number, lang:string, body:string[] }
    for (const line of lines) {
      if (open) {
        // closing fence: same marker char, length >= opening length, nothing but marker
        const close = line.match(FENCE_OPEN);
        if (close && close[2][0] === open.marker && close[2].length >= open.len && close[3].trim() === '') {
          out.push({ stepRef, codeBlockIndex: idx++, lang: open.lang, code: open.body.join('\n') });
          open = null;
        } else {
          open.body.push(line);
        }
      } else {
        const m = line.match(FENCE_OPEN);
        if (m) open = { marker: m[2][0], len: m[2].length, lang: (m[3] || '').trim(), body: [] };
      }
    }
    // unclosed fence at EOF is discarded (matches CommonMark tolerance for our purposes)
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/freshness-extract.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/freshness-extract.js test/unit/freshness-extract.test.js
git commit -m "feat(freshness): runtime code-block extractor for tutorial steps"
```

---

### Task 2: Data model — entities, embedding columns, migration

Two new persisted entities and vector columns on `ApiDocs`/`Samples`, projected into `AdminService`.

**Files:**
- Create: `db/tutorial-freshness.cds`
- Modify: `db/external-content.cds` (add embedding columns to `ApiDocs` + `Samples`)
- Modify: `srv/admin-service.cds` (project the new entities; add associations + virtual columns to `Tutorials`)
- Test: `test/unit/freshness-model.test.js`

**Interfaces:**
- Produces: entities `ims.FreshnessReport`, `ims.FreshnessFinding`; `ims.ApiDocs.embedding`/`embeddingVec`, `ims.Samples.embedding`/`embeddingVec`; `AdminService.FreshnessReport`, `AdminService.FreshnessFinding`; `AdminService.Tutorials.freshnessFindings` (assoc), `.openHighCount`/`.freshnessStatus`/`.freshnessCriticality` (virtual).

- [ ] **Step 1: Write the failing test**

```js
// test/unit/freshness-model.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('freshness data model', () => {
  let db;
  beforeAll(async () => { db = await cds.test(process.cwd()); });

  it('persists a report with findings and defaults disposition to OPEN', async () => {
    const { FreshnessReport, FreshnessFinding } = cds.entities('ims');
    const reportId = cds.utils.uuid();
    await INSERT.into(FreshnessReport).entries({
      ID: reportId, tutorial_ID: null, status: 'DONE', model: 'test', cost: '$0.00', openHighCount: 1,
    });
    await INSERT.into(FreshnessFinding).entries({
      ID: cds.utils.uuid(), report_ID: reportId, tutorial_ID: null,
      fingerprint: 'abc', category: 'obsolete-dep', severity: 'High', confidence: 'High',
      stepRef: 1, codeBlockIndex: 0, lang: 'JavaScript', evidence: 'require("node-fetch")',
      summary: 'node-fetch obsolete', suggestedFix: 'use native fetch', groundingSource: 'https://x',
    });
    const f = await SELECT.one.from(FreshnessFinding).where({ report_ID: reportId });
    expect(f.disposition).toBe('OPEN');
    expect(f.confidence).toBe('High');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-model.test.js`
Expected: FAIL — `ims.FreshnessReport` not found.

- [ ] **Step 3: Write the CDS**

```cds
// db/tutorial-freshness.cds
namespace ims;

using { ims.Tutorials } from './schema';
using { cuid, managed } from '@sap/cds/common';

// One CURRENT report per tutorial (replaced on re-run, not a history table).
entity FreshnessReport : cuid, managed {
  tutorial      : Association to Tutorials;
  runAt         : Timestamp;
  model         : String(100);
  cost          : String(20);                       // e.g. '$0.62'
  status        : String(20) default 'QUEUED';      // QUEUED | RUNNING | DONE | FAILED
  error         : String(1000);
  openHighCount : Integer default 0;                // findings: confidence=High AND disposition=OPEN
  findings      : Composition of many FreshnessFinding on findings.report = $self;
}

entity FreshnessFinding : cuid {
  report          : Association to FreshnessReport;
  tutorial        : Association to Tutorials;        // direct nav for FE facet + LR
  fingerprint     : String(64);                      // SHA-256(category + location + evidence)
  category        : String(30);                      // obsolete-dep | deprecated-api | dated-style | hardcoded-secret | broken-flow
  severity        : String(10);                      // High | Medium | Low
  confidence      : String(10);                      // High | Medium | Low  (primary visual weight)
  stepRef         : Integer;
  codeBlockIndex  : Integer;
  lang            : String(40);
  evidence        : LargeString;
  summary         : String(500);
  suggestedFix    : LargeString;
  groundingSource : String(500);
  disposition     : String(12) default 'OPEN';       // OPEN | ACCEPTED | DISMISSED | FIXED
  dispositionBy   : String(255);
  dispositionAt   : Timestamp;
  dispositionNote : String(1000);
}
```

```cds
// db/external-content.cds — append near the ApiDocs / Samples definitions.
// Vector columns for direct code→doc grounding cosine search (Task 3 backfills them).
extend entity ims.ApiDocs with {
  embedding    : LargeBinary;        // raw Float32 BLOB (SQLite unit-test path)
  embeddingVec : Vector(1536);       // HANA REAL_VECTOR (COSINE_SIMILARITY path)
}
extend entity ims.Samples with {
  embedding    : LargeBinary;
  embeddingVec : Vector(1536);
}
```

- [ ] **Step 4: Project into AdminService**

```cds
// srv/admin-service.cds — add near the other entity projections.
entity FreshnessReport  as projection on ims.FreshnessReport;
entity FreshnessFinding as projection on ims.FreshnessFinding;
```

Add to the existing `entity Tutorials as projection on ims.Tutorials { ... }` body (alongside the other inverse associations at ~`:59-105`):

```cds
    // Freshness detector (spec 2026-08-22)
    freshnessFindings   : Association to many FreshnessFinding on freshnessFindings.tutorial.ID = ID,
    virtual openHighCount      : Integer,   // populated in after('READ','Tutorials') — Task 8
    virtual freshnessStatus    : String,
    virtual freshnessCriticality : Integer,
```

- [ ] **Step 5: Run the model test (SQLite auto-deploy)**

Run: `npx vitest run test/unit/freshness-model.test.js`
Expected: PASS.

- [ ] **Step 6: Verify HANA deploy compiles + regenerate migration**

Run: `npx cds build --production`
Expected: build succeeds; a new `.hdbmigrationtable`/`.hdbtable` set is emitted for the new entities and altered ApiDocs/Samples. **Do not hand-edit** the migration. If the second `hana`/`dest:db` task (`.cdsrc.json:15`) blanks the fresh migration, re-run `cds build --production` and confirm the ALTER is present before committing (memory `cdsrc-second-hana-task-clobbers-fresh-migration`).

- [ ] **Step 7: Commit**

```bash
git add db/tutorial-freshness.cds db/external-content.cds srv/admin-service.cds test/unit/freshness-model.test.js db/src gen 2>/dev/null; git add -A
git commit -m "feat(freshness): data model, ApiDocs/Samples embedding columns, projections"
```

---

### Task 3: ApiDocs/Samples embedding backfill job

Populates the new vector columns using the existing embedding client. Reuses the raw-SQL vector-write convention from `concept-embedding-backfill.js` (store `EMBEDDING` BLOB + `EMBEDDINGVEC = TO_REAL_VECTOR(?)`).

**Files:**
- Create: `srv/jobs/freshness-corpus-embedding-job.js`
- Test: `test/unit/freshness-corpus-embedding-job.test.js`

**Interfaces:**
- Consumes: `embed(inputs, model) → Promise<Float32Array[]>` from `srv/lib/embedding-client.js`.
- Produces: `export async function runFreshnessCorpusEmbedding(logId, opts?) → { apiDocs:number, samples:number }`.

- [ ] **Step 1: Write the failing test** (mock `embed`; SQLite BLOB path)

```js
// test/unit/freshness-corpus-embedding-job.test.js
import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async (inputs) => inputs.map(() => new Float32Array(1536).fill(0.01))),
}));

describe('runFreshnessCorpusEmbedding', () => {
  let db;
  beforeAll(async () => { db = await cds.test(process.cwd()); });

  it('embeds ApiDocs/Samples rows lacking an embedding and writes the BLOB', async () => {
    const { ApiDocs } = cds.entities('ims');
    await INSERT.into(ApiDocs).entries({ ID: cds.utils.uuid(), slug: 'x', title: 'X', description: 'desc' });
    const { runFreshnessCorpusEmbedding } = await import('../../srv/jobs/freshness-corpus-embedding-job.js');
    const res = await runFreshnessCorpusEmbedding('test-log');
    expect(res.apiDocs).toBeGreaterThanOrEqual(1);
    const row = await SELECT.one.from(ApiDocs).columns('ID', 'embedding').where({ slug: 'x' });
    expect(row.embedding).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-corpus-embedding-job.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/jobs/freshness-corpus-embedding-job.js
import cds from '@sap/cds';
import { embed } from '../lib/embedding-client.js';

const LOG = cds.log('freshness-corpus-embedding');
const BATCH = 100;

// SQLite unit tests can't run TO_REAL_VECTOR; guard on the HANA dialect.
function isHana(db) { return (db.kind || db.options?.kind) === 'hana'; }

async function embedEntity(db, entity, tableName) {
  const rows = await SELECT.from(entity).columns('ID', 'title', 'description').where('embedding is null');
  let n = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const vectors = await embed(chunk.map(r => `${r.title || ''}\n${r.description || ''}`.trim()));
    for (let j = 0; j < chunk.length; j++) {
      const vec = vectors[j];
      const blob = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
      if (isHana(db)) {
        const arr = '[' + Array.from(vec, x => x.toFixed(6)).join(',') + ']';
        // raw SQL: TO_REAL_VECTOR + BLOB are not expressible in CDS QL (sanctioned exception)
        await db.run(
          `UPDATE "${tableName}" SET "EMBEDDING" = ?, "EMBEDDINGVEC" = TO_REAL_VECTOR(?) WHERE "ID" = ?`,
          [blob, arr, chunk[j].ID],
        );
      } else {
        await UPDATE(entity).set({ embedding: blob }).where({ ID: chunk[j].ID });
      }
      n++;
    }
  }
  return n;
}

export async function runFreshnessCorpusEmbedding(_logId, _opts) {
  const db = await cds.connect.to('db');
  const { ApiDocs, Samples } = cds.entities('ims');
  try {
    const apiDocs = await embedEntity(db, ApiDocs, 'IMS_APIDOCS');
    const samples = await embedEntity(db, Samples, 'IMS_SAMPLES');
    LOG.info(`embedded apiDocs=${apiDocs} samples=${samples}`);
    return { apiDocs, samples };
  } catch (err) {
    LOG.error('corpus embedding failed', err);
    throw err;   // re-throw so runWithLock records FAILED
  }
}
```

> **Verify the HANA table names** (`IMS_APIDOCS`, `IMS_SAMPLES`) against `gen/db` output during Task 6/Task 11 build — CAP flattens `ims.ApiDocs` to `IMS_APIDOCS`; adjust if the generated name differs.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/freshness-corpus-embedding-job.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/freshness-corpus-embedding-job.js test/unit/freshness-corpus-embedding-job.test.js
git commit -m "feat(freshness): backfill job for ApiDocs/Samples embeddings"
```

---

### Task 4: Grounding helper (`srv/lib/freshness-grounding.js`)

Given a code block, embed it and cosine-search ApiDocs/Samples embeddings for the nearest chunks. Mirrors `srv/lib/kg/concept-embedding-query.js#topConceptsByCosine`.

**Files:**
- Create: `srv/lib/freshness-grounding.js`
- Test: `test/unit/freshness-grounding.test.js`

**Interfaces:**
- Consumes: `embed` from `embedding-client.js`.
- Produces: `groundCodeBlock({ db, code, limit=4, minScore=0.25 }) → Promise<Array<{ source:'apidoc'|'sample', id, title, url, score }>>` sorted by score desc.

- [ ] **Step 1: Write the failing test** (SQLite Float32 path)

```js
// test/unit/freshness-grounding.test.js
import { describe, it, expect, beforeAll, vi } from 'vitest';
import cds from '@sap/cds';

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async () => [new Float32Array(1536).fill(0.5)]),
}));

describe('groundCodeBlock', () => {
  let db;
  beforeAll(async () => { db = await cds.test(process.cwd()); });

  it('returns nearest ApiDocs chunks above minScore', async () => {
    const { ApiDocs } = cds.entities('ims');
    const vec = new Float32Array(1536).fill(0.5);
    const blob = Buffer.from(vec.buffer);
    await INSERT.into(ApiDocs).entries({ ID: cds.utils.uuid(), slug: 'fetch-api', title: 'Fetch API', url: 'https://x', embedding: blob });
    const { groundCodeBlock } = await import('../../srv/lib/freshness-grounding.js');
    const hits = await groundCodeBlock({ db, code: 'require("node-fetch")', limit: 3 });
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).toMatchObject({ source: 'apidoc', title: 'Fetch API' });
    expect(hits[0].score).toBeGreaterThan(0.9);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-grounding.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/freshness-grounding.js
import cds from '@sap/cds';
import { embed } from './embedding-client.js';

function isHana(db) { return (db.kind || db.options?.kind) === 'hana'; }
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}
function decode(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}

async function searchEntity(db, tableName, source, qVec, limit, minScore) {
  if (isHana(db)) {
    const arr = '[' + Array.from(qVec, x => x.toFixed(6)).join(',') + ']';
    // raw SQL: COSINE_SIMILARITY + BLOB (sanctioned exception). Do NOT select EMBEDDING here.
    const rows = await db.run(
      `SELECT TOP ${limit} "ID", "TITLE", "URL",
              COSINE_SIMILARITY("EMBEDDINGVEC", TO_REAL_VECTOR(?)) AS "SCORE"
         FROM "${tableName}" WHERE "EMBEDDINGVEC" IS NOT NULL ORDER BY "SCORE" DESC`, [arr]);
    return rows.filter(r => r.SCORE >= minScore)
               .map(r => ({ source, id: r.ID, title: r.TITLE, url: r.URL, score: r.SCORE }));
  }
  // SQLite unit path: decode Float32 BLOB, rank locally.
  const { ApiDocs, Samples } = cds.entities('ims');
  const entity = source === 'apidoc' ? ApiDocs : Samples;
  const rows = await SELECT.from(entity).columns('ID', 'title', 'url', 'embedding').where('embedding is not null');
  return rows.map(r => ({ source, id: r.ID, title: r.title, url: r.url, score: cosine(qVec, decode(r.embedding)) }))
             .filter(r => r.score >= minScore)
             .sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function groundCodeBlock({ db, code, limit = 4, minScore = 0.25 }) {
  if (!code || !code.trim()) return [];
  const [qVec] = await embed([code]);
  if (!qVec) return [];
  const [a, s] = await Promise.all([
    searchEntity(db, 'IMS_APIDOCS', 'apidoc', qVec, limit, minScore),
    searchEntity(db, 'IMS_SAMPLES', 'sample', qVec, limit, minScore),
  ]);
  return [...a, ...s].sort((x, y) => y.score - x.score).slice(0, limit);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/freshness-grounding.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/freshness-grounding.js test/unit/freshness-grounding.test.js
git commit -m "feat(freshness): grounding helper (cosine over ApiDocs/Samples)"
```

---

### Task 5: Detection engine (`srv/lib/freshness-detector.js`)

Orchestrates extract → ground → one forced-tool-call LLM request. Mirrors `srv/lib/explainer-generator.js` exactly (SDK client shape, `resolveChatLlmSettings`, `getToolCalls`/`getTokenUsage`). Exposes a `globalThis.__FRESHNESS_TEST_IMPL__` hook so unit tests inject canned findings without a live AI Core.

**Files:**
- Create: `srv/lib/freshness-detector.js`
- Test: `test/unit/freshness-detector.test.js`
- Test: `test/unit/freshness-prompt-guard.test.js`

**Interfaces:**
- Consumes: `extractCodeBlocks` (Task 1), `groundCodeBlock` (Task 4), `resolveChatLlmSettings` from `./chat-settings-resolver.js`, `tokensToCents` from `./_token-cost.js`.
- Produces:
  - `export const FRESHNESS_TOOL_SPEC` — the JSON-schema tool contract.
  - `detectFreshness({ db, tutorialId }) → Promise<{ model:string, costCents:number, findings:Array<Finding> }>` where `Finding = { category, severity, confidence, stepRef, codeBlockIndex, lang, evidence, summary, suggestedFix, groundingSource }`.

- [ ] **Step 1: Write the failing tests**

```js
// test/unit/freshness-detector.test.js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';

describe('detectFreshness', () => {
  let db;
  beforeAll(async () => { db = await cds.test(process.cwd()); });
  afterEach(() => { delete globalThis.__FRESHNESS_TEST_IMPL__; });

  it('uses the test-impl hook and returns findings + cost', async () => {
    const { Tutorials, Steps } = cds.entities('ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo', title: 'Demo', legacyId: 1 });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, number: 1, content: '```JavaScript\nrequire("node-fetch");\n```' });

    globalThis.__FRESHNESS_TEST_IMPL__ = async ({ blocks }) => ({
      promptTokens: 100, completionTokens: 50, modelName: 'anthropic--claude-4.6-sonnet',
      findings: [{ category: 'obsolete-dep', severity: 'High', confidence: 'High',
        stepRef: blocks[0].stepRef, codeBlockIndex: 0, lang: 'JavaScript',
        evidence: 'require("node-fetch")', summary: 'node-fetch obsolete',
        suggestedFix: 'use native fetch', groundingSource: 'https://x' }],
    });

    const { detectFreshness } = await import('../../srv/lib/freshness-detector.js');
    const res = await detectFreshness({ db, tutorialId: tid });
    expect(res.findings).toHaveLength(1);
    expect(res.findings[0].category).toBe('obsolete-dep');
    expect(res.costCents).toBeGreaterThan(0);
  });

  it('fails open (returns empty findings) when the impl throws', async () => {
    const { Tutorials, Steps } = cds.entities('ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo2', title: 'D2', legacyId: 2 });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, number: 1, content: '```js\nx\n```' });
    globalThis.__FRESHNESS_TEST_IMPL__ = async () => { throw new Error('LLM down'); };
    const { detectFreshness } = await import('../../srv/lib/freshness-detector.js');
    const res = await detectFreshness({ db, tutorialId: tid });
    expect(res.findings).toEqual([]);
  });
});
```

```js
// test/unit/freshness-prompt-guard.test.js
import { describe, it, expect } from 'vitest';
import { FRESHNESS_TOOL_SPEC } from '../../srv/lib/freshness-detector.js';

describe('FRESHNESS_TOOL_SPEC', () => {
  it('requires confidence and groundingSource on every finding', () => {
    const item = FRESHNESS_TOOL_SPEC.function.parameters.properties.findings.items;
    expect(item.required).toEqual(expect.arrayContaining(['confidence', 'groundingSource', 'category', 'severity', 'stepRef', 'codeBlockIndex']));
    expect(item.properties.confidence.enum).toEqual(['High', 'Medium', 'Low']);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/unit/freshness-detector.test.js test/unit/freshness-prompt-guard.test.js`
Expected: FAIL — module/export not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/freshness-detector.js
import cds from '@sap/cds';
import { OrchestrationClient } from '@sap-ai-sdk/orchestration';
import { extractCodeBlocks } from './freshness-extract.js';
import { groundCodeBlock } from './freshness-grounding.js';
import { resolveChatLlmSettings } from './chat-settings-resolver.js';
import { tokensToCents } from './_token-cost.js';

const LOG = cds.log('freshness-detector');
const TOOL_NAME = 'submit_freshness_findings';
const MAX_TOKENS = 2000;
const TEMPERATURE = 0;

export const FRESHNESS_TOOL_SPEC = {
  type: 'function',
  function: {
    name: TOOL_NAME,
    description: 'Report code/dependency staleness findings for a tutorial.',
    parameters: {
      type: 'object', additionalProperties: false, required: ['findings'],
      properties: {
        findings: {
          type: 'array',
          items: {
            type: 'object', additionalProperties: false,
            required: ['category', 'severity', 'confidence', 'stepRef', 'codeBlockIndex', 'evidence', 'summary', 'suggestedFix', 'groundingSource'],
            properties: {
              category: { type: 'string', enum: ['obsolete-dep', 'deprecated-api', 'dated-style', 'hardcoded-secret', 'broken-flow'] },
              severity: { type: 'string', enum: ['High', 'Medium', 'Low'] },
              confidence: { type: 'string', enum: ['High', 'Medium', 'Low'] },
              stepRef: { type: 'integer' },
              codeBlockIndex: { type: 'integer' },
              lang: { type: 'string' },
              evidence: { type: 'string' },
              summary: { type: 'string' },
              suggestedFix: { type: 'string' },
              groundingSource: { type: 'string', description: 'Cited doc URL, or empty string if the claim is not supported by provided grounding context (then confidence MUST be Low).' },
            },
          },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = [
  'You are a technical reviewer detecting STALE code and dependencies in SAP developer tutorials.',
  'You are given code blocks (each with a stepRef + codeBlockIndex) and, per block, grounding context retrieved from official SAP docs.',
  'Report obsolete dependencies, deprecated/superseded APIs, dated idioms, hardcoded secrets, and broken step flow.',
  'RULES: Echo back the exact stepRef and codeBlockIndex you were given — never invent locations.',
  'Every finding MUST carry a confidence tier. If an API-obsolescence claim is NOT supported by the provided grounding context, set confidence to "Low" and leave groundingSource empty.',
  'Prefer High confidence only for clear, verifiable staleness (e.g. a dependency with a native replacement, a hardcoded credential).',
].join(' ');

function buildUserMessage(blocks, groundingByBlock) {
  return blocks.map((b, i) => {
    const g = (groundingByBlock[i] || []).map(h => `- ${h.title} (${h.url || 'n/a'}) [score ${h.score.toFixed(2)}]`).join('\n') || '- (no grounding context found)';
    return `### Block stepRef=${b.stepRef} codeBlockIndex=${b.codeBlockIndex} lang=${b.lang}\n\`\`\`\n${b.code}\n\`\`\`\nGrounding:\n${g}`;
  }).join('\n\n');
}

async function callLlm({ blocks, userMessage }) {
  const hook = globalThis.__FRESHNESS_TEST_IMPL__;
  if (typeof hook === 'function') return hook({ blocks, userMessage });

  const { modelName, deploymentId } = await resolveChatLlmSettings();
  const client = new OrchestrationClient({
    promptTemplating: {
      model: { name: modelName, params: { max_tokens: MAX_TOKENS, temperature: TEMPERATURE,
        tool_choice: { type: 'function', function: { name: TOOL_NAME } } } },
      prompt: { template: [{ role: 'system', content: SYSTEM_PROMPT }], tools: [FRESHNESS_TOOL_SPEC] },
    },
  }, { deploymentId });

  const response = await client.chatCompletion({ messagesHistory: [{ role: 'user', content: userMessage }] });
  const calls = response.getToolCalls?.() ?? [];
  const submit = calls.find(c => c.function?.name === TOOL_NAME);
  const parsed = submit ? JSON.parse(submit.function.arguments) : { findings: [] };
  const usage = response.getTokenUsage?.() ?? {};
  return { findings: parsed.findings ?? [], promptTokens: usage.prompt_tokens ?? 0,
           completionTokens: usage.completion_tokens ?? 0, modelName };
}

export async function detectFreshness({ db, tutorialId }) {
  db = db || (await cds.connect.to('db'));
  const { Steps } = cds.entities('ims');
  try {
    const steps = await SELECT.from(Steps).columns('number', 'content').where({ tutorial_ID: tutorialId }).orderBy('number');
    const blocks = extractCodeBlocks(steps);
    if (!blocks.length) return { model: null, costCents: 0, findings: [] };

    const groundingByBlock = await Promise.all(blocks.map(b => groundCodeBlock({ db, code: b.code }).catch(() => [])));
    const userMessage = buildUserMessage(blocks, groundingByBlock);

    const r = await callLlm({ blocks, userMessage });
    let costCents = 0;
    try { costCents = tokensToCents({ promptTokens: r.promptTokens, completionTokens: r.completionTokens, modelName: r.modelName }); }
    catch { costCents = 0; }
    // trust only locations that map to a real block (guards invented anchors)
    const valid = new Set(blocks.map(b => `${b.stepRef}:${b.codeBlockIndex}`));
    const findings = (r.findings || []).filter(f => valid.has(`${f.stepRef}:${f.codeBlockIndex}`))
      .map(f => (f.groundingSource ? f : { ...f, confidence: 'Low' })); // enforce: no citation ⇒ Low
    return { model: r.modelName, costCents, findings };
  } catch (err) {
    LOG.error('detection failed — failing open', err);
    return { model: null, costCents: 0, findings: [] };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/unit/freshness-detector.test.js test/unit/freshness-prompt-guard.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/freshness-detector.js test/unit/freshness-detector.test.js test/unit/freshness-prompt-guard.test.js
git commit -m "feat(freshness): detection engine (forced-tool-call LLM + grounding + fail-open)"
```

---

### Task 6: Persistence + disposition migration (`srv/lib/freshness-persist.js`)

Computes fingerprints, carries forward prior dispositions on matching findings, and atomically replaces the current report.

**Files:**
- Create: `srv/lib/freshness-persist.js`
- Test: `test/unit/freshness-persist.test.js`

**Interfaces:**
- Produces:
  - `fingerprintFinding(f) → string` (SHA-256 of `category|stepRef|codeBlockIndex|evidence`).
  - `persistReport({ db, tutorialId, model, costCents, findings }) → Promise<{ reportId:string, openHighCount:number }>`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/freshness-persist.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('persistReport', () => {
  let db;
  beforeAll(async () => { db = await cds.test(process.cwd()); });

  const finding = (over = {}) => ({ category: 'obsolete-dep', severity: 'High', confidence: 'High',
    stepRef: 1, codeBlockIndex: 0, lang: 'js', evidence: 'require("node-fetch")',
    summary: 's', suggestedFix: 'f', groundingSource: 'https://x', ...over });

  it('persists findings, computes openHighCount, and replaces on re-run', async () => {
    const { Tutorials } = cds.entities('ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'p', title: 'P', legacyId: 9 });
    const { persistReport } = await import('../../srv/lib/freshness-persist.js');

    const r1 = await persistReport({ db, tutorialId: tid, model: 'm', costCents: 5, findings: [finding(), finding({ codeBlockIndex: 1, confidence: 'Low' })] });
    expect(r1.openHighCount).toBe(1);

    const { FreshnessFinding } = cds.entities('ims');
    const persisted = await SELECT.from(FreshnessFinding).where({ tutorial_ID: tid });
    expect(persisted).toHaveLength(2);
  });

  it('carries forward disposition on a fingerprint match across re-runs', async () => {
    const { Tutorials, FreshnessFinding } = cds.entities('ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'p2', title: 'P2', legacyId: 10 });
    const { persistReport } = await import('../../srv/lib/freshness-persist.js');

    await persistReport({ db, tutorialId: tid, model: 'm', costCents: 1, findings: [finding()] });
    const f1 = await SELECT.one.from(FreshnessFinding).where({ tutorial_ID: tid });
    await UPDATE(FreshnessFinding).set({ disposition: 'DISMISSED', dispositionBy: 'tom' }).where({ ID: f1.ID });

    // re-run with the SAME finding + a NEW one
    await persistReport({ db, tutorialId: tid, model: 'm', costCents: 1, findings: [finding(), finding({ stepRef: 2 })] });
    const rows = await SELECT.from(FreshnessFinding).where({ tutorial_ID: tid });
    const same = rows.find(r => r.stepRef === 1);
    const fresh = rows.find(r => r.stepRef === 2);
    expect(same.disposition).toBe('DISMISSED');   // carried forward
    expect(fresh.disposition).toBe('OPEN');        // new finding
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-persist.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```js
// srv/lib/freshness-persist.js
import cds from '@sap/cds';
import { createHash } from 'node:crypto';

export function fingerprintFinding(f) {
  return createHash('sha256')
    .update(`${f.category}|${f.stepRef}|${f.codeBlockIndex}|${(f.evidence || '').trim()}`)
    .digest('hex').slice(0, 64);
}

export async function persistReport({ db, tutorialId, model, costCents, findings }) {
  db = db || (await cds.connect.to('db'));
  const { FreshnessReport, FreshnessFinding } = cds.entities('ims');
  const { centsToUsdString } = await import('./_token-cost.js');

  // prior dispositions keyed by fingerprint (for carry-forward)
  const prior = await SELECT.from(FreshnessFinding)
    .columns('fingerprint', 'disposition', 'dispositionBy', 'dispositionAt', 'dispositionNote')
    .where({ tutorial_ID: tutorialId });
  const priorByFp = new Map(prior.map(p => [p.fingerprint, p]));

  const stamped = (findings || []).map(f => {
    const fp = fingerprintFinding(f);
    const carry = priorByFp.get(fp);
    return {
      ID: cds.utils.uuid(), tutorial_ID: tutorialId, fingerprint: fp,
      category: f.category, severity: f.severity, confidence: f.confidence,
      stepRef: f.stepRef, codeBlockIndex: f.codeBlockIndex, lang: f.lang,
      evidence: f.evidence, summary: f.summary, suggestedFix: f.suggestedFix, groundingSource: f.groundingSource,
      disposition: carry?.disposition || 'OPEN',
      dispositionBy: carry?.dispositionBy || null,
      dispositionAt: carry?.dispositionAt || null,
      dispositionNote: carry?.dispositionNote || null,
    };
  });

  const openHighCount = stamped.filter(f => f.confidence === 'High' && f.disposition === 'OPEN').length;
  const reportId = cds.utils.uuid();

  await db.tx(async (tx) => {
    // replace: delete prior report(s) + findings for this tutorial, then insert the current one
    await tx.run(DELETE.from(FreshnessFinding).where({ tutorial_ID: tutorialId }));
    await tx.run(DELETE.from(FreshnessReport).where({ tutorial_ID: tutorialId }));
    await tx.run(INSERT.into(FreshnessReport).entries({
      ID: reportId, tutorial_ID: tutorialId, status: 'DONE', model,
      cost: centsToUsdString(costCents || 0), openHighCount, runAt: new Date().toISOString(),
    }));
    if (stamped.length) await tx.run(INSERT.into(FreshnessFinding).entries(stamped.map(s => ({ ...s, report_ID: reportId }))));
  });

  return { reportId, openHighCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/unit/freshness-persist.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/freshness-persist.js test/unit/freshness-persist.test.js
git commit -m "feat(freshness): persist reports with fingerprint disposition migration"
```

---

### Task 7: Service actions — `checkFreshness` + `setDisposition`

Per-tutorial trigger (enqueues a background run that writes status transitions) and a finding-level disposition setter. Handlers registered in `srv/admin-service.js` mirroring `clearKhorosLink` (`this.on('<action>', '<Entity>', ...)`, key via `req.params[0].ID`).

**Files:**
- Modify: `srv/admin-service.cds` (declare the two bound actions)
- Modify: `srv/admin-service.js` (register handlers)
- Test: `test/unit/freshness-actions.test.js`

**Interfaces:**
- Consumes: `detectFreshness` (Task 5), `persistReport` (Task 6).
- Produces:
  - `Tutorials` action `checkFreshness() returns { status: String; reportId: String }`.
  - `FreshnessFinding` action `setDisposition(disposition: String, note: String) returns { status: String }`.

- [ ] **Step 1: Declare actions in CDS**

In `srv/admin-service.cds`, add an `actions { }` block to the `Tutorials` projection (or `extend entity AdminService.Tutorials with actions`):

```cds
extend entity AdminService.Tutorials with actions {
  @(requires: 'Author')
  action checkFreshness() returns { status: String; reportId: String };
};
extend entity AdminService.FreshnessFinding with actions {
  @(requires: 'Author')
  action setDisposition(disposition: String, note: String) returns { status: String };
};
```

- [ ] **Step 2: Write the failing test**

```js
// test/unit/freshness-actions.test.js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';

describe('freshness service actions', () => {
  let srv, db;
  beforeAll(async () => { const t = await cds.test(process.cwd()); db = t; srv = await cds.connect.to('AdminService'); });
  afterEach(() => { delete globalThis.__FRESHNESS_TEST_IMPL__; });

  it('checkFreshness runs detection and persists a DONE report', async () => {
    const { Tutorials, Steps } = cds.entities('ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'act', title: 'Act', legacyId: 21 });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, number: 1, content: '```js\nrequire("node-fetch")\n```' });
    globalThis.__FRESHNESS_TEST_IMPL__ = async ({ blocks }) => ({ promptTokens: 10, completionTokens: 5, modelName: 'anthropic--claude-4.6-sonnet',
      findings: [{ category: 'obsolete-dep', severity: 'High', confidence: 'High', stepRef: blocks[0].stepRef, codeBlockIndex: 0, lang: 'js', evidence: 'require("node-fetch")', summary: 's', suggestedFix: 'f', groundingSource: 'https://x' }] });

    // bound action: call via the Tutorials entity key
    const res = await srv.send({ event: 'checkFreshness', entity: 'Tutorials', params: { ID: tid } });
    expect(res.status).toBe('DONE');
    const { FreshnessFinding } = cds.entities('ims');
    const findings = await SELECT.from(FreshnessFinding).where({ tutorial_ID: tid });
    expect(findings).toHaveLength(1);
  });

  it('setDisposition updates a finding', async () => {
    const { Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('ims');
    const tid = cds.utils.uuid(); const rid = cds.utils.uuid(); const fid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'd', title: 'D', legacyId: 22 });
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE' });
    await INSERT.into(FreshnessFinding).entries({ ID: fid, report_ID: rid, tutorial_ID: tid, fingerprint: 'x', category: 'dated-style', severity: 'Low', confidence: 'Low', disposition: 'OPEN' });
    const res = await srv.send({ event: 'setDisposition', entity: 'FreshnessFinding', params: { ID: fid }, data: { disposition: 'FIXED', note: 'done' } });
    expect(res.status).toBe('ok');
    const f = await SELECT.one.from(FreshnessFinding).where({ ID: fid });
    expect(f.disposition).toBe('FIXED');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-actions.test.js`
Expected: FAIL — handlers not registered.

- [ ] **Step 4: Register handlers in `srv/admin-service.js`**

Add inside the service `init()` (near the other `this.on('<action>', '<Entity>', ...)` registrations, e.g. by `clearKhorosLink`):

```js
this.on('checkFreshness', 'Tutorials', async (req) => {
  const tutorialId = req.params?.[0]?.ID;
  if (!tutorialId) return req.reject(400, 'tutorialId required');
  const { detectFreshness } = await import('./lib/freshness-detector.js');
  const { persistReport } = await import('./lib/freshness-persist.js');
  const db = await cds.connect.to('db');
  try {
    // run synchronously in unit/test context; in CF this returns fast enough for a
    // handful of code blocks. If p95 latency proves too high, move to setImmediate +
    // a QUEUED row (see plan note). For v1, run inline and return the terminal status.
    const { model, costCents, findings } = await detectFreshness({ db, tutorialId });
    const { reportId } = await persistReport({ db, tutorialId, model, costCents, findings });
    return { status: 'DONE', reportId };
  } catch (err) {
    cds.log('freshness').error('checkFreshness failed', err);
    // record a FAILED report so the UI shows the failure state, never a 500
    const { FreshnessReport } = cds.entities('ims');
    const reportId = cds.utils.uuid();
    await db.run(INSERT.into(FreshnessReport).entries({ ID: reportId, tutorial_ID: tutorialId, status: 'FAILED', error: String(err.message || err).slice(0, 1000) }));
    return { status: 'FAILED', reportId };
  }
});

this.on('setDisposition', 'FreshnessFinding', async (req) => {
  const id = req.params?.[0]?.ID;
  if (!id) return req.reject(400, 'finding id required');
  const { disposition, note } = req.data;
  if (!['OPEN', 'ACCEPTED', 'DISMISSED', 'FIXED'].includes(disposition)) return req.reject(400, 'invalid disposition');
  const { FreshnessFinding } = cds.entities('ims');
  await UPDATE(FreshnessFinding).set({
    disposition, dispositionNote: note || null,
    dispositionBy: req.user?.id || 'unknown', dispositionAt: new Date().toISOString(),
  }).where({ ID: id });
  return { status: 'ok' };
});
```

> **Latency note (decision recorded in spec):** v1 runs `checkFreshness` inline and returns the terminal status. The spec's QUEUED→RUNNING→DONE state machine is the fallback if inline p95 exceeds the approuter timeout on real content; the `status` field already models it. Do not add the background runner unless a hybrid smoke shows a timeout.

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/freshness-actions.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/freshness-actions.test.js
git commit -m "feat(freshness): checkFreshness + setDisposition service actions"
```

---

### Task 8: Worklist virtuals + criticality (`after('READ')`)

Populate `Tutorials.openHighCount`/`freshnessStatus`/`freshnessCriticality` and `FreshnessFinding.confidenceCriticality` at read time. Criticality enum: **1=Negative(red), 2=Critical(yellow), 3=Positive(green), 0=Neutral** (matches `PipelineLog` at `srv/admin-service.js:1998-2031`).

**Files:**
- Modify: `srv/admin-service.cds` (add `virtual confidenceCriticality : Integer` to `FreshnessFinding` projection)
- Modify: `srv/admin-service.js` (two `after('READ')` handlers)
- Test: `test/unit/freshness-read-decorators.test.js`

**Interfaces:**
- Produces: populated virtuals on `Tutorials` and `FreshnessFinding` reads.

- [ ] **Step 1: Add the finding virtual in CDS**

```cds
// in srv/admin-service.cds — extend the FreshnessFinding projection
extend projection AdminService.FreshnessFinding with columns {
  virtual confidenceCriticality : Integer
};
```

- [ ] **Step 2: Write the failing test**

```js
// test/unit/freshness-read-decorators.test.js
import { describe, it, expect, beforeAll } from 'vitest';
import cds from '@sap/cds';

describe('freshness read decorators', () => {
  let srv;
  beforeAll(async () => { await cds.test(process.cwd()); srv = await cds.connect.to('AdminService'); });

  it('sets openHighCount + freshnessCriticality on Tutorials', async () => {
    const { Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('ims');
    const tid = cds.utils.uuid(); const rid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'w', title: 'W', legacyId: 31 });
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE', openHighCount: 2 });
    await INSERT.into(FreshnessFinding).entries({ ID: cds.utils.uuid(), report_ID: rid, tutorial_ID: tid, fingerprint: 'a', category: 'obsolete-dep', severity: 'High', confidence: 'High', disposition: 'OPEN' });

    const row = await srv.run(SELECT.one.from('AdminService.Tutorials').columns('ID', 'openHighCount', 'freshnessCriticality').where({ ID: tid }));
    expect(row.openHighCount).toBe(2);
    expect(row.freshnessCriticality).toBe(1);   // >0 open-high ⇒ red
  });

  it('maps confidence to criticality on findings', async () => {
    const { Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('ims');
    const tid = cds.utils.uuid(); const rid = cds.utils.uuid(); const fid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'w2', title: 'W2', legacyId: 32 });
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE' });
    await INSERT.into(FreshnessFinding).entries({ ID: fid, report_ID: rid, tutorial_ID: tid, fingerprint: 'b', category: 'obsolete-dep', severity: 'High', confidence: 'High', disposition: 'OPEN' });
    const f = await srv.run(SELECT.one.from('AdminService.FreshnessFinding').columns('ID', 'confidenceCriticality').where({ ID: fid }));
    expect(f.confidenceCriticality).toBe(1);   // High confidence ⇒ red
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-read-decorators.test.js`
Expected: FAIL — virtuals undefined.

- [ ] **Step 4: Add the decorators in `srv/admin-service.js`**

```js
this.after('READ', 'Tutorials', async (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const ids = list.map(r => r?.ID).filter(Boolean);
  if (!ids.length) return;
  try {
    const { FreshnessReport } = cds.entities('ims');
    const reports = await SELECT.from(FreshnessReport).columns('tutorial_ID', 'status', 'openHighCount').where({ tutorial_ID: { in: ids } });
    const byT = new Map(reports.map(r => [r.tutorial_ID, r]));
    for (const row of list) {
      const rep = byT.get(row.ID);
      row.openHighCount = rep?.openHighCount ?? 0;
      row.freshnessStatus = rep?.status ?? null;
      row.freshnessCriticality = (rep?.openHighCount > 0) ? 1 : (rep?.status === 'DONE' ? 3 : 0);
    }
  } catch (err) { cds.log('freshness').warn('Tutorials freshness decorate failed', err); }
});

this.after('READ', 'FreshnessFinding', (rows) => {
  const list = Array.isArray(rows) ? rows : [rows];
  const map = { High: 1, Medium: 2, Low: 0 };   // High-confidence dominates visually
  for (const row of list) if (row) row.confidenceCriticality = map[row.confidence] ?? 0;
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/unit/freshness-read-decorators.test.js`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js test/unit/freshness-read-decorators.test.js
git commit -m "feat(freshness): worklist count + criticality read decorators"
```

---

### Task 9: Bulk scan job + feature flag

Optional catalog-wide driver reusing the engine, default OFF, budget-capped, self-skipping. Registered in the scheduler and gated by a feature flag.

**Files:**
- Create: `srv/jobs/freshness-scan-job.js`
- Modify: `srv/jobs/scheduler.js` (register both the scan job and the corpus-embedding job from Task 3)
- Modify: `srv/lib/feature-flags/registry.js` (register `FRESHNESS_SCAN_ENABLED`)
- Test: `test/unit/freshness-scan-job.test.js`

**Interfaces:**
- Consumes: `detectFreshness`, `persistReport`.
- Produces: `export async function runFreshnessScan(logId, opts?) → { scanned:number, skipped:boolean }`.

- [ ] **Step 1: Write the failing test**

```js
// test/unit/freshness-scan-job.test.js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';

describe('runFreshnessScan', () => {
  beforeAll(async () => { await cds.test(process.cwd()); });
  afterEach(() => { delete process.env.FRESHNESS_SCAN_ENABLED; delete globalThis.__FRESHNESS_TEST_IMPL__; });

  it('self-skips when the flag is off', async () => {
    delete process.env.FRESHNESS_SCAN_ENABLED;
    const { runFreshnessScan } = await import('../../srv/jobs/freshness-scan-job.js');
    const res = await runFreshnessScan('log');
    expect(res.skipped).toBe(true);
  });

  it('scans tutorials when enabled', async () => {
    process.env.FRESHNESS_SCAN_ENABLED = 'true';
    globalThis.__FRESHNESS_TEST_IMPL__ = async () => ({ promptTokens: 1, completionTokens: 1, modelName: 'anthropic--claude-4.6-sonnet', findings: [] });
    const { Tutorials, Steps } = cds.entities('ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'scan', title: 'S', legacyId: 41 });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, number: 1, content: '```js\nx\n```' });
    const { runFreshnessScan } = await import('../../srv/jobs/freshness-scan-job.js');
    const res = await runFreshnessScan('log', { limit: 5 });
    expect(res.skipped).toBe(false);
    expect(res.scanned).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/unit/freshness-scan-job.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the job**

```js
// srv/jobs/freshness-scan-job.js
import cds from '@sap/cds';
import { detectFreshness } from '../lib/freshness-detector.js';
import { persistReport } from '../lib/freshness-persist.js';

const LOG = cds.log('freshness-scan');
const DEFAULT_LIMIT = 50;   // budget cap per run

export async function runFreshnessScan(_logId, opts = {}) {
  if (process.env.FRESHNESS_SCAN_ENABLED !== 'true') {
    LOG.info('FRESHNESS_SCAN_ENABLED != true — skipping');
    return { scanned: 0, skipped: true };
  }
  const db = await cds.connect.to('db');
  const { Tutorials } = cds.entities('ims');
  const limit = opts.limit || DEFAULT_LIMIT;
  const tutorials = await SELECT.from(Tutorials).columns('ID').limit(limit);
  let scanned = 0;
  for (const t of tutorials) {
    try {
      const { model, costCents, findings } = await detectFreshness({ db, tutorialId: t.ID });
      await persistReport({ db, tutorialId: t.ID, model, costCents, findings });
      scanned++;
    } catch (err) { LOG.warn(`scan failed for ${t.ID}`, err); }   // per-tutorial fail-open
  }
  LOG.info(`freshness scan complete — scanned=${scanned}`);
  return { scanned, skipped: false };
}
```

- [ ] **Step 4: Register in the scheduler**

In `srv/jobs/scheduler.js` `registerJobs()`, add (off-minute cron):

```js
registerJob({
  jobName: 'freshness-scan',
  schedule: '23 4 * * *',
  ttlMs: 1800000,
  description: 'Bulk tutorial freshness scan (gated by FRESHNESS_SCAN_ENABLED, default OFF)',
  fn: (logId) => import('./freshness-scan-job.js').then(m => m.runFreshnessScan(logId)),
});
registerJob({
  jobName: 'freshness-corpus-embedding',
  schedule: '17 3 * * *',
  ttlMs: 1800000,
  description: 'Backfill ApiDocs/Samples embeddings for freshness grounding',
  fn: (logId) => import('./freshness-corpus-embedding-job.js').then(m => m.runFreshnessCorpusEmbedding(logId)),
});
```

- [ ] **Step 5: Register the feature flag**

In `srv/lib/feature-flags/registry.js`, add to the registry array:

```js
{
  key: 'FRESHNESS_SCAN_ENABLED', label: 'Tutorial freshness bulk scan', category: 'Content',
  kind: 'env', envVar: 'FRESHNESS_SCAN_ENABLED', envRule: 'true-enables',
  valueType: 'boolean', default: false, status: 'dev-only',
  description: 'When true, the nightly freshness-scan job runs the detector across the tutorial catalog. Default OFF.',
  howToChange: cfEnv('FRESHNESS_SCAN_ENABLED', 'true'),
},
```

- [ ] **Step 6: Run tests (job + feature-flags guard)**

Run: `npx vitest run test/unit/freshness-scan-job.test.js test/unit/feature-flags-registry.test.js`
Expected: PASS (both — the registry guard must stay green).

- [ ] **Step 7: Commit**

```bash
git add srv/jobs/freshness-scan-job.js srv/jobs/scheduler.js srv/lib/feature-flags/registry.js test/unit/freshness-scan-job.test.js
git commit -m "feat(freshness): bulk scan + corpus-embedding jobs, FRESHNESS_SCAN_ENABLED flag"
```

---

### Task 10: Fiori Elements annotations

Surface findings on the Object Page, the header trigger, disposition, and the List Report worklist column. All annotations live in `app/admin-annotations.cds`.

**Files:**
- Modify: `app/admin-annotations.cds`
- Test: manifest/annotation validation (no unit test — verified by `cds build` + MCP manifest validation)

- [ ] **Step 1: Annotate the FreshnessFinding LineItem + criticality**

```cds
annotate AdminService.FreshnessFinding with @UI: {
  LineItem: [
    { Value: confidence, Criticality: confidenceCriticality, ![@UI.Importance]: #High },
    { Value: severity },
    { Value: category },
    { Value: stepRef, Label: 'Step' },
    { Value: codeBlockIndex, Label: 'Block' },
    { Value: summary },
    { Value: suggestedFix },
    { Value: groundingSource, Label: 'Source' },
    { Value: disposition, Criticality: confidenceCriticality },
    { $Type: 'UI.DataFieldForAction', Action: 'AdminService.setDisposition', Label: 'Set disposition' }
  ],
  PresentationVariant: { SortOrder: [ { Property: confidence, Descending: true }, { Property: severity, Descending: true } ] }
};
annotate AdminService.FreshnessFinding with {
  suggestedFix @UI.MultiLineText;
  evidence     @UI.MultiLineText;
};
```

- [ ] **Step 2: Add the OP facet + header action to Tutorials**

In the existing `annotate AdminService.Tutorials with @UI: { Facets: [ ... ] }` (`app/admin-annotations.cds:759`), append a ReferenceFacet:

```cds
    { $Type: 'UI.ReferenceFacet', ID: 'FreshnessFacet', Label: 'Freshness',
      Target: 'freshnessFindings/@UI.LineItem' }
```

In the Tutorials `UI.Identification` (header actions, `:685`), append:

```cds
    { $Type: 'UI.DataFieldForAction', Label: 'Check freshness', Action: 'AdminService.checkFreshness', ![@UI.Importance]: #High }
```

- [ ] **Step 3: Add the List Report worklist column**

In the Tutorials `UI.LineItem`, add:

```cds
    { Value: openHighCount, Label: 'Stale flags', Criticality: freshnessCriticality }
```

- [ ] **Step 4: Validate**

Run: `npx cds build --production`
Expected: build succeeds with no annotation errors.
Then validate the app manifest (UI5 MCP): `run_manifest_validation` on `app/admin/tutorials/webapp/manifest.json`.
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "feat(freshness): FE facet, findings table, worklist column, header action"
```

---

### Task 11: Verification, srv-qa audit, and docs

Final integration pass: full test suite, migration regen, cp-list audit, and a CLAUDE.md gotcha entry.

**Files:**
- Modify: `CLAUDE.md` (Top Gotchas entry) and/or `docs/developers/reference/tutorials-ims-gotchas.md`
- Verify: `.deploy/mta.yaml` (srv-qa cp list)

- [ ] **Step 1: srv-qa cp-list audit**

Run: `git grep -n "freshness" srv/lib/content-store.js`
Expected: **no matches** — the freshness modules are not content-store deps, so no `.deploy/mta.yaml` `srv-qa` `cp` entry is required. If any match appears, add the transitive freshness `srv/lib/*` files to the `srv-qa` `cp` list (Global Constraints).

- [ ] **Step 2: Full unit suite + SQLite deploy check**

Run: `npx cds deploy --to sqlite::memory: 2>&1 | tail -5 && npm test`
Expected: deploy clean; all freshness tests pass; no pre-existing tests regressed.

- [ ] **Step 3: Regenerate + verify the migration**

Run: `npx cds build --production`
Expected: `.hdbmigrationtable` for the new entities + ApiDocs/Samples ALTER present. Confirm the second `hana`/`dest:db` task did not blank it (re-run if needed). Verify generated HANA table names match the `IMS_APIDOCS`/`IMS_SAMPLES` literals used in Tasks 3 & 4; fix the literals if CAP emitted different names.

- [ ] **Step 4: Add the gotcha doc**

Append to `CLAUDE.md` "Top Gotchas" (one entry):

```markdown
- **Freshness detector grounding needs the corpus-embedding backfill** — the `checkFreshness`/`freshness-scan` engine cosine-searches `ApiDocs`/`Samples` embeddings. Those columns are populated by `srv/jobs/freshness-corpus-embedding-job.js` (nightly `17 3` + on-demand `runJob`). Until it runs in an env, grounding returns nothing and every API-obsolescence claim degrades to `confidence: Low` (fail-open, by design). LLM calls use the SAP AI SDK directly (`@sap-ai-sdk/orchestration`, forced tool-call), NOT `@cap-js/ai`; unit tests inject `globalThis.__FRESHNESS_TEST_IMPL__`. Bulk scan gated by `FRESHNESS_SCAN_ENABLED` (default OFF).
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md .deploy/mta.yaml 2>/dev/null; git add -A
git commit -m "docs(freshness): gotcha entry + srv-qa cp audit note"
```

---

## Self-Review

**Spec coverage:**
- Data model (report + findings, disposition, fingerprint) → Task 2, 6. ✓
- Detection engine (extract → ground → LLM) → Tasks 1, 4, 5. ✓
- Grounding = ApiDocs/Samples embeddings (decision (b)) → Tasks 2, 3, 4. ✓
- Trigger `checkFreshness` + disposition → Task 7. ✓
- Worklist column + criticality → Task 8, 10. ✓
- Bulk scan job + flag → Task 9. ✓
- UI presentation (facet, confidence-first, header button, LR column) → Task 10. ✓
- Testing (unit + prompt guard + fail-open + hybrid grounding) → Tasks 1–9 unit; hybrid grounding smoke folded into Task 11 Step 3 (real-HANA verification) — **note:** a dedicated `test/hybrid/freshness-grounding.test.js` is recommended but deferred; the SQLite grounding test (Task 4) plus the Task 11 HANA deploy check cover v1.
- Fail-open, off-minute cron, re-throw in jobs, feature-flag registry → Global Constraints + Tasks 5, 7, 9. ✓
- Migration hazard (second db task) → Global Constraints + Tasks 2, 11. ✓

**Placeholder scan:** No TBD/TODO; every code step has concrete content. The one deferred item (hybrid grounding spec test) is explicitly flagged, not hidden.

**Type consistency:** `detectFreshness({db, tutorialId}) → {model, costCents, findings}` consumed identically in Tasks 7 & 9. `persistReport({db, tutorialId, model, costCents, findings}) → {reportId, openHighCount}` consistent. `extractCodeBlocks(steps) → [{stepRef, codeBlockIndex, lang, code}]` consumed in Task 5. Criticality enum (1/2/3/0) consistent across Tasks 8 & 10. `FRESHNESS_TOOL_SPEC` shape asserted in Task 5 guard test matches its use.

**Known implementation risks to watch (not blockers):**
- HANA table-name literals (`IMS_APIDOCS`/`IMS_SAMPLES`) are assumptions — verified in Task 11 Step 3.
- Bound-action invocation form in unit tests (`srv.send({event, entity, params})`) may need adjustment to the project's exact `cds.test` calling convention; the handler logic is the contract.
- Inline `checkFreshness` vs the spec's QUEUED state machine — v1 runs inline; escalate to background only if hybrid p95 shows a timeout (Task 7 note).
