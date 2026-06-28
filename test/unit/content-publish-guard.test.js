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

  it('threads rejectedReverts through commit response, summary, and PipelineLog metadata', async () => {
    await publishOne('thread-slug', 'A');
    await publishOne('thread-slug', 'B');
    const v3SessionResult = await publishOne('thread-slug', 'A');

    // Commit response field
    expect(v3SessionResult.rejectedReverts).toEqual(['thread-slug']);

    // PipelineLog summary suffix
    const active = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    const log = await SELECT.one.from(PipelineLog).where({ ID: active.sessionId });
    expect(log.summary).toMatch(/\(1 revert rejected\)$/);

    // PipelineLog metadata gains rejectedReverts (merged, not replaced —
    // the begin-time fields like `trigger` should still be there).
    const meta = JSON.parse(log.metadata || '{}');
    expect(meta.rejectedReverts).toEqual(['thread-slug']);
    expect(meta.trigger, 'begin-time trigger should still be in metadata').toBe('unit-test');
  });

  // ─────────────────────────────────────────────────────────────────────
  // No-op republish fast-path (2026-06-28 follow-up to #672 — surfaced by
  // rebuild-content workflow run 28322396467 after PR #692 fixed the
  // source-only short-circuit). When `history[0].sourceHash === incomingHash`
  // the server's current ACTIVE state already IS the incoming content, so
  // re-uploading the same bytes cannot semantically be a revert — regardless
  // of what older history looks like.
  //
  // Without the fast-path, the deep-history scan in detectReverts spuriously
  // rejects multi-flip patterns like `[X, X, Y, X]` (incoming X). The flow
  // is: walk newest-first, history[0]=X matches incoming and is skipped by
  // line 262 (which only sets divIdx on a DIFFERING entry), then the older
  // Y at index 2 becomes divIdx, then the X at index 3 is treated as
  // "abandoned history" and triggers a rejection — even though X IS the
  // current server state.
  // ─────────────────────────────────────────────────────────────────────

  it('accepts a no-op republish when history[0].sourceHash matches incoming', async () => {
    // Sequence: v1 X (fresh) → v2 Y (fresh) → v3 X (rejected; carry-forwards Y)
    // → manually overwrite v3's row to simulate the multi-flip case where the
    // most-recent prior actually has the incoming hash (e.g., after an admin
    // `/content/rollback` or a manual sourceHash null-out + re-publish).
    await publishOne('hist0-match-slug', 'X');
    await publishOne('hist0-match-slug', 'Y');
    const v3Reject = await publishOne('hist0-match-slug', 'X');
    expect(v3Reject.rejectedReverts).toContain('hist0-match-slug');
    // After v3, the row is Y (carry-forwarded from v2 after v3's X was rejected).
    // Force the row's sourceHash back to X to simulate a fresh-publish that
    // succeeded after history rewriting. This matches the production state
    // where the same slug has been republished across many versions with the
    // same source-md, then briefly flipped, then back — leaving history[0]
    // matching incoming.
    const activeAfterV3 = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    await UPDATE(ContentFiles)
      .set({ sourceHash: sha256('X') })
      .where({ slug: 'hist0-match-slug', version: activeAfterV3.version });

    // Now v4 incoming X. history (newest-first): v3=X (just-overwritten),
    // v2=Y (fresh), v1=X (fresh). Without the fast-path, the deep scan finds
    // v2 as divIdx and v1 as the older-matching X → rejected.
    const v4 = await publishOne('hist0-match-slug', 'X');
    expect(v4.rejectedReverts, 'no-op republish (history[0] already matches incoming) must NOT be rejected').toEqual([]);

    // The fresh row should now be in the new ACTIVE manifest (not carry-forwarded).
    const activeAfterV4 = await SELECT.one.from(ContentManifest).where({ status: 'ACTIVE' });
    expect(activeAfterV4.version, 'v4 must be the new ACTIVE').toBeGreaterThan(activeAfterV3.version);
    const row = await SELECT.one.from(ContentFiles).where({ slug: 'hist0-match-slug', version: activeAfterV4.version });
    expect(row.sourceHash).toBe(sha256('X'));
  });

  it('still rejects when history[0] differs (existing flap-rejection behavior preserved)', async () => {
    // Standard A → B → A pattern. history[0] after v2 is B (≠ incoming A),
    // so the fast-path does NOT fire. The deep scan finds A in older history
    // and rejects — matching the original PR #675 design.
    await publishOne('flap-preserved-slug', 'A');
    await publishOne('flap-preserved-slug', 'B');
    const v3 = await publishOne('flap-preserved-slug', 'A');
    expect(v3.rejectedReverts).toContain('flap-preserved-slug');
  });
});
