// test/unit/content-publish-carryforward-memory.test.js
//
// Regression guard for the commit-time OOM defect class (#1932).
//
// carryForwardUnchanged used to materialize the ENTIRE previously-ACTIVE
// version — including the CONTENT + SOURCECONTENT BLOB columns — into one
// in-memory array, then filter freshly-written slugs out in Node. On a full
// (force-mode) rebuild every slug is freshly appended, so nothing is actually
// carried forward, yet the whole catalog's BLOBs were still pulled into memory
// first. As the catalog grew (~2,200 tutorials) the peak tripped V8's heap
// limit (SIGABRT / exit 134) on the memory-constrained srv-qa instance,
// crashing the /content/publish commit with 502/503.
//
// The fix makes carry-forward slug-list-first: fetch only slugs for the prev
// version, compute the carry set (prevSlugs − freshSlugs), and read BLOB
// columns ONLY for that (usually empty) set, in chunks. When the carry set is
// empty — every force/full rebuild — NO content-bearing SELECT is emitted.
//
// This test drives a full republish (v2 re-appends every v1 slug) and asserts
// the commit emits zero SELECTs touching the `content` column. It also verifies
// a PARTIAL republish still carries untouched slugs forward with content intact
// (behavior preservation).

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
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

// Wrap tx.run to record any SELECT against ContentFiles whose projection
// includes the `content` BLOB column (CQN) or any raw SQL string that reads
// the CONTENT column. Returns { contentReads, restore }.
function instrumentContentReads(tx, contentTable) {
  const contentReads = [];
  const origRun = tx.run.bind(tx);
  tx.run = async (q, ...rest) => {
    try {
      if (typeof q === 'string') {
        if (/select/i.test(q) && /content/i.test(q) && new RegExp(contentTable, 'i').test(q)) {
          contentReads.push({ kind: 'sql', q });
        }
      } else {
        const from = q?.SELECT?.from?.ref?.[0];
        const cols = q?.SELECT?.columns;
        const isContentFiles = typeof from === 'string' && /ContentFiles/i.test(from);
        const readsContent = Array.isArray(cols) && cols.some((c) => {
          const ref = c?.ref?.join?.('.') || (typeof c === 'string' ? c : '');
          return /(^|\.)content$/i.test(ref);
        });
        if (isContentFiles && readsContent) contentReads.push({ kind: 'cqn', from, cols });
      }
    } catch { /* diagnostic-only */ }
    return origRun(q, ...rest);
  };
  return { contentReads, restore() { tx.run = origRun; } };
}

async function appendAll(helpers, sessionId, slugs) {
  const files = {};
  const sources = {};
  for (const slug of slugs) {
    files[slug] = html(`body-${slug}`);
    sources[slug] = source(`src-${slug}`);
  }
  await helpers.appendToSession({ sessionId, files, sources });
}

describe('carryForwardUnchanged commit memory (#1932)', () => {
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

  it('full republish carries nothing forward and reads no content BLOBs at commit', async () => {
    const slugs = ['a', 'b', 'c', 'd', 'e'];

    // v1: publish all slugs.
    const s1 = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: slugs.length, initiator: 'test' });
    await appendAll(helpers, s1.sessionId, slugs);
    await helpers.commitSession({ sessionId: s1.sessionId });

    // v2: re-append EVERY slug (force/full rebuild). Nothing should carry forward.
    const s2 = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: slugs.length, initiator: 'test' });
    await appendAll(helpers, s2.sessionId, slugs);

    const db = await cds.connect.to('db');
    const guard = instrumentContentReads(db, 'IMS_CONTENTFILES');
    try {
      await helpers.commitSession({ sessionId: s2.sessionId });
    } finally {
      guard.restore();
    }

    expect(
      guard.contentReads,
      `commit read content BLOBs even though every slug was fresh: ${JSON.stringify(guard.contentReads.map((r) => r.from || 'sql'))}`
    ).toEqual([]);
  }, 60_000);

  it('partial republish carries untouched slugs forward with content intact', async () => {
    const slugs = ['a', 'b', 'c', 'd', 'e'];

    const s1 = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: slugs.length, initiator: 'test' });
    await appendAll(helpers, s1.sessionId, slugs);
    await helpers.commitSession({ sessionId: s1.sessionId });

    // v2: re-append only 'a' and 'b'. c/d/e must carry forward from v1.
    const s2 = await helpers.beginPublishSession({ trigger: 'ci/test', expectedSlugCount: 2, initiator: 'test' });
    await appendAll(helpers, s2.sessionId, ['a', 'b']);
    const res = await helpers.commitSession({ sessionId: s2.sessionId });

    // All five slugs must exist at the new (active) version...
    const v = res.version;
    const rows = await SELECT.from(ContentFiles).columns('slug', 'content').where({ version: v });
    const bySlug = new Map(rows.map((r) => [r.slug, r]));
    for (const slug of slugs) {
      expect(bySlug.has(slug), `slug ${slug} missing at committed version`).toBe(true);
      expect(bySlug.get(slug).content, `slug ${slug} carried forward with null content`).toBeTruthy();
    }
  }, 60_000);
});
