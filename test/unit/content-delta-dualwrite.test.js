// test/unit/content-delta-dualwrite.test.js
//
// Workstream D (slug-targeted-delta-rebuild) — Option B dual-write guard.
//
// When CONTENT_DELTA_WRITE_ENABLED=true, commitSession mirrors the freshly-
// published slugs into the mutable ContentCurrent table (one row per slug, no
// version) + appends WRITTEN rows to ContentHistory, ALONGSIDE the legacy
// ContentFiles write. This test drives publishes on in-memory SQLite and
// asserts: (a) ContentCurrent is one-row-per-slug and UPSERTs on republish,
// (b) ContentHistory accumulates per version, (c) the flag OFF writes neither.
//
// HANA LOB-locator behavior is NOT exercised here (SQLite CQL path); that is
// covered by the hybrid publish→rollback test in Workstream D task 7.4.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}
function source(s) {
  return gzipSync(Buffer.from(s, 'utf-8')).toString('base64');
}
async function appendAll(helpers, sessionId, slugs) {
  const files = {};
  const sources = {};
  for (const slug of slugs) { files[slug] = html(`body-${slug}`); sources[slug] = source(`src-${slug}`); }
  await helpers.appendToSession({ sessionId, files, sources });
}

describe('Option B dual-write (Workstream D)', () => {
  let helpers;
  let ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks;
  const prevFlag = process.env.CONTENT_DELTA_WRITE_ENABLED;

  beforeAll(() => {
    helpers = createSessionHelpers({ namespace: NS });
    ({ ContentFiles, ContentManifest, ContentCurrent, ContentHistory, PipelineLog, JobLocks } = cds.entities(NS));
  });
  afterAll(() => {
    if (prevFlag === undefined) delete process.env.CONTENT_DELTA_WRITE_ENABLED;
    else process.env.CONTENT_DELTA_WRITE_ENABLED = prevFlag;
  });
  beforeEach(async () => {
    await DELETE.from(ContentFiles);
    await DELETE.from(ContentManifest);
    await DELETE.from(ContentCurrent);
    await DELETE.from(ContentHistory);
    await DELETE.from(PipelineLog);
    await DELETE.from(JobLocks);
  });

  it('exposes ContentCurrent + ContentHistory entities', () => {
    expect(ContentCurrent).toBeTruthy();
    expect(ContentHistory).toBeTruthy();
  });

  it('writes ContentCurrent (one row per slug) + ContentHistory when the flag is ON', async () => {
    process.env.CONTENT_DELTA_WRITE_ENABLED = 'true';
    const slugs = ['a', 'b', 'c'];
    const s = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: slugs.length, initiator: 'test' });
    await appendAll(helpers, s.sessionId, slugs);
    const res = await helpers.commitSession({ sessionId: s.sessionId });

    const current = await SELECT.from(ContentCurrent).columns('slug', 'contentHash', 'sourceVersion', 'content');
    expect(current.map(r => r.slug).sort()).toEqual(['a', 'b', 'c']);
    for (const row of current) {
      expect(row.content, `ContentCurrent.${row.slug} has null content`).toBeTruthy();
      expect(row.sourceVersion).toBe(res.version);
    }
    const history = await SELECT.from(ContentHistory).columns('slug', 'version', 'action');
    expect(history.length).toBe(3);
    expect(history.every(h => h.action === 'WRITTEN' && h.version === res.version)).toBe(true);
  }, 60_000);

  it('UPSERTs ContentCurrent on republish (stays one row per slug) + appends history per version', async () => {
    process.env.CONTENT_DELTA_WRITE_ENABLED = 'true';
    const slugs = ['a', 'b', 'c'];
    const s1 = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: 3, initiator: 'test' });
    await appendAll(helpers, s1.sessionId, slugs);
    const r1 = await helpers.commitSession({ sessionId: s1.sessionId });

    // Republish only 'a' with new content.
    const s2 = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: 1, initiator: 'test' });
    await helpers.appendToSession({ sessionId: s2.sessionId, files: { a: html('body-a-v2') }, sources: { a: source('src-a-v2') } });
    const r2 = await helpers.commitSession({ sessionId: s2.sessionId });

    // ContentCurrent still has exactly one row for 'a', now at the new version.
    const aRows = await SELECT.from(ContentCurrent).where({ slug: 'a' });
    expect(aRows.length).toBe(1);
    expect(aRows[0].sourceVersion).toBe(r2.version);
    // b + c unchanged rows remain (from v1) — dual-write only touches fresh slugs.
    const all = await SELECT.from(ContentCurrent).columns('slug');
    expect(all.map(r => r.slug).sort()).toEqual(['a', 'b', 'c']);

    // History has 'a' at both versions (append-only).
    const aHistory = await SELECT.from(ContentHistory).where({ slug: 'a' });
    expect(aHistory.map(h => h.version).sort((x, y) => x - y)).toEqual([r1.version, r2.version]);
  }, 60_000);

  it('writes NEITHER table when the flag is OFF', async () => {
    process.env.CONTENT_DELTA_WRITE_ENABLED = 'false';
    const s = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: 2, initiator: 'test' });
    await appendAll(helpers, s.sessionId, ['x', 'y']);
    await helpers.commitSession({ sessionId: s.sessionId });

    expect((await SELECT.from(ContentCurrent)).length).toBe(0);
    expect((await SELECT.from(ContentHistory)).length).toBe(0);
    // Legacy ContentFiles still written (source of truth).
    expect((await SELECT.from(ContentFiles).columns('slug')).map(r => r.slug).sort()).toEqual(['x', 'y']);
  }, 60_000);
});
