# Publish Content Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single-shot `POST /content/publish` with a chunked `begin`/`append`/`commit`/`abort` protocol so the 5+ minute publish stops emitting "Fatal: fetch failed" false negatives when the server actually succeeded.

**Architecture:** Client splits the slug list into 50-slug batches and runs them through 6-way parallel `append` requests with per-batch retry (1s/3s/9s backoff). `commit` is the atomic activation step (carry-forward + ACTIVE flip) and is idempotent so transport drops are recoverable. Auto-verification via `GET /content/hashes` runs after every successful publish. New `--verify-only` and `--heal` modes added.

**Tech Stack:** TypeScript (scripts), Node.js + CAP (server), HANA Cloud (DB), Vitest (tests).

**Spec:** [docs/superpowers/specs/2026-05-29-publish-content-hardening-design.md](../specs/2026-05-29-publish-content-hardening-design.md)

**Branch:** `harden/publish-content-chunked` (already created).

**Conventions used in this plan:**

- All paths are repo-relative from `d:\projects\tutorials-poc`.
- All commands assume Bash (Git Bash on Windows). Use forward slashes.
- "Run tests" tasks use Vitest's filter form (`-t "<title>"`) so each step exercises only the test it just wrote.
- Each task ends with a commit. Commit messages follow the project's existing convention (lowercase imperative, scope prefix).
- TDD discipline: every code task starts by writing a failing test and running it to confirm the failure mode, before writing implementation. Watch for the expected failure message — if it fails differently, stop and investigate.
- **Project is ESM** (`"type": "module"`). The `__dirname` shorthand does not exist; the canonical `cds.test` invocation in this repo is `cds.test('serve', '--project', '.', '--in-memory');` placed at **module scope** (not inside `beforeAll`) — `cds.entities()` returns `undefined` if the test harness is initialized inside `beforeAll`. See `srv/__tests__/lib/content-publish-session.test.js` for the canonical example. If a code snippet in this plan shows `cds.test(__dirname + '/../..')`, substitute the project pattern.
- **Vitest 4.1.5** in this repo does not support `--reporter=basic`. Use the default reporter (omit the flag).

---

## Task list

1. Schema additions to `ContentManifest` (sessionId, lastAppendAt, FAILED enum)
2. Server-side session helper module (`content-publish-session.js`) — pure logic, unit-tested in isolation
3. Server route wiring (begin/append/commit/abort handlers in `content-store.js` and `server.js`)
4. Tighten the GC reaper cadence (5 min, 30 min threshold)
5. Client retry helper (`scripts/lib/publish-retry.ts`)
6. Client batcher with concurrency pool (`scripts/lib/publish-batcher.ts`)
7. Client protocol module (`scripts/lib/publish-client.ts`)
8. Wire the new flow into `scripts/publish-content.ts` with new flags
9. Hybrid HANA test for end-to-end chunked publish
10. Documentation updates and obsolete-memory deletion

---

## Task 1: Schema additions to ContentManifest

**Files:**
- Modify: `db/_content-shape.cds:22-31` (add `sessionId`, `lastAppendAt`, FAILED enum)

Note: `db/schema.cds` and `db-qa/schema.cds` consume this aspect; both pick the new columns up automatically.

- [ ] **Step 1: Add the columns and FAILED enum value**

Edit `db/_content-shape.cds`. Replace the `ContentManifestAspect` block (lines 22-31) with:

```cds
aspect ContentManifestAspect : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; FAILED; };
  trigger                   : String(500);
  fileCount                 : Integer;
  totalSizeBytes            : Int64;
  changedSlugs              : LargeString;
  hugoVersion               : String(20);
  publishDurationMs         : Integer;
  // Set on /content/publish/begin; remains NULL for legacy single-shot publishes.
  // The 5-min reaper ignores rows where sessionId IS NULL — keeps legacy publishes safe.
  sessionId                 : String(36);
  lastAppendAt              : Timestamp;
}
```

- [ ] **Step 2: Verify the model compiles**

Run: `npx cds compile db/schema.cds --to sql > /tmp/schema.sql && head -30 /tmp/schema.sql`
Expected: Output contains `SESSION_ID NVARCHAR(36)` and `LAST_APPEND_AT` columns on the `CONTENT_MANIFEST` table.

If compile fails with a message about FAILED already existing or string-length errors, inspect the diff and fix.

- [ ] **Step 3: Run the existing unit tests to make sure schema changes don't break anything**

Run: `npm test -- --project=unit content-store`
Expected: All existing content-store tests pass. Any failure here is a regression — investigate before continuing.

- [ ] **Step 4: Commit**

```bash
git add db/_content-shape.cds
git commit -m "feat(schema): add sessionId, lastAppendAt, FAILED status to ContentManifest

Prep for chunked publish protocol (begin/append/commit). Both new
columns are nullable so legacy single-shot publishes leave them NULL
and the 5-min reaper can safely ignore those rows.

Spec: docs/superpowers/specs/2026-05-29-publish-content-hardening-design.md"
```

---

## Task 2a: Server-side session helper — beginPublishSession

The session helper owns the lock + manifest lifecycle. We extract it into a new module so `content-store.js` does not grow further and the lifecycle is unit-testable in isolation.

**Files:**
- Create: `srv/lib/content-publish-session.js`
- Create: `srv/__tests__/lib/content-publish-session.test.js`

- [ ] **Step 1: Write the failing test for beginPublishSession**

Create `srv/__tests__/lib/content-publish-session.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { createSessionHelpers } from '../../lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

describe('content-publish-session', () => {
  let helpers;

  beforeAll(async () => {
    cds.test(__dirname + '/../..').in(__dirname + '/../..');
    await cds.connect.to('db');
    helpers = createSessionHelpers({ namespace: NS });
  });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
  });

  it('beginPublishSession allocates a fresh version, sessionId, and PUBLISHING manifest', async () => {
    const { ContentManifest } = cds.entities(NS);
    const result = await helpers.beginPublishSession({ trigger: 'test', hugoVersion: 'v1', expectedSlugCount: 5 });

    expect(result.version).toBe(1);
    expect(result.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const row = await SELECT.one.from(ContentManifest).where({ version: 1 });
    expect(row.status).toBe('PUBLISHING');
    expect(row.sessionId).toBe(result.sessionId);
    expect(row.lastAppendAt).toBeTruthy();
    expect(row.trigger).toBe('test');
  });

  it('beginPublishSession returns 409 when the lock is already held', async () => {
    await helpers.beginPublishSession({ trigger: 'a', hugoVersion: 'v1', expectedSlugCount: 0 });
    await expect(
      helpers.beginPublishSession({ trigger: 'b', hugoVersion: 'v1', expectedSlugCount: 0 })
    ).rejects.toMatchObject({ statusCode: 409 });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js -t "beginPublishSession"`
Expected: FAIL — `Cannot find module '../../lib/content-publish-session.js'`.

- [ ] **Step 3: Create the helper module**

Create `srv/lib/content-publish-session.js`:

```js
import cds from '@sap/cds';
import { acquireLock, releaseLock } from '../jobs/job-lock.js';

const LOCK_NAME = 'content-publish';
const LOCK_DURATION_MS = 30 * 60 * 1000;
const INSTANCE_ID = process.env.CF_INSTANCE_GUID || `local-${process.pid}`;

export function createSessionHelpers({ namespace }) {
  async function getNextVersion() {
    const { ContentManifest } = cds.entities(namespace);
    const max = await SELECT.one.from(ContentManifest).columns('max(version) as v');
    return (max?.v || 0) + 1;
  }

  async function beginPublishSession({ trigger, hugoVersion, expectedSlugCount }) {
    const locked = await acquireLock(LOCK_NAME, INSTANCE_ID, LOCK_DURATION_MS, namespace);
    if (!locked) {
      const err = new Error('Another publish in progress');
      err.statusCode = 409;
      throw err;
    }

    try {
      const version = await getNextVersion();
      const sessionId = cds.utils.uuid();
      const { ContentManifest } = cds.entities(namespace);

      await INSERT.into(ContentManifest).entries({
        version,
        status: 'PUBLISHING',
        sessionId,
        trigger: (trigger || 'unknown').slice(0, 500),
        fileCount: 0,
        totalSizeBytes: 0,
        changedSlugs: JSON.stringify([]),
        hugoVersion: hugoVersion || null,
        lastAppendAt: new Date().toISOString()
      });

      return { sessionId, version, expectedSlugCount: expectedSlugCount || 0 };
    } catch (err) {
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace).catch(() => {});
      throw err;
    }
  }

  return { beginPublishSession };
}
```

- [ ] **Step 4: Run the test to confirm both cases pass**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js -t "beginPublishSession"`
Expected: PASS for both cases.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-publish-session.js srv/__tests__/lib/content-publish-session.test.js
git commit -m "feat(content-publish): add beginPublishSession helper

First slice of the chunked publish protocol. Allocates a fresh version,
acquires the content-publish lock, INSERTs a PUBLISHING manifest with
sessionId + lastAppendAt. Returns 409 if a publish is already in flight.
Lock duration matches the GC reap window so abandoned sessions release
the lock at the same time they are marked FAILED."
```

---

## Task 2b: Server-side session helper — appendToSession

This task adds `appendToSession` and folds in the metadata and body-text upsert logic from the legacy `publishHandler` ([srv/lib/content-store.js:405-571](../../srv/lib/content-store.js#L405)). Per the spec, that work runs per batch in the new flow, not at commit time.

**Before you start:** Read [srv/lib/content-store.js:405-571](../../srv/lib/content-store.js#L405) end-to-end. The metadata loop has subtle behavior that took prior PRs to get right — `recomputeTutorialProgress` after step upsert, `legacyId` allocation order, and the `reviewedDate` skip-if-newer logic in TutorialMeta. The plan asks you to lift this verbatim; do not rewrite it.

**Files:**
- Modify: `srv/lib/content-publish-session.js`
- Modify: `srv/__tests__/lib/content-publish-session.test.js`

- [ ] **Step 1: Write the failing tests for appendToSession**

Append to the `describe('content-publish-session', ...)` block in the test file:

```js
  it('appendToSession persists files and computes a per-batch hash', async () => {
    const { ContentFiles } = cds.entities(NS);
    const { sessionId, version } = await helpers.beginPublishSession({
      trigger: 't', hugoVersion: 'v1', expectedSlugCount: 1
    });

    const html = '<html><body><main class="tutorial-main">hello</main></body></html>';
    const { gzipSync } = await import('node:zlib');
    const files = { 'demo-slug': gzipSync(Buffer.from(html)).toString('base64') };

    const result = await helpers.appendToSession({ sessionId, files, metadata: {}, bodyTexts: {} });

    expect(result.slugsAccepted).toBe(1);
    expect(result.batchHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.totalSizeBytes).toBe(html.length);

    const row = await SELECT.one.from(ContentFiles).where({ slug: 'demo-slug', version });
    expect(row.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(row.sizeBytes).toBe(html.length);
  });

  it('appendToSession rejects an unknown sessionId with 404', async () => {
    await expect(
      helpers.appendToSession({
        sessionId: '00000000-0000-0000-0000-000000000000',
        files: {}, metadata: {}, bodyTexts: {}
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('appendToSession bumps lastAppendAt on every call', async () => {
    const { ContentManifest } = cds.entities(NS);
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0
    });
    const before = (await SELECT.one.from(ContentManifest).where({ sessionId })).lastAppendAt;

    await new Promise(r => setTimeout(r, 50));
    await helpers.appendToSession({ sessionId, files: {}, metadata: {}, bodyTexts: {} });

    const after = (await SELECT.one.from(ContentManifest).where({ sessionId })).lastAppendAt;
    expect(new Date(after).getTime()).toBeGreaterThan(new Date(before).getTime());
  });
```

- [ ] **Step 2: Run the new tests to confirm they fail**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js -t "appendToSession"`
Expected: FAIL — `helpers.appendToSession is not a function`.

- [ ] **Step 3: Implement appendToSession**

Edit `srv/lib/content-publish-session.js`. Add these imports at the top:

```js
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
```

Inside `createSessionHelpers`, before the final `return`, add:

```js
  async function findActiveSession(sessionId) {
    const { ContentManifest } = cds.entities(namespace);
    const row = await SELECT.one.from(ContentManifest).where({ sessionId, status: 'PUBLISHING' });
    if (!row) {
      const err = new Error(`No PUBLISHING session for sessionId ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }
    return row;
  }

  async function appendToSession({ sessionId, files = {}, metadata = {}, bodyTexts = {} }) {
    const session = await findActiveSession(sessionId);
    const { ContentFiles, ContentManifest } = cds.entities(namespace);

    const slugs = Object.keys(files);
    const entries = [];
    let totalSizeBytes = 0;
    const batchHasher = createHash('sha256');

    for (const slug of slugs) {
      const compressed = Buffer.from(files[slug], 'base64');
      const decompressed = gunzipSync(compressed);
      const contentHash = createHash('sha256').update(decompressed).digest('hex');
      batchHasher.update(slug).update(contentHash);

      entries.push({
        slug,
        version: session.version,
        content: compressed,
        contentHash,
        sizeBytes: decompressed.length,
        compressedBytes: compressed.length,
        mimeType: 'text/html'
      });
      totalSizeBytes += decompressed.length;
    }

    if (entries.length > 0) {
      // Insert in groups of 50 — same batch size publishHandler uses.
      for (let i = 0; i < entries.length; i += 50) {
        await INSERT.into(ContentFiles).entries(entries.slice(i, i + 50));
      }
    }

    if (Object.keys(metadata).length > 0) {
      await upsertTutorialMetadata(namespace, metadata);
    }
    if (Object.keys(bodyTexts).length > 0) {
      await upsertBodyTexts(namespace, bodyTexts);
    }

    await UPDATE(ContentManifest)
      .where({ sessionId })
      .set({ lastAppendAt: new Date().toISOString() });

    return {
      slugsAccepted: slugs.length,
      totalSizeBytes,
      batchHash: batchHasher.digest('hex')
    };
  }
```

Add `appendToSession` to the `return { ... }` at the bottom:

```js
  return { beginPublishSession, appendToSession };
```

Add the metadata and body-text helpers below `createSessionHelpers` (export-not-needed, module-private). Lift them verbatim from [srv/lib/content-store.js:405-571](../../srv/lib/content-store.js#L405) — the loop that does `existing = await SELECT.one.from(Tutorials).where({ slug })` etc. — but parameterize them on `namespace`:

```js
async function upsertTutorialMetadata(namespace, metadata) {
  // Lifted from content-store.js publishHandler. The body of the loop is unchanged;
  // only the surrounding wrapper differs (no pipelineLogId here — that is logged
  // at the route layer instead). Includes Tutorials + Steps + TutorialMeta upserts
  // and the per-tutorial recomputeTutorialProgress call.
  // ...full implementation...
}

async function upsertBodyTexts(namespace, bodyTexts) {
  // Lifted from content-store.js publishHandler — the TutorialBodyText upsert loop.
  // ...full implementation...
}
```

When implementing, copy the existing code carefully — the metadata loop has subtle behavior (skip-if-already-newer for `reviewedDate`, `legacyId` allocation, `recomputeTutorialProgress` call). Do not rewrite from scratch; lift verbatim.

- [ ] **Step 4: Run all session tests to confirm they pass**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js`
Expected: PASS for all five test cases (the 2 from Task 2a + 3 new).

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-publish-session.js srv/__tests__/lib/content-publish-session.test.js
git commit -m "feat(content-publish): add appendToSession with metadata + body-text upsert

Persists ContentFiles for one batch, computes a per-batch SHA-256 the
client uses to verify round-trip integrity, and bumps lastAppendAt so
the GC reaper sees the session as live. Metadata + bodyText upsert lifted
verbatim from publishHandler; the carry-forward / recompute-progress
phase stays in commit (next task)."
```

---

## Task 2c: Server-side session helper — commitSession and abortSession

`commitSession` runs the carry-forward, recomputes `TaskRecords` progress for affected tutorials, flips the new manifest to `ACTIVE`, supersedes the previous, releases the lock, and invalidates the cache. It is **idempotent** — calling it on a manifest that is already `ACTIVE` returns the same result without re-running the carry-forward. This is what makes the new protocol robust against the gorouter timeout drop that motivated the spec.

**Before you start:** Read [srv/lib/content-store.js:320-378](../../srv/lib/content-store.js#L320) — the carry-forward block. There is a HANA-vs-SQLite split (raw SQL on HANA to dodge LOB locator expiry; CDS QL on SQLite for unit tests — see the `feedback_hana_lob_locator_expiry` memory). Lift the entire branching block verbatim into your new `carryForwardUnchanged` helper. Also read the surrounding `recomputeTutorialProgress` call (around line 470) — it must run inside `commit`, not append, because it depends on the merged file set.

**Files:**
- Modify: `srv/lib/content-publish-session.js`
- Modify: `srv/__tests__/lib/content-publish-session.test.js`

- [ ] **Step 1: Write failing tests for commit + abort**

Append to the test file:

```js
  it('commitSession flips manifest to ACTIVE and supersedes the previous version', async () => {
    const { ContentManifest } = cds.entities(NS);

    // Seed a previous ACTIVE so we can verify carry-forward and supersede.
    const prev = await helpers.beginPublishSession({ trigger: 'prev', hugoVersion: 'v1', expectedSlugCount: 0 });
    await helpers.commitSession({ sessionId: prev.sessionId });

    const next = await helpers.beginPublishSession({ trigger: 'next', hugoVersion: 'v1', expectedSlugCount: 0 });
    const result = await helpers.commitSession({ sessionId: next.sessionId });

    expect(result.version).toBe(next.version);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const newRow = await SELECT.one.from(ContentManifest).where({ version: next.version });
    const oldRow = await SELECT.one.from(ContentManifest).where({ version: prev.version });
    expect(newRow.status).toBe('ACTIVE');
    expect(oldRow.status).toBe('SUPERSEDED');
  });

  it('commitSession is idempotent when called on an already-ACTIVE manifest', async () => {
    const { sessionId } = await helpers.beginPublishSession({ trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 });
    const first = await helpers.commitSession({ sessionId });
    const second = await helpers.commitSession({ sessionId });
    expect(second.version).toBe(first.version);
    expect(second.alreadyActive).toBe(true);
  });

  it('abortSession marks the manifest FAILED and releases the lock', async () => {
    const { ContentManifest } = cds.entities(NS);
    const { sessionId, version } = await helpers.beginPublishSession({ trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 });

    await helpers.abortSession({ sessionId, reason: 'test' });

    const row = await SELECT.one.from(ContentManifest).where({ version });
    expect(row.status).toBe('FAILED');

    // Lock released — a fresh begin should succeed.
    const next = await helpers.beginPublishSession({ trigger: 't2', hugoVersion: 'v1', expectedSlugCount: 0 });
    expect(next.sessionId).not.toBe(sessionId);
  });

  it('abortSession is idempotent when the manifest is already FAILED', async () => {
    const { sessionId } = await helpers.beginPublishSession({ trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 });
    await helpers.abortSession({ sessionId, reason: 'first' });
    await expect(helpers.abortSession({ sessionId, reason: 'second' })).resolves.toMatchObject({ aborted: true });
  });
```

- [ ] **Step 2: Run new tests to confirm they fail**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js -t "commitSession|abortSession"`
Expected: FAIL — `helpers.commitSession is not a function`.

- [ ] **Step 3: Implement commit and abort**

Inside `createSessionHelpers`, before the final `return`, add:

```js
  async function commitSession({ sessionId }) {
    const { ContentManifest } = cds.entities(namespace);

    const existing = await SELECT.one.from(ContentManifest).where({ sessionId });
    if (!existing) {
      const err = new Error(`No manifest for sessionId ${sessionId}`);
      err.statusCode = 404;
      throw err;
    }
    if (existing.status === 'ACTIVE') {
      return {
        version: existing.version,
        fileCount: existing.fileCount,
        totalSizeBytes: existing.totalSizeBytes,
        durationMs: existing.publishDurationMs || 0,
        alreadyActive: true
      };
    }
    if (existing.status !== 'PUBLISHING') {
      const err = new Error(`Cannot commit session in status ${existing.status}`);
      err.statusCode = 409;
      throw err;
    }

    const startTime = Date.now();
    const newVersion = existing.version;

    // Carry forward unchanged slugs from the previously-ACTIVE manifest.
    // This logic is lifted verbatim from the legacy publishHandler at
    // srv/lib/content-store.js:320-378 so prod/SQLite parity is preserved.
    const { carriedForward, carriedSize } = await carryForwardUnchanged(namespace, newVersion);

    // Count how many slugs were actually written by /append for this version
    // so the manifest fileCount + totalSizeBytes reflect both fresh + carried.
    const { ContentFiles } = cds.entities(namespace);
    const freshAgg = await SELECT.one.from(ContentFiles)
      .columns('count(*) as c', 'sum(sizeBytes) as s')
      .where({ version: newVersion });
    const freshCount = (freshAgg?.c || 0) - carriedForward;
    const freshSize  = (Number(freshAgg?.s) || 0) - carriedSize;

    // Recompute TaskRecords progress for any tutorials whose stepCount changed.
    // Pull the existing helper from content-store.js — same behavior, same edge cases.
    await recomputeProgressForChangedTutorials(namespace, newVersion);

    // Mark previous ACTIVE as SUPERSEDED, flip new to ACTIVE.
    await UPDATE(ContentManifest)
      .where({ status: 'ACTIVE' })
      .and({ version: { '!=': newVersion } })
      .set({ status: 'SUPERSEDED' });

    const durationMs = Date.now() - startTime;
    await UPDATE(ContentManifest)
      .where({ sessionId })
      .set({
        status: 'ACTIVE',
        fileCount: freshCount + carriedForward,
        totalSizeBytes: freshSize + carriedSize,
        publishDurationMs: durationMs
      });

    await releaseLock(LOCK_NAME, INSTANCE_ID, namespace).catch(() => {});

    return {
      version: newVersion,
      fileCount: freshCount + carriedForward,
      totalSizeBytes: freshSize + carriedSize,
      durationMs,
      carriedForward,
      alreadyActive: false
    };
  }

  async function abortSession({ sessionId, reason }) {
    const { ContentManifest } = cds.entities(namespace);
    const existing = await SELECT.one.from(ContentManifest).where({ sessionId });
    if (!existing) {
      // Idempotent: nothing to abort.
      return { aborted: true };
    }
    if (existing.status === 'PUBLISHING') {
      await UPDATE(ContentManifest)
        .where({ sessionId })
        .set({ status: 'FAILED', trigger: ((existing.trigger || '') + ` [aborted: ${reason || 'unknown'}]`).slice(0, 500) });
      await releaseLock(LOCK_NAME, INSTANCE_ID, namespace).catch(() => {});
    }
    // FAILED, ACTIVE, SUPERSEDED → no-op, idempotent.
    return { aborted: true };
  }
```

Update the `return { ... }` to include all four:

```js
  return { beginPublishSession, appendToSession, commitSession, abortSession };
```

Add module-private helpers `carryForwardUnchanged` and `recomputeProgressForChangedTutorials` below `createSessionHelpers`. Lift the carry-forward logic from [srv/lib/content-store.js:320-378](../../srv/lib/content-store.js#L320) (preserving the HANA raw-SQL + SQLite CDS-QL split — see the `[[feedback_hana_lob_locator_expiry]]` memory). Lift the progress-recompute helper similarly.

- [ ] **Step 4: Run all session tests**

Run: `npx vitest run srv/__tests__/lib/content-publish-session.test.js`
Expected: PASS for all 9 test cases.

- [ ] **Step 5: Commit**

```bash
git add srv/lib/content-publish-session.js srv/__tests__/lib/content-publish-session.test.js
git commit -m "feat(content-publish): add commitSession + abortSession helpers

Carry-forward + ACTIVE flip + lock release — closing the chunked
publish protocol on the server side. Commit is idempotent: a manifest
already ACTIVE returns its activation result without re-running
carry-forward, which closes the original 2026-05-29 false-negative bug
at the protocol level. Abort marks the manifest FAILED and is also
idempotent."
```

---

## Task 3: Wire begin/append/commit/abort routes into the server

The session helpers are now standalone. This task adds thin Express handlers that translate HTTP requests into helper calls and registers them in `srv/server.js`. Existing `publishHandler` stays untouched (frozen-deprecated per the spec).

**Files:**
- Modify: `srv/lib/content-store.js` (add new handler exports)
- Modify: `srv/server.js:130-132` (register routes)
- Create: `srv/__tests__/lib/content-publish-routes.test.js`

- [ ] **Step 1: Write failing route-level test**

This test follows the same pattern as the existing `srv/__tests__/lib/content-store-skip-metadata.test.js` — hand-rolled `makeReq`/`makeRes` mocks calling handlers directly. The repo does NOT have supertest installed; do not add it.

Create `srv/__tests__/lib/content-publish-routes.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
  beginHandler, appendHandler, commitHandler, abortHandler, contentAuthMiddleware
} from '../../lib/content-store.js';

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

describe('content publish routes', () => {
  beforeAll(async () => {
    cds.test('serve', '--project', '.', '--in-memory');
    await cds.connect.to('db');
    process.env.CONTENT_API_KEY = 'test-key';
  });

  beforeEach(async () => {
    const { ContentManifest, ContentFiles, JobLocks } = cds.entities(NS);
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(JobLocks);
  });

  it('begin → append → commit produces an ACTIVE manifest', async () => {
    const beginReq = makeReq(
      { trigger: 'route-test', hugoVersion: 'v1', expectedSlugCount: 1 },
      { authorization: 'Bearer test-key' }
    );
    const beginRes = makeRes();
    await beginHandler(beginReq, beginRes);
    expect(beginRes._status).toBe(201);
    expect(beginRes._body.sessionId).toMatch(/^[0-9a-f-]{36}$/);

    const html = '<html><body><main class="tutorial-main">x</main></body></html>';
    const appendReq = makeReq(
      {
        sessionId: beginRes._body.sessionId,
        files: { 'route-demo': gzipSync(Buffer.from(html)).toString('base64') },
        metadata: {}, bodyTexts: {}
      },
      { authorization: 'Bearer test-key' }
    );
    const appendRes = makeRes();
    await appendHandler(appendReq, appendRes);
    expect(appendRes._status).toBe(202);
    expect(appendRes._body.slugsAccepted).toBe(1);

    const commitReq = makeReq(
      { sessionId: beginRes._body.sessionId },
      { authorization: 'Bearer test-key' }
    );
    const commitRes = makeRes();
    await commitHandler(commitReq, commitRes);
    expect(commitRes._status).toBe(200);
    expect(commitRes._body.version).toBe(beginRes._body.version);

    const { ContentManifest } = cds.entities(NS);
    const row = await SELECT.one.from(ContentManifest).where({ version: beginRes._body.version });
    expect(row.status).toBe('ACTIVE');
  });

  it('begin missing sessionId in append returns 400', async () => {
    const req = makeReq({}, { authorization: 'Bearer test-key' });
    const res = makeRes();
    await appendHandler(req, res);
    expect(res._status).toBe(400);
  });

  it('abort marks the manifest FAILED', async () => {
    const beginReq = makeReq(
      { trigger: 'abort-test', hugoVersion: 'v1', expectedSlugCount: 0 },
      { authorization: 'Bearer test-key' }
    );
    const beginRes = makeRes();
    await beginHandler(beginReq, beginRes);

    const abortReq = makeReq(
      { sessionId: beginRes._body.sessionId, reason: 'test' },
      { authorization: 'Bearer test-key' }
    );
    const abortRes = makeRes();
    await abortHandler(abortReq, abortRes);
    expect(abortRes._status).toBe(200);
    expect(abortRes._body.aborted).toBe(true);

    const { ContentManifest } = cds.entities(NS);
    const row = await SELECT.one.from(ContentManifest).where({ version: beginRes._body.version });
    expect(row.status).toBe('FAILED');
  });
});
```

Note on auth: `contentAuthMiddleware` is registered at the Express layer in `srv/server.js`; the handlers themselves do not enforce auth. Testing the auth-required behavior would require integrating express, which adds complexity for low value here. The middleware is already covered by existing tests — we just verify the new handlers work when called past it.

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run srv/__tests__/lib/content-publish-routes.test.js`
Expected: FAIL — `Cannot find ... beginHandler`.

- [ ] **Step 3: Add the four handlers to `srv/lib/content-store.js`**

In `srv/lib/content-store.js`, locate the `createContentHandlers` factory (it returns the legacy handlers). Inside the factory, after the existing handler definitions, add:

```js
  const sessionHelpers = createSessionHelpers({ namespace });

  async function beginHandler(req, res) {
    try {
      const { trigger, hugoVersion, expectedSlugCount } = req.body || {};
      const result = await sessionHelpers.beginPublishSession({ trigger, hugoVersion, expectedSlugCount });
      LOG.info(`[content/publish/begin] sessionId=${result.sessionId} version=${result.version}`);
      res.status(201).json({ ...result, expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString() });
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/begin] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  async function appendHandler(req, res) {
    try {
      const { sessionId, files, metadata, bodyTexts } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const droppedFiles = dropCatalogSlugs(files);
      dropCatalogSlugs(metadata);
      dropCatalogSlugs(bodyTexts);
      if (droppedFiles.length) {
        LOG.warn(`[content/publish/append] dropped ${droppedFiles.length} catalog slug(s)`);
      }
      const result = await sessionHelpers.appendToSession({ sessionId, files, metadata, bodyTexts });
      res.status(202).json(result);
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/append] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  async function commitHandler(req, res) {
    try {
      const { sessionId } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const result = await sessionHelpers.commitSession({ sessionId });
      cache.invalidate();
      LOG.info(`[content/publish/commit] sessionId=${sessionId} version=${result.version} duration=${result.durationMs}ms alreadyActive=${result.alreadyActive}`);
      res.status(200).json(result);
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/commit] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }

  async function abortHandler(req, res) {
    try {
      const { sessionId, reason } = req.body || {};
      if (!sessionId) return res.status(400).json({ error: 'sessionId required' });
      const result = await sessionHelpers.abortSession({ sessionId, reason });
      LOG.info(`[content/publish/abort] sessionId=${sessionId} reason=${reason || 'unknown'}`);
      res.status(200).json(result);
    } catch (err) {
      const code = err.statusCode || 500;
      LOG.error(`[content/publish/abort] ${err.message}`);
      res.status(code).json({ error: err.message });
    }
  }
```

Add a module-level `createSessionHelpers` import at the top of `srv/lib/content-store.js`:

```js
import { createSessionHelpers } from './content-publish-session.js';
```

Add the four handlers to the object returned from `createContentHandlers` and to the named exports at the bottom of the file (matching the pattern used by `publishHandler`, `serveHandler`, etc):

```js
return {
  // ... existing
  beginHandler,
  appendHandler,
  commitHandler,
  abortHandler,
};
```

```js
export const beginHandler = _defaults.beginHandler;
export const appendHandler = _defaults.appendHandler;
export const commitHandler = _defaults.commitHandler;
export const abortHandler = _defaults.abortHandler;
```

Tag the legacy `publishHandler` with a one-time deprecation log: at the top of its body, add:

```js
LOG.warn('[content/publish] DEPRECATED single-shot endpoint — clients should migrate to /content/publish/begin|append|commit (spec: 2026-05-29-publish-content-hardening-design.md)');
```

- [ ] **Step 4: Register routes in `srv/server.js`**

In `srv/server.js`, find the existing line at [srv/server.js:132](../../srv/server.js#L132):

```js
app.post('/content/publish', express.json({ limit: '100mb' }), contentAuthMiddleware, publishHandler);
```

Add immediately after it (and update the import at line 13):

```js
app.post('/content/publish/begin',  express.json({ limit: '1mb' }),   contentAuthMiddleware, beginHandler);
app.post('/content/publish/append', express.json({ limit: '100mb' }), contentAuthMiddleware, appendHandler);
app.post('/content/publish/commit', express.json({ limit: '1mb' }),   contentAuthMiddleware, commitHandler);
app.post('/content/publish/abort',  express.json({ limit: '1mb' }),   contentAuthMiddleware, abortHandler);
```

Update the import at [srv/server.js:13](../../srv/server.js#L13):

```js
import {
  contentAuthMiddleware, publishHandler, serveHandler, hashesHandler, navHandler,
  rollbackHandler, invalidateRenderCache,
  beginHandler, appendHandler, commitHandler, abortHandler
} from './lib/content-store.js';
```

- [ ] **Step 5: Run the route tests**

Run: `npx vitest run srv/__tests__/lib/content-publish-routes.test.js`
Expected: PASS for both cases.

- [ ] **Step 6: Run all content-store tests to verify the legacy path still works**

Run: `npx vitest run srv/__tests__/lib/content-store`
Expected: All existing tests still pass. The deprecation warning fires (visible in test output) but does not break anything.

- [ ] **Step 7: Commit**

```bash
git add srv/lib/content-store.js srv/server.js srv/__tests__/lib/content-publish-routes.test.js
git commit -m "feat(content-publish): wire begin/append/commit/abort HTTP routes

Thin Express handlers translating HTTP into the new session helpers.
Legacy /content/publish endpoint stays in place; emits a one-line
deprecation warning per call. Catalog slugs are dropped at the route
layer for parity with the legacy handler."
```

---

## Task 4: Tighten the GC reaper cadence

There is already a `content-publishing-sweep` cron at [srv/jobs/scheduler.js:78-80](../../srv/jobs/scheduler.js#L78) that calls `cleanupStuckPublishing(60)` hourly. The spec needs reaping within 30 min, which an hourly job with a 60-min threshold cannot honor. Tighten to every 5 minutes with a 30-min threshold, and teach the reaper to ignore rows where `sessionId IS NULL` (legacy single-shot publishes).

**Files:**
- Modify: `srv/jobs/cleanup.js:67` (cleanupStuckPublishing — add sessionId filter)
- Modify: `srv/jobs/scheduler.js:78-80` (cron expression + threshold)
- Modify: `srv/__tests__/jobs/cleanup.test.js` (or create if missing)

- [ ] **Step 1: Write the failing test**

Create or extend `srv/__tests__/jobs/cleanup.test.js`. If the file exists, append; otherwise create with this skeleton plus the new test:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cleanupStuckPublishing } from '../../jobs/cleanup.js';

const NS = 'com.sap.developers.ims';

describe('cleanupStuckPublishing', () => {
  beforeAll(async () => {
    cds.test(__dirname + '/../..').in(__dirname + '/../..');
    await cds.connect.to('db');
  });

  beforeEach(async () => {
    const { ContentManifest } = cds.entities(NS);
    await DELETE.from(ContentManifest);
  });

  it('marks PUBLISHING rows older than threshold as FAILED only when sessionId is set', async () => {
    const { ContentManifest } = cds.entities(NS);
    const oldDate = new Date(Date.now() - 31 * 60 * 1000).toISOString();

    // Stale chunked session — should be reaped.
    await INSERT.into(ContentManifest).entries({
      version: 1, status: 'PUBLISHING', sessionId: '11111111-1111-1111-1111-111111111111',
      lastAppendAt: oldDate, fileCount: 0, totalSizeBytes: 0,
      changedSlugs: '[]', trigger: 'stale'
    });

    // Stale legacy publish (no sessionId) — should NOT be reaped by this job.
    await INSERT.into(ContentManifest).entries({
      version: 2, status: 'PUBLISHING', sessionId: null,
      lastAppendAt: null, fileCount: 0, totalSizeBytes: 0,
      changedSlugs: '[]', trigger: 'legacy', createdAt: oldDate
    });

    await cleanupStuckPublishing(30);

    const v1 = await SELECT.one.from(ContentManifest).where({ version: 1 });
    const v2 = await SELECT.one.from(ContentManifest).where({ version: 2 });
    expect(v1.status).toBe('FAILED');
    expect(v2.status).toBe('PUBLISHING'); // legacy untouched
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `npx vitest run srv/__tests__/jobs/cleanup.test.js -t "marks PUBLISHING"`
Expected: FAIL — likely "v2.status to be PUBLISHING but got FAILED" because today's reaper does not filter on sessionId.

- [ ] **Step 3: Update cleanupStuckPublishing**

Open `srv/jobs/cleanup.js`. Replace the body of `cleanupStuckPublishing` (around line 67) with logic that filters chunked sessions on `lastAppendAt` and keeps the legacy `createdAt`-based fallback for rows where `sessionId IS NULL`:

```js
export async function cleanupStuckPublishing(olderThanMinutes = 30, legacyOlderThanMinutes = 60) {
  const { ContentManifest } = cds.entities('com.sap.developers.ims');
  const sessionCutoff = new Date(Date.now() - olderThanMinutes * 60 * 1000).toISOString();
  const legacyCutoff  = new Date(Date.now() - legacyOlderThanMinutes * 60 * 1000).toISOString();

  // Two cohorts:
  //  - Chunked sessions (sessionId IS NOT NULL): reap on lastAppendAt > 30 min
  //  - Legacy single-shot publishes (sessionId IS NULL): reap on createdAt > 60 min
  // Different thresholds because the chunked protocol heartbeats every append (so 30
  // min is a tight bound) while the legacy single-shot has no heartbeat at all.
  const stuck = await SELECT.from(ContentManifest)
    .columns('version', 'sessionId', 'lastAppendAt', 'createdAt')
    .where`status = 'PUBLISHING' and (
        (sessionId is not null and lastAppendAt < ${sessionCutoff})
        or (sessionId is null and createdAt < ${legacyCutoff})
      )`;

  if (stuck.length === 0) {
    return { reaped: 0 };
  }

  await UPDATE(ContentManifest)
    .where({ version: { in: stuck.map(r => r.version) } })
    .set({ status: 'FAILED' });

  // Best-effort lock release.
  try {
    const { releaseLock } = await import('../lib/job-lock.js');
    await releaseLock('content-publish', process.env.CF_INSTANCE_GUID || `local-${process.pid}`, 'com.sap.developers.ims').catch(() => {});
  } catch { /* job-lock unavailable in test contexts is fine */ }

  const chunked = stuck.filter(r => r.sessionId).length;
  const legacy  = stuck.length - chunked;
  LOG.info(`Marked ${stuck.length} stuck PUBLISHING manifests as FAILED (chunked: ${chunked} > ${olderThanMinutes}m, legacy: ${legacy} > ${legacyOlderThanMinutes}m)`);
  return { reaped: stuck.length, sessionIds: stuck.filter(r => r.sessionId).map(r => r.sessionId) };
}
```

The test from Step 1 still passes because the legacy row's `createdAt` (set via `oldDate` 31 minutes back) is younger than the legacy 60-min threshold, so it stays PUBLISHING. **Update the test to assert this explicitly** — extend the test from Step 1:

```js
  it('reaps legacy single-shot publishes (sessionId NULL) using createdAt and a longer threshold', async () => {
    const { ContentManifest } = cds.entities(NS);
    const veryOld = new Date(Date.now() - 61 * 60 * 1000).toISOString();

    await INSERT.into(ContentManifest).entries({
      version: 3, status: 'PUBLISHING', sessionId: null,
      lastAppendAt: null, createdAt: veryOld,
      fileCount: 0, totalSizeBytes: 0,
      changedSlugs: '[]', trigger: 'legacy-very-old'
    });

    await cleanupStuckPublishing(30, 60);

    const v3 = await SELECT.one.from(ContentManifest).where({ version: 3 });
    expect(v3.status).toBe('FAILED');
  });
```

- [ ] **Step 4: Update the cron schedule**

In `srv/jobs/scheduler.js`, replace the existing `content-publishing-sweep` block (lines 77-80):

```js
  // Every 5 minutes — mark stuck PUBLISHING manifests as FAILED. Threshold 30 min
  // matches the begin/append/commit lock duration. Off-minute (every 5m starting at :03)
  // to keep us out of the :00/:30 thundering herd. See spec: 2026-05-29-publish-content-hardening.
  cron.schedule('3-58/5 * * * *', () =>
    runWithLock('content-publishing-sweep', 300000, () => cleanupStuckPublishing(30))
  );
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run srv/__tests__/jobs/cleanup.test.js`
Expected: PASS.

Run the broader cleanup suite to make sure nothing else regressed:
Run: `npx vitest run srv/__tests__/jobs/`
Expected: All cleanup-related tests pass.

- [ ] **Step 6: Commit**

```bash
git add srv/jobs/cleanup.js srv/jobs/scheduler.js srv/__tests__/jobs/cleanup.test.js
git commit -m "feat(content-publish): tighten reaper to 5-min cadence, 30-min threshold

The chunked-publish spec requires stale PUBLISHING sessions to be
marked FAILED within 30 min so a fresh publish can proceed. The hourly
job with a 60-min threshold could not honor that. New schedule reaps
every 5 min on an off-minute. Legacy single-shot publishes (sessionId
IS NULL) are exempt — they keep the original 60-min behavior on their
own publish handler exception path."
```

---

## Task 5: Client retry helper

**Files:**
- Create: `scripts/lib/publish-retry.ts`
- Create: `scripts/__tests__/publish-retry.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/publish-retry.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { withRetry, classifyError, formatErrorChain } from '../lib/publish-retry.js';

describe('classifyError', () => {
  it('classifies HTTP 5xx as transient', () => {
    expect(classifyError({ status: 502 })).toBe('transient');
    expect(classifyError({ status: 503 })).toBe('transient');
    expect(classifyError({ status: 504 })).toBe('transient');
  });
  it('classifies HTTP 408 and 429 as transient', () => {
    expect(classifyError({ status: 408 })).toBe('transient');
    expect(classifyError({ status: 429 })).toBe('transient');
  });
  it('classifies other 4xx as permanent', () => {
    expect(classifyError({ status: 400 })).toBe('permanent');
    expect(classifyError({ status: 401 })).toBe('permanent');
    expect(classifyError({ status: 409 })).toBe('permanent');
    expect(classifyError({ status: 413 })).toBe('permanent');
  });
  it('classifies fetch TypeError as transient', () => {
    const err = new TypeError('fetch failed');
    expect(classifyError(err)).toBe('transient');
  });
  it('classifies AbortError as transient', () => {
    const err = new Error('timeout');
    err.name = 'AbortError';
    expect(classifyError(err)).toBe('transient');
  });
  it('classifies ECONNRESET / ETIMEDOUT / EPIPE codes as transient', () => {
    for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'UND_ERR_SOCKET']) {
      expect(classifyError({ code })).toBe('transient');
    }
  });
});

describe('formatErrorChain', () => {
  it('walks err.cause recursively', () => {
    const inner = new Error('inner');
    (inner as any).code = 'UND_ERR_SOCKET';
    const middle = new Error('middle');
    (middle as any).cause = inner;
    const outer = new TypeError('fetch failed');
    (outer as any).cause = middle;
    const formatted = formatErrorChain(outer);
    expect(formatted).toContain('TypeError: fetch failed');
    expect(formatted).toContain('caused by: Error: middle');
    expect(formatted).toContain('caused by: Error: inner');
    expect(formatted).toContain('UND_ERR_SOCKET');
  });
});

describe('withRetry', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('returns the result on first attempt success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const p = withRetry(fn, { attempts: 3, backoffMs: [1, 3, 9] });
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries on transient error and eventually succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 502 }))
      .mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 503 }))
      .mockResolvedValue('ok');
    const p = withRetry(fn, { attempts: 3, backoffMs: [1000, 3000, 9000] });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(p).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('does NOT retry permanent errors', async () => {
    const fn = vi.fn().mockRejectedValue(Object.assign(new Error('bad'), { status: 400 }));
    const p = withRetry(fn, { attempts: 3, backoffMs: [1, 3, 9] });
    await expect(p).rejects.toThrow('bad');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('throws after attempts exhausted, exposing attempt count and last cause', async () => {
    const err502 = Object.assign(new Error('boom'), { status: 502 });
    const fn = vi.fn().mockRejectedValue(err502);
    const p = withRetry(fn, { attempts: 3, backoffMs: [10, 30, 90] });
    await vi.advanceTimersByTimeAsync(40);
    await vi.advanceTimersByTimeAsync(30);
    await expect(p).rejects.toMatchObject({ attempts: 3 });
    expect(fn).toHaveBeenCalledTimes(3);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run scripts/__tests__/publish-retry.test.ts`
Expected: FAIL — `Cannot find module '../lib/publish-retry.js'`.

- [ ] **Step 3: Implement the helper**

Create `scripts/lib/publish-retry.ts`:

```ts
export type FailureClass = 'transient' | 'permanent';

const TRANSIENT_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const TRANSIENT_CODES  = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'
]);

export function classifyError(err: any): FailureClass {
  if (err == null) return 'permanent';
  if (typeof err.status === 'number') {
    return TRANSIENT_STATUS.has(err.status) ? 'transient' : 'permanent';
  }
  if (typeof err.code === 'string' && TRANSIENT_CODES.has(err.code)) return 'transient';
  if (err.name === 'AbortError') return 'transient';
  if (err instanceof TypeError && /fetch failed/i.test(err.message)) return 'transient';
  return 'permanent';
}

export function formatErrorChain(err: any): string {
  const lines: string[] = [];
  let cur: any = err;
  let depth = 0;
  while (cur && depth < 10) {
    const prefix = depth === 0 ? '' : 'caused by: ';
    const ctor = cur.constructor?.name || 'Error';
    const meta: string[] = [];
    if (cur.code) meta.push(`code=${cur.code}`);
    if (cur.errno) meta.push(`errno=${cur.errno}`);
    if (cur.syscall) meta.push(`syscall=${cur.syscall}`);
    if (cur.status) meta.push(`status=${cur.status}`);
    const tail = meta.length ? `  [${meta.join(' ')}]` : '';
    lines.push(`${prefix}${ctor}: ${cur.message ?? String(cur)}${tail}`);
    cur = cur.cause;
    depth++;
  }
  return lines.join('\n  ');
}

export interface RetryOptions {
  attempts: number;
  backoffMs: number[];
  onAttemptFail?: (attempt: number, err: any, willRetry: boolean) => void;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T> {
  let lastErr: any;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const cls = classifyError(err);
      const willRetry = cls === 'transient' && attempt < opts.attempts;
      opts.onAttemptFail?.(attempt, err, willRetry);
      if (!willRetry) break;
      const wait = opts.backoffMs[Math.min(attempt - 1, opts.backoffMs.length - 1)];
      await new Promise(r => setTimeout(r, wait));
    }
  }
  if (lastErr && typeof lastErr === 'object') (lastErr as any).attempts = opts.attempts;
  throw lastErr;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run scripts/__tests__/publish-retry.test.ts`
Expected: PASS for all cases.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/publish-retry.ts scripts/__tests__/publish-retry.test.ts
git commit -m "feat(publish-content): add bounded retry helper with err.cause walking

Pure function: classifyError + withRetry + formatErrorChain. Transient
class covers HTTP 5xx, 408, 429, fetch TypeError, AbortError, and the
common Node socket error codes (ECONNRESET, ETIMEDOUT, EPIPE,
UND_ERR_SOCKET). Permanent class is everything else; no retry.
formatErrorChain walks err.cause up to 10 levels deep, capturing
err.code, err.errno, err.syscall, err.status — fixes the original
'Fatal: fetch failed' log having zero diagnostic value."
```

---

## Task 6: Client batcher with concurrency pool

**Files:**
- Create: `scripts/lib/publish-batcher.ts`
- Create: `scripts/__tests__/publish-batcher.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/publish-batcher.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import { chunk, runConcurrent } from '../lib/publish-batcher.js';

describe('chunk', () => {
  it('splits into batches of given size with the last batch potentially smaller', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunk([], 3)).toEqual([]);
    expect(chunk([1], 5)).toEqual([[1]]);
  });
});

describe('runConcurrent', () => {
  it('honors the concurrency cap', async () => {
    let inFlight = 0;
    let peak = 0;
    const tasks = Array.from({ length: 12 }, (_, i) => async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight--;
      return i;
    });
    const results = await runConcurrent(tasks, 4);
    expect(results.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it('a failing task does not starve the pool — others still complete', async () => {
    const tasks = [
      async () => { throw new Error('boom'); },
      async () => 'a',
      async () => 'b',
    ];
    const results = await Promise.allSettled(
      tasks.map(t => Promise.resolve().then(t))
    );
    // runConcurrent itself rejects on first error, so test the underlying contract:
    await expect(runConcurrent(tasks, 2)).rejects.toThrow('boom');
  });

  it('returns results in input order', async () => {
    const tasks = [10, 20, 30, 40].map((n, i) => async () => {
      await new Promise(r => setTimeout(r, n));
      return i;
    });
    const results = await runConcurrent(tasks, 2);
    expect(results).toEqual([0, 1, 2, 3]);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run scripts/__tests__/publish-batcher.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the helper**

Create `scripts/lib/publish-batcher.ts`:

```ts
export function chunk<T>(items: T[], size: number): T[][] {
  if (size <= 0) throw new Error('chunk size must be > 0');
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

export async function runConcurrent<T>(tasks: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  if (concurrency <= 0) throw new Error('concurrency must be > 0');
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;
  let firstError: any = null;

  async function worker() {
    while (true) {
      if (firstError) return;
      const i = nextIndex++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        firstError ??= err;
        return;
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker());
  await Promise.all(workers);
  if (firstError) throw firstError;
  return results;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run scripts/__tests__/publish-batcher.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/publish-batcher.ts scripts/__tests__/publish-batcher.test.ts
git commit -m "feat(publish-content): add chunk + runConcurrent helpers

Two pure functions for the chunked-publish client. chunk splits a slug
list into N batches of size S; runConcurrent runs an array of thunks
through a pool of size K, fail-fast on first error. Tests cover
concurrency cap, in-order results, and fail-fast semantics."
```

---

## Task 7: Client protocol module

Wraps the four endpoints in typed, mockable functions. Pure I/O — no `process.exit`, no logging side effects beyond what the caller passes in.

**Files:**
- Create: `scripts/lib/publish-client.ts`
- Create: `scripts/__tests__/publish-client.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `scripts/__tests__/publish-client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  beginSession, appendBatch, commitSession, abortSession, fetchRemoteHashes
} from '../lib/publish-client.js';

const baseUrl = 'http://localhost:4004';
const apiKey  = 'test-key';

describe('publish-client', () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it('beginSession returns sessionId + version on 201', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 201,
      json: () => Promise.resolve({ sessionId: 'abc', version: 7, expiresAt: '2026-05-30T00:00:00Z' })
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await beginSession({ baseUrl, apiKey, trigger: 't', hugoVersion: 'v1', expectedSlugCount: 5 });
    expect(out).toEqual({ sessionId: 'abc', version: 7, expiresAt: '2026-05-30T00:00:00Z' });
    expect(fetchMock).toHaveBeenCalledWith(
      `${baseUrl}/content/publish/begin`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer test-key' })
      })
    );
  });

  it('beginSession throws with status attached on non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409,
      text: () => Promise.resolve('lock held')
    }));
    await expect(
      beginSession({ baseUrl, apiKey, trigger: 't', hugoVersion: 'v1', expectedSlugCount: 0 })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('appendBatch posts files/metadata/bodyTexts and returns server result', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 202,
      json: () => Promise.resolve({ slugsAccepted: 3, batchHash: 'h', totalSizeBytes: 100 })
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await appendBatch({
      baseUrl, apiKey, sessionId: 'abc',
      files: { a: 'AA', b: 'BB', c: 'CC' },
      metadata: {}, bodyTexts: {}
    });
    expect(out.slugsAccepted).toBe(3);
    const [, opts] = fetchMock.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.sessionId).toBe('abc');
    expect(Object.keys(body.files)).toEqual(['a', 'b', 'c']);
  });

  it('commitSession returns the activation result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ version: 7, fileCount: 1398, durationMs: 5234, alreadyActive: false })
    }));
    const out = await commitSession({ baseUrl, apiKey, sessionId: 'abc' });
    expect(out.version).toBe(7);
    expect(out.alreadyActive).toBe(false);
  });

  it('abortSession is best-effort and does not throw on server error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 500,
      text: () => Promise.resolve('boom')
    }));
    await expect(abortSession({ baseUrl, apiKey, sessionId: 'abc', reason: 'r' })).resolves.toMatchObject({ aborted: false });
  });

  it('fetchRemoteHashes returns the hash map', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.resolve({ slug1: 'h1', slug2: 'h2' })
    }));
    const out = await fetchRemoteHashes({ baseUrl });
    expect(out).toEqual({ slug1: 'h1', slug2: 'h2' });
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run scripts/__tests__/publish-client.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Implement the client**

Create `scripts/lib/publish-client.ts`:

```ts
export interface BeginInput {
  baseUrl: string; apiKey: string;
  trigger: string; hugoVersion: string; expectedSlugCount: number;
}
export interface BeginResult { sessionId: string; version: number; expiresAt: string }

export interface AppendInput {
  baseUrl: string; apiKey: string;
  sessionId: string;
  files: Record<string, string>;
  metadata: Record<string, any>;
  bodyTexts: Record<string, string>;
}
export interface AppendResult { slugsAccepted: number; batchHash: string; totalSizeBytes: number }

export interface CommitInput { baseUrl: string; apiKey: string; sessionId: string }
export interface CommitResult {
  version: number; fileCount: number; totalSizeBytes: number;
  durationMs: number; alreadyActive: boolean;
}

async function postJson<T>(url: string, apiKey: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try { detail = await res.text(); } catch { /* ignore */ }
    const err: any = new Error(`HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
    err.status = res.status;
    err.responseBody = detail;
    throw err;
  }
  return res.json() as Promise<T>;
}

export async function beginSession(i: BeginInput): Promise<BeginResult> {
  return postJson(`${i.baseUrl}/content/publish/begin`, i.apiKey, {
    trigger: i.trigger, hugoVersion: i.hugoVersion, expectedSlugCount: i.expectedSlugCount,
  });
}

export async function appendBatch(i: AppendInput): Promise<AppendResult> {
  return postJson(`${i.baseUrl}/content/publish/append`, i.apiKey, {
    sessionId: i.sessionId, files: i.files, metadata: i.metadata, bodyTexts: i.bodyTexts,
  });
}

export async function commitSession(i: CommitInput): Promise<CommitResult> {
  return postJson(`${i.baseUrl}/content/publish/commit`, i.apiKey, { sessionId: i.sessionId });
}

export async function abortSession({ baseUrl, apiKey, sessionId, reason }: {
  baseUrl: string; apiKey: string; sessionId: string; reason?: string;
}): Promise<{ aborted: boolean }> {
  try {
    await postJson<{ aborted: boolean }>(`${baseUrl}/content/publish/abort`, apiKey, { sessionId, reason });
    return { aborted: true };
  } catch {
    // Best-effort — even if the server is unreachable, the GC reaper will pick this up.
    return { aborted: false };
  }
}

export async function fetchRemoteHashes({ baseUrl }: { baseUrl: string }): Promise<Record<string, string>> {
  const res = await fetch(`${baseUrl}/content/hashes`);
  if (!res.ok) {
    if (res.status === 503) return {};
    const err: any = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<Record<string, string>>;
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `npx vitest run scripts/__tests__/publish-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/lib/publish-client.ts scripts/__tests__/publish-client.test.ts
git commit -m "feat(publish-content): add typed client for begin/append/commit/abort

Pure I/O wrappers — postJson attaches err.status and err.responseBody
so the retry helper can classify, abortSession is best-effort
(swallows server errors because the GC reaper is the actual
recovery path), fetchRemoteHashes treats 503 'no active version' as
empty map, matching the server's existing semantics."
```

---

## Task 8: Wire the new flow into scripts/publish-content.ts

This is the largest change to existing code. It replaces the giant single-shot fetch at [scripts/publish-content.ts:467-479](../../scripts/publish-content.ts#L467) with the new orchestration: `begin → batched parallel append with retry → commit → auto-verify`. Adds new flags `--verify-only`, `--heal`, `--concurrency`, `--batch-size`. Adds the `--force`/`--heal` mutex check. Adds new exit codes 2 and 3.

**Files:**
- Modify: `scripts/publish-content.ts`
- Create: `scripts/__tests__/publish-content-cli.test.ts`

- [ ] **Step 1: Write failing CLI tests**

Create `scripts/__tests__/publish-content-cli.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computePublishPlan, validateFlagCombo } from '../publish-content.js';

describe('validateFlagCombo', () => {
  it('rejects --force + --heal', () => {
    expect(() => validateFlagCombo({ force: true, heal: true, verifyOnly: false }))
      .toThrow(/mutually exclusive/i);
  });
  it('rejects --verify-only + --heal', () => {
    expect(() => validateFlagCombo({ force: false, heal: true, verifyOnly: true }))
      .toThrow(/mutually exclusive/i);
  });
  it('accepts a single mode flag', () => {
    expect(() => validateFlagCombo({ force: true,  heal: false, verifyOnly: false })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: true,  verifyOnly: false })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: true  })).not.toThrow();
    expect(() => validateFlagCombo({ force: false, heal: false, verifyOnly: false })).not.toThrow();
  });
});

describe('computePublishPlan', () => {
  const local = new Map<string, string>([
    ['a', 'h_a'], ['b', 'h_b'], ['c', 'h_c'],
  ]);

  it('force mode publishes every local slug', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a' }, mode: 'force' });
    expect(out.targetSlugs.sort()).toEqual(['a', 'b', 'c']);
  });
  it('delta mode publishes only changed/missing slugs', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a', b: 'STALE' }, mode: 'delta' });
    expect(out.targetSlugs.sort()).toEqual(['b', 'c']);
  });
  it('heal mode is the same set as delta', () => {
    const out = computePublishPlan({ local, remote: { a: 'h_a', b: 'STALE' }, mode: 'heal' });
    expect(out.targetSlugs.sort()).toEqual(['b', 'c']);
  });
});
```

- [ ] **Step 2: Run tests to confirm they fail**

Run: `npx vitest run scripts/__tests__/publish-content-cli.test.ts`
Expected: FAIL — exports do not exist.

- [ ] **Step 3: Add new pure helpers to publish-content.ts**

In `scripts/publish-content.ts`, before the `parseArgs` function, add:

```ts
export function validateFlagCombo(flags: { force: boolean; heal: boolean; verifyOnly: boolean }) {
  const modes = [flags.force && 'force', flags.heal && 'heal', flags.verifyOnly && 'verify-only'].filter(Boolean);
  if (modes.length > 1) {
    throw new Error(`Flags ${modes.join(', ')} are mutually exclusive`);
  }
}

export type PublishMode = 'force' | 'heal' | 'delta';

export function computePublishPlan(opts: {
  local: Map<string, string>;
  remote: Record<string, string>;
  mode: PublishMode;
}): { targetSlugs: string[] } {
  if (opts.mode === 'force') return { targetSlugs: [...opts.local.keys()] };
  return { targetSlugs: computeDiff(opts.local, opts.remote) };
}
```

- [ ] **Step 4: Replace the single-shot publish path with the chunked flow**

In `scripts/publish-content.ts`, locate the block that runs from `Building payload...` (around line 387) through the end of `main()`. **Keep the existing pure-function definitions intact** — `discoverTutorials`, `validateProductionBuild`, `computeLocalHashes`, `computeDiff`, `buildPayload`, `extractMetadata`, `extractAllBodyTexts`, `extractBodyText` and the `DEV_ARTIFACT_PATTERNS` constants are all called by the new code. Do not delete any pure helper.

Replace from `log('Building payload...');` onwards with:

```ts
  validateFlagCombo({ force: opts.force, heal: opts.heal, verifyOnly: opts.verifyOnly });

  log('Computing local hashes...');
  const localHashes = computeLocalHashes(tutorials);

  // --- verify-only short-circuit ---
  if (opts.verifyOnly) {
    let remote: Record<string, string>;
    try {
      remote = await fetchRemoteHashes({ baseUrl: opts.baseUrl });
    } catch (err) {
      console.error('Verify failed: cannot reach /content/hashes:', formatErrorChain(err));
      process.exit(1);
    }
    const diff = computeDiff(localHashes, remote);
    if (diff.length === 0) {
      console.log(`Verify OK: ${localHashes.size} slugs match server.`);
      process.exit(0);
    }
    console.error(`Verify FAILED: ${diff.length} slugs differ:`);
    for (const s of diff.slice(0, 50).sort()) console.error(`  - ${s}`);
    if (diff.length > 50) console.error(`  ... (+${diff.length - 50} more)`);
    process.exit(2);
  }

  // --- decide what to publish ---
  let mode: PublishMode = 'delta';
  if (opts.force) mode = 'force';
  else if (opts.heal) mode = 'heal';

  let remoteHashes: Record<string, string> = {};
  if (mode !== 'force') {
    log(`Fetching remote hashes from ${opts.baseUrl}/content/hashes...`);
    try { remoteHashes = await fetchRemoteHashes({ baseUrl: opts.baseUrl }); }
    catch (err) {
      console.error(`Cannot reach ${opts.baseUrl}/content/hashes: ${formatErrorChain(err)}`);
      process.exit(1);
    }
  }

  const { targetSlugs } = computePublishPlan({ local: localHashes, remote: remoteHashes, mode });
  if (targetSlugs.length === 0) {
    console.log('No changes detected. Nothing to publish.');
    process.exit(0);
  }
  console.log(`${targetSlugs.length} of ${tutorials.size} tutorials to publish (${mode} mode)`);

  if (opts.dryRun) {
    console.log('Dry run — would publish:');
    for (const slug of targetSlugs.slice().sort()) console.log(`  ${slug}`);
    process.exit(0);
  }

  // --- begin / append / commit ---
  log('Building payload + extracting metadata...');
  const startTime = Date.now();
  const payload    = buildPayload(targetSlugs, tutorials);
  const hugoContentDir = join(opts.hugoDir, '..', 'content', 'tutorials');
  const metadataAll = extractMetadata(hugoContentDir, targetSlugs);
  const bodyTextsAll = extractAllBodyTexts(tutorials, targetSlugs);

  // __nav__ / __404__ / __shell__ ride along on the first batch (these are
  // small and the server happily accepts them mixed with regular slugs).
  const sidecarKeys = await collectSidecars(opts.hugoDir, payload, log);

  const begin = await beginSession({
    baseUrl: opts.baseUrl, apiKey: opts.apiKey,
    trigger: opts.trigger, hugoVersion: opts.hugoVersion, expectedSlugCount: targetSlugs.length,
  });
  log(`Session ${begin.sessionId} version ${begin.version} (expires ${begin.expiresAt})`);

  const allKeys = [...targetSlugs, ...sidecarKeys];
  const batches = chunk(allKeys, opts.batchSize);
  log(`${batches.length} batches × up to ${opts.batchSize} slugs, concurrency=${opts.concurrency}`);

  try {
    await runConcurrent(
      batches.map((batch, idx) => () => withRetry(
        () => appendBatch({
          baseUrl: opts.baseUrl, apiKey: opts.apiKey,
          sessionId: begin.sessionId,
          files:     pickEntries(payload,        batch),
          metadata:  pickEntries(metadataAll,    batch),
          bodyTexts: pickEntries(bodyTextsAll,   batch),
        }),
        {
          attempts: 3, backoffMs: [1000, 3000, 9000],
          onAttemptFail: (attempt, err, willRetry) => {
            console.error(
              `[publish-content] append batch ${idx + 1}/${batches.length} failed (attempt ${attempt}/3)\n  ${formatErrorChain(err)}\n  ${willRetry ? 'retrying...' : 'giving up'}`
            );
          },
        }
      )),
      opts.concurrency
    );
  } catch (err) {
    console.error(`[publish-content] append failed permanently: ${formatErrorChain(err)}`);
    await abortSession({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, sessionId: begin.sessionId, reason: 'append failed' });
    process.exit(1);
  }

  let commit;
  try {
    commit = await withRetry(
      () => commitSession({ baseUrl: opts.baseUrl, apiKey: opts.apiKey, sessionId: begin.sessionId }),
      {
        attempts: 3, backoffMs: [1000, 3000, 9000],
        onAttemptFail: (attempt, err, willRetry) => {
          console.error(`[publish-content] commit failed (attempt ${attempt}/3): ${formatErrorChain(err)}${willRetry ? ' — retrying' : ''}`);
        },
      }
    );
  } catch (err) {
    console.error(`[publish-content] commit failed permanently — manifest left for GC reaper: ${formatErrorChain(err)}`);
    process.exit(1);
  }

  const totalMs = Date.now() - startTime;
  console.log(`Published successfully:
  Version:    ${commit.version}
  Files:      ${commit.fileCount}
  Size:       ${(commit.totalSizeBytes / 1024 / 1024).toFixed(1)} MB
  Server:     ${commit.durationMs} ms
  Total:      ${totalMs} ms
  Idempotent retry hit?  ${commit.alreadyActive}`);

  // --- auto-verify ---
  log('Verifying server state matches local...');
  let postRemote: Record<string, string>;
  try { postRemote = await fetchRemoteHashes({ baseUrl: opts.baseUrl }); }
  catch (err) {
    console.error(`Auto-verify warning: cannot reach /content/hashes after commit: ${formatErrorChain(err)}`);
    process.exit(0); // commit was successful; don't punish for a transient verify-fetch error
  }
  const verifyDiff = computeDiff(localHashes, postRemote);
  if (verifyDiff.length === 0) {
    console.log(`Verify OK: ${localHashes.size} slugs match server.`);
    process.exit(0);
  }
  console.error(`Verify FAILED: commit reported success but ${verifyDiff.length} slugs still differ:`);
  for (const s of verifyDiff.slice(0, 50).sort()) console.error(`  - ${s}`);
  process.exit(2);
}
```

Add the helper functions and imports. Near the top of the file (after existing imports), add:

```ts
import { beginSession, appendBatch, commitSession, abortSession, fetchRemoteHashes } from './lib/publish-client.js';
import { withRetry, formatErrorChain } from './lib/publish-retry.js';
import { chunk, runConcurrent } from './lib/publish-batcher.js';
```

Above `main()`, add:

```ts
function pickEntries<T>(src: Record<string, T>, keys: string[]): Record<string, T> {
  const out: Record<string, T> = {};
  for (const k of keys) if (k in src) out[k] = src[k];
  return out;
}

async function collectSidecars(hugoDir: string, payload: Record<string, string>, log: (s: string) => void): Promise<string[]> {
  const keys: string[] = [];
  const navJsonPath = join(hugoDir, 'tutorials', '_nav.json');
  if (existsSync(navJsonPath)) {
    const navContent = readFileSync(navJsonPath);
    const navData = JSON.parse(navContent.toString('utf-8'));
    const allNavTutorials = navData.tutorials ?? navData;
    payload['__nav__'] = gzipSync(Buffer.from(JSON.stringify({ tutorials: allNavTutorials }))).toString('base64');
    keys.push('__nav__');
    log(`Included nav metadata for ${allNavTutorials.length} tutorials`);
  }
  const notFoundPath = join(hugoDir, '404.html');
  if (existsSync(notFoundPath)) {
    const notFoundContent = readFileSync(notFoundPath);
    payload['__404__'] = gzipSync(notFoundContent).toString('base64');
    keys.push('__404__');
  }
  const shellPath = join(hugoDir, '_shell', 'index.html');
  if (!existsSync(shellPath)) {
    throw new Error(`[publish-content] _shell/index.html missing — Hugo build did not emit chrome shell. Path: ${shellPath}`);
  }
  const shellRaw = readFileSync(shellPath, 'utf-8');
  const mainMatch = shellRaw.match(/<main\b[^>]*>[\s\S]*?<\/main>/);
  if (!mainMatch) throw new Error('[publish-content] _shell/index.html does not contain <main>...</main>');
  const shellHtml = shellRaw.replace(mainMatch[0], '<!-- MAIN -->');
  if (shellHtml.length < 1000) throw new Error(`[publish-content] chrome shell suspiciously small (${shellHtml.length} bytes)`);
  payload['__shell__'] = gzipSync(Buffer.from(shellHtml, 'utf-8')).toString('base64');
  keys.push('__shell__');
  return keys;
}
```

Update `parseArgs` to include the new flags:

```ts
function parseArgs(argv: string[]): PublishOptions {
  const get = (flag: string, fallback: string): string => {
    const idx = argv.indexOf(flag);
    return idx !== -1 && idx + 1 < argv.length ? argv[idx + 1] : fallback;
  };
  const has = (flag: string): boolean => argv.includes(flag);

  return {
    hugoDir: get('--hugo-dir', 'hugo/public'),
    baseUrl: get('--base-url', process.env.CAP_BASE_URL || 'http://localhost:4004'),
    apiKey:  get('--api-key',  process.env.CONTENT_API_KEY || ''),
    trigger: get('--trigger',  `manual@${process.env.GITHUB_SHA?.slice(0, 7) || 'local'}`),
    hugoVersion: get('--hugo-version', ''),
    dryRun:    has('--dry-run'),
    force:     has('--force'),
    heal:      has('--heal'),
    verifyOnly: has('--verify-only'),
    verbose:   has('--verbose'),
    concurrency: parseInt(get('--concurrency', '6'), 10),
    batchSize:   parseInt(get('--batch-size', '50'), 10),
  };
}
```

And update the `PublishOptions` interface to include `heal`, `verifyOnly`, `concurrency`, `batchSize`.

- [ ] **Step 5: Run all client-side unit tests**

Run: `npx vitest run scripts/__tests__/`
Expected: PASS for all five test files (publish-retry, publish-batcher, publish-client, publish-content-cli, plus any pre-existing publish-content tests).

If pre-existing tests reference deleted code paths, update them — they should still cover the pure functions (`discoverTutorials`, `computeLocalHashes`, `computeDiff`, `buildPayload`, etc.) which are unchanged.

- [ ] **Step 6: Smoke test against local CAP**

Bring up CAP locally with hybrid bindings (`npm run dev:hybrid`), set `CONTENT_API_KEY`, then run:

```bash
CONTENT_API_KEY="tutorials-content-publish-2024" npm run publish-content -- --dry-run --verbose
```

Expected: prints `would publish: ...` list and exits 0. No HTTP traffic.

Then a real publish against the local CAP:

```bash
CONTENT_API_KEY="tutorials-content-publish-2024" npm run publish-content -- --force --verbose
```

Expected: shows `Session ... version ...`, `N batches × up to 50 slugs, concurrency=6`, parallel append progress, `Published successfully`, `Verify OK`. Exit 0.

- [ ] **Step 7: Commit**

```bash
git add scripts/publish-content.ts scripts/__tests__/publish-content-cli.test.ts
git commit -m "feat(publish-content): switch to chunked begin/append/commit flow

Replaces the single-shot 53MB POST that hit gorouter's ~300s idle
timeout. New flags: --verify-only (read-only diff, exit 2 on
mismatch), --heal (publish only diff slugs), --concurrency (default 6),
--batch-size (default 50). Mutex on --force/--heal/--verify-only.
Auto-verify after every successful publish — fetches /content/hashes
and exits 2 if local does not match. Session is aborted on permanent
failure; transient failures retried 3x with 1s/3s/9s backoff and
err.cause walked for log clarity. Idempotent commit closes the
2026-05-29 false-negative bug at the protocol level."
```

---

## Task 9: Hybrid HANA test for end-to-end chunked publish

This test exercises the full begin/append/commit flow against real HANA via `cds bind --exec`. Gated by `ALLOW_HYBRID_WRITES=true` per the existing `test/hybrid/_guard.js`.

**Files:**
- Create: `test/hybrid/content-publish-chunked.test.js`

- [ ] **Step 1: Create the hybrid test**

Create `test/hybrid/content-publish-chunked.test.js`:

```js
import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';
const PREFIX = '__TEST__chunked-';

describe('content publish chunked — HANA', () => {
  let helpers;

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
    }
    await cds.connect.to('db');
    helpers = createSessionHelpers({ namespace: NS });
  });

  afterAll(async () => {
    const { ContentFiles, ContentManifest } = cds.entities(NS);
    const stale = await SELECT.from(ContentManifest).where`status = 'PUBLISHING' or status = 'FAILED'`;
    if (stale.length) {
      await DELETE.from(ContentFiles).where({ version: { in: stale.map(r => r.version) } });
      await DELETE.from(ContentManifest).where({ version: { in: stale.map(r => r.version) } });
    }
    // Also clean any test slugs that leaked into ACTIVE during a failed test.
    await DELETE.from(ContentFiles).where({ slug: { like: `${PREFIX}%` } });
  });

  it('runs begin → 3 parallel appends → commit and produces an ACTIVE manifest', async () => {
    const { ContentFiles, ContentManifest } = cds.entities(NS);

    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-test', hugoVersion: 'test', expectedSlugCount: 9
    });

    const html = (slug) => `<html><body><main class="tutorial-main">${slug}</main></body></html>`;
    const buildBatch = (slugs) => ({
      sessionId: begin.sessionId,
      files: Object.fromEntries(slugs.map(s => [s, gzipSync(Buffer.from(html(s))).toString('base64')])),
      metadata: {}, bodyTexts: {},
    });

    const slugBatches = [
      [`${PREFIX}a1`, `${PREFIX}a2`, `${PREFIX}a3`],
      [`${PREFIX}b1`, `${PREFIX}b2`, `${PREFIX}b3`],
      [`${PREFIX}c1`, `${PREFIX}c2`, `${PREFIX}c3`],
    ];

    await Promise.all(slugBatches.map(b => helpers.appendToSession(buildBatch(b))));

    const result = await helpers.commitSession({ sessionId: begin.sessionId });
    expect(result.version).toBe(begin.version);

    const manifest = await SELECT.one.from(ContentManifest).where({ version: begin.version });
    expect(manifest.status).toBe('ACTIVE');

    const writtenCount = await SELECT.one.from(ContentFiles)
      .columns('count(*) as c')
      .where({ version: begin.version, slug: { like: `${PREFIX}%` } });
    expect(writtenCount.c).toBe(9);
  });

  it('abort marks the manifest FAILED and releases the lock', async () => {
    const { ContentManifest } = cds.entities(NS);

    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-abort', hugoVersion: 'test', expectedSlugCount: 0
    });
    await helpers.abortSession({ sessionId: begin.sessionId, reason: 'hybrid-test' });

    const row = await SELECT.one.from(ContentManifest).where({ version: begin.version });
    expect(row.status).toBe('FAILED');

    // Lock is free → another begin works.
    const next = await helpers.beginPublishSession({
      trigger: 'hybrid-after-abort', hugoVersion: 'test', expectedSlugCount: 0
    });
    expect(next.sessionId).not.toBe(begin.sessionId);
    await helpers.abortSession({ sessionId: next.sessionId, reason: 'cleanup' });
  });

  it('idempotent commit returns alreadyActive=true on second call', async () => {
    const begin = await helpers.beginPublishSession({
      trigger: 'hybrid-idempotent', hugoVersion: 'test', expectedSlugCount: 0
    });
    const first = await helpers.commitSession({ sessionId: begin.sessionId });
    const second = await helpers.commitSession({ sessionId: begin.sessionId });
    expect(first.version).toBe(second.version);
    expect(second.alreadyActive).toBe(true);
  });
});
```

- [ ] **Step 2: Run the hybrid test**

Run (requires `cf login` to DEV space and a recent `npm run bind:setup`):

```bash
ALLOW_HYBRID_WRITES=true npx cds bind --exec -- npx vitest run --project=hybrid test/hybrid/content-publish-chunked.test.js
```

Expected: PASS for all three test cases.

- [ ] **Step 3: Commit**

```bash
git add test/hybrid/content-publish-chunked.test.js
git commit -m "test(content-publish): hybrid HANA test for chunked publish flow

Covers: begin → 3 parallel appends → commit produces an ACTIVE
manifest with 9 ContentFiles rows; abort marks FAILED and releases
the lock so a fresh begin succeeds; idempotent commit returns
alreadyActive=true on repeat. Test slugs prefixed __TEST__ and
cleaned up in afterAll."
```

---

## Task 10: Documentation updates and obsolete-memory deletion

**Files:**
- Modify: `docs/developers/operations/testing-endpoints.md` (add new endpoints, mark legacy deprecated)
- Modify: `CLAUDE.md` (Content Publishing section — drop the `--force` recommendation, document new flags)
- Delete: `~/.claude/projects/d--projects-tutorials-poc/memory/feedback_publish_content_force.md`
- Modify: `~/.claude/projects/d--projects-tutorials-poc/memory/MEMORY.md` (remove the line for the deleted memory)
- Modify: `~/.claude/projects/d--projects-tutorials-poc/memory/project_publish_content_hardening_followup.md` (mark DONE, point at PR)

- [ ] **Step 1: Document new endpoints in testing-endpoints.md**

Open `docs/developers/operations/testing-endpoints.md`. Find the section that lists `POST /content/publish` and add right after it:

```markdown
### POST /content/publish/begin

Bearer auth (`CONTENT_API_KEY`). Allocates a new manifest version and returns
a `sessionId` for use with `/append` and `/commit`. Returns 409 if another
publish is in progress.

```bash
curl -X POST http://localhost:4004/content/publish/begin \
  -H "Authorization: Bearer $CONTENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"trigger":"manual","hugoVersion":"v1","expectedSlugCount":1398}'
```

Response: `201 { sessionId, version, expiresAt }`.

### POST /content/publish/append

Persists a batch of slugs against the open session. Idempotent for a
given `(sessionId, slug)` tuple. The `files` shape is `{ slug: base64gzip }`
identical to the legacy single-shot endpoint.

### POST /content/publish/commit

Carry-forward + ACTIVE flip. **Idempotent** — a repeat call against an
already-ACTIVE manifest returns the same activation result with
`alreadyActive: true`.

### POST /content/publish/abort

Marks the session's manifest FAILED and releases the publish lock. Idempotent.

### POST /content/publish (deprecated)

Legacy single-shot. Still supported for one release cycle; emits a
deprecation warning. Clients should migrate to the begin/append/commit
flow.
```

- [ ] **Step 2: Update CLAUDE.md Content Publishing section**

In `CLAUDE.md`, find the `### Content Publishing` heading and replace its body with:

```markdown
After Hugo builds, publish tutorial HTML to HANA via the chunked publish
protocol (begin/append/commit):

```bash
# Set the API key
export CONTENT_API_KEY="tutorials-content-publish-2024"

# Standard publish (delta — only changed slugs)
CAP_BASE_URL="https://tutorial-system-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com" npm run publish-content

# Verify the deployed server matches local (read-only)
CAP_BASE_URL=... npm run publish-content -- --verify-only

# Publish only the slugs that differ on the server (heal mode)
CAP_BASE_URL=... npm run publish-content -- --heal

# Force-publish everything (skips delta check; same correctness as default)
CAP_BASE_URL=... npm run publish-content -- --force
```

Flags:
- `--verify-only` exits 0 on full match, 2 on mismatch.
- `--heal` publishes only the diff. Mutex with `--force` and `--verify-only`.
- `--concurrency N` (default 6) and `--batch-size N` (default 50) tune
  parallelism. Default values target ~90s wall-clock for a full 1398-slug publish.

If `CONTENT_API_KEY` is not set on the deployed srv app:

```bash
cf set-env tutorials-srv CONTENT_API_KEY "tutorials-content-publish-2024"
cf restart tutorials-srv
```
```

In the same file, find the `**`publish-content.ts` delta detection**` Gotcha bullet and replace it with:

```markdown
- **`publish-content.ts` chunked publish** — uses begin/append/commit
  protocol. Default delta mode is correctness-equivalent to `--force` (the
  server's commit step does carry-forward of unchanged slugs). `--force` is
  now purely a performance/CI-convenience flag. Auto-verifies via
  `/content/hashes` after every successful commit; exits 2 on mismatch.
```

- [ ] **Step 3: Delete the obsolete memory and update MEMORY.md**

```bash
rm "C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback_publish_content_force.md"
```

Edit `C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/MEMORY.md`. Find and delete the line:

```
- [publish-content needs --force](feedback_publish_content_force.md) — Default delta mode breaks production: server treats publish as full snapshot, only-changed-slugs payload drops the rest. Always run with --force.
```

- [ ] **Step 4: Update the followup memory**

Edit `C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/project_publish_content_hardening_followup.md`. Change the `description:` and prepend a DONE marker to the body:

```markdown
---
name: publish-content-hardening-followup
description: "DONE — chunked publish protocol shipped (begin/append/commit) with auto-verify; --force is now perf-only"
metadata:
  node_type: memory
  type: project
  originSessionId: 86089d7d-46d6-4a06-b7c5-1981ba5fbff4
---

**DONE 2026-05-29** — chunked publish protocol shipped via PR (TODO: fill in PR
number after merge). Spec at `docs/superpowers/specs/2026-05-29-publish-content-hardening-design.md`.
The 2026-05-29 false-negative bug is closed at the protocol level: idempotent
commit + auto-verify-after-publish + per-batch retry with err.cause logging.
`feedback_publish_content_force.md` deleted as obsolete.

---

(Original notes preserved below for posterity.)
```

Then keep the original body content below as-is.

Also update the corresponding line in `MEMORY.md`:

```
- [Publish-content Hardening TODO](project_publish_content_hardening_followup.md) — DONE 2026-05-29; chunked protocol + auto-verify shipped, [[feedback-publish-content-force]] deleted.
```

- [ ] **Step 5: Commit**

```bash
git add docs/developers/operations/testing-endpoints.md CLAUDE.md
git commit -m "docs(content-publish): document chunked publish protocol

- New endpoints (begin/append/commit/abort) with curl examples
- Mark legacy /content/publish deprecated for one release cycle
- Update CLAUDE.md publish recipes; --force becomes perf-only
- Update Gotcha block to describe new auto-verify behavior"
```

Memory updates are not committed (memory lives outside the repo).

- [ ] **Step 6: Final verification — full unit run**

```bash
npm test
```

Expected: All unit tests pass. New tests added: publish-retry, publish-batcher, publish-client, publish-content-cli, content-publish-session, content-publish-routes, cleanup (extended).

- [ ] **Step 7: Final verification — hybrid run (optional, requires cf login)**

```bash
ALLOW_HYBRID_WRITES=true npm run test:hybrid
```

Expected: Existing hybrid tests pass + new content-publish-chunked test passes.

- [ ] **Step 8: Push the branch and open a PR**

```bash
git push -u origin harden/publish-content-chunked

# Write the PR body to a temp file. On Windows Git Bash, nested heredocs inside
# `"$(...)"` substitution can mangle newlines — using --body-file is more robust.
cat > /tmp/pr-body.md <<'EOF'
Closes the 2026-05-29 false-negative deploy bug. Replaces the single-shot
53MB POST with begin/append/commit chunking, parallel appends, per-batch
retry, and post-publish auto-verification.

Spec: docs/superpowers/specs/2026-05-29-publish-content-hardening-design.md
Plan: docs/superpowers/plans/2026-05-29-publish-content-hardening.md

## What changes

- 4 new endpoints: /content/publish/{begin,append,commit,abort}
- Client batches at 50 slugs × 6-way parallelism (~90s wall-clock for full publish)
- Per-batch retry 3× (1s/3s/9s) with err.cause walking
- Idempotent commit + auto-verify after every publish — closes the false-negative at the protocol level
- New flags: --verify-only, --heal, --concurrency, --batch-size
- GC reaper tightened to 5-min cadence, 30-min threshold (chunked) / 60-min (legacy)
- Legacy /content/publish frozen-deprecated for one release cycle

## Tests

- Unit: 6 new test files covering retry, batcher, client, CLI, server session helpers, routes
- Hybrid: full begin/append/commit + abort + idempotent commit on real HANA
- Manual: see plan §10 step 6/7
EOF

gh pr create --base main \
  --title "feat(content-publish): chunked publish protocol with auto-verify" \
  --body-file /tmp/pr-body.md
```

---

## Notes for the executor

- **Branch already exists** (`harden/publish-content-chunked`). Tasks 2-10 commit incrementally to that branch; Task 1's commit is already a clean prep step.
- **TDD discipline:** every code task starts with a failing test. If the failure mode does not match the expected message, stop and investigate before writing implementation. A test that fails for the wrong reason gives you no signal.
- **YAGNI:** resist any urge to add features not in the spec (Section "Non-Goals" lists what is intentionally excluded — cross-invocation resume, HTTP/2, webhooks, streaming).
- **DRY:** the metadata + body-text upsert helpers in Task 2b should be lifted **verbatim** from the existing `publishHandler`. Do not rewrite the recompute-progress and TutorialMeta logic; it has subtle edge cases that took prior PRs to get right.
- **Frequent commits:** commit after every passing test, not just at task boundaries. The plan's commit steps are minimums.
- **Subagent dispatch (recommended):** consider invoking `superpowers:subagent-driven-development` to run each task in a fresh context window — the file count and test surface area is large enough that one-shot execution risks dropping detail.
