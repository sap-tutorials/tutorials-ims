// test/unit/provenance-data.test.js
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import cds from '@sap/cds';
import { loadProvenanceInputs } from '../../srv/lib/provenance-data.js';

const project = cds.test('serve', '--project', '.', '--in-memory');

describe('loadProvenanceInputs', () => {
  let ContentCurrent, Tutorials, FreshnessReport, FreshnessFinding;
  beforeAll(() => { ({ ContentCurrent, Tutorials, FreshnessReport, FreshnessFinding } = cds.entities('com.sap.developers.ims')); });
  beforeEach(async () => {
    await DELETE.from(ContentCurrent); await DELETE.from(FreshnessFinding);
    await DELETE.from(FreshnessReport); await DELETE.from(Tutorials);
  });

  it('returns null for unknown slug', async () => {
    expect(await loadProvenanceInputs('nope')).toBeNull();
  });

  it('joins content row, source commit, and current freshness report', async () => {
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo' });
    await INSERT.into(ContentCurrent).entries({ slug: 'demo', contentHash: 'h'.repeat(64), sourceCommit: 'a'.repeat(40), modifiedAt: '2026-09-10T00:00:00.000Z' });
    await INSERT.into(FreshnessReport).entries({ ID: cds.utils.uuid(), tutorial_ID: tid, status: 'DONE', openHighCount: 0, runAt: '2026-09-05T00:00:00.000Z', model: 'm1' });
    const out = await loadProvenanceInputs('demo');
    expect(out.contentHash).toBe('h'.repeat(64));
    expect(out.sourceCommit).toBe('a'.repeat(40));
    expect(out.report).toMatchObject({ status: 'DONE', openHighCount: 0, openMediumCount: 0, runAt: '2026-09-05T00:00:00.000Z', model: 'm1' });
  });

  it('counts open medium findings', async () => {
    const tid = cds.utils.uuid();
    await INSERT.into(Tutorials).entries({ ID: tid, slug: 'demo2' });
    await INSERT.into(ContentCurrent).entries({ slug: 'demo2', contentHash: 'h'.repeat(64) });
    const rid = cds.utils.uuid();
    await INSERT.into(FreshnessReport).entries({ ID: rid, tutorial_ID: tid, status: 'DONE', openHighCount: 0, runAt: '2026-09-05T00:00:00.000Z' });
    await INSERT.into(FreshnessFinding).entries([
      { ID: cds.utils.uuid(), report_ID: rid, tutorial_ID: tid, severity: 'Medium', disposition: 'OPEN' },
      { ID: cds.utils.uuid(), report_ID: rid, tutorial_ID: tid, severity: 'Medium', disposition: 'DISMISSED' },
    ]);
    const out = await loadProvenanceInputs('demo2');
    expect(out.report.openMediumCount).toBe(1);
  });
});
