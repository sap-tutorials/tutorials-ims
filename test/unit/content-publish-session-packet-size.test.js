// test/unit/content-publish-session-packet-size.test.js
//
// Regression guard for the HANA "Failed to set parameters, maximum packet size
// exceeded" defect class. See memory note cqn-where-in-hana-packet-cap.md and
// the prior fixes shipped in #1063 (kg-featured-topics) and #1103 (build-
// concepts payload).
//
// Prior to the packet-size sweep, `content-publish-session.js` emitted three
// unbounded `.where({slug:{in:bigArray}})` queries during commit — one in
// appendToSession and two in detectReverts. On a full-repo publish (~7,315
// slugs) each blew HANA's parameter batch.
//
// This test seeds ≥3,000 slugs, drives commitSession end-to-end, and asserts
// via the shared tx.run guard that NO CQN emits an IN-list ≥500 items.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { gzipSync } from 'node:zlib';
import { createSessionHelpers } from '../../srv/lib/content-publish-session.js';
import { instrumentInLimit } from '../helpers/assert-no-oversized-in.js';

const NS = 'com.sap.developers.ims';

cds.test('serve', '--project', '.', '--in-memory');

function html(s) {
  return gzipSync(Buffer.from(`<html><body><main class="tutorial-main">${s}</main></body></html>`, 'utf-8')).toString('base64');
}

function source(s) {
  return gzipSync(Buffer.from(s, 'utf-8')).toString('base64');
}

describe('content-publish-session packet-size regression', () => {
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

  it('appendToSession + commitSession emit no IN-list ≥500 for a 3000-slug publish', async () => {
    const N = 3000;

    // Instrument the shared cds.db tx (createSessionHelpers uses cds.db under
    // the hood via cds.connect.to('db')). Instrumenting at cds.db catches every
    // downstream call from beginPublishSession / appendToSession / commitSession.
    const db = await cds.connect.to('db');
    const guard = instrumentInLimit(db, { limit: 500 });

    try {
      const session = await helpers.beginPublishSession({
        trigger: 'ci/packet-size-regression',
        hugoVersion: '0.147.7',
        expectedSlugCount: N,
        initiator: 'test',
      });

      // Append in 200-slug batches — realistic client behavior; commitSession
      // must still see freshSlugs at N=3000 total.
      for (let batch = 0; batch < N; batch += 200) {
        const files = {};
        const sources = {};
        for (let i = batch; i < Math.min(batch + 200, N); i++) {
          const slug = `slug-${i}`;
          files[slug] = html(`t${i}`);
          sources[slug] = source(`src-${i}`);
        }
        await helpers.appendToSession({ sessionId: session.sessionId, files, sources });
      }

      await helpers.commitSession({ sessionId: session.sessionId });
    } finally {
      guard.restore();
    }

    expect(
      guard.oversized,
      `emitted oversized IN clause(s): ${JSON.stringify(guard.oversized)}`
    ).toEqual([]);
  }, 90_000);
});
