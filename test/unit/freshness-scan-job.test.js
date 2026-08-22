// test/unit/freshness-scan-job.test.js
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import cds from '@sap/cds';

// Bootstrap: same pattern as other freshness unit tests.
cds.test('serve', '--project', '.', '--in-memory');

describe('runFreshnessScan', () => {
  let db;
  beforeAll(async () => { db = await cds.connect.to('db'); });
  afterEach(() => {
    delete process.env.FRESHNESS_SCAN_ENABLED;
    delete globalThis.__FRESHNESS_DETECT_IMPL__;
    delete globalThis.__FRESHNESS_TEST_IMPL__;
  });

  it('self-skips when the flag is off', async () => {
    delete process.env.FRESHNESS_SCAN_ENABLED;
    const { runFreshnessScan } = await import('../../srv/jobs/freshness-scan-job.js');
    const res = await runFreshnessScan('log');
    expect(res.skipped).toBe(true);
  });

  it('scans tutorials when enabled', async () => {
    process.env.FRESHNESS_SCAN_ENABLED = 'true';
    // Full-stack hook: bypasses ALL I/O (grounding + LLM + ContentFiles read).
    // Returns the shape detectFreshness() resolves with so no ContentFiles seeding needed.
    globalThis.__FRESHNESS_DETECT_IMPL__ = async () => ({ model: 'm', costCents: 0, findings: [] });
    const { Tutorials, Steps } = cds.entities('com.sap.developers.ims');
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'scan', title: 'S', legacyId: 41 });
    await INSERT.into(Steps).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, number: 1, content: '```js\nx\n```' });
    const { runFreshnessScan } = await import('../../srv/jobs/freshness-scan-job.js');
    const res = await runFreshnessScan('log', { limit: 5 });
    expect(res.skipped).toBe(false);
    expect(res.scanned).toBeGreaterThanOrEqual(1);
  });
});
