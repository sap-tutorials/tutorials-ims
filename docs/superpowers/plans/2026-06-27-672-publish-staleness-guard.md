# #672 Publish staleness guard — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent a stale workstation `npm run publish-content` from silently regressing live tutorial content, optimize the common case for the next publisher, and make every publish attributable to a person or CI run.

**Architecture:** Three layers — (1) authoritative server-side no-revert guard in `commitPublishSession`; (2) optimization-only client short-circuit in `publish-content.ts` delta mode; (3) `ContentManifest.initiator + PipelineLog.initiator` attribution column populated by every publish. See [docs/superpowers/specs/2026-06-27-672-publish-staleness-guard-design.md](../specs/2026-06-27-672-publish-staleness-guard-design.md).

**Tech Stack:** SAP CAP (Node.js), HANA Cloud, SQLite (unit tests), Vitest, TypeScript (client).

**Branch / worktree:** `worktree-672-publish-staleness-guard` at `D:/projects/tutorials-poc/.claude/worktrees/672-publish-staleness-guard/`. Spec already committed at `76158672` + `a7e8b57a`.

**Commits planned:** 3 commits, 1 PR.

| Commit | Tasks | Touches |
|---|---|---|
| 1: server guard + schema + attribution | 1–4 | `db/_content-shape.cds`, `srv/lib/content-publish-session.js`, `test/unit/content-publish-guard.test.js` |
| 2: client + CI + hybrid test | 5–6 | `scripts/publish-content.ts`, `scripts/lib/publish-client.ts`, `.github/workflows/rebuild-content*.yml`, `test/hybrid/content-publish-guard.test.js` |
| 3: docs | 7 | `CLAUDE.md`, `docs/developers/operations/rebuild-content-workflow.md` |

---

## Task 1: Add `initiator` column to ContentManifestAspect

Schema-only. Additive nullable column; HANA HDI emits `ALTER TABLE ADD COLUMN initiator NVARCHAR(255)`, which is idempotent. The QA schema reuses the same aspect, so it propagates automatically.

**Files:**
- Modify: `db/_content-shape.cds:44-57`

- [ ] **Step 1: Add the `initiator` column**

Edit [db/_content-shape.cds](../../../db/_content-shape.cds:44-57) to insert a single line after the `trigger` field. The exact edit:

Replace:
```cds
aspect ContentManifestAspect : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; FAILED; };
  trigger                   : String(500);
  fileCount                 : Integer;
```

With:
```cds
aspect ContentManifestAspect : managed {
  key version               : Integer;
  status                    : String(20) enum { PUBLISHING; ACTIVE; SUPERSEDED; ROLLED_BACK; FAILED; };
  trigger                   : String(500);
  // #672 — who initiated this publish. Format: "<user>@<hostname>" for
  // workstation publishes; "ci/<run_id>" for CI. NULL on rows created before
  // PR #680 lands.
  initiator                 : String(255);
  fileCount                 : Integer;
```

- [ ] **Step 2: Verify the model still compiles**

Run: `npx cds compile srv --to csn > /dev/null`
Expected: exit code 0, no stderr.

If it errors with a parse error, the indentation is off — copy the block verbatim.

- [ ] **Step 3: Verify CSN includes the new field**

Run: `npx cds compile srv --to csn 2>/dev/null | node -e 'const j = JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(Object.keys(j.definitions["com.sap.developers.ims.ContentManifest"].elements).filter(k => k === "initiator"))'`
Expected: `[ 'initiator' ]`.

- [ ] **Step 4: Commit (no commit yet — bundle with Task 4)**

Don't commit yet. Tasks 1–4 land as one commit ("Commit 1") because Task 2 depends on this column existing.

---

## Task 2: Persist `initiator` from `beginPublishSession`

`beginPublishSession` already accepts an `initiator` arg ([srv/lib/content-publish-session.js:24](../../../srv/lib/content-publish-session.js#L24)) and forwards it to `logPipelineStart` ([line 56](../../../srv/lib/content-publish-session.js#L56)). What's missing is writing it to the `ContentManifest` INSERT block ([line 37–47](../../../srv/lib/content-publish-session.js#L37-L47)). TDD this against the existing unit-test harness in `test/unit/content-publish-pipeline-log.test.js`.

**Files:**
- Create: `test/unit/content-publish-guard.test.js`
- Modify: `srv/lib/content-publish-session.js:37-47`

- [ ] **Step 1: Write a failing test for `initiator` ending up on `ContentManifest`**

Create [test/unit/content-publish-guard.test.js](../../../test/unit/content-publish-guard.test.js) with this content:

```javascript
// test/unit/content-publish-guard.test.js
// #672 — Publish staleness guard: SQLite unit tests.
//
// 1. initiator round-trips to ContentManifest + PipelineLog symmetrically.
// 2. detectReverts catches when an incoming sourceHash matches a superseded version.
// 3. Legitimate flap A → B → A is rejected; subsequent C is accepted normally.
// 4. Novel content is accepted (no false positives).
// 5. Slugs with null sourceHash are skipped (pre-PR#591 rows must not false-positive).
//
// These tests run against the in-memory SQLite path. The hybrid sibling at
// test/hybrid/content-publish-guard.test.js exercises the same guard against
// real HANA.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}

function source(s) {
  // Each unique input string produces a distinct sourceHash.
  return gzipSync(Buffer.from(s, 'utf-8')).toString('base64');
}

function sha256(s) {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

describe('#672 publish staleness guard', () => {
  let helpers;
  let ContentFiles, ContentManifest, PipelineLog, JobLocks;

  beforeAll(() => {
    helpers = createSessionHelpers({ namespace: NS });
    ({ ContentFiles, ContentManifest, PipelineLog, JobLocks } = cds.entities(NS));
  });

  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  it('writes initiator to ContentManifest and PipelineLog symmetrically', async () => {
    const { sessionId, version } = await helpers.beginPublishSession({
      trigger: 'unit-test',
      hugoVersion: '0.147.0',
      expectedSlugCount: 0,
      initiator: 'bob@laptop',
    });

    const manifest = await SELECT.one.from(ContentManifest).where({ version });
    expect(manifest.initiator, 'ContentManifest.initiator should be set').toBe('bob@laptop');

    const logRow = await SELECT.one.from(PipelineLog).where({ ID: sessionId });
    expect(logRow.initiator, 'PipelineLog.initiator should be set').toBe('bob@laptop');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run test/unit/content-publish-guard.test.js -t 'writes initiator'`
Expected: FAIL — assertion `ContentManifest.initiator should be set` fails because the column is set but never written to. (The exact failure message will be `expected null to be 'bob@laptop'` or `expected undefined to be 'bob@laptop'`.)

If the test errors with "column 'initiator' does not exist" instead, Task 1 wasn't completed — go back and add the column.

- [ ] **Step 3: Implement — write `initiator` to the INSERT block**

Modify [srv/lib/content-publish-session.js:37-47](../../../srv/lib/content-publish-session.js#L37-L47). Replace:

```javascript
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
```

With:

```javascript
      await INSERT.into(ContentManifest).entries({
        version,
        status: 'PUBLISHING',
        sessionId,
        trigger: (trigger || 'unknown').slice(0, 500),
        // #672 — clients pass initiator via x-initiator header; beginHandler
        // forwards it as the `initiator` arg. Falls back to 'publish-script'
        // when absent (legacy single-shot publishHandler still uses that).
        initiator: (initiator || 'publish-script').slice(0, 255),
        fileCount: 0,
        totalSizeBytes: 0,
        changedSlugs: JSON.stringify([]),
        hugoVersion: hugoVersion || null,
        lastAppendAt: new Date().toISOString()
      });
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run test/unit/content-publish-guard.test.js -t 'writes initiator'`
Expected: PASS, 1 test.

- [ ] **Step 5: Run the existing pipeline-log test to ensure no regression**

Run: `npx vitest run test/unit/content-publish-pipeline-log.test.js`
Expected: all tests in that file still pass.

---

## Task 3: Implement the no-revert guard in `commitSession`

Insert the guard between the existing `freshSlugs` capture ([line 225](../../../srv/lib/content-publish-session.js#L225)) and the `carryForwardUnchanged` call ([line 230](../../../srv/lib/content-publish-session.js#L230)). The guard is a new local helper `detectReverts(namespace, newVersion, freshSlugs)` that returns the slug list to reject. Rejected slugs are DELETEd from the in-flight version — `carryForwardUnchanged` then naturally picks up the current ACTIVE row, preserving content.

TDD this thoroughly because it's the actual safety-critical code.

**Files:**
- Modify: `srv/lib/content-publish-session.js:191-230` (function body)
- Modify: `test/unit/content-publish-guard.test.js` (append new cases)

- [ ] **Step 1: Write 4 failing tests for the guard behavior**

Append to [test/unit/content-publish-guard.test.js](../../../test/unit/content-publish-guard.test.js) inside the `describe` block, after the initiator test:

```javascript
  // Helper: run a complete begin/append/commit cycle for one slug with a
  // specific source hash. Returns the commit result.
  async function publishOne(slug, label) {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'unit-test', hugoVersion: '0.147.0', expectedSlugCount: 1,
      initiator: 'unit-test',
    });
    await helpers.appendToSession({
      sessionId,
      files: { [slug]: html(label) },
      sources: { [slug]: source(label) },
    });
    return helpers.commitSession({ sessionId });
  }

  it('rejects a revert when incoming sourceHash matches a superseded version', async () => {
    // v1: hash A. v2: hash B (active). v3: hash A (should be rejected).
    await publishOne('drift-slug', 'A');
    await publishOne('drift-slug', 'B');
    const v3 = await publishOne('drift-slug', 'A');

    expect(v3.rejectedReverts).toEqual(['drift-slug']);

    // The ACTIVE row for the slug should still be v2's content (hash B).
    const active = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    const row = await SELECT.one.from(ContentFiles).where({ slug: 'drift-slug', version: active.version });
    expect(row.sourceHash).toBe(sha256('B'));
  });

  it('allows legitimate flap A → B → A → C (current upstream IS A)', async () => {
    await publishOne('flap-slug', 'A');
    await publishOne('flap-slug', 'B');
    const v3 = await publishOne('flap-slug', 'A');
    expect(v3.rejectedReverts).toContain('flap-slug');
    // The next publish moves forward to C — this must NOT be blocked,
    // even though it follows a rejected revert.
    const v4 = await publishOne('flap-slug', 'C');
    expect(v4.rejectedReverts).toEqual([]);

    const active = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    const row = await SELECT.one.from(ContentFiles).where({ slug: 'flap-slug', version: active.version });
    expect(row.sourceHash).toBe(sha256('C'));
  });

  it('allows novel content (no false positives)', async () => {
    const v1 = await publishOne('novel-slug', 'A');
    expect(v1.rejectedReverts).toEqual([]);
    const v2 = await publishOne('novel-slug', 'B');
    expect(v2.rejectedReverts).toEqual([]);
  });

  it('ignores slugs with null sourceHash (pre-PR#591 rows)', async () => {
    // Publish without `sources` — sourceHash will be null on the row.
    const { sessionId: s1 } = await helpers.beginPublishSession({
      trigger: 'unit-test', hugoVersion: '0.147.0', expectedSlugCount: 1, initiator: 'unit-test',
    });
    await helpers.appendToSession({ sessionId: s1, files: { 'legacy-slug': html('A') } });
    await helpers.commitSession({ sessionId: s1 });

    const { sessionId: s2 } = await helpers.beginPublishSession({
      trigger: 'unit-test', hugoVersion: '0.147.0', expectedSlugCount: 1, initiator: 'unit-test',
    });
    await helpers.appendToSession({ sessionId: s2, files: { 'legacy-slug': html('B') } });
    const result = await helpers.commitSession({ sessionId: s2 });
    // No source hashes anywhere → guard can't act → no rejections.
    expect(result.rejectedReverts).toEqual([]);
  });
```

- [ ] **Step 2: Run the new tests to verify they fail**

Run: `npx vitest run test/unit/content-publish-guard.test.js -t 'rejects a revert'`
Expected: FAIL — `result.rejectedReverts` is undefined (field doesn't exist yet) OR the revert actually lands because there's no guard.

Run: `npx vitest run test/unit/content-publish-guard.test.js`
Expected: 4 failures, 1 pass (the Task-2 initiator test still passes).

- [ ] **Step 3: Implement the `detectReverts` helper**

Add a new function inside the `createSessionHelpers` closure in [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js), placed right before `commitSession` (around line 191):

```javascript
  /**
   * #672 no-revert guard. For each slug freshly written in `newVersion`, check
   * whether its sourceHash matches an *abandoned* hash from history — i.e. a
   * hash older than the most recent prior hash that differs from the incoming
   * one. If yes, the publish is trying to roll back content the server has
   * since moved past, so we reject the slug (caller DELETEs it from this
   * version; carryForwardUnchanged then re-pulls the current ACTIVE row).
   *
   * Legitimate flap `A → B → A` is permitted: when the *current upstream* IS
   * A and the most-recent-prior-differing hash is B, A does NOT appear in
   * "older than B" history → not a revert.
   *
   * Slugs without a sourceHash (pre-PR#591 legacy rows or special slugs like
   * __shell__/__nav__/__404__) are skipped — nothing to compare against.
   *
   * Two SQL round-trips total (not per-slug). Runs inside the publish lock.
   *
   * @returns {Promise<string[]>} slugs to reject (carry-forward instead of commit)
   */
  async function detectReverts(newVersion, freshSlugs) {
    if (!freshSlugs.length) return [];
    const { ContentFiles } = cds.entities(namespace);

    // 1. Incoming hashes for this version (only slugs that have a sourceHash
    //    — null-sourceHash rows can't be checked).
    const incoming = await SELECT.from(ContentFiles)
      .columns('slug', 'sourceHash')
      .where({ version: newVersion, slug: { in: freshSlugs } })
      .and({ sourceHash: { '!=': null } });
    if (!incoming.length) return [];

    const incomingMap = new Map(incoming.map((r) => [r.slug, r.sourceHash]));
    const slugsWithSrc = [...incomingMap.keys()];

    // 2. All prior versions of those slugs (newest-first).
    const priors = await SELECT.from(ContentFiles)
      .columns('slug', 'sourceHash', 'version')
      .where({ slug: { in: slugsWithSrc } })
      .and({ version: { '<': newVersion } })
      .and({ sourceHash: { '!=': null } })
      .orderBy({ slug: 'asc', version: 'desc' });

    // 3. Per slug, walk newest-first: find V_div (most recent prior hash that
    //    differs from incoming). If incoming appears in any version older
    //    than V_div, it's a revert.
    const bySlug = new Map();
    for (const r of priors) {
      if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
      bySlug.get(r.slug).push(r);
    }

    const rejected = [];
    for (const slug of slugsWithSrc) {
      const incomingHash = incomingMap.get(slug);
      const history = bySlug.get(slug) || [];
      // Find V_div index — the first entry whose hash differs from incoming.
      let divIdx = -1;
      for (let i = 0; i < history.length; i++) {
        if (history[i].sourceHash !== incomingHash) { divIdx = i; break; }
      }
      if (divIdx === -1) continue; // every prior hash equals incoming — re-publish of unchanged content, not a revert
      // Anything strictly older than V_div is "abandoned history". If
      // incoming matches any of those, it's a revert.
      for (let i = divIdx + 1; i < history.length; i++) {
        if (history[i].sourceHash === incomingHash) {
          rejected.push(slug);
          break;
        }
      }
    }
    return rejected;
  }
```

- [ ] **Step 4: Wire the guard into `commitSession`**

Modify [srv/lib/content-publish-session.js:221-230](../../../srv/lib/content-publish-session.js#L221-L230). Replace:

```javascript
    // Capture the set of slugs freshly written by /append BEFORE carry-forward
    // runs (carry-forward INSERTs more rows for this version, which would
    // otherwise inflate the "fresh" set used for embedding triggering).
    const { ContentFiles } = cds.entities(namespace);
    const freshRows = await SELECT.from(ContentFiles)
      .columns('slug')
      .where({ version: newVersion });
    const freshSlugs = freshRows.map((r) => r.slug);

    // Carry forward unchanged slugs from the previously-ACTIVE manifest.
    // This logic is lifted verbatim from the legacy publishHandler at
    // srv/lib/content-store.js:320-378 so prod/SQLite parity is preserved.
    const { carriedForward, carriedSize } = await carryForwardUnchanged(namespace, newVersion, hanaTableName, getActiveVersion);
```

With:

```javascript
    // Capture the set of slugs freshly written by /append BEFORE carry-forward
    // runs (carry-forward INSERTs more rows for this version, which would
    // otherwise inflate the "fresh" set used for embedding triggering).
    const { ContentFiles } = cds.entities(namespace);
    const freshRows = await SELECT.from(ContentFiles)
      .columns('slug')
      .where({ version: newVersion });
    let freshSlugs = freshRows.map((r) => r.slug);

    // #672 — no-revert guard. Detect slugs whose incoming sourceHash matches a
    // previously-superseded version (i.e. the publish would roll back content
    // the server has moved past). DELETE rejected slugs from the in-flight
    // version; carryForwardUnchanged below then re-pulls the current ACTIVE
    // row for them, so the result is "we silently kept the existing content."
    const rejectedReverts = await detectReverts(newVersion, freshSlugs);
    if (rejectedReverts.length) {
      LOG.warn(`[content/publish/commit] #672 rejecting ${rejectedReverts.length} revert(s): ${rejectedReverts.join(', ')}`);
      await DELETE.from(ContentFiles).where({ version: newVersion, slug: { in: rejectedReverts } });
      const rejectedSet = new Set(rejectedReverts);
      freshSlugs = freshSlugs.filter((s) => !rejectedSet.has(s));
    }

    // Carry forward unchanged slugs from the previously-ACTIVE manifest.
    // This logic is lifted verbatim from the legacy publishHandler at
    // srv/lib/content-store.js:320-378 so prod/SQLite parity is preserved.
    const { carriedForward, carriedSize } = await carryForwardUnchanged(namespace, newVersion, hanaTableName, getActiveVersion);
```

- [ ] **Step 5: Run the guard tests to verify they pass**

Run: `npx vitest run test/unit/content-publish-guard.test.js`
Expected: all 5 tests pass (1 initiator + 4 guard cases).

If `rejects a revert` still fails because `result.rejectedReverts` is undefined, the response field hasn't been added yet — that's Task 4. Comment out the `expect(v3.rejectedReverts)` assertions temporarily by changing them to `expect((v3.rejectedReverts || [])`, run again, confirm the actual behavior (ACTIVE row retains hash B) passes, then revert the temporary edits and continue to Task 4.

- [ ] **Step 6: Run the full unit test suite to catch any regression**

Run: `npm test -- --reporter=dot 2>&1 | tail -30`
Expected: no failures introduced by this change. Pre-existing failures (the "check-* tests pool flake on Windows" issue, per memory) are not blockers.

---

## Task 4: Thread `rejectedReverts` through the commit response and PipelineLog

Surface the rejected list in the commit response body, the `summary` text, and `PipelineLog.metadata` so operators can see what was dropped without grepping CF logs.

**Files:**
- Modify: `srv/lib/content-publish-session.js` (commitSession return + summary + logPipelineEnd)
- Modify: `scripts/lib/publish-client.ts:23-26` (CommitResult shape)
- Test: existing tests in `test/unit/content-publish-guard.test.js` (uncomment if temporarily disabled in Task 3, Step 5)

- [ ] **Step 1: Add `rejectedReverts` to the commit response and summary**

In [srv/lib/content-publish-session.js](../../../srv/lib/content-publish-session.js) `commitSession`, modify the closing return block and the summary message. Find the existing block (around line 282–301):

```javascript
    try {
      const summary = `Published v${newVersion}: ${freshCount} new + ${carriedForward} carried = ${freshCount + carriedForward} slugs in ${durationMs}ms`;
      await logPipelineEnd(
        sessionId,
        'SUCCESS',
        summary,
        null,
        namespace
      );
    } catch (logErr) {
      LOG.warn(`[content/publish/commit] PipelineLog end failed (non-fatal): ${logErr.message}`);
    }

    return {
      version: newVersion,
      fileCount: freshCount + carriedForward,
      totalSizeBytes: freshSize + carriedSize,
      durationMs,
      carriedForward,
      alreadyActive: false
    };
```

Replace with:

```javascript
    try {
      const revertSuffix = rejectedReverts.length ? ` (${rejectedReverts.length} revert${rejectedReverts.length === 1 ? '' : 's'} rejected)` : '';
      const summary = `Published v${newVersion}: ${freshCount} new + ${carriedForward} carried = ${freshCount + carriedForward} slugs in ${durationMs}ms${revertSuffix}`;
      // PipelineLog.metadata is LargeString JSON — attach the rejected slug
      // list so admin Pipeline Log Object Page surfaces it under Metadata.
      const logMetadata = rejectedReverts.length ? { rejectedReverts } : null;
      await logPipelineEnd(
        sessionId,
        'SUCCESS',
        summary,
        logMetadata,
        namespace
      );
    } catch (logErr) {
      LOG.warn(`[content/publish/commit] PipelineLog end failed (non-fatal): ${logErr.message}`);
    }

    return {
      version: newVersion,
      fileCount: freshCount + carriedForward,
      totalSizeBytes: freshSize + carriedSize,
      durationMs,
      carriedForward,
      // #672 — empty array (not omitted) so clients can rely on the field
      // being present in every commit response.
      rejectedReverts,
      alreadyActive: false
    };
```

- [ ] **Step 2: Check `logPipelineEnd`'s 4th argument shape**

The 4th positional arg to `logPipelineEnd` is `errorDetails` in some signatures. Verify by reading [srv/lib/pipeline-log.js](../../../srv/lib/pipeline-log.js). If the 4th arg is `errorDetails` and metadata is a separate arg, adapt the call accordingly. Look for the function signature: `export function logPipelineEnd(id, status, summary, ???, namespace)`.

Run: `grep -n "export function logPipelineEnd\|export async function logPipelineEnd" srv/lib/pipeline-log.js`

If the 4th arg is named `metadata`, the call above is correct. If it's named `errorDetails` (and metadata is appended differently — e.g. a 6th arg, or via a separate `UPDATE`), adjust the code to attach `{ rejectedReverts }` via whatever mechanism that file uses. Update the test below accordingly.

- [ ] **Step 3: Update the CommitResult TypeScript interface**

Modify [scripts/lib/publish-client.ts:23-26](../../../scripts/lib/publish-client.ts#L23-L26). Replace:

```typescript
export interface CommitResult {
  version: number; fileCount: number; totalSizeBytes: number;
  durationMs: number; alreadyActive: boolean;
}
```

With:

```typescript
export interface CommitResult {
  version: number; fileCount: number; totalSizeBytes: number;
  durationMs: number; alreadyActive: boolean;
  /** #672 — slugs whose incoming sourceHash matched a superseded version
   * and were carry-forwarded instead of committed. Always present, often `[]`. */
  rejectedReverts: string[];
  /** Carry-forward count from the prior ACTIVE manifest (existing field, now declared). */
  carriedForward?: number;
}
```

- [ ] **Step 4: Add a test for the response/summary/metadata threading**

Append to `test/unit/content-publish-guard.test.js`:

```javascript
  it('threads rejectedReverts through commit response, summary, and PipelineLog metadata', async () => {
    await publishOne('thread-slug', 'A');
    await publishOne('thread-slug', 'B');
    const v3SessionResult = await publishOne('thread-slug', 'A');

    // Commit response field
    expect(v3SessionResult.rejectedReverts).toEqual(['thread-slug']);

    // PipelineLog summary suffix + metadata
    const active = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    const log = await SELECT.one.from(PipelineLog).where({ ID: active.sessionId });
    expect(log.summary).toMatch(/\(1 revert rejected\)$/);
    const meta = JSON.parse(log.metadata || '{}');
    // metadata.rejectedReverts populated by logPipelineEnd (Task 4 Step 2 may
    // have you using a different field name; adjust if so).
    expect(meta.rejectedReverts).toEqual(['thread-slug']);
  });
```

- [ ] **Step 5: Run all guard tests**

Run: `npx vitest run test/unit/content-publish-guard.test.js`
Expected: all 6 tests pass.

If the metadata assertion fails because `logPipelineEnd` stores metadata differently than expected, adjust either the call in Step 1 or the assertion in Step 4 to match the actual storage shape. Don't change the SQL — the contract is "rejected slugs are findable somewhere on the PipelineLog row."

- [ ] **Step 6: Run the existing pipeline-log test for regression**

Run: `npx vitest run test/unit/content-publish-pipeline-log.test.js`
Expected: all pre-existing tests still pass. The summary regex in that file is `/^Published v\d+: \d+ new \+ \d+ carried = \d+ slugs in \d+ms$/` — it has no `(N reverts rejected)` suffix because that test never triggers a revert. Should still match.

- [ ] **Step 7: Verify schema-drift-check is still narrowed to JobLocks**

Run: `grep -nE "ENTITIES.*=" scripts/check-qa-schema-drift.ts`
Expected: `const ENTITIES = ['JobLocks'];` (or similar — must NOT include `ContentManifest`). If `ContentManifest` is now in the list, the QA schema (`db-qa/schema.cds`) must be checked to ensure it picks up the new `initiator` field — but since the QA schema reuses `shared.ContentManifestAspect`, this should be automatic.

- [ ] **Step 8: Commit — this is Commit 1 of 3**

```bash
git add db/_content-shape.cds srv/lib/content-publish-session.js scripts/lib/publish-client.ts test/unit/content-publish-guard.test.js
git commit -m "feat(#672): no-revert guard + ContentManifest.initiator

Server side of the publish staleness guard:

- ContentManifestAspect gains an additive nullable 'initiator' column
  (workstation: user@hostname; CI: ci/<run_id>; NULL on pre-PR rows).
- beginPublishSession writes initiator to ContentManifest, symmetric
  with the existing PipelineLog.initiator write.
- commitSession runs detectReverts() between freshSlugs capture and
  carryForwardUnchanged. Reverted slugs are DELETEd from the in-flight
  version; carry-forward then re-pulls the current ACTIVE row.
- 'older than V_div' walk: permits A->B->A flap when current upstream
  IS A; rejects A when the server has moved on to B.
- rejectedReverts threads through the commit response, summary suffix,
  and PipelineLog.metadata.
- 6 unit tests against in-memory SQLite cover revert detection, flap
  permission, novel content, null-sourceHash skip, initiator round-trip,
  and response/metadata threading.

Refs #672"
```

---

## Task 5: Client short-circuit + `--initiator` flag + CI wiring

Add the client-side short-circuit (drop slugs whose local sourceHash matches the server's) and the `--initiator` flag (default `${os.userInfo().username}@${os.hostname()}`). Update the publish-client to send `x-initiator` header. Wire CI workflows to pass `--initiator "ci/$GITHUB_RUN_ID"`.

**Files:**
- Modify: `scripts/publish-content.ts` (parseArgs, main, buildSourcePayload export, short-circuit logic)
- Modify: `scripts/lib/publish-client.ts:1-4, 45-49` (BeginInput + beginSession)
- Modify: `.github/workflows/rebuild-content.yml:307-314`
- Modify: `.github/workflows/rebuild-content-qa.yml:142-146` (or `package.json` `publish-content:qa` script)

- [ ] **Step 1: Refactor `buildSourcePayload` to expose `computeLocalSourceHashes`**

Modify [scripts/publish-content.ts:167-183](../../../scripts/publish-content.ts#L167-L183). Replace:

```typescript
export function buildSourcePayload(
  slugs: string[],
  cacheDir: string
): { sources: Record<string, string>; sourceHashes: Map<string, string> } {
  const sources: Record<string, string> = {};
  const sourceHashes = new Map<string, string>();
  for (const slug of slugs) {
    const mdPath = join(cacheDir, `${slug}.md`);
    if (!existsSync(mdPath)) continue; // No source for this slug — special slugs etc.
    const content = readFileSync(mdPath);
    const hash = createHash('sha256').update(content).digest('hex');
    const compressed = gzipSync(content);
    sources[slug] = compressed.toString('base64');
    sourceHashes.set(slug, hash);
  }
  return { sources, sourceHashes };
}
```

With:

```typescript
/**
 * #672 short-circuit support: compute pre-gzip SHA-256 of each slug's source
 * markdown WITHOUT building the gzip payload. Used in delta mode to drop slugs
 * whose source bytes already match the server, before paying for buildPayload's
 * Hugo-output re-read + gzip.
 *
 * Slugs whose source file is missing (special slugs: __shell__, __nav__, __404__)
 * are silently skipped.
 */
export function computeLocalSourceHashes(
  slugs: string[],
  cacheDir: string
): Map<string, string> {
  const sourceHashes = new Map<string, string>();
  for (const slug of slugs) {
    const mdPath = join(cacheDir, `${slug}.md`);
    if (!existsSync(mdPath)) continue;
    const content = readFileSync(mdPath);
    const hash = createHash('sha256').update(content).digest('hex');
    sourceHashes.set(slug, hash);
  }
  return sourceHashes;
}

export function buildSourcePayload(
  slugs: string[],
  cacheDir: string
): { sources: Record<string, string>; sourceHashes: Map<string, string> } {
  const sources: Record<string, string> = {};
  const sourceHashes = computeLocalSourceHashes(slugs, cacheDir);
  for (const slug of slugs) {
    const mdPath = join(cacheDir, `${slug}.md`);
    if (!existsSync(mdPath)) continue;
    const content = readFileSync(mdPath);
    const compressed = gzipSync(content);
    sources[slug] = compressed.toString('base64');
  }
  return { sources, sourceHashes };
}
```

The split keeps the existing `buildSourcePayload` contract intact (so verify-only, post-commit verification, etc. don't break) while exposing the hash-only helper for the new short-circuit.

- [ ] **Step 2: Add `--initiator` to `PublishOptions` and `parseArgs`**

Modify [scripts/publish-content.ts:391-427](../../../scripts/publish-content.ts#L391-L427). Replace the interface and `parseArgs` body. After `hugoVersion: string;` and before `dryRun: boolean;` add:

```typescript
  initiator: string;
```

In `parseArgs`, after `hugoVersion: get('--hugo-version', ''),` add:

```typescript
    initiator: get(
      '--initiator',
      process.env.INITIATOR
        || `${(require('os').userInfo().username || 'unknown')}@${require('os').hostname()}`
    ),
```

(`require('os')` works fine here even though the file is TS — the `tsx` runtime accepts CJS-style requires; if the file is strict ESM (`import` at top only), use a top-level `import { userInfo, hostname } from 'node:os'` instead and reference them directly.)

- [ ] **Step 3: Wire `initiator` through to the begin call**

Modify [scripts/lib/publish-client.ts:1-5](../../../scripts/lib/publish-client.ts#L1-L5):

```typescript
export interface BeginInput {
  baseUrl: string; apiKey: string;
  trigger: string; hugoVersion: string; expectedSlugCount: number;
  /** #672 — sent as `x-initiator` header; persisted on ContentManifest.initiator and PipelineLog.initiator. */
  initiator?: string;
}
```

Modify [scripts/lib/publish-client.ts:28-43](../../../scripts/lib/publish-client.ts#L28-L43) to accept an optional headers map, then update `beginSession`. Replace `postJson` and `beginSession`:

```typescript
async function postJson<T>(
  url: string,
  apiKey: string,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, ...extraHeaders },
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
  const headers: Record<string, string> = {};
  if (i.initiator) headers['x-initiator'] = i.initiator;
  return postJson(
    `${i.baseUrl}/content/publish/begin`,
    i.apiKey,
    { trigger: i.trigger, hugoVersion: i.hugoVersion, expectedSlugCount: i.expectedSlugCount },
    headers
  );
}
```

Then update the call site in `scripts/publish-content.ts` around line 697:

```typescript
  const begin = await beginSession({
    baseUrl: opts.baseUrl, apiKey: opts.apiKey,
    trigger: opts.trigger, hugoVersion: opts.hugoVersion, expectedSlugCount: targetSlugs.length,
    initiator: opts.initiator,
  });
```

- [ ] **Step 4: Add the short-circuit between local-hash computation and computePublishPlan**

Modify [scripts/publish-content.ts](../../../scripts/publish-content.ts) — find the block starting `log('Computing local hashes...');` (around line 639) through `computePublishPlan(...)` (around line 657). The existing code:

```typescript
  log('Computing local hashes...');
  const localHashes = computeLocalHashes(tutorials);

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
```

Replace with (note the added `cacheDir` resolution earlier — if it already exists higher in `main`, reuse it):

```typescript
  log('Computing local hashes...');
  const localHashes = computeLocalHashes(tutorials);

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

  const planResult = computePublishPlan({ local: localHashes, remote: remoteHashes, mode });
  let targetSlugs = planResult.targetSlugs;

  // #672 — client-side short-circuit. In delta mode only, drop slugs whose
  // local sourceHash matches the server's. A slug whose upstream markdown is
  // byte-identical to what the server already has would be carry-forwarded
  // server-side anyway; skipping the upload saves the round-trip and
  // protects against a stale local cache uploading old bytes on top of
  // newer ones (the #672 regression mode).
  //
  // --force and --heal explicitly skip this layer:
  //   --force: "upload everything regardless of server state"
  //   --heal : "fix slugs the client thinks are in sync"
  if (mode === 'delta' && targetSlugs.length > 0) {
    const cacheDirForHashes = channel === 'qa'
      ? join(process.cwd(), '.tutorial-cache-qa')
      : join(process.cwd(), '.tutorial-cache');
    const localSourceHashes = computeLocalSourceHashes(targetSlugs, cacheDirForHashes);
    let serverSourceHashes: Record<string, string> = {};
    try {
      serverSourceHashes = await fetchRemoteSourceHashes({ baseUrl: opts.baseUrl });
    } catch (err) {
      console.warn(`[publish-content] #672 short-circuit disengaged: cannot reach /content/source-hashes: ${formatErrorChain(err)}`);
    }
    const beforeCount = targetSlugs.length;
    targetSlugs = targetSlugs.filter((slug) => {
      const local = localSourceHashes.get(slug);
      const server = serverSourceHashes[slug];
      // Only short-circuit when both sides have a hash AND they match.
      // Missing local hash (special slugs) or missing server hash (new slug) → keep.
      return !(local && server && local === server);
    });
    const dropped = beforeCount - targetSlugs.length;
    if (dropped > 0) log(`#672 short-circuit: dropped ${dropped} of ${beforeCount} slugs (source hash matches server)`);
  }
```

Also ensure `fetchRemoteSourceHashes` and `computeLocalSourceHashes` are imported at the top of the file. Search for `fetchRemoteHashes` imports — `fetchRemoteSourceHashes` should already be imported nearby (it's used by `--verify-only`).

- [ ] **Step 5: Add a no-op exit when short-circuit drops everything**

Find the existing `if (targetSlugs.length === 0)` block right after `computePublishPlan` (the spec says "around line 658"). Verify it still triggers correctly after the short-circuit drops slugs — should be `if (targetSlugs.length === 0) { console.log('No changes detected. Nothing to publish.'); process.exit(0); }`. No code change needed, just sanity-check that the existing block is positioned after the new short-circuit, not before.

- [ ] **Step 6: Update the CI workflows to pass `--initiator`**

Modify [.github/workflows/rebuild-content.yml:307-314](../../../.github/workflows/rebuild-content.yml#L307-L314). Replace:

```yaml
          npx tsx scripts/publish-content.ts \
            --hugo-dir hugo/public \
            --base-url "${{ steps.srv.outputs.srv_url }}" \
            --trigger "ci/${{ github.event_name }}@${{ github.sha }}" \
            --hugo-version "0.147.7" \
            --concurrency "${{ inputs.publish-concurrency || '4' }}" \
            --batch-size "${{ inputs.publish-batch-size || '25' }}" \
            --verbose
```

With:

```yaml
          npx tsx scripts/publish-content.ts \
            --hugo-dir hugo/public \
            --base-url "${{ steps.srv.outputs.srv_url }}" \
            --trigger "ci/${{ github.event_name }}@${{ github.sha }}" \
            --hugo-version "0.147.7" \
            --initiator "ci/${{ github.run_id }}" \
            --concurrency "${{ inputs.publish-concurrency || '4' }}" \
            --batch-size "${{ inputs.publish-batch-size || '25' }}" \
            --verbose
```

- [ ] **Step 7: Update the QA workflow / npm script**

The QA workflow calls `npm run publish-content:qa`, which expands to `tsx scripts/publish-content.ts --channel qa`. Modify [package.json](../../../package.json) to pass an environment-derived initiator. Replace:

```json
"publish-content:qa": "tsx scripts/publish-content.ts --channel qa",
```

The cleanest change is to keep the package script as-is and pass `--initiator` from the workflow YAML. Modify [.github/workflows/rebuild-content-qa.yml:142-146](../../../.github/workflows/rebuild-content-qa.yml#L142-L146):

```yaml
      - name: Publish QA content to HANA
        run: npx tsx scripts/publish-content.ts --channel qa --initiator "ci/${{ github.run_id }}"
        env:
          CAP_QA_BASE_URL: ${{ secrets.CAP_SRV_URL_QA }}
          CONTENT_API_KEY_QA: ${{ secrets.CONTENT_API_KEY_QA }}
```

(The `--channel qa` switch is parsed by `parseChannel(process.argv)` separately from `parseArgs`, so the order of flags doesn't matter.)

- [ ] **Step 8: Quick smoke test the client locally**

Run: `npx tsx scripts/publish-content.ts --help 2>&1 | grep -i initiator || npx tsx scripts/publish-content.ts --dry-run --base-url http://localhost:4004 2>&1 | head -5`

The script doesn't have a `--help` flag, so the second command is the actual smoke check: it should fail early with something like "Cannot reach localhost:4004" (good — that means the script parsed `--initiator` default from `os.userInfo()` without throwing). If it crashes with a `TypeError` about `require` or `userInfo`, fix the import in Step 2.

- [ ] **Step 9: Stage Task 5 changes (no commit yet — bundle with Task 6)**

```bash
git add scripts/publish-content.ts scripts/lib/publish-client.ts .github/workflows/rebuild-content.yml .github/workflows/rebuild-content-qa.yml
```

Tasks 5 + 6 land as one commit ("Commit 2") because the hybrid test is the verification gate for the wire-level changes.

---

## Task 6: Hybrid test against real HANA

Two cases: the canonical regression (publish H1, publish H2, attempt publish H1 — verify rejection) and the initiator round-trip on HANA. Copy the harness pattern verbatim from `test/hybrid/content-publish-chunked.test.js`.

**Files:**
- Create: `test/hybrid/content-publish-guard.test.js`

- [ ] **Step 1: Write the hybrid test file**

Create [test/hybrid/content-publish-guard.test.js](../../../test/hybrid/content-publish-guard.test.js):

```javascript
// test/hybrid/content-publish-guard.test.js
// #672 — hybrid (HANA) verification of the publish staleness guard.
//
// SQLite covers the algorithm exhaustively in test/unit/content-publish-guard.test.js;
// this file confirms HANA-specific concerns: the SELECT against ContentFiles
// with `version: { '<': X }` works under HANA's SqlScript, BLOB columns aren't
// touched accidentally during the guard read, and ContentManifest.initiator
// round-trips through the real wire.
//
// Two cases:
//   1. Canonical regression: H1 → H2 → H1-revert is rejected; H2 stays ACTIVE.
//   2. Initiator round-trip: begin with 'bob@laptop', verify both columns.
//
// Cleanup follows the pattern in test/hybrid/content-publish-chunked.test.js:
// __TEST__ slug prefix + afterAll wipe.

import cds from '@sap/cds';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { isSafeForWrites } from './_guard.js';

const NS = 'com.sap.developers.ims';
const PREFIX = '__TEST__guard-';

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}
function source(s) {
  return gzipSync(Buffer.from(s, 'utf-8')).toString('base64');
}
function sha256(s) {
  return createHash('sha256').update(Buffer.from(s, 'utf-8')).digest('hex');
}

describe('#672 publish staleness guard — HANA', () => {
  let helpers;

  beforeAll(async () => {
    if (process.env.ALLOW_HYBRID_WRITES !== 'true') {
      throw new Error('Hybrid writes require ALLOW_HYBRID_WRITES=true');
    }
    if (!isSafeForWrites()) {
      throw new Error('Refusing to run hybrid writes against production');
    }
    await cds.connect.to('db');
    helpers = createSessionHelpers({ namespace: NS });
  });

  afterAll(async () => {
    const { ContentFiles, ContentManifest, PipelineLog } = cds.entities(NS);
    // Clean stale PUBLISHING/FAILED manifests (and their ContentFiles).
    const stale = await SELECT.from(ContentManifest).where`status = 'PUBLISHING' or status = 'FAILED'`;
    if (stale.length) {
      await DELETE.from(ContentFiles).where({ version: { in: stale.map((r) => r.version) } });
      await DELETE.from(ContentManifest).where({ version: { in: stale.map((r) => r.version) } });
    }
    // Wipe any rows the tests created.
    await DELETE.from(ContentFiles).where({ slug: { like: `${PREFIX}%` } });
    // PipelineLog rows for test sessions — sessionId IS the PipelineLog.ID,
    // so wipe by initiator prefix.
    await DELETE.from(PipelineLog).where({ initiator: { like: '__TEST__%' } });
  });

  async function publishOne(slug, label, initiator = '__TEST__guard-suite') {
    const { sessionId } = await helpers.beginPublishSession({
      trigger: 'hybrid-test', hugoVersion: 'test', expectedSlugCount: 1, initiator,
    });
    await helpers.appendToSession({
      sessionId,
      files: { [slug]: html(label) },
      sources: { [slug]: source(label) },
    });
    return helpers.commitSession({ sessionId });
  }

  it('rejects a revert: H1 → H2 → H1 leaves ACTIVE on H2 (canonical regression)', async () => {
    const slug = `${PREFIX}canonical`;
    await publishOne(slug, 'H1');
    await publishOne(slug, 'H2');
    const v3 = await publishOne(slug, 'H1');

    expect(v3.rejectedReverts).toContain(slug);

    const { ContentManifest, ContentFiles } = cds.entities(NS);
    const active = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    const row = await SELECT.one.from(ContentFiles).where({ slug, version: active.version });
    expect(row.sourceHash, 'ACTIVE row should still hold H2').toBe(sha256('H2'));
  });

  it('initiator round-trips through real HANA wire to ContentManifest + PipelineLog', async () => {
    const slug = `${PREFIX}initiator`;
    const result = await publishOne(slug, 'X', '__TEST__bob@laptop');

    const { ContentManifest, PipelineLog } = cds.entities(NS);
    const manifest = await SELECT.one.from(ContentManifest).where({ version: result.version });
    expect(manifest.initiator).toBe('__TEST__bob@laptop');

    const log = await SELECT.one.from(PipelineLog).where({ ID: manifest.sessionId });
    expect(log.initiator).toBe('__TEST__bob@laptop');
  });
});
```

- [ ] **Step 2: Run the hybrid test**

Run: `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/content-publish-guard.test.js`

Expected: both tests pass. The hybrid test requires `cf login` to the DEV space first; without it, the bind step will fail with a permission error.

If it fails because `ContentManifest.initiator` doesn't exist on the deployed HANA schema, the schema change from Task 1 needs to be deployed first. Two paths:

(a) Locally only (no deploy needed): `npx cds deploy --to hana --auto-undeploy` against the dev container will pick up the new column.
(b) Run `cf push tutorials-db-deployer` if a recent build is staged.

Either way, this is the same flow as any other schema-only change — see the [cf push db-deployer Fast Path memory](../../../C:/Users/I809764/.claude/projects/d--projects-tutorials-poc/memory/feedback-cf-push-db-deployer-fast-path.md).

- [ ] **Step 3: Run the full hybrid suite to catch any regression**

Run: `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- --reporter=dot 2>&1 | tail -30`
Expected: no new failures. The existing `content-publish-chunked.test.js` should still pass since the guard never fires on its single-version test cases.

- [ ] **Step 4: Commit — this is Commit 2 of 3**

```bash
git add test/hybrid/content-publish-guard.test.js
git commit -m "feat(#672): client short-circuit + --initiator + hybrid test

Client side of the publish staleness guard:

- publish-content.ts gains --initiator flag with INITIATOR env fallback;
  default is user@hostname from os.userInfo() + os.hostname(). Passed
  to the server as the x-initiator header on /content/publish/begin.
- buildSourcePayload is split: the new computeLocalSourceHashes helper
  is callable independently for the short-circuit.
- In delta mode (not --force, not --heal), the client also fetches
  /content/source-hashes and drops slugs whose local source hash matches
  the server's. A stale workstation cache short-circuits to 'No changes
  detected' instead of uploading older bytes on top of newer ones.
- rebuild-content.yml and rebuild-content-qa.yml pass
  --initiator 'ci/\$GITHUB_RUN_ID' so CI runs are attributable.
- New hybrid test covers the canonical H1->H2->H1-revert regression
  against real HANA plus the initiator wire round-trip.

Refs #672"
```

---

## Task 7: Documentation

Update `CLAUDE.md` "Content Publishing" section and `docs/developers/operations/rebuild-content-workflow.md`. Doc-only commit.

**Files:**
- Modify: `CLAUDE.md` "Content Publishing" section (search for `### Content Publishing`)
- Modify: `docs/developers/operations/rebuild-content-workflow.md` (top + new "Drift attribution" subsection)

- [ ] **Step 1: Add warning callout to CLAUDE.md Content Publishing**

Open [CLAUDE.md](../../../CLAUDE.md) and locate the `### Content Publishing` heading. Insert immediately after the heading and before the first `npm run publish-content` example:

```markdown
> **⚠️ Workstation publishes are emergency-only.** The canonical publish path is `gh workflow run rebuild-content.yml`. Until #672 shipped (this PR), a stale local `.tutorial-cache/` could silently regress live content. With #672 the server-side no-revert guard catches the worst case, but a workstation publish still skips the validation work CI does. Every publish now records its initiator on `ContentManifest.initiator` and `PipelineLog.initiator` so attribution is one query away.
```

- [ ] **Step 2: Add `--initiator` to the flag documentation**

In the same section, find the bulleted flag list under "Flags:". Add a new bullet:

```markdown
- `--initiator <value>` — who issued this publish. Default: `${user}@${hostname}`. Override with the `INITIATOR` env var or this flag. CI passes `--initiator "ci/$GITHUB_RUN_ID"` from `rebuild-content.yml`. Persisted on `ContentManifest.initiator` + `PipelineLog.initiator`.
```

Place it after the `--dry-run` bullet (alphabetical-ish placement is fine; the existing list isn't strictly sorted).

- [ ] **Step 3: Document `rejectedReverts` in the response shape**

If the CLAUDE.md publish section doesn't already have a "Response shape" code block, skip this step. If it does, update the example commit response JSON to include `"rejectedReverts": []`.

- [ ] **Step 4: Add "Reverting content intentionally" subsection**

After the flag list, add:

```markdown
#### Reverting content intentionally

`--force` is a client-side performance shortcut (skips the `/content/hashes` round-trip and uploads everything). It does **not** bypass the server's no-revert guard. For a deliberate rollback:

1. **Preferred:** `POST /content/rollback` (existing endpoint; reverts to the previous ACTIVE manifest). See [docs/developers/operations/rebuild-content-workflow.md](docs/developers/operations/rebuild-content-workflow.md).
2. **Last resort:** if `/content/rollback` is insufficient (e.g. the slug you want to revert isn't in the immediately-prior manifest), null out the offending prior `sourceHash` in HANA via `UPDATE com_sap_developers_ims_contentfiles SET sourceHash = NULL WHERE version = <V> AND slug = <S>`. The next publish of that slug then appears "novel" to the guard and lands normally. This is the escape hatch; use it sparingly and log what you did.

The guard rejects a slug if its incoming `sourceHash` appears in **any version older than the most recent prior hash that differs from incoming**. A legitimate flap (`A → B → A` where current upstream IS `A`) is permitted; a stale-cache regression (`A → B` where the workstation re-publishes the old `A` after the server has moved to `B`) is caught.
```

- [ ] **Step 5: Update rebuild-content-workflow.md top**

Open [docs/developers/operations/rebuild-content-workflow.md](../../../docs/developers/operations/rebuild-content-workflow.md). Add at the very top, before the first heading or paragraph:

```markdown
> **⚠️ Always use this workflow — never `npm run publish-content` from a workstation.** Until #672 shipped, a stale local `.tutorial-cache/` silently regressed CI-published content. With the staleness guard in place the worst case is caught server-side, but a workstation publish still skips fetch, Hugo build, and validation. Use `gh workflow run rebuild-content.yml -f mode=full` (or `-f slug=…` for one-tutorial fixes).
```

- [ ] **Step 6: Add "Drift attribution" subsection**

In the same file, append a new subsection at a natural location (after the "Modes" section, or wherever the existing diagnostic / forensics content lives):

```markdown
## Drift attribution

Every publish now records its initiator on `ContentManifest.initiator` and `PipelineLog.initiator`. Format:

- Workstation: `<user>@<hostname>` (auto-computed from `os.userInfo()` + `os.hostname()`)
- CI: `ci/<github_run_id>` (passed explicitly from `rebuild-content.yml` / `rebuild-content-qa.yml`)

To see who did the most recent N publishes:

```sql
SELECT VERSION, STATUS, TRIGGER, INITIATOR, MODIFIEDAT
  FROM COM_SAP_DEVELOPERS_IMS_CONTENTMANIFEST
 ORDER BY VERSION DESC
 LIMIT 20;
```

Or via the admin Pipeline Log tile (`/admin-ui/#pipelinelog-display`) — the `Initiator` column shows the same value joined by `PipelineLog.ID = ContentManifest.sessionId`.

If a daily content-drift check reports drifted slugs, the first forensic step is:

1. Find the publish that introduced the regression: `SELECT VERSION, INITIATOR FROM COM_SAP_DEVELOPERS_IMS_CONTENTMANIFEST ORDER BY VERSION DESC LIMIT 10`.
2. If `INITIATOR` is `ci/<run_id>`, the regression came from CI — pull the workflow log.
3. If `INITIATOR` is `<user>@<hostname>`, talk to that person. The most likely cause is a workstation publish from a stale `.tutorial-cache/`.

Historical rows (pre-#672) have `INITIATOR = NULL` and are not attributable — that's intentional, not a bug.
```

- [ ] **Step 7: Verify the docs build**

Run: `npm run docs:build 2>&1 | tail -10`
Expected: build completes without errors. The `predocs:build` step runs a sidebar guard + dead-link check; both should pass since we're modifying existing files.

If the build fails on a dead link, check that the relative paths to other docs (e.g. `rebuild-content-workflow.md` from `CLAUDE.md`) resolve correctly.

- [ ] **Step 8: Commit — this is Commit 3 of 3**

```bash
git add CLAUDE.md docs/developers/operations/rebuild-content-workflow.md
git commit -m "docs(#672): workstation-publish warning + --initiator + revert guidance

- CLAUDE.md Content Publishing section gains a warning callout at top
  declaring workstation publishes emergency-only.
- --initiator flag documented (default user@hostname, INITIATOR env
  override, CI passes ci/\$GITHUB_RUN_ID).
- New 'Reverting content intentionally' subsection: use /content/rollback,
  not --force; document the SQL nullout escape hatch.
- rebuild-content-workflow.md gets the same warning and a new
  'Drift attribution' subsection with the SQL for forensics.

Refs #672"
```

---

## Final verification before opening the PR

- [ ] **Step 1: Run all unit tests**

Run: `npm test -- --reporter=dot 2>&1 | tail -15`
Expected: no new failures. Pre-existing `check-* tests pool flake` on Windows is not a blocker.

- [ ] **Step 2: Run hybrid tests one more time**

Run: `ALLOW_HYBRID_WRITES=true npm run test:hybrid -- test/hybrid/content-publish-guard.test.js test/hybrid/content-publish-chunked.test.js 2>&1 | tail -20`
Expected: both files green.

- [ ] **Step 3: Verify the commit log is clean**

Run: `git log --oneline origin/main..HEAD`
Expected output (something close to):

```
abc1234 docs(#672): workstation-publish warning + --initiator + revert guidance
def5678 feat(#672): client short-circuit + --initiator + hybrid test
ghi9012 feat(#672): no-revert guard + ContentManifest.initiator
a7e8b57a docs(#672): fold in spec-reviewer recommendations
76158672 docs(#672): publish staleness guard design
```

5 commits total: 2 spec + 3 implementation.

- [ ] **Step 4: Push the branch and open a PR**

```bash
git push -u origin worktree-672-publish-staleness-guard
gh pr create --base main --head worktree-672-publish-staleness-guard \
  --title "fix(#672): publish staleness guard + initiator attribution" \
  --body "Closes #672.

Three layers as described in [docs/superpowers/specs/2026-06-27-672-publish-staleness-guard-design.md](docs/superpowers/specs/2026-06-27-672-publish-staleness-guard-design.md):

1. **Server guard** — \`commitPublishSession\` runs \`detectReverts()\` between fresh-slug capture and \`carryForwardUnchanged\`. Slugs whose incoming \`sourceHash\` matches an *abandoned* prior version (older than the most recent prior differing hash) are DELETEd from the in-flight version; carry-forward then re-pulls the current ACTIVE row. Response gains \`rejectedReverts: []\`; PipelineLog summary suffix + metadata carry the list.
2. **Client short-circuit** — \`publish-content.ts\` delta mode also fetches \`/content/source-hashes\` and drops slugs whose local source hash matches the server's. \`--force\` and \`--heal\` skip this layer.
3. **Attribution** — new \`ContentManifest.initiator\` column, populated symmetrically with the existing \`PipelineLog.initiator\`. CLI auto-stamps \`user@hostname\`; CI passes \`ci/\$GITHUB_RUN_ID\`.

Verified: 6 unit tests against SQLite + 2 hybrid tests against real HANA. The slug-targeted repair run kicked off after #672 was filed cleared the 10 drifted slugs surfaced by [run 28280011633](https://github.com/sap-tutorials/tutorials-ims/actions/runs/28280011633); tomorrow's drift check should report 0."
```

---

## Skills referenced

- @superpowers:subagent-driven-development — recommended for executing this plan task-by-task.
- @superpowers:executing-plans — alternative for inline execution.
- @superpowers:test-driven-development — applied throughout Tasks 2, 3, 4, 6.
- @superpowers:verification-before-completion — final-verification gate before pushing.
