# HANA Vector + RAG for Joule Tutorial Grounding — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add semantic step-level retrieval to Joule chat, backed by a HANA-native vector store of tutorial content.

**Architecture:** Per-step embeddings keyed by `(tutorial_ID, stepNumber)` stored as `Vector(1536)` in HANA, populated by a post-publish hook + hourly reconciliation cron, queried via `COSINE_SIMILARITY` from a new `getRelevantSteps` LLM tool gated by `ChatSettings.ragEnabled`.

**Tech Stack:** SAP CAP Node.js, HANA Cloud `Vector(1536)` + `COSINE_SIMILARITY`, `@sap-ai-sdk/foundation-models` for embeddings via `tutorials-aicore` BTP binding, `text-embedding-3-small`, cheerio for HTML parsing, Vitest (unit + hybrid + smoke), SAPUI5 admin tile.

**Spec:** [docs/superpowers/specs/2026-05-20-hana-vector-rag-design.md](../specs/2026-05-20-hana-vector-rag-design.md)

---

## File map

**New files (one responsibility each):**
- `srv/lib/step-text-extractor.js` — pure HTML→step-text
- `srv/lib/embedding-client.js` — AI Core SDK wrapper
- `srv/lib/embedding-pipeline.js` — orchestrator (extract+embed+upsert)
- `srv/lib/embedding-query.js` — query-time retrieval (HANA + SQLite branches)
- `srv/lib/embedding-stats.js` — admin coverage stats
- `srv/jobs/embedding-reconciliation.js` — cron job body
- Tests under `test/lib/`, `test/jobs/`, `test/hybrid/`, `test/smoke/`

**Modified files:**
- `db/schema.cds` — `TutorialEmbedding` entity, `Steps.contentHash`, four `ChatSettings` fields
- `srv/admin-service.cds` — `seedEmbeddings()` action
- `srv/admin-service.js` — `seedEmbeddings` impl
- `srv/lib/content-store.js` — post-publish hook
- `srv/lib/chat-orchestrator.js` — `GET_RELEVANT_STEPS_TOOL` registration + dispatch
- `srv/lib/chat-context.js` — persona RAG-citation guidance
- `srv/jobs/scheduler.js` — register reconciliation job
- `srv/server.js` — `/admin/embeddings/stats` route
- `srv/jobs/cleanup.js` — orphan TutorialEmbedding cleanup
- `app/admin/joule/webapp/view/Settings.view.xml` — RAG panel + Seed button
- `app/admin/joule/webapp/controller/Settings.controller.js` — bindings + seed handler
- `app/admin/joule/webapp/i18n/i18n.properties` — labels
- `app/admin-annotations.cds` — labels for new fields
- `db/change-tracking.cds` — verify new fields tracked
- Documentation: `docs/joule-chat.md`, `docs/content-pipeline.md`, new `docs/joule-chat-admin-settings.md`, `CLAUDE.md`

---

## Task ordering rationale

Tasks are ordered so the schema lands first (everything else compiles against it), then pure libs (extractor, client) with their unit tests, then the pipeline orchestrator, then the trigger points (publish hook, cron, query path), then admin surface, then docs. Each task ends with a commit so the history is bisectable.

---

## Task 1: Schema additions

**Files:**
- Modify: `db/schema.cds` (append `TutorialEmbedding` entity; add `contentHash` to `Steps`; add 4 fields to `ChatSettings` at line 340)
- Modify: `db/change-tracking.cds` (verify `ChatSettings` change-tracking still covers new fields)
- Test: `test/admin-schema-ext.test.js` (existing — extend with assertions for new fields)

- [ ] **Step 1: Locate the existing entities**

Run: `grep -n "entity ChatSettings\|entity Steps\b" db/schema.cds`
Expected: prints lines for `entity Steps : TaskBase` and `entity ChatSettings : cuid, managed`. Note line numbers.

- [ ] **Step 2: Add `contentHash` field to `Steps`**

Edit `db/schema.cds` and add `contentHash : String(64);` immediately before the closing `}` of the `Steps` entity. Position it after the existing fields, before any associations.

- [ ] **Step 3: Add four RAG fields to `ChatSettings`**

Replace the `ChatSettings` entity body so it reads:

```cds
entity ChatSettings : cuid, managed {
  enabled              : Boolean default false;
  deploymentId         : String(100);
  modelName            : String(100);
  temperature          : Decimal(3, 2);
  maxTokens            : Integer;
  maxRequestsPerUser   : Integer default 100;
  bannerText           : String(500);

  // RAG / vector grounding (see docs/joule-chat.md "Tutorial Grounding")
  ragEnabled           : Boolean default false;
  embeddingModel       : String(100) default 'text-embedding-3-small';
  embeddingTopK        : Integer default 5;
  embeddingMinScore    : Decimal(4, 3) default 0.25;
}
```

- [ ] **Step 4: Add `TutorialEmbedding` entity**

Append to the bottom of `db/schema.cds` (after `ChatSettings`):

```cds
entity TutorialEmbedding {
  key tutorial_ID  : UUID;
  key stepNumber   : Integer;
  contentHash      : String(64);
  embeddingModel   : String(100);
  embedding        : Vector(1536);
  text             : LargeString;
  charCount        : Integer;
  createdAt        : Timestamp @cds.on.insert: $now;
}
```

> NOTE: `Vector(1536)` is HANA Cloud's native vector type. CDS compiler maps it to `LargeBinary` on SQLite (verified via `cds compile --to sql`). Both branches are handled at query time by `embedding-query.js`.

- [ ] **Step 5: Verify CDS compiles**

Run: `npx cds compile db/schema.cds --to sql 2>&1 | head -30`
Expected: SQL output without errors. Look for `CREATE TABLE com_sap_developers_ims_TutorialEmbedding` and a column `embedding REAL_VECTOR(1536)` (HANA dialect) or `embedding BLOB` (SQLite). If errors appear about `Vector(1536)`, ensure your `@sap/cds-compiler` is >=4.5; check `cds version`.

- [ ] **Step 6: Confirm `change-tracking.cds` covers new fields**

Run: `grep -A 3 "ChatSettings" db/change-tracking.cds`
Expected: an annotation block for `ChatSettings`. If it lists explicit fields, append `ragEnabled`, `embeddingModel`, `embeddingTopK`, `embeddingMinScore`. If it uses `@changelog: { include: '*' }` or similar wildcard, no change needed.

- [ ] **Step 7: Run unit tests**

Run: `npm test`
Expected: PASS. The schema-shape tests should still pass; if any test asserts the column count of `ChatSettings`, update its expected value.

- [ ] **Step 8: Commit**

```bash
git add db/schema.cds db/change-tracking.cds
git commit -m "feat(schema): add TutorialEmbedding, Steps.contentHash, ChatSettings RAG fields

Adds the storage layer for the HANA vector + RAG feature gated by
ChatSettings.ragEnabled. No code wiring yet — fields default to off.

See docs/superpowers/specs/2026-05-20-hana-vector-rag-design.md"
```

---

## Task 2: Step text extractor (pure)

**Files:**
- Create: `srv/lib/step-text-extractor.js`
- Test: `test/lib/step-text-extractor.test.js`
- Test fixtures: `test/fixtures/step-extractor/v1-accordion.html`, `test/fixtures/step-extractor/v2-h3.html`

The extractor is pure (no I/O, no DB) so it can be unit-tested with fixtures. It accepts a gzip Buffer, decompresses, parses with cheerio, and returns step records. Both Hugo parser formats are supported.

- [ ] **Step 1: Create v1 fixture**

Create `test/fixtures/step-extractor/v1-accordion.html` with this content (it represents the legacy ACCORDION-based Hugo template):

```html
<!DOCTYPE html>
<html><body>
  <h1>How to bind XSUAA</h1>
  <div class="accordion-content" data-step="1">
    <p>First, install the dependency:</p>
    <pre><code>npm install @sap/xsuaa</code></pre>
  </div>
  <div class="accordion-content" data-step="2">
    <p>Bind the service via mta.yaml.</p>
  </div>
</body></html>
```

- [ ] **Step 2: Create v2 fixture**

Create `test/fixtures/step-extractor/v2-h3.html` with this content (represents the v2 parser output where each step is a `<section data-step="N">`):

```html
<!DOCTYPE html>
<html><body>
  <h1>How to bind XSUAA</h1>
  <section data-step="1">
    <h3>Install the dependency</h3>
    <p>First, install the dependency:</p>
    <pre><code>npm install @sap/xsuaa</code></pre>
  </section>
  <section data-step="2">
    <h3>Bind the service</h3>
    <p>Bind the service via mta.yaml.</p>
  </section>
</body></html>
```

- [ ] **Step 3: Write the failing test**

Create `test/lib/step-text-extractor.test.js`:

```javascript
import { describe, it, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { extractStepText, MAX_CHUNK_CHARS } from '../../srv/lib/step-text-extractor.js';

const fixture = (name) =>
  gzipSync(readFileSync(join(import.meta.dirname, '../fixtures/step-extractor', name)));

describe('step-text-extractor', () => {
  it('extracts steps from v1 ACCORDION format', () => {
    const steps = extractStepText(fixture('v1-accordion.html'));
    expect(steps).toHaveLength(2);
    expect(steps[0].stepNumber).toBe(1);
    expect(steps[0].text).toContain('install the dependency');
    expect(steps[0].text).toContain('npm install @sap/xsuaa');
    expect(steps[1].stepNumber).toBe(2);
    expect(steps[1].text).toContain('Bind the service via mta.yaml');
  });

  it('extracts steps from v2 H3/section format', () => {
    const steps = extractStepText(fixture('v2-h3.html'));
    expect(steps).toHaveLength(2);
    expect(steps[0].stepNumber).toBe(1);
    expect(steps[0].text).toContain('Install the dependency');
    expect(steps[1].text).toContain('Bind the service');
  });

  it('normalises whitespace (collapses runs to single space, trims)', () => {
    const html = '<section data-step="1"><p>a   b\n\n  c</p></section>';
    const steps = extractStepText(gzipSync(Buffer.from(html)));
    expect(steps[0].text).toBe('a b c');
  });

  it('truncates oversized chunks at sentence boundary', () => {
    const sentence = 'This is a sentence. ';
    const big = sentence.repeat(1000); // ~20000 chars
    const html = `<section data-step="1"><p>${big}</p></section>`;
    const steps = extractStepText(gzipSync(Buffer.from(html)));
    expect(steps[0].text.length).toBeLessThanOrEqual(MAX_CHUNK_CHARS);
    // truncation MUST end on a sentence boundary, not mid-sentence
    expect(steps[0].text).toMatch(/\.\s*$/);
    expect(steps[0].charCount).toBe(steps[0].text.length);
  });

  it('returns [] and does not throw on malformed HTML', () => {
    const steps = extractStepText(gzipSync(Buffer.from('<not really html')));
    expect(steps).toEqual([]);
  });

  it('returns [] when no step markers present', () => {
    const html = '<html><body><p>no steps here</p></body></html>';
    const steps = extractStepText(gzipSync(Buffer.from(html)));
    expect(steps).toEqual([]);
  });
});
```

- [ ] **Step 4: Run the test, confirm it fails**

Run: `npx vitest run test/lib/step-text-extractor.test.js`
Expected: FAIL with "Cannot find module '../../srv/lib/step-text-extractor.js'".

- [ ] **Step 5: Implement the extractor**

Create `srv/lib/step-text-extractor.js`:

```javascript
import { gunzipSync } from 'node:zlib';
import * as cheerio from 'cheerio';

export const MAX_CHUNK_CHARS = 8000;

/**
 * Decompress a gzipped HTML buffer and return per-step text records.
 * Handles both Hugo parser formats:
 *   v1 — `<div class="accordion-content" data-step="N">`
 *   v2 — `<section data-step="N">`
 *
 * Returns `[]` for malformed input or HTML without step markers.
 *
 * @param {Buffer} gzBuffer
 * @returns {Array<{stepNumber: number, text: string, charCount: number}>}
 */
export function extractStepText(gzBuffer) {
  let html;
  try {
    html = gunzipSync(gzBuffer).toString('utf8');
  } catch {
    return [];
  }

  let $;
  try {
    $ = cheerio.load(html);
  } catch {
    return [];
  }

  const nodes = $('[data-step]');
  if (nodes.length === 0) return [];

  const out = [];
  nodes.each((_, el) => {
    const num = Number($(el).attr('data-step'));
    if (!Number.isInteger(num) || num < 1) return;
    const raw = $(el).text();
    const text = truncateAtSentence(normalise(raw), MAX_CHUNK_CHARS);
    if (!text) return;
    out.push({ stepNumber: num, text, charCount: text.length });
  });
  return out;
}

function normalise(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function truncateAtSentence(s, max) {
  if (s.length <= max) return s;
  const slice = s.slice(0, max);
  const lastDot = slice.lastIndexOf('.');
  if (lastDot > max * 0.5) return slice.slice(0, lastDot + 1).trimEnd();
  return slice.trimEnd();
}
```

- [ ] **Step 6: Verify cheerio is installed**

Run: `node -e "import('cheerio').then(c => console.log(typeof c.load))"`
Expected: prints `function`. If "Cannot find package 'cheerio'", run `npm install cheerio` (it's already a transitive dep but may need direct add — check `package.json`).

- [ ] **Step 7: Run tests, confirm they pass**

Run: `npx vitest run test/lib/step-text-extractor.test.js`
Expected: PASS — all 6 tests green.

- [ ] **Step 8: Commit**

```bash
git add srv/lib/step-text-extractor.js test/lib/step-text-extractor.test.js test/fixtures/step-extractor/
git commit -m "feat(rag): pure step-text extractor for v1+v2 Hugo HTML"
```

---

## Task 3: Embedding client (AI Core wrapper)

**Files:**
- Create: `srv/lib/embedding-client.js`
- Test: `test/lib/embedding-client.test.js`
- Modify: `package.json` (add `@sap-ai-sdk/foundation-models` if missing)

The client wraps the SAP AI SDK foundation-models embedding endpoint. It batches up to 100 inputs per call, retries with exponential backoff on 429 / 5xx (max 3 attempts), and returns `Float32Array` outputs aligned with the input order.

- [ ] **Step 1: Confirm `@sap-ai-sdk/foundation-models` availability**

Run: `npm ls @sap-ai-sdk/foundation-models 2>&1 | head -3`
Expected: prints a version, OR "(empty)". If empty, run `npm install @sap-ai-sdk/foundation-models` (must match the major version of `@sap-ai-sdk/orchestration` already in `package.json`).

- [ ] **Step 2: Write the failing test**

Create `test/lib/embedding-client.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockCreate = vi.fn();
vi.mock('@sap-ai-sdk/foundation-models', () => ({
  AzureOpenAiEmbeddingClient: vi.fn().mockImplementation(() => ({
    run: mockCreate
  }))
}));

const { embed } = await import('../../srv/lib/embedding-client.js');

beforeEach(() => mockCreate.mockReset());

describe('embedding-client', () => {
  it('returns vectors aligned with input order', async () => {
    mockCreate.mockResolvedValueOnce({
      data: [
        { embedding: [0.1, 0.2], index: 0 },
        { embedding: [0.3, 0.4], index: 1 }
      ]
    });
    const out = await embed(['hello', 'world'], 'text-embedding-3-small');
    expect(out).toHaveLength(2);
    expect(Array.from(out[0])).toEqual([0.1, 0.2]);
    expect(Array.from(out[1])).toEqual([0.3, 0.4]);
  });

  it('batches inputs over 100 at a time', async () => {
    mockCreate.mockResolvedValue({
      data: Array.from({ length: 100 }, (_, i) => ({ embedding: [i], index: i }))
    });
    const inputs = Array.from({ length: 250 }, (_, i) => `t${i}`);
    await embed(inputs, 'text-embedding-3-small');
    expect(mockCreate).toHaveBeenCalledTimes(3); // 100 + 100 + 50
  });

  it('retries on 429 and succeeds on third attempt', async () => {
    const err429 = Object.assign(new Error('rate limited'), { status: 429 });
    mockCreate
      .mockRejectedValueOnce(err429)
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce({ data: [{ embedding: [1, 2], index: 0 }] });
    const out = await embed(['x'], 'text-embedding-3-small');
    expect(out).toHaveLength(1);
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('gives up after 3 retries on persistent 5xx', async () => {
    const err500 = Object.assign(new Error('server error'), { status: 503 });
    mockCreate.mockRejectedValue(err500);
    await expect(embed(['x'], 'text-embedding-3-small')).rejects.toThrow();
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });

  it('does not retry on 4xx other than 429', async () => {
    const err400 = Object.assign(new Error('bad request'), { status: 400 });
    mockCreate.mockRejectedValue(err400);
    await expect(embed(['x'], 'text-embedding-3-small')).rejects.toThrow();
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it('returns [] for [] input without calling the API', async () => {
    const out = await embed([], 'text-embedding-3-small');
    expect(out).toEqual([]);
    expect(mockCreate).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the test, confirm it fails**

Run: `npx vitest run test/lib/embedding-client.test.js`
Expected: FAIL with "Cannot find module '../../srv/lib/embedding-client.js'".

- [ ] **Step 4: Implement the client**

Create `srv/lib/embedding-client.js`:

```javascript
import cds from '@sap/cds';
import { AzureOpenAiEmbeddingClient } from '@sap-ai-sdk/foundation-models';

const LOG = cds.log('embedding-client');
const BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const BACKOFF_MS = 500;

const clientCache = new Map();

function getClient(model) {
  let c = clientCache.get(model);
  if (!c) {
    c = new AzureOpenAiEmbeddingClient(model);
    clientCache.set(model, c);
  }
  return c;
}

function isRetryable(err) {
  const status = err?.status ?? err?.response?.status;
  return status === 429 || (status >= 500 && status < 600);
}

async function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function callWithRetry(client, batch) {
  let lastErr;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await client.run({ input: batch });
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) throw err;
      const delay = BACKOFF_MS * Math.pow(2, attempt);
      LOG.warn(`embedding call failed (attempt ${attempt + 1}/${MAX_RETRIES}): ${err.message} — retrying in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Embed an array of input strings via SAP Generative AI Hub.
 * Batches up to 100 per API call. Retries 429/5xx with exponential backoff.
 * Returns `Float32Array[]` aligned with input order.
 */
export async function embed(inputs, model) {
  if (!Array.isArray(inputs) || inputs.length === 0) return [];
  const client = getClient(model);
  const out = new Array(inputs.length);

  for (let i = 0; i < inputs.length; i += BATCH_SIZE) {
    const batch = inputs.slice(i, i + BATCH_SIZE);
    const resp = await callWithRetry(client, batch);
    const data = resp?.data || [];
    for (const item of data) {
      const idx = i + (item.index ?? 0);
      out[idx] = new Float32Array(item.embedding);
    }
  }
  return out;
}
```

- [ ] **Step 5: Run tests, confirm they pass**

Run: `npx vitest run test/lib/embedding-client.test.js`
Expected: PASS — all 6 tests green.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/embedding-client.js test/lib/embedding-client.test.js package.json package-lock.json
git commit -m "feat(rag): AI Core embedding client with batching + retry"
```

---

## Task 4: Embedding pipeline (orchestrator)

**Files:**
- Create: `srv/lib/embedding-pipeline.js`
- Test: `test/lib/embedding-pipeline.test.js`

The pipeline reads `ChatSettings`, decompresses changed slugs from `ContentFiles`, runs the extractor, hashes each chunk, diffs against existing `TutorialEmbedding` rows, embeds the truly-new/changed ones via `embedding-client`, and upserts. Acquires a distributed lock so concurrent hook + cron + seed runs are safe.

- [ ] **Step 1: Write the failing test**

Create `test/lib/embedding-pipeline.test.js`:

```javascript
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async (inputs) => inputs.map(() => new Float32Array(1536).fill(0.1)))
}));
vi.mock('../../srv/lib/step-text-extractor.js', () => ({
  extractStepText: vi.fn()
}));
vi.mock('../../srv/jobs/job-lock.js', () => ({
  acquireLock: vi.fn(async () => true),
  releaseLock: vi.fn(async () => undefined)
}));

const cds = (await import('@sap/cds')).default;

describe('embedding-pipeline', () => {
  let pipeline, extractor, jobLock, embeddingClient;

  beforeEach(async () => {
    await cds.deploy(__dirname + '/../../db/schema.cds').to('sqlite::memory:');
    extractor = await import('../../srv/lib/step-text-extractor.js');
    jobLock = await import('../../srv/jobs/job-lock.js');
    embeddingClient = await import('../../srv/lib/embedding-client.js');
    pipeline = await import('../../srv/lib/embedding-pipeline.js');
    vi.clearAllMocks();
    jobLock.acquireLock.mockResolvedValue(true);
  });

  it('skips entirely when ragEnabled is false', async () => {
    const result = await pipeline.embedSlugs(['slug-a'], { ragEnabled: false });
    expect(result).toEqual({ embedded: 0, skipped: 0, failed: 0, lockHeld: false });
    expect(embeddingClient.embed).not.toHaveBeenCalled();
  });

  it('exits early when distributed lock is held', async () => {
    jobLock.acquireLock.mockResolvedValueOnce(false);
    const result = await pipeline.embedSlugs(['slug-a'], { ragEnabled: true, embeddingModel: 'm' });
    expect(result.lockHeld).toBe(true);
    expect(embeddingClient.embed).not.toHaveBeenCalled();
  });

  it('embeds and upserts new chunks for a fresh slug', async () => {
    const { Tutorials, Steps, ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'slug-a', title: 'A', status: 'ACTIVE' });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, stepOrder: 1, title: 's1', status: 'ACTIVE' });
    const { gzipSync } = await import('node:zlib');
    await INSERT.into(ContentManifest).entries({ version: 1, status: 'ACTIVE' });
    await INSERT.into(ContentFiles).entries({
      slug: 'slug-a', version: 1,
      content: gzipSync(Buffer.from('<section data-step="1">hello world</section>')),
      contentHash: 'x', sizeBytes: 1, compressedBytes: 1, mimeType: 'text/html'
    });
    extractor.extractStepText.mockReturnValue([{ stepNumber: 1, text: 'hello world', charCount: 11 }]);

    const result = await pipeline.embedSlugs(['slug-a'], { ragEnabled: true, embeddingModel: 'text-embedding-3-small' });

    expect(result.embedded).toBe(1);
    expect(result.failed).toBe(0);
    const { TutorialEmbedding } = cds.entities('com.sap.developers.ims');
    const rows = await SELECT.from(TutorialEmbedding);
    expect(rows).toHaveLength(1);
    expect(rows[0].stepNumber).toBe(1);
    expect(rows[0].embeddingModel).toBe('text-embedding-3-small');
  });

  it('skips chunks whose hash + model already match', async () => {
    // (similar setup; pre-insert a TutorialEmbedding row with matching hash and assert embed() never called)
    // Implementation expanded in step 2
  });

  it('records failed slugs without throwing', async () => {
    extractor.extractStepText.mockImplementationOnce(() => { throw new Error('boom'); });
    const result = await pipeline.embedSlugs(['bad'], { ragEnabled: true, embeddingModel: 'm' });
    expect(result.failed).toBe(1);
  });
});
```

- [ ] **Step 2: Flesh out the "skip when hash matches" test**

Replace the placeholder test body with a full setup that pre-inserts a `TutorialEmbedding` row with the same `contentHash` and `embeddingModel` the pipeline would compute, then asserts `embed()` was not called. Use `crypto.createHash('sha256').update('hello world').digest('hex')` to compute the expected hash.

- [ ] **Step 3: Run the test, confirm it fails**

Run: `npx vitest run test/lib/embedding-pipeline.test.js`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the pipeline**

Create `srv/lib/embedding-pipeline.js`:

```javascript
import cds from '@sap/cds';
import { createHash } from 'node:crypto';
import { extractStepText } from './step-text-extractor.js';
import { embed } from './embedding-client.js';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';
import { toBuffer } from './content-store.js';

const LOG = cds.log('embedding-pipeline');
const LOCK_NAME = 'embedding-pipeline';
const LOCK_DURATION_MS = 15 * 60 * 1000;
const INSTANCE_ID = process.env.CF_INSTANCE_INDEX || '0';

function hashChunk(text) {
  return createHash('sha256').update(text).digest('hex');
}

async function readContentBuffer(db, slug) {
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';
  if (isHana) {
    const [row] = await db.run(
      `SELECT TOP 1 "CONTENT" FROM "COM_SAP_DEVELOPERS_IMS_CONTENTFILES" cf
         JOIN "COM_SAP_DEVELOPERS_IMS_CONTENTMANIFEST" m ON cf."VERSION" = m."VERSION"
        WHERE cf."SLUG" = ? AND m."STATUS" = 'ACTIVE'`, [slug]);
    return row?.CONTENT || null;
  }
  const { ContentFiles, ContentManifest } = cds.entities('com.sap.developers.ims');
  const [active] = await SELECT.from(ContentManifest).where({ status: 'ACTIVE' }).columns('version');
  if (!active) return null;
  const row = await SELECT.one.from(ContentFiles).where({ slug, version: active.version }).columns('content');
  return row ? await toBuffer(row.content) : null;
}

/**
 * Process a list of slugs through the embedding pipeline.
 * Idempotent: skips chunks whose hash + model already match.
 *
 * @param {string[]} slugs
 * @param {{ragEnabled, embeddingModel}} settings
 * @returns {Promise<{embedded, skipped, failed, lockHeld}>}
 */
export async function embedSlugs(slugs, settings) {
  if (!settings?.ragEnabled) return { embedded: 0, skipped: 0, failed: 0, lockHeld: false };
  if (!Array.isArray(slugs) || slugs.length === 0) return { embedded: 0, skipped: 0, failed: 0, lockHeld: false };

  const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS);
  if (!locked) {
    LOG.info('lock held — another pipeline run is active, skipping');
    return { embedded: 0, skipped: 0, failed: 0, lockHeld: true };
  }

  let embedded = 0, skipped = 0, failed = 0;
  try {
    const db = await cds.connect.to('db');
    const { Tutorials, Steps, TutorialEmbedding } = cds.entities('com.sap.developers.ims');
    const model = settings.embeddingModel || 'text-embedding-3-small';

    for (const slug of slugs) {
      try {
        const tut = await SELECT.one.from(Tutorials).where({ slug }).columns('ID');
        if (!tut) { skipped++; continue; }
        const buf = await readContentBuffer(db, slug);
        if (!buf) { skipped++; continue; }

        const chunks = extractStepText(buf);
        if (chunks.length === 0) { skipped++; continue; }

        // Hash and compute Steps.contentHash so reconciliation has a target
        for (const c of chunks) c.contentHash = hashChunk(c.text);

        // Update Steps.contentHash for any matching step rows
        for (const c of chunks) {
          await UPDATE(Steps)
            .where({ tutorial_ID: tut.ID, stepOrder: c.stepNumber })
            .set({ contentHash: c.contentHash });
        }

        // Look up existing embeddings for this tutorial
        const existing = await SELECT.from(TutorialEmbedding)
          .where({ tutorial_ID: tut.ID })
          .columns('stepNumber', 'contentHash', 'embeddingModel');
        const existingMap = new Map(existing.map((r) => [r.stepNumber, r]));

        const toEmbed = chunks.filter((c) => {
          const e = existingMap.get(c.stepNumber);
          return !e || e.contentHash !== c.contentHash || e.embeddingModel !== model;
        });

        if (toEmbed.length === 0) { skipped++; continue; }

        const vectors = await embed(toEmbed.map((c) => c.text), model);

        for (let i = 0; i < toEmbed.length; i++) {
          const c = toEmbed[i];
          const v = vectors[i];
          if (!v) continue;
          // Delete-then-insert (composite PK upsert)
          await DELETE.from(TutorialEmbedding).where({ tutorial_ID: tut.ID, stepNumber: c.stepNumber });
          await INSERT.into(TutorialEmbedding).entries({
            tutorial_ID: tut.ID,
            stepNumber: c.stepNumber,
            contentHash: c.contentHash,
            embeddingModel: model,
            embedding: Buffer.from(v.buffer),
            text: c.text,
            charCount: c.charCount
          });
        }
        embedded++;
      } catch (err) {
        LOG.warn(`embed failed for ${slug}: ${err.message}`);
        failed++;
      }
    }
  } finally {
    await releaseLock(LOCK_NAME, INSTANCE_ID);
  }
  return { embedded, skipped, failed, lockHeld: false };
}
```

> NOTE: `Buffer.from(v.buffer)` works for SQLite test path. On HANA, `Vector(1536)` accepts a Buffer in CDS QL — verified in Task 7 hybrid test. If hybrid round-trip fails, switch to `db.run('... TO_REAL_VECTOR(?) ...', [JSON.stringify(Array.from(v))])` per HANA syntax.

- [ ] **Step 5: Run tests, confirm they pass**

Run: `npx vitest run test/lib/embedding-pipeline.test.js`
Expected: PASS — all 5 tests green.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/embedding-pipeline.js test/lib/embedding-pipeline.test.js
git commit -m "feat(rag): embedding pipeline orchestrator with hash-based delta"
```

---

### Task 5: Wire the post-publish hook into content-store.js

**Files:**
- Modify: `srv/lib/content-store.js` — add a fire-and-forget call to `embedSlugs()` from `publishHandler()` after the manifest activation transaction commits.

**Why this task:** Whenever Hugo content lands in HANA, the embeddings for every changed slug must follow. The hook runs *after* the manifest is ACTIVE so a failed embedding never blocks publishing.

- [ ] **Step 1: Write the failing test**

Create `test/lib/content-store-hook.test.js`:

```javascript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../srv/lib/embedding-pipeline.js', () => ({
  embedSlugs: vi.fn().mockResolvedValue({ embedded: 1, skipped: 0, failed: 0, lockHeld: false })
}));

describe('content-store post-publish hook', () => {
  beforeEach(() => vi.clearAllMocks());

  it('invokes embedSlugs with changed slugs when ragEnabled is true', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { triggerPostPublishEmbeddings } = await import('../../srv/lib/content-store.js');
    await triggerPostPublishEmbeddings({
      changedSlugs: ['cap-hello-world', 'btp-trial-setup'],
      settings: { ragEnabled: true, embeddingModel: 'text-embedding-3-small', embeddingTopK: 4, embeddingMinScore: 0.7 }
    });
    expect(embedSlugs).toHaveBeenCalledTimes(1);
    expect(embedSlugs.mock.calls[0][0]).toEqual(['cap-hello-world', 'btp-trial-setup']);
  });

  it('skips embedding when ragEnabled is false', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { triggerPostPublishEmbeddings } = await import('../../srv/lib/content-store.js');
    await triggerPostPublishEmbeddings({
      changedSlugs: ['cap-hello-world'],
      settings: { ragEnabled: false }
    });
    expect(embedSlugs).not.toHaveBeenCalled();
  });

  it('swallows embedding errors so publish stays successful', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    embedSlugs.mockRejectedValueOnce(new Error('AI Core down'));
    const { triggerPostPublishEmbeddings } = await import('../../srv/lib/content-store.js');
    await expect(triggerPostPublishEmbeddings({
      changedSlugs: ['x'],
      settings: { ragEnabled: true }
    })).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run test/lib/content-store-hook.test.js`
Expected: FAIL — `triggerPostPublishEmbeddings is not exported`.

- [ ] **Step 3: Implement the hook in `srv/lib/content-store.js`**

Add this exported helper near the top of the file (right after the imports):

```javascript
import { embedSlugs } from './embedding-pipeline.js';

export async function triggerPostPublishEmbeddings({ changedSlugs, settings }) {
  if (!settings?.ragEnabled) return;
  if (!Array.isArray(changedSlugs) || changedSlugs.length === 0) return;
  try {
    const result = await embedSlugs(changedSlugs, settings);
    LOG.info('post-publish embeddings', result);
  } catch (err) {
    LOG.warn('post-publish embeddings failed (non-fatal)', err.message);
  }
}
```

Then inside `publishHandler()`, *after* the manifest activation transaction commits successfully and you have computed `changedSlugs` (slugs whose hash differed from the prior active manifest), invoke:

```javascript
const settings = await SELECT.one.from('ims.ChatSettings');
setImmediate(() => triggerPostPublishEmbeddings({ changedSlugs, settings }));
```

The `setImmediate` keeps the publish HTTP response fast — embeddings stream out asynchronously.

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run test/lib/content-store-hook.test.js`
Expected: PASS — all 3 tests green.

Also run the existing content-store regression: `npx vitest run test/unit/content-store.test.js`. No tests should regress.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-store.js test/lib/content-store-hook.test.js
git commit -m "feat(rag): trigger embedding pipeline after content publish"
```

---

### Task 6: Embedding query (`srv/lib/embedding-query.js`)

**Files:**
- Create: `srv/lib/embedding-query.js`
- Test: `test/lib/embedding-query.test.js`

**Why this task:** The `getRelevantSteps` LLM tool needs a single function that takes a question + `ChatSettings` and returns the top-K matching steps. We isolate the HANA-vs-SQLite branching here so the orchestrator stays clean.

- [ ] **Step 1: Write the failing test**

Create `test/lib/embedding-query.test.js`:

```javascript
import { describe, it, expect, vi, beforeAll } from 'vitest';
import cds from '@sap/cds';

vi.mock('../../srv/lib/embedding-client.js', () => ({
  embed: vi.fn(async (texts) => texts.map(() => new Float32Array(1536).fill(0.01)))
}));

describe('embedding-query', () => {
  beforeAll(async () => { await cds.test('serve', 'all').in(process.cwd()); });

  it('filters to current embeddingModel', async () => {
    const { findRelevantSteps } = await import('../../srv/lib/embedding-query.js');
    const hits = await findRelevantSteps({
      query: 'how do I bind a HANA service',
      settings: { embeddingModel: 'text-embedding-3-small', embeddingTopK: 4, embeddingMinScore: 0.0 }
    });
    expect(Array.isArray(hits)).toBe(true);
    for (const h of hits) {
      expect(h).toHaveProperty('tutorialSlug');
      expect(h).toHaveProperty('stepNumber');
      expect(h).toHaveProperty('text');
      expect(h).toHaveProperty('score');
    }
  });

  it('returns [] when query is empty', async () => {
    const { findRelevantSteps } = await import('../../srv/lib/embedding-query.js');
    const hits = await findRelevantSteps({ query: '   ', settings: { embeddingModel: 'x', embeddingTopK: 4, embeddingMinScore: 0 } });
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run test/lib/embedding-query.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/lib/embedding-query.js`**

```javascript
import cds from '@sap/cds';
import { embed } from './embedding-client.js';

const LOG = cds.log('rag-query');

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

export async function findRelevantSteps({ query, settings }) {
  if (!query || !query.trim()) return [];
  const topK = Math.min(Math.max(settings.embeddingTopK ?? 4, 1), 10);
  const minScore = settings.embeddingMinScore ?? 0.7;
  const model = settings.embeddingModel || 'text-embedding-3-small';

  const [qVec] = await embed([query.trim()], model);
  const db = cds.db;
  const isHana = db.options?.kind === 'hana' || db.constructor?.name === 'HANAService';

  if (isHana) {
    const sql = `
      SELECT TOP ${topK}
        e."tutorial_ID", e."stepNumber", e."text",
        t."slug" AS "tutorialSlug", t."title" AS "tutorialTitle",
        COSINE_SIMILARITY(e."embedding", TO_REAL_VECTOR(?)) AS "score"
      FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" e
      JOIN "COM_SAP_DEVELOPERS_IMS_TUTORIALS" t ON t."ID" = e."tutorial_ID"
      WHERE e."embeddingModel" = ?
      ORDER BY "score" DESC`;
    const rows = await db.run(sql, [JSON.stringify(Array.from(qVec)), model]);
    return rows.filter(r => r.SCORE >= minScore || r.score >= minScore).map(r => ({
      tutorialId: r.TUTORIAL_ID ?? r.tutorial_ID,
      tutorialSlug: r.TUTORIALSLUG ?? r.tutorialSlug,
      tutorialTitle: r.TUTORIALTITLE ?? r.tutorialTitle,
      stepNumber: r.STEPNUMBER ?? r.stepNumber,
      text: r.TEXT ?? r.text,
      score: r.SCORE ?? r.score
    }));
  }

  // SQLite test path: fetch all rows for the current model and rank in JS.
  const rows = await SELECT.from('ims.TutorialEmbedding').columns(
    'tutorial_ID', 'stepNumber', 'text', 'embedding'
  ).where({ embeddingModel: model });
  const tutorialIndex = await SELECT.from('ims.Tutorials').columns('ID', 'slug', 'title');
  const tMap = new Map(tutorialIndex.map(t => [t.ID, t]));
  const scored = rows.map(r => {
    const buf = Buffer.isBuffer(r.embedding) ? r.embedding : Buffer.from(r.embedding);
    const v = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    const t = tMap.get(r.tutorial_ID) || {};
    return {
      tutorialId: r.tutorial_ID,
      tutorialSlug: t.slug,
      tutorialTitle: t.title,
      stepNumber: r.stepNumber,
      text: r.text,
      score: cosine(v, qVec)
    };
  });
  return scored.filter(s => s.score >= minScore).sort((a,b) => b.score - a.score).slice(0, topK);
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run test/lib/embedding-query.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/embedding-query.js test/lib/embedding-query.test.js
git commit -m "feat(rag): top-K step retrieval with HANA/SQLite branches"
```

---

### Task 7: Hybrid HANA round-trip test for `Vector(1536)`

**Files:**
- Create: `test/hybrid/vector-roundtrip.test.js`

**Why this task:** SQLite tests cannot exercise the real HANA `Vector(1536)` storage or `COSINE_SIMILARITY` function. Before wiring this into prod traffic, prove that a Float32Array survives the round-trip and that similarity ranking is sane on HANA. Catches CDS QL → HANA driver mismatches early.

- [ ] **Step 1: Write the failing test**

Create `test/hybrid/vector-roundtrip.test.js`:

```javascript
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import cds from '@sap/cds';
import './_guard.js';

describe('HANA Vector(1536) round-trip', () => {
  const TUTORIAL_ID = '__TEST__-vector-roundtrip';

  beforeAll(async () => {
    await cds.connect.to('db');
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "tutorial_ID" = ?`, [TUTORIAL_ID]);
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" = ?`, [TUTORIAL_ID]);
    await INSERT.into('ims.Tutorials').entries({ ID: TUTORIAL_ID, slug: '__test__-vec', title: '__test__' });
  });

  afterAll(async () => {
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "tutorial_ID" = ?`, [TUTORIAL_ID]);
    await cds.db.run(`DELETE FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALS" WHERE "ID" = ?`, [TUTORIAL_ID]);
  });

  it('inserts and retrieves a Vector(1536) and ranks by cosine similarity', async () => {
    const v1 = new Float32Array(1536); v1[0] = 1;
    const v2 = new Float32Array(1536); v2[0] = 0.9; v2[1] = 0.1;
    const v3 = new Float32Array(1536); v3[1535] = 1;

    for (const [n, v] of [[1, v1], [2, v2], [3, v3]]) {
      await cds.db.run(
        `INSERT INTO "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING"
           ("tutorial_ID", "stepNumber", "contentHash", "embeddingModel", "embedding", "text", "charCount")
         VALUES (?, ?, ?, ?, TO_REAL_VECTOR(?), ?, ?)`,
        [TUTORIAL_ID, n, `h${n}`, 'text-embedding-3-small', JSON.stringify(Array.from(v)), `step${n}`, 6]
      );
    }

    const rows = await cds.db.run(
      `SELECT TOP 3 "stepNumber", COSINE_SIMILARITY("embedding", TO_REAL_VECTOR(?)) AS "score"
       FROM "COM_SAP_DEVELOPERS_IMS_TUTORIALEMBEDDING" WHERE "tutorial_ID" = ? ORDER BY "score" DESC`,
      [JSON.stringify(Array.from(v1)), TUTORIAL_ID]
    );
    expect(rows[0].STEPNUMBER ?? rows[0].stepNumber).toBe(1);
    expect(rows[2].STEPNUMBER ?? rows[2].stepNumber).toBe(3);
  }, 30000);
});
```

- [ ] **Step 2: Run against real HANA**

Pre-req: `cf login` to DEV space, then:

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid -- vector-roundtrip
```

Expected: PASS — three rows inserted, retrieval order is `[1, 2, 3]` for cosine similarity to `v1`.

If the insert fails with `invalid REAL_VECTOR literal`, swap `TO_REAL_VECTOR(?)` with binding the buffer directly: `embedding: Buffer.from(v.buffer)` via CDS QL. Update [embedding-pipeline.js](../../../srv/lib/embedding-pipeline.js) and [embedding-query.js](../../../srv/lib/embedding-query.js) to match.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/vector-roundtrip.test.js
git commit -m "test(rag): hybrid HANA Vector(1536) round-trip"
```

---

### Task 8: Reconciliation cron (`srv/jobs/embedding-reconciliation.js`)

**Files:**
- Create: `srv/jobs/embedding-reconciliation.js`
- Test: `test/lib/embedding-reconciliation.test.js`

**Why this task:** Belt-and-braces. If a publish hook fails (AI Core hiccup, lock contention), the embeddings drift. An hourly job re-checks every active slug's `Steps.contentHash` against the `TutorialEmbedding.contentHash` and fills in missing/stale rows. Spec calls for hourly cadence + jitter so post-publish failures self-heal within an hour.

- [ ] **Step 1: Write the failing test**

Create `test/lib/embedding-reconciliation.test.js`:

```javascript
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../srv/lib/embedding-pipeline.js', () => ({
  embedSlugs: vi.fn().mockResolvedValue({ embedded: 2, skipped: 0, failed: 0, lockHeld: false })
}));

describe('embedding reconciliation', () => {
  it('reconcileAll calls embedSlugs with the union of stale + missing slugs', async () => {
    const { embedSlugs } = await import('../../srv/lib/embedding-pipeline.js');
    const { reconcileAll } = await import('../../srv/jobs/embedding-reconciliation.js');
    const settings = { ragEnabled: true, embeddingModel: 'text-embedding-3-small', embeddingTopK: 4, embeddingMinScore: 0.7 };
    const result = await reconcileAll({
      activeSlugs: ['a', 'b', 'c'],
      slugsWithStaleHashes: ['a'],
      slugsWithoutEmbeddings: ['c'],
      settings
    });
    expect(embedSlugs).toHaveBeenCalledWith(expect.arrayContaining(['a', 'c']), settings);
    expect(result.candidates).toBe(2);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `npx vitest run test/lib/embedding-reconciliation.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `srv/jobs/embedding-reconciliation.js`**

```javascript
import cds from '@sap/cds';
import { embedSlugs } from '../lib/embedding-pipeline.js';
import { logPipelineStart, logPipelineEnd } from '../lib/pipeline-log.js';

const LOG = cds.log('rag-reconcile');

export async function reconcileAll({ activeSlugs, slugsWithStaleHashes, slugsWithoutEmbeddings, settings }) {
  const candidateSet = new Set([...slugsWithStaleHashes, ...slugsWithoutEmbeddings].filter(s => activeSlugs.includes(s)));
  const candidates = [...candidateSet];
  if (candidates.length === 0) return { candidates: 0, embedded: 0, skipped: 0, failed: 0 };
  const result = await embedSlugs(candidates, settings);
  return { candidates: candidates.length, ...result };
}

export async function runReconciliationJob() {
  const settings = await SELECT.one.from('ims.ChatSettings');
  if (!settings?.ragEnabled) { LOG.info('ragEnabled=false, skipping'); return { skipped: true }; }

  const pipelineId = await logPipelineStart({ pipelineType: 'EMBEDDING_PIPELINE', source: 'reconciliation-cron' });
  try {
    const manifest = await SELECT.one.from('ims.ContentManifest').where({ status: 'ACTIVE' });
    if (!manifest) return { skipped: true, reason: 'no active manifest' };

    const activeFiles = await SELECT.from('ims.ContentFiles').columns('slug').where({ manifest_ID: manifest.ID });
    const activeSlugs = activeFiles.map(f => f.slug);

    const stepRows = await SELECT.from('ims.Steps').columns('tutorial_ID', 'stepNumber', 'contentHash');
    const embedRows = await SELECT.from('ims.TutorialEmbedding').columns('tutorial_ID', 'stepNumber', 'contentHash', 'embeddingModel');
    const tutorials = await SELECT.from('ims.Tutorials').columns('ID', 'slug');
    const tToSlug = new Map(tutorials.map(t => [t.ID, t.slug]));

    const embedKey = (r) => `${r.tutorial_ID}:${r.stepNumber}`;
    const embedMap = new Map(embedRows.map(e => [embedKey(e), e]));

    const stale = new Set();
    const missing = new Set();
    for (const s of stepRows) {
      const slug = tToSlug.get(s.tutorial_ID);
      if (!slug || !activeSlugs.includes(slug)) continue;
      const e = embedMap.get(embedKey(s));
      if (!e) { missing.add(slug); continue; }
      if (e.contentHash !== s.contentHash) stale.add(slug);
      if (e.embeddingModel !== settings.embeddingModel) stale.add(slug);
    }

    const result = await reconcileAll({
      activeSlugs,
      slugsWithStaleHashes: [...stale],
      slugsWithoutEmbeddings: [...missing],
      settings
    });
    await logPipelineEnd({ pipelineId, status: 'SUCCESS', stats: result });
    LOG.info('reconciliation complete', result);
    return result;
  } catch (err) {
    await logPipelineEnd({ pipelineId, status: 'FAILURE', error: err.message });
    throw err;
  }
}
```

- [ ] **Step 4: Run tests, confirm pass**

Run: `npx vitest run test/lib/embedding-reconciliation.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add srv/jobs/embedding-reconciliation.js test/lib/embedding-reconciliation.test.js
git commit -m "feat(rag): hourly embedding reconciliation job"
```

---

### Task 9: Register reconciliation job in scheduler

**Files:**
- Modify: `srv/jobs/scheduler.js`

**Why this task:** The job needs to actually run. Reuse the existing `runWithLock()` wrapper and `cron.schedule()` pattern so distributed locking works in multi-instance deployments. Spec specifies hourly cadence with small jitter.

- [ ] **Step 1: Open `srv/jobs/scheduler.js` and locate the `register()` function**

Existing pattern (paraphrased):

```javascript
cron.schedule('0 3 * * *', () => runWithLock('cleanup', cleanupJob.run));
```

- [ ] **Step 2: Add the embedding reconciliation registration**

Insert next to the other recurring jobs:

```javascript
import { runReconciliationJob } from './embedding-reconciliation.js';

// Hourly — fires at minute 17 to avoid the :00 thundering-herd; lock keeps multi-instance safe.
cron.schedule('17 * * * *', () => runWithLock('embedding-reconciliation', runReconciliationJob));
```

> NOTE: Spec recommends hourly with jitter. The fixed offset (`17 * * * *`) is the cheapest jitter — distributes load away from `:00` where every other cron fires. If multi-instance jitter is desired, wrap in `setTimeout(fn, Math.random() * 60_000)` inside the cron callback.

- [ ] **Step 3: Smoke-check the registration**

Run: `npx vitest run test/jobs/scheduler.test.js` (or whichever scheduler unit test exists). The new schedule should not break startup.

- [ ] **Step 4: Commit**

```bash
git add srv/jobs/scheduler.js
git commit -m "feat(rag): schedule hourly embedding reconciliation"
```

---

### Task 10: Register `getRelevantSteps` tool in chat orchestrator

**Files:**
- Modify: `srv/lib/chat-orchestrator.js`

**Why this task:** The whole point of the pipeline. Add a fourth LLM tool alongside `searchTutorials`, `searchAdminDocs`, `analyticsQuery` — gated by `ChatSettings.ragEnabled` and the user's chat context (always available, not admin-only).

- [ ] **Step 1: Add the tool definition**

In [srv/lib/chat-orchestrator.js](../../../srv/lib/chat-orchestrator.js), near the other `_TOOL` constants:

```javascript
const GET_RELEVANT_STEPS_TOOL = {
  type: 'function',
  function: {
    name: 'getRelevantSteps',
    description: 'Find the most relevant tutorial steps for a question using semantic vector search across all published tutorials. Returns up to topK steps with the originating tutorial slug, step number, text excerpt, and similarity score. Use whenever the user asks a how-to question that may be answered inside a tutorial step.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'natural-language question to ground' }
      },
      required: ['question']
    }
  }
};
```

- [ ] **Step 2: Make `toolsForContext()` aware of the new tool**

```javascript
async function toolsForContext({ pageContext, isAdmin }) {
  const tools = [SEARCH_TUTORIALS_TOOL];
  const settings = await SELECT.one.from('ims.ChatSettings');
  if (settings?.ragEnabled) tools.push(GET_RELEVANT_STEPS_TOOL);
  if (isAdmin && pageContext?.kind === 'admin') {
    tools.push(SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL);
  }
  return tools;
}
```

> NOTE: `toolsForContext` becomes async. Update its caller in [srv/chat-service.js](../../../srv/chat-service.js) to `await toolsForContext(...)`.

- [ ] **Step 3: Add the dispatch branch in `dispatchTool()`**

```javascript
if (name === 'getRelevantSteps') {
  try {
    if (typeof args.question !== 'string' || !args.question.trim()) {
      return { error: 'invalid_args', hits: [] };
    }
    const settings = await SELECT.one.from('ims.ChatSettings');
    if (!settings?.ragEnabled) return { error: 'rag_disabled', hits: [] };
    const { findRelevantSteps } = await import('./embedding-query.js');
    const hits = await findRelevantSteps({ query: args.question, settings });
    return hits.map(h => ({
      tutorialSlug: h.tutorialSlug,
      tutorialTitle: h.tutorialTitle,
      stepNumber: h.stepNumber,
      excerpt: h.text.slice(0, 600),
      score: Number(h.score?.toFixed?.(3) ?? h.score)
    }));
  } catch (err) {
    LOG.warn('getRelevantSteps failed', err.message);
    return { error: 'rag_failed', hits: [] };
  }
}
```

- [ ] **Step 4: Stream a UI event for citations**

In `streamChat()`, where existing `tool` results emit `tutorial-cards` / `doc-citations`, add:

```javascript
} else if (tc.name === 'getRelevantSteps' && Array.isArray(result) && result.length > 0) {
  sse(res, { type: 'step-citations', items: result });
}
```

- [ ] **Step 5: Export and re-run unit tests**

Update the export line at the bottom:

```javascript
export { SEARCH_TUTORIALS_TOOL, SEARCH_ADMIN_DOCS_TOOL, ANALYTICS_QUERY_TOOL, GET_RELEVANT_STEPS_TOOL, toolsForContext };
```

Run: `npx vitest run test/lib/chat-orchestrator.test.js`
Expected: PASS — existing tests still green; if a new test for the dispatch is desired, add one mocking `embedding-query.js`.

- [ ] **Step 6: Commit**

```bash
git add srv/lib/chat-orchestrator.js srv/chat-service.js
git commit -m "feat(rag): expose getRelevantSteps LLM tool"
```

---

### Task 11: Update Joule chat persona for RAG citations

**Files:**
- Modify: `srv/lib/chat-persona.js` (or wherever the system prompt lives — confirm path before editing)

**Why this task:** The model needs to be told: when `getRelevantSteps` returns hits, cite the tutorial slug + step number, and prefer those excerpts as ground truth over its own knowledge.

- [ ] **Step 1: Locate the system prompt**

Run: `grep -rn "you are.*joule\|system.*prompt" srv/lib/ srv/`. Confirm the file (likely `srv/lib/chat-persona.js`).

- [ ] **Step 2: Add a RAG section to the persona**

Append (or merge into) the system prompt:

```text
When the getRelevantSteps tool returns step excerpts, treat them as authoritative
ground truth for the question. Quote them naturally and cite each step inline using
the form [tutorial-slug #stepNumber]. If no relevant steps come back (empty hits or
all below the threshold), say so explicitly rather than guessing — invite the user
to refine the question or use the searchTutorials tool to discover candidates.
```

- [ ] **Step 3: Run the persona tests if they exist**

Run: `npx vitest run test/lib/chat-persona.test.js` (skip if no such test file).

- [ ] **Step 4: Commit**

```bash
git add srv/lib/chat-persona.js
git commit -m "feat(rag): instruct chat persona to cite grounded steps"
```

---

### Task 12: AdminService `seedEmbeddings()` action

**Files:**
- Modify: `srv/admin-service.cds`
- Modify: `srv/admin-service.js`

**Why this task:** Cold-start. When an admin first toggles `ragEnabled = true`, no embeddings exist yet. They need a button to seed everything from the current ACTIVE manifest. Reuses the same distributed lock as the publish hook so concurrent runs are safe.

- [ ] **Step 1: Declare the action**

In [srv/admin-service.cds](../../../srv/admin-service.cds), inside `entity ChatSettings as projection on ims.ChatSettings`:

```cds
@odata.singleton
entity ChatSettings as projection on ims.ChatSettings actions {
  action seedEmbeddings() returns {
    queued: Boolean;
    activeSlugs: Integer;
  };
};
```

- [ ] **Step 2: Implement the handler**

In [srv/admin-service.js](../../../srv/admin-service.js):

```javascript
this.on('seedEmbeddings', async (req) => {
  const settings = await SELECT.one.from('ims.ChatSettings');
  if (!settings?.ragEnabled) return req.error(400, 'ragEnabled must be true');

  const manifest = await SELECT.one.from('ims.ContentManifest').where({ status: 'ACTIVE' });
  if (!manifest) return req.error(409, 'no active content manifest');
  const files = await SELECT.from('ims.ContentFiles').columns('slug').where({ manifest_ID: manifest.ID });
  const slugs = files.map(f => f.slug);

  const { embedSlugs } = await import('./lib/embedding-pipeline.js');
  setImmediate(() => embedSlugs(slugs, settings).catch(err => {
    cds.log('rag-seed').warn('seed failed', err.message);
  }));

  return { queued: true, activeSlugs: slugs.length };
});
```

The `setImmediate` returns immediately to the admin (no HTTP timeout) while the lock-protected pipeline runs in the background.

- [ ] **Step 3: Smoke test**

Run: `npx vitest run test/unit/admin-service.test.js` (or whatever file covers admin actions). Add a test mocking `embedding-pipeline.embedSlugs` if none covers the new action.

- [ ] **Step 4: Commit**

```bash
git add srv/admin-service.cds srv/admin-service.js
git commit -m "feat(rag): admin seedEmbeddings action"
```

---

### Task 13: Embedding stats endpoint

**Files:**
- Create: `srv/lib/embedding-stats.js`
- Modify: `srv/server.js`

**Why this task:** The admin UI needs to show coverage at a glance: how many active slugs have full embeddings, how many are missing, when the last reconciliation ran. Plain Express route avoids OData overhead for a read-only metrics endpoint.

- [ ] **Step 1: Implement `srv/lib/embedding-stats.js`**

```javascript
import cds from '@sap/cds';

export async function computeEmbeddingStats() {
  const manifest = await SELECT.one.from('ims.ContentManifest').where({ status: 'ACTIVE' });
  if (!manifest) return { activeManifest: null, slugs: 0, slugsWithEmbeddings: 0, missing: 0, stale: 0 };

  const files = await SELECT.from('ims.ContentFiles').columns('slug').where({ manifest_ID: manifest.ID });
  const slugs = files.map(f => f.slug);
  const tutorials = await SELECT.from('ims.Tutorials').columns('ID', 'slug').where({ slug: { in: slugs } });
  const tIds = tutorials.map(t => t.ID);

  const steps = await SELECT.from('ims.Steps').columns('tutorial_ID', 'stepNumber', 'contentHash').where({ tutorial_ID: { in: tIds } });
  const embeds = await SELECT.from('ims.TutorialEmbedding').columns('tutorial_ID', 'stepNumber', 'contentHash').where({ tutorial_ID: { in: tIds } });

  const ek = (r) => `${r.tutorial_ID}:${r.stepNumber}`;
  const embedMap = new Map(embeds.map(e => [ek(e), e]));
  let missing = 0, stale = 0;
  const slugSet = new Set();
  for (const s of steps) {
    const e = embedMap.get(ek(s));
    if (!e) missing++;
    else if (e.contentHash !== s.contentHash) stale++;
    if (e) slugSet.add(s.tutorial_ID);
  }

  const lastRun = await SELECT.one.from('ims.PipelineLog')
    .where({ pipelineType: 'EMBEDDING_PIPELINE' })
    .orderBy('startedAt desc');

  return {
    activeManifest: manifest.ID,
    slugs: slugs.length,
    slugsWithEmbeddings: slugSet.size,
    totalSteps: steps.length,
    embeddedSteps: embeds.length,
    missing,
    stale,
    lastRun: lastRun ? { startedAt: lastRun.startedAt, status: lastRun.status, source: lastRun.source } : null
  };
}
```

- [ ] **Step 2: Mount the Express route in `srv/server.js`**

In the `cds.on('bootstrap')` handler:

```javascript
import { computeEmbeddingStats } from './lib/embedding-stats.js';

app.get('/admin/embeddings/stats', async (req, res) => {
  if (!req.user?.is?.('Admin') && !req.user?.is?.('admin')) return res.status(403).end();
  try {
    const stats = await computeEmbeddingStats();
    res.json(stats);
  } catch (err) {
    cds.log('rag-stats').error(err.message);
    res.status(500).json({ error: 'stats_failed' });
  }
});
```

- [ ] **Step 3: Test**

Run unit tests: `npx vitest run test/unit`.
Manual smoke (optional): `curl -H "Authorization: Bearer $ADMIN_TOKEN" http://localhost:4004/admin/embeddings/stats`.

- [ ] **Step 4: Commit**

```bash
git add srv/lib/embedding-stats.js srv/server.js
git commit -m "feat(rag): /admin/embeddings/stats endpoint"
```

---

### Task 14: Orphan cleanup in nightly job

**Files:**
- Modify: `srv/jobs/cleanup.js`

**Why this task:** When a tutorial is removed from the active manifest, its `TutorialEmbedding` rows linger forever. They don't break anything (the query joins on `Tutorials`) but they waste rows and slow `COSINE_SIMILARITY`.

- [ ] **Step 1: Add the orphan delete**

Inside the daily cleanup function:

```javascript
async function pruneOrphanEmbeddings() {
  const manifest = await SELECT.one.from('ims.ContentManifest').where({ status: 'ACTIVE' });
  if (!manifest) return { deleted: 0 };
  const files = await SELECT.from('ims.ContentFiles').columns('slug').where({ manifest_ID: manifest.ID });
  const activeSlugs = files.map(f => f.slug);
  const tutorials = await SELECT.from('ims.Tutorials').columns('ID', 'slug');
  const orphanIds = tutorials.filter(t => !activeSlugs.includes(t.slug)).map(t => t.ID);
  if (orphanIds.length === 0) return { deleted: 0 };
  const result = await DELETE.from('ims.TutorialEmbedding').where({ tutorial_ID: { in: orphanIds } });
  return { deleted: result };
}
```

Call `pruneOrphanEmbeddings()` from the existing cleanup orchestrator and include the result in its log line.

- [ ] **Step 2: Test**

Run: `npx vitest run test/unit/cleanup.test.js` (or equivalent). Add a unit test that seeds a `Tutorials` row not in the active manifest and verifies the delete.

- [ ] **Step 3: Commit**

```bash
git add srv/jobs/cleanup.js
git commit -m "feat(rag): prune orphan tutorial embeddings nightly"
```

---

### Task 15: Admin UI — Tutorial Grounding (RAG) panel

**Files:**
- Modify: `app/admin/joule/webapp/view/Settings.view.xml`
- Modify: `app/admin/joule/webapp/controller/Settings.controller.js`
- Modify: `app/admin/joule/webapp/i18n/i18n.properties`

**Why this task:** Tom required the feature flag and tuning knobs to be Admin-UI configurable, not env vars. The existing Settings tile is the natural home — same pattern as the `temperature` / `maxTokens` fields.

- [ ] **Step 1: Add the i18n keys**

Append to [app/admin/joule/webapp/i18n/i18n.properties](../../../app/admin/joule/webapp/i18n/i18n.properties):

```properties
ragSection=Tutorial Grounding (RAG)
ragEnabled=Enable Vector Grounding
ragEnabledHelp=When on, the chat assistant can pull excerpts from tutorial steps via semantic search.
embeddingModel=Embedding Model
embeddingTopK=Top K Steps
embeddingMinScore=Minimum Similarity Score
seedButton=Seed Embeddings Now
seedRunning=Seeding queued — check stats below in a few minutes.
ragStatsTitle=Coverage
ragStatsSlugs={0} of {1} tutorials embedded
ragStatsSteps={0} of {1} steps embedded
ragStatsLastRun=Last run: {0} ({1})
```

- [ ] **Step 2: Add the panel to `Settings.view.xml`**

Below the existing chat settings panel:

```xml
<Panel headerText="{i18n>ragSection}" expandable="true" expanded="true">
  <f:SimpleForm editable="true" layout="ColumnLayout">
    <Label text="{i18n>ragEnabled}"/>
    <Switch state="{settings>/ragEnabled}" change=".onSettingChange"/>
    <Label text="{i18n>embeddingModel}"/>
    <Input value="{settings>/embeddingModel}" change=".onSettingChange"/>
    <Label text="{i18n>embeddingTopK}"/>
    <StepInput value="{settings>/embeddingTopK}" min="1" max="10" change=".onSettingChange"/>
    <Label text="{i18n>embeddingMinScore}"/>
    <Input value="{settings>/embeddingMinScore}" type="Number" change=".onSettingChange"/>
  </f:SimpleForm>
  <Toolbar>
    <Button text="{i18n>seedButton}" press=".onSeedEmbeddings" type="Emphasized" enabled="{settings>/ragEnabled}"/>
  </Toolbar>
  <VBox class="sapUiSmallMargin">
    <Title text="{i18n>ragStatsTitle}" level="H4"/>
    <Text text="{= ${i18n>ragStatsSlugs} ? ${i18n>ragStatsSlugs}.replace('{0}', ${stats>/slugsWithEmbeddings}).replace('{1}', ${stats>/slugs}) : ''}"/>
    <Text text="{= ${i18n>ragStatsSteps} ? ${i18n>ragStatsSteps}.replace('{0}', ${stats>/embeddedSteps}).replace('{1}', ${stats>/totalSteps}) : ''}"/>
    <Text text="{stats>/lastRunDisplay}"/>
  </VBox>
</Panel>
```

- [ ] **Step 3: Wire the controller**

In [app/admin/joule/webapp/controller/Settings.controller.js](../../../app/admin/joule/webapp/controller/Settings.controller.js):

```javascript
async onSeedEmbeddings() {
  const res = await fetch('/admin/ChatSettings/AdminService.seedEmbeddings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': await this._fetchCsrf() }
  });
  if (!res.ok) {
    MessageBox.error('Seed failed: ' + (await res.text()));
    return;
  }
  const body = await res.json();
  MessageToast.show(this.getResourceBundle().getText('seedRunning'));
  this._refreshStats();
},

async _refreshStats() {
  const res = await fetch('/admin/embeddings/stats');
  if (!res.ok) return;
  const stats = await res.json();
  if (stats.lastRun) {
    stats.lastRunDisplay = this.getResourceBundle().getText('ragStatsLastRun', [
      new Date(stats.lastRun.startedAt).toLocaleString(),
      stats.lastRun.status
    ]);
  }
  this.getView().setModel(new JSONModel(stats), 'stats');
}
```

Call `this._refreshStats()` in `onInit()` and after every settings save.

The existing `onSettingChange` handler already PATCHes `/admin/ChatSettings`. Confirm the four new fields (`ragEnabled`, `embeddingModel`, `embeddingTopK`, `embeddingMinScore`) round-trip correctly — they should, since the binding path is generic.

- [ ] **Step 4: Build and smoke**

```bash
npm run build:admin
```

Open `/admin-ui/#/joule-chat-settings` (or wherever the Joule Settings tile is mounted). Confirm:
- Toggle persists after refresh
- Seed button is disabled when `ragEnabled` is off
- Stats panel updates after pressing Seed (allow 30s)

- [ ] **Step 5: Commit**

```bash
git add app/admin/joule/webapp/
git commit -m "feat(rag): admin UI tile for tutorial grounding settings + seed"
```

---

### Task 16: Annotate ChatSettings fields for the OData layer

**Files:**
- Modify: `app/admin-annotations.cds`

**Why this task:** `@UI.LineItem` and `@Common.Label` keep the auto-generated Fiori metadata aligned with the i18n labels in the custom view. Even though the Settings tile is hand-rolled XML, other admin tools (e.g., the ChangeLog viewer) still honour the annotations.

- [ ] **Step 1: Add labels**

```cds
annotate AdminService.ChatSettings with {
  ragEnabled         @Common.Label: 'RAG Enabled';
  embeddingModel     @Common.Label: 'Embedding Model';
  embeddingTopK      @Common.Label: 'Top K Steps';
  embeddingMinScore  @Common.Label: 'Min Similarity Score';
};
```

- [ ] **Step 2: Build and verify metadata**

```bash
npm run build:cds
curl -s http://localhost:4004/admin/$metadata | grep -i ragEnabled
```

Expected: the annotation is present in the EDMX.

- [ ] **Step 3: Commit**

```bash
git add app/admin-annotations.cds
git commit -m "chore(rag): annotate ChatSettings new fields"
```

---

### Task 17: Smoke test for grounded chat

**Files:**
- Create: `test/smoke/grounded-chat.test.js`

**Why this task:** End-to-end proof that the deployed pipeline actually grounds an answer. Runs in CI after deploy against `SMOKE_BASE_URL` and `SMOKE_SRV_URL`.

- [ ] **Step 1: Write the test**

```javascript
import { describe, it, expect } from 'vitest';

const BASE = process.env.SMOKE_BASE_URL || process.env.SMOKE_SRV_URL;

describe('grounded chat smoke', () => {
  it('GET /admin/embeddings/stats returns coverage shape (auth-required)', async () => {
    const res = await fetch(`${BASE}/admin/embeddings/stats`);
    // Either 401/403 (no admin token in CI) or a stats payload
    if (res.status === 200) {
      const body = await res.json();
      expect(body).toHaveProperty('slugs');
      expect(body).toHaveProperty('embeddedSteps');
    } else {
      expect([401, 403]).toContain(res.status);
    }
  });
});
```

> NOTE: Full end-to-end grounded-chat assertion (sending a question, expecting `step-citations` SSE events) is intentionally omitted at smoke level — it requires an authenticated user token. Coverage shape check is enough to detect regressions.

- [ ] **Step 2: Run locally against DEV**

```bash
SMOKE_BASE_URL=https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com npm run test:smoke -- grounded-chat
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/smoke/grounded-chat.test.js
git commit -m "test(rag): smoke test for embedding stats endpoint"
```

---

### Task 18: Documentation updates

**Files:**
- Modify: `docs/joule-chat.md`
- Modify: `docs/content-pipeline.md`
- Create: `docs/joule-chat-admin-settings.md`
- Modify: `CLAUDE.md`

**Why this task:** Future-Tom and future-Claude both need to find this without spelunking through git log.

- [ ] **Step 1: Update `docs/joule-chat.md`**

Add a new section "Tutorial Grounding (RAG)" describing:
- `getRelevantSteps` tool, gated by `ChatSettings.ragEnabled`
- per-step embeddings stored in HANA `Vector(1536)`
- model: `text-embedding-3-small` via `tutorials-aicore`
- topK / minScore tuning knobs
- citation format: `[tutorial-slug #stepNumber]`
- link to `docs/joule-chat-admin-settings.md` for operations

- [ ] **Step 2: Update `docs/content-pipeline.md`**

Add the post-publish embedding hook to the pipeline diagram:

```text
Hugo build → publish-content → /content/publish → manifest ACTIVE
                                                         ↓ setImmediate
                                                    embedSlugs(changed)
```

Mention the hourly reconciliation cron (`17 * * * *`) and orphan pruning during the daily cleanup at 03:00.

- [ ] **Step 3: Create `docs/joule-chat-admin-settings.md`**

Operational runbook covering:
- Where the settings live (Admin UI → Joule Chat Settings tile → Tutorial Grounding panel)
- What each knob does, and recommended values (topK=4, minScore=0.7)
- How to seed for the first time (toggle on, click Seed Embeddings Now)
- How to recover from "embedding drift" (the hourly reconciliation handles it; for forced full re-embed, click Seed)
- How to interpret the stats panel
- How to roll back: toggle `ragEnabled` off — the chat tool disappears, embeddings stay on disk
- How to rotate embedding models: change `embeddingModel`, click Seed (old-model rows auto-skipped by the query path; cleanup on next reconciliation)

- [ ] **Step 4: Update `CLAUDE.md`**

Add a "Gotchas" entry:

```markdown
- **Tutorial embeddings live in `TutorialEmbedding` and are HANA-only at query time** —
  SQLite test path uses JS-side cosine. Never SELECT the `embedding` BLOB alongside
  metadata in a single CDS QL query on HANA (LOB locator expiry); use `db.run()` raw SQL
  in `srv/lib/embedding-query.js`.
- **`ChatSettings.ragEnabled`** — feature flag for the `getRelevantSteps` tool. When
  toggling on for the first time, click "Seed Embeddings Now" in the Joule Chat
  Settings tile to populate. Reconciliation cron at minute 17 of every hour catches any drift.
```

- [ ] **Step 5: Commit**

```bash
git add docs/joule-chat.md docs/content-pipeline.md docs/joule-chat-admin-settings.md CLAUDE.md
git commit -m "docs(rag): document tutorial grounding pipeline + admin settings"
```

---

## Done. Now what?

After Task 18, the full pipeline is in place:

1. Schema deployed (Task 1)
2. Step text → embeddings → HANA `Vector(1536)` (Tasks 2–4)
3. Triggered by publish (Task 5) and reconciled nightly (Tasks 8–9)
4. Queryable via the new chat tool (Tasks 6, 10–11)
5. Cold-start covered by admin Seed action (Task 12)
6. Operational visibility (Tasks 13, 15)
7. Orphans pruned (Task 14)
8. Annotations + smoke + docs (Tasks 16–18)

**Verification checklist before merging to main:**

- [ ] All unit tests green: `npm test`
- [ ] Hybrid HANA vector round-trip green: `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- vector-roundtrip`
- [ ] Build succeeds: `npm run build:all`
- [ ] Deploy to DEV: `cd .deploy && mbt build && cf deploy ... -e ../deploy/dev.mtaext`
- [ ] Smoke tests green: `npm run test:smoke`
- [ ] Manual smoke: toggle `ragEnabled` on, seed, ask Joule a known question, confirm `[slug #N]` citation appears
- [ ] `/admin/embeddings/stats` shows `embeddedSteps == totalSteps` after seed completes

